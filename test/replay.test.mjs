// Replayed batches, which a rebuild and a backfill share:
// one of the owner's days per batch, `Now:` each batch's own time, a session for each
// day, and where a replay stops.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { buildReplayBatch, ownersDay, removeReplaySessions, replaySessionId } from '../src/runner/replay.mjs'
import { createTestLog } from './support/log.mjs'
import { indexOf, line } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const PATHS = makePaths({ dataDir: '/data', configDir: '/config' })
const AGENT = { name: 'lifelog', reads: ['whatsapp', 'email'], replyMode: 'quiet', session: 'daily', run: { newMessages: true, scheduled: [], backfill: [] } }
// When the replay looks at its retries: long after every message.
const LATER = Date.parse('2026-11-18T10:00:00Z')

// The owner's messages over three days in Kolkata, UTC+5:30. #3 and #4 are on the same UTC day,
// and on two days of the owner's.
const LINES = [
  line.text(1, '2026-11-07T16:00:00Z', 'ran 5k'), // Sat 7 Nov, 21:30
  line.sent(2, '2026-11-07T16:01:00Z', 'Logged.'),
  line.text(3, '2026-11-07T18:20:00Z', 'late coffee'), // Sat 7 Nov, 23:50
  line.text(4, '2026-11-07T18:40:00Z', 'midnight snack'), // Sun 8 Nov, 00:10
  line.command(5, '2026-11-08T03:00:00Z', '/new'),
  line.text(6, '2026-11-08T03:30:00Z', 'breakfast'), // Sun 8 Nov, 09:00
  line.text(7, '2026-11-09T15:00:00Z', 'today was long'), // Mon 9 Nov, 20:30
]

function replay({ lines = LINES, lane = { ...initialAgentState() }, until = 7, timeZone = 'Asia/Kolkata', now = LATER, intro } = {}) {
  return buildReplayBatch({ agent: AGENT, lane, until, index: indexOf(lines), paths: PATHS, now, timeZone, homeCurrency: 'INR', internet: false, intro })
}

// Every batch of a replay of `lines` from the start, each run as if it had succeeded.
function replayAll(options = {}) {
  const batches = []
  let lane = { ...initialAgentState() }
  for (let built; (built = replay({ ...options, lane })) !== null; ) {
    batches.push(built)
    lane = { ...lane, cursor: built.batch.covered }
  }
  return batches
}

const seqsOf = built => built.batch.items.map(item => item.seq)
const firstLine = prompt => prompt.split('\n')[0]

