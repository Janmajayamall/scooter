// The email channel: the sender
// check, the spool as the bridge takes it, the datastore line, the reader's environment and
// supervision, its status, and `email-check`.
//
// The tests from "The spool" on run the bridge with the email reader's stub (`support/mail-reader`),
// which runs the real reader against a fake mailbox, and the wacli stub, not paired. Most of them
// place folders in the spool themselves, as the reader writes them.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_READER, SUBJECT_CUT_NOTE, TEXT_CUT_NOTE, checkParsed, createEmail, dateOf, emailRecord, fromAddress, messageIdOf, readAuthResults, readHeaderBlock, readerEnv, runEmailCheck, senderCheck } from '../src/bridge/channels/email.mjs'
import { BridgeConfigError, startBridge } from '../src/bridge/main.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { createMailReaderStub } from './support/mail-reader.mjs'
import {
  AUTHSERV,
  M4A,
  OWNER_ADDRESSES,
  OWNER_APPLE,
  OWNER_GMAIL,
  PDF,
  STRANGER,
  appleMailAudio,
  gmailForwardedBooking,
  gmailPlain,
  headers,
  outlookHtmlOnly,
  replaceHeader,
  stranger,
} from './support/mail-samples.mjs'
import { isRoot, skipIfRoot, skipUnlessRoot } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'
import { OWNER_NUMBER, createWacliStub, waitFor } from './support/wacli.mjs'

const SECOND = 1000
const EMAIL = { host: 'imap.example.com', port: 993, user: 'scooter.inbox@example.com', password: 'mailbox-password-123', ownerAddresses: OWNER_ADDRESSES, authservId: AUTHSERV, checkSeconds: 60 }
const check = raw => senderCheck(readHeaderBlock(raw), EMAIL)

// ---------------------------------------------------------------------------------------------
// The sender check

test('email: the sender check keeps the owner\'s mail from Gmail, Apple Mail and Outlook', () => {
  for (const [raw, sender] of [
    [gmailPlain(), OWNER_GMAIL],
    [appleMailAudio(), OWNER_APPLE],
    [outlookHtmlOnly(), 'owner@example.org'],
  ]) {
    assert.deepEqual(check(raw), { ok: true, reason: null, sender, authserv: AUTHSERV })
  }
})

test('email: the sender check skips another From address, several From headers or addresses, a group, and none', () => {
  const reason = raw => check(raw).reason
  assert.deepEqual(check(stranger()), { ok: false, reason: 'From isn\'t one of the owner\'s addresses', sender: STRANGER, authserv: AUTHSERV })
  const from = value => replaceHeader(gmailPlain(), 'From', value)
  assert.equal(reason(from(`From: Owner <${OWNER_GMAIL}>\nFrom: ${STRANGER}`)), 'it has several From headers')
  assert.equal(reason(from(`From: ${OWNER_GMAIL}, ${STRANGER}`)), 'its From header holds several addresses')
  assert.equal(reason(from(`From: <${OWNER_GMAIL}> <${STRANGER}>`)), 'its From header holds several addresses')
  assert.equal(reason(from(`From: Friends: ${OWNER_GMAIL};`)), 'its From header holds a group')
  assert.equal(reason(from(null)), 'it has no From header')
  assert.equal(reason(from('From: Owner')), 'its From header holds no address')
  assert.equal(reason(from(`From: "Owner <${OWNER_GMAIL}>`)), 'its From header can\'t be read')
  // The owner's address as the display name, and another in the brackets: the brackets count.
  assert.deepEqual(check(from(`From: ${OWNER_GMAIL} <${STRANGER}>`)).sender, STRANGER)
  assert.equal(reason(from(`From: <${OWNER_GMAIL}> ${STRANGER}`)), 'its From header can\'t be read')
})

test('email: the sender check reads From as mail apps write it, without regard to case', () => {
  const from = value => check(replaceHeader(gmailPlain(), 'From', value))
  for (const value of [
    `From: ${OWNER_GMAIL}`,
    `From: <${OWNER_GMAIL.toUpperCase()}>`,
    `From: "Example, Owner (home)" <${OWNER_GMAIL}>`,
    `From: =?UTF-8?Q?Owner_=C3=89xample?= <${OWNER_GMAIL}>`,
    `From: ${OWNER_GMAIL} (Owner, at home)`,
    `From: Owner (the <real> one) <${OWNER_GMAIL}> (sent from (my) phone)`,
    `From: "Owner Example"\n <${OWNER_GMAIL}>`,
    `fRoM:    Owner   <${OWNER_GMAIL}>   `,
  ]) {
    assert.deepEqual([from(value).ok, from(value).sender], [true, OWNER_GMAIL], value)
  }
})

test('email: the sender check skips no Authentication-Results, another server\'s on top, and anything but one dmarc=pass', () => {
  const reason = raw => check(raw).reason
  const results = value => replaceHeader(gmailPlain(), 'Authentication-Results', value)
  assert.equal(reason(results(null)), 'it has no Authentication-Results header')
  assert.equal(reason(gmailPlain({ dmarc: 'fail' })), 'dmarc=fail')
  assert.equal(reason(results(`Authentication-Results: ${AUTHSERV}; spf=pass smtp.mailfrom=${OWNER_GMAIL}`)), 'it has no DMARC result')
  assert.equal(reason(results(`Authentication-Results: ${AUTHSERV}; dmarc=pass; dmarc=fail`)), 'it has several DMARC results')
  // dmarc=pass inside a comment is no result.
  assert.equal(reason(results(`Authentication-Results: ${AUTHSERV}; dmarc=none (dmarc=pass) header.from=example.com`)), 'dmarc=none')
  assert.equal(reason(results(`Authentication-Results: ${AUTHSERV}; spf=pass (dmarc=pass; dmarc=pass) smtp.mailfrom=x`)), 'it has no DMARC result')
  assert.equal(reason(results(`Authentication-Results: ${AUTHSERV}; dmarc=pass (unclosed`)), 'its topmost Authentication-Results can\'t be read')
  // Another server's header on top: as a message that passed through another server last.
  const other = headers(gmailPlain(), 'Authentication-Results: mx.other.example; dmarc=pass header.from=example.com')
  assert.deepEqual(check(other), { ok: false, reason: 'its topmost Authentication-Results is another server\'s', sender: OWNER_GMAIL, authserv: 'mx.other.example' })
  // A header forged by the sender, below the provider's, which says the truth: never read.
  const forged = Buffer.from(
    gmailPlain({ dmarc: 'fail' })
      .toString('latin1')
      .replace('MIME-Version: 1.0', `Authentication-Results: ${AUTHSERV}; dmarc=pass header.from=example.com\r\nMIME-Version: 1.0`),
    'latin1',
  )
  assert.equal(readHeaderBlock(forged).filter(line => line.name === 'authentication-results').length, 2)
  assert.equal(reason(forged), 'dmarc=fail')
  // The server's name and the result, in any case, and the version after the name.
  assert.equal(check(results(`Authentication-Results: MX.Google.COM 1; DMARC=Pass header.from=example.com`)).ok, true)
  // Without the setting, which only `email-check` runs without, nothing passes.
  assert.equal(senderCheck(readHeaderBlock(gmailPlain()), { ...EMAIL, authservId: null }).reason, 'EMAIL_AUTHSERV_ID isn\'t set')
})

