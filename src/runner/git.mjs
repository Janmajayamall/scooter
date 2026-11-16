// Git, as the runner uses it on an agent's folder (6.2, 6.8, 6.9 of DESIGN.md).
//
// The runner is the only committer. Every git command runs through `proc.mjs`, from an argument
// list, with an environment of its own:
// - the repository is named outright, as the agent's `.git` and the agent's folder, so git never
//   looks for one above it, such as a developer's checkout that holds the data folder;
// - no system or user git config, so nothing on the machine changes what git does here;
// - no hooks and no signing;
// - the author and the time from the runner, as `Scooter <scooter@localhost>`.
//
// After each run the runner checks what pi left in `views/` and `memory/`, commits it, or throws
// it away. Those are the only folders pi can write, apart from its session copy (6.6).
//
// pi chose every name and mode there, so the folders are walked by the bytes of their names,
// without following links, and the runner takes its access back before it empties them: nothing
// pi leaves can stop the runner, at the end of a run or at its next start.

import fs from 'node:fs'
import path from 'node:path'
import { childPath, ensureDir, restoreAccess } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { systemClock } from '../common/time.mjs'

export const AUTHOR = { name: 'Scooter', email: 'scooter@localhost' }

// The folders of the agent's that pi writes and git keeps (6.2).
export const AGENT_FOLDERS = ['views', 'memory']

// Settings given on every command line, ahead of the command.
const CONFIG = ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null']

// Returns git for the repository in `dir`. `proc` is what `createProc` returns.
export function createGit({ proc, dir, clock = systemClock }) {
  function env() {
    const date = `@${Math.floor(clock.now() / 1000)} +0000`
    return {
      // Git finds its own helpers, and the runner's `PATH` is the one it was started with.
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_DIR: path.join(dir, '.git'),
      GIT_WORK_TREE: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
      GIT_COMMITTER_DATE: date,
      LC_ALL: 'C',
      TZ: 'UTC',
    }
  }

  // Runs `git <args>` and returns `{ code, stdout }`. Rejects when it exits with another code than
  // those in `codes`, or times out. The error names the command, not what git printed, which can
  // name the agent's files.
  async function run(args, { codes = [0] } = {}) {
    const result = await proc.run('git', [...CONFIG, ...args], { env: env(), cwd: dir, timeout: limits.GIT_CALL_TIMEOUT })
    if (result.timedOut || !codes.includes(result.code)) {
      const reason = result.timedOut ? 'timed out' : `exit code ${result.code}`
      throw Object.assign(new Error(`git ${args[0]}: ${reason}`), { code: 'EGIT', exitCode: result.code, timedOut: result.timedOut })
    }
    return { code: result.code, stdout: result.stdout }
  }

  // The folders of `folders` that hold files of the last commit.
  async function tracked(folders) {
    const { stdout } = await run(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...folders])
    const names = stdout.split('\0').filter(Boolean)
    return folders.filter(folder => names.some(name => name.startsWith(`${folder}/`)))
  }

  // The first path in `folders` with a change that isn't staged, or null.
  async function firstUnstaged(folders) {
    const { stdout } = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...folders])
    // Each entry is `XY <path>`: X for the index, Y for the work tree.
    const fields = stdout.split('\0')
    for (let n = 0; n < fields.length; n++) {
      const entry = fields[n]
      if (entry === '') continue
      // A staged rename or copy is followed by the path it came from.
      if (entry[0] === 'R' || entry[0] === 'C') n++
      if (entry[1] !== ' ') return entry.slice(3)
    }
    return null
  }

  return {
    run,

    // Whether the repository has a commit yet. False also when there is no repository, or only an
    // empty `.git` that a start killed during `git init` left.
    async hasCommit() {
      return (await run(['rev-parse', '--verify', '--quiet', 'HEAD'], { codes: [0, 1, 128] })).code === 0
    },

    // Commits what is staged, with `message`.
    async commit(message) {
      await run(['commit', '--quiet', '--no-verify', '-m', message])
    },

    // The first thing in `folders` that git wouldn't record, as a path from the agent's folder, or
    // null when there is none (6.8): anything that isn't a regular file or a folder, such as a
    // link or a FIFO; any name starting with `.`, such as a `.gitignore` or a nested `.git`; a
    // file the runner can't read, or a folder it can't read and search, which git would pass
    // over or fail on; and any file git ignores.
    async unexpectedFile(folders = AGENT_FOLDERS) {
      const found = findUnexpected(dir, folders)
      if (found !== null) return found
      const { stdout } = await run(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', ...folders])
      const ignored = stdout.split('\0').find(entry => entry.startsWith('!! '))
      return ignored === undefined ? null : ignored.slice(3)
    },

    // Stages everything in `folders` (`git add -A`), and returns null, or the first path git
    // wouldn't add: a name it refuses, such as `git~1`, or a file it couldn't read. Such a path is
    // something git wouldn't record, so this is the last step of the check in 6.8, after
    // `unexpectedFile`. git goes on past it (`--ignore-errors`) and leaves it unstaged, which is
    // how it is found. A failure that leaves nothing unstaged isn't pi's, and throws.
    async stage(folders = AGENT_FOLDERS) {
      for (const folder of folders) ensureDir(path.join(dir, folder), { mode: 0o700 })
      const { code } = await run(['add', '-A', '--ignore-errors', '--', ...folders], { codes: [0, 1] })
      if (code === 0) return null
      const left = await firstUnstaged(folders)
      if (left === null) throw Object.assign(new Error('git add: exit code 1, with everything staged'), { code: 'EGIT', exitCode: 1, timedOut: false })
      return left
    },

    // Commits what `stage` staged in `folders` with `message`, if it differs from the last
    // commit. Returns whether there was a commit.
    async commitStaged(message, folders = AGENT_FOLDERS) {
      const { code } = await run(['diff', '--cached', '--quiet', '--', ...folders], { codes: [0, 1] })
      if (code === 0) return false
      await this.commit(message)
      return true
    },

    // Throws away every change in `folders` since the last commit, so the next run starts from the
    // last good state (6.9): `git restore` and `git clean -fdx`, both limited to those folders.
    // First the runner takes back its access to everything there (`restoreAccess`), so that it can
    // read and remove whatever pi left. Then what git can't see, such as a FIFO, and what it won't
    // remove, such as a nested repository, goes by hand. The folders are there, and empty if
    // nothing of them was committed, when this returns.
    async discardChanges(folders = AGENT_FOLDERS) {
      for (const folder of folders) {
        const full = Buffer.from(path.join(dir, folder))
        restoreAccess(full)
        sweep(full)
      }
      const kept = await tracked(folders)
      if (kept.length > 0) await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...kept])
      // Files staged in a folder the last commit doesn't have, which a check that failed at
      // staging, or a commit that failed, leaves.
      const untracked = folders.filter(folder => !kept.includes(folder))
      if (untracked.length > 0) await run(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...untracked])
      const present = folders.filter(folder => fs.existsSync(path.join(dir, folder)))
      if (present.length > 0) await run(['clean', '-ffdxq', '--', ...present])
      for (const folder of folders) ensureDir(path.join(dir, folder), { mode: 0o700 })
      const left = await this.unexpectedFile(folders)
      if (left !== null) throw Object.assign(new Error(`the clean-up left ${left} in the agent's folder`), { code: 'EGIT' })
    },
  }
}

