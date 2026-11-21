// The runner's side of an agent's `state.json`: reading and writing it, and the
// changes to it that planning makes. The format and its check are in `src/common/agentstate.mjs`,
// because the bridge reads the file too, for `/status`.
//
// Every change is a pure function that takes a state and returns a new one. Only `saveState`
// writes, atomically and with mode 0600, in the agent's own folder.

import { checkAgentState, initialAgentState, readAgentState } from '../common/agentstate.mjs'
import { writeFileAtomic } from '../common/files.mjs'
import { isoSeconds, localDate, parseIsoSeconds, previousLocalTime, shiftDate, toLocal } from '../common/time.mjs'

// Reads the state at `file`, or returns the state of an agent that has never run when there is
// none. Throws an `AgentStateError` that names the file and the fields if it isn't a state.
export function loadState(file) {
  return readAgentState(file) ?? initialAgentState()
}

// Writes the state to `file`: under a temporary name, synced, then renamed, mode 0600. Throws if
// the state isn't well formed, before anything is written.
export function saveState(file, state) {
  const problems = checkAgentState(state)
  if (problems.length > 0) throw new Error(`not an agent state: ${problems.join('; ')}`)
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

// ---------------------------------------------------------------------------------------------
// Sessions

// The owner's day that a session belongs to: the local date at `now`, or the date before until the
// local clock reaches `rolloverHour`. The hour is the clock's, so on a day when clocks change the
// session still changes at, say, 04:00.
export function sessionDay(now, timeZone, rolloverHour) {
  const local = toLocal(now, timeZone)
  return local.hour >= rolloverHour ? local.date : shiftDate(local.date, -1)
}

// The session of a run at `now`: `{ day, bump }`. The state's `session` counts the `/new` commands
// of its day; on any other day the count is 0.
export function currentSession(state, { now, timeZone, rolloverHour }) {
  const day = sessionDay(now, timeZone, rolloverHour)
  return { day, bump: state.session?.day === day ? state.session.bump : 0 }
}

// The session ID pi is given: `<agent>-<day>`, with `-<n>` after the nth `/new` of the day.
export function sessionId(agentName, { day, bump }) {
  return `${agentName}-${day}${bump > 0 ? `-${bump}` : ''}`
}

// ---------------------------------------------------------------------------------------------
// Commands

export const NEW_SESSION_REPLY = 'Started a fresh conversation.'

// Handles the command lines newer than `commandSeq`, given in `seq` order. `/new` starts a fresh
// session for the rest of the owner's day, and is answered with a text about the command.
// The other commands are the bridge's, and are passed over. Returns `{ state, replies }`:
// the state with `commandSeq` moved to the newest command, and the outbox entries to write.
//
// The day a `/new` applies to is the session's day when the owner sent it, which is the day it is
// handled unless the runner was down across the rollover hour. A time from the channel that is
// later than `now` counts as `now`.
//
// The runner writes the replies and saves the state before it builds a batch, so a crash or a
// failed batch afterwards doesn't handle a command twice.
export function applyCommands(state, lines, { now, timeZone, rolloverHour }) {
  let next = state
  const replies = []
  for (const line of lines) {
    if (line.kind !== 'command' || line.seq <= next.commandSeq) continue
    next = { ...next, commandSeq: line.seq }
    if (line.text !== '/new') continue
    const sent = Math.min(parseIsoSeconds(line.at) ?? now, now)
    const session = currentSession(next, { now: sent, timeZone, rolloverHour })
    next = { ...next, session: { day: session.day, bump: session.bump + 1 } }
    replies.push({ type: 'text', by: 'runner', text: NEW_SESSION_REPLY, about: line.seq })
  }
  return { state: next, replies }
}

// ---------------------------------------------------------------------------------------------
// Startup

// The occurrence of a scheduled task that last came due at or before `now`: `{ instant, date }`,
// with `date` its owner's date.
export function lastOccurrence(schedule, { now, timeZone }) {
  const instant = previousLocalTime(schedule, timeZone, now)
  return { instant, date: localDate(instant, timeZone) }
}

// What the runner does to the state when it starts, given the agent's config:
//
// - **Scheduled tasks.** Every occurrence up to now counts as dealt with: a runner that starts after
//   a task's time leaves it for its next time. The dates are worked out in the time zone the
//   runner starts with, so a changed `SCOOTER_TZ` takes effect from here. Tasks no longer in the
//   config are forgotten. During a pause, though, the dates already there are kept: a task that
//   failed on a setup error or an outage stays due, and is the next try (the plan's rule for
//   milestone 4), and one that came due during the pause runs after it. Otherwise a
//   pause that only a task held would be left with nothing to try.
// - **A pause** is tried again at once: runs pause "until the next try, every 30 minutes and
//   whenever it restarts".
// - **Backfills.** One whose entry is gone from the config is dropped. If none is in progress, the
//   first entry not in `backfillDone` starts, from the beginning of the datastore up to `until`,
//   the live cursor now.
//
// Returns `{ state, started, dropped }`, the last two being the backfill IDs started and dropped,
// or null.
export function startupState(state, agent, { now, timeZone }) {
  const scheduled = {}
  for (const { at, schedule } of agent.run.scheduled) {
    const held = Boolean(state.paused) && state.scheduled[at] !== undefined
    scheduled[at] = held ? state.scheduled[at] : lastOccurrence(schedule, { now, timeZone }).date
  }
  let next = { ...state, scheduled }

  if (next.paused) next = { ...next, paused: { ...next.paused, next: isoSeconds(now) } }

  let dropped = null
  let started = null
  if (next.backfill && !agent.run.backfill.some(entry => entry.id === next.backfill.id)) {
    dropped = next.backfill.id
    const { backfill, ...rest } = next
    next = rest
  }
  if (!next.backfill) {
    const entry = agent.run.backfill.find(candidate => !next.backfillDone.includes(candidate.id))
    if (entry) {
      started = entry.id
      next = { ...next, backfill: { id: entry.id, until: next.cursor, cursor: 0, retry: [], skipped: [] } }
    }
  }
  return { state: next, started, dropped }
}
