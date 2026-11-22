// Backfills: the datastore's history run through a newly added skill alone,
// without touching the other views and without stopping live work. A rebuild for one view.
//
// - **Its lane in the state.** `state.backfill` is `{ id, until, cursor, retry, skipped }`.
//   A start begins the first backfill of the config that isn't in `backfillDone`, with `until` the
//   live cursor, and drops one whose entry has left the config (`startupState` in `state.mjs`).
//   Live runs, which load the new skill from then on, handle everything after `until`, and the
//   backfill everything up to it, so every message is covered once.
// - **When it runs** (`nextAction` in `triggers.mjs`): a batch only when nothing live is waiting,
//   no work items after the live cursor, no due retries and no scheduled task. Runs never overlap,
//   so a message that arrives during a batch waits for it, and then goes first.
// - **Its batches** are replayed (`replay.mjs`): one of the owner's days each, `Now:` the time of
//   the batch's newest item, a session of its own for each day, and the locks. The prompt starts
//   with a line saying it is a backfill and what it may change (`backfillIntro`). pi gets the
//   backfill's skill alone, with the system prompt of live runs, so the owner's current
//   preferences apply to all of history.
// - **What it may change:** the paths in `writes`, and nothing else. After the check of the files
//   pi left, a batch that changed anything else, `memory/` included, fails as pi's own failure, and
//   the clean-up throws it away (`mayChange`, used in `run.mjs`).
// - **Silent:** nothing is sent per batch. Texts, `REPLY_TO` and `NO_REPLY` are ignored, and a
//   failure sends no notice.
// - **Its own retries,** handled like the live ones (`settleBackfill`): an item not
//   reported is tried again a minute later; one reported `FAILED`, or given up on after
//   `MAX_ATTEMPTS`, goes to `skipped`. An edit or deletion brings in the message it changes from
//   the backfill's retries or `skipped`, as from the live ones. A setup error or an outage pauses
//   every run, as it does after a live run, and the items wait with their attempts as they were.
//   A batch leaves `lastRun` alone: that is the live runs' (the plan's rule for milestone 4).
// - **Commits:** `lifelog: backfill people-1 #812-#831` (`commitMessage` in `run.mjs`).
// - **Finishing** (`finishBackfill`): once its cursor has reached `until` and its retries are
//   done, the ID goes to `backfillDone`, and the owner gets one message, which counts the rows of
//   each CSV in `writes`, and those marked ❓, and lists what was skipped.

import fs from 'node:fs'
import path from 'node:path'
import { readUntrustedFile } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { pauseAfterRun, settleLane } from './failures.mjs'
import { buildReplayBatch, removeReplaySessions, replaySessionId } from './replay.mjs'
import { saveState } from './state.mjs'

