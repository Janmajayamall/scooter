// Logging: one JSON object per line, on stderr.
//
//   {"at":"2026-11-09T15:43:02Z","level":"info","component":"bridge","event":"store.appended","seq":1042,"bytes":187}
//
// Logs carry IDs, kinds, sizes and timings, never message text or file contents (section 9 of
// DESIGN.md). The caller chooses the fields, so that rule is the caller's to keep. Two things
// here help it:
// - a field named after one of the datastore's content fields is written as "[withheld]", so
//   passing a whole datastore line by mistake leaks nothing;
// - `errorFields` describes an error without its message, because the message of a parsing error
//   quotes what was being parsed.

import { isoSeconds, systemClock } from './time.mjs'

// The fields of a datastore line that hold what was written (4.2). Its other content, `files` and
// `media`, is nested, and nothing nested is logged.
const CONTENT_FIELDS = new Set(['text', 'subject', 'quoted'])
const RESERVED_FIELDS = new Set(['at', 'level', 'component', 'event'])

function isPlain(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function clean(name, value) {
  if (CONTENT_FIELDS.has(name)) return '[withheld]'
  if (isPlain(value)) return value
  if (Array.isArray(value) && value.every(isPlain)) return value
  // Nothing nested: an object could carry anything.
  return `[${Array.isArray(value) ? 'array' : typeof value}]`
}

// What can be said about an error without repeating content: its name, the system's code and call
// when it has them, and, for a program that failed, its exit code and whether it timed out. Spread
// it into a log call's fields.
export function errorFields(error) {
  const fields = { error: typeof error?.name === 'string' ? error.name : 'Error' }
  if (typeof error?.code === 'string') fields.code = error.code
  if (typeof error?.syscall === 'string') fields.syscall = error.syscall
  if (Number.isSafeInteger(error?.exitCode)) fields.exitCode = error.exitCode
  if (error?.timedOut === true) fields.timedOut = true
  return fields
}

// Returns a log for one component, such as `bridge` or `runner`. `write` takes each finished
// line; by default lines go to stderr, which leaves stdout to the commands that print results.
export function createLog({ component, clock = systemClock, write = line => process.stderr.write(line) }) {
  function emit(level, event, fields = {}) {
    const entry = { at: isoSeconds(clock.now()), level, component, event }
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || RESERVED_FIELDS.has(name)) continue
      entry[name] = clean(name, value)
    }
    write(`${JSON.stringify(entry)}\n`)
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}
