// The datastore: the line format, the reader,
// the index, and the single writer with its recovery.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { attachmentName, openStore } from '../src/bridge/store.mjs'
import { createIndex } from '../src/common/datastore/index.mjs'
import { DatastoreError, checkLine, checkReadLine, dataFlag, dataText, decodeLine, encodeLine, isKnown } from '../src/common/datastore/line.mjs'
import { createReader, listDays } from '../src/common/datastore/reader.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { skipUnlessRoot, skipUnlessUsers } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

// The example lines that datastore.md shows under The line format: messages in and out, a
// reaction, and an email.
const EXAMPLES = [
  '{"seq":1042,"kind":"message","dir":"in","at":"2026-11-09T15:43:02Z","source":"whatsapp","sourceId":"3EB0A1B2C3D4E5F6A7B8","trust":"owner","text":"","files":[{"path":"1042.jpg","mime":"image/jpeg","bytes":482113}]}',
  '{"seq":1043,"kind":"message","dir":"out","at":"2026-11-09T15:43:40Z","source":"whatsapp","sourceId":"3EB0FF01A2B3C4D5E6F7","by":"lifelog","replyTo":1042,"text":"Blue Tokai, ₹450 at 12:40: work or personal?"}',
  '{"seq":1044,"kind":"message","dir":"in","at":"2026-11-09T15:50:11Z","source":"whatsapp","sourceId":"3EB0A1C9D8E7F6A5B4C3","trust":"owner","replyTo":1043,"text":"work","data":{"quoted":"Blue Tokai, ₹450 at 12:40: work or personal?"}}',
  '{"seq":1045,"kind":"reaction","dir":"out","at":"2026-11-09T15:50:30Z","source":"whatsapp","sourceId":"3EB0FF02A3B4C5D6E7F8","by":"lifelog","target":1044,"data":{"emoji":"✅"}}',
  '{"seq":1071,"kind":"message","dir":"in","at":"2026-11-09T16:12:40Z","source":"email","sourceId":"CAF3x9qR2-example@mail.gmail.com","trust":"owner","text":"Recording from today\'s call.","files":[{"path":"1071.eml","mime":"message/rfc822","bytes":19262388},{"path":"1071-2.m4a","mime":"audio/mp4","name":"Call with Sam.m4a","bytes":14206977}],"data":{"subject":"Call with Sam"}}',
]

const modeOf = file => fs.statSync(file).mode & 0o7777

// A message from the owner on WhatsApp, as intake will hand it to the store.
let nextId = 0
function incoming(text, extra = {}) {
  return { kind: 'message', dir: 'in', at: '2026-11-09T15:43:02Z', source: 'whatsapp', sourceId: `ID${++nextId}`, trust: 'owner', text, ...extra }
}

