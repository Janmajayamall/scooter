// The batch and its prompt: the example prompt, the two
// limits, context lines and reply labels, emails, and an edit or deletion bringing in its message.

import assert from 'node:assert/strict'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { buildBatch, buildTaskPrompt, headerFor } from '../src/runner/batch.mjs'
import { cutText, renderBatchPrompt } from '../src/runner/prompt.mjs'
import { EXAMPLE_NOW, EXAMPLE_PROMPT, exampleLines, exampleState, fillerLines, indexOf, line } from './support/runner.mjs'

const PATHS = makePaths({ dataDir: '/data', configDir: '/config' })
const AGENT = { name: 'lifelog', reads: ['whatsapp', 'email'], replyMode: 'quiet', run: { newMessages: true, scheduled: [], backfill: [] } }
const HEADER = `[scooter] Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.
Your folder: /data/agents/lifelog. Attachments are in /data/datastore (read-only).`

function build({ lines, state = initialAgentState(), now = EXAMPLE_NOW, agent = AGENT, timeZone = 'Asia/Kolkata', internet = false }) {
  return buildBatch({ agent, state, index: indexOf(lines), paths: PATHS, now: Date.parse(now), timeZone, homeCurrency: 'INR', internet })
}

// The prompt without its two header lines and the blank line after them.
const body = prompt => prompt.split('\n').slice(3).join('\n')
const bytes = text => Buffer.byteLength(text)
const seqsOf = batch => batch.items.map(item => item.seq)

test('batch: the example prompt, exactly as the runner\'s document shows it', () => {
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
    context: [1048, 1049],
    covered: 1054,
    newest: 1054,
  })
})

test('batch: the header says the mode, the internet setting and the currency', () => {
  const { prompt } = build({ lines: exampleLines(), state: exampleState(), agent: { ...AGENT, replyMode: 'confirm' }, internet: true })
  assert.equal(prompt.split('\n')[0], '[scooter] Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: confirm. Internet: on.')
})

test('batch: nothing to give the agent is no batch', () => {
  assert.equal(build({ lines: exampleLines(), state: { ...exampleState(), cursor: 1054, retry: [] } }), null)
  // A retry that isn't due yet waits.
  assert.equal(build({ lines: exampleLines(), state: { ...exampleState(), cursor: 1054, retry: [{ seq: 1047, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'x' }] } }), null)
})

test('batch: at most 20 items, retries first, and the cursor stops before the first one left', () => {
  // 3 due retries, then 25 new messages with a reply, a reaction and an email the agent doesn't
  // read among them.
  const lines = [...fillerLines(10)]
  for (let seq = 11; seq <= 40; seq++) {
    if (seq === 25) lines.push(line.sent(seq, '2026-11-09T15:00:00Z', 'Noted.'))
    else if (seq === 26) lines.push(line.reaction(seq, '2026-11-09T15:00:00Z', 24, '👍'))
    else if (seq === 27) lines.push(line.email(seq, '2026-11-09T15:00:00Z', 'Hi', 'not read'))
    else lines.push(line.text(seq, '2026-11-09T15:00:00Z', `item ${seq}`))
  }
  const retry = [3, 1, 2].map(seq => ({ seq, attempts: 2, due: '2026-11-09T15:00:00Z', reason: 'not reported' }))
  const { batch, prompt } = build({ lines, state: { ...initialAgentState(), cursor: 10, retry }, agent: { ...AGENT, reads: ['whatsapp'] } })
  assert.equal(batch.items.length, limits.BATCH_MAX_ITEMS)
  assert.deepEqual(seqsOf(batch).slice(0, 3), [1, 2, 3])
  assert.deepEqual(batch.items.slice(0, 3).map(item => [item.origin, item.attempt]), [['retry', 3], ['retry', 3], ['retry', 3]])
  // The 17 new ones are #11 to #24 and #28 to #30; #31 is the first left for later.
  assert.deepEqual(seqsOf(batch).slice(3), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 28, 29, 30])
  assert.equal(batch.covered, 30)
  assert.equal(batch.newest, 30)
  // The context is the sent message and the reaction; the email is passed over.
  assert.deepEqual(batch.context, [25, 26])
  assert.ok(!prompt.includes('not read'))
  assert.equal(prompt.split('\n').filter(text => text.startsWith('#')).length, 22)
})

