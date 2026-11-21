// The runner's own waits between its starts.
//
// The runner stops on an error and leans on its service manager to start it again. A fault
// that stays after pi has run, such as a disk too full to record the run, or a bug the batch's
// answer runs into, then runs pi again at every start, and spends on OpenRouter each time. The
// native unit waits 1 minute, then about 5½, then 30, and every 30 after. Docker's restart
// policy starts a container that ran longer than 10 seconds again at once, which a runner that ran
// pi always has: 12 seconds from one start to the next, measured (the review of milestone 13). So
// wherever its service manager doesn't wait, the runner keeps the same waits itself:
//
// - A start that follows a stop on an error, the `stops`th in a row, waits `RUNNER_RESTART_WAITS`
//   for that many from the stop, before anything can run pi. Its service manager has already
//   waited some of it, or all.
// - Before it goes on, it records itself as a stop on an error, the next in a row: if it can't, it
//   runs nothing. So a start that ends in a crash, a kill or a lost power counts, though it could
//   write nothing then.
// - A run recorded since the start makes it the first in a row again: what stops it from then on
//   isn't a fault that stops every run. A stop it was asked for, by SIGTERM or SIGINT, makes it
//   none: the owner's restart, `docker compose stop` or `up`, Docker's own restart, and the
//   machine's shutdown all end the waiting, as a start by hand or the machine's start does for
//   systemd.
// - The first wait in a row tells the owner, once, why and until when; `scooter status` says so
//   while it lasts, from `status.json`. The reason is the error's code or name, never its message.
//
// The native unit says, with `SCOOTER_RESTART_WAITS=systemd`, that systemd keeps these waits, and
// the runner then keeps none of its own: a start by hand must bring it back at once.
//
// `runner/restarts.json`, the runner's own, written atomically, mode 0600:
//
//   {"stops":2,"startedAt":"2026-11-09T15:40:02Z","stoppedAt":"2026-11-09T15:41:10Z","reason":"ENOSPC"}
//
// - `stops`: how many starts in a row have ended other than by a stop the runner was asked for,
//   the one running counted. 0 after such a stop.
// - `startedAt`: when the latest start went on to run; `stoppedAt`: when it stopped on an error,
//   or null when it couldn't say, or hasn't stopped.
// - `reason`: what it stopped on, or null.

import { readJsonFile, writeFileAtomic } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { isoSeconds, parseIsoSeconds, shortLocalTime } from '../common/time.mjs'

// What `SCOOTER_RESTART_WAITS` says when the service manager keeps the waits.
export const SERVICE_MANAGER_WAITS = 'systemd'

// Whether the runner keeps waits of its own, by its environment.
export const keepsRestartWaits = (env = process.env) => env.SCOOTER_RESTART_WAITS !== SERVICE_MANAGER_WAITS

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const orNull = (value, check) => value === null || check(value)

// What is wrong with a record, or null.
function problemOf(record) {
  if (!isObject(record)) return 'not an object'
  if (!Number.isSafeInteger(record.stops) || record.stops < 0) return 'stops must be a whole number, 0 or more'
  if (!orNull(record.startedAt, value => parseIsoSeconds(value) !== null)) return 'startedAt must be a UTC time or null'
  if (!orNull(record.stoppedAt, value => parseIsoSeconds(value) !== null)) return 'stoppedAt must be a UTC time or null'
  if (!orNull(record.reason, value => typeof value === 'string' && value.length <= limits.REASON_MAX_CHARS)) return 'reason must be a short text or null'
  return null
}

const NONE = { stops: 0, startedAt: null, stoppedAt: null, reason: null }

// The wait before a start that follows `stops` stops on an error in a row: none for none, and the
// last of `RUNNER_RESTART_WAITS` for more than it lists.
export function restartWait(stops) {
  const waits = limits.RUNNER_RESTART_WAITS
  return stops <= 0 ? 0 : waits[Math.min(stops, waits.length) - 1]
}

