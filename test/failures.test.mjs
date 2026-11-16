// What a run's outcome does (6.8, 6.9 of DESIGN.md; section 10, "Runner"): the cause, read from
// the network log; pauses and their schedule; cursor, retry and failed transitions with an injected
// clock; and the notices. Pure functions, and the log's format and reader.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { checkNetworkLogLine, formatNetworkLogLine, readNetworkLog } from '../src/common/netlog.mjs'
import { makePaths } from '../src/common/paths.mjs'
import {
  describeItem,
  failureCause,
  failureNotice,
  givenUpNotice,
  isFirstFailure,
  lastOpenRouterAnswer,
  openRouterMessage,
  pauseAfter,
  settleBatch,
  settleTask,
} from '../src/runner/failures.mjs'
import { indexOf, line } from './support/runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const at = Date.parse
const MINUTE = 60 * 1000
const NOW = at('2026-11-09T15:51:00Z')
const TIMING = { now: NOW, startedAt: at('2026-11-09T15:50:10Z'), durationMs: 50000 }

const request = (id, host = 'openrouter.ai') => ({ id, at: '2026-11-09T15:50:12Z', event: 'request', host, method: 'POST', path: '/api/v1/messages' })
const response = (id, status) => ({ id, at: '2026-11-09T15:50:19Z', event: 'response', status, sent: 48211, received: 5340, ms: 7012 })
const ID1 = '20261109T155012041-0001'
const ID2 = '20261109T155013502-0001'

// ---------------------------------------------------------------------------------------------
// The network log

test('network log: the lines of 6.13, checked and written in order', () => {
  const lines = [
    request(ID1),
    response(ID1, 200),
    { id: ID2, at: '2026-11-09T15:50:14Z', event: 'error', reason: 'ECONNREFUSED', ms: 31 },
    { at: '2026-11-09T15:51:02Z', event: 'refused', host: 'example.com', reason: 'host not allowed' },
  ]
  for (const entry of lines) assert.deepEqual(checkNetworkLogLine(entry), [], JSON.stringify(entry))
  assert.equal(
    formatNetworkLogLine({ path: '/api/v1/messages', method: 'POST', host: 'openrouter.ai', event: 'request', at: '2026-11-09T15:50:12Z', id: ID1 }),
    '{"id":"20261109T155012041-0001","at":"2026-11-09T15:50:12Z","event":"request","host":"openrouter.ai","method":"POST","path":"/api/v1/messages"}\n',
  )
  // Never a query string, a header or a body.
  assert.deepEqual(checkNetworkLogLine({ ...request(ID1), path: '/api/v1/messages?beta=true' }), ['path must be a path without a query string'])
  assert.deepEqual(checkNetworkLogLine({ ...request(ID1), headers: {} }), ["headers doesn't belong on a request line"])
  assert.deepEqual(checkNetworkLogLine({ ...response(ID1, 200), body: 'x' }), ["body doesn't belong on a response line"])
  assert.deepEqual(checkNetworkLogLine({ ...response(ID1, 200), status: 99 }), ['status must be an HTTP status'])
  assert.deepEqual(checkNetworkLogLine({ event: 'gossip' }), ['event must be one of request, response, error, refused'])
  assert.throws(() => formatNetworkLogLine({ event: 'response', id: ID1 }), /not a line of the network log: at is missing/)
})

