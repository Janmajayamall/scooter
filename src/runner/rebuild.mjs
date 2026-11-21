// `scooter rebuild <agent>`: an agent's views and memory made again from the
// whole datastore, which is the record (principle 1).
//
// It runs as the runner's user, with the runner's service stopped; in Docker, as
// `docker compose run --rm runner rebuild lifelog`. The bridge keeps running, so messages that
// arrive meanwhile are stored, and handled once the runner is back. In order:
//
// 0. **Alone.** It holds `runner/runner.sock`, as a runner does, so it refuses to start
//    while a runner, another rebuild or `build-image` runs, and nothing of those can start while
//    it does: a runner's start would remove its `run.lock` and git's lock files, and throw its
//    changes away. It also refuses while `run.lock` is there (the plan's rule). Then it
//    readies the agent's folder as a runner's start does, and opens the sandbox.
// 1. **Tag** the last commit `before-rebuild-<UTC time>`, such as
//    `before-rebuild-20261118T101500Z`.
// 2. **Note the newest `seq`** in the datastore, `until`. The rebuild stops there: what comes after
//    it is the runner's, which handles it with replies.
// 3. **Empty** `views/`, `memory/` and `sessions/`, and commit the empty folders, so that a failed
//    batch's clean-up comes back to them. **Reset `state.json`**: `cursor` and `commandSeq` are
//    `until`, so old commands aren't answered again, and a runner started after a rebuild cut
//    short goes on from there, rather than give the agent all of history again with replies;
//    `onceDone` and `backfillDone` are kept; and every backfill of the config counts as done, the
//    one in progress, which is dropped, among them, because the rebuild runs every skill over the
//    history each would cover.
// 4. **Replay** the datastore up to `until`, silently (`replay.mjs`): batches of one of the
//    owner's days, `Now:` each batch's own time, a session for each day, each batch taking
//    `run.lock` and giving way to `backup.lock`. Its progress is a lane it keeps in memory, the
//    live lane's fields of a state that is never saved, and it handles failures as the runner
//    does: items not reported are tried again a minute later, and given up on after
//    `MAX_ATTEMPTS`; a setup error or an outage pauses it until the next try. It waits for an item
//    to be tried again before it takes the items after it, so the history is replayed in its order,
//    and a rule the owner sent is learned before the days after it are filed. Nothing goes
//    to the outbox: it says what it does on its own output instead.
// 5. **Commit** the rebuilt folders as one commit, `lifelog: rebuild`, on the tagged one: each
//    batch committed as it went, so a failed batch's clean-up had its last good state, and those
//    commits are folded into this one. Then write the state, with what it gave up on in `failed`,
//    where an edit of the message brings it back; and remove its sessions.
//
// Steps 1 to 3, and 5, take `run.lock` and give way to `backup.lock`, as each batch does: they
// change `views/`, `memory/` and `.git`, and a backup must not read those halfway.
//
// Rules the owner sent as messages are learned again at the point they were sent. Rules in the
// config apply to all of history.
//
// Cut short, by a stop, a closed terminal or a crash, it leaves the views rebuilt up to where it
// got, and the commits of the batches so far. Run it again: it starts from the beginning.

import { createIds, emptyFolder } from '../common/files.mjs'
import { initialAgentState } from '../common/agentstate.mjs'
import { limits } from '../common/limits.mjs'
import { lockExists, releaseLock } from '../common/locks.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc } from '../common/proc.mjs'
import { isoSeconds, parseIsoSeconds, shortLocalTime, systemClock } from '../common/time.mjs'
import { ConfigError, loadConfig } from './config.mjs'
import { openDatastore } from './datastore.mjs'
import { holdRunnerFolder, readyAgentFolder } from './main.mjs'
import { loadProtocol } from './prompt.mjs'
import { buildReplayBatch, removeReplaySessions, replaySessionId } from './replay.mjs'
import { acquireRunLock, performRun } from './run.mjs'
import { SandboxSetupError } from './sandbox/index.mjs'
import { loadState, saveState } from './state.mjs'

const MINUTE = 60 * 1000

// A rebuild that can't start for how it was called or how things stand: no such agent, a runner
// running, `run.lock` there. `scooter rebuild` exits with 2.
export class RebuildError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RebuildError'
  }
}

