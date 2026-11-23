// What a run's VM sees of the host, and what it may change.
//
// A run's spec says it in `files` (`index.mjs`): a folder, `root`, mounted at its own path, of
// which the VM sees only what `reads` and `writes` name, and may change only what `writes` names;
// `hide` names what it never sees, whatever the two say. For a run, `root` is the data folder.
//
// The sandbox mounts `root` through two providers of this module, over the one the sandbox gives
// it (`inner`, a `RealFSProvider` of `root`, counted against the run's budget):
//
// - `ViewShadow`, Gondolin's `ShadowProvider` with what it lacks or takes too far (`viewShadow`): a
//   path that is hidden, or that is neither in an entry of `reads` or `writes` nor a folder that
//   leads to one, isn't there. Reading it fails with ENOENT, and listings leave it out, also a
//   listing through a link on the host. A path that leads to such a path through a link on the
//   host is taken as that path (`denySymlinkBypass`); a link itself, which `lstat`, `readlink`,
//   `unlink` and `rename` act on, is judged by its own name.
// - `WritesProvider`, outermost, which refuses with EROFS every operation that changes something,
//   unless `writes` lets the run change that path, as Gondolin's `ReadonlyProvider` refuses them
//   all. It looks at the path the guest gave, and at the path the host would change, through
//   whatever links the host would follow on the way, and both must be allowed; nothing is done
//   through a link that leads nowhere.
//
// An entry of `writes` is a file or a folder:
// - **a folder** lets the run change everything in it, and the folder itself only by `mkdir`,
//   `rmdir` and `chmod`: so the run can make it when it isn't there, and can't put a file, a link
//   or another folder in its place, or move it;
// - **a file** lets the run write, make, truncate, `chmod`, remove, rename, link and make a link
//   at that one path, and not make a folder there or move one there, or act on one that is there.
//
// The operations that change something, as Gondolin's file system service calls them: `open` for
// writing (which is also how a file is made, and how `truncate` reaches a file), `mkdir`, `rmdir`,
// `unlink`, `rename` (from and to), `link` (the file linked to and the new name), `symlink`,
// `chmod` and `truncate`. Writes, `fallocate` and `copy_file_range` go through a file opened for
// writing, so they need nothing more. There is no `chown`, `utimes` or `mknod` in the service, so
// the VM can't make a FIFO or a device anywhere, and `touch` changes nothing on the host.
//
// The VM's own requests are trusted for nothing: pi runs as root in the VM, and could talk to the
// file system service itself rather than through the VM's kernel, with any name. So the checks are
// on normalized paths, and on what the host resolves them to.

import fs from 'node:fs'
import path from 'node:path'

const posix = path.posix

// Whether `p` is `folder` or inside it. Both are absolute paths from the root, `/` the root.
const within = (p, folder) => folder === '/' || p === folder || p.startsWith(`${folder}/`)
const strictlyWithin = (p, folder) => p !== folder && within(p, folder)

// A path from the root, normalized: `/`, `/agents/lifelog/views/a.csv`.
function normalize(p) {
  const clean = posix.normalize(`/${p}`)
  return clean.length > 1 && clean.endsWith('/') ? clean.slice(0, -1) : clean
}

// What `real`, in `viewShadow`, gives for a folder outside the root.
const OUTSIDE = Symbol('outside the root')

// The path from `root` of `full`, an absolute host path inside it, or null when it isn't inside.
function fromRoot(root, full) {
  const relative = path.relative(root, full)
  if (relative === '') return '/'
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return normalize(relative.split(path.sep).join('/'))
}

// An error the guest gets as that errno: Gondolin sends a code back as the errno of the call.
function errnoError(code, syscall, p) {
  return Object.assign(new Error(`${code}: ${syscall} '${p}'`), { code, errno: 0, syscall, path: p })
}

// The view of `files` (`checkRunSpec` checked it), as paths from the root:
// `{ shown, writes: [{ path, folder }], hide }`, `shown` being every entry of `reads` and `writes`.
export function viewOf(files) {
  const rel = full => {
    const found = fromRoot(files.root, full)
    if (found === null) throw new Error(`${full} isn't inside ${files.root}`)
    return found
  }
  const writes = files.writes.map(write => ({ path: rel(write.path), folder: write.folder }))
  return { shown: [...files.reads.map(rel), ...writes.map(write => write.path)], writes, hide: files.hide.map(rel) }
}

// Whether the VM sees `p`: not hidden, and in an entry it is shown, or a folder that leads to one.
export function isShown(view, p) {
  if (view.hide.some(hidden => within(p, hidden))) return false
  return view.shown.some(entry => within(p, entry) || within(entry, p))
}

