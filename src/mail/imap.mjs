// The mailbox, over IMAP with `imapflow`.
//
// This is the reader's only contact with the mail server, and a small one, so that the reader's
// own logic can be tested against a fake mailbox with the same functions
// (`test/support/fake-mailbox.mjs`). A mailbox has:
//
//   open()              opens `INBOX` read-only (EXAMINE) and resolves with `{ uidValidity,
//                       uidNext }`
//   list(from)          the messages `from:*` by UID, as `{ uid, size, arrivedAt }`. As IMAP has
//                       it, that includes the newest message when there is none from `from` on,
//                       whatever its UID
//   header(uid)         its header block, as a Buffer, or null when it is gone
//   source(uid)         the whole message, as a Buffer, or null when it is gone
//   search({ since })   the UIDs of the messages that arrived on or after a date (a `Date` at UTC
//                       midnight), in order
//   newest(count)       the newest `count` messages, as `list` gives them
//   news({ signal })    resolves when the server has said that new mail arrived since the last
//                       time it resolved, at once if it has; rejects when the connection is lost
//   close()             logs out
//
// Nothing here changes the mailbox: it is opened read-only, and the messages are fetched with
// `BODY.PEEK`, so not even the `\Seen` flag changes. The mailbox doubles as a copy.
//
// imapflow logs nothing (`logger: false`): its logs can hold what the server sent. Its keepalive
// breaks IDLE every five minutes of quiet, so a server that ends an IDLE of 30 minutes (RFC 9051)
// never does.

import { ImapFlow } from 'imapflow'

// A time as the spool writes one, to the second, from what imapflow gives: a Date, or text.
function isoOf(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')
}

const message = row => ({ uid: row.uid, size: Number.isSafeInteger(row.size) ? row.size : null, arrivedAt: isoOf(row.internalDate) })
const byUid = (a, b) => a.uid - b.uid

// Connects to the mailbox and logs in, over TLS. `options` is for tests: `transport` and
// `autoIdleDelay` go to imapflow as they are. Rejects when it can't connect or log in.
export async function openImapMailbox({ host, port, user, password }, options = {}) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
    ...options,
  })
  let lost = null
  let arrived = false
  let waiters = []
  const settle = (outcome, value) => {
    const waiting = waiters
    waiters = []
    for (const waiter of waiting) waiter[outcome](value)
  }
  const fail = error => {
    lost ??= error
    settle('reject', lost)
  }
  // Without a listener an `error` event would end the process; the reader ends anyway, by the
  // rejected call or wait, and the bridge starts it again.
  client.on('error', error => fail(error))
  client.on('close', () => fail(Object.assign(new Error('the connection to the mailbox was lost'), { code: 'ECLOSED' })))
  client.on('exists', ({ count, prevCount }) => {
    if (count <= prevCount) return
    arrived = true
    settle('resolve')
  })
  await client.connect()

  return {
    async open() {
      const box = await client.mailboxOpen('INBOX', { readOnly: true })
      const opened = { uidValidity: Number(box.uidValidity), uidNext: box.uidNext }
      // IMAP requires both. Without them the reader couldn't keep its place.
      if (!(opened.uidValidity > 0 && Number.isSafeInteger(opened.uidNext) && opened.uidNext > 0)) {
        throw Object.assign(new Error('the mailbox gave no UIDVALIDITY or UIDNEXT'), { code: 'ENOUID' })
      }
      return opened
    },

    async list(from) {
      const rows = await client.fetchAll(`${from}:*`, { uid: true, size: true, internalDate: true }, { uid: true })
      return rows.map(message).sort(byUid)
    },

    async header(uid) {
      const row = await client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true })
      return row && row.headers ? Buffer.from(row.headers) : null
    },

    async source(uid) {
      const row = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
      return row && row.source ? Buffer.from(row.source) : null
    },

    async search({ since }) {
      const uids = await client.search({ since }, { uid: true })
      return Array.isArray(uids) ? [...uids].sort((a, b) => a - b) : []
    },

    async newest(count) {
      const exists = client.mailbox ? client.mailbox.exists : 0
      if (exists === 0) return []
      const rows = await client.fetchAll(`${Math.max(1, exists - count + 1)}:*`, { uid: true, size: true, internalDate: true })
      return rows.map(message).sort(byUid).slice(-count)
    },

    news({ signal }) {
      if (lost) return Promise.reject(lost)
      if (arrived) {
        arrived = false
        return Promise.resolve()
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort)
            arrived = false
            resolve()
          },
          reject: error => {
            signal?.removeEventListener('abort', onAbort)
            reject(error)
          },
        }
        const onAbort = () => {
          waiters = waiters.filter(other => other !== waiter)
          reject(signal.reason ?? new Error('aborted'))
        }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
    },

    async close() {
      if (lost) return client.close()
      try {
        await client.logout()
      } catch {
        client.close()
      }
    },
  }
}
