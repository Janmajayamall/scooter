// Git, as the runner uses it on an agent's folder (6.2, 6.8, 6.9 of DESIGN.md).
//
// The runner is the only committer. Every git command runs through `proc.mjs`, from an argument
// list, with an environment of its own:
// - the repository is named outright, as the agent's `.git` and the agent's folder, so git never
//   looks for one above it, such as a developer's checkout that holds the data folder;
// - no system or user git config, so nothing on the machine changes what git does here;
// - no hooks and no signing;
// - the author and the time from the runner, as `Scooter <scooter@localhost>`;
// - no maintenance started by a command on its own, which would go on in the background after the
//   command returned, outside `run.lock`. The runner packs the repository itself (`pack`).
//
// After each run the runner checks what pi left in `views/` and `memory/`, commits it, or throws
// it away. Those are the only folders pi can write, apart from its session copy (6.6).
//
// pi chose every name, mode, size and depth, and the number of files there. So the check walks the
// folders by the bytes of their names, without following links, and counts and weighs what they
// hold before git reads any of it; staging puts back the modes, which git doesn't record; and the
// clean-up sets the folders aside, frees what pi wrote, and takes the last commit's back, which
// nothing pi left can slow down or stop, not even a disk it filled. Nothing pi leaves can stop the
// runner, at the end of a run or at its next start.

import fs from 'node:fs'
import path from 'node:path'
import { childPath, emptyFolder, ensureDir } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { systemClock } from '../common/time.mjs'

export const AUTHOR = { name: 'Scooter', email: 'scooter@localhost' }

// The folders of the agent's that pi writes and git keeps (6.2).
export const AGENT_FOLDERS = ['views', 'memory']

// Settings given on every command line, ahead of the command. `maintenance.auto=false` keeps
// `git commit` from starting `git gc` on its own; `gc.autoDetach=false` keeps the runner's own
// `git gc --auto` in the foreground.
const CONFIG = [
  ...['-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null'],
  ...['-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false', '-c', 'maintenance.autoDetach=false'],
]

