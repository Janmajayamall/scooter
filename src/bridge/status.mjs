// `scooter status`, and the bridge's `status.json` it reads.
//
// The report says how Scooter is doing: each channel, the newest message, the runner and its
// agent, the network log and the backups. It is made only from files, so it works with the bridge
// stopped, and it changes nothing: it takes no lock and no socket, and writes no file.
//
// - **The bridge's part**, each channel's line and the backups' line, comes from
//   `bridge/status.json`, which the running bridge writes (`createStatusFile`):
//
//     {
//       "startedAt": "2026-11-09T06:00:00Z",
//       "writtenAt": "2026-11-09T15:50:12Z",
//       "stoppedAt": null,
//       "channels": {"whatsapp": "WhatsApp: linked", "email": "Email: connected, last checked 21:20; 2 stored and 1 skipped in the last 24 hours."},
//       "backups": "Backups: last 03:30, snapshot 1a2b3c4d. Next Tue 10 Nov 03:30."
//     }
//
//   The lines are as the bridge rendered them at `writtenAt`, with times in `SCOOTER_TZ` against
//   that instant. The bridge renders them every `POLL_INTERVAL` and writes the file, atomically,
//   whenever they differ from what it last wrote, and once more when it stops, with `stoppedAt`.
//   A bridge that stops between a change and the write leaves the last file, which says when it
//   was written, and the report says so.
// - **The newest message, and each agent's pending messages,** come from the datastore, read
//   without changing anything, as the runner reads it.
// - **The runner's part** comes from three of the runner's files, since a command of the bridge's
//   side reads neither `config/` nor `runner.env`: `status.json` for the runner's settings, each
//   agent's `state.json` for its runs, and the network log for the last 24 hours. Before the
//   runner has ever started there is no `status.json`, and so no agent to report on.
//
// It reports what it can read, and says so when a file isn't there yet or can't be read. The
// command runs as root natively, and the runner's user writes the runner's files, so each is read
// without following a link, without waiting on a FIFO, and only if it is a regular file of a
// bounded size (`readUntrustedFile`), and only in a folder that is one, not a link to one
// (`checkOwnFolder`): what isn't is said to be unreadable, and the rest is reported. Every control
// character in the report is printed as U+FFFD, so that nothing the runner's user wrote, such as a
// reason, can act on the terminal of the root who reads it.
//
// Times are in `SCOOTER_TZ`. The report is a function of the files and the clock, so a test can
// give it both.

import { AgentStateError, readAgentState } from '../common/agentstate.mjs'
import { createIndex } from '../common/datastore/index.mjs'
import { DatastoreError, SOURCES } from '../common/datastore/line.mjs'
import { createReader } from '../common/datastore/reader.mjs'
import { checkOwnFolder, readUntrustedFile, writeFileAtomic } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { scanNetworkLog } from '../common/netlog.mjs'
import { makePaths } from '../common/paths.mjs'
import { RunnerStatusError, readRunnerStatus } from '../common/runnerstatus.mjs'
import { isoSeconds, parseIsoSeconds, shortLocalTime, systemClock, toLocal } from '../common/time.mjs'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CHANNEL_NAMES = { whatsapp: 'WhatsApp', email: 'email' }

// The kinds of line that are work for an agent.
const WORK = ['message', 'edit', 'delete']

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isLine = value => typeof value === 'string' && value !== ''
const isTime = value => parseIsoSeconds(value) !== null
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const pad = number => String(number).padStart(2, '0')
// A line of the report as it is printed: every control character, a line break among them, as
// U+FFFD.
const shown = text => text.replace(/\p{Cc}/gu, '�')

// ---------------------------------------------------------------------------------------------
// The bridge's `status.json`

const FIELDS = ['startedAt', 'writtenAt', 'stoppedAt', 'channels', 'backups']