// What `writes` lets the run do at `p`: `inside` a folder of `writes`, all; at a `folder` itself,
// `mkdir`, `rmdir` and `chmod`; at a `file`, all but `mkdir` and `rmdir`; otherwise, null, nothing.
export function writeRule(view, p) {
  if (view.hide.some(hidden => within(p, hidden))) return null
  if (view.writes.some(write => write.folder && strictlyWithin(p, write.path))) return 'inside'
  if (view.writes.some(write => write.folder && p === write.path)) return 'folder'
  if (view.writes.some(write => !write.folder && p === write.path)) return 'file'
  return null
}

const FOLDER_OPS = ['mkdir', 'rmdir', 'chmod']

// Whether `writes` lets the run do `op` at `p`.
export function allows(view, op, p) {
  const rule = writeRule(view, p)
  if (rule === 'inside') return true
  if (rule === 'folder') return FOLDER_OPS.includes(op)
  if (rule === 'file') return op !== 'mkdir' && op !== 'rmdir'
  return false
}

// Whether `flags`, as Gondolin gives them to `open`, open a file for writing.
function opensForWriting(flags) {
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0
  }
  return typeof flags !== 'string' || /[wa+]/.test(flags)
}

// Whether there is a link at `host`, a path on the host.
function isLinkOnHost(host) {
  try {
    return fs.lstatSync(host).isSymbolicLink()
  } catch {
    return false
  }
}

// The path on the host of `p`, a path from the root.
const hostPath = (rootReal, p) => (p === '/' ? rootReal : path.join(rootReal, p))

