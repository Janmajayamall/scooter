// pi's answer (6.7 of DESIGN.md; section 10, "Answer parsing"): every instruction line, text
// segments, unknown `seq` numbers, and what is sent.

import assert from 'node:assert/strict'
import test from 'node:test'
import { overrideLimits } from '../src/common/limits.mjs'
import { NO_REASON, answerEntries, droppedTexts, parseAnswer, replyTarget, reportsOf, shortReason } from '../src/runner/answer.mjs'
import { indexOf, line } from './support/runner.mjs'
import { atEnd } from './support/tmp.mjs'

const LINES = [
  line.text(1, '2026-11-09T15:00:00Z', 'coffee 120'),
  line.sent(2, '2026-11-09T15:00:10Z', 'Which café?', { replyTo: 1 }),
  line.text(3, '2026-11-09T15:01:00Z', 'Blue Tokai', { replyTo: 2 }),
  line.edit(4, '2026-11-09T15:02:00Z', 1, 'coffee 150'),
  line.text(5, '2026-11-09T15:03:00Z', 'gone soon'),
  line.delete(6, '2026-11-09T15:04:00Z', 5),
  line.reaction(7, '2026-11-09T15:05:00Z', 2, '👍'),
  line.command(8, '2026-11-09T15:06:00Z', '/status'),
  line.text(9, '2026-11-09T15:07:00Z', 'lunch 300'),
]
const index = indexOf(LINES)
const AGENT = { name: 'lifelog', canMessage: true, replyMode: 'quiet', ackReaction: '✅' }

test('answer parsing: every instruction line', () => {
  const answer = parseAnswer(
    [
      'DONE: 1050 #1051',
      '  DONE:1052,#1053 , 1050  ',
      'FAILED: 1054 unreadable PDF',
      'FAILED: #1055   blurry   photo  ',
      'FAILED: 1056',
      'NO_REPLY',
      '',
    ].join('\n'),
  )
  assert.deepEqual(answer.done, [1050, 1051, 1052, 1053])
  assert.deepEqual(answer.failed, [
    { seq: 1054, reason: 'unreadable PDF' },
    { seq: 1055, reason: 'blurry photo' },
    { seq: 1056, reason: NO_REASON },
  ])
  assert.equal(answer.noReply, true)
  assert.deepEqual(answer.messages, [])
  assert.equal(answer.unreadable, 0)
})

test('answer parsing: text segments, before the first REPLY_TO and after each', () => {
  const answer = parseAnswer(
    [
      'Logged the run and the coffee.',
      '',
      '- *coffee*: ₹150',
      'REPLY_TO: 1042',
      'Blue Tokai, ₹450 at 12:40:',
      'work or personal?',
      'REPLY_TO: #1050',
      '   ',
      'REPLY_TO: 1051',
      '  Is that _lunch_ with Sam?  ',
      'DONE: 1042 1050 1051',
      '',
    ].join('\n'),
  )
  assert.deepEqual(answer.messages, [
    { replyTo: null, text: 'Logged the run and the coffee.\n\n- *coffee*: ₹150' },
    { replyTo: 1042, text: 'Blue Tokai, ₹450 at 12:40:\nwork or personal?' },
    // The empty one, to #1050, is dropped.
    { replyTo: 1051, text: 'Is that _lunch_ with Sam?' },
  ])
  assert.deepEqual(answer.done, [1042, 1050, 1051])
  assert.equal(answer.noReply, false)

  // pi prints the model's last message and a line break, and a Windows line end is no different.
  assert.deepEqual(parseAnswer('Noted.\r\nDONE: 7\r\n').messages, [{ replyTo: null, text: 'Noted.' }])
  assert.deepEqual(parseAnswer(''), { done: [], failed: [], messages: [], noReply: false, unreadable: 0 })
})