test('email: a header block that doesn\'t end, or holds a line that is no header, can\'t be read, and is skipped', () => {
  assert.equal(readHeaderBlock(Buffer.from('From: a@example.com\r\nSubject: no end')), null)
  assert.equal(readHeaderBlock(Buffer.from('From: a@example.com\r\nnot a header\r\n\r\n')), null)
  assert.equal(readHeaderBlock(Buffer.from(' folded first\r\nFrom: a@example.com\r\n\r\n')), null)
  assert.equal(readHeaderBlock(Buffer.from('Fr om: a@example.com\r\n\r\n')), null)
  assert.deepEqual(readHeaderBlock(Buffer.from('From: a@example.com\nSubject: one\n\ttwo\n\nbody')), [
    { name: 'from', value: ' a@example.com' },
    { name: 'subject', value: ' one\ttwo' },
  ])
  assert.deepEqual(senderCheck(null, EMAIL), { ok: false, reason: 'its header block can\'t be read', sender: null, authserv: null })
})

test('email: the address in From, and the results of Authentication-Results, as the check reads them', () => {
  assert.deepEqual(fromAddress(' "A; B" <x@example.com>'), { address: 'x@example.com' })
  assert.deepEqual(fromAddress(' (a, comment) x@example.com'), { address: 'x@example.com' })
  assert.deepEqual(fromAddress(' x@example.com, y@example.com'), { problem: 'its From header holds several addresses' })
  assert.deepEqual(readAuthResults(' mx.google.com;\r\n       dkim=pass header.i=@example.com;\r\n       spf=pass (google.com: domain of a@example.com designates 1.2.3.4) smtp.mailfrom=a@example.com;\r\n       dmarc=pass (p=NONE) header.from=example.com'), {
    authserv: 'mx.google.com',
    results: [
      { method: 'dkim', result: 'pass' },
      { method: 'spf', result: 'pass' },
      { method: 'dmarc', result: 'pass' },
    ],
  })
  assert.deepEqual(readAuthResults(' mx.google.com; none'), { authserv: 'mx.google.com', results: [] })
  assert.deepEqual(readAuthResults(' mx.example.com; dmarc=pass header.from="a;b"'), { authserv: 'mx.example.com', results: [{ method: 'dmarc', result: 'pass' }] })
  assert.equal(readAuthResults(' '), null)
})

// ---------------------------------------------------------------------------------------------
// The datastore line's ID and time

test('email: sourceId is the Message-ID without its brackets, and at is the Date header\'s', () => {
  const lines = raw => readHeaderBlock(raw)
  assert.equal(messageIdOf(lines(gmailPlain())), 'CAF3x9qR2pZ8mWk1y=dinner@mail.gmail.com')
  // Outlook folds it onto a line of its own.
  assert.equal(messageIdOf(lines(outlookHtmlOnly())), 'PN3P287MB1234A1B2C3D4E5F6A7B8C9D0E1F2A@PN3P287MB1234.INDP287.PROD.OUTLOOK.COM')
  for (const value of [null, 'Message-ID: not-in-brackets@x', 'Message-ID: <a@x> <b@x>', 'Message-ID: <a b@x>', 'Message-ID: <a@x>\nMessage-ID: <b@x>']) {
    assert.equal(messageIdOf(lines(replaceHeader(gmailPlain(), 'Message-ID', value))), null, String(value))
  }
  assert.equal(dateOf(lines(gmailPlain())), '2026-11-09T15:42:28Z')
  assert.equal(dateOf(lines(outlookHtmlOnly())), '2026-11-09T16:20:05Z')
  const date = value => dateOf(lines(replaceHeader(gmailPlain(), 'Date', value)))
  assert.equal(date('Date: 9 Nov 2026 21:12 +0530 (IST)'), '2026-11-09T15:42:00Z')
  assert.equal(date('Date: Mon, 09 Nov 2026 07:42:41 PST'), '2026-11-09T15:42:41Z')
  // Without a zone it would depend on the bridge's own, and isn't read; nor is a day that isn't.
  for (const value of [null, 'Date: Mon, 9 Nov 2026 21:12:28', 'Date: yesterday', 'Date: 31 Feb 2026 10:00:00 +0000', 'Date: 9 Nov 26 10:00:00 +0000', 'Date: 9 Nov 2026 10:00:00 +0000\nDate: 9 Nov 2026 11:00:00 +0000']) {
    assert.equal(date(value), null, String(value))
  }
})

test('email: the record of an email: the whole message first, then its attachments; cut text and subject', () => {
  const lines = readHeaderBlock(appleMailAudio())
  const parsed = { uid: 7, uidValidity: 42, arrivedAt: '2026-11-09T16:12:40Z', size: 900, fetched: 'whole', parsed: true, subject: 'Call with Sam', text: 'Recording.', attachments: [{ name: 'Call with Sam.m4a', mime: 'audio/x-m4a', bytes: 36 }] }
  const record = emailRecord({ parsed, lines, size: 900 })
  assert.deepEqual(record, {
    source: 'email',
    id: '5E4F3A2B-1C0D-4E9F-8A7B-6C5D4E3F2A1B@example.net',
    at: '2026-11-09T16:12:17Z',
    text: 'Recording.',
    subject: 'Call with Sam',
    attachments: [
      { type: 'email', mime: 'message/rfc822', name: null, bytes: 900, error: null },
      { type: 'audio', mime: 'audio/x-m4a', name: 'Call with Sam.m4a', bytes: 36, error: null },
    ],
    replyToId: null,
    replyToPreview: null,
    reactionToId: null,
    reactionEmoji: null,
    edited: false,
    revoked: false,
    forwarded: false,
  })
  // No Message-ID or Date that can be read: the UID, and the time it arrived.
  const bare = readHeaderBlock(replaceHeader(replaceHeader(appleMailAudio(), 'Message-Id', null), 'Date', null))
  assert.deepEqual([emailRecord({ parsed, lines: bare, size: 900 }).id, emailRecord({ parsed, lines: bare, size: 900 }).at], ['imap-42-7', '2026-11-09T16:12:40Z'])
  // The text cut at 20,000 characters, and the subject at 1,000, each with a note.
  const long = emailRecord({ parsed: { ...parsed, text: `${'é'.repeat(20000)}x`, subject: `${'s'.repeat(1000)}t` }, lines, size: 900 })
  assert.equal(long.text, `${'é'.repeat(20000)}${TEXT_CUT_NOTE}`)
  assert.equal(long.subject, `${'s'.repeat(1000)}${SUBJECT_CUT_NOTE}`)
  assert.equal(emailRecord({ parsed: { ...parsed, text: 'é'.repeat(20000) }, lines, size: 900 }).text, 'é'.repeat(20000))
})

