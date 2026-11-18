// Delivery (5.3 of DESIGN.md; section 10, "Delivery"): the outbox processor with fake channels and
// a real store. Order, pacing, chunking, quoting, reactions, `out` lines with the channel's IDs,
// recovery from the bridge's record of an entry, which it keeps in its own folder (D205), waiting,
// failed sends, entries that aren't entries, pausing, and how long a text may be. Routing has its own tests (`routing.test.mjs`), and the WhatsApp module's
// command lines theirs (`whatsapp.test.mjs`).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createOutbox, splitText } from '../src/bridge/outbox.mjs'
import { openStore } from '../src/bridge/store.mjs'
import { createIds, listHandOffs } from '../src/common/files.mjs'
import { limits } from '../src/common/limits.mjs'
import { CUT_NOTE, ENTRY_FILE, SENDING_FILE, textLength, writeOutboxEntry } from '../src/common/outbox.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createFakeChannel } from './support/fake-channel.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { isRoot } from './support/root.mjs'
import { line, writeDatastore } from './support/runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const SECOND = 1000
const START = '2026-11-09T15:50:00Z'
const at = text => Date.parse(text)

// The owner's lines most tests point at: two WhatsApp messages and an email.
const LINES = [
  line.text(1, '2026-11-09T15:40:00Z', 'coffee 150', { sourceId: 'WA1' }),
  line.text(2, '2026-11-09T15:41:00Z', 'lunch 300', { sourceId: 'WA2' }),
  line.email(3, '2026-11-09T15:42:00Z', 'Call with Sam', 'Recording from today.', { sourceId: 'mail-1@example.com' }),
]

// A store over `lines`, the two fake channels, and the processor, started. `outbox` is null until
// `start()` when `started` is false.
function setup(t, { lines = LINES, started = true } = {}) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const clock = createFakeClock(START)
  const { log, entries, events } = createTestLog({ clock })
  writeDatastore(paths, lines)
  const store = openStore({ paths, clock, log })
  const whatsapp = createFakeChannel({ name: 'whatsapp', clock })
  const email = createFakeChannel({ name: 'email', takesCommands: false, canSend: false, canReact: false, clock })
  const channels = new Map([
    ['whatsapp', whatsapp],
    ['email', email],
  ])
  const ids = createIds(clock)
  const fatal = []
  const context = {
    root,
    paths,
    clock,
    log,
    entries,
    events,
    store,
    whatsapp,
    channels,
    fatal,
    outbox: null,
    // Starts a processor, as a bridge starting afresh would.
    start() {
      context.outbox = createOutbox({ paths, store, channels, defaultChannel: 'whatsapp', log, clock, onFatal: error => fatal.push(error) })
      context.outbox.start()
      atEnd(t, () => context.outbox.stop())
      return context.outbox
    },
    write: entry => writeOutboxEntry({ paths, ids, entry }),
    // An entry of the bridge's own, in its own outbox.
    writeOwn: entry => writeOutboxEntry({ paths, ids, entry, outbox: paths.bridgeOutbox }),
    // The entries waiting, by ID: in the runner's outbox, with a record of the bridge's, or in the
    // bridge's own outbox.
    waiting: () => [...new Set([...listHandOffs(paths.outbox), ...records(paths), ...listHandOffs(paths.bridgeOutbox)])].sort(),
    // The lines the store wrote for what went out.
    out: () => [...store.index.entries()].map(entry => entry.line).filter(entry => entry.dir === 'out'),
    // Moves the time on a second at a time until the outbox is empty.
    async drain(limit = 3600) {
      for (let n = 0; n < limit && context.waiting().length > 0; n++) await clock.advance(SECOND)
      await context.outbox.idle()
      assert.deepEqual(context.waiting(), [], 'the outbox should be empty')
    },
  }
  if (started) context.start()
  return context
}

// The IDs of the runner's entries the bridge keeps a record of, in its own folder (D205).
const records = paths => listHandOffs(paths.bridgeSending).map(name => name.replace(/\.json$/, ''))
const recordOf = (paths, id) => JSON.parse(fs.readFileSync(path.join(paths.bridgeSending, `${id}.json`), 'utf8'))

// What a fake channel was asked to send, without the times.
const sendsOf = channel => channel.sends.map(({ at: _, aborted: __, ...rest }) => rest)

