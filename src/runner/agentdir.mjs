// An agent's folder (6.2 of DESIGN.md), and `run/`, which the runner builds again before each run.
//
//   /data/agents/lifelog/      a git repository, the runner's, 0700
//     views/                   the agent's views, in git
//     memory/                  preferences.md and needs-review.md, in git
//     sessions/                pi's sessions, not in git; hidden from the VM
//     run/                     not in git: system.md, config/ and session/
//     state.json               the runner's state, not in git, 0600
//
// pi sees the folder through its VM's mounts: `views/`, `memory/` and `run/session/` writable,
// `sessions/` hidden, and the rest read-only (6.6). Everything in it belongs to the runner's user.

import fs from 'node:fs'
import path from 'node:path'
import { copyUntrustedFile, ensureDir } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { readMemoryFile, renderSystemPrompt } from './prompt.mjs'

// What git leaves out, anchored with `/` so that the names can't match anything inside `views/`
// or `memory/` (6.2).
export const GITIGNORE = '/sessions/\n/run/\n/state.json\n'

const FOLDER_MODE = 0o700
const FILE_MODE = 0o600

// Creates the agent's folder the first time, and finishes what a crash left half done: the
// folders, `git init`, the `.gitignore`, and a first commit with the `.gitignore` alone. A folder
// that is complete is left as it is. `git` is what `createGit` returns, for this folder.
//
// `git init` runs whenever the folder has no commit: a start killed during `git init` can leave an
// empty `.git`, and running it again on a repository is safe.
export async function ensureAgentDir({ paths, name, git, log }) {
  const dir = paths.agentDir(name)
  for (const folder of [dir, paths.agentViews(name), paths.agentMemory(name), paths.agentSessions(name), paths.agentRun(name)]) {
    ensureDir(folder, { mode: FOLDER_MODE })
  }
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

// Builds `run/` for one run (6.2, 6.5, 6.6), from nothing:
// - `config/`: a copy of the agent's prompt and of `skills` (all of the agent's by default), each
//   at its path in the config folder, so pi only ever sees this run's copy (8.5);
// - `session/`: empty, with a copy of the session `sessionId` if the runner has one, as
//   `sessions/<sessionId>.jsonl`. With `session: none`, `sessionId` is null;
// - `system.md`: the protocol, the agent's prompt, and its memory as it is now (6.5).
//
// Returns `{ systemFile, skillDirs, sessionDir, sessionFile }`: the paths pi is given, and the
// session file copied in, or null.
export function prepareRun({ paths, agent, protocol, sessionId = null, skills = agent.skills }) {
  const name = agent.name
  const runDir = paths.agentRun(name)
  const configDir = paths.agentRunConfig(name)
  const sessionDir = paths.agentRunSession(name)
  fs.rmSync(runDir, { recursive: true, force: true })
  ensureDir(runDir, { mode: FOLDER_MODE })

  ensureDir(configDir, { mode: FOLDER_MODE })
  const promptCopy = path.join(configDir, agent.prompt.path)
  copyTree(agent.prompt.file, promptCopy)
  const skillDirs = skills.map(skill => {
    const copy = path.join(configDir, skill.path)
    copyTree(skill.dir, copy)
    return copy
  })

  ensureDir(sessionDir, { mode: FOLDER_MODE })
  let sessionFile = null
  if (sessionId !== null) {
    const kept = path.join(paths.agentSessions(name), `${sessionId}.jsonl`)
    // Only the runner writes `sessions/`, and it keeps regular files there (6.6).
    if (fs.existsSync(kept) && fs.lstatSync(kept).isFile()) {
      sessionFile = path.join(sessionDir, `${sessionId}.jsonl`)
      fs.copyFileSync(kept, sessionFile, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(sessionFile, FILE_MODE)
    }
  }

  const systemFile = paths.agentRunSystem(name)
  const memory = paths.agentMemory(name)
  const system = renderSystemPrompt({
    protocol,
    prompt: fs.readFileSync(promptCopy, 'utf8'),
    preferences: readMemoryFile(path.join(memory, 'preferences.md')),
    needsReview: readMemoryFile(path.join(memory, 'needs-review.md')),
  })
  fs.writeFileSync(systemFile, system, { mode: FILE_MODE })
  return { systemFile, skillDirs, sessionDir, sessionFile }
}

// After a successful run, keeps the session pi wrote as `sessions/<sessionId>.jsonl` (6.6). Returns
// `kept`, `none` when pi left no session file, or `refused` when the file isn't one to keep: a link,
// anything but a regular file, a file with more than one name, or one over `SESSION_MAX_BYTES`.
//
// pi finds a session by the first line of its file, not by its name (`docs/DECISIONS.md`, 0.4,
// pi 2). It continues the copy `prepareRun` made, under that copy's name. A session it starts
// afresh, which happens on the first run of a session and when the agent's folder has moved, goes
// into a new file it names `<UTC time>_<sessionId>.jsonl`, and that is the one to take. Anything
// else in `run/session/` is ignored, so a run can only extend its own session.
//
// The file is copied without following a link, and checked on what was opened (`copyUntrustedFile`).
export async function keepSession({ paths, agent, sessionId }) {
  const sessionDir = paths.agentRunSession(agent.name)
  let names
  try {
    names = fs.readdirSync(sessionDir)
  } catch (error) {
    if (error.code === 'ENOENT') return 'none'
    throw error
  }
  const fresh = names.filter(name => name.endsWith(`_${sessionId}.jsonl`)).sort()
  const name = fresh.at(-1) ?? (names.includes(`${sessionId}.jsonl`) ? `${sessionId}.jsonl` : null)
  if (name === null) return 'none'
  ensureDir(paths.agentSessions(agent.name), { mode: FOLDER_MODE })
  try {
    await copyUntrustedFile(path.join(sessionDir, name), path.join(paths.agentSessions(agent.name), `${sessionId}.jsonl`), {
      maxBytes: limits.SESSION_MAX_BYTES,
      mode: FILE_MODE,
    })
  } catch (error) {
    if (error.code === 'EUNTRUSTED' || error.code === 'EFBIG') return 'refused'
    throw error
  }
  return 'kept'
}
