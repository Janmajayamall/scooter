// What the agent does next: nothing while
// paused, new messages after the quiet period, scheduled tasks at the right local time, and a
// backfill batch only when nothing live is waiting.

import assert from 'node:assert/strict'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { parseLocalTime } from '../src/common/time.mjs'
import { startupState } from '../src/runner/state.mjs'
import { dueScheduled, isToGive, isWorkItem, nextAction } from '../src/runner/triggers.mjs'
import { indexOf, line } from './support/runner.mjs'

const at = Date.parse
const SECOND = 1000
const MINUTE = 60 * SECOND

// An agent whose one trigger for new messages names `channels`, or with none when they are none;
// with a scheduled trigger for each `[at, prompt, tag]` of `scheduled`.
function agentWith({ scheduled = [], backfill = [], channels = ['whatsapp', 'email'] } = {}) {
  return {
    name: 'lifelog',
    channels,
    run: {
      newMessages: channels.length > 0 ? [{ channels }] : [],
      scheduled: scheduled.map(([time, prompt, tag = 'task']) => ({ at: time, tag, schedule: parseLocalTime(time), prompt })),
      backfill: backfill.map(id => ({ id, skill: 'people', writes: ['agents/lifelog/views/people.csv'] })),
    },
  }
}

// Asks for the next action at `now`, with the owner last heard from `seenAgo` before it.
function ask({ agent = agentWith(), state = initialAgentState(), lines = [], now = '2026-11-09T15:50:30Z', seenAgo = 60 * SECOND, timeZone = 'Asia/Kolkata' } = {}) {
  const time = typeof now === 'string' ? at(now) : now
  return nextAction({
    agent,
    state,
    index: indexOf(lines),
    now: time,
    timeZone,
    batchSeconds: 8,
    incomingSeenAt: seenAgo === null ? null : time - seenAgo,
  })
}

const HANDLED = { ...initialAgentState(), cursor: 3 }
const EARLIER = [line.text(1, '2026-11-09T15:00:00Z', 'coffee 120'), line.sent(2, '2026-11-09T15:00:10Z', 'Which café?'), line.text(3, '2026-11-09T15:01:00Z', 'Blue Tokai')]

test('triggers: what is a work item', () => {
  const channels = ['whatsapp']
  assert.equal(isWorkItem(line.text(1, '2026-11-09T15:00:00Z', 'x'), channels), true)
  assert.equal(isWorkItem(line.edit(2, '2026-11-09T15:00:00Z', 1, 'y'), channels), true)
  assert.equal(isWorkItem(line.delete(3, '2026-11-09T15:00:00Z', 1), channels), true)
  // Context, or skipped.
  assert.equal(isWorkItem(line.sent(4, '2026-11-09T15:00:00Z', 'x'), channels), false)
  assert.equal(isWorkItem(line.reaction(5, '2026-11-09T15:00:00Z', 1, '👍'), channels), false)
  // A text such as /new is a message like any other.
  assert.equal(isWorkItem(line.text(6, '2026-11-09T15:00:00Z', '/new'), channels), true)
  // A channel no trigger of the agent's names.
  assert.equal(isWorkItem(line.email(7, '2026-11-09T15:00:00Z', 'Hi', 'x'), channels), false)
  assert.equal(isWorkItem(line.email(7, '2026-11-09T15:00:00Z', 'Hi', 'x'), ['email']), true)
  // A line this version doesn't know: a kind or a channel it doesn't have, or without a field its
  // kind needs. Channels naming such a channel change nothing.
  const base = { dir: 'in', at: '2026-11-09T15:00:00Z', trust: 'owner' }
  assert.equal(isWorkItem({ seq: 8, kind: 'command', ...base, source: 'whatsapp', text: '/status' }, channels), false)
  assert.equal(isWorkItem({ seq: 9, kind: 'message', ...base, source: 'telegram', text: 'hi' }, ['telegram']), false)
  assert.equal(isWorkItem({ seq: 10, kind: 'message', ...base, source: 'whatsapp' }, channels), false)
  assert.equal(isWorkItem({ seq: 11, kind: 'edit', ...base, source: 'whatsapp', text: 'y' }, channels), false)
  assert.equal(isWorkItem({ seq: 12, kind: 'delete', ...base, source: 'whatsapp' }, channels), false)
})

