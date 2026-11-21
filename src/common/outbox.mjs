// Outbox entries: what the runner, and the bridge itself, ask the bridge to send.
//
// Each entry is a folder `exchange/outbox/<id>/` holding `entry.json`. It is made as `.tmp-<id>/`
// and renamed once complete, so the bridge never sees half of one. IDs are the UTC time and a
// counter, so entries sort in the order they were made. Two processes write entries: if a name is
// taken when the folder is renamed, the entry takes the next ID (`handOff`).
//
//   {"type":"text","by":"lifelog","text":"Blue Tokai, ₹450 at 12:40: work or personal?","replyTo":1042}
//   {"type":"text","by":"runner","text":"Started a fresh conversation.","about":1060}
//   {"type":"react","by":"lifelog","target":1044,"emoji":"✅"}
//
// There is no recipient: everything goes to the owner. Messages are named by `seq` only, and the
// bridge picks the channel from the line an entry points at.
//
// While the bridge sends an entry, it keeps a record of it: the entry, and how many of its messages
// have gone out:
//
//   {"entry":{"type":"text","by":"lifelog","text":"…","replyTo":1042},"sent":1}
//
// The bridge keeps that record in its own folder, never in the runner's outbox, which the runner's
// user controls: `bridge/sending/<id>.json` for an entry of the runner's. The bridge's own entries,
// its backup notices, are written to `bridge/outbox/` in the same form, and their record is
// `sending.json` in the entry's folder there.
//
// A text is at most `TEXT_MAX_CHARS` long. `writeOutboxEntry` cuts a longer one, with a line that
// says so, rather than refuse it: what the agent wrote is its own to make as long as it likes, and
// a refusal would stop the runner after a run that went well.

import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, handOff } from './files.mjs'
import { limits } from './limits.mjs'

export const ENTRY_FILE = 'entry.json'
export const SENDING_FILE = 'sending.json'
export const ENTRY_TYPES = ['text', 'react']

// What ends a text that was cut.
export const CUT_NOTE = '\n\n[The rest of this message was too long to send.]'

// The length of a text as `TEXT_MAX_CHARS` counts it: in characters, a character being a Unicode
// code point, so an emoji counts once and is never split in two.
export const textLength = text => {
  let count = 0
  for (const _ of text) count += 1
  return count
}

