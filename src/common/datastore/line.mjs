// The format of a datastore line (4.2 of DESIGN.md).
//
// One JSON object per line of `log.jsonl`. The bridge writes them, and the runner and pi read
// them. `checkLine` is the format in code: what each field holds and when it's there.

import { parseIsoSeconds } from '../time.mjs'

export const KINDS = ['message', 'edit', 'delete', 'reaction', 'command']
export const DIRECTIONS = ['in', 'out']
export const SOURCES = ['whatsapp', 'email']
export const TRUSTS = ['owner', 'external']

// The fields, in the order a line is written.
const FIELDS = [
  'seq',
  'kind',
  'dir',
  'at',
  'source',
  'sourceId',
  'trust',
  'by',
  'replyTo',
  'quoted',
  'forwarded',
  'target',
  'emoji',
  'subject',
  'text',
  'files',
  'media',
]

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
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

function checkFile(file) {
  if (!isObject(file)) return false
  const { path, mime, name, bytes, ...rest } = file
  if (Object.keys(rest).length > 0) return false
  // `path` is a file name in the line's own day folder, never a path that leads elsewhere.
  if (!isString(path) || path === '' || path.includes('/') || path.startsWith('.')) return false
  if (!isString(mime) || mime === '') return false
  if (name !== undefined && !isString(name)) return false
  return Number.isSafeInteger(bytes) && bytes >= 0
}

function checkMedia(media) {
  if (!isObject(media)) return false
  const { type, mime, error, ...rest } = media
  if (Object.keys(rest).length > 0) return false
  if (!isString(type) || type === '') return false
  if (mime !== undefined && !isString(mime)) return false
  return isString(error) && error !== ''
}

// Returns what is wrong with a line, as a list of short statements that name fields and never
// repeat their values. An empty list means the line is well formed.
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
  need('at', value => parseIsoSeconds(value) !== null, 'a UTC time to the second, such as 2026-11-09T15:43:02Z')
  need('source', value => SOURCES.includes(value), `one of ${SOURCES.join(', ')}`)
  allow('sourceId', true, value => isString(value) && value !== '', 'a string that isn\'t empty')

  const { kind, dir, source } = line
  const isMessage = kind === 'message'
  const pointsAtAnother = ['edit', 'delete', 'reaction'].includes(kind)

  // Who it's from: `trust` on what came in, `by` on what Scooter sent.
  if (dir === 'in') need('trust', value => TRUSTS.includes(value), `one of ${TRUSTS.join(', ')}`)
  else allow('trust', false)
  if (dir === 'out') need('by', value => isString(value) && value !== '', 'a string that isn\'t empty')
  else allow('by', false)

  if (['message', 'edit', 'command'].includes(kind)) need('text', isString, 'a string')
  else allow('text', false)

  if (pointsAtAnother) need('target', isSeq, 'a seq')
  else allow('target', false)
  if (kind === 'reaction') need('emoji', isString, 'a string')
  else allow('emoji', false)

  allow('subject', isMessage && source === 'email', isString, 'a string')
  allow('files', isMessage, value => Array.isArray(value) && value.length > 0 && value.every(checkFile), 'a list of stored files')
  allow('media', isMessage, checkMedia, 'an object with type and error')
  allow('replyTo', isMessage, isSeq, 'a seq')
  allow('quoted', isMessage, isString, 'a string')
  allow('forwarded', isMessage, value => value === true, 'true, or left out')

  // A line can only point at lines before it.
  for (const field of ['replyTo', 'target']) {
    if (isSeq(line[field]) && isSeq(line.seq) && line[field] >= line.seq) problems.push(`${field} must be a seq before this line's`)
  }
  return problems
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

// Reads one line of `log.jsonl`, without its line break. Throws a `DatastoreError` if it isn't a
// well-formed line.
export function decodeLine(text) {
  let line
  try {
    line = JSON.parse(text)
  } catch {
    throw new DatastoreError('not JSON')
  }
  const problems = checkLine(line)
  if (problems.length > 0) throw new DatastoreError(problems.join('; '))
  return line
}