test('triggers: a line this version doesn\'t know starts no batch, and a retry of one is never due', () => {
  const base = { dir: 'in', at: '2026-11-09T15:50:00Z', trust: 'owner' }
  const lines = [
    ...EARLIER,
    { seq: 4, kind: 'command', ...base, source: 'whatsapp', sourceId: 'C4', text: '/status' },
    { seq: 5, kind: 'message', ...base, source: 'telegram', sourceId: 'T5', text: 'hi' },
    { seq: 6, kind: 'message', ...base, source: 'whatsapp', sourceId: 'W6' },
  ]
  assert.deepEqual(ask({ state: HANDLED, lines }), { kind: 'idle', reason: 'nothing' })
  const retry = [4, 5, 6].map(seq => ({ seq, attempts: 1, due: '2026-11-09T15:00:00Z', reason: 'x' }))
  assert.deepEqual(ask({ state: { ...HANDLED, cursor: 6, retry }, lines }), { kind: 'idle', reason: 'nothing' })
})

test('triggers: new messages wait until the owner has been quiet for BATCH_SECONDS', () => {
  const lines = [...EARLIER, line.text(4, '2026-11-09T15:50:00Z', 'lunch 300')]
  assert.deepEqual(ask({ state: HANDLED, lines, seenAgo: 7999 }), { kind: 'idle', reason: 'quiet' })
  assert.deepEqual(ask({ state: HANDLED, lines, seenAgo: 8000 }), { kind: 'messages' })
  // Before the runner has seen anything come in, there is nothing to wait for.
  assert.deepEqual(ask({ state: HANDLED, lines, seenAgo: null }), { kind: 'messages' })
  // Only the cursor's side counts: everything here is dealt with.
  assert.deepEqual(ask({ state: { ...HANDLED, cursor: 4 }, lines }), { kind: 'idle', reason: 'nothing' })
  // Lines that aren't work don't start a batch: what Scooter sent, a reaction, and channels no trigger names.
  const other = [...EARLIER, line.sent(4, '2026-11-09T15:50:00Z', 'Noted.'), line.reaction(5, '2026-11-09T15:50:00Z', 3, '👍'), line.email(6, '2026-11-09T15:50:00Z', 'Hi', 'x')]
  assert.deepEqual(ask({ agent: agentWith({ channels: ['whatsapp'] }), state: HANDLED, lines: other }), { kind: 'idle', reason: 'nothing' })
  assert.deepEqual(ask({ agent: agentWith({ channels: ['email'] }), state: HANDLED, lines: other }), { kind: 'messages' })
  // Without a trigger `on: new-messages`, no channel's lines are work.
  assert.deepEqual(ask({ agent: agentWith({ channels: [] }), state: HANDLED, lines }), { kind: 'idle', reason: 'nothing' })
})

test("triggers: the channels of every trigger for new messages are the agent's work, whichever trigger names them", () => {
  const lines = [...EARLIER, line.email(4, '2026-11-09T15:50:00Z', 'Hi', 'x'), line.text(5, '2026-11-09T15:50:00Z', 'lunch')]
  const agent = { ...agentWith(), run: { ...agentWith().run, newMessages: [{ channels: ['email'] }, { channels: ['whatsapp'] }] } }
  assert.deepEqual(ask({ agent, state: HANDLED, lines }), { kind: 'messages' })
  assert.deepEqual(ask({ agent, state: { ...HANDLED, cursor: 4 }, lines }), { kind: 'messages' })
  assert.deepEqual(ask({ agent, state: { ...HANDLED, cursor: 5 }, lines }), { kind: 'idle', reason: 'nothing' })
})