test('delivery: entries go out in order, one message every SEND_INTERVAL, each logged as an out line with the channel\'s ID', async t => {
  const { write, drain, whatsapp, out, waiting } = setup(t)
  await write({ type: 'text', by: 'lifelog', text: 'Blue Tokai, ₹450: work or personal?', replyTo: 1 })
  await write({ type: 'react', by: 'lifelog', target: 2, emoji: '✅' })
  await write({ type: 'text', by: 'lifelog', text: 'Logged the lunch.', about: 2 })
  await write({ type: 'text', by: 'runner', text: "⚠️ I couldn't process your last messages (timed out). I'll try again." })
  assert.equal(waiting().length, 4)
  await drain()

  assert.deepEqual(sendsOf(whatsapp), [
    { type: 'text', text: 'Blue Tokai, ₹450: work or personal?', quoteId: 'WA1' },
    { type: 'react', id: 'WA2', emoji: '✅' },
    { type: 'text', text: 'Logged the lunch.', quoteId: null },
    { type: 'text', text: "⚠️ I couldn't process your last messages (timed out). I'll try again.", quoteId: null },
  ])
  // The first at the first look, a second in, and each after it SEND_INTERVAL later.
  assert.deepEqual(
    whatsapp.sends.map(send => send.at - at(START)),
    [1, 6, 11, 16].map(seconds => seconds * SECOND),
  )
  const base = { dir: 'out', source: 'whatsapp' }
  assert.deepEqual(out(), [
    { seq: 4, kind: 'message', ...base, at: '2026-11-09T15:50:01Z', sourceId: 'WHATSAPP-OUT-1', by: 'lifelog', replyTo: 1, text: 'Blue Tokai, ₹450: work or personal?' },
    { seq: 5, kind: 'reaction', ...base, at: '2026-11-09T15:50:06Z', sourceId: 'WHATSAPP-OUT-2', by: 'lifelog', target: 2, emoji: '✅' },
    { seq: 6, kind: 'message', ...base, at: '2026-11-09T15:50:11Z', sourceId: 'WHATSAPP-OUT-3', by: 'lifelog', text: 'Logged the lunch.' },
    { seq: 7, kind: 'message', ...base, at: '2026-11-09T15:50:16Z', sourceId: 'WHATSAPP-OUT-4', by: 'runner', text: "⚠️ I couldn't process your last messages (timed out). I'll try again." },
  ].map(fields => {
    // In the order the store writes a line's fields.
    const { seq, kind, dir, at: time, source, sourceId, by, ...rest } = fields
    return { seq, kind, dir, at: time, source, sourceId, by, ...rest }
  }))
})

test('delivery: a long text goes out in pieces cut at paragraph breaks, and only the first quotes', async t => {
  const { write, drain, whatsapp, out } = setup(t)
  const paragraphs = ['a'.repeat(3000), 'b'.repeat(3000), 'c'.repeat(1000)]
  await write({ type: 'text', by: 'lifelog', text: paragraphs.join('\n\n'), replyTo: 1 })
  await drain()
  assert.deepEqual(
    sendsOf(whatsapp).map(send => [send.text, send.quoteId]),
    [
      [paragraphs[0], 'WA1'],
      [paragraphs[1], null],
      [paragraphs[2], null],
    ],
  )
  assert.deepEqual(
    out().map(entry => [entry.replyTo, entry.text.length, entry.sourceId]),
    [
      [1, 3000, 'WHATSAPP-OUT-1'],
      [undefined, 3000, 'WHATSAPP-OUT-2'],
      [undefined, 1000, 'WHATSAPP-OUT-3'],
    ],
  )
})

test('delivery: splitText cuts at a paragraph, a line, a space or the limit, never over it, and keeps characters whole', () => {
  assert.deepEqual(splitText('short', 10), ['short'])
  assert.deepEqual(splitText('one two\n\nthree four', 12), ['one two', 'three four'])
  // A line break in the second half is taken when there is no paragraph break there.
  assert.deepEqual(splitText('abcdefg\nhijk lmn', 10), ['abcdefg', 'hijk lmn'])
  // Then a space.
  assert.deepEqual(splitText('abcdefg hijklmn', 10), ['abcdefg', 'hijklmn'])
  // A break in the first half isn't used: the piece would be less than half full.
  assert.deepEqual(splitText('ab cdefghijklmnop', 10), ['ab cdefghi', 'jklmnop'])
  // A character is a code point: an emoji counts once, and isn't split.
  assert.deepEqual(splitText('😀'.repeat(15), 10), ['😀'.repeat(10), '😀'.repeat(5)])
  // Blank lines where it was cut, and pieces of nothing but spaces, are left out.
  assert.deepEqual(splitText('abcdefgh\n\n\n\n\n\n\n\n\n\n\n\n   ', 10), ['abcdefgh'])
  // With CRLF line breaks.
  assert.deepEqual(splitText('abcdef\r\n\r\nghij', 10), ['abcdef', 'ghij'])
  // Many random texts: no piece over the limit, and nothing but the breaks lost.
  let seed = 7
  const random = n => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    return seed % n
  }
  const alphabet = ['a', 'b', ' ', '\n', '😀', 'é']
  for (let round = 0; round < 200; round++) {
    const text = Array.from({ length: 1 + random(400) }, () => alphabet[random(alphabet.length)]).join('')
    const max = 5 + random(60)
    const pieces = splitText(text, max)
    for (const piece of pieces) assert.ok(textLength(piece) <= max, `${JSON.stringify(piece)} is over ${max}`)
    const squash = value => value.replace(/\s+/g, '')
    assert.equal(squash(pieces.join('')), squash(text))
  }
})

