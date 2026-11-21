// The bridge as a whole: signed webhooks from wacli become datastore lines
// and attachments, and unsigned ones don't; a message goes through the runner and comes back as a
// quoted reply, logged as an `out` line; a text such as `/status` is a message, and `scooter
// status` says what the bridge and the runner are doing; the bridge's state; one bridge per data
// folder; and `scooter bridge` as a real process.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { startBridge } from '../src/bridge/main.mjs'
import { readBridgeStatus, readIndex, runStatus, statusText } from '../src/bridge/status.mjs'
import { holdInstance } from '../src/common/instance.mjs'
import { openBridgeState } from '../src/bridge/state.mjs'
import { listHandOffs } from '../src/common/files.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { createMailReaderStub } from './support/mail-reader.mjs'
import { AUTHSERV, OWNER_ADDRESSES, appleMailAudio, gmailPlain } from './support/mail-samples.mjs'
import { createResticStub } from './support/restic.mjs'
import { isRoot } from './support/root.mjs'
import { SECOND, prepareTestRunner, startTestRunner } from './support/test-runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'
import { OWNER, OWNER_NUMBER, createWacliStub, listRow, waitFor, webhookPayload } from './support/wacli.mjs'

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

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

// The mailbox's settings, for the bridge with email on. The reader is its stub, which reaches no
// mailbox (`support/mail-reader.mjs`).
const EMAIL = { host: 'imap.example.com', port: 993, user: 'scooter.inbox@example.com', password: 'app-password', ownerAddresses: OWNER_ADDRESSES, authservId: AUTHSERV, checkSeconds: 60 }

async function start(t, root, { clock = createFakeClock('2026-11-09T15:45:00Z') } = {}) {
  const { log, entries, events } = createTestLog({ clock })
  // As root, without the users `setup` makes, wacli runs as root (whatsapp.test.mjs has the root test).
  const proc = createProc({ log, clock })
  const bridge = await startBridge({ settings: bridgeSettings(root), clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc })
  atEnd(t, () => bridge.stop())
  return { bridge, clock, entries, events }
}