test('email: parsed.json is checked field by field, and a bad one is refused', () => {
  const good = { uid: 1, uidValidity: 2, arrivedAt: '2026-11-09T16:12:40Z', size: 10, fetched: 'whole', parsed: true, subject: '', text: '', attachments: [{ name: null, mime: 'application/pdf', bytes: 3 }] }
  assert.deepEqual(checkParsed(good), [])
  const bad = [
    [null, 'not an object'],
    [{ ...good, extra: 1 }, 'unknown field extra'],
    [{ ...good, uid: 0 }, 'uid must be a UID'],
    [{ ...good, uidValidity: '2' }, 'uidValidity must be a UIDVALIDITY'],
    [{ ...good, arrivedAt: '2026-11-09' }, 'arrivedAt must be a UTC time to the second'],
    [{ ...good, size: -1 }, 'size must be a size in bytes'],
    [{ ...good, fetched: 'part' }, 'fetched must be whole or headers'],
    [{ ...good, parsed: 'yes' }, 'parsed must be true or false'],
    [{ ...good, subject: 's'.repeat(1002) }, 'subject must be a text of at most 1001 characters'],
    [{ ...good, text: 't'.repeat(20002) }, 'text must be a text of at most 20001 characters'],
    [{ ...good, attachments: [{ name: '', mime: 'application/pdf', bytes: 3 }] }, 'attachments must be a list of { name, mime, bytes }'],
    [{ ...good, attachments: [{ name: 'x', mime: 'pdf', bytes: 3 }] }, 'attachments must be a list of { name, mime, bytes }'],
    [{ ...good, attachments: [{ name: 'x', mime: 'application/pdf', bytes: 3, file: '../../etc/shadow' }] }, 'attachments must be a list of { name, mime, bytes }'],
    [{ ...good, fetched: 'headers' }, 'an email fetched without its body has no text or attachments'],
    [{ ...good, parsed: false }, 'an email that couldn\'t be parsed has no subject, text or attachments'],
  ]
  for (const [value, problem] of bad) assert.deepEqual(checkParsed(value), [problem], JSON.stringify(value)?.slice(0, 80))
})

// ---------------------------------------------------------------------------------------------
// The spool

function bridgeSettings(root, email = EMAIL) {
  return {
    side: 'bridge',
    dataDir: path.join(root, 'data'),
    configDir: path.join(root, 'config'),
    timeZone: 'Asia/Kolkata',
    ownerNumber: OWNER_NUMBER,
    ownerJids: [],
    defaultChannel: 'whatsapp',
    email,
    backupTime: '03:30',
    backup: null,
  }
}

// The bridge, with email on, the reader's stub and the wacli stub, not paired, and a fake clock.
async function setup(t, { email = EMAIL, users = null, prepare } = {}) {
  const root = makeTestDir(t)
  createWacliStub(t, root).fixtures({ paired: false })
  const reader = createMailReaderStub(root)
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const clock = createFakeClock('2026-11-09T16:15:00Z')
  const { log, entries, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const settings = bridgeSettings(root, email)
  const paths = makePaths(settings)
  await prepare?.({ root, reader, paths })
  const lookupUser = users ? async name => users[name] ?? null : isRoot ? async () => null : proc.lookupUser
  const bridge = await startBridge({ settings, clock, log, proc: { ...proc, lookupUser }, emailReader: reader.reader })
  atEnd(t, () => bridge.stop())
  const channel = bridge.channels.get('email')
  const context = {
    root,
    reader,
    clock,
    log,
    entries,
    events,
    settings,
    paths,
    bridge,
    channel,
    lines: () => [...bridge.store.index.entries()].map(entry => entry.line),
    dayDir: path.join(paths.datastore, '2026/11/09'),
    // Lets the bridge look at the spool, and waits until it has taken what was there.
    async take(rounds = 2) {
      for (let n = 0; n < rounds; n++) {
        await clock.advance(SECOND)
        await channel.idle()
        await bridge.intake.idle()
      }
    },
  }
  await waitFor(() => reader.calls().length > 0, 'the email reader to start')
  return context
}

let folderCount = 0
// Places a folder in the spool as the reader writes one: `message.eml`, `parsed.json` and the
// parts. `parsed` changes the description; `files` changes or adds files by name.
function spool(context, { raw = gmailPlain(), parsed = {}, parts = [], files = {}, name } = {}) {
  const id = name ?? `20261109T161500000-${String(++folderCount).padStart(4, '0')}`
  const dir = path.join(context.paths.mailSpool, id)
  fs.mkdirSync(dir, { mode: 0o700 })
  const description = { uid: folderCount, uidValidity: 3857529045, arrivedAt: '2026-11-09T16:12:40Z', size: raw.length, fetched: 'whole', parsed: true, subject: '', text: '', attachments: [], ...parsed }
  const all = { 'message.eml': raw, 'parsed.json': JSON.stringify(description), ...Object.fromEntries(parts.map((content, n) => [`part-${n + 1}`, content])), ...files }
  for (const [file, content] of Object.entries(all)) if (content !== null) fs.writeFileSync(path.join(dir, file), content, { mode: 0o600 })
  return id
}

test('email: the bridge refuses to start with email on and no EMAIL_AUTHSERV_ID', async t => {
  const root = makeTestDir(t)
  const clock = createFakeClock()
  const { log } = createTestLog({ clock })
  await assert.rejects(startBridge({ settings: bridgeSettings(root, { ...EMAIL, authservId: null }), clock, log }), error => {
    assert.ok(error instanceof BridgeConfigError)
    assert.match(error.message, /^EMAIL_AUTHSERV_ID is required when EMAIL_IMAP_HOST is set; `scooter email-check` shows what to set it to$/)
    return true
  })
})

test('email: emails from the spool become the right lines and attachments: the whole message first, then the parts', async t => {
  const context = await setup(t)
  const memo = appleMailAudio()
  const booking = gmailForwardedBooking()
  spool(context, { raw: memo, parsed: { subject: 'Call with Sam', text: "Recording from today's call.", attachments: [{ name: 'Call with Sam.m4a', mime: 'audio/x-m4a', bytes: M4A.length }] }, parts: [M4A] })
  spool(context, { raw: booking, parsed: { subject: 'Fwd: Your booking is confirmed: PNR X7Y2KQ', text: 'Work trip.', attachments: [{ name: 'E-ticket X7Y2KQ.pdf', mime: 'application/pdf', bytes: PDF.length }] }, parts: [PDF] })
  spool(context, { raw: outlookHtmlOnly(), parsed: { subject: 'Taxi receipt', text: 'Taxi from the airport, ₹850.' } })
  await context.take()

  assert.deepEqual(context.lines(), [
    {
      seq: 1,
      kind: 'message',
      dir: 'in',
      at: '2026-11-09T16:12:17Z',
      source: 'email',
      sourceId: '5E4F3A2B-1C0D-4E9F-8A7B-6C5D4E3F2A1B@example.net',
      trust: 'owner',
      subject: 'Call with Sam',
      text: "Recording from today's call.",
      files: [
        { path: '1.eml', mime: 'message/rfc822', bytes: memo.length },
        { path: '1-2.m4a', mime: 'audio/x-m4a', name: 'Call with Sam.m4a', bytes: M4A.length },
      ],
    },
    {
      seq: 2,
      kind: 'message',
      dir: 'in',
      at: '2026-11-09T12:50:51Z',
      source: 'email',
      sourceId: 'CAF3x9qR2pZ8mWk1y=fwd@mail.gmail.com',
      trust: 'owner',
      subject: 'Fwd: Your booking is confirmed: PNR X7Y2KQ',
      text: 'Work trip.',
      files: [
        { path: '2.eml', mime: 'message/rfc822', bytes: booking.length },
        { path: '2-2.pdf', mime: 'application/pdf', name: 'E-ticket X7Y2KQ.pdf', bytes: PDF.length },
      ],
    },
    {
      seq: 3,
      kind: 'message',
      dir: 'in',
      at: '2026-11-09T16:20:05Z',
      source: 'email',
      sourceId: 'PN3P287MB1234A1B2C3D4E5F6A7B8C9D0E1F2A@PN3P287MB1234.INDP287.PROD.OUTLOOK.COM',
      trust: 'owner',
      subject: 'Taxi receipt',
      text: 'Taxi from the airport, ₹850.',
      files: [{ path: '3.eml', mime: 'message/rfc822', bytes: outlookHtmlOnly().length }],
    },
  ])
  assert.deepEqual(fs.readFileSync(path.join(context.dayDir, '1.eml')), memo)
  assert.deepEqual(fs.readFileSync(path.join(context.dayDir, '1-2.m4a')), M4A)
  assert.deepEqual(fs.readFileSync(path.join(context.dayDir, '2-2.pdf')), PDF)
  // Taken folders are deleted.
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [])
  assert.deepEqual(context.events().filter(event => event === 'email.stored').length, 3)
})