test('answer parsing: an instruction that can\'t be read is never sent as text', () => {
  const answer = parseAnswer(['DONE: 1050 soon 1051', 'FAILED: the PDF', 'REPLY_TO: the coffee', 'Which café?', 'done: 1052', 'DONE 1053'].join('\n'))
  assert.deepEqual(answer.done, [1050, 1051])
  assert.deepEqual(answer.failed, [])
  assert.equal(answer.unreadable, 3)
  // A REPLY_TO that names no number starts a message of its own, sent without a quote. Lines that
  // only look like instructions, in another case or without the colon, are text.
  assert.deepEqual(answer.messages, [{ replyTo: null, text: 'Which café?\ndone: 1052\nDONE 1053' }])
})

test('answer parsing: unknown seq numbers are ignored, and an item reported both ways counts as failed', () => {
  const answer = parseAnswer('DONE: 1 3 77\nFAILED: 3 changed my mind\nFAILED: 88 not in the batch\nDONE: 1\n')
  const reports = reportsOf(answer, [1, 3, 9])
  assert.deepEqual([...reports.done], [1])
  assert.deepEqual([...reports.failed], [[3, 'changed my mind']])
  assert.deepEqual(reports.unknown, [77, 88])
})

test('answer parsing: a reason from outside is one line, cut at REASON_MAX_CHARS', t => {
  atEnd(t, overrideLimits({ REASON_MAX_CHARS: 10 }))
  assert.equal(shortReason('  two\n lines '), 'two lines')
  assert.equal(shortReason('0123456789'), '0123456789')
  assert.equal(shortReason('0123456789ab'), '012345678…')
  assert.equal(shortReason('😀😀😀😀😀😀😀😀😀😀😀'), '😀😀😀😀😀😀😀😀😀…')
  assert.deepEqual(parseAnswer('FAILED: 4 0123456789abcdef').failed, [{ seq: 4, reason: '012345678…' }])
})

test('answer parsing: a long line takes time in step with its length (the fifth review of milestone 4)', () => {
  const started = performance.now()
  const spaces = ' '.repeat(1024 * 1024)
  const numbers = Array.from({ length: 160_000 }, (_, n) => n + 1)
  const answer = parseAnswer(
    [
      // A carriage return and U+2028, which `.` alone doesn't take, after a megabyte of spaces.
      `FAILED: 1${spaces}a\rb\u2028c`,
      `DONE: ${numbers.join(' ')}`,
      ...numbers.map(n => `FAILED: ${n} again`),
    ].join('\n'),
  )
  const ms = performance.now() - started
  assert.deepEqual(answer.failed[0], { seq: 1, reason: 'a b c' })
  assert.equal(answer.failed.length, 160_000)
  assert.equal(answer.done.length, 160_000)
  // Before, the first line took about 17 minutes, and the second about 9 seconds.
  assert.ok(ms < 5000, `${Math.round(ms)} ms`)
})

test('answer: what a REPLY_TO quotes', () => {
  assert.equal(replyTarget(index, 1), 1)
  assert.equal(replyTarget(index, 2), 2)
  // An edit or a deletion: the message it changes.
  assert.equal(replyTarget(index, 4), 1)
  assert.equal(replyTarget(index, 6), 5)
  // A reaction, a command, or a number that doesn't exist: nothing.
  assert.equal(replyTarget(index, 7), null)
  assert.equal(replyTarget(index, 8), null)
  assert.equal(replyTarget(index, 99), null)
})

