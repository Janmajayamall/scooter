// A job's file of `scooter backfill` (`src/common/jobfile.mjs`), as the command, the runner and
// `scooter status` read it: the example of its document; each field it needs, of its form, a fault
// naming the field; a field it doesn't know, ignored; and what `readJob` refuses besides: a file
// that isn't JSON, one whose name or folder isn't the job's, and one that isn't a file to read.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { JobError, checkJob, readJob } from '../src/common/jobfile.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const REPO = path.resolve(import.meta.dirname, '..')

// The example of `docs/architecture/backfill.md`, under The job's file, as the document gives it.
function documentExample() {
  const text = fs.readFileSync(path.join(REPO, 'docs', 'architecture', 'backfill.md'), 'utf8')
  const section = text.slice(text.indexOf("## The job's file"))
  return JSON.parse(/```json\n([\s\S]*?)```/.exec(section)[1])
}

const EXAMPLE = documentExample()
const AGENT_FILE = 'agents:\n  lifelog-try: {}\n'
// A job of an agent given in a file, started, and waiting after a setup error of its own.
const WAITING = {
  ...EXAMPLE,
  agent: 'lifelog-try',
  skills: null,
  writes: null,
  agentFile: AGENT_FILE,
  progress: { ...EXAMPLE.progress, wait: { since: '2026-11-23T11:00:00Z', cause: 'setup', reason: 'OpenRouter answered 403', next: '2026-11-23T11:30:00Z', tries: 1 } },
}

const without = (object, name) => Object.fromEntries(Object.entries(object).filter(([key]) => key !== name))
const withProgress = changes => ({ ...EXAMPLE, progress: { ...EXAMPLE.progress, ...changes } })
const withRetry = changes => withProgress({ retry: [{ ...EXAMPLE.progress.retry[0], ...changes }] })
const withWait = wait => ({ ...WAITING, progress: { ...WAITING.progress, wait } })

test("job file: the document's example is a job, not started or started, and one that waits", () => {
  assert.equal(EXAMPLE.id, '20261123T101500123-0001')
  assert.deepEqual(checkJob(EXAMPLE), [])
  assert.deepEqual(checkJob({ ...EXAMPLE, progress: null }), [])
  assert.deepEqual(checkJob(WAITING), [])
  assert.deepEqual(checkJob({ ...EXAMPLE, skills: null, writes: null, empty: true, holdLive: true, prompt: '# Books\n$run.writes$\n' }), [])
})