// The tag of the commit before a rebuild that started at `now`: `before-rebuild-20261118T101500Z`.
export function rebuildTag(now) {
  return `before-rebuild-${isoSeconds(now).replace(/[-:]/g, '')}`
}

// The state a rebuild leaves, and works from while it runs (step 3): that of an agent that has never
// run, but for `cursor` and `commandSeq`, which are `until`, and the tasks and backfills done. Every
// backfill of `agent`'s config counts as done, as does the one in progress in `before`.
export function rebuiltState(before, agent, until) {
  const done = new Set([...before.backfillDone, ...(before.backfill ? [before.backfill.id] : []), ...agent.run.backfill.map(entry => entry.id)])
  return { ...initialAgentState(), cursor: until, commandSeq: until, onceDone: [...before.onceDone], backfillDone: [...done] }
}

const rangeOf = seqs => {
  const [first, last] = [Math.min(...seqs), Math.max(...seqs)]
  return first === last ? `#${first}` : `#${first}-#${last}`
}
const seqList = seqs => seqs.map(seq => `#${seq}`).join(', ')

// One line for the rebuild's output, about a batch that ran: `after` is the replay's state after
// it, and `outcome` what `performRun` said of it.
function batchReport({ job, day, after, outcome, now, timeZone }) {
  const seqs = new Set(job.batch.items.map(item => item.seq))
  const head = `${day} ${rangeOf([...seqs])}:`
  const waiting = after.retry.filter(entry => seqs.has(entry.seq))
  const givenUp = after.failed.filter(entry => seqs.has(entry.seq)).map(entry => entry.seq)
  const parts = []
  if (outcome.ok) parts.push('done')
  else if (outcome.cause === 'other') parts.push(`failed (${waiting[0]?.reason ?? after.failed.find(entry => seqs.has(entry.seq))?.reason})`)
  else parts.push(`paused (${after.paused.reason}) until ${shortLocalTime(parseIsoSeconds(after.paused.next), now, timeZone)}`)
  if (outcome.ok && waiting.length > 0) parts.push(`not reported, tried again: ${seqList(waiting.map(entry => entry.seq))}`)
  else if (outcome.cause === 'other' && waiting.length > 0) parts.push('tried again in a minute')
  if (givenUp.length > 0) parts.push(`given up on: ${seqList(givenUp)}`)
  return `${head} ${parts.join('; ')}.`
}

