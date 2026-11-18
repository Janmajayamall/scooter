// The WhatsApp channel (5.1 and 5.2 of DESIGN.md; section 10, "Intake" and "Least privilege"):
// wacli's two formats, the filters and owner matching, the webhook and its signature, pairing,
// supervision, catch-up, media downloads, and what wacli is given.
//
// The tests from "The channel at work" on run the bridge with the wacli stub first on PATH, and a
// fake clock for every wait.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import {
  NOT_A_FILE,
  canonicalJid,
  dropReason,
  fromListRow,
  fromWebhook,
  ownerIds,
  toRecord,
  verifySignature,
  wacliEnv,
} from '../src/bridge/channels/whatsapp.mjs'
import { startBridge } from '../src/bridge/main.mjs'
import { openStore } from '../src/bridge/store.mjs'
import { createIds, listHandOffs } from '../src/common/files.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { writeOutboxEntry } from '../src/common/outbox.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { createMailReaderStub } from './support/mail-reader.mjs'
import { isRoot, skipUnlessRoot } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'
import { OWNER, OWNER_NUMBER, createWacliStub, listRow, waitFor, webhookPayload } from './support/wacli.mjs'

const LID = '123456789012345@lid'
const STRANGER = '447700900123@s.whatsapp.net'

// ---------------------------------------------------------------------------------------------
// wacli's two formats

test('whatsapp: a webhook payload becomes a normalized message', () => {
  assert.deepEqual(fromWebhook(webhookPayload({ Text: 'coffee 150' })), {
    chat: OWNER,
    id: '3EB0A1B2C3D4E5F6A7B8',
    sender: OWNER,
    at: '2026-11-09T15:43:02Z',
    fromMe: false,
    text: 'coffee 150',
    media: null,
    replyToId: null,
    replyToPreview: null,
    reactionToId: null,
    reactionEmoji: '',
    edited: false,
    revoked: false,
    forwarded: false,
  })

  // Media: the caption is the text, and wacli's own placeholder for audio isn't.
  const image = { Type: 'image', Caption: 'lunch with sam', Filename: '', MimeType: 'image/jpeg', FileLength: 482113 }
  const photo = fromWebhook(webhookPayload({ Text: 'lunch with sam', Media: image }))
  assert.equal(photo.text, 'lunch with sam')
  assert.deepEqual(photo.media, { type: 'image', caption: 'lunch with sam', filename: '', mime: 'image/jpeg', size: 482113 })
  const audio = fromWebhook(webhookPayload({ Text: '[Audio]', Media: { Type: 'audio', Caption: '', Filename: '', MimeType: 'audio/ogg; codecs=opus', FileLength: 0 } }))
  assert.equal(audio.text, '')
  assert.equal(audio.media.size, null)

  // A reply, a reaction, an edit, a deletion and a forward.
  const reply = fromWebhook(webhookPayload({ Text: 'work', ReplyToID: '3EB0FF01', ReplyToSenderJID: '15550100000@s.whatsapp.net', ReplyToDisplay: 'work or personal?' }))
  assert.deepEqual([reply.replyToId, reply.replyToPreview], ['3EB0FF01', 'work or personal?'])
  const reaction = fromWebhook(webhookPayload({ ID: 'R1', ReactionToID: '3EB0FF01', ReactionEmoji: '👍' }))
  assert.deepEqual([reaction.id, reaction.reactionToId, reaction.reactionEmoji], ['R1', '3EB0FF01', '👍'])
  const edit = fromWebhook(webhookPayload({ Text: 'coffee 120', Edited: true }))
  assert.deepEqual([edit.id, edit.edited, edit.text], ['3EB0A1B2C3D4E5F6A7B8', true, 'coffee 120'])
  assert.equal(fromWebhook(webhookPayload({ Revoked: true })).revoked, true)
  assert.equal(fromWebhook(webhookPayload({ Text: 'x', IsForwarded: true, ForwardingScore: 1 })).forwarded, true)

  // Times: to the second, and Go's zero time is no time.
  assert.equal(fromWebhook(webhookPayload({ Timestamp: '2026-11-09T15:43:02.987654321Z' })).at, '2026-11-09T15:43:02Z')
  assert.equal(fromWebhook(webhookPayload({ Timestamp: '0001-01-01T00:00:00Z' })).at, null)
  assert.equal(fromWebhook(webhookPayload({ Timestamp: 'yesterday' })).at, null)

  // Not a message with an ID.
  for (const payload of [webhookPayload({ ID: '' }), webhookPayload({ ID: 7 }), null, [], 'text']) {
    assert.equal(fromWebhook(payload), null)
  }
})

test('whatsapp: a list row becomes a normalized message; an edited row is the message and its edit', () => {
  const plain = fromListRow(listRow({ Text: 'coffee 150', quoted_msg_id: '3EB0FF01' }))
  assert.deepEqual(plain, [
    {
      chat: OWNER,
      id: '3EB0A1B2C3D4E5F6A7B8',
      sender: OWNER,
      at: '2026-11-09T15:43:02Z',
      fromMe: false,
      text: 'coffee 150',
      media: null,
      replyToId: '3EB0FF01',
      replyToPreview: null,
      reactionToId: null,
      reactionEmoji: '',
      edited: false,
      revoked: false,
      forwarded: false,
    },
  ])
  // A row has no size for its media.
  const [document] = fromListRow(listRow({ MediaType: 'document', MediaCaption: 'ticket', Filename: 'Ticket.pdf', MimeType: 'application/pdf', Text: 'ticket' }))
  assert.deepEqual(document.media, { type: 'document', caption: 'ticket', filename: 'Ticket.pdf', mime: 'application/pdf', size: null })

  const edited = fromListRow(listRow({ Text: 'coffee 120', Edited: true }))
  assert.deepEqual(edited.map(message => [message.id, message.edited, message.text]), [
    ['3EB0A1B2C3D4E5F6A7B8', false, 'coffee 120'],
    ['3EB0A1B2C3D4E5F6A7B8', true, 'coffee 120'],
  ])
  const deleted = fromListRow(listRow({ Revoked: true, Edited: true, DisplayText: 'This message was deleted' }))
  assert.deepEqual(deleted.map(message => message.revoked), [true])
  assert.deepEqual(fromListRow(listRow({ MsgID: '' })), [])
  assert.deepEqual(fromListRow(null), [])
})

test('whatsapp: a record is the message without its chat, sender and fromMe', () => {
  const [message] = fromListRow(listRow({ MediaType: 'image', MimeType: 'image/jpeg', MediaCaption: 'receipt' }))
  assert.deepEqual(toRecord(message), {
    source: 'whatsapp',
    id: '3EB0A1B2C3D4E5F6A7B8',
    at: '2026-11-09T15:43:02Z',
    text: 'receipt',
    attachments: [{ type: 'image', mime: 'image/jpeg', name: null, bytes: null, error: null }],
    replyToId: null,
    replyToPreview: null,
    reactionToId: null,
    reactionEmoji: null,
    edited: false,
    revoked: false,
    forwarded: false,
  })
  // A location has no file.
  const location = fromWebhook(webhookPayload({ Media: { Type: 'location', Caption: 'Blue Tokai', Filename: '', MimeType: '', FileLength: 0 } }))
  assert.deepEqual(toRecord(location).attachments, [{ type: 'location', mime: null, name: null, bytes: null, error: NOT_A_FILE }])
  // An edit, a deletion or a reaction carries no attachment to download.
  const edit = fromWebhook(webhookPayload({ Edited: true, Media: { Type: 'image', Caption: 'new caption', Filename: '', MimeType: 'image/jpeg', FileLength: 9 } }))
  assert.deepEqual([toRecord(edit).attachments, toRecord(edit).text], [[], 'new caption'])
  const removed = fromWebhook(webhookPayload({ ReactionToID: 'M1', ReactionEmoji: '' }))
  assert.deepEqual([toRecord(removed).reactionToId, toRecord(removed).reactionEmoji], ['M1', ''])
})

