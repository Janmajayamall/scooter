// An agent's state: its format, reading and writing it, and the changes that
// planning makes to it: sessions, commands and startup.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { AgentStateError, checkAgentState, initialAgentState, readAgentState } from '../src/common/agentstate.mjs'
import { applyCommands, currentSession, loadState, saveState, sessionDay, sessionId, startupState } from '../src/runner/state.mjs'
import { line } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const at = Date.parse
const modeOf = file => fs.statSync(file).mode & 0o7777

// The example of 6.3, with a pause.
const EXAMPLE = {
  cursor: 1049,
  commandSeq: 1038,
  retry: [{ seq: 1047, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'not reported' }],
  failed: [{ seq: 1031, at: '2026-11-09T12:32:11Z', reason: 'unreadable PDF' }],
  session: { day: '2026-11-09', bump: 0 },
  onceDone: ['poems'],
  backfill: { id: 'people-1', until: 1890, cursor: 812, retry: [], skipped: [1031] },
  backfillDone: [],
  scheduled: { '21:30': '2026-11-09' },
  lastRun: { at: '2026-11-09T15:50:15Z', ok: true, seqs: [1050, 1051, 1053], durationMs: 48211 },
  paused: { since: '2026-11-09T15:50:15Z', cause: 'setup', reason: 'OpenRouter answered 401', next: '2026-11-09T16:20:15Z', tries: 1 },
}

// An agent's config, with only what these functions read.
function agentWith({ scheduled = [], backfill = [] } = {}) {
  return { name: 'lifelog', run: { newMessages: true, scheduled, once: [], backfill } }
}

test('state: the example of 6.3, and the state of an agent that has never run, are well formed', () => {
  assert.deepEqual(checkAgentState(EXAMPLE), [])
  assert.deepEqual(checkAgentState(initialAgentState()), [])
  assert.deepEqual(initialAgentState(), {
    cursor: 0,
    commandSeq: 0,
    retry: [],
    failed: [],
    session: null,
    onceDone: [],
    backfillDone: [],
    scheduled: {},
    lastRun: null,
  })
})

test('state: each fault names its field', () => {
  const cases = [
    [{ cursor: -1 }, 'cursor must be a whole number, 0 or more'],
    [{ commandSeq: '1038' }, 'commandSeq must be a whole number, 0 or more'],
    [{ retry: {} }, 'retry must be a list'],
    [{ retry: [{ seq: 1047, attempts: 1, due: 'soon', reason: 'x' }] }, 'retry[0].due must be a UTC time to the second'],
    [{ retry: [{ seq: 1047, attempts: 1, due: '2026-11-09T15:51:00Z' }] }, 'retry[0].reason is missing'],
    [{ retry: [{ seq: 0, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'x' }] }, 'retry[0].seq must be a seq'],
    [{ retry: [EXAMPLE.retry[0], EXAMPLE.retry[0]] }, 'retry holds a seq twice'],
    // Everything in a retry list has been given to the agent, so it is at or before the cursor.
    [{ retry: [{ ...EXAMPLE.retry[0], seq: 1050 }] }, 'retry[0].seq is after the cursor'],
    [{ backfill: { ...EXAMPLE.backfill, retry: [{ ...EXAMPLE.retry[0], seq: 813 }] } }, 'backfill.retry[0].seq is after the cursor'],
    [{ failed: [{ seq: 1031, at: '2026-11-09T12:32:11Z', reason: '' }] }, "failed[0].reason must be a string that isn't empty"],
    [{ session: { day: '2026-02-30', bump: 0 } }, 'session.day must be a date such as 2026-11-09'],
    [{ session: { day: '2026-11-09', bump: -1 } }, 'session.bump must be a whole number, 0 or more'],
    [{ onceDone: [''] }, "onceDone[0] must be a string that isn't empty"],
    [{ backfill: { ...EXAMPLE.backfill, skipped: [1031, 1031] } }, 'backfill.skipped holds a seq twice'],
    [{ backfill: { ...EXAMPLE.backfill, cursor: undefined } }, 'backfill.cursor is missing'],
    [{ scheduled: { '21:30': 'today' } }, 'scheduled.21:30 must be a date such as 2026-11-09'],
    [{ lastRun: { ...EXAMPLE.lastRun, ok: 'yes' } }, 'lastRun.ok must be true or false'],
    [{ paused: { ...EXAMPLE.paused, cause: 'storm' } }, 'paused.cause must be one of setup, outage'],
    [{ paused: { ...EXAMPLE.paused, tries: 0 } }, 'paused.tries must be a whole number, 1 or more'],
    [{ paused: { ...EXAMPLE.paused, extra: 1 } }, 'paused.extra is not a field of the state'],
    [{ surprise: true }, 'surprise is not a field of the state'],
    [{ lastRun: undefined }, 'lastRun is missing'],
  ]
  for (const [changes, problem] of cases) {
    const state = JSON.parse(JSON.stringify({ ...EXAMPLE, ...changes }))
    assert.ok(checkAgentState(state).includes(problem), `${problem}: ${JSON.stringify(checkAgentState(state))}`)
  }
  assert.deepEqual(checkAgentState([]), ['the state must be an object'])
})

