// The email channel.
//
// This is the only module that runs the email reader, `src/mail/reader.mjs`, a program of its own
// that reads the mailbox as `scooter-mail` and hands each email over as a folder in its spool. The
// module:
// - runs the reader as `scooter-mail`, with the mailbox's settings and nothing else of the bridge's
//   in its environment, and starts it again with backoff whenever it exits;
// - takes the spool's folders in order, every `POLL_INTERVAL`, as untrusted: the spool must be the
//   reader's folder and not a link, `parsed.json` must be valid and within its size limit, every
//   file is read without following a link and only if it is the reader's, and the bridge names the
//   stored files itself. What isn't the reader's, or isn't a folder, is left where it is, and a
//   folder the bridge is done with is removed by the names the reader writes in one;
// - keeps an email whose files it can't copy, for a reason of its own such as a full disk, in the
//   spool, whole, and tries it again after waits that grow;
// - applies the sender check, Scooter's own code reading the raw headers: exactly one `From`,
//   holding a single one of the owner's addresses, and a topmost `Authentication-Results` that
//   names the mailbox's provider and says `dmarc=pass`. Anything ambiguous is skipped;
// - hands the email to the core as a record, which intake writes as the datastore line, with the
//   whole message as `<seq>.eml` first and the attachments after it; or logs the skip, with the
//   sender, the reason and the UID, never the subject or what it says, and counts it for its status;
// - runs `scooter email-check`.
//
// Email only comes in: the channel can't send or react, and replies about an email go to
// `DEFAULT_CHANNEL`. An email is never an edit, a deletion or a reaction.
//
// The spool's format is `src/mail/spool.mjs`'s, which this module can't import:
// its names are repeated here, and a test hands over through the real reader.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkOwnFolder, copyUntrustedFile, ensureDir, listHandOffs, readUntrustedFile, readUntrustedStart, removeHandOff } from '../../common/files.mjs'
import { limits } from '../../common/limits.mjs'
import { createLog, errorFields } from '../../common/log.mjs'
import { makePaths } from '../../common/paths.mjs'
import { createProc } from '../../common/proc.mjs'
import { isoSeconds, parseIsoSeconds, shortLocalTime, systemClock } from '../../common/time.mjs'
import { MEDIA_ERRORS } from '../intake.mjs'

// The email reader, run with Node: `node --disable-sigusr1 <READER> run`. Without the flag, Node
// answers SIGUSR1 by opening its debugger on 127.0.0.1:9229, where any local user could run code
// as `scooter-mail`, which holds the mailbox's password. The signal is the bridge's, to back up
// now, and a signal to the whole service, as `systemctl kill` sends by default, reaches the
// reader too. With the flag, Node ignores it from the moment it starts.
const READER = fileURLToPath(new URL('../../mail/reader.mjs', import.meta.url))
export const DEFAULT_READER = { program: process.execPath, args: ['--disable-sigusr1', READER] }

// The spool folder's files (`src/mail/spool.mjs`).
const MESSAGE_FILE = 'message.eml'
const PARSED_FILE = 'parsed.json'
const PART_PREFIX = 'part-'
// The names the reader writes in a spool folder: the only ones the bridge removes (`removeHandOff`).
const isSpoolFile = name => name === MESSAGE_FILE || name === PARSED_FILE || /^part-[1-9][0-9]*$/.test(name)

// What a too-long email's text ends with, after its first `EMAIL_TEXT_MAX_CHARS` characters, and a
// too-long subject after its first `EMAIL_SUBJECT_MAX_CHARS`.
export const TEXT_CUT_NOTE = '\n\n[The rest of this email was too long to keep here. The whole email is in its .eml file.]'
export const SUBJECT_CUT_NOTE = ' […]'

// The longest address, by RFC 5321, and the longest message ID, by RFC 5322's line limit. Facts of
// the formats, not choices of Scooter's.
const ADDRESS_MAX = 254
const MESSAGE_ID_MAX = 995

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

// The length of a text in characters, a character being a Unicode code point, and its first `max`.
function chars(text) {
  let count = 0
  for (const _ of text) count += 1
  return count
}
function firstChars(text, max) {
  let count = 0
  let end = 0
  for (const char of text) {
    if (count === max) break
    count += 1
    end += char.length
  }
  return text.slice(0, end)
}

