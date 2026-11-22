#!/usr/bin/env node
// `show <seq>…`: prints lines of the datastore by their number, for the agent in its VM.
//
// It ships with the runner. Each run gets a copy as `run/bin/show`, which the VM finds on the `PATH`
// the runner gives pi (`prepareRun` in `agentdir.mjs`, `piEnv` in `run.mjs`):
//
//   $ show 1054
//   1054  Mon 9 Nov 2026 21:22  /data/datastore/2026/11/09/log.jsonl:216
//   {"seq":1054,"kind":"edit",…,"target":1051,"text":"coffee 150"}
//     points at 1051  Mon 9 Nov 2026 21:14  /data/datastore/2026/11/09/log.jsonl:213
//     {"seq":1051,"kind":"message",…,"text":"coffee 120"}
//
// - Each line is found through the run's index file, `run/index.txt` beside `bin/`, which the
//   runner wrote before the run from its own index of the datastore: one line for each `seq`,
//   `<seq> <log>:<line number> <kind>[ <seq it points at>]`. So it shows only what that index
//   holds: a number the index doesn't have, a line written during the run among them, prints
//   "no such line", and the command fails.
// - A line is printed as it is stored, byte for byte, under a header with its `seq`, its time in
//   the owner's time zone, and where it is; then each of its attachments, by its full path; then
//   the one line it points at, which the index gives, in the same way, indented. One hop only, and
//   nothing that points back at the line.
// - The line is read again from its log, by counting line breaks as the runner's reader does, and
//   printed only when its `seq` is the one asked for. Only complete lines are counted, so a log
//   that ends in part of a line, or grows, changes nothing that was in the index.
// - The time is converted for the zone `TZ` names, which the runner sets to the owner's, explicitly
//   through `Intl.DateTimeFormat`, as the runner's own code converts it (`src/common/time.mjs`):
//   without a zone that Node knows, it stops rather than print another zone's time.
//
// Exit codes: 0 when every line asked for was printed, with the line it points at; 1 when one
// wasn't; 2 when it was called without a number, or can't read the index file or the zone.
//
// It runs in the VM with nothing of Scooter's but itself and the index file, so it imports only
// Node's own modules. Node runs a file without an extension, such as `run/bin/show`, as an ES
// module by its syntax (`test/tools/vm.test.mjs`).

import fs from 'node:fs'
import path from 'node:path'

const NEWLINE = 0x0a
const CHUNK_BYTES = 64 * 1024

// ---------------------------------------------------------------------------------------------
// The owner's time

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ISO_SECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/
const pad = text => String(text).padStart(2, '0')

// The formatter for the zone `zone` names, or null when it names none that Node knows.
function zoneFormatter(zone) {
  if (typeof zone !== 'string' || zone === '') return null
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return null
  }
}

// A line's `at`, `2026-11-09T15:43:02Z`, as the zone's clock and calendar show it:
// `Mon 9 Nov 2026 21:13`. Null when it isn't a time as the datastore writes one.
function localTime(at, formatter) {
  const match = typeof at === 'string' ? ISO_SECONDS.exec(at) : null
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const instant = new Date(0)
  instant.setUTCFullYear(year, month - 1, day)
  instant.setUTCHours(hour, minute, second, 0)
  // A time that doesn't exist, such as 31 February or 24:00, would have rolled over.
  if (instant.toISOString().slice(0, 19) !== at.slice(0, 19)) return null
  const fields = {}
  for (const part of formatter.formatToParts(instant)) fields[part.type] = part.value
  const localYear = fields.era === 'BC' ? 1 - Number(fields.year) : Number(fields.year)
  const local = new Date(0)
  local.setUTCFullYear(localYear, Number(fields.month) - 1, Number(fields.day))
  return `${DAY_NAMES[local.getUTCDay()]} ${local.getUTCDate()} ${MONTH_NAMES[local.getUTCMonth()]} ${localYear} ${pad(fields.hour)}:${pad(fields.minute)}`
}

// ---------------------------------------------------------------------------------------------
// The index file, and the logs

// `<seq> <log>:<line number> <kind>[ <seq it points at>]`. The log's path is everything between the
// first space and the last `:` before the kind, so it may hold spaces; the runner refuses a data
// folder whose path holds a line break.
const INDEX_LINE = /^(\d+) (.+):(\d+) ([a-z][a-z0-9-]*)(?: (\d+))?$/s

// The index file, as a Map from each `seq`, as written, to `{ log, number, points }`.
function readIndex(file) {
  const entries = new Map()
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = INDEX_LINE.exec(text)
    if (match) entries.set(match[1], { log: match[2], number: Number(match[3]), points: match[5] ?? null })
  }
  return entries
}

