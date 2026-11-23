// `scooter backfill`: queues a job that runs an agent over history, and exits.
//
//   scooter backfill <agent> [--from <UTC date or seq>] [--skills <names>] [--writes <paths>]
//                            [--empty] [--hold-live] [--prompt <file>]
//   scooter backfill --agent-file <file> [--from <UTC date or seq>]
//
// It runs as the runner's user; in Docker, as `docker compose run --rm runner backfill …`. It reads
// `agents.yaml` and the datastore, checks its arguments against them, writes the job's file into
// the agent's folder, `agents/<agent>/jobs/<id>.json`, and exits. The running runner takes the job
// at its next look, with no restart (`backfill.mjs`). It changes nothing else, and takes no lock:
// a job's file is written whole or not at all, under a name no other has.
//
// - **An agent of `agents.yaml`** may be run with fewer skills, `--skills`, the names of some of
//   its skills, and narrower writes, `--writes`, paths in its own `writes`; and its runs given a
//   prompt of their own, `--prompt`, the text of a file, read now and kept in the job's file, in
//   place of the prompt of the agent's trigger for new messages. The agent's own prompt, which pi
//   appends to its system prompt, stays the agent's.
// - **An agent given in a file**, `--agent-file`, is one agent in the format of `agents.yaml`, its
//   paths of the config folder relative to the config folder, whose name is no agent's of
//   `agents.yaml`, which writes only in its own folder, `agents/<name>/`, sends nothing, and has a
//   trigger for new messages. The file's text is read now, and kept in the job's file. It brings
//   its own skills, writes and prompts, so it takes none of the flags but `--from`.
// - **`--from`** is a UTC date, the day folder a line was stored in, or a `seq`. A date is the first
//   line stored that day, or the first after it when no line was; a date with no line on or after
//   it, and a `seq` past the newest line, are refused. Without it, the job starts at the first line.
// - Each fault is reported at once, each on a line of its own, as `agents.yaml`'s are.
//
// Exit codes: 0 once the job is written; 2 for a call or a configuration it can't take; 1 when it
// fails otherwise, as on a datastore it can't read, or a job's file it can't write.

import fs from 'node:fs'
import path from 'node:path'
import { createIds, ensureDir, writeNewFile } from '../common/files.mjs'
import { instanceAnswers } from '../common/instance.mjs'
import { checkJob, jobFileName } from '../common/jobfile.mjs'
import { limits } from '../common/limits.mjs'
import { dayOfDate, makePaths } from '../common/paths.mjs'
import { isDate, isoSeconds, systemClock } from '../common/time.mjs'
import { ConfigError, checkJobWrites, jobPromptProblems, loadConfig, parseConfig } from './config.mjs'
import { openDatastore } from './datastore.mjs'

// A call or a configuration the command can't take: it exits with 2. `problems` are the lines it
// prints, each a fault.
export class BackfillError extends Error {
  constructor(problems) {
    super(problems.join('\n'))
    this.name = 'BackfillError'
    this.problems = problems
  }
}

const USAGE = [
  'scooter backfill <agent> [--from <UTC date or seq>] [--skills <names>] [--writes <paths>] [--empty] [--hold-live] [--prompt <file>]',
  'scooter backfill --agent-file <file> [--from <UTC date or seq>]',
]

// The flags, and how many values each takes: one, none, or one or more, up to the next flag.
const FLAGS = { '--from': 'one', '--skills': 'many', '--writes': 'many', '--empty': 'none', '--hold-live': 'none', '--prompt': 'one', '--agent-file': 'one' }