// ---------------------------------------------------------------------------------------------
// The owner, and what is dropped

test('whatsapp: JIDs are compared in lower case, without the device', () => {
  assert.equal(canonicalJid('919812345678:12@s.whatsapp.net'), OWNER)
  assert.equal(canonicalJid('919812345678.0:3@S.WHATSAPP.NET'), OWNER)
  assert.equal(canonicalJid('123456789012345:7@lid'), LID)
  assert.equal(canonicalJid(' 919812345678@s.whatsapp.net '), OWNER)
  assert.equal(canonicalJid(undefined), '')
  assert.equal(canonicalJid('status@broadcast'), 'status@broadcast')

  const owners = ownerIds({ ownerNumber: OWNER_NUMBER, ownerJids: ['123456789012345@LID'] })
  assert.deepEqual([...owners].sort(), [`${OWNER_NUMBER}@c.us`, OWNER, LID].sort())
})

test('whatsapp: what is dropped before it reaches the core', () => {
  const owners = ownerIds({ ownerNumber: OWNER_NUMBER, ownerJids: [LID] })
  const reason = fields => dropReason(fromWebhook(webhookPayload({ Text: 'coffee 150', ...fields })), owners)
  assert.equal(reason({}), null)
  // The owner, by number, on any device, by the old suffix, or by an ID in OWNER_JIDS.
  assert.equal(reason({ SenderJID: '919812345678:5@s.whatsapp.net' }), null)
  assert.equal(reason({ SenderJID: `${OWNER_NUMBER}@c.us`, Chat: `${OWNER_NUMBER}@c.us` }), null)
  assert.equal(reason({ SenderJID: '123456789012345:2@lid', Chat: LID }), null)
  assert.equal(reason({ SenderJID: '999999999999999@lid', Chat: '999999999999999@lid' }), 'not the owner')
  assert.equal(reason({ SenderJID: STRANGER, Chat: STRANGER }), 'not the owner')
  assert.equal(reason({ SenderJID: '' }), 'not the owner')
  // The bot's own messages, echoed back.
  assert.equal(reason({ FromMe: true, SenderJID: '15550100000@s.whatsapp.net' }), 'from the bot')
  // Groups, broadcasts, status updates and channels, even from the owner.
  assert.equal(reason({ Chat: '120363025246125486@g.us' }), 'not a one-to-one chat')
  assert.equal(reason({ Chat: 'status@broadcast' }), 'not a one-to-one chat')
  assert.equal(reason({ Chat: '1234567890@broadcast' }), 'not a one-to-one chat')
  assert.equal(reason({ Chat: '120363000000000000@newsletter' }), 'not a one-to-one chat')
  // Stickers, and messages with nothing in them.
  assert.equal(reason({ Text: '', Media: { Type: 'sticker', Caption: '', Filename: '', MimeType: 'image/webp', FileLength: 9 } }), 'a sticker')
  assert.equal(reason({ Text: '' }), 'empty')
  assert.equal(reason({ Text: '  \n' }), 'empty')
  // A reaction, an edit to an empty caption, or a deletion has no text and isn't empty.
  assert.equal(reason({ Text: '', ReactionToID: 'M1', ReactionEmoji: '' }), null)
  assert.equal(reason({ Text: '', Edited: true }), null)
  assert.equal(reason({ Text: '', Revoked: true }), null)
})

test('whatsapp: signatures accepted and rejected', () => {
  const secret = 'f'.repeat(64)
  const body = Buffer.from('{"ID":"X"}')
  const sign = (key, data) => `sha256=${crypto.createHmac('sha256', key).update(data).digest('hex')}`
  assert.equal(verifySignature(secret, body, sign(secret, body)), true)
  assert.equal(verifySignature(secret, body, sign('another secret', body)), false)
  assert.equal(verifySignature(secret, body, sign(secret, Buffer.from('{"ID":"Y"}'))), false)
  assert.equal(verifySignature(secret, body, sign(secret, body).toUpperCase()), false)
  assert.equal(verifySignature(secret, body, sign(secret, body).slice(7)), false)
  assert.equal(verifySignature(secret, body, `${sign(secret, body)}0`), false)
  assert.equal(verifySignature(secret, body, ''), false)
  assert.equal(verifySignature(secret, body, undefined), false)
  assert.equal(verifySignature(secret, body, ['a', 'b']), false)
})

test('whatsapp: wacli\'s environment is its own folders and UTC, and nothing else', () => {
  const paths = makePaths({ dataDir: '/data', configDir: '/config' })
  assert.deepEqual(wacliEnv(paths), {
    HOME: '/data/wacli',
    WACLI_STORE_DIR: '/data/wacli/store',
    XDG_CONFIG_HOME: '/data/wacli/config',
    XDG_STATE_HOME: '/data/wacli/state',
    XDG_CACHE_HOME: '/data/wacli/cache',
    TZ: 'UTC',
  })
})

// ---------------------------------------------------------------------------------------------
// The channel at work

// The bridge's settings, as `loadSettings` would give them.
function bridgeSettings(root, extra = {}) {
  return {
    side: 'bridge',
    dataDir: path.join(root, 'data'),
    configDir: path.join(root, 'config'),
    timeZone: 'Asia/Kolkata',
    ownerNumber: OWNER_NUMBER,
    ownerJids: [],
    defaultChannel: 'whatsapp',
    email: null,
    backupTime: '03:30',
    backup: null,
    ...extra,
  }
}

// As root, the bridge looks up `scooter-wacli` and `scooter-runner`, which only `setup` makes. These
// tests run wacli as whoever runs them, as root too; the root test at the end gives users of its own.
const asTester = proc => (isRoot ? { ...proc, lookupUser: async () => null } : proc)