test('bridge: signed webhook posts end up as the right datastore lines and attachments, and unsigned ones don\'t', async t => {
  const root = makeTestDir(t)
  const stub = createWacliStub(t, root)
  const media = {
    IMG1: { content: 'jpeg bytes of a receipt' },
    DOC1: { content: '%PDF-1.7 a train ticket' },
  }
  stub.fixtures({ paired: true, messages: [], media })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const { bridge } = await start(t, root)
  const paths = makePaths(bridgeSettings(root))
  await waitFor(() => stub.callsOf('sync').length > 0, 'wacli sync to start')

  const send = async (payload, options) => {
    const status = await stub.postWebhook(payload, options)
    await new Promise(resolve => setTimeout(resolve, 20))
    await bridge.intake.idle()
    return status
  }
  const at = minute => `2026-11-09T15:${String(minute).padStart(2, '0')}:00Z`
  const image = { Type: 'image', Caption: 'Blue Tokai, coffee', Filename: '', MimeType: 'image/jpeg', FileLength: 23 }
  const document = { Type: 'document', Caption: '', Filename: 'Ticket.pdf', MimeType: 'application/pdf', FileLength: 23 }

  const statuses = [
    await send(webhookPayload({ ID: 'IMG1', Timestamp: at(30), Text: 'Blue Tokai, coffee', Media: image })),
    await send(webhookPayload({ ID: 'TXT1', Timestamp: at(31), Text: 'coffee 150' })),
    await send(webhookPayload({ ID: 'DOC1', Timestamp: at(32), Media: document })),
    await send(webhookPayload({ ID: 'REP1', Timestamp: at(33), Text: 'work', ReplyToID: 'IMG1', ReplyToDisplay: 'Blue Tokai, coffee' })),
    await send(webhookPayload({ ID: 'REA1', Timestamp: at(34), ReactionToID: 'TXT1', ReactionEmoji: '👍' })),
    await send(webhookPayload({ ID: 'TXT1', Timestamp: at(35), Text: 'coffee 120', Edited: true })),
    await send(webhookPayload({ ID: 'REP1', Timestamp: at(36), Revoked: true })),
    // A text such as /status is a message like any other.
    await send(webhookPayload({ ID: 'TXT2', Timestamp: at(37), Text: '/status' })),
    // The same edit, delivered again.
    await send(webhookPayload({ ID: 'TXT1', Timestamp: at(35), Text: 'coffee 120', Edited: true })),
    // Unsigned, and signed with a wrong secret.
    await send(webhookPayload({ ID: 'FAKE1', Timestamp: at(38), Text: 'forged' }), { signature: null }),
    await send(webhookPayload({ ID: 'FAKE2', Timestamp: at(39), Text: 'forged' }), { signature: `sha256=${'ab'.repeat(32)}` }),
  ]
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 401, 401])

  const day = path.join(paths.datastore, '2026/11/09')
  const lines = fs.readFileSync(path.join(day, 'log.jsonl'), 'utf8').split('\n').filter(Boolean)
  const base = { dir: 'in', source: 'whatsapp', trust: 'owner' }
  assert.deepEqual(
    lines.map(line => JSON.parse(line)),
    [
      { seq: 1, kind: 'message', ...base, at: at(30), sourceId: 'IMG1', text: 'Blue Tokai, coffee', files: [{ path: '1.jpg', mime: 'image/jpeg', bytes: 23 }] },
      { seq: 2, kind: 'message', ...base, at: at(31), sourceId: 'TXT1', text: 'coffee 150' },
      { seq: 3, kind: 'message', ...base, at: at(32), sourceId: 'DOC1', text: '', files: [{ path: '3.pdf', mime: 'application/pdf', name: 'Ticket.pdf', bytes: 23 }] },
      { seq: 4, kind: 'message', ...base, at: at(33), sourceId: 'REP1', replyTo: 1, quoted: 'Blue Tokai, coffee', text: 'work' },
      { seq: 5, kind: 'reaction', ...base, at: at(34), sourceId: 'REA1', target: 2, emoji: '👍' },
      { seq: 6, kind: 'edit', ...base, at: at(35), sourceId: 'TXT1', target: 2, text: 'coffee 120' },
      { seq: 7, kind: 'delete', ...base, at: at(36), sourceId: 'REP1', target: 4 },
      { seq: 8, kind: 'message', ...base, at: at(37), sourceId: 'TXT2', text: '/status' },
    ].map(line => {
      // The fields in the order the datastore writes them.
      const { seq, kind, dir, at: time, source, sourceId, trust, ...rest } = line
      return { seq, kind, dir, at: time, source, sourceId, trust, ...rest }
    }),
  )
  assert.equal(fs.readFileSync(path.join(day, '1.jpg'), 'utf8'), 'jpeg bytes of a receipt')
  assert.equal(fs.readFileSync(path.join(day, '3.pdf'), 'utf8'), '%PDF-1.7 a train ticket')
  assert.deepEqual(fs.readdirSync(day).sort(), ['1.jpg', '3.pdf', 'log.jsonl'])
  // The replies go to the chat the owner wrote from.
  assert.equal(bridge.state.get().ownerChat.jid, OWNER)
})

// ---------------------------------------------------------------------------------------------
// From a webhook to a reply, through the runner (milestone 5)

