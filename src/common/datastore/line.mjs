// The format of a datastore line.
//
// One JSON object per line of `log.jsonl`. The bridge writes them, and the runner and pi read
// them. A line is checked one way when it is written and another when it is read:
//
// - `checkLine` is the format in code, as the store writes it: what each field holds and when it's
//   there. The store writes only what passes it, and `encodeLine` refuses anything else.
// - `checkReadLine` is what every reader depends on, and all a reader checks: `seq`, `dir`, `at`,
//   that `kind` and `source` are names, and the type of each field this version's code acts on,
//   where the line has it. A field it doesn't know is ignored. `decodeLine` reads by it.
// - `isKnown` says whether a line that passed the reading check is one this version acts on: of a
//   kind and a channel it knows, with the fields its kind needs. A reader keeps any other line in
//   its index, and passes it over, as the runner passes over a line that isn't work.
//
// `data` is a JSON object that only the agent reads: what a channel keeps of a line that isn't on
// every channel's lines and that Scooter's code doesn't act on, such as an email's subject. The
// datastore doesn't look into it. A reader that takes something from it all the same checks it
// first (`dataText`, `dataFlag`).
//
// The rule from here on: stop writing a kind, a channel or a field, and keep reading it.

import { parseIsoSeconds } from '../time.mjs'

export const KINDS = ['message', 'edit', 'delete', 'reaction']
export const DIRECTIONS = ['in', 'out']
export const SOURCES = ['whatsapp', 'email']
export const TRUSTS = ['owner', 'external']

// The fields, in the order a line is written.
const FIELDS = ['seq', 'kind', 'dir', 'at', 'source', 'sourceId', 'trust', 'by', 'replyTo', 'target', 'text', 'files', 'media', 'data']

// The fields each kind of line needs, beyond those every line has, for this version to act on it.
const NEEDS = {
  message: ['text'],
  edit: ['target', 'text'],
  delete: ['target'],
  reaction: ['target'],
}

// Something is wrong with the datastore's contents or with a line about to be written. The message
// says where and what, and never quotes the line: an error's message ends up in logs.
export class DatastoreError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DatastoreError'
  }
}

const isSeq = value => Number.isSafeInteger(value) && value >= 1
const isString = value => typeof value === 'string'
const isText = value => isString(value) && value !== ''
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = value => parseIsoSeconds(value) !== null
// A kind or a channel: a lowercase letter, then lowercase letters, digits and hyphens.
const isName = value => isString(value) && /^[a-z][a-z0-9-]*$/.test(value)
// A file's name in the line's own day folder, never a path that leads elsewhere.
const isBareName = value => isText(value) && !value.includes('/') && !value.startsWith('.')

// Whether a value is what JSON can hold, and reads back as it was written: null, a boolean, a
// string, a finite number, or a list or a plain object of such values.
function isJson(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  const isList = Array.isArray(value)
  const proto = Object.getPrototypeOf(value)
  if (!isList && proto !== Object.prototype && proto !== null) return false
  seen.add(value)
  let ok = true
  if (isList) {
    for (let i = 0; ok && i < value.length; i++) ok = Object.hasOwn(value, i) && isJson(value[i], seen)
  } else {
    ok = Object.values(value).every(item => isJson(item, seen))
  }
  seen.delete(value)
  return ok
}

// Whether a value can be the `data` of a line or a record: an object of JSON values.
export const isData = value => isObject(value) && isJson(value)

function checkFile(file) {
  if (!isObject(file)) return false
  const { path, mime, name, bytes, ...rest } = file
  if (Object.keys(rest).length > 0) return false
  if (!isBareName(path) || !isText(mime)) return false
  if (name !== undefined && !isString(name)) return false
  return Number.isSafeInteger(bytes) && bytes >= 0
}

function checkMedia(media) {
  if (!isObject(media)) return false
  const { type, mime, error, ...rest } = media
  if (Object.keys(rest).length > 0) return false
  if (!isText(type)) return false
  if (mime !== undefined && !isString(mime)) return false
  return isText(error)
}

// Returns what is wrong with a line the store is to write, as a list of short statements that
// name fields and never repeat their values. An empty list means the line is well formed.
export function checkLine(line) {
  if (!isObject(line)) return ['not an object']
  const problems = []
  const has = field => line[field] !== undefined
  const need = (field, ok, what) => {
    if (!has(field)) problems.push(`${field} is missing`)
    else if (!ok(line[field])) problems.push(`${field} must be ${what}`)
  }
  const allow = (field, when, ok, what) => {
    if (!has(field)) return
    if (!when) problems.push(`${field} doesn't belong on this line`)
    else if (!ok(line[field])) problems.push(`${field} must be ${what}`)
  }

  for (const field of Object.keys(line)) {
    if (!FIELDS.includes(field)) problems.push(`unknown field ${field}`)
  }

  need('seq', isSeq, 'a whole number, 1 or more')
  need('kind', value => KINDS.includes(value), `one of ${KINDS.join(', ')}`)
  need('dir', value => DIRECTIONS.includes(value), `one of ${DIRECTIONS.join(', ')}`)
  need('at', isTime, 'a UTC time to the second, such as 2026-11-09T15:43:02Z')
  need('source', value => SOURCES.includes(value), `one of ${SOURCES.join(', ')}`)
  allow('sourceId', true, isText, 'a string that isn\'t empty')

  const { kind, dir } = line
  const isMessage = kind === 'message'
  const pointsAtAnother = ['edit', 'delete', 'reaction'].includes(kind)

  // Who it's from: `trust` on what came in, `by` on what Scooter sent.
  if (dir === 'in') need('trust', value => TRUSTS.includes(value), `one of ${TRUSTS.join(', ')}`)
  else allow('trust', false)
  if (dir === 'out') need('by', isText, 'a string that isn\'t empty')
  else allow('by', false)

  if (['message', 'edit'].includes(kind)) need('text', isString, 'a string')
  else allow('text', false)

  if (pointsAtAnother) need('target', isSeq, 'a seq')
  else allow('target', false)

  allow('files', isMessage, value => Array.isArray(value) && value.length > 0 && value.every(checkFile), 'a list of stored files')
  allow('media', isMessage, checkMedia, 'an object with type and error')
  allow('replyTo', isMessage, isSeq, 'a seq')
  // The channel's, on any line: written only when it holds something.
  allow('data', true, value => isData(value) && Object.keys(value).length > 0, 'an object of JSON values with something in it, or left out')

  // A line can only point at lines before it.
  for (const field of ['replyTo', 'target']) {
    if (isSeq(line[field]) && isSeq(line.seq) && line[field] >= line.seq) problems.push(`${field} must be a seq before this line's`)
  }
  return problems
}

