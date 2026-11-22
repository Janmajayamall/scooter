// Git, as the runner uses it on an agent's folder.
//
// The runner is the only committer. Every git command runs through `proc.mjs`, from an argument
// list, with an environment of its own:
// - the repository is named outright, as the agent's `.git` and the agent's folder, so git never
//   looks for one above it, such as a developer's checkout that holds the data folder;
// - no system or user git config, so nothing on the machine changes what git does here;
// - no hooks and no signing;
// - the author and the time from the runner, as `Scooter <scooter@localhost>`;
// - every path taken as it is written, never as a pattern (`GIT_LITERAL_PATHSPECS`): the paths
//   come from `writes`, which the owner writes;
// - no maintenance started by a command on its own, which would go on in the background after the
//   command returned, outside `run.lock`. The runner packs the repository itself (`pack`).
//
// The repository keeps what the agent's `writes` names in its folder (`agent.repository`, from
// `config.mjs`): its entries, files or folders, a folder ending in `/`, such as `views/`. After each
// run the runner checks what pi left there, commits it, or throws it away. A path of `writes`
// outside the agent's folder is none of the repository's, and the runner never reads it.
//
// pi chose every name, mode, size and depth there, and the number of files. So the check walks the
// entries by the bytes of their names, without following links, and counts and weighs what they
// hold before git reads any of it; staging puts back the modes, which git doesn't record; and the
// clean-up sets the entries aside, frees what pi wrote, and takes the last commit's back, which
// nothing pi left can slow down or stop, not even a disk it filled. Nothing pi leaves can stop the
// runner, at the end of a run or at its next start.

import fs from 'node:fs'
import path from 'node:path'
import { childPath, emptyFolder, ensureDir } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { systemClock } from '../common/time.mjs'

export const AUTHOR = { name: 'Scooter', email: 'scooter@localhost' }

// An entry of the repository's as git and the file system take it: its path from the agent's
// folder, without the `/` that ends a folder's.
const pathOf = entry => entry.replace(/\/$/, '')
const isFolderEntry = entry => entry.endsWith('/')

// Whether git's `name` is the path `p`, or in it.
const isIn = (name, p) => name === p || name.startsWith(`${p}/`)

// Settings given on every command line, ahead of the command. `maintenance.auto=false` keeps
// `git commit` from starting `git gc` on its own; `gc.autoDetach=false` keeps the runner's own
// `git gc --auto` in the foreground.
const CONFIG = [
  ...['-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null'],
  ...['-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false', '-c', 'maintenance.autoDetach=false'],
]