// The runner of `test/support/test-runner.mjs`, with the fake sandbox and the pi stub, and the
// bridge with the wacli stub, on one data folder and one fake clock.
async function startBoth(t, { fixtures = { paired: true, messages: [] }, email = false } = {}) {
  const prepared = prepareTestRunner(t, { start: '2026-11-09T15:50:30Z' })
  const stub = createWacliStub(t, prepared.root)
  stub.fixtures(fixtures)
  const reader = email ? createMailReaderStub(prepared.root) : null
  // The clock jumps ahead while wacli calls run in real time; only the test of the timeout keeps it.
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0, WACLI_CALL_TIMEOUT: 365 * 24 * 3600_000 }))
  const runner = await startTestRunner(t, prepared)
  const { log, events } = createTestLog({ clock: prepared.clock })
  const proc = createProc({ log, clock: prepared.clock })
  const settings = bridgeSettings(prepared.root, email ? { email: EMAIL } : {})
  const bridge = await startBridge({ settings, clock: prepared.clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc, emailReader: reader?.reader })
  atEnd(t, () => bridge.stop())
  await waitFor(() => stub.callsOf('sync').length > 0 && events().includes('whatsapp.caught_up'), 'the bridge to start')
  const both = {
    ...runner,
    stub,
    reader,
    bridge,
    bridgeEvents: events,
    // Has wacli post a payload, and waits until the bridge has stored it.
    async post(payload) {
      assert.equal(await stub.postWebhook(payload), 200)
      await new Promise(resolve => setTimeout(resolve, 20))
      await bridge.intake.idle()
    },
    // Lets the runner see what was stored, waits out the quiet period, and runs what comes next.
    async runNext() {
      await runner.runner.tick()
      await runner.clock.advance(8 * SECOND)
      return runner.runner.tick()
    },
    // Moves the clock on a second at a time while the bridge sends, in real time, until both
    // outboxes are empty, the runner's and the bridge's own, and the bridge keeps no record.
    async deliver() {
      const { paths } = runner
      await waitFor(
        async () => {
          await runner.clock.advance(SECOND)
          return [paths.outbox, paths.bridgeOutbox, paths.bridgeSending].every(folder => listHandOffs(folder).length === 0)
        },
        'the outbox to empty',
        30_000,
      )
    },
    sent: () => stub.calls().filter(call => call.command === 'send text').map(call => call.args),
    lines: () => [...bridge.store.index.entries()].map(entry => entry.line),
  }
  return both
}

const messageOf = args => args[args.indexOf('--message') + 1]

test('bridge: a signed webhook goes through the runner and comes back as a quoted reply, sent through wacli and logged as an out line', async t => {
  const both = await startBoth(t)
  await both.post(webhookPayload({ ID: 'IMG1', Timestamp: '2026-11-09T15:50:00Z', Text: 'Blue Tokai 450 ASK' }))
  assert.deepEqual((await both.runNext()).outcome, { ok: true, cause: null })
  // The runner asked for the reply; the bridge sends it.
  assert.deepEqual(both.outbox(), [{ type: 'text', by: 'lifelog', text: 'Work or personal?', replyTo: 1 }])
  await both.deliver()

  assert.deepEqual(both.sent(), [['--json', 'send', 'text', '--to', OWNER, '--message', 'Work or personal?', '--no-preview', '--reply-to', 'IMG1']])
  const [message, reply] = both.lines()
  assert.equal(message.sourceId, 'IMG1')
  const { at: time, ...rest } = reply
  assert.deepEqual(rest, { seq: 2, kind: 'message', dir: 'out', source: 'whatsapp', sourceId: 'SENT1', by: 'lifelog', replyTo: 1, text: 'Work or personal?' })
  assert.ok(Date.parse(time) > Date.parse('2026-11-09T15:50:30Z'))
  // The runner sees its own reply as context, and has nothing more to do.
  assert.deepEqual(both.state().retry, [])
  assert.equal(both.state().cursor, 1)
  await both.runner.tick()
})

