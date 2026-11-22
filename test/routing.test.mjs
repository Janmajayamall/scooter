// Routing: which channel each outbox entry goes to, and
// what is quoted. `replyTo` and `about` follow their line's channel; a reply about an email reaches
// `DEFAULT_CHANNEL` without a quote; a reaction to an email becomes a `✅ Email:` text; notices,
// scheduled tasks and the backfill summary go to `DEFAULT_CHANNEL`; and a `DEFAULT_CHANNEL` that
// can't send stops the bridge at startup.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { defaultChannelProblem } from '../src/bridge/channels/index.mjs'
import { BridgeConfigError, runBridge, startBridge } from '../src/bridge/main.mjs'
import { routeEntry } from '../src/bridge/outbox.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { CUT_NOTE, textLength } from '../src/common/outbox.mjs'
import { createProc } from '../src/common/proc.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createFakeChannel } from './support/fake-channel.mjs'
import { createTestLog } from './support/log.mjs'
import { isRoot } from './support/root.mjs'
import { indexOf, line } from './support/runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'
import { OWNER_NUMBER, createWacliStub } from './support/wacli.mjs'

const AT = '2026-11-09T15:40:00Z'
const LINES = [
  line.text(1, AT, 'coffee 150', { sourceId: 'WA1' }),
  line.email(2, AT, 'Call with Sam', 'Recording from today.', { sourceId: 'mail-1@example.com' }),
  line.edit(3, AT, 1, 'coffee 120'),
  line.delete(4, AT, 1),
  line.sent(5, AT, 'Work or personal?', { sourceId: 'WA-OUT-5', replyTo: 1 }),
  line.reaction(6, AT, 1, '👍', { sourceId: 'WA6' }),
  line.email(7, AT, '', 'No subject here.', { sourceId: 'mail-2@example.com' }),
  { ...line.sent(8, AT, 'sent, and wacli gave no ID'), sourceId: undefined },
].map(fixture => JSON.parse(JSON.stringify(fixture)))

function channels() {
  const whatsapp = createFakeChannel({ name: 'whatsapp' })
  const email = createFakeChannel({ name: 'email', canSend: false, canReact: false })
  return new Map([
    ['whatsapp', whatsapp],
    ['email', email],
  ])
}

// Where `entry` goes, as `[channel, quoted ID or the action]`.
function route(entry, { channelMap = channels(), lines = LINES } = {}) {
  const result = routeEntry(entry, { index: indexOf(lines), channels: channelMap, defaultChannel: 'whatsapp' })
  if (result.action === 'drop') return ['drop', result.reason]
  if (result.action === 'react') return [result.channel.name, 'react', result.id, result.target]
  return [result.channel.name, result.quote?.id ?? null, result.text]
}

const text = fields => ({ type: 'text', by: 'lifelog', text: 'hello', ...fields })
const react = target => ({ type: 'react', by: 'lifelog', target, emoji: '✅' })

test('routing: replyTo and about follow their line\'s channel; only replyTo quotes', () => {
  assert.deepEqual(route(text({ replyTo: 1 })), ['whatsapp', 'WA1', 'hello'])
  assert.deepEqual(route(text({ about: 1 })), ['whatsapp', null, 'hello'])
  // A reply to the bot's own message quotes it by the ID wacli gave it.
  assert.deepEqual(route(text({ replyTo: 5 })), ['whatsapp', 'WA-OUT-5', 'hello'])
  // An edit or a deletion is quoted as the message it changes.
  assert.deepEqual(route(text({ replyTo: 3 })), ['whatsapp', 'WA1', 'hello'])
  assert.deepEqual(route(text({ replyTo: 4 })), ['whatsapp', 'WA1', 'hello'])
  // A line with no channel ID, or one that isn't a message, goes to its channel unquoted.
  assert.deepEqual(route(text({ replyTo: 8 })), ['whatsapp', null, 'hello'])
  assert.deepEqual(route(text({ replyTo: 6 })), ['whatsapp', null, 'hello'])
})

test('routing: a reply about an email reaches DEFAULT_CHANNEL without a quote', () => {
  assert.deepEqual(route(text({ replyTo: 2 })), ['whatsapp', null, 'hello'])
  assert.deepEqual(route(text({ about: 2 })), ['whatsapp', null, 'hello'])
})