// Starts the bridge with the wacli stub, a fake clock, and the webhook on a free port. `seed(paths)`
// runs before it starts, to put lines in the datastore or a state on disk.
async function setup(t, { fixtures = { paired: true }, settings: extra, start = '2026-11-09T15:45:00Z', seed, limits: changes = {} } = {}) {
  const root = makeTestDir(t)
  const stub = createWacliStub(t, root)
  stub.fixtures(fixtures)
  const clock = createFakeClock(start)
  const { log, entries, events } = createTestLog({ clock })
  const proc = asTester(createProc({ log, clock }))
  const settings = bridgeSettings(root, extra)
  const paths = makePaths(settings)
  // The fake clock jumps ten minutes at a time to the next catch-up. A wacli call still running in
  // real time would see its timeout pass; only the test of the timeout keeps it.
  const restore = overrideLimits({ WEBHOOK_PORT: 0, WACLI_CALL_TIMEOUT: 365 * 24 * 3600_000, ...changes })
  atEnd(t, restore)
  await seed?.(paths, { clock, log })
  // With email on, the email reader runs too: its stub, which reaches no mailbox.
  const emailReader = settings.email ? createMailReaderStub(root).reader : undefined
  const bridge = await startBridge({ settings, clock, log, proc, emailReader })
  atEnd(t, () => bridge.stop())
  const whatsapp = bridge.channels.get('whatsapp')
  const lines = () => [...bridge.store.index.entries()].map(entry => entry.line)
  const synced = () => waitFor(() => stub.callsOf('sync').length > 0, 'wacli sync to start')
  const caughtUp = (count = 1) => waitFor(() => events().filter(event => event === 'whatsapp.caught_up').length >= count, `catch-up ${count}`)
  return { root, stub, clock, log, entries, events, proc, settings, paths, bridge, whatsapp, lines, synced, caughtUp }
}

// Posts a payload through the running sync, and waits until the bridge is done with it. Waits
// between download retries pass at once.
async function post(context, payload, options) {
  let done = false
  const posting = (async () => {
    const status = await context.stub.postWebhook(payload, options)
    await new Promise(resolve => setTimeout(resolve, 20))
    await context.bridge.intake.idle()
    return status
  })().finally(() => (done = true))
  while (!done && context.clock) {
    if (context.clock.sleeping().includes(limits.MEDIA_DOWNLOAD_RETRY_WAIT)) await context.clock.advance(limits.MEDIA_DOWNLOAD_RETRY_WAIT)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return posting
}

test('whatsapp: a signed webhook post becomes a line, and an unsigned one does not', async t => {
  const context = await setup(t)
  const { stub, lines, synced, events } = context
  await synced()

  assert.equal(await post(context, webhookPayload({ ID: 'A1', Text: 'coffee 150' })), 200)
  assert.deepEqual(lines().map(line => [line.sourceId, line.text]), [['A1', 'coffee 150']])

  // No signature, a wrong one, or one for another body: refused, and nothing stored.
  assert.equal(await post(context, webhookPayload({ ID: 'A2', Text: 'forged' }), { signature: null }), 401)
  assert.equal(await post(context, webhookPayload({ ID: 'A3', Text: 'forged' }), { signature: `sha256=${'0'.repeat(64)}` }), 401)
  const other = `sha256=${crypto.createHmac('sha256', 'guess').update('{}').digest('hex')}`
  assert.equal(await post(context, webhookPayload({ ID: 'A4', Text: 'forged' }), { signature: other }), 401)
  assert.equal(lines().length, 1)
  assert.equal(events().filter(event => event === 'whatsapp.webhook_refused').length, 3)

  // Signed, but not a message: receipts and presence, and what isn't JSON.
  assert.equal(await post(context, { EventType: 'receipt', Chat: OWNER, MessageIDs: ['A1'] }), 200)
  assert.equal(await post(context, 'not json'), 200)
  assert.equal(await post(context, webhookPayload({ ID: '' , Text: 'no ID' })), 200)
  assert.equal(lines().length, 1)
  assert.equal(events().filter(event => event === 'whatsapp.webhook_unreadable').length, 2)

  // The secret is new on every start, and only on sync's command line.
  const secrets = stub.callsOf('sync').map(call => call.args[call.args.indexOf('--webhook-secret') + 1])
  assert.equal(secrets.length, 1)
  assert.match(secrets[0], /^[0-9a-f]{64}$/)
})

test('whatsapp: the webhook takes only POST /wacli, up to 2 MB', async t => {
  const context = await setup(t, { fixtures: { paired: false } })
  const { whatsapp, events } = context
  await waitFor(() => events().includes('whatsapp.not_paired'), 'the pairing check')
  const port = Number(events().length && context.entries.find(entry => entry.event === 'whatsapp.started').port)
  const send = (method, url, body = '', headers = {}) =>
    new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, method, path: url, headers }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', reject)
      request.end(body)
    })
  assert.equal(await send('GET', '/wacli'), 405)
  assert.equal(await send('PUT', '/wacli', '{}'), 405)
  assert.equal(await send('POST', '/'), 404)
  assert.equal(await send('POST', '/wacli/'), 404)
  assert.equal(await send('POST', '/wacli?x=1'), 404)
  assert.equal(await send('POST', '/wacli', '{}'), 401)
  // Too large, by what it says and by what it sends. The server answers 413 and closes the
  // connection, which a client still sending may see as the connection reset instead. Either way
  // the log says why it was refused.
  const big = Buffer.alloc(limits.WEBHOOK_MAX_BYTES + 1, 0x20)
  const refused = request => request.catch(error => (['ECONNRESET', 'EPIPE'].includes(error.code) ? 'reset' : Promise.reject(error)))
  const tooLarge = () => context.entries.filter(entry => entry.event === 'whatsapp.webhook_refused' && entry.reason === 'too large').length
  assert.equal(await refused(send('POST', '/wacli', '', { 'content-length': String(big.length) })), 413)
  assert.equal(tooLarge(), 1)
  assert.ok([413, 'reset'].includes(await refused(send('POST', '/wacli', big, { 'transfer-encoding': 'chunked' }))))
  await waitFor(() => tooLarge() === 2, 'the second refusal')
  // It listens on loopback only.
  assert.equal(context.entries.find(entry => entry.event === 'whatsapp.started').address, '127.0.0.1')
  assert.equal(whatsapp.status(), 'WhatsApp: not linked; run `scooter pair`')
})

test('whatsapp: messages that aren\'t the owner\'s one-to-one chat stop in the module', async t => {
  const context = await setup(t, { settings: { ownerJids: [LID] } })
  const { lines, synced, entries } = context
  await synced()
  const drop = [
    webhookPayload({ ID: 'D1', Text: 'hi', SenderJID: STRANGER, Chat: STRANGER }),
    webhookPayload({ ID: 'D2', Text: 'echo', FromMe: true }),
    webhookPayload({ ID: 'D3', Text: 'group', Chat: '120363025246125486@g.us' }),
    webhookPayload({ ID: 'D4', Text: 'status', Chat: 'status@broadcast' }),
    webhookPayload({ ID: 'D5', Media: { Type: 'sticker', Caption: '', Filename: '', MimeType: 'image/webp', FileLength: 9 } }),
    webhookPayload({ ID: 'D6', Text: '' }),
  ]
  for (const payload of drop) assert.equal(await post(context, payload), 200)
  assert.equal(lines().length, 0)
  // A stranger is logged with the hint, by ID only.
  const stranger = entries.find(entry => entry.event === 'whatsapp.not_owner')
  assert.deepEqual([stranger.sender, stranger.hint], [STRANGER, 'add it to OWNER_JIDS if this is you'])
  assert.ok(!JSON.stringify(entries).includes('"hi"'))

  // The owner writing from an `@lid` ID in OWNER_JIDS gets in, and that chat is where replies go.
  await post(context, webhookPayload({ ID: 'L1', Text: 'from the lid', SenderJID: '123456789012345:4@lid', Chat: LID, Timestamp: '2026-11-09T15:44:00Z' }))
  assert.deepEqual(lines().map(line => line.sourceId), ['L1'])
  assert.deepEqual(context.bridge.state.get().ownerChat, { jid: LID, at: '2026-11-09T15:44:00Z' })
  assert.equal(context.whatsapp.ownerChat(), LID)
  // An older message from the other chat doesn't move it back.
  await post(context, webhookPayload({ ID: 'L2', Text: 'older', Timestamp: '2026-11-09T15:40:00Z' }))
  assert.equal(context.whatsapp.ownerChat(), LID)
})

