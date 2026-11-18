// The VM image (6.12 of DESIGN.md; row 8): building it, what is recorded about it, and the check
// the runner makes at startup.
//
// `scooter build-image` builds the image from `config/image/build.json` into `runner/image/`:
// - **Who builds.** Gondolin's builder runs the build's install commands in a chroot, which needs
//   root (13.4). As root, it builds natively. Otherwise it uses Gondolin's container build when
//   Docker or Podman is there, and otherwise stops, saying which of the two it needs.
// - **What runs as root.** pi is installed with `npm install --ignore-scripts`, and the build's
//   commands never run pi or anything else npm installed. pi's installed version is read from its
//   `package.json`, out of the finished image's file system with `debugfs`, which runs nothing in
//   the image.
// - **What is recorded.** Beside Gondolin's own files, `scooter-image.json` holds when the image
//   was built, pi's version, Alpine's release, the architecture and the image's time zones; and
//   `packages.txt` the versions of the Alpine packages in it, since they change within a release.
// - **One at a time, and not under a running runner.** It holds `runner/runner.sock` while it
//   builds (D90), so a runner can't start meanwhile, and it can't start while one runs.
// - **Where it builds.** In `.image-build/`, beside `runner/` in the data folder, which natively
//   only root can write, not in the runner's own folder: the image is built, recorded and given to
//   the runner's user there, and renamed into `runner/image/` once it is complete (D151).
//
// At startup the runner refuses to run when the image is missing, was built for another pi version
// than the one the build file pins, for another architecture, or doesn't know the owner's time
// zone (`checkImage`).

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { checkOwnFolder, ensureDir, removeHandOff, removeTree, writeFileAtomic } from '../../common/files.mjs'
import { RUNNER_SOCKET_HOLDERS, holdInstance } from '../../common/instance.mjs'
import { limits } from '../../common/limits.mjs'
import { createLog, errorFields } from '../../common/log.mjs'
import { makePaths } from '../../common/paths.mjs'
import { createProc, findProgram } from '../../common/proc.mjs'
import { SettingsError, loadFolders } from '../../common/settings.mjs'
import { isoSeconds, systemClock } from '../../common/time.mjs'
import { SandboxSetupError } from './index.mjs'

// The file beside Gondolin's own that says what the image holds.
export const IMAGE_RECORD = 'scooter-image.json'
// The versions of the Alpine packages in the image.
export const PACKAGES_FILE = 'packages.txt'

// Where the image keeps pi's `package.json`, and the time zones.
export const PI_PACKAGE = '@earendil-works/pi-coding-agent'
export const PI_PACKAGE_JSON = `/usr/local/lib/node_modules/${PI_PACKAGE}/package.json`
const ZONEINFO = '/usr/share/zoneinfo'

// Gondolin's name for the machine's architecture, and QEMU's program for it.
export function machineArch(arch = process.arch) {
  return arch === 'arm64' ? 'aarch64' : 'x86_64'
}
export function qemuProgram(arch = process.arch) {
  return `qemu-system-${machineArch(arch)}`
}