// ---------------------------------------------------------------------------------------------
// The reader's environment

// Everything the reader is given: its home, UTC, a plain `PATH` and `LANG`, and the mailbox's
// settings. Nothing else of the bridge's: not its other secrets, nor `EMAIL_AUTHSERV_ID`, which
// only the sender check reads. The password is here and never on the reader's command line.
export function readerEnv(settings, paths) {
  const { email } = settings
  return {
    HOME: paths.mail,
    TZ: 'UTC',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    EMAIL_IMAP_HOST: email.host,
    EMAIL_IMAP_PORT: String(email.port),
    EMAIL_USER: email.user,
    EMAIL_PASSWORD: email.password,
    EMAIL_OWNER_ADDRESSES: email.ownerAddresses.join(','),
    EMAIL_CHECK_SECONDS: String(email.checkSeconds),
  }
}

// ---------------------------------------------------------------------------------------------
// The raw headers

// The header block of a message, from its first bytes: the lines before the first empty one,
// unfolded, as `{ name, value }` with the name in lower case and the value as written. Null when
// the block doesn't end within the bytes given, or when a line is neither a header nor a
// continuation of one: what can't be read for sure isn't read at all.
export function readHeaderBlock(bytes) {
  const text = bytes.toString('utf8')
  const end = text.search(/\r?\n\r?\n/)
  if (end === -1) return null
  const lines = []
  for (const line of text.slice(0, end).split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (lines.length === 0) return null
      lines.at(-1).value += line
      continue
    }
    // A name is printable ASCII without a colon (RFC 5322).
    const match = /^([!-9;-~]+):(.*)$/.exec(line)
    if (!match) return null
    lines.push({ name: match[1].toLowerCase(), value: match[2] })
  }
  return lines
}

// Walks a structured header value, as RFC 5322 has it: a quoted string, from `"` to the `"` that
// isn't escaped by `\`, and a comment, from `(` to its matching `)`, which comments may nest in. Calls
// `each(kind, text)` for each piece, `kind` being `quoted`, `comment` or `text`. Returns false when
// a quoted string or a comment doesn't end.
function walkValue(value, each) {
  let i = 0
  let text = ''
  const flush = () => {
    if (text !== '') each('text', text)
    text = ''
  }
  while (i < value.length) {
    const char = value[i]
    if (char === '"') {
      flush()
      let j = i + 1
      while (j < value.length && value[j] !== '"') j += value[j] === '\\' ? 2 : 1
      if (j >= value.length) return false
      each('quoted', value.slice(i, j + 1))
      i = j + 1
    } else if (char === '(') {
      flush()
      let depth = 0
      let j = i
      for (; j < value.length; j++) {
        if (value[j] === '\\') j++
        else if (value[j] === '(') depth++
        else if (value[j] === ')' && --depth === 0) break
      }
      if (j >= value.length) return false
      each('comment', value.slice(i, j + 1))
      i = j + 1
    } else {
      text += char
      i += 1
    }
  }
  flush()
  return true
}

// The one address a `From` header holds, in lower case: `{ address }`, or `{ problem }` when it
// holds none, several, a group, or something that can't be read. A display name, quoted or not, and
// comments are passed over; with an address in `<…>`, nothing but them may stand before it, and
// nothing but spaces and comments after it.
export function fromAddress(value) {
  const angles = []
  let outside = ''
  let after = ''
  let problem = null
  const ok = walkValue(value, (kind, text) => {
    if (kind === 'comment') return
    if (kind === 'quoted') {
      if (angles.length > 0) after += text
      else outside += ' '
      return
    }
    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      if (char === '<') {
        const close = text.indexOf('>', i + 1)
        if (close === -1) problem ??= 'its From header can\'t be read'
        else {
          angles.push(text.slice(i + 1, close))
          i = close
        }
      } else if (char === ',') problem ??= 'its From header holds several addresses'
      else if (char === ':' || char === ';') problem ??= 'its From header holds a group'
      else if (char === '>') problem ??= 'its From header can\'t be read'
      else if (angles.length > 0) after += char
      else outside += char
    }
  })
  if (!ok) return { problem: 'its From header can\'t be read' }
  if (problem) return { problem }
  if (angles.length > 1) return { problem: 'its From header holds several addresses' }
  const address = (angles.length === 1 ? angles[0] : outside).trim()
  if (angles.length === 1 && after.trim() !== '') return { problem: 'its From header can\'t be read' }
  if (address === '' || /\s/.test(address) || !address.includes('@')) return { problem: 'its From header holds no address' }
  return { address: address.toLowerCase() }
}

