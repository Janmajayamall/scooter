// Replayed batches, a job's of `scooter backfill`:
// one of the owner's days per batch, `$now$` each batch's own time, the prompt of a live batch or
// the job's own, with what the job may change, a session for each day, and where a job stops.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { buildReplayBatch, jobOfSession, ownersDay, removeJobSessions, replaySessionId } from '../src/runner/replay.mjs'
import { createTestLog } from './support/log.mjs'
import { indexOf, line } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const PATHS = makePaths({ dataDir: '/data', configDir: '/config' })
// Its prompt for new messages gives the time, the lines and what the run may change.
const PROMPT = 'Now: $now$\nNew: $seq.unread$\nGiven before: $seq.retry$\nMay change: $run.writes$\n'
const AGENT = {
  name: 'lifelog',
  channels: ['whatsapp', 'email'],
  replyMode: 'quiet',
  session: 'daily',
  writes: ['agents/lifelog/views/', 'agents/lifelog/memory/'],
  run: { newMessages: [{ channels: ['whatsapp', 'email'], prompt: PROMPT }], scheduled: [] },
}
// When the replay looks at its retries: long after every message.
const LATER = Date.parse('2026-11-18T10:00:00Z')

// The owner's messages over three days in Kolkata, UTC+5:30. #3 and #4 are on the same UTC day,
// and on two days of the owner's.
const LINES = [
  line.text(1, '2026-11-07T16:00:00Z', 'ran 5k'), // Sat 7 Nov, 21:30
  line.sent(2, '2026-11-07T16:01:00Z', 'Logged.'),
  line.text(3, '2026-11-07T18:20:00Z', 'late coffee'), // Sat 7 Nov, 23:50
  line.text(4, '2026-11-07T18:40:00Z', 'midnight snack'), // Sun 8 Nov, 00:10
  line.reaction(5, '2026-11-08T03:00:00Z', 4, '👍'),
  line.text(6, '2026-11-08T03:30:00Z', 'breakfast'), // Sun 8 Nov, 09:00
  line.text(7, '2026-11-09T15:00:00Z', 'today was long'), // Mon 9 Nov, 20:30
]