test('bridge: emails go through the reader, the bridge and the runner, and what is said about them reaches WhatsApp unquoted', async t => {
  const both = await startBoth(t, { email: true })
  const email = both.bridge.channels.get('email')
  await waitFor(() => email.status().startsWith('Email: connected'), 'the reader to connect')
  // The owner emails a receipt the agent asks about, and a voice memo it files.
  both.reader.deliver(gmailPlain({ body: 'Dinner with Sam, 3200. ASK' }))
  both.reader.deliver(appleMailAudio())
  await waitFor(
    async () => {
      await both.clock.advance(SECOND)
      await email.idle()
      await both.bridge.intake.idle()
      return both.lines().length === 2
    },
    'the two emails to be stored',
  )
  const [receipt, memo] = both.lines()
  assert.deepEqual([receipt.source, receipt.subject, receipt.files.map(file => file.path)], ['email', 'Dinner at Bombay Canteen', ['1.eml']])
  assert.deepEqual([memo.source, memo.subject, memo.files.map(file => file.path)], ['email', 'Call with Sam', ['2.eml', '2-2.m4a']])

  assert.deepEqual((await both.runNext()).outcome, { ok: true, cause: null })
  // The agent read the whole emails and the recording from the datastore.
  const [seen] = both.sandbox.seen()
  const day = path.join(both.paths.datastore, '2026/11/09')
  assert.ok(
    seen.prompt.endsWith(
      [
        'New messages:',
        `#1 21:12 email "Dinner at Bombay Canteen": "Dinner with Sam, 3200. ASK"`,
        `      whole email ${day}/1.eml`,
        `#2 21:42 email "Call with Sam": "Recording from today's call.\\n\\n\\n\\nSent from my iPhone"`,
        `      attachment "Call with Sam.m4a" ${day}/2-2.m4a (audio/x-m4a)`,
        `      whole email ${day}/2.eml`,
      ].join('\n'),
    ),
    seen.prompt,
  )
  // A question about the receipt, and a ✅ for the memo.
  assert.deepEqual(both.outbox(), [
    { type: 'text', by: 'lifelog', text: 'Work or personal?', replyTo: 1 },
    { type: 'react', by: 'lifelog', target: 2, emoji: '✅' },
  ])
  await both.deliver()

  // Email sends nothing: both reach WhatsApp, the question without a quote, and the reaction as a
  // text that names the email.
  assert.deepEqual(both.sent(), [
    ['--json', 'send', 'text', '--to', OWNER, '--message', 'Work or personal?', '--no-preview'],
    ['--json', 'send', 'text', '--to', OWNER, '--message', '✅ Email: Call with Sam', '--no-preview'],
  ])
  assert.deepEqual(both.stub.callsOf('send react'), [])
  const out = both.lines().filter(line => line.dir === 'out')
  assert.deepEqual(
    out.map(({ at: _, ...line }) => line),
    [
      { seq: 3, kind: 'message', dir: 'out', source: 'whatsapp', sourceId: 'SENT1', by: 'lifelog', text: 'Work or personal?' },
      { seq: 4, kind: 'message', dir: 'out', source: 'whatsapp', sourceId: 'SENT2', by: 'lifelog', text: '✅ Email: Call with Sam' },
    ],
  )
  assert.deepEqual([both.state().cursor, both.state().retry], [2, []])
  assert.match(email.status(), /; 2 stored and 0 skipped since the bridge started, /)
})

