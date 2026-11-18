// The VM image (6.12 of DESIGN.md; row 8): the build file and its pin of pi, what `build-image`
// records about an image and how it builds one, and the runner's check at startup (section 10,
// "Sandbox": a missing image, or one built for another pi version, stops the runner).
//
// The builds here are made by a fake builder, which writes a small image of the shape Gondolin
// writes, and Alpine's index comes from a fake `fetch`. The real build needs the network, Docker
// and minutes; `docs/DECISIONS.md` says when it was run.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { holdInstance } from '../src/common/instance.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createProc, findProgram } from '../src/common/proc.mjs'
import { runRunner } from '../src/runner/main.mjs'
import { openGondolinSandbox } from '../src/runner/sandbox/gondolin.mjs'
import {
  IMAGE_RECORD,
  ImageError,
  PACKAGES_FILE,
  apkIndexFromArchive,
  buildImage,
  buildMethod,
  checkImage,
  packagesText,
  parseApkIndex,
  pinnedPiVersion,
  readBuildFile,
  recordImage,
  resolvePackages,
} from '../src/runner/sandbox/image.mjs'
import { SandboxSetupError } from '../src/runner/sandbox/index.mjs'
import { FAKE_BUILD_TIME, apkIndexArchive, apkIndexText, fakeImageSkipReason, makeFakeImage, readFakeImage } from './support/fake-image.mjs'
import { BUILD_FILE } from './support/image.mjs'
import { createTestLog } from './support/log.mjs'
import { isRoot, skipUnlessRoot } from './support/root.mjs'
import { prepareTestRunner } from './support/test-runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const needsE2fs = { skip: fakeImageSkipReason() }

function writeBuild(dir, change = build => build) {
  const file = path.join(dir, 'build.json')
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8')))))
  return file
}

// ---------------------------------------------------------------------------------------------
// The build file

