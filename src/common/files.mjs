// Files: atomic writes, the folder hand-off, sortable IDs, and removing a folder another program
// wrote.
//
// Two services and several programs share Scooter's folders, so a reader must never see half of
// anything. A file is written under a temporary name and renamed into place. A folder that is
// handed from one program to another, such as an outbox entry (5.3 of DESIGN.md) or a mail spool
// folder (5.6), is filled as `.tmp-<id>` and renamed to `<id>` once it's complete.

import fs from 'node:fs'
import path from 'node:path'
import { systemClock, utcStamp } from './time.mjs'

// The prefix of everything unfinished. Readers skip names that start with a dot.
export const TMP_PREFIX = '.tmp-'

let tmpCounter = 0

function fsyncPath(target) {
  const fd = fs.openSync(target, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// Sets the owner of a file or folder. Without an owner this does nothing: a process that isn't
// root can't give files away, and skips it (section 10).
export function setOwner(target, owner) {
  if (owner) fs.chownSync(target, owner.uid, owner.gid)
}

// Creates a folder and every missing folder above it. Each folder it creates gets `mode`, whatever
// the umask is, and `owner` (`{ uid, gid }`) if one is given. Folders already there are left alone.
export function ensureDir(dir, { mode = 0o700, owner } = {}) {
  const missing = []
  let current = path.resolve(dir)
  while (!fs.existsSync(current)) {
    missing.unshift(current)
    current = path.dirname(current)
  }
  for (const folder of missing) {
    try {
      fs.mkdirSync(folder, { mode })
    } catch (error) {
      if (error.code === 'EEXIST') continue
      throw error
    }
    fs.chmodSync(folder, mode)
    setOwner(folder, owner)
  }
}

// Writes a file so that a reader sees either the old contents or the new, never a part: a
// temporary file beside it, synced, then renamed over it. The file gets `mode` whatever the umask
// is, and `owner` if one is given.
export function writeFileAtomic(file, data, { mode = 0o600, owner } = {}) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `${TMP_PREFIX}${path.basename(file)}-${process.pid}-${++tmpCounter}`)
  try {
    const fd = fs.openSync(tmp, 'wx', mode)
    try {
      fs.writeFileSync(fd, data)
      fs.fchmodSync(fd, mode)
      if (owner) fs.fchownSync(fd, owner.uid, owner.gid)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
  fsyncPath(dir)
}

// Reads a JSON file. Returns undefined when there is no such file.
export function readJsonFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text)
}

// Copies a file that another program wrote, in a folder that program controls, into a folder of
// Scooter's own: a download in wacli's staging folder (5.2), or an attachment in the mail spool
// (5.6). The bridge runs as root and the other program doesn't, so the other program could leave
// something in the file's place that gets root to copy what the program can't read itself:
// - a symbolic link: the file is opened without following a link at the end of its path;
// - a hard link to someone else's file: the file must have exactly one name, and, when `owner` is
//   given, belong to that user;
// - a FIFO or a device: it must be a regular file, checked on what was opened, and opening doesn't
//   wait for a writer;
// - something huge: at most `maxBytes` are copied, and a larger file is refused.
//
// The copy is written under a temporary name beside `target`, with `mode`, synced, and renamed into
// place. Returns its size. Throws an error with the code `EUNTRUSTED` when the file isn't one to
// copy, and `EFBIG` when it is too large; otherwise the system's error.
export async function copyUntrustedFile(source, target, { owner = null, maxBytes, mode = 0o600 }) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  const refuse = (code, why) => Object.assign(new Error(`not copied: ${why}`), { code })
  let input
  try {
    input = await fs.promises.open(source, flags)
  } catch (error) {
    // Linux says ELOOP for a link at the end of the path, and macOS EMLINK or ELOOP.
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw refuse('EUNTRUSTED', 'a symbolic link')
    throw error
  }
  const tmp = path.join(path.dirname(target), `${TMP_PREFIX}${path.basename(target)}-${process.pid}-${++tmpCounter}`)
  let output
  try {
    const stat = await input.stat()
    if (!stat.isFile()) throw refuse('EUNTRUSTED', 'not a regular file')
    if (stat.nlink !== 1) throw refuse('EUNTRUSTED', 'a file with more than one name')
    if (owner && stat.uid !== owner.uid) throw refuse('EUNTRUSTED', 'a file of another user')
    if (stat.size > maxBytes) throw refuse('EFBIG', 'too large')

    output = await fs.promises.open(tmp, 'wx', mode)
    const buffer = Buffer.alloc(1024 * 1024)
    let bytes = 0
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      bytes += bytesRead
      // It may still be growing, whatever its size was when it was opened.
      if (bytes > maxBytes) throw refuse('EFBIG', 'too large')
      await output.write(buffer, 0, bytesRead)
    }
    await output.chmod(mode)
    await output.sync()
    await output.close()
    output = null
    fs.renameSync(tmp, target)
    return bytes
  } catch (error) {
    await output?.close()
    fs.rmSync(tmp, { force: true })
    throw error
  } finally {
    await input.close()
  }
}