test('delivery: after a crash, only the messages the record doesn\'t count as sent go out again', async t => {
  const context = setup(t)
  const { write, whatsapp, clock, paths, waiting, out } = context
  const parts = ['first '.repeat(500).trim(), 'second '.repeat(500).trim(), 'third '.repeat(500).trim()]
  const id = await write({ type: 'text', by: 'lifelog', text: parts.join('\n\n'), replyTo: 1 })
  // The first goes out; the second fails, and the bridge stops before it tries again, as a crash
  // would leave it.
  whatsapp.failNext(null, { code: 'EWACLI' })
  await clock.advance(SECOND)
  await clock.advance(limits.SEND_INTERVAL)
  await context.outbox.stop()
  assert.deepEqual(recordOf(paths, id), {
    entry: { type: 'text', by: 'lifelog', text: parts.join('\n\n'), replyTo: 1 },
    sent: 1,
  })
  // The bridge wrote nothing in the runner's outbox: the entry is as the runner left it.
  assert.deepEqual(fs.readdirSync(path.join(paths.outbox, id)), [ENTRY_FILE])

  // A bridge starting afresh sends the second and the third, and the first not again.
  context.start()
  await context.drain()
  assert.deepEqual(
    sendsOf(whatsapp).map(send => [send.text.split(' ')[0], send.quoteId, send.failed ?? false]),
    [
      ['first', 'WA1', false],
      ['second', null, true],
      ['second', null, false],
      ['third', null, false],
    ],
  )
  assert.deepEqual(
    out().map(entry => entry.text.split(' ')[0]),
    ['first', 'second', 'third'],
  )
  assert.deepEqual(waiting(), [])
  assert.deepEqual(fs.readdirSync(paths.bridgeSending), [])
})

test('delivery: a record left by a crash is sent from where it counts, a reaction again from the start, and wins over the entry\'s folder', async t => {
  const context = setup(t, { started: false })
  const { paths, whatsapp, out } = context
  // A runner's entry the bridge had taken: the record in the bridge's folder, and, unless it was
  // removed already, the entry's folder in the runner's outbox.
  const leave = (id, value, { folder = true } = {}) => {
    fs.mkdirSync(paths.bridgeSending, { recursive: true })
    fs.writeFileSync(path.join(paths.bridgeSending, `${id}.json`), JSON.stringify(value))
    if (!folder) return
    fs.mkdirSync(path.join(paths.outbox, id), { recursive: true })
    // What the runner's user may have put there since: the record wins.
    fs.writeFileSync(path.join(paths.outbox, id, ENTRY_FILE), JSON.stringify({ type: 'text', by: 'lifelog', text: 'changed since' }))
  }
  const text = ['one', 'two', 'three'].map(word => `${word} `.repeat(500).trim()).join('\n\n')
  leave('20261109T154000000-0001', { entry: { type: 'text', by: 'lifelog', text, about: 2 }, sent: 2 })
  leave('20261109T154000000-0002', { entry: { type: 'react', by: 'lifelog', target: 1, emoji: '✅' }, sent: 0 })
  // All of it was sent and recorded; the folder was removed, and the record left.
  leave('20261109T154000000-0003', { entry: { type: 'text', by: 'runner', text: 'done already' }, sent: 1 }, { folder: false })
  // All of it was sent and recorded; only the folder was left.
  leave('20261109T154000000-0004', { entry: { type: 'text', by: 'runner', text: 'done too' }, sent: 1 })
  // One of the bridge's own, in its own outbox, with its record in its folder.
  fs.mkdirSync(path.join(paths.bridgeOutbox, '20261109T154000000-0005'), { recursive: true })
  fs.writeFileSync(path.join(paths.bridgeOutbox, '20261109T154000000-0005', SENDING_FILE), JSON.stringify({ entry: { type: 'text', by: 'bridge', text: 'own one\n\n'.repeat(1) + 'x '.repeat(2000).trim(), about: 1 }, sent: 1 }))
  context.start()
  await context.drain()
  assert.deepEqual(
    sendsOf(whatsapp).map(send => send.text?.split(' ')[0] ?? send.emoji),
    ['three', '✅', 'x'],
  )
  assert.deepEqual(
    out().map(entry => entry.kind),
    ['message', 'reaction', 'message'],
  )
  assert.deepEqual(fs.readdirSync(paths.bridgeSending), [])
  assert.deepEqual(fs.readdirSync(paths.outbox), [])
  assert.deepEqual(fs.readdirSync(paths.bridgeOutbox), [])
})

test('delivery: the bridge\'s own entries go out from its own outbox, in order with the runner\'s', async t => {
  const { write, writeOwn, drain, whatsapp, paths } = setup(t)
  await write({ type: 'text', by: 'lifelog', text: 'first, from the runner', about: 1 })
  const own = await writeOwn({ type: 'text', by: 'bridge', text: 'second, from the bridge', about: 2 })
  await write({ type: 'text', by: 'lifelog', text: 'third, from the runner', about: 1 })
  assert.deepEqual(fs.readdirSync(paths.bridgeOutbox), [own])
  await drain()
  assert.deepEqual(
    sendsOf(whatsapp).map(send => send.text),
    ['first, from the runner', 'second, from the bridge', 'third, from the runner'],
  )
  assert.deepEqual(fs.readdirSync(paths.bridgeOutbox), [])
})

