#!/usr/bin/env node
// `show <seq>…`: prints lines of the datastore by their number, for the agent in its VM.
//
// It ships with the runner. Each run gets a copy as `run/bin/show`, which the VM finds on the `PATH`
// the runner gives pi (`prepareRun` in `agentdir.mjs`, `piEnv` in `run.mjs`):
//
//   $ show 1054
//   1054  Mon 9 Nov 2026 21:22 +05:30  /data/datastore/2026/11/09/log.jsonl:216
//   {"seq":1054,"kind":"edit",…,"target":1051,"text":"coffee 150"}
//     points at 1051  Mon 9 Nov 2026 21:14 +05:30  /data/datastore/2026/11/09/log.jsonl:213
//     {"seq":1051,"kind":"message",…,"text":"coffee 120"}
//
// - Each line is found through the run's index file, `run/index.txt` beside `bin/`, which the
//   runner wrote before the run from its own index of the datastore: one line for each `seq`, in
//   order from 1, `<seq> <log>:<line number> <kind>[ <seq it points at>]`. So it shows only what
//   that index holds: a number the index doesn't have, a line written during the run among them,
//   prints "no such line", and the command fails.
// - A line is printed as it is stored, byte for byte, under a header with its `seq`, its time in
//   the owner's time zone, ending with the zone's offset from UTC then, and where it is; then each
//   of its attachments, by its full path; then the one line it points at, which the index gives,
//   in the same way, indented. One hop only, and nothing that points back at the line.
// - The line is read again from its log, by counting line breaks as the runner's reader does, and
//   printed only when its `seq` is the one asked for. Only complete lines are counted, so a log
//   that ends in part of a line, or grows, changes nothing that was in the index.
// - The time is the line's `at` plus the owner's zone's offset from UTC at that instant, which the
//   runner worked out with its own time code (`src/common/time.mjs`) and wrote beside the index
//   file, as `run/offsets.txt`: one row for each instant from which the offset is another,
//   `<instant> <offset>`, `-` where it worked none out. So it asks no zone database, and reads no
//   `TZ`: the VM's Node has zone data of its own, which can be another time's. A line whose time
//   the file doesn't cover, which only a log changed under the run can hold, gets `no time`.
//
// Exit codes: 0 when every line asked for was printed, with the line it points at; 1 when one
// wasn't; 2 when it was called without a number, or can't read the index file or the offsets file.
//
// It runs in the VM with nothing of Scooter's but itself, the index file and the offsets file, so
// it imports only Node's own modules. Node runs a file without an extension, such as
// `run/bin/show`, as an ES module by its syntax (`test/tools/vm.test.mjs`).

import fs from 'node:fs'
import path from 'node:path'

const NEWLINE = 0x0a
const CHUNK_BYTES = 64 * 1024

// ---------------------------------------------------------------------------------------------
// The owner's time

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = text => String(text).padStart(2, '0')

// A UTC time as the datastore writes one, `2026-11-09T15:43:02Z`, as milliseconds since the epoch,
// or null when it isn't one. The offsets file's last row can be in the year 10000, the end of a
// line's day in 9999.
const UTC_TIME = /^(\d{4,5})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/
function instantOf(text) {
  const match = typeof text === 'string' ? UTC_TIME.exec(text) : null
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const instant = new Date(0)
  instant.setUTCFullYear(year, month - 1, day)
  instant.setUTCHours(hour, minute, second, 0)
  // A time that doesn't exist, such as 31 February or 24:00, would have rolled over.
  const parts = [instant.getUTCFullYear(), instant.getUTCMonth() + 1, instant.getUTCDate(), instant.getUTCHours(), instant.getUTCMinutes(), instant.getUTCSeconds()]
  return parts.every((part, n) => part === [year, month, day, hour, minute, second][n]) ? instant.getTime() : null
}

// `run/offsets.txt`: `<instant> <offset>`, from that instant until the next row's, the owner's zone
// is `<offset>` from UTC, `+05:30`, or `+05:53:28` with its seconds; or isn't covered, `-`.
const OFFSET_ROW = /^(\S+) (-|([+-])(\d{2}):([0-5]\d)(?::([0-5]\d))?)$/

