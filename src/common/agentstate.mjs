// An agent's `state.json` (6.3 of DESIGN.md): the runner's bookkeeping for one agent.
//
//   {
//     "cursor": 1049,
//     "commandSeq": 1038,
//     "retry": [{"seq": 1047, "attempts": 1, "due": "2026-11-09T15:51:00Z", "reason": "not reported"}],
//     "failed": [{"seq": 1031, "at": "2026-11-09T12:32:11Z", "reason": "unreadable PDF"}],
//     "session": {"day": "2026-11-09", "bump": 0},
//     "onceDone": ["poems"],
//     "backfill": {"id": "people-1", "until": 1890, "cursor": 812, "retry": [], "skipped": [1031]},
//     "backfillDone": [],
//     "scheduled": {"21:30": "2026-11-09"},
//     "lastRun": {"at": "2026-11-09T15:50:15Z", "ok": true, "seqs": [1050, 1051, 1053], "durationMs": 48211},
//     "paused": {"since": "2026-11-09T15:50:15Z", "cause": "setup", "reason": "OpenRouter answered 401", "next": "2026-11-09T16:20:15Z", "tries": 1}
//   }
//
// - `cursor`: the highest `seq` the runner has dealt with, by giving it to the agent or by skipping
//   it. 0 before anything has been.
// - `commandSeq`: the `seq` of the newest command line the runner has handled, 0 before any.
// - `retry`: items given to the agent and not handled yet. `attempts` is how many runs they have
//   been in that counted, and `due` when they are next tried. Each is at or before the cursor: a
//   run moves the cursor past its batch, whether it succeeds or fails.
// - `failed`: items given up on, the newest `FAILED_KEEP`.
// - `session`: the owner's day of the newest `/new`, and how many there were that day. Null before
//   the first `/new`: a day without one has the session `<agent>-<day>`.
// - `onceDone`, `backfillDone`: the IDs of the `once` tasks and backfills that have finished.
// - `backfill`: only while a backfill is in progress (6.11). Its own cursor, its retries, and the
//   items it gave up on.
// - `scheduled`: for each `at` of the config, the owner's date of the last time it came due that
//   has been dealt with.
// - `lastRun`: the last live run, null before the first.
// - `paused`: only while a setup error or an outage holds runs back (6.9). `cause` is `setup` or
//   `outage`, `next` is the next try, and `tries` how many tries in a row have failed.
//
// Times are UTC to the second. `session.day` and the dates in `scheduled` are dates of the owner's
// day in `SCOOTER_TZ`. The runner alone writes the file, atomically. The bridge reads it for
// `/status`, which is why its format is here.

import { readJsonFile } from './files.mjs'
import { isDate, parseIsoSeconds } from './time.mjs'

export const PAUSE_CAUSES = ['setup', 'outage']

const FIELDS = ['cursor', 'commandSeq', 'retry', 'failed', 'session', 'onceDone', 'backfill', 'backfillDone', 'scheduled', 'lastRun', 'paused']

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isSeq = value => Number.isSafeInteger(value) && value >= 1
const isTime = value => parseIsoSeconds(value) !== null
const isText = value => typeof value === 'string' && value !== ''

// The state of an agent that has never run.
export function initialAgentState() {
  return {
    cursor: 0,
    commandSeq: 0,
    retry: [],
    failed: [],
    session: null,
    onceDone: [],
    backfillDone: [],
    scheduled: {},
    lastRun: null,
  }
}

