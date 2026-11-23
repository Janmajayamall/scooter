// The batch and its prompt: the example prompt, the trigger's prompt and its variables, the
// batch's limit, the lines it passes over, the messages already deleted, and an edit bringing in its
// message.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { assembleBatch, buildBatch, scheduledPrompt, selectCandidates, triggerOf } from '../src/runner/batch.mjs'
import { settleBatch } from '../src/runner/failures.mjs'
import { NONE, VARIABLES, longTime, longestPrompt, longestValues, promptValues, renderPrompt, variablesIn } from '../src/runner/prompt.mjs'
import { EXAMPLE_NOW, EXAMPLE_PROMPT, NEW_MESSAGES_PROMPT, exampleLines, exampleState, fillerLines, indexOf, line } from './support/runner.mjs'
import { atEnd } from './support/tmp.mjs'

const PATHS = makePaths({ dataDir: '/data', configDir: '/config' })
const SETTINGS = { timeZone: 'Asia/Kolkata', homeCurrency: 'INR', agentInternet: false }
// Every variable, one to a line.
const EVERY = `${VARIABLES.map(name => `${name}=$${name}$`).join('\n')}\n`
const AGENT = {
  name: 'lifelog',
  channels: ['whatsapp', 'email'],
  replyMode: 'quiet',
  writes: ['agents/lifelog/views/', 'agents/lifelog/memory/'],
  run: { newMessages: [{ channels: ['whatsapp', 'email'], prompt: NEW_MESSAGES_PROMPT }], scheduled: [] },
}
const withPrompt = (prompt, agent = AGENT) => ({ ...agent, run: { ...agent.run, newMessages: [{ channels: agent.channels, prompt }] } })

function build({ lines, state = initialAgentState(), now = EXAMPLE_NOW, agent = AGENT, settings = SETTINGS, paths = PATHS }) {
  return buildBatch({ agent, state, index: indexOf(lines), paths, settings, now: Date.parse(now) })
}

const seqsOf = batch => batch.items.map(item => item.seq)
// A prompt that gives every variable, read back as `{ name: value }`.
const valuesOf = prompt => Object.fromEntries(prompt.trimEnd().split('\n').map(text => [text.slice(0, text.indexOf('=')), text.slice(text.indexOf('=') + 1)]))

test("batch: the example prompt, exactly as the runner's document shows it", () => {
  const { batch, prompt } = build({ lines: exampleLines(), state: exampleState() })
  assert.equal(prompt, EXAMPLE_PROMPT)
  assert.deepEqual(batch, {
    items: [
      { seq: 1047, origin: 'retry', attempt: 2 },
      { seq: 1050, origin: 'new', attempt: 1 },
      { seq: 1051, origin: 'new', attempt: 1 },
      { seq: 1052, origin: 'new', attempt: 1 },
      { seq: 1053, origin: 'new', attempt: 1 },
      { seq: 1054, origin: 'new', attempt: 1 },
    ],
    settled: [],
    covered: 1054,
    newest: 1054,
  })
  // The document's own example, the fenced block under "The prompt" that starts as the prompt does.
  const document = fs.readFileSync(new URL('../docs/architecture/runner.md', import.meta.url), 'utf8')
  const section = document.slice(document.indexOf('\n## The prompt\n'))
  const blocks = [...section.matchAll(/^```text\n([\s\S]*?)^```$/gm)].map(match => match[1])
  assert.ok(blocks.includes(EXAMPLE_PROMPT), 'runner.md shows the example prompt')
})