// Reads a small file that another program wrote, in a folder that program controls, such as an
// outbox entry, which the runner's user writes and the bridge, as root, reads (5.3). As with
// `copyUntrustedFile`, it is opened without following a link at the end of its path and without
// waiting for a writer, and it must be a regular file with exactly one name, of at most `maxBytes`.
// Returns its contents as text. Throws an error with the code `EUNTRUSTED` when the file isn't one
// to read, `EFBIG` when it is too large, and the system's error otherwise, `ENOENT` among them.
export function readUntrustedFile(file, { maxBytes }) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  const refuse = (code, why) => Object.assign(new Error(`not read: ${why}`), { code })
  let fd
  try {
    fd = fs.openSync(file, flags)
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw refuse('EUNTRUSTED', 'a symbolic link')
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw refuse('EUNTRUSTED', 'not a regular file')
    if (stat.nlink !== 1) throw refuse('EUNTRUSTED', 'a file with more than one name')
    if (stat.size > maxBytes) throw refuse('EFBIG', 'too large')
    // One byte more than allowed tells a file that grew since from one that didn't.
    const buffer = Buffer.alloc(maxBytes + 1)
    let filled = 0
    for (;;) {
      const count = fs.readSync(fd, buffer, filled, buffer.length - filled, null)
      if (count === 0) break
      filled += count
      if (filled > maxBytes) throw refuse('EFBIG', 'too large')
    }
    return buffer.toString('utf8', 0, filled)
  } finally {
    fs.closeSync(fd)
  }
}

// The path of `name` in the folder `parent`, as bytes. Walking a folder by the bytes of its names
// reaches every name as it is on disk: one that isn't UTF-8 doesn't survive a round trip through a
// string.
export function childPath(parent, name) {
  return Buffer.concat([Buffer.from(parent), Buffer.from('/'), Buffer.from(name)])
}

// The longest path, in bytes, of a folder that `emptyFolder` reads where it is. A name is at most
// 255 bytes, so every entry of such a folder has a path the system takes: Linux takes paths of up
// to 4,095 bytes, and macOS of up to 1,023, which is 767 + 1 + 255.
const NAME_MAX = 255
const PATH_MAX = 1023
const FOLDER_PATH_MAX = PATH_MAX - 1 - NAME_MAX

// What a folder that `emptyFolder` moves to the top of the folder it empties is called, with a
// number after it. Another name there is no matter: a rename that would take one tries the next
// number.
const MOVED_PREFIX = 'moved-'
const NAME_TAKEN = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EINVAL'])

// Gives the runner back read, write and search on the folder at `folder`.
function takeFolderBack(folder) {
  if ((fs.lstatSync(folder).mode & 0o700) !== 0o700) fs.chmodSync(folder, 0o700)
}

// Removes `target` and everything under it, without following links: a link goes as a link. A
// `target` that isn't there is fine. `target` is a path, as a string or as bytes. It is for what a
// sandboxed program wrote (6.6, 6.9 of DESIGN.md), and nothing in it can stop the removal
// (`emptyFolder`).
export function removeTree(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(target)
    return
  }
  emptyFolder(target)
  fs.rmdirSync(target)
}