// What "and" makes of a list.
function listed(words) {
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

// The line a backfill's prompt starts with, for the backfill `entry` of `agents.yaml`.
export function backfillIntro(entry) {
  return (
    `Backfill (from your configuration, not a message from the owner): file these messages for the ${entry.skill} skill only. ` +
    `Change only ${listed(entry.writes)}.`
  )
}

// The skills pi gets for a backfill's batch: the backfill's own, alone.
export function backfillSkills(agent, entry) {
  return agent.skills.filter(skill => skill.name === entry.skill)
}

// Whether a backfill that may change `writes` may change `file`, a path from the agent's folder: a
// file `writes` names, or anything in a folder it names (ending in `/`).
export function mayChange(file, writes) {
  return writes.some(write => (write.endsWith('/') ? file.startsWith(write) : file === write))
}

// A backfill's lane, as `batch.mjs` draws batches from one: `skipped` takes the place of `failed`.
export function backfillLane(backfill) {
  return { cursor: backfill.cursor, retry: backfill.retry, failed: backfill.skipped.map(seq => ({ seq })) }
}

// The job of the next batch of the backfill in progress, for `performRun`, or null when there is
// nothing to give the agent now. `entry` is the backfill's entry in `agents.yaml`; the rest is as
// for `buildReplayBatch`, with `now` the clock's time.
export function backfillJob({ agent, entry, state, index, paths, now, timeZone, homeCurrency, internet }) {
  const backfill = state.backfill
  const built = buildReplayBatch({
    agent,
    lane: backfillLane(backfill),
    until: backfill.until,
    index,
    paths,
    now,
    timeZone,
    homeCurrency,
    internet,
    intro: backfillIntro(entry),
  })
  if (built === null) return null
  return {
    kind: 'backfill',
    id: entry.id,
    batch: built.batch,
    prompt: built.prompt,
    day: built.day,
    sessionId: replaySessionId(agent, { day: built.day, backfill: entry.id }),
    skills: backfillSkills(agent, entry),
    writes: entry.writes,
  }
}

// The state after a backfill's batch: its lane settled as a live one is (`settleLane`), with what
// was given up on in `skipped`, and the pause as after any run. `lastRun` is left alone. Returns
// `{ state, givenUp }`.
export function settleBackfill(state, batch, outcome, { now }) {
  const backfill = state.backfill
  const { lane, givenUp } = settleLane(backfillLane(backfill), batch, outcome, { now })
  const skipped = [...new Set(lane.failed.map(entry => entry.seq))]
  const next = pauseAfterRun(state, outcome, { now })
  return { state: { ...next, backfill: { ...backfill, cursor: lane.cursor, retry: lane.retry, skipped } }, givenUp }
}

// ---------------------------------------------------------------------------------------------
// Finishing

// The rows of a CSV file's text, and how many of them are marked ❓: the records after the header,
// blank ones left out. A field in double quotes may hold commas and line breaks.
export function countRows(text) {
  let quoted = false
  let records = 0
  let marked = 0
  let filled = false
  let mark = false
  const end = () => {
    if (filled) {
      records += 1
      if (mark && records > 1) marked += 1
    }
    filled = false
    mark = false
  }
  for (const char of text) {
    if (char === '"') quoted = !quoted
    if (char === '\n' && !quoted) {
      end()
      continue
    }
    if (char === '❓') mark = true
    if (char !== ' ' && char !== '\t' && char !== '\r') filled = true
  }
  end()
  return { rows: Math.max(0, records - 1), unsure: marked }
}

// The CSV files a backfill's `writes` name, as `{ name, file }`: `name` the path from `views/`,
// `file` the path on disk. A folder in `writes` gives every CSV file in it, at any depth, in order;
// a file that isn't a CSV gives none. Links aren't followed.
function csvFilesOf(agentDir, writes) {
  const found = []
  const walk = (folder, relative) => {
    let entries
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const inner = `${relative}${entry.name}`
      if (entry.isDirectory()) walk(path.join(folder, entry.name), `${inner}/`)
      else if (entry.isFile() && entry.name.endsWith('.csv')) found.push({ name: inner.slice('views/'.length), file: path.join(folder, entry.name) })
    }
  }
  for (const write of writes) {
    if (write.endsWith('/')) {
      const before = found.length
      walk(path.join(agentDir, write), write)
      if (found.length === before) found.push({ name: write.slice('views/'.length), file: null })
    } else if (write.endsWith('.csv')) {
      found.push({ name: write.slice('views/'.length), file: path.join(agentDir, write) })
    }
  }
  return found
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// What one CSV file of a backfill's says in its summary.
function describeCsv({ name, file }) {
  if (file === null) return `${name} holds no CSV file`
  let text
  try {
    // The views are the last commit's now, which the check of the files pi left let through: within its limits,
    // and no link. Read with care all the same, as everything pi wrote is.
    text = readUntrustedFile(file, { maxBytes: limits.AGENT_FILES_MAX_BYTES })
  } catch (error) {
    return error.code === 'ENOENT' ? `${name} isn't there` : `${name} couldn't be read`
  }
  const { rows, unsure } = countRows(text)
  return `${name} has ${plural(rows, 'row')}, ${unsure === 0 ? 'none' : unsure} marked ❓`
}

// The message a backfill sends when it finishes: "Backfill people-1 finished: people.csv
// has 143 rows, 12 marked ❓. Skipped: #1031, #1207."
export function backfillSummary({ paths, agent, entry, skipped }) {
  const parts = csvFilesOf(paths.agentDir(agent.name), entry.writes).map(describeCsv)
  const head = `Backfill ${entry.id} finished${parts.length > 0 ? `: ${parts.join('; ')}` : ''}.`
  const sorted = [...skipped].sort((a, b) => a - b)
  return sorted.length === 0 ? head : `${head} Skipped: ${sorted.map(seq => `#${seq}`).join(', ')}.`
}

// Finishes the backfill in progress, whose entry in `agents.yaml` is `entry`: writes its summary to
// the outbox, then moves its ID to `backfillDone` and saves the state, so a crash between the two
// sends the summary twice and never loses it. Its sessions go. Returns the new state.
//
// The summary is the runner's, by `runner`, and goes to `DEFAULT_CHANNEL`, also with
// `can_message: false`, as the notices do: that setting is about what the agent sends.
export async function finishBackfill({ agent, entry, state, stateFile, paths, ids, log }) {
  const { backfill, ...rest } = state
  const text = backfillSummary({ paths, agent, entry, skipped: backfill.skipped })
  const id = await writeOutboxEntry({ paths, ids, entry: { type: 'text', by: 'runner', text } })
  const next = { ...rest, backfillDone: rest.backfillDone.includes(backfill.id) ? rest.backfillDone : [...rest.backfillDone, backfill.id] }
  saveState(stateFile, next)
  const sessions = removeReplaySessions({ paths, agent, backfill: backfill.id, log })
  log.info('runner.backfill_finished', { agent: agent.name, backfill: backfill.id, until: backfill.until, skipped: backfill.skipped.length, sessions, entry: id })
  return next
}
