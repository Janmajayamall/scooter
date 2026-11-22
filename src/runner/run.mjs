// One run: from `run.lock` to the state update.
//
// 1. **Lock.** Take `run.lock`, recording when the run must be over, then look for `backup.lock`.
//    If a backup holds it, let go of `run.lock` and wait.
// 2. **Prepare** `run/`: the system prompt, a copy of the prompt and skills, the runner's own skill
//    and programs, the index file and the offsets file, and a copy of the current session.
// 3. **Run** pi in the sandbox, with its command, what it sees and may change, its environment and
//    the network policy.
// 4. **After a successful run,** in this order: check the files pi left, staging them as the
//    check's last step; commit; copy its session back; write the outbox entries; update the state.
//    A crash part-way through only means the batch runs again.
// 5. **After a failed run**: throw away its session and its changes, read why it failed from
//    the network log, and update the state, with a notice for the first failure in a row.
// 6. **Release** the lock.
//
// Everything from the check to the commit reads what pi left, so an error there, such as a git
// command that times out, fails the run like an unexpected file, and counts an attempt: it never
// stops the runner, which would run the same batch again at its next start without counting one.
// `run/session/` is emptied before the run is recorded, and on a failure what `writes` names in
// the agent's folder is cleaned up after it, so nothing pi left takes room the clean-up or the
// state needs: pi may have filled the disk. A clean-up that can't finish stops the runner, once
// the run is recorded.
//
// A replayed batch, of a rebuild or a backfill (`replay.mjs`), is a run like the
// others, with its own session, skills and commit message, and three differences: it sends
// nothing, neither texts, reactions nor notices; a backfill's batch may change only what the
// backfill may, which the sandbox holds it to; and each settles its own lane of the state.