test('answer: the texts in order, then a ✅ for each message done that no REPLY_TO answered', () => {
  const answer = parseAnswer(['Logged the lunch.', 'REPLY_TO: 3', 'Blue Tokai it is.', 'REPLY_TO: 99', 'Which one?', 'DONE: 1 3 4 5 9'].join('\n'))
  const done = reportsOf(answer, [1, 3, 4, 5, 9]).done
  assert.deepEqual(answerEntries({ answer, agent: AGENT, index, about: 9, done }), [
    { type: 'text', by: 'lifelog', text: 'Logged the lunch.', about: 9 },
    { type: 'text', by: 'lifelog', text: 'Blue Tokai it is.', replyTo: 3 },
    // #99 doesn't exist: no quote, and about the newest item, like plain text.
    { type: 'text', by: 'lifelog', text: 'Which one?', about: 9 },
    // #3 got a reply instead; #4 is an edit, and #5 was deleted since.
    { type: 'react', by: 'lifelog', target: 1, emoji: '✅' },
    { type: 'react', by: 'lifelog', target: 9, emoji: '✅' },
  ])

  // A reply to an edit quotes its message, which then gets no reaction.
  const toEdit = parseAnswer('REPLY_TO: 4\nNow ₹150.\nDONE: 1 4')
  assert.deepEqual(answerEntries({ answer: toEdit, agent: AGENT, index, about: 4, done: new Set([1, 4]) }), [
    { type: 'text', by: 'lifelog', text: 'Now ₹150.', replyTo: 1 },
  ])

  // A scheduled task's text is Scooter's own: no `about`.
  assert.deepEqual(answerEntries({ answer: parseAnswer('Evening: all filed.'), agent: AGENT, index }), [{ type: 'text', by: 'lifelog', text: 'Evening: all filed.' }])
})

test('answer: NO_REPLY sends no text, and its items still get their reaction', () => {
  const answer = parseAnswer('REPLY_TO: 3\nOK?\nNO_REPLY\nDONE: 3 9')
  assert.deepEqual(answerEntries({ answer, agent: AGENT, index, about: 9, done: new Set([3, 9]) }), [
    { type: 'react', by: 'lifelog', target: 3, emoji: '✅' },
    { type: 'react', by: 'lifelog', target: 9, emoji: '✅' },
  ])
})

test('answer: confirm mode reacts to nothing, "" reacts to nothing, and can_message: false sends nothing', () => {
  const answer = parseAnswer('Logged the lunch.\nDONE: 9')
  const done = new Set([9])
  assert.deepEqual(answerEntries({ answer, agent: { ...AGENT, replyMode: 'confirm' }, index, about: 9, done }), [
    { type: 'text', by: 'lifelog', text: 'Logged the lunch.', about: 9 },
  ])
  assert.deepEqual(answerEntries({ answer, agent: { ...AGENT, ackReaction: '' }, index, about: 9, done }), [
    { type: 'text', by: 'lifelog', text: 'Logged the lunch.', about: 9 },
  ])
  assert.deepEqual(answerEntries({ answer, agent: { ...AGENT, canMessage: false }, index, about: 9, done }), [])
})

test('answer: at most ANSWER_MAX_TEXTS texts are sent, and a message whose reply was dropped gets its reaction', () => {
  // 30 texts: a question about #1 first, then 28 more, then a question about #9 past the limit.
  const lines = ['REPLY_TO: 1', 'Which café?']
  for (let n = 0; n < 28; n++) lines.push(`REPLY_TO: 999${n}`, `Text ${n}`)
  lines.push('REPLY_TO: 9', 'Lunch with whom?', 'DONE: 1 9')
  const answer = parseAnswer(lines.join('\n'))
  assert.equal(answer.messages.length, 30)
  const entries = answerEntries({ answer, agent: AGENT, index, about: 9, done: new Set([1, 9]) })
  const texts = entries.filter(entry => entry.type === 'text')
  assert.equal(texts.length, 25)
  assert.deepEqual(texts[0], { type: 'text', by: 'lifelog', text: 'Which café?', replyTo: 1 })
  assert.equal(texts.at(-1).text, 'Text 23')
  assert.deepEqual(entries.filter(entry => entry.type === 'react'), [{ type: 'react', by: 'lifelog', target: 9, emoji: '✅' }])
  assert.equal(droppedTexts(answer, AGENT), 5)
  // NO_REPLY, or can_message: false, sends none, so drops none.
  assert.equal(droppedTexts(parseAnswer(`${lines.join('\n')}\nNO_REPLY`), AGENT), 0)
  assert.equal(droppedTexts(answer, { ...AGENT, canMessage: false }), 0)
})
