// Jobs of `scooter backfill`, as the runner runs them: the datastore's history given to an agent
// again, as it usually runs, from the first line or from a chosen point, without sending anything.
//
// - **One at a time, oldest first.** At each round the runner looks at the jobs' folders of the
//   agents' folders (`listJobFiles`). It holds one job at a time, the oldest, of whichever agent,
//   and takes the next only once the one it holds is over: finished, or cancelled by removing its
//   file. A job's file is read as the runner reads its own state, strictly (`readJob`), and checked
//   against `agents.yaml` as `scooter backfill` checked it; a file that isn't one, or a job that
//   can't run as the config is now, is refused and logged, once while it stays as it is, and the
//   runner goes on with the next.
// - **An agent given in a file** (`--agent-file`) has a folder of its own, which the runner readies
//   when it takes the job, as a start readies the agent's: made if it is new, git's leftover locks
//   removed, and what a run cut short left thrown away.
// - **Its start** (`startJob`), holding `run.lock`: the agent's last commit is tagged
//   `before-backfill-<id>`, with the job's arguments and its prompt as the tag's message, unless a
//   start cut short made the tag already; with `--empty`, what the job's `writes` names in the
//   agent's folder is emptied and that is committed; then the job's progress is saved, with
//   `until`, where it stops: the agent's position, its cursor, for an agent of `agents.yaml`, and
//   the newest line for an agent given in a file. A crash before that save does the start again:
//   the tag stays where it was, before anything the job changed, emptying again changes nothing
//   that needs keeping, and `until` is taken again, so the lines a live run handled meanwhile are
//   the job's too.
// - **Its batches** are replayed (`replay.mjs`), drawn from its own lane, which its file keeps:
//   one of the owner's days each, `$now$` the time of the batch's newest item, a session of its own
//   for each day, the job's skills, `writes` and prompt. A batch's outcome settles the lane as a
//   live one's settles the live lane (`settleLane`), with what it gave up on in `skipped`. Its
//   failures send no notice and leave `lastRun` alone; a setup error or an outage pauses every run.
// - **When it has finished** (`finishJob`), its cursor at `until` and nothing left to try again, the
//   owner gets one message, which says how many lines the job was given and which it gave up on.
//   Then its file goes, and its sessions. The message is written before the file goes, so a crash
//   between the two sends it twice and never loses it.
// - **Cancelled** by removing its file: the runner drops what it holds of the job at its next look,
//   and its sessions go. Its tag and its commits stay. Sessions of a job whose file went while the
//   runner was stopped go at its next start (`sweepJobSessions`).
//
// The runner alone changes a job's file once the command has written it. Before it saves the
// progress, it looks at the file: gone, the job was cancelled, and it stays gone; something else
// than a file in its place is no job any more, and is left alone; a file that isn't what the runner
// last wrote or read is written over, and that is logged. So the job's lines are given by the
// runner's own count, once each.

import fs from 'node:fs'
import path from 'node:path'
import { emptyFolder, readUntrustedFile, removeTree, writeFileAtomic } from '../common/files.mjs'
import { JobError, listJobFiles, readJob } from '../common/jobfile.mjs'
import { isAgentName } from '../common/runnerstatus.mjs'
import { limits } from '../common/limits.mjs'
import { releaseLock } from '../common/locks.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { isoSeconds } from '../common/time.mjs'
import { ConfigError, checkJobWrites, jobPromptProblems, parseConfig, repositoryPaths } from './config.mjs'
import { settleLane } from './failures.mjs'
import { createGit, wayIsOpen } from './git.mjs'
import { ensureAgentDir } from './agentdir.mjs'
import { buildReplayBatch, removeJobSessions, replaySessionId } from './replay.mjs'
import { acquireRunLock } from './run.mjs'

const MINUTE = 60 * 1000

// The tag of the agent's last commit before the job `id` changed anything.
export const jobTag = id => `before-backfill-${id}`

// A job's lane, as `batch.mjs` draws batches from one: `skipped` takes the place of `failed`.
export function jobLane(progress) {
  return { cursor: progress.cursor, retry: progress.retry, failed: progress.skipped.map(seq => ({ seq })) }
}