test('delivery: an entry the runner\'s user swaps for a link once the bridge has taken it leads the bridge to write nothing there', async t => {
  const context = setup(t)
  const { write, whatsapp, clock, paths, root } = context
  // As root, the bridge would otherwise write where the link leads (D136's cost, settled by D205):
  // a folder of root's, which the runner's user can't write itself.
  const elsewhere = path.join(root, 'elsewhere')
  fs.mkdirSync(elsewhere, { mode: 0o700 })
  fs.writeFileSync(path.join(elsewhere, 'kept'), 'kept')
  const parts = ['first '.repeat(500).trim(), 'second '.repeat(500).trim()]
  const id = await write({ type: 'text', by: 'lifelog', text: parts.join('\n\n'), about: 1 })
  // The first message goes out; then the entry's folder is swapped for a link to that folder.
  await clock.advance(SECOND)
  assert.equal(whatsapp.sends.length, 1)
  fs.renameSync(path.join(paths.outbox, id), path.join(root, 'moved-away'))
  fs.symlinkSync(elsewhere, path.join(paths.outbox, id))
  for (let n = 0; n < 30; n++) await clock.advance(SECOND)
  // The rest went out, from the bridge's record.
  assert.deepEqual(sendsOf(whatsapp).map(send => send.text.split(' ')[0]), ['first', 'second'])
  // Nothing was written, or removed, where the link leads; the link is left, as what isn't a
  // folder is, and said once; the record is gone, since nothing of the entry is left to take.
  assert.deepEqual(fs.readdirSync(elsewhere), ['kept'])
  assert.deepEqual(fs.readdirSync(path.join(root, 'moved-away')), [ENTRY_FILE])
  assert.deepEqual(fs.readdirSync(paths.bridgeSending), [])
  assert.deepEqual(context.entries.filter(entry => entry.event === 'outbox.not_removed').map(entry => [entry.entry, entry.code]), [[id, 'ENOTDIR']])
})

test('delivery: entries wait while their channel isn\'t ready, and so do the ones after them', async t => {
  const { write, drain, whatsapp, clock, waiting, events } = setup(t)
  whatsapp.setReady(false)
  await write({ type: 'text', by: 'lifelog', text: 'first', about: 1 })
  await write({ type: 'text', by: 'runner', text: 'second' })
  for (let n = 0; n < 60; n++) await clock.advance(SECOND)
  assert.deepEqual(whatsapp.sends, [])
  assert.equal(waiting().length, 2)
  // Said once, not every second.
  assert.equal(events().filter(event => event === 'outbox.waiting').length, 1)
  whatsapp.setReady(true)
  await drain()
  assert.deepEqual(
    sendsOf(whatsapp).map(send => send.text),
    ['first', 'second'],
  )
})

test('delivery: a failed send is tried again after waits that double, without its quote from the middle try on, passed over after SEND_ATTEMPTS, and given up on once another goes and its next try fails', async t => {
  const { write, drain, whatsapp, entries, out } = setup(t)
  // Eight failures, then one that works, then the last try of the first entry fails too.
  whatsapp.failNext(...Array.from({ length: limits.SEND_ATTEMPTS }, () => ({ code: 'EWACLI' })), null, { code: 'EWACLI' })
  const failing = await write({ type: 'text', by: 'lifelog', text: 'Work or personal?', replyTo: 1 })
  await write({ type: 'text', by: 'runner', text: 'the next one' })
  await drain()

  assert.deepEqual(
    whatsapp.sends.map(send => [send.text, send.quoteId, send.failed ?? false]),
    [
      ...Array.from({ length: 4 }, () => ['Work or personal?', 'WA1', true]),
      ...Array.from({ length: 4 }, () => ['Work or personal?', null, true]),
      ['the next one', null, false],
      // Its last try, once a message of another entry has shown that the channel works.
      ['Work or personal?', null, true],
    ],
  )
  // Each wait at least the one before it doubled, from 5 seconds, up to 5 minutes.
  const tries = whatsapp.sends.slice(0, limits.SEND_ATTEMPTS)
  const gaps = tries.slice(1).map((send, n) => send.at - tries[n].at)
  const waits = [5, 10, 20, 40, 80, 160, 300].map(seconds => seconds * SECOND)
  gaps.forEach((gap, n) => assert.ok(gap >= waits[n] && gap < waits[n] + 2 * SECOND, `wait ${n + 1}: ${gap} ms`))
  // Passed over, then given up on, each logged.
  assert.deepEqual(
    entries.filter(entry => ['outbox.passed_over', 'outbox.given_up'].includes(entry.event)).map(entry => [entry.event, entry.entry, entry.failures, entry.by]),
    [
      ['outbox.passed_over', failing, limits.SEND_ATTEMPTS, 'lifelog'],
      ['outbox.given_up', failing, limits.SEND_ATTEMPTS + 1, 'lifelog'],
    ],
  )
  assert.deepEqual(
    out().map(entry => entry.text),
    ['the next one'],
  )
  // Nothing of the text is in the log.
  assert.ok(!JSON.stringify(entries).includes('personal'))
})

