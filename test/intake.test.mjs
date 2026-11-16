// Intake (5.2 step 6 of DESIGN.md; section 10, "Intake"): records from a channel become datastore
// lines, with their attachments. The core is driven here with a fake channel; the WhatsApp module's
// own steps are in whatsapp.test.mjs.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MEDIA_ERRORS, createIntake } from '../src/bridge/intake.mjs'
import { openStore } from '../src/bridge/store.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createFakeChannel, makeAttachment, makeRecord } from './support/fake-channel.mjs'
import { createTestLog } from './support/log.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

function setup(t, { channels: given } = {}) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: root, configDir: path.join(root, 'config') })
  const clock = createFakeClock('2026-11-09T15:45:00Z')
  const { log, entries, events } = createTestLog({ clock })
  const store = openStore({ paths, clock, log })
  const whatsapp = createFakeChannel()
  const channels = new Map((given ?? [whatsapp]).map(channel => [channel.name, channel]))
  const fatal = []
  const intake = createIntake({ store, channels, paths, log, clock, onFatal: error => fatal.push(error) })
  for (const channel of channels.values()) channel.start(record => intake.take(record))
  const lines = () => [...store.index.entries()].map(entry => entry.line)
  const dayDir = path.join(paths.datastore, '2026/11/09')
  return { root, paths, clock, log, entries, events, store, whatsapp, intake, fatal, lines, dayDir }
}

// What a line says, without the fields every incoming WhatsApp line has.
function gist(line) {
  const { dir, source, trust, at, ...rest } = line
  assert.equal(dir, 'in')
  assert.equal(trust, 'owner')
  return rest
}

// ---------------------------------------------------------------------------------------------
// Messages, replies and commands

test('intake: a message becomes a message line, with its time and its ID', async t => {
  const { whatsapp, lines } = setup(t)
  const result = await whatsapp.deliver(makeRecord({ id: 'A1', text: 'coffee 150', at: '2026-11-09T15:43:02Z' }))
  assert.equal(result.stored, true)
  assert.deepEqual(lines(), [
    { seq: 1, kind: 'message', dir: 'in', at: '2026-11-09T15:43:02Z', source: 'whatsapp', sourceId: 'A1', trust: 'owner', text: 'coffee 150' },
  ])
  // A forwarded message is marked as someone else's words.
  await whatsapp.deliver(makeRecord({ id: 'A2', text: 'the train leaves at 9', forwarded: true }))
  assert.deepEqual(gist(lines()[1]), { seq: 2, kind: 'message', sourceId: 'A2', forwarded: true, text: 'the train leaves at 9' })
})

test('intake: a message whose channel gives no time is dated when it arrives', async t => {
  const { whatsapp, lines, clock } = setup(t)
  clock.set('2026-11-09T16:00:07.900Z')
  await whatsapp.deliver(makeRecord({ id: 'A1', text: 'hi', at: null }))
  assert.equal(lines()[0].at, '2026-11-09T16:00:07Z')
})

test('intake: a reply gets the seq of what it quotes when that is known, and the preview either way', async t => {
  const { whatsapp, lines } = setup(t)
  await whatsapp.deliver(makeRecord({ id: 'Q1', text: 'Blue Tokai, ₹450 at 12:40' }))
  await whatsapp.deliver(makeRecord({ id: 'R1', text: 'work', replyToId: 'Q1', replyToPreview: 'Blue Tokai, ₹450 at 12:40' }))
  // Quoting a message from before the datastore: only the preview.
  await whatsapp.deliver(makeRecord({ id: 'R2', text: 'that one', replyToId: 'OLD', replyToPreview: 'from last year' }))
  // Quoting with no preview, as catch-up does.
  await whatsapp.deliver(makeRecord({ id: 'R3', text: 'and again', replyToId: 'Q1' }))
  assert.deepEqual(lines().slice(1).map(gist), [
    { seq: 2, kind: 'message', sourceId: 'R1', replyTo: 1, quoted: 'Blue Tokai, ₹450 at 12:40', text: 'work' },
    { seq: 3, kind: 'message', sourceId: 'R2', quoted: 'from last year', text: 'that one' },
    { seq: 4, kind: 'message', sourceId: 'R3', replyTo: 1, text: 'and again' },
  ])
})