// Rebuilds the agent `agentName`, as the module's comment says. Returns `{ stopped, tag, until,
// cursor, batches, failed }`: whether `signal` stopped it first, the tag of the commit before it,
// where it stops, where it got, how many batches it ran, and what it gave up on.
//
// - `settings`: the runner's, from `loadSettings('runner')`.
// - `openSandbox({ paths, settings, log, clock })`: as for the runner (`main.mjs`).
// - `say(line)`: what the rebuild tells the person running it, a line at a time.
// - `clock`, `log`, `proc`: tests give their own.
//
// Throws a `ConfigError` for a bad `agents.yaml`, a `RebuildError` or a `SandboxSetupError` when it
// can't start for how things stand, and anything else that stops it.
export async function rebuildAgent({ settings, agentName, openSandbox, clock = systemClock, log = createLog({ component: 'rebuild', clock }), proc = createProc({ log, clock }), say = () => {}, signal }) {
  const paths = makePaths(settings)
  const { agents } = loadConfig({ paths })
  const agent = agents.find(candidate => candidate.name === agentName)
  if (!agent) throw new RebuildError(`agents.yaml has no agent called ${agentName}; it has ${agents.map(candidate => candidate.name).join(', ')}`)

  let instance
  try {
    instance = await holdRunnerFolder(paths)
  } catch (error) {
    if (error.code === 'EINSTANCE') throw new RebuildError(`it can't run while the runner, another rebuild or build-image does (${error.message}): stop the runner first`)
    throw error
  }
  try {
    if (lockExists(paths.runLock)) {
      throw new RebuildError(`${paths.runLock} is there, though no runner or rebuild is running: one stopped by force left it. Remove it, and run the rebuild again`)
    }
    const stateFile = paths.agentState(agent.name)
    const before = loadState(stateFile)
    const git = await readyAgentFolder({ paths, agent, proc, log, clock })
    const sandbox = await openSandbox({ paths, settings, log, clock })
    const datastore = openDatastore({ paths, clock })
    datastore.poll()
    const { index } = datastore

    const until = index.lastSeq
    const tag = rebuildTag(clock.now())
    const context = { agent, settings, paths, sandbox, git, protocol: loadProtocol(), ids: createIds(clock), log, clock, index, stateFile: null, signal }
    const reset = rebuiltState(before, agent, until)
    let state = { ...reset, cursor: 0 }
    let batches = 0
    let waitingFor = null
    const gaveUp = new Set()
    // Waits `ms`, at least `POLL_INTERVAL`, for `why`: a retry not due yet, a pause, or the locks.
    // Returns false when `signal` stopped it first. Each wait for a retry or a pause is logged; one
    // for the locks, which is tried again every `POLL_INTERVAL`, only when it starts.
    const sleep = async (why, ms) => {
      const wait = Math.max(ms, limits.POLL_INTERVAL)
      if (why === 'retry' || why === 'paused' || waitingFor !== why) log.info('rebuild.waiting', { agent: agent.name, for: why, ms: wait })
      try {
        await clock.sleep(wait, { signal })
        return true
      } catch {
        return false
      }
    }
    // Says that it waits for the locks, once for each wait.
    const waitFor = why => {
      if (waitingFor !== why) say(why === 'backup' ? 'Waiting for a backup to finish.' : `Waiting for ${paths.runLock} to go.`)
    }
    // Does `step` holding `run.lock`, as a batch does, and giving way to a backup in the same way
    // (D181). Returns false when `signal` stopped it before it could.
    const locked = async step => {
      for (;;) {
        const lock = acquireRunLock({ paths, deadline: clock.now() + agent.timeoutMinutes * MINUTE, clock })
        if (lock === 'taken') {
          waitingFor = null
          try {
            await step()
          } finally {
            releaseLock(paths.runLock)
          }
          return true
        }
        waitFor(lock)
        const going = await sleep(lock, limits.POLL_INTERVAL)
        waitingFor = lock
        if (!going) return false
      }
    }
    const stopped = () => {
      log.info('rebuild.stopped', { agent: agent.name, until, cursor: state.cursor, batches })
      say(`Stopped at #${state.cursor} of #${until}, with the views rebuilt only in part. Run the rebuild again; it starts from the beginning.`)
      return { stopped: true, tag, until, cursor: state.cursor, batches, failed: [...gaveUp] }
    }

    // 1 to 3.
    let base = null
    const started = await locked(async () => {
      base = await git.head()
      await git.tag(tag)
      log.info('rebuild.started', { agent: agent.name, until, tag, accel: sandbox.accel })
      say(`Rebuilding ${agent.name} from the datastore, up to #${until}. The last commit before the rebuild is tagged ${tag}.`)
      if (sandbox.accel === 'emulation') say("pi's VMs run under emulation here, because KVM isn't available, so each batch takes much longer.")
      for (const folder of [paths.agentViews(agent.name), paths.agentMemory(agent.name), paths.agentSessions(agent.name)]) emptyFolder(folder)
      const refused = await git.stage()
      if (refused !== null) throw new Error(`git wouldn't stage ${refused} once the views were emptied`)
      await git.commitStaged(`${agent.name}: rebuild, from empty views and memory`)
      saveState(stateFile, reset)
    })
    if (!started) {
      log.info('rebuild.stopped', { agent: agent.name, until, cursor: 0, batches })
      say('Stopped before it changed anything.')
      return { stopped: true, tag: null, until, cursor: 0, batches, failed: [] }
    }

    // 4.
    for (;;) {
      if (signal?.aborted) return stopped()
      const now = clock.now()
      if (state.paused && now < parseIsoSeconds(state.paused.next)) {
        if (!(await sleep('paused', parseIsoSeconds(state.paused.next) - now))) return stopped()
        continue
      }
      // An item to be tried again is waited for, rather than passed by: the items after it, and
      // the days after it, wait with it, as they wait for a pause.
      const waiting = state.retry.map(entry => parseIsoSeconds(entry.due))
      if (waiting.length > 0 && Math.min(...waiting) > now) {
        if (!(await sleep('retry', Math.min(...waiting) - now))) return stopped()
        continue
      }
      const built = buildReplayBatch({
        agent,
        lane: state,
        until,
        index,
        paths,
        now,
        timeZone: settings.timeZone,
        homeCurrency: settings.homeCurrency,
        internet: settings.agentInternet,
      })
      if (built === null) break
      const job = { kind: 'rebuild', batch: built.batch, prompt: built.prompt, sessionId: replaySessionId(agent, { day: built.day }) }
      const done = await performRun({ ...context, state, job })
      if (done.outcome === 'stopped') return stopped()
      if (done.outcome === 'waiting') {
        waitFor(done.why)
        const going = await sleep(done.why, limits.POLL_INTERVAL)
        waitingFor = done.why
        if (!going) return stopped()
        continue
      }
      waitingFor = null
      batches += 1
      state = done.state
      for (const item of built.batch.items) {
        if (state.failed.some(entry => entry.seq === item.seq)) gaveUp.add(item.seq)
        else gaveUp.delete(item.seq)
      }
      say(batchReport({ job, day: built.day, after: state, outcome: done.outcome, now: clock.now(), timeZone: settings.timeZone }))
    }

    // 5. The batches' commits, folded into one on the tagged commit.
    let committed = false
    let sessions = 0
    const finished = await locked(async () => {
      await git.resetTo(base)
      committed = await git.commitStaged(`${agent.name}: rebuild`)
      try {
        await git.pack()
      } catch (error) {
        log.warn('agent.pack_failed', { agent: agent.name, ...errorFields(error) })
      }
      saveState(stateFile, { ...reset, failed: state.failed })
      sessions = removeReplaySessions({ paths, agent, log })
    })
    if (!finished) return stopped()
    const failed = [...gaveUp].sort((a, b) => a - b)
    log.info('rebuild.finished', { agent: agent.name, until, batches, committed, failed: failed.length, sessions })
    say(`Rebuilt ${agent.name} up to #${until}, in ${batches} ${batches === 1 ? 'batch' : 'batches'}${committed ? `, committed as "${agent.name}: rebuild"` : ', which changed nothing'}.`)
    if (failed.length > 0) say(`Given up on: ${seqList(failed)}. An edit of one of these messages brings it back.`)
    return { stopped: false, tag, until, cursor: until, batches, failed }
  } finally {
    await instance.close()
  }
}