test('state: written atomically with mode 0600, and read back; a damaged file names itself', t => {
  const dir = path.join(makeTestDir(t), 'agent')
  fs.mkdirSync(dir)
  const file = path.join(dir, 'state.json')
  assert.deepEqual(loadState(file), initialAgentState())
  assert.equal(readAgentState(file), null)

  saveState(file, EXAMPLE)
  assert.equal(modeOf(file), 0o600)
  assert.deepEqual(loadState(file), EXAMPLE)
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])

  // A state that isn't one is never written.
  assert.throws(() => saveState(file, { ...EXAMPLE, cursor: -1 }), /not an agent state: cursor must be a whole number/)
  assert.deepEqual(loadState(file), EXAMPLE)

  fs.writeFileSync(file, '{"cursor":')
  assert.throws(() => loadState(file), error => error instanceof AgentStateError && error.message === `${file} is not JSON`)
  fs.writeFileSync(file, JSON.stringify({ ...EXAMPLE, cursor: 'x' }))
  assert.throws(() => loadState(file), error => error instanceof AgentStateError && error.message === `${file}: cursor must be a whole number, 0 or more`)
})

test('state: the session\'s day changes at the rollover hour of the local clock, also on a day clocks change', () => {
  const kolkata = 'Asia/Kolkata'
  // 03:59 in Kolkata belongs to the day before; 04:00 to its own.
  assert.equal(sessionDay(at('2026-11-09T22:29:00Z'), kolkata, 4), '2026-11-09')
  assert.equal(sessionDay(at('2026-11-09T22:30:00Z'), kolkata, 4), '2026-11-10')
  assert.equal(sessionDay(at('2026-11-09T18:29:00Z'), kolkata, 0), '2026-11-09')
  assert.equal(sessionDay(at('2026-11-09T18:30:00Z'), kolkata, 0), '2026-11-10')
  // New York goes from 02:00 to 03:00 on 8 March 2026. The day still changes at 04:00 by the
  // clock: 03:30 is the day before, though only two and a half hours have passed since midnight.
  const york = 'America/New_York'
  assert.equal(sessionDay(at('2026-03-08T07:30:00Z'), york, 4), '2026-03-07') // 03:30 EDT
  assert.equal(sessionDay(at('2026-03-08T08:00:00Z'), york, 4), '2026-03-08') // 04:00 EDT
  // And back from 02:00 to 01:00 on 1 November 2026: 04:00 comes once.
  assert.equal(sessionDay(at('2026-11-01T08:59:00Z'), york, 4), '2026-10-31') // 03:59 EST
  assert.equal(sessionDay(at('2026-11-01T09:00:00Z'), york, 4), '2026-11-01') // 04:00 EST
  // Across a month and a year.
  assert.equal(sessionDay(at('2027-01-01T01:00:00Z'), 'UTC', 4), '2026-12-31')
})

