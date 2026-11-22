// The batch: which items the agent is given in one run, what it is shown for
// context, and the prompt that says it.
//
// - **Items:** due retries first, then work items after the cursor, oldest first, at most
//   `BATCH_MAX_ITEMS`. The batch also stops growing once its prompt would pass `PROMPT_MAX_BYTES`,
//   and always keeps at least one item.
// - **Brought in:** an edit or deletion in the batch also brings in the message it changes, when
//   that message waits in `retry` (due or not) or is in `failed`. It joins as a retry; one from
//   `failed` starts again at attempt 1. Otherwise the edit could be handled before its message, and
//   the retry would later file the old text. These can take the batch past `BATCH_MAX_ITEMS`.
// - **Context:** the messages Scooter sent and the reactions, of the lines this version knows, from
//   the oldest item to the end of what the batch covers, plus the message each reply quotes, shown
//   under it.
// - **Covered:** the lines up to the first work item left for a later batch. When the run succeeds,
//   the cursor moves there: the context, and the lines of channels no trigger names, in that
//   stretch are dealt with too.
//
// When even one item makes the prompt too long, it is fitted, in this order: the oldest lines of
// context are left out; if the item is too long on its own, its texts are cut, followed by where
// the whole of each is; and, last, the prompt is cut at the limit.
//
// A batch is drawn from a **lane**: `{ cursor, retry, failed }`, a cursor, the items waiting to be
// tried again, and those given up on, each with its `seq`. Live runs draw from the state's own;
// a backfill from its own, with `skipped` as `failed`; and a rebuild from a state it
// keeps in memory. `upTo` is the last line a lane's work reaches: the newest line for live
// runs, and the `seq` a replay stops at (`replay.mjs`).

import { isKnown } from '../common/datastore/line.mjs'
import { limits } from '../common/limits.mjs'
import { fitToLimit, promptHeader, renderBatchPrompt, renderTaskPrompt } from './prompt.mjs'
import { dueRetries, isWorkItem, workItemsAfter } from './triggers.mjs'

const fits = prompt => Buffer.byteLength(prompt) <= limits.PROMPT_MAX_BYTES

// Whether a line is context: a message Scooter sent, or a reaction, either way, of the lines this
// version knows. A line it doesn't know is passed over.
const isContext = line => isKnown(line) && ((line.kind === 'message' && line.dir === 'out') || line.kind === 'reaction')

// The largest whole number from `low` to `high` for which `ok` holds, given that it holds for
// `low` and holds less the higher the number.
function largest(low, high, ok) {
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (ok(middle)) low = middle
    else high = middle - 1
  }
  return low
}

// The items the batch may take, in the order it takes them, at most `BATCH_MAX_ITEMS`: due retries,
// then new work items. Each is `{ seq, origin, attempt }`: `origin` is `retry` or `new`, and
// `attempt` is the attempt this run would be. Also returns `fresh`, every work item after the
// cursor, up to `upTo`.
export function selectCandidates({ agent, lane, index, now, upTo = index.lastSeq }) {
  const retries = dueRetries(lane.retry, index, agent.channels, now).map(entry => ({ seq: entry.seq, origin: 'retry', attempt: entry.attempts + 1 }))
  const fresh = workItemsAfter(index, agent.channels, lane.cursor, upTo)
  const news = fresh.map(seq => ({ seq, origin: 'new', attempt: 1 }))
  return { candidates: [...retries, ...news].slice(0, limits.BATCH_MAX_ITEMS), fresh }
}