test('whatsapp: an attachment is downloaded into wacli\'s staging folder and copied out', async t => {
  const context = await setup(t, { fixtures: { paired: true, media: { P1: { content: 'the photo' } } } })
  const { stub, lines, synced, paths } = context
  await synced()
  await post(context, webhookPayload({ ID: 'P1', Text: 'lunch with sam', Media: { Type: 'image', Caption: 'lunch with sam', Filename: '', MimeType: 'image/jpeg', FileLength: 9 } }))
  const [line] = lines()
  assert.deepEqual([line.text, line.files], ['lunch with sam', [{ path: '1.jpg', mime: 'image/jpeg', bytes: 9 }]])
  assert.equal(fs.readFileSync(path.join(paths.datastore, '2026/11/09/1.jpg'), 'utf8'), 'the photo')

  // The command of 5.2 step 6, into a name of the bridge's choosing, and nothing left behind.
  const [download] = stub.callsOf('media download')
  const output = download.args[download.args.indexOf('--output') + 1]
  assert.deepEqual(download.args, ['--json', 'media', 'download', '--chat', OWNER, '--id', 'P1', '--output', output])
  assert.equal(path.dirname(output), paths.wacliStaging)
  assert.deepEqual(fs.readdirSync(paths.wacliStaging), [])
  assert.deepEqual(fs.readdirSync(paths.bridgeIncoming), [])
})

test('whatsapp: a download wacli fails, or leaves as a link or elsewhere, is not stored', async t => {
  const media = {
    F1: { content: 'third time', failures: 2 },
    F2: { content: 'never', failures: 3 },
    S1: { as: 'symlink', target: '/etc/hostname' },
    E1: { as: 'elsewhere', content: 'somewhere else' },
  }
  const context = await setup(t, { fixtures: { paired: true, media } })
  const { stub, lines, synced, paths } = context
  await synced()
  const image = { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 0 }
  for (const id of ['F1', 'F2', 'S1', 'E1']) await post(context, webhookPayload({ ID: id, Media: image }))
  assert.deepEqual(
    lines().map(line => [line.sourceId, line.files?.[0].bytes ?? line.media.error]),
    [
      ['F1', 10],
      ['F2', 'download failed'],
      ['S1', 'download failed'],
      ['E1', 'download failed'],
    ],
  )
  // Three tries each, except the one that worked on its third.
  const tries = id => stub.callsOf('media download').filter(call => call.args.includes(id)).length
  assert.deepEqual(['F1', 'F2', 'S1', 'E1'].map(tries), [3, 3, 3, 3])
  // Nothing of the link's target was copied, and the staging folder was emptied.
  assert.deepEqual(fs.readdirSync(path.join(paths.datastore, '2026/11/09')).sort(), ['1.jpg', 'log.jsonl'])
  assert.deepEqual(fs.readdirSync(paths.wacliStaging).filter(name => !name.endsWith('-elsewhere')), [])
})

test('whatsapp: what the bridge\'s downloads left in wacli\'s staging folder is removed at the start, by their names, and wacli\'s own folders stay', async t => {
  const context = await setup(t, {
    fixtures: { paired: true, leftDir: ['D1'] },
    limits: { MEDIA_DOWNLOAD_RETRIES: 0 },
    // What a bridge killed during downloads left there, under the names it gives them; and what
    // wacli made there itself.
    seed: paths => {
      fs.mkdirSync(paths.wacliStaging, { recursive: true })
      fs.writeFileSync(path.join(paths.wacliStaging, '20261109T154000000-0001'), 'part')
      fs.writeFileSync(path.join(paths.wacliStaging, '20261109T154000000-0002-elsewhere'), 'part')
      fs.symlinkSync('/etc/hostname', path.join(paths.wacliStaging, '20261109T154000000-0003'))
      fs.mkdirSync(path.join(paths.wacliStaging, '20261109T154000000-0004', 'deeper'), { recursive: true })
      fs.writeFileSync(path.join(paths.wacliStaging, 'wacli-own.tmp'), 'wacli\'s')
    },
  })
  const { lines, synced, paths, entries } = context
  await synced()
  // Removing the link removed the link only. A folder, or a name the bridge doesn't give, is
  // wacli's, and stays.
  assert.ok(fs.existsSync('/etc/hostname'))
  assert.deepEqual(fs.readdirSync(paths.wacliStaging).sort(), ['20261109T154000000-0004', 'wacli-own.tmp'])
  assert.deepEqual(entries.filter(entry => entry.event === 'whatsapp.staging_kept').map(entry => entry.names), [2])

  await post(context, webhookPayload({ ID: 'D1', Media: { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 0 } }))
  assert.equal(lines()[0].media.error, 'download failed')
  // The folder wacli left in the download's place is wacli's too.
  assert.equal(fs.readdirSync(paths.wacliStaging).length, 3)
  assert.deepEqual(entries.filter(entry => entry.event === 'whatsapp.staging_kept').map(entry => entry.names), [2, 1])
  // The log says why the download failed: wacli's exit code, and none of what it wrote.
  const failed = entries.find(entry => entry.event === 'intake.download_failed')
  assert.deepEqual([failed.code, failed.exitCode, failed.timedOut], ['EWACLI', 1, undefined])
  assert.ok(!JSON.stringify(entries).includes('interrupted'))
})

test('whatsapp: a staging folder wacli made a link is not cleared, and nothing the link leads to is removed', async t => {
  let elsewhere
  const { synced, events, root } = await setup(t, {
    // As wacli could make its staging folder lead to the data folder.
    seed: paths => {
      elsewhere = path.join(path.dirname(paths.dataDir), 'elsewhere')
      fs.mkdirSync(path.join(elsewhere, 'datastore'), { recursive: true })
      fs.writeFileSync(path.join(elsewhere, '20261109T154000000-0001'), 'named as a download is')
      fs.mkdirSync(paths.wacli, { recursive: true })
      fs.symlinkSync(elsewhere, paths.wacliStaging)
    },
  })
  await synced()
  assert.ok(elsewhere.startsWith(root))
  assert.deepEqual(fs.readdirSync(elsewhere).sort(), ['20261109T154000000-0001', 'datastore'])
  assert.ok(events().includes('whatsapp.staging_not_cleared'))
})

test('whatsapp: a wacli call that hangs is stopped after WACLI_CALL_TIMEOUT', async t => {
  const timeout = 6 * 60_000
  const context = await setup(t, { fixtures: { paired: true, media: { H1: { as: 'hang' } } }, limits: { MEDIA_DOWNLOAD_RETRIES: 0, WACLI_CALL_TIMEOUT: timeout } })
  const { stub, lines, synced, clock, bridge } = context
  await synced()
  await stub.postWebhook(webhookPayload({ ID: 'H1', Media: { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 0 } }))
  await waitFor(() => stub.callsOf('media download').length === 1, 'the download to start')
  await waitFor(() => clock.sleeping().includes(timeout), 'the timeout to be set')
  await clock.advance(timeout)
  await bridge.intake.idle()
  assert.deepEqual(lines()[0].media, { type: 'image', mime: 'image/jpeg', error: 'download failed' })
})

