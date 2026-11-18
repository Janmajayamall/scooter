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
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { runRunner } from '../src/runner/main.mjs'
import { openGondolinSandbox } from '../src/runner/sandbox/gondolin.mjs'
import {
  IMAGE_RECORD,
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
import { FAKE_BUILD_TIME, apkIndexArchive, apkIndexText, fakeImageSkipReason, makeFakeImage } from './support/fake-image.mjs'
import { BUILD_FILE } from './support/image.mjs'
import { createTestLog } from './support/log.mjs'
import { prepareTestRunner } from './support/test-runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

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
  assert.throws(() => buildMethod({ isRoot: false, find: finder([]) }), /^ImageError: build-image needs root, to build natively, or Docker or Podman, to build in a container/)
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

test('image: build-image builds beside the old image, records what it holds, and takes the old one\'s place', needsE2fs, async t => {
  const { paths, build, builds, fetch, fetched, log, proc } = prepareBuild(t)
  fs.mkdirSync(paths.runnerImage, { recursive: true })
  fs.writeFileSync(path.join(paths.runnerImage, 'old'), 'the image before')
  // A build cut short earlier left these.
  fs.mkdirSync(`${paths.runnerImage}.new`)
  fs.mkdirSync(`${paths.runnerImage}.old`)

  const built = await buildImage({ paths, proc, log, isRoot: false, build, fetch })
  assert.equal(built.pi, '1.5.2')
  assert.equal(builds.length, 1)
  const [{ config, options }] = builds
  // The build file as it is, with the architecture and the container build chosen here.
  assert.equal(config.arch, process.arch === 'arm64' ? 'aarch64' : 'x86_64')
  assert.equal(config.container.force, true)
  assert.deepEqual(config.postBuild, readBuildFile(BUILD_FILE).postBuild)
  assert.equal(options.outputDir, `${paths.runnerImage}.new`)

  assert.deepEqual(fetched, ['https://mirror.test/alpine/v3.23/main/x86_64/APKINDEX.tar.gz', 'https://mirror.test/alpine/v3.23/community/x86_64/APKINDEX.tar.gz'])
  const names = fs.readdirSync(paths.runnerImage).sort()
  assert.deepEqual(names, ['initramfs.cpio.lz4', 'manifest.json', PACKAGES_FILE, 'rootfs.ext4', IMAGE_RECORD, 'vmlinuz-virt'].sort())
  assert.equal(fs.statSync(paths.runnerImage).mode & 0o777, 0o700)
  assert.equal(fs.existsSync(`${paths.runnerImage}.new`), false)
  assert.equal(fs.existsSync(`${paths.runnerImage}.old`), false)
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
  await assert.rejects(buildImage({ paths, proc, log, isRoot: false, build, fetch }), /build-image can't run while the runner does .*: stop the runner first/)
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