test('state: the session ID is the agent and the day, with the number of /new commands that day', () => {
  const options = { now: at('2026-11-09T15:50:00Z'), timeZone: 'Asia/Kolkata', rolloverHour: 4 }
  assert.deepEqual(currentSession(initialAgentState(), options), { day: '2026-11-09', bump: 0 })
  assert.deepEqual(currentSession({ ...initialAgentState(), session: { day: '2026-11-09', bump: 2 } }, options), { day: '2026-11-09', bump: 2 })
  // A /new of another day counts for nothing today.
  assert.deepEqual(currentSession({ ...initialAgentState(), session: { day: '2026-11-08', bump: 2 } }, options), { day: '2026-11-09', bump: 0 })
  assert.equal(sessionId('lifelog', { day: '2026-11-09', bump: 0 }), 'lifelog-2026-11-09')
  assert.equal(sessionId('lifelog', { day: '2026-11-09', bump: 2 }), 'lifelog-2026-11-09-2')
})

test('state: /new starts a fresh session and is answered about itself; the bridge\'s commands are passed over', () => {
  const options = { now: at('2026-11-09T15:50:00Z'), timeZone: 'Asia/Kolkata', rolloverHour: 4 }
  const lines = [line.command(1060, '2026-11-09T15:49:00Z', '/status'), line.command(1062, '2026-11-09T15:49:30Z', '/new')]
  const { state, replies } = applyCommands(initialAgentState(), lines, options)
  assert.equal(state.commandSeq, 1062)
  assert.deepEqual(state.session, { day: '2026-11-09', bump: 1 })
  assert.deepEqual(replies, [{ type: 'text', by: 'runner', text: 'Started a fresh conversation.', about: 1062 }])

  // A second /new the same day starts another; one the next day starts the first of that day.
  const second = applyCommands(state, [line.command(1070, '2026-11-09T16:00:00Z', '/new')], options)
  assert.deepEqual(second.state.session, { day: '2026-11-09', bump: 2 })
  const nextDay = applyCommands(second.state, [line.command(1080, '2026-11-10T03:00:00Z', '/new')], { ...options, now: at('2026-11-10T03:00:00Z') })
  assert.deepEqual(nextDay.state.session, { day: '2026-11-10', bump: 1 })

  // A command already handled isn't handled again.
  const again = applyCommands(state, lines, options)
  assert.deepEqual(again.replies, [])
  assert.equal(again.state, state)
  // Only the bridge's: `commandSeq` moves, and nothing is said.
  const bridgeOnly = applyCommands(initialAgentState(), [line.command(5, '2026-11-09T15:49:00Z', '/help')], options)
  assert.deepEqual([bridgeOnly.state.commandSeq, bridgeOnly.state.session, bridgeOnly.replies], [5, null, []])
})

test('state: a /new counts for the session of the day it was sent, also when it is handled after the rollover', () => {
  const options = { timeZone: 'Asia/Kolkata', rolloverHour: 4 }
  // Sent at 03:50 on the 10th, Kolkata time, which is still the 9th's session; handled at 04:10,
  // after a runner that was down came back.
  const sent = line.command(1090, '2026-11-09T22:20:00Z', '/new')
  const late = applyCommands(initialAgentState(), [sent], { ...options, now: at('2026-11-09T22:40:00Z') })
  assert.deepEqual(late.state.session, { day: '2026-11-09', bump: 1 })
  // So the 10th's session starts as usual.
  assert.deepEqual(currentSession(late.state, { ...options, now: at('2026-11-09T22:40:00Z'), rolloverHour: 4 }), { day: '2026-11-10', bump: 0 })
  // A time from the channel later than now counts as now.
  const future = applyCommands(initialAgentState(), [line.command(1091, '2026-11-12T10:00:00Z', '/new')], { ...options, now: at('2026-11-09T15:50:00Z') })
  assert.deepEqual(future.state.session, { day: '2026-11-09', bump: 1 })
})

