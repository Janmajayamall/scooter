// What the agent does next: the planner's first question.
//
// `nextAction` is a pure function of the agent's config, its state, the datastore's index and the
// clock, with one fact the runner keeps in memory: when it last saw an incoming line. The runner
// asks it whenever no run is in progress, and does what it says. In order:
//
// 1. **Paused**: nothing until the next try.
// 2. **New messages:** work items after the cursor, or retries that are due, once the owner has
//    been quiet for `BATCH_SECONDS`. Only with `on: new-messages`.
// 3. **Scheduled tasks** whose time has come since they were last dealt with. One that comes due
//    during a run or a pause waits, and runs afterwards.
// 4. **A backfill batch**, only when nothing live is waiting: no work items after the cursor, quiet
//    or not, and no due retries. Messages are live work only with `on: new-messages`;
//    without it they wait for good, and don't hold a backfill back. When its work is done, the
//    backfill finishes.
// 5. Otherwise, nothing.

import { isKnown } from '../common/datastore/line.mjs'
import { previousLocalTime, localDate, parseIsoSeconds } from '../common/time.mjs'

// The kinds of line that are work for the agent. Everything else is context or skipped.
const WORK_KINDS = ['message', 'edit', 'delete']

// Whether a line is a work item for an agent that reads `reads`: an incoming message, edit or
// deletion from one of those sources. A line this version doesn't know (`isKnown`), of a kind or
// a channel it doesn't have or without a field its kind needs, is never one: it is passed over.
export function isWorkItem(line, reads) {
  return isKnown(line) && line.dir === 'in' && WORK_KINDS.includes(line.kind) && reads.includes(line.source)
}

// The `seq` of each work item after `after`, up to `upTo` (the newest line by default), in order.
export function workItemsAfter(index, reads, after, upTo = index.lastSeq) {
  const seqs = []
  for (let seq = after + 1; seq <= upTo; seq++) {
    const entry = index.get(seq)
    if (entry && isWorkItem(entry.line, reads)) seqs.push(seq)
  }
  return seqs
}

// Whether there is a work item after `after`, up to `upTo`.
export function hasWorkAfter(index, reads, after, upTo = index.lastSeq) {
  for (let seq = after + 1; seq <= upTo; seq++) {
    const entry = index.get(seq)
    if (entry && isWorkItem(entry.line, reads)) return true
  }
  return false
}

// The entries of a retry list that are due at `now`, by `seq`. An entry whose line isn't a work
// item of this agent, which only a changed `reads` or a damaged state would give, is never due:
// it would start runs with nothing in them.
export function dueRetries(retry, index, reads, now) {
  return retry
    .filter(entry => parseIsoSeconds(entry.due) <= now && index.get(entry.seq) && isWorkItem(index.get(entry.seq).line, reads))
    .sort((a, b) => a.seq - b.seq)
}

// The scheduled task that is due at `now`, as `{ at, date, task }`, or null. `date` is the owner's
// date of the occurrence that came due: the runner records it in `scheduled` once the task has run.
// An `at` the state has no date for is never due; `startupState` gives every one a date.
export function dueScheduled(agent, state, { now, timeZone }) {
  for (const { at, schedule, task } of agent.run.scheduled) {
    const done = state.scheduled[at]
    if (done === undefined) continue
    const date = localDate(previousLocalTime(schedule, timeZone, now), timeZone)
    if (date > done) return { at, date, task }
  }
  return null
}

// What to do next. Returns one of:
//
//   { kind: 'messages' }               run a batch of messages (`buildBatch`)
//   { kind: 'scheduled', at, date, task }
//   { kind: 'backfill', id }           run a batch of the backfill in progress
//   { kind: 'backfill-finished', id }  the backfill has covered everything up to `until`
//   { kind: 'idle', reason }           nothing now: `paused`, `quiet` (messages wait for the owner
//                                      to be quiet), or `nothing`
//
// Input:
// - `agent`: the agent's config (`config.mjs`); `state`: its state; `index`: the datastore's.
// - `now`: the time, in milliseconds; `timeZone`: `SCOOTER_TZ`; `batchSeconds`: `BATCH_SECONDS`.
// - `incomingSeenAt`: when the runner last saw an incoming line arrive, or null.
export function nextAction({ agent, state, index, now, timeZone, batchSeconds, incomingSeenAt }) {
  if (state.paused && now < parseIsoSeconds(state.paused.next)) return { kind: 'idle', reason: 'paused' }

  // Messages are live work only for an agent that runs on them. Without `on: new-messages` they
  // wait for good, and must not hold a backfill back.
  const live = agent.run.newMessages && (hasWorkAfter(index, agent.reads, state.cursor) || dueRetries(state.retry, index, agent.reads, now).length > 0)
  const quiet = incomingSeenAt === null || now - incomingSeenAt >= batchSeconds * 1000
  if (live && quiet) return { kind: 'messages' }

  const scheduled = dueScheduled(agent, state, { now, timeZone })
  if (scheduled) return { kind: 'scheduled', ...scheduled }

  if (live) return { kind: 'idle', reason: 'quiet' }

  const backfill = state.backfill
  if (backfill && agent.run.backfill.some(entry => entry.id === backfill.id)) {
    const upTo = Math.min(backfill.until, index.lastSeq)
    if (hasWorkAfter(index, agent.reads, backfill.cursor, upTo) || dueRetries(backfill.retry, index, agent.reads, now).length > 0) {
      return { kind: 'backfill', id: backfill.id }
    }
    if (backfill.retry.length === 0) return { kind: 'backfill-finished', id: backfill.id }
  }
  return { kind: 'idle', reason: 'nothing' }
}