test("job file: a field the runner doesn't know is ignored, at the top, in progress, in a retry and in a wait, and readJob keeps it as it is", t => {
  const job = {
    ...WAITING,
    later: { anything: [1, 2] },
    progress: {
      ...WAITING.progress,
      notes: 'x',
      retry: [{ ...WAITING.progress.retry[0], tried: ['2026-11-23T11:00:00Z'] }],
      wait: { ...WAITING.progress.wait, model: 'anthropic/claude-opus-5.5' },
    },
  }
  assert.deepEqual(checkJob(job), [])
  // The field's own name doesn't matter, one of Object's among them.
  assert.deepEqual(checkJob(JSON.parse(`{"__proto__": {"id": 1}, "constructor": 1, ${JSON.stringify(EXAMPLE).slice(1)}`)), [])
  const dir = path.join(makeTestDir(t), 'lifelog-try', 'jobs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${job.id}.json`)
  fs.writeFileSync(file, JSON.stringify(job))
  assert.deepEqual(readJob(file, { agent: 'lifelog-try' }).job, job)
})

test('job file: each field a job needs, missing or of another form, is a fault that names it', () => {
  for (const value of [null, [], 'job', 3]) assert.deepEqual(checkJob(value), ['the job must be an object'])
  for (const name of ['id', 'agent', 'written', 'from', 'skills', 'writes', 'empty', 'holdLive', 'prompt', 'agentFile', 'progress']) {
    assert.deepEqual(checkJob(without(EXAMPLE, name)), [`${name} is missing`], name)
  }
  const cases = [
    [{ id: 'people-1' }, 'id must be an ID such as 20261123T101500123-0001'],
    [{ id: 20261123 }, 'id must be an ID such as 20261123T101500123-0001'],
    [{ agent: 'Life Log' }, "agent must be an agent's name, such as lifelog"],
    [{ agent: null }, "agent must be an agent's name, such as lifelog"],
    [{ written: '2026-11-23' }, 'written must be a UTC time to the second'],
    [{ from: 0 }, 'from must be a seq'],
    [{ from: '812' }, 'from must be a seq'],
    [{ from: 8.5 }, 'from must be a seq'],
    [{ skills: [] }, 'skills must be null, or a list of names, each once'],
    [{ skills: 'books' }, 'skills must be null, or a list of names, each once'],
    [{ skills: ['books', 'books'] }, 'skills must be null, or a list of names, each once'],
    [{ skills: [''] }, 'skills must be null, or a list of names, each once'],
    [{ writes: [3] }, 'writes must be null, or a list of names, each once'],
    [{ empty: 'no' }, 'empty must be true or false'],
    [{ holdLive: null }, 'holdLive must be true or false'],
    [{ prompt: '' }, "prompt must be null, or a string that isn't empty"],
    [{ prompt: ['a'] }, "prompt must be null, or a string that isn't empty"],
    [{ agentFile: '' }, "agentFile must be null, or a string that isn't empty"],
    [{ progress: [] }, 'progress must be null, or an object'],
    [{ progress: 'started' }, 'progress must be null, or an object'],
  ]
  for (const [changes, fault] of cases) assert.deepEqual(checkJob({ ...EXAMPLE, ...changes }), [fault], JSON.stringify(changes))
  // Each fault is named, all at once.
  assert.deepEqual(checkJob({ ...without(EXAMPLE, 'written'), from: 0, empty: 1 }), ['written is missing', 'from must be a seq', 'empty must be true or false'])
})

test('job file: an agent given in a file has none of the flags of an agent of agents.yaml', () => {
  const given = { ...EXAMPLE, agent: 'lifelog-try', skills: null, writes: null, agentFile: AGENT_FILE }
  assert.deepEqual(checkJob(given), [])
  assert.deepEqual(checkJob({ ...given, skills: ['books'] }), ['skills must be null for an agent given in a file'])
  assert.deepEqual(checkJob({ ...given, writes: ['agents/lifelog-try/views/'] }), ['writes must be null for an agent given in a file'])
  assert.deepEqual(checkJob({ ...given, prompt: 'Now: $now$' }), ['prompt must be null for an agent given in a file'])
  assert.deepEqual(checkJob({ ...given, empty: true }), ['empty must be false for an agent given in a file'])
  assert.deepEqual(checkJob({ ...given, holdLive: true }), ['holdLive must be false for an agent given in a file'])
})

test("job file: each field of a started job's progress, of a retry and of a wait, missing or of another form, is a fault that names it", () => {
  for (const name of ['started', 'until', 'cursor', 'given', 'retry', 'skipped', 'wait']) {
    assert.deepEqual(checkJob({ ...EXAMPLE, progress: without(EXAMPLE.progress, name) }), [`progress.${name} is missing`], name)
  }
  const progress = [
    [{ started: 'now' }, 'progress.started must be a UTC time to the second'],
    [{ until: -1 }, 'progress.until must be a whole number, 0 or more'],
    [{ until: '1890' }, 'progress.until must be a whole number, 0 or more'],
    [{ cursor: 1203.5 }, 'progress.cursor must be a whole number, 0 or more'],
    [{ given: null }, 'progress.given must be a whole number, 0 or more'],
    [{ retry: {} }, 'progress.retry must be a list'],
    [{ retry: ['1201'] }, 'progress.retry[0] must be an object'],
    [{ skipped: 1031 }, 'progress.skipped must be a list of seqs'],
    [{ skipped: [0] }, 'progress.skipped must be a list of seqs'],
    [{ skipped: [1031, 1031] }, 'progress.skipped holds a seq twice'],
    [{ wait: 'setup' }, 'progress.wait must be null for an agent of agents.yaml, whose failures pause every run'],
  ]
  for (const [changes, fault] of progress) assert.deepEqual(checkJob(withProgress(changes)), [fault], JSON.stringify(changes))

  for (const name of ['seq', 'attempts', 'due', 'reason']) {
    assert.deepEqual(checkJob(withProgress({ retry: [without(EXAMPLE.progress.retry[0], name)] })), [`progress.retry[0].${name} is missing`], name)
  }
  const retry = [
    [{ seq: 0 }, 'progress.retry[0].seq must be a seq'],
    [{ seq: 1204 }, 'progress.retry[0].seq is after the cursor'],
    [{ attempts: -1 }, 'progress.retry[0].attempts must be a whole number, 0 or more'],
    [{ attempts: '1' }, 'progress.retry[0].attempts must be a whole number, 0 or more'],
    [{ due: '2026-11-23T11:02Z' }, 'progress.retry[0].due must be a UTC time to the second'],
    [{ reason: '' }, "progress.retry[0].reason must be a string that isn't empty"],
    [{ reason: 4 }, "progress.retry[0].reason must be a string that isn't empty"],
  ]
  for (const [changes, fault] of retry) assert.deepEqual(checkJob(withRetry(changes)), [fault], JSON.stringify(changes))
  const twice = EXAMPLE.progress.retry[0]
  assert.deepEqual(checkJob(withProgress({ retry: [twice, twice] })), ['progress.retry holds a seq twice'])

  for (const name of ['since', 'cause', 'reason', 'next', 'tries']) {
    assert.deepEqual(checkJob(withWait(without(WAITING.progress.wait, name))), [`progress.wait.${name} is missing`], name)
  }
  const wait = [
    [{ since: 1 }, 'progress.wait.since must be a UTC time to the second'],
    [{ cause: 'other' }, 'progress.wait.cause must be one of setup, outage'],
    [{ reason: '' }, "progress.wait.reason must be a string that isn't empty"],
    [{ next: '2026-11-23' }, 'progress.wait.next must be a UTC time to the second'],
    [{ tries: 0 }, 'progress.wait.tries must be a whole number, 1 or more'],
  ]
  for (const [changes, fault] of wait) assert.deepEqual(checkJob(withWait({ ...WAITING.progress.wait, ...changes })), [fault], JSON.stringify(changes))
  assert.deepEqual(checkJob(withWait([])), ['progress.wait must be an object'])
  // An agent of agents.yaml never waits on its own: its failures pause every run.
  assert.deepEqual(checkJob(withProgress({ wait: WAITING.progress.wait })), ['progress.wait must be null for an agent of agents.yaml, whose failures pause every run'])
})

test("job file: readJob refuses a file that isn't JSON, isn't a job, or isn't the job its name and its folder say, and one that isn't a file to read, naming the file", t => {
  const root = makeTestDir(t)
  const dir = path.join(root, 'lifelog', 'jobs')
  fs.mkdirSync(dir, { recursive: true })
  const named = id => path.join(dir, `${id}.json`)
  const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  const refused = (file, message, agent = 'lifelog') =>
    assert.throws(
      () => readJob(file, { agent }),
      error => {
        assert.ok(error instanceof JobError, error.stack)
        assert.equal(error.message, message)
        return true
      },
    )

  const file = named(EXAMPLE.id)
  write(file, EXAMPLE)
  assert.deepEqual(readJob(file, { agent: 'lifelog' }), { job: EXAMPLE, text: JSON.stringify(EXAMPLE) })
  write(file, '{"id": ')
  refused(file, `${file} is not JSON`)
  write(file, { ...EXAMPLE, from: 0, progress: { ...EXAMPLE.progress, skipped: 'none' } })
  refused(file, `${file}: from must be a seq; progress.skipped must be a list of seqs`)
  write(file, { ...EXAMPLE, id: '20261123T101500123-0002' })
  refused(file, `${file}: id is 20261123T101500123-0002, where the file's name gives another`)
  const other = path.join(dir, 'job.json')
  write(other, EXAMPLE)
  refused(other, `${other}: id is ${EXAMPLE.id}, where the file's name gives another`)
  write(file, EXAMPLE)
  refused(file, `${file}: agent is lifelog, where the file is in the folder of lifelog-try`, 'lifelog-try')

  // What isn't a file to read: the error of the read, which names no field.
  const code = target => {
    try {
      readJob(target, { agent: 'lifelog' })
    } catch (error) {
      return error.code
    }
    return null
  }
  assert.equal(code(named('20261123T101500123-0009')), 'ENOENT')
  const link = named('20261123T101500123-0003')
  fs.symlinkSync(file, link)
  assert.equal(code(link), 'EUNTRUSTED')
  const folder = named('20261123T101500123-0004')
  fs.mkdirSync(folder)
  assert.equal(code(folder), 'EUNTRUSTED')
  const fifo = named('20261123T101500123-0005')
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
  assert.equal(code(fifo), 'EUNTRUSTED')
  const twice = named('20261123T101500123-0006')
  fs.linkSync(file, twice)
  assert.equal(code(twice), 'EUNTRUSTED')
  fs.rmSync(twice)
  atEnd(t, overrideLimits({ JOB_FILE_MAX_BYTES: 64 }))
  assert.equal(code(file), 'EFBIG')
})