test('email: a folder counts only once it is renamed', async t => {
  const context = await setup(t)
  // The reader removes what it left unfinished when it opens the spool, before it connects.
  await waitFor(() => context.channel.status().startsWith('Email: connected'), 'the reader to connect')
  spool(context, { name: '.tmp-20261109T161500000-0001' })
  await context.take()
  assert.deepEqual(context.lines(), [])
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), ['.tmp-20261109T161500000-0001'])
})

test('email: the bridge refuses a bad parsed.json, picks file names itself, and takes the next folder', async t => {
  const context = await setup(t)
  const bad = [
    spool(context, { files: { 'parsed.json': '{"uid":' } }),
    spool(context, { parsed: { attachments: [{ name: 'x', mime: 'text/plain', bytes: 1 }], extra: true }, parts: ['x'] }),
    spool(context, { files: { 'parsed.json': null } }),
    spool(context, { files: { 'message.eml': null } }),
  ]
  // A link in place of a file: the bridge, as root, mustn't read what the reader can't.
  const linked = spool(context)
  fs.rmSync(path.join(context.paths.mailSpool, linked, 'parsed.json'))
  fs.symlinkSync('/etc/hostname', path.join(context.paths.mailSpool, linked, 'parsed.json'))
  // A file where a folder should be.
  fs.writeFileSync(path.join(context.paths.mailSpool, '20261109T161500000-0900'), 'x')
  // A link where a folder should be, to a folder laid out as a spool folder outside the spool: the
  // bridge, as root, reads and removes nothing it leads to.
  const elsewhere = path.join(context.root, 'elsewhere')
  fs.mkdirSync(elsewhere)
  for (const [file, content] of [['message.eml', gmailPlain()], ['parsed.json', '{}'], ['part-1', 'x']]) fs.writeFileSync(path.join(elsewhere, file), content)
  fs.symlinkSync(elsewhere, path.join(context.paths.mailSpool, '20261109T161500000-0901'))
  // Original names that would lead elsewhere are names, never paths.
  spool(context, {
    parsed: { attachments: [{ name: '../../../etc/cron.d/x.sh', mime: 'text/x-sh', bytes: 2 }, { name: 'notes.txt/..', mime: 'text/plain', bytes: 2 }] },
    parts: ['#!', 'hi'],
  })
  await context.take()

  await context.take(5)
  const refusals = context.entries.filter(entry => entry.event === 'email.refused')
  assert.deepEqual(
    refusals.map(entry => [entry.folder, entry.reason, entry.left ?? false]),
    [
      [bad[0], 'parsed.json is not JSON', false],
      [bad[1], 'parsed.json: unknown field extra', false],
      [bad[2], 'parsed.json can\'t be read (ENOENT)', false],
      [bad[3], 'message.eml can\'t be read (ENOENT)', false],
      [linked, 'parsed.json can\'t be read (EUNTRUSTED)', false],
      // Left where it is, for the reader to remove, and said once, not at every look.
      ['20261109T161500000-0900', 'it is not a folder', true],
      ['20261109T161500000-0901', 'it is not a folder', true],
    ],
  )
  const [line] = context.lines()
  // The stored names are the bridge's: `<seq>-<n>.<ext>`, the extension from the original name
  // when it is one, else from the MIME type.
  assert.deepEqual(
    line.files.map(file => [file.path, file.name]),
    [
      ['1.eml', undefined],
      ['1-2.sh', '../../../etc/cron.d/x.sh'],
      ['1-3.txt', 'notes.txt/..'],
    ],
  )
  assert.deepEqual(fs.readdirSync(context.dayDir).sort(), ['1-2.sh', '1-3.txt', '1.eml', 'log.jsonl'])
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool).sort(), ['20261109T161500000-0900', '20261109T161500000-0901'])
  assert.deepEqual(fs.readdirSync(elsewhere).sort(), ['message.eml', 'parsed.json', 'part-1'])
  // The link was removed as a link.
  assert.ok(fs.existsSync('/etc/hostname'))
})

test('email: a duplicate Message-ID is skipped, as when a renumbered mailbox hands over again', async t => {
  const context = await setup(t)
  spool(context, { parsed: { text: 'first' } })
  spool(context, { parsed: { uid: 900, uidValidity: 1, text: 'again' } })
  await context.take()
  assert.deepEqual(context.lines().map(line => line.text), ['first'])
  assert.ok(context.entries.some(entry => entry.event === 'intake.skipped' && entry.reason === 'duplicate'))
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [])
})