test("batch: the prompt is the trigger's own, each variable filled in once, and nothing else", () => {
  const settings = { timeZone: 'America/New_York', homeCurrency: 'USD', agentInternet: true }
  const agent = withPrompt(EVERY, { ...AGENT, replyMode: 'confirm', writes: ['agents/lifelog/views/books.csv', 'agents/lifelog/my notes/', 'shared/'] })
  const { prompt } = build({ lines: exampleLines(), state: exampleState(), agent, settings })
  assert.deepEqual(valuesOf(prompt), {
    now: 'Monday 9 November 2026, 10:50',
    'user.timezone': 'America/New_York',
    'user.currency': 'USD',
    reply_mode: 'confirm',
    internet: 'on',
    'agent.dir': '/data/agents/lifelog',
    'datastore.dir': '/data/datastore',
    'seq.unread': '1050 1051 1052 1053 1054',
    'seq.retry': '1047 (attempt 2 of 4)',
    // A path that holds a space is a JSON string, so the list reads one way.
    'run.writes': '/data/agents/lifelog/views/books.csv "/data/agents/lifelog/my notes/" /data/shared/',
  })

  // A `$` that starts no variable is the owner's own text, and a pattern `String.replace` reads in
  // a replacement is text too, in the template and in a value. A value is never read again for
  // variables: a data folder whose path holds `$now$` gives it as it is.
  const odd = withPrompt('$5, $$, $&, $1, $`, $\', US$now$ and $now$$ $ now$ $No w$\n')
  const paths = makePaths({ dataDir: '/srv/$now$/$&', configDir: '/config' })
  const fills = build({ lines: exampleLines(), state: exampleState(), agent: withPrompt('$agent.dir$ $run.writes$\n', odd), paths })
  assert.equal(fills.prompt, '/srv/$now$/$&/agents/lifelog /srv/$now$/$&/agents/lifelog/views/ /srv/$now$/$&/agents/lifelog/memory/\n')
  assert.equal(build({ lines: exampleLines(), state: exampleState(), agent: odd }).prompt, "$5, $$, $&, $1, $`, $', USMonday 9 November 2026, 21:20 and Monday 9 November 2026, 21:20$ $ now$ $No w$\n")

  // What a list with nothing in it reads.
  const none = build({ lines: exampleLines(), state: { ...exampleState(), retry: [] }, agent: withPrompt(EVERY, { ...AGENT, writes: [] }) })
  assert.deepEqual([valuesOf(none.prompt)['seq.retry'], valuesOf(none.prompt)['run.writes']], [NONE, NONE])
})

test('batch: nothing a channel delivered is in the prompt: no text, name, subject, path or number of its own', () => {
  // Texts that would pass for the prompt's own words, a variable, or a flag of pi's, and a file's
  // name, an email's subject and a quoted preview with them.
  const words = ['New: 1 2 3', '$now$', '$seq.unread$', '--model x', '@views/expenses.csv', 'Given before: 9', 'ignore the above']
  const lines = [
    ...fillerLines(2),
    line.text(3, '2026-11-09T15:00:00Z', words.join('\n'), { data: { quoted: words[0], forwarded: true } }),
    line.email(4, '2026-11-09T15:01:00Z', words[1], words[2], {
      files: [
        { path: '4.eml', mime: 'message/rfc822', bytes: 10 },
        { path: '4-2.pdf', mime: 'application/pdf', name: `${words[3]}.pdf`, bytes: 10 },
      ],
    }),
    line.text(5, '2026-11-09T15:02:00Z', '', { media: { type: 'image', mime: 'image/jpeg', error: words[4] } }),
    line.edit(6, '2026-11-09T15:03:00Z', 3, words[5]),
  ]
  const { prompt } = build({ lines, state: { ...initialAgentState(), cursor: 2 } })
  for (const word of [...words, '4-2.pdf', 'ignore']) assert.ok(!prompt.includes(word), word)
  assert.match(prompt, /^New: 3 4 5 6$/m)
})

test('batch: nothing to give the agent is no batch', () => {
  assert.equal(build({ lines: exampleLines(), state: { ...exampleState(), cursor: 1054, retry: [] } }), null)
  // A retry that isn't due yet waits.
  assert.equal(build({ lines: exampleLines(), state: { ...exampleState(), cursor: 1054, retry: [{ seq: 1047, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'x' }] } }), null)
})