// The lines of `file` whose numbers are in `wanted`, counting from 1, as a Map from number to the
// line's bytes, without its line break. Only complete lines are taken, and only as far as the last
// one wanted. A line of any length is read whole.
function readLines(file, wanted) {
  const found = new Map()
  let last = 0
  for (const number of wanted) last = Math.max(last, number)
  const fd = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES)
    let number = 1
    let parts = []
    let position = 0
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, position)
      if (count === 0) return found
      position += count
      const data = chunk.subarray(0, count)
      let start = 0
      while (start < data.length) {
        const end = data.indexOf(NEWLINE, start)
        const stop = end === -1 ? data.length : end
        if (wanted.has(number)) parts.push(Buffer.from(data.subarray(start, stop)))
        if (end === -1) break
        if (wanted.has(number)) found.set(number, Buffer.concat(parts))
        parts = []
        if (++number > last) return found
        start = end + 1
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

// The line as JSON, when it is an object that was stored as `seq`; otherwise null.
function lineOf(bytes, seq) {
  try {
    const line = JSON.parse(bytes.toString('utf8'))
    return typeof line === 'object' && line !== null && Number.isSafeInteger(line.seq) && String(line.seq) === seq ? line : null
  } catch {
    return null
  }
}

// The names of a line's attachments, each a file in the line's own day folder.
function filesOf(line) {
  if (!Array.isArray(line.files)) return []
  return line.files.map(file => file?.path).filter(name => typeof name === 'string' && name !== '' && !name.includes('/') && !name.startsWith('.'))
}

// A path, or a word the agent gave, as it is, or as a JSON string when it holds a character that
// could break the line it is printed on, or is empty. A path as it is starts with `/`, so the two
// can't be taken for each other.
const printable = text => (/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u.test(text) ? text : JSON.stringify(text))

// ---------------------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    process.stdout.write('usage: show <seq>…\nPrints each line of the datastore with that number, and the one line it points at.\n')
    process.exitCode = args.length === 0 ? 2 : 0
    return
  }
  const stop = message => {
    process.stderr.write(`show: ${message}\n`)
    process.exitCode = 2
  }
  const formatter = zoneFormatter(process.env.TZ)
  if (formatter === null) return stop("TZ isn't set to a time zone, such as Asia/Kolkata, so the owner's time can't be shown")
  // `run/index.txt`, beside the folder this program is in.
  const indexFile = path.join(path.dirname(path.resolve(process.argv[1])), '..', 'index.txt')
  let index
  try {
    index = readIndex(indexFile)
  } catch (error) {
    return stop(`can't read the index file ${printable(indexFile)} (${error.code ?? error.name})`)
  }

  // Each number as the index writes it, digits without a leading zero; `#1051` is taken too.
  const asked = args.map(arg => {
    const digits = /^#?(\d+)$/.exec(arg)?.[1]
    return { arg, seq: digits === undefined ? null : BigInt(digits).toString() }
  })

  // Every line to print, read with one pass over each log.
  const wanted = new Map()
  for (const seq of asked.flatMap(({ seq }) => (seq === null ? [] : [seq, index.get(seq)?.points]))) {
    const entry = seq ? index.get(seq) : undefined
    if (!entry) continue
    if (!wanted.has(entry.log)) wanted.set(entry.log, new Set())
    wanted.get(entry.log).add(entry.number)
  }
  const stored = new Map()
  for (const [log, numbers] of wanted) {
    try {
      for (const [number, bytes] of readLines(log, numbers)) stored.set(`${log}:${number}`, bytes)
    } catch {
      // Each line wanted there is one that can't be read.
    }
  }

  const out = []
  const write = text => out.push(typeof text === 'string' ? Buffer.from(text) : text)
  let ok = true
  // One line: its header, the line as stored, and its files, each line with `indent` before it.
  // Returns whether it was printed.
  const print = (seq, indent, lead) => {
    const entry = index.get(seq)
    if (!entry) {
      write(`${indent}${lead}${seq}  no such line\n`)
      return false
    }
    const where = `${printable(entry.log)}:${entry.number}`
    const bytes = stored.get(`${entry.log}:${entry.number}`)
    const line = bytes === undefined ? null : lineOf(bytes, seq)
    if (line === null) {
      write(`${indent}${lead}${seq}  can't be read at ${where}\n`)
      return false
    }
    write(`${indent}${lead}${seq}  ${localTime(line.at, formatter) ?? 'no time'}  ${where}\n`)
    write(indent)
    write(bytes)
    write('\n')
    for (const name of filesOf(line)) write(`${indent}  file ${printable(path.join(path.dirname(entry.log), name))}\n`)
    return true
  }

  asked.forEach(({ arg, seq }, n) => {
    if (n > 0) write('\n')
    if (seq === null) {
      write(`${printable(arg)}  no such line\n`)
      ok = false
      return
    }
    if (!print(seq, '', '')) {
      ok = false
      return
    }
    const points = index.get(seq).points
    if (points !== null && !print(points, '  ', 'points at ')) ok = false
  })
  process.stdout.write(Buffer.concat(out))
  if (!ok) process.exitCode = 1
}

main()
