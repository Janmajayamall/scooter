// The email reader: against a fake mailbox, headers first
// and whole messages only from the owner's addresses, the `n:*` quirk, IDLE with the periodic look,
// errors, the position across restarts, nothing imported the first time, a `UIDVALIDITY` change,
// and the spool folders it writes.
//
// The reader runs in-process here, with a fake clock. The bridge's side of the spool, and the
// reader run as a program by the bridge, are in email.test.mjs.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { TMP_PREFIX, listHandOffs } from '../src/common/files.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { listNewest, main, readerConfig, runReader } from '../src/mail/reader.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createFakeMailbox } from './support/fake-mailbox.mjs'
import { createTestLog } from './support/log.mjs'
import { M4A, OWNER_ADDRESSES, PDF, appleMailAudio, gmailForwardedBooking, gmailPlain, outlookHtmlOnly, stranger } from './support/mail-samples.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const SECOND = 1000

// Waits, in real time, until `check()` is true.
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

function setup(t, { config: changes = {}, mailbox: options = {} } = {}) {
  const root = makeTestDir(t)
  const home = path.join(root, 'mail')
  fs.mkdirSync(home)
  const clock = createFakeClock('2026-11-09T16:00:00Z')
  const { log, entries, events } = createTestLog({ clock })
  const mailbox = createFakeMailbox({ clock, ...options })
  const config = { home, host: 'imap.example.com', port: 993, user: 'scooter.inbox@example.com', password: 'app-password', ownerAddresses: OWNER_ADDRESSES, checkSeconds: 60, ...changes }
  const spool = path.join(home, 'spool')

  let running = null
  const context = {
    root,
    home,
    clock,
    log,
    entries,
    events,
    mailbox,
    config,
    spool,
    // Starts the reader. `done` settles when it ends.
    start() {
      const controller = new AbortController()
      const done = runReader({ config, openMailbox: mailbox.openMailbox, clock, log, signal: controller.signal })
      done.catch(() => {})
      running = { controller, done }
      return running
    },
    async stop() {
      if (!running) return
      running.controller.abort()
      await running.done.catch(() => {})
      running = null
    },
    // Waits until the reader has looked at the mailbox `count` times in all, and waits again.
    async looked(count) {
      await until(() => mailbox.callsOf('list').length >= count && clock.sleeping().length > 0, `look ${count}`)
    },
    // The spool's folders, oldest first, each as `{ id, parsed, eml, parts }`.
    folders() {
      return listHandOffs(spool).map(id => {
        const dir = path.join(spool, id)
        const parts = fs
          .readdirSync(dir)
          .filter(name => name.startsWith('part-'))
          .sort()
          .map(name => fs.readFileSync(path.join(dir, name)))
        return { id, parsed: JSON.parse(fs.readFileSync(path.join(dir, 'parsed.json'), 'utf8')), eml: fs.readFileSync(path.join(dir, 'message.eml')), parts }
      })
    },
    position: () => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')),
  }
  atEnd(t, () => context.stop())
  return context
}

const headerOf = raw => raw.subarray(0, raw.indexOf('\r\n\r\n') + 4)

// ---------------------------------------------------------------------------------------------
// The position

test('reader: the first time, nothing already in the mailbox is handed over, and next is its UIDNEXT', async t => {
  const context = setup(t)
  context.mailbox.deliver(gmailPlain(), { arrivedAt: '2026-11-08T10:00:00Z' })
  context.mailbox.deliver(stranger(), { arrivedAt: '2026-11-08T11:00:00Z' })
  context.start()
  await context.looked(1)
  assert.deepEqual(context.folders(), [])
  assert.deepEqual(context.position(), { uidValidity: 1700000001, next: 3, newest: null, parsing: null, connected: true, checkedAt: '2026-11-09T16:00:00Z' })
  assert.deepEqual(context.events().filter(event => event.startsWith('mail.')), ['mail.connected', 'mail.position_started'])

  // What arrives from now on is handed over.
  context.mailbox.deliver(outlookHtmlOnly())
  await context.looked(2)
  assert.deepEqual(context.folders().map(folder => folder.parsed.uid), [3])
  assert.equal(context.position().next, 4)
})

