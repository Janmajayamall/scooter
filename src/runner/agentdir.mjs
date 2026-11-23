// An agent's folder, and `run/`, which the runner builds again before each run.
//
//   /data/agents/lifelog/      a git repository, the runner's, 0700
//     views/, memory/          what `writes` names in the folder, in git (`agent.repository`)
//     sessions/                pi's sessions, not in git; hidden from the VM
//     run/                     not in git: config/, session/, send/, marks.txt, index.txt, bin/,
//                              skills/ and icu-tz/
//     jobs/                    the jobs of `scooter backfill` that run the agent, not in git;
//                              hidden from the VM
//     state.json               the runner's state, not in git, 0600
//
// What pi's VM sees of the folder, and may change, is what the agent's `reads` and `writes` name,
// with `run/` read-only but for `run/session/`, `run/send/` and `run/marks.txt`, and never
// `sessions/` or `jobs/` (`piFiles` in `run.mjs`). Everything in it belongs to the runner's user.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyUntrustedFile, emptyFolder, ensureDir, removeTree } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { RUNNER_SKILL } from './config.mjs'

// What ships with the runner for every run's VM: the programs, which each run gets in `run/bin/`
// under their names; the runner's own skill, which it gets in `run/skills/`; and ICU's zone rules,
// which it gets as `run/icu-tz/`, and which the VM's Node converts times with (`piEnv` in
// `run.mjs`).
const PROGRAMS = {
  show: fileURLToPath(new URL('./vm/bin/show.mjs', import.meta.url)),
  send: fileURLToPath(new URL('./vm/bin/send.mjs', import.meta.url)),
  mark: fileURLToPath(new URL('./vm/bin/mark.mjs', import.meta.url)),
}
const RUNNER_SKILL_DIR = fileURLToPath(new URL(`./vm/skills/${RUNNER_SKILL}`, import.meta.url))
const ICU_TZ_DIR = fileURLToPath(new URL('./vm/icu-tz', import.meta.url))

// ICU's four zone files, each of which `release.txt` lists with its SHA-256.
const ICU_TZ_FILES = ['zoneinfo64.res', 'metaZones.res', 'timezoneTypes.res', 'windowsZones.res']

// The release of the tz database that the zone rules shipped with the runner are of, as the first
// line of their `release.txt` names it, such as `2026f`: what `process.versions.tz` gives in a Node
// that converts with them. The lines after it give each of ICU's four files' SHA-256 and name, as
// `sha256sum` writes them, and it throws unless each file is the one listed, as `show` checks the
// run's copy. *Why at the start:* ICU reads the zone file as Node starts, and a damaged one can make
// every Node in the VM die there, pi among them, which would fail every run as pi's own.
export function icuTzRelease(dir = ICU_TZ_DIR) {
  const file = path.join(dir, 'release.txt')
  const [release, ...rows] = fs.readFileSync(file, 'utf8').split('\n')
  if (!/^\d{4}[a-z]+$/.test(release)) throw new Error(`${file} doesn't start with a release of the tz database`)
  const listed = rows.filter(row => row !== '').map(row => /^([0-9a-f]{64}) {2}(\S+)$/.exec(row))
  const sums = new Map(listed.map(match => (match ? [match[2], match[1]] : [null, null])))
  if (listed.length !== ICU_TZ_FILES.length || !ICU_TZ_FILES.every(name => sums.has(name))) {
    throw new Error(`${file} doesn't list the SHA-256 of each of ${ICU_TZ_FILES.join(', ')}`)
  }
  for (const name of ICU_TZ_FILES) {
    const sum = createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
    if (sum !== sums.get(name)) throw new Error(`${path.join(dir, name)} isn't the file ${file} lists`)
  }
  return release
}

// What git leaves out, anchored with `/` so that the names can't match anything inside what
// `writes` names.
export const GITIGNORE = '/sessions/\n/run/\n/jobs/\n/state.json\n'

const FOLDER_MODE = 0o700
const FILE_MODE = 0o600