// A fault with the build file, the image or the build. The message is for the owner. `setup` is
// true when the fault is in how Scooter is set up or called, rather than in the build itself.
export class ImageError extends SandboxSetupError {
  constructor(message, { setup = true } = {}) {
    super(message)
    this.name = 'ImageError'
    this.setup = setup
  }
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------------------------
// The build file

// Reads `config/image/build.json`. It says what goes into the image; how it is built is
// `build-image`'s to choose (D5), so it may not name the architecture or the container build.
export function readBuildFile(file) {
  let build
  try {
    build = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ImageError(`${file} can't be read as JSON (${error.code ?? error.name})`)
  }
  const problems = []
  if (!isObject(build)) problems.push('it must be an object')
  else {
    if (build.distro !== 'alpine') problems.push('distro must be alpine')
    if (!isObject(build.alpine) || typeof build.alpine.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(build.alpine.version)) {
      problems.push('alpine.version must be an Alpine release, such as 3.23.8')
    } else if (!Array.isArray(build.alpine.rootfsPackages) || !build.alpine.rootfsPackages.every(name => typeof name === 'string' && /^[a-z0-9][a-z0-9._+-]*$/.test(name))) {
      problems.push('alpine.rootfsPackages must list package names')
    }
    if (!isObject(build.postBuild) || !Array.isArray(build.postBuild.commands) || !build.postBuild.commands.every(command => typeof command === 'string')) {
      problems.push('postBuild.commands must list commands')
    }
    for (const key of ['arch', 'container']) {
      if (Object.hasOwn(build, key)) problems.push(`${key} is chosen by scooter build-image, and has no place in the build file`)
    }
  }
  if (problems.length > 0) throw new ImageError(`${file}: ${problems.join('; ')}`)
  return build
}

// Every mention of pi's package in a command, with or without a version: its name, followed by
// nothing a package's name holds, and by `@<version>` when one is given.
const PI_MENTION = new RegExp(`${PI_PACKAGE.replace('/', '\\/')}(?![a-z0-9._~-])(?:@(\\S*))?`, 'g')

// What the command that installs pi may hold: words of letters, digits and `@/._=:+,-`, apart by
// spaces. The shell reads them as they are, so the command is that one `npm install` and nothing
// else: no `;`, `&` or `|`, newline, quote, `$`, backquote, redirection or pattern.
const PLAIN_COMMAND = /^[A-Za-z0-9@/._=:+,\- ]+$/

// The switches the command that installs pi may give npm: those the build file uses, and `-g`.
// npm takes a word after a switch as its value, and a switch by the start of its name, so any other
// word, such as `false` after `--ignore-scripts`, or `--ignore-s=false`, could turn pi's install
// scripts back on (the second review of milestone 7, smaller point 1).
const INSTALL_SWITCHES = ['--global', '-g', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']

// pi's version, as the build file pins it, strictly: the commands name pi once, with or without a
// version, and that is in an install command of plain words that pins it to an exact version, such
// as `@earendil-works/pi-coding-agent@1.5.2`, and installs it without its install scripts (row 8):
// `npm install`, pi, and switches from `INSTALL_SWITCHES`, `--ignore-scripts` among them, and no
// other word. Throws an `ImageError` that names the command otherwise.
export function pinnedPiVersion(build, file = 'config/image/build.json') {
  const found = []
  build.postBuild.commands.forEach((command, n) => {
    for (const match of command.matchAll(PI_MENTION)) found.push({ n, command, version: match[1] ?? null })
  })
  if (found.length !== 1) {
    throw new ImageError(`${file}: postBuild.commands must install ${PI_PACKAGE} exactly once, as ${PI_PACKAGE}@<version>, and ${found.length === 0 ? 'none does' : 'it is named more than once'}`)
  }
  const [{ n, command, version }] = found
  const where = `${file}: postBuild.commands[${n}]`
  if (version === null || !/^\d+\.\d+\.\d+$/.test(version)) throw new ImageError(`${where} must pin pi to an exact version, such as ${PI_PACKAGE}@1.5.2`)
  if (!PLAIN_COMMAND.test(command)) {
    throw new ImageError(`${where} must be one npm install command, of plain words: no ;, &, |, newline, quote, $ or anything else the shell reads as more`)
  }
  const [npm, install, ...rest] = command.trim().split(/ +/)
  const known = word => INSTALL_SWITCHES.includes(word) || word === `${PI_PACKAGE}@${version}`
  if (npm !== 'npm' || install !== 'install' || !rest.includes('--ignore-scripts') || !rest.every(known)) {
    throw new ImageError(
      `${where} must install pi with npm install --ignore-scripts, so the build runs none of its packages' code, and give npm no other word than pi and ${INSTALL_SWITCHES.join(', ')}`,
    )
  }
  return version
}

// ---------------------------------------------------------------------------------------------
// What the image holds

// `debugfs`, from e2fsprogs, which reads an ext4 file system without mounting it. It is often in a
// folder only root's `PATH` has, so those are looked in too.
export function debugfsProgram() {
  return findProgram('debugfs', `${process.env.PATH ?? ''}${path.delimiter}/usr/sbin${path.delimiter}/sbin`)
}

function debugfs(proc, request, rootfs) {
  const program = debugfsProgram()
  if (program === null) throw new ImageError('reading the VM image needs debugfs, from e2fsprogs')
  return proc.run(program, ['-R', request, rootfs])
}

// Reads one file out of the image's root file system, with `debugfs`, which runs nothing in the
// image. Returns its text, or null when it isn't there.
async function readImageFile(proc, rootfs, file) {
  const result = await debugfs(proc, `cat ${file}`, rootfs)
  if (result.code !== 0) throw new ImageError(`debugfs couldn't read ${rootfs} (exit code ${result.code})`, { setup: false })
  return /File not found/.test(result.stderr) ? null : result.stdout
}

// The names in a folder of the image: `{ name, folder }`, without `.` and `..`.
async function listImageFolder(proc, rootfs, folder) {
  const result = await debugfs(proc, `ls -p ${folder}`, rootfs)
  if (result.code !== 0) throw new ImageError(`debugfs couldn't read ${rootfs} (exit code ${result.code})`, { setup: false })
  const entries = []
  for (const line of result.stdout.split('\n')) {
    // `/<inode>/<mode>/<uid>/<gid>/<name>/<size>/`; a name holds no slash.
    const parts = line.split('/')
    if (parts.length < 7 || parts[0] !== '') continue
    const [, , mode, , , name] = parts
    if (name === '.' || name === '..' || name === '') continue
    const type = Number.parseInt(mode, 8) & 0o170000
    if (type === 0o040000) entries.push({ name, folder: true })
    else if (type === 0o100000 || type === 0o120000) entries.push({ name, folder: false })
  }
  return entries
}

// The time zones the image knows: every file under its zoneinfo folder, by its name there, such as
// `Asia/Kolkata`. pi's `TZ` is one of these (6.6), and the image's C library reads it from there.
async function imageZones(proc, rootfs) {
  const zones = []
  const folders = ['']
  while (folders.length > 0) {
    const folder = folders.shift()
    for (const entry of await listImageFolder(proc, rootfs, `${ZONEINFO}${folder}`)) {
      const name = `${folder}/${entry.name}`
      if (entry.folder) folders.push(name)
      else zones.push(name.slice(1))
    }
  }
  return zones.sort()
}

// What a built image holds, read from the files Gondolin wrote into `dir`: the record to keep
// beside it, and what `packages.txt` needs. Runs nothing in the image.
export async function recordImage(dir, { proc }) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new ImageError(`${dir} holds no image Gondolin built: its manifest.json can't be read (${error.code ?? error.name})`, { setup: false })
  }
  const rootfs = path.join(dir, manifest.assets?.rootfs ?? 'rootfs.ext4')
  const piJson = await readImageFile(proc, rootfs, PI_PACKAGE_JSON)
  let pi
  try {
    pi = JSON.parse(piJson ?? '').version
  } catch {
    pi = undefined
  }
  if (typeof pi !== 'string') throw new ImageError(`the image in ${dir} has no pi: ${PI_PACKAGE_JSON} isn't there`, { setup: false })
  const zones = await imageZones(proc, rootfs)
  if (zones.length === 0) throw new ImageError(`the image in ${dir} has no time zones in ${ZONEINFO}`, { setup: false })
  const record = {
    builtAt: isoSeconds(Date.parse(manifest.buildTime)),
    pi,
    alpine: manifest.config?.alpine?.version ?? null,
    arch: manifest.config?.arch ?? null,
    zones,
  }
  return {
    record,
    repositories: (await readImageFile(proc, rootfs, '/etc/apk/repositories')) ?? '',
    installed: (await readImageFile(proc, rootfs, '/lib/apk/db/installed')) ?? '',
    requested: manifest.config?.alpine?.rootfsPackages ?? [],
  }
}