// The types of the fields this version's code acts on, which the reading check holds a line to
// where it has them: `[check, what it must be]`. `data`, which only the agent reads, isn't among
// them, and neither is `trust`, which no code of this version reads.
const READ_TYPES = {
  sourceId: [isText, "a string that isn't empty"],
  by: [isText, "a string that isn't empty"],
  replyTo: [isSeq, 'a seq'],
  target: [isSeq, 'a seq'],
  text: [isString, 'a string'],
  // A file is read by its `path`, `mime` and `name`; what else it holds is passed over.
  files: [
    value =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(file => isObject(file) && isBareName(file.path) && isText(file.mime) && (file.name === undefined || isString(file.name))),
    'a list of stored files',
  ],
  media: [value => isObject(value) && isText(value.type) && isText(value.error) && (value.mime === undefined || isString(value.mime)), 'an object with type and error'],
}

// Returns what is wrong with a line as a reader takes it, as `checkLine` does. A reader checks only
// what every reader depends on: `seq`, `dir`, `at`, that `kind` and `source` are names, and the
// type of each field of `READ_TYPES`, where the line has it. A field this version doesn't know is
// ignored, and so is everything in `data`. That the `seq` is one more than the last is the index's
// to check.
export function checkReadLine(line) {
  if (!isObject(line)) return ['not an object']
  const problems = []
  const need = (field, ok, what) => {
    if (line[field] === undefined) problems.push(`${field} is missing`)
    else if (!ok(line[field])) problems.push(`${field} must be ${what}`)
  }
  need('seq', isSeq, 'a whole number, 1 or more')
  need('kind', isName, 'a name')
  need('dir', value => DIRECTIONS.includes(value), `one of ${DIRECTIONS.join(', ')}`)
  need('at', isTime, 'a UTC time to the second, such as 2026-11-09T15:43:02Z')
  need('source', isName, 'a name')
  for (const [field, [ok, what]] of Object.entries(READ_TYPES)) {
    if (line[field] !== undefined && !ok(line[field])) problems.push(`${field} must be ${what}`)
  }
  for (const field of ['replyTo', 'target']) {
    if (isSeq(line[field]) && isSeq(line.seq) && line[field] >= line.seq) problems.push(`${field} must be a seq before this line's`)
  }
  return problems
}

// Whether this version acts on a line that passed `checkReadLine`: one of its kinds, from one of
// its channels, with the fields its kind needs. Any other line is kept, and passed over.
export function isKnown(line) {
  return KINDS.includes(line.kind) && SOURCES.includes(line.source) && NEEDS[line.kind].every(field => line[field] !== undefined)
}

// What a line's `data` holds under `name` when `data` is an object and that is a string, or
// undefined. The reading check doesn't look into `data`, so it can be missing, a list, or hold
// anything at all under any name.
export function dataText(line, name) {
  const data = line.data
  return isObject(data) && Object.hasOwn(data, name) && isString(data[name]) ? data[name] : undefined
}

// Whether a line's `data` holds `true` under `name`, as `dataText` reads it.
export function dataFlag(line, name) {
  const data = line.data
  return isObject(data) && Object.hasOwn(data, name) && data[name] === true
}

// The text of a line as it goes into `log.jsonl`, with its line break. Throws a `DatastoreError`
// if the line isn't well formed.
export function encodeLine(line) {
  const problems = checkLine(line)
  if (problems.length > 0) throw new DatastoreError(`not a datastore line: ${problems.join('; ')}`)
  const ordered = {}
  for (const field of FIELDS) {
    if (line[field] !== undefined) ordered[field] = line[field]
  }
  return `${JSON.stringify(ordered)}\n`
}

// Reads one line of `log.jsonl`, without its line break. Throws a `DatastoreError` if it isn't
// JSON, or doesn't pass the reading check.
export function decodeLine(text) {
  let line
  try {
    line = JSON.parse(text)
  } catch {
    throw new DatastoreError('not JSON')
  }
  const problems = checkReadLine(line)
  if (problems.length > 0) throw new DatastoreError(problems.join('; '))
  return line
}