import path from 'node:path'
import { ensureDir } from '../common/files.mjs'
import { lockExists, releaseLock, takeLock } from '../common/locks.mjs'
import { errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { clearRunSession, keepSession, prepareRun } from './agentdir.mjs'
import { answerEntries, droppedTexts, parseAnswer, reportsOf, shortReason } from './answer.mjs'
import { settleBackfill } from './backfill.mjs'
import { failureNotice, givenUpNotice, isFirstFailure, readFailureCause, settleBatch, settleTask } from './failures.mjs'
import { GUEST_HOME, GUEST_PATH, OPENROUTER_HOST, PI_PROGRAM } from './sandbox/index.mjs'
import { saveState, sessionId } from './state.mjs'

const MINUTE = 60 * 1000

// pi's tools: read, bash, edit and write are on by default; grep, find and ls aren't.
export const PI_TOOLS = 'read,bash,edit,write,grep,find,ls'

// ---------------------------------------------------------------------------------------------
// What the sandbox is given

// What the VM sees of the data folder, mounted at its own path, and what it may change (`files`,
// `sandbox/index.mjs`): what the agent's `reads` and `writes` name, and `run/`, which a run needs
// whatever they say; changes only to `writes`, the run's own unless given, and to `run/session/`;
// and never `sessions/`.
export function piFiles(paths, agent, writes = agent.writes) {
  const full = entry => path.join(paths.dataDir, entry.replace(/\/$/, ''))
  return {
    root: paths.dataDir,
    reads: [...agent.reads, ...agent.writes].map(full).concat(paths.agentRun(agent.name)),
    writes: [...writes.map(entry => ({ path: full(entry), folder: entry.endsWith('/') })), { path: paths.agentRunSession(agent.name), folder: true }],
    hide: [paths.agentSessions(agent.name)],
  }
}

// pi's environment, apart from the key's placeholder, which the sandbox sets from the policy. The
// programs that ship with the runner, in the run's `bin/` (`prepareRun`), come first on the `PATH`,
// so the VM finds them by their names, and pi's tools do. The runner refuses a data folder whose
// path holds a `:`, which would split it (`settings.mjs`).
export function piEnv({ timeZone, binDir }) {
  return {
    PATH: `${binDir}:${GUEST_PATH}`,
    HOME: GUEST_HOME,
    LANG: 'C.UTF-8',
    TZ: timeZone,
    PI_SKIP_VERSION_CHECK: '1',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  }
}

// The network policy of a run of `agent`: its model, the internet switch, ZDR, and the key,
// which pi sees only as a placeholder in `OPENROUTER_API_KEY`.
export function piPolicy({ agent, settings }) {
  return {
    model: agent.model,
    internet: settings.agentInternet,
    zdr: settings.zdr,
    secrets: { OPENROUTER_API_KEY: { hosts: [OPENROUTER_HOST], value: settings.openrouterApiKey } },
  }
}

// pi's command, with what milestone 0 found: every kind of discovery off, MCP included; the
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

// The sandbox's spec for one run of pi. `writes` is what the run may change, when it is narrower
// than the agent's own, as for a backfill's batch.
export function runSpec({ agent, settings, paths, prepared, sessionId: id, prompt, writes }) {
  return {
    argv: [PI_PROGRAM, ...piArgs({ agent, prepared, sessionId: id, prompt })],
    cwd: paths.agentDir(agent.name),
    env: piEnv({ timeZone: settings.timeZone, binDir: paths.agentRunBin(agent.name) }),
    files: piFiles(paths, agent, writes),
    timeoutMs: agent.timeoutMinutes * MINUTE,
    policy: piPolicy({ agent, settings }),
  }
}

// ---------------------------------------------------------------------------------------------
// The lock

// Takes `run.lock` for a run that must be over by `deadline`, then looks for `backup.lock`. Returns
// `taken`; `backup` when a backup holds its lock, and `run.lock` has been let go of again; or `busy`
// when `run.lock` was already there, as a `rebuild` holds it. Taking its own lock before
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

// Whether a job is a replayed batch, of a rebuild or a backfill.
export const isReplay = job => job.kind === 'rebuild' || job.kind === 'backfill'

// The commit message: `lifelog: #1050 #1051 #1053` for a batch, `lifelog: scheduled task
// 21:30` for a task; for a replayed batch, the range of its items,
// `lifelog: backfill people-1 #812-#831`, or `lifelog: rebuild #812-#831`, which the
// finished rebuild folds into one commit, `lifelog: rebuild`.
export function commitMessage(agentName, job) {
  if (job.kind === 'scheduled') return `${agentName}: scheduled task ${job.at}`
  const seqs = job.batch.items.map(item => item.seq)
  if (isReplay(job)) {
    const [first, last] = [Math.min(...seqs), Math.max(...seqs)]
    const range = first === last ? `#${first}` : `#${first}-#${last}`
    return job.kind === 'backfill' ? `${agentName}: backfill ${job.id} ${range}` : `${agentName}: rebuild ${range}`
  }
  return `${agentName}: ${seqs.map(seq => `#${seq}`).join(' ')}`
}

// What a run of `job` does to the state, for each kind: live batches and a rebuild's
// settle the live lane of the state they are given, a backfill's batches the backfill's, and tasks
// their dates. Returns `{ state, givenUp }`.
function settleJob(job, state, outcome, timing) {
  if (job.kind === 'messages' || job.kind === 'rebuild') return settleBatch(state, job.batch, outcome, timing)
  if (job.kind === 'backfill') return settleBackfill(state, job.batch, outcome, timing)
  return { state: settleTask(state, job, outcome, timing), givenUp: [] }
}

// Runs one job, and returns `{ state, outcome }`. `job` is
//
//   { kind: 'messages', batch, prompt }            from `buildBatch`
//   { kind: 'scheduled', at, date, task, prompt }  from `nextAction` and `buildTaskPrompt`
//   { kind: 'rebuild', batch, prompt, sessionId }  a rebuild's batch (`rebuild.mjs`)
//   { kind: 'backfill', id, batch, prompt, sessionId, skills, writes }   from `backfillJob`
//
// A replayed batch names its session, null for none, and a backfill's the skills pi gets and what
// it may change, which the sandbox lets through in place of the agent's own `writes`.
//
// `outcome` is `waiting` (a backup or a rebuild holds the locks, and nothing ran), `stopped` (the
// runner is stopping, `signal` aborted the run, and its changes were thrown away, as after a crash),
// or `{ ok, cause }` for a run that finished: `cause` is null after a success, and otherwise
// `setup`, `outage` or `other` (`failureCause`).
//
// Context: `agent`, `settings`, `paths`; `sandbox`; `git` for the agent's folder; `protocol`;
// `ids`, for outbox entries; `index`, the datastore's; `state` and `stateFile`, null for a state
// that isn't saved, as a rebuild keeps its own in memory; `log` and `clock`.
export async function performRun(context) {
  const { agent, settings, paths, sandbox, git, protocol, index, log, clock, state, job, signal } = context
  const startedAt = clock.now()
  const lock = acquireRunLock({ paths, deadline: startedAt + agent.timeoutMinutes * MINUTE, clock })
  if (lock !== 'taken') return { state, outcome: 'waiting', why: lock }
  try {
    const id = isReplay(job)
      ? job.sessionId
      : agent.session === 'daily'
        ? sessionId(agent.name, { now: startedAt, timeZone: settings.timeZone, rolloverHour: settings.sessionRolloverHour })
        : null
    const prepared = prepareRun({ paths, agent, protocol, index, timeZone: settings.timeZone, sessionId: id, skills: job.skills })
    const spec = runSpec({ agent, settings, paths, prepared, sessionId: id, prompt: job.prompt, writes: job.writes })
    const seqs = job.batch ? job.batch.items.map(item => item.seq) : []
    const task = job.kind === 'scheduled' ? job.at : undefined
    log.info('runner.run_started', { agent: agent.name, job: job.kind, seqs, task, backfill: job.kind === 'backfill' ? job.id : undefined, session: id })

    let result
    try {
      result = await sandbox.run(spec, { signal })
    } catch (error) {
      log.error('runner.sandbox_failed', { agent: agent.name, ...errorFields(error) })
      result = { error }
    }
    const endedAt = clock.now()
    if (signal?.aborted) {
      clearRunSession({ paths, agent, log })
      await git.discardChanges()
      log.info('runner.run_stopped', { agent: agent.name, job: job.kind, ms: endedAt - startedAt })
      return { state, outcome: 'stopped' }
    }

    // A run whose answer was cut, or that wrote more than a run may, failed, whatever pi's exit code.
    const exited = !result.error && result.code === 0 && !result.stdoutCut && !result.wroteTooMuch
    const files = exited ? await commitFiles(context) : null
    const timing = { now: endedAt, startedAt, durationMs: Math.max(0, Math.round(endedAt - startedAt)) }
    if (files !== null && files.committed !== undefined) return await afterSuccess(context, { result, sessionId: id, seqs, timing, committed: files.committed })
    return await afterFailure(context, { result, files, seqs, timing })
  } finally {
    releaseLock(paths.runLock)
  }
}

// After pi exited with 0: anything git wouldn't record fails the run, then what
// was staged is committed. Staging is the check's last step, because only git knows every name it
// refuses. Returns `{ committed }`, whether there was a commit; `{ unexpected }`, the path the
// check found; or `{ error }`, when a step failed. Everything here reads what pi left, so any error
// is the run's, and fails it as an unexpected file would. What a run may change, the sandbox held
// it to while it ran, so nothing here compares what changed with what it may change.
async function commitFiles({ agent, git, log, job }) {
  try {
    const unexpected = (await git.unexpectedFile()) ?? (await git.stage())
    if (unexpected !== null) return { unexpected }
    return { committed: await git.commitStaged(commitMessage(agent.name, job)) }
  } catch (error) {
    log.warn('runner.files_failed', { agent: agent.name, ...errorFields(error) })
    return { error }
  }
}

// After the commit: the session, the outbox, the state; then, outside what the run depends
// on, the repository is packed if it needs it.
async function afterSuccess(context, { result, sessionId: id, seqs, timing, committed }) {
  const { agent, paths, git, ids, log, index, state, stateFile, job } = context
  const answer = parseAnswer(result.stdout)
  if (answer.unreadable > 0) log.warn('runner.answer_unreadable', { agent: agent.name, lines: answer.unreadable })
  const dropped = droppedTexts(answer, agent)
  if (dropped > 0) log.warn('runner.answer_texts_dropped', { agent: agent.name, texts: dropped })

  const session = id === null ? 'none' : await keepSession({ paths, agent, sessionId: id, log })
  clearRunSession({ paths, agent, log })

  let next
  let entries
  let reports = null
  if (job.batch) {
    reports = reportsOf(answer, seqs)
    if (reports.unknown.length > 0) log.warn('runner.answer_unknown', { agent: agent.name, seqs: reports.unknown })
    // A replay is silent: its texts, `REPLY_TO` and `NO_REPLY` are ignored.
    entries = isReplay(job) ? [] : answerEntries({ answer, agent, index, about: job.batch.newest, done: reports.done })
    const settled = settleJob(job, state, { ok: true, done: reports.done, failed: reports.failed }, timing)
    next = settled.state
    if (settled.givenUp.length > 0 && !isReplay(job)) entries.push(givenUpNotice(index, settled.givenUp))
  } else {
    const reported = [...new Set([...answer.done, ...answer.failed.map(entry => entry.seq)])].sort((a, b) => a - b)
    // A task has no items to report on.
    if (reported.length > 0) log.warn('runner.answer_unknown', { agent: agent.name, seqs: reported })
    entries = answerEntries({ answer, agent, index })
    next = settleJob(job, state, { ok: true }, timing).state
  }

  for (const entry of entries) await writeOutboxEntry({ paths, ids, entry })
  if (stateFile !== null) saveState(stateFile, next)
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
  if (committed) {
    try {
      await git.pack()
    } catch (error) {
      log.warn('agent.pack_failed', { agent: agent.name, ...errorFields(error) })
    }
  }
  return { state: next, outcome: { ok: true, cause: null } }
}

// After a failed run: throw it away, find why it failed, and count it. `files` is what `commitFiles` found,
// or null when pi itself failed. `run/session/` is emptied first: it frees room, which the clean-up
// needs to make the folders again if pi filled the disk.
async function afterFailure(context, { result, files, seqs, timing }) {
  const { agent, paths, git, ids, log, index, state, stateFile, job } = context
  clearRunSession({ paths, agent, log })
  let cleanup = null
  try {
    await git.discardChanges()
  } catch (error) {
    cleanup = error
  }
  const unexpected = files?.unexpected ?? null
  const failure = readFailureCause({ paths, result, unexpected, filesError: files?.error ?? null, startedAt: timing.startedAt, endedAt: timing.now, log })
  log.warn('runner.run_failed', {
    agent: agent.name,
    job: job.kind,
    cause: failure.cause,
    status: failure.status,
    exitCode: result.code,
    timedOut: result.timedOut,
    stdoutCut: result.stdoutCut || undefined,
    wroteTooMuch: result.wroteTooMuch || undefined,
    // A name pi chose, cut as the reason is: it could hold a message's words.
    file: unexpected === null ? undefined : shortReason(unexpected),
    ms: timing.durationMs,
  })

  const outcome = { ok: false, cause: failure.cause, reason: failure.reason }
  const settled = settleJob(job, state, outcome, timing)
  const next = settled.state
  const entries = []
  // A replay's failures send no notice, and its batches don't count in the live runs'
  // row of failures, which `lastRun` keeps.
  if (!isReplay(job)) {
    if (isFirstFailure(state)) entries.push(failureNotice(job, failure))
    if (settled.givenUp.length > 0) entries.push(givenUpNotice(index, settled.givenUp))
  }
  for (const entry of entries) await writeOutboxEntry({ paths, ids, entry })
  if (stateFile !== null) saveState(stateFile, next)
  // The run is recorded, and its attempt counted; a start cleans up again.
  if (cleanup !== null) throw cleanup
  return { state: next, outcome: { ok: false, cause: failure.cause } }
}
