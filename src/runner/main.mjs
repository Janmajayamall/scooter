// The runner's service, `scooter runner` (section 6 of DESIGN.md; ARCHITECTURE.md 4.4).
//
// At startup, in order:
// 1. It reads `agents.yaml`, and stops on any fault, naming the field (6.1).
// 2. It makes sure it is the only runner on this data folder (`holdInstance`).
// 3. It frees what pi wrote that a crash or a stop left taking room, before it makes any folder:
//    pi may have filled the disk. Then it creates the agent's folder if it is new (6.2), removes the
//    lock files a git that was killed left there, and throws away the changes of a run that a
//    crash or a stop cut short, so the next run starts from the last commit (6.9).
// 4. It opens the sandbox, which checks the VM image and picks the accelerator (6.6, 6.12).
// 5. It removes a leftover `run.lock` (6.4).
// 6. It writes `status.json`, and tells the owner if its VMs have just fallen back to emulation
//    (6.3, 6.6; rows 6 and 15).
// 7. It brings the state up to date: scheduled tasks already past, a pause tried again at once, and
//    backfills started or dropped (6.4, 6.9, 6.11).
// 8. It reads the datastore.
// 9. Where its service manager doesn't wait between its starts, as Docker's doesn't, and this start
//    follows a stop on an error, it waits as the native unit would have, then records itself as the
//    next stop in a row until a run is recorded (`restarts.mjs`; D229). Nothing before this runs pi.
//
// Then it loops, once every `POLL_INTERVAL`: it reads the lines that are new, asks the planner what
// is next (`nextAction`), and does it. One thing at a time, so runs never overlap.
//
// `scooter runner` (`src/cli.mjs`) runs `runRunner` with the Gondolin sandbox
// (`sandbox/gondolin.mjs`). The tests give the fake one.

import { createIds, ensureDir } from '../common/files.mjs'
import { RUNNER_SOCKET_HOLDERS, holdInstance } from '../common/instance.mjs'
import { limits } from '../common/limits.mjs'
import { lockExists, releaseLock } from '../common/locks.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc } from '../common/proc.mjs'
import { RunnerStatusError, readRunnerStatus } from '../common/runnerstatus.mjs'
import { systemClock } from '../common/time.mjs'
import { ensureAgentDir } from './agentdir.mjs'
import { backfillJob, finishBackfill } from './backfill.mjs'
import { buildBatch, buildTaskPrompt } from './batch.mjs'
import { handleCommands } from './commands.mjs'
import { ConfigError, loadConfig } from './config.mjs'
import { openDatastore } from './datastore.mjs'
import { createGit } from './git.mjs'
import { loadProtocol } from './prompt.mjs'
import { removeReplaySessions } from './replay.mjs'
import { openRestarts } from './restarts.mjs'
import { performRun } from './run.mjs'
import { SandboxSetupError } from './sandbox/index.mjs'
import { loadState, saveState, startupState } from './state.mjs'
import { emulationNotice, runnerStatus, writeRunnerStatus } from './status.mjs'
import { nextAction } from './triggers.mjs'

// Makes the data folder's folders that the runner uses, if they are missing: `setup` makes them in
// an install (8.4), so this is for development. Then holds `runner/runner.sock`, for a runner or a
// rebuild, and returns what `holdInstance` returns: nothing else of the runner's may run on the
// data folder meanwhile. It throws if something else holds it.
export async function holdRunnerFolder(paths) {
  ensureDir(paths.dataDir, { mode: 0o755 })
  for (const folder of [paths.runner, paths.agents, paths.exchange, paths.locks]) ensureDir(folder, { mode: 0o700 })
  return holdInstance(paths.runnerSocket, RUNNER_SOCKET_HOLDERS)
}

// Readies the agent's folder for runs, as a start does, before anything runs there (D89): frees
// what pi wrote that a crash or a stop left taking room, before it makes any folder; creates the
// folder if it is new (6.2); removes the lock files a git that was killed left; and throws away
// the changes of a run that a crash or a stop cut short, so the next run starts from the last
// commit (6.9). Returns git for the folder (`createGit`). The caller holds `runner.sock`.
export async function readyAgentFolder({ paths, agent, proc, log, clock }) {
  const git = createGit({ proc, dir: paths.agentDir(agent.name), discardDir: paths.agentDiscarded(agent.name), log, clock })
  await ensureAgentDir({ paths, name: agent.name, git, log })
  await git.discardChanges()
  return git
}