const DOT = '.'.charCodeAt(0)

// The entries of the folder at `full` (bytes), sorted by name, without following links. Their
// names are bytes too.
function entriesOf(full) {
  return fs.readdirSync(full, { withFileTypes: true, encoding: 'buffer' }).sort((a, b) => Buffer.compare(a.name, b.name))
}

// Whether the runner may `mode` (`fs.constants`) the file or folder at `full`.
function mayAccess(full, mode) {
  try {
    fs.accessSync(full, mode)
    return true
  } catch (error) {
    if (error.code === 'EACCES') return false
    throw error
  }
}

// What `unexpectedFile` finds without git: the first entry, in name order, that is a dot name;
// neither a regular file nor a folder; a file the runner can't read; or a folder it can't read and
// search. `folders` are paths from `dir`. The path returned is for people: a name that isn't
// UTF-8 shows its bytes as `�`.
export function findUnexpected(dir, folders = AGENT_FOLDERS) {
  const { R_OK, X_OK } = fs.constants
  function walk(full, relative) {
    if (!mayAccess(full, R_OK | X_OK)) return relative
    for (const entry of entriesOf(full)) {
      const inner = `${relative}/${entry.name.toString()}`
      if (entry.name[0] === DOT) return inner
      const innerFull = childPath(full, entry.name)
      if (entry.isDirectory()) {
        const found = walk(innerFull, inner)
        if (found !== null) return found
      } else if (!entry.isFile() || !mayAccess(innerFull, R_OK)) {
        return inner
      }
    }
    return null
  }
  for (const folder of folders) {
    const full = Buffer.from(path.join(dir, folder))
    let stat
    try {
      stat = fs.lstatSync(full)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!stat.isDirectory()) return folder
    const found = walk(full, folder)
    if (found !== null) return found
  }
  return null
}

// Removes from the folder at `full` (bytes) the dot names and the entries that are neither a
// regular file nor a folder, which git can't see or won't remove, without following links: a
// link goes as a link, and a folder named with a dot, such as a nested `.git`, with all it holds.
// A `full` that is itself no folder goes too. The runner has its access back by now
// (`restoreAccess`).
function sweep(full) {
  let stat
  try {
    stat = fs.lstatSync(full)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory()) {
    fs.rmSync(full, { force: true })
    return
  }
  for (const entry of entriesOf(full)) {
    const inner = childPath(full, entry.name)
    if (entry.name[0] === DOT || !(entry.isDirectory() || entry.isFile())) fs.rmSync(inner, { recursive: true, force: true })
    else if (entry.isDirectory()) sweep(inner)
  }
}
