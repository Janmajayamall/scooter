// Outbox entries: their format, and writing one as a folder handed over whole.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createIds } from '../src/common/files.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { CUT_NOTE, checkOutboxEntry, checkSendingFile, cutText, textLength, writeOutboxEntry } from '../src/common/outbox.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createFakeClock } from './support/clock.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

// Four example entries.
const EXAMPLES = [
  { type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'Blue Tokai, ₹450 at 12:40: work or personal?', replyTo: 1042 },
  { type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'Logged the run and the coffee.', about: 1061 },
  { type: 'text', by: 'runner', text: "⚠️ I couldn't process your last messages (timeout). I'll try again." },
  { type: 'react', by: 'lifelog', channels: ['whatsapp'], target: 1044, emoji: '✅' },
]

const modeOf = file => fs.statSync(file).mode & 0o7777

test('outbox: the four examples are entries', () => {
  for (const entry of EXAMPLES) assert.deepEqual(checkOutboxEntry(entry), [], JSON.stringify(entry))
})

test('outbox: what isn\'t an entry, by field', () => {
  const cases = [
    [null, 'not an object'],
    [{ type: 'file', by: 'lifelog' }, 'type must be one of text, react'],
    [{ type: 'text', text: 'x' }, 'by is missing'],
    [{ type: 'text', by: 'lifelog', channels: ['whatsapp'], text: ' \n' }, "text must be a string that isn't empty"],
    [{ type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'x', replyTo: 0 }, 'replyTo must be a seq'],
    [{ type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'x', replyTo: 1, about: 2 }, "replyTo and about can't both be given"],
    [{ type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'x', to: 'someone' }, "to doesn't belong on a text entry"],
    [{ type: 'react', by: 'lifelog', channels: ['whatsapp'], target: 1044 }, 'emoji is missing'],
    [{ type: 'react', by: 'lifelog', channels: ['whatsapp'], target: 1044, emoji: '✅', text: 'x' }, "text doesn't belong on a react entry"],
  ]
  for (const [entry, problem] of cases) assert.ok(checkOutboxEntry(entry).includes(problem), `${problem}: ${JSON.stringify(checkOutboxEntry(entry))}`)
})

test("outbox: an agent's entry carries the channels its sends names, and the runner's and the bridge's carry none", () => {
  const channels = 'channels must be a list of the channels it may go out on, whatsapp or email, each once'
  const cases = [
    // An entry of an agent's without them, as a runner of before agents had sends wrote one.
    [{ type: 'text', by: 'lifelog', text: 'x', about: 1 }, 'channels is missing'],
    [{ type: 'react', by: 'lifelog', target: 1, emoji: '✅' }, 'channels is missing'],
    [{ type: 'text', by: 'lifelog', channels: [], text: 'x' }, channels],
    [{ type: 'text', by: 'lifelog', channels: ['sms'], text: 'x' }, channels],
    [{ type: 'text', by: 'lifelog', channels: ['whatsapp', 'whatsapp'], text: 'x' }, channels],
    [{ type: 'text', by: 'lifelog', channels: 'whatsapp', text: 'x' }, channels],
    [{ type: 'text', by: 'runner', channels: ['whatsapp'], text: 'x' }, "channels doesn't belong on an entry of the runner's own"],
    [{ type: 'text', by: 'bridge', channels: ['whatsapp'], text: 'x' }, "channels doesn't belong on an entry of the bridge's own"],
  ]
  for (const [entry, problem] of cases) assert.ok(checkOutboxEntry(entry).includes(problem), `${problem}: ${JSON.stringify(checkOutboxEntry(entry))}`)
  for (const entry of [
    { type: 'text', by: 'lifelog', channels: ['email', 'whatsapp'], text: 'x' },
    { type: 'text', by: 'runner', text: 'x' },
    { type: 'text', by: 'bridge', text: 'x' },
  ]) {
    assert.deepEqual(checkOutboxEntry(entry), [], JSON.stringify(entry))
  }
})

