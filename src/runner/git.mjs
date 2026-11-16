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

import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '../common/files.mjs'
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
    // link or a FIFO; any name starting with `.`, such as a `.gitignore` or a nested `.git`; and
    // any file git ignores.
    async unexpectedFile(folders = AGENT_FOLDERS) {
      const found = findUnexpected(dir, folders)
      if (found !== null) return found
      const { stdout } = await run(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', ...folders])
      const ignored = stdout.split('\0').find(entry => entry.startsWith('!! '))
      return ignored === undefined ? null : ignored.slice(3)
    },

    // Stages everything in `folders` and commits it with `message`, if anything changed. Returns
    // whether there was a commit.
    async commitChanges(message, folders = AGENT_FOLDERS) {
      for (const folder of folders) ensureDir(path.join(dir, folder), { mode: 0o700 })
      await run(['add', '-A', '--', ...folders])
      const { code } = await run(['diff', '--cached', '--quiet', '--', ...folders], { codes: [0, 1] })
      if (code === 0) return false
      await this.commit(message)
      return true
    },

    // Throws away every change in `folders` since the last commit, so the next run starts from the
    // last good state (6.9): `git restore` and `git clean -fdx`, both limited to those folders.
    // What git can't see, such as a FIFO, and what it won't remove, such as a nested repository,
    // goes first, by hand. The folders are there, and empty if nothing of them was committed,
    // when this returns.
    async discardChanges(folders = AGENT_FOLDERS) {
      for (const folder of folders) sweep(dir, folder)
      const kept = await tracked(folders)
      if (kept.length > 0) await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...kept])
      // Files staged in a folder the last commit doesn't have, which a commit that failed leaves.
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

// The entries of a folder, sorted, without following links.
function entriesOf(full) {
  return fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// What `unexpectedFile` finds without git: the first entry, in name order, that is a dot name or
// neither a regular file nor a folder. `folders` are paths from `dir`.
export function findUnexpected(dir, folders = AGENT_FOLDERS) {
  function walk(full, relative) {
    for (const entry of entriesOf(full)) {
      const inner = `${relative}/${entry.name}`
      if (entry.name.startsWith('.')) return inner
      if (entry.isDirectory()) {
        const found = walk(path.join(full, entry.name), inner)
        if (found !== null) return found
      } else if (!entry.isFile()) {
        return inner
      }
    }
    return null
  }
  for (const folder of folders) {
    const full = path.join(dir, folder)
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

// Removes from `folder` everything `findUnexpected` would find, without following links: a link
// goes as a link, and a folder named with a dot, such as a nested `.git`, with all it holds. A
// `folder` that is itself no folder goes too.
function sweep(dir, folder) {
  const full = path.join(dir, folder)
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
    const inner = path.join(full, entry.name)
    if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isFile())) fs.rmSync(inner, { recursive: true, force: true })
    else if (entry.isDirectory()) sweep(full, entry.name)
  }
}