// What is wrong with a record, as statements that name fields.
function checkRecord(record) {
  const problems = []
  if (!isObject(record)) return ['it must be an object']
  if (typeof record.builtAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(record.builtAt)) problems.push('builtAt must be a UTC time')
  for (const key of ['pi', 'arch']) if (typeof record[key] !== 'string') problems.push(`${key} must be a string`)
  if (!Array.isArray(record.zones) || !record.zones.every(zone => typeof zone === 'string')) problems.push('zones must list time zones')
  return problems
}

// Checks the image in `dir` at the runner's startup (6.12): it is there whole, with its record;
// built for `pinned`, pi's version as the build file pins it; for this machine's architecture; and
// it knows `timeZone`, the zone pi runs in. Returns `{ dir, builtAt }`. Throws an `ImageError` that
// says what to do.
export function checkImage({ dir, pinned, timeZone, arch = machineArch() }) {
  const build = 'scooter build-image (natively, as root: sudo scooter build-image)'
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new ImageError(`there is no VM image in ${dir}: build it with ${build}`)
    throw new ImageError(`the VM image in ${dir} can't be read (${error.code ?? error.name}): build it again with ${build}`)
  }
  for (const asset of ['kernel', 'initramfs', 'rootfs']) {
    const name = manifest?.assets?.[asset]
    if (typeof name !== 'string' || !fs.existsSync(path.join(dir, name))) {
      throw new ImageError(`the VM image in ${dir} is missing its ${asset}: build it again with ${build}`)
    }
  }
  let record
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, IMAGE_RECORD), 'utf8'))
  } catch (error) {
    throw new ImageError(`the VM image in ${dir} has no ${IMAGE_RECORD} (${error.code ?? error.name}), so what it holds isn't known: build it again with ${build}`)
  }
  const problems = checkRecord(record)
  if (problems.length > 0) throw new ImageError(`${path.join(dir, IMAGE_RECORD)}: ${problems.join('; ')}: build the image again with ${build}`)
  if (record.pi !== pinned) {
    throw new ImageError(`the VM image has pi ${record.pi}, and config/image/build.json pins ${pinned}: build it again with ${build}`)
  }
  if (record.arch !== arch) throw new ImageError(`the VM image was built for ${record.arch}, and this machine is ${arch}: build it again with ${build}`)
  if (!record.zones.includes(timeZone)) {
    throw new ImageError(`SCOOTER_TZ is ${timeZone}, which isn't a time zone the VM image knows: write it as the tz database does, such as Asia/Kolkata`)
  }
  return { dir, builtAt: record.builtAt }
}