test('network log: read by time across UTC days, skipping what isn\'t a line', t => {
  const paths = makePaths({ dataDir: path.join(makeTestDir(t), 'data'), configDir: '/config' })
  fs.mkdirSync(paths.networkLogDir, { recursive: true })
  const late = { ...request('20261108T235959000-0001'), at: '2026-11-08T23:59:59Z' }
  fs.writeFileSync(paths.networkLog('2026-11-08'), formatNetworkLogLine({ ...request('20261108T120000000-0001'), at: '2026-11-08T12:00:00Z' }) + formatNetworkLogLine(late))
  fs.writeFileSync(
    paths.networkLog('2026-11-09'),
    [formatNetworkLogLine(response('20261108T235959000-0001', 200)), 'not json\n', '{"event":"request"}\n', formatNetworkLogLine(request(ID1)), '{"id":"2026'].join(''),
  )
  const { entries, skipped } = readNetworkLog(paths, { from: at('2026-11-08T23:59:59.400Z'), to: at('2026-11-09T15:50:19Z') })
  // The second `from` falls in counts whole; a partial last line and lines that aren't lines are skipped.
  assert.deepEqual(entries, [late, response('20261108T235959000-0001', 200), request(ID1)])
  assert.equal(skipped, 3)
  // A line after `to` is left out.
  assert.deepEqual(readNetworkLog(paths, { from: at('2026-11-09T15:50:12Z'), to: at('2026-11-09T15:50:18Z') }).entries, [request(ID1)])
  assert.deepEqual(readNetworkLog(paths, { from: at('2026-11-10T00:00:00Z'), to: at('2026-11-10T10:00:00Z') }), { entries: [], skipped: 0 })
})

// ---------------------------------------------------------------------------------------------
// The cause

test('failures: OpenRouter\'s last answer during a run', () => {
  assert.equal(lastOpenRouterAnswer([]), null)
  assert.equal(lastOpenRouterAnswer([request(ID1, 'example.com'), response(ID1, 200)]), null)
  assert.deepEqual(lastOpenRouterAnswer([request(ID1), response(ID1, 200), request(ID2), response(ID2, 429)]), { status: 429 })
  // An answer to the last request, not an earlier one.
  assert.deepEqual(lastOpenRouterAnswer([request(ID1), request(ID2), response(ID1, 200)]), { answer: 'none' })
  assert.deepEqual(lastOpenRouterAnswer([request(ID1), { id: ID1, at: '2026-11-09T15:50:14Z', event: 'error', reason: 'ETIMEDOUT', ms: 9 }]), { answer: 'none' })
  // A refusal by the policy isn't OpenRouter's answer.
  assert.deepEqual(lastOpenRouterAnswer([request(ID1), response(ID1, 200), { at: '2026-11-09T15:50:20Z', event: 'refused', host: 'example.com', reason: 'host not allowed' }]), { status: 200 })
})

test('failures: OpenRouter\'s own words, from the last line pi printed on stderr', () => {
  const messages = '401 {"type":"error","error":{"type":"authentication_error","message":"User not found."},"request_id":null}'
  const chat = '404: {"message":"No endpoints found matching your data policy","code":404}'
  assert.equal(openRouterMessage(`Warning: No project session found\n${messages}\n`, 401), 'User not found.')
  assert.equal(openRouterMessage(chat, 404), 'No endpoints found matching your data policy')
  // Only for the status the log shows, and only from a line in pi's format.
  assert.equal(openRouterMessage(messages, 403), null)
  assert.equal(openRouterMessage('401 not json', 401), null)
  assert.equal(openRouterMessage('Error: something else', 401), null)
  assert.equal(openRouterMessage('', 401), null)
})