test('intake: a text that is one of the four commands is a command line, trimmed', async t => {
  const { whatsapp, lines } = setup(t)
  for (const text of ['/status', '  /backup\n', '/help', '/new']) await whatsapp.deliver(makeRecord({ text }))
  // Close is not enough.
  for (const text of ['/STATUS', '/status please', '/ new', 'status', '/new.']) await whatsapp.deliver(makeRecord({ text }))
  // A reply that is a command is a command, and quotes nothing.
  await whatsapp.deliver(makeRecord({ text: '/status', replyToId: 'X', replyToPreview: 'what?' }))
  // A caption is not a text.
  await whatsapp.deliver(makeRecord({ text: '/status', attachments: [makeAttachment({ error: 'not a file, so not stored', type: 'location' })] }))
  assert.deepEqual(
    lines().map(line => [line.kind, line.text]),
    [
      ['command', '/status'],
      ['command', '/backup'],
      ['command', '/help'],
      ['command', '/new'],
      ['message', '/STATUS'],
      ['message', '/status please'],
      ['message', '/ new'],
      ['message', 'status'],
      ['message', '/new.'],
      ['command', '/status'],
      ['message', '/status'],
    ],
  )
  assert.equal(lines()[9].replyTo, undefined)
})

test('intake: an email is never a command', async t => {
  const email = createFakeChannel({ name: 'email', takesCommands: false })
  const { lines } = setup(t, { channels: [createFakeChannel(), email] })
  await email.deliver(makeRecord({ source: 'email', id: 'abc@mail.example', subject: 'note', text: '/status' }))
  assert.deepEqual(gist(lines()[0]), { seq: 1, kind: 'message', sourceId: 'abc@mail.example', subject: 'note', text: '/status' })
})

// ---------------------------------------------------------------------------------------------
// Reactions, edits and deletions

test('intake: reactions, edits and deletions point at the seq of their message', async t => {
  const { whatsapp, lines } = setup(t)
  await whatsapp.deliver(makeRecord({ id: 'M1', text: 'coffee 150' }))
  await whatsapp.deliver(makeRecord({ id: 'M2', text: 'lunch 400' }))
  await whatsapp.deliver(makeRecord({ id: 'R1', reactionToId: 'M1', reactionEmoji: '👍' }))
  await whatsapp.deliver(makeRecord({ id: 'R2', reactionToId: 'M1', reactionEmoji: '' }))
  await whatsapp.deliver(makeRecord({ id: 'M1', edited: true, text: 'coffee 120', at: '2026-11-09T15:44:00Z' }))
  await whatsapp.deliver(makeRecord({ id: 'M2', revoked: true, at: '2026-11-09T15:44:30Z' }))
  assert.deepEqual(lines().slice(2).map(gist), [
    { seq: 3, kind: 'reaction', sourceId: 'R1', target: 1, emoji: '👍' },
    // A removed reaction is one with no emoji.
    { seq: 4, kind: 'reaction', sourceId: 'R2', target: 1, emoji: '' },
    { seq: 5, kind: 'edit', sourceId: 'M1', target: 1, text: 'coffee 120' },
    { seq: 6, kind: 'delete', sourceId: 'M2', target: 2 },
  ])
  assert.equal(lines()[4].at, '2026-11-09T15:44:00Z')
})

test('intake: a reaction, an edit or a deletion of an unknown message is skipped', async t => {
  const { whatsapp, lines, events } = setup(t)
  await whatsapp.deliver(makeRecord({ id: 'M1', text: 'coffee 150' }))
  await whatsapp.deliver(makeRecord({ id: 'R1', reactionToId: 'M1', reactionEmoji: '👍' }))
  for (const record of [
    makeRecord({ id: 'R2', reactionToId: 'NOWHERE', reactionEmoji: '👍' }),
    makeRecord({ id: 'NOWHERE', edited: true, text: 'new' }),
    makeRecord({ id: 'NOWHERE', revoked: true }),
    // A reaction is not a message: it can't be reacted to, edited or deleted.
    makeRecord({ id: 'R3', reactionToId: 'R1', reactionEmoji: '❤️' }),
    makeRecord({ id: 'R1', edited: true, text: 'new' }),
    makeRecord({ id: 'R1', revoked: true }),
  ]) {
    assert.deepEqual(await whatsapp.deliver(record), { stored: false, reason: 'unknown target' })
  }
  assert.equal(lines().length, 2)
  assert.ok(events().includes('intake.skipped'))
})