// The provider that refuses what `writes` doesn't let the run change. `rootReal` is the root on
// the host, with its links resolved, as `RealFSProvider` takes it.
function writesProvider(gondolin, view, rootReal, backend) {
  // Where on the host an operation on `p` lands, as a path from the root, or null when it lands
  // outside the root or can't be told: `follow` for an operation that follows a link at `p`
  // itself, as `open` and `chmod` do; otherwise only the links on the way to `p`'s folder count,
  // as for `unlink` and `rename`.
  //
  // A last name that is a link leading nowhere lands nowhere that can be told: the host would make
  // what the link names, wherever that is, so nothing is done through it. The VM's kernel never
  // asks that, since it follows a link itself.
  const landing = (p, follow) => {
    const host = hostPath(rootReal, p)
    if (follow) {
      try {
        return fromRoot(rootReal, fs.realpathSync(host))
      } catch (error) {
        if (error.code !== 'ENOENT' || isLinkOnHost(host)) return null
      }
    }
    if (p === '/') return '/'
    try {
      const folder = fromRoot(rootReal, fs.realpathSync(path.dirname(host)))
      return folder === null ? null : posix.join(folder, posix.basename(p))
    } catch {
      return null
    }
  }
  // Whether the host has a folder at `p`, not following a link there.
  const isFolderOnHost = p => {
    try {
      return fs.lstatSync(path.join(rootReal, p)).isDirectory()
    } catch {
      return false
    }
  }
  // Throws EROFS unless the run may do `op` at `given`, and at where it lands; returns both. A file
  // of `writes` never acts on a folder that is there in its place, which a rename would move whole.
  const check = (op, given, { follow, syscall = op } = {}) => {
    const p = normalize(given)
    const landed = allows(view, op, p) ? landing(p, follow) : null
    const allowed = landed !== null && allows(view, op, landed) && ![p, landed].some(at => writeRule(view, at) === 'file' && isFolderOnHost(at))
    if (!allowed) throw errnoError('EROFS', syscall, given)
    return { p, landed }
  }
  // A rename: both ends allowed, and no folder moved to where `writes` names a file, which would
  // then hold what the folder held.
  const checkRename = (from, to) => {
    const source = check('rename', from)
    const target = check('rename', to)
    if ([target.p, target.landed].some(at => writeRule(view, at) === 'file') && isFolderOnHost(source.landed)) throw errnoError('EROFS', 'rename', to)
  }

  class WritesProvider extends gondolin.VirtualProviderClass {
    get readonly() {
      return view.writes.length === 0
    }
    get supportsSymlinks() {
      return backend.supportsSymlinks
    }
    get supportsWatch() {
      return backend.supportsWatch
    }

    async open(p, flags, mode) {
      if (opensForWriting(flags)) check('open', p, { follow: true })
      return backend.open(p, flags, mode)
    }
    openSync(p, flags, mode) {
      if (opensForWriting(flags)) check('open', p, { follow: true })
      return backend.openSync(p, flags, mode)
    }
    async mkdir(p, options) {
      check('mkdir', p)
      return backend.mkdir(p, options)
    }
    mkdirSync(p, options) {
      check('mkdir', p)
      return backend.mkdirSync(p, options)
    }
    async rmdir(p) {
      check('rmdir', p)
      return backend.rmdir(p)
    }
    rmdirSync(p) {
      check('rmdir', p)
      return backend.rmdirSync(p)
    }
    async unlink(p) {
      check('unlink', p)
      return backend.unlink(p)
    }
    unlinkSync(p) {
      check('unlink', p)
      return backend.unlinkSync(p)
    }
    async rename(from, to) {
      checkRename(from, to)
      return backend.rename(from, to)
    }
    renameSync(from, to) {
      checkRename(from, to)
      return backend.renameSync(from, to)
    }
    // A hard link: the file linked to, which the host finds through links, and the new name.
    async link(existing, name) {
      check('link', existing, { follow: true })
      check('link', name)
      return backend.link(existing, name)
    }
    linkSync(existing, name) {
      check('link', existing, { follow: true })
      check('link', name)
      return backend.linkSync(existing, name)
    }
    async symlink(target, p, type) {
      check('symlink', p)
      return backend.symlink(target, p, type)
    }
    symlinkSync(target, p, type) {
      check('symlink', p)
      return backend.symlinkSync(target, p, type)
    }
    async chmod(p, mode) {
      check('chmod', p, { follow: true })
      return backend.chmod(p, mode)
    }
    chmodSync(p, mode) {
      check('chmod', p, { follow: true })
      return backend.chmodSync(p, mode)
    }
    async truncate(p, length) {
      check('truncate', p, { follow: true })
      const handle = await backend.open(p, 'r+')
      try {
        await handle.truncate(length)
      } finally {
        await handle.close()
      }
    }
    truncateSync(p, length) {
      check('truncate', p, { follow: true })
      const handle = backend.openSync(p, 'r+')
      try {
        handle.truncateSync(length)
      } finally {
        handle.closeSync()
      }
    }
    async access(p, mode) {
      return backend.access(p, mode)
    }
    accessSync(p, mode) {
      return backend.accessSync(p, mode)
    }
    async stat(p, options) {
      return backend.stat(p, options)
    }
    statSync(p, options) {
      return backend.statSync(p, options)
    }
    async lstat(p, options) {
      return backend.lstat(p, options)
    }
    lstatSync(p, options) {
      return backend.lstatSync(p, options)
    }
    async readdir(p, options) {
      return backend.readdir(p, options)
    }
    readdirSync(p, options) {
      return backend.readdirSync(p, options)
    }
    async readlink(p, options) {
      return backend.readlink(p, options)
    }
    readlinkSync(p, options) {
      return backend.readlinkSync(p, options)
    }
    async realpath(p, options) {
      return backend.realpath(p, options)
    }
    realpathSync(p, options) {
      return backend.realpathSync(p, options)
    }
    async statfs(p) {
      return backend.statfs(p)
    }
    async close() {
      await backend.close?.()
    }
  }
  return new WritesProvider()
}