// ---------------------------------------------------------------------------------------------
// The packages in the image

// The records of an APKINDEX file: `{ P, V, D, p }` for each package, in its order.
export function parseApkIndex(text) {
  const records = []
  for (const block of text.split(/\n\s*\n/)) {
    const record = {}
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z]):(.*)$/.exec(line)
      if (match) record[match[1]] = match[2]
    }
    if (record.P && record.V) records.push(record)
  }
  return records
}

// The text of the APKINDEX in an `APKINDEX.tar.gz`: gzip members, each a piece of a tar archive.
export function apkIndexFromArchive(archive) {
  const tar = zlib.gunzipSync(archive)
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) {
      at += 512
      continue
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
    const start = at + 512
    if (name === 'APKINDEX') return tar.subarray(start, start + size).toString('utf8')
    at = start + Math.ceil(size / 512) * 512
  }
  throw new ImageError('an APKINDEX.tar.gz holds no APKINDEX', { setup: false })
}

// Resolves `requested` against `indexes` (one list of records for each repository, in the image's
// order) as Gondolin 0.14.0's builder does, so the versions are those it installed: the first
// record of a name wins, names are also found through what packages provide, and each package's
// dependencies are followed, version constraints dropped. Returns a Map from name to version.
export function resolvePackages(indexes, requested) {
  const meta = new Map()
  const provides = new Map()
  for (const records of indexes) {
    for (const record of records) {
      if (meta.has(record.P)) continue
      meta.set(record.P, record)
      for (const token of (record.p ?? '').split(' ')) {
        const name = token.split('=')[0]
        if (name && !provides.has(name)) provides.set(name, record.P)
      }
    }
  }
  const resolved = new Map()
  const queue = [...requested]
  while (queue.length > 0) {
    const dep = queue.shift().replace(/^!/, '').split(/[<>=~]/)[0]
    if (!dep) continue
    const name = meta.has(dep) ? dep : provides.get(dep)
    if (!name || resolved.has(name)) continue
    const record = meta.get(name)
    resolved.set(name, record.V)
    for (const token of (record.D ?? '').split(' ')) if (token) queue.push(token)
  }
  return resolved
}

