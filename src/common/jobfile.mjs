// A backfill's job file: what `scooter backfill` asks of the runner, and how far the runner has
// got with it. One file for each job, `agents/<agent>/jobs/<id>.json`, in the folder of the agent
// it runs, mode 0600:
//
//   {
//     "id": "20261123T101500123-0001",
//     "agent": "lifelog",
//     "written": "2026-11-23T10:15:00Z",
//     "from": 812,
//     "skills": ["books"],
//     "writes": ["agents/lifelog/views/books.csv"],
//     "empty": false,
//     "holdLive": false,
//     "prompt": null,
//     "agentFile": null,
//     "progress": {"started": "2026-11-23T10:15:03Z", "until": 1890, "cursor": 1203, "given": 391,
//                  "retry": [{"seq": 1201, "attempts": 1, "due": "2026-11-23T11:02:00Z", "reason": "not marked"}],
//                  "skipped": [1031], "wait": null}
//   }
//
// - `id`: the job's name, as `createIds` makes one, so the names sort in the order the jobs were
//   written. The file is named by it.
// - `agent`: the agent the job runs, whose folder the file is in.
// - `written`: when the command wrote it.
// - `from`: the first `seq` the job may give.
// - `skills`, `writes`: the agent's skills, by name, and paths of the data folder, that the job's
//   runs are given in place of the agent's own; null for the agent's own.
// - `empty`, `holdLive`: `--empty` and `--hold-live`.
// - `prompt`: the text the job's runs are given as their message, in place of the prompt of the
//   agent's trigger for new messages; null for that prompt.
// - `agentFile`: for an agent given in a file, the file's text, in the format of `agents.yaml`;
//   null for an agent of `agents.yaml`. Such a job has none of `skills`, `writes`, `prompt`,
//   `empty` and `holdLive`.
// - `progress`: null until the job has started. Then when it started, the `seq` it stops at, its
//   cursor, how many lines it has given, the lines to be tried again, and those it gave up on: the
//   lane its batches are drawn from, as the state's own is for live runs. And `wait`: null, or,
//   for an agent given in a file, while a setup error or an outage of its own holds the job back,
//   `{ since, cause, reason, next, tries }`, as the state's `paused` is; always null for an agent of
//   `agents.yaml`, whose failures pause every run.
//
// `scooter backfill` writes the file, and the runner alone changes it after that, atomically.
// `scooter status` reads it, which is why its format is here.
//
// Every field above is needed, of its form, and a fault names the field; a job of an agent given
// in a file has none of the others' flags. A field the runner doesn't know is ignored, at the top,
// in `progress`, in `wait` or in a retry, so that a file can hold more than this version
// reads, as long as what it needs is there.

import fs from 'node:fs'
import path from 'node:path'
import { PAUSE_CAUSES } from './agentstate.mjs'
import { checkOwnFolder, isId, readUntrustedFile } from './files.mjs'
import { limits } from './limits.mjs'
import { isAgentName } from './runnerstatus.mjs'
import { parseIsoSeconds } from './time.mjs'

const FIELDS = ['id', 'agent', 'written', 'from', 'skills', 'writes', 'empty', 'holdLive', 'prompt', 'agentFile', 'progress']
const PROGRESS_FIELDS = ['started', 'until', 'cursor', 'given', 'retry', 'skipped', 'wait']

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const isSeq = value => Number.isSafeInteger(value) && value >= 1
const isTime = value => parseIsoSeconds(value) !== null
const isText = value => typeof value === 'string' && value !== ''

// The name of a job's file, and the job's ID a file's name gives, or null when it isn't one.
export const jobFileName = id => `${id}.json`
export function jobIdOf(name) {
  const match = /^(.+)\.json$/.exec(name)
  return match && isId(match[1]) ? match[1] : null
}