test('email: an email that couldn\'t be parsed is stored with its .eml and an error, and the ones after it still arrive', async t => {
  const context = await setup(t)
  const raw = gmailPlain({ messageId: '<broken@mail.example>' })
  spool(context, { raw, parsed: { parsed: false } })
  spool(context, { parsed: { text: 'next' } })
  await context.take()
  const [broken, next] = context.lines()
  assert.deepEqual(
    { files: broken.files, media: broken.media, subject: broken.subject, text: broken.text },
    { files: [{ path: '1.eml', mime: 'message/rfc822', bytes: raw.length }], media: { type: 'email', error: 'could not be parsed' }, subject: '', text: '' },
  )
  assert.equal(next.text, 'next')
})

test('email: one too large to fetch, from the owner, is stored without its body, and says so', async t => {
  const context = await setup(t)
  const raw = appleMailAudio()
  const header = raw.subarray(0, raw.indexOf('\r\n\r\n') + 4)
  spool(context, { raw: header, parsed: { fetched: 'headers', size: limits.ATTACHMENT_MAX_BYTES + 1, subject: 'Call with Sam' } })
  await context.take()
  const [line] = context.lines()
  assert.deepEqual(
    { subject: line.subject, text: line.text, files: line.files, media: line.media },
    { subject: 'Call with Sam', text: '', files: undefined, media: { type: 'email', mime: 'message/rfc822', error: 'too large, not downloaded' } },
  )
})

test('email: an email is a message, whatever its text', async t => {
  const context = await setup(t)
  spool(context, { parsed: { text: '/status' } })
  await context.take()
  assert.deepEqual(context.lines().map(line => [line.kind, line.text]), [['message', '/status']])
})

test('email: mail that fails the sender check isn\'t stored; it is logged with its sender, reason and UID, and counted', async t => {
  const context = await setup(t)
  const other = stranger()
  spool(context, { raw: other.subarray(0, other.indexOf('\r\n\r\n') + 4), parsed: { uid: 31, fetched: 'headers', subject: 'Our best offers' } })
  spool(context, { raw: gmailPlain({ dmarc: 'fail' }), parsed: { uid: 32, subject: 'Dinner at Bombay Canteen', text: 'spoofed' } })
  spool(context, { raw: Buffer.from('From: x\r\nno end'), parsed: { uid: 33 } })
  await context.take()
  assert.deepEqual(context.lines(), [])
  assert.deepEqual(
    context.entries.filter(entry => entry.event === 'email.skipped').map(({ uid, sender, reason }) => ({ uid, sender, reason })),
    [
      { uid: 31, sender: STRANGER, reason: 'From isn\'t one of the owner\'s addresses' },
      { uid: 32, sender: OWNER_GMAIL, reason: 'dmarc=fail' },
      { uid: 33, sender: null, reason: 'its header block can\'t be read' },
    ],
  )
  // Never its subject or contents.
  const logged = JSON.stringify(context.entries)
  for (const word of ['Our best offers', 'Bombay', 'spoofed', 'Buy now']) assert.ok(!logged.includes(word), word)
  assert.match(context.channel.status(), /; 0 stored and 3 skipped since the bridge started, 21:45\.$/)
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [])
})

test('email: its status says whether the reader is connected, when it last looked, and what was stored and skipped', async t => {
  const context = await setup(t)
  let line
  await waitFor(() => (line = context.channel.status()).startsWith('Email: connected, last checked'), 'the reader to connect')
  // The reader runs in its stub's process, with the real clock, and the bridge with the test's: the
  // time it last looked is shown with a date, and with a year once the real year isn't the test's.
  assert.match(line, /^Email: connected, last checked (\d\d:\d\d|\w{3} \d+ \w{3}( \d{4})? \d\d:\d\d); 0 stored and 0 skipped since the bridge started, 21:45\.$/)
  spool(context, { parsed: { text: 'one' } })
  spool(context, { raw: stranger(), parsed: { uid: 99, fetched: 'whole' } })
  await context.take()
  assert.match(context.channel.status(), /; 1 stored and 1 skipped since the bridge started, 21:45\.$/)
  // A day later, they have left the window.
  await context.clock.advance(24 * 3600 * SECOND)
  assert.match(context.channel.status(), /; 0 stored and 0 skipped in the last 24 hours\.$/)

  await context.bridge.stop()
  assert.equal(context.channel.status(), 'Email: stopped; 0 stored and 0 skipped in the last 24 hours.')
  // In what `scooter status` prints, beside WhatsApp's line, from the bridge's status.json.
  const { readIndex, statusText } = await import('../src/bridge/status.mjs')
  const text = statusText({ now: context.clock.now(), settings: context.settings, paths: context.paths, index: readIndex(context.paths) })
  assert.match(text, /^WhatsApp: stopped\nEmail: stopped; 0 stored and 0 skipped in the last 24 hours\.$/m)
})

test('email: a folder the store can\'t take now stays, and is tried again after waits that grow', async t => {
  const root = makeTestDir(t)
  const reader = createMailReaderStub(root)
  const clock = createFakeClock('2026-11-09T16:15:00Z')
  const { log, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const settings = bridgeSettings(root)
  const paths = makePaths(settings)
  const channel = createEmail({ settings, paths, proc, log, clock, reader: reader.reader })
  const results = [{ stored: false, reason: 'failed' }, { stored: false, reason: 'failed' }, { stored: true, seq: 1 }]
  const taken = []
  await channel.start(async record => {
    taken.push({ at: clock.now(), id: record.id })
    return results.shift()
  })
  atEnd(t, () => channel.stop())
  fs.mkdirSync(paths.mailSpool, { recursive: true })
  const context = { paths }
  spool(context)
  const start = clock.now()
  for (let n = 0; n < 20; n++) {
    await clock.advance(SECOND)
    await channel.idle()
  }
  // Taken at once, then again 5 seconds later, then 10 seconds after that.
  assert.deepEqual(
    taken.map(({ at }) => (at - start) / SECOND),
    [1, 6, 16],
  )
  assert.deepEqual(fs.readdirSync(paths.mailSpool), [])
  assert.deepEqual(events().filter(event => event === 'email.spool_failed').length, 2)
})

// An email with an attachment, as the reader hands it over.
const spoolMemo = context =>
  spool(context, {
    raw: appleMailAudio(),
    parsed: { subject: 'Call with Sam', text: 'Recording.', attachments: [{ name: 'Call with Sam.m4a', mime: 'audio/x-m4a', bytes: M4A.length }] },
    parts: [M4A],
  })

test('email: an email whose files the bridge can\'t copy, as on a full disk, stays whole in the spool, and is stored with them once it can', async t => {
  const context = await setup(t)
  // A copy that fails on the bridge's side isn't tried again in place, whatever the retries.
  atEnd(t, overrideLimits({ MEDIA_DOWNLOAD_RETRIES: 0 }))
  spool(context, { parsed: { text: 'first' } })
  await context.take()
  const id = spoolMemo(context)
  // The copy into `bridge/incoming/` fails, as on a full disk, while the datastore can still take
  // a line.
  const open = fs.promises.open
  let full = true
  fs.promises.open = (target, flags, ...rest) =>
    full && String(target).startsWith(context.paths.bridgeIncoming) && /^w/.test(flags)
      ? Promise.reject(Object.assign(new Error(`ENOSPC: no space left on device, open '${target}'`), { code: 'ENOSPC', syscall: 'open' }))
      : open(target, flags, ...rest)
  atEnd(t, () => (fs.promises.open = open))
  await context.take()
  assert.deepEqual(context.lines().map(line => line.text), ['first'])
  assert.deepEqual(fs.readdirSync(path.join(context.paths.mailSpool, id)).sort(), ['message.eml', 'parsed.json', 'part-1'])
  assert.deepEqual(context.events().filter(event => event === 'email.spool_failed').length, 1)

  full = false
  await context.take(5)
  const [, line] = context.lines()
  assert.deepEqual(
    { text: line.text, files: line.files.map(file => file.path), media: line.media },
    { text: 'Recording.', files: ['2.eml', '2-2.m4a'], media: undefined },
  )
  assert.deepEqual(fs.readFileSync(path.join(context.dayDir, '2-2.m4a')), M4A)
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [])
})