// The text of `packages.txt`: every Alpine package in the image with its version, one a line. The
// base system records its own (`/lib/apk/db/installed`); Gondolin unpacks the rest itself and
// records nothing, so their versions are those Alpine's index gave when the image was built, which
// is what Gondolin installed.
export function packagesText({ record, installed, resolved, indexedAt }) {
  const versions = new Map()
  for (const entry of parseApkIndex(installed)) versions.set(entry.P, entry.V)
  for (const [name, version] of resolved) versions.set(name, version)
  const lines = [...versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, version]) => `${name} ${version}`)
  return `# The Alpine packages in the VM image built ${record.builtAt}: Alpine ${record.alpine}, ${record.arch}, with pi ${record.pi}.
# The base system's versions are its own record; the others are Alpine's index of ${indexedAt}, from which they were installed.
${lines.join('\n')}
`
}

// Alpine's index of each repository the image lists, each fetched within `APK_INDEX_TIMEOUT`, its
// body included.
async function fetchApkIndexes({ repositories, arch, fetch, clock }) {
  const indexes = []
  for (const repository of repositories.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))) {
    const fetching = new AbortController()
    const done = new AbortController()
    let timedOut = false
    clock.sleep(limits.APK_INDEX_TIMEOUT, { signal: done.signal }).then(
      () => {
        timedOut = true
        fetching.abort()
      },
      () => {},
    )
    try {
      const response = await fetch(`${repository}/${arch}/APKINDEX.tar.gz`, { signal: fetching.signal })
      if (!response.ok) throw new ImageError(`Alpine's index at ${repository} answered ${response.status}`, { setup: false })
      indexes.push(parseApkIndex(apkIndexFromArchive(Buffer.from(await response.arrayBuffer()))))
    } catch (error) {
      if (timedOut) throw new ImageError(`Alpine's index at ${repository} didn't come within ${limits.APK_INDEX_TIMEOUT / 1000} seconds`, { setup: false })
      throw error
    } finally {
      done.abort()
    }
  }
  return indexes
}

// ---------------------------------------------------------------------------------------------
// Building

// How to build, as row 8 has it: natively as root, or else in a container when Docker or Podman is
// there. Returns `{ native: true }` or `{ native: false, runtime }`. Throws an `ImageError` that
// says what is needed.
export function buildMethod({ isRoot, find = findProgram }) {
  if (isRoot) return { native: true }
  for (const runtime of ['docker', 'podman']) if (find(runtime) !== null) return { native: false, runtime }
  throw new ImageError(
    "build-image needs root, to build natively, or Docker or Podman, to build in a container: Gondolin's builder runs the build's commands in a chroot, which only root can make",
  )
}

// Reads what a built image holds, with `debugfs`, which must be there before a build starts.
function imageReader(proc) {
  if (debugfsProgram() === null) throw new ImageError('build-image needs debugfs, from e2fsprogs')
  return dir => recordImage(dir, { proc })
}

// As root, `build-image` builds in the data folder (D151), so the data folder must be root's, and
// writable by root alone: otherwise another user could put a link in the place of the folder it
// builds in. Natively it is `/var/lib/scooter`, which `setup` makes.
function checkDataFolder(dataDir) {
  let stat
  try {
    stat = fs.statSync(dataDir)
  } catch (error) {
    throw new ImageError(`${dataDir} can't be looked at (${error.code ?? error.name}): run scooter setup first`)
  }
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new ImageError(`${dataDir} must be a folder of root's that only root can write, since build-image builds the image in it as root`)
  }
}

// Removes the old image, once it has been renamed out of the runner's folder into `staging`. It
// was the runner's, so a process of that user's that was in it, such as a shell whose working
// folder it was, can still change what it holds, though nothing can reach it by its path any
// more, and nobody but root can rename it. So it is removed as a handed-over folder is: each name
// in it is unlinked, which follows no link and removes no folder, and then the folder, which goes
// only once that empties it. Gondolin's image holds no folder. A link or a file that was put in
// the image's place is unlinked. Throws when anything is left.
function removeOldImage(dir) {
  let stat
  try {
    stat = fs.lstatSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!stat.isDirectory()) fs.unlinkSync(dir)
  else removeHandOff(dir, () => true)
}