test('state: at startup, scheduled tasks already past wait for their next time, and the rest is set up', () => {
  const agent = agentWith({
    scheduled: [
      { at: '21:30', schedule: { weekday: null, hour: 21, minute: 30 }, task: 'Check in.' },
      { at: 'Sun 18:00', schedule: { weekday: 7, hour: 18, minute: 0 }, task: 'Weekly.' },
    ],
  })
  const before = { ...initialAgentState(), scheduled: { '21:30': '2026-11-01', '07:00': '2026-11-08' } }
  // Monday 9 November, 21:31 in Kolkata: today's 21:30 has passed, and Sunday's 18:00 was yesterday.
  const { state } = startupState(before, agent, { now: at('2026-11-09T16:01:00Z'), timeZone: 'Asia/Kolkata' })
  assert.deepEqual(state.scheduled, { '21:30': '2026-11-09', 'Sun 18:00': '2026-11-08' })
  // A minute earlier, today's 21:30 is still to come.
  const early = startupState(before, agent, { now: at('2026-11-09T15:59:00Z'), timeZone: 'Asia/Kolkata' })
  assert.equal(early.state.scheduled['21:30'], '2026-11-08')
})

test('state: at startup, a pause is tried again at once', () => {
  const { state } = startupState({ ...initialAgentState(), paused: EXAMPLE.paused }, agentWith(), { now: at('2026-11-09T15:55:00Z'), timeZone: 'UTC' })
  assert.deepEqual(state.paused, { ...EXAMPLE.paused, next: '2026-11-09T15:55:00Z' })
})

test('state: at startup during a pause, scheduled tasks keep their dates, so one the pause holds back is still due', () => {
  const agent = agentWith({
    scheduled: [
      { at: '21:30', schedule: { weekday: null, hour: 21, minute: 30 }, task: 'Check in.' },
      { at: '07:00', schedule: { weekday: null, hour: 7, minute: 0 }, task: 'Morning.' },
    ],
  })
  const before = { ...initialAgentState(), scheduled: { '21:30': '2026-11-08' }, paused: EXAMPLE.paused }
  // Monday 9 November, 21:31 in Kolkata: today's 21:30 failed on a setup error, and is still due.
  // A task new in the config starts from now, as always.
  const { state } = startupState(before, agent, { now: at('2026-11-09T16:01:00Z'), timeZone: 'Asia/Kolkata' })
  assert.deepEqual(state.scheduled, { '21:30': '2026-11-08', '07:00': '2026-11-09' })
  const { paused, ...unpaused } = before
  assert.equal(startupState(unpaused, agent, { now: at('2026-11-09T16:01:00Z'), timeZone: 'Asia/Kolkata' }).state.scheduled['21:30'], '2026-11-09')
})

test('state: at startup, the first backfill not done starts from the live cursor, and one removed from the config is dropped', () => {
  const options = { now: at('2026-11-09T15:55:00Z'), timeZone: 'UTC' }
  const entries = [
    { id: 'people-1', skill: 'people', writes: ['views/people.csv'] },
    { id: 'runs-1', skill: 'runs', writes: ['views/runs.csv'] },
  ]
  const fresh = { ...initialAgentState(), cursor: 1890, backfillDone: ['people-1'] }
  const started = startupState(fresh, agentWith({ backfill: entries }), options)
  assert.deepEqual([started.started, started.dropped], ['runs-1', null])
  assert.deepEqual(started.state.backfill, { id: 'runs-1', until: 1890, cursor: 0, retry: [], skipped: [] })

  // One in progress goes on, from where it was.
  const going = { ...started.state, cursor: 1950, backfill: { ...started.state.backfill, cursor: 812 } }
  const restarted = startupState(going, agentWith({ backfill: entries }), options)
  assert.deepEqual([restarted.started, restarted.dropped, restarted.state.backfill.cursor, restarted.state.backfill.until], [null, null, 812, 1890])

  // Its entry removed from the config, it is dropped, and the next one not done starts.
  const removed = startupState(going, agentWith({ backfill: [entries[0]] }), options)
  assert.deepEqual([removed.started, removed.dropped, removed.state.backfill], [null, 'runs-1', undefined])
  assert.equal(Object.hasOwn(removed.state, 'backfill'), false)
  assert.deepEqual(checkAgentState(removed.state), [])
})