// A store in a test's own folder, with a clock the test moves.
function setup(t, start = '2026-11-09T15:43:02Z') {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: root, configDir: path.join(root, 'config') })
  const dir = paths.datastore
  const clock = createFakeClock(start)
  const { log, entries, events } = createTestLog({ clock })
  const open = (options = {}) => openStore({ paths, clock, log, ...options })
  const logFile = day => path.join(dir, day, 'log.jsonl')
  const linesOf = day => fs.readFileSync(logFile(day), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  // A file standing in for a download in wacli's staging folder or the mail spool.
  const staged = (name, contents = name) => {
    const file = path.join(root, 'staging', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
    return file
  }
  return { root, paths, dir, clock, entries, events, open, logFile, linesOf, staged }
}

// ---------------------------------------------------------------------------------------------
// The line format

test('datastore: the example lines are written exactly as datastore.md shows them', () => {
  for (const text of EXAMPLES) {
    const line = decodeLine(text)
    assert.equal(encodeLine(line), `${text}\n`)
    // Whatever order the fields are given in, they're written in the format's order.
    const shuffled = Object.fromEntries(Object.entries(line).reverse())
    assert.equal(encodeLine(shuffled), `${text}\n`)
  }
})

test('datastore: every kind of line', () => {
  const base = { seq: 9, dir: 'in', at: '2026-11-09T15:43:02Z', source: 'whatsapp', sourceId: 'X', trust: 'owner' }
  const lines = [
    { ...base, kind: 'message', text: 'coffee 150' },
    { ...base, kind: 'message', text: '', media: { type: 'image', mime: 'image/jpeg', error: 'download failed' } },
    { ...base, kind: 'message', text: 'see this', replyTo: 3, data: { forwarded: true, quoted: 'from before the datastore' } },
    { ...base, kind: 'edit', target: 4, text: 'coffee 120' },
    { ...base, kind: 'delete', target: 4 },
    { ...base, kind: 'reaction', target: 4, data: { emoji: '👍' } },
    { ...base, kind: 'reaction', target: 4, data: { emoji: '' } },
    // `data` is the channel's: any JSON it likes, on any line.
    { ...base, kind: 'edit', target: 4, text: '', data: { list: [1, 'two', null, { three: [true] }], n: -0.5 } },
    { ...base, kind: 'message', text: '', trust: 'external' },
    { seq: 9, kind: 'message', dir: 'out', at: base.at, source: 'whatsapp', by: 'bridge', text: 'Backup failed.' },
  ]
  for (const line of lines) {
    assert.deepEqual(checkLine(line), [], JSON.stringify(line))
    assert.deepEqual(decodeLine(encodeLine(line).trimEnd()), line)
    // What the store writes, a reader takes, and this version knows.
    assert.deepEqual(checkReadLine(line), [], JSON.stringify(line))
    assert.equal(isKnown(line), true, JSON.stringify(line))
  }
})

test('datastore: what the store refuses to write, and why', () => {
  const good = decodeLine(EXAMPLES[2])
  const bad = [
    [{ ...good, seq: 0 }, /seq must be/],
    [{ ...good, seq: 1.5 }, /seq must be/],
    [{ ...good, seq: '1044' }, /seq must be/],
    [{ ...good, seq: undefined }, /seq is missing/],
    [{ ...good, kind: 'note' }, /kind must be one of/],
    [{ ...good, dir: 'sideways' }, /dir must be one of/],
    [{ ...good, at: '2026-11-09T21:20:11+05:30' }, /at must be a UTC time/],
    [{ ...good, at: '2026-11-09T15:50:11.000Z' }, /at must be a UTC time/],
    [{ ...good, at: 1762703411 }, /at must be a UTC time/],
    [{ ...good, source: 'telegram' }, /source must be one of/],
    [{ ...good, sourceId: '' }, /sourceId must be/],
    [{ ...good, trust: 'stranger' }, /trust must be one of/],
    [{ ...good, trust: undefined }, /trust is missing/],
    [{ ...good, by: 'lifelog' }, /by doesn't belong/],
    [{ ...good, text: undefined }, /text is missing/],
    [{ ...good, text: 7 }, /text must be a string/],
    [{ ...good, replyTo: 'x' }, /replyTo must be a seq/],
    [{ ...good, replyTo: 1044 }, /replyTo must be a seq before/],
    [{ ...good, target: 3 }, /target doesn't belong/],
    [{ ...good, note: 'extra' }, /unknown field note/],
    // The four fields that moved into `data` are no fields of a line the store writes.
    [{ ...good, quoted: 'Blue Tokai' }, /unknown field quoted/],
    [{ ...good, forwarded: true }, /unknown field forwarded/],
    [{ ...good, subject: 'Call with Sam' }, /unknown field subject/],
    [{ ...good, emoji: '✅' }, /unknown field emoji/],
    // `data` is an object of JSON values with something in it, or left out.
    [{ ...good, data: {} }, /data must be an object of JSON values/],
    [{ ...good, data: null }, /data must be/],
    [{ ...good, data: ['quoted'] }, /data must be/],
    [{ ...good, data: 'quoted' }, /data must be/],
    [{ ...good, data: { n: NaN } }, /data must be/],
    [{ ...good, data: { n: Infinity } }, /data must be/],
    [{ ...good, data: { n: 1n } }, /data must be/],
    [{ ...good, data: { gone: undefined } }, /data must be/],
    [{ ...good, data: { when: new Date(0) } }, /data must be/],
    [{ ...good, data: { f() {} } }, /data must be/],
    [{ ...good, data: { holes: [1, , 3] } }, /data must be/],
    [{ ...good, data: (() => { const loop = { a: 1 }; loop.self = loop; return loop })() }, /data must be/],
    [{ ...good, files: [] }, /files must be/],
    [{ ...good, files: [{ path: '../../etc/passwd', mime: 'text/plain', bytes: 1 }] }, /files must be/],
    [{ ...good, files: [{ path: '.hidden', mime: 'text/plain', bytes: 1 }] }, /files must be/],
    [{ ...good, files: [{ path: '1044.jpg', mime: 'image/jpeg' }] }, /files must be/],
    [{ ...good, files: [{ path: '1044.jpg', mime: 'image/jpeg', bytes: 1, sha: 'x' }] }, /files must be/],
    [{ ...good, media: { type: 'image' } }, /media must be/],
    [{ ...decodeLine(EXAMPLES[1]), by: undefined }, /by is missing/],
    [{ ...decodeLine(EXAMPLES[1]), trust: 'owner' }, /trust doesn't belong/],
    [{ ...decodeLine(EXAMPLES[3]), target: undefined }, /target is missing/],
    [{ ...decodeLine(EXAMPLES[3]), target: 1045 }, /target must be a seq before/],
    [{ ...decodeLine(EXAMPLES[3]), text: 'hi' }, /text doesn't belong/],
    [{ ...decodeLine(EXAMPLES[3]), files: [{ path: 'a.jpg', mime: 'image/jpeg', bytes: 1 }] }, /files doesn't belong/],
    // There is no kind `command`: a text such as /status is a message.
    [{ ...good, kind: 'command', replyTo: undefined, data: undefined, text: '/status' }, /^kind must be one of message, edit, delete, reaction; text doesn't belong on this line$/],
    [[], /not an object/],
    [null, /not an object/],
  ]
  for (const [line, pattern] of bad) {
    assert.match(checkLine(line).join('; '), pattern, inspect(line))
    assert.throws(() => encodeLine(line), DatastoreError)
  }
  assert.throws(() => decodeLine('{"seq":1,'), /not JSON/)
  assert.throws(() => decodeLine(''), /not JSON/)
})

test('datastore: a reader checks only what every reader depends on, and ignores what it doesn\'t know', () => {
  const good = decodeLine(EXAMPLES[2])
  // Read, though the store wouldn't write them: a kind, a channel and a field this version doesn't
  // have, such as the kind `command` an earlier version wrote, and anything at all in `data`.
  const read = [
    { ...good, kind: 'command', text: '/status' },
    { ...good, source: 'telegram' },
    { ...good, source: 'bank-alerts-2' },
    { ...good, note: 'a field of a later version' },
    { ...good, quoted: 7, forwarded: 'yes', subject: null, emoji: ['✅'] },
    { ...good, trust: 'stranger' },
    { ...good, trust: undefined },
    { ...good, dir: 'out' },
    { ...good, text: undefined },
    { ...good, data: null },
    { ...good, data: [] },
    { ...good, data: 'not an object' },
    { ...good, data: { subject: 7, quoted: { text: 'x' }, forwarded: 'true', emoji: null } },
    { ...good, data: {} },
    // A file is read by its path, MIME type and name; what else it holds is passed over.
    { ...good, files: [{ path: '1044.jpg', mime: 'image/jpeg' }] },
    { ...good, files: [{ path: '1044.jpg', mime: 'image/jpeg', bytes: 'many', sha256: 'abc' }] },
    { ...good, media: { type: 'image', error: 'download failed', size: 3 } },
    // An edit, a deletion or a reaction without its target, and a message without its text.
    { ...good, kind: 'edit' },
    { ...good, kind: 'reaction', text: undefined },
  ]
  for (const line of read) {
    assert.deepEqual(checkReadLine(line), [], JSON.stringify(line))
    assert.deepEqual(decodeLine(JSON.stringify(line)), JSON.parse(JSON.stringify(line)))
  }
  // Refused as damage: what every reader depends on, and a field this version acts on that isn't
  // of its type.
  const refused = [
    [{ ...good, seq: 0 }, /seq must be/],
    [{ ...good, seq: '1044' }, /seq must be/],
    [{ ...good, seq: undefined }, /seq is missing/],
    [{ ...good, kind: undefined }, /kind is missing/],
    [{ ...good, kind: 'Memo' }, /kind must be a name/],
    [{ ...good, kind: 'a note' }, /kind must be a name/],
    [{ ...good, kind: '' }, /kind must be a name/],
    [{ ...good, kind: 7 }, /kind must be a name/],
    [{ ...good, kind: '-x' }, /kind must be a name/],
    [{ ...good, source: 'Telegram' }, /source must be a name/],
    [{ ...good, source: '\u001b[2J' }, /source must be a name/],
    [{ ...good, source: undefined }, /source is missing/],
    [{ ...good, dir: 'sideways' }, /dir must be one of in, out/],
    [{ ...good, dir: undefined }, /dir is missing/],
    [{ ...good, at: '2026-11-09T21:20:11+05:30' }, /at must be a UTC time/],
    [{ ...good, at: undefined }, /at is missing/],
    [{ ...good, sourceId: '' }, /sourceId must be/],
    [{ ...good, sourceId: 7 }, /sourceId must be/],
    [{ ...good, by: 7 }, /by must be/],
    [{ ...good, text: 7 }, /text must be a string/],
    [{ ...good, text: null }, /text must be a string/],
    [{ ...good, replyTo: 'x' }, /replyTo must be a seq/],
    [{ ...good, replyTo: 1044 }, /replyTo must be a seq before/],
    [{ ...good, target: 1.5 }, /target must be a seq/],
    [{ ...good, kind: 'edit', target: 2000 }, /target must be a seq before/],
    [{ ...good, files: [] }, /files must be/],
    [{ ...good, files: {} }, /files must be/],
    [{ ...good, files: [{ path: '../../etc/passwd', mime: 'text/plain' }] }, /files must be/],
    [{ ...good, files: [{ path: '.hidden', mime: 'text/plain' }] }, /files must be/],
    [{ ...good, files: [{ path: '1044.jpg' }] }, /files must be/],
    [{ ...good, files: [{ path: '1044.jpg', mime: 'image/jpeg', name: 7 }] }, /files must be/],
    [{ ...good, media: { type: 'image' } }, /media must be/],
    [{ ...good, media: { type: 'image', error: 'x', mime: 7 } }, /media must be/],
    [{ ...good, media: 'download failed' }, /media must be/],
    [[], /not an object/],
    [null, /not an object/],
    ['a line', /not an object/],
  ]
  for (const [line, pattern] of refused) {
    assert.match(checkReadLine(line).join('; '), pattern, JSON.stringify(line))
    assert.throws(() => decodeLine(JSON.stringify(line)), error => error instanceof DatastoreError && pattern.test(error.message))
  }
  assert.throws(() => decodeLine('{"seq":1,'), /not JSON/)
})

test('datastore: this version knows a line of its kinds and channels with the fields its kind needs, and nothing in data', () => {
  const at = '2026-11-09T15:43:02Z'
  const base = { seq: 9, dir: 'in', at, source: 'whatsapp', trust: 'owner' }
  for (const line of [
    { ...base, kind: 'message', text: '' },
    { ...base, kind: 'edit', target: 4, text: 'x' },
    { ...base, kind: 'delete', target: 4 },
    { ...base, kind: 'reaction', target: 4 },
    { ...base, kind: 'reaction', target: 4, data: 'not even an object' },
    { ...base, source: 'email', kind: 'message', text: '' },
    { ...base, kind: 'message', text: '', trust: undefined, note: 'ignored' },
  ]) {
    assert.equal(isKnown(line), true, JSON.stringify(line))
  }
  for (const line of [
    { ...base, kind: 'command', text: '/status' },
    { ...base, kind: 'message', text: 'hi', source: 'telegram' },
    { ...base, kind: 'message' },
    { ...base, kind: 'edit', text: 'x' },
    { ...base, kind: 'edit', target: 4 },
    { ...base, kind: 'delete' },
    { ...base, kind: 'reaction' },
    { ...base, kind: 'constructor', text: '' },
    { ...base, kind: 'message', source: 'constructor', text: '' },
  ]) {
    assert.equal(isKnown(line), false, JSON.stringify(line))
  }
})

test('datastore: what a reader takes from data, it checks first', () => {
  const line = data => ({ seq: 1, kind: 'message', dir: 'in', at: '2026-11-09T15:43:02Z', source: 'email', trust: 'owner', text: '', data })
  assert.equal(dataText(line({ subject: 'Call with Sam' }), 'subject'), 'Call with Sam')
  assert.equal(dataText(line({ subject: '' }), 'subject'), '')
  for (const data of [undefined, null, [], ['subject'], 'subject', 7, true, {}, { subject: 7 }, { subject: null }, { subject: ['x'] }, { subject: { text: 'x' } }, { Subject: 'x' }]) {
    assert.equal(dataText(line(data), 'subject'), undefined, JSON.stringify(data))
  }
  // Only its own: nothing an object inherits.
  assert.equal(dataText(line({}), 'constructor'), undefined)
  assert.equal(dataText(line(JSON.parse('{"__proto__":{"subject":"x"}}')), 'subject'), undefined)
  assert.equal(dataFlag(line({ forwarded: true }), 'forwarded'), true)
  for (const data of [undefined, null, [true], { forwarded: 'true' }, { forwarded: 1 }, { forwarded: false }, {}]) {
    assert.equal(dataFlag(line(data), 'forwarded'), false, JSON.stringify(data))
  }
})

test('datastore: an error about a line never quotes the line', () => {
  const secret = 'coffee with Sam at Blue Tokai'
  for (const text of [`{"seq":1,"text":"${secret}"`, JSON.stringify({ seq: 1, kind: 'message', text: secret, [secret]: secret })]) {
    try {
      decodeLine(text)
      assert.fail('should not decode')
    } catch (error) {
      assert.ok(error instanceof DatastoreError)
      assert.ok(!error.message.includes('Sam'), error.message)
    }
  }
  // The value of a field is never repeated, whatever is wrong with it.
  const problems = checkLine({ ...decodeLine(EXAMPLES[2]), data: [secret], text: [secret], at: secret })
  assert.ok(!problems.join(' ').includes('Sam'))
  // A reader names no field it doesn't know, so not even a field's name is repeated.
  for (const line of [{ seq: 1, kind: 'message', text: secret, [secret]: secret }, { ...decodeLine(EXAMPLES[2]), [secret]: secret, text: [secret], data: secret }]) {
    const read = checkReadLine(line).join(' ')
    assert.notEqual(read, '')
    assert.ok(!read.includes('Sam'), read)
  }
})

// ---------------------------------------------------------------------------------------------
// The store: seq, day folders and order

test('datastore: seq starts at 1 and goes up by 1, in the order of the lines', async t => {
  const { open, linesOf, dir } = setup(t)
  const store = open()
  assert.equal(store.index.lastSeq, 0)

  const first = await store.append(incoming('coffee 150', { sourceId: 'A1' }))
  assert.deepEqual(first, {
    stored: true,
    seq: 1,
    day: '2026/11/09',
    line: { seq: 1, kind: 'message', dir: 'in', at: '2026-11-09T15:43:02Z', source: 'whatsapp', sourceId: 'A1', trust: 'owner', text: 'coffee 150' },
  })
  // Asked for all at once, lines are still written one after another, in the order asked.
  const results = await Promise.all(Array.from({ length: 30 }, (_, n) => store.append(incoming(`note ${n}`))))
  assert.deepEqual(results.map(result => result.seq), Array.from({ length: 30 }, (_, n) => n + 2))

  const lines = linesOf('2026/11/09')
  assert.deepEqual(lines.map(line => line.seq), Array.from({ length: 31 }, (_, n) => n + 1))
  assert.deepEqual(lines.slice(1).map(line => line.text), Array.from({ length: 30 }, (_, n) => `note ${n}`))
  assert.equal(store.index.lastSeq, 31)
  assert.deepEqual(listDays(dir), ['2026/11/09'])
  // The file is exactly its lines: each one JSON on one line, with a line break, in the format's order.
  assert.equal(
    fs.readFileSync(path.join(dir, '2026/11/09/log.jsonl'), 'utf8').split('\n')[0],
    '{"seq":1,"kind":"message","dir":"in","at":"2026-11-09T15:43:02Z","source":"whatsapp","sourceId":"A1","trust":"owner","text":"coffee 150"}',
  )
})

test('datastore: a line with a line break in its text is still one line', async t => {
  const { open, linesOf, logFile } = setup(t)
  const store = open()
  const text = 'first line\nsecond line\r\n\ttabbed "quoted" \\ ₹450 ✅'
  await store.append(incoming(text))
  await store.append(incoming('next'))
  assert.equal(fs.readFileSync(logFile('2026/11/09'), 'utf8').split('\n').length, 3)
  assert.equal(linesOf('2026/11/09')[0].text, text)
})

test('datastore: the day folder is the UTC date the line arrived, whatever the message\'s own time', async t => {
  const { open, clock, linesOf, dir } = setup(t, '2026-11-09T23:59:58Z')
  const store = open()
  // Sent days ago and caught up now: filed under today, with its own time in `at`.
  const late = await store.append(incoming('caught up after downtime', { at: '2026-11-03T08:00:00Z' }))
  assert.equal(late.day, '2026/11/09')
  assert.equal(late.line.at, '2026-11-03T08:00:00Z')

  clock.set('2026-11-10T00:00:00Z')
  assert.equal((await store.append(incoming('just past midnight, UTC'))).day, '2026/11/10')
  clock.set('2026-12-01T10:00:00Z')
  assert.equal((await store.append(incoming('next month'))).day, '2026/12/01')
  clock.set('2027-01-01T00:00:01Z')
  assert.equal((await store.append(incoming('next year'))).day, '2027/01/01')

  assert.deepEqual(listDays(dir), ['2026/11/09', '2026/11/10', '2026/12/01', '2027/01/01'])
  assert.deepEqual(linesOf('2026/11/09').map(line => line.seq), [1])
  assert.deepEqual(linesOf('2027/01/01').map(line => line.seq), [4])
})

test('datastore: read in date order, the day folders give seq order', async t => {
  const { open, clock, dir, paths } = setup(t, '2026-11-28T10:00:00Z')
  const store = open()
  for (let day = 0; day < 40; day++) {
    for (let n = 0; n < 3; n++) await store.append(incoming(`day ${day} note ${n}`))
    clock.set(clock.now() + 24 * 3600 * 1000)
  }
  const read = createReader(paths).poll()
  assert.equal(read.length, 120)
  assert.deepEqual(read.map(entry => entry.line.seq), Array.from({ length: 120 }, (_, n) => n + 1))
  assert.deepEqual([...new Set(read.map(entry => entry.day))], listDays(dir))
  assert.equal(listDays(dir).length, 40)
  assert.equal(listDays(dir)[0], '2026/11/28')
  assert.equal(listDays(dir).at(-1), '2027/01/06')
})

test('datastore: day folders never go backwards, even when the clock does', async t => {
  const { open, clock, dir, entries, paths } = setup(t, '2026-11-10T00:30:00Z')
  let store = open()
  await store.append(incoming('before the clock was set back'))

  // The clock now reads the day before. The lines go in the newest folder, so order holds.
  clock.set('2026-11-09T23:40:00Z')
  const second = await store.append(incoming('after'))
  const third = await store.append(incoming('after, again'))
  assert.equal(second.day, '2026/11/10')
  assert.equal(third.day, '2026/11/10')
  assert.deepEqual(listDays(dir), ['2026/11/10'])
  assert.equal(entries.filter(entry => entry.event === 'store.clock_behind').length, 1)

  // The same after a restart, when the newest folder is known only from the disk.
  store = open()
  assert.equal((await store.append(incoming('after a restart'))).day, '2026/11/10')
  // And a folder with nothing in it yet counts too: a crash can leave one.
  fs.mkdirSync(path.join(dir, '2026/11/12'), { recursive: true })
  store = open()
  assert.equal((await store.append(incoming('into the newest folder'))).day, '2026/11/12')

  // Once the clock has caught up, new days are used again.
  clock.set('2026-11-13T00:00:00Z')
  assert.equal((await store.append(incoming('caught up'))).day, '2026/11/13')
  assert.deepEqual(createReader(paths).poll().map(entry => entry.line.seq), [1, 2, 3, 4, 5, 6])
})

test('datastore: the time zone of the process changes nothing', async t => {
  // Everything stored is UTC, and the store is never told the owner's time zone. So
  // a restart in another time zone can't reorder the datastore or move a day folder.
  const { root, linesOf } = setup(t)
  const script = `
    import { openStore } from ${JSON.stringify(fileURLToPath(new URL('../src/bridge/store.mjs', import.meta.url)))}
    import { makePaths } from ${JSON.stringify(fileURLToPath(new URL('../src/common/paths.mjs', import.meta.url)))}
    const [dataDir, now, text] = process.argv.slice(1)
    const log = { info() {}, warn() {}, error() {} }
    const store = openStore({ paths: makePaths({ dataDir, configDir: '/config' }), log, clock: { now: () => Date.parse(now) } })
    const result = await store.append({ kind: 'message', dir: 'in', at: now, source: 'whatsapp', trust: 'owner', text })
    console.log(result.seq + ' ' + result.day)
  `
  const write = (zone, now, text) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script, root, now, text], { env: { TZ: zone }, encoding: 'utf8' }).trim()

  // 20:30 UTC on the 9th is already the 10th in Kiritimati and in India, and still the 9th in Los Angeles.
  assert.equal(write('Pacific/Kiritimati', '2026-11-09T20:30:00Z', 'one'), '1 2026/11/09')
  assert.equal(write('America/Los_Angeles', '2026-11-09T20:31:00Z', 'two'), '2 2026/11/09')
  assert.equal(write('Asia/Kolkata', '2026-11-09T23:59:59Z', 'three'), '3 2026/11/09')
  // 03:00 UTC on the 10th is still the 9th in Los Angeles.
  assert.equal(write('America/Los_Angeles', '2026-11-10T03:00:00Z', 'four'), '4 2026/11/10')
  assert.deepEqual(linesOf('2026/11/09').map(line => line.text), ['one', 'two', 'three'])
  assert.deepEqual(linesOf('2026/11/09').map(line => line.at), ['2026-11-09T20:30:00Z', '2026-11-09T20:31:00Z', '2026-11-09T23:59:59Z'])
})

// ---------------------------------------------------------------------------------------------
// The store: recovery, and the index

test('datastore: an incomplete last line is removed at startup, and its seq is used again', async t => {
  const { open, logFile, linesOf, entries } = setup(t)
  let store = open()
  await store.append(incoming('one', { sourceId: 'A1' }))
  await store.append(incoming('two', { sourceId: 'A2' }))
  const whole = fs.readFileSync(logFile('2026/11/09'))

  // The bridge dies in the middle of writing line 3: part of it is on disk, without its line break.
  const part = '{"seq":3,"kind":"message","dir":"in","at":"2026-11-09T15:43:02Z","source":"whatsapp","sourceId":"A3","tru'
  fs.appendFileSync(logFile('2026/11/09'), part)

  store = open()
  assert.deepEqual(fs.readFileSync(logFile('2026/11/09')), whole)
  assert.equal(store.index.lastSeq, 2)
  // The message never got a line, so it isn't known, and it is stored when it comes again.
  assert.equal(store.index.seqOf('whatsapp', 'A3'), undefined)
  const again = await store.append(incoming('three', { sourceId: 'A3' }))
  assert.equal(again.seq, 3)
  assert.deepEqual(linesOf('2026/11/09').map(line => [line.seq, line.text]), [
    [1, 'one'],
    [2, 'two'],
    [3, 'three'],
  ])
  const truncated = entries.filter(entry => entry.event === 'store.truncated')
  assert.deepEqual(truncated.map(entry => [entry.day, entry.bytes]), [['2026/11/09', Buffer.byteLength(part)]])
  // What was removed is not in the log.
  assert.ok(!JSON.stringify(entries).includes('A3"'))
})

test('datastore: an incomplete first line of a new day, and one cut inside a character', async t => {
  const { open, clock, logFile, dir, paths } = setup(t)
  let store = open()
  await store.append(incoming('yesterday'))

  // The first line of the next day was cut off: the file holds nothing but the part.
  fs.mkdirSync(path.join(dir, '2026/11/10'), { recursive: true })
  fs.writeFileSync(logFile('2026/11/10'), '{"seq":2,"kind":"mess')
  clock.set('2026-11-10T09:00:00Z')
  store = open()
  assert.equal(fs.statSync(logFile('2026/11/10')).size, 0)
  assert.equal((await store.append(incoming('today'))).seq, 2)

  // Cut in the middle of a character of several bytes: the bytes are removed as bytes.
  const euro = Buffer.from('{"seq":3,"kind":"message","text":"₹')
  fs.appendFileSync(logFile('2026/11/10'), euro.subarray(0, euro.length - 1))
  store = open()
  assert.equal((await store.append(incoming('₹450'))).seq, 3)
  assert.deepEqual(createReader(paths).poll().map(entry => entry.line.text), ['yesterday', 'today', '₹450'])
})

test('datastore: nothing is truncated when the last line is complete', async t => {
  const { open, logFile, events } = setup(t)
  let store = open()
  await store.append(incoming('one'))
  await store.append(incoming('two'))
  const before = fs.readFileSync(logFile('2026/11/09'))
  store = open()
  store = open()
  assert.deepEqual(fs.readFileSync(logFile('2026/11/09')), before)
  assert.ok(!events().includes('store.truncated'))
  assert.equal((await store.append(incoming('three'))).seq, 3)
})

test('datastore: the index is rebuilt on restart', async t => {
  const { open, clock, logFile } = setup(t)
  let store = open()
  await store.append(incoming('coffee 150', { sourceId: 'MSG-1' }))
  await store.append({ kind: 'message', dir: 'out', at: '2026-11-09T15:44:00Z', source: 'whatsapp', sourceId: 'OUT-1', by: 'lifelog', replyTo: 1, text: 'Work or personal?' })
  clock.set('2026-11-10T08:00:00Z')
  await store.append(incoming('', { kind: 'edit', target: 1, text: 'coffee 120', sourceId: 'MSG-1' }))
  await store.append({ kind: 'reaction', dir: 'in', at: '2026-11-10T08:01:00Z', source: 'whatsapp', sourceId: 'REACT-1', trust: 'owner', target: 2, data: { emoji: '👍' } })
  await store.append({ kind: 'message', dir: 'in', at: '2026-11-10T08:02:00Z', source: 'email', sourceId: 'mail-1@example.com', trust: 'owner', text: 'attached', data: { subject: 'Receipt' } })
  await store.append(incoming('lunch 300', { sourceId: 'MSG-3' }))
  await store.append({ kind: 'delete', dir: 'in', at: '2026-11-10T08:03:00Z', source: 'whatsapp', trust: 'owner', target: 5 })

  const check = index => {
    assert.equal(index.lastSeq, 7)
    // seq to line, with the day folder its attachments are in.
    assert.equal(index.get(1).line.text, 'coffee 150')
    assert.equal(index.get(1).day, '2026/11/09')
    assert.equal(index.get(5).day, '2026/11/10')
    assert.equal(index.get(8), undefined)
    assert.deepEqual([...index.entries()].map(entry => entry.line.seq), [1, 2, 3, 4, 5, 6, 7])
    // (source, sourceId) to seq. An edit carries its message's ID, and the message keeps it.
    assert.equal(index.seqOf('whatsapp', 'MSG-1'), 1)
    assert.equal(index.seqOf('whatsapp', 'OUT-1'), 2)
    assert.equal(index.seqOf('whatsapp', 'REACT-1'), 4)
    assert.equal(index.seqOf('email', 'mail-1@example.com'), 5)
    assert.equal(index.seqOf('whatsapp', 'MSG-3'), 6)
    // The same ID on another channel is another message.
    assert.equal(index.seqOf('email', 'MSG-1'), undefined)
    assert.equal(index.seqOf('whatsapp', 'mail-1@example.com'), undefined)
    // Each message's current text, and whether it's deleted.
    assert.deepEqual(index.current(1), { text: 'coffee 120', editedIn: 3, deletedIn: null })
    assert.deepEqual(index.current(2), { text: 'Work or personal?', editedIn: null, deletedIn: null })
    assert.deepEqual(index.current(5), { text: 'attached', editedIn: null, deletedIn: 7 })
    assert.deepEqual(index.current(6), { text: 'lunch 300', editedIn: null, deletedIn: null })
    assert.equal(index.current(4), undefined)
    assert.equal(index.current(99), undefined)
    // Each line's number in its day's log, which the runner's prompt points at.
    assert.deepEqual([...index.entries()].map(entry => `${entry.day}:${entry.number}`), ['2026/11/09:1', '2026/11/09:2', '2026/11/10:1', '2026/11/10:2', '2026/11/10:3', '2026/11/10:4', '2026/11/10:5'])
    for (const { day, number, line } of index.entries()) {
      assert.equal(JSON.parse(fs.readFileSync(logFile(day), 'utf8').split('\n')[number - 1]).seq, line.seq)
    }
  }
  check(store.index)
  store = open()
  check(store.index)
  assert.equal((await store.append(incoming('after the restart'))).seq, 8)

})

test('datastore: the index refuses lines out of order', () => {
  const index = createIndex()
  const line = (seq, extra = {}) => ({ seq, kind: 'message', dir: 'in', at: '2026-11-09T15:43:02Z', source: 'whatsapp', trust: 'owner', text: '', ...extra })
  index.add(line(1), '2026/11/09')
  assert.throws(() => index.add(line(3), '2026/11/09'), /seq 3 follows seq 1/)
  assert.throws(() => index.add(line(1), '2026/11/09'), /seq 1 follows seq 1/)
  assert.throws(() => index.add(line(2), '2026/11/08'), /before 2026\/11\/09/)
  index.add(line(2), '2026/11/10')
  assert.equal(index.lastSeq, 2)
  assert.equal(index.newestDay, '2026/11/10')
  assert.throws(() => createIndex().add(line(2), '2026/11/09'), /seq 2 follows seq 0/)
})

test('datastore: a damaged datastore stops the store, and the error says where', async t => {
  const { open, clock, logFile, dir } = setup(t)
  const store = open()
  await store.append(incoming('one'))
  await store.append(incoming('two'))
  clock.set('2026-11-10T09:00:00Z')
  await store.append(incoming('three'))
  const day1 = fs.readFileSync(logFile('2026/11/09'), 'utf8')
  const day2 = fs.readFileSync(logFile('2026/11/10'), 'utf8')
  const [one, two] = day1.split('\n')

  const damage = [
    // A complete line that isn't a line.
    [`${one}\nsecret words that are not JSON\n`, day2, /2026\/11\/09\/log\.jsonl, line 2: not JSON/],
    [`${one}\n${two.replace('"kind":"message"', '"kind":"Memo"')}\n`, day2, /log\.jsonl, line 2: kind must be a name/],
    [`${one}\n${two.replace('"text":"two"', '"text":2')}\n`, day2, /log\.jsonl, line 2: text must be a string/],
    // A line missing, or there twice. The error names the file and the line.
    [`${one}\n`, day2, /2026\/11\/10\/log\.jsonl, line 1: seq 3 follows seq 1/],
    [`${one}\n${two}\n${two}\n`, day2, /2026\/11\/09\/log\.jsonl, line 3: seq 2 follows seq 2/],
    // Part of a line in a day that isn't the newest: a crash can't leave that.
    [`${one}\n${two.slice(0, 20)}`, day2, /2026\/11\/09\/log\.jsonl ends in part of a line/],
    [day1, `${day2}\n`, /2026\/11\/10\/log\.jsonl, line 2: not JSON/],
  ]
  for (const [first, second, pattern] of damage) {
    fs.writeFileSync(logFile('2026/11/09'), first)
    fs.writeFileSync(logFile('2026/11/10'), second)
    assert.throws(open, error => {
      assert.ok(error instanceof DatastoreError, error.stack)
      assert.match(error.message, pattern)
      assert.ok(!error.message.includes('secret words'))
      return true
    })
    // The store changed nothing: only an incomplete last line is ever removed.
    assert.equal(fs.readFileSync(logFile('2026/11/09'), 'utf8'), first)
    assert.equal(fs.readFileSync(logFile('2026/11/10'), 'utf8'), second)
  }
  fs.writeFileSync(logFile('2026/11/09'), day1)
  fs.writeFileSync(logFile('2026/11/10'), day2)
  assert.equal(open().index.lastSeq, 3)
  assert.deepEqual(listDays(dir), ['2026/11/09', '2026/11/10'])
})

test('datastore: after a write fails, the store writes nothing more until it is opened again', async t => {
  const { open, logFile, linesOf, events } = setup(t)
  let store = open()
  await store.append(incoming('one'))

  // The disk takes only half of the next line.
  const writeSync = fs.writeSync
  const mock = t.mock.method(fs, 'writeSync', (fd, bytes) => writeSync(fd, bytes.subarray(0, bytes.length >> 1)))
  await assert.rejects(store.append(incoming('two', { sourceId: 'HALF' })), /only part of a line was written/)
  mock.mock.restore()
  assert.ok(!fs.readFileSync(logFile('2026/11/09'), 'utf8').endsWith('\n'))

  // A line appended now would follow the half line on the same line of the file.
  await assert.rejects(store.append(incoming('three')), /the bridge must be restarted/)
  assert.equal(store.index.lastSeq, 1)
  assert.ok(events().includes('store.write_failed'))

  store = open()
  assert.equal((await store.append(incoming('two', { sourceId: 'HALF' }))).seq, 2)
  assert.deepEqual(linesOf('2026/11/09').map(line => line.text), ['one', 'two'])
})

test('datastore: a line that is not well formed is refused, and uses up no seq', async t => {
  const { open, dir, paths } = setup(t)
  const store = open()
  await store.append(incoming('one'))
  const refused = [
    [incoming('x', { seq: 9 }), /seq and files are set by the store/],
    [incoming('x', { files: [{ path: 'a.jpg', mime: 'image/jpeg', bytes: 1 }] }), /seq and files are set by the store/],
    [incoming('x', { at: 'now' }), /at must be a UTC time/],
    [incoming('x', { kind: 'reaction' }), /target is missing/],
    // A line can only point at one that exists.
    [incoming('x', { kind: 'edit', target: 2 }), /target must be a seq before/],
    [incoming('x', { replyTo: 7 }), /replyTo must be a seq before/],
    [{ kind: 'message', dir: 'out', at: '2026-11-09T15:43:02Z', source: 'whatsapp', text: 'x' }, /by is missing/],
  ]
  for (const [line, pattern] of refused) {
    await assert.rejects(store.append(line), error => error instanceof DatastoreError && pattern.test(error.message))
  }
  await assert.rejects(store.append({ kind: 'delete', dir: 'in', at: '2026-11-09T15:43:02Z', source: 'whatsapp', trust: 'owner', target: 1 }, [{ path: '/x', mime: 'a/b' }]), /only a message has attachments/)
  assert.equal((await store.append(incoming('two'))).seq, 2)
  assert.equal(createReader(paths).poll().length, 2)
})

// ---------------------------------------------------------------------------------------------
// The store: duplicates

test('datastore: a message or a reaction whose ID is stored is ignored', async t => {
  const { open, linesOf } = setup(t)
  let store = open()
  const message = incoming('coffee 150', { sourceId: 'MSG-1' })
  const other = incoming('lunch 300', { sourceId: 'MSG-3' })
  const reaction = { kind: 'reaction', dir: 'in', at: '2026-11-09T15:45:00Z', source: 'whatsapp', sourceId: 'REACT-1', trust: 'owner', target: 1, data: { emoji: '👍' } }
  for (const line of [message, other, reaction]) assert.equal((await store.append(line)).stored, true)

  // The webhook and catch-up both deliver the same event.
  for (const line of [message, other, reaction]) {
    assert.deepEqual(await store.append(line), { stored: false, reason: 'duplicate' })
  }
  // The ID decides, not the contents; and the same contents under a new ID are a new message.
  assert.equal((await store.append({ ...message, text: 'something else' })).stored, false)
  assert.equal((await store.append({ ...message, sourceId: 'MSG-2' })).seq, 4)
  // A reaction that changes is a new reaction with its own ID.
  assert.equal((await store.append({ ...reaction, sourceId: 'REACT-2', data: { emoji: '' } })).seq, 5)
  // The same ID on the other channel is not the same message.
  assert.equal((await store.append({ ...message, source: 'email', data: { subject: 'coffee' } })).seq, 6)
  // Without an ID there is nothing to compare, and the line is stored.
  const noId = { kind: 'message', dir: 'out', at: '2026-11-09T15:46:00Z', source: 'whatsapp', by: 'bridge', text: 'Backup failed.' }
  assert.equal((await store.append(noId)).seq, 7)
  assert.equal((await store.append(noId)).seq, 8)

  // Duplicates are still known after a restart.
  store = open()
  for (const line of [message, other, reaction]) assert.equal((await store.append(line)).stored, false)
  assert.equal(linesOf('2026/11/09').length, 8)
  assert.equal(store.index.lastSeq, 8)
})

test('datastore: the same edit or deletion delivered twice is stored once', async t => {
  const { open, linesOf } = setup(t)
  let store = open()
  await store.append(incoming('coffee 150', { sourceId: 'MSG-1' }))
  await store.append(incoming('lunch 400', { sourceId: 'MSG-2' }))

  // An edit carries the ID of the message it changes, so its text is what tells it apart.
  const edit = text => incoming(text, { kind: 'edit', target: 1, sourceId: 'MSG-1' })
  assert.equal((await store.append(edit('coffee 120'))).seq, 3)
  assert.deepEqual(await store.append(edit('coffee 120')), { stored: false, reason: 'duplicate' })
  // An edit that changes nothing is skipped too.
  assert.equal((await store.append(incoming('lunch 400', { kind: 'edit', target: 2, sourceId: 'MSG-2' }))).stored, false)
  // A second, different edit is stored, and so is one that goes back to the first text.
  assert.equal((await store.append(edit('coffee 130'))).seq, 4)
  assert.equal((await store.append(edit('coffee 150'))).seq, 5)
  assert.equal((await store.append(edit('coffee 150'))).stored, false)

  const deletion = { kind: 'delete', dir: 'in', at: '2026-11-09T15:50:00Z', source: 'whatsapp', trust: 'owner', target: 2 }
  assert.equal((await store.append(deletion)).seq, 6)
  assert.deepEqual(await store.append(deletion), { stored: false, reason: 'duplicate' })

  store = open()
  assert.equal((await store.append(edit('coffee 150'))).stored, false)
  assert.equal((await store.append(deletion)).stored, false)
  assert.deepEqual(store.index.current(1), { text: 'coffee 150', editedIn: 5, deletedIn: null })
  assert.deepEqual(store.index.current(2), { text: 'lunch 400', editedIn: null, deletedIn: 6 })
  assert.deepEqual(linesOf('2026/11/09').map(line => line.kind), ['message', 'message', 'edit', 'edit', 'edit', 'delete'])
})

// ---------------------------------------------------------------------------------------------
// The store: attachments

test('datastore: attachment names', () => {
  const name = (attachment, n = 1) => attachmentName(1042, n, attachment)
  // The extension comes from the original file name if there is one.
  assert.equal(name({ name: 'receipt.jpg', mime: 'image/jpeg' }), '1042.jpg')
  assert.equal(name({ name: 'Ticket.PDF', mime: 'application/octet-stream' }), '1042.pdf')
  assert.equal(name({ name: 'archive.tar.gz' }), '1042.gz')
  assert.equal(name({ name: 'Call with Sam.m4a', mime: 'audio/mp4' }, 2), '1042-2.m4a')
  assert.equal(name({ name: 'notes.txt' }, 3), '1042-3.txt')
  // Else from the MIME type.
  assert.equal(name({ mime: 'image/jpeg' }), '1042.jpg')
  assert.equal(name({ mime: 'audio/ogg; codecs=opus' }), '1042.ogg')
  assert.equal(name({ mime: 'Application/PDF' }), '1042.pdf')
  assert.equal(name({ mime: 'message/rfc822' }), '1042.eml')
  assert.equal(name({ mime: 'image/heic' }, 2), '1042-2.heic')
  // A name with no usable extension leaves it to the MIME type.
  assert.equal(name({ name: 'README', mime: 'text/plain' }), '1042.txt')
  assert.equal(name({ name: '.bashrc', mime: 'text/plain' }), '1042.txt')
  assert.equal(name({ name: 'trailing.', mime: 'image/png' }), '1042.png')
  assert.equal(name({ name: 'photo.jp g', mime: 'image/jpeg' }), '1042.jpg')
  assert.equal(name({ name: 'x.../../../etc/passwd', mime: 'image/png' }), '1042.png')
  assert.equal(name({ name: 'report.averyveryverylongextension', mime: 'application/pdf' }), '1042.pdf')
  assert.equal(name({ name: 'data.extension1' }), '1042.extension1')
  // Else `.bin`.
  assert.equal(name({}), '1042.bin')
  assert.equal(name({ name: 'README' }), '1042.bin')
  assert.equal(name({ mime: 'application/x-something-new' }), '1042.bin')
  assert.equal(name({ name: 'evil.sh;rm -rf', mime: '' }, 2), '1042-2.bin')
})

test('datastore: the longest extension taken from a name is a limit', t => {
  t.after(overrideLimits({ ATTACHMENT_EXT_MAX_CHARS: 3 }))
  assert.equal(attachmentName(7, 1, { name: 'a.jpg' }), '7.jpg')
  assert.equal(attachmentName(7, 1, { name: 'a.jpeg', mime: 'image/jpeg' }), '7.jpg')
})

test('datastore: attachments are copied into the day folder, and the line names them', async t => {
  const { open, dir, staged, linesOf } = setup(t)
  const store = open()
  await store.append(incoming('first'))
  const photo = staged('IMG_2041.JPG', 'jpeg bytes')
  const ticket = staged('ticket', '%PDF-1.7 …')
  const voice = staged('PTT-20261109-WA0001', 'OggS')

  const result = await store.append(incoming('', { sourceId: 'MEDIA-1' }), [
    { path: photo, mime: 'image/jpeg', name: 'IMG_2041.JPG' },
    { path: ticket, mime: 'application/pdf', name: 'ticket.pdf' },
    { path: voice, mime: 'audio/ogg; codecs=opus' },
    { path: photo },
  ])
  assert.equal(result.seq, 2)
  assert.deepEqual(result.line.files, [
    { path: '2.jpg', mime: 'image/jpeg', name: 'IMG_2041.JPG', bytes: 10 },
    { path: '2-2.pdf', mime: 'application/pdf', name: 'ticket.pdf', bytes: Buffer.byteLength('%PDF-1.7 …') },
    { path: '2-3.ogg', mime: 'audio/ogg; codecs=opus', bytes: 4 },
    { path: '2-4.bin', mime: 'application/octet-stream', bytes: 10 },
  ])
  // The files sit beside the log, in the line's own day folder, and nothing else does.
  const dayDir = path.join(dir, '2026/11/09')
  assert.deepEqual(fs.readdirSync(dayDir).sort(), ['2-2.pdf', '2-3.ogg', '2-4.bin', '2.jpg', 'log.jsonl'])
  assert.equal(fs.readFileSync(path.join(dayDir, '2.jpg'), 'utf8'), 'jpeg bytes')
  assert.equal(fs.readFileSync(path.join(dayDir, '2-2.pdf'), 'utf8'), '%PDF-1.7 …')
  assert.deepEqual(linesOf('2026/11/09')[1], result.line)
  // The store copies. What becomes of the staged file is for whoever staged it.
  assert.ok(fs.existsSync(photo) && fs.existsSync(ticket) && fs.existsSync(voice))
  // The line after takes the next seq, and its file the next name.
  assert.deepEqual((await store.append(incoming(''), [{ path: photo, mime: 'image/jpeg' }])).line.files, [
    { path: '3.jpg', mime: 'image/jpeg', bytes: 10 },
  ])
})

test('datastore: a message that is a duplicate stores no attachment', async t => {
  const { open, dir, staged } = setup(t)
  const store = open()
  const photo = staged('a.jpg')
  await store.append(incoming('', { sourceId: 'MEDIA-1' }), [{ path: photo, mime: 'image/jpeg' }])
  assert.equal((await store.append(incoming('', { sourceId: 'MEDIA-1' }), [{ path: photo, mime: 'image/jpeg' }])).stored, false)
  assert.deepEqual(fs.readdirSync(path.join(dir, '2026/11/09')).sort(), ['1.jpg', 'log.jsonl'])
})

test('datastore: an attachment that can\'t be copied stores nothing, and the seq is used by the next line', async t => {
  const { open, dir, staged, linesOf } = setup(t)
  const store = open()
  await store.append(incoming('one'))
  const photo = staged('a.jpg', 'first photo')

  await assert.rejects(
    store.append(incoming('', { sourceId: 'MEDIA-1' }), [
      { path: photo, mime: 'image/jpeg' },
      { path: path.join(dir, 'gone.pdf'), mime: 'application/pdf' },
    ]),
    error => error.code === 'ENOENT',
  )
  // No line, no files, and nothing temporary.
  assert.deepEqual(fs.readdirSync(path.join(dir, '2026/11/09')), ['log.jsonl'])
  assert.equal(linesOf('2026/11/09').length, 1)
  assert.equal(store.index.seqOf('whatsapp', 'MEDIA-1'), undefined)

  // Intake stores the message with a `media` object instead, and it gets seq 2.
  const result = await store.append(incoming('', { sourceId: 'MEDIA-1', media: { type: 'document', mime: 'application/pdf', error: 'download failed' } }))
  assert.equal(result.seq, 2)
  assert.deepEqual(result.line.media, { type: 'document', mime: 'application/pdf', error: 'download failed' })
  assert.equal(result.line.files, undefined)
})

test('datastore: an attachment left by a crash, whose seq has no line, is removed at startup', async t => {
  const { open, clock, dir, staged, events } = setup(t)
  let store = open()
  await store.append(incoming('one'), [{ path: staged('one.jpg'), mime: 'image/jpeg' }])
  // The bridge died after copying the attachments of line 2 and before writing the line.
  const dayDir = path.join(dir, '2026/11/09')
  fs.writeFileSync(path.join(dayDir, '2.jpg'), 'left over from the crash')
  fs.writeFileSync(path.join(dayDir, '2-2.pdf'), 'left over from the crash')
  fs.writeFileSync(path.join(dayDir, '.tmp-2-3.pdf'), 'half a copy')

  store = open()
  // Unfinished copies and finished ones without a line are cleared away at startup. Line 1's stays.
  assert.deepEqual(fs.readdirSync(dayDir).sort(), ['1.jpg', 'log.jsonl'])
  assert.ok(events().includes('store.leftovers_removed'))
  // So line 2, a plain text, has no attachment beside it that pi could take for its own.
  assert.equal((await store.append(incoming('two'))).seq, 2)
  assert.deepEqual(fs.readdirSync(dayDir).sort(), ['1.jpg', 'log.jsonl'])
  // And had a crash left one in the moment before another start, it is overwritten all the same.
  fs.writeFileSync(path.join(dayDir, '3.jpg'), 'left over from the crash')
  const result = await store.append(incoming(''), [{ path: staged('new.jpg', 'the new photo'), mime: 'image/jpeg' }])
  assert.equal(result.seq, 3)
  assert.equal(fs.readFileSync(path.join(dayDir, '3.jpg'), 'utf8'), 'the new photo')
  assert.deepEqual(result.line.files, [{ path: '3.jpg', mime: 'image/jpeg', bytes: 13 }])

  // A crash on the first line of a new day leaves the attachment in a folder with no log yet.
  clock.set('2026-11-10T06:00:00Z')
  fs.mkdirSync(path.join(dir, '2026/11/10'))
  fs.writeFileSync(path.join(dir, '2026/11/10/4.jpg'), 'left over from the crash')
  store = open()
  assert.deepEqual(fs.readdirSync(path.join(dir, '2026/11/10')), [])
})

test('datastore: a line of a kind, a channel or a field this version doesn\'t know is kept in the index, and passed over', async t => {
  const { open, logFile, linesOf, dir } = setup(t)
  const at = '2026-11-09T15:43:02Z'
  const base = { dir: 'in', at, trust: 'owner' }
  const lines = [
    { seq: 1, kind: 'message', ...base, source: 'whatsapp', sourceId: 'A1', text: 'coffee 150' },
    // The kind an earlier version wrote for /status.
    { seq: 2, kind: 'command', ...base, source: 'whatsapp', sourceId: 'C1', text: '/status' },
    // A channel that is gone.
    { seq: 3, kind: 'message', ...base, source: 'telegram', sourceId: 'T1', text: 'hi' },
    // Fields this version doesn't know, the four that moved into `data` among them.
    { seq: 4, kind: 'message', ...base, source: 'whatsapp', sourceId: 'A2', note: 'later', quoted: 'x', forwarded: true, text: 'lunch 300' },
    // A message without the text its kind needs.
    { seq: 5, kind: 'message', ...base, source: 'whatsapp', sourceId: 'A3' },
    // `data` that isn't what a channel writes.
    { seq: 6, kind: 'message', ...base, source: 'email', sourceId: 'E1', text: 'a', data: [] },
    { seq: 7, kind: 'message', ...base, source: 'email', sourceId: 'E2', text: 'b', data: { subject: 7 } },
    // An edit and a reaction that point at lines this version doesn't know.
    { seq: 8, kind: 'edit', ...base, source: 'whatsapp', sourceId: 'C1', target: 2, text: '/help' },
    { seq: 9, kind: 'reaction', ...base, source: 'telegram', sourceId: 'T2', target: 3, data: { emoji: '👍' } },
  ]
  fs.mkdirSync(path.join(dir, '2026/11/09'), { recursive: true })
  fs.writeFileSync(logFile('2026/11/09'), lines.map(line => `${JSON.stringify(line)}\n`).join(''))

  let store = open()
  assert.equal(store.index.lastSeq, 9)
  for (const line of lines) assert.deepEqual(store.index.get(line.seq).line, line)
  // Only what this version knows is a message to it.
  assert.deepEqual(
    lines.map(line => store.index.current(line.seq) !== undefined),
    [true, false, false, true, false, true, true, false, false],
  )
  // The edit of the old command changed nothing this version knows of.
  assert.deepEqual(store.index.current(4), { text: 'lunch 300', editedIn: null, deletedIn: null })
  // A line of a kind this version doesn't know keeps its own ID, so the same message caught up again
  // isn't stored a second time; an edit, which carries its message's, never takes one.
  assert.equal(store.index.seqOf('whatsapp', 'C1'), 2)
  assert.equal(store.index.seqOf('whatsapp', 'A3'), 5)
  assert.equal(store.index.seqOf('telegram', 'T1'), 3)
  assert.deepEqual(await store.append({ kind: 'message', ...base, source: 'whatsapp', sourceId: 'C1', text: '/status' }), { stored: false, reason: 'duplicate' })
  // Nothing can point at what isn't a message this version knows.
  for (const [target, kind] of [[2, 'edit'], [3, 'reaction'], [5, 'delete'], [9, 'reaction']]) {
    const line = { kind, ...base, source: 'whatsapp', target, ...(kind === 'edit' ? { text: 'x' } : {}), ...(kind === 'reaction' ? { sourceId: `R${target}`, data: { emoji: '👍' } } : {}) }
    await assert.rejects(store.append(line), new RegExp(`a ${kind} must point at a message, and seq ${target} isn't one`))
  }
  // The writer stays as strict: none of what it read is something it writes.
  for (const [line, pattern] of [
    [{ kind: 'command', ...base, source: 'whatsapp', text: '/status' }, /kind must be one of/],
    [{ kind: 'message', ...base, source: 'telegram', text: 'hi' }, /source must be one of/],
    [{ kind: 'message', ...base, source: 'whatsapp', note: 'later', text: 'x' }, /unknown field note/],
    [{ kind: 'message', ...base, source: 'whatsapp', quoted: 'x', text: 'x' }, /unknown field quoted/],
    [{ kind: 'message', ...base, source: 'whatsapp' }, /text is missing/],
    [{ kind: 'message', ...base, source: 'email', text: 'a', data: [] }, /data must be/],
  ]) {
    await assert.rejects(store.append(line), error => error instanceof DatastoreError && pattern.test(error.message))
  }
  assert.equal((await store.append({ kind: 'edit', ...base, source: 'whatsapp', sourceId: 'A2', target: 4, text: 'lunch 350' })).seq, 10)
  store = open()
  assert.equal((await store.append({ kind: 'message', ...base, source: 'whatsapp', sourceId: 'A4', text: 'next' })).seq, 11)
  assert.deepEqual(store.index.current(4), { text: 'lunch 350', editedIn: 10, deletedIn: null })
  // What it read is left as it was.
  assert.deepEqual(linesOf('2026/11/09').slice(0, 9), lines)
})

test('datastore: an edit, a deletion or a reaction points at a message', async t => {
  const { open } = setup(t)
  const store = open()
  await store.append(incoming('coffee 150'))
  await store.append(incoming('lunch 300'))
  const reaction = { kind: 'reaction', dir: 'in', at: '2026-11-09T15:45:00Z', source: 'whatsapp', sourceId: 'R1', trust: 'owner', target: 1, data: { emoji: '👍' } }
  assert.equal((await store.append(reaction)).seq, 3)
  assert.equal((await store.append({ ...reaction, sourceId: 'R2', target: 2 })).seq, 4)
  // A reaction is not something to edit, delete or react to.
  for (const line of [
    { ...reaction, sourceId: 'R3', target: 3 },
    incoming('coffee 120', { kind: 'edit', target: 3 }),
    { kind: 'delete', dir: 'in', at: '2026-11-09T15:50:00Z', source: 'whatsapp', trust: 'owner', target: 3 },
  ]) {
    await assert.rejects(store.append(line), error => {
      assert.ok(error instanceof DatastoreError)
      assert.match(error.message, new RegExp(`a ${line.kind} must point at a message, and seq 3 isn't one`))
      return true
    })
  }
  assert.equal(store.index.lastSeq, 4)
})

// ---------------------------------------------------------------------------------------------
// The reader

test('datastore: a reader takes only complete lines, and leaves a partial last line for its next poll', async t => {
  const { open, dir, logFile, paths } = setup(t)
  const store = open()
  const reader = createReader(paths)
  assert.deepEqual(reader.poll(), [])
  assert.deepEqual(reader.position, { day: null, offset: 0, lineNumber: 0 })

  await store.append(incoming('one'))
  await store.append(incoming('two'))
  assert.deepEqual(reader.poll().map(entry => [entry.line.seq, entry.day]), [
    [1, '2026/11/09'],
    [2, '2026/11/09'],
  ])
  assert.deepEqual(reader.poll(), [])

  // The writer is in the middle of line 3: the reader sees the first part of it.
  const whole = Buffer.from(`${JSON.stringify({ seq: 3, kind: 'message', dir: 'in', at: '2026-11-09T15:43:02Z', source: 'whatsapp', trust: 'owner', text: '₹450 ✅' })}\n`)
  const before = fs.statSync(logFile('2026/11/09')).size
  for (const cut of [1, 20, whole.length - 8, whole.length - 1]) {
    fs.truncateSync(logFile('2026/11/09'), before)
    fs.appendFileSync(logFile('2026/11/09'), whole.subarray(0, cut))
    assert.deepEqual(reader.poll(), [], `cut at ${cut}`)
    assert.deepEqual(reader.pending(), { day: '2026/11/09', file: logFile('2026/11/09'), offset: before, bytes: cut })
    assert.equal(reader.position.offset, before)
  }
  // The rest arrives, and with it the line.
  fs.appendFileSync(logFile('2026/11/09'), whole.subarray(whole.length - 1))
  assert.deepEqual(reader.poll().map(entry => entry.line.text), ['₹450 ✅'])
  assert.equal(reader.pending(), null)
  assert.deepEqual(reader.position, { day: '2026/11/09', offset: before + whole.length, lineNumber: 3 })
  // Reading changed nothing.
  assert.equal(fs.statSync(logFile('2026/11/09')).size, before + whole.length)
})

test('datastore: a reader follows the writer across a crash and into a new day', async t => {
  const { open, clock, dir, logFile, paths } = setup(t)
  let store = open()
  const reader = createReader(paths)
  await store.append(incoming('one'))
  assert.equal(reader.poll().length, 1)

  // The bridge dies in the middle of line 2. The reader takes nothing of it.
  fs.appendFileSync(logFile('2026/11/09'), '{"seq":2,"kind":"message","dir":"in"')
  assert.deepEqual(reader.poll(), [])
  assert.equal(reader.pending().bytes, 36)

  // The bridge starts again the next day, removes the part, and goes on. The reader sees line 2
  // once, whole, in the new day's folder.
  clock.set('2026-11-10T06:00:00Z')
  store = open()
  await store.append(incoming('two'))
  await store.append(incoming('three'))
  assert.deepEqual(reader.poll().map(entry => [entry.line.seq, entry.line.text, entry.day]), [
    [2, 'two', '2026/11/10'],
    [3, 'three', '2026/11/10'],
  ])
  assert.deepEqual(reader.poll(), [])
})

test('datastore: a reader started later reads from the first line, and skips what isn\'t a day folder', async t => {
  const { open, clock, dir, paths } = setup(t)
  const store = open()
  await store.append(incoming('one'), [])
  clock.set('2026-11-11T06:00:00Z')
  await store.append(incoming('two'))
  // Things that aren't day folders, and a day folder with no log yet.
  fs.writeFileSync(path.join(dir, 'README'), '')
  fs.mkdirSync(path.join(dir, 'lost+found'))
  fs.mkdirSync(path.join(dir, '2026', 'notes'))
  fs.writeFileSync(path.join(dir, '2026', '11', '99'), 'a file, not a folder')
  fs.mkdirSync(path.join(dir, '2026', '11', '10'))
  assert.deepEqual(listDays(dir), ['2026/11/09', '2026/11/10', '2026/11/11'])
  assert.deepEqual(createReader(paths).poll().map(entry => [entry.line.seq, entry.day]), [
    [1, '2026/11/09'],
    [2, '2026/11/11'],
  ])
  // A line that isn't one stops a reader where it was before the poll: a poll gives all of its
  // lines or none. Asked again, it says the same again.
  const reader = createReader(paths)
  assert.equal(reader.poll().length, 2)
  const position = reader.position
  clock.set('2026-11-12T06:00:00Z')
  await store.append(incoming('three'))
  fs.appendFileSync(paths.dayLog('2026/11/12'), 'not a line\n')
  for (let n = 0; n < 2; n++) {
    assert.throws(() => reader.poll(), /2026\/11\/12\/log\.jsonl, line 2: not JSON/)
    assert.deepEqual(reader.position, position)
  }
  assert.throws(() => createReader(paths).poll(), /line 2: not JSON/)
  assert.deepEqual(listDays(path.join(dir, 'missing')), [])
  assert.deepEqual(createReader(makePaths({ dataDir: path.join(dir, 'missing'), configDir: '/config' })).poll(), [])
})

test('datastore: the runner\'s index, built from a reader, matches the store\'s', async t => {
  const { open, clock, dir, paths } = setup(t)
  const store = open()
  const reader = createReader(paths)
  const index = createIndex()
  const follow = () => {
    for (const { line, day } of reader.poll()) index.add(line, day)
  }
  await store.append(incoming('coffee 150', { sourceId: 'MSG-1' }))
  follow()
  clock.set('2026-11-10T06:00:00Z')
  await store.append(incoming('coffee 120', { kind: 'edit', target: 1, sourceId: 'MSG-1' }))
  await store.append({ kind: 'delete', dir: 'in', at: '2026-11-10T06:01:00Z', source: 'whatsapp', trust: 'owner', target: 1 })
  follow()
  follow()
  assert.equal(index.lastSeq, store.index.lastSeq)
  assert.deepEqual(index.current(1), store.index.current(1))
  assert.deepEqual(index.current(1), { text: 'coffee 120', editedIn: 2, deletedIn: 3 })
  assert.equal(index.seqOf('whatsapp', 'MSG-1'), 1)
  assert.deepEqual([...index.entries()], [...store.index.entries()])
})

// ---------------------------------------------------------------------------------------------
// Owners and modes

test('datastore: folders are 0750 and files 0640, whatever the umask', async t => {
  for (const mask of [0o000, 0o022, 0o077]) {
    const before = process.umask(mask)
    atEnd(t, () => process.umask(before))
    const { open, dir, staged } = setup(t)
    const store = open()
    await store.append(incoming(''), [{ path: staged('a.jpg'), mime: 'image/jpeg' }])
    for (const folder of [dir, path.join(dir, '2026'), path.join(dir, '2026/11'), path.join(dir, '2026/11/09')]) {
      assert.equal(modeOf(folder), 0o750, `${folder} with umask ${mask.toString(8)}`)
    }
    for (const file of ['log.jsonl', '1.jpg']) {
      assert.equal(modeOf(path.join(dir, '2026/11/09', file)), 0o640, `${file} with umask ${mask.toString(8)}`)
    }
    process.umask(before)
  }
})

test('datastore: as root, everything belongs to root and the runner\'s group, and only they can read it', { skip: skipUnlessRoot }, async t => {
  const { open, root, dir, staged, clock } = setup(t)
  // The folders above the datastore are open here, as /data is, so only the datastore's own
  // owner and modes decide who gets in.
  fs.chmodSync(root, 0o755)
  const runnerGroup = 12002
  const owner = { uid: 0, gid: runnerGroup }
  let store = open({ owner })
  await store.append(incoming('coffee 150'), [{ path: staged('a.jpg', 'photo'), mime: 'image/jpeg' }])
  clock.set('2026-12-01T00:00:00Z')
  await store.append(incoming('next month'))
  store = open({ owner })
  await store.append(incoming('after a restart'), [{ path: staged('b.pdf', 'ticket'), mime: 'application/pdf' }])

  const stored = fs.readdirSync(dir, { recursive: true }).sort()
  assert.deepEqual(stored, [
    '2026',
    '2026/11',
    '2026/11/09',
    '2026/11/09/1.jpg',
    '2026/11/09/log.jsonl',
    '2026/12',
    '2026/12/01',
    '2026/12/01/3.pdf',
    '2026/12/01/log.jsonl',
  ])
  for (const target of [dir, ...stored.map(entry => path.join(dir, entry))]) {
    const stat = fs.statSync(target)
    assert.deepEqual({ uid: stat.uid, gid: stat.gid }, owner, target)
    assert.equal(stat.mode & 0o7777, stat.isDirectory() ? 0o750 : 0o640, target)
  }

  // The runner, a user in that group, reads the log and the attachments, and can't change them.
  const { log } = createTestLog()
  const proc = createProc({ log })
  const logFile = path.join(dir, '2026/11/09/log.jsonl')
  const photo = path.join(dir, '2026/11/09/1.jpg')
  const read = `const fs = require('fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(photo)}, 'utf8') + ' ' + fs.readFileSync(${JSON.stringify(logFile)}, 'utf8').split('\\n').length)`
  const runner = await proc.run(process.execPath, ['-e', read], { user: { uid: 12001, gid: runnerGroup } })
  assert.equal(runner.stdout, 'photo 2', runner.stderr)
  const write = `require('fs').appendFileSync(${JSON.stringify(logFile)}, 'x')`
  const tamper = await proc.run(process.execPath, ['-e', write], { user: { uid: 12001, gid: runnerGroup } })
  assert.match(tamper.stderr, /EACCES/)
  const create = `require('fs').writeFileSync(${JSON.stringify(path.join(dir, '2026/11/09/planted'))}, 'x')`
  assert.match((await proc.run(process.execPath, ['-e', create], { user: { uid: 12001, gid: runnerGroup } })).stderr, /EACCES/)

  // wacli and the email reader, users outside the group, can't read it or even list it.
  for (const user of [{ uid: 12003, gid: 12003 }, { uid: 12004, gid: 12004 }]) {
    const denied = await proc.run(process.execPath, ['-e', read], { user })
    assert.match(denied.stderr, /EACCES/)
    assert.equal(denied.stdout, '')
    const list = await proc.run(process.execPath, ['-e', `require('fs').readdirSync(${JSON.stringify(dir)})`], { user })
    assert.match(list.stderr, /EACCES/)
  }
})

test('datastore: as root, the group is found by the name setup gives it', { skip: skipUnlessUsers }, async t => {
  const { open, root, dir } = setup(t)
  fs.chmodSync(root, 0o755)
  const { log } = createTestLog()
  const proc = createProc({ log })
  const env = { PATH: process.env.PATH }
  // `setup` creates this user. Nothing here depends on its number.
  const add = await proc.run('useradd', ['--system', '--user-group', '--shell', '/usr/sbin/nologin', 'scooter-runner'], { env })
  assert.equal(add.code, 0, add.stderr)
  atEnd(t, () => proc.run('userdel', ['scooter-runner'], { env }))

  const runner = await proc.lookupUser('scooter-runner')
  const store = open({ owner: { uid: 0, gid: runner.gid } })
  await store.append(incoming('coffee 150'))
  for (const target of [dir, path.join(dir, '2026/11/09'), path.join(dir, '2026/11/09/log.jsonl')]) {
    const stat = fs.statSync(target)
    assert.deepEqual({ uid: stat.uid, gid: stat.gid }, { uid: 0, gid: runner.gid }, target)
  }
  // The user setup made can read it, by its group.
  const read = await proc.run(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path.join(dir, '2026/11/09/log.jsonl'))}, 'utf8'))`], { user: runner })
  assert.match(read.stdout, /"text":"coffee 150"/)
})