// Returns git for the repository in `dir`. `proc` is what `createProc` returns. `entries` is what
// the repository keeps (`agent.repository`). `discardDir` is where the clean-up sets what it
// throws away aside (`paths.agentDiscarded`), and `log` where it says what it couldn't remove
// there.
export function createGit({ proc, dir, entries = [], discardDir, log, clock = systemClock }) {
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
      GIT_LITERAL_PATHSPECS: '1',
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

  // The paths of `given`, entries of the repository, that the last commit has in the shape the entry
  // gives: a folder that holds files, for a folder; a file, for a file. What it has in the other
  // shape, as a change of `writes` can leave, isn't the entry's any more. git given no path would
  // take the whole tree, so it is given none then.
  async function tracked(given) {
    if (given.length === 0) return []
    const { stdout } = await run(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...given.map(pathOf)])
    const names = stdout.split('\0').filter(Boolean)
    return given.filter(entry => names.some(name => (isFolderEntry(entry) ? name.startsWith(entry) : name === entry))).map(pathOf)
  }

  // The paths of `paths` that are on disk or in git's index: those `git add` takes. git refuses a
  // path that is neither, such as a file of `writes` the agent hasn't made.
  async function present(paths) {
    if (paths.length === 0) return []
    const { stdout } = await run(['ls-files', '-z', '--', ...paths])
    const names = stdout.split('\0').filter(Boolean)
    return paths.filter(p => exists(path.join(dir, p)) || names.some(name => isIn(name, p)))
  }

  // The first path in `paths` with a change that isn't staged, or null.
  async function firstUnstaged(paths) {
    const { stdout } = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths])
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

    // The first thing in `given` (the repository's entries by default) that git wouldn't record,
    // as a path from the agent's folder, or null when there is none: an entry that isn't the shape
    // `writes` gives it, a folder or a file; anything that isn't a regular file or a folder, such
    // as a link; any name starting with `.`, such as a `.gitignore` or a
    // nested `.git`; a file the runner can't read, or a folder it can't read and search, or a path
    // longer than the system takes, which git would pass over or fail on; a file with more than one
    // name, which git would record as two; the name at which the entries pass `maxCount` files and
    // folders in all, or the file at which they pass `maxBytes`, which git would take too long
    // over; and any file git ignores. All but the last are found without git, so git reads nothing
    // before the files have been counted and weighed.
    async unexpectedFile(given = entries, { maxBytes = limits.AGENT_FILES_MAX_BYTES, maxCount = limits.AGENT_FILES_MAX_COUNT } = {}) {
      const paths = given.map(pathOf)
      const found = findUnexpected(dir, given, { maxBytes, maxCount })
      if (found !== null || paths.length === 0) return found
      const { stdout } = await run(['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', ...paths])
      const ignored = stdout.split('\0').find(entry => entry.startsWith('!! '))
      return ignored === undefined ? null : ignored.slice(3)
    },

    // Stages everything in `given` (the repository's entries by default) with `git add -A`, and
    // returns null, or the first path git wouldn't add: a name it refuses, such as `git~1`. Such a
    // path is something git wouldn't record, so this is the last step of the check of the files pi
    // left, after `unexpectedFile`, which must have passed. git goes on past it (`--ignore-errors`)
    // and leaves it unstaged, which is how it is found. A failure that leaves nothing unstaged
    // isn't a name's, and throws.
    //
    // First it makes each folder of `given` again if it is gone, and puts back what git doesn't
    // record:
    // - the modes. git keeps only whether a file can be run, and pi chose the rest, such as a
    //   folder no later run could write. Folders get 0700, and files 0600, or 0700 when they can
    //   be run (`resetModes`).
    // - empty folders. An ordinary run can leave one, such as a folder once the only file a skill
    //   kept in it is gone, so it doesn't fail the run; but it would carry over to later runs
    //   outside git. They are removed, the deepest first. A folder of `given` itself stays.
    // A file of `given` that isn't there, and isn't in the last commit, isn't given to git, which
    // would refuse it; one that is in the last commit is, and its removal staged. So is what the
    // last commit has at an entry in the other shape, which the clean-up left out. An entry with a
    // file on its way is passed over (`discardChanges`).
    async stage(given = entries) {
      for (const entry of given) {
        const full = path.join(dir, pathOf(entry))
        if (isFolderEntry(entry)) makeFolder(full)
        if (!exists(full)) continue
        resetModes(Buffer.from(full))
        if (fs.lstatSync(full).isDirectory()) removeEmptyFolders(Buffer.from(full))
      }
      const paths = await present(given.map(pathOf))
      if (paths.length === 0) return null
      const { code } = await run(['add', '-A', '--ignore-errors', '--', ...paths], { codes: [0, 1] })
      if (code === 0) return null
      const left = await firstUnstaged(paths)
      if (left === null) throw Object.assign(new Error('git add: exit code 1, with everything staged'), { code: 'EGIT', exitCode: 1, timedOut: false })
      return left
    },

    // Commits what `stage` staged in `given` (the repository's entries by default) with
    // `message`, if it differs from the last commit. Returns whether there was a commit.
    async commitStaged(message, given = entries) {
      const paths = given.map(pathOf)
      if (paths.length === 0) return false
      const { code } = await run(['diff', '--cached', '--quiet', '--', ...paths], { codes: [0, 1] })
      if (code === 0) return false
      await this.commit(message)
      return true
    },

    // The last commit's ID.
    async head() {
      return (await run(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    },

    // Tags the last commit `name`, as a rebuild does first. A name already taken fails.
    async tag(name) {
      await run(['tag', name, 'HEAD'])
    },

    // Makes `commit` the branch's last commit again, leaving the index and the files as they are,
    // so that the next commit holds every change since `commit` (`git reset --soft`).
    async resetTo(commit) {
      await run(['reset', '--soft', '--quiet', commit])
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

    // Throws away every change in `given` (the repository's entries by default) since the last
    // commit, so the next run starts from the last good state. Nothing pi left can slow this down
    // or stop it, and it frees what pi wrote before it makes anything new, because pi may have
    // filled the disk, and on a full disk a new folder has no room:
    // 1. Each entry that is there is set aside, renamed into `discardDir`, which a start made and
    //    which is kept (`ensureAgentDir`), under a number of its own, so the name is never longer
    //    than the system takes. A rename takes the same time whatever it holds, and no room.
    // 2. Everything in `discardDir` is removed, with what earlier clean-ups couldn't remove
    //    (`emptyFolder`): without git, with no time limit, taking access back as it goes, however
    //    deep it goes. If that fails, it is logged, and tried again by the next clean-up and at
    //    the next start: it is out of pi's sight and git's.
    // 3. The folders of `given` are made again, empty, and the folder each file of `given` is in,
    //    so a file the agent may make has a folder to be made in. Only now: on a disk pi filled,
    //    a folder has room once what pi wrote is freed. Where a file lies on the way, as a change
    //    of `writes` can leave one, nothing is made, the entry is passed over as one that isn't
    //    there, and that is logged as `agent.entry_blocked`.
    // 4. The index is the last commit's again (`git read-tree HEAD`), in one step, whatever was
    //    staged. Taking a large number of names out of it one folder at a time takes time that
    //    grows faster than their number.
    // 5. The last commit's files are written back (`git restore`), for each entry in the shape the
    //    entry gives (`tracked`): what the last commit has there in the other shape, as a change of
    //    `writes` can leave, is left out, and the next commit records its removal.
    // Then the entries are checked, without the limits on count and size: what is left is the last
    // commit, and the clean-up can't make that smaller. If anything else is still there, it throws.
    // Last, the objects that staging copied into the repository, which nothing refers to now, are
    // removed (`git prune`).
    async discardChanges(given = entries) {
      ensureDir(discardDir, { mode: 0o700 })
      for (const entry of given) {
        const full = path.join(dir, pathOf(entry))
        const stat = lstatOrNull(full)
        if (stat === null) continue
        // A folder moves to another only if it can be written: its `..` changes.
        if (stat.isDirectory() && (stat.mode & 0o700) !== 0o700) fs.chmodSync(full, 0o700)
        fs.renameSync(full, freeName(discardDir))
      }
      try {
        emptyFolder(discardDir)
      } catch (error) {
        log.warn('agent.discarded_left', { folder: path.basename(discardDir), ...errorFields(error) })
      }
      const open = given.filter(entry => {
        const full = path.join(dir, pathOf(entry))
        if (makeFolder(isFolderEntry(entry) ? full : path.dirname(full))) return true
        log.warn('agent.entry_blocked', { agent: path.basename(dir), entry: pathOf(entry) })
        return false
      })
      await run(['read-tree', 'HEAD'])
      const kept = await tracked(open)
      if (kept.length > 0) await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...kept])
      const left = await this.unexpectedFile(given, { maxBytes: Infinity, maxCount: Infinity })
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
    // `runner/runner.sock`, so no git of its own can be running.
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

// What is at `full`, not following a link there, or null when nothing is: `ENOENT`, or `ENOTDIR`
// when a file lies on the way, where a path names nothing.
function lstatOrNull(full) {
  try {
    return fs.lstatSync(full)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

// Whether there is anything at `full`, a link included.
const exists = full => lstatOrNull(full) !== null

// Makes the folder `full`, and those on the way, 0700, as `ensureDir` does, and returns whether a
// folder is there now: false when something else lies in the way, a file on the way or at `full`,
// which a change of `writes` can leave, and which isn't the runner's to remove.
function makeFolder(full) {
  try {
    ensureDir(full, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'ENOTDIR' && error.code !== 'EEXIST') throw error
  }
  return lstatOrNull(full)?.isDirectory() ?? false
}

// A path in `folder` that nothing has, a number, so what is set aside never meets what an earlier
// clean-up couldn't remove, and its name is never too long, whatever the entry's was.
function freeName(folder) {
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, String(n))
    if (!exists(candidate)) return candidate
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
// which the sizes of the files so far pass `maxBytes`. `given` are the repository's entries, from
// `dir`, each a file or a folder, a folder ending in `/`, walked in their order: one that isn't
// there, also for a file on its way, is passed over; one that is there in the other shape is the
// unexpected file itself; and one that is a file counts as a name. The path returned is for
// people: a name that isn't UTF-8 shows its bytes as `�`. The walk goes one call deeper for each
// folder, which the system's limit on a path's length keeps to about 2,000.
export function findUnexpected(dir, given, { maxBytes = Infinity, maxCount = Infinity } = {}) {
  const { R_OK, X_OK } = fs.constants
  let bytes = 0
  let count = 0
  // What is at `full`: a folder is walked; a file is weighed; anything else is unexpected.
  function visit(full, relative, { folder, file }) {
    if (folder) return walk(full, relative)
    if (!file || !mayAccess(full, R_OK)) return relative
    // Its size as the file system gives it: a file with holes weighs what git would read.
    const stat = fs.lstatSync(full)
    if (stat.nlink > 1) return relative
    bytes += stat.size
    return bytes > maxBytes ? relative : null
  }
  function walk(full, relative) {
    if (!mayAccess(full, R_OK | X_OK)) return relative
    const { entries, over } = entriesOf(full, maxCount - count)
    if (over !== null) return `${relative}/${over.toString()}`
    count += entries.length
    for (const entry of entries) {
      const inner = `${relative}/${entry.name.toString()}`
      if (entry.name[0] === DOT) return inner
      const found = visit(childPath(full, entry.name), inner, { folder: entry.isDirectory(), file: entry.isFile() })
      if (found !== null) return found
    }
    return null
  }
  for (const entry of given) {
    const p = pathOf(entry)
    const full = Buffer.from(path.join(dir, p))
    const stat = lstatOrNull(full)
    if (stat === null) continue
    // A folder where `writes` names a file, or a file where it names a folder, as a change of
    // `writes` can leave: the VM can change neither, and the clean-up leaves it out.
    if (stat.isDirectory() !== isFolderEntry(entry)) return p
    if (!stat.isDirectory()) {
      count += 1
      if (count > maxCount) return p
    }
    const found = visit(full, p, { folder: stat.isDirectory(), file: stat.isFile() })
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
