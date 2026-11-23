// One run: from `run.lock` to the state update.
//
// 1. **Lock.** Take `run.lock`, recording when the run must be over, then look for `backup.lock`.
//    If a backup holds it, let go of `run.lock` and wait.
// 2. **Prepare** `run/`: a copy of the prompt and skills, the runner's own skill and programs,
//    ICU's zone rules, the index file, a copy of the current session, and an empty `send/`.
// 3. **Run** pi in the sandbox, with its command, what it sees and may change, its environment and
//    the network policy.
// 4. **After a run that passed,** pi exiting with 0 and its files passing the check, in this
//    order: check the files pi left, staging them as the check's last step; commit; copy its
//    session back; write to the outbox the messages `send` queued; update the state from the marks
//    `mark` wrote; then, in quiet mode, write a reaction for each message marked done that no
//    message answered. Then the repository is packed if it needs it.
// 5. **After a failed run**: throw away its session, what it queued and marked, and its changes;
//    read why it failed from the network log, and update the state, with a notice for the first
//    failure in a row. Every line it was given has used an attempt, as its cause says.
// 6. **Release** the lock.
//
// Nothing in pi's output decides anything: the runner reads what `send` and `mark` left, and only
// once the run has passed (`report.mjs`).
//
// Everything from the check to the commit reads what pi left, so an error there, such as a git
// command that times out, fails the run like an unexpected file, and counts an attempt: it never
// stops the runner, which would run the same batch again at its next start without counting one.
// What the run could write in `run/` is cleared before the run is recorded (`clearRunWrites`),
// and on a failure what `writes` names in the agent's folder is cleaned up after it, so nothing pi
// left takes room the clean-up, the outbox or the state needs: pi may have filled the disk. A
// clean-up that can't finish stops the runner, once the run is recorded.
//
// A crash between the commit and the state only means the lines are given again, and the agent may
// then send a second time what it sent. One between the state and the reactions loses that run's
// reactions: its lines are done, and a reaction says only that.
//
// A batch of a job of `scooter backfill` (`backfill.mjs`, `replay.mjs`) is a run like the others,
// with its own session, skills, prompt and commit message, and four differences: it sends
// nothing, neither texts, reactions nor notices; it may change only what the job may, which the
// sandbox holds it to; it may be a run of an agent given in a file, which has a folder of its own;
// and it settles the job's own lane, in the job's file, which is saved before the state, and
// leaves `lastRun` alone. A crash between the two loses only the pause the batch started or ended,
// which a start tries again at once.

import path from 'node:path'
import { ensureDir } from '../common/files.mjs'
import { lockExists, releaseLock, takeLock } from '../common/locks.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { clearRunWrites, keepSession, prepareRun } from './agentdir.mjs'
import { failureNotice, givenUpNotice, isFirstFailure, pauseAfterRun, readFailureCause, settleBatch, settleTask } from './failures.mjs'
import { ackEntries, marksOf, readMarks, readSends, sendEntries, shortReason } from './report.mjs'
import { GUEST_HOME, GUEST_PATH, OPENROUTER_HOST, PI_PROGRAM } from './sandbox/index.mjs'
import { saveState, sessionId } from './state.mjs'

const MINUTE = 60 * 1000

// pi's tools: read, bash, edit and write are on by default; grep, find and ls aren't.
export const PI_TOOLS = 'read,bash,edit,write,grep,find,ls'

// ---------------------------------------------------------------------------------------------
// What the sandbox is given

// What the VM sees of the data folder, mounted at its own path, and what it may change (`files`,
// `sandbox/index.mjs`): what the agent's `reads` and `writes` name, and `run/`, which a run needs
// whatever they say; changes only to `writes`, the run's own unless given, and to the run's own
// places in `run/`, `session/`, `send/` and `marks.txt`; and never `sessions/` or `jobs/`, the
// runner's own: the sessions of every day, and the jobs of `scooter backfill`, whose prompts and
// progress are the owner's and the runner's.
export function piFiles(paths, agent, writes = agent.writes) {
  const full = entry => path.join(paths.dataDir, entry.replace(/\/$/, ''))
  const name = agent.name
  return {
    root: paths.dataDir,
    reads: [...agent.reads, ...agent.writes].map(full).concat(paths.agentRun(name)),
    writes: [
      ...writes.map(entry => ({ path: full(entry), folder: entry.endsWith('/') })),
      { path: paths.agentRunSession(name), folder: true },
      { path: paths.agentRunSend(name), folder: true },
      { path: paths.agentRunMarks(name), folder: false },
    ],
    hide: [paths.agentSessions(name), paths.agentJobs(name)],
  }
}