test('email: a spool file the bridge can\'t open for a reason of its own, such as no file descriptors left, keeps the email whole in the spool', async t => {
  const context = await setup(t)
  atEnd(t, overrideLimits({ MEDIA_DOWNLOAD_RETRIES: 0 }))
  spool(context, { parsed: { text: 'first' } })
  await context.take()
  const id = spoolMemo(context)
  // Opening the spool's file fails with EMFILE, an error with the file's path that isn't about
  // the file.
  const open = fs.promises.open
  let out = true
  fs.promises.open = (target, flags, ...rest) =>
    out && String(target).startsWith(path.join(context.paths.mailSpool, id))
      ? Promise.reject(Object.assign(new Error(`EMFILE: too many open files, open '${target}'`), { code: 'EMFILE', syscall: 'open', path: String(target) }))
      : open(target, flags, ...rest)
  atEnd(t, () => (fs.promises.open = open))
  await context.take()
  assert.deepEqual(context.lines().map(line => line.text), ['first'])
  assert.deepEqual(fs.readdirSync(path.join(context.paths.mailSpool, id)).sort(), ['message.eml', 'parsed.json', 'part-1'])

  out = false
  await context.take(5)
  const [, line] = context.lines()
  assert.deepEqual({ files: line.files.map(file => file.path), media: line.media }, { files: ['2.eml', '2-2.m4a'], media: undefined })
})

test('email: a part missing from the spool is the email\'s own, and isn\'t tried again: the email is stored without it at once', async t => {
  const context = await setup(t)
  // Three parts listed, none there: before, each was tried three times, 10 seconds apart.
  spool(context, {
    parsed: { text: 'Three files.', attachments: [1, 2, 3].map(n => ({ name: `f${n}.txt`, mime: 'text/plain', bytes: 1 })) },
    files: {},
  })
  await context.take()
  const [line] = context.lines()
  assert.deepEqual(line.files.map(file => file.path), ['1.eml'])
  assert.deepEqual(line.media, { type: 'document', mime: 'text/plain', error: 'download failed' })
  const failures = context.entries.filter(entry => entry.event === 'intake.download_failed')
  assert.deepEqual(failures.map(entry => [entry.n, entry.attempt]), [[2, 1], [3, 1], [4, 1]])
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [])
})

test('email: an email whose files can\'t go into the day folder stays whole in the spool, and is stored with them later', { skip: skipIfRoot }, async t => {
  const context = await setup(t)
  spool(context, { parsed: { text: 'first' } })
  await context.take()
  // The day folder, with its log, can't take another file.
  fs.chmodSync(context.dayDir, 0o500)
  atEnd(t, () => fs.chmodSync(context.dayDir, 0o750))
  const id = spoolMemo(context)
  await context.take()
  assert.deepEqual(context.lines().map(line => line.text), ['first'])
  assert.deepEqual(fs.readdirSync(path.join(context.paths.mailSpool, id)).sort(), ['message.eml', 'parsed.json', 'part-1'])

  fs.chmodSync(context.dayDir, 0o750)
  await context.take(5)
  const [, line] = context.lines()
  assert.deepEqual(
    { text: line.text, files: line.files.map(file => file.path), media: line.media },
    { text: 'Recording.', files: ['2.eml', '2-2.m4a'], media: undefined },
  )
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [])
})

test('email: a folder the bridge is done with is removed by the names the reader writes; one holding anything else is left, and said once', async t => {
  const context = await setup(t)
  const id = spool(context, { parsed: { text: 'one' }, files: { 'notes.txt': 'not a name the reader writes' } })
  spool(context, { raw: gmailPlain({ messageId: '<two@mail.example>' }), parsed: { text: 'two' } })
  await context.take(5)
  assert.deepEqual(context.lines().map(line => line.text), ['one', 'two'])
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [id])
  assert.deepEqual(fs.readdirSync(path.join(context.paths.mailSpool, id)), ['notes.txt'])
  assert.deepEqual(context.entries.filter(entry => entry.event === 'email.not_removed').map(entry => [entry.folder, entry.code]), [[id, 'ENOTEMPTY']])
})

test('email: a spool the reader made a link is not looked into, and nothing the link leads to is removed', async t => {
  const context = await setup(t)
  await waitFor(() => context.channel.status().startsWith('Email: connected'), 'the reader to connect')
  // As the reader could make the spool lead to the data folder: folders as the data folder holds
  // them, and one named as a spool folder is.
  const elsewhere = path.join(context.root, 'elsewhere')
  for (const name of ['agents', 'datastore', '20261109T161500000-0001']) {
    fs.mkdirSync(path.join(elsewhere, name), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, name, 'kept'), 'kept')
  }
  fs.renameSync(context.paths.mailSpool, path.join(context.paths.mail, 'spool-before'))
  fs.symlinkSync(elsewhere, context.paths.mailSpool)
  await context.take(10)
  for (const name of ['agents', 'datastore', '20261109T161500000-0001']) assert.ok(fs.existsSync(path.join(elsewhere, name, 'kept')), name)
  assert.deepEqual(context.entries.filter(entry => entry.event === 'email.refused'), [])
  const failed = context.entries.filter(entry => entry.event === 'email.spool_failed')
  assert.ok(failed.length > 0 && failed.every(entry => entry.code === 'EUNTRUSTED'))
  // Tried again after waits that grow, not every second.
  assert.ok(failed.length < 5, `${failed.length} looks`)
})