test('delivery: an outage gives up on nothing: entries passed over wait, and all go, in order, once sends work again', async t => {
  const { write, drain, whatsapp, clock, entries, out, waiting } = setup(t)
  whatsapp.failAll({ code: 'EWACLI' })
  for (const text of ['one', 'two', 'three', 'four', 'five', 'six']) await write({ type: 'text', by: 'lifelog', text, about: 1 })
  // The case of the review of milestone 5: every send fails for an hour, the channel ready.
  for (let n = 0; n < 3600; n++) await clock.advance(SECOND)
  assert.equal(waiting().length, 6)
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.given_up'), [])
  assert.ok(entries.filter(entry => entry.event === 'outbox.passed_over').length >= 1)
  // Each entry is tried SEND_ATTEMPTS times, with waits that grow, and then every five minutes,
  // while the next ramps up; and before each try of an entry behind ones passed over, those are
  // tried again, so that they would go first. About 140 tries in the hour, never two within
  // SEND_INTERVAL.
  assert.ok(whatsapp.sends.length > 110 && whatsapp.sends.length < 170, `${whatsapp.sends.length} tries`)
  whatsapp.sends.slice(1).forEach((send, n) => assert.ok(send.at - whatsapp.sends[n].at >= limits.SEND_INTERVAL))

  whatsapp.failAll(null)
  await drain()
  assert.deepEqual(
    out().map(entry => entry.text),
    ['one', 'two', 'three', 'four', 'five', 'six'],
  )
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.given_up'), [])
})

// Whether the outbox is between two looks, so that none is trying an entry.
async function betweenLooks(outbox) {
  let done = false
  outbox.idle().then(() => (done = true))
  await new Promise(resolve => setImmediate(resolve))
  return done
}

test('delivery: after an outage of any length the entries go in order: those passed over are tried before an entry behind them', async t => {
  // The review of milestone 6, smaller point 1: an entry behind one passed over, which came due
  // first, went first, after 7 of these 30 lengths.
  for (const minutes of Array.from({ length: 30 }, (_, n) => 5 + 3 * n)) {
    await t.test(`${minutes} minutes`, async t => {
      const { write, drain, whatsapp, clock, entries, out, outbox } = setup(t)
      whatsapp.failAll({ code: 'EWACLI' })
      for (const text of ['one', 'two', 'three', 'four']) await write({ type: 'text', by: 'lifelog', text, about: 1 })
      for (let n = 0; n < minutes * 60; n++) await clock.advance(SECOND)
      // Sends work again from a moment when no look is trying an entry (the next test has one
      // that is).
      while (!(await betweenLooks(outbox))) await clock.advance(SECOND)
      whatsapp.failAll(null)
      await drain()
      assert.deepEqual(
        out().map(entry => entry.text),
        ['one', 'two', 'three', 'four'],
      )
      assert.deepEqual(entries.filter(entry => entry.event === 'outbox.given_up'), [])
    })
  }
})

test('delivery: when sends work again in the middle of a look, the entry tried then goes first, and nothing is given up', async t => {
  const { write, drain, whatsapp, clock, entries, out, outbox } = setup(t)
  whatsapp.failAll({ code: 'EWACLI' })
  for (const text of ['one', 'two']) await write({ type: 'text', by: 'lifelog', text, about: 1 })
  // Until both are passed over, and a look has tried `one` and is waiting to try `two`.
  const passedOver = () => entries.filter(entry => entry.event === 'outbox.passed_over').length
  while (passedOver() < 2) await clock.advance(SECOND)
  const tries = whatsapp.sends.length
  let found = false
  for (let n = 0; n < 3600 && !found; n++) {
    await clock.advance(SECOND)
    found = whatsapp.sends.length > tries && whatsapp.sends.at(-1).text === 'one' && !(await betweenLooks(outbox))
  }
  assert.ok(found, 'a look that tried one, and has two to try')
  whatsapp.failAll(null)
  await drain()
  // `two` showed that sends work, so `one` had its last try, which worked.
  assert.deepEqual(
    out().map(entry => entry.text),
    ['two', 'one'],
  )
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.given_up'), [])
})

test('delivery: an entry passed over with nothing behind it holds nothing back, and is tried again every five minutes', async t => {
  const { write, drain, whatsapp, clock, entries, out } = setup(t)
  whatsapp.failAll({ code: 'EWACLI' })
  await write({ type: 'text', by: 'lifelog', text: 'alone', replyTo: 1 })
  for (let n = 0; n < 3600; n++) await clock.advance(SECOND)
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.given_up'), [])
  const tries = whatsapp.sends.length
  assert.ok(tries > limits.SEND_ATTEMPTS && tries < limits.SEND_ATTEMPTS + 12, `${tries} tries`)
  whatsapp.failAll(null)
  await drain()
  // Without its quote, as from the middle try on.
  assert.deepEqual(
    out().map(entry => [entry.text, entry.replyTo]),
    [['alone', undefined]],
  )
})

test('delivery: a failure that leaves the channel not ready isn\'t counted against the entry', async t => {
  const { write, drain, whatsapp, clock, entries } = setup(t)
  whatsapp.failNext({ code: 'EWACLI', unready: true })
  await write({ type: 'text', by: 'lifelog', text: 'hello', about: 1 })
  await clock.advance(SECOND)
  assert.deepEqual(
    entries.filter(entry => entry.event === 'outbox.send_failed').map(entry => entry.failures),
    [0],
  )
  whatsapp.setReady(true)
  await drain()
  assert.equal(whatsapp.sends.filter(send => !send.failed).length, 1)
})

