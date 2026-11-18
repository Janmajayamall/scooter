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
//   builds (D90), so a runner can't start meanwhile, and it can't start while one runs. The new
//   image is built beside the old one and takes its place when it is complete.
//
// At startup the runner refuses to run when the image is missing, was built for another pi version
// than the one the build file pins, for another architecture, or doesn't know the owner's time
// zone (`checkImage`).

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ensureDir, removeTree, writeFileAtomic } from '../../common/files.mjs'
import { holdInstance } from '../../common/instance.mjs'
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

const PI_PIN = new RegExp(`${PI_PACKAGE.replace('/', '\\/')}@(\\S*)`, 'g')

// pi's version, as the build file pins it, strictly: one install command names pi with an exact
// version, such as `@earendil-works/pi-coding-agent@1.5.2`, and installs it without its install
// scripts (row 8). Throws an `ImageError` that names the command otherwise.
export function pinnedPiVersion(build, file = 'config/image/build.json') {
  const found = []
  build.postBuild.commands.forEach((command, n) => {
    for (const match of command.matchAll(PI_PIN)) found.push({ n, command, version: match[1] })
  })
  if (found.length !== 1) {
    throw new ImageError(`${file}: postBuild.commands must install ${PI_PACKAGE} exactly once, as ${PI_PACKAGE}@<version>, and ${found.length === 0 ? 'none does' : 'it is named more than once'}`)
  }
  const [{ n, command, version }] = found
  const where = `${file}: postBuild.commands[${n}]`
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new ImageError(`${where} must pin pi to an exact version, such as ${PI_PACKAGE}@1.5.2`)
  const words = command.trim().split(/\s+/)
  if (words[0] !== 'npm' || words[1] !== 'install' || !words.includes('--ignore-scripts')) {
    throw new ImageError(`${where} must install pi with npm install --ignore-scripts, so the build runs none of its packages' code`)
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

async function fetchApkIndexes({ repositories, arch, fetch }) {
  const indexes = []
  for (const repository of repositories.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))) {
    const response = await fetch(`${repository}/${arch}/APKINDEX.tar.gz`)
    if (!response.ok) throw new ImageError(`Alpine's index at ${repository} answered ${response.status}`, { setup: false })
    indexes.push(parseApkIndex(apkIndexFromArchive(Buffer.from(await response.arrayBuffer()))))
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

// Builds the image into `paths.runnerImage`. `log` takes the steps; Gondolin prints its own
// progress on stderr. Returns the record.
export async function buildImage({ paths, proc, log, clock = systemClock, isRoot = process.getuid?.() === 0, fetch = globalThis.fetch, build: buildAssets }) {
  const build = readBuildFile(paths.imageBuild)
  const pinned = pinnedPiVersion(build, paths.imageBuild)
  const method = buildMethod({ isRoot })
  if (debugfsProgram() === null) throw new ImageError('build-image needs debugfs, from e2fsprogs')
  if (!fs.existsSync(paths.runner)) {
    if (isRoot) throw new ImageError(`${paths.runner} doesn't exist: run scooter setup first`)
    ensureDir(paths.runner, { mode: 0o700 })
  }

  let instance
  try {
    instance = await holdInstance(paths.runnerSocket, 'runner')
  } catch (error) {
    throw new ImageError(`build-image can't run while the runner does (${error.message}): stop the runner first`)
  }
  const fresh = `${paths.runnerImage}.new`
  const old = `${paths.runnerImage}.old`
  try {
    for (const leftover of [fresh, old]) removeTree(leftover)
    const config = { ...structuredClone(build), arch: machineArch(), container: method.native ? { force: false } : { force: true, runtime: method.runtime } }
    const started = clock.now()
    log.info('image.build_started', { native: method.native, runtime: method.runtime, pi: pinned })
    buildAssets ??= (await import('@earendil-works/gondolin')).buildAssets
    await buildAssets(config, { outputDir: fresh, configDir: path.dirname(paths.imageBuild), verbose: true })

    const found = await recordImage(fresh, { proc })
    if (found.record.pi !== pinned) {
      throw new ImageError(`the image built holds pi ${found.record.pi}, where config/image/build.json pins ${pinned}`, { setup: false })
    }
    const indexedAt = isoSeconds(clock.now())
    const indexes = await fetchApkIndexes({ repositories: found.repositories, arch: found.record.arch, fetch })
    const resolved = resolvePackages(indexes, found.requested)
    writeFileAtomic(path.join(fresh, PACKAGES_FILE), packagesText({ ...found, resolved, indexedAt }), { mode: 0o644 })
    writeFileAtomic(path.join(fresh, IMAGE_RECORD), `${JSON.stringify(found.record, null, 2)}\n`, { mode: 0o644 })

    // Natively the image is root's: it goes to the runner's user, who boots it (row 8).
    const owner = isRoot ? await proc.lookupUser('scooter-runner') : null
    if (owner) {
      fs.chownSync(fresh, owner.uid, owner.gid)
      for (const name of fs.readdirSync(fresh)) fs.lchownSync(path.join(fresh, name), owner.uid, owner.gid)
    }
    fs.chmodSync(fresh, 0o700)
    if (fs.existsSync(paths.runnerImage)) fs.renameSync(paths.runnerImage, old)
    fs.renameSync(fresh, paths.runnerImage)
    removeTree(old)
    const bytes = fs.readdirSync(paths.runnerImage).reduce((sum, name) => sum + fs.statSync(path.join(paths.runnerImage, name)).size, 0)
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