// What is wrong with a job, as a list of statements that each name the field, such as
// `progress.retry[0].due must be a UTC time to the second`. An empty list means it is well formed.
// A field this version doesn't know isn't looked at: it is no fault.
export function checkJob(job) {
  if (!isObject(job)) return ['the job must be an object']
  const problems = []
  const fault = (field, what) => problems.push(`${field} must be ${what}`)
  for (const name of FIELDS) {
    if (job[name] === undefined) problems.push(`${name} is missing`)
  }
  if (job.id !== undefined && !(typeof job.id === 'string' && isId(job.id))) fault('id', 'an ID such as 20261123T101500123-0001')
  if (job.agent !== undefined && !(typeof job.agent === 'string' && isAgentName(job.agent))) fault('agent', "an agent's name, such as lifelog")
  if (job.written !== undefined && !isTime(job.written)) fault('written', 'a UTC time to the second')
  if (job.from !== undefined && !isSeq(job.from)) fault('from', 'a seq')
  for (const name of ['skills', 'writes']) {
    const value = job[name]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value) || value.length === 0 || !value.every(isText) || new Set(value).size !== value.length) {
      fault(name, 'null, or a list of names, each once')
    }
  }
  for (const name of ['empty', 'holdLive']) {
    if (job[name] !== undefined && typeof job[name] !== 'boolean') fault(name, 'true or false')
  }
  for (const name of ['prompt', 'agentFile']) {
    if (job[name] !== undefined && job[name] !== null && !isText(job[name])) fault(name, "null, or a string that isn't empty")
  }
  // An agent given in a file brings its own skills, writes and prompts, and never holds live runs
  // back.
  if (isText(job.agentFile)) {
    for (const name of ['skills', 'writes', 'prompt']) {
      if (job[name] !== undefined && job[name] !== null) fault(name, 'null for an agent given in a file')
    }
    for (const name of ['empty', 'holdLive']) {
      if (job[name] === true) fault(name, 'false for an agent given in a file')
    }
  }

  const progress = job.progress
  if (progress !== undefined && progress !== null) {
    if (!isObject(progress)) fault('progress', 'null, or an object')
    else {
      for (const name of PROGRESS_FIELDS) {
        if (progress[name] === undefined) problems.push(`progress.${name} is missing`)
      }
      if (progress.started !== undefined && !isTime(progress.started)) fault('progress.started', 'a UTC time to the second')
      for (const name of ['until', 'cursor', 'given']) {
        if (progress[name] !== undefined && !isCount(progress[name])) fault(`progress.${name}`, 'a whole number, 0 or more')
      }
      problems.push(...retryProblems('progress.retry', progress.retry, progress.cursor))
      if (progress.skipped !== undefined) {
        if (!Array.isArray(progress.skipped) || !progress.skipped.every(isSeq)) fault('progress.skipped', 'a list of seqs')
        else if (new Set(progress.skipped).size !== progress.skipped.length) problems.push('progress.skipped holds a seq twice')
      }
      if (progress.wait !== undefined && progress.wait !== null) {
        // Only the job of an agent given in a file waits on its own; another's failures pause
        // every run (`run.mjs`).
        if (job.agentFile === null) fault('progress.wait', 'null for an agent of agents.yaml, whose failures pause every run')
        else problems.push(...waitProblems('progress.wait', progress.wait))
      }
    }
  }
  return problems
}

// What is wrong with an object's fields: `tests` gives each field the object needs, with its test
// and what it must be. A field it doesn't give is no fault.
function fieldProblems(field, value, tests) {
  if (!isObject(value)) return [`${field} must be an object`]
  const problems = []
  for (const [name, [ok, what]] of Object.entries(tests)) {
    if (value[name] === undefined) problems.push(`${field}.${name} is missing`)
    else if (!ok(value[name])) problems.push(`${field}.${name} must be ${what}`)
  }
  return problems
}

const RETRY = {
  seq: [isSeq, 'a seq'],
  attempts: [isCount, 'a whole number, 0 or more'],
  due: [isTime, 'a UTC time to the second'],
  reason: [isText, "a string that isn't empty"],
}

// What is wrong with a list of lines to be tried again: each `{ seq, attempts, due, reason }`, each
// `seq` once, and each at or before the lane's `cursor`, since a run moves the cursor past its
// batch whether it succeeds or fails.
function retryProblems(field, value, cursor) {
  if (value === undefined) return []
  if (!Array.isArray(value)) return [`${field} must be a list`]
  const problems = []
  value.forEach((item, n) => {
    const name = `${field}[${n}]`
    problems.push(...fieldProblems(name, item, RETRY))
    if (isObject(item) && isSeq(item.seq) && isCount(cursor) && item.seq > cursor) problems.push(`${name}.seq is after the cursor`)
  })
  const seqs = value.map(item => item?.seq)
  if (new Set(seqs).size !== seqs.length) problems.push(`${field} holds a seq twice`)
  return problems
}