// What is wrong with a state, as a list of statements that each name the field, such as
// `retry[2].due must be a UTC time to the second`. An empty list means it is well formed.
export function checkAgentState(state) {
  if (!isObject(state)) return ['the state must be an object']
  const problems = []
  const fault = (field, what) => problems.push(`${field} must be ${what}`)

  // Checks an object's own fields: each one listed, with its test, and nothing else.
  function shape(field, value, tests, optional = []) {
    if (!isObject(value)) return fault(field, 'an object')
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(tests, name)) problems.push(`${field}.${name} is not a field of the state`)
    }
    for (const [name, [ok, what]] of Object.entries(tests)) {
      if (value[name] === undefined) {
        if (!optional.includes(name)) problems.push(`${field}.${name} is missing`)
      } else if (!ok(value[name])) {
        fault(`${field}.${name}`, what)
      }
    }
  }
  function list(field, value, each) {
    if (!Array.isArray(value)) return fault(field, 'a list')
    value.forEach((item, n) => each(`${field}[${n}]`, item))
  }
  function seqs(field, value) {
    list(field, value, (name, item) => {
      if (!isSeq(item)) fault(name, 'a seq')
    })
    if (Array.isArray(value) && new Set(value).size !== value.length) problems.push(`${field} holds a seq twice`)
  }
  function ids(field, value) {
    list(field, value, (name, item) => {
      if (!isText(item)) fault(name, "a string that isn't empty")
    })
  }
  const retryEntry = (name, item) =>
    shape(name, item, {
      seq: [isSeq, 'a seq'],
      attempts: [isCount, 'a whole number, 0 or more'],
      due: [isTime, 'a UTC time to the second'],
      reason: [isText, "a string that isn't empty"],
    })
  function retries(field, value) {
    list(field, value, retryEntry)
    if (Array.isArray(value)) {
      const listed = value.map(item => item?.seq)
      if (new Set(listed).size !== listed.length) problems.push(`${field} holds a seq twice`)
    }
  }

  for (const name of Object.keys(state)) {
    if (!FIELDS.includes(name)) problems.push(`${name} is not a field of the state`)
  }
  for (const name of FIELDS) {
    if (state[name] === undefined && !['backfill', 'paused'].includes(name)) problems.push(`${name} is missing`)
  }

  // Every item waiting in a retry list has been given to the agent, so it is at or before its
  // lane's cursor: a run moves the cursor past its batch whether it succeeds or fails, and the
  // planner takes everything after the cursor as new.
  function behindCursor(field, value, cursor) {
    if (!Array.isArray(value) || !isCount(cursor)) return
    value.forEach((item, n) => {
      if (isSeq(item?.seq) && item.seq > cursor) problems.push(`${field}[${n}].seq is after the cursor`)
    })
  }

  if (state.cursor !== undefined && !isCount(state.cursor)) fault('cursor', 'a whole number, 0 or more')
  if (state.commandSeq !== undefined && !isCount(state.commandSeq)) fault('commandSeq', 'a whole number, 0 or more')
  if (state.retry !== undefined) {
    retries('retry', state.retry)
    behindCursor('retry', state.retry, state.cursor)
  }
  if (state.failed !== undefined) {
    list('failed', state.failed, (name, item) =>
      shape(name, item, { seq: [isSeq, 'a seq'], at: [isTime, 'a UTC time to the second'], reason: [isText, "a string that isn't empty"] }),
    )
  }
  if (state.session !== undefined && state.session !== null) {
    shape('session', state.session, { day: [isDate, 'a date such as 2026-11-09'], bump: [isCount, 'a whole number, 0 or more'] })
  }
  if (state.onceDone !== undefined) ids('onceDone', state.onceDone)
  if (state.backfillDone !== undefined) ids('backfillDone', state.backfillDone)
  if (state.backfill !== undefined) {
    shape('backfill', state.backfill, {
      id: [isText, "a string that isn't empty"],
      until: [isCount, 'a whole number, 0 or more'],
      cursor: [isCount, 'a whole number, 0 or more'],
      retry: [Array.isArray, 'a list'],
      skipped: [Array.isArray, 'a list'],
    })
    if (Array.isArray(state.backfill?.retry)) {
      retries('backfill.retry', state.backfill.retry)
      behindCursor('backfill.retry', state.backfill.retry, state.backfill.cursor)
    }
    if (Array.isArray(state.backfill?.skipped)) seqs('backfill.skipped', state.backfill.skipped)
  }
  if (state.scheduled !== undefined) {
    if (!isObject(state.scheduled)) fault('scheduled', 'an object')
    else {
      for (const [at, date] of Object.entries(state.scheduled)) {
        if (!isDate(date)) fault(`scheduled.${at}`, 'a date such as 2026-11-09')
      }
    }
  }
  if (state.lastRun !== undefined && state.lastRun !== null) {
    shape('lastRun', state.lastRun, {
      at: [isTime, 'a UTC time to the second'],
      ok: [value => typeof value === 'boolean', 'true or false'],
      seqs: [Array.isArray, 'a list'],
      durationMs: [isCount, 'a whole number, 0 or more'],
    })
    if (Array.isArray(state.lastRun?.seqs)) seqs('lastRun.seqs', state.lastRun.seqs)
  }
  if (state.paused !== undefined) {
    shape('paused', state.paused, {
      since: [isTime, 'a UTC time to the second'],
      cause: [value => PAUSE_CAUSES.includes(value), `one of ${PAUSE_CAUSES.join(', ')}`],
      reason: [isText, "a string that isn't empty"],
      next: [isTime, 'a UTC time to the second'],
      tries: [isSeq, 'a whole number, 1 or more'],
    })
  }
  return problems
}

// Something is wrong with a `state.json`. The message names the file and the fields.
export class AgentStateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AgentStateError'
  }
}

// Reads a `state.json`. Returns null when there is none, and throws an `AgentStateError` that
// names the file when it isn't a state. The file is written atomically, so a crash doesn't leave
// half of one.
export function readAgentState(file) {
  let state
  try {
    state = readJsonFile(file)
  } catch (error) {
    if (error instanceof SyntaxError) throw new AgentStateError(`${file} is not JSON`)
    throw error
  }
  if (state === undefined) return null
  const problems = checkAgentState(state)
  if (problems.length > 0) throw new AgentStateError(`${file}: ${problems.join('; ')}`)
  return state
}