test('intake: the same edit, deletion or reaction delivered twice is stored once', async t => {
  const { whatsapp, lines } = setup(t)
  const message = makeRecord({ id: 'M1', text: 'coffee 150' })
  const reaction = makeRecord({ id: 'R1', reactionToId: 'M1', reactionEmoji: '👍' })
  const edit = makeRecord({ id: 'M1', edited: true, text: 'coffee 120' })
  const deletion = makeRecord({ id: 'M1', revoked: true })
  // The webhook delivers each, and catch-up delivers each again.
  for (const record of [message, reaction, edit, deletion]) assert.equal((await whatsapp.deliver(record)).stored, true)
  for (const record of [message, reaction, edit, deletion]) {
    assert.deepEqual(await whatsapp.deliver(record), { stored: false, reason: 'duplicate' })
  }
  assert.deepEqual(lines().map(line => line.kind), ['message', 'reaction', 'edit', 'delete'])
})

// ---------------------------------------------------------------------------------------------
// Attachments

test('intake: an attachment is downloaded through the channel and stored beside the line', async t => {
  const { whatsapp, lines, dayDir, paths } = setup(t)
  const record = makeRecord({ id: 'P1', text: 'lunch with sam', attachments: [makeAttachment({ name: null, bytes: 13 })] })
  whatsapp.willDownload(record, 1, 'a jpeg, really')
  await whatsapp.deliver(record)
  assert.deepEqual(gist(lines()[0]), {
    seq: 1,
    kind: 'message',
    sourceId: 'P1',
    text: 'lunch with sam',
    files: [{ path: '1.jpg', mime: 'image/jpeg', bytes: 14 }],
  })
  assert.equal(fs.readFileSync(path.join(dayDir, '1.jpg'), 'utf8'), 'a jpeg, really')
  // The channel saved it in the bridge's own folder, and nothing is left there.
  assert.equal(path.dirname(whatsapp.downloads[0].target), paths.bridgeIncoming)
  assert.deepEqual(fs.readdirSync(paths.bridgeIncoming), [])

  // A document keeps its original name, and the extension comes from it.
  const document = makeRecord({ id: 'D1', attachments: [makeAttachment({ type: 'document', mime: 'application/pdf', name: 'Ticket.PDF' })] })
  whatsapp.willDownload(document, 1, '%PDF')
  await whatsapp.deliver(document)
  assert.deepEqual(lines()[1].files, [{ path: '2.pdf', mime: 'application/pdf', name: 'Ticket.PDF', bytes: 4 }])
})

test('intake: a failed download is tried twice more, 10 seconds apart, and then the line says so', async t => {
  const { whatsapp, lines, clock, events, paths } = setup(t)
  const flaky = makeRecord({ id: 'P1', attachments: [makeAttachment()] })
  whatsapp.willDownload(flaky, 1, 'third time lucky', { failures: 2 })
  const storing = whatsapp.deliver(flaky)
  // The retries wait `MEDIA_DOWNLOAD_RETRY_WAIT` each.
  await clock.whenSleeping()
  assert.deepEqual(clock.sleeping(), [10_000])
  await clock.advance(10_000)
  await clock.whenSleeping()
  await clock.advance(10_000)
  await storing
  assert.deepEqual(lines()[0].files, [{ path: '1.jpg', mime: 'image/jpeg', bytes: 16 }])
  assert.equal(whatsapp.downloads.length, 3)
  assert.equal(events().filter(event => event === 'intake.download_failed').length, 2)

  // Three failures: the message is stored with a media object instead of the file.
  const broken = makeRecord({ id: 'P2', text: 'receipt', attachments: [makeAttachment()] })
  whatsapp.willDownload(broken, 1, 'never', { failures: 3 })
  const failing = whatsapp.deliver(broken)
  for (let retry = 0; retry < 2; retry++) {
    await clock.whenSleeping()
    await clock.advance(10_000)
  }
  await failing
  assert.deepEqual(gist(lines()[1]), {
    seq: 2,
    kind: 'message',
    sourceId: 'P2',
    text: 'receipt',
    media: { type: 'image', mime: 'image/jpeg', error: 'download failed' },
  })
  assert.equal(whatsapp.downloads.length, 6)
  assert.deepEqual(fs.readdirSync(paths.bridgeIncoming), [])
})

