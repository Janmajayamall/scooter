// What a run's outcome does (6.8, 6.9 of DESIGN.md): why a run failed, read from the network log;
// pauses and when they are tried again; the attempts each item has used; and the notices the owner
// gets.
//
// When pi fails, or leaves a file git wouldn't record, the cause decides what happens next. The
// runner reads it from OpenRouter's last answer during the run, in its own network log (6.13):
//
// | Cause   | Sign                                            | What happens                        |
// |---------|-------------------------------------------------|-------------------------------------|
// | setup   | 401, 402, 403 or 404                            | Runs pause, and are tried every 30  |
// |         |                                                 | minutes and at each start           |
// | outage  | 408, 429, a 5xx, or no answer                   | Tried after 1, 5 and 30 minutes,    |
// |         |                                                 | then every 30                       |
// | other   | pi crashed or timed out while OpenRouter was    | Each item counts an attempt, and is |
// |         | answering, or it left an unexpected file        | due again a minute later            |
//
// Neither a setup error nor an outage counts an attempt: the batch's items wait in `retry` for the
// next try, with their counts unchanged, so nothing they hold up ends in `failed`.
//
// Everything here is a pure function, apart from reading the log.

import { limits } from '../common/limits.mjs'
import { readNetworkLog } from '../common/netlog.mjs'
import { isoSeconds } from '../common/time.mjs'
import { shortReason } from './answer.mjs'
import { OPENROUTER_HOST } from './sandbox/index.mjs'

export const SETUP_STATUSES = [401, 402, 403, 404]
const isOutageStatus = status => status === 408 || status === 429 || status >= 500

// ---------------------------------------------------------------------------------------------
// The cause

// OpenRouter's last answer among `entries`, lines of the network log: the outcome of the last
// request to OpenRouter. Returns null when there was none, and otherwise one of
//
//   { status }           OpenRouter answered with this status
//   { answer: 'none' }   the request got no answer: it couldn't be sent, or the connection broke,
//                        or the run ended while it waited
export function lastOpenRouterAnswer(entries) {
  const requests = entries.filter(entry => entry.event === 'request' && entry.host === OPENROUTER_HOST)
  const last = requests.at(-1)
  if (!last) return null
  const outcome = entries.find(entry => entry.id === last.id && (entry.event === 'response' || entry.event === 'error'))
  return outcome?.event === 'response' ? { status: outcome.status } : { answer: 'none' }
}

// What OpenRouter said, in its own words, from the last line pi printed on stderr: `401 {…}` on
// the messages route and `401: {…}` on the chat route, each with the error's message in it
// (`docs/DECISIONS.md`, 0.4, pi 5). Returns null when that line isn't one for `status`. The words
// come from outside: they go into the owner's notice and the state, never into Scooter's logs.
export function openRouterMessage(stderr, status) {
  const last = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1)
  const match = last && /^(\d{3}):? (\{.*\})$/.exec(last)
  if (!match || Number(match[1]) !== status) return null
  let body
  try {
    body = JSON.parse(match[2])
  } catch {
    return null
  }
  const message = body?.error?.message ?? body?.message
  return typeof message === 'string' && message.trim() !== '' ? shortReason(message) : null
}

// Why a run failed. `result` is what the sandbox returned, or `{ error }` when it couldn't run
// the command; `unexpected` the file a successful pi left that git wouldn't record, or null;
// `answer` what `lastOpenRouterAnswer` found. Returns `{ cause, reason, status }`: `cause` is
// `setup`, `outage` or `other`, `reason` the short reason for the owner and the state, and
// `status` OpenRouter's last status or null.
//
// A sandbox that couldn't run pi at all, such as a VM that doesn't boot, is a setup error: it is
// the machine's, not the message's, and trying every message four times wouldn't help.
export function failureCause({ result, unexpected = null, answer = null }) {
  const status = answer?.status ?? null
  if (result.error) return { cause: 'setup', reason: "the VM couldn't start", status }
  if (result.code === 0 && unexpected !== null) return { cause: 'other', reason: shortReason(`unexpected file ${unexpected}`), status }

  if (status !== null && (SETUP_STATUSES.includes(status) || isOutageStatus(status))) {
    const words = openRouterMessage(result.stderr ?? '', status)
    return {
      cause: SETUP_STATUSES.includes(status) ? 'setup' : 'outage',
      reason: words === null ? `OpenRouter answered ${status}` : `OpenRouter: ${words}`,
      status,
    }
  }
  if (answer?.answer === 'none') return { cause: 'outage', reason: "OpenRouter didn't answer", status }
  if (result.timedOut) return { cause: 'other', reason: 'timed out', status }
  if (result.code === null) return { cause: 'other', reason: 'pi was stopped', status }
  return { cause: 'other', reason: `pi exited with code ${result.code}`, status }
}