// pi's environment, apart from the key's placeholder, which the sandbox sets from the policy. The
// programs that ship with the runner, in the run's `bin/` (`prepareRun`), come first on the `PATH`,
// so the VM finds them by their names, and pi's tools do. The runner refuses a data folder whose
// path holds a `:`, which would split it (`settings.mjs`). `ICU_TIMEZONE_FILES_DIR` is the run's
// copy of ICU's zone rules, `icuTzDir`, which every Node in the VM, `show` and pi, then converts
// times with, in place of the image's own.
export function piEnv({ timeZone, binDir, icuTzDir }) {
  return {
    PATH: `${binDir}:${GUEST_PATH}`,
    HOME: GUEST_HOME,
    LANG: 'C.UTF-8',
    TZ: timeZone,
    ICU_TIMEZONE_FILES_DIR: icuTzDir,
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
// session by its ID in `run/session/`, or none; the run's copy of the agent's prompt, which pi
// appends to its own system prompt, and the skills, from `run/`; and the prompt as one argument
// after `--`, so nothing in it can pass for a flag.
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
    prepared.promptFile,
    ...prepared.skillDirs.flatMap(dir => ['--skill', dir]),
    '--',
    prompt,
  ]
}

// The sandbox's spec for one run of pi. `writes` is what the run may change, when it is another
// than the agent's own, as for a job's batch.
export function runSpec({ agent, settings, paths, prepared, sessionId: id, prompt, writes }) {
  return {
    argv: [PI_PROGRAM, ...piArgs({ agent, prepared, sessionId: id, prompt })],
    cwd: paths.agentDir(agent.name),
    env: piEnv({ timeZone: settings.timeZone, binDir: paths.agentRunBin(agent.name), icuTzDir: paths.agentRunIcuTz(agent.name) }),
    files: piFiles(paths, agent, writes),
    timeoutMs: agent.timeoutMinutes * MINUTE,
    policy: piPolicy({ agent, settings }),
  }
}

// ---------------------------------------------------------------------------------------------
// The lock

// Takes `run.lock` for a run that must be over by `deadline`, then looks for `backup.lock`. Returns
// `taken`; `backup` when a backup holds its lock, and `run.lock` has been let go of again; or `busy`
// when `run.lock` was already there, which nothing of Scooter's but the runner itself makes, and
// it removes one left over at its start. Taking its own lock before looking for the other's is
// what keeps a run and a backup from starting at the same instant: when the two appear together,
// the runner gives way.
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

// Whether a job is a replayed batch, a job's of `scooter backfill`.
export const isReplay = job => job.kind === 'backfill'

// The commit message: `lifelog: #1050 #1051 #1053` for a batch, `lifelog: scheduled task
// 21:30` for a task; for a job's batch, the job's ID and the range of its items,
// `lifelog: backfill 20261123T101500123-0001 #812-#831`.
export function commitMessage(agentName, job) {
  if (job.kind === 'scheduled') return `${agentName}: scheduled task ${job.at}`
  const seqs = job.batch.items.map(item => item.seq)
  if (isReplay(job)) {
    const [first, last] = [Math.min(...seqs), Math.max(...seqs)]
    return `${agentName}: backfill ${job.id} ${first === last ? `#${first}` : `#${first}-#${last}`}`
  }
  return `${agentName}: ${seqs.map(seq => `#${seq}`).join(' ')}`
}