test('triggers: retries start a batch when they are due', () => {
  const retry = due => [{ seq: 3, attempts: 1, due, reason: 'not marked' }]
  assert.deepEqual(ask({ state: { ...HANDLED, retry: retry('2026-11-09T15:51:00Z') }, lines: EARLIER }), { kind: 'idle', reason: 'nothing' })
  assert.deepEqual(ask({ state: { ...HANDLED, retry: retry('2026-11-09T15:50:30Z') }, lines: EARLIER }), { kind: 'messages' })
  // The quiet period holds them back too.
  assert.deepEqual(ask({ state: { ...HANDLED, retry: retry('2026-11-09T15:50:30Z') }, lines: EARLIER, seenAgo: SECOND }), { kind: 'idle', reason: 'quiet' })
  // One whose line isn't a work item of this agent would start runs with nothing in them.
  const stale = [{ seq: 2, attempts: 1, due: '2026-11-09T15:00:00Z', reason: 'x' }, { seq: 99, attempts: 1, due: '2026-11-09T15:00:00Z', reason: 'x' }]
  assert.deepEqual(ask({ state: { ...HANDLED, retry: stale }, lines: EARLIER }), { kind: 'idle', reason: 'nothing' })
})

test('triggers: a message already deleted is no work to give, and starts no run; its deletion is', () => {
  const deleted = [...EARLIER, line.delete(4, '2026-11-09T15:50:00Z', 3)]
  // #3 deleted, waiting to be tried again and due, with its deletion dealt with: nothing to do.
  const retry = [{ seq: 3, attempts: 1, due: '2026-11-09T15:00:00Z', reason: 'not marked' }]
  assert.deepEqual(ask({ state: { ...HANDLED, cursor: 4, retry }, lines: deleted }), { kind: 'idle', reason: 'nothing' })
  // Its deletion, after the cursor, is work.
  assert.deepEqual(ask({ state: { ...HANDLED, retry }, lines: deleted }), { kind: 'messages' })
  // A message deleted before it was given: only its deletion is work.
  assert.deepEqual(ask({ state: { ...initialAgentState(), cursor: 2 }, lines: deleted }), { kind: 'messages' })
  assert.deepEqual(isToGive(indexOf(deleted), 3, ['whatsapp']), false)
  assert.deepEqual(isToGive(indexOf(deleted), 4, ['whatsapp']), true)
  assert.deepEqual(isToGive(indexOf(deleted), 1, ['whatsapp']), true)
})

test('triggers: a pause holds everything back until its next try, a text such as /status among the messages', () => {
  const lines = [...EARLIER, line.text(4, '2026-11-09T15:50:00Z', '/status'), line.text(5, '2026-11-09T15:50:01Z', 'lunch')]
  const paused = { since: '2026-11-09T15:40:00Z', cause: 'setup', reason: 'OpenRouter answered 401', next: '2026-11-09T16:10:00Z', tries: 1 }
  assert.deepEqual(ask({ state: { ...HANDLED, paused }, lines }), { kind: 'idle', reason: 'paused' })
  assert.deepEqual(ask({ state: { ...HANDLED, paused }, lines, now: '2026-11-09T16:09:59Z' }), { kind: 'idle', reason: 'paused' })
  assert.deepEqual(ask({ state: { ...HANDLED, paused }, lines, now: '2026-11-09T16:10:00Z' }), { kind: 'messages' })
})