// The command line, read: `{ agent, from, skills, writes, empty, holdLive, prompt, agentFile }`,
// each null or false when it isn't given. Throws a `BackfillError` that names each fault.
export function parseArgs(args) {
  const problems = []
  const given = {}
  const names = []
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]
    if (!arg.startsWith('--')) {
      names.push(arg)
      continue
    }
    if (!Object.hasOwn(FLAGS, arg)) {
      problems.push(`${arg} is no flag of scooter backfill`)
      continue
    }
    if (Object.hasOwn(given, arg)) problems.push(`${arg} is given twice`)
    const values = []
    while (FLAGS[arg] !== 'none' && n + 1 < args.length && !args[n + 1].startsWith('--') && (FLAGS[arg] === 'many' || values.length === 0)) values.push(args[++n])
    if (FLAGS[arg] !== 'none' && values.length === 0) problems.push(`${arg} needs ${FLAGS[arg] === 'many' ? 'one value or more' : 'a value'}`)
    given[arg] = values
  }
  const one = flag => given[flag]?.[0] ?? null
  const read = {
    agent: names[0] ?? null,
    from: one('--from'),
    skills: given['--skills'] ?? null,
    writes: given['--writes'] ?? null,
    empty: Object.hasOwn(given, '--empty'),
    holdLive: Object.hasOwn(given, '--hold-live'),
    prompt: one('--prompt'),
    agentFile: one('--agent-file'),
  }
  if (read.agentFile !== null) {
    if (names.length > 0) problems.push(`with --agent-file, the agent is the file's: name no other, as ${names.join(' ')}`)
    for (const flag of ['--skills', '--writes', '--empty', '--hold-live', '--prompt']) {
      if (Object.hasOwn(given, flag)) problems.push(`${flag} can't go with --agent-file, whose file gives the agent's own skills, writes and prompts`)
    }
  } else if (names.length === 0) {
    problems.push('name the agent to run, such as lifelog, or give one in a file with --agent-file')
  } else if (names.length > 1) {
    problems.push(`name one agent; it was given ${names.join(' ')}`)
  }
  if (read.skills !== null) {
    const twice = read.skills.filter((name, n) => read.skills.indexOf(name) !== n)
    if (twice.length > 0) problems.push(`--skills names ${[...new Set(twice)].join(', ')} twice`)
  }
  if (problems.length > 0) throw new BackfillError(problems)
  return read
}

// The text of a file given on the command line: a regular file, once links are followed, of at
// most `maxBytes`, in UTF-8, without a byte-order mark at its start. `flag` names it in a fault.
function readGivenFile(file, { flag, maxBytes }) {
  const fault = what => new BackfillError([`${flag} ${file} ${what}`])
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    throw fault(`can't be read (${error.code ?? error.name})`)
  }
  if (!stat.isFile()) throw fault("isn't a file")
  if (stat.size > maxBytes) throw fault(`is ${stat.size} bytes, where it can be ${maxBytes} at most`)
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch (error) {
    throw fault(`can't be read (${error.code ?? error.name})`)
  }
  if (bytes.length > maxBytes) throw fault(`is more than ${maxBytes} bytes`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    throw fault("isn't text in UTF-8")
  }
}

// The first `seq` of the job: that of `--from`, or 1 without it. Throws a `BackfillError`.
export function resolveFrom(from, index) {
  if (from === null) return 1
  const newest = index.lastSeq === 0 ? 'the datastore holds no line yet' : `the newest line is #${index.lastSeq}, stored on ${index.newestDay.replaceAll('/', '-')}`
  if (/^[1-9][0-9]*$/.test(from)) {
    const seq = Number(from)
    if (!Number.isSafeInteger(seq) || seq > index.lastSeq) throw new BackfillError([`--from #${from} is past the newest line: ${newest}`])
    return seq
  }
  if (!isDate(from)) throw new BackfillError([`--from takes a UTC date, the day a line was stored, such as 2026-11-09, or a seq, such as 812; not ${from}`])
  const day = dayOfDate(from)
  for (const { line, day: stored } of index.entries()) {
    if (stored >= day) return line.seq
  }
  throw new BackfillError([`--from ${from}: no line was stored on or after it; ${newest}`])
}