// Returns git for the repository in `dir`. `proc` is what `createProc` returns. `discardDir` is
// where the clean-up sets what it throws away aside (`paths.agentDiscarded`), and `log` where it
// says what it couldn't remove there.
export function createGit({ proc, dir, discardDir, log, clock = systemClock }) {
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
  // those in `codes`, or times out after `timeout`. The error names the command, not what git
  // printed, which can name the agent's files.
  async function run(args, { codes = [0], timeout = limits.GIT_CALL_TIMEOUT } = {}) {
    const result = await proc.run('git', [...CONFIG, ...args], { env: env(), cwd: dir, timeout })
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
    // file the runner can't read, or a folder it can't read and search, or a path longer than the
    // system takes, which git would pass over or fail on; a file with more than one name, which
    // git would record as two; the name at which `folders` pass `maxCount` files and folders in
    // all, or the file at which they pass `maxBytes`, which git would take too long over; and any
    // file git ignores. All but the last are found without git, so git reads nothing before the
    // files have been counted and weighed.
    async unexpectedFile(folders = AGENT_FOLDERS, { maxBytes = limits.AGENT_FILES_MAX_BYTES, maxCount = limits.AGENT_FILES_MAX_COUNT } = {}) {
      const found = findUnexpected(dir, folders, { maxBytes, maxCount })
      if (found !== null) return found
      const { stdout } = await run(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', ...folders])
      const ignored = stdout.split('\0').find(entry => entry.startsWith('!! '))
      return ignored === undefined ? null : ignored.slice(3)
    },

    // Stages everything in `folders` (`git add -A`), and returns null, or the first path git
    // wouldn't add: a name it refuses, such as `git~1`. Such a path is something git wouldn't
    // record, so this is the last step of the check in 6.8, after `unexpectedFile`, which must
    // have passed. git goes on past it (`--ignore-errors`) and leaves it unstaged, which is how it
    // is found. A failure that leaves nothing unstaged isn't a name's, and throws.
    //
    // First it puts back what git doesn't record:
    // - the modes. git keeps only whether a file can be run, and pi chose the rest, such as a
    //   folder no later run could write. Folders get 0700, and files 0600, or 0700 when they can
    //   be run (`resetModes`).
    // - empty folders. An ordinary run can leave one, such as a month's folder once its only day
    //   page is gone, so it doesn't fail the run; but it would carry over to later runs outside
    //   git. They are removed, the deepest first.
    async stage(folders = AGENT_FOLDERS) {
      for (const folder of folders) {
        const full = Buffer.from(path.join(dir, folder))
        ensureDir(path.join(dir, folder), { mode: 0o700 })
        resetModes(full)
        removeEmptyFolders(full)
      }
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

    // Packs the repository's loose objects when git finds there are enough of them (`git gc
    // --auto`): every few thousand, which is a few hundred commits. It runs in the foreground,
    // after a commit, while the runner still holds `run.lock`, so no backup reads `.git` while git
    // rewrites it, and with no time limit: git stopped part-way would leave the programs it
    // started writing on their own. It packs only what is loose, and all of it again once every
    // 50 packs.
    async pack() {
      await run(['gc', '--auto', '--quiet'], { timeout: null })
    },

    // Throws away every change in `folders` since the last commit, so the next run starts from the
    // last good state (6.9). Nothing pi left can slow this down or stop it, and it frees what pi
    // wrote before it makes anything new, because pi may have filled the disk, and on a full disk
    // a new folder has no room:
    // 1. The folders are set aside, renamed into `discardDir`, which a start made and which is
    //    kept (`ensureAgentDir`). A rename takes the same time whatever they hold, and no room.
    // 2. Everything in `discardDir` is removed, with what earlier clean-ups couldn't remove
    //    (`emptyFolder`): without git, with no time limit, taking access back as it goes, however
    //    deep it goes. If that fails, it is logged, and tried again by the next clean-up and at
    //    the next start: it is out of pi's sight and git's.
    // 3. The folders are made again, empty, as the VM's mount points.
    // 4. The index is the last commit's again (`git read-tree HEAD`), in one step, whatever was
    //    staged. Taking a large number of names out of it one folder at a time takes time that
    //    grows faster than their number.
    // 5. The last commit's files are written back (`git restore`).
    // Then the folders are checked, without the limits on count and size: what is left is the last
    // commit, and the clean-up can't make that smaller. If anything else is still there, it throws.
    // Last, the objects that staging copied into the repository, which nothing refers to now, are
    // removed (`git prune`).
    async discardChanges(folders = AGENT_FOLDERS) {
      ensureDir(discardDir, { mode: 0o700 })
      for (const folder of folders) {
        const full = path.join(dir, folder)
        let stat = null
        try {
          stat = fs.lstatSync(full)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        if (stat === null) continue
        // A folder moves to another only if it can be written: its `..` changes.
        if (stat.isDirectory() && (stat.mode & 0o700) !== 0o700) fs.chmodSync(full, 0o700)
        fs.renameSync(full, freeName(discardDir, folder))
      }
      try {
        emptyFolder(discardDir)
      } catch (error) {
        log.warn('agent.discarded_left', { folder: path.basename(discardDir), ...errorFields(error) })
      }
      for (const folder of folders) ensureDir(path.join(dir, folder), { mode: 0o700 })
      await run(['read-tree', 'HEAD'])
      const kept = await tracked(folders)
      if (kept.length > 0) await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...kept])
      const left = await this.unexpectedFile(folders, { maxBytes: Infinity, maxCount: Infinity })
      if (left !== null) throw Object.assign(new Error(`the clean-up left ${left} in the agent's folder`), { code: 'EGIT' })
      // What the run staged is in `.git/objects` by now, copied there by `git add`, and the last
      // commit doesn't refer to it. Left there, each failed attempt could leave up to
      // `AGENT_FILES_MAX_BYTES` for good: `git gc` removes only what is two weeks old, and only
      // once thousands of objects are loose. Only the runner uses the repository, so what nothing
      // refers to now is the run's, and goes. A failure changes nothing else, and the next
      // clean-up tries again.
      try {
        await run(['prune', '--expire=now'])
      } catch (error) {
        log.warn('agent.prune_failed', errorFields(error))
      }
    },

    // Removes the lock files git left in the repository, and returns their paths from `.git`.
    // git leaves one when it is killed while it holds it, by a power cut or a `SIGKILL` during
    // `git add`, `git commit` or `git restore`, and then refuses to change the index or the branch
    // until someone removes it. These are `index.lock` and the others at the top of `.git`, and
    // those of the refs, such as `refs/heads/main.lock`. Only for startup: the runner holds
    // `runner/runner.sock` (D90), so no git of its own can be running.
    removeLeftoverLocks() {
      const removed = []
      const visit = (folder, relative, deeper) => {
        let entries
        try {
          entries = fs.readdirSync(folder, { withFileTypes: true })
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return
          throw error
        }
        for (const entry of entries) {
          const inner = relative === '' ? entry.name : `${relative}/${entry.name}`
          if (entry.isFile() && entry.name.endsWith('.lock')) {
            fs.rmSync(path.join(folder, entry.name), { force: true })
            removed.push(inner)
          } else if (entry.isDirectory() && deeper(inner)) {
            visit(path.join(folder, entry.name), inner, () => true)
          }
        }
      }
      visit(path.join(dir, '.git'), '', inner => inner === 'refs')
      return removed.sort()
    },
  }
}

const DOT = '.'.charCodeAt(0)

// A path in `folder` for `name` that nothing has, `<name>-<n>`, so a folder set aside never
// meets what an earlier clean-up couldn't remove.
function freeName(folder, name) {
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, `${name}-${n}`)
    try {
      fs.lstatSync(candidate)
    } catch (error) {
      if (error.code === 'ENOENT') return candidate
      throw error
    }
  }
}