// Reads the cause of a failed run from the network log, for the run from `startedAt` to `endedAt`.
export function readFailureCause({ paths, result, unexpected = null, startedAt, endedAt }) {
  const { entries } = readNetworkLog(paths, { from: startedAt, to: endedAt })
  return failureCause({ result, unexpected, answer: lastOpenRouterAnswer(entries) })
}

// ---------------------------------------------------------------------------------------------
// Pauses (6.9)

// The pause after a failed try with a setup error or an outage. A try that fails for the same cause
// as the pause it was made in continues it: one more try, and the wait that comes with it. The
// waits are `SETUP_RETRY_WAIT` after a setup error, and `OUTAGE_RETRY_WAITS`, the last repeating,
// during an outage.
export function pauseAfter(paused, { cause, reason, now }) {
  const continued = paused?.cause === cause
  const tries = continued ? paused.tries + 1 : 1
  const waits = limits.OUTAGE_RETRY_WAITS
  const wait = cause === 'setup' ? limits.SETUP_RETRY_WAIT : waits[Math.min(tries, waits.length) - 1]
  return { since: continued ? paused.since : isoSeconds(now), cause, reason, next: isoSeconds(now + wait), tries }
}

// ---------------------------------------------------------------------------------------------
// The state after a run

// The run's outcome, as `settleBatch` and `settleTask` take it:
//
//   { ok: true, done: Set, failed: Map }        pi succeeded; for a batch, what it reported
//   { ok: false, cause, reason }                it failed, for this cause (`failureCause`)

function withoutPause(state) {
  const { paused, ...rest } = state
  return rest
}

// What every run does to the state, whatever it ran: `lastRun`, and the pause.
function afterRun(state, outcome, { now, startedAt, durationMs, seqs }) {
  const next = { ...state, lastRun: { at: isoSeconds(startedAt), ok: outcome.ok, seqs, durationMs } }
  if (outcome.ok || outcome.cause === 'other') return withoutPause(next)
  return { ...next, paused: pauseAfter(state.paused, { cause: outcome.cause, reason: outcome.reason, now }) }
}

// Whether a failed run is the first of a row: the run before it got through, or there was none.
// The first sends the owner a notice, and later ones don't (6.9; the plan's rule for milestone 4).
export function isFirstFailure(state) {
  return state.lastRun === null || state.lastRun.ok
}

// The state after a batch of messages (6.8 step 5, 6.9). `batch` is what `buildBatch` gave. Returns
// `{ state, givenUp }`, with the items that ran out of attempts, in order.
//
// - **Done:** gone from `retry`.
// - **Failed** by the agent: into `failed`, with its reason.
// - **Not reported,** or in a batch that failed for another reason: one attempt more, due again
//   `RETRY_WAIT` later. After `MAX_ATTEMPTS`, into `failed` and given up.
// - **A setup error or an outage:** every item waits in `retry` for the next try, its attempts as
//   they were. It is due at once: the pause holds every run back until the next try, which comes
//   sooner when the runner restarts (6.9).
//
// An item brought in from `failed` leaves it and starts again at attempt 1 (6.5). `failed` keeps
// its newest `FAILED_KEEP`. The cursor moves past the batch in every case: what the batch didn't
// handle waits in `retry`, which comes first in the next batch.
export function settleBatch(state, batch, outcome, { now, startedAt, durationMs }) {
  const at = isoSeconds(now)
  const seqs = batch.items.map(item => item.seq)
  const inBatch = new Set(seqs)
  const retry = state.retry.filter(entry => !inBatch.has(entry.seq))
  const failed = state.failed.filter(entry => !inBatch.has(entry.seq))
  const givenUp = []

  const giveUp = (seq, reason) => failed.push({ seq, at, reason })
  const tryAgain = (item, reason) => {
    if (item.attempt >= limits.MAX_ATTEMPTS) {
      giveUp(item.seq, `not handled after ${limits.MAX_ATTEMPTS} attempts`)
      givenUp.push(item.seq)
    } else {
      retry.push({ seq: item.seq, attempts: item.attempt, due: isoSeconds(now + limits.RETRY_WAIT), reason })
    }
  }

  let next
  if (outcome.ok) {
    for (const item of batch.items) {
      if (outcome.failed.has(item.seq)) giveUp(item.seq, outcome.failed.get(item.seq))
      else if (!outcome.done.has(item.seq)) tryAgain(item, 'not reported')
    }
    next = afterRun(state, outcome, { now, startedAt, durationMs, seqs })
  } else if (outcome.cause === 'other') {
    for (const item of batch.items) tryAgain(item, outcome.reason)
    next = afterRun(state, outcome, { now, startedAt, durationMs, seqs })
  } else {
    next = afterRun(state, outcome, { now, startedAt, durationMs, seqs })
    for (const item of batch.items) retry.push({ seq: item.seq, attempts: item.attempt - 1, due: at, reason: outcome.reason })
  }

  retry.sort((a, b) => a.seq - b.seq)
  return {
    state: { ...next, cursor: Math.max(state.cursor, batch.covered), retry, failed: failed.slice(-limits.FAILED_KEEP) },
    givenUp,
  }
}