test('triggers: a scheduled task runs at its time, once, and waits for messages and pauses', () => {
  const agent = agentWith({ scheduled: [['21:30', 'Evening check-in.', 'check-in']] })
  const state = { ...HANDLED, scheduled: { '21:30': '2026-11-08' } }
  // 21:29 and 21:30 in Kolkata.
  assert.deepEqual(ask({ agent, state, lines: EARLIER, now: '2026-11-09T15:59:59Z' }), { kind: 'idle', reason: 'nothing' })
  assert.deepEqual(ask({ agent, state, lines: EARLIER, now: '2026-11-09T16:00:00Z' }), { kind: 'scheduled', at: '21:30', tag: 'check-in', date: '2026-11-09', prompt: 'Evening check-in.' })
  // Once it has run, the runner records the date, and the task waits for tomorrow.
  const ran = { ...state, scheduled: { '21:30': '2026-11-09' } }
  assert.deepEqual(ask({ agent, state: ran, lines: EARLIER, now: '2026-11-10T15:59:59Z' }), { kind: 'idle', reason: 'nothing' })
  assert.equal(ask({ agent, state: ran, lines: EARLIER, now: '2026-11-10T16:00:00Z' }).kind, 'scheduled')

  // Messages ready at the same time go first, and the task after them.
  const lines = [...EARLIER, line.text(4, '2026-11-09T15:59:00Z', 'dinner')]
  assert.deepEqual(ask({ agent, state, lines, now: '2026-11-09T16:00:00Z' }), { kind: 'messages' })
  assert.equal(ask({ agent, state: { ...state, cursor: 4 }, lines, now: '2026-11-09T16:05:00Z' }).kind, 'scheduled')
  // Messages still in their quiet period don't hold it back.
  assert.equal(ask({ agent, state, lines, now: '2026-11-09T16:00:00Z', seenAgo: SECOND }).kind, 'scheduled')

  // A task that comes due during a pause runs once the pause has ended.
  const paused = { since: '2026-11-09T15:50:00Z', cause: 'setup', reason: 'OpenRouter answered 402', next: '2026-11-09T16:20:00Z', tries: 1 }
  assert.deepEqual(ask({ agent, state: { ...state, paused }, lines: EARLIER, now: '2026-11-09T16:00:00Z' }), { kind: 'idle', reason: 'paused' })
  assert.equal(ask({ agent, state: { ...state, paused }, lines: EARLIER, now: '2026-11-09T16:20:00Z' }).kind, 'scheduled')
  // So does one that came due during a run: the runner asks again when the run is over.
  assert.equal(ask({ agent, state, lines: EARLIER, now: '2026-11-09T16:09:00Z' }).kind, 'scheduled')
  // A task the state has no date for, which only a startup that skipped `startupState` would
  // leave, never runs.
  assert.equal(dueScheduled(agent, HANDLED, { now: at('2026-11-09T16:00:00Z'), timeZone: 'Asia/Kolkata' }), null)
})

// Runs the schedule from `start` to `end`, asking every `step`, as the runner's loop would after
// starting at `start`. Returns the instants at which tasks ran, as `<at> <UTC time>`.
function runSchedule(agent, { start, end, step = MINUTE, timeZone }) {
  let { state } = startupState(HANDLED, agent, { now: at(start), timeZone })
  const ran = []
  for (let now = at(start); now <= at(end); now += step) {
    const due = dueScheduled(agent, state, { now, timeZone })
    if (!due) continue
    ran.push(`${due.at} ${new Date(now).toISOString().slice(0, 16)}Z`)
    state = { ...state, scheduled: { ...state.scheduled, [due.at]: due.date } }
  }
  return ran
}

test('time: scheduled tasks run at the right local time across daylight-saving changes', () => {
  // New York leaves summer time on 1 November 2026: 21:30 is 01:30 UTC before, 02:30 after.
  assert.deepEqual(runSchedule(agentWith({ scheduled: [['21:30', 'Check in.']] }), { start: '2026-10-30T12:00:00Z', end: '2026-11-03T12:00:00Z', timeZone: 'America/New_York' }), [
    '21:30 2026-10-31T01:30Z',
    '21:30 2026-11-01T01:30Z',
    '21:30 2026-11-02T02:30Z',
    '21:30 2026-11-03T02:30Z',
  ])
  // London goes from 01:00 to 02:00 on 29 March 2026. 01:30 doesn't exist that day, and the task
  // runs at the jump; it runs once each day all the same.
  assert.deepEqual(runSchedule(agentWith({ scheduled: [['01:30', 'Night.']] }), { start: '2026-03-27T12:00:00Z', end: '2026-03-30T12:00:00Z', timeZone: 'Europe/London' }), [
    '01:30 2026-03-28T01:30Z',
    '01:30 2026-03-29T01:00Z',
    '01:30 2026-03-30T00:30Z',
  ])
  // London goes back from 02:00 to 01:00 on 25 October 2026. 01:30 comes twice, and the task runs
  // at the first.
  assert.deepEqual(runSchedule(agentWith({ scheduled: [['01:30', 'Night.']] }), { start: '2026-10-23T12:00:00Z', end: '2026-10-26T12:00:00Z', timeZone: 'Europe/London' }), [
    '01:30 2026-10-24T00:30Z',
    '01:30 2026-10-25T00:30Z',
    '01:30 2026-10-26T01:30Z',
  ])
  // A weekly task, on Sundays only.
  assert.deepEqual(runSchedule(agentWith({ scheduled: [['Sun 18:00', 'Weekly.']] }), { start: '2026-11-01T00:00:00Z', end: '2026-11-16T00:00:00Z', step: 15 * MINUTE, timeZone: 'Asia/Kolkata' }), [
    'Sun 18:00 2026-11-01T12:30Z',
    'Sun 18:00 2026-11-08T12:30Z',
    'Sun 18:00 2026-11-15T12:30Z',
  ])
})