// What is wrong with a job's wait, as with the state's `paused` (`agentstate.mjs`).
function waitProblems(field, value) {
  return fieldProblems(field, value, {
    since: [isTime, 'a UTC time to the second'],
    cause: [cause => PAUSE_CAUSES.includes(cause), `one of ${PAUSE_CAUSES.join(', ')}`],
    reason: [isText, "a string that isn't empty"],
    next: [isTime, 'a UTC time to the second'],
    tries: [isSeq, 'a whole number, 1 or more'],
  })
}

// Something is wrong with a job's file. The message names the file and the fields.
export class JobError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JobError'
  }
}

// Reads the job in `file`, whose name gives its ID, in the folder of the agent `agent`. Returns
// `{ job, text }`, the job and the file's text. Throws a `JobError` that names the file when it
// isn't a job (`checkJob`: a field it needs missing or of another form), or isn't the job its name
// and its folder say, and the error of the read, such as `ENOENT`, when it can't be read. Fields
// it doesn't know are left in the job as they are: nothing acts on them, and the runner's saves
// keep those at the top and in `progress`. It is read as a file another user controls, whoever
// reads it (`readUntrustedFile`): without following a link, without waiting on a FIFO, only if it
// is a regular file with one name, and up to `JOB_FILE_MAX_BYTES`. So nothing in the jobs' folder
// can stop the runner, or have root, running `scooter status`, read another file.
export function readJob(file, { agent }) {
  const text = readUntrustedFile(file, { maxBytes: limits.JOB_FILE_MAX_BYTES })
  let job
  try {
    job = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new JobError(`${file} is not JSON`)
    throw error
  }
  const problems = checkJob(job)
  if (problems.length === 0 && job.id !== jobIdOf(path.basename(file))) problems.push(`id is ${job.id}, where the file's name gives another`)
  if (problems.length === 0 && job.agent !== agent) problems.push(`agent is ${job.agent}, where the file is in the folder of ${agent}`)
  if (problems.length > 0) throw new JobError(`${file}: ${problems.join('; ')}`)
  return { job, text }
}

// Every name in the jobs' folders of the agents' folders, oldest first: `[{ agent, name, file, id }]`,
// `id` being null for a name that isn't a job's, which is no job. Names that start with a dot,
// the temporary files of an atomic write among them, aren't listed. A folder is used only while it
// is a folder and not a link (`checkOwnFolder`), and an agent's folder only when its name is one
// an agent can have: `agents/.discarded/` is the runner's own. An agent's folder, or its jobs'
// folder, that isn't there, is a link or a file, or can't be read, holds no job; `agents/` itself
// that is a link or a file throws `EUNTRUSTED`. Oldest first is by ID, which is the time the job
// was written, and then by agent.
export function listJobFiles(paths) {
  const found = []
  for (const agent of folderNames(paths.agents)) {
    if (!isAgentName(agent)) continue
    try {
      checkOwnFolder(paths.agentDir(agent))
    } catch (error) {
      if (PASSED_OVER.includes(error.code)) continue
      throw error
    }
    for (const name of folderNames(paths.agentJobs(agent), { passOver: true })) {
      found.push({ agent, name, file: path.join(paths.agentJobs(agent), name), id: jobIdOf(name) })
    }
  }
  const key = entry => entry.id ?? entry.name
  return found.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0))
}

// Why a folder an agent's jobs could be in is passed over: it isn't there, it is a link or a file,
// or it can't be read. So no folder of the runner's user's making can stop the runner.
const PASSED_OVER = ['ENOENT', 'EUNTRUSTED', 'EACCES', 'ENOTDIR']

// The names in a folder of the runner's, but those that start with a dot, or none when it isn't
// there, or, with `passOver`, for any reason of `PASSED_OVER`. It is used only while it is a folder
// and not a link.
function folderNames(dir, { passOver = false } = {}) {
  try {
    checkOwnFolder(dir)
    return fs.readdirSync(dir).filter(name => !name.startsWith('.'))
  } catch (error) {
    if (error.code === 'ENOENT' || (passOver && PASSED_OVER.includes(error.code))) return []
    throw error
  }
}