test('routing: a line that doesn\'t exist, or a text with neither replyTo nor about, goes to DEFAULT_CHANNEL', () => {
  assert.deepEqual(route(text({ replyTo: 999 })), ['whatsapp', null, 'hello'])
  assert.deepEqual(route(text({ about: 999 })), ['whatsapp', null, 'hello'])
  // Notices, scheduled tasks, the backfill summary and the bridge's own messages have neither.
  for (const by of ['runner', 'lifelog', 'bridge']) assert.deepEqual(route(text({ by })), ['whatsapp', null, 'hello'])
})

test('routing: a reaction goes to its target\'s channel, as a reaction to the message it is or changes', () => {
  assert.deepEqual(route(react(1)), ['whatsapp', 'react', 'WA1', 1])
  assert.deepEqual(route(react(3)), ['whatsapp', 'react', 'WA1', 1])
})

test('routing: a reaction to an email becomes a ✅ Email: text on DEFAULT_CHANNEL', () => {
  assert.deepEqual(route(react(2)), ['whatsapp', null, '✅ Email: Call with Sam'])
  assert.deepEqual(route(react(7)), ['whatsapp', null, '✅ Email: (no subject)'])
})

test('routing: the ✅ Email: text is cut as an entry\'s text is, whatever subject the datastore holds', () => {
  // The text was once made after the entry was written, from a subject the datastore bounds only
  // since milestone 6.
  const lines = [...LINES, line.email(9, AT, `a\0${'s'.repeat(60000)}`, 'long', { sourceId: 'mail-3@example.com' })]
  const [channel, quote, text] = route(react(9), { lines })
  assert.deepEqual([channel, quote], ['whatsapp', null])
  assert.equal(textLength(text), limits.TEXT_MAX_CHARS)
  assert.ok(text.startsWith('✅ Email: a\ufffdsss'))
  assert.ok(text.endsWith(CUT_NOTE))
})

test('routing: a ✅ Email: text takes the subject from the line\'s data only when it is a string there', () => {
  const email = (seq, data) => ({ ...line.email(seq, AT, '', 'text', { sourceId: `mail-${seq}@example.com` }), data })
  const lines = [
    ...LINES,
    email(9, undefined),
    email(10, ['Call with Sam']),
    email(11, 'Call with Sam'),
    email(12, { subject: 7 }),
    email(13, { subject: { text: 'Call with Sam' } }),
    email(14, null),
    email(15, { subject: ' Call\nwith\tSam ', other: 'kept' }),
  ].map(fixture => JSON.parse(JSON.stringify(fixture)))
  for (const seq of [9, 10, 11, 12, 13, 14]) assert.deepEqual(route(react(seq), { lines }), ['whatsapp', null, '✅ Email: (no subject)'], `#${seq}`)
  assert.deepEqual(route(react(15), { lines }), ['whatsapp', null, '✅ Email: Call with Sam'])
})

test('routing: a line of a kind or a channel this version doesn\'t know: a reply about one of a channel that is gone goes to DEFAULT_CHANNEL, and a reaction to one is dropped', () => {
  const base = { dir: 'in', at: AT, trust: 'owner' }
  const lines = [
    ...LINES,
    // The kind an earlier version wrote for /status, from WhatsApp.
    { seq: 9, kind: 'command', ...base, source: 'whatsapp', sourceId: 'WA9', text: '/status' },
    // A channel that is gone.
    { seq: 10, kind: 'message', ...base, source: 'telegram', sourceId: 'TG10', text: 'hi' },
    // A WhatsApp message without the text a message needs.
    { seq: 11, kind: 'message', ...base, source: 'whatsapp', sourceId: 'WA11' },
    // An edit of the old command, and one of the gone channel's message.
    { seq: 12, kind: 'edit', ...base, source: 'whatsapp', sourceId: 'WA9', target: 9, text: '/help' },
    { seq: 13, kind: 'edit', ...base, source: 'telegram', sourceId: 'TG10', target: 10, text: 'hello' },
    { seq: 14, kind: 'message', ...base, source: 'constructor', sourceId: 'X14', text: 'hi' },
  ]
  // A gone channel's line, or an edit of one: to DEFAULT_CHANNEL, unquoted.
  for (const seq of [10, 13, 14]) {
    assert.deepEqual(route(text({ replyTo: seq }), { lines }), ['whatsapp', null, 'hello'], `replyTo #${seq}`)
    assert.deepEqual(route(text({ about: seq }), { lines }), ['whatsapp', null, 'hello'], `about #${seq}`)
  }
  // A line of WhatsApp's that this version doesn't know, or an edit of one: to WhatsApp, unquoted.
  for (const seq of [9, 11, 12]) {
    assert.deepEqual(route(text({ replyTo: seq }), { lines }), ['whatsapp', null, 'hello'], `replyTo #${seq}`)
  }
  // A reaction to any of them is dropped: none is a message this version knows.
  for (const seq of [9, 10, 11, 14]) assert.deepEqual(route(react(seq), { lines }), ['drop', "a line this version doesn't know"], `#${seq}`)
  for (const seq of [12]) assert.deepEqual(route(react(seq), { lines }), ['drop', "not one of the owner's messages"], `#${seq}`)
  assert.deepEqual(route(react(13), { lines }), ['drop', "a line this version doesn't know"])
})