// Starts the runner, without its loop: everything up to the loop. Returns the runner, whose
// `tick()` does one round of the loop. Throws a `ConfigError` for a bad `agents.yaml`, and anything
// else that stops a start.
//
// - `settings`: the runner's, from `loadSettings('runner')`.
// - `openSandbox({ paths, settings, log, clock })`: opens the sandbox runs go through (`sandbox/`),
//   checking what it needs.
// - `clock`, `log`, `proc`: tests give their own.
// - `restartWaits`: whether the runner keeps its own waits between starts, where its service
//   manager doesn't wait (`restarts.mjs`; D229). `scooter runner` says, by its environment.
export async function openRunner({ settings, openSandbox, clock = systemClock, log = createLog({ component: 'runner', clock }), proc = createProc({ log, clock }), restartWaits = false }) {
  const paths = makePaths(settings)
  const { agents } = loadConfig({ paths })
  // There is exactly one agent in v2 (6.1).
  const [agent] = agents

  const instance = await holdRunnerFolder(paths)
  try {
    // What pi left is freed before the sandbox opens, which may need room on the disk.
    const git = await readyAgentFolder({ paths, agent, proc, log, clock })
    const sandbox = await openSandbox({ paths, settings, log, clock })

    if (lockExists(paths.runLock)) {
      releaseLock(paths.runLock)
      log.warn('runner.lock_removed', { lock: 'run.lock' })
    }

    const ids = createIds(clock)
    const restarts = restartWaits ? openRestarts({ paths, clock, log, ids, timeZone: settings.timeZone }) : null
    let previous = null
    try {
      previous = readRunnerStatus(paths.runnerStatus)
    } catch (error) {
      if (!(error instanceof RunnerStatusError)) throw error
      log.warn('runner.status_unreadable', errorFields(error))
    }
    const status = runnerStatus({ settings, agents, sandbox, now: clock.now(), restarts })
    const notice = emulationNotice({ previous, status, accelSetting: settings.agentAccel })
    if (notice) await writeOutboxEntry({ paths, ids, entry: notice })
    writeRunnerStatus(paths, status)
    log.info('runner.accelerator', { accel: sandbox.accel, setting: settings.agentAccel, noticed: notice !== null })

    const stateFile = paths.agentState(agent.name)
    const started = startupState(loadState(stateFile), agent, { now: clock.now(), timeZone: settings.timeZone })
    let state = started.state
    saveState(stateFile, state)
    if (started.dropped) {
      // Its sessions served it alone.
      const sessions = removeReplaySessions({ paths, agent, backfill: started.dropped, log })
      log.info('runner.backfill_dropped', { agent: agent.name, backfill: started.dropped, sessions })
    }
    if (started.started) log.info('runner.backfill_started', { agent: agent.name, backfill: started.started, until: state.backfill.until })

    const datastore = openDatastore({ paths, clock })
    datastore.poll()
    const protocol = loadProtocol()
    // The `once` tasks run since this start, whatever came of them (D68).
    const onceTried = new Set()
    let waitingFor = null

    async function run(job, signal) {
      const done = await performRun({ agent, settings, paths, sandbox, git, protocol, ids, log, clock, index: datastore.index, state, stateFile, job, signal })
      state = done.state
      if (done.outcome === 'waiting') {
        if (waitingFor !== done.why) log.info('runner.waiting', { agent: agent.name, for: done.why })
        waitingFor = done.why
      } else {
        waitingFor = null
      }
      return done
    }

    // One round of the loop: reads the new lines, and does what comes next. Returns
    // `{ action, outcome }`: what `nextAction` said, and for a run, what came of it (`performRun`).
    async function tick({ signal } = {}) {
      datastore.poll()
      const now = clock.now()
      const action = nextAction({
        agent,
        state,
        index: datastore.index,
        now,
        timeZone: settings.timeZone,
        batchSeconds: settings.batchSeconds,
        incomingSeenAt: datastore.incomingSeenAt,
        onceTried,
      })
      const prompts = { agent, paths, now, timeZone: settings.timeZone, homeCurrency: settings.homeCurrency, internet: settings.agentInternet }

      if (action.kind === 'commands') {
        state = await handleCommands({
          agent,
          state,
          lines: action.lines,
          stateFile,
          paths,
          ids,
          log,
          now,
          timeZone: settings.timeZone,
          rolloverHour: settings.sessionRolloverHour,
        })
        return { action }
      }
      if (action.kind === 'messages') {
        const built = buildBatch({ agent, state, index: datastore.index, ...prompts })
        if (!built) return { action }
        const { outcome } = await run({ kind: 'messages', batch: built.batch, prompt: built.prompt }, signal)
        return { action, outcome }
      }
      if (action.kind === 'scheduled') {
        const prompt = buildTaskPrompt({ task: action.task, ...prompts })
        const { outcome } = await run({ kind: 'scheduled', at: action.at, date: action.date, task: action.task, prompt }, signal)
        return { action, outcome }
      }
      if (action.kind === 'once') {
        onceTried.add(action.id)
        const prompt = buildTaskPrompt({ task: action.task, ...prompts })
        const { outcome } = await run({ kind: 'once', id: action.id, task: action.task, prompt }, signal)
        // Tried again as the next try after a setup error or an outage, or whenever it didn't run.
        if (typeof outcome === 'string' || outcome.cause === 'setup' || outcome.cause === 'outage') onceTried.delete(action.id)
        return { action, outcome }
      }
      // A backfill's batch, and finishing it (6.11; `backfill.mjs`). `nextAction` names only a
      // backfill whose entry is in the config.
      if (action.kind === 'backfill') {
        const entry = agent.run.backfill.find(candidate => candidate.id === action.id)
        const job = backfillJob({ agent, entry, state, index: datastore.index, ...prompts })
        if (job === null) return { action }
        const { outcome } = await run(job, signal)
        return { action, outcome }
      }
      if (action.kind === 'backfill-finished') {
        const entry = agent.run.backfill.find(candidate => candidate.id === action.id)
        state = await finishBackfill({ agent, entry, state, stateFile, paths, ids, log })
        return { action }
      }
      return { action }
    }

    return {
      paths,
      agent,
      sandbox,
      datastore,
      restarts,
      tick,
      get state() {
        return state
      },
      close: () => instance.close(),
    }
  } catch (error) {
    await instance.close()
    throw error
  }
}