// `scooter rebuild <agent>`: rebuilds the agent's views and memory, saying what it does on
// stdout. Stops on SIGTERM, SIGINT or SIGHUP, which a terminal that is closed sends, throwing away
// the batch in progress, and letting go of `run.lock`. Exits with 0 once it has rebuilt, 2 when it
// can't start for how it was called or how things stand, and 1 when it fails or is stopped.
export async function runRebuild({ args = [], settings, stdout = process.stdout, stderr = process.stderr, openSandbox, clock = systemClock, log = createLog({ component: 'rebuild', clock }) }) {
  if (args.length !== 1 || args[0].startsWith('-')) {
    stderr.write("scooter rebuild: name the agent to rebuild, such as: scooter rebuild lifelog\n")
    return 2
  }
  const stopping = new AbortController()
  const handlers = new Map()
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    handlers.set(name, () => stopping.abort())
    process.once(name, handlers.get(name))
  }
  // A closed terminal makes what the rebuild says fail to be written; it stops all the same.
  const quiet = () => {}
  for (const stream of [stdout, stderr]) stream.on?.('error', quiet)
  try {
    const result = await rebuildAgent({ settings, agentName: args[0], openSandbox, clock, log, say: line => stdout.write(`${line}\n`), signal: stopping.signal })
    return result.stopped ? 1 : 0
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) stderr.write(`scooter rebuild: ${problem.message}\n`)
      return 2
    }
    log.error('rebuild.failed', errorFields(error))
    stderr.write(`scooter rebuild: ${error.message}\n`)
    return error instanceof RebuildError || error instanceof SandboxSetupError ? 2 : 1
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler)
  }
}
