// The email reader (5.6 of DESIGN.md; ARCHITECTURE.md 2.3): `node src/mail/reader.mjs run`.
//
// A program of its own, which the bridge starts as `scooter-mail` and starts again with backoff
// whenever it exits (`src/bridge/channels/email.mjs`). It is the only part of Scooter that uses
// `imapflow` and `postal-mime`, so their code never runs in the bridge's process. It reads and
// writes only its home, `/data/mail`, and its environment holds only the mailbox's settings.
//
// What it does:
// - keeps one TLS connection to the mailbox, with `INBOX` open read-only, and waits for new mail
//   with IDLE, looking at least every `EMAIL_CHECK_SECONDS` in case IDLE misses something;
// - for each new message, in UID order, fetches its header block first, and the whole message only
//   when a `From` header names one of the owner's addresses and it isn't over
//   `ATTACHMENT_MAX_BYTES`. Other mail is handed over with its headers only, so the bridge can log
//   and count it;
// - parses each whole message (`parse.mjs`), and hands it over as a folder in the spool
//   (`spool.mjs`). One that can't be parsed is handed over raw, saying so, so it can't hold up the
//   ones after it;
// - keeps its position: the mailbox's `UIDVALIDITY`, and `next`, the UID after the last message
//   handed over, which moves once the folder is renamed. The first time, `next` is the mailbox's
//   `UIDNEXT`, so nothing already there is imported. For `n:*`, IMAP returns the newest message
//   even when its UID is lower than `n`, so a UID below `next` is ignored. When `UIDVALIDITY`
//   changes, the server has renumbered the mailbox: the reader starts again from the first message
//   that arrived since the day before the newest one it handed over, and the bridge skips what it
//   has already stored, by `Message-ID`.
//
// It never deletes, moves or flags mail. Any error with the mailbox ends it with exit code 1, and
// the bridge starts it again after a wait that doubles (`RESTART_BACKOFF`), which is how it
// reconnects with backoff. SIGTERM ends it with 0.
//
// `node src/mail/reader.mjs newest`, for `scooter email-check`: prints the header blocks of
// the mailbox's newest `EMAIL_CHECK_COUNT` messages, one JSON object a line, and stores nothing.
//
// Its logs, on stderr, hold UIDs, counts and sizes, never what an email says.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIds } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { openImapMailbox } from './imap.mjs'
import { firstChars, mentionsOwner, parseEmail, parseSubject } from './parse.mjs'
import { openSpool, readPosition, writePosition, writeSpoolFolder } from './spool.mjs'