// An `Authentication-Results` header (RFC 8601): `{ authserv, results }`, the server that wrote it,
// which is the first token, and each result as `{ method, result }` in lower case. Comments are no
// part of it, so `dmarc=pass` inside one is not a result. Null when it can't be read.
export function readAuthResults(value) {
  const parts = ['']
  const ok = walkValue(value, (kind, text) => {
    if (kind === 'comment') parts[parts.length - 1] += ' '
    else if (kind === 'quoted') parts[parts.length - 1] += text
    else {
      const [first, ...rest] = text.split(';')
      parts[parts.length - 1] += first
      parts.push(...rest)
    }
  })
  if (!ok) return null
  const authserv = parts[0].trim().split(/\s+/)[0]
  if (!authserv) return null
  const results = []
  for (const part of parts.slice(1)) {
    const match = /^\s*([A-Za-z0-9_.-]+)(?:\/\d+)?\s*=\s*([A-Za-z0-9_.-]+)/.exec(part)
    if (match) results.push({ method: match[1].toLowerCase(), result: match[2].toLowerCase() })
  }
  return { authserv, results }
}

// The sender check. `lines` is what `readHeaderBlock` gives. Returns `{ ok, reason, sender,
// authserv }`: whether the email is kept, and if not why, the address in `From` when there is one,
// and the server named in the topmost `Authentication-Results` when there is one.
//
// - exactly one `From` header, holding a single address, one of `ownerAddresses` without regard
//   to case;
// - its topmost `Authentication-Results` header, the first after unfolding, which the mailbox's
//   provider adds when the mail arrives, names `authservId` as its first token, and holds exactly
//   one `dmarc` result, `pass`.
//
// Anyone can write the owner's address in `From`; the DMARC result says whether the owner's own
// provider sent it. A header someone wrote below the provider's is never read.
export function senderCheck(lines, { ownerAddresses, authservId }) {
  let sender = null
  let authserv = null
  const done = reason => ({ ok: reason === null, reason, sender, authserv })
  if (lines === null) return done('its header block can\'t be read')

  const froms = lines.filter(line => line.name === 'from')
  if (froms.length === 0) return done('it has no From header')
  if (froms.length > 1) return done('it has several From headers')
  const from = fromAddress(froms[0].value)
  if (from.address) sender = firstChars(from.address, ADDRESS_MAX)
  const results = lines.find(line => line.name === 'authentication-results')
  const read = results ? readAuthResults(results.value) : null
  if (read) authserv = firstChars(read.authserv, ADDRESS_MAX)

  if (from.problem) return done(from.problem)
  if (!ownerAddresses.includes(from.address)) return done('From isn\'t one of the owner\'s addresses')
  if (!results) return done('it has no Authentication-Results header')
  if (!read) return done('its topmost Authentication-Results can\'t be read')
  if (!authservId) return done('EMAIL_AUTHSERV_ID isn\'t set')
  if (read.authserv.toLowerCase() !== authservId.toLowerCase()) return done('its topmost Authentication-Results is another server\'s')
  const dmarc = read.results.filter(result => result.method === 'dmarc')
  if (dmarc.length === 0) return done('it has no DMARC result')
  if (dmarc.length > 1) return done('it has several DMARC results')
  if (dmarc[0].result !== 'pass') return done(`dmarc=${firstChars(dmarc[0].result, 20)}`)
  return done(null)
}

