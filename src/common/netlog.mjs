// The network log (6.13 of DESIGN.md): every request pi's VM makes, as the runner's network policy
// handles it, in `runner/log/YYYY-MM-DD.jsonl` by UTC date.
//
//   {"id":"20261109T155012041-0001","at":"2026-11-09T15:50:12Z","event":"request","host":"openrouter.ai","method":"POST","path":"/api/v1/messages"}
//   {"id":"20261109T155012041-0001","at":"2026-11-09T15:50:19Z","event":"response","status":200,"sent":48211,"received":5340,"ms":7012}
//   {"id":"20261109T155013502-0001","at":"2026-11-09T15:50:14Z","event":"error","reason":"ECONNREFUSED","ms":31}
//   {"at":"2026-11-09T15:51:02Z","event":"refused","host":"example.com","reason":"host not allowed"}
//
// - `request`: written before the request goes out, so nothing leaves without a line.
// - `response`: the answer to the request with the same `id`, by its status.
// - `error`: the request with the same `id` got no answer: the host couldn't be reached, or the
//   connection broke before a status came. `reason` is a short code from Scooter's own code.
// - `refused`: the policy refused a request and nothing went out. `method` and `path` are there
//   when the policy got that far.
//
// Lines hold hosts, paths without their query strings, statuses, byte counts and timings, never
// headers, bodies or query strings. The runner writes the log (`src/runner/sandbox/`), and reads
// it to learn why a run failed (6.9). The bridge reads it for `/status`, which is why its format
// is here.

import fs from 'node:fs'
import { parseIsoSeconds, utcDate } from './time.mjs'

export const NETLOG_EVENTS = ['request', 'response', 'error', 'refused']

const DAY = 24 * 60 * 60 * 1000

// The fields of each event, in the order they are written, and those that may be left out.
const FIELDS = {
  request: ['id', 'at', 'event', 'host', 'method', 'path'],
  response: ['id', 'at', 'event', 'status', 'sent', 'received', 'ms'],
  error: ['id', 'at', 'event', 'reason', 'ms'],
  refused: ['at', 'event', 'host', 'method', 'path', 'reason'],
}
const OPTIONAL = { refused: ['method', 'path'] }

const ID = /^\d{8}T\d{9}-\d{4}$/
const HOST = /^[a-z0-9.:[\]-]+$/
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isText = value => typeof value === 'string' && value !== '' && !/\p{C}/u.test(value)

const TESTS = {
  id: [value => typeof value === 'string' && ID.test(value), 'an ID such as 20261109T155012041-0001'],
  at: [value => parseIsoSeconds(value) !== null, 'a UTC time to the second'],
  host: [value => typeof value === 'string' && HOST.test(value), 'a host name in lower case'],
  method: [value => typeof value === 'string' && /^[A-Z]+$/.test(value), 'an HTTP method in capitals'],
  path: [value => typeof value === 'string' && value.startsWith('/') && !/[?#\s]/.test(value), 'a path without a query string'],
  status: [value => Number.isSafeInteger(value) && value >= 100 && value <= 599, 'an HTTP status'],
  sent: [isCount, 'a count of bytes'],
  received: [isCount, 'a count of bytes'],
  ms: [isCount, 'a whole number of milliseconds'],
  reason: [isText, 'a short reason on one line'],
}

// What is wrong with a line of the log, as a list of statements that name fields. An empty list
// means it is well formed.
export function checkNetworkLogLine(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ['not an object']
  if (!NETLOG_EVENTS.includes(entry.event)) return [`event must be one of ${NETLOG_EVENTS.join(', ')}`]
  const fields = FIELDS[entry.event]
  const optional = OPTIONAL[entry.event] ?? []
  const problems = []
  for (const name of Object.keys(entry)) {
    if (!fields.includes(name)) problems.push(`${name} doesn't belong on a ${entry.event} line`)
  }
  for (const name of fields) {
    if (name === 'event') continue
    if (entry[name] === undefined) {
      if (!optional.includes(name)) problems.push(`${name} is missing`)
    } else if (!TESTS[name][0](entry[name])) {
      problems.push(`${name} must be ${TESTS[name][1]}`)
    }
  }
  return problems
}

// A line of the log, as written: its fields in order, and a line break. Throws if it isn't one.
export function formatNetworkLogLine(entry) {
  const problems = checkNetworkLogLine(entry)
  if (problems.length > 0) throw new Error(`not a line of the network log: ${problems.join('; ')}`)
  const ordered = {}
  for (const name of FIELDS[entry.event]) {
    if (entry[name] !== undefined) ordered[name] = entry[name]
  }
  return `${JSON.stringify(ordered)}\n`
}

// The lines of the log from `from` to `to`, instants in milliseconds, in the order they were
// written. A line counts by its `at`, which is to the second, so the second `from` falls in counts
// whole. Each day's file is read whole; the log is a few hundred lines a day.
//
// Lines that aren't lines of the log are skipped, and so is part of a line that a crash left at the
// end of a file: the log is a record for reading, and one bad line shouldn't hide the rest. Returns
// `{ entries, skipped }`, with how many were skipped.
export function readNetworkLog(paths, { from, to }) {
  const start = Math.floor(from / 1000) * 1000
  const entries = []
  let skipped = 0
  for (let day = Date.parse(`${utcDate(start)}T00:00:00Z`); day <= to; day += DAY) {
    let text
    try {
      text = fs.readFileSync(paths.networkLog(utcDate(day)), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const lines = text.split('\n')
    // What follows the last line break is part of a line, or nothing.
    if (lines.pop() !== '') skipped += 1
    for (const text of lines) {
      let entry
      try {
        entry = JSON.parse(text)
      } catch {
        skipped += 1
        continue
      }
      if (checkNetworkLogLine(entry).length > 0) {
        skipped += 1
        continue
      }
      const at = parseIsoSeconds(entry.at)
      if (at >= start && at <= to) entries.push(entry)
    }
  }
  return { entries, skipped }
}