// Creates the agent's folder the first time, and finishes what a crash left half done: the
// folders, `git init`, the `.gitignore`, and a first commit with the `.gitignore` alone. A folder
// that is complete is left as it is. `git` is what `createGit` returns, for this folder. What
// `writes` names in the folder is made by the clean-up that follows at a start, once it has freed
// what pi wrote there (`discardChanges` in `git.mjs`).
//
// First it frees what pi wrote that a crash or a stop may have left taking room: what a clean-up
// set aside and couldn't remove, in `agents/.discarded/<agent>/`, and what the run could write in
// `run/` (`clearRunWrites`). pi could have
// filled the disk, and on a full disk no folder can be made, so this comes before any is. The
// clean-up that follows at a start frees what `writes` names. `agents/.discarded/<agent>/` is made
// here, while there is room, and kept, so a clean-up makes nothing before it has freed what it set
// aside.
//
// `git init` runs whenever the folder has no commit: a start killed during `git init` can leave an
// empty `.git`, and running it again on a repository is safe. A git killed while it held the
// index or a branch leaves its lock file, such as `.git/index.lock`, and git would refuse to work
// until it is gone, so it goes first. Only the runner uses this repository.
export async function ensureAgentDir({ paths, name, git, log }) {
  const dir = paths.agentDir(name)
  try {
    emptyFolder(paths.agentDiscarded(name))
  } catch (error) {
    log.warn('agent.discarded_left', { folder: name, ...errorFields(error) })
  }
  clearRunWrites({ paths, agent: { name }, log })
  for (const folder of [dir, paths.agentSessions(name), paths.agentRun(name), paths.agentDiscarded(name)]) {
    ensureDir(folder, { mode: FOLDER_MODE })
  }
  const locks = git.removeLeftoverLocks()
  if (locks.length > 0) log.warn('agent.git_lock_removed', { agent: name, locks })
  if (!(await git.hasCommit())) {
    await git.run(['init', '--quiet'])
    log.info('agent.git_init', { agent: name })
  }
  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, GITIGNORE, { mode: FILE_MODE })
  if (!(await git.hasCommit())) {
    await git.run(['add', '--', '.gitignore'])
    await git.commit(`${name}: initial commit`)
    log.info('agent.created', { agent: name })
  }
}

// Copies a folder of the config, holding only files and folders, as `config.mjs` checked at
// startup. Anything else found here since is refused. A file keeps whether it can be run.
function copyTree(source, target) {
  const stat = fs.lstatSync(source)
  if (stat.isDirectory()) {
    ensureDir(target, { mode: FOLDER_MODE })
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(target, name))
  } else if (stat.isFile()) {
    ensureDir(path.dirname(target), { mode: FOLDER_MODE })
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(target, stat.mode & 0o111 ? 0o700 : FILE_MODE)
  } else {
    throw Object.assign(new Error(`${source} is neither a file nor a folder`), { code: 'ECONFIG' })
  }
}

// The index file's text: one line for each line of the datastore that `index` holds, in `seq`
// order, `<seq> <log>:<line number> <kind>[ <seq it points at>]`, as
// `1054 /data/datastore/2026/11/09/log.jsonl:216 edit 1051`. A line points at its `target`, or
// else at the message it replies to, `replyTo`; only a line this version's store didn't write can
// have both. The paths are the host's, which the VM sees at the same paths. The reading check
// holds the kind to a name and each `seq` to a whole number, so a line of the file can't be taken
// for two, and the runner refuses a data folder whose path holds a line break (`settings.mjs`).
// `show` reads it (`vm/bin/show.mjs`).
export function indexFileText(index, paths) {
  const lines = []
  for (const { line, day, number } of index.entries()) {
    const points = line.target ?? line.replyTo
    lines.push(`${line.seq} ${paths.dayLog(day)}:${number} ${line.kind}${points === undefined ? '' : ` ${points}`}\n`)
  }
  return lines.join('')
}