// What is wrong with a bridge's status, as a list of statements that name fields. An empty list
// means it is well formed.
export function checkBridgeStatus(status) {
  if (!isObject(status)) return ['the status must be an object']
  const problems = []
  for (const name of Object.keys(status)) {
    if (!FIELDS.includes(name)) problems.push(`${name} is not a field of the status`)
  }
  for (const name of FIELDS) {
    if (status[name] === undefined) problems.push(`${name} is missing`)
  }
  for (const name of ['startedAt', 'writtenAt']) {
    if (status[name] !== undefined && !isTime(status[name])) problems.push(`${name} must be a UTC time to the second`)
  }
  if (status.stoppedAt !== undefined && status.stoppedAt !== null && !isTime(status.stoppedAt)) {
    problems.push('stoppedAt must be a UTC time to the second, or null')
  }
  const channels = status.channels
  if (channels !== undefined && !(isObject(channels) && Object.entries(channels).every(([name, line]) => SOURCES.includes(name) && isLine(line)))) {
    problems.push(`channels must give a line for each channel, named ${SOURCES.join(' or ')}`)
  }
  if (status.backups !== undefined && !isLine(status.backups)) problems.push('backups must be a line')
  return problems
}

// Something is wrong with the bridge's `status.json`. The message names the file and the fields.
export class BridgeStatusError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeStatusError'
  }
}

// Reads the bridge's `status.json`, as it reads the runner's: without following a link, without
// waiting on a FIFO, and up to `STATUS_FILE_MAX_BYTES`. Returns null when there is none, which is
// so until the bridge first starts, and throws a `BridgeStatusError` when it isn't a status.
export function readBridgeStatus(paths) {
  let status
  try {
    status = JSON.parse(readUntrustedFile(paths.bridgeStatus, { maxBytes: limits.STATUS_FILE_MAX_BYTES }))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error instanceof SyntaxError) throw new BridgeStatusError(`${paths.bridgeStatus} is not JSON`)
    throw error
  }
  const problems = checkBridgeStatus(status)
  if (problems.length > 0) throw new BridgeStatusError(`${paths.bridgeStatus}: ${problems.join('; ')}`)
  return status
}

// Writes the bridge's `status.json`, atomically, mode 0600, in the bridge's own folder. Throws if
// the status isn't well formed, before anything is written.
export function writeBridgeStatus(paths, status) {
  const problems = checkBridgeStatus(status)
  if (problems.length > 0) throw new Error(`not a bridge status: ${problems.join('; ')}`)
  writeFileAtomic(paths.bridgeStatus, `${JSON.stringify(status)}\n`, { mode: 0o600 })
}

// Returns the bridge's writer of its `status.json`. `render(now)` returns the part that changes,
// `{ channels, backups }`: each channel's line, by name, and the backups' line. Options: `paths`,
// `clock`, `log`.
//
// `start()` writes the file, then looks every `POLL_INTERVAL`, and writes it whenever what `render`
// returns differs from what it last wrote. `stop()` stops looking, and writes the file once more,
// with `stoppedAt`. A write that fails, as on a full disk, is logged once, and tried again at the
// next look: the file stays as it was meanwhile, and says when it was written.
export function createStatusFile({ paths, clock = systemClock, log, render }) {
  const startedAt = isoSeconds(clock.now())
  const stopping = new AbortController()
  // What was last written, but for `writtenAt`, as JSON.
  let written = null
  let failing = false
  let loop = null
  let stopped = null

  // Never throws: what goes wrong is logged, and the next look tries again.
  function write(stoppedAt = null) {
    const now = clock.now()
    let status
    try {
      const { channels, backups } = render(now)
      status = { startedAt, writtenAt: isoSeconds(now), stoppedAt, channels, backups }
    } catch (error) {
      log.error('bridge.status_not_rendered', errorFields(error))
      return
    }
    const same = JSON.stringify({ ...status, writtenAt: null })
    if (same === written) return
    try {
      writeBridgeStatus(paths, status)
      written = same
      if (failing) log.info('bridge.status_written')
      failing = false
    } catch (error) {
      if (!failing) log.error('bridge.status_not_written', errorFields(error))
      failing = true
    }
  }

  async function look() {
    for (;;) {
      try {
        await clock.sleep(limits.POLL_INTERVAL, { signal: stopping.signal })
      } catch {
        return
      }
      write()
    }
  }

  return {
    start() {
      if (loop) return
      write()
      loop = look()
    },

    stop: () =>
      (stopped ??= (async () => {
        stopping.abort()
        await loop
        write(isoSeconds(clock.now()))
      })()),
  }
}