// The state after a scheduled or `once` task (the plan's rule for milestone 4). `task` is
// `{ kind: 'scheduled', at, date }` or `{ kind: 'once', id }`.
//
// - A task that fails on a setup error or an outage stays due, and is the next try.
// - A scheduled task that ran, or failed for another reason, is done for its date: it runs again
//   at its next time.
// - A `once` task is recorded in `onceDone` only after it succeeds. One that fails for another
//   reason runs again at the next start; the runner remembers until then that it tried (D68).
export function settleTask(state, task, outcome, { now, startedAt, durationMs }) {
  let next = afterRun(state, outcome, { now, startedAt, durationMs, seqs: [] })
  const counts = outcome.ok || outcome.cause === 'other'
  if (task.kind === 'scheduled' && counts) next = { ...next, scheduled: { ...next.scheduled, [task.at]: task.date } }
  if (task.kind === 'once' && outcome.ok && !next.onceDone.includes(task.id)) next = { ...next, onceDone: [...next.onceDone, task.id] }
  return next
}

// ---------------------------------------------------------------------------------------------
// Notices (6.9). They are the runner's own, sent to `DEFAULT_CHANNEL` (5.3).

const minutes = ms => Math.round(ms / 60000)

// The notice of the first failure in a row. `job` is `{ kind: 'messages' }`, or the task as for
// `settleTask`; `failure` what `failureCause` returned.
export function failureNotice(job, { cause, reason }) {
  const what =
    job.kind === 'scheduled' ? `run the scheduled task ${job.at}` : job.kind === 'once' ? `run the task ${job.id}` : 'process your last messages'
  let next
  if (cause === 'setup') next = `Runs are paused until this is fixed. I'll try again every ${minutes(limits.SETUP_RETRY_WAIT)} minutes.`
  else if (cause === 'outage' || job.kind === 'messages') next = "I'll try again."
  else if (job.kind === 'scheduled') next = 'It runs again at its next time.'
  else next = "I'll try it again when I next start."
  return { type: 'text', by: 'runner', text: `⚠️ I couldn't ${what} (${reason}). ${next}` }
}

// A short way to name a message to the owner: its text as it is now, cut, or what it holds.
export function describeItem(index, seq) {
  const entry = index.get(seq)
  if (!entry) return 'a message'
  const { line } = entry
  if (line.kind === 'edit') return `an edit of #${line.target}`
  if (line.kind === 'delete') return `a deletion of #${line.target}`
  const current = index.current(seq)
  if (current && current.deletedIn !== null) return 'deleted since'
  const quote = text => {
    const chars = [...text.replace(/\s+/g, ' ').trim()]
    const cut = chars.length > limits.NOTICE_QUOTE_CHARS ? `${chars.slice(0, limits.NOTICE_QUOTE_CHARS - 1).join('')}…` : chars.join('')
    return `"${cut}"`
  }
  if (line.source === 'email') return `email ${quote(line.subject ?? '')}`
  if (current && current.text.trim() !== '') return quote(current.text)
  const mime = line.files?.[0]?.mime ?? line.media?.mime ?? ''
  if (line.media?.type === 'image' || mime.startsWith('image/')) return 'a photo'
  if (line.media?.type === 'video' || mime.startsWith('video/')) return 'a video'
  if (line.media?.type === 'audio' || mime.startsWith('audio/')) return 'an audio file'
  return line.files || line.media ? 'a document' : 'a message'
}

// The notice for items given up on: "⚠️ I gave up on #1051 ("coffee 120") after 4 attempts. Send it
// again if it matters."
export function givenUpNotice(index, seqs) {
  const names = seqs.map(seq => `#${seq} (${describeItem(index, seq)})`)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  const again = seqs.length === 1 ? 'Send it again if it matters.' : 'Send them again if they matter.'
  return { type: 'text', by: 'runner', text: `⚠️ I gave up on ${list} after ${limits.MAX_ATTEMPTS} attempts. ${again}` }
}
