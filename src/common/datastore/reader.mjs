// Reading the datastore.
//
// The datastore is one `log.jsonl` per day folder, `YYYY/MM/DD`, and reading the folders in date
// order gives the lines in `seq` order. A reader follows it by polling: each `poll()` returns the
// lines that are new since the one before.
//
// A reader takes only complete lines. The writer appends each line with one `write` call, but a
// crash can leave part of a line at the very end. A reader leaves such a part where it is, for
// its next poll: either the rest arrives, or the writer removes the part when it next starts.
// A reader never changes anything.

import fs from 'node:fs'
import path from 'node:path'
import { DatastoreError, decodeLine } from './line.mjs'

const NEWLINE = 0x0a

function names(dir, pattern) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => entry.isDirectory() && pattern.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

// The day folders there are, oldest first, each as `YYYY/MM/DD`.
export function listDays(datastoreDir) {
  const days = []
  for (const year of names(datastoreDir, /^\d{4}$/)) {
    for (const month of names(path.join(datastoreDir, year), /^\d{2}$/)) {
      for (const day of names(path.join(datastoreDir, year, month), /^\d{2}$/)) {
        days.push(`${year}/${month}/${day}`)
      }
    }
  }
  return days
}

// Reads a file from `offset` to its end. Returns an empty buffer when there's no such file.
function readFrom(file, offset) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size <= offset) return Buffer.alloc(0)
    const buffer = Buffer.alloc(size - offset)
    let filled = 0
    while (filled < buffer.length) {
      const count = fs.readSync(fd, buffer, filled, buffer.length - filled, offset + filled)
      if (count === 0) break
      filled += count
    }
    return buffer.subarray(0, filled)
  } finally {
    fs.closeSync(fd)
  }
}

// Returns a reader that starts at the first line of the datastore. `paths` is what `makePaths`
// returns (`src/common/paths.mjs`).
//
// - `poll()` returns the lines that are new, in order, each as `{ line, day, number }`, where
//   `day` is the line's day folder and `number` its line number in that day's log, counting from
//   1. It throws a `DatastoreError` if a complete line isn't a well-formed line, or if a day that
//   isn't the newest ends in part of a line.
// - `position` is where the reader is: `{ day, offset, lineNumber }`, the day folder it's in (null
//   before there is one), the bytes of that day's log it has taken, and the lines.
// - `pending()` returns what is left unread at the end of the newest day's log, the part of a
//   line: `{ day, file, offset, bytes }`, or null when there's nothing. The writer uses it at
//   startup, to cut the part off.
export function createReader(paths) {
  let day = null
  let offset = 0
  let lineNumber = 0
  let leftover = 0

  // Takes the complete lines after `offset` in the current day's log.
  function take(out) {
    const file = paths.dayLog(day)
    const fresh = readFrom(file, offset)
    const end = fresh.lastIndexOf(NEWLINE) + 1
    leftover = fresh.length - end
    const lines = []
    let start = 0
    while (start < end) {
      const stop = fresh.indexOf(NEWLINE, start)
      const number = lineNumber + lines.length + 1
      try {
        lines.push({ line: decodeLine(fresh.toString('utf8', start, stop)), day, number })
      } catch (error) {
        throw new DatastoreError(`${file}, line ${number}: ${error.message}`)
      }
      start = stop + 1
    }
    out.push(...lines)
    lineNumber += lines.length
    offset += end
  }

  function poll() {
    const out = []
    const days = listDays(paths.datastore)
    if (days.length === 0) return out
    const before = { day, offset, lineNumber, leftover }
    try {
      if (day === null) day = days[0]
      for (;;) {
        take(out)
        const next = days.find(candidate => candidate > day)
        if (next === undefined) return out
        // The writer has moved on to a later day, so this day's log is finished.
        if (leftover > 0) {
          throw new DatastoreError(`${paths.dayLog(day)} ends in part of a line, and isn't the newest day's log`)
        }
        day = next
        offset = 0
        lineNumber = 0
      }
    } catch (error) {
      // A poll gives all of its lines or none: the reader stays where it was.
      ;({ day, offset, lineNumber, leftover } = before)
      throw error
    }
  }

  return {
    poll,
    get position() {
      return { day, offset, lineNumber }
    },
    pending() {
      if (day === null || leftover === 0) return null
      return { day, file: paths.dayLog(day), offset, bytes: leftover }
    },
  }
}