test('delivery: an entry that isn\'t one is logged and removed, and the next goes; what isn\'t a folder is left, and logged once', async t => {
  const context = setup(t, { started: false })
  const { paths, whatsapp, entries, root } = context
  const folder = name => {
    fs.mkdirSync(path.join(paths.outbox, name), { recursive: true })
    return path.join(paths.outbox, name)
  }
  fs.writeFileSync(path.join(folder('20261109T150000000-0001'), ENTRY_FILE), '{"type":')
  const secret = path.join(root, 'secret.json')
  fs.writeFileSync(secret, JSON.stringify({ type: 'text', by: 'lifelog', text: 'a file the runner could not read' }))
  fs.symlinkSync(secret, path.join(folder('20261109T150000000-0002'), ENTRY_FILE))
  fs.writeFileSync(path.join(folder('20261109T150000000-0003'), ENTRY_FILE), JSON.stringify({ type: 'text', by: 'lifelog', text: 'x'.repeat(limits.OUTBOX_ENTRY_MAX_BYTES) }))
  fs.writeFileSync(path.join(folder('20261109T150000000-0004'), ENTRY_FILE), JSON.stringify({ type: 'text', by: 'lifelog', text: 'hi', to: 'someone else' }))
  fs.writeFileSync(path.join(folder('20261109T150000000-0005'), ENTRY_FILE), JSON.stringify({ type: 'text', by: 'lifelog', text: 'y'.repeat(limits.TEXT_MAX_CHARS + 1) }))
  fs.mkdirSync(paths.bridgeSending, { recursive: true })
  fs.writeFileSync(path.join(paths.bridgeSending, '20261109T150000000-0006.json'), JSON.stringify({ entry: { type: 'react', by: 'lifelog', target: 1, emoji: '✅' }, sent: -1 }))
  folder('20261109T150000000-0007')
  fs.writeFileSync(path.join(paths.outbox, '20261109T150000000-0008'), 'a file, not a folder')
  await context.write({ type: 'text', by: 'runner', text: 'the real one' })
  context.start()
  for (let n = 0; n < 30; n++) await context.clock.advance(SECOND)
  assert.deepEqual(
    sendsOf(whatsapp).map(send => send.text),
    ['the real one'],
  )
  // The bridge removes only an entry's own files, by name: the file stays, for its writer to
  // remove, and the bridge doesn't say so again at every look.
  assert.deepEqual(context.waiting(), ['20261109T150000000-0008'])
  assert.deepEqual(
    entries.filter(entry => entry.event === 'outbox.refused').map(entry => entry.reason),
    [
      'entry.json is not JSON',
      "entry.json can't be read (EUNTRUSTED)",
      "entry.json can't be read (EFBIG)",
      "entry.json: to doesn't belong on a text entry",
      `entry.json: text must be at most ${limits.TEXT_MAX_CHARS} characters`,
      '20261109T150000000-0006.json: sent must be a whole number, 0 or more',
      'there is no entry.json',
      'the entry is not a folder',
    ],
  )
  // The file the link led to is untouched.
  assert.ok(fs.existsSync(secret))
})

test('delivery: an outbox the runner\'s user made a link is not looked into, and nothing the link leads to is removed', async t => {
  const context = setup(t, { started: false })
  const { paths, root, entries, whatsapp, clock } = context
  // As the runner's user could make the outbox lead to the data folder (the review of milestone 6,
  // smaller point 4): folders as the data folder holds them, and one named as an entry is.
  const elsewhere = path.join(root, 'elsewhere')
  for (const name of ['agents', 'datastore', '20261109T150000000-0001']) {
    fs.mkdirSync(path.join(elsewhere, name), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, name, 'kept'), 'kept')
  }
  fs.mkdirSync(paths.exchange, { recursive: true })
  fs.symlinkSync(elsewhere, paths.outbox)
  // A record of a runner's entry, whose removal would reach through the link, and an entry of the
  // bridge's own, such as its reply to `/status`.
  fs.mkdirSync(paths.bridgeSending, { recursive: true })
  fs.writeFileSync(path.join(paths.bridgeSending, '20261109T150000000-0001.json'), JSON.stringify({ entry: { type: 'text', by: 'lifelog', text: 'from the record' }, sent: 0 }))
  await context.writeOwn({ type: 'text', by: 'bridge', text: 'the reply to /status', about: 2 })
  context.start()
  for (let n = 0; n < 30; n++) await clock.advance(SECOND)
  for (const name of ['agents', 'datastore', '20261109T150000000-0001']) assert.ok(fs.existsSync(path.join(elsewhere, name, 'kept')), name)
  // The bridge's own entry goes, while nothing of the runner's does, its record included (D226).
  assert.deepEqual(sendsOf(whatsapp).map(send => send.text), ['the reply to /status'])
  assert.deepEqual(fs.readdirSync(paths.bridgeSending), ['20261109T150000000-0001.json'])
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.failed'), [])
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.runner_outbox_refused').map(entry => entry.reason), ['not used: a symbolic link'])
  // While there is no outbox, nothing is said to be taken from it (the review of milestone 13,
  // smaller point 5); once it is a folder again, the record goes, and that is said.
  fs.unlinkSync(paths.outbox)
  for (let n = 0; n < 3; n++) await clock.advance(SECOND)
  assert.equal(context.events().filter(event => event === 'outbox.runner_outbox_taken').length, 0)
  fs.mkdirSync(paths.outbox, { mode: 0o700 })
  for (let n = 0; n < 10; n++) await clock.advance(SECOND)
  assert.deepEqual(sendsOf(whatsapp).map(send => send.text), ['the reply to /status', 'from the record'])
  assert.equal(context.events().filter(event => event === 'outbox.runner_outbox_taken').length, 1)
})