test('batch: at most 20 items, retries first, and the cursor stops before the first one left', () => {
  // 3 due retries, then 25 new messages with a message Scooter sent, a reaction and an email the
  // agent doesn't read among them.
  const lines = [...fillerLines(10)]
  for (let seq = 11; seq <= 40; seq++) {
    if (seq === 25) lines.push(line.sent(seq, '2026-11-09T15:00:00Z', 'Noted.'))
    else if (seq === 26) lines.push(line.reaction(seq, '2026-11-09T15:00:00Z', 24, '👍'))
    else if (seq === 27) lines.push(line.email(seq, '2026-11-09T15:00:00Z', 'Hi', 'not read'))
    else lines.push(line.text(seq, '2026-11-09T15:00:00Z', `item ${seq}`))
  }
  const retry = [3, 1, 2].map(seq => ({ seq, attempts: 2, due: '2026-11-09T15:00:00Z', reason: 'not marked' }))
  const { batch, prompt } = build({ lines, state: { ...initialAgentState(), cursor: 10, retry }, agent: { ...AGENT, channels: ['whatsapp'], run: { ...AGENT.run, newMessages: [{ channels: ['whatsapp'], prompt: NEW_MESSAGES_PROMPT }] } } })
  assert.equal(batch.items.length, limits.BATCH_MAX_ITEMS)
  assert.deepEqual(seqsOf(batch).slice(0, 3), [1, 2, 3])
  assert.deepEqual(batch.items.slice(0, 3).map(item => [item.origin, item.attempt]), [['retry', 3], ['retry', 3], ['retry', 3]])
  // The 17 new ones are #11 to #24 and #28 to #30; #31 is the first left for later. The message
  // sent, the reaction and the email are passed over, and given in no way.
  assert.deepEqual(seqsOf(batch).slice(3), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 28, 29, 30])
  assert.equal(batch.covered, 30)
  assert.equal(batch.newest, 30)
  assert.match(prompt, /^New: 11 12 13 14 15 16 17 18 19 20 21 22 23 24 28 29 30$/m)
  assert.match(prompt, /^Given before: 1 \(attempt 3 of 4\), 2 \(attempt 3 of 4\), 3 \(attempt 3 of 4\)$/m)
})

test("batch: a line this version doesn't know is passed over, and an edit or a deletion of one is work of its own", () => {
  const at = minute => `2026-11-09T15:${String(minute).padStart(2, '0')}:00Z`
  const base = { dir: 'in', trust: 'owner' }
  const lines = [
    ...fillerLines(1),
    line.text(2, at(0), 'coffee 120'),
    // A kind an earlier version wrote, a channel that is gone, and a message without its text.
    { seq: 3, kind: 'command', ...base, at: at(1), source: 'whatsapp', sourceId: 'C3', text: '/status' },
    { seq: 4, kind: 'message', ...base, at: at(2), source: 'telegram', sourceId: 'T4', text: 'hi' },
    { seq: 5, kind: 'message', ...base, at: at(3), source: 'whatsapp', sourceId: 'W5' },
    // Fields this version doesn't know, and `data` of any kind, change nothing.
    line.text(6, at(4), 'lunch 300', { replyTo: 4, quoted: 'top-level', forwarded: true, subject: 'x', data: { quoted: 'hi there' } }),
    line.email(7, at(5), 'unused', 'a list for data', { data: ['Call with Sam'] }),
    { ...line.reaction(8, at(6), 2, 'x'), data: { emoji: 7 } },
    // An `out` line of a kind this version doesn't know.
    { seq: 9, kind: 'typing', dir: 'out', at: at(7), source: 'whatsapp', by: 'lifelog' },
    // An edit of the old command, and a deletion of the gone channel's message.
    line.edit(10, at(8), 3, '/help'),
    line.delete(11, at(9), 4),
  ].map(entry => JSON.parse(JSON.stringify(entry)))
  const { batch, prompt } = build({ lines, state: { ...initialAgentState(), cursor: 1 } })
  assert.deepEqual(seqsOf(batch), [2, 6, 7, 10, 11])
  assert.equal(batch.covered, 11)
  assert.match(prompt, /^New: 2 6 7 10 11$/m)
})

