// An agent's state: its format, reading and writing it, and the changes that
// planning makes to it: sessions and startup.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { AgentStateError, checkAgentState, initialAgentState, readAgentState } from '../src/common/agentstate.mjs'
import { loadState, saveState, sessionDay, sessionId, startupState } from '../src/runner/state.mjs'
import { makeTestDir } from './support/tmp.mjs'

const at = Date.parse
const modeOf = file => fs.statSync(file).mode & 0o7777

// An example state, with a pause.
const EXAMPLE = {
  cursor: 1049,
  retry: [{ seq: 1047, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'not marked' }],
  failed: [{ seq: 1031, at: '2026-11-09T12:32:11Z', reason: 'unreadable PDF' }],
  scheduled: { '21:30': '2026-11-09' },
  lastRun: { at: '2026-11-09T15:50:15Z', ok: true, seqs: [1050, 1051, 1053], durationMs: 48211 },
  paused: { since: '2026-11-09T15:50:15Z', cause: 'setup', reason: 'OpenRouter answered 401', next: '2026-11-09T16:20:15Z', tries: 1 },
}

// An agent's config, with only what these functions read.
function agentWith({ scheduled = [] } = {}) {
  return { name: 'lifelog', run: { newMessages: [{ channels: ['whatsapp'] }], scheduled } }
}

test('state: an example state, and the state of an agent that has never run, are well formed', () => {
  assert.deepEqual(checkAgentState(EXAMPLE), [])
  assert.deepEqual(checkAgentState(initialAgentState()), [])
  assert.deepEqual(initialAgentState(), {
    cursor: 0,
    retry: [],
    failed: [],
    scheduled: {},
    lastRun: null,
  })
})

test('state: each fault names its field', () => {
  const cases = [
    [{ cursor: -1 }, 'cursor must be a whole number, 0 or more'],
    [{ retry: {} }, 'retry must be a list'],
    [{ retry: [{ seq: 1047, attempts: 1, due: 'soon', reason: 'x' }] }, 'retry[0].due must be a UTC time to the second'],
    [{ retry: [{ seq: 1047, attempts: 1, due: '2026-11-09T15:51:00Z' }] }, 'retry[0].reason is missing'],
    [{ retry: [{ seq: 0, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'x' }] }, 'retry[0].seq must be a seq'],
    [{ retry: [EXAMPLE.retry[0], EXAMPLE.retry[0]] }, 'retry holds a seq twice'],
    // Everything in a retry list has been given to the agent, so it is at or before the cursor.
    [{ retry: [{ ...EXAMPLE.retry[0], seq: 1050 }] }, 'retry[0].seq is after the cursor'],
    [{ failed: [{ seq: 1031, at: '2026-11-09T12:32:11Z', reason: '' }] }, "failed[0].reason must be a string that isn't empty"],
    // The fields of the commands and of `/new`, which are gone.
    [{ commandSeq: 1038 }, 'commandSeq is not a field of the state'],
    [{ session: { day: '2026-11-09', bump: 0 } }, 'session is not a field of the state'],
    // The fields of the backfill trigger, which is gone: a job of `scooter backfill` keeps its own
    // lane in its file.
    [{ backfill: { id: 'people-1', until: 1890, cursor: 812, retry: [], skipped: [] } }, 'backfill is not a field of the state'],
    [{ backfillDone: [] }, 'backfillDone is not a field of the state'],
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

test('state: the session ID is the agent and the session\'s day', () => {
  const options = { timeZone: 'Asia/Kolkata', rolloverHour: 4 }
  assert.equal(sessionId('lifelog', { ...options, now: at('2026-11-09T15:50:00Z') }), 'lifelog-2026-11-09')
  // 03:59 in Kolkata on the 10th is still the 9th's session; 04:00 is the 10th's.
  assert.equal(sessionId('lifelog', { ...options, now: at('2026-11-09T22:29:59Z') }), 'lifelog-2026-11-09')
  assert.equal(sessionId('lifelog', { ...options, now: at('2026-11-09T22:30:00Z') }), 'lifelog-2026-11-10')
})

test('state: at startup, scheduled tasks already past wait for their next time, and the rest is set up', () => {
  const agent = agentWith({
    scheduled: [
      { at: '21:30', tag: 'check-in', schedule: { weekday: null, hour: 21, minute: 30 }, prompt: 'Check in.' },
      { at: 'Sun 18:00', tag: 'weekly', schedule: { weekday: 7, hour: 18, minute: 0 }, prompt: 'Weekly.' },
    ],
  })
  const before = { ...initialAgentState(), scheduled: { '21:30': '2026-11-01', '07:00': '2026-11-08' } }
  // Monday 9 November, 21:31 in Kolkata: today's 21:30 has passed, and Sunday's 18:00 was yesterday.
  const state = startupState(before, agent, { now: at('2026-11-09T16:01:00Z'), timeZone: 'Asia/Kolkata' })
  assert.deepEqual(state.scheduled, { '21:30': '2026-11-09', 'Sun 18:00': '2026-11-08' })
  // A minute earlier, today's 21:30 is still to come.
  const early = startupState(before, agent, { now: at('2026-11-09T15:59:00Z'), timeZone: 'Asia/Kolkata' })
  assert.equal(early.scheduled['21:30'], '2026-11-08')
})

test('state: at startup, a pause is tried again at once', () => {
  const state = startupState({ ...initialAgentState(), paused: EXAMPLE.paused }, agentWith(), { now: at('2026-11-09T15:55:00Z'), timeZone: 'UTC' })
  assert.deepEqual(state.paused, { ...EXAMPLE.paused, next: '2026-11-09T15:55:00Z' })
})

test('state: at startup during a pause, scheduled tasks keep their dates, so one the pause holds back is still due', () => {
  const agent = agentWith({
    scheduled: [
      { at: '21:30', tag: 'check-in', schedule: { weekday: null, hour: 21, minute: 30 }, prompt: 'Check in.' },
      { at: '07:00', tag: 'morning', schedule: { weekday: null, hour: 7, minute: 0 }, prompt: 'Morning.' },
    ],
  })
  const before = { ...initialAgentState(), scheduled: { '21:30': '2026-11-08' }, paused: EXAMPLE.paused }
  // Monday 9 November, 21:31 in Kolkata: today's 21:30 failed on a setup error, and is still due.
  // A task new in the config starts from now, as always.
  const state = startupState(before, agent, { now: at('2026-11-09T16:01:00Z'), timeZone: 'Asia/Kolkata' })
  assert.deepEqual(state.scheduled, { '21:30': '2026-11-08', '07:00': '2026-11-09' })
  const { paused, ...unpaused } = before
  assert.equal(startupState(unpaused, agent, { now: at('2026-11-09T16:01:00Z'), timeZone: 'Asia/Kolkata' }).scheduled['21:30'], '2026-11-09')
})

