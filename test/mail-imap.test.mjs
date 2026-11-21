// The mailbox adapter over imapflow (`src/mail/imap.mjs`), against a small IMAP server on a Unix
// socket (`support/imap-server.mjs`), which imapflow reaches through its `transport` option: the
// commands the reader's functions send, `n:*`, IDLE, a lost connection, a wrong password, and that
// nothing changes the mailbox. And the reader on top of it, with imapflow for real.
//
// What only a real provider shows, TLS, an app password and the provider's own IDLE, is for the
// first real run.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { listHandOffs } from '../src/common/files.mjs'
import { openImapMailbox } from '../src/mail/imap.mjs'
import { runReader } from '../src/mail/reader.mjs'
import { startImapServer } from './support/imap-server.mjs'
import { createTestLog } from './support/log.mjs'
import { OWNER_ADDRESSES, gmailPlain, outlookHtmlOnly, stranger } from './support/mail-samples.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const USER = 'scooter.inbox@example.com'
const PASSWORD = 'an app password'
const CONFIG = { host: 'imap.example.com', port: 993, user: USER, password: PASSWORD }

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function setup(t, options = {}) {
  const root = makeTestDir(t)
  const server = await startImapServer(path.join(root, 'imap.sock'), { user: USER, password: PASSWORD, uidNext: 41, ...options })
  atEnd(t, () => server.close())
  // Auto-IDLE after 50 ms of quiet, not imapflow's 15 s, so the test needn't wait.
  const open = () => openImapMailbox(CONFIG, { transport: server.transport, autoIdleDelay: 50 })
  return { root, server, open }
}

const headerOf = raw => raw.subarray(0, raw.indexOf('\r\n\r\n') + 4)

test('imap: it opens INBOX read-only, and lists, fetches and searches by UID as the reader asks', async t => {
  const { server, open } = await setup(t)
  const plain = gmailPlain()
  server.deliver(plain, { arrivedAt: '2026-11-08T09:00:00Z' })
  server.deliver(stranger(), { arrivedAt: '2026-11-09T10:00:05Z', size: 104857601 })
  const mailbox = await open()
  atEnd(t, () => mailbox.close())

  assert.deepEqual(await mailbox.open(), { uidValidity: 3857529045, uidNext: 43 })
  assert.deepEqual(await mailbox.list(41), [
    { uid: 41, size: plain.length, arrivedAt: '2026-11-08T09:00:00Z' },
    { uid: 42, size: 104857601, arrivedAt: '2026-11-09T10:00:05Z' },
  ])
  // `n:*` with no message from `n` on: IMAP answers with the newest, whatever its UID.
  assert.deepEqual(await mailbox.list(50), [{ uid: 42, size: 104857601, arrivedAt: '2026-11-09T10:00:05Z' }])
  assert.deepEqual(await mailbox.header(41), headerOf(plain))
  assert.deepEqual(await mailbox.source(41), plain)
  // A message that is gone.
  assert.equal(await mailbox.header(99), null)
  assert.equal(await mailbox.source(99), null)
  assert.deepEqual(await mailbox.search({ since: new Date('2026-11-09T00:00:00Z') }), [42])
  assert.deepEqual(await mailbox.search({ since: new Date('2026-11-01T00:00:00Z') }), [41, 42])
  assert.deepEqual((await mailbox.newest(5)).map(message => message.uid), [41, 42])
  assert.deepEqual((await mailbox.newest(1)).map(message => message.uid), [42])
  await mailbox.close()

  // Nothing changes the mailbox: EXAMINE, not SELECT; BODY.PEEK, so not even `\Seen`; no STORE,
  // EXPUNGE, COPY, MOVE or APPEND.
  const names = new Set(server.commands.map(({ command }) => command))
  assert.ok(names.has('EXAMINE'))
  for (const changes of ['SELECT', 'STORE', 'UID STORE', 'EXPUNGE', 'UID EXPUNGE', 'COPY', 'UID COPY', 'MOVE', 'UID MOVE', 'APPEND']) assert.ok(!names.has(changes), changes)
  const fetches = server.commands.filter(({ command }) => command.endsWith('FETCH'))
  assert.ok(fetches.length >= 6)
  for (const { rest } of fetches) assert.ok(!/BODY\[/i.test(rest), rest)
  assert.ok(names.has('LOGOUT'))
})

test('imap: IDLE tells it of new mail, and a lost connection ends the wait with an error', async t => {
  const { server, open } = await setup(t)
  const mailbox = await open()
  atEnd(t, () => mailbox.close())
  await mailbox.open()
  await until(() => server.commands.some(({ command }) => command === 'IDLE'), 'IDLE')
  const news = mailbox.news({})
  let told = false
  news.then(() => (told = true))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(told, false)
  server.deliver(gmailPlain())
  await news
  // Mail that arrived while nobody waited is news at once.
  await until(() => server.commands.filter(({ command }) => command === 'IDLE').length >= 1, 'IDLE again')
  server.deliver(outlookHtmlOnly())
  await new Promise(resolve => setTimeout(resolve, 30))
  await mailbox.news({})
  // A wait can be cut short.
  const stop = new AbortController()
  const waiting = mailbox.news({ signal: stop.signal })
  stop.abort()
  await assert.rejects(waiting)

  const lost = mailbox.news({})
  server.drop()
  await assert.rejects(lost, { code: 'ECLOSED' })
  await assert.rejects(mailbox.news({}), { code: 'ECLOSED' })
})

test('imap: a wrong password is refused when it connects', async t => {
  const { server } = await setup(t)
  await assert.rejects(openImapMailbox({ ...CONFIG, password: 'wrong' }, { transport: server.transport }))
  // The password goes nowhere but the LOGIN command.
  assert.ok(!JSON.stringify(server.commands).includes(PASSWORD))
})

test('imap: the reader, with imapflow for real, hands over what arrives and keeps its place', async t => {
  const { root, server, open } = await setup(t)
  server.deliver(gmailPlain({ messageId: '<before@mail.example>' }))
  const home = path.join(root, 'mail')
  fs.mkdirSync(home)
  const { log, events } = createTestLog()
  const config = { ...CONFIG, home, ownerAddresses: OWNER_ADDRESSES, checkSeconds: 60 }
  const stop = new AbortController()
  const done = runReader({ config, openMailbox: open, log, signal: stop.signal })
  atEnd(t, async () => {
    stop.abort()
    await done.catch(() => {})
  })
  await until(() => events().includes('mail.position_started'), 'the reader to start')
  // Arrives while it waits in IDLE: handed over without waiting for the next look.
  server.deliver(gmailPlain({ messageId: '<after@mail.example>' }))
  server.deliver(stranger())
  const spool = path.join(home, 'spool')
  await until(() => listHandOffs(spool).length === 2, 'two folders')
  const [mine, theirs] = listHandOffs(spool).map(id => JSON.parse(fs.readFileSync(path.join(spool, id, 'parsed.json'), 'utf8')))
  assert.deepEqual([mine.uid, mine.fetched, mine.subject], [42, 'whole', 'Dinner at Bombay Canteen'])
  assert.deepEqual([theirs.uid, theirs.fetched], [43, 'headers'])
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).next, 44)
  stop.abort()
  await done
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).connected, false)
  // The whole message was fetched only for the owner's mail.
  const sources = server.commands.filter(({ command, rest }) => command === 'UID FETCH' && /BODY\.PEEK\[\]/i.test(rest))
  assert.deepEqual(sources.map(({ rest }) => rest.split(' ')[0]), ['42'])
})
