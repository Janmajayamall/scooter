// Replayed batches (6.10, 6.11 of DESIGN.md): how a rebuild and a backfill give the agent the
// datastore's history again. Both share what is here.
//
// - **One of the owner's days per batch.** A replayed batch is drawn from its lane as a live one
//   is (6.5, `batch.mjs`): due retries first, then work items after the lane's cursor, up to the
//   `seq` the replay stops at, at most `BATCH_MAX_ITEMS` and within `PROMPT_MAX_BYTES`. And every
//   item it takes was sent on one day of the owner's: the local date, in `SCOOTER_TZ`, of the
//   first item's `at`. It stops at the first item sent on another. A message that an edit or a
//   deletion in it brings in, from the lane's retries or from what it gave up on, joins whatever
//   its day, as it may take a batch past 20 (6.5): otherwise the edit would be handled before the
//   message it changes. It is shown with its date, which says when it was sent.
// - **`Now:`** in the prompt is the time of the batch's newest item, not the clock's, so "today"
//   and "yesterday" in old messages mean what they meant then. Every item but one brought in is of
//   that day, so every one of them was sent "today".
// - **A session for each of the owner's days:** `<agent>-rebuild-<day>`, or
//   `<agent>-backfill-<id>-<day>`, so a day's batches continue one conversation and no other day's.
//   With `session: none`, none, as for live runs. A replay's sessions serve only it, and go once it
//   is over (`removeReplaySessions`).
// - **The locks:** each batch is a run (`performRun` in `run.mjs`), which takes `run.lock` and gives
//   way to `backup.lock`, as a live run does (6.4), so a backup never sees half a batch.
//
// A replay is silent: nothing it runs sends anything, and its failures send no notice.

import fs from 'node:fs'
import path from 'node:path'
import { errorFields } from '../common/log.mjs'
import { localDate, parseIsoSeconds } from '../common/time.mjs'
import { fitBatch, headerFor, selectCandidates } from './batch.mjs'

// The owner's day a line was sent on: the date of its `at` in `timeZone`, such as `2026-11-09`.
export function ownersDay(line, timeZone) {
  return localDate(parseIsoSeconds(line.at), timeZone)
}

// The items a replayed batch may take, in order: those `selectCandidates` would take, up to the
// first sent on another of the owner's days than the first. Returns `{ candidates, fresh, day }`,
// `day` being the batch's, or null when there is nothing to take.
export function replayCandidates({ agent, lane, index, now, upTo, timeZone }) {
  const { candidates, fresh } = selectCandidates({ agent, lane, index, now, upTo })
  if (candidates.length === 0) return { candidates, fresh, day: null }
  const dayOf = candidate => ownersDay(index.get(candidate.seq).line, timeZone)
  const day = dayOf(candidates[0])
  const other = candidates.findIndex(candidate => dayOf(candidate) !== day)
  return { candidates: other === -1 ? candidates : candidates.slice(0, other), fresh, day }
}

// The time a replayed batch is shown as having: that of its newest item, by `at`.
export function batchTime(batch, index) {
  return Math.max(...batch.items.map(item => parseIsoSeconds(index.get(item.seq).line.at)))
}

// The next replayed batch of a lane, and its prompt, or null when there is nothing to give the
// agent now. Returns `{ batch, prompt, day, time }`: the batch as `assembleBatch` gives it, the
// owner's day it is of, and the time its prompt's `Now:` says.
//
// - `agent`, `index`: the config and the datastore's index.
// - `lane`: `{ cursor, retry, failed }` (`batch.mjs`); `until`: the `seq` the replay stops at.
// - `now`: the clock's time, which says which retries are due.
// - `paths`, `timeZone`, `homeCurrency`, `internet`: as for a live batch.
// - `intro`: a line the prompt starts with, or null: a backfill's (6.11).
export function buildReplayBatch({ agent, lane, until, index, paths, now, timeZone, homeCurrency, internet, intro = null }) {
  const upTo = Math.min(until, index.lastSeq)
  const { candidates, fresh, day } = replayCandidates({ agent, lane, index, now, upTo, timeZone })
  if (candidates.length === 0) return null
  const viewOf = batch => {
    const time = batchTime(batch, index)
    const header = headerFor({ agent, paths, now: time, timeZone, homeCurrency, internet })
    return { index, paths, agentName: agent.name, now: time, timeZone, header: intro === null ? header : `${intro}\n${header}` }
  }
  const { batch, prompt } = fitBatch({ agent, lane, index, upTo, candidates, fresh, viewOf })
  return { batch, prompt, day, time: batchTime(batch, index) }
}

// The session of a replayed batch of the owner's day `day`: `<agent>-rebuild-<day>` for a rebuild,
// and `<agent>-backfill-<id>-<day>` for the backfill `backfill`. Null with `session: none`.
export function replaySessionId(agent, { day, backfill = null }) {
  if (agent.session === 'none') return null
  return `${replaySessionPrefix(agent, { backfill })}${day}`
}

function replaySessionPrefix(agent, { backfill = null }) {
  return backfill === null ? `${agent.name}-rebuild-` : `${agent.name}-backfill-${backfill}-`
}

// Removes the sessions a replay kept, a rebuild's or the backfill `backfill`'s, once it is over:
// they serve no other run. Only names of the form `<prefix><day>.jsonl` go, so a backfill whose ID
// begins with another's, such as `people-1-2` beside `people-1`, keeps its own. Returns how many
// went. An error is logged, and leaves the rest where they are: they are the runner's, and harm
// nothing.
export function removeReplaySessions({ paths, agent, backfill = null, log }) {
  const dir = paths.agentSessions(agent.name)
  const prefix = replaySessionPrefix(agent, { backfill })
  let removed = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name.slice(prefix.length))) continue
      fs.rmSync(path.join(dir, name), { force: true })
      removed += 1
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log.warn('runner.replay_sessions_left', { agent: agent.name, ...errorFields(error) })
  }
  return removed
}