// Builds `run/` for one run, from nothing:
// - `config/`: a copy of the agent's prompt and of `skills` (all of the agent's by default), each
//   at its path in the config folder, so pi only ever sees this run's copy. The prompt's copy is
//   what pi appends to its system prompt;
// - `skills/`: a copy of the skill that ships with the runner, which every run is given first;
// - `bin/`: a copy of each program that ships with the runner, `show`, `send` and `mark`, which the
//   VM finds on its `PATH` (`piEnv` in `run.mjs`);
// - `icu-tz/`: a copy of ICU's zone rules, which pi's environment points the VM's Node at;
// - `index.txt`: the index file, from `index`, the datastore's (`indexFileText`);
// - `session/`: empty, with a copy of the session `sessionId` if the runner has one, as
//   `sessions/<sessionId>.jsonl`. With `session: none`, `sessionId` is null;
// - `send/`: empty, for the messages `send` queues; `marks.txt`, which `mark` makes, isn't there.
//
// Returns `{ promptFile, skillDirs, sessionDir, sessionFile }`: the paths pi is given, and the
// session file copied in, or null.
//
// pi could write `run/session/`, `run/send/` and `run/marks.txt` in the last run, and leave there
// what it liked, if the runner stopped before it cleared them (`clearRunWrites`), so `run/` is
// removed as anything pi wrote is (`removeTree`): access taken back, no folder read whole, and
// however deep it goes. The rest of `run/` is read-only in the VM, and the runner never reads any
// of it back: it is made anew for each run.
export function prepareRun({ paths, agent, index, sessionId = null, skills = agent.skills }) {
  const name = agent.name
  const runDir = paths.agentRun(name)
  const configDir = paths.agentRunConfig(name)
  const sessionDir = paths.agentRunSession(name)
  removeTree(runDir)
  ensureDir(runDir, { mode: FOLDER_MODE })

  ensureDir(configDir, { mode: FOLDER_MODE })
  const promptFile = path.join(configDir, agent.prompt.path)
  copyTree(agent.prompt.file, promptFile)
  const runnerSkill = path.join(paths.agentRunSkills(name), RUNNER_SKILL)
  copyTree(RUNNER_SKILL_DIR, runnerSkill)
  const skillDirs = [
    runnerSkill,
    ...skills.map(skill => {
      const copy = path.join(configDir, skill.path)
      copyTree(skill.dir, copy)
      return copy
    }),
  ]

  const binDir = paths.agentRunBin(name)
  ensureDir(binDir, { mode: FOLDER_MODE })
  for (const [program, source] of Object.entries(PROGRAMS)) {
    const copy = path.join(binDir, program)
    fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(copy, 0o700)
  }
  copyTree(ICU_TZ_DIR, paths.agentRunIcuTz(name))
  fs.writeFileSync(paths.agentRunIndex(name), indexFileText(index, paths), { mode: FILE_MODE })

  ensureDir(sessionDir, { mode: FOLDER_MODE })
  let sessionFile = null
  if (sessionId !== null) {
    const kept = path.join(paths.agentSessions(name), `${sessionId}.jsonl`)
    // Only the runner writes `sessions/`, and it keeps regular files there.
    if (fs.existsSync(kept) && fs.lstatSync(kept).isFile()) {
      sessionFile = path.join(sessionDir, `${sessionId}.jsonl`)
      fs.copyFileSync(kept, sessionFile, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(sessionFile, FILE_MODE)
    }
  }
  ensureDir(paths.agentRunSend(name), { mode: FOLDER_MODE })
  return { promptFile, skillDirs, sessionDir, sessionFile }
}

// After a successful run, keeps the session pi wrote as `sessions/<sessionId>.jsonl`. Returns
// `kept`, `none` when pi left no session file, or `refused` when the file isn't one to keep: a link,
// anything but a regular file, a file with more than one name, one over `SESSION_MAX_BYTES`, or
// one the runner can't open, such as a file pi made unreadable or a session folder it can't list.
// A refusal is logged as `runner.session_refused`, with why.
//
// pi finds a session by the first line of its file, not by its name.
// It continues the copy `prepareRun` made, under that copy's name. A session it starts
// afresh, which happens on the first run of a session and when the agent's folder has moved, goes
// into a new file it names `<UTC time>_<sessionId>.jsonl`, and that is the one to take. Anything
// else in `run/session/` is ignored, so a run can only extend its own session.
//
// pi wrote everything in `run/session/`, so nothing there may stop the runner: the folder is read
// as a stream, which a folder of millions of names can't make costly in memory, and the file is
// copied without following a link, and checked on what was opened (`copyUntrustedFile`). Any error
// is a refusal: the run is committed by now, and the session kept before stays.
export async function keepSession({ paths, agent, sessionId, log }) {
  const sessionDir = paths.agentRunSession(agent.name)
  const refuse = (error = null) => {
    log.warn('runner.session_refused', { agent: agent.name, session: sessionId, ...(error ? errorFields(error) : {}) })
    return 'refused'
  }
  try {
    if (!fs.lstatSync(sessionDir).isDirectory()) return refuse()
    // The newest file pi named itself, or else the copy it continued.
    let fresh = null
    let copy = false
    const dir = fs.opendirSync(sessionDir)
    try {
      for (let entry; (entry = dir.readSync()) !== null; ) {
        if (entry.name.endsWith(`_${sessionId}.jsonl`) && (fresh === null || entry.name > fresh)) fresh = entry.name
        else if (entry.name === `${sessionId}.jsonl`) copy = true
      }
    } finally {
      dir.closeSync()
    }
    const name = fresh ?? (copy ? `${sessionId}.jsonl` : null)
    if (name === null) return 'none'
    ensureDir(paths.agentSessions(agent.name), { mode: FOLDER_MODE })
    await copyUntrustedFile(path.join(sessionDir, name), path.join(paths.agentSessions(agent.name), `${sessionId}.jsonl`), {
      maxBytes: limits.SESSION_MAX_BYTES,
      mode: FILE_MODE,
    })
    return 'kept'
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(sessionDir)) return 'none'
    return refuse(error)
  }
}

// Clears what a run could write in `run/`: empties `run/session/` and `run/send/`, and removes
// `run/marks.txt`; with `session: false`, all but `run/session/`. It runs once a run is over, what
// `send` and `mark` left read and its session kept, and before a failed run's clean-up, so before
// the runner records the run; and at a start. pi wrote what is there, and could have filled the
// disk with it: the folders stay, so nothing is made. Returns nothing. An error is logged, naming
// what couldn't be cleared, and left to `prepareRun`, which removes `run/` whole before the next
// run.
export function clearRunWrites({ paths, agent, log, session = true }) {
  const name = agent.name
  for (const [what, clear] of [
    ...(session ? [['session', () => emptyFolder(paths.agentRunSession(name))]] : []),
    ['send', () => emptyFolder(paths.agentRunSend(name))],
    ['marks.txt', () => removeTree(paths.agentRunMarks(name))],
  ]) {
    try {
      clear()
    } catch (error) {
      log.warn('runner.run_left', { agent: name, left: what, ...errorFields(error) })
    }
  }
}