// `text` as it can be sent: U+0000 in it replaced by U+FFFD, since no program takes a command-line
// argument that holds one, and wacli takes a text as one; and, when it is longer than
// `TEXT_MAX_CHARS`, as much of it as fits before `CUT_NOTE`.
export function cutText(given) {
  const text = given.replaceAll('\0', '\ufffd')
  if (textLength(text) <= limits.TEXT_MAX_CHARS) return text
  const keep = limits.TEXT_MAX_CHARS - textLength(CUT_NOTE)
  let kept = ''
  let count = 0
  for (const char of text) {
    if (count === keep) break
    kept += char
    count += 1
  }
  return `${kept.trimEnd()}${CUT_NOTE}`
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isSeq = value => Number.isSafeInteger(value) && value >= 1
const isName = value => typeof value === 'string' && value !== ''

// The fields of each type of entry, in the order they are written.
const FIELDS = {
  text: ['type', 'by', 'text', 'replyTo', 'about'],
  react: ['type', 'by', 'target', 'emoji'],
}

// What is wrong with an entry, as a list of short statements that name fields and never repeat
// their values. An empty list means it is well formed.
//
// - `text`: `by`, a `text` that isn't empty, at most `TEXT_MAX_CHARS` long and without U+0000, and
//   at most one of `replyTo` (the message it answers, quoted) and `about` (the newest message it
//   answers, not quoted). With neither, it is something Scooter says on its own.
// - `react`: `by`, the `target` it reacts to, and an `emoji` that isn't empty, without U+0000.
//
// A text or an emoji with U+0000 in it could never be sent: it would be tried `SEND_ATTEMPTS`
// times, holding back the entries after it, so the bridge refuses it at once. `writeOutboxEntry`
// writes none.
export function checkOutboxEntry(entry) {
  if (!isObject(entry)) return ['not an object']
  if (!ENTRY_TYPES.includes(entry.type)) return [`type must be one of ${ENTRY_TYPES.join(', ')}`]
  const problems = []
  for (const field of Object.keys(entry)) {
    if (!FIELDS[entry.type].includes(field)) problems.push(`${field} doesn't belong on a ${entry.type} entry`)
  }
  const need = (field, ok, what) => {
    if (entry[field] === undefined) problems.push(`${field} is missing`)
    else if (!ok(entry[field])) problems.push(`${field} must be ${what}`)
  }
  const allow = (field, ok, what) => {
    if (entry[field] !== undefined && !ok(entry[field])) problems.push(`${field} must be ${what}`)
  }
  need('by', isName, "a string that isn't empty")
  if (entry.type === 'text') {
    need('text', value => typeof value === 'string' && value.trim() !== '', "a string that isn't empty")
    if (typeof entry.text === 'string' && textLength(entry.text) > limits.TEXT_MAX_CHARS) problems.push(`text must be at most ${limits.TEXT_MAX_CHARS} characters`)
    if (typeof entry.text === 'string' && entry.text.includes('\0')) problems.push("text can't hold U+0000")
    allow('replyTo', isSeq, 'a seq')
    allow('about', isSeq, 'a seq')
    if (entry.replyTo !== undefined && entry.about !== undefined) problems.push('replyTo and about can\'t both be given')
  } else {
    need('target', isSeq, 'a seq')
    need('emoji', isName, "a string that isn't empty")
    if (typeof entry.emoji === 'string' && entry.emoji.includes('\0')) problems.push("emoji can't hold U+0000")
  }
  return problems
}

// What is wrong with the contents of a `sending.json`: `{ entry, sent }`, where `entry` is an entry
// and `sent` how many of its messages have gone out, 0 or more.
export function checkSendingFile(value) {
  if (!isObject(value)) return ['not an object']
  const problems = []
  for (const field of Object.keys(value)) {
    if (field !== 'entry' && field !== 'sent') problems.push(`${field} doesn't belong in ${SENDING_FILE}`)
  }
  if (!Number.isSafeInteger(value.sent) || value.sent < 0) problems.push('sent must be a whole number, 0 or more')
  problems.push(...checkOutboxEntry(value.entry).map(problem => `entry: ${problem}`))
  return problems
}

// An entry with its fields in the order they are written.
export function orderedEntry(entry) {
  const ordered = {}
  for (const field of FIELDS[entry.type]) {
    if (entry[field] !== undefined) ordered[field] = entry[field]
  }
  return ordered
}

// Writes an entry into an outbox and returns its ID. `ids` is a generator from `createIds`
// (`files.mjs`), one per process. A text is made one that can be sent (`cutText`): U+0000 replaced,
// and cut at `TEXT_MAX_CHARS`. Throws if the entry isn't well formed.
//
// `outbox` is the runner's outbox, `paths.outbox`, unless given: the bridge gives its own,
// `paths.bridgeOutbox`, so that it writes nothing in a folder the runner's user controls.
// The folder is made, 0700, if it is missing, as in development. An installed Scooter makes the
// runner's in `setup`, owned by the runner's user.
export async function writeOutboxEntry({ paths, ids, entry: given, outbox = paths.outbox }) {
  const entry = given?.type === 'text' && typeof given.text === 'string' ? { ...given, text: cutText(given.text) } : given
  const problems = checkOutboxEntry(entry)
  if (problems.length > 0) throw new Error(`not an outbox entry: ${problems.join('; ')}`)
  const ordered = orderedEntry(entry)
  ensureDir(outbox, { mode: 0o700 })
  return handOff(outbox, ids, dir => {
    fs.writeFileSync(path.join(dir, ENTRY_FILE), `${JSON.stringify(ordered)}\n`, { mode: 0o600, flag: 'wx' })
  })
}