test('failures: the cause is the status of OpenRouter\'s last answer, or what pi did', () => {
  const failed = (code, extra = {}) => ({ code, stdout: '', stderr: '', timedOut: false, ...extra })
  const cases = [
    // Setup errors.
    ...[401, 402, 403, 404].map(status => [failed(1), { status }, { cause: 'setup', reason: `OpenRouter answered ${status}`, status }]),
    // Outages: 408, 429, a 5xx, or no answer.
    ...[408, 429, 500, 502, 503].map(status => [failed(1), { status }, { cause: 'outage', reason: `OpenRouter answered ${status}`, status }]),
    [failed(1), { answer: 'none' }, { cause: 'outage', reason: "OpenRouter didn't answer", status: null }],
    [failed(null, { timedOut: true }), { answer: 'none' }, { cause: 'outage', reason: "OpenRouter didn't answer", status: null }],
    // OpenRouter answering normally, or not asked at all: pi's own failure.
    [failed(3), { status: 200 }, { cause: 'other', reason: 'pi exited with code 3', status: 200 }],
    // OpenRouter refusing a request for another reason: its error, as for the others (6.9).
    [failed(1), { status: 400 }, { cause: 'other', reason: 'OpenRouter answered 400', status: 400 }],
    [failed(null, { timedOut: true }), { status: 413 }, { cause: 'other', reason: 'OpenRouter answered 413', status: 413 }],
    [failed(127), null, { cause: 'other', reason: 'pi exited with code 127', status: null }],
    [failed(null, { timedOut: true }), { status: 200 }, { cause: 'other', reason: 'timed out', status: 200 }],
    [failed(null), { status: 200 }, { cause: 'other', reason: 'pi was stopped', status: 200 }],
  ]
  for (const [result, answer, expected] of cases) assert.deepEqual(failureCause({ result, answer }), expected, JSON.stringify([result, answer]))

  // With OpenRouter's words when pi printed them.
  const stderr = '404 {"type":"error","error":{"message":"No endpoints found matching your data policy"}}\n'
  assert.deepEqual(failureCause({ result: failed(1, { stderr }), answer: { status: 404 } }), {
    cause: 'setup',
    reason: 'OpenRouter: No endpoints found matching your data policy',
    status: 404,
  })
  const tooLarge = '413: {"error":{"message":"Request body too large","code":413}}\n'
  assert.deepEqual(failureCause({ result: failed(1, { stderr: tooLarge }), answer: { status: 413 } }), {
    cause: 'other',
    reason: 'OpenRouter: Request body too large',
    status: 413,
  })
  // An unexpected file after a run that succeeded, whatever OpenRouter said.
  assert.deepEqual(failureCause({ result: failed(0), unexpected: 'views/.gitignore', answer: { status: 401 } }), {
    cause: 'other',
    reason: 'unexpected file views/.gitignore',
    status: 401,
  })
  // A sandbox that couldn't run pi at all.
  assert.deepEqual(failureCause({ result: { error: new Error('no QEMU') } }), { cause: 'setup', reason: "the VM couldn't start", status: null })
})

// ---------------------------------------------------------------------------------------------
// Pauses

test('failures: a setup error pauses runs, tried every 30 minutes; an outage after 1, 5 and 30 minutes, then every 30', () => {
  let paused = pauseAfter(undefined, { cause: 'setup', reason: 'OpenRouter answered 401', now: NOW })
  assert.deepEqual(paused, { since: '2026-11-09T15:51:00Z', cause: 'setup', reason: 'OpenRouter answered 401', next: '2026-11-09T16:21:00Z', tries: 1 })
  paused = pauseAfter(paused, { cause: 'setup', reason: 'OpenRouter answered 402', now: NOW + 30 * MINUTE })
  assert.deepEqual(paused, { since: '2026-11-09T15:51:00Z', cause: 'setup', reason: 'OpenRouter answered 402', next: '2026-11-09T16:51:00Z', tries: 2 })

  // An outage continues its own count; a change of cause starts a new pause.
  let outage = pauseAfter(paused, { cause: 'outage', reason: 'OpenRouter answered 503', now: NOW })
  const waits = []
  let now = NOW
  for (let n = 0; n < 5; n++) {
    waits.push((at(outage.next) - now) / MINUTE)
    assert.equal(outage.tries, n + 1)
    assert.equal(outage.since, '2026-11-09T15:51:00Z')
    now = at(outage.next)
    outage = pauseAfter(outage, { cause: 'outage', reason: 'OpenRouter answered 503', now })
  }
  assert.deepEqual(waits, [1, 5, 30, 30, 30])
})

// ---------------------------------------------------------------------------------------------
// The state after a run