test("replay: batches don't cross the owner's days, and Now: is each batch's own time", () => {
  const batches = replayAll()
  assert.deepEqual(
    batches.map(built => [built.day, seqsOf(built), built.batch.covered]),
    [
      ['2026-11-07', [1, 3], 3],
      ['2026-11-08', [4, 6], 6],
      ['2026-11-09', [7], 7],
    ],
  )
  // `Now:` is the time of the batch's newest item, so its items are all from "today".
  assert.deepEqual(
    batches.map(built => firstLine(built.prompt)),
    [
      '[scooter] Now: Saturday 7 November 2026, 23:50 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.',
      '[scooter] Now: Sunday 8 November 2026, 09:00 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.',
      '[scooter] Now: Monday 9 November 2026, 20:30 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.',
    ],
  )
  assert.deepEqual(
    batches.map(built => built.time),
    ['2026-11-07T18:20:00Z', '2026-11-08T03:30:00Z', '2026-11-09T15:00:00Z'].map(Date.parse),
  )
  assert.equal(
    batches[0].prompt.split('\n').slice(3).join('\n'),
    `New messages:
#1 21:30 text: "ran 5k"
#3 23:50 text: "late coffee"

For context only (no action, no DONE):
#2 21:31 you sent: "Logged."`,
  )
  // A message just after midnight is of the next day, and its time is "today"'s.
  assert.match(batches[1].prompt, /^#4 00:10 text: "midnight snack"$/m)

  // The days are the owner's: in New York, #3, #4 and #6 are all on Saturday 7 November.
  const york = replayAll({ timeZone: 'America/New_York' })
  assert.deepEqual(
    york.map(built => [built.day, seqsOf(built)]),
    [
      ['2026-11-07', [1, 3, 4, 6]],
      ['2026-11-09', [7]],
    ],
  )
  assert.equal(ownersDay(LINES[5], 'America/New_York'), '2026-11-07')
  assert.equal(ownersDay(LINES[5], 'Asia/Kolkata'), '2026-11-08')
})

test('replay: it stops at until, and the cursor never passes it', () => {
  const batches = replayAll({ until: 6 })
  assert.deepEqual(
    batches.map(built => [seqsOf(built), built.batch.covered]),
    [
      [[1, 3], 3],
      [[4, 6], 6],
    ],
  )
  // Lines past `until` aren't even context.
  const withReply = [...LINES.slice(0, 4), line.sent(5, '2026-11-07T18:41:00Z', 'Noted.')]
  assert.deepEqual(replayAll({ lines: withReply, until: 4 }).map(built => [seqsOf(built), built.batch.context]), [
    [[1, 3], [2]],
    [[4], []],
  ])
  assert.equal(replay({ lane: { ...initialAgentState(), cursor: 6 }, until: 6 }), null)
})

test('replay: at most 20 items, due retries first, each batch of one day', () => {
  // 25 messages on one day: 20, then 5.
  const many = Array.from({ length: 25 }, (_, n) => line.text(n + 1, `2026-11-07T10:${String(n).padStart(2, '0')}:00Z`, `note ${n + 1}`))
  assert.deepEqual(
    replayAll({ lines: many, until: 25 }).map(built => seqsOf(built).length),
    [20, 5],
  )

  // A retry of 7 November is due, and the cursor is past 8 November: the retry is a batch of its
  // own, with its day's time, and 9 November waits for the next.
  const lane = { ...initialAgentState(), cursor: 6, retry: [{ seq: 3, attempts: 1, due: '2026-11-17T10:00:00Z', reason: 'not reported' }] }
  const built = replay({ lane })
  assert.deepEqual([built.day, built.batch.items, built.batch.covered], ['2026-11-07', [{ seq: 3, origin: 'retry', attempt: 2 }], 6])
  assert.match(built.prompt, /^\[scooter\] Now: Saturday 7 November 2026, 23:50 /)
  assert.match(built.prompt, /Retrying \(not handled yet\):\n#3 23:50 text: "late coffee" \(attempt 2 of 4\)/)
  // Once it is done, 9 November.
  assert.deepEqual(seqsOf(replay({ lane: { ...lane, retry: [] } })), [7])
  // Not due yet: 9 November goes first.
  assert.deepEqual(seqsOf(replay({ lane, now: Date.parse('2026-11-17T09:59:00Z') })), [7])
})

test('replay: an edit brings in the message it changes, from another day, which is shown with its date', () => {
  // #1, of 7 November, waits in the lane's retries; #8 edits it on 9 November.
  const lines = [...LINES, line.edit(8, '2026-11-09T15:10:00Z', 1, 'ran 6k')]
  const lane = { ...initialAgentState(), cursor: 6, retry: [{ seq: 1, attempts: 1, due: '2026-11-19T10:00:00Z', reason: 'not reported' }] }
  const built = replay({ lines, lane, until: 8 })
  assert.equal(built.day, '2026-11-09')
  assert.deepEqual(built.batch.items, [
    { seq: 1, origin: 'retry', attempt: 2 },
    { seq: 7, origin: 'new', attempt: 1 },
    { seq: 8, origin: 'new', attempt: 1 },
  ])
  assert.match(built.prompt, /^\[scooter\] Now: Monday 9 November 2026, 20:40 /)
  assert.match(built.prompt, /^#1 Sat 7 Nov 21:30 text: "ran 6k" \(edited in #8\) \(attempt 2 of 4\)$/m)

  // And from what the lane gave up on, which starts it again at attempt 1.
  const failed = { ...lane, retry: [], failed: [{ seq: 1, at: '2026-11-09T10:00:00Z', reason: 'not handled after 4 attempts' }] }
  assert.deepEqual(replay({ lines, lane: failed, until: 8 }).batch.items[0], { seq: 1, origin: 'failed', attempt: 1 })
})

test("replay: a backfill's prompt starts with its line", () => {
  const intro = 'Backfill (from your configuration, not a message from the owner): file these messages for the people skill only. Change only views/people.csv.'
  const built = replay({ intro })
  assert.equal(built.prompt.split('\n')[0], intro)
  assert.match(built.prompt.split('\n')[1], /^\[scooter\] Now: Saturday 7 November 2026, 23:50 /)
})

test('replay: a session for each of the owner\'s days, and only a replay\'s own sessions go when it is over', t => {
  assert.equal(replaySessionId(AGENT, { day: '2026-11-07' }), 'lifelog-rebuild-2026-11-07')
  assert.equal(replaySessionId(AGENT, { day: '2026-11-07', backfill: 'people-1' }), 'lifelog-backfill-people-1-2026-11-07')
  assert.equal(replaySessionId({ ...AGENT, session: 'none' }, { day: '2026-11-07' }), null)

  const paths = makePaths({ dataDir: makeTestDir(t), configDir: '/config' })
  const dir = paths.agentSessions('lifelog')
  fs.mkdirSync(dir, { recursive: true })
  const names = [
    'lifelog-2026-11-07.jsonl',
    'lifelog-2026-11-07-1.jsonl',
    'lifelog-rebuild-2026-11-07.jsonl',
    'lifelog-rebuild-2026-11-08.jsonl',
    'lifelog-rebuild-notes.jsonl',
    'lifelog-backfill-people-1-2026-11-07.jsonl',
    'lifelog-backfill-people-1-2-2026-11-07.jsonl',
  ]
  for (const name of names) fs.writeFileSync(path.join(dir, name), '{}\n')
  const { log } = createTestLog()
  assert.equal(removeReplaySessions({ paths, agent: AGENT, log }), 2)
  assert.equal(removeReplaySessions({ paths, agent: AGENT, backfill: 'people-1', log }), 1)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['lifelog-2026-11-07-1.jsonl', 'lifelog-2026-11-07.jsonl', 'lifelog-backfill-people-1-2-2026-11-07.jsonl', 'lifelog-rebuild-notes.jsonl'])
  // No sessions folder is no matter.
  fs.rmSync(dir, { recursive: true })
  assert.equal(removeReplaySessions({ paths, agent: AGENT, log }), 0)
})