test('routing: a reaction to an unknown line, to what Scooter sent, or to a reaction is dropped', () => {
  assert.deepEqual(route(react(999)), ['drop', 'unknown target'])
  assert.deepEqual(route(react(5)), ['drop', "not one of the owner's messages"])
  assert.deepEqual(route(react(6)), ['drop', "not one of the owner's messages"])
  // A channel that isn't running, or can't react.
  const only = new Map([['whatsapp', createFakeChannel({ name: 'whatsapp', canReact: false })]])
  assert.deepEqual(route(react(1), { channelMap: only }), ['drop', "its channel can't react"])
})

test('routing: a reply goes to DEFAULT_CHANNEL when its line\'s channel isn\'t running', () => {
  const whatsappOnly = new Map([['whatsapp', createFakeChannel({ name: 'whatsapp' })]])
  assert.deepEqual(route(text({ replyTo: 2 }), { channelMap: whatsappOnly }), ['whatsapp', null, 'hello'])
})

test('routing: DEFAULT_CHANNEL must be a channel that is running and can send', () => {
  const map = channels()
  assert.equal(defaultChannelProblem(map, 'whatsapp'), null)
  assert.equal(defaultChannelProblem(map, 'email'), "DEFAULT_CHANNEL is email, which can't send; it must be a channel that can send: whatsapp")
  const whatsappOnly = new Map([['whatsapp', createFakeChannel({ name: 'whatsapp' })]])
  assert.equal(defaultChannelProblem(whatsappOnly, 'email'), "DEFAULT_CHANNEL is email, which isn't running; it must be a channel that can send: whatsapp")
})

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

test('routing: a DEFAULT_CHANNEL that can\'t send stops the bridge at startup, before it starts a channel', async t => {
  const root = makeTestDir(t)
  const stub = createWacliStub(t, root)
  stub.fixtures({ paired: true })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const clock = createFakeClock('2026-11-09T15:45:00Z')
  const { log } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const asTester = isRoot ? { ...proc, lookupUser: async () => null } : proc
  await assert.rejects(startBridge({ settings: bridgeSettings(root, { defaultChannel: 'email' }), clock, log, proc: asTester }), error => {
    assert.ok(error instanceof BridgeConfigError)
    assert.equal(error.message, "DEFAULT_CHANNEL is email, which isn't running; it must be a channel that can send: whatsapp")
    return true
  })
  // No wacli was started, and the data folder was let go of: a bridge with whatsapp starts.
  assert.deepEqual(stub.calls(), [])
  const bridge = await startBridge({ settings: bridgeSettings(root), clock, log, proc: asTester })
  await bridge.stop()
})

test('routing: `scooter bridge` exits with 2 and says why when DEFAULT_CHANNEL can\'t send', { skip: isRoot ? 'as root, scooter bridge needs the users setup makes' : false }, async t => {
  const root = makeTestDir(t)
  createWacliStub(t, root).fixtures({ paired: false })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  let stderr = ''
  const saved = process.stderr.write
  // The bridge logs to stderr too; only what it tells the person starting it is kept here.
  process.stderr.write = () => true
  let code
  try {
    code = await runBridge({ settings: bridgeSettings(root, { defaultChannel: 'email' }), stderr: { write: text => (stderr += text) } })
  } finally {
    process.stderr.write = saved
  }
  assert.equal(code, 2)
  assert.match(stderr, /^scooter bridge: DEFAULT_CHANNEL is email, which isn't running; it must be a channel that can send: whatsapp\n$/)
})