// ---------------------------------------------------------------------------------------------
// The report

// `48 s`, `3 min 5 s`.
function duration(ms) {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}

// The datastore's index, read as the runner reads it, which changes nothing; or the error that
// kept it from being read, such as a damaged line.
export function readIndex(paths) {
  const index = createIndex()
  try {
    for (const { line, day, number } of createReader(paths).poll()) {
      try {
        index.add(line, day)
      } catch (error) {
        throw new DatastoreError(`${paths.dayLog(day)}, line ${number}: ${error.message}`)
      }
    }
  } catch (error) {
    return error
  }
  return index
}

// What the agent's state says it has waiting: work items after its cursor, from the sources it
// reads, and the lengths of its retry and failed lists.
function counts(index, state, reads) {
  let pending = 0
  for (let seq = state.cursor + 1; seq <= index.lastSeq; seq++) {
    const line = index.get(seq)?.line
    if (line && line.dir === 'in' && WORK.includes(line.kind) && reads.includes(line.source)) pending += 1
  }
  return { pending, retrying: state.retry.length, failed: state.failed.length }
}

// The requests in the network log over the last `STATUS_WINDOW`, the hosts they went to, and the
// requests the policy refused: those written one by one, and those a run only counted. The log's
// folder is the runner's, and is read only while it is a folder and not a link.
function network(paths, now) {
  let requests = 0
  let refused = 0
  const hosts = new Set()
  try {
    checkOwnFolder(paths.networkLogDir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  scanNetworkLog(paths, { from: now - limits.STATUS_WINDOW, to: now }, entry => {
    if (entry.event === 'request') {
      requests += 1
      hosts.add(entry.host)
    } else if (entry.event === 'refused') {
      refused += 1
    } else if (entry.event === 'unlogged') {
      refused += entry.refused
    }
  })
  return { requests, hosts: hosts.size, refused }
}

// An agent's `state.json`, as `readAgentState` reads it, in the agent's folder, which is the
// runner's, and is read only while it is a folder and not a link. Null when there is none.
function agentState(paths, name) {
  try {
    checkOwnFolder(paths.agentDir(name))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return readAgentState(paths.agentState(name), { maxBytes: limits.STATUS_FILE_MAX_BYTES })
}

// The newest message the owner sent: the `in` message with the highest `seq`.
function newestMessage(index) {
  for (let seq = index.lastSeq; seq >= 1; seq--) {
    const line = index.get(seq)?.line
    if (line?.dir === 'in' && line.kind === 'message') return line
  }
  return null
}

// The report of `scooter status`. Options:
// - `now`: the instant; `settings`: the bridge's (`timeZone`).
// - `paths`: what `makePaths` returns.
// - `index`: the datastore's index (`readIndex`), or the error that kept it from being read.
export function statusText({ now, settings, paths, index }) {
  const zone = settings.timeZone
  const at = time => shortLocalTime(time, now, zone)
  const atText = text => at(parseIsoSeconds(text))
  const t = toLocal(now, zone)
  const lines = [`Scooter, ${DAYS[t.weekday - 1]} ${t.day} ${MONTHS[t.month - 1]} ${pad(t.hour)}:${pad(t.minute)} (${zone})`, '']

  let bridge = null
  try {
    bridge = readBridgeStatus(paths)
    if (bridge === null) lines.push("Bridge: it hasn't written its status yet, so there is nothing to say about the channels or the backups.")
  } catch (error) {
    lines.push(`Bridge: its status.json can't be read (${error instanceof BridgeStatusError ? 'not a status' : (error.code ?? error.name)}), so there is nothing to say about the channels or the backups.`)
  }
  if (bridge !== null) {
    if (bridge.stoppedAt === null) lines.push(`Bridge: started ${atText(bridge.startedAt)}; it last wrote its status ${atText(bridge.writtenAt)}.`)
    else lines.push(`Bridge: stopped ${atText(bridge.stoppedAt)}, when it last wrote its status.`)
    lines.push(...Object.values(bridge.channels))
  }
  if (index instanceof Error) {
    lines.push(`Newest message: the datastore can't be read (${index instanceof DatastoreError ? index.message : (index.code ?? index.name)}).`)
  } else {
    const newest = newestMessage(index)
    lines.push(newest === null ? 'Newest message: none yet' : `Newest message: #${newest.seq}, ${atText(newest.at)}, on ${CHANNEL_NAMES[newest.source] ?? newest.source}`)
  }
  lines.push('')

  let status = null
  try {
    status = readRunnerStatus(paths.runnerStatus, { maxBytes: limits.STATUS_FILE_MAX_BYTES })
    if (status === null) lines.push("Runner: it hasn't started yet, so there is nothing to say about the agent or its VMs.")
  } catch (error) {
    lines.push(`Runner: its status.json can't be read (${error instanceof RunnerStatusError ? 'not a status' : (error.code ?? error.name)}).`)
  }
  if (status !== null) {
    const accel = status.accel === 'kvm' ? 'KVM' : 'emulation, which is much slower'
    const image = status.imageBuiltAt === null ? 'when, unknown' : atText(status.imageBuiltAt)
    lines.push(`Runner: started ${atText(status.startedAt)}. VMs run with ${accel}; their image was built ${image}.`)
    // A runner that stopped on an error, and waits before it goes on.
    const restart = status.restart ?? null
    if (restart !== null && parseIsoSeconds(restart.until) > now) {
      const why = restart.reason === null ? "it stopped, and couldn't record why" : `it stopped on an error (${restart.reason})`
      const times = restart.stops === 1 ? '' : `, ${restart.stops} times in a row`
      lines.push(`The runner waits until ${atText(restart.until)} before it goes on: ${why}${times}. Restarting it ends the wait.`)
    }
    lines.push(`Zero data retention: ${status.zdr ? 'on' : 'off'}. The agent's internet access: ${status.internet ? 'on' : 'off'}.`)
  }
  try {
    const net = network(paths, now)
    const refused = net.refused === 0 ? '' : `, and ${net.refused} refused`
    lines.push(`Network, last 24 hours: ${plural(net.requests, 'request')} to ${plural(net.hosts, 'host')}${refused}.`)
  } catch (error) {
    lines.push(`Network log: it can't be read (${error.code ?? error.name}).`)
  }

  for (const [name, agent] of Object.entries(status?.agents ?? {})) {
    lines.push('')
    let state
    try {
      state = agentState(paths, name)
    } catch (error) {
      lines.push(`${name}: its state.json can't be read (${error instanceof AgentStateError ? 'not a state' : (error.code ?? error.name)}).`)
      continue
    }
    if (state === null) {
      lines.push(`${name}: it hasn't run yet.`)
      continue
    }
    const run = state.lastRun
    if (run === null) lines.push(`${name}: no run yet.`)
    else {
      const what = run.seqs.length === 0 ? 'a task' : plural(run.seqs.length, 'message')
      lines.push(`${name}: last run ${atText(run.at)}, ${run.ok ? 'ok' : 'failed'}, ${what}, ${duration(run.durationMs)}.`)
    }
    const paused = state.paused
    if (paused) lines.push(`Runs are paused since ${atText(paused.since)}: ${paused.reason}. Next try ${atText(paused.next)}.`)
    else lines.push("Runs aren't paused.")
    if (index instanceof Error) {
      lines.push(`Messages: ${state.retry.length} retrying, ${state.failed.length} failed; those pending can't be counted without the datastore.`)
    } else {
      const { pending, retrying, failed } = counts(index, state, agent.reads)
      lines.push(`Messages: ${pending} pending, ${retrying} retrying, ${failed} failed.`)
    }
    if (state.backfill) lines.push(`Backfill ${state.backfill.id}: at #${state.backfill.cursor} of #${state.backfill.until}.`)
  }

  if (bridge !== null) lines.push('', bridge.backups)
  return lines.map(shown).join('\n')
}

// `scooter status`: prints the report, and exits with 0, whatever it could read. It takes no
// arguments. Exits with 2 when given any.
export async function runStatus({ args = [], settings, stdout, stderr, clock = systemClock }) {
  if (args.length > 0) {
    stderr.write('scooter status: it takes no arguments\n')
    return 2
  }
  const paths = makePaths(settings)
  stdout.write(`${statusText({ now: clock.now(), settings, paths, index: readIndex(paths) })}\n`)
  return 0
}