test('intake: an attachment over the size limit is not downloaded, or not kept', async t => {
  const { whatsapp, lines } = setup(t)
  const restore = overrideLimits({ ATTACHMENT_MAX_BYTES: 10 })
  t.after(restore)
  // The channel says how large it is: it isn't downloaded at all.
  await whatsapp.deliver(makeRecord({ id: 'V1', attachments: [makeAttachment({ type: 'video', mime: 'video/mp4', bytes: 11 })] }))
  // The channel didn't know, and the file turned out too large.
  const unknown = makeRecord({ id: 'V2', attachments: [makeAttachment({ type: 'video', mime: 'video/mp4' })] })
  whatsapp.willDownload(unknown, 1, 'twelve bytes')
  await whatsapp.deliver(unknown)
  // The channel refused it as too large while copying: no retry.
  const refused = makeRecord({ id: 'V3', attachments: [makeAttachment({ type: 'video', mime: 'video/mp4' })] })
  whatsapp.willDownload(refused, 1, 'x', { failures: 5, code: 'EFBIG' })
  await whatsapp.deliver(refused)

  assert.deepEqual(
    lines().map(line => line.media),
    [1, 2, 3].map(() => ({ type: 'video', mime: 'video/mp4', error: MEDIA_ERRORS.tooLarge })),
  )
  assert.deepEqual(whatsapp.downloads.map(download => download.id), ['V2', 'V3'])
})

test('intake: media that is not a file is recorded as such, with its caption', async t => {
  const { whatsapp, lines } = setup(t)
  await whatsapp.deliver(makeRecord({ id: 'L1', text: 'Blue Tokai', attachments: [makeAttachment({ type: 'location', mime: null, error: 'not a file, so not stored' })] }))
  assert.deepEqual(gist(lines()[0]), { seq: 1, kind: 'message', sourceId: 'L1', text: 'Blue Tokai', media: { type: 'location', error: 'not a file, so not stored' } })
  assert.deepEqual(whatsapp.downloads, [])
})

test('intake: an attachment the store can\'t copy leaves the message stored without it', async t => {
  const { whatsapp, lines, store, events } = setup(t)
  const record = makeRecord({ id: 'P1', text: 'receipt', attachments: [makeAttachment()] })
  whatsapp.willDownload(record, 1, 'a photo')
  const copyFile = fs.promises.copyFile
  const mock = t.mock.method(fs.promises, 'copyFile', async () => {
    throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
  })
  await whatsapp.deliver(record)
  mock.mock.restore()
  assert.equal(fs.promises.copyFile, copyFile)
  assert.deepEqual(gist(lines()[0]), { seq: 1, kind: 'message', sourceId: 'P1', text: 'receipt', media: { type: 'image', mime: 'image/jpeg', error: 'could not be stored' } })
  assert.ok(events().includes('intake.attachment_not_stored'))
  assert.equal(store.broken, false)
})

test('intake: a message already stored is not downloaded again', async t => {
  const { whatsapp, lines } = setup(t)
  const record = makeRecord({ id: 'P1', attachments: [makeAttachment()] })
  whatsapp.willDownload(record, 1, 'a photo')
  await whatsapp.deliver(record)
  // Catch-up lists it again.
  assert.deepEqual(await whatsapp.deliver({ ...record }), { stored: false, reason: 'duplicate' })
  assert.equal(whatsapp.downloads.length, 1)
  assert.equal(lines().length, 1)
})

// ---------------------------------------------------------------------------------------------
// The rest

test('intake: records are handled one at a time, in the order they came', async t => {
  const { whatsapp, lines, clock } = setup(t)
  const slow = makeRecord({ id: 'P1', attachments: [makeAttachment()] })
  whatsapp.willDownload(slow, 1, 'photo', { failures: 1 })
  const first = whatsapp.deliver(slow)
  const second = whatsapp.deliver(makeRecord({ id: 'T1', text: 'after the photo' }))
  await clock.whenSleeping()
  assert.equal(lines().length, 0)
  await clock.advance(10_000)
  await Promise.all([first, second])
  assert.deepEqual(lines().map(line => line.sourceId), ['P1', 'T1'])
})