test('reader: the position is kept across restarts, and what arrived meanwhile is handed over once', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  context.mailbox.deliver(gmailPlain())
  await context.looked(2)
  await context.stop()
  assert.equal(context.position().connected, false)

  context.mailbox.deliver(outlookHtmlOnly(), { arrivedAt: '2026-11-09T17:00:00Z' })
  context.clock.set('2026-11-09T18:00:00Z')
  context.start()
  await context.looked(3)
  assert.deepEqual(context.folders().map(folder => folder.parsed.uid), [1, 2])
  assert.deepEqual(context.position(), { uidValidity: 1700000001, next: 3, newest: '2026-11-09T17:00:00Z', parsing: null, connected: true, checkedAt: '2026-11-09T18:00:00Z' })
})

test('reader: for n:*, the newest message, with a UID below next, is not handed over again', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  context.mailbox.deliver(gmailPlain())
  await context.looked(2)
  // Looking again, at `2:*`, the mailbox answers with message 1, as IMAP does.
  await context.clock.advance(60 * SECOND)
  await context.looked(3)
  const [, , third] = context.mailbox.callsOf('list')
  assert.equal(third.from, 2)
  assert.equal(context.mailbox.callsOf('header').length, 1)
  assert.deepEqual(context.folders().map(folder => folder.parsed.uid), [1])
})

test('reader: a UIDVALIDITY change starts again from the first message since the day before the newest one handed over', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  context.mailbox.deliver(gmailPlain({ messageId: '<old@mail.example>' }), { arrivedAt: '2026-11-01T09:00:00Z' })
  context.mailbox.deliver(gmailPlain({ messageId: '<day-before@mail.example>' }), { arrivedAt: '2026-11-08T09:00:00Z' })
  context.mailbox.deliver(gmailPlain({ messageId: '<newest@mail.example>' }), { arrivedAt: '2026-11-09T15:00:00Z' })
  await context.looked(2)
  await context.stop()
  assert.equal(context.folders().length, 3)

  // The server renumbers the mailbox, and a message arrives meanwhile.
  context.mailbox.renumber({ from: 101 })
  context.mailbox.deliver(outlookHtmlOnly(), { arrivedAt: '2026-11-09T16:30:00Z' })
  context.start()
  await context.looked(3)
  assert.deepEqual(context.mailbox.callsOf('search'), [{ op: 'search', since: '2026-11-08T00:00:00.000Z' }])
  const again = context.folders().slice(3)
  // The two since then, again, for the bridge's duplicate check to skip, and the new one.
  assert.deepEqual(again.map(folder => [folder.parsed.uid, folder.parsed.uidValidity]), [
    [102, 1700000002],
    [103, 1700000002],
    [104, 1700000002],
  ])
  assert.match(again[0].eml.toString(), /Message-ID: <day-before@mail\.example>/)
  assert.deepEqual([context.position().uidValidity, context.position().next], [1700000002, 105])
  assert.ok(context.events().includes('mail.uidvalidity_changed'))
})

test('reader: a UIDVALIDITY change before anything was handed over starts from UIDNEXT', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  await context.stop()
  context.mailbox.deliver(gmailPlain())
  context.mailbox.renumber({ from: 50 })
  context.start()
  await context.looked(2)
  assert.deepEqual(context.folders(), [])
  assert.deepEqual([context.position().uidValidity, context.position().next], [1700000002, 51])
  assert.deepEqual(context.mailbox.callsOf('search'), [])
})