// The folder `build-image` builds in, `paths.imageStaging`, made if it isn't there, with what a
// build cut short left in it removed: the image it was building, which nobody but root could
// reach, and the old image it had set aside (`removeOldImage`).
function openStaging(paths, isRoot) {
  const staging = paths.imageStaging
  if (fs.existsSync(staging)) {
    if (isRoot) {
      try {
        checkOwnFolder(staging, { uid: 0 })
      } catch (error) {
        throw new ImageError(`${staging} isn't a folder of root's (${error.message}): remove it, and build again`)
      }
    }
    removeTree(path.join(staging, STAGED_IMAGE))
    try {
      removeOldImage(path.join(staging, STAGED_OLD))
    } catch (error) {
      throw new ImageError(`an earlier build set the old image aside in ${path.join(staging, STAGED_OLD)} and couldn't remove it (${error.code ?? error.name}): it holds what no image does. Look at it, remove it, and build again`)
    }
  }
  ensureDir(staging, { mode: 0o700 })
  fs.chmodSync(staging, 0o700)
  return staging
}

// Runs `step`, which writes in `dir`, and returns what it returns. A user who may not write there
// gets an error that says who builds the image, with exit code 2: since D151 that is every user but
// root on a native install, `scooter-runner` among them (the second review of milestone 7, smaller
// point 3). Any other error is passed on.
function canWrite(dir, step) {
  try {
    return step()
  } catch (error) {
    if (refusedWriting(error)) throw cantWrite(dir, error)
    throw error
  }
}

const refusedWriting = error => ['EACCES', 'EPERM', 'EROFS'].includes(error?.code)
const cantWrite = (dir, error) =>
  new ImageError(`build-image can't write in ${dir} (${error.code}): on a native install it runs as root, as sudo scooter build-image; otherwise, as a user who can write the data folder`)

// The names in `paths.imageStaging`: the image being built, and the old one once it is set aside.
const STAGED_IMAGE = 'image'
const STAGED_OLD = 'old'