test('batch: the batch stops growing at the prompt\'s size limit, and always keeps one item', () => {
  // Ten messages of 15 KB each: six fit in 96 KB with the header.
  const lines = [...fillerLines(2)]
  for (let seq = 3; seq <= 12; seq++) lines.push(line.text(seq, '2026-11-09T15:00:00Z', 'x'.repeat(15 * 1024)))
  const { batch, prompt } = build({ lines, state: { ...initialAgentState(), cursor: 2 } })
  assert.deepEqual(seqsOf(batch), [3, 4, 5, 6, 7, 8])
  assert.equal(batch.covered, 8)
  assert.ok(bytes(prompt) <= limits.PROMPT_MAX_BYTES)
  assert.ok(!prompt.includes('(cut;'))

  // With a limit below even one of them, the first is shown cut, and says where the rest is.
  const restore = overrideLimits({ PROMPT_MAX_BYTES: 4096 })
  try {
    const small = build({ lines, state: { ...initialAgentState(), cursor: 2 } })
    assert.deepEqual(seqsOf(small.batch), [3])
    assert.equal(small.batch.covered, 3)
    assert.ok(bytes(small.prompt) <= 4096, `${bytes(small.prompt)}`)
    // Its line is the first of 9 November's log: the filler is in 8 November's.
    assert.match(small.prompt, /\n#3 20:30 text: "x+" \(cut; the whole text is line 1 of \/data\/datastore\/2026\/11\/09\/log\.jsonl\)$/)
  } finally {
    restore()
  }
})

test('batch: an over-long text points at the line it is in, or at the whole email', () => {
  const restore = overrideLimits({ PROMPT_MAX_BYTES: 2048 })
  try {
    const long = 'ü'.repeat(3000)
    // An edited message shows its latest text, which is in the edit's line.
    const lines = [...fillerLines(2), line.text(3, '2026-11-09T15:00:00Z', 'short'), line.edit(4, '2026-11-09T15:01:00Z', 3, long)]
    const first = build({ lines, state: { ...initialAgentState(), cursor: 2 } })
    assert.ok(bytes(first.prompt) <= 2048)
    assert.match(first.prompt, /\n#3 20:30 text: "ü+" \(cut; the whole text is line 2 of \/data\/datastore\/2026\/11\/09\/log\.jsonl\) \(edited in #4\)$/)
    // The edit itself didn't fit beside it, and comes in the next batch.
    assert.deepEqual([seqsOf(first.batch), first.batch.covered], [[3], 3])
    const second = build({ lines, state: { ...initialAgentState(), cursor: 3 } })
    assert.match(second.prompt, /\n#4 20:31 edit of #3, now: "ü+" \(cut; the whole text is line 2 of \/data\/datastore\/2026\/11\/09\/log\.jsonl\)$/)

    const email = [...fillerLines(2), line.email(3, '2026-11-09T16:12:40Z', 'Booking', long, { files: [{ path: '3.eml', mime: 'message/rfc822', bytes: 9000 }] })]
    const mail = build({ lines: email, state: { ...initialAgentState(), cursor: 2 } }).prompt
    assert.ok(bytes(mail) <= 2048)
    assert.match(mail, /#3 21:42 email "Booking": "ü+" \(cut; the whole email is \/data\/datastore\/2026\/11\/09\/3\.eml\)\n      whole email \/data\/datastore\/2026\/11\/09\/3\.eml$/)
    // A cut never splits a character.
    assert.equal(cutText('aü€😀', 5), 'aü')
    assert.equal(cutText('aü€😀', 9), 'aü€')
    assert.equal(cutText('😀😀', 7), '😀')
    assert.equal(cutText('😀😀', 8), '😀😀')
  } finally {
    restore()
  }
})

test('batch: with a long context, its oldest lines are left out first, and an over-long item keeps what context fits', () => {
  // A message from long ago, in `failed`, is brought in by an edit; 300 replies were sent since.
  const day = '2026/11/09'
  const lines = [...fillerLines(2), { ...line.text(3, '2026-11-01T10:00:00Z', 'coffee 120'), day }]
  for (let seq = 4; seq < 304; seq++) lines.push({ ...line.sent(seq, '2026-11-05T10:00:00Z', `reply number ${seq} `.repeat(25)), day })
  lines.push(line.edit(304, '2026-11-09T15:00:00Z', 3, 'coffee 150'))
  const state = { ...initialAgentState(), cursor: 303, failed: [{ seq: 3, at: '2026-11-01T10:05:00Z', reason: 'unreadable' }] }
  const { batch, prompt } = build({ lines, state })
  assert.deepEqual(batch.items, [
    { seq: 3, origin: 'failed', attempt: 1 },
    { seq: 304, origin: 'new', attempt: 1 },
  ])
  assert.equal(batch.context.length, 300)
  assert.ok(bytes(prompt) <= limits.PROMPT_MAX_BYTES)
  const contextLines = prompt.split('For context only (no action, no DONE):\n')[1].split('\n')
  // The newest are kept, newest first, and the rest are counted.
  assert.match(contextLines[0], /^#303 Thu 5 Nov 15:30 you sent: "reply number 303 /)
  const kept = contextLines.filter(text => text.startsWith('#')).length
  assert.ok(kept > 100 && kept < 300, `${kept}`)
  assert.equal(contextLines.at(-1), `(${300 - kept} older lines left out: the prompt would have been too long)`)
  assert.match(prompt, /#3 Sun 1 Nov 15:30 text: "coffee 150" \(edited in #304\) \(attempt 1 of 4\)/)

  // An item too long on its own is cut, and the context stays, since there is room for it then.
  const restore = overrideLimits({ PROMPT_MAX_BYTES: 4096 })
  try {
    const few = [...fillerLines(2), line.text(3, '2026-11-09T15:00:00Z', 'y'.repeat(9000)), line.sent(4, '2026-11-09T15:01:00Z', 'Which café?')]
    const cut = build({ lines: few, state: { ...initialAgentState(), cursor: 2 } })
    assert.deepEqual(cut.batch.context, [4])
    assert.ok(bytes(cut.prompt) <= 4096)
    assert.match(cut.prompt, /\n#3 20:30 text: "y+" \(cut; the whole text is line 1 of /)
    assert.match(cut.prompt, /For context only \(no action, no DONE\):\n#4 20:31 you sent: "Which café\?"$/)
  } finally {
    restore()
  }
})

test('batch: whatever the texts, the prompt keeps within its limit and has an item', () => {
  const restore = overrideLimits({ PROMPT_MAX_BYTES: 3000 })
  try {
    let seed = 7
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pieces = ['a', 'ü', '€', '😀', '\n', '"', '\\', '\u0001']
    const text = length => Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join('')
    for (let round = 0; round < 40; round++) {
      const lines = [...fillerLines(2)]
      let seq = 3
      const count = 1 + Math.floor(random() * 30)
      for (let n = 0; n < count; n++) {
        const length = Math.floor(random() * (random() < 0.2 ? 5000 : 200))
        const kind = random()
        if (kind < 0.25) lines.push(line.sent(seq, '2026-11-09T15:00:00Z', text(length + 1)))
        else if (kind < 0.35) lines.push(line.email(seq, '2026-11-09T15:00:00Z', text(30), text(length), { files: [{ path: `${seq}.eml`, mime: 'message/rfc822', bytes: 10 }] }))
        else lines.push(line.text(seq, '2026-11-09T15:00:00Z', text(length), seq > 3 && random() < 0.3 ? { replyTo: seq - 1, quoted: text(length) } : {}))
        seq += 1
      }
      if (!lines.some(entry => entry.dir === 'in' && entry.seq > 2)) lines.push(line.text(seq, '2026-11-09T15:00:00Z', text(4000)))
      const result = build({ lines, state: { ...initialAgentState(), cursor: 2 } })
      assert.ok(bytes(result.prompt) <= 3000, `round ${round}: ${bytes(result.prompt)} bytes`)
      assert.ok(result.batch.items.length >= 1)
      assert.ok(result.prompt.includes('\nNew messages:\n#'), `round ${round}`)
    }
    // The last resort: an email with so many attachments that even its paths are too long.
    const files = [{ path: '3.eml', mime: 'message/rfc822', bytes: 10 }, ...Array.from({ length: 200 }, (_, n) => ({ path: `3-${n + 2}.pdf`, mime: 'application/pdf', name: `part ${n}.pdf`, bytes: 10 }))]
    const flood = build({ lines: [...fillerLines(2), line.email(3, '2026-11-09T15:00:00Z', 'Parts', 'All of them.', { files })], state: { ...initialAgentState(), cursor: 2 } })
    assert.ok(bytes(flood.prompt) <= 3000)
    assert.ok(flood.prompt.endsWith('\n(The rest of this prompt was cut: it was too long.)'))
  } finally {
    restore()
  }
})

test('batch: an item too long on its own is cut as little as will do, also where a text fits whole', () => {
  const max = 800
  const restore = overrideLimits({ PROMPT_MAX_BYTES: max })
  try {
    const now = Date.parse(EXAMPLE_NOW)
    const view = { paths: PATHS, agentName: 'lifelog', now, timeZone: 'Asia/Kolkata', header: headerFor({ agent: AGENT, paths: PATHS, now, timeZone: 'Asia/Kolkata', homeCurrency: 'INR', internet: false }) }
    let oneWhole = 0
    // An item that quotes a message, so two texts are cut. The quoted one's length passes through
    // the stretch where it fits whole, and just below, cut and with its note, it doesn't.
    for (let length = 100; length < 400; length += 3) {
      const lines = [...fillerLines(2), line.text(3, '2026-11-09T14:00:00Z', 'q'.repeat(length)), line.text(4, '2026-11-09T15:00:00Z', 'o'.repeat(700), { replyTo: 3 })]
      const result = build({ lines, state: { ...initialAgentState(), cursor: 3 } })
      const index = indexOf(lines)
      // Every cap, from the highest down: the first that fits is the least cut.
      let best = null
      for (let cap = max; cap >= 0 && best === null; cap--) {
        const prompt = renderBatchPrompt(result.batch, { ...view, index }, { itemCap: cap, contextKeep: 0 })
        if (bytes(prompt) <= max) best = prompt
      }
      assert.equal(result.prompt, best, `a quoted text of ${length} bytes`)
      if ((best.match(/\(cut; /g) ?? []).length === 1) oneWhole += 1
    }
    assert.ok(oneWhole > 0)
  } finally {
    restore()
  }
})

test('batch: context lines and reply labels', () => {
  const lines = [
    ...fillerLines(1),
    line.text(2, '2026-11-09T14:00:00Z', 'coffee 120'),
    line.sent(3, '2026-11-09T14:00:30Z', 'Which café?', { replyTo: 2 }),
    { ...line.sent(4, '2026-11-09T14:01:00Z', "⚠️ I couldn't process your last messages (timed out). I'll try again."), by: 'runner' },
    line.text(5, '2026-11-09T14:02:00Z', '', { files: [{ path: '5.jpg', mime: 'image/jpeg', bytes: 10 }] }),
    line.text(6, '2026-11-09T14:03:00Z', 'gone'),
    line.delete(7, '2026-11-09T14:04:00Z', 6),
    // From here on, after the cursor.
    line.text(8, '2026-11-09T15:00:00Z', 'Blue Tokai', { replyTo: 3, quoted: 'Which café?' }),
    line.text(9, '2026-11-09T15:01:00Z', 'what?', { replyTo: 4, quoted: '⚠️ I couldn…' }),
    line.text(10, '2026-11-09T15:02:00Z', 'that was lunch', { replyTo: 5 }),
    line.text(11, '2026-11-09T15:03:00Z', 'never mind', { replyTo: 6, quoted: 'gone' }),
    line.text(12, '2026-11-09T15:04:00Z', 'about my old message', { quoted: 'from before Scooter' }),
    line.text(13, '2026-11-09T15:05:00Z', 'read this', { forwarded: true }),
    line.reaction(14, '2026-11-09T15:06:00Z', 3, '❤️'),
    line.reaction(15, '2026-11-09T15:07:00Z', 3, ''),
    { ...line.reaction(16, '2026-11-09T15:08:00Z', 8, '✅'), dir: 'out', trust: undefined, by: 'lifelog' },
    line.sent(17, '2026-11-09T15:09:00Z', 'Noted:\n"two lines"', { replyTo: 13 }),
    // A text such as /new is a message like any other, and so is what a reply quotes of it.
    line.text(18, '2026-11-09T15:10:00Z', '/new'),
    line.text(19, '2026-11-09T15:11:00Z', 'after it'),
    line.text(20, '2026-11-09T15:12:00Z', 'that one', { replyTo: 18, quoted: '/new' }),
    // A reply to a line that isn't a message, which only a damaged datastore has, shows the
    // channel's preview if it has one.
    line.text(21, '2026-11-09T15:13:00Z', 'odd', { replyTo: 14, quoted: 'a heart' }),
    line.text(22, '2026-11-09T15:14:00Z', 'odder', { replyTo: 15 }),
  ].map(entry => JSON.parse(JSON.stringify(entry)))
  const { batch, prompt } = build({ lines, state: { ...initialAgentState(), cursor: 7 } })
  assert.deepEqual(seqsOf(batch), [8, 9, 10, 11, 12, 13, 18, 19, 20, 21, 22])
  assert.equal(
    body(prompt),
    `New messages:
#8 20:30 text: "Blue Tokai"
      ↳ reply to #3, which you sent: "Which café?"
#9 20:31 text: "what?"
      ↳ reply to #4, which Scooter sent: "⚠️ I couldn't process your last messages (timed out). I'll try again."
#10 20:32 text: "that was lunch"
      ↳ reply to #5, which the owner sent: photo /data/datastore/2026/11/09/5.jpg (image/jpeg)
#11 20:33 text: "never mind"
      ↳ reply to #6, which the owner sent: (deleted in #7)
#12 20:34 text: "about my old message"
      ↳ reply to an earlier message: "from before Scooter"
#13 20:35 forwarded text: "read this"
#18 20:40 text: "/new"
#19 20:41 text: "after it"
#20 20:42 text: "that one"
      ↳ reply to #18, which the owner sent: "/new"
#21 20:43 text: "odd"
      ↳ reply to #14: "a heart"
#22 20:44 text: "odder"
      ↳ reply to #15

For context only (no action, no DONE):
#17 20:39 you sent, in reply to #13: "Noted:\\n\\"two lines\\""
#16 20:38 you reacted ✅ to #8
#15 20:37 the owner removed their reaction to #3
#14 20:36 the owner reacted ❤️ to #3`,
  )
})

test('batch: emails, media and attachments in the prompt', () => {
  const lines = [
    ...fillerLines(2),
    // The example email of `docs/architecture/datastore.md`, as `runner.md` shows it in a prompt.
    line.email(3, '2026-11-09T16:12:40Z', 'Call with Sam', "Recording from today's call.", {
      files: [
        { path: '3.eml', mime: 'message/rfc822', bytes: 19262388 },
        { path: '3-2.m4a', mime: 'audio/mp4', name: 'Call with Sam.m4a', bytes: 14206977 },
      ],
    }),
    // An email that couldn't be read is stored with its .eml and why.
    line.email(4, '2026-11-09T16:13:00Z', '', '', { files: [{ path: '4.eml', mime: 'message/rfc822', bytes: 900 }], media: { type: 'email', error: 'could not be parsed' } }),
    line.text(5, '2026-11-09T16:14:00Z', 'receipt', { media: { type: 'image', mime: 'image/jpeg', error: 'download failed' } }),
    line.text(6, '2026-11-09T16:15:00Z', 'Blue Tokai', { media: { type: 'location', error: 'not a file, so not stored' } }),
    line.text(7, '2026-11-09T16:16:00Z', '', { files: [{ path: '7.mp4', mime: 'video/mp4', bytes: 10 }] }),
    line.text(8, '2026-11-09T16:17:00Z', 'voice', { files: [{ path: '8.ogg', mime: 'audio/ogg; codecs=opus', bytes: 10 }] }),
    // A message caught up from yesterday, and one from last year, arriving today.
    { ...line.text(9, '2026-11-08T05:00:00Z', 'yesterday'), day: '2026/11/09' },
    { ...line.text(10, '2025-12-31T05:00:00Z', 'last year'), day: '2026/11/09' },
  ]
  const { prompt } = build({ lines, state: { ...initialAgentState(), cursor: 2 }, now: '2026-11-09T16:20:00Z' })
  assert.equal(
    body(prompt),
    `New messages:
#3 21:42 email "Call with Sam": "Recording from today's call."
      attachment "Call with Sam.m4a" /data/datastore/2026/11/09/3-2.m4a (audio/mp4)
      whole email /data/datastore/2026/11/09/3.eml
#4 21:43 email "": ""
      whole email /data/datastore/2026/11/09/4.eml
      email not stored (could not be parsed)
#5 21:44 photo, not stored (download failed), caption: "receipt"
#6 21:45 location, not stored (not a file, so not stored), caption: "Blue Tokai"
#7 21:46 video /data/datastore/2026/11/09/7.mp4 (video/mp4)
#8 21:47 audio /data/datastore/2026/11/09/8.ogg ("audio/ogg; codecs=opus"), caption: "voice"
#9 Sun 8 Nov 10:30 text: "yesterday"
#10 Wed 31 Dec 2025 10:30 text: "last year"`,
  )
})

test('batch: an edit or deletion brings in its message from retry or failed, shown as it is now', () => {
  const lines = [
    ...fillerLines(2),
    line.text(3, '2026-11-09T14:00:00Z', 'coffee 120'),
    line.text(4, '2026-11-09T14:01:00Z', 'taxi 300'),
    line.text(5, '2026-11-09T14:02:00Z', 'lunch 400'),
    line.text(6, '2026-11-09T14:03:00Z', 'unrelated'),
    line.edit(7, '2026-11-09T15:00:00Z', 3, 'coffee 150'),
    line.delete(8, '2026-11-09T15:01:00Z', 4),
    line.edit(9, '2026-11-09T15:02:00Z', 5, 'lunch 450'),
  ]
  const state = {
    ...initialAgentState(),
    cursor: 6,
    // #3 waits, not due yet; #4 failed for good; #5 was handled, and is in neither.
    retry: [{ seq: 3, attempts: 2, due: '2026-11-09T16:00:00Z', reason: 'not reported' }],
    failed: [{ seq: 4, at: '2026-11-09T14:30:00Z', reason: 'not handled after 4 attempts' }],
  }
  const { batch, prompt } = build({ lines, state })
  assert.deepEqual(batch.items, [
    { seq: 3, origin: 'retry', attempt: 3 },
    { seq: 4, origin: 'failed', attempt: 1 },
    { seq: 7, origin: 'new', attempt: 1 },
    { seq: 8, origin: 'new', attempt: 1 },
    { seq: 9, origin: 'new', attempt: 1 },
  ])
  assert.equal(
    body(prompt),
    `New messages:
#7 20:30 edit of #3, now: "coffee 150"
#8 20:31 deletion of #4
#9 20:32 edit of #5, now: "lunch 450"

Retrying (not handled yet):
#3 19:30 text: "coffee 150" (edited in #7) (attempt 3 of 4)
#4 19:31 (deleted in #8) (attempt 1 of 4)`,
  )

  // They come in even when they take the batch past 20 items.
  const many = [...fillerLines(2), line.text(3, '2026-11-09T14:00:00Z', 'coffee 120')]
  for (let seq = 4; seq <= 21; seq++) many.push(line.text(seq, '2026-11-09T15:00:00Z', `item ${seq}`))
  many.push(line.edit(22, '2026-11-09T15:00:00Z', 3, 'coffee 150'), line.text(23, '2026-11-09T15:00:00Z', 'later'))
  const full = build({ lines: many, state: { ...initialAgentState(), cursor: 3, failed: [{ seq: 3, at: '2026-11-09T14:30:00Z', reason: 'x' }], retry: [{ seq: 2, attempts: 1, due: '2026-11-09T15:00:00Z', reason: 'x' }] } })
  assert.equal(full.batch.items.length, 21)
  assert.deepEqual(seqsOf(full.batch).slice(0, 3), [2, 3, 4])
  assert.equal(full.batch.covered, 22)
})

test('batch: a scheduled task is its task, with no messages', () => {
  const prompt = buildTaskPrompt({
    agent: AGENT,
    task: 'Evening check-in. List in a few lines what you filed today.\n',
    paths: PATHS,
    now: Date.parse(EXAMPLE_NOW),
    timeZone: 'Asia/Kolkata',
    homeCurrency: 'INR',
    internet: false,
  })
  assert.equal(prompt, `${HEADER}\n\nScheduled task (from your configuration, not a message from the owner):\nEvening check-in. List in a few lines what you filed today.`)
})