test('outbox: an entry is a folder with entry.json, renamed into place, its IDs in the order they were made', async t => {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const clock = createFakeClock('2026-11-09T15:50:15.123Z')
  const ids = createIds(clock)
  const written = []
  for (const entry of EXAMPLES) written.push(await writeOutboxEntry({ paths, ids, entry: { ...entry } }))
  assert.deepEqual(written, ['20261109T155015123-0001', '20261109T155015123-0002', '20261109T155015123-0003', '20261109T155015123-0004'])
  assert.deepEqual(fs.readdirSync(paths.outbox).sort(), written)
  assert.equal(modeOf(paths.outbox), 0o700)
  const file = path.join(paths.outbox, written[0], 'entry.json')
  assert.equal(modeOf(path.dirname(file)), 0o700)
  assert.equal(modeOf(file), 0o600)
  // Written with its fields in order, whatever order they were given in.
  assert.equal(fs.readFileSync(file, 'utf8'), '{"type":"text","by":"lifelog","text":"Blue Tokai, ₹450 at 12:40: work or personal?","replyTo":1042,"channels":["whatsapp"]}\n')
  const reversed = Object.fromEntries(Object.entries(EXAMPLES[3]).reverse())
  const id = await writeOutboxEntry({ paths, ids, entry: reversed })
  assert.equal(fs.readFileSync(path.join(paths.outbox, id, 'entry.json'), 'utf8'), '{"type":"react","by":"lifelog","target":1044,"emoji":"✅","channels":["whatsapp"]}\n')

  // A name the other writer took is passed over.
  clock.set('2026-11-09T15:50:16.000Z')
  fs.mkdirSync(path.join(paths.outbox, '20261109T155016000-0001'))
  fs.writeFileSync(path.join(paths.outbox, '20261109T155016000-0001', 'entry.json'), '{}')
  assert.equal(await writeOutboxEntry({ paths, ids, entry: EXAMPLES[2] }), '20261109T155016000-0002')

  // An entry that isn't one is never written.
  await assert.rejects(writeOutboxEntry({ paths, ids, entry: { type: 'text', by: 'lifelog', channels: ['whatsapp'], text: '' } }), /not an outbox entry: text must be a string/)
  assert.ok(fs.readdirSync(paths.outbox).every(name => !name.startsWith('.')))
})

test('outbox: a text is at most TEXT_MAX_CHARS characters; a longer one is cut when written, with a line that says so', async t => {
  atEnd(t, overrideLimits({ TEXT_MAX_CHARS: 60 }))
  assert.equal(cutText('short'), 'short')
  const exact = '😀'.repeat(60)
  assert.equal(cutText(exact), exact)
  // Characters are code points: the emoji count once each, and none is split.
  const cut = cutText('😀'.repeat(61))
  assert.equal(cut, `${'😀'.repeat(60 - textLength(CUT_NOTE))}${CUT_NOTE}`)
  assert.equal(textLength(cut), 60)
  // What it ends on before the note is trimmed.
  assert.equal(textLength(CUT_NOTE), 50)
  assert.equal(cutText('abcd '.repeat(20)), `abcd abcd${CUT_NOTE}`)
  assert.deepEqual(checkOutboxEntry({ type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'x'.repeat(61) }), ['text must be at most 60 characters'])

  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const id = await writeOutboxEntry({ paths, ids: createIds(createFakeClock()), entry: { type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'y'.repeat(1000), replyTo: 3 } })
  const written = JSON.parse(fs.readFileSync(path.join(paths.outbox, id, 'entry.json'), 'utf8'))
  assert.deepEqual(written, { type: 'text', by: 'lifelog', channels: ['whatsapp'], text: cutText('y'.repeat(1000)), replyTo: 3 })
})

test('outbox: sending.json holds the entry and how many of its messages have gone out', () => {
  assert.deepEqual(checkSendingFile({ entry: EXAMPLES[0], sent: 0 }), [])
  assert.deepEqual(checkSendingFile({ entry: EXAMPLES[3], sent: 1 }), [])
  assert.deepEqual(checkSendingFile(null), ['not an object'])
  assert.deepEqual(checkSendingFile({ entry: EXAMPLES[0], sent: 1.5 }), ['sent must be a whole number, 0 or more'])
  assert.deepEqual(checkSendingFile({ entry: { type: 'text', by: 'runner' }, sent: 0, extra: 1 }), ["extra doesn't belong in sending.json", 'entry: text is missing'])
})

test('outbox: a text or an emoji with U+0000 in it is no entry, and a text is written with U+FFFD in its place', async t => {
  // No program takes a command-line argument with U+0000 in it, so such a text could never be
  // sent.
  assert.deepEqual(checkOutboxEntry({ type: 'text', by: 'lifelog', channels: ['whatsapp'], text: 'a\0b' }), ["text can't hold U+0000"])
  assert.deepEqual(checkOutboxEntry({ type: 'react', by: 'lifelog', channels: ['whatsapp'], target: 1, emoji: '✅\0' }), ["emoji can't hold U+0000"])
  assert.equal(cutText('a\0b\0'), 'a�b�')
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: root, configDir: path.join(root, 'config') })
  const ids = createIds(createFakeClock())
  const id = await writeOutboxEntry({ paths, ids, entry: { type: 'text', by: 'lifelog', channels: ['whatsapp'], text: '\0' } })
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.outbox, id, 'entry.json'), 'utf8')).text, '�')
})