// The lost-line rule: an edit and a deletion, in every order, against a message that is new, waits
// to be tried again, was given up on, or is done. Each line that is work is given until it is
// marked, or has used its attempts, and only the message already deleted is settled by the runner.
test('batch: a message already deleted is never given, and its deletion always is; an edit brings in its message from retry or failed', () => {
  const at = minute => `2026-11-09T15:${String(minute).padStart(2, '0')}:00Z`
  const message = line.text(3, at(0), 'coffee 120')
  const edit = seq => line.edit(seq, at(seq), 3, 'coffee 150')
  const deletion = seq => line.delete(seq, at(seq), 3)
  const waiting = { seq: 3, attempts: 1, due: '2026-11-09T16:30:00Z', reason: 'not marked' }
  const givenUp = { seq: 3, at: at(1), reason: 'not handled after 4 attempts' }
  const states = {
    new: { cursor: 2, retry: [], failed: [] },
    waiting: { cursor: 3, retry: [waiting], failed: [] },
    'given up on': { cursor: 3, retry: [], failed: [givenUp] },
    done: { cursor: 3, retry: [], failed: [] },
  }
  const orders = { edit: [edit(4)], deletion: [deletion(4)], 'edit, then deletion': [edit(4), deletion(5)], 'deletion, then edit': [deletion(4), edit(5)] }
  // What each gives, as `[items, settled]`, by the message's state and the order of the lines.
  const expected = {
    new: { edit: [[[3, 'new', 1], [4, 'new', 1]], []], deletion: [[[4, 'new', 1]], []], 'edit, then deletion': [[[4, 'new', 1], [5, 'new', 1]], []], 'deletion, then edit': [[[4, 'new', 1], [5, 'new', 1]], []] },
    waiting: { edit: [[[3, 'retry', 2], [4, 'new', 1]], []], deletion: [[[4, 'new', 1]], [3]], 'edit, then deletion': [[[4, 'new', 1], [5, 'new', 1]], [3]], 'deletion, then edit': [[[4, 'new', 1], [5, 'new', 1]], [3]] },
    'given up on': { edit: [[[3, 'failed', 1], [4, 'new', 1]], []], deletion: [[[4, 'new', 1]], [3]], 'edit, then deletion': [[[4, 'new', 1], [5, 'new', 1]], [3]], 'deletion, then edit': [[[4, 'new', 1], [5, 'new', 1]], [3]] },
    done: { edit: [[[4, 'new', 1]], []], deletion: [[[4, 'new', 1]], []], 'edit, then deletion': [[[4, 'new', 1], [5, 'new', 1]], []], 'deletion, then edit': [[[4, 'new', 1], [5, 'new', 1]], []] },
  }
  for (const [stateName, lane] of Object.entries(states)) {
    for (const [orderName, after] of Object.entries(orders)) {
      const lines = [...fillerLines(2), message, ...after]
      const state = { ...initialAgentState(), ...lane }
      const built = build({ lines, state })
      const what = `${stateName}, ${orderName}`
      const [items, settled] = expected[stateName][orderName]
      assert.deepEqual(built.batch.items.map(item => [item.seq, item.origin, item.attempt]), items, what)
      assert.deepEqual(built.batch.settled, settled, what)
      assert.equal(built.batch.covered, lines.at(-1).seq, what)
      // Whatever comes of the run, the message settled has left both lists; and once the batch is
      // marked done, nothing of it waits, nor is it given again.
      for (const outcome of [{ ok: true, done: new Set(items.map(([seq]) => seq)), failed: new Map() }, { ok: false, cause: 'outage', reason: 'x' }, { ok: false, cause: 'other', reason: 'x' }]) {
        const next = settleBatch(state, built.batch, outcome, { now: Date.parse(EXAMPLE_NOW), startedAt: Date.parse(EXAMPLE_NOW), durationMs: 1 }).state
        for (const seq of settled) {
          assert.ok(!next.retry.some(entry => entry.seq === seq), what)
          assert.ok(!next.failed.some(entry => entry.seq === seq), what)
        }
        if (outcome.ok) {
          assert.deepEqual(next.retry, [], what)
          assert.equal(build({ lines, state: next, now: '2026-11-10T00:00:00Z' }), null, what)
        }
      }
    }
  }

  // The deletion comes, in a later batch, also when the batch that gave the message was cut before
  // it, and when the message is deleted before its first batch the cursor passes it.
  const cut = [...fillerLines(2), message]
  for (let seq = 4; seq <= 21; seq++) cut.push(line.text(seq, at(seq), `item ${seq}`))
  cut.push(deletion(22))
  const first = build({ lines: cut.slice(0, -1), state: { ...initialAgentState(), cursor: 2 } })
  assert.deepEqual(seqsOf(first.batch), [3, ...Array.from({ length: 18 }, (_, n) => n + 4)])
  const waitingNow = { ...initialAgentState(), cursor: first.batch.covered, retry: [{ ...waiting, due: at(0) }] }
  const second = build({ lines: cut, state: waitingNow })
  assert.deepEqual(seqsOf(second.batch), [22])
  assert.deepEqual(second.batch.settled, [3])
  const fresh = build({ lines: cut, state: { ...initialAgentState(), cursor: 2 } })
  assert.deepEqual(seqsOf(fresh.batch), [...Array.from({ length: 18 }, (_, n) => n + 4), 22])
  assert.equal(fresh.batch.covered, 22)

  // A message deleted while it waits is due no more, and starts no batch by itself; the batch that
  // gives its deletion settles it.
  const onlyDeleted = build({ lines: [...fillerLines(2), message, deletion(4)], state: { ...initialAgentState(), cursor: 4, retry: [{ ...waiting, due: at(0) }] } })
  assert.equal(onlyDeleted, null)
})