test('whatsapp: a stop stops a download in progress, its message is left for catch-up, and stored with its file once the channel starts again (D179)', async t => {
  const at = '2026-11-09T15:46:00Z'
  const context = await setup(t, { fixtures: { paired: true, messages: [], media: { H1: { as: 'hang' } } } })
  const { stub, lines, synced, bridge, whatsapp, events } = context
  await synced()
  await stub.postWebhook(webhookPayload({ ID: 'H1', Timestamp: at, Media: { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 9 } }))
  await waitFor(() => stub.callsOf('media download').length === 1, 'the download to start')
  const { pid } = stub.callsOf('media download')[0]
  // As a backup stops the channels: the download is stopped, not waited for.
  await whatsapp.stop()
  await bridge.intake.idle()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.deepEqual(lines(), [])
  assert.ok(!events().includes('intake.download_failed'))
  assert.equal(stub.callsOf('media download').length, 1)

  stub.fixtures({ media: { H1: { content: 'the photo' } }, messages: [listRow({ MsgID: 'H1', Timestamp: at, MediaType: 'image', MimeType: 'image/jpeg' })] })
  bridge.intake.started('whatsapp')
  await whatsapp.start(record => bridge.intake.take(record))
  await waitFor(() => lines().length === 1, 'catch-up to bring it back')
  assert.deepEqual(lines()[0].files, [{ path: '1.jpg', mime: 'image/jpeg', bytes: 9 }])
})

test('whatsapp: what came after a message a stop left is left too, until the channel starts again, so catch-up brings them all back, in order (D179)', async t => {
  // The review's probe: a photo whose download hangs, and a text sent five minutes later while it
  // does, past CATCHUP_OVERLAP. Had the text been stored, catch-up would start after the photo.
  const photoAt = '2026-11-09T15:46:00Z'
  const textAt = '2026-11-09T15:51:00Z'
  const photo = { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 9 }
  const context = await setup(t, { fixtures: { paired: true, messages: [], media: { P1: { as: 'hang' } } } })
  const { stub, lines, synced, bridge, whatsapp, caughtUp } = context
  await synced()
  await caughtUp()
  assert.equal(await stub.postWebhook(webhookPayload({ ID: 'P1', Timestamp: photoAt, Media: photo })), 200)
  await waitFor(() => stub.callsOf('media download').length === 1, 'the download to start')
  assert.equal(await stub.postWebhook(webhookPayload({ ID: 'T1', Timestamp: textAt, Text: 'coffee 150' })), 200)
  // A command after it is left too, and answered once catch-up brings it back.
  assert.equal(await stub.postWebhook(webhookPayload({ ID: 'C1', Timestamp: textAt, Text: '/help' })), 200)
  await new Promise(resolve => setTimeout(resolve, 20))
  await whatsapp.stop()
  await bridge.intake.idle()
  assert.deepEqual(lines(), [])

  const rows = [
    listRow({ MsgID: 'P1', Timestamp: photoAt, MediaType: 'image', MimeType: 'image/jpeg' }),
    listRow({ MsgID: 'T1', Timestamp: textAt, Text: 'coffee 150' }),
    listRow({ MsgID: 'C1', Timestamp: textAt, Text: '/help' }),
  ]
  stub.fixtures({ media: { P1: { content: 'the photo' } }, messages: rows })
  bridge.intake.started('whatsapp')
  await whatsapp.start(record => bridge.intake.take(record))
  await waitFor(() => lines().length === 3, 'catch-up to bring them back')
  assert.deepEqual(
    lines().map(line => [line.seq, line.kind, line.sourceId, line.at]),
    [
      [1, 'message', 'P1', photoAt],
      [2, 'message', 'T1', textAt],
      [3, 'command', 'C1', textAt],
    ],
  )
  assert.deepEqual(lines()[0].files, [{ path: '1.jpg', mime: 'image/jpeg', bytes: 9 }])
  // The second catch-up listed from the bridge's first start, as nothing was stored before it.
  const lists = stub.callsOf('messages list')
  assert.equal(lists.at(-1).args[lists.at(-1).args.indexOf('--after') + 1], '2026-11-09T15:45:00Z')
})

test('whatsapp: not paired, it says to run pair and checks every minute; once paired, sync starts', async t => {
  const context = await setup(t, { fixtures: { paired: false } })
  const { stub, clock, whatsapp, events, entries } = context
  await waitFor(() => events().includes('whatsapp.not_paired'), 'the pairing check')
  assert.equal(entries.find(entry => entry.event === 'whatsapp.not_paired').hint, 'run `scooter pair` to link the bot\'s number')
  assert.equal(whatsapp.status(), 'WhatsApp: not linked; run `scooter pair`')
  assert.deepEqual(stub.callsOf('auth status').map(call => call.args), [['--json', '--read-only', 'auth', 'status']])

  await waitFor(() => clock.sleeping().includes(limits.AUTH_CHECK_INTERVAL), 'the next check')
  await clock.advance(limits.AUTH_CHECK_INTERVAL)
  await waitFor(() => stub.callsOf('auth status').length === 2, 'the second check')
  assert.equal(stub.callsOf('sync').length, 0)
  // It says so once, not every minute.
  assert.equal(events().filter(event => event === 'whatsapp.not_paired').length, 1)

  stub.fixtures({ paired: true })
  await waitFor(() => clock.sleeping().includes(limits.AUTH_CHECK_INTERVAL), 'the next check')
  await clock.advance(limits.AUTH_CHECK_INTERVAL)
  await context.synced()
  const [sync] = stub.callsOf('sync')
  const port = entries.find(entry => entry.event === 'whatsapp.started').port
  assert.deepEqual(sync.args, [
    'sync',
    '--follow',
    '--webhook',
    `http://127.0.0.1:${port}/wacli`,
    '--webhook-secret',
    sync.args[5],
    '--webhook-allow-private',
  ])
  assert.ok(events().includes('whatsapp.paired'))
  assert.equal(whatsapp.status(), 'WhatsApp: linked')
})

test('whatsapp: sync is started again with backoff when it exits, checking the pairing first', async t => {
  const context = await setup(t, { fixtures: { paired: true, syncExit: 1 } })
  const { stub, clock, whatsapp } = context
  await context.synced()
  await waitFor(() => clock.sleeping().includes(5000), 'the restart wait')
  assert.equal(whatsapp.status(), 'WhatsApp: wacli stopped, and starts again shortly')
  stub.fixtures({ syncExit: undefined })
  const checks = stub.callsOf('auth status').length
  await clock.advance(5000)
  await waitFor(() => stub.callsOf('sync').length === 2, 'the second sync')
  assert.equal(stub.callsOf('auth status').length, checks + 1)
  await waitFor(() => whatsapp.status() === 'WhatsApp: linked', 'the link')
})

