// A full disk, for the runner's tests (6.9 of DESIGN.md; the fourth review of milestone 4).
//
// While `isFull()` says so, this process can make nothing new, neither a folder nor a file, as on
// ext4, where a new folder needs a block of its own and a full disk has none. Removing, renaming,
// reading, and writing to a file already open still work. Other processes, such as git and the pi
// stub, are left alone: a test makes the disk act full only once pi has left what fills it, and
// git, which the runner runs after it has freed that, writes as on any disk.
//
// A hermetic test can't fill a real file system. This shows what the runner tries to make, and
// when: anything it makes before it has freed what pi wrote fails with `ENOSPC`, as it would there.

import fs from 'node:fs'

// Makes `fs` act full while `isFull()` returns true. Returns a function that puts `fs` back.
export function actFull(isFull) {
  const creates = flags => (typeof flags === 'number' ? (flags & fs.constants.O_CREAT) !== 0 : /^[wa]/.test(flags ?? 'r'))
  const refuse = (syscall, target) => Object.assign(new Error(`ENOSPC: no space left on device, ${syscall} '${target}'`), { code: 'ENOSPC', errno: -28, syscall })
  // For each call that makes something: what it makes, from its arguments, or null when it makes
  // nothing.
  const makes = {
    mkdirSync: target => target,
    mkdtempSync: prefix => prefix,
    openSync: (target, flags) => (creates(flags) ? target : null),
    writeFileSync: (target, data, options) => (typeof target === 'number' ? null : creates(options?.flag ?? 'w') ? target : null),
    appendFileSync: (target, data, options) => (typeof target === 'number' ? null : creates(options?.flag ?? 'a') ? target : null),
    copyFileSync: (source, target) => target,
    symlinkSync: (source, target) => target,
    linkSync: (source, target) => target,
  }
  const originals = {}
  for (const [name, made] of Object.entries(makes)) {
    const original = fs[name]
    originals[name] = original
    fs[name] = (...args) => {
      const target = made(...args)
      if (target !== null && isFull()) throw refuse(name.replace(/Sync$/, ''), target)
      return original(...args)
    }
  }
  const originalOpen = fs.promises.open
  fs.promises.open = (target, flags = 'r', ...rest) => {
    if (creates(flags) && isFull()) return Promise.reject(refuse('open', target))
    return originalOpen(target, flags, ...rest)
  }
  return () => {
    Object.assign(fs, originals)
    fs.promises.open = originalOpen
  }
}

// Whether a file named `name` is anywhere under the folders `dirs`. Folders that aren't there hold
// nothing.
export function holds(dirs, name) {
  return dirs.some(dir => {
    try {
      return fs.readdirSync(dir, { recursive: true }).some(entry => entry === name || entry.endsWith(`/${name}`))
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  })
}