// The clock of `src/common/time.mjs`, which the reader may not import (ARCHITECTURE.md 4.2): the
// time in milliseconds, and a wait that an AbortSignal cuts short.
export const systemClock = {
  now: () => Date.now(),
  sleep: (ms, { signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
}

// A time to the second, as the spool and the position write it.
export const isoSeconds = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')

// The variables the reader reads, besides `HOME`, `TZ`, `PATH` and `LANG`.
export const READER_VARIABLES = ['EMAIL_IMAP_HOST', 'EMAIL_IMAP_PORT', 'EMAIL_USER', 'EMAIL_PASSWORD', 'EMAIL_OWNER_ADDRESSES', 'EMAIL_CHECK_SECONDS']

// The reader's settings, from the environment the bridge gives it, which the bridge has checked
// already (`src/common/settings.mjs`): `{ home, host, port, user, password, ownerAddresses,
// checkSeconds }`. Throws an error that names what is wrong, and never repeats a value.
export function readerConfig(env) {
  const problems = []
  const need = name => {
    const value = env[name]
    if (typeof value !== 'string' || value === '') problems.push(`${name} is missing`)
    return value
  }
  const whole = (name, fallback, [lowest, highest]) => {
    const value = env[name] ?? String(fallback)
    const number = /^\d+$/.test(value) ? Number(value) : NaN
    if (!(number >= lowest && number <= highest)) problems.push(`${name} must be a whole number from ${lowest} to ${highest}`)
    return number
  }
  const config = {
    home: need('HOME'),
    host: need('EMAIL_IMAP_HOST'),
    port: whole('EMAIL_IMAP_PORT', 993, limits.SETTING_RANGES.EMAIL_IMAP_PORT),
    user: need('EMAIL_USER'),
    password: need('EMAIL_PASSWORD'),
    ownerAddresses: (need('EMAIL_OWNER_ADDRESSES') ?? '').split(',').map(address => address.trim().toLowerCase()).filter(Boolean),
    checkSeconds: whole('EMAIL_CHECK_SECONDS', 60, limits.SETTING_RANGES.EMAIL_CHECK_SECONDS),
  }
  if (typeof config.home === 'string' && config.home !== '' && !path.isAbsolute(config.home)) problems.push('HOME must be an absolute path')
  if (config.ownerAddresses.length === 0 && !problems.some(problem => problem.startsWith('EMAIL_OWNER_ADDRESSES'))) problems.push('EMAIL_OWNER_ADDRESSES is empty')
  if (problems.length > 0) throw new Error(problems.join('; '))
  return config
}

// The UTC midnight of the day before the time `iso`, for IMAP's `SINCE`, which takes a date.
function dayBefore(iso) {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  return day
}

// Reads the mailbox until `signal` aborts, or until something goes wrong with the mailbox, when it
// rejects. Options:
// - `config`: what `readerConfig` returns.
// - `openMailbox(config)`: connects, and resolves with a mailbox (`imap.mjs`).
// - `clock`, `log`, `signal`.
export async function runReader({ config, openMailbox, clock = systemClock, log, signal = new AbortController().signal }) {
  const spool = openSpool(config.home)
  const ids = createIds(clock)
  const read = readPosition(config.home)
  if (read.damaged) log.warn('mail.position_unreadable', { note: 'starting from the mailbox\'s UIDNEXT' })
  let position = read.position ?? { uidValidity: null, next: null, newest: null, parsing: null, connected: false, checkedAt: null }
  const save = changes => {
    position = { ...position, ...changes }
    writePosition(config.home, position)
  }
  save({ connected: false })

  const mailbox = await openMailbox(config)
  try {
    const box = await mailbox.open()
    save({ connected: true, checkedAt: isoSeconds(clock.now()) })
    log.info('mail.connected', { uidValidity: box.uidValidity, uidNext: box.uidNext })
    if (position.uidValidity === null) {
      save({ uidValidity: box.uidValidity, next: box.uidNext })
      log.info('mail.position_started', { uidValidity: box.uidValidity, next: box.uidNext })
    } else if (position.uidValidity !== box.uidValidity) {
      let next = box.uidNext
      if (position.newest !== null) {
        const uids = await mailbox.search({ since: dayBefore(position.newest) })
        if (uids.length > 0) next = uids.reduce((low, uid) => Math.min(low, uid))
      }
      log.warn('mail.uidvalidity_changed', { before: position.uidValidity, now: box.uidValidity, next })
      // A message being parsed is named by a UID of the numbering before.
      save({ uidValidity: box.uidValidity, next, parsing: null })
    }

    for (;;) {
      await check(mailbox)
      if (signal.aborted) break
      save({ checkedAt: isoSeconds(clock.now()) })
      // IDLE, and a look at least every `EMAIL_CHECK_SECONDS` in case IDLE misses something.
      const waiting = new AbortController()
      const stop = () => waiting.abort()
      signal.addEventListener('abort', stop, { once: true })
      try {
        await Promise.race([mailbox.news({ signal: waiting.signal }), clock.sleep(config.checkSeconds * 1000, { signal: waiting.signal })])
      } catch (error) {
        if (!signal.aborted) throw error
      } finally {
        signal.removeEventListener('abort', stop)
        waiting.abort()
      }
      if (signal.aborted) break
    }
  } finally {
    try {
      save({ connected: false })
    } catch (error) {
      log.error('mail.position_not_saved', errorFields(error))
    }
    await mailbox.close().catch(() => {})
  }
  log.info('mail.stopped')

  // Hands over every message from `next` on, in UID order.
  async function check(mailbox) {
    const fresh = (await mailbox.list(position.next)).filter(message => message.uid >= position.next)
    for (const message of fresh.sort((a, b) => a.uid - b.uid)) {
      if (signal.aborted) return
      await handOver(mailbox, message)
      const arrivedAt = message.arrivedAt ?? isoSeconds(clock.now())
      save({ next: message.uid + 1, newest: position.newest === null || arrivedAt > position.newest ? arrivedAt : position.newest, parsing: null })
    }
  }

  async function handOver(mailbox, { uid, size, arrivedAt }) {
    const header = await mailbox.header(uid)
    if (header === null) return log.warn('mail.gone', { uid })
    const whole = size !== null && size <= limits.ATTACHMENT_MAX_BYTES && mentionsOwner(header, config.ownerAddresses)
    const raw = whole ? await mailbox.source(uid) : header
    if (raw === null) return log.warn('mail.gone', { uid })

    const unparsed = { subject: '', text: '', attachments: [] }
    let description = {
      uid,
      uidValidity: position.uidValidity,
      arrivedAt: arrivedAt ?? isoSeconds(clock.now()),
      size: size ?? raw.length,
      fetched: whole ? 'whole' : 'headers',
      parsed: true,
      ...unparsed,
    }
    let parts = []
    if (!whole) {
      description.subject = firstChars(await parseSubject(header), limits.EMAIL_SUBJECT_MAX_CHARS + 1)
    } else if (position.parsing === uid) {
      // The reader ended while it parsed this message, the last time: killed, or out of memory.
      // Parsing it again could end it again, at every start, and hold up every email after it.
      log.warn('mail.parse_failed', { uid, reason: 'the reader ended while parsing it' })
      description = { ...description, parsed: false }
    } else {
      // Set only while postal-mime runs, so that what ends the reader then is told from what ends
      // it later, such as a spool it can't write: that one is parsed again at the next start.
      save({ parsing: uid })
      try {
        const email = await parseEmail(raw)
        description.subject = firstChars(email.subject, limits.EMAIL_SUBJECT_MAX_CHARS + 1)
        description.text = firstChars(email.text, limits.EMAIL_TEXT_MAX_CHARS + 1)
        description.attachments = email.attachments.map(({ name, mime, content }) => ({ name, mime, bytes: content.length }))
        parts = email.attachments.map(attachment => attachment.content)
      } catch (error) {
        log.warn('mail.parse_failed', { uid, ...errorFields(error) })
        description = { ...description, parsed: false }
      }
      save({ parsing: null })
      // So many attachments, or names so long, that the bridge wouldn't read the description.
      if (Buffer.byteLength(JSON.stringify(description)) > limits.EMAIL_PARSED_MAX_BYTES) {
        log.warn('mail.parse_failed', { uid, reason: 'too much to describe', attachments: parts.length })
        description = { ...description, parsed: false, ...unparsed }
        parts = []
      }
    }
    const folder = await writeSpoolFolder(spool, ids, { raw, description, parts })
    log.info('mail.handed_over', { uid, folder, fetched: description.fetched, parsed: description.parsed, attachments: parts.length, bytes: raw.length })
  }
}

// The newest `count` messages' header blocks, for `email-check`: `[{ uid, arrivedAt, size,
// header }]`, oldest first. Stores nothing.
export async function listNewest({ config, openMailbox, count = limits.EMAIL_CHECK_COUNT }) {
  const mailbox = await openMailbox(config)
  try {
    await mailbox.open()
    const found = []
    for (const { uid, size, arrivedAt } of await mailbox.newest(count)) {
      const header = await mailbox.header(uid)
      if (header !== null) found.push({ uid, arrivedAt, size, header: header.subarray(0, limits.EMAIL_HEADER_MAX_BYTES) })
    }
    return found
  } finally {
    await mailbox.close().catch(() => {})
  }
}

// `node reader.mjs run` or `node reader.mjs newest`. Returns the exit code: 0, 1 when something
// went wrong with the mailbox, and 2 when it was started wrongly.
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, openMailbox = openImapMailbox, log = createLog({ component: 'mail' }) } = {}) {
  const mode = argv[0]
  if (mode !== 'run' && mode !== 'newest') {
    stderr.write('usage: reader.mjs run | newest\n')
    return 2
  }
  let config
  try {
    config = readerConfig(env)
  } catch (error) {
    stderr.write(`email reader: ${error.message}\n`)
    return 2
  }
  if (mode === 'newest') {
    try {
      for (const found of await listNewest({ config, openMailbox })) {
        stdout.write(`${JSON.stringify({ ...found, header: found.header.toString('base64') })}\n`)
      }
      return 0
    } catch (error) {
      log.error('mail.failed', errorFields(error))
      return 1
    }
  }
  const stopping = new AbortController()
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => stopping.abort())
  try {
    await runReader({ config, openMailbox, log, signal: stopping.signal })
    return 0
  } catch (error) {
    if (stopping.signal.aborted) return 0
    log.error('mail.failed', errorFields(error))
    return 1
  }
}

function startedDirectly() {
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (startedDirectly()) {
  // What imapflow leaves behind, such as a timer, mustn't keep a reader that is done from exiting.
  process.exit(await main(process.argv.slice(2)))
}