function replay({ lines = LINES, lane = { ...initialAgentState() }, until = 7, timeZone = 'Asia/Kolkata', now = LATER, writes, template } = {}) {
  const settings = { timeZone, homeCurrency: 'INR', agentInternet: false }
  return buildReplayBatch({ agent: AGENT, lane, until, index: indexOf(lines), paths: PATHS, settings, now, writes, template })
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

test("replay: batches don't cross the owner's days, and $now$ is each batch's own time", () => {
  const batches = replayAll()
  assert.deepEqual(
    batches.map(built => [built.day, seqsOf(built), built.batch.covered]),
    [
      ['2026-11-07', [1, 3], 3],
      ['2026-11-08', [4, 6], 6],
      ['2026-11-09', [7], 7],
    ],
  )
  // `$now$` is the time of the batch's newest item, so its items are all from "today".
  assert.deepEqual(
    batches.map(built => firstLine(built.prompt)),
    ['Now: Saturday 7 November 2026, 23:50', 'Now: Sunday 8 November 2026, 09:00', 'Now: Monday 9 November 2026, 20:30'],
  )
  assert.deepEqual(
    batches.map(built => built.time),
    ['2026-11-07T18:20:00Z', '2026-11-08T03:30:00Z', '2026-11-09T15:00:00Z'].map(Date.parse),
  )
  // The prompt of a live batch: the lines' numbers, and what the replay's runs may change.
  assert.equal(batches[0].prompt, 'Now: Saturday 7 November 2026, 23:50\nNew: 1 3\nGiven before: none\nMay change: /data/agents/lifelog/views/ /data/agents/lifelog/memory/\n')
  // A message just after midnight is of the next day.
  assert.match(batches[1].prompt, /^New: 4 6$/m)

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
  // Lines past `until` aren't covered.
  const withReply = [...LINES.slice(0, 4), line.sent(5, '2026-11-07T18:41:00Z', 'Noted.')]
  assert.deepEqual(replayAll({ lines: withReply, until: 4 }).map(built => [seqsOf(built), built.batch.covered]), [
    [[1, 3], 3],
    [[4], 4],
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
  const lane = { ...initialAgentState(), cursor: 6, retry: [{ seq: 3, attempts: 1, due: '2026-11-17T10:00:00Z', reason: 'not marked' }] }
  const built = replay({ lane })
  assert.deepEqual([built.day, built.batch.items, built.batch.covered], ['2026-11-07', [{ seq: 3, origin: 'retry', attempt: 2 }], 6])
  assert.match(built.prompt, /^Now: Saturday 7 November 2026, 23:50$/m)
  assert.match(built.prompt, /^New: none\nGiven before: 3 \(attempt 2 of 4\)$/m)
  // Once it is done, 9 November.
  assert.deepEqual(seqsOf(replay({ lane: { ...lane, retry: [] } })), [7])
  // Not due yet: 9 November goes first.
  assert.deepEqual(seqsOf(replay({ lane, now: Date.parse('2026-11-17T09:59:00Z') })), [7])
})

test('replay: an edit brings in the message it changes, from another day', () => {
  // #1, of 7 November, waits in the lane's retries; #8 edits it on 9 November.
  const lines = [...LINES, line.edit(8, '2026-11-09T15:10:00Z', 1, 'ran 6k')]
  const lane = { ...initialAgentState(), cursor: 6, retry: [{ seq: 1, attempts: 1, due: '2026-11-19T10:00:00Z', reason: 'not marked' }] }
  const built = replay({ lines, lane, until: 8 })
  assert.equal(built.day, '2026-11-09')
  assert.deepEqual(built.batch.items, [
    { seq: 1, origin: 'retry', attempt: 2 },
    { seq: 7, origin: 'new', attempt: 1 },
    { seq: 8, origin: 'new', attempt: 1 },
  ])
  assert.match(built.prompt, /^Now: Monday 9 November 2026, 20:40$/m)
  assert.match(built.prompt, /^New: 7 8\nGiven before: 1 \(attempt 2 of 4\)$/m)

  // And from what the lane gave up on, which starts it again at attempt 1.
  const failed = { ...lane, retry: [], failed: [{ seq: 1, at: '2026-11-09T10:00:00Z', reason: 'not handled after 4 attempts' }] }
  assert.deepEqual(replay({ lines, lane: failed, until: 8 }).batch.items[0], { seq: 1, origin: 'failed', attempt: 1 })
})

test("replay: a job's prompt is a live batch's, or the job's own, with what the job may change", () => {
  const writes = ['agents/lifelog/views/people.csv', 'agents/lifelog/views/people/']
  const built = replay({ writes })
  assert.equal(built.prompt, 'Now: Saturday 7 November 2026, 23:50\nNew: 1 3\nGiven before: none\nMay change: /data/agents/lifelog/views/people.csv /data/agents/lifelog/views/people/\n')
  // `--prompt`: the job's own text, filled in as a trigger's is; the agent's isn't used.
  const own = replay({ writes, template: 'File only what belongs in $run.writes$. Lines: $seq.unread$ ($now$). $5 stays.' })
  assert.equal(own.prompt, 'File only what belongs in /data/agents/lifelog/views/people.csv /data/agents/lifelog/views/people/. Lines: 1 3 (Saturday 7 November 2026, 23:50). $5 stays.')
})

test('replay: a message deleted later in history is never given, and its deletion is, on its own day', () => {
  // #1, of 7 November, deleted on 9 November.
  const lines = [...LINES, line.delete(8, '2026-11-09T15:10:00Z', 1)]
  const batches = replayAll({ lines, until: 8 })
  assert.deepEqual(
    batches.map(built => [built.day, seqsOf(built), built.batch.covered]),
    [
      ['2026-11-07', [3], 3],
      ['2026-11-08', [4, 6], 6],
      ['2026-11-09', [7, 8], 8],
    ],
  )
})

test("replay: a session for each of the owner's days, of the job's own, and only the sessions of a job that is over go", t => {
  const job = '20261123T101500123-0001'
  assert.equal(replaySessionId(AGENT, { day: '2026-11-07', job }), 'lifelog-backfill-20261123T101500123-0001-2026-11-07')
  assert.equal(replaySessionId({ ...AGENT, session: 'none' }, { day: '2026-11-07', job }), null)
  assert.equal(jobOfSession('lifelog', 'lifelog-backfill-20261123T101500123-0001-2026-11-07.jsonl'), job)
  for (const name of ['lifelog-2026-11-07.jsonl', 'lifelog-backfill-people-1-2026-11-07.jsonl', 'lifelog-backfill-20261123T101500123-0001-notes.jsonl', 'other-backfill-20261123T101500123-0001-2026-11-07.jsonl']) {
    assert.equal(jobOfSession('lifelog', name), null, name)
  }

  const paths = makePaths({ dataDir: makeTestDir(t), configDir: '/config' })
  const dir = paths.agentSessions('lifelog')
  fs.mkdirSync(dir, { recursive: true })
  const other = '20261123T101500123-0002'
  const names = [
    'lifelog-2026-11-07.jsonl',
    'lifelog-2026-11-07-1.jsonl',
    `lifelog-backfill-${job}-2026-11-07.jsonl`,
    `lifelog-backfill-${job}-2026-11-08.jsonl`,
    `lifelog-backfill-${job}-notes.jsonl`,
    `lifelog-backfill-${other}-2026-11-07.jsonl`,
  ]
  for (const name of names) fs.writeFileSync(path.join(dir, name), '{}\n')
  const { log } = createTestLog()
  assert.equal(removeJobSessions({ paths, agentName: 'lifelog', isOver: id => id === job, log }), 2)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['lifelog-2026-11-07-1.jsonl', 'lifelog-2026-11-07.jsonl', `lifelog-backfill-${job}-notes.jsonl`, `lifelog-backfill-${other}-2026-11-07.jsonl`])
  // No sessions folder is no matter.
  fs.rmSync(dir, { recursive: true })
  assert.equal(removeJobSessions({ paths, agentName: 'lifelog', isOver: () => true, log }), 0)
})