test('time: a SCOOTER_TZ changed between restarts doesn\'t stall the schedule or the messages', () => {
  const agent = agentWith({ scheduled: [['21:30', 'Check in.', 'check-in']] })
  // In Kolkata the task ran at 21:30 on 9 November, 16:00 UTC. The runner restarts in New York,
  // where it is then 12:00 on the same day: the task runs at 21:30 there, that evening.
  const fromKolkata = { ...HANDLED, scheduled: { '21:30': '2026-11-09' } }
  const york = startupState(fromKolkata, agent, { now: at('2026-11-09T17:00:00Z'), timeZone: 'America/New_York' }).state
  assert.equal(dueScheduled(agent, york, { now: at('2026-11-10T02:29:00Z'), timeZone: 'America/New_York' }), null)
  assert.deepEqual(dueScheduled(agent, york, { now: at('2026-11-10T02:30:00Z'), timeZone: 'America/New_York' }), { at: '21:30', tag: 'check-in', date: '2026-11-09', prompt: 'Check in.' })

  // The other way: in New York it ran at 21:30 on 9 November, 02:30 UTC on the 10th, which is
  // already 08:00 on the 10th in Kolkata. Its date there is ahead of nothing, and the task runs at
  // 21:30 on the 10th, Kolkata time.
  const fromYork = { ...HANDLED, scheduled: { '21:30': '2026-11-09' } }
  const kolkata = startupState(fromYork, agent, { now: at('2026-11-10T03:00:00Z'), timeZone: 'Asia/Kolkata' }).state
  assert.equal(dueScheduled(agent, kolkata, { now: at('2026-11-10T15:59:00Z'), timeZone: 'Asia/Kolkata' }), null)
  assert.equal(dueScheduled(agent, kolkata, { now: at('2026-11-10T16:00:00Z'), timeZone: 'Asia/Kolkata' })?.date, '2026-11-10')
  // Even a date from a zone far ahead, which the new zone hasn't reached yet, is set right at the
  // start, so the task isn't held back for days.
  const ahead = { ...HANDLED, scheduled: { '21:30': '2026-11-12' } }
  const reset = startupState(ahead, agent, { now: at('2026-11-10T03:00:00Z'), timeZone: 'Pacific/Pago_Pago' }).state
  assert.equal(reset.scheduled['21:30'], '2026-11-08')
  assert.equal(dueScheduled(agent, reset, { now: at('2026-11-10T08:30:00Z'), timeZone: 'Pacific/Pago_Pago' })?.date, '2026-11-09')

  // Messages go by `seq` and by when the runner saw them, so the zone changes nothing there.
  const lines = [...EARLIER, line.text(4, '2026-11-09T15:50:00Z', 'lunch')]
  for (const timeZone of ['Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati']) {
    assert.deepEqual(ask({ state: HANDLED, lines, timeZone }), { kind: 'messages' })
  }
})