test("delivery: a name in the runner's outbox that isn't an entry's ID is left, and said once, and the entries after it go", async t => {
  const context = setup(t, { started: false })
  const { paths, whatsapp, entries, clock } = context
  // The review of milestone 12, smaller point 3: a valid entry in a folder whose name is too long
  // for the bridge's record once `.json` and a temporary prefix are added.
  const entry = JSON.stringify({ type: 'text', by: 'lifelog', text: 'not taken', about: 1 })
  for (const name of ['x'.repeat(240), '20261109T150000000-0001-more', 'notes']) {
    fs.mkdirSync(path.join(paths.outbox, name), { recursive: true })
    fs.writeFileSync(path.join(paths.outbox, name, ENTRY_FILE), entry)
  }
  await context.write({ type: 'text', by: 'lifelog', text: 'the real one', about: 1 })
  context.start()
  for (let n = 0; n < 30; n++) await clock.advance(SECOND)
  assert.deepEqual(sendsOf(whatsapp).map(send => send.text), ['the real one'])
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.failed'), [])
  assert.deepEqual(
    entries.filter(entry => entry.event === 'outbox.not_an_entry').map(entry => entry.bytes).sort((a, b) => a - b),
    [5, 28, 240],
  )
  for (const name of ['x'.repeat(240), '20261109T150000000-0001-more', 'notes']) assert.deepEqual(fs.readdirSync(path.join(paths.outbox, name)), [ENTRY_FILE])
  assert.deepEqual(fs.readdirSync(paths.bridgeSending), [])
})

test("delivery: in the runner's outbox the bridge removes only entry.json; in its own, also its sending.json", async t => {
  const { write, writeOwn, whatsapp, clock, paths, entries } = setup(t)
  // A runner's entry with what an older bridge left in it (D205's cost), and one of the bridge's own.
  const id = await write({ type: 'text', by: 'lifelog', text: 'the runner\'s', about: 1 })
  for (const name of [SENDING_FILE, `.tmp-${SENDING_FILE}-1`]) fs.writeFileSync(path.join(paths.outbox, id, name), '{}')
  const own = await writeOwn({ type: 'text', by: 'bridge', text: 'the bridge\'s', about: 2 })
  for (let n = 0; n < 30; n++) await clock.advance(SECOND)
  assert.deepEqual(sendsOf(whatsapp).map(send => send.text), ["the runner's", "the bridge's"])
  assert.deepEqual(fs.readdirSync(path.join(paths.outbox, id)).sort(), [`.tmp-${SENDING_FILE}-1`, SENDING_FILE])
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.not_removed').map(entry => [entry.entry, entry.code]), [[id, 'ENOTEMPTY']])
  assert.equal(fs.existsSync(path.join(paths.bridgeOutbox, own)), false)
})

test('delivery: an entry is removed by the names one holds; one holding anything else is left once sent, and said once', async t => {
  const { write, whatsapp, clock, paths, entries, waiting } = setup(t)
  const id = await write({ type: 'text', by: 'lifelog', text: 'hello', about: 1 })
  fs.writeFileSync(path.join(paths.outbox, id, 'notes.txt'), 'not a name an entry holds')
  await write({ type: 'text', by: 'lifelog', text: 'and the next', about: 1 })
  for (let n = 0; n < 30; n++) await clock.advance(SECOND)
  assert.deepEqual(sendsOf(whatsapp).map(send => send.text), ['hello', 'and the next'])
  assert.deepEqual(waiting(), [id])
  assert.deepEqual(fs.readdirSync(path.join(paths.outbox, id)), ['notes.txt'])
  assert.deepEqual(entries.filter(entry => entry.event === 'outbox.not_removed').map(entry => [entry.entry, entry.code]), [[id, 'ENOTEMPTY']])
})

test('delivery: pause stops it between two messages, until resume', async t => {
  const { write, drain, whatsapp, clock, outbox, paths } = setup(t)
  const id = await write({ type: 'text', by: 'lifelog', text: ['one', 'two', 'three'].map(word => `${word} `.repeat(500).trim()).join('\n\n') })
  await clock.advance(SECOND)
  assert.equal(whatsapp.sends.length, 1)
  // Paused while it waits to send the second.
  const pausing = outbox.pause()
  await clock.advance(limits.SEND_INTERVAL)
  await pausing
  for (let n = 0; n < 30; n++) await clock.advance(SECOND)
  assert.equal(whatsapp.sends.length, 1)
  assert.equal(recordOf(paths, id).sent, 1)
  outbox.resume()
  await drain()
  assert.equal(whatsapp.sends.length, 3)
})

