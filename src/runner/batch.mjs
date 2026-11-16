// The batch (6.5 of DESIGN.md): which items the agent is given in one run, what it is shown for
// context, and the prompt that says it.
//
// - **Items:** due retries first, then work items after the cursor, oldest first, at most
//   `BATCH_MAX_ITEMS`. The batch also stops growing once its prompt would pass `PROMPT_MAX_BYTES`,
//   and always keeps at least one item.
// - **Brought in:** an edit or deletion in the batch also brings in the message it changes, when
//   that message waits in `retry` (due or not) or is in `failed`. It joins as a retry; one from
//   `failed` starts again at attempt 1. Otherwise the edit could be handled before its message, and
//   the retry would later file the old text. These can take the batch past `BATCH_MAX_ITEMS`.
// - **Context:** the out lines and reactions from the oldest item to the end of what the batch
//   covers, plus the message each reply quotes, shown under it.
// - **Covered:** the lines up to the first work item left for a later batch. When the run succeeds,
//   the cursor moves there (6.8): the context, the commands and the lines of other sources in that
//   stretch are dealt with too.
//
// When even one item makes the prompt too long, it is fitted, in this order: the oldest lines of
// context are left out; if the item is too long on its own, its texts are cut, followed by where
// the whole of each is; and, last, the prompt is cut at the limit.

import { limits } from '../common/limits.mjs'
import { fitToLimit, promptHeader, renderBatchPrompt, renderTaskPrompt } from './prompt.mjs'
import { dueRetries, isWorkItem, workItemsAfter } from './triggers.mjs'

const fits = prompt => Buffer.byteLength(prompt) <= limits.PROMPT_MAX_BYTES

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
// cursor.
export function selectCandidates({ agent, state, index, now }) {
  const retries = dueRetries(state.retry, index, agent.reads, now).map(entry => ({ seq: entry.seq, origin: 'retry', attempt: entry.attempts + 1 }))
  const fresh = workItemsAfter(index, agent.reads, state.cursor)
  const news = fresh.map(seq => ({ seq, origin: 'new', attempt: 1 }))
  return { candidates: [...retries, ...news].slice(0, limits.BATCH_MAX_ITEMS), fresh }
}

// The batch of the given candidates, the first ones `selectCandidates` returned:
//
//   { items: [{ seq, origin, attempt }], context: [seq], covered, newest }
//
// `items` are in `seq` order, with those brought in by an edit or deletion (`origin` `retry` or
// `failed`). `context` is in `seq` order. `covered` is where the cursor goes when the run succeeds,
// and `newest` the newest item, which an answer's plain text is `about` (6.7).
export function assembleBatch({ agent, state, index }, candidates, fresh) {
  const items = new Map(candidates.map(candidate => [candidate.seq, candidate]))
  for (const candidate of candidates) {
    const { line } = index.get(candidate.seq)
    if (line.kind !== 'edit' && line.kind !== 'delete') continue
    const target = line.target
    const entry = index.get(target)
    if (items.has(target) || !entry || !isWorkItem(entry.line, agent.reads)) continue
    const retry = state.retry.find(other => other.seq === target)
    if (retry) {
      items.set(target, { seq: target, origin: 'retry', attempt: retry.attempts + 1 })
    } else if (state.failed.some(other => other.seq === target)) {
      items.set(target, { seq: target, origin: 'failed', attempt: 1 })
    }
  }

  const taken = candidates.filter(candidate => candidate.origin === 'new').length
  const covered = taken < fresh.length ? fresh[taken] - 1 : index.lastSeq
  const sorted = [...items.values()].sort((a, b) => a.seq - b.seq)
  const context = []
  for (let seq = sorted[0].seq; seq <= covered; seq++) {
    const entry = index.get(seq)
    if (!entry || items.has(seq)) continue
    if (entry.line.dir === 'out' || entry.line.kind === 'reaction') context.push(seq)
  }
  return { items: sorted, context, covered: Math.max(covered, state.cursor), newest: sorted.at(-1).seq }
}

// Fits the prompt of a batch of one candidate that is too long as it stands.
function fitOne(batch, view) {
  const all = batch.context.length
  const render = (contextKeep, itemCap) => renderBatchPrompt(batch, view, { contextKeep, itemCap })
  // The item fits on its own: as much context as fits with it, the newest first.
  if (fits(render(0, Infinity))) return render(largest(0, all, keep => fits(render(keep, Infinity))), Infinity)
  // It doesn't: its texts are cut, as little as will do, with the context if there is room for it.
  for (const keep of [all, 0]) {
    if (fits(render(keep, 0))) return render(keep, largest(0, limits.PROMPT_MAX_BYTES, cap => fits(render(keep, cap))))
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

// The next batch of messages and its prompt, or null when there is nothing to give the agent.
// Returns `{ batch, prompt }`, with the batch as `assembleBatch` gives it.
//
// - `agent`, `state`, `index`: the config, the state and the datastore's index.
// - `paths`: what `makePaths` returns; the prompt gives absolute paths, which are the same inside
//   the VM (6.6).
// - `now`, `timeZone`, `homeCurrency`, `internet`: what the prompt's first line says.
export function buildBatch({ agent, state, index, paths, now, timeZone, homeCurrency, internet }) {
  const { candidates, fresh } = selectCandidates({ agent, state, index, now })
  if (candidates.length === 0) return null
  const view = { index, paths, agentName: agent.name, now, timeZone, header: headerFor({ agent, paths, now, timeZone, homeCurrency, internet }) }

  let best = null
  for (let count = 1; count <= candidates.length; count++) {
    const batch = assembleBatch({ agent, state, index }, candidates.slice(0, count), fresh)
    const prompt = renderBatchPrompt(batch, view)
    if (!fits(prompt)) break
    best = { batch, prompt }
  }
  if (best) return best

  const batch = assembleBatch({ agent, state, index }, candidates.slice(0, 1), fresh)
  const prompt = fitOne(batch, view) ?? fitToLimit(renderBatchPrompt(batch, view, { contextKeep: 0, itemCap: 0 }))
  return { batch, prompt }
}

// The prompt of a scheduled or `once` task (6.5). No messages, and no context.
export function buildTaskPrompt({ agent, task, paths, now, timeZone, homeCurrency, internet }) {
  return renderTaskPrompt(task, { header: headerFor({ agent, paths, now, timeZone, homeCurrency, internet }) })
}