// ---------------------------------------------------------------------------------------------
// The reader as a program, and least privilege

test('email: the reader runs with the mailbox\'s settings and nothing else of the bridge\'s, and no password on its command line', async t => {
  const context = await setup(t)
  const [call] = context.reader.calls()
  assert.deepEqual(call.args, ['run'])
  assert.deepEqual(call.env, readerEnv(context.settings, context.paths))
  assert.deepEqual(Object.keys(call.env).sort(), ['EMAIL_CHECK_SECONDS', 'EMAIL_IMAP_HOST', 'EMAIL_IMAP_PORT', 'EMAIL_OWNER_ADDRESSES', 'EMAIL_PASSWORD', 'EMAIL_USER', 'HOME', 'LANG', 'PATH', 'TZ'])
  assert.deepEqual([call.env.HOME, call.env.TZ, call.env.EMAIL_IMAP_PORT, call.env.EMAIL_OWNER_ADDRESSES], [context.paths.mail, 'UTC', '993', OWNER_ADDRESSES.join(',')])
  assert.ok(!JSON.stringify(call.args).includes('mailbox-password-123'))
  assert.ok(!('EMAIL_AUTHSERV_ID' in call.env))
  // Its folders are 0700, and it writes only there.
  for (const dir of [context.paths.mail, context.paths.mailSpool]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir)
  await waitFor(() => fs.existsSync(context.paths.mailState), 'the reader\'s position')
  if (!isRoot) assert.equal(call.uid, process.getuid())
  // In production the reader is this Node, running src/mail/reader.mjs, deaf to SIGUSR1.
  assert.deepEqual(DEFAULT_READER, { program: process.execPath, args: ['--disable-sigusr1', fileURLToPath(new URL('../src/mail/reader.mjs', import.meta.url))] })
})

test('email: the reader\'s Node ignores SIGUSR1, the bridge\'s signal to back up, rather than open its debugger to local users', async t => {
  // The reader's own Node options, before its file, with a program that waits in its place.
  const options = DEFAULT_READER.args.slice(0, -1)
  const child = spawn(DEFAULT_READER.program, [...options, '-e', 'process.stdout.write("ready\\n"); setTimeout(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  atEnd(t, () => child.kill('SIGKILL'))
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  await new Promise(resolve => child.stdout.once('data', resolve))
  child.kill('SIGUSR1')
  assert.deepEqual(await exited, { code: 0, signal: null })
  assert.ok(!/Debugger listening/.test(stderr), stderr)
})

test('email: every wacli call is still without the mailbox\'s password, with email on', async t => {
  const context = await setup(t)
  const wacliCalls = fs.readFileSync(path.join(context.root, 'stub', 'calls.jsonl'), 'utf8')
  assert.ok(!wacliCalls.includes('mailbox-password-123'))
  assert.ok(!wacliCalls.includes('EMAIL_'))
})

test('email: the reader is started again with backoff when it exits, and its status says so meanwhile', async t => {
  const context = await setup(t, { prepare: ({ reader }) => reader.set({ connectFails: true }) })
  await waitFor(() => context.events().includes('proc.exited'), 'the reader to exit')
  assert.equal(context.channel.status(), 'Email: the reader stopped, and starts again shortly; 0 stored and 0 skipped since the bridge started, 21:45.')
  assert.equal(context.reader.calls().length, 1)
  assert.deepEqual(context.reader.log().filter(entry => entry.event === 'mail.failed').map(entry => entry.code), ['ECONNREFUSED'])
  // 5 seconds later it starts again, and works once the mailbox does.
  context.reader.set({ connectFails: false })
  await context.clock.advance(limits.RESTART_BACKOFF.first)
  await waitFor(() => context.reader.calls().length === 2, 'the second start')
  await waitFor(() => context.channel.status().startsWith('Email: connected'), 'the reader to connect')
})

test('email: stopping stops the reader and the spool\'s consumer', async t => {
  const context = await setup(t)
  await waitFor(() => context.channel.status().startsWith('Email: connected'), 'the reader to connect')
  const { pid } = context.reader.calls()[0]
  await context.bridge.stop()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  // The reader saved its position on the way out.
  assert.equal(JSON.parse(fs.readFileSync(context.paths.mailState, 'utf8')).connected, false)
  spool(context)
  await context.clock.advance(5 * SECOND)
  assert.deepEqual(context.lines(), [])
})

test('email: as root, the reader runs as its own user, its folders are its own, and the bridge reads only its files', { skip: skipUnlessRoot }, async t => {
  const mailUser = { uid: 4545, gid: 4545 }
  const users = { 'scooter-wacli': { uid: 4242, gid: 4242 }, 'scooter-runner': { uid: 4343, gid: 4343 }, 'scooter-mail': mailUser }
  const context = await setup(t, {
    users,
    prepare: ({ root, reader }) => {
      // The reader passes through the test's folder to reach its own, and its stub's.
      fs.chmodSync(root, 0o755)
      for (const dir of [reader.bin, reader.control, path.join(root, 'stub'), path.join(root, 'bin')]) fs.chmodSync(dir, 0o777)
      for (const file of fs.readdirSync(reader.control)) fs.chmodSync(path.join(reader.control, file), 0o666)
    },
  })
  await waitFor(() => context.channel.status().startsWith('Email: connected'), 'the reader to connect')
  const [call] = context.reader.calls()
  assert.deepEqual([call.uid, call.gid], [4545, 4545])
  for (const dir of [context.paths.mail, context.paths.mailSpool]) {
    const stat = fs.statSync(dir)
    assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777], [4545, 4545, 0o700], dir)
  }
  const state = fs.statSync(context.paths.mailState)
  assert.deepEqual([state.uid, state.mode & 0o777], [4545, 0o600])

  // A folder that isn't the reader's, and one whose parsed.json isn't, are refused. The first is
  // left as it is: the bridge removes nothing the reader couldn't.
  const rootsFolder = spool(context)
  const rootsFile = spool(context)
  fs.chownSync(path.join(context.paths.mailSpool, rootsFile), 4545, 4545)
  const mine = spool(context, { parsed: { text: 'mine' } })
  for (const entry of fs.readdirSync(path.join(context.paths.mailSpool, mine))) fs.chownSync(path.join(context.paths.mailSpool, mine, entry), 4545, 4545)
  fs.chownSync(path.join(context.paths.mailSpool, mine), 4545, 4545)
  await context.take(5)
  assert.deepEqual(
    context.entries.filter(entry => entry.event === 'email.refused').map(entry => [entry.folder, entry.reason, entry.left ?? false]),
    [
      [rootsFolder, 'it is not the email reader\'s', true],
      [rootsFile, 'parsed.json can\'t be read (EUNTRUSTED)', false],
    ],
  )
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [rootsFolder])
  assert.deepEqual(fs.readdirSync(path.join(context.paths.mailSpool, rootsFolder)).sort(), ['message.eml', 'parsed.json'])
  // The email is stored as root's, with the runner's group.
  const [line] = context.lines()
  assert.equal(line.text, 'mine')
  const stored = fs.statSync(path.join(context.dayDir, '1.eml'))
  assert.deepEqual([stored.uid, stored.gid, stored.mode & 0o777], [0, 4343, 0o640])
})