// The job's progress after a batch: its lane settled as a live one is (`settleLane`), with what was
// given up on in `skipped`, and the lines given for the first time counted. Returns
// `{ progress, givenUp }`.
export function settleJobBatch(progress, batch, outcome, { now }) {
  const { lane, givenUp } = settleLane(jobLane(progress), batch, outcome, { now })
  const skipped = [...new Set(lane.failed.map(entry => entry.seq))]
  const given = progress.given + batch.items.filter(item => item.origin === 'new').length
  return { progress: { ...progress, cursor: lane.cursor, given, retry: lane.retry, skipped }, givenUp }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const seqList = seqs => {
  const named = [...seqs].sort((a, b) => a - b).map(seq => `#${seq}`)
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
}

// The message a job sends when it has finished: "Backfill 20261123T101500123-0001 of lifelog
// finished: it was given 143 lines, and gave up on #1031 and #1207."
export function jobSummary(job) {
  const { given, skipped } = job.progress
  return `Backfill ${job.id} of ${job.agent} finished: it was given ${plural(given, 'line')}, and gave up on ${skipped.length === 0 ? 'none' : seqList(skipped)}.`
}

// The message of the job's tag: what it was asked, and the prompt its runs are given, before its
// variables are filled in, which nothing else keeps once the job is over.
export function tagMessage(job) {
  const lines = [`Before backfill ${job.id} of ${job.agent}, written ${job.written}.`, '', `From: #${job.from}`]
  if (job.agentFile !== null) return [...lines, '', 'The agent, as given in its file:', '', job.agentFile].join('\n')
  lines.push(
    `Skills: ${job.skills === null ? "the agent's" : job.skills.join(' ')}`,
    `Writes: ${job.writes === null ? "the agent's" : job.writes.join(' ')}`,
    `Empty: ${job.empty ? 'yes' : 'no'}`,
    `Hold live: ${job.holdLive ? 'yes' : 'no'}`,
  )
  if (job.prompt === null) return [...lines, "Prompt: that of the agent's trigger for new messages, in agents.yaml", ''].join('\n')
  return [...lines, '', 'Prompt:', '', job.prompt].join('\n')
}

// Empties what `entries`, entries of the repository as `repositoryPaths` gives them, name in the
// folder `dir`: a folder of its files, and a file removed. An entry whose way is blocked is passed
// over (`wayIsOpen`), and so is one that isn't there.
function emptyEntries(dir, entries) {
  for (const entry of entries) {
    if (!wayIsOpen(dir, entry)) continue
    const full = path.join(dir, entry)
    try {
      if (entry.endsWith('/') && fs.lstatSync(full).isDirectory()) emptyFolder(full)
      else removeTree(full)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

// The runner's jobs. `agent` and `git` are the runner's agent, of `agents.yaml`, and git for its
// folder; `paths`, `settings`, `proc`, `log`, `clock` the runner's. Returns:
//
// - `poll()`: looks at the jobs' folders: drops the job it holds when its file is gone, and takes
//   the oldest when it holds none. Returns what the planner needs of the job it holds
//   (`nextAction`), or null.
// - `start({ state, index })`: the held job's start. Returns `{ outcome }`: `started`, or
//   `waiting` with `why` when a backup or another holds the locks, and nothing was done.
// - `batch({ index, now })`: the next batch of the held job, as `performRun` takes it, with the
//   agent and git it runs with, `{ job, agent, git }`; or null when there is nothing to give now.
// - `finish({ ids })`: the held job's message, then its file and its sessions go.
export function createJobs({ agent: own, git: ownGit, paths, settings, proc, log, clock }) {
  // The job held: `{ id, file, job, text, agent, git, skills, writes, template }`, `job` being the
  // file as the runner last wrote or read it, and `text` that file's text.
  let held = null
  // The files refused, by path, with what they were when refused, so each is logged once while it
  // stays as it is.
  const refused = new Map()

  sweepJobSessions()

  // Removes, in each agent's folder, the sessions of a job whose file is gone: one cancelled, or
  // finished, while the runner was stopped, or by a crash between its file and its sessions.
  function sweepJobSessions() {
    const jobs = new Set(listJobFiles(paths).map(entry => `${entry.agent}/${entry.id}`))
    for (const name of agentFolders()) {
      const sessions = removeJobSessions({ paths, agentName: name, isOver: id => !jobs.has(`${name}/${id}`), log })
      if (sessions > 0) log.info('runner.job_sessions_removed', { agent: name, sessions })
    }
  }

  function agentFolders() {
    try {
      return fs.readdirSync(paths.agents).filter(isAgentName)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  function refuse(entry, error) {
    let mark = 'gone'
    try {
      const stat = fs.lstatSync(entry.file)
      mark = `${stat.ino}:${stat.ctimeMs}:${stat.size}`
    } catch {}
    if (refused.get(entry.file) === mark) return
    refused.set(entry.file, mark)
    log.warn('runner.job_refused', { agent: entry.agent, file: entry.name, reason: error.message })
  }

  // The job of the entry `entry` of `listJobFiles`, as the runner would hold it, or throws why it
  // can't be run as the config is now: a `JobError`, or the error of the read, such as `EUNTRUSTED`
  // for a link, or `EACCES`.
  function check(entry) {
    if (entry.id === null) throw new JobError(`${entry.file} is named as no job is: a job's file is <ID>.json`)
    const { job, text } = readJob(entry.file, { agent: entry.agent })
    let agent = own
    if (job.agentFile !== null) {
      try {
        ;[agent] = parseConfig(job.agentFile, { configDir: paths.configDir, dataDir: paths.dataDir, settings, file: `${entry.file}, its agentFile`, agentFile: { taken: [own.name] } }).agents
      } catch (error) {
        if (error instanceof ConfigError) throw new JobError(error.message.replaceAll('\n', '; '))
        throw error
      }
      if (agent.name !== job.agent) throw new JobError(`${entry.file}: its agentFile gives ${agent.name}, where the job is of ${job.agent}`)
    } else if (job.agent !== own.name) {
      throw new JobError(`${entry.file}: ${job.agent} is no agent of agents.yaml, which has ${own.name}`)
    }
    const problems = []
    const skills = job.skills === null ? agent.skills : job.skills.map(name => agent.skills.find(skill => skill.name === name) ?? name)
    for (const name of skills.filter(skill => typeof skill === 'string')) problems.push(`skills names ${name}, which is no skill of ${agent.name}`)
    let writes = agent.writes
    if (job.writes !== null) {
      const checked = checkJobWrites(agent, job.writes, { dataDir: paths.dataDir })
      problems.push(...checked.problems)
      writes = checked.writes
    }
    const templates = job.prompt === null ? agent.run.newMessages.map(trigger => trigger.prompt) : [job.prompt]
    for (const template of templates) problems.push(...jobPromptProblems({ agent, template, writes, paths, settings }).map(what => `its prompt ${what}`))
    if (problems.length > 0) throw new JobError(`${entry.file}: ${problems.join('; ')}`)
    return { id: job.id, file: entry.file, job, text, agent, git: ownGit, skills, writes, template: job.prompt }
  }

  // Readies the folder of an agent given in a file, as a start readies the agent's
  // (`readyAgentFolder` in `main.mjs`), and returns the job with git for it.
  async function ready(taken) {
    if (taken.agent === own) return taken
    const { agent } = taken
    const git = createGit({ proc, dir: paths.agentDir(agent.name), entries: agent.repository, discardDir: paths.agentDiscarded(agent.name), log, clock })
    await ensureAgentDir({ paths, name: agent.name, git, log })
    await git.discardChanges()
    return { ...taken, git }
  }

  // Writes the held job's progress to its file, unless the job is over: it returns false when the
  // file is gone, cancelled, or is something else than a file now, and the job is dropped.
  function save(progress) {
    const next = { ...held.job, progress }
    const text = `${JSON.stringify(next, null, 2)}\n`
    // Only a job that gave up on more than a million lines comes near it. It is refused before
    // anything is written, as `saveState` refuses a state that isn't one, rather than leave a
    // file the runner would refuse to read back.
    if (Buffer.byteLength(text) > limits.JOB_FILE_MAX_BYTES) throw new Error(`the job ${held.id} would be more than ${limits.JOB_FILE_MAX_BYTES} bytes`)
    let stat = null
    try {
      stat = fs.lstatSync(held.file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (stat === null || !stat.isFile()) {
      drop(stat === null ? 'runner.job_cancelled' : 'runner.job_replaced')
      return false
    }
    let onDisk = null
    try {
      onDisk = readUntrustedFile(held.file, { maxBytes: limits.JOB_FILE_MAX_BYTES })
    } catch {}
    if (onDisk !== held.text) log.warn('runner.job_rewritten', { agent: held.agent.name, job: held.id })
    writeFileAtomic(held.file, text, { mode: 0o600 })
    held = { ...held, job: next, text }
    return true
  }

  // Lets go of the held job, and removes its sessions. Returns how many went.
  function release() {
    const { id, agent } = held
    held = null
    return removeJobSessions({ paths, agentName: agent.name, isOver: job => job === id, log })
  }

  // Lets go of the held job, which is over without finishing, and logs `event`.
  function drop(event) {
    const { id, agent } = held
    log.info(event, { agent: agent.name, job: id, sessions: release() })
  }

  return {
    get held() {
      return held
    },

    async poll() {
      const entries = listJobFiles(paths)
      if (held !== null && !entries.some(entry => entry.file === held.file)) drop('runner.job_cancelled')
      for (const entry of held === null ? entries : []) {
        let taken
        try {
          taken = check(entry)
        } catch (error) {
          refuse(entry, error)
          continue
        }
        refused.delete(entry.file)
        held = await ready(taken)
        log.info('runner.job_taken', { agent: held.agent.name, job: held.id, started: held.job.progress !== null })
        break
      }
      if (held === null) return null
      const { progress } = held.job
      return {
        id: held.id,
        holdLive: held.job.holdLive,
        started: progress !== null,
        lane: progress === null ? null : jobLane(progress),
        until: progress?.until ?? null,
        channels: held.agent.channels,
      }
    },

    async start({ state, index }) {
      const { agent, git, job } = held
      const lock = acquireRunLock({ paths, deadline: clock.now() + agent.timeoutMinutes * MINUTE, clock })
      if (lock !== 'taken') return { outcome: 'waiting', why: lock }
      try {
        const tag = jobTag(job.id)
        if (!(await git.hasTag(tag))) await git.tag(tag, tagMessage(job))
        if (job.empty) {
          emptyEntries(paths.agentDir(agent.name), repositoryPaths(agent.name, held.writes))
          const left = await git.stage()
          if (left !== null) throw new Error(`git wouldn't stage ${left} once the job's writes were emptied`)
          await git.commitStaged(`${agent.name}: backfill ${job.id}, from empty`)
        }
        const until = agent === own ? state.cursor : index.lastSeq
        const progress = { started: isoSeconds(clock.now()), until, cursor: job.from - 1, given: 0, retry: [], skipped: [] }
        if (save(progress)) log.info('runner.job_started', { agent: agent.name, job: job.id, from: job.from, until, tag, empty: job.empty || undefined })
      } finally {
        releaseLock(paths.runLock)
      }
      return { outcome: 'started' }
    },

    batch({ index, now }) {
      const { agent, git, job } = held
      const { progress } = job
      const built = buildReplayBatch({ agent, lane: jobLane(progress), until: progress.until, index, paths, settings, now, writes: held.writes, template: held.template })
      if (built === null) return null
      return {
        agent,
        git,
        job: {
          kind: 'backfill',
          id: job.id,
          batch: built.batch,
          prompt: built.prompt,
          sessionId: replaySessionId(agent, { day: built.day, job: job.id }),
          skills: held.skills,
          writes: held.writes,
          settle: (outcome, timing) => settleJobBatch(progress, built.batch, outcome, timing),
          save: next => {
            if (held?.id === job.id) save(next)
          },
        },
      }
    },

    async finish({ ids }) {
      const { agent, job, file } = held
      const id = await writeOutboxEntry({ paths, ids, entry: { type: 'text', by: 'runner', text: jobSummary(job) } })
      fs.rmSync(file, { force: true })
      const { until, given, skipped } = job.progress
      log.info('runner.job_finished', { agent: agent.name, job: job.id, until, given, skipped: skipped.length, entry: id, sessions: release() })
    },
  }
}