test('reader: a position that isn\'t one is logged, and the reader starts from UIDNEXT', async t => {
  const context = setup(t)
  fs.writeFileSync(path.join(context.home, 'state.json'), '{"uidValidity":')
  context.mailbox.deliver(gmailPlain())
  context.start()
  await context.looked(1)
  assert.deepEqual(context.folders(), [])
  assert.equal(context.position().next, 2)
  assert.ok(context.events().includes('mail.position_unreadable'))
})

// ---------------------------------------------------------------------------------------------
// Fetching

test('reader: headers first, and the whole message only when From names one of the owner\'s addresses', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  const owner = gmailPlain()
  const other = stranger()
  context.mailbox.deliver(owner)
  context.mailbox.deliver(other)
  await context.looked(2)
  assert.deepEqual(
    context.mailbox.calls.filter(call => ['header', 'source'].includes(call.op)),
    [
      { op: 'header', uid: 1 },
      { op: 'source', uid: 1 },
      { op: 'header', uid: 2 },
    ],
  )
  const [mine, theirs] = context.folders()
  assert.equal(mine.parsed.fetched, 'whole')
  assert.deepEqual(mine.eml, owner)
  // Mail from anyone else goes over with its headers only, so the bridge can log and count it.
  assert.deepEqual(theirs.parsed, { uid: 2, uidValidity: 1700000001, arrivedAt: '2026-11-09T16:00:00Z', size: other.length, fetched: 'headers', parsed: true, subject: 'Our best offers', text: '', attachments: [] })
  assert.deepEqual(theirs.eml, headerOf(other))
})

test('reader: a message over ATTACHMENT_MAX_BYTES isn\'t fetched, and goes over with its headers only', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  const uid = context.mailbox.deliver(appleMailAudio(), { notify: false })
  context.mailbox.setSize(uid, limits.ATTACHMENT_MAX_BYTES + 1)
  await context.clock.advance(60 * SECOND)
  await context.looked(2)
  assert.deepEqual(context.mailbox.callsOf('source'), [])
  const [folder] = context.folders()
  assert.equal(folder.parsed.fetched, 'headers')
  assert.equal(folder.parsed.size, limits.ATTACHMENT_MAX_BYTES + 1)
  assert.equal(folder.parsed.subject, 'Call with Sam')
})

test('reader: IDLE wakes it at once, and it looks every EMAIL_CHECK_SECONDS in case IDLE misses a message', async t => {
  const context = setup(t, { config: { checkSeconds: 30 } })
  context.start()
  await context.looked(1)
  assert.deepEqual(context.clock.sleeping(), [30 * SECOND])

  // Announced: handed over without waiting.
  context.mailbox.deliver(gmailPlain())
  await context.looked(2)
  assert.equal(context.folders().length, 1)

  // Missed by IDLE: handed over at the next look.
  context.mailbox.deliver(outlookHtmlOnly(), { notify: false })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(context.folders().length, 1)
  await context.clock.advance(29 * SECOND)
  assert.equal(context.folders().length, 1)
  await context.clock.advance(1 * SECOND)
  await context.looked(3)
  assert.equal(context.folders().length, 2)
  // Every look is recorded, for `/status`.
  assert.equal(context.position().checkedAt, '2026-11-09T16:00:30Z')
})

// ---------------------------------------------------------------------------------------------
// Errors

test('reader: a mailbox it can\'t reach, or loses, ends it with an error, and leaves the position as it was', async t => {
  const context = setup(t)
  context.mailbox.failNext('connect', 'ECONNREFUSED')
  await assert.rejects(context.start().done, { code: 'ECONNREFUSED' })
  assert.equal(context.position().connected, false)

  // Started again, as the bridge does after a wait: connected, then the connection is lost.
  context.start()
  await context.looked(1)
  assert.equal(context.position().connected, true)
  context.mailbox.drop()
  await until(() => context.position().connected === false, 'the reader to end')
  await context.stop()

  // A look that fails part-way: nothing handed over twice, nothing skipped.
  context.mailbox.deliver(gmailPlain())
  context.mailbox.deliver(outlookHtmlOnly())
  context.mailbox.failNext('source', 'EPIPE')
  await assert.rejects(context.start().done, { code: 'EPIPE' })
  assert.equal(context.position().next, 1)
  context.start()
  await context.looked(3)
  assert.deepEqual(context.folders().map(folder => folder.parsed.uid), [1, 2])
  // Stopped, it says so; ended by an error, it didn't.
  assert.equal(context.events().filter(event => event === 'mail.stopped').length, 0)
  await context.stop()
  assert.deepEqual([context.events().filter(event => event === 'mail.stopped').length, context.position().connected], [1, false])
})