// The entries of the folder at `full` (bytes), without following links, sorted by name; their
// names are bytes too. The folder is read as a stream, and at most `limit` entries are taken:
// `over` is the name of the next one, or null when there was none. So a folder of millions of
// names costs no more than `limit` of them.
function entriesOf(full, limit = Infinity) {
  const entries = []
  let over = null
  const dir = fs.opendirSync(full, { encoding: 'buffer' })
  try {
    for (let entry; (entry = dir.readSync()) !== null; ) {
      if (entries.length >= limit) {
        over = entry.name
        break
      }
      entries.push(entry)
    }
  } finally {
    dir.closeSync()
  }
  return { entries: entries.sort((a, b) => Buffer.compare(a.name, b.name)), over }
}

// Whether the runner may `mode` (`fs.constants`) the file or folder at `full`. Not when its path is
// longer than the system takes, which pi can make by moving a folder into another.
function mayAccess(full, mode) {
  try {
    fs.accessSync(full, mode)
    return true
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'ENAMETOOLONG') return false
    throw error
  }
}

// What `unexpectedFile` finds without git: the first entry, in name order, that is a dot name;
// neither a regular file nor a folder; a file the runner can't read, or one with more than one
// name; a folder it can't read and search; a path longer than the system takes; the name at which
// the files and folders so far pass `maxCount`, in the order the folder gives them; or the file at
// which the sizes of the files so far pass `maxBytes`. `folders` are paths from `dir`, walked in
// their order. The path returned is for people: a name that isn't UTF-8 shows its bytes as `�`.
// The walk goes one call deeper for each folder, which the system's limit on a path's length
// keeps to about 2,000.
export function findUnexpected(dir, folders = AGENT_FOLDERS, { maxBytes = Infinity, maxCount = Infinity } = {}) {
  const { R_OK, X_OK } = fs.constants
  let bytes = 0
  let count = 0
  function walk(full, relative) {
    if (!mayAccess(full, R_OK | X_OK)) return relative
    const { entries, over } = entriesOf(full, maxCount - count)
    if (over !== null) return `${relative}/${over.toString()}`
    count += entries.length
    for (const entry of entries) {
      const inner = `${relative}/${entry.name.toString()}`
      if (entry.name[0] === DOT) return inner
      const innerFull = childPath(full, entry.name)
      if (entry.isDirectory()) {
        const found = walk(innerFull, inner)
        if (found !== null) return found
        continue
      }
      if (!entry.isFile() || !mayAccess(innerFull, R_OK)) return inner
      // Its size as the file system gives it: a file with holes weighs what git would read.
      const stat = fs.lstatSync(innerFull)
      if (stat.nlink > 1) return inner
      bytes += stat.size
      if (bytes > maxBytes) return inner
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

// Gives the folder at `full` (bytes), and everything in it, the modes the runner gives what it
// makes: 0700 on folders, and on files 0600, or 0700 when the owner may run them, which is all of
// a mode git records. Only a mode that differs is set. The check has found everything there
// readable, and no more of it than its limits.
function resetModes(full) {
  const stat = fs.lstatSync(full)
  // A mode set by path would be set on what a link leads to. The check has let no link through.
  if (!stat.isDirectory() && !stat.isFile()) return
  const wanted = stat.isDirectory() ? 0o700 : stat.mode & 0o100 ? 0o700 : 0o600
  if ((stat.mode & 0o7777) !== wanted) fs.chmodSync(full, wanted)
  if (!stat.isDirectory()) return
  for (const entry of entriesOf(full).entries) resetModes(childPath(full, entry.name))
}

// Removes every empty folder inside the folder at `full` (bytes), the deepest first, so that a
// folder that held only empty folders goes too; `full` itself stays. Its modes have been put back.
function removeEmptyFolders(full) {
  for (const entry of entriesOf(full).entries) {
    if (!entry.isDirectory()) continue
    const inner = childPath(full, entry.name)
    removeEmptyFolders(inner)
    if (entriesOf(inner, 0).over === null) fs.rmdirSync(inner)
  }
}