// The `Message-ID` without its angle brackets, or null when there isn't exactly one that reads
// as `<…>`.
export function messageIdOf(lines) {
  const ids = lines.filter(line => line.name === 'message-id')
  if (ids.length !== 1) return null
  const match = /^\s*<([\x21-\x3b\x3d\x3f-\x7e]+)>\s*$/.exec(ids[0].value)
  return match && match[1].length <= MESSAGE_ID_MAX ? match[1] : null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// The zones RFC 5322 names, besides `+hhmm` and `-hhmm`, in minutes east of UTC.
const ZONES = { ut: 0, gmt: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 }

// When the `Date` header says it was sent, as a UTC time to the second, or null when there isn't
// exactly one, or it isn't a date of RFC 5322's form with its zone: `Mon, 9 Nov 2026 21:12:28
// +0530`. Read without the process's time zone, which a date without a zone would depend on.
export function dateOf(lines) {
  const dates = lines.filter(line => line.name === 'date')
  if (dates.length !== 1) return null
  const text = dates[0].value.replace(/\([^()]*\)/g, ' ').trim()
  const match = /^(?:[A-Za-z]{3}\s*,\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|[A-Za-z]{1,3})$/.exec(text)
  if (!match) return null
  const [, day, monthName, year, hour, minute, second = '0', zone] = match
  const month = MONTHS.indexOf(monthName.toLowerCase())
  const offset = /^[+-]/.test(zone) ? (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) : ZONES[zone.toLowerCase()]
  if (month === -1 || offset === undefined || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return null
  const local = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Math.min(Number(second), 59))
  // A day the month doesn't have, such as 31 Feb, isn't a date.
  if (new Date(local).getUTCDate() !== Number(day)) return null
  const iso = isoSeconds(local - offset * 60_000)
  return parseIsoSeconds(iso) === null ? null : iso
}

// ---------------------------------------------------------------------------------------------
// `parsed.json` (`src/mail/spool.mjs`)

// What an attachment's MIME type must look like (RFC 6838), as the reader writes it.
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/
const PARSED_FIELDS = ['uid', 'uidValidity', 'arrivedAt', 'size', 'fetched', 'parsed', 'subject', 'text', 'attachments']

const isUid = value => Number.isSafeInteger(value) && value > 0
const isCount = value => Number.isSafeInteger(value) && value >= 0

function checkAttachment(attachment) {
  if (!isObject(attachment)) return false
  const { name, mime, bytes, ...rest } = attachment
  return (
    Object.keys(rest).length === 0 &&
    (name === null || (typeof name === 'string' && name !== '' && chars(name) <= limits.ATTACHMENT_NAME_MAX_CHARS)) &&
    typeof mime === 'string' &&
    MIME_TYPE.test(mime) &&
    isCount(bytes)
  )
}

// What is wrong with the contents of a `parsed.json`, as short statements that name fields and
// never repeat their values. An empty list means the bridge can take it.
export function checkParsed(value) {
  if (!isObject(value)) return ['not an object']
  const problems = []
  for (const field of Object.keys(value)) {
    if (!PARSED_FIELDS.includes(field)) problems.push(`unknown field ${field}`)
  }
  const check = (field, ok, what) => {
    if (!ok(value[field])) problems.push(`${field} must be ${what}`)
  }
  check('uid', isUid, 'a UID')
  check('uidValidity', isUid, 'a UIDVALIDITY')
  check('arrivedAt', at => parseIsoSeconds(at) !== null, 'a UTC time to the second')
  check('size', isCount, 'a size in bytes')
  check('fetched', fetched => fetched === 'whole' || fetched === 'headers', 'whole or headers')
  check('parsed', parsed => typeof parsed === 'boolean', 'true or false')
  check('subject', subject => typeof subject === 'string' && chars(subject) <= limits.EMAIL_SUBJECT_MAX_CHARS + 1, `a text of at most ${limits.EMAIL_SUBJECT_MAX_CHARS + 1} characters`)
  check('text', text => typeof text === 'string' && chars(text) <= limits.EMAIL_TEXT_MAX_CHARS + 1, `a text of at most ${limits.EMAIL_TEXT_MAX_CHARS + 1} characters`)
  check('attachments', list => Array.isArray(list) && list.every(checkAttachment), 'a list of { name, mime, bytes }')
  if (problems.length > 0) return problems
  if (value.fetched === 'headers' && (value.text !== '' || value.attachments.length > 0)) problems.push('an email fetched without its body has no text or attachments')
  if (!value.parsed && (value.subject !== '' || value.text !== '' || value.attachments.length > 0)) problems.push('an email that couldn\'t be parsed has no subject, text or attachments')
  return problems
}

// ---------------------------------------------------------------------------------------------
// The record

// The kind of media an attachment is, for the `media` object of one that couldn't be stored.
function kindOf(mime) {
  const type = mime.split('/')[0]
  return ['image', 'audio', 'video'].includes(type) ? type : 'document'
}

// The record of an email that passed the sender check, from its `parsed.json`, its header
// block, and the size of its `message.eml`. Its first attachment is the whole message, which the
// store names `<seq>.eml`; then come its attachments, as `part-1`, `part-2`… in the spool.
// - `id` is the `Message-ID` without its angle brackets, or `imap-<UIDVALIDITY>-<UID>`.
// - `at` is the `Date` header's, or the time it arrived when that can't be read.
// - The text is cut at `EMAIL_TEXT_MAX_CHARS`, and the subject at `EMAIL_SUBJECT_MAX_CHARS`, each
//   with a note that says so.
// - An email that couldn't be parsed keeps its `.eml`, and a `media` object says so. One fetched
//   without its body, which the reader does only for one over `ATTACHMENT_MAX_BYTES`, has none.
export function emailRecord({ parsed, lines, size }) {
  const whole = { type: 'email', mime: 'message/rfc822', name: null, bytes: size, error: null }
  let attachments
  if (parsed.fetched === 'headers') attachments = [{ ...whole, bytes: parsed.size, error: MEDIA_ERRORS.tooLarge }]
  else if (!parsed.parsed) attachments = [whole, { type: 'email', mime: null, name: null, bytes: null, error: MEDIA_ERRORS.notParsed }]
  else attachments = [whole, ...parsed.attachments.map(({ name, mime, bytes }) => ({ type: kindOf(mime), mime, name, bytes, error: null }))]
  const cut = (text, max, note) => (chars(text) > max ? `${firstChars(text, max)}${note}` : text)
  return {
    source: 'email',
    id: messageIdOf(lines) ?? `imap-${parsed.uidValidity}-${parsed.uid}`,
    at: dateOf(lines) ?? parsed.arrivedAt,
    text: cut(parsed.text, limits.EMAIL_TEXT_MAX_CHARS, TEXT_CUT_NOTE),
    subject: cut(parsed.subject, limits.EMAIL_SUBJECT_MAX_CHARS, SUBJECT_CUT_NOTE),
    attachments,
    replyToId: null,
    replyToPreview: null,
    reactionToId: null,
    reactionEmoji: null,
    edited: false,
    revoked: false,
    forwarded: false,
  }
}

// ---------------------------------------------------------------------------------------------
// The channel

// Returns the email channel. Options:
// - `settings`: the bridge's settings; `settings.email` is used here, and `timeZone` for its status.
// - `paths`: what `makePaths` returns. `paths.mail` is the reader's home, and its spool is in it.
// - `proc`: what `createProc` returns. The reader runs through it.
// - `user`: `{ uid, gid }` of `scooter-mail`, or null when the bridge isn't root.
// - `reader`: the program, and the arguments before `run`, that are the reader. Tests give a stub.
export function createEmail({ settings, paths, proc, log, clock = systemClock, user = null, reader = DEFAULT_READER }) {
  const config = settings.email
  const env = readerEnv(settings, paths)
  // The spool folder of each record handed over, for its downloads.
  const folders = new WeakMap()
  // When each email stored and skipped was taken, over the last `STATUS_WINDOW`, for its status.
  const stored = []
  const skipped = []
  const startedAt = clock.now()
  // `stopped`, `running`, or `restarting` (the reader exited and waits to start again).
  let link = 'stopped'
  let running = null
  let retryAt = -Infinity
  let failures = 0
  let round = Promise.resolve()
  // What the bridge left in the spool, by name, so it is logged once: what isn't the reader's, isn't
  // a folder, or couldn't be removed.
  const left = new Set()

  const prune = list => {
    const from = clock.now() - limits.STATUS_WINDOW
    while (list.length > 0 && list[0] < from) list.shift()
  }
  // Counts an email for its status. Those past the window go then too, so a mailbox strangers write
  // to keeps a day of times at most, whatever reads the status.
  const count = list => {
    list.push(clock.now())
    prune(list)
  }

  // Removes a spool folder the bridge is done with, by the names the reader writes in one, and
  // never anything else (`removeHandOff`). One that holds anything else, or has been made something
  // else meanwhile, is left, and logged once.
  function remove(id) {
    try {
      removeHandOff(path.join(paths.mailSpool, id), isSpoolFile)
    } catch (error) {
      log.warn('email.not_removed', { folder: id, ...errorFields(error) })
      left.add(id)
    }
  }

  // Takes one spool folder. Returns `next` when it is done with, `retry` when it must be tried
  // again later, and `stop` when the store has stopped and the bridge with it.
  async function take(id, onRecord) {
    const dir = path.join(paths.mailSpool, id)
    const refuse = reason => {
      log.warn('email.refused', { folder: id, reason })
      remove(id)
      return 'next'
    }
    // What isn't the reader's, or isn't a folder, is left where it is: the bridge, as root, removes
    // only what the reader can, and only by the names it writes. A well-behaved reader leaves
    // nothing else.
    const leave = reason => {
      log.warn('email.refused', { folder: id, reason, left: true })
      left.add(id)
      return 'next'
    }
    let stat
    try {
      stat = fs.lstatSync(dir)
    } catch (error) {
      return leave(`it can't be opened (${error.code})`)
    }
    if (user && stat.uid !== user.uid) return leave('it is not the email reader\'s')
    if (!stat.isDirectory()) return leave('it is not a folder')

    let parsed
    try {
      parsed = JSON.parse(readUntrustedFile(path.join(dir, PARSED_FILE), { maxBytes: limits.EMAIL_PARSED_MAX_BYTES, owner: user }))
    } catch (error) {
      return refuse(error instanceof SyntaxError ? `${PARSED_FILE} is not JSON` : `${PARSED_FILE} can't be read (${error.code ?? error.name})`)
    }
    const problems = checkParsed(parsed)
    if (problems.length > 0) return refuse(`${PARSED_FILE}: ${problems.join('; ')}`)
    let head
    try {
      head = readUntrustedStart(path.join(dir, MESSAGE_FILE), { maxBytes: limits.EMAIL_HEADER_MAX_BYTES, owner: user })
    } catch (error) {
      return refuse(`${MESSAGE_FILE} can't be read (${error.code ?? error.name})`)
    }

    const lines = readHeaderBlock(head.bytes)
    const check = senderCheck(lines, config)
    if (!check.ok) {
      count(skipped)
      log.info('email.skipped', { uid: parsed.uid, sender: check.sender, reason: check.reason })
      remove(id)
      return 'next'
    }
    const record = emailRecord({ parsed, lines, size: head.size })
    folders.set(record, dir)
    const result = await onRecord(record)
    if (result?.reason === 'the store stopped') return 'stop'
    // Intake stored nothing of it, for a reason of the bridge's own, such as a full disk: the
    // folder stays, whole, and is tried again.
    if (result?.reason === 'failed') return 'retry'
    if (result?.stored) {
      count(stored)
      log.info('email.stored', { uid: parsed.uid, seq: result.seq })
    }
    remove(id)
    return 'next'
  }

  // The wait after the `n`th failure in a row.
  function backoff(n) {
    const { first, factor, max } = limits.SPOOL_RETRY_BACKOFF
    return Math.min(first * factor ** Math.max(0, n - 1), max)
  }

  // One look at the spool: the folders in order, until one has to wait. Returns `stop` when the
  // store has stopped.
  async function look(onRecord, signal) {
    if (clock.now() < retryAt) return null
    try {
      // The reader owns the folder above the spool, and could put a link in its place: then
      // nothing is taken, and the look is tried again after waits that grow.
      try {
        checkOwnFolder(paths.mailSpool, user)
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
      const ids = listHandOffs(paths.mailSpool)
      const listed = new Set(ids)
      for (const id of left) if (!listed.has(id)) left.delete(id)
      for (const id of ids) {
        if (signal.aborted) return null
        if (left.has(id)) continue
        const outcome = await take(id, onRecord)
        if (outcome === 'stop') return 'stop'
        if (outcome === 'retry') throw Object.assign(new Error('the email could not be stored'), { code: 'ERETRY' })
      }
      failures = 0
    } catch (error) {
      // The disk, or a bug. The folder stays, and is tried again after a wait that grows.
      failures += 1
      retryAt = clock.now() + backoff(failures)
      log.error('email.spool_failed', { failures, ...errorFields(error) })
    }
    return null
  }

  async function consume(onRecord, signal) {
    for (;;) {
      round = look(onRecord, signal)
      if ((await round) === 'stop') return
      try {
        await clock.sleep(limits.POLL_INTERVAL, { signal })
      } catch {
        return
      }
    }
  }

  // What the reader last wrote about the mailbox, or null when that can't be read.
  function readerState() {
    try {
      const value = JSON.parse(readUntrustedFile(paths.mailState, { maxBytes: limits.STATUS_FILE_MAX_BYTES, owner: user }))
      if (!isObject(value) || typeof value.connected !== 'boolean') return null
      return { connected: value.connected, checkedAt: parseIsoSeconds(value.checkedAt) }
    } catch {
      return null
    }
  }

  return {
    name: 'email',
    // An email stays in the spool until it is stored, with its files, or skipped.
    keepsUntilStored: true,
    canSend: false,
    canReact: false,

    // Starts the reader, and the spool's consumer.
    async start(onRecord) {
      if (running) throw new Error('the email channel is already started')
      // The reader reads and writes only its own folder. A native install makes it in
      // `setup`; here it is made if it's missing, as in development.
      for (const dir of [paths.mail, paths.mailSpool]) ensureDir(dir, { mode: 0o700, owner: user })
      const supervisor = proc.supervise(reader.program, [...reader.args, 'run'], {
        env,
        user,
        cwd: paths.mail,
        // The reader's log lines, on its stderr, join the bridge's. They are Scooter's own, and
        // carry no content.
        stdio: ['ignore', 'ignore', 'inherit'],
        onStart: () => {
          link = 'running'
        },
        onExit: () => {
          link = 'restarting'
        },
      })
      const stopping = new AbortController()
      const consuming = consume(onRecord, stopping.signal)
      running = { supervisor, stopping, consuming }
      log.info('email.started')
    },

    // Stops the reader and the consumer. Resolves once both have stopped, and the email the
    // consumer was handing over has been taken.
    async stop() {
      if (!running) return
      const { supervisor, stopping, consuming } = running
      running = null
      stopping.abort()
      await supervisor.stop()
      await consuming
      link = 'stopped'
      log.info('email.stopped')
    },

    // Saves the record's `n`th attachment at `target`: the whole message for the first, then the
    // parts, copied out of the spool with care, since the reader owns it. A file in the spool that
    // is missing (`ENOENT` on it), isn't one to copy, or is too large is the email's own; any other
    // failure is on the bridge's side, such as a full disk or a bridge out of file descriptors, and
    // says so (`bridgeSide`): the email then stays in the spool, and is tried again.
    async download(record, n, target) {
      const dir = folders.get(record)
      if (dir === undefined || !Number.isSafeInteger(n) || n < 1 || n > record.attachments.length) throw new Error('no such attachment')
      const source = path.join(dir, n === 1 ? MESSAGE_FILE : `${PART_PREFIX}${n - 1}`)
      try {
        await copyUntrustedFile(source, target, { owner: user, maxBytes: limits.ATTACHMENT_MAX_BYTES })
      } catch (error) {
        const emailsOwn = error.code === 'EUNTRUSTED' || error.code === 'EFBIG' || (error.code === 'ENOENT' && error.path === source)
        if (!emailsOwn) error.bridgeSide = true
        throw error
      }
    },

    // Resolves when the look at the spool in progress is over. For tests.
    idle: () => round,

    // Email never sends.
    ready: () => false,
    sendText: async () => {
      throw new Error('the email channel sends nothing')
    },
    react: async () => {
      throw new Error('the email channel sends nothing')
    },

    // One line for `scooter status`: whether the reader is connected, and the emails stored and
    // skipped in the last 24 hours, or since the bridge started when that is later.
    status() {
      const now = clock.now()
      prune(stored)
      prune(skipped)
      const zone = settings.timeZone
      const window = now - startedAt < limits.STATUS_WINDOW ? `since the bridge started, ${shortLocalTime(startedAt, now, zone)}` : 'in the last 24 hours'
      const counts = `${stored.length} stored and ${skipped.length} skipped ${window}`
      let state = 'stopped'
      if (link === 'restarting') state = 'the reader stopped, and starts again shortly'
      else if (link === 'running') {
        const read = readerState()
        if (read === null) state = 'the reader is starting'
        else if (!read.connected) state = 'connecting to the mailbox'
        else state = `connected${read.checkedAt === null ? '' : `, last checked ${shortLocalTime(read.checkedAt, now, zone)}`}`
      }
      return `Email: ${state}; ${counts}.`
    },
  }
}

// ---------------------------------------------------------------------------------------------
// `scooter email-check`

// Prints a value from a header as it is, or quoted when it holds a space or a control character.
const shown = value => (/^[^\s\p{C}"]+$/u.test(value) ? value : JSON.stringify(value))

// `scooter email-check`: runs the reader once, as `scooter-mail`, to list the mailbox's newest
// `EMAIL_CHECK_COUNT` messages, each with its `From`, the server named in its topmost
// `Authentication-Results`, and whether it would pass the sender check. Stores nothing. Works
// before `EMAIL_AUTHSERV_ID` is set, so the owner can find it. Exits with 2 when email is off, and
// with 1 when the reader couldn't read the mailbox.
export async function runEmailCheck({ settings, stdout, stderr, clock = systemClock, log = createLog({ component: 'bridge', clock }), proc = createProc({ log, clock }), reader = DEFAULT_READER }) {
  if (!settings.email) {
    stderr.write('scooter email-check: email is off; set EMAIL_IMAP_HOST and the other mailbox settings in bridge.env\n')
    return 2
  }
  const paths = makePaths(settings)
  const user = await proc.lookupUser('scooter-mail')
  const result = await proc.run(reader.program, [...reader.args, 'newest'], { env: readerEnv(settings, paths), user, cwd: '/', timeout: limits.EMAIL_CHECK_TIMEOUT })
  // The reader's log lines, which carry no content, say what went wrong.
  stderr.write(result.stderr)
  if (result.code !== 0) {
    stderr.write(`scooter email-check: the email reader couldn't read the mailbox (${result.timedOut ? 'timed out' : `exit code ${result.code}`})\n`)
    return 1
  }
  const found = []
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(value) || !isUid(value.uid) || typeof value.header !== 'string') continue
    found.push({ uid: value.uid, arrivedAt: parseIsoSeconds(value.arrivedAt), header: Buffer.from(value.header, 'base64') })
  }
  const now = clock.now()
  const out = [found.length === 0 ? 'The mailbox is empty.' : `The mailbox's newest ${found.length === 1 ? 'message' : `${found.length} messages`}, oldest first:`]
  for (const { uid, arrivedAt, header } of found) {
    const check = senderCheck(readHeaderBlock(header), settings.email)
    out.push('', `UID ${uid}${arrivedAt === null ? '' : `, arrived ${shortLocalTime(arrivedAt, now, settings.timeZone)}`}`)
    out.push(`  From: ${check.sender === null ? '(no single address)' : shown(check.sender)}`)
    out.push(`  Topmost Authentication-Results: ${check.authserv === null ? '(none that can be read)' : shown(check.authserv)}`)
    out.push(`  Kept: ${check.ok ? 'yes' : `no, ${check.reason}`}`)
  }
  if (!settings.email.authservId) {
    out.push('', 'EMAIL_AUTHSERV_ID isn\'t set. Send an email from your own address, run this again, and set it to the server named on its')
    out.push('Authentication-Results line, which is your mailbox\'s provider, such as mx.google.com.')
  }
  stdout.write(`${out.join('\n')}\n`)
  return 0
}