// ---------------------------------------------------------------------------------------------
// Parsing and the spool

test('reader: a spool folder holds the raw message, parsed.json and the attachments, part-1 on', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  const audio = appleMailAudio()
  context.mailbox.deliver(audio)
  context.mailbox.deliver(gmailForwardedBooking())
  await context.looked(2)
  const [memo, booking] = context.folders()
  assert.deepEqual(memo.eml, audio)
  assert.deepEqual(memo.parsed, {
    uid: 1,
    uidValidity: 1700000001,
    arrivedAt: '2026-11-09T16:00:00Z',
    size: audio.length,
    fetched: 'whole',
    parsed: true,
    subject: 'Call with Sam',
    text: "Recording from today's call.\n\n\n\nSent from my iPhone",
    attachments: [{ name: 'Call with Sam.m4a', mime: 'audio/x-m4a', bytes: M4A.length }],
  })
  assert.deepEqual(memo.parts, [M4A])
  assert.deepEqual(booking.parsed.attachments, [{ name: 'E-ticket X7Y2KQ.pdf', mime: 'application/pdf', bytes: PDF.length }])
  assert.deepEqual(booking.parts, [PDF])
  // Each folder and file is the reader's own: the bridge reads them as root.
  for (const name of fs.readdirSync(path.join(context.spool, memo.id))) assert.equal(fs.statSync(path.join(context.spool, memo.id, name)).mode & 0o777, 0o600, name)
  assert.equal(fs.statSync(path.join(context.spool, memo.id)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(context.home, 'state.json')).mode & 0o777, 0o600)
})

// A message postal-mime refuses: multiparts nested deeper than it parses.
function tooDeep() {
  let body = 'Content-Type: text/plain\r\n\r\ndeep\r\n'
  for (let n = 0; n < 300; n++) body = `Content-Type: multipart/mixed; boundary="b${n}"\r\n\r\n--b${n}\r\n${body}--b${n}--\r\n`
  return Buffer.from(`From: Owner <${OWNER_ADDRESSES[0]}>\r\nSubject: deep\r\nMessage-ID: <deep@mail.example>\r\nMIME-Version: 1.0\r\n${body}`)
}

test('reader: an email it can\'t parse is handed over raw, saying so, and the ones after it still arrive', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  const broken = tooDeep()
  context.mailbox.deliver(broken)
  context.mailbox.deliver(gmailPlain())
  await context.looked(2)
  const [first, second] = context.folders()
  assert.deepEqual(first.eml, broken)
  assert.deepEqual([first.parsed.fetched, first.parsed.parsed, first.parsed.subject, first.parsed.text, first.parsed.attachments], ['whole', false, '', '', []])
  assert.deepEqual(first.parts, [])
  assert.equal(second.parsed.parsed, true)
  assert.ok(context.events().includes('mail.parse_failed'))
})

test('reader: a message the reader ended while parsing is handed over unparsed at the next start', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  await context.stop()
  context.mailbox.deliver(gmailPlain())
  context.mailbox.deliver(outlookHtmlOnly())
  // As a reader killed in the middle of parsing message 1 leaves its position.
  fs.writeFileSync(path.join(context.home, 'state.json'), JSON.stringify({ ...context.position(), parsing: 1 }))
  context.start()
  await context.looked(2)
  assert.deepEqual(context.folders().map(folder => [folder.parsed.uid, folder.parsed.parsed]), [
    [1, false],
    [2, true],
  ])
  assert.equal(context.position().parsing, null)
})