test('intake: a record that isn\'t well formed is logged, and stores nothing', async t => {
  const { whatsapp, lines, entries } = setup(t)
  for (const bad of [
    makeRecord({ id: '' }),
    makeRecord({ at: '2026-11-09T15:43:02.000Z' }),
    makeRecord({ text: undefined }),
    makeRecord({ reactionToId: 'M1' }),
    makeRecord({ attachments: [{ type: 'image' }] }),
    makeRecord({ chat: 'leaked@s.whatsapp.net' }),
    makeRecord({ subject: 'only on email' }),
  ]) {
    assert.deepEqual(await whatsapp.deliver(bad), { stored: false, reason: 'not a record' })
  }
  assert.equal(lines().length, 0)
  const logged = entries.filter(entry => entry.event === 'intake.bad_record')
  assert.equal(logged.length, 7)
  assert.ok(logged.every(entry => Array.isArray(entry.problems) && entry.problems.length > 0))
})

test('intake: logs say what was stored, never what it said', async t => {
  const { whatsapp, entries } = setup(t)
  const record = makeRecord({ id: 'P1', text: 'coffee with Sam', attachments: [makeAttachment({ name: 'Sam at Blue Tokai.jpg' })] })
  whatsapp.willDownload(record, 1, 'photo of Sam')
  await whatsapp.deliver(record)
  await whatsapp.deliver(makeRecord({ id: 'M2', text: 'Sam paid', replyToId: 'P1', replyToPreview: 'coffee with Sam' }))
  const text = JSON.stringify(entries)
  assert.ok(!text.includes('Sam'), text)
})

test('intake: once the store stops taking lines, the bridge is told, once', async t => {
  const { whatsapp, fatal, store } = setup(t)
  await whatsapp.deliver(makeRecord({ text: 'one' }))
  const writeSync = fs.writeSync
  const mock = t.mock.method(fs, 'writeSync', (fd, bytes) => writeSync(fd, bytes.subarray(0, 3)))
  assert.deepEqual(await whatsapp.deliver(makeRecord({ text: 'two' })), { stored: false, reason: 'the store stopped' })
  mock.mock.restore()
  assert.equal(store.broken, true)
  assert.deepEqual(await whatsapp.deliver(makeRecord({ text: 'three' })), { stored: false, reason: 'the store stopped' })
  assert.equal(fatal.length, 1)
})

test('intake: it knows the newest incoming line from each channel, from the datastore and as lines arrive', async t => {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: root, configDir: path.join(root, 'config') })
  const clock = createFakeClock('2026-11-09T15:45:00Z')
  const { log } = createTestLog({ clock })
  let store = openStore({ paths, clock, log })
  await store.append({ kind: 'message', dir: 'in', at: '2026-11-09T15:00:00Z', source: 'whatsapp', sourceId: 'W1', trust: 'owner', text: 'a' })
  await store.append({ kind: 'message', dir: 'in', at: '2026-11-09T15:10:00Z', source: 'email', sourceId: 'E1', trust: 'owner', subject: '', text: 'b' })
  // Scooter's own messages don't count.
  await store.append({ kind: 'message', dir: 'out', at: '2026-11-09T15:20:00Z', source: 'whatsapp', by: 'lifelog', text: 'c' })

  store = openStore({ paths, clock, log })
  const whatsapp = createFakeChannel()
  const intake = createIntake({ store, channels: new Map([['whatsapp', whatsapp]]), paths, log, clock })
  assert.equal(intake.newestIncomingAt('whatsapp'), '2026-11-09T15:00:00Z')
  assert.equal(intake.newestIncomingAt('email'), '2026-11-09T15:10:00Z')
  assert.equal(intake.newestIncomingAt('telegram'), null)
  await whatsapp.start(record => intake.take(record))
  // The newest by seq: catch-up storing an older message moves it back, which only lists more.
  await whatsapp.deliver(makeRecord({ id: 'W2', at: '2026-11-09T15:30:00Z', text: 'd' }))
  assert.equal(intake.newestIncomingAt('whatsapp'), '2026-11-09T15:30:00Z')
  await whatsapp.deliver(makeRecord({ id: 'W3', at: '2026-11-09T15:05:00Z', text: 'e' }))
  assert.equal(intake.newestIncomingAt('whatsapp'), '2026-11-09T15:05:00Z')
  // A duplicate changes nothing.
  await whatsapp.deliver(makeRecord({ id: 'W2', at: '2026-11-09T15:30:00Z', text: 'd' }))
  assert.equal(intake.newestIncomingAt('whatsapp'), '2026-11-09T15:05:00Z')
  atEnd(t, () => intake.idle())
})