test('whatsapp: stopping stops sync, the webhook and catch-up', async t => {
  const context = await setup(t)
  const { stub, bridge, clock, entries } = context
  await context.synced()
  await context.caughtUp()
  const { pid } = stub.callsOf('sync')[0]
  const port = entries.find(entry => entry.event === 'whatsapp.started').port
  await bridge.stop()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.deepEqual(clock.sleeping(), [])
  await assert.rejects(
    new Promise((resolve, reject) => http.request({ host: '127.0.0.1', port, method: 'POST', path: '/wacli' }, resolve).on('error', reject).end()),
    { code: 'ECONNREFUSED' },
  )
  assert.equal(bridge.channels.get('whatsapp').status(), 'WhatsApp: stopped')
})

// ---------------------------------------------------------------------------------------------
// Catch-up

// Moves the clock on to the next catch-up, once the loop is waiting for it.
async function untilNextCatchUp(clock) {
  await waitFor(() => clock.sleeping().includes(limits.CATCHUP_INTERVAL), 'the wait for the next catch-up')
  await clock.advance(limits.CATCHUP_INTERVAL)
}

// Puts lines in the datastore before the bridge starts.
function seedLines(lines) {
  return async (paths, { clock, log }) => {
    const store = openStore({ paths, clock, log })
    for (const line of lines) await store.append(line)
  }
}

const incoming = (at, sourceId, text, extra = {}) => ({ kind: 'message', dir: 'in', at, source: 'whatsapp', sourceId, trust: 'owner', text, ...extra })

test('whatsapp: catch-up after a gap starts from the newest incoming WhatsApp line, even when emails came after it', async t => {
  const rows = [
    listRow({ MsgID: 'OLD', Timestamp: '2026-11-09T09:00:00Z', Text: 'before the gap, stored' }),
    listRow({ MsgID: 'G1', Timestamp: '2026-11-09T10:05:00Z', Text: 'missed one' }),
    listRow({ MsgID: 'BOT', Timestamp: '2026-11-09T10:06:00Z', Text: 'a reply', FromMe: true, SenderJID: '15550100000@s.whatsapp.net' }),
    listRow({ MsgID: 'G2', Timestamp: '2026-11-09T11:30:00Z', Text: 'missed two', quoted_msg_id: 'W1' }),
  ]
  const seed = seedLines([
    incoming('2026-11-09T10:00:00Z', 'W1', 'last before wacli went down'),
    // An email arrived while wacli was down. It says nothing about WhatsApp.
    { kind: 'message', dir: 'in', at: '2026-11-09T11:00:00Z', source: 'email', sourceId: 'e@x', trust: 'owner', subject: '', text: 'mail' },
    // So did a reply of Scooter's own.
    { kind: 'message', dir: 'out', at: '2026-11-09T11:10:00Z', source: 'whatsapp', sourceId: 'BOT', by: 'lifelog', text: 'a reply' },
  ])
  const context = await setup(t, { fixtures: { paired: true, messages: rows }, seed, start: '2026-11-09T12:00:00Z' })
  const { stub, lines, caughtUp, clock } = context
  await caughtUp()
  const [list] = stub.callsOf('messages list')
  assert.deepEqual(list.args, ['--json', '--read-only', 'messages', 'list', '--chat', OWNER, '--after', '2026-11-09T09:58:00Z', '--asc', '--limit', '500'])
  assert.deepEqual(
    lines().slice(3).map(line => [line.seq, line.sourceId, line.at, line.text, line.replyTo]),
    [
      [4, 'G1', '2026-11-09T10:05:00Z', 'missed one', undefined],
      [5, 'G2', '2026-11-09T11:30:00Z', 'missed two', 1],
    ],
  )

  // The next catch-up, ten minutes later, starts from the newest line now, and stores nothing twice.
  await untilNextCatchUp(clock)
  await caughtUp(2)
  assert.equal(stub.callsOf('messages list')[1].args[7], '2026-11-09T11:28:00Z')
  assert.equal(lines().length, 5)
})

test('whatsapp: on the first start no history is imported', async t => {
  const rows = [
    listRow({ MsgID: 'H1', Timestamp: '2026-11-01T08:00:00Z', Text: 'last week' }),
    listRow({ MsgID: 'H2', Timestamp: '2026-11-09T11:59:59Z', Text: 'a second ago' }),
  ]
  const context = await setup(t, { fixtures: { paired: true, messages: rows }, start: '2026-11-09T12:00:00Z' })
  const { stub, lines, caughtUp, clock, bridge, paths } = context
  await caughtUp()
  assert.equal(bridge.state.get().firstStart, '2026-11-09T12:00:00Z')
  assert.equal(stub.callsOf('messages list')[0].args[7], '2026-11-09T12:00:00Z')
  assert.equal(lines().length, 0)
  // The first message after the start is stored at the next catch-up, the rest of the history never.
  stub.fixtures({ messages: [...rows, listRow({ MsgID: 'N1', Timestamp: '2026-11-09T12:03:00Z', Text: 'new' })] })
  await untilNextCatchUp(clock)
  await caughtUp(2)
  assert.deepEqual(lines().map(line => line.sourceId), ['N1'])
  // The first start is kept: a restart doesn't move it.
  assert.equal(JSON.parse(fs.readFileSync(paths.bridgeState, 'utf8')).firstStart, '2026-11-09T12:00:00Z')
})