test('reader: an email it parsed but couldn\'t hand over, as on a full disk, is parsed again at the next start', async t => {
  const context = setup(t)
  const first = context.start()
  await context.looked(1)
  // The spool can't take a folder, once.
  const mkdir = fs.mkdirSync
  let refuse = true
  fs.mkdirSync = (target, ...rest) => {
    if (refuse && String(target).startsWith(context.spool)) {
      refuse = false
      throw Object.assign(new Error('ENOSPC: no space left on device, mkdir'), { code: 'ENOSPC' })
    }
    return mkdir(target, ...rest)
  }
  atEnd(t, () => (fs.mkdirSync = mkdir))
  context.mailbox.deliver(gmailPlain())
  await assert.rejects(first.done, { code: 'ENOSPC' })
  assert.deepEqual([context.position().next, context.position().parsing], [1, null])
  const looks = context.mailbox.callsOf('list').length
  context.start()
  await context.looked(looks + 1)
  assert.deepEqual(context.folders().map(folder => [folder.parsed.uid, folder.parsed.parsed]), [[1, true]])
})

test('reader: a UIDVALIDITY change forgets the message it was parsing, whose UID may now name another', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  context.mailbox.deliver(gmailPlain(), { arrivedAt: '2026-11-09T15:00:00Z' })
  await context.looked(2)
  await context.stop()
  // As a reader that ended while parsing message 2 leaves its position. Then the server renumbers
  // the mailbox, and 2 names the message handed over before, which is handed over again.
  fs.writeFileSync(path.join(context.home, 'state.json'), JSON.stringify({ ...context.position(), parsing: 2 }))
  context.mailbox.renumber({ from: 2 })
  context.mailbox.deliver(outlookHtmlOnly(), { arrivedAt: '2026-11-09T16:30:00Z' })
  const looks = context.mailbox.callsOf('list').length
  context.start()
  await context.looked(looks + 1)
  assert.deepEqual(context.folders().slice(1).map(folder => [folder.parsed.uid, folder.parsed.parsed]), [
    [2, true],
    [3, true],
  ])
})

test('reader: text and subject are kept to one character past where the bridge cuts them', async t => {
  const context = setup(t)
  atEnd(t, overrideLimits({ EMAIL_TEXT_MAX_CHARS: 10, EMAIL_SUBJECT_MAX_CHARS: 5 }))
  context.start()
  await context.looked(1)
  context.mailbox.deliver(gmailPlain({ subject: 'A long subject', body: 'a body of more than ten characters' }))
  await context.looked(2)
  const [folder] = context.folders()
  assert.equal(folder.parsed.subject, 'A long')
  assert.equal(folder.parsed.text, 'a body of m')
})

test('reader: an email with too much to describe is handed over unparsed', async t => {
  const context = setup(t)
  atEnd(t, overrideLimits({ EMAIL_PARSED_MAX_BYTES: 300 }))
  context.start()
  await context.looked(1)
  context.mailbox.deliver(gmailForwardedBooking())
  await context.looked(2)
  const [folder] = context.folders()
  assert.equal(folder.parsed.parsed, false)
  assert.deepEqual(folder.parts, [])
})

test('reader: what a stopped reader left unfinished in the spool is removed at the start', async t => {
  const context = setup(t)
  fs.mkdirSync(path.join(context.spool, `${TMP_PREFIX}20261109T155900000-0001`), { recursive: true })
  fs.writeFileSync(path.join(context.spool, `${TMP_PREFIX}20261109T155900000-0001`, 'message.eml'), 'half')
  context.start()
  await context.looked(1)
  assert.deepEqual(fs.readdirSync(context.spool), [])
})