test('delivery: a text over TEXT_MAX_CHARS is cut when it is written, and goes out in a few messages', async t => {
  const { write, drain, whatsapp, paths, out } = setup(t)
  const id = await write({ type: 'text', by: 'lifelog', text: 'word '.repeat(200_000) })
  const written = JSON.parse(fs.readFileSync(path.join(paths.outbox, id, ENTRY_FILE), 'utf8'))
  assert.ok(textLength(written.text) <= limits.TEXT_MAX_CHARS && textLength(written.text) > limits.TEXT_MAX_CHARS - 10)
  assert.ok(written.text.endsWith(CUT_NOTE))
  await drain()
  assert.ok(whatsapp.sends.length <= 2 * Math.ceil(limits.TEXT_MAX_CHARS / limits.CHUNK_CHARS), `${whatsapp.sends.length} messages`)
  assert.ok(out().at(-1).text.endsWith(CUT_NOTE.trim()))
})

test('delivery: a message the channel gives no ID for is logged without one', async t => {
  const { write, drain, whatsapp, out, events } = setup(t)
  whatsapp.noIdNext()
  await write({ type: 'react', by: 'lifelog', target: 1, emoji: '✅' })
  await drain()
  assert.equal(out()[0].sourceId, undefined)
  assert.ok(events().includes('outbox.no_id'))
})

test('delivery: a message whose ID the store already holds is logged without one, and the next goes', async t => {
  const { write, drain, whatsapp, out, entries } = setup(t)
  // As a channel that answered with the ID of the message it reacted to (the review of milestone
  // 5, point 4): the reaction went out, and is recorded.
  whatsapp.idsNext('WA1', 'WA2')
  await write({ type: 'react', by: 'lifelog', target: 1, emoji: '✅' })
  await write({ type: 'text', by: 'lifelog', text: 'about the lunch', about: 2 })
  await write({ type: 'text', by: 'lifelog', text: 'and one more', about: 2 })
  await drain()
  assert.deepEqual(
    out().map(line => [line.kind, line.sourceId, line.text ?? line.emoji]),
    [
      ['reaction', undefined, '✅'],
      ['message', undefined, 'about the lunch'],
      ['message', 'WHATSAPP-OUT-1', 'and one more'],
    ],
  )
  assert.deepEqual(
    entries.filter(entry => entry.event === 'outbox.id_taken').map(entry => entry.reason),
    ['duplicate', 'duplicate'],
  )
})

test('delivery: an entry with U+0000 in its text is refused at once, not tried SEND_ATTEMPTS times', async t => {
  const context = setup(t, { started: false })
  const { paths, whatsapp, entries } = context
  fs.mkdirSync(path.join(paths.outbox, '20261109T150000000-0001'), { recursive: true })
  fs.writeFileSync(path.join(paths.outbox, '20261109T150000000-0001', ENTRY_FILE), JSON.stringify({ type: 'text', by: 'lifelog', text: 'a\u0000b' }))
  await context.write({ type: 'text', by: 'runner', text: 'the next one' })
  context.start()
  await context.drain(10)
  assert.deepEqual(
    sendsOf(whatsapp).map(send => send.text),
    ['the next one'],
  )
  assert.deepEqual(
    entries.filter(entry => entry.event === 'outbox.refused').map(entry => entry.reason),
    ["entry.json: text can't hold U+0000"],
  )
})

test('delivery: when the store takes no more lines, the message counts as sent and the bridge is told', async t => {
  const context = setup(t)
  const { write, whatsapp, clock, store, fatal, paths } = context
  // As after a write that failed (D29).
  store.append = async () => {
    throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
  }
  const id = await write({ type: 'text', by: 'lifelog', text: ['one', 'two'].map(word => `${word} `.repeat(500).trim()).join('\n\n') })
  await clock.advance(SECOND)
  for (let n = 0; n < 30; n++) await clock.advance(SECOND)
  assert.equal(whatsapp.sends.length, 1)
  assert.equal(fatal.length, 1)
  // Restarted, the bridge doesn't send it again.
  assert.equal(recordOf(paths, id).sent, 1)
})

const notAsRoot = { skip: isRoot ? 'root writes a folder whatever its mode' : false }

test('delivery: nothing goes out that the record can\'t hold, and the look is tried again after waits that grow', notAsRoot, async t => {
  const context = setup(t)
  const { write, whatsapp, clock, paths, entries } = context
  const id = await write({ type: 'text', by: 'lifelog', text: 'hello', about: 1 })
  // The bridge's folder of records can't be written, as a full disk can't.
  fs.mkdirSync(paths.bridgeSending, { recursive: true })
  fs.chmodSync(paths.bridgeSending, 0o500)
  atEnd(t, () => fs.existsSync(paths.bridgeSending) && fs.chmodSync(paths.bridgeSending, 0o700))
  for (let n = 0; n < 40; n++) await clock.advance(SECOND)
  assert.deepEqual(whatsapp.sends, [])
  const failures = entries.filter(entry => entry.event === 'outbox.failed')
  // At 1 s, then 5, 10 and 20 seconds later: not every second.
  assert.equal(failures.length, 4)
  assert.deepEqual(
    failures.map(entry => entry.failures),
    [1, 2, 3, 4],
  )
  fs.chmodSync(paths.bridgeSending, 0o700)
  await context.drain()
  assert.equal(whatsapp.sends.length, 1)
  assert.equal(fs.existsSync(path.join(paths.outbox, id)), false)
})