test('whatsapp: a full page of catch-up goes on from the last row\'s time, within that second', async t => {
  const times = ['10:00:01', '10:00:02', '10:00:03', '10:00:03', '10:00:03', '10:00:04', '10:00:05']
  const rows = times.map((time, n) => listRow({ MsgID: `P${n + 1}`, Timestamp: `2026-11-09T${time}Z`, Text: `row ${n + 1}` }))
  const seed = seedLines([incoming('2026-11-09T10:02:00Z', 'W1', 'newest')])
  const context = await setup(t, { fixtures: { paired: true, messages: rows }, seed, limits: { CATCHUP_LIMIT: 3 } })
  const { stub, lines, caughtUp } = context
  await caughtUp()
  assert.deepEqual(lines().slice(1).map(line => line.sourceId), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'])
  // Each page after a full one starts a second before its last row, so the rest of that second is
  // listed too; a page that is all one second moves past it.
  assert.deepEqual(
    stub.callsOf('messages list').map(call => call.args[7]),
    ['2026-11-09T10:00:00Z', '2026-11-09T10:00:02Z', '2026-11-09T10:00:03Z'],
  )
})

test('whatsapp: catch-up stops at a full page that ends before the time it asked for', async t => {
  // A broken wacli answers the same full page, of rows long before `--after`, whatever it is asked.
  const rows = ['10:00:01', '10:00:02', '10:00:03'].map((time, n) => listRow({ MsgID: `B${n + 1}`, Timestamp: `2026-11-09T${time}Z`, Text: `row ${n + 1}` }))
  const seed = seedLines([incoming('2026-11-09T11:58:00Z', 'W1', 'newest')])
  const context = await setup(t, { fixtures: { paired: true, messages: rows, ignoreAfter: true }, seed, limits: { CATCHUP_LIMIT: 3 } })
  const { stub, lines, caughtUp, events } = context
  await caughtUp()
  // One page, handed over once, and no going further back.
  assert.deepEqual(stub.callsOf('messages list').map(call => call.args[7]), ['2026-11-09T11:56:00Z'])
  assert.deepEqual(lines().map(line => line.sourceId), ['W1', 'B1', 'B2', 'B3'])
  assert.ok(events().includes('whatsapp.catchup_stopped'))
})

test('whatsapp: catch-up turns an edited row into its message, or its edit, and a deleted row into a deletion', async t => {
  const seed = seedLines([
    incoming('2026-11-09T10:00:00Z', 'K1', 'coffee 150'),
    incoming('2026-11-09T10:01:00Z', 'K2', 'lunch 400'),
  ])
  const rows = [
    // Stored before, and edited while wacli was down.
    listRow({ MsgID: 'K1', Timestamp: '2026-11-09T10:00:00Z', Text: 'coffee 120', Edited: true }),
    // Stored before, and deleted.
    listRow({ MsgID: 'K2', Timestamp: '2026-11-09T10:01:00Z', Revoked: true }),
    // Missed, and edited since: stored as it is now.
    listRow({ MsgID: 'K3', Timestamp: '2026-11-09T10:02:00Z', Text: 'dinner 600', Edited: true }),
    // Missed, and deleted since: nothing to store.
    listRow({ MsgID: 'K4', Timestamp: '2026-11-09T10:03:00Z', Revoked: true }),
  ]
  const context = await setup(t, { fixtures: { paired: true, messages: rows }, seed, start: '2026-11-09T10:30:00Z' })
  const { lines, caughtUp, clock } = context
  await caughtUp()
  const expected = [
    [3, 'edit', 'K1', 1, 'coffee 120'],
    [4, 'delete', 'K2', 2, undefined],
    [5, 'message', 'K3', undefined, 'dinner 600'],
  ]
  assert.deepEqual(lines().slice(2).map(line => [line.seq, line.kind, line.sourceId, line.target, line.text]), expected)
  await untilNextCatchUp(clock)
  await caughtUp(2)
  assert.equal(lines().length, 5)
})

test('whatsapp: catch-up lists the chat of the owner\'s newest message', async t => {
  const seed = async paths => {
    fs.mkdirSync(paths.bridge, { recursive: true })
    fs.writeFileSync(paths.bridgeState, JSON.stringify({ firstStart: '2026-11-01T00:00:00Z', ownerChat: { jid: LID, at: '2026-11-08T10:00:00Z' }, lastBackup: null }))
  }
  const context = await setup(t, { fixtures: { paired: true, messages: [] }, seed, settings: { ownerJids: [LID] } })
  await context.caughtUp()
  const [list] = context.stub.callsOf('messages list')
  assert.equal(list.args[list.args.indexOf('--chat') + 1], LID)
  // Before the first incoming line, from the first start.
  assert.equal(list.args[list.args.indexOf('--after') + 1], '2026-11-01T00:00:00Z')
})

test('whatsapp: a catch-up that fails is tried again at the next one, and not while unpaired', async t => {
  const context = await setup(t, { fixtures: { paired: true, store: false } })
  const { stub, clock, events, caughtUp } = context
  await waitFor(() => events().includes('whatsapp.catchup_failed'), 'the failed catch-up')
  stub.fixtures({ store: true, messages: [listRow({ MsgID: 'C1', Timestamp: '2026-11-09T15:46:00Z', Text: 'later' })] })
  await untilNextCatchUp(clock)
  await caughtUp()
  assert.deepEqual(context.lines().map(line => line.sourceId), ['C1'])

  // Not paired: no list, and so no failure every ten minutes.
  const unpaired = await setup(t, { fixtures: { paired: false } })
  // The catch-up at startup runs while the first check is still asking, and fails.
  await waitFor(() => unpaired.events().includes('whatsapp.not_paired'), 'the pairing check')
  await waitFor(() => unpaired.events().includes('whatsapp.catchup_failed'), 'the catch-up at startup')
  const lists = unpaired.stub.callsOf('messages list').length
  await untilNextCatchUp(unpaired.clock)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(unpaired.stub.callsOf('messages list').length, lists)
})

// ---------------------------------------------------------------------------------------------
// Sending (5.3)

// Writes outbox entries as the runner would, and moves the fake clock on, a second at a time, while
// the sends go through the stub in real time, until the outbox is empty.
async function deliver(context, ...entries) {
  const ids = createIds(context.clock)
  for (const entry of entries) await writeOutboxEntry({ paths: context.paths, ids, entry })
  await waitFor(
    async () => {
      await context.clock.advance(1000)
      return listHandOffs(context.paths.outbox).length === 0
    },
    'the outbox to empty',
    30_000,
  )
}

const outLines = context => context.lines().filter(line => line.dir === 'out')

test('whatsapp: every text goes out with --no-preview, a reply with --reply-to the quoted message\'s WhatsApp ID, and a reaction with --sender', async t => {
  const context = await setup(t, { fixtures: { paired: true, messages: [] } })
  const { stub, synced, caughtUp } = context
  await synced()
  await caughtUp()
  await post(context, webhookPayload({ ID: 'A1', Text: 'coffee 150' }))
  await post(context, webhookPayload({ ID: 'A2', Text: 'lunch https://example.com/menu', Timestamp: '2026-11-09T15:44:00Z' }))
  const long = ['a'.repeat(3490), 'see https://example.com/x'].join('\n\n')
  await deliver(
    context,
    { type: 'text', by: 'lifelog', text: 'Work or personal? https://example.com/receipt', replyTo: 1 },
    { type: 'react', by: 'lifelog', target: 2, emoji: '✅' },
    { type: 'text', by: 'lifelog', text: long, about: 2 },
  )

  const sends = stub.calls().filter(call => call.command.startsWith('send '))
  assert.deepEqual(
    sends.map(call => call.args),
    [
      ['--json', 'send', 'text', '--to', OWNER, '--message', 'Work or personal? https://example.com/receipt', '--no-preview', '--reply-to', 'A1'],
      ['--json', 'send', 'react', '--to', OWNER, '--id', 'A2', '--sender', OWNER, '--reaction', '✅'],
      ['--json', 'send', 'text', '--to', OWNER, '--message', 'a'.repeat(3490), '--no-preview'],
      ['--json', 'send', 'text', '--to', OWNER, '--message', 'see https://example.com/x', '--no-preview'],
    ],
  )
  // Every text, quoted or not, with link previews off.
  for (const call of sends.filter(call => call.command === 'send text')) assert.ok(call.args.includes('--no-preview'))
  // Logged as out lines, each with the ID wacli gave it; the reaction's warning on stderr isn't a failure.
  assert.deepEqual(
    outLines(context).map(line => [line.seq, line.kind, line.sourceId, line.replyTo, line.target, line.by]),
    [
      [3, 'message', 'SENT1', 1, undefined, 'lifelog'],
      [4, 'reaction', 'SENT2', undefined, 2, 'lifelog'],
      [5, 'message', 'SENT3', undefined, undefined, 'lifelog'],
      [6, 'message', 'SENT4', undefined, undefined, 'lifelog'],
    ],
  )
  // Pacing is in `delivery.test.mjs`: here the fake clock moves on while each send runs in real time.
})

test('whatsapp: sends go to the chat the owner last wrote from', async t => {
  const context = await setup(t, { fixtures: { paired: true, messages: [] }, settings: { ownerJids: [LID] } })
  const { stub, synced, caughtUp } = context
  await synced()
  await caughtUp()
  await post(context, webhookPayload({ ID: 'L1', Chat: LID, SenderJID: LID, Text: 'from my lid' }))
  await deliver(context, { type: 'text', by: 'runner', text: 'a notice' }, { type: 'react', by: 'lifelog', target: 1, emoji: '✅' })
  const sends = stub.calls().filter(call => call.command.startsWith('send '))
  assert.deepEqual(
    sends.map(call => [call.args[call.args.indexOf('--to') + 1], call.args.includes('--sender') ? call.args[call.args.indexOf('--sender') + 1] : null]),
    [
      [LID, null],
      [LID, LID],
    ],
  )
})

test('whatsapp: entries wait while wacli isn\'t paired, and go once it is', async t => {
  const context = await setup(t, { fixtures: { paired: false, messages: [] } })
  const { stub, clock, paths, events } = context
  // The pairing check has had its answer, so its next look is a minute from now. Waiting for any
  // sleep could find the outbox's instead, and then, under load, the clock was moved before the
  // check's minute began, and nobody moved it again (the second review of milestone 6, point 4).
  await waitFor(() => events().includes('whatsapp.not_paired'), 'the pairing check')
  await clock.whenSleeping()
  const ids = createIds(clock)
  await writeOutboxEntry({ paths, ids, entry: { type: 'text', by: 'runner', text: 'a notice' } })
  for (let n = 0; n < 30; n++) await clock.advance(1000)
  assert.deepEqual(stub.callsOf('send text'), [])
  assert.equal(context.bridge.channels.get('whatsapp').ready(), false)
  stub.fixtures({ paired: true })
  await clock.advance(limits.AUTH_CHECK_INTERVAL)
  await context.synced()
  await waitFor(() => context.bridge.channels.get('whatsapp').ready(), 'wacli to be linked')
  await deliver(context)
  assert.equal(stub.callsOf('send text').length, 1)
  assert.deepEqual(outLines(context).map(line => line.text), ['a notice'])
})

test('whatsapp: a send wacli fails is tried again, and logged once it goes', async t => {
  const context = await setup(t, { fixtures: { paired: true, messages: [], sendFailures: 1 } })
  const { stub, synced, caughtUp, events } = context
  await synced()
  await caughtUp()
  await deliver(context, { type: 'text', by: 'runner', text: 'a notice' })
  assert.equal(stub.callsOf('send text').length, 2)
  assert.deepEqual(outLines(context).map(line => line.sourceId), ['SENT2'])
  assert.ok(events().includes('outbox.send_failed'))
})

// ---------------------------------------------------------------------------------------------
// Least privilege

test('whatsapp: every wacli call gets only wacli\'s environment, and no secret but the webhook\'s is on a command line', async t => {
  const secrets = {
    email: { host: 'imap.example.com', port: 993, user: 'scooter@example.com', password: 'mailbox-password-123', ownerAddresses: ['me@example.com'], authservId: 'mx.example.com', checkSeconds: 60 },
    backup: { repository: 's3:https://r2.example/bucket/scooter', password: 'restic-password-456', keepDaily: 7, keepWeekly: 4, keepMonthly: 12, env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'aws-secret-789', AWS_DEFAULT_REGION: 'auto' } },
  }
  const media = { P1: { content: 'photo' } }
  const context = await setup(t, { fixtures: { paired: true, media, messages: [] }, settings: secrets })
  const { stub, paths, synced, caughtUp } = context
  await synced()
  await caughtUp()
  await post(context, webhookPayload({ ID: 'P1', Media: { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 5 } }))
  await deliver(context, { type: 'text', by: 'lifelog', text: 'a photo of what?', replyTo: 1 }, { type: 'react', by: 'lifelog', target: 1, emoji: '✅' })

  const calls = stub.calls()
  assert.deepEqual([...new Set(calls.map(call => call.command))].sort(), ['auth status', 'media download', 'messages list', 'send react', 'send text', 'sync'])
  for (const call of calls) assert.deepEqual(call.env, wacliEnv(paths), call.command)

  const everything = JSON.stringify(calls)
  for (const secret of ['mailbox-password-123', 'restic-password-456', 'aws-secret-789', 'AKIAEXAMPLE', 'scooter@example.com']) {
    assert.ok(!everything.includes(secret), secret)
  }
  // The webhook's secret is on sync's command line, the one exception (5.1), and on no other.
  const [sync] = stub.callsOf('sync')
  const secret = sync.args[sync.args.indexOf('--webhook-secret') + 1]
  assert.deepEqual(calls.filter(call => JSON.stringify(call).includes(secret)), [sync])
  // Not root: wacli runs as this user, with the one warning.
  if (!isRoot) {
    assert.ok(calls.every(call => call.uid === process.getuid()))
    assert.ok(context.events().includes('proc.not_root'))
  }
})