// Builds the image into `paths.runnerImage`. `log` takes the steps; Gondolin prints its own
// progress on stderr. `build`, `fetch` and `readImage`, which reads what a built image holds, are
// for tests. Returns the record.
//
// The image is built, recorded and given to the runner's user in `paths.imageStaging`, beside the
// runner's folder, which natively only root can write. The runner's user owns `runner/`, and
// could put a link where the image is built, or in an image's place, at any moment: root would
// then write into, give away or remove what the link leads to (D151). So, in the runner's folder,
// `build-image` holds its socket and makes two renames, the old image out to the staging folder
// and the new one in, and nothing else. A rename follows no link, and replaces nothing but an
// empty folder or what it moves.
export async function buildImage({ paths, proc, log, clock = systemClock, isRoot = process.getuid?.() === 0, fetch = globalThis.fetch, build: buildAssets, readImage }) {
  const build = readBuildFile(paths.imageBuild)
  const pinned = pinnedPiVersion(build, paths.imageBuild)
  const method = buildMethod({ isRoot })
  readImage ??= imageReader(proc)
  if (!fs.existsSync(paths.runner)) {
    if (isRoot) throw new ImageError(`${paths.runner} doesn't exist: run scooter setup first`)
    canWrite(paths.runner, () => ensureDir(paths.runner, { mode: 0o700 }))
  }
  if (isRoot) checkDataFolder(paths.dataDir)

  let instance
  try {
    instance = await holdInstance(paths.runnerSocket, RUNNER_SOCKET_HOLDERS)
  } catch (error) {
    if (refusedWriting(error)) throw cantWrite(paths.runner, error)
    throw new ImageError(`build-image can't run while the runner, a rebuild or another build-image does (${error.message}): stop the runner first`)
  }
  try {
    const staging = canWrite(paths.dataDir, () => openStaging(paths, isRoot))
    const fresh = path.join(staging, STAGED_IMAGE)
    const old = path.join(staging, STAGED_OLD)
    const config = { ...structuredClone(build), arch: machineArch(), container: method.native ? { force: false } : { force: true, runtime: method.runtime } }
    const started = clock.now()
    log.info('image.build_started', { native: method.native, runtime: method.runtime, pi: pinned })
    buildAssets ??= (await import('@earendil-works/gondolin')).buildAssets
    await buildAssets(config, { outputDir: fresh, configDir: path.dirname(paths.imageBuild), verbose: true })

    const found = await readImage(fresh)
    if (found.record.pi !== pinned) {
      throw new ImageError(`the image built holds pi ${found.record.pi}, where config/image/build.json pins ${pinned}`, { setup: false })
    }
    const indexedAt = isoSeconds(clock.now())
    const indexes = await fetchApkIndexes({ repositories: found.repositories, arch: found.record.arch, fetch, clock })
    const resolved = resolvePackages(indexes, found.requested)
    writeFileAtomic(path.join(fresh, PACKAGES_FILE), packagesText({ ...found, resolved, indexedAt }), { mode: 0o644 })
    writeFileAtomic(path.join(fresh, IMAGE_RECORD), `${JSON.stringify(found.record, null, 2)}\n`, { mode: 0o644 })
    const bytes = fs.readdirSync(fresh).reduce((sum, name) => sum + fs.lstatSync(path.join(fresh, name)).size, 0)

    // Natively the image is root's: it goes to the runner's user, who boots it (row 8), while it is
    // still where only root can reach it.
    const owner = isRoot ? await proc.lookupUser('scooter-runner') : null
    if (owner) {
      for (const name of fs.readdirSync(fresh)) fs.lchownSync(path.join(fresh, name), owner.uid, owner.gid)
      fs.chownSync(fresh, owner.uid, owner.gid)
    }
    fs.chmodSync(fresh, 0o700)

    // The two renames in the runner's folder: whatever is in the image's place out, a link
    // included, and the new image in.
    try {
      fs.renameSync(paths.runnerImage, old)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ImageError(`build-image couldn't set the old image in ${paths.runnerImage} aside (${error.code ?? error.name})`, { setup: false })
    }
    try {
      fs.renameSync(fresh, paths.runnerImage)
    } catch (error) {
      throw new ImageError(`build-image couldn't put the image in ${paths.runnerImage} (${error.code ?? error.name}): something took its place during the build`, { setup: false })
    }
    try {
      removeOldImage(old)
      fs.rmdirSync(staging)
    } catch (error) {
      // The new image is in place. What is left is in root's folder, and the next build says so.
      log.warn('image.old_left', errorFields(error))
    }
    log.info('image.built', { pi: found.record.pi, arch: found.record.arch, bytes, ms: clock.now() - started })
    return { ...found.record, bytes, ms: clock.now() - started }
  } finally {
    await instance.close()
  }
}

// `scooter build-image`: builds the VM image, as root natively or in a container (8.4). It reads
// only `DATA_DIR` and `CONFIG_DIR`, from `runner.env` or the environment: it needs neither the key
// nor any other setting. Exits with 2 when it can't start for how it was called or configured,
// and with 1 when the build fails.
export async function runBuildImage({ args = [], env = process.env, stdout = process.stdout, stderr = process.stderr }) {
  if (args.length > 0) {
    stderr.write('scooter build-image: it takes no arguments\n')
    return 2
  }
  let folders
  try {
    folders = loadFolders('runner', { env })
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error
    for (const problem of error.problems) stderr.write(`scooter build-image: ${problem.message}\n`)
    return 2
  }
  const log = createLog({ component: 'image' })
  const proc = createProc({ log })
  const paths = makePaths(folders)
  try {
    const built = await buildImage({ paths, proc, log })
    stdout.write(
      `Built the VM image in ${paths.runnerImage}: pi ${built.pi}, Alpine ${built.alpine}, ${built.arch}, ${Math.round(built.bytes / 1024 / 1024)} MB, in ${Math.round(built.ms / 1000)} seconds.\n` +
        `The versions of its Alpine packages are in ${path.join(paths.runnerImage, PACKAGES_FILE)}. Restart the runner to use it.\n`,
    )
    return 0
  } catch (error) {
    log.error('image.build_failed', errorFields(error))
    stderr.write(`scooter build-image: ${error.message}\n`)
    return error instanceof ImageError && error.setup ? 2 : 1
  }
}
