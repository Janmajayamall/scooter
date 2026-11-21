// The reply to `/status`.
//
// What the bridge knows itself: each channel's state, the newest message, and the backups. What it
// says about the runner comes from three of the runner's files, since the bridge reads neither
// `config/` nor `runner.env`: `status.json` for the runner's settings, each agent's
// `state.json` for its runs, and the network log for the last 24 hours. It reports what it can
// read, and says so when one of them isn't there yet or can't be read. Before the runner has ever
// started there is no `status.json`, and so no agent to report on.
//
// The bridge reads these as root, and the runner's user writes them, so each is read without
// following a link, without waiting on a FIFO, and only if it is a regular file of a bounded size
// (`readUntrustedFile`): one that isn't is said to be unreadable, and the rest is reported.
//
// Times are in `SCOOTER_TZ`. The reply is text for the owner, and a function of the
// files and the clock, so a test can give it both.

import { AgentStateError, readAgentState } from '../common/agentstate.mjs'
import { limits } from '../common/limits.mjs'
import { scanNetworkLog } from '../common/netlog.mjs'
import { RunnerStatusError, readRunnerStatus } from '../common/runnerstatus.mjs'
import { parseIsoSeconds, shortLocalTime, toLocal } from '../common/time.mjs'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CHANNEL_NAMES = { whatsapp: 'WhatsApp', email: 'email' }

// The kinds of line that are work for an agent.
const WORK = ['message', 'edit', 'delete']

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const pad = number => String(number).padStart(2, '0')

// `48 s`, `3 min 5 s`.
function duration(ms) {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
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
// requests the policy refused: those written one by one, and those a run only counted.
function network(paths, now) {
  let requests = 0
  let refused = 0
  const hosts = new Set()
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

// The newest message the owner sent: the `in` message with the highest `seq`.
function newestMessage(index) {
  for (let seq = index.lastSeq; seq >= 1; seq--) {
    const line = index.get(seq)?.line
    if (line?.dir === 'in' && line.kind === 'message') return line
  }
  return null
}

// The reply to `/status`. Options:
// - `now`: the instant, from the bridge's clock; `settings`: the bridge's (`timeZone`).
// - `paths`: what `makePaths` returns.
// - `channels`: a Map from each channel's name to the channel, for its `status()`.
// - `index`: the datastore's index, as the store keeps it.
// - `backups`: the line about backups (`createBackups().statusLine`).
export function statusText({ now, settings, paths, channels, index, backups }) {
  const zone = settings.timeZone
  const at = text => shortLocalTime(parseIsoSeconds(text), now, zone)
  const t = toLocal(now, zone)
  const lines = [`Scooter, ${DAYS[t.weekday - 1]} ${t.day} ${MONTHS[t.month - 1]} ${pad(t.hour)}:${pad(t.minute)} (${zone})`, '']

  for (const channel of channels.values()) lines.push(channel.status())
  const newest = newestMessage(index)
  lines.push(newest === null ? 'Newest message: none yet' : `Newest message: #${newest.seq}, ${at(newest.at)}, on ${CHANNEL_NAMES[newest.source] ?? newest.source}`)
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
    const image = status.imageBuiltAt === null ? 'when, unknown' : at(status.imageBuiltAt)
    lines.push(`Runner: started ${at(status.startedAt)}. VMs run with ${accel}; their image was built ${image}.`)
    // A runner that stopped on an error, and waits before it goes on.
    const restart = status.restart ?? null
    if (restart !== null && parseIsoSeconds(restart.until) > now) {
      const why = restart.reason === null ? "it stopped, and couldn't record why" : `it stopped on an error (${restart.reason})`
      const times = restart.stops === 1 ? '' : `, ${restart.stops} times in a row`
      lines.push(`The runner waits until ${at(restart.until)} before it goes on: ${why}${times}. Restarting it ends the wait.`)
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
      state = readAgentState(paths.agentState(name), { maxBytes: limits.STATUS_FILE_MAX_BYTES })
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
      lines.push(`${name}: last run ${at(run.at)}, ${run.ok ? 'ok' : 'failed'}, ${what}, ${duration(run.durationMs)}.`)
    }
    const paused = state.paused
    if (paused) lines.push(`Runs are paused since ${at(paused.since)}: ${paused.reason}. Next try ${at(paused.next)}.`)
    else lines.push("Runs aren't paused.")
    const { pending, retrying, failed } = counts(index, state, agent.reads)
    lines.push(`Messages: ${pending} pending, ${retrying} retrying, ${failed} failed.`)
    if (state.backfill) lines.push(`Backfill ${state.backfill.id}: at #${state.backfill.cursor} of #${state.backfill.until}.`)
  }

  lines.push('', backups)
  return lines.join('\n')
}