test('batch: an edit brings in its message even past 20 items, and an edit of a message deleted since brings in nothing', () => {
  const many = [...fillerLines(2), line.text(3, '2026-11-09T14:00:00Z', 'coffee 120')]
  for (let seq = 4; seq <= 21; seq++) many.push(line.text(seq, '2026-11-09T15:00:00Z', `item ${seq}`))
  many.push(line.edit(22, '2026-11-09T15:00:00Z', 3, 'coffee 150'), line.text(23, '2026-11-09T15:00:00Z', 'later'))
  const full = build({ lines: many, state: { ...initialAgentState(), cursor: 3, failed: [{ seq: 3, at: '2026-11-09T14:30:00Z', reason: 'x' }], retry: [{ seq: 2, attempts: 1, due: '2026-11-09T15:00:00Z', reason: 'x' }] } })
  assert.equal(full.batch.items.length, 21)
  assert.deepEqual(seqsOf(full.batch).slice(0, 3), [2, 3, 4])
  assert.equal(full.batch.covered, 22)
  assert.match(full.prompt, /^Given before: 2 \(attempt 2 of 4\), 3 \(attempt 1 of 4\)$/m)

  // A message edited and then deleted, in failed: the edit brings nothing back.
  const lines = [...fillerLines(2), line.text(3, '2026-11-09T14:00:00Z', 'coffee 120'), line.edit(4, '2026-11-09T15:00:00Z', 3, 'coffee 150'), line.delete(5, '2026-11-09T15:01:00Z', 3)]
  const index = indexOf(lines)
  const lane = { cursor: 3, retry: [], failed: [{ seq: 3, at: '2026-11-09T14:30:00Z', reason: 'x' }] }
  const { candidates, fresh } = selectCandidates({ agent: AGENT, lane, index, now: Date.parse(EXAMPLE_NOW), upTo: 4 })
  assert.deepEqual(assembleBatch({ agent: AGENT, lane, index, upTo: 4 }, candidates, fresh).items, [{ seq: 4, origin: 'new', attempt: 1 }])
})