const BATCH_LINES = [
  line.text(1, '2026-11-09T15:00:00Z', 'coffee 120'),
  line.text(2, '2026-11-09T15:01:00Z', 'lunch 300'),
  line.text(3, '2026-11-09T15:02:00Z', 'ran 5k'),
  line.sent(4, '2026-11-09T15:03:00Z', 'Noted.'),
  line.text(5, '2026-11-09T15:04:00Z', 'tea 40'),
]
const STATE = { ...initialAgentState(), cursor: 0 }
const batchOf = (items, covered = 5) => ({ items: items.map(([seq, origin, attempt]) => ({ seq, origin, attempt })), context: [4], covered, newest: items.at(-1)[0] })
const ok = (done, failed = {}) => ({ ok: true, done: new Set(done), failed: new Map(Object.entries(failed).map(([seq, reason]) => [Number(seq), reason])) })

test('state: after a success, done items go, FAILED ones go to failed, the rest wait a minute; the cursor covers the batch', () => {
  const batch = batchOf([[1, 'new', 1], [2, 'new', 1], [3, 'new', 1], [5, 'new', 1]])
  const { state, givenUp } = settleBatch(STATE, batch, ok([1, 5], { 2: 'unreadable photo' }), TIMING)
  assert.deepEqual(givenUp, [])
  assert.equal(state.cursor, 5)
  assert.deepEqual(state.retry, [{ seq: 3, attempts: 1, due: '2026-11-09T15:52:00Z', reason: 'not reported' }])
  assert.deepEqual(state.failed, [{ seq: 2, at: '2026-11-09T15:51:00Z', reason: 'unreadable photo' }])
  assert.deepEqual(state.lastRun, { at: '2026-11-09T15:50:10Z', ok: true, seqs: [1, 2, 3, 5], durationMs: 50000 })
})

test('state: an item not reported four times in a row is given up on', () => {
  let state = { ...STATE, cursor: 5, retry: [] }
  let attempt = 1
  let now = NOW
  const seen = []
  for (;;) {
    const batch = batchOf([[3, attempt === 1 ? 'new' : 'retry', attempt]])
    const settled = settleBatch(state, batch, ok([]), { ...TIMING, now })
    state = settled.state
    seen.push(state.retry.map(entry => [entry.attempts, (at(entry.due) - now) / MINUTE]))
    if (settled.givenUp.length > 0) {
      assert.deepEqual(settled.givenUp, [3])
      break
    }
    attempt = state.retry[0].attempts + 1
    now = at(state.retry[0].due)
  }
  // A minute between attempts; four attempts.
  assert.deepEqual(seen, [[[1, 1]], [[2, 1]], [[3, 1]], []])
  assert.deepEqual(state.failed, [{ seq: 3, at: '2026-11-09T15:54:00Z', reason: 'not handled after 4 attempts' }])
})

