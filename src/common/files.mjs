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

// The path of `name` in the folder `parent`, as bytes. Walking a folder by the bytes of its names
// reaches every name as it is on disk: one that isn't UTF-8 doesn't survive a round trip through a
// string.
export function childPath(parent, name) {
  return Buffer.concat([Buffer.from(parent), Buffer.from('/'), Buffer.from(name)])
}

// Removes `target` and everything under it, without following links: a link goes as a link. A
// `target` that isn't there is fine. `target` is a path, as a string or as bytes.
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
// The program must have stopped: a mode is set by path after the entry was looked at, which a
// program still writing could swap for a link.
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
  if ((stat.mode & 0o700) !== 0o700) fs.chmodSync(target, 0o700)
  const dir = fs.opendirSync(target, { encoding: 'buffer' })
  try {
    for (let entry; (entry = dir.readSync()) !== null; ) removeTree(childPath(target, entry.name))
  } finally {
    dir.closeSync()
  }
  fs.rmdirSync(target)
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
