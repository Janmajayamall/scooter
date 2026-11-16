// One run (6.6 to 6.9 of DESIGN.md): from `run.lock` to the state update.
//
// 1. **Lock.** Take `run.lock`, recording when the run must be over, then look for `backup.lock`.
//    If a backup holds it, let go of `run.lock` and wait (6.4; row 7).
// 2. **Prepare** `run/`: the system prompt, a copy of the prompt and skills, and a copy of the
//    current session (6.5, 6.6).
// 3. **Run** pi in the sandbox, with the command, mounts, environment and network policy of 6.6.
// 4. **After a successful run,** in this order (6.8): check the files pi left; copy its session back;
//    commit; write the outbox entries; update the state. A crash part-way through only means the
//    batch runs again.
// 5. **After a failed run** (6.9): throw away its changes and its session, read why it failed from
//    the network log, and update the state, with a notice for the first failure in a row.
// 6. **Release** the lock.

import path from 'node:path'
import { ensureDir } from '../common/files.mjs'
import { lockExists, releaseLock, takeLock } from '../common/locks.mjs'
import { errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { keepSession, prepareRun } from './agentdir.mjs'
import { answerEntries, parseAnswer, reportsOf } from './answer.mjs'
import { failureNotice, givenUpNotice, isFirstFailure, readFailureCause, settleBatch, settleTask } from './failures.mjs'
import { GUEST_HOME, GUEST_PATH, OPENROUTER_HOST, PI_PROGRAM } from './sandbox/index.mjs'
import { currentSession, saveState, sessionId } from './state.mjs'

const MINUTE = 60 * 1000

// pi's tools (6.6): read, bash, edit and write are on by default; grep, find and ls aren't.
export const PI_TOOLS = 'read,bash,edit,write,grep,find,ls'

// ---------------------------------------------------------------------------------------------
// What the sandbox is given (6.6)

// The mounts, at the host's own paths: the agent's folder read-only, with `sessions/` hidden and
// `views/`, `memory/` and `run/session/` writable; and the datastore read-only.
export function piMounts(paths, agentName) {
  const dir = paths.agentDir(agentName)
  return [
    { path: dir, writable: false, hide: [path.relative(dir, paths.agentSessions(agentName))] },
    { path: paths.agentViews(agentName), writable: true, hide: [] },
    { path: paths.agentMemory(agentName), writable: true, hide: [] },
    { path: paths.agentRunSession(agentName), writable: true, hide: [] },
    { path: paths.datastore, writable: false, hide: [] },
  ]
}

// pi's environment, apart from the key's placeholder, which the sandbox sets from the policy.
export function piEnv({ timeZone }) {
  return {
    PATH: GUEST_PATH,
    HOME: GUEST_HOME,
    LANG: 'C.UTF-8',
    TZ: timeZone,
    PI_SKIP_VERSION_CHECK: '1',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  }
}

// The network policy of a run of `agent` (6.13): its model, the internet switch, ZDR, and the key,
// which pi sees only as a placeholder in `OPENROUTER_API_KEY`.
export function piPolicy({ agent, settings }) {
  return {
    model: agent.model,
    internet: settings.agentInternet,
    zdr: settings.zdr,
    secrets: { OPENROUTER_API_KEY: { hosts: [OPENROUTER_HOST], value: settings.openrouterApiKey } },
  }
}

// pi's command (6.6), with what milestone 0 found: every kind of discovery off, MCP included; the
// session by its ID in `run/session/`, or none; the system prompt and the skills from `run/`; and
// the prompt as one argument after `--`, so nothing in it can pass for a flag.
export function piArgs({ agent, prepared, sessionId: id, prompt }) {
  return [
    '-p',
    '--no-approve',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-mcp',
    '--offline',
    '--provider',
    'openrouter',
    '--model',
    agent.model,
    ...(agent.thinking ? ['--thinking', agent.thinking] : []),
    '--tools',
    PI_TOOLS,
    ...(id === null ? ['--no-session'] : ['--session-dir', prepared.sessionDir, '--session-id', id]),
    '--append-system-prompt',
    prepared.systemFile,
    ...prepared.skillDirs.flatMap(dir => ['--skill', dir]),
    '--',
    prompt,
  ]
}

// The sandbox's spec for one run of pi.
export function runSpec({ agent, settings, paths, prepared, sessionId: id, prompt }) {
  return {
    argv: [PI_PROGRAM, ...piArgs({ agent, prepared, sessionId: id, prompt })],
    cwd: paths.agentDir(agent.name),
    env: piEnv({ timeZone: settings.timeZone }),
    mounts: piMounts(paths, agent.name),
    timeoutMs: agent.timeoutMinutes * MINUTE,
    policy: piPolicy({ agent, settings }),
  }
}

// ---------------------------------------------------------------------------------------------
// The lock (6.4; row 7)

// Takes `run.lock` for a run that must be over by `deadline`, then looks for `backup.lock`. Returns
// `taken`; `backup` when a backup holds its lock, and `run.lock` has been let go of again; or `busy`
// when `run.lock` was already there, as a `rebuild` holds it (6.10). Taking its own lock before
// looking for the other's is what keeps a run and a backup from starting at the same instant: when
// the two appear together, the runner gives way.
export function acquireRunLock({ paths, deadline, clock }) {
  ensureDir(paths.locks, { mode: 0o700 })
  if (!takeLock(paths.runLock, { deadline, clock })) return 'busy'
  if (lockExists(paths.backupLock)) {
    releaseLock(paths.runLock)
    return 'backup'
  }
  return 'taken'
}

// ---------------------------------------------------------------------------------------------
// A run

// The commit message (6.8): `lifelog: #1050 #1051 #1053` for a batch, `lifelog: scheduled task
// 21:30` or `lifelog: once task poems` for a task.
export function commitMessage(agentName, job) {
  if (job.kind === 'scheduled') return `${agentName}: scheduled task ${job.at}`
  if (job.kind === 'once') return `${agentName}: once task ${job.id}`
  return `${agentName}: ${job.batch.items.map(item => `#${item.seq}`).join(' ')}`
}

// Runs one job, and returns `{ state, outcome }`. `job` is
//
//   { kind: 'messages', batch, prompt }            from `buildBatch`
//   { kind: 'scheduled', at, date, task, prompt }  from `nextAction` and `buildTaskPrompt`
//   { kind: 'once', id, task, prompt }
//
// `outcome` is `waiting` (a backup or a rebuild holds the locks, and nothing ran), `stopped` (the
// runner is stopping, `signal` aborted the run, and its changes were thrown away, as after a crash),
// or `{ ok, cause }` for a run that finished: `cause` is null after a success, and otherwise
// `setup`, `outage` or `other` (`failureCause`).
//
// Context: `agent`, `settings`, `paths`; `sandbox`; `git` for the agent's folder; `protocol`;
// `ids`, for outbox entries; `index`, the datastore's; `state` and `stateFile`; `log` and `clock`.
export async function performRun(context) {
  const { agent, settings, paths, sandbox, git, protocol, log, clock, state, job, signal } = context
  const startedAt = clock.now()
  const lock = acquireRunLock({ paths, deadline: startedAt + agent.timeoutMinutes * MINUTE, clock })
  if (lock !== 'taken') return { state, outcome: 'waiting', why: lock }
  try {
    const id =
      agent.session === 'daily'
        ? sessionId(agent.name, currentSession(state, { now: startedAt, timeZone: settings.timeZone, rolloverHour: settings.sessionRolloverHour }))
        : null
    const prepared = prepareRun({ paths, agent, protocol, sessionId: id })
    const spec = runSpec({ agent, settings, paths, prepared, sessionId: id, prompt: job.prompt })
    const seqs = job.kind === 'messages' ? job.batch.items.map(item => item.seq) : []
    log.info('runner.run_started', { agent: agent.name, job: job.kind, seqs, task: job.at ?? job.id, session: id })

    let result
    try {
      result = await sandbox.run(spec, { signal })
    } catch (error) {
      log.error('runner.sandbox_failed', { agent: agent.name, ...errorFields(error) })
      result = { error }
    }
    const endedAt = clock.now()
    if (signal?.aborted) {
      await git.discardChanges()
      log.info('runner.run_stopped', { agent: agent.name, job: job.kind, ms: endedAt - startedAt })
      return { state, outcome: 'stopped' }
    }

    const unexpected = !result.error && result.code === 0 ? await git.unexpectedFile() : null
    const timing = { now: endedAt, startedAt, durationMs: Math.max(0, Math.round(endedAt - startedAt)) }
    if (!result.error && result.code === 0 && unexpected === null) return await afterSuccess(context, { result, sessionId: id, seqs, timing })
    return await afterFailure(context, { result, unexpected, seqs, timing })
  } finally {
    releaseLock(paths.runLock)
  }
}

// 6.8: the session, git, the outbox, the state.
async function afterSuccess(context, { result, sessionId: id, seqs, timing }) {
  const { agent, paths, git, ids, log, index, state, stateFile, job } = context
  const answer = parseAnswer(result.stdout)
  if (answer.unreadable > 0) log.warn('runner.answer_unreadable', { agent: agent.name, lines: answer.unreadable })

  const session = id === null ? 'none' : await keepSession({ paths, agent, sessionId: id })
  if (session === 'refused') log.warn('runner.session_refused', { agent: agent.name, session: id })
  const committed = await git.commitChanges(commitMessage(agent.name, job))

  let next
  let entries
  let reports = null
  if (job.kind === 'messages') {
    reports = reportsOf(answer, seqs)
    if (reports.unknown.length > 0) log.warn('runner.answer_unknown', { agent: agent.name, seqs: reports.unknown })
    entries = answerEntries({ answer, agent, index, about: job.batch.newest, done: reports.done })
    const settled = settleBatch(state, job.batch, { ok: true, done: reports.done, failed: reports.failed }, timing)
    next = settled.state
    if (settled.givenUp.length > 0) entries.push(givenUpNotice(index, settled.givenUp))
  } else {
    const reported = [...new Set([...answer.done, ...answer.failed.map(entry => entry.seq)])].sort((a, b) => a - b)
    // A task has no items to report on (6.7).
    if (reported.length > 0) log.warn('runner.answer_unknown', { agent: agent.name, seqs: reported })
    entries = answerEntries({ answer, agent, index })
    next = settleTask(state, job, { ok: true }, timing)
  }

  for (const entry of entries) await writeOutboxEntry({ paths, ids, entry })
  saveState(stateFile, next)
  log.info('runner.run_finished', {
    agent: agent.name,
    job: job.kind,
    ok: true,
    ms: timing.durationMs,
    done: reports?.done.size,
    failed: reports?.failed.size,
    notReported: reports ? seqs.length - reports.done.size - reports.failed.size : undefined,
    texts: entries.filter(entry => entry.type === 'text').length,
    reactions: entries.filter(entry => entry.type === 'react').length,
    committed,
    session,
  })
  return { state: next, outcome: { ok: true, cause: null } }
}

// 6.9: throw the run away, find why it failed, and count it.
async function afterFailure(context, { result, unexpected, seqs, timing }) {
  const { agent, paths, git, ids, log, index, state, stateFile, job } = context
  await git.discardChanges()
  const failure = readFailureCause({ paths, result, unexpected, startedAt: timing.startedAt, endedAt: timing.now })
  log.warn('runner.run_failed', {
    agent: agent.name,
    job: job.kind,
    cause: failure.cause,
    status: failure.status,
    exitCode: result.code,
    timedOut: result.timedOut,
    file: unexpected ?? undefined,
    ms: timing.durationMs,
  })

  const outcome = { ok: false, cause: failure.cause, reason: failure.reason }
  const entries = []
  let next
  if (job.kind === 'messages') {
    const settled = settleBatch(state, job.batch, outcome, timing)
    next = settled.state
    if (isFirstFailure(state)) entries.push(failureNotice(job, failure))
    if (settled.givenUp.length > 0) entries.push(givenUpNotice(index, settled.givenUp))
  } else {
    next = settleTask(state, job, outcome, timing)
    if (isFirstFailure(state)) entries.push(failureNotice(job, failure))
  }
  for (const entry of entries) await writeOutboxEntry({ paths, ids, entry })
  saveState(stateFile, next)
  return { state: next, outcome: { ok: false, cause: failure.cause } }
}