test('email: as root, a spool the reader made a link to the data folder removes nothing there', { skip: skipUnlessRoot }, async t => {
  const users = { 'scooter-wacli': { uid: 4242, gid: 4242 }, 'scooter-runner': { uid: 4343, gid: 4343 }, 'scooter-mail': { uid: 4545, gid: 4545 } }
  const context = await setup(t, {
    users,
    prepare: ({ root, reader }) => {
      fs.chmodSync(root, 0o755)
      for (const dir of [reader.bin, reader.control, path.join(root, 'stub'), path.join(root, 'bin')]) fs.chmodSync(dir, 0o777)
      for (const file of fs.readdirSync(reader.control)) fs.chmodSync(path.join(reader.control, file), 0o666)
    },
  })
  await waitFor(() => context.channel.status().startsWith('Email: connected'), 'the reader to connect')
  // An email stored first, so the data folder holds the record.
  const mine = spool(context, { parsed: { text: 'mine' } })
  for (const entry of fs.readdirSync(path.join(context.paths.mailSpool, mine))) fs.chownSync(path.join(context.paths.mailSpool, mine, entry), 4545, 4545)
  fs.chownSync(path.join(context.paths.mailSpool, mine), 4545, 4545)
  await context.take()
  assert.equal(context.lines().length, 1)
  const before = fs.readdirSync(context.paths.dataDir, { recursive: true }).filter(name => !name.startsWith('mail')).sort()
  assert.ok(before.includes('datastore/2026/11/09/log.jsonl') && before.includes('bridge/state.json'))

  // The reader, which owns `mail/`, puts a link to the data folder in the spool's place, its own,
  // as the review of milestone 6 did; and a folder of root's in the spool, named as the reader's.
  fs.renameSync(context.paths.mailSpool, path.join(context.paths.mail, 'spool-before'))
  fs.symlinkSync(context.paths.dataDir, context.paths.mailSpool)
  fs.lchownSync(context.paths.mailSpool, 4545, 4545)
  await context.take(10)
  fs.rmSync(context.paths.mailSpool)
  fs.renameSync(path.join(context.paths.mail, 'spool-before'), context.paths.mailSpool)
  const rootsFolder = spool(context)
  await context.take(10)

  assert.deepEqual(fs.readdirSync(context.paths.dataDir, { recursive: true }).filter(name => !name.startsWith('mail')).sort(), before)
  assert.deepEqual(fs.readdirSync(context.paths.mailSpool), [rootsFolder])
  assert.ok(context.entries.some(entry => entry.event === 'email.spool_failed' && entry.code === 'EUNTRUSTED'))
})

test('email: a file in the spool the bridge can\'t read is refused, not a reason to stop', { skip: skipIfRoot }, async t => {
  const context = await setup(t)
  const id = spool(context)
  fs.chmodSync(path.join(context.paths.mailSpool, id, 'parsed.json'), 0o000)
  spool(context, { parsed: { text: 'after' } })
  await context.take()
  assert.deepEqual(context.lines().map(line => line.text), ['after'])
  assert.ok(context.entries.some(entry => entry.event === 'email.refused' && entry.reason === 'parsed.json can\'t be read (EACCES)'))
})

// ---------------------------------------------------------------------------------------------
// `email-check`

test('email: email-check lists the newest messages, each with its From, its server and whether it would be kept', async t => {
  const root = makeTestDir(t)
  const reader = createMailReaderStub(root)
  for (const raw of [stranger(), gmailPlain({ dmarc: 'fail' }), appleMailAudio(), outlookHtmlOnly(), gmailPlain(), gmailForwardedBooking()]) reader.deliver(raw)
  const settings = bridgeSettings(root)
  const clock = createFakeClock('2026-11-09T16:30:00Z')
  const { log } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  let out = ''
  let err = ''
  const io = { stdout: { write: text => (out += text) }, stderr: { write: text => (err += text) } }
  const code = await runEmailCheck({ settings, ...io, clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc, reader: reader.reader })
  assert.equal(code, 0, err)
  assert.equal(
    out,
    [
      'The mailbox\'s newest 5 messages, oldest first:',
      '',
      'UID 2, arrived 21:42',
      '  From: owner@example.com',
      '  Topmost Authentication-Results: mx.google.com',
      '  Kept: no, dmarc=fail',
      '',
      'UID 3, arrived 21:42',
      '  From: owner@example.net',
      '  Topmost Authentication-Results: mx.google.com',
      '  Kept: yes',
      '',
      'UID 4, arrived 21:42',
      '  From: owner@example.org',
      '  Topmost Authentication-Results: mx.google.com',
      '  Kept: yes',
      '',
      'UID 5, arrived 21:42',
      '  From: owner@example.com',
      '  Topmost Authentication-Results: mx.google.com',
      '  Kept: yes',
      '',
      'UID 6, arrived 21:42',
      '  From: owner@example.com',
      '  Topmost Authentication-Results: mx.google.com',
      '  Kept: yes',
      '',
    ].join('\n'),
  )
  // It stores nothing, and ran the reader with its own settings.
  assert.equal(fs.existsSync(makePaths(settings).mail), false)
  const [call] = reader.calls()
  assert.deepEqual(call.args, ['newest'])
  assert.deepEqual(call.env, readerEnv(settings, makePaths(settings)))

  // Before EMAIL_AUTHSERV_ID is set, it says what to set it to.
  out = ''
  assert.equal(await runEmailCheck({ settings: bridgeSettings(root, { ...EMAIL, authservId: null }), ...io, clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc, reader: reader.reader }), 0)
  assert.match(out, /  Kept: no, EMAIL_AUTHSERV_ID isn't set\n\nEMAIL_AUTHSERV_ID isn't set\. Send an email from your own address, run this again, and set it to the server named on its\nAuthentication-Results line, which is your mailbox's provider, such as mx\.google\.com\.\n$/)

  // Email off: it says so, and exits with 2. A mailbox it can't reach: 1.
  assert.equal(await runEmailCheck({ settings: bridgeSettings(root, null), ...io }), 2)
  assert.match(err, /scooter email-check: email is off; set EMAIL_IMAP_HOST and the other mailbox settings in bridge\.env\n$/)
  reader.set({ connectFails: true })
  assert.equal(await runEmailCheck({ settings, ...io, clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc, reader: reader.reader }), 1)
  assert.match(err, /scooter email-check: the email reader couldn't read the mailbox \(exit code 1\)\n$/)
})