// What a run of `job` does to the state, for each kind: live batches settle the live lane, tasks
// their dates, and a job's batches the job's own lane (`job.settle`), and of the state only the
// pause. Returns `{ state, givenUp, progress }`, `progress` being the job's after the batch, or
// undefined for a live run.
function settleJob(job, state, outcome, timing) {
  if (job.kind === 'messages') return settleBatch(state, job.batch, outcome, timing)
  if (job.kind === 'backfill') return { ...job.settle(outcome, timing), state: pauseAfterRun(state, outcome, timing) }
  return { state: settleTask(state, job, outcome, timing), givenUp: [] }
}

// Runs one job, and returns `{ state, outcome }`. `job` is
//
//   { kind: 'messages', batch, prompt }            from `buildBatch`
//   { kind: 'scheduled', at, tag, date, prompt }   from `nextAction` and `scheduledPrompt`
//   { kind: 'backfill', id, batch, prompt, sessionId, skills, writes, settle, save }
//                                                  a job's batch, from `batchOfJob` (`backfill.mjs`)
//
// A job's batch names its session, null for none, the skills pi gets and what it may change,
// which the sandbox lets through in place of the agent's own `writes`; `settle(outcome, timing)`
// gives the job's progress after the batch, `{ progress, givenUp }`, and `save(progress)` writes it
// to the job's file.
//
// `outcome` is `waiting` (a backup holds its lock, or `run.lock` is another's, and nothing ran),
// `stopped` (the runner is stopping, `signal` aborted the run, and its changes were thrown away,
// as after a crash), or `{ ok, cause }` for a run that finished: `cause` is null after a success,
// and otherwise `setup`, `outage` or `other` (`failureCause`).
//
// Context: `agent`, the agent the run is of, an agent given in a file for such a job's batch;
// `settings`, `paths`; `sandbox`; `git` for that agent's folder; `ids`, for outbox entries;
// `index`, the datastore's; `state` and `stateFile`, the state of the runner's agent, which holds
// the pause of every run; `log` and `clock`.
export async function performRun(context) {
  const { agent, settings, paths, sandbox, git, index, log, clock, state, job, signal } = context
  const startedAt = clock.now()
  const lock = acquireRunLock({ paths, deadline: startedAt + agent.timeoutMinutes * MINUTE, clock })
  if (lock !== 'taken') return { state, outcome: 'waiting', why: lock }
  try {
    const id = isReplay(job)
      ? job.sessionId
      : agent.session === 'daily'
        ? sessionId(agent.name, { now: startedAt, timeZone: settings.timeZone, rolloverHour: settings.sessionRolloverHour })
        : null
    const prepared = prepareRun({ paths, agent, index, sessionId: id, skills: job.skills })
    const spec = runSpec({ agent, settings, paths, prepared, sessionId: id, prompt: job.prompt, writes: job.writes })
    const seqs = job.batch ? job.batch.items.map(item => item.seq) : []
    // A scheduled task by its tag: the log keeps `at` for its line's own time.
    const tag = job.kind === 'scheduled' ? job.tag : undefined
    log.info('runner.run_started', { agent: agent.name, job: job.kind, seqs, tag, backfill: isReplay(job) ? job.id : undefined, session: id })

    let result
    try {
      result = await sandbox.run(spec, { signal })
    } catch (error) {
      log.error('runner.sandbox_failed', { agent: agent.name, ...errorFields(error) })
      result = { error }
    }
    const endedAt = clock.now()
    if (signal?.aborted) {
      clearRunWrites({ paths, agent, log })
      await git.discardChanges()
      log.info('runner.run_stopped', { agent: agent.name, job: job.kind, ms: endedAt - startedAt })
      return { state, outcome: 'stopped' }
    }

    // A run that wrote more than a run may failed, whatever pi's exit code. Nothing pi printed counts.
    const exited = !result.error && result.code === 0 && !result.wroteTooMuch
    const files = exited ? await commitFiles(context) : null
    const timing = { now: endedAt, startedAt, durationMs: Math.max(0, Math.round(endedAt - startedAt)) }
    if (files !== null && files.committed !== undefined) return await afterSuccess(context, { sessionId: id, seqs, timing, committed: files.committed })
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

// After the commit: the session; the outbox, from what `send` queued; the state, from what `mark`
// wrote; the reactions; then, outside what the run depends on, the repository is packed if it needs
// it. What `send` and `mark` left is read before anything is written, and cleared at once, and
// `run/session/` once the session is kept, so nothing pi wrote there takes room the session's
// copy, the outbox or the state needs.
//
// - The messages: at most `RUN_MAX_SENDS` go out, the first ones; the rest, and what isn't a
//   message `send` writes, are dropped and counted in the log. A replay's, and with `sends: []`
//   every one, are dropped too: a replay sends nothing.
// - The marks: a line the run wasn't given is ignored and logged, and a scheduled run's marks
//   all are, since it is given none.
async function afterSuccess(context, { sessionId: id, seqs, timing, committed }) {
  const { agent, paths, git, ids, log, index, state, stateFile, job } = context
  const sends = readSends(paths.agentRunSend(agent.name))
  const marks = readMarks(paths.agentRunMarks(agent.name))
  clearRunWrites({ paths, agent, log, session: false })
  const session = id === null ? 'none' : await keepSession({ paths, agent, sessionId: id, log })
  clearRunWrites({ paths, agent, log })

  if (sends.error !== null) log.warn('runner.sends_unreadable', { agent: agent.name, error: sends.error })
  const silent = isReplay(job) || agent.sends.length === 0
  const dropped = { past: sends.past, refused: sends.refused, silent: silent ? sends.messages.length : 0 }
  if (dropped.past + dropped.refused + dropped.silent > 0) log.warn('runner.sends_dropped', { agent: agent.name, ...dropped })
  if (marks.refused !== null) log.warn('runner.marks_refused', { agent: agent.name, error: marks.refused })
  if (marks.unreadable > 0) log.warn('runner.marks_unreadable', { agent: agent.name, lines: marks.unreadable })

  const marked = marksOf(marks, seqs)
  if (marked.unknown.length > 0) log.warn('runner.marks_unknown', { agent: agent.name, count: marked.unknown.length, seqs: marked.unknown.slice(0, limits.LOGGED_SEQS_MAX) })
  const about = job.batch ? job.batch.newest : null
  const { entries: texts, answered } = silent ? { entries: [], answered: new Set() } : sendEntries({ messages: sends.messages, agent, index, about })

  const settled = settleJob(job, state, job.batch ? { ok: true, done: marked.done, failed: marked.failed } : { ok: true }, timing)
  const next = settled.state
  const notices = settled.givenUp.length > 0 && !isReplay(job) ? [givenUpNotice(index, settled.givenUp)] : []
  const reactions = job.batch && !isReplay(job) ? ackEntries({ agent, index, done: marked.done, answered }) : []

  for (const entry of [...texts, ...notices]) await writeOutboxEntry({ paths, ids, entry })
  if (settled.progress) job.save(settled.progress)
  saveState(stateFile, next)
  for (const entry of reactions) await writeOutboxEntry({ paths, ids, entry })
  log.info('runner.run_finished', {
    agent: agent.name,
    job: job.kind,
    ok: true,
    ms: timing.durationMs,
    done: job.batch ? marked.done.size : undefined,
    failed: job.batch ? marked.failed.size : undefined,
    notMarked: job.batch ? seqs.length - marked.done.size - marked.failed.size : undefined,
    texts: texts.length,
    reactions: reactions.length,
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
// or null when pi itself failed. What the run could write in `run/` is cleared first, unread: what
// it queued goes nowhere, and what it marked settles nothing. Clearing frees room, which the
// clean-up needs to make the folders again if pi filled the disk.
async function afterFailure(context, { result, files, seqs, timing }) {
  const { agent, paths, git, ids, log, index, state, stateFile, job } = context
  clearRunWrites({ paths, agent, log })
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
  if (settled.progress) job.save(settled.progress)
  saveState(stateFile, next)
  // The run is recorded, and its attempt counted; a start cleans up again.
  if (cleanup !== null) throw cleanup
  return { state: next, outcome: { ok: false, cause: failure.cause } }
}