test('reader: its logs hold UIDs and sizes, never what an email says', async t => {
  const context = setup(t)
  context.start()
  await context.looked(1)
  context.mailbox.deliver(gmailPlain())
  context.mailbox.deliver(tooDeep())
  await context.looked(2)
  const logged = JSON.stringify(context.entries)
  for (const word of ['Bombay', 'Dinner', 'deep', 'owner@example.com', 'app-password']) assert.ok(!logged.includes(word), word)
  assert.deepEqual(
    context.entries.filter(entry => entry.event === 'mail.handed_over').map(entry => [entry.uid, entry.fetched, entry.parsed]),
    [
      [1, 'whole', true],
      [2, 'whole', false],
    ],
  )
})

// ---------------------------------------------------------------------------------------------
// Its settings, and `email-check`

test('reader: its settings come from its environment, and a fault names the variable, never the value', () => {
  const env = {
    HOME: '/data/mail',
    EMAIL_IMAP_HOST: 'imap.gmail.com',
    EMAIL_IMAP_PORT: '993',
    EMAIL_USER: 'scooter.inbox@example.com',
    EMAIL_PASSWORD: 'app password',
    EMAIL_OWNER_ADDRESSES: 'Owner@Example.com,owner@example.net',
    EMAIL_CHECK_SECONDS: '60',
  }
  assert.deepEqual(readerConfig(env), {
    home: '/data/mail',
    host: 'imap.gmail.com',
    port: 993,
    user: 'scooter.inbox@example.com',
    password: 'app password',
    ownerAddresses: ['owner@example.com', 'owner@example.net'],
    checkSeconds: 60,
  })
  assert.throws(() => readerConfig({ ...env, EMAIL_PASSWORD: '', EMAIL_CHECK_SECONDS: '5' }), error => {
    assert.equal(error.message, 'EMAIL_PASSWORD is missing; EMAIL_CHECK_SECONDS must be a whole number from 10 to 3600')
    return true
  })
  assert.throws(() => readerConfig({ ...env, HOME: 'mail' }), /HOME must be an absolute path/)
})

test('reader: `newest` lists the header blocks of the newest messages, and stores nothing', async t => {
  const context = setup(t)
  for (let n = 0; n < 7; n++) context.mailbox.deliver(gmailPlain({ messageId: `<m${n}@mail.example>` }))
  const found = await listNewest({ config: context.config, openMailbox: context.mailbox.openMailbox })
  assert.deepEqual(found.map(message => message.uid), [3, 4, 5, 6, 7])
  assert.match(found[0].header.toString(), /^Delivered-To:[^]*Message-ID: <m2@mail\.example>[^]*\r\n\r\n$/)
  assert.deepEqual(fs.readdirSync(context.home), [])

  // As a program: one JSON line each, the header block in base64.
  let out = ''
  const code = await main(['newest'], {
    env: { HOME: context.home, EMAIL_IMAP_HOST: 'imap.example.com', EMAIL_USER: 'u', EMAIL_PASSWORD: 'p', EMAIL_OWNER_ADDRESSES: OWNER_ADDRESSES.join(',') },
    stdout: { write: text => (out += text) },
    openMailbox: context.mailbox.openMailbox,
    log: context.log,
  })
  assert.equal(code, 0)
  const lines = out.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines.map(line => line.uid), [3, 4, 5, 6, 7])
  assert.match(Buffer.from(lines[4].header, 'base64').toString(), /Message-ID: <m6@mail\.example>/)
  assert.deepEqual(fs.readdirSync(context.home), [])

  // Started wrongly, it says so and exits with 2.
  let err = ''
  assert.equal(await main(['other'], { stderr: { write: text => (err += text) }, log: context.log }), 2)
  assert.equal(await main(['run'], { env: {}, stderr: { write: text => (err += text) }, log: context.log }), 2)
  assert.match(err, /usage: reader\.mjs run \| newest\nemail reader: HOME is missing; EMAIL_IMAP_HOST is missing/)
})
