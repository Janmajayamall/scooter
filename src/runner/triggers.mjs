// What the agent does next: the planner's first question.
//
// `nextAction` is a pure function of the agent's config, its state, the datastore's index and the
// clock, with one fact the runner keeps in memory: when it last saw an incoming line. The runner
// asks it whenever no run is in progress, and does what it says. In order:
//
// 1. **Paused**: nothing until the next try.
// 2. **New messages:** work items to give after the cursor, or retries that are due, once the owner
//    has been quiet for `BATCH_SECONDS`. A work item is of a channel a trigger `on: new-messages`
//    names in its `channels`, so without such a trigger there is none.
// 3. **Scheduled tasks** whose time has come since they were last dealt with. One that comes due
//    during a run or a pause waits, and runs afterwards.
// 4. **A job of `scooter backfill`**, the one the runner holds, only when nothing live is waiting:
//    no work items to give after the cursor, quiet or not, no due retries and no scheduled task.
//    First its start, then its batches; when its work is done, it finishes. A job with
//    `--hold-live` comes before 2 and 3 instead, until it has finished: live runs wait for it,
//    and it waits for a line to be tried again before it takes the lines after it. A job that
//    waits after a setup error or an outage of its own, which only one of an agent given in a
//    file does, gives no batch until its wait's next try.
// 5. Otherwise, nothing.
//
// A message that is already deleted is never given: the runner settles it itself, and gives only
// its deletion (`assembleBatch` in `batch.mjs`). So it is no work to give here, and starts no run.

import { isKnown } from '../common/datastore/line.mjs'
import { previousLocalTime, localDate, parseIsoSeconds } from '../common/time.mjs'

// The kinds of line that are work for the agent. Everything else is passed over.
const WORK_KINDS = ['message', 'edit', 'delete']

// Whether a line is a work item for an agent whose triggers name `channels`: an incoming message,
// edit or deletion from one of those channels. A line this version doesn't know (`isKnown`), of a
// kind or a channel it doesn't have or without a field its kind needs, is never one: it is passed
// over.
export function isWorkItem(line, channels) {
  return isKnown(line) && line.dir === 'in' && WORK_KINDS.includes(line.kind) && channels.includes(line.source)
}

// Whether the line `seq` is a message that is already deleted, by the index as the runner has read
// it.
export function isDeletedMessage(index, seq) {
  return index.get(seq)?.line.kind === 'message' && Boolean(index.current(seq)?.deletedIn)
}

// Whether the line `seq` is one to give the agent: a work item, but not a message that is already
// deleted.
export function isToGive(index, seq, channels) {
  const entry = index.get(seq)
  return entry !== undefined && isWorkItem(entry.line, channels) && !isDeletedMessage(index, seq)
}

// The `seq` of each work item to give after `after`, up to `upTo` (the newest line by default), in
// order.
export function workItemsAfter(index, channels, after, upTo = index.lastSeq) {
  const seqs = []
  for (let seq = after + 1; seq <= upTo; seq++) {
    if (isToGive(index, seq, channels)) seqs.push(seq)
  }
  return seqs
}

// Whether there is a work item to give after `after`, up to `upTo`.
export function hasWorkAfter(index, channels, after, upTo = index.lastSeq) {
  for (let seq = after + 1; seq <= upTo; seq++) {
    if (isToGive(index, seq, channels)) return true
  }
  return false
}

// The entries of a retry list that are due at `now`, by `seq`. An entry whose line isn't a work
// item of this agent, which only a changed `channels` or a damaged state would give, is never due:
// it would start runs with nothing in them. Nor is a message that has been deleted since, which the
// next batch settles.
export function dueRetries(retry, index, channels, now) {
  return retry.filter(entry => parseIsoSeconds(entry.due) <= now && isToGive(index, entry.seq, channels)).sort((a, b) => a.seq - b.seq)
}