// The batch of the given candidates, the first ones `selectCandidates` returned:
//
//   { items: [{ seq, origin, attempt }], context: [seq], covered, newest }
//
// `items` are in `seq` order, with those brought in by an edit or deletion (`origin` `retry` or
// `failed`). `context` is in `seq` order. `covered` is where the lane's cursor goes once the run is
// over, at most `upTo`, and `newest` the newest item, which an answer's plain text is `about`.
export function assembleBatch({ agent, lane, index, upTo = index.lastSeq }, candidates, fresh) {
  const items = new Map(candidates.map(candidate => [candidate.seq, candidate]))
  for (const candidate of candidates) {
    const { line } = index.get(candidate.seq)
    if (line.kind !== 'edit' && line.kind !== 'delete') continue
    const target = line.target
    const entry = index.get(target)
    if (items.has(target) || !entry || !isWorkItem(entry.line, agent.channels)) continue
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
  const context = []
  for (let seq = sorted[0].seq; seq <= covered; seq++) {
    const entry = index.get(seq)
    if (!entry || items.has(seq) || !isContext(entry.line)) continue
    context.push(seq)
  }
  return { items: sorted, context, covered: Math.max(covered, lane.cursor), newest: sorted.at(-1).seq }
}

// The largest cap on the item's texts at which the prompt fits, given that it fits at 0. `render`
// renders it at a cap, and `lengths` are the lengths of the texts the cap applies to. The prompt
// grows with the cap, except where the cap reaches a text's whole length: the text is then shown
// whole, without the note that follows a cut text, and the prompt is shorter than just below. So
// the caps are searched a stretch at a time, between those lengths, from the highest down, and the
// first stretch whose lowest cap fits holds the answer.
function largestCap(render, lengths) {
  const ok = cap => fits(render(cap))
  let high = limits.PROMPT_MAX_BYTES
  for (const low of [...new Set([...lengths, 0])].sort((a, b) => b - a)) {
    if (low > high) continue
    if (ok(low)) return largest(low, high, ok)
    high = low - 1
  }
  return 0
}

// Fits the prompt of a batch of one candidate that is too long as it stands.
function fitOne(batch, view) {
  const all = batch.context.length
  const render = (contextKeep, itemCap) => renderBatchPrompt(batch, view, { contextKeep, itemCap })
  // The item fits on its own: as much context as fits with it, the newest first.
  if (fits(render(0, Infinity))) return render(largest(0, all, keep => fits(render(keep, Infinity))), Infinity)
  // It doesn't: its texts are cut, as little as will do, with the context if there is room for it.
  for (const keep of [all, 0]) {
    const lengths = []
    if (!fits(renderBatchPrompt(batch, view, { contextKeep: keep, itemCap: 0, onCapped: bytes => lengths.push(bytes) }))) continue
    return render(keep, largestCap(cap => render(keep, cap), lengths))
  }
  return null
}

// The prompt's header for a run of `agent` at `now`. `internet` is `AGENT_INTERNET`.
export function headerFor({ agent, paths, now, timeZone, homeCurrency, internet }) {
  return promptHeader({
    now,
    timeZone,
    homeCurrency,
    replyMode: agent.replyMode,
    internet,
    agentDir: paths.agentDir(agent.name),
    datastoreDir: paths.datastore,
  })
}

// The batch of the most of `candidates`, taken in order, whose prompt fits, and its prompt; at
// least the first, fitted as it must be. `viewOf(batch)` is how its prompt shows it: `{ index,
// paths, agentName, now, timeZone, header }`. Returns `{ batch, prompt }`.
export function fitBatch({ agent, lane, index, upTo = index.lastSeq, candidates, fresh, viewOf }) {
  let best = null
  for (let count = 1; count <= candidates.length; count++) {
    const batch = assembleBatch({ agent, lane, index, upTo }, candidates.slice(0, count), fresh)
    const prompt = renderBatchPrompt(batch, viewOf(batch))
    if (!fits(prompt)) break
    best = { batch, prompt }
  }
  if (best) return best

  const batch = assembleBatch({ agent, lane, index, upTo }, candidates.slice(0, 1), fresh)
  const view = viewOf(batch)
  const prompt = fitOne(batch, view) ?? fitToLimit(renderBatchPrompt(batch, view, { contextKeep: 0, itemCap: 0 }))
  return { batch, prompt }
}

// The next batch of messages and its prompt, or null when there is nothing to give the agent.
// Returns `{ batch, prompt }`, with the batch as `assembleBatch` gives it.
//
// - `agent`, `state`, `index`: the config, the state and the datastore's index.
// - `paths`: what `makePaths` returns; the prompt gives absolute paths, which are the same inside
//   the VM.
// - `now`, `timeZone`, `homeCurrency`, `internet`: what the prompt's first line says.
export function buildBatch({ agent, state, index, paths, now, timeZone, homeCurrency, internet }) {
  const { candidates, fresh } = selectCandidates({ agent, lane: state, index, now })
  if (candidates.length === 0) return null
  const view = { index, paths, agentName: agent.name, now, timeZone, header: headerFor({ agent, paths, now, timeZone, homeCurrency, internet }) }
  return fitBatch({ agent, lane: state, index, candidates, fresh, viewOf: () => view })
}

// The prompt of a scheduled task. No messages, and no context.
export function buildTaskPrompt({ agent, task, paths, now, timeZone, homeCurrency, internet }) {
  return renderTaskPrompt(task, { header: headerFor({ agent, paths, now, timeZone, homeCurrency, internet }) })
}