// When a start after `record` may go on, as a time in ms, or null when it needn't wait. From the
// stop, or, when the stop couldn't say when, from the start before it.
export function restartUntil(record) {
  if (record.stops === 0) return null
  const from = parseIsoSeconds(record.stoppedAt) ?? parseIsoSeconds(record.startedAt)
  return from === null ? null : from + restartWait(record.stops)
}

// What the error that stopped the runner was, for the owner: its code or its name, never its
// message, which can quote what was being read (`errorFields`).
export function stopReason(error) {
  const { code, error: name } = errorFields(error)
  return (code ?? name).slice(0, limits.REASON_MAX_CHARS)
}

// The notice for the first wait in a row.
export function restartNotice({ record, until, now, timeZone }) {
  const why = record.reason === null ? "I stopped, and couldn't record why" : `I stopped on an error (${record.reason})`
  const when = shortLocalTime(until, now, timeZone)
  return { type: 'text', by: 'runner', text: `⚠️ ${why}, so I wait until ${when} before I go on, and longer if it happens again. Restarting the runner ends the wait.` }
}

// Reads the record. A runner that never wrote one has none to keep, and one that can't be read is
// logged and counts as none: only the runner writes it, atomically.
export function readRestarts(file, log) {
  let record
  try {
    record = readJsonFile(file)
  } catch (error) {
    log.warn('runner.restarts_unreadable', errorFields(error))
    return { ...NONE }
  }
  if (record === undefined) return { ...NONE }
  const problem = problemOf(record)
  if (problem !== null) {
    log.warn('runner.restarts_unreadable', { problem })
    return { ...NONE }
  }
  return record
}

// Opens the record for this start. Returns:
// - `record`: as the start found it; `until`: when this start may go on, in ms, or null.
// - `wait({ signal })`: tells the owner, if this is the first wait in a row, and waits until then.
//   Rejects when `signal` stops it first.
// - `begin()`: records this start as the next stop in a row, before anything runs; throws when it
//   can't, and then nothing must run.
// - `ranThrough()`: a run was recorded, so this start is the first in a row from now on.
// - `failed(error)`, `stopped()`: how this start ended, an error or a stop it was asked for.
// The last three write as best they can, and log when they can't.
export function openRestarts({ paths, clock, log, ids, timeZone }) {
  const file = paths.runnerRestarts
  const found = readRestarts(file, log)
  const until = restartUntil(found)
  let current = found
  let ended = false

  const write = record => {
    writeFileAtomic(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    current = record
  }
  const tryWrite = (record, what) => {
    try {
      write(record)
    } catch (error) {
      log.error('runner.restarts_not_saved', { what, ...errorFields(error) })
    }
  }

  return {
    record: found,
    until,

    async wait({ signal }) {
      const now = clock.now()
      if (until === null || until <= now) return
      log.warn('runner.restart_waiting', { stops: found.stops, reason: found.reason, until: isoSeconds(until) })
      if (found.stops === 1) {
        try {
          await writeOutboxEntry({ paths, ids, entry: restartNotice({ record: found, until, now, timeZone }) })
        } catch (error) {
          log.error('runner.notice_not_written', errorFields(error))
        }
      }
      await clock.sleep(until - now, { signal })
    },

    begin() {
      write({ stops: found.stops + 1, startedAt: isoSeconds(clock.now()), stoppedAt: null, reason: null })
    },

    ranThrough() {
      if (ended || current.stops <= 1) return
      tryWrite({ ...current, stops: 1 }, 'ran through')
    },

    failed(error) {
      if (ended) return
      ended = true
      // `begin` may not have written, as when the disk is full: then this start counts too.
      const stops = current === found ? found.stops + 1 : current.stops
      tryWrite({ stops, startedAt: current.startedAt, stoppedAt: isoSeconds(clock.now()), reason: stopReason(error) }, 'failed')
    },

    stopped() {
      if (ended) return
      ended = true
      tryWrite({ stops: 0, startedAt: current.startedAt, stoppedAt: isoSeconds(clock.now()), reason: null }, 'stopped')
    },
  }
}
