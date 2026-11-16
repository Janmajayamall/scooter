// Files: atomic writes, the folder hand-off, and sortable IDs.
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
