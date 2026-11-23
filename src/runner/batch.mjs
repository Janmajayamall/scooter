// The batch: which lines the agent is given in one run, and the prompt that gives their numbers.
//
// - **Items:** due retries first, then work items after the cursor, oldest first, at most
//   `BATCH_MAX_ITEMS`.
// - **A message that is already deleted is never given:** the runner settles it itself, and gives
//   only its deletion. One after the cursor is passed over with the lines the batch covers; one
//   that waits in `retry` leaves it with the batch, whatever comes of the run; and one given up on,
//   in `failed`, leaves it when its deletion is in the batch, as an edit or a deletion brought such
//   a message back before.
// - **Brought in:** an edit in the batch also brings in the message it changes, when that message
//   waits in `retry` (due or not) or is in `failed`, and isn't deleted. It joins as a retry; one
//   from `failed` starts again at attempt 1. Otherwise the edit could be handled before its
//   message, and the retry would later file the old text. These can take the batch past
//   `BATCH_MAX_ITEMS`, at most one for each edit.
// - **Covered:** the lines up to the first work item to give that is left for a later batch. When
//   the run is over, the cursor moves there: the lines of channels no trigger names, the messages
//   Scooter sent, the reactions and the messages already deleted, in that stretch, are dealt with
//   too.
//
// The runner settles no other line because of another: an edit's mark doesn't settle its message.
//
// A batch is drawn from a **lane**: `{ cursor, retry, failed }`, a cursor, the items waiting to be
// tried again, and those given up on, each with its `seq`. Live runs draw from the state's own;
// a backfill from its own, with `skipped` as `failed`; and a rebuild from a state it
// keeps in memory. `upTo` is the last line a lane's work reaches: the newest line for live
// runs, and the `seq` a replay stops at (`replay.mjs`).
//
// The prompt is the `prompt` of the first trigger `on: new-messages`, in the order of `run`, that
// names the channel of one of the batch's lines, filled in (`prompt.mjs`).

import { limits } from '../common/limits.mjs'
import { promptValues, renderPrompt } from './prompt.mjs'
import { dueRetries, isDeletedMessage, isToGive, workItemsAfter } from './triggers.mjs'

// The items the batch may take, in the order it takes them, at most `BATCH_MAX_ITEMS`: due retries,
// then new work items. Each is `{ seq, origin, attempt }`: `origin` is `retry` or `new`, and
// `attempt` is the attempt this run would be. Also returns `fresh`, every work item to give after
// the cursor, up to `upTo`.
export function selectCandidates({ agent, lane, index, now, upTo = index.lastSeq }) {
  const retries = dueRetries(lane.retry, index, agent.channels, now).map(entry => ({ seq: entry.seq, origin: 'retry', attempt: entry.attempts + 1 }))
  const fresh = workItemsAfter(index, agent.channels, lane.cursor, upTo)
  const news = fresh.map(seq => ({ seq, origin: 'new', attempt: 1 }))
  return { candidates: [...retries, ...news].slice(0, limits.BATCH_MAX_ITEMS), fresh }
}

// The batch of the given candidates, the first ones `selectCandidates` returned:
//
//   { items: [{ seq, origin, attempt }], settled: [seq], covered, newest }
//
// `items` are in `seq` order, with those brought in by an edit (`origin` `retry` or `failed`).
// `settled` lists the messages already deleted that the runner settles itself, of the lane's
// `retry` and, those whose deletion is an item, of its `failed`. `covered` is where the lane's
// cursor goes once the run is over, at most `upTo`, and `newest` the newest item, which a message
// `send` queued without `--reply-to` is `about`.
export function assembleBatch({ agent, lane, index, upTo = index.lastSeq }, candidates, fresh) {
  const items = new Map(candidates.map(candidate => [candidate.seq, candidate]))
  const settled = new Set(lane.retry.filter(entry => isDeletedMessage(index, entry.seq)).map(entry => entry.seq))
  for (const candidate of candidates) {
    const { line } = index.get(candidate.seq)
    const target = line.target
    if (line.kind === 'delete' && lane.failed.some(other => other.seq === target)) settled.add(target)
    if (line.kind !== 'edit' || items.has(target) || !isToGive(index, target, agent.channels)) continue
    const retry = lane.retry.find(other => other.seq === target)
    if (retry) {
      items.set(target, { seq: target, origin: 'retry', attempt: retry.attempts + 1 })
    } else if (lane.failed.some(other => other.seq === target)) {
      items.set(target, { seq: target, origin: 'failed', attempt: 1 })
    }
  }

  const taken = candidates.filter(candidate => candidate.origin === 'new').length
  const covered = taken < fresh.length ? fresh[taken] - 1 : upTo
  const sorted = [...items.values()].sort((a, b) => a.seq - b.seq)
  return { items: sorted, settled: [...settled].sort((a, b) => a - b), covered: Math.max(covered, lane.cursor), newest: sorted.at(-1).seq }
}

// The trigger `on: new-messages` whose prompt a batch of `items` is given: the first, in the order
// of `run`, that names the channel of one of them. Each item is a work item, so one does.
export function triggerOf(agent, items, index) {
  const channels = new Set(items.map(item => index.get(item.seq).line.source))
  return agent.run.newMessages.find(trigger => trigger.channels.some(channel => channels.has(channel)))
}

// The prompt of `batch`, a run of `agent` at `now` that may change `writes`, the agent's own or a
// backfill's.
export function batchPrompt({ agent, batch, index, paths, settings, now, writes = agent.writes }) {
  const { prompt } = triggerOf(agent, batch.items, index)
  return renderPrompt(prompt, promptValues({ agent, paths, settings, now, items: batch.items, writes }))
}

// The next batch of messages and its prompt, or null when there is nothing to give the agent.
// Returns `{ batch, prompt }`, with the batch as `assembleBatch` gives it.
//
// - `agent`, `state`, `index`: the config, the state and the datastore's index.
// - `paths`, `settings`: what `makePaths` returns, and the runner's settings, for the prompt.
// - `now`: the time, which says which retries are due, and the prompt's `$now$`.
export function buildBatch({ agent, state, index, paths, settings, now }) {
  const { candidates, fresh } = selectCandidates({ agent, lane: state, index, now })
  if (candidates.length === 0) return null
  const batch = assembleBatch({ agent, lane: state, index }, candidates, fresh)
  return { batch, prompt: batchPrompt({ agent, batch, index, paths, settings, now }) }
}

// The prompt of a scheduled task, its trigger's `prompt` filled in. It gives no lines.
export function scheduledPrompt({ agent, prompt, paths, settings, now }) {
  return renderPrompt(prompt, promptValues({ agent, paths, settings, now }))
}