// Writes `job` as the file `<id>.json` in `dir`, whole or not at all, and under a name no other
// file has (`writeNewFile`): a name taken, as by a command run in the same millisecond, gives the
// job the next ID. Returns the job, with the ID it got.
function writeJobFile(dir, ids, job) {
  for (let written = job; ; written = { ...written, id: ids.next() }) {
    try {
      writeNewFile(path.join(dir, jobFileName(written.id)), `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 })
      return written
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

// Queues the job a command line asks for. Returns `{ job, file, runner }`: the job written, its
// file, and whether a runner holds the data folder now. Throws a `ConfigError` for a bad
// `agents.yaml`, a `BackfillError` for a call it can't take, and anything else that stops it.
export async function queueJob({ args, settings, clock = systemClock }) {
  const given = parseArgs(args)
  const paths = makePaths(settings)
  const { agents } = loadConfig({ paths, settings })
  let agent
  let agentFile = null
  if (given.agentFile !== null) {
    agentFile = readGivenFile(given.agentFile, { flag: '--agent-file', maxBytes: limits.JOB_AGENT_FILE_MAX_BYTES })
    try {
      ;[agent] = parseConfig(agentFile, { configDir: paths.configDir, dataDir: paths.dataDir, settings, file: given.agentFile, agentFile: { taken: agents.map(other => other.name) } }).agents
    } catch (error) {
      if (error instanceof ConfigError) throw new BackfillError(error.problems.map(problem => problem.message))
      throw error
    }
  } else {
    agent = agents.find(candidate => candidate.name === given.agent)
    if (!agent) throw new BackfillError([`agents.yaml has no agent called ${given.agent}; it has ${agents.map(candidate => candidate.name).join(', ')}`])
  }

  const problems = []
  for (const name of given.skills ?? []) {
    if (!agent.skills.some(skill => skill.name === name)) problems.push(`--skills names ${name}, which is no skill of ${agent.name}: its skills are ${agent.skills.map(skill => skill.name).join(', ') || 'none'}`)
  }
  let writes = agent.writes
  if (given.writes !== null) {
    const checked = checkJobWrites(agent, given.writes, { dataDir: paths.dataDir })
    problems.push(...checked.problems)
    writes = checked.writes
  }
  let prompt = null
  if (given.prompt !== null) {
    prompt = readGivenFile(given.prompt, { flag: '--prompt', maxBytes: limits.PROMPT_MAX_BYTES })
    problems.push(...jobPromptProblems({ agent, template: prompt, writes, paths, settings }).map(what => `--prompt ${given.prompt} ${what}`))
  } else if (agentFile === null) {
    // The prompt of the agent's trigger for new messages was held to the agent's writes at the
    // start; the job's, if narrower, can make `$run.writes$` longer.
    for (const trigger of agent.run.newMessages) {
      for (const what of jobPromptProblems({ agent, template: trigger.prompt, writes, paths, settings })) {
        problems.push(`the prompt of the trigger for new messages from ${trigger.channels.join(' and ')}, given what --writes names, ${what}`)
      }
    }
  }
  if (problems.length > 0) throw new BackfillError(problems)

  const datastore = openDatastore({ paths, clock })
  datastore.poll()
  const from = resolveFrom(given.from, datastore.index)

  const ids = createIds(clock)
  const job = {
    id: ids.next(),
    agent: agent.name,
    written: isoSeconds(clock.now()),
    from,
    skills: given.skills,
    writes: given.writes === null ? null : writes,
    empty: given.empty,
    holdLive: given.holdLive,
    prompt,
    agentFile,
    progress: null,
  }
  const faults = checkJob(job)
  if (faults.length > 0) throw new Error(`not a job: ${faults.join('; ')}`)
  const dir = paths.agentJobs(agent.name)
  ensureDir(dir, { mode: 0o700 })
  const written = writeJobFile(dir, ids, job)
  return { job: written, file: path.join(dir, jobFileName(written.id)), runner: await instanceAnswers(paths.runnerSocket) }
}

// `scooter backfill`: queues the job, and says so on stdout. Exits with 0 once it is written, 2
// when it can't take how it was called or how Scooter is configured, and 1 when it fails.
export async function runBackfill({ args = [], settings, stdout, stderr, clock = systemClock }) {
  let queued
  try {
    queued = await queueJob({ args, settings, clock })
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BackfillError) {
      for (const line of error instanceof ConfigError ? error.problems.map(problem => problem.message) : error.problems) stderr.write(`scooter backfill: ${line}\n`)
      if (error instanceof BackfillError && args.length === 0) stderr.write(`Usage:\n${USAGE.map(line => `  ${line}\n`).join('')}`)
      return 2
    }
    // What can fail here names a file and a line of the datastore, or the job's file.
    stderr.write(`scooter backfill: ${error.message}\n`)
    return 1
  }
  const { job, file, runner } = queued
  stdout.write(`Queued backfill ${job.id} of ${job.agent}, from #${job.from}: ${file}\n`)
  stdout.write(runner ? 'The runner takes it at its next look. Remove the file to cancel it.\n' : "The runner isn't running: it takes it when it starts. Remove the file to cancel it.\n")
  return 0
}