test('image: the build file pins pi, installed without its scripts, and says nothing of how it is built', t => {
  const build = readBuildFile(BUILD_FILE)
  assert.equal(pinnedPiVersion(build), '1.5.2')

  const dir = makeTestDir(t)
  const faults = [
    [b => ({ ...b, arch: 'x86_64' }), /arch is chosen by scooter build-image/],
    [b => ({ ...b, container: { force: true } }), /container is chosen by scooter build-image/],
    [b => ({ ...b, distro: 'nixos' }), /distro must be alpine/],
    [b => ({ ...b, alpine: { ...b.alpine, version: '3.23' } }), /alpine\.version must be an Alpine release/],
    [b => ({ ...b, postBuild: {} }), /postBuild\.commands must list commands/],
  ]
  for (const [change, message] of faults) assert.throws(() => readBuildFile(writeBuild(dir, change)), message)
  fs.writeFileSync(path.join(dir, 'bad.json'), '{')
  assert.throws(() => readBuildFile(path.join(dir, 'bad.json')), /can't be read as JSON/)

  const pin = commands => pinnedPiVersion({ postBuild: { commands } }, 'build.json')
  const install = version => `npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${version}`
  assert.equal(pin(['true', install('1.6.0')]), '1.6.0')
  assert.throws(() => pin(['npm cache clean --force']), /must install @earendil-works\/pi-coding-agent exactly once.*none does/)
  assert.throws(() => pin([install('1.5.2'), install('1.5.2')]), /named more than once/)
  for (const loose of ['latest', '^1.5.2', '1.5', '']) {
    assert.throws(() => pin([install(loose)]), /build\.json: postBuild\.commands\[0\] must pin pi to an exact version/, loose)
  }
  assert.throws(() => pin(['npm install --global @earendil-works/pi-coding-agent@1.5.2']), /must install pi with npm install --ignore-scripts/)
  assert.throws(() => pin(['pnpm add --ignore-scripts @earendil-works/pi-coding-agent@1.5.2']), /must install pi with npm install --ignore-scripts/)
  // npm takes the last word about scripts: one that turns them back on is refused. So is any word
  // but pi and the switches the build file uses: npm takes a word after a switch as its value, and
  // a switch by the start of its name (the second review of milestone 7, smaller point 1).
  for (const again of ['--ignore-scripts=false', '--no-ignore-scripts', '--ignore-scripts false', '--no-ignore-s', '--ignore-s=false', '--foreground-scripts', '--prefix=/tmp', 'other-package']) {
    assert.throws(() => pin([`${install('1.5.2')} ${again}`]), /must install pi with npm install --ignore-scripts.*no other word than pi and --global, -g, --ignore-scripts, --omit=dev, --no-audit, --no-fund/, again)
  }
  assert.throws(() => pin(['npm install --global --ignore-scripts false @earendil-works/pi-coding-agent@1.5.2']), /no other word/)
  assert.equal(pin(['npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.5.2']), '1.5.2')

  // pi named again, with or without a version, as by a second install (the review of milestone 7,
  // smaller point 4), or in a path.
  assert.throws(() => pin([install('1.5.2'), 'npm install --global @earendil-works/pi-coding-agent']), /named more than once/)
  assert.throws(() => pin([install('1.5.2'), 'ls /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/']), /named more than once/)
  assert.throws(() => pin(['npm install --global --ignore-scripts @earendil-works/pi-coding-agent']), /must pin pi to an exact version/)
  // Another package whose name starts with pi's isn't pi.
  assert.equal(pin(['npm install --global @earendil-works/pi-coding-agent-extra', install('1.5.2')]), '1.5.2')
  // The install command is that one command: nothing the shell would read as another, or as more.
  for (const more of [
    `${install('1.5.2')} ; echo --ignore-scripts`,
    `${install('1.5.2')} && node /usr/local/bin/pi --version`,
    `${install('1.5.2')} & node /usr/local/bin/pi`,
    `${install('1.5.2')} | sh`,
    `${install('1.5.2')}\nnode /usr/local/bin/pi`,
    `${install('1.5.2')} $(node /usr/local/bin/pi)`,
    `${install('1.5.2')} \`pi\``,
    `${install('1.5.2')} '--x'`,
    `${install('1.5.2')} > /dev/null`,
  ]) {
    assert.throws(() => pin([more]), /postBuild\.commands\[0\] must be one npm install command, of plain words/, more)
  }
  // The build file's own command is plain words.
  assert.equal(pin(['npm install --global --ignore-scripts --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.2']), '1.5.2')
})

// ---------------------------------------------------------------------------------------------
// The check at startup

test('image: the runner\'s check: the image whole, with its record, for the pinned pi, this machine and the owner\'s zone', needsE2fs, async t => {
  const dir = makeTestDir(t)
  const image = makeFakeImage(path.join(dir, 'image'))
  const { record } = await recordImage(image, { proc: createProc({ log: createTestLog().log }) })
  assert.deepEqual(record, {
    builtAt: '2026-11-16T00:56:54Z',
    pi: '1.5.2',
    alpine: '3.23.8',
    arch: 'x86_64',
    zones: ['America/New_York', 'Asia/Kolkata', 'UTC'],
  })
  fs.writeFileSync(path.join(image, IMAGE_RECORD), JSON.stringify(record))

  const check = options => checkImage({ dir: image, pinned: '1.5.2', timeZone: 'Asia/Kolkata', arch: 'x86_64', ...options })
  assert.deepEqual(check(), { dir: image, builtAt: '2026-11-16T00:56:54Z' })
  assert.throws(() => check({ pinned: '1.6.0' }), /^ImageError: the VM image has pi 1\.5\.2, and config\/image\/build\.json pins 1\.6\.0: build it again with scooter build-image/)
  assert.throws(() => check({ arch: 'aarch64' }), /was built for x86_64, and this machine is aarch64/)
  // A zone is written as the tz database writes it: the image's C library looks it up as a file.
  assert.throws(() => check({ timeZone: 'Asia/KOLKATA' }), /SCOOTER_TZ is Asia\/KOLKATA, which isn't a time zone the VM image knows/)
  assert.equal(check({ timeZone: 'America/New_York' }).builtAt, '2026-11-16T00:56:54Z')

  assert.throws(() => checkImage({ dir: path.join(dir, 'none'), pinned: '1.5.2', timeZone: 'UTC' }), /there is no VM image in .*none: build it with scooter build-image/)
  fs.writeFileSync(path.join(image, IMAGE_RECORD), '{"pi":"1.5.2"}')
  assert.throws(() => check(), /builtAt must be a UTC time; arch must be a string; zones must list time zones/)
  fs.rmSync(path.join(image, IMAGE_RECORD))
  assert.throws(() => check(), /has no scooter-image\.json \(ENOENT\), so what it holds isn't known: build it again/)
  fs.writeFileSync(path.join(image, IMAGE_RECORD), JSON.stringify(record))
  fs.rmSync(path.join(image, 'rootfs.ext4'))
  assert.throws(() => check(), error => error instanceof SandboxSetupError && /is missing its rootfs/.test(error.message))
})

test('image: a missing image, or one built for another pi, stops the runner with exit code 2, before any VM', needsE2fs, async t => {
  const prepared = prepareTestRunner(t)
  const { paths, settings } = prepared
  fs.mkdirSync(path.dirname(paths.imageBuild), { recursive: true })
  fs.copyFileSync(BUILD_FILE, paths.imageBuild)
  const errors = []
  const stderr = { write: text => errors.push(text) }
  const openSandbox = options => openGondolinSandbox({ ...options, kvmDevice: '/dev/null' })

  assert.equal(await runRunner({ settings, stderr, openSandbox, clock: prepared.clock }), 2)
  assert.match(errors.join(''), /^scooter runner: there is no VM image in .*runner\/image: build it with scooter build-image/)

  makeFakeImage(paths.runnerImage, { pi: '1.4.0' })
  const { record } = await recordImage(paths.runnerImage, { proc: prepared.proc })
  fs.writeFileSync(path.join(paths.runnerImage, IMAGE_RECORD), JSON.stringify(record))
  errors.length = 0
  assert.equal(await runRunner({ settings, stderr, openSandbox, clock: prepared.clock }), 2)
  assert.match(errors.join(''), /^scooter runner: the VM image has pi 1\.4\.0, and config\/image\/build\.json pins 1\.5\.2/)
  // Nothing was asked of Gondolin: the runner's home and temporary folder were never made.
  assert.equal(fs.existsSync(paths.runnerTmp), false)
})

// ---------------------------------------------------------------------------------------------
// The packages

const MAIN = [
  { P: 'musl', V: '1.2.5-r25', p: 'so:libc.musl-x86_64.so.1=1' },
  { P: 'nodejs', V: '24.22.3-r0', D: 'so:libc.musl-x86_64.so.1 ca-certificates icu-libs>=76' },
  { P: 'ca-certificates', V: '20261020-r0', D: 'ca-certificates-bundle !openssl-misc' },
  { P: 'ca-certificates-bundle', V: '20261020-r0' },
  { P: 'icu-libs', V: '76.1-r1' },
  { P: 'openssl-misc', V: '3.5.9-r0' },
  { P: 'git', V: '2.52.1-r0', D: 'cmd:sh' },
  { P: 'busybox-binsh', V: '1.37.0-r30', p: 'cmd:sh=1.37.0-r30 /bin/sh' },
]
const COMMUNITY = [
  // A name the main repository has already: the first repository's wins.
  { P: 'git', V: '9.9.9-r0' },
  { P: 'ripgrep', V: '15.1.0-r0' },
]

test('image: the packages Gondolin installed are resolved as its builder resolves them', () => {
  const resolved = resolvePackages([MAIN, COMMUNITY], ['nodejs', 'git', 'ripgrep', 'no-such-package'])
  assert.deepEqual(Object.fromEntries(resolved), {
    nodejs: '24.22.3-r0',
    git: '2.52.1-r0',
    ripgrep: '15.1.0-r0',
    musl: '1.2.5-r25',
    'ca-certificates': '20261020-r0',
    'icu-libs': '76.1-r1',
    'busybox-binsh': '1.37.0-r30',
    'ca-certificates-bundle': '20261020-r0',
    // Gondolin 0.14.0 takes a conflict, `!name`, for a dependency, and installs it.
    'openssl-misc': '3.5.9-r0',
  })

  const archive = apkIndexArchive(apkIndexText(MAIN))
  assert.deepEqual(parseApkIndex(apkIndexFromArchive(archive)).map(record => record.P), MAIN.map(record => record.P))

  const installed = 'P:musl\nV:1.2.5-r24\n\nP:busybox\nV:1.37.0-r30\n\n'
  const record = { builtAt: '2026-11-16T00:56:54Z', pi: '1.5.2', alpine: '3.23.8', arch: 'x86_64' }
  const text = packagesText({ record, installed, resolved: new Map([['musl', '1.2.5-r25'], ['nodejs', '24.22.3-r0']]), indexedAt: '2026-11-16T00:57:10Z' })
  assert.equal(
    text,
    '# The Alpine packages in the VM image built 2026-11-16T00:56:54Z: Alpine 3.23.8, x86_64, with pi 1.5.2.\n' +
      "# The base system's versions are its own record; the others are Alpine's index of 2026-11-16T00:57:10Z, from which they were installed.\n" +
      'busybox 1.37.0-r30\nmusl 1.2.5-r25\nnodejs 24.22.3-r0\n',
  )
})

// ---------------------------------------------------------------------------------------------
// Building

test('image: build-image builds natively as root, in Docker or Podman otherwise, and says which it needs when neither is there', () => {
  const finder = present => name => (present.includes(name) ? `/usr/bin/${name}` : null)
  assert.deepEqual(buildMethod({ isRoot: true, find: finder([]) }), { native: true })
  assert.deepEqual(buildMethod({ isRoot: false, find: finder(['docker', 'podman']) }), { native: false, runtime: 'docker' })
  assert.deepEqual(buildMethod({ isRoot: false, find: finder(['podman']) }), { native: false, runtime: 'podman' })
  assert.throws(() => buildMethod({ isRoot: false, find: finder([]), docker: false }), /^ImageError: build-image needs root, to build natively, or Docker or Podman, to build in a container/)
  // In the runner's container, which has neither, it says which container builds (D220).
  assert.throws(() => buildMethod({ isRoot: false, find: finder([]), docker: true }), /^ImageError: in Docker, build-image runs in a container of its own, .*: docker compose run --rm build-image$/)
})

// A data folder with the build file, a builder that writes a fake image where Gondolin would,
// recording what it was given, and Alpine's index.
function prepareBuild(t, { pi = '1.5.2' } = {}) {
  const dir = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') })
  fs.mkdirSync(path.dirname(paths.imageBuild), { recursive: true })
  fs.copyFileSync(BUILD_FILE, paths.imageBuild)
  const builds = []
  const build = async (config, options) => {
    builds.push({ config, options })
    makeFakeImage(options.outputDir, { pi, packages: ['nodejs', 'git'], arch: config.arch })
  }
  const fetched = []
  const fetch = async url => {
    fetched.push(url)
    const records = url.includes('/main/') ? MAIN : COMMUNITY
    return new Response(apkIndexArchive(apkIndexText(records)))
  }
  const { log, events } = createTestLog()
  return { dir, paths, build, builds, fetch, fetched, log, events, proc: createProc({ log }) }
}

test('image: build-image builds beside the runner\'s folder, records what it holds, and takes the old image\'s place', needsE2fs, async t => {
  const { paths, build, builds, fetch, fetched, log, proc } = prepareBuild(t)
  fs.mkdirSync(paths.runnerImage, { recursive: true })
  fs.writeFileSync(path.join(paths.runnerImage, 'old'), 'the image before')
  // A build cut short earlier left these: an image half built, and the old image set aside.
  fs.mkdirSync(path.join(paths.imageStaging, 'image', 'sub'), { recursive: true })
  fs.mkdirSync(path.join(paths.imageStaging, 'old'))
  fs.writeFileSync(path.join(paths.imageStaging, 'old', 'rootfs.ext4'), 'an image before that')

  const built = await buildImage({ paths, proc, log, isRoot: false, build, fetch })
  assert.equal(built.pi, '1.5.2')
  assert.equal(builds.length, 1)
  const [{ config, options }] = builds
  // The build file as it is, with the architecture and the container build chosen here.
  assert.equal(config.arch, process.arch === 'arm64' ? 'aarch64' : 'x86_64')
  assert.equal(config.container.force, true)
  assert.deepEqual(config.postBuild, readBuildFile(BUILD_FILE).postBuild)
  // Built outside the runner's folder, beside it in the data folder.
  assert.equal(options.outputDir, path.join(paths.dataDir, '.image-build', 'image'))

  assert.deepEqual(fetched, ['https://mirror.test/alpine/v3.23/main/x86_64/APKINDEX.tar.gz', 'https://mirror.test/alpine/v3.23/community/x86_64/APKINDEX.tar.gz'])
  const names = fs.readdirSync(paths.runnerImage).sort()
  assert.deepEqual(names, ['initramfs.cpio.lz4', 'manifest.json', PACKAGES_FILE, 'rootfs.ext4', IMAGE_RECORD, 'vmlinuz-virt'].sort())
  assert.equal(fs.statSync(paths.runnerImage).mode & 0o777, 0o700)
  // The folder it built in is gone, and nothing is left in the runner's folder but the image.
  assert.equal(fs.existsSync(paths.imageStaging), false)
  assert.deepEqual(fs.readdirSync(paths.runner), ['image'])
  const record = JSON.parse(fs.readFileSync(path.join(paths.runnerImage, IMAGE_RECORD), 'utf8'))
  assert.equal(record.builtAt, FAKE_BUILD_TIME.replace(/\.\d+Z$/, 'Z'))
  const packages = fs.readFileSync(path.join(paths.runnerImage, PACKAGES_FILE), 'utf8')
  assert.match(packages, /^busybox 1\.37\.0-r30$/m)
  // The two packages asked for, and what they need, at the index's versions, the main
  // repository's first; and the base system's own, for the rest.
  assert.match(packages, /^nodejs 24\.22\.3-r0$/m)
  assert.match(packages, /^git 2\.52\.1-r0$/m)
  assert.match(packages, /^musl 1\.2\.5-r25$/m)
  assert.match(packages, /^ca-certificates-bundle 20261020-r0$/m)
  assert.doesNotMatch(packages, /^ripgrep /m)

  // The runner's check takes it.
  assert.equal(checkImage({ dir: paths.runnerImage, pinned: '1.5.2', timeZone: 'Asia/Kolkata', arch: record.arch }).builtAt, record.builtAt)
})

test('image: build-image refuses while a runner runs, and a build of another pi than the pinned one leaves the image as it was', needsE2fs, async t => {
  const prepared = prepareBuild(t)
  const { paths, build, fetch, log, proc } = prepared
  fs.mkdirSync(paths.runner, { recursive: true })
  const runner = await holdInstance(paths.runnerSocket, 'runner')
  await assert.rejects(buildImage({ paths, proc, log, isRoot: false, build, fetch }), /build-image can't run while the runner, a rebuild or another build-image does .*: stop the runner first/)
  await runner.close()
  assert.equal(prepared.builds.length, 0)

  fs.mkdirSync(paths.runnerImage)
  fs.writeFileSync(path.join(paths.runnerImage, 'old'), 'the image before')
  const other = prepareBuild(t, { pi: '1.4.0' })
  await assert.rejects(buildImage({ paths, proc, log, isRoot: false, build: other.build, fetch }), /the image built holds pi 1\.4\.0, where config\/image\/build\.json pins 1\.5\.2/)
  assert.deepEqual(fs.readdirSync(paths.runnerImage), ['old'])
  // The socket is let go of: a runner can start.
  await (await holdInstance(paths.runnerSocket, 'runner')).close()
})

test("image: a user who can't write the data folder, or the runner's, is told who builds the image, with exit code 2", { skip: isRoot ? 'root writes anyway' : false }, async t => {
  const { paths, build, fetch, log, proc } = prepareBuild(t)
  fs.mkdirSync(paths.runner, { recursive: true })
  // As `scooter-runner` on a native install, whose data folder is root's (D151).
  fs.chmodSync(paths.dataDir, 0o555)
  atEnd(t, () => fs.chmodSync(paths.dataDir, 0o755))
  const refused = error => error instanceof ImageError && error.setup
  await assert.rejects(buildImage({ paths, proc, log, isRoot: false, build, fetch }), error => refused(error) && error.message === `build-image can't write in ${paths.dataDir} (EACCES): on a native install it runs as root, as sudo scooter build-image; otherwise, as a user who can write the data folder`)
  // A runner's folder it can't write, where it holds its socket.
  fs.chmodSync(paths.dataDir, 0o755)
  fs.chmodSync(paths.runner, 0o555)
  atEnd(t, () => fs.chmodSync(paths.runner, 0o755))
  await assert.rejects(buildImage({ paths, proc, log, isRoot: false, build, fetch }), error => refused(error) && error.message.startsWith(`build-image can't write in ${paths.runner} (EACCES)`))
})

// A builder that writes a fake image with a stand-in for its file system, which `readFakeImage`
// reads: for the tests of where and how `build-image` builds, which need no e2fsprogs.
const standInBuild = async (config, options) => {
  makeFakeImage(options.outputDir, { ext4: false, arch: config.arch })
}

// For a test that builds as this process is: natively as root, which gives the image to nobody
// here, or else in a container, which needs Docker or Podman to be there.
const asWeAre = { skip: isRoot || findProgram('docker') || findProgram('podman') ? false : 'needs root, or Docker or Podman' }
const buildAsWeAre = ({ paths, fetch, log }, options = {}) => {
  const proc = { ...createProc({ log }), lookupUser: async () => null }
  return buildImage({ paths, proc, log, isRoot, build: standInBuild, fetch, readImage: readFakeImage, ...options })
}

test('image: as root, build-image builds where only root can write, and a link the runner\'s user puts in its folder meanwhile leads it nowhere', { skip: skipUnlessRoot }, async t => {
  const { dir, paths, fetch, log } = prepareBuild(t)
  // `scooter-runner`, by its uid: giving a file to it needs no such user.
  const runnerUser = { uid: 4242, gid: 4242 }
  const proc = { ...createProc({ log }), lookupUser: async name => (name === 'scooter-runner' ? runnerUser : null) }
  // The data folder is root's, and runner/ the runner's user's, with its old image, as setup and
  // an earlier build leave them.
  fs.mkdirSync(paths.runnerImage, { recursive: true, mode: 0o755 })
  fs.chmodSync(paths.dataDir, 0o755)
  fs.writeFileSync(path.join(paths.runnerImage, 'manifest.json'), '{}')
  for (const owned of [paths.runner, paths.runnerImage, path.join(paths.runnerImage, 'manifest.json')]) fs.chownSync(owned, runnerUser.uid, runnerUser.gid)
  fs.chmodSync(paths.runner, 0o700)
  // A folder of root's, with a secret in it, as /etc/scooter is.
  const victim = path.join(dir, 'etc-scooter')
  fs.mkdirSync(victim, { mode: 0o755 })
  fs.chmodSync(victim, 0o755)
  fs.writeFileSync(path.join(victim, 'bridge.env'), 'RESTIC_PASSWORD=x\n', { mode: 0o600 })

  // A data folder another user can write is refused: a link could take the place of the folder
  // build-image builds in.
  fs.chmodSync(paths.dataDir, 0o777)
  await assert.rejects(buildImage({ paths, proc, log, isRoot: true, build: standInBuild, fetch, readImage: readFakeImage }), /must be a folder of root's that only root can write/)
  fs.chmodSync(paths.dataDir, 0o755)

  const aside = path.join(paths.runner, 'image-aside')
  let outputDir
  const build = async (config, options) => {
    outputDir = options.outputDir
    // The runner's user, meanwhile, in its own folder: the old image renamed aside, and links to
    // the victim in its place and at the names an earlier build-image used.
    fs.renameSync(paths.runnerImage, aside)
    fs.symlinkSync(victim, paths.runnerImage)
    for (const name of ['image.new', 'image.old']) fs.symlinkSync(victim, path.join(paths.runner, name))
    await standInBuild(config, options)
  }
  await buildImage({ paths, proc, log, isRoot: true, build, fetch, readImage: readFakeImage })

  // It built in a folder of root's, beside the runner's.
  assert.equal(outputDir, path.join(paths.dataDir, '.image-build', 'image'))
  // The victim is as it was: nothing written into it, given away or removed.
  assert.deepEqual(fs.readdirSync(victim), ['bridge.env'])
  for (const [file, mode] of [[victim, 0o755], [path.join(victim, 'bridge.env'), 0o600]]) {
    const stat = fs.lstatSync(file)
    assert.deepEqual({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }, { uid: 0, gid: 0, mode }, file)
  }
  // The image is the new one, a folder of the runner's user's, 0700, with its files the user's.
  const image = fs.lstatSync(paths.runnerImage)
  assert.ok(image.isDirectory())
  assert.deepEqual({ uid: image.uid, gid: image.gid, mode: image.mode & 0o777 }, { ...runnerUser, mode: 0o700 })
  assert.deepEqual(fs.readdirSync(paths.runnerImage).sort(), ['initramfs.cpio.lz4', 'manifest.json', PACKAGES_FILE, 'rootfs.ext4', IMAGE_RECORD, 'vmlinuz-virt'].sort())
  for (const name of fs.readdirSync(paths.runnerImage)) {
    const stat = fs.lstatSync(path.join(paths.runnerImage, name))
    assert.deepEqual({ uid: stat.uid, file: stat.isFile() }, { uid: runnerUser.uid, file: true }, name)
  }
  // What the runner's user left in its folder is as it left it; the link in the image's place went.
  for (const name of ['image.new', 'image.old']) assert.equal(fs.readlinkSync(path.join(paths.runner, name)), victim)
  assert.deepEqual(fs.readdirSync(aside), ['manifest.json'])
  assert.equal(fs.lstatSync(aside).uid, runnerUser.uid)
  assert.deepEqual(fs.readdirSync(paths.runner).sort(), ['image', 'image-aside', 'image.new', 'image.old'])
  assert.equal(fs.existsSync(paths.imageStaging), false)
})

test('image: an old image holding what no image holds is left where only build-image reaches it, and the next build says so', asWeAre, async t => {
  const prepared = prepareBuild(t)
  const { paths, events } = prepared
  fs.mkdirSync(path.join(paths.runnerImage, 'folder'), { recursive: true })
  fs.writeFileSync(path.join(paths.runnerImage, 'folder', 'file'), 'x')
  fs.writeFileSync(path.join(paths.runnerImage, 'manifest.json'), '{}')
  await buildAsWeAre(prepared)
  // The new image is in place; the old one, set aside, keeps its folder: no folder in it is entered.
  assert.ok(fs.existsSync(path.join(paths.runnerImage, IMAGE_RECORD)))
  assert.ok(events().includes('image.old_left'))
  assert.ok(fs.existsSync(path.join(paths.imageStaging, 'old', 'folder', 'file')))
  await assert.rejects(
    buildAsWeAre(prepared),
    /an earlier build set the old image aside in .*\.image-build\/old and couldn't remove it \((EISDIR|EPERM)\): it holds what no image does/,
  )
  // A link in the old image's place is removed as a link, and what it leads to stays.
  fs.rmSync(path.join(paths.imageStaging, 'old'), { recursive: true })
  const kept = path.join(paths.dataDir, 'kept')
  fs.mkdirSync(kept)
  fs.writeFileSync(path.join(kept, 'manifest.json'), 'kept')
  fs.renameSync(paths.runnerImage, path.join(paths.dataDir, 'new-image'))
  fs.symlinkSync(kept, paths.runnerImage)
  await buildAsWeAre(prepared)
  assert.ok(fs.lstatSync(paths.runnerImage).isDirectory())
  assert.deepEqual(fs.readdirSync(kept), ['manifest.json'])
  assert.equal(fs.existsSync(paths.imageStaging), false)
})

test("image: build-image waits for Alpine's index only so long, and keeps the old image", asWeAre, async t => {
  const prepared = prepareBuild(t)
  const { paths } = prepared
  fs.mkdirSync(paths.runnerImage, { recursive: true })
  fs.writeFileSync(path.join(paths.runnerImage, 'old'), 'the image before')
  t.after(overrideLimits({ APK_INDEX_TIMEOUT: 50 }))
  // An index that never comes, until the fetch is aborted.
  const fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  await assert.rejects(
    buildAsWeAre(prepared, { fetch }),
    error => error instanceof ImageError && !error.setup && /^Alpine's index at https:\/\/mirror\.test\/alpine\/v3\.23\/main didn't come within 0\.05 seconds$/.test(error.message),
  )
  assert.deepEqual(fs.readdirSync(paths.runnerImage), ['old'])
  // The socket is let go of.
  await (await holdInstance(paths.runnerSocket, 'runner')).close()
})

test('image: scooter build-image reads only where Scooter\'s folders are, and a fault in the build file exits with 2', async t => {
  const { main } = await import('../src/cli.mjs')
  const dir = makeTestDir(t)
  const configDir = path.join(dir, 'config')
  fs.mkdirSync(path.join(configDir, 'image'), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'image', 'build.json'), JSON.stringify({ distro: 'alpine', arch: 'x86_64' }))
  // A runner.env with the key, which the command doesn't read, and a bridge.env it never opens.
  fs.writeFileSync(path.join(dir, 'runner.env'), `OPENROUTER_API_KEY=sk-or-v1-x\nDATA_DIR=${path.join(dir, 'data')}\nCONFIG_DIR=${configDir}\n`)
  fs.writeFileSync(path.join(dir, 'bridge.env'), 'NOT_A_SETTING=1\n')
  const out = []
  const err = []
  const code = await main(['build-image'], { env: { SCOOTER_ENV_DIR: dir, PATH: process.env.PATH }, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } })
  assert.equal(code, 2)
  assert.match(err.join(''), /^scooter build-image: .*build\.json: alpine\.version must be an Alpine release.*arch is chosen by scooter build-image/)
  assert.deepEqual(out, [])

  const bad = await main(['build-image'], { env: { SCOOTER_ENV_DIR: dir, DATA_DIR: 'data' }, stdout: { write: () => {} }, stderr: { write: text => err.push(text) } })
  assert.equal(bad, 2)
  assert.match(err.at(-1), /DATA_DIR must be an absolute path/)
})
