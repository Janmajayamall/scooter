// Lock files: `run.lock`, which the runner holds for each run, and `backup.lock`, which the bridge
// holds for each backup.
//
// A lock is a small JSON file: who made it, when, and when its work must be over.
//
//   {"pid":4211,"at":"2026-11-09T15:50:02Z","deadline":"2026-11-09T16:00:02Z"}
//
// It is created exclusively, so of two processes that try at once, one gets it. Its contents are
// written first, under a temporary name, and linked into place, so nobody ever reads half a lock.
//
// How the two locks work together belongs to the runner and the bridge: each takes its own lock
// first and then looks for the other's.

import fs from 'node:fs'
import path from 'node:path'
import { TMP_PREFIX } from './files.mjs'
import { isoSeconds, parseIsoSeconds, systemClock } from './time.mjs'

let tmpCounter = 0

// Takes the lock at `file`. Returns true if this call created it, and false if it was already
// there. `deadline` is the instant its work must be over, in milliseconds, or null for none.
export function takeLock(file, { deadline = null, clock = systemClock, pid = process.pid } = {}) {
  const lock = {
    pid,
    at: isoSeconds(clock.now()),
    deadline: deadline === null ? null : isoSeconds(deadline),
  }
  const tmp = path.join(path.dirname(file), `${TMP_PREFIX}${path.basename(file)}-${process.pid}-${++tmpCounter}`)
  fs.writeFileSync(tmp, `${JSON.stringify(lock)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    // A link fails if the name is taken, and the name appears with its contents complete.
    fs.linkSync(tmp, file)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// Reads the lock at `file`. Returns null when there is none. Otherwise `{ pid, at, deadline }`,
// with `at` and `deadline` as instants in milliseconds. A part that's missing or unreadable is
// null: the lock is still held, and nothing more is known about it.
export function readLock(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let lock = null
  try {
    lock = JSON.parse(text)
  } catch {
    // not a lock this code wrote
  }
  return {
    pid: Number.isInteger(lock?.pid) ? lock.pid : null,
    at: parseIsoSeconds(lock?.at),
    deadline: parseIsoSeconds(lock?.deadline),
  }
}

// Whether there is a lock at `file`.
export function lockExists(file) {
  return fs.existsSync(file)
}

// Removes the lock at `file`, if there is one. Each side removes only its own kind of lock: after
// its work, and at startup, when a lock of its own can only be a leftover.
export function releaseLock(file) {
  fs.rmSync(file, { force: true })
}