// The rows of the offsets file, `{ from, offset, text }`, `offset` in milliseconds and `text` as
// the file writes it, or both null where it covers nothing. Throws, with a code, when the file
// can't be read, and `EDAMAGED`, with the line, when it isn't as the runner writes it: a row that
// can't be read, rows out of order, or a file that doesn't end with a row of `-` and a line break,
// as one cut short wouldn't.
function readOffsets(file) {
  const text = fs.readFileSync(file, 'utf8')
  const rows = []
  const lines = text.split('\n')
  const damaged = number => Object.assign(new Error('damaged'), { code: 'EDAMAGED', line: number })
  if (lines.pop() !== '') throw damaged(lines.length + 1)
  lines.forEach((row, n) => {
    const match = OFFSET_ROW.exec(row)
    const from = match ? instantOf(match[1]) : null
    if (from === null || (rows.length > 0 && from <= rows.at(-1).from) || (match[4] !== undefined && Number(match[4]) > 23)) throw damaged(n + 1)
    const offset = match[2] === '-' ? null : (match[3] === '-' ? -1 : 1) * ((Number(match[4]) * 60 + Number(match[5])) * 60 + Number(match[6] ?? 0)) * 1000
    rows.push({ from, offset, text: offset === null ? null : match[2] })
  })
  if (rows.length > 0 && rows.at(-1).offset !== null) throw damaged(rows.length)
  return rows
}

// A line's `at`, `2026-11-09T15:43:02Z`, as the owner's zone's clock and calendar show it, with
// the zone's offset from UTC then: `Mon 9 Nov 2026 21:13 +05:30`. Null when it isn't a time as the
// datastore writes one, or the offsets don't cover it.
function localTime(at, offsets) {
  const instant = instantOf(at)
  if (instant === null) return null
  // The last row from at or before the instant.
  let low = 0
  let high = offsets.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle].from <= instant) low = middle + 1
    else high = middle
  }
  const row = offsets[low - 1]
  if (row === undefined || row.offset === null) return null
  const wall = new Date(instant + row.offset)
  return `${DAY_NAMES[wall.getUTCDay()]} ${wall.getUTCDate()} ${MONTH_NAMES[wall.getUTCMonth()]} ${wall.getUTCFullYear()} ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())} ${row.text}`
}

// ---------------------------------------------------------------------------------------------
// The index file, and the logs

// `<seq> <log>:<line number> <kind>[ <seq it points at>]`. The log's path is everything between the
// first space and the last `:` before the kind, so it may hold spaces; the runner refuses a data
// folder whose path holds a line break.
const INDEX_LINE = /^(\d+) (.+):(\d+) ([a-z][a-z0-9-]*)(?: (\d+))?$/s

// What the index file says of each of `seqs`, as a Map from the `seq`, as the index writes it, to
// `{ log, number, points }`; a `seq` it doesn't have is left out. The index has every `seq` from 1,
// in order, so the line of `seq` N is its line N, and only those lines are read: a datastore of
// years makes an index of megabytes. A line that doesn't hold its `seq` is taken as none.
function readIndex(file, seqs) {
  const numbers = new Set()
  for (const seq of seqs) if (seq.length <= 15) numbers.add(Number(seq))
  const entries = new Map()
  for (const [number, bytes] of readLines(file, numbers)) {
    const match = INDEX_LINE.exec(bytes.toString('utf8'))
    if (match && match[1] === String(number)) entries.set(match[1], { log: match[2], number: Number(match[3]), points: match[5] ?? null })
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
    if (last === 0) return found
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
  // Each number as the index writes it, digits without a leading zero; `#1051` is taken too.
  const asked = args.map(arg => {
    const digits = /^#?(\d+)$/.exec(arg)?.[1]
    return { arg, seq: digits === undefined ? null : BigInt(digits).toString() }
  })

  // `run/index.txt`, beside the folder this program is in: the lines asked for, then the lines they
  // point at. Then `run/offsets.txt`, beside it.
  const runDir = path.join(path.dirname(path.resolve(process.argv[1])), '..')
  const indexFile = path.join(runDir, 'index.txt')
  let index
  try {
    index = readIndex(indexFile, asked.flatMap(({ seq }) => (seq === null ? [] : [seq])))
    const points = [...index.values()].map(entry => entry.points).filter(seq => seq !== null && !index.has(seq))
    for (const [seq, entry] of readIndex(indexFile, points)) index.set(seq, entry)
  } catch (error) {
    return stop(`can't read the index file ${printable(indexFile)} (${error.code ?? error.name})`)
  }
  const offsetsFile = path.join(runDir, 'offsets.txt')
  let offsets
  try {
    offsets = readOffsets(offsetsFile)
  } catch (error) {
    return stop(`can't read the offsets file ${printable(offsetsFile)} (${error.code === 'EDAMAGED' ? `damaged at line ${error.line}` : (error.code ?? error.name)})`)
  }

  // Every line to print, read with one pass over each log.
  const wanted = new Map()
  for (const entry of index.values()) {
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
    write(`${indent}${lead}${seq}  ${localTime(line.at, offsets) ?? 'no time'}  ${where}\n`)
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