test("batch: its prompt is that of the first trigger, in run's order, that names the channel of one of its lines", () => {
  const agent = {
    ...AGENT,
    run: { ...AGENT.run, newMessages: [{ channels: ['email'], prompt: 'Emails: $seq.unread$\n' }, { channels: ['whatsapp'], prompt: 'WhatsApp: $seq.unread$\n' }] },
  }
  const lines = [...fillerLines(2), line.text(3, '2026-11-09T15:00:00Z', 'coffee'), line.email(4, '2026-11-09T15:01:00Z', 'Ticket', 'attached')]
  // An email among the lines: the email trigger's, which comes first, with every line's number.
  assert.equal(build({ lines, state: { ...initialAgentState(), cursor: 2 }, agent }).prompt, 'Emails: 3 4\n')
  // Only WhatsApp's.
  assert.equal(build({ lines: lines.slice(0, 3), state: { ...initialAgentState(), cursor: 2 }, agent }).prompt, 'WhatsApp: 3\n')
  assert.equal(triggerOf(agent, [{ seq: 4 }, { seq: 3 }], indexOf(lines)).prompt, 'Emails: $seq.unread$\n')
})

test("batch: a scheduled task's prompt is its trigger's, with no lines", () => {
  const prompt = scheduledPrompt({ agent: AGENT, prompt: EVERY, paths: PATHS, settings: SETTINGS, now: Date.parse(EXAMPLE_NOW) })
  assert.deepEqual(valuesOf(prompt), {
    now: 'Monday 9 November 2026, 21:20',
    'user.timezone': 'Asia/Kolkata',
    'user.currency': 'INR',
    reply_mode: 'quiet',
    internet: 'off',
    'agent.dir': '/data/agents/lifelog',
    'datastore.dir': '/data/datastore',
    'seq.unread': NONE,
    'seq.retry': NONE,
    'run.writes': '/data/agents/lifelog/views/ /data/agents/lifelog/memory/',
  })
})

test('prompt: its variables, and the longest value each can take, which no prompt filled in passes', t => {
  assert.deepEqual(variablesIn('$now$ $5 $a.b_c$ $$ $1x$ $now$'), ['now', 'a.b_c', 'now'])
  assert.equal(renderPrompt('$now$ $other$', { now: '$&' }), '$& $other$')
  // Times of the owner's day.
  assert.equal(longTime(Date.parse('2026-11-09T15:50:30Z'), 'Asia/Kolkata'), 'Monday 9 November 2026, 21:20')

  // The longest each variable can take: a batch of the most items, each of the largest number, and
  // a time of the longest names.
  atEnd(t, overrideLimits({ BATCH_MAX_ITEMS: 3 }))
  const agent = { ...AGENT, writes: ['agents/lifelog/views/'] }
  // A job's writes, longer than the agent's.
  const job = ['agents/lifelog/views/a.csv', 'agents/lifelog/views/my b.csv']
  const longest = longestValues({ agent, paths: PATHS, settings: SETTINGS, writes: job })
  const big = Number.MAX_SAFE_INTEGER
  const items = [
    ...[0, 1, 2].map(n => ({ seq: big - n, origin: 'new', attempt: 1 })),
    ...[3, 4, 5, 6, 7, 8].map(n => ({ seq: big - n, origin: 'retry', attempt: big })),
  ]
  const filled = promptValues({ agent, paths: PATHS, settings: SETTINGS, now: Date.parse('2026-09-30T18:29:00Z'), items, writes: job })
  assert.equal(filled.now, 'Wednesday 30 September 2026, 23:59')
  for (const name of VARIABLES) assert.ok(Buffer.byteLength(filled[name]) <= longest[name], name)
  for (const name of ['seq.unread', 'seq.retry', 'run.writes', 'user.timezone', 'agent.dir']) assert.equal(Buffer.byteLength(filled[name]), longest[name], name)
  assert.equal(longestPrompt(EVERY, longest), Buffer.byteLength(renderPrompt(EVERY, filled)) + (longest.now - Buffer.byteLength(filled.now)))
  // Half of a pair of surrogates on either side of a variable counts as three bytes, as it is sent.
  assert.equal(longestPrompt('\uD83D$internet$\uDE00', longest), 3 + 3 + 3)
})