// Removes everything in the folder `target`, without following links, and leaves the folder, empty
// and the runner's. A `target` that isn't there is fine. It makes nothing new, so it can free a
// disk that is full: it only removes, and renames within the folder.
//
// It is for a folder that a sandboxed program wrote (6.6, 6.9 of DESIGN.md), and nothing in it can
// stop the removal:
// - pi runs as root in its VM, and what it writes there belongs to the runner on the host, so it
//   can take the runner's access away from a file or a whole folder. Each folder is given back
//   read, write and search before it is read; removing a file needs no access to the file itself.
// - Names are read as bytes, so a name that isn't UTF-8 is reached as it is on disk.
// - Each folder is read as a stream, one entry at a time, and each entry is removed as it comes,
//   so a folder of millions of names takes time, about 7 microseconds a name on the plan's Linux
//   machine, but no more memory than one of a few.
// - pi can nest folders as deep as it likes: `mkdir` stops where the host's path would pass what
//   the system takes, but moving a folder into another doesn't. Each entry is reached by its path,
//   so a folder whose path would pass `FOLDER_PATH_MAX` is first moved to the top of `target`,
//   under a short name, and emptied from there; `target`'s own path must be short. And the folders
//   being read are kept in a list, not one call inside another, so the depth costs neither the
//   call stack nor more than `FOLDER_PATH_MAX / 2` open folders.
// - An entry it can't remove is passed over, so everything else goes. The first error is thrown
//   at the end; what is left is tried again by the next removal.
// The program must have stopped: a mode is set by path after the entry was looked at, which a
// program still writing could swap for a link.
export function emptyFolder(target) {
  const root = Buffer.from(target)
  let stat
  try {
    stat = fs.lstatSync(root)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory()) throw Object.assign(new Error(`not a folder: ${root.toString()}`), { code: 'ENOTDIR' })

  let failure = null
  const attempt = action => {
    try {
      action()
    } catch (error) {
      failure ??= error
    }
  }
  let counter = 0
  let moved = 0
  const moveToTop = folder => {
    // A folder moves to another only if it can be written: its `..` changes.
    takeFolderBack(folder)
    for (;;) {
      try {
        fs.renameSync(folder, childPath(root, `${MOVED_PREFIX}${++counter}`))
        moved++
        return
      } catch (error) {
        if (!NAME_TAKEN.has(error.code)) throw error
      }
    }
  }

  // One pass over `root`, depth first. A folder moved to the top while it runs may be read in this
  // pass or not, so another pass follows any pass that moved one. Each folder moves once at most,
  // since one at the top never moves again.
  const pass = () => {
    const open = []
    const enter = folder => {
      takeFolderBack(folder)
      open.push({ folder, dir: fs.opendirSync(folder, { encoding: 'buffer' }) })
    }
    attempt(() => enter(root))
    try {
      while (open.length > 0) {
        const { folder, dir } = open.at(-1)
        let entry = null
        let read = true
        try {
          entry = dir.readSync()
        } catch (error) {
          failure ??= error
          read = false
        }
        if (entry === null) {
          dir.closeSync()
          open.pop()
          // `root` stays.
          if (read && open.length > 0) attempt(() => fs.rmdirSync(folder))
          continue
        }
        const inner = childPath(folder, entry.name)
        if (!entry.isDirectory()) attempt(() => fs.unlinkSync(inner))
        else if (open.length > 1 && inner.length > FOLDER_PATH_MAX) attempt(() => moveToTop(inner))
        else attempt(() => enter(inner))
      }
    } finally {
      for (const { dir } of open) dir.closeSync()
    }
  }
  do {
    moved = 0
    pass()
  } while (moved > 0)
  if (failure !== null) throw failure
}

// IDs that sort in the order they were made: the UTC time to the millisecond and a counter, such
// as `20261109T155015123-0001`. The counter starts again at 1 with each new millisecond.
//
// IDs from one generator always go up, even if the clock goes back. Two processes can still make
// the same ID in the same millisecond; `handOff` settles that when it renames.
export function createIds(clock = systemClock) {
  let last = -Infinity
  let counter = 0
  return {
    next() {
      let now = Math.max(Math.floor(clock.now()), last)
      // The counter has four digits. When a millisecond runs out of them, move on to the next.
      if (now === last && counter === 9999) now = last + 1
      counter = now === last ? counter + 1 : 1
      last = now
      return `${utcStamp(last)}-${String(counter).padStart(4, '0')}`
    },
  }
}

// Hands a folder over: creates `<parent>/.tmp-<id>/`, lets `fill(dir)` put the files in it, syncs
// them, and renames it to `<parent>/<id>`. Returns the ID it ended up with.
//
// `ids` is a generator from `createIds`. If another writer has taken the name, at either step,
// the folder takes the next ID.
export async function handOff(parent, ids, fill, { mode = 0o700 } = {}) {
  let id = ids.next()
  let tmp
  for (;;) {
    tmp = path.join(parent, `${TMP_PREFIX}${id}`)
    try {
      fs.mkdirSync(tmp, { mode })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      id = ids.next()
    }
  }
  try {
    fs.chmodSync(tmp, mode)
    await fill(tmp)
    for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (entry.isFile()) fsyncPath(path.join(tmp, entry.name))
    }
    fsyncPath(tmp)
    for (;;) {
      const target = path.join(parent, id)
      // `rename` would replace an empty folder of the same name, and take a file's place.
      // A name that exists in any form is taken.
      if (!fs.existsSync(target)) {
        try {
          fs.renameSync(tmp, target)
          break
        } catch (error) {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
        }
      }
      id = ids.next()
    }
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw error
  }
  fsyncPath(parent)
  return id
}

// The folders handed over and not yet taken, oldest first. Unfinished ones aren't listed.
export function listHandOffs(parent) {
  let names
  try {
    names = fs.readdirSync(parent)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return names.filter(name => !name.startsWith('.')).sort()
}