test('state: a failure of pi\'s own counts an attempt for every item; a setup error or an outage counts none and pauses', () => {
  const state = { ...STATE, cursor: 3, retry: [{ seq: 1, attempts: 2, due: '2026-11-09T15:40:00Z', reason: 'not reported' }], failed: [{ seq: 2, at: '2026-11-09T15:00:00Z', reason: 'x' }] }
  // #1 is a due retry; #2 was brought back from failed by an edit; #5 is new.
  const batch = batchOf([[1, 'retry', 3], [2, 'failed', 1], [5, 'new', 1]])

  const other = settleBatch(state, batch, { ok: false, cause: 'other', reason: 'pi exited with code 3' }, TIMING).state
  assert.equal(other.cursor, 5)
  assert.deepEqual(other.retry, [
    { seq: 1, attempts: 3, due: '2026-11-09T15:52:00Z', reason: 'pi exited with code 3' },
    { seq: 2, attempts: 1, due: '2026-11-09T15:52:00Z', reason: 'pi exited with code 3' },
    { seq: 5, attempts: 1, due: '2026-11-09T15:52:00Z', reason: 'pi exited with code 3' },
  ])
  assert.deepEqual(other.failed, [])
  assert.equal(other.lastRun.ok, false)
  assert.equal(other.paused, undefined)

  for (const cause of ['setup', 'outage']) {
    const paused = settleBatch(state, batch, { ok: false, cause, reason: 'OpenRouter answered 401' }, TIMING).state
    const next = cause === 'setup' ? '2026-11-09T16:21:00Z' : '2026-11-09T15:52:00Z'
    assert.deepEqual(paused.paused, { since: '2026-11-09T15:51:00Z', cause, reason: 'OpenRouter answered 401', next, tries: 1 })
    // Attempts as they were; the one from failed starts again at attempt 1, so it has used none.
    // Each is due at once, and the pause holds it back until the next try.
    assert.deepEqual(
      paused.retry.map(entry => [entry.seq, entry.attempts, entry.due]),
      [
        [1, 2, '2026-11-09T15:51:00Z'],
        [2, 0, '2026-11-09T15:51:00Z'],
        [5, 0, '2026-11-09T15:51:00Z'],
      ],
    )
    assert.deepEqual(paused.failed, [])
    assert.equal(paused.cursor, 5)
  }

  // A success, or a failure of pi's own, ends a pause.
  const wasPaused = { ...state, paused: pauseAfter(undefined, { cause: 'outage', reason: 'x', now: NOW }) }
  assert.equal(settleBatch(wasPaused, batch, ok([1, 2, 5]), TIMING).state.paused, undefined)
  assert.equal(settleBatch(wasPaused, batch, { ok: false, cause: 'other', reason: 'timed out' }, TIMING).state.paused, undefined)
  assert.equal(settleBatch(wasPaused, batch, { ok: false, cause: 'outage', reason: 'x' }, TIMING).state.paused.tries, 2)
})

test('state: failed keeps its newest FAILED_KEEP', t => {
  atEnd(t, overrideLimits({ FAILED_KEEP: 3 }))
  const state = { ...STATE, cursor: 3, failed: [10, 11, 12].map(seq => ({ seq, at: '2026-11-09T10:00:00Z', reason: 'old' })) }
  const { state: next } = settleBatch({ ...state, cursor: 20 }, batchOf([[13, 'new', 1], [14, 'new', 1]], 14), ok([], { 13: 'a', 14: 'b' }), TIMING)
  assert.deepEqual(
    next.failed.map(entry => entry.seq),
    [12, 13, 14],
  )
})

test('state: the first failure in a row is known from lastRun.ok', () => {
  assert.equal(isFirstFailure(initialAgentState()), true)
  assert.equal(isFirstFailure({ ...initialAgentState(), lastRun: { at: '2026-11-09T15:00:00Z', ok: true, seqs: [], durationMs: 1 } }), true)
  assert.equal(isFirstFailure({ ...initialAgentState(), lastRun: { at: '2026-11-09T15:00:00Z', ok: false, seqs: [], durationMs: 1 } }), false)
})

test('state: a task that fails on a setup error or an outage stays due; otherwise it is done for its date', () => {
  const state = { ...STATE, scheduled: { '21:30': '2026-11-08' } }
  const scheduled = { kind: 'scheduled', at: '21:30', date: '2026-11-09' }
  assert.deepEqual(settleTask(state, scheduled, { ok: true }, TIMING).scheduled, { '21:30': '2026-11-09' })
  assert.deepEqual(settleTask(state, scheduled, { ok: false, cause: 'other', reason: 'timed out' }, TIMING).scheduled, { '21:30': '2026-11-09' })
  const outage = settleTask(state, scheduled, { ok: false, cause: 'outage', reason: 'x' }, TIMING)
  assert.deepEqual(outage.scheduled, { '21:30': '2026-11-08' })
  assert.equal(outage.paused.cause, 'outage')
  assert.deepEqual(outage.lastRun, { at: '2026-11-09T15:50:10Z', ok: false, seqs: [], durationMs: 50000 })

  const once = { kind: 'once', id: 'poems' }
  assert.deepEqual(settleTask(state, once, { ok: true }, TIMING).onceDone, ['poems'])
  assert.deepEqual(settleTask(state, once, { ok: false, cause: 'other', reason: 'timed out' }, TIMING).onceDone, [])
  assert.deepEqual(settleTask(state, once, { ok: false, cause: 'setup', reason: 'x' }, TIMING).onceDone, [])
  // The cursor is the messages', and a task leaves it.
  assert.equal(settleTask({ ...state, cursor: 7 }, once, { ok: true }, TIMING).cursor, 7)
})

