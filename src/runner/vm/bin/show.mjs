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
// - The time is converted for the zone `TZ` names, which the runner sets to the owner's, through
//   `Intl.DateTimeFormat`, and ends with the zone's offset from UTC then, worked out from the
//   conversion itself. The VM's Node converts with ICU's zone rules that ship with the runner,
//   which each run gets as `run/icu-tz/` beside `bin/`, and which `ICU_TIMEZONE_FILES_DIR` points
//   ICU at in pi's environment. Before it converts anything, it checks that it does: that each of
//   the folder's four files is what its `release.txt` lists, that the variable names the folder,
//   and that this Node's rules are of the release named there. Otherwise, and without a zone `TZ`
//   names that those rules know, it stops rather than print another time.
//
// Exit codes: 0 when every line asked for was printed, with the line it points at; 1 when one
// wasn't; 2 when it was called without a number, can't read the index file, or has no zone rules or
// zone it can stand behind.
//
// It runs in the VM with nothing of Scooter's but itself and what is in `run/`, so it imports only
// Node's own modules. Node runs a file without an extension, such as `run/bin/show`, as an ES
// module by its syntax (`test/tools/vm.test.mjs`).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const NEWLINE = 0x0a
const CHUNK_BYTES = 64 * 1024

// ---------------------------------------------------------------------------------------------
// The owner's time

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = text => String(text).padStart(2, '0')

const ISO_SECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/

// ICU's four zone files, which the run's copy of the zone rules holds.
const ZONE_FILES = ['zoneinfo64.res', 'metaZones.res', 'timezoneTypes.res', 'windowsZones.res']

// The release of the tz database that the zone rules in `dir` are of, once each of the four files
// there is what their `release.txt` lists: its first line names the release, such as `2026f`, and
// each line after it gives a file's SHA-256 and its name, as `sha256sum` writes them. Otherwise it
// throws, saying which file is missing or isn't as listed. *Why:* ICU checks little of a file it
// reads. Tried in the VM: a `zoneinfo64.res` that isn't ICU's leaves Node no zone rules, and makes
// it abort once a time is converted; one cut short leaves it none too, or now and then kills it as
// it starts, before any of this runs; and one with a byte changed is taken as it is.
function zoneRulesRelease(dir) {
  const damaged = (name, why) => Object.assign(new Error(`${name}: ${why}`), { code: 'EDAMAGED' })
  const read = name => {
    try {
      return fs.readFileSync(path.join(dir, name))
    } catch (error) {
      throw damaged(name, error.code ?? error.name)
    }
  }
  const [release, ...rows] = read('release.txt').toString('utf8').split('\n')
  const sums = new Map()
  for (const row of rows) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(row)
    if (match) sums.set(match[2], match[1])
    else if (row !== '') throw damaged('release.txt', 'a line that is no file\'s SHA-256 and name')
  }
  if (!/^\d{4}[a-z]+$/.test(release)) throw damaged('release.txt', 'no release on its first line')
  if (sums.size !== ZONE_FILES.length || !ZONE_FILES.every(name => sums.has(name))) throw damaged('release.txt', `not one line for each of ${ZONE_FILES.join(', ')}`)
  for (const name of ZONE_FILES) {
    if (createHash('sha256').update(read(name)).digest('hex') !== sums.get(name)) throw damaged(name, 'not the file release.txt lists')
  }
  return release
}

// The formatter for the owner's zone, with the run's zone rules in `dir`, or a message that says why
// there is none: the rules aren't whole; `ICU_TIMEZONE_FILES_DIR` doesn't name them, so ICU would
// use the rules built into this Node; this Node's rules aren't of their release, as when ICU
// couldn't use a file there; `TZ` isn't set; or the rules don't know the zone `TZ` names.
function ownerZone(dir) {
  let release
  try {
    release = zoneRulesRelease(dir)
  } catch (error) {
    if (error.code !== 'EDAMAGED') throw error
    return { problem: `the run's zone rules, ${printable(dir)}, are missing or damaged (${error.message})` }
  }
  const named = process.env.ICU_TIMEZONE_FILES_DIR
  if (named === undefined || named === '') return { problem: `ICU_TIMEZONE_FILES_DIR isn't set to the run's zone rules, ${printable(dir)}, so Node would convert with rules of its own` }
  if (realPath(named) !== realPath(dir)) return { problem: `ICU_TIMEZONE_FILES_DIR is ${printable(named)}, not the run's zone rules, ${printable(dir)}` }
  if (process.versions.tz !== release) return { problem: `this Node converts with zone rules of ${process.versions.tz ? `tz ${process.versions.tz}` : 'no release it could read'}, not those of the run, tz ${release}, in ${printable(dir)}` }
  const zone = process.env.TZ
  if (zone === undefined || zone === '') return { problem: "TZ isn't set, so the owner's time can't be shown" }
  try {
    return {
      formatter: new Intl.DateTimeFormat('en-US', {
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
        second: '2-digit',
      }),
    }
  } catch {
    return { problem: `TZ is ${printable(zone)}, which the run's zone rules, tz ${release}, don't know as a time zone` }
  }
}

// A folder's path with no link in it, or null when there is no such folder.
function realPath(dir) {
  try {
    return fs.realpathSync(path.resolve(dir))
  } catch {
    return null
  }
}

// A line's `at`, `2026-11-09T15:43:02Z`, as the zone's clock and calendar show it, then the zone's
// offset from UTC at that instant: `Mon 9 Nov 2026 21:13 +05:30`. Null when it isn't a time as the
// datastore writes one. The offset is the zone's clock less the UTC time, to the second, from the
// conversion itself: the zone's name for it isn't one form in every ICU, `GMT` in ICU 76 where ICU
// 78 writes `GMT+00:00`.
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
  local.setUTCHours(Number(fields.hour), Number(fields.minute), Number(fields.second), 0)
  const offset = (local.getTime() - instant.getTime()) / 1000
  return `${DAY_NAMES[local.getUTCDay()]} ${local.getUTCDate()} ${MONTH_NAMES[local.getUTCMonth()]} ${localYear} ${pad(fields.hour)}:${pad(fields.minute)} ${offsetText(offset)}`
}

// An offset from UTC, in seconds, as the header ends with it: `+05:30`, `-07:00`, `+00:00` for UTC
// itself, and `+05:53:28`, with its seconds, when it isn't a whole number of minutes, as a zone's
// local mean time before its first standard time often isn't.
function offsetText(offset) {
  const size = Math.abs(offset)
  const text = `${offset < 0 ? '-' : '+'}${pad(Math.floor(size / 3600))}:${pad(Math.floor(size / 60) % 60)}`
  return size % 60 === 0 ? text : `${text}:${pad(size % 60)}`
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

  // `run/`, the folder beside the one this program is in: the zone rules in `icu-tz/`, then the
  // lines asked for in `index.txt`, then the lines they point at.
  const runDir = path.join(path.dirname(path.resolve(process.argv[1])), '..')
  const { formatter, problem } = ownerZone(path.join(runDir, 'icu-tz'))
  if (problem) return stop(problem)
  const indexFile = path.join(runDir, 'index.txt')
  let index
  try {
    index = readIndex(indexFile, asked.flatMap(({ seq }) => (seq === null ? [] : [seq])))
    const points = [...index.values()].map(entry => entry.points).filter(seq => seq !== null && !index.has(seq))
    for (const [seq, entry] of readIndex(indexFile, points)) index.set(seq, entry)
  } catch (error) {
    return stop(`can't read the index file ${printable(indexFile)} (${error.code ?? error.name})`)
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