test('triggers: a backfill batch runs only when nothing live is waiting, and finishes when its work is done', () => {
  const agent = agentWith({ backfill: ['people-1'], scheduled: [['21:30', 'Check in.']] })
  const lines = [...EARLIER, line.text(4, '2026-11-09T15:40:00Z', 'met sam'), line.text(5, '2026-11-09T15:50:00Z', 'lunch')]
  const backfill = { id: 'people-1', until: 4, cursor: 0, retry: [], skipped: [] }
  const state = { ...initialAgentState(), cursor: 4, scheduled: { '21:30': '2026-11-09' }, backfill }

  // #5 waits after the cursor, quiet or not: no backfill batch.
  assert.deepEqual(ask({ agent, state, lines, seenAgo: SECOND }), { kind: 'idle', reason: 'quiet' })
  assert.deepEqual(ask({ agent, state, lines }), { kind: 'messages' })
  // Once it is handled, the backfill has its turn.
  assert.deepEqual(ask({ agent, state: { ...state, cursor: 5 }, lines }), { kind: 'backfill', id: 'people-1' })
  // A due retry or a scheduled task comes first.
  const retry = [{ seq: 5, attempts: 1, due: '2026-11-09T15:50:00Z', reason: 'not marked' }]
  assert.deepEqual(ask({ agent, state: { ...state, cursor: 5, retry }, lines }), { kind: 'messages' })
  assert.equal(ask({ agent, state: { ...state, cursor: 5, scheduled: { '21:30': '2026-11-08' } }, lines, now: '2026-11-09T16:00:00Z' }).kind, 'scheduled')
  // So does a pause.
  const paused = { since: '2026-11-09T15:40:00Z', cause: 'outage', reason: 'no answer', next: '2026-11-09T16:10:00Z', tries: 1 }
  assert.deepEqual(ask({ agent, state: { ...state, cursor: 5, paused }, lines }), { kind: 'idle', reason: 'paused' })

  // Its work is up to `until`: #5, after it, is the live lane's.
  const done = { ...state, cursor: 5, backfill: { ...backfill, cursor: 4 } }
  assert.deepEqual(ask({ agent, state: done, lines }), { kind: 'backfill-finished', id: 'people-1' })
  // Not while its own retries wait; and they start a batch when they are due.
  const waiting = { ...done, backfill: { ...done.backfill, retry: [{ seq: 3, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'not marked' }] } }
  assert.deepEqual(ask({ agent, state: waiting, lines }), { kind: 'idle', reason: 'nothing' })
  assert.deepEqual(ask({ agent, state: waiting, lines, now: '2026-11-09T15:51:00Z' }), { kind: 'backfill', id: 'people-1' })
  // A message of its retries that was deleted since, live, holds it back no more: the runner
  // settles it, and no batch would give it.
  const deletedSince = [...lines, line.delete(6, '2026-11-09T15:50:20Z', 3)]
  assert.deepEqual(ask({ agent, state: { ...waiting, cursor: 6 }, lines: deletedSince }), { kind: 'backfill-finished', id: 'people-1' })
  assert.deepEqual(ask({ agent, state: { ...waiting, cursor: 6 }, lines: deletedSince, now: '2026-11-09T15:51:00Z' }), { kind: 'backfill-finished', id: 'people-1' })
  // One whose entry left the config is left alone until the next start drops it.
  assert.deepEqual(ask({ agent: agentWith(), state: { ...state, cursor: 5 }, lines }), { kind: 'idle', reason: 'nothing' })

  // A channel no trigger names is no work, live or a backfill's: its lines don't hold the backfill
  // back, and aren't its to take.
  const onEmail = agentWith({ channels: ['email'], backfill: ['people-1'] })
  assert.deepEqual(ask({ agent: onEmail, state, lines }), { kind: 'backfill-finished', id: 'people-1' })
  const withEmail = [...lines, { ...line.email(6, '2026-11-09T15:30:00Z', 'Hi', 'x'), day: undefined }]
  assert.deepEqual(ask({ agent: onEmail, state: { ...state, cursor: 6, backfill: { ...backfill, until: 6 } }, lines: withEmail }), { kind: 'backfill', id: 'people-1' })
})