// Gondolin's `ShadowProvider`, with what it lacks or takes too far. `hidden(p)` says whether the VM
// doesn't see `p`, a normalized path from the root; `ShadowProvider` asks it of the path given, and
// of where the host finds it, through every link on the way (`denySymlinkBypass`).
// - `link`, which it lacks: refused when either end is hidden, as its other operations are.
// - `readdir`: a name is left out when it is hidden in the folder given, as `ShadowProvider` has
//   it, and also in the folder the host lists, where a link given as the folder leads. The VM's
//   kernel lists a folder by its own path, but a request made to the service itself can name a
//   link, and `RealFSProvider` lists what it leads to.
// - `lstat`, `readlink`, `unlink` and `rename`, which act on a link itself, not on what it leads
//   to: judged at the name, and where the host finds the name through the links on the way to its
//   folder, but not through a link at the name. `ShadowProvider` follows that link too, so a link
//   the run made to what it doesn't see could be neither seen, read, moved nor removed. A name
//   whose folder a link on the way leads out of the root is hidden: `RealFSProvider` resolves
//   these four by the path alone, and would answer for the host's own files there.
function viewShadow(gondolin, backend, rootReal, hidden) {
  // Where on the host the folder `p` is, as a path from the root; `OUTSIDE` when it is outside the
  // root, through a link on the way; or null when that can't be told, as for a folder that isn't
  // there, through which the host reaches nothing either.
  const real = p => {
    let full
    try {
      full = fs.realpathSync(hostPath(rootReal, p))
    } catch {
      return null
    }
    return fromRoot(rootReal, full) ?? OUTSIDE
  }
  // Whether the VM doesn't see the name `p` itself. A name in a folder that a link on the way leads
  // out of the root is one: `RealFSProvider` would answer `lstat` and `readlink` there for the
  // host's own files.
  const nameHidden = p => {
    if (hidden(p)) return true
    if (p === '/') return false
    const folder = real(posix.dirname(p))
    if (folder === OUTSIDE) return true
    return folder !== null && hidden(posix.join(folder, posix.basename(p)))
  }
  const entryName = entry => (typeof entry === 'string' ? entry : Buffer.isBuffer(entry) ? entry.toString() : entry.name)
  const listed = (p, names) => {
    const folder = real(p)
    if (folder === OUTSIDE) return []
    return folder === null || folder === p ? names : names.filter(entry => !hidden(posix.join(folder, entryName(entry))))
  }

  class ViewShadow extends gondolin.ShadowProvider {
    async link(existing, name) {
      const [from, to] = [normalize(existing), normalize(name)]
      for (const p of [from, to]) {
        if (this.shadowedFor('link', p) || (await this.resolvesToShadowed('link', p))) throw errnoError('ENOENT', 'link', p)
      }
      return this.backend.link(from, to)
    }
    linkSync(existing, name) {
      const [from, to] = [normalize(existing), normalize(name)]
      for (const p of [from, to]) {
        if (this.shadowedFor('link', p) || this.resolvesToShadowedSync('link', p)) throw errnoError('ENOENT', 'link', p)
      }
      return this.backend.linkSync(from, to)
    }
    async readdir(p, options) {
      return listed(normalize(p), await super.readdir(p, options))
    }
    readdirSync(p, options) {
      return listed(normalize(p), super.readdirSync(p, options))
    }
    async lstat(given, options) {
      const p = normalize(given)
      if (nameHidden(p)) throw errnoError('ENOENT', 'lstat', p)
      return this.backend.lstat(p, options)
    }
    lstatSync(given, options) {
      const p = normalize(given)
      if (nameHidden(p)) throw errnoError('ENOENT', 'lstat', p)
      return this.backend.lstatSync(p, options)
    }
    async readlink(given, options) {
      const p = normalize(given)
      if (nameHidden(p)) throw errnoError('ENOENT', 'readlink', p)
      return this.backend.readlink(p, options)
    }
    readlinkSync(given, options) {
      const p = normalize(given)
      if (nameHidden(p)) throw errnoError('ENOENT', 'readlink', p)
      return this.backend.readlinkSync(p, options)
    }
    async unlink(given) {
      const p = normalize(given)
      if (nameHidden(p)) throw errnoError('EACCES', 'unlink', p)
      return this.backend.unlink(p)
    }
    unlinkSync(given) {
      const p = normalize(given)
      if (nameHidden(p)) throw errnoError('EACCES', 'unlink', p)
      return this.backend.unlinkSync(p)
    }
    async rename(oldPath, newPath) {
      const [from, to] = [normalize(oldPath), normalize(newPath)]
      if (nameHidden(from) || nameHidden(to)) throw errnoError('EXDEV', 'rename', `${from} -> ${to}`)
      return this.backend.rename(from, to)
    }
    renameSync(oldPath, newPath) {
      const [from, to] = [normalize(oldPath), normalize(newPath)]
      if (nameHidden(from) || nameHidden(to)) throw errnoError('EXDEV', 'rename', `${from} -> ${to}`)
      return this.backend.renameSync(from, to)
    }
  }
  return new ViewShadow(backend, { shouldShadow: ({ path: p }) => hidden(normalize(p)) })
}

// The provider for a run's `files`, over `inner`, Gondolin's provider of `files.root` (with the
// run's budget). `gondolin` is the module, which only `src/runner/sandbox/` loads.
export function viewProvider(gondolin, files, inner) {
  const view = viewOf(files)
  const rootReal = fs.realpathSync(files.root)
  // A path shown only because it leads to an entry is a folder on the way: a file there, as a
  // change of `writes` can leave one, is no entry's, and isn't shown.
  const isFolderOnHost = p => {
    try {
      return fs.statSync(hostPath(rootReal, p)).isDirectory()
    } catch {
      return false
    }
  }
  const hidden = p => !isShown(view, p) || (!view.shown.some(entry => within(p, entry)) && !isFolderOnHost(p))
  return writesProvider(gondolin, view, rootReal, viewShadow(gondolin, inner, rootReal, hidden))
}