// The scheduled task that is due at `now`, as `{ at, tag, date, prompt }`, or null: its trigger's
// `at`, `tag` and `prompt`, and `date`, the owner's date of the occurrence that came due, which the
// runner records in `scheduled` once the task has run. An `at` the state has no date for is never
// due; `startupState` gives every one a date.
export function dueScheduled(agent, state, { now, timeZone }) {
  for (const { at, tag, schedule, prompt } of agent.run.scheduled) {
    const done = state.scheduled[at]
    if (done === undefined) continue
    const date = localDate(previousLocalTime(schedule, timeZone, now), timeZone)
    if (date > done) return { at, tag, date, prompt }
  }
  return null
}

// What to do next. Returns one of:
//
//   { kind: 'messages' }               run a batch of messages (`buildBatch`)
//   { kind: 'scheduled', at, tag, date, prompt }
//   { kind: 'backfill-start', id }     start the job: its tag, `--empty`, and where it stops
//   { kind: 'backfill', id }           run a batch of the job
//   { kind: 'backfill-finished', id }  the job has covered everything up to where it stops
//   { kind: 'idle', reason }           nothing now: `paused`, `quiet` (messages wait for the owner
//                                      to be quiet), `backfill` (a job that holds live runs back
//                                      waits for a line to be tried again), `backfill-waits` (the
//                                      job waits after a setup error or an outage of its own), or
//                                      `nothing`
//
// Input:
// - `agent`: the agent's config (`config.mjs`); `state`: its state; `index`: the datastore's.
// - `now`: the time, in milliseconds; `timeZone`: `SCOOTER_TZ`; `batchSeconds`: `BATCH_SECONDS`.
// - `incomingSeenAt`: when the runner last saw an incoming line arrive, or null.
// - `job`: the job the runner holds, as `poll` of `createJobs` in `backfill.mjs` gives it, or null.
export function nextAction({ agent, state, index, now, timeZone, batchSeconds, incomingSeenAt, job = null }) {
  if (state.paused && now < parseIsoSeconds(state.paused.next)) return { kind: 'idle', reason: 'paused' }

  // Live runs wait for a job with `--hold-live`, scheduled tasks among them.
  if (job?.holdLive) return jobAction(job, index, now)

  // Only a line of a channel a trigger names is work: a line of any other holds nothing back.
  const live = hasWorkAfter(index, agent.channels, state.cursor) || dueRetries(state.retry, index, agent.channels, now).length > 0
  const quiet = incomingSeenAt === null || now - incomingSeenAt >= batchSeconds * 1000
  if (live && quiet) return { kind: 'messages' }

  const scheduled = dueScheduled(agent, state, { now, timeZone })
  if (scheduled) return { kind: 'scheduled', ...scheduled }

  if (live) return { kind: 'idle', reason: 'quiet' }
  if (job) return jobAction(job, index, now)
  return { kind: 'idle', reason: 'nothing' }
}

// What comes next of a job: its start, before anything else; then a batch, while there are work
// items to give after its cursor, up to where it stops, or retries that are due; and when there
// are neither, and no line waits to be tried again, it has finished. A line in its retries that is
// no work item to give, a message deleted since it was given among them, waits for nothing: no
// batch would give it.
//
// A job with `--hold-live` replays in order: while a line waits to be tried again, it takes
// nothing, also when another is due, and waits, as live runs wait for it. A job whose `wait`
// holds it back gives no batch before the wait's next try.
function jobAction(job, index, now) {
  if (!job.started) return { kind: 'backfill-start', id: job.id }
  const { lane, until, channels, wait = null } = job
  const waiting = lane.retry.filter(entry => isToGive(index, entry.seq, channels))
  if (job.holdLive && waiting.some(entry => parseIsoSeconds(entry.due) > now)) return { kind: 'idle', reason: 'backfill' }
  if (dueRetries(lane.retry, index, channels, now).length > 0 || hasWorkAfter(index, channels, lane.cursor, Math.min(until, index.lastSeq))) {
    if (wait !== null && now < parseIsoSeconds(wait.next)) return { kind: 'idle', reason: 'backfill-waits' }
    return { kind: 'backfill', id: job.id }
  }
  if (waiting.length === 0) return { kind: 'backfill-finished', id: job.id }
  return { kind: 'idle', reason: 'nothing' }
}