// ---------------------------------------------------------------------------------------------
// Notices

test('notices: the first failure, with its short reason', () => {
  const text = (job, failure) => failureNotice(job, failure).text
  assert.deepEqual(failureNotice({ kind: 'messages' }, { cause: 'other', reason: 'timed out' }), {
    type: 'text',
    by: 'runner',
    text: "⚠️ I couldn't process your last messages (timed out). I'll try again.",
  })
  assert.equal(
    text({ kind: 'messages' }, { cause: 'setup', reason: 'OpenRouter: No endpoints found matching your data policy' }),
    "⚠️ I couldn't process your last messages (OpenRouter: No endpoints found matching your data policy). Runs are paused until this is fixed. I'll try again every 30 minutes.",
  )
  assert.equal(text({ kind: 'messages' }, { cause: 'outage', reason: 'OpenRouter answered 503' }), "⚠️ I couldn't process your last messages (OpenRouter answered 503). I'll try again.")
  assert.equal(text({ kind: 'scheduled', at: '21:30' }, { cause: 'other', reason: 'timed out' }), "⚠️ I couldn't run the scheduled task 21:30 (timed out). It runs again at its next time.")
  assert.equal(text({ kind: 'scheduled', at: '21:30' }, { cause: 'outage', reason: 'x' }), "⚠️ I couldn't run the scheduled task 21:30 (x). I'll try again.")
  assert.equal(text({ kind: 'once', id: 'poems' }, { cause: 'other', reason: 'pi exited with code 1' }), "⚠️ I couldn't run the task poems (pi exited with code 1). I'll try it again when I next start.")
})

test('notices: items given up on, each named by what it says now', t => {
  atEnd(t, overrideLimits({ NOTICE_QUOTE_CHARS: 14 }))
  const index = indexOf([
    line.text(1, '2026-11-09T15:00:00Z', 'coffee 120'),
    line.edit(2, '2026-11-09T15:01:00Z', 1, 'coffee  \n 150'),
    line.text(3, '2026-11-09T15:02:00Z', '', { files: [{ path: '3.jpg', mime: 'image/jpeg', bytes: 1 }] }),
    line.text(4, '2026-11-09T15:03:00Z', '', { files: [{ path: '4.pdf', mime: 'application/pdf', bytes: 1 }] }),
    line.text(5, '2026-11-09T15:04:00Z', '', { media: { type: 'audio', mime: 'audio/ogg', error: 'download failed' } }),
    line.email(6, '2026-11-09T15:05:00Z', 'Call with Sam', 'text'),
    line.text(7, '2026-11-09T15:06:00Z', 'a long message that goes on'),
    line.text(8, '2026-11-09T15:07:00Z', 'oops'),
    line.delete(9, '2026-11-09T15:08:00Z', 8),
  ])
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map(seq => describeItem(index, seq)),
    ['"coffee 150"', 'an edit of #1', 'a photo', 'a document', 'an audio file', 'email "Call with Sam"', '"a long messag…"', 'deleted since', 'a deletion of #8'],
  )
  assert.deepEqual(givenUpNotice(index, [1]), {
    type: 'text',
    by: 'runner',
    text: '⚠️ I gave up on #1 ("coffee 150") after 4 attempts. Send it again if it matters.',
  })
  assert.equal(givenUpNotice(index, [1, 3, 6]).text, '⚠️ I gave up on #1 ("coffee 150"), #3 (a photo) and #6 (email "Call with Sam") after 4 attempts. Send them again if they matter.')
})