test('whatsapp: as root, wacli runs as its own user, and its folders are its own', { skip: skipUnlessRoot }, async t => {
  // A made-up user: running as another user needs no user to exist (D32). It must be able to reach
  // the stub and its control folder.
  const wacliUser = { uid: 4242, gid: 4242 }
  const root = makeTestDir(t)
  // wacli passes through the test's folder and the data folder to reach its own.
  fs.chmodSync(root, 0o755)
  const stub = createWacliStub(t, root)
  for (const dir of [stub.bin, stub.control, path.join(stub.control, 'webhooks')]) fs.chmodSync(dir, 0o777)
  stub.fixtures({ paired: true, messages: [], media: { P1: { content: 'photo' } } })
  fs.chmodSync(path.join(stub.control, 'fixtures.json'), 0o644)

  const clock = createFakeClock('2026-11-09T15:45:00Z')
  const { log, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  // The bridge looks its users up by name; here they are given.
  const users = { 'scooter-wacli': wacliUser, 'scooter-runner': { uid: 4343, gid: 4343 } }
  const lookupUser = async name => users[name]
  const settings = bridgeSettings(root)
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const bridge = await startBridge({ settings, clock, log, proc: { ...proc, lookupUser } })
  atEnd(t, () => bridge.stop())
  const paths = makePaths(settings)
  await waitFor(() => stub.callsOf('sync').length > 0, 'wacli sync to start')
  await waitFor(() => events().includes('whatsapp.caught_up'), 'catch-up')
  await post({ stub, bridge, clock }, webhookPayload({ ID: 'P1', Media: { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 5 } }))

  for (const call of stub.calls()) assert.deepEqual([call.uid, call.gid], [4242, 4242], call.command)
  for (const dir of [paths.wacli, paths.wacliStore, paths.wacliStaging, paths.wacliConfig, paths.wacliState, paths.wacliCache]) {
    const stat = fs.statSync(dir)
    assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777], [4242, 4242, 0o700], dir)
  }
  // The download was copied out of wacli's folder, and belongs to root and the runner's group.
  const stored = fs.statSync(path.join(paths.datastore, '2026/11/09/1.jpg'))
  assert.deepEqual([stored.uid, stored.gid, stored.mode & 0o777], [0, 4343, 0o640])
  // A file in staging that isn't wacli's own is refused, as a hard link to root's file would be.
  const target = path.join(paths.bridge, 'probe')
  fs.writeFileSync(path.join(paths.wacliStaging, 'root-owned'), 'root')
  const { copyUntrustedFile } = await import('../src/common/files.mjs')
  await assert.rejects(copyUntrustedFile(path.join(paths.wacliStaging, 'root-owned'), target, { owner: wacliUser, maxBytes: 100 }), { code: 'EUNTRUSTED' })
})