test('bridge: a text such as /status is filed as any message, and nothing answers it; scooter status says how the bridge and the runner are doing', async t => {
  const both = await startBoth(t)
  await both.post(webhookPayload({ ID: 'M1', Timestamp: '2026-11-09T15:50:00Z', Text: 'coffee 150' }))
  await both.runNext()
  await both.deliver()
  // The runner filed it, and the bridge sent its ✅.
  assert.equal(both.stub.callsOf('send react').length, 1)

  const texts = ['/status', ' /help ', '/backup', '/new']
  for (const [n, text] of texts.entries()) await both.post(webhookPayload({ ID: `T${n + 1}`, Timestamp: `2026-11-09T15:51:0${n}Z`, Text: text }))
  assert.deepEqual(
    both.lines().slice(-4).map(line => [line.kind, line.text]),
    texts.map(text => ['message', text]),
  )
  // The runner gives them to the agent, which files each, and the bridge sends a ✅ for each:
  // nothing else is sent, and nothing is written to the bridge's own outbox.
  assert.deepEqual((await both.runNext()).outcome, { ok: true, cause: null })
  assert.deepEqual(both.state().lastRun.seqs, [3, 4, 5, 6])
  await both.deliver()
  assert.equal(both.stub.callsOf('send react').length, 5)
  assert.deepEqual(both.sent(), [])
  assert.ok(both.lines().every(line => line.dir === 'in' || line.kind === 'reaction'))

  // `scooter status`, while both run.
  const { paths } = both
  const settings = bridgeSettings(both.root)
  const status = statusText({ now: both.clock.now(), settings, paths, index: readIndex(paths) })
  assert.match(status, /^Scooter, Mon 9 Nov 21:2\d \(Asia\/Kolkata\)$/m)
  assert.match(status, /^Bridge: started 21:20; it last wrote its status 21:2\d\.$/m)
  assert.match(status, /^WhatsApp: linked$/m)
  assert.match(status, /^Newest message: #6, 21:21, on WhatsApp$/m)
  assert.match(status, /^Runner: started 21:20\. VMs run with KVM; their image was built 15:30\.$/m)
  assert.match(status, /^Zero data retention: on\. The agent's internet access: off\.$/m)
  assert.match(status, /^Network, last 24 hours: 2 requests to 1 host\.$/m)
  assert.match(status, /^lifelog: last run 21:2\d, ok, 4 messages, 0 s\.$/m)
  assert.match(status, /^Runs aren't paused\.$/m)
  assert.match(status, /^Messages: 0 pending, 0 retrying, 0 failed\.$/m)
  assert.match(status, /^Backups: off, because RESTIC_REPOSITORY isn't set in bridge\.env\.$/m)

  // Stopped, the bridge says so, and the report still comes, from its files.
  await both.bridge.stop()
  assert.notEqual(readBridgeStatus(paths).stoppedAt, null)
  const out = []
  const code = await runStatus({ settings, stdout: { write: text => out.push(text) }, stderr: { write: text => assert.fail(text) }, clock: both.clock })
  assert.equal(code, 0)
  assert.match(out.join(''), /^Bridge: stopped 21:2\d, when it last wrote its status\.\nWhatsApp: stopped\nNewest message: #6, 21:21, on WhatsApp\n/m)
  assert.match(out.join(''), /^Messages: 0 pending, 0 retrying, 0 failed\.$/m)
})

test('bridge: it writes bridge/status.json at its start, whenever a channel\'s line or the backups\' changes, and at its stop', async t => {
  const root = makeTestDir(t)
  const stub = createWacliStub(t, root)
  stub.fixtures({ paired: false, messages: [] })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0, WACLI_CALL_TIMEOUT: 365 * 24 * 3600_000 }))
  const clock = createFakeClock('2026-11-09T15:45:00Z')
  const paths = makePaths(bridgeSettings(root))
  const { bridge } = await start(t, root, { clock })
  // Each look is a second of the clock's.
  const look = async () => {
    await clock.advance(SECOND)
    return readBridgeStatus(paths)
  }
  await waitFor(async () => (await look())?.channels.whatsapp === 'WhatsApp: not linked; run `scooter pair`', 'the bridge to find wacli unpaired')
  const first = readBridgeStatus(paths)
  assert.deepEqual(first, {
    startedAt: '2026-11-09T15:45:00Z',
    writtenAt: first.writtenAt,
    stoppedAt: null,
    channels: { whatsapp: 'WhatsApp: not linked; run `scooter pair`' },
    backups: 'Backups: off, because RESTIC_REPOSITORY isn\'t set in bridge.env.',
  })
  assert.equal(fs.statSync(paths.bridgeStatus).mode & 0o777, 0o600)
  // Nothing changes: nothing is written.
  const before = fs.statSync(paths.bridgeStatus).ino
  for (let n = 0; n < 5; n++) await look()
  assert.equal(fs.statSync(paths.bridgeStatus).ino, before)
  assert.equal(readBridgeStatus(paths).writtenAt, first.writtenAt)
  // wacli is paired: the channel's next check finds it, within a minute, and the file says so.
  stub.fixtures({ paired: true, messages: [] })
  await waitFor(async () => (await look()).channels.whatsapp === 'WhatsApp: linked', 'the link to show', 30_000)
  assert.ok(Date.parse(readBridgeStatus(paths).writtenAt) > Date.parse(first.writtenAt))
  // Stopped: once more, with the channel stopped and when.
  await bridge.stop()
  const last = readBridgeStatus(paths)
  assert.deepEqual([last.channels, last.stoppedAt, last.writtenAt], [{ whatsapp: 'WhatsApp: stopped' }, last.writtenAt, last.writtenAt])
  assert.notEqual(last.stoppedAt, null)
  assert.deepEqual(fs.readdirSync(paths.bridge).filter(name => name.startsWith('.')), [])
})

test('bridge: the state records the first start, and keeps it', async t => {
  const root = makeTestDir(t)
  const paths = makePaths(bridgeSettings(root))
  fs.mkdirSync(paths.bridge, { recursive: true })
  const clock = createFakeClock('2026-11-09T15:45:00Z')
  const { log } = createTestLog({ clock })
  const state = openBridgeState({ paths, clock, log })
  assert.deepEqual(state.get(), { firstStart: '2026-11-09T15:45:00Z', ownerChat: null, lastBackup: null })
  assert.equal(fs.statSync(paths.bridgeState).mode & 0o777, 0o600)
  state.update({ ownerChat: { jid: OWNER, at: '2026-11-09T15:46:00Z' } })

  clock.set('2026-11-12T08:00:00Z')
  const again = openBridgeState({ paths, clock, log })
  assert.deepEqual(again.get(), { firstStart: '2026-11-09T15:45:00Z', ownerChat: { jid: OWNER, at: '2026-11-09T15:46:00Z' }, lastBackup: null })
  // What it holds is checked, when read and when changed.
  assert.throws(() => again.update({ ownerChat: { jid: '' } }), /ownerChat must be null or/)
  assert.throws(() => again.update({ firstStart: 'yesterday' }), /firstStart must be a UTC time/)
  // A file that isn't a state stops the bridge, and the message says which.
  fs.writeFileSync(paths.bridgeState, '{"firstStart":')
  assert.throws(() => openBridgeState({ paths, clock, log }), new RegExp(`${paths.bridgeState} is not JSON`))
  fs.writeFileSync(paths.bridgeState, '{"firstStart":"2026-11-09","ownerChat":null,"lastBackup":null}')
  assert.throws(() => openBridgeState({ paths, clock, log }), /firstStart must be/)
})

test('bridge: a second bridge on the same data folder refuses to start', async t => {
  const root = makeTestDir(t)
  createWacliStub(t, root).fixtures({ paired: false })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const { bridge } = await start(t, root)
  await assert.rejects(start(t, root), /another bridge is running on this data folder/)
  // The first is untouched.
  assert.ok(fs.existsSync(bridge.paths.bridgeSocket))
  await bridge.stop()
  assert.equal(fs.existsSync(bridge.paths.bridgeSocket), false)
  // Once it has stopped, another can start.
  const { bridge: next } = await start(t, root)
  await next.stop()
})

test('bridge: a socket left by a bridge that was killed is replaced', async t => {
  const root = makeTestDir(t)
  const socket = path.join(root, 'bridge.sock')
  // A socket file with nobody listening, as a bridge killed with SIGKILL leaves it.
  const script = `require('net').createServer().listen(${JSON.stringify(socket)}, () => console.log('listening'))`
  const killed = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise(resolve => killed.stdout.once('data', resolve))
  killed.kill('SIGKILL')
  await new Promise(resolve => killed.once('exit', resolve))
  assert.ok(fs.existsSync(socket))
  const instance = await holdInstance(socket)
  await assert.rejects(holdInstance(socket), /another bridge is running/)
  await assert.rejects(holdInstance(socket, 'runner'), /another runner is running/)
  await instance.close()
  assert.equal(fs.existsSync(socket), false)
})

test('bridge: attachments that waited for the store when the bridge stopped are cleared at startup', async t => {
  const root = makeTestDir(t)
  createWacliStub(t, root).fixtures({ paired: false })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const paths = makePaths(bridgeSettings(root))
  fs.mkdirSync(paths.bridgeIncoming, { recursive: true })
  fs.writeFileSync(path.join(paths.bridgeIncoming, '20261109T154500000-0001-1'), 'half a download')
  await start(t, root)
  assert.deepEqual(fs.readdirSync(paths.bridgeIncoming), [])
})

test('bridge: its own folder is made 0700', async t => {
  const root = makeTestDir(t)
  createWacliStub(t, root).fixtures({ paired: false })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const { bridge } = await start(t, root)
  for (const dir of [bridge.paths.bridge, bridge.paths.bridgeIncoming, bridge.paths.wacli, bridge.paths.wacliStaging]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir)
  }
})

// The port wacli posts to, unless a test sets another. `scooter bridge` as a process uses it.
function portIsFree(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

// As root, the bridge needs the users that `setup` makes.
const asProcess = { skip: isRoot ? 'as root, scooter bridge needs the users setup makes' : false }

test('bridge: `scooter bridge` runs as a process until SIGTERM, backs up on SIGUSR1, and leaves no wacli behind', asProcess, async t => {
  if (!(await portIsFree(limits.WEBHOOK_PORT))) return t.skip(`port ${limits.WEBHOOK_PORT} is in use`)
  const root = makeTestDir(t)
  const stub = createWacliStub(t, root)
  // The messages' times, to the second: an hour after now, and the second after. Catch-up lists a
  // chat from the bridge's first start on, which this process takes from the real clock, so any
  // fixed time would be passed one day, and catch-up would then list nothing.
  const later = seconds => new Date((Math.floor(Date.now() / 1000) + 3600 + seconds) * 1000).toISOString().replace('.000Z', 'Z')
  stub.fixtures({ paired: true, messages: [listRow({ MsgID: 'CU1', Timestamp: later(0), Text: 'caught up' })] })
  const restic = createResticStub(t, root)
  const dataDir = path.join(root, 'data')
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    SCOOTER_ENV_DIR: path.join(root, 'no-env-files'),
    OWNER_NUMBER: `+${OWNER_NUMBER}`,
    DATA_DIR: dataDir,
    CONFIG_DIR: path.join(root, 'config'),
    RESTIC_REPOSITORY: path.join(root, 'repository'),
    RESTIC_PASSWORD: 'correct horse',
    BACKUP_TIME: 'off',
    // A backup checks the repository on Sundays in SCOOTER_TZ, and this bridge reads the real
    // clock, which the test can't fake. With FORCE_CHECK=1 it checks after every backup, so restic
    // is asked the same on every day, in any zone. The Sunday rule is backup.test.mjs's, with a
    // fake clock.
    FORCE_CHECK: '1',
  }
  const child = spawn(process.execPath, [CLI, 'bridge'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  atEnd(t, () => child.kill('SIGKILL'))
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
  const events = () => stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line).event)

  // Waits for `check`. Another process, such as another copy of this test, may take the port
  // between the check above and the bridge's start, or while a backup has the webhook closed; the
  // bridge then stops, as it must without its webhook, and this resolves true. A wait that times
  // out says what the bridge logged last, which holds no message's text.
  async function portTakenBefore(check, what) {
    const waiting = waitFor(check, what)
    try {
      if (await Promise.race([waiting.then(() => false), exited.then(() => /EADDRINUSE/.test(stderr))])) return true
      await waiting
      return false
    } catch (error) {
      error.message += `; the bridge's last log lines:\n${stderr.trim().split('\n').slice(-10).join('\n')}`
      throw error
    }
  }
  if (await portTakenBefore(() => events().includes('whatsapp.caught_up') && stub.callsOf('sync').length > 0, 'the bridge to start')) {
    return t.skip(`port ${limits.WEBHOOK_PORT} was taken`)
  }
  assert.equal(await stub.postWebhook(webhookPayload({ ID: 'WH1', Text: 'coffee 150', Timestamp: later(1) })), 200)
  const log = path.join(dataDir, 'datastore')
  await waitFor(() => events().filter(event => event === 'intake.stored').length === 2, 'two lines')

  // A backup now: WhatsApp stops while restic runs, and starts again.
  child.kill('SIGUSR1')
  await waitFor(() => events().includes('backup.finished'), 'the backup')
  assert.deepEqual(restic.commands(), ['backup', 'forget', 'check'])
  if (await portTakenBefore(() => stub.callsOf('sync').length === 2, 'sync to start again')) {
    return t.skip(`port ${limits.WEBHOOK_PORT} was taken while the backup had the webhook closed`)
  }

  child.kill('SIGTERM')
  assert.deepEqual(await exited, { code: 0, signal: null })
  for (const { pid } of stub.callsOf('sync')) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.deepEqual(events().slice(-2), ['whatsapp.stopped', 'bridge.stopped'])
  // Every log line is JSON, and none holds what the owner wrote.
  assert.ok(!stderr.includes('coffee') && !stderr.includes('caught up'))
  // Each line is in the folder of the UTC day it was stored on: two folders, when a UTC midnight
  // came between the two.
  const days = fs.readdirSync(log, { recursive: true }).filter(name => name.endsWith('log.jsonl'))
  const texts = days.flatMap(day => fs.readFileSync(path.join(log, day), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).text))
  assert.deepEqual(texts.sort(), ['caught up', 'coffee 150'])
  assert.equal(fs.existsSync(path.join(dataDir, 'bridge', 'bridge.sock')), false)
})