// Starts the runner and its loop. Returns the runner, with `fatal`, which resolves with an error
// when the runner can't go on, and `stop()`, which stops it: a run in progress is cut short and
// thrown away, as after a crash, and the lock is let go of.
export async function startRunner(options) {
  const { clock = systemClock } = options
  const log = options.log ?? createLog({ component: 'runner', clock })
  const runner = await openRunner({ ...options, clock, log })
  const stopping = new AbortController()
  let reportFatal
  const fatal = new Promise(resolve => (reportFatal = resolve))

  const { restarts } = runner
  const fail = error => {
    log.error('runner.failed', errorFields(error))
    restarts?.failed(error)
    reportFatal(error)
  }

  const loop = (async () => {
    if (restarts) {
      try {
        await restarts.wait({ signal: stopping.signal })
      } catch {
        return
      }
      // Recorded as the next stop in a row before anything can run pi; if it can't be, nothing runs.
      try {
        restarts.begin()
      } catch (error) {
        fail(error)
        return
      }
    }
    while (!stopping.signal.aborted) {
      let done
      try {
        done = await runner.tick({ signal: stopping.signal })
      } catch (error) {
        fail(error)
        return
      }
      // A run was recorded: what stops the runner from here on isn't a fault that stops every run.
      if (typeof done.outcome === 'object') restarts?.ranThrough()
      try {
        await clock.sleep(limits.POLL_INTERVAL, { signal: stopping.signal })
      } catch {
        return
      }
    }
  })()
  log.info('runner.started', { agent: runner.agent.name, accel: runner.sandbox.accel })

  let stopped = null
  return {
    ...runner,
    get state() {
      return runner.state
    },
    fatal,
    stop: () =>
      (stopped ??= (async () => {
        stopping.abort()
        await loop
        // Asked to stop, it ends the waits; after a failure, which `fail` recorded, it doesn't.
        restarts?.stopped()
        await runner.close()
        log.info('runner.stopped')
      })()),
  }
}

// `scooter runner`: runs the runner until SIGTERM or SIGINT. Exits with 2 for a bad `agents.yaml`,
// or a sandbox that can't run as it is set up (no VM image, one for another pi, a forced
// accelerator that isn't there), and with 1 if it can't start or can't go on for another reason.
// `openSandbox` opens the sandbox its runs go through; `restartWaits`, whether the runner keeps its
// own waits between starts (`restarts.mjs`).
export async function runRunner({ settings, stderr, openSandbox, clock = systemClock, restartWaits = false }) {
  const log = createLog({ component: 'runner', clock })
  let runner
  try {
    runner = await startRunner({ settings, openSandbox, clock, log, restartWaits })
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) stderr.write(`scooter runner: ${problem.message}\n`)
      return 2
    }
    log.error('runner.start_failed', errorFields(error))
    // For the person starting it. What can fail here names a path, a file and a line, or a field.
    stderr.write(`scooter runner: ${error.message}\n`)
    return error instanceof SandboxSetupError ? 2 : 1
  }
  const handlers = new Map()
  const outcome = await new Promise(resolve => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      handlers.set(signal, () => resolve(signal))
      process.once(signal, handlers.get(signal))
    }
    runner.fatal.then(() => resolve('fatal'))
  })
  for (const [signal, handler] of handlers) process.off(signal, handler)
  log.info('runner.stopping', { reason: outcome })
  await runner.stop()
  return outcome === 'fatal' ? 1 : 0
}
