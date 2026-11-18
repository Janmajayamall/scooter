// Docker (8.3 of DESIGN.md; the plan's milestone 13): the Dockerfile and the Compose files, read as
// text and as YAML, against what DESIGN.md and the native install say: the users and their uids,
// the data folder's owners and modes, restic's checksum, the two services and their settings, the
// one data volume, the container that builds the VM image, and the KVM files. Where Docker is
// installed, `docker compose config` also reads each combination of the files.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { makePaths } from '../src/common/paths.mjs'
import { createProc, findProgram } from '../src/common/proc.mjs'
import { USERS, dataFolders } from '../src/ops/setup.mjs'
import { createTestLog } from './support/log.mjs'
import { makeTestDir } from './support/tmp.mjs'

const REPO = new URL('..', import.meta.url).pathname
const read = name => fs.readFileSync(path.join(REPO, name), 'utf8')
const compose = name => parse(read(name), { merge: true })

// The Dockerfile's shell lines, with their continuations joined.
const DOCKERFILE = read('Dockerfile').replace(/\\\n\s*/g, ' ')

// The uids of 3.2 for Scooter's users in the image.
const UIDS = { wacli: 10001, runner: 10002, mail: 10003 }

test("docker: the image defines Scooter's users at the uids of 3.2, as setup names them", () => {
  const listed = /for user in ([^;]+); do/.exec(DOCKERFILE)[1].trim().split(/\s+/)
  assert.deepEqual(listed, Object.entries(UIDS).map(([part, uid]) => `${USERS[part]}:${uid}`))
  assert.match(DOCKERFILE, /useradd --system --uid "\$id" --gid "\$id" --no-create-home --home-dir \/nonexistent --shell \/usr\/sbin\/nologin/)
})

test("docker: the image's data folder has the folders, owners and modes setup gives a native one", () => {
  const ids = Object.fromEntries(Object.entries(UIDS).map(([part, uid]) => [part, { uid, gid: uid }]))
  const byName = { root: 0, ...Object.fromEntries(Object.entries(USERS).map(([part, name]) => [name, UIDS[part]])) }
  const made = new Map()
  for (const match of DOCKERFILE.matchAll(/install -d -o (\S+) -g (\S+) -m (0\d+) ([^;\n]+)/g)) {
    for (const folder of match[4].trim().split(/\s+/)) made.set(folder, { owner: { uid: byName[match[1]], gid: byName[match[2]] }, mode: Number.parseInt(match[3], 8) })
  }
  const paths = makePaths({ dataDir: '/data', configDir: '/config' })
  const want = dataFolders(paths, { ...ids, root: { uid: 0, gid: 0 } })
  assert.deepEqual(
    [...made].filter(([folder]) => folder.startsWith('/data')),
    want.map(({ path: folder, owner, mode }) => [folder, { owner, mode }]),
  )
  assert.deepEqual(made.get('/config'), { owner: { uid: 0, gid: 0 }, mode: 0o755 })
})

test('docker: the image is built as 8.3 says: its two stages, restic checked against its release, the app without install scripts, and tini', () => {
  assert.match(DOCKERFILE, /^FROM golang:1\.27-trixie AS wacli$/m)
  assert.match(DOCKERFILE, /go install -tags sqlite_fts5 -trimpath -ldflags="-s -w" "github\.com\/openclaw\/wacli\/cmd\/wacli@v\$\{WACLI_VERSION\}"/)
  assert.match(DOCKERFILE, /^ARG WACLI_VERSION=0\.26\.0$/m)
  assert.match(DOCKERFILE, /^FROM node:24-trixie-slim$/m)
  for (const name of ['ca-certificates', 'curl', 'bzip2', 'git', 'tini', 'tzdata', 'cpio', 'lz4', 'e2fsprogs', 'qemu-utils']) assert.match(DOCKERFILE, new RegExp(`apt-get install -y --no-install-recommends [^;]*\\b${name}\\b`), name)
  assert.match(DOCKERFILE, /amd64\) qemu=qemu-system-x86 ;;\s+arm64\) qemu=qemu-system-arm ;;/)
  // restic's checksums are those milestone 0 took from the release's SHA256SUMS (docs/DECISIONS.md, 0.2).
  const decisions = read('docs/DECISIONS.md')
  assert.match(DOCKERFILE, /^ARG RESTIC_VERSION=0\.19\.1$/m)
  for (const arch of ['amd64', 'arm64']) {
    const recorded = new RegExp(`\\| \`restic_0\\.19\\.1_linux_${arch}\\.bz2\` \\| \`([0-9a-f]{64})\` \\|`).exec(decisions)[1]
    assert.match(DOCKERFILE, new RegExp(`^ARG RESTIC_SHA256_${arch.toUpperCase()}=${recorded}$`, 'm'), arch)
  }
  assert.match(DOCKERFILE, /sha256sum -c -/)
  assert.match(DOCKERFILE, /^RUN npm ci --omit=dev --ignore-scripts /m)
  // The app is readable by every user, writable by root alone, whatever the checkout's modes, and
  // after everything is copied in (the review of milestone 13, smaller point 4).
  const lines = DOCKERFILE.split('\n')
  const chmod = lines.indexOf('RUN chmod -R a+rX,go-w /app')
  assert.ok(chmod > lines.indexOf('COPY src ./src') && lines.indexOf('COPY src ./src') > 0)
  assert.match(DOCKERFILE, /^ENV TZ=UTC$/m)
  assert.match(DOCKERFILE, /^ENTRYPOINT \["tini", "--", "node", "\/app\/src\/cli\.mjs"\]$/m)
  // Only what the image copies goes to the build, never an env file.
  assert.deepEqual(read('.dockerignore').split('\n').filter(entry => entry && !entry.startsWith('#')), ['*', '!package.json', '!package-lock.json', '!src/'])
})

test('docker: compose.yaml has the two services of 8.3, one data volume, and no published port', () => {
  const file = compose('compose.yaml')
  assert.deepEqual(Object.keys(file.services).sort(), ['bridge', 'build-image', 'runner'])
  assert.deepEqual(Object.keys(file.volumes), ['data'])
  for (const name of ['bridge', 'runner']) {
    const service = file.services[name]
    assert.equal(service.profiles, undefined, name)
    assert.deepEqual(service.command, [name])
    assert.equal(service.restart, 'unless-stopped', name)
    assert.deepEqual(service.security_opt, ['no-new-privileges:true'], name)
    assert.equal(service.stop_grace_period, '30s', name)
    assert.deepEqual(service.logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }, name)
    assert.deepEqual(service.environment, { DATA_DIR: '/data', CONFIG_DIR: '/config' }, name)
    assert.equal(service.env_file, `${name}.env`)
    // Neither needs added capabilities, privileges or seccomp changes, nor publishes a port (13.4).
    for (const key of ['ports', 'privileged', 'cap_add', 'devices', 'group_add', 'network_mode']) assert.equal(service[key], undefined, `${name}.${key}`)
    assert.equal(service.build, '.')
    assert.equal(service.image, 'scooter:local')
  }
  // The bridge: root, the same hostname from one container to the next (5.5), the data volume.
  const { bridge, runner } = file.services
  assert.equal(bridge.user, undefined)
  assert.equal(bridge.hostname, 'scooter')
  assert.deepEqual(bridge.volumes, ['data:/data'])
  // The runner: scooter-runner in every variant (D217), a read-only root file system with /tmp in
  // memory, and the config read-only.
  assert.equal(runner.user, USERS.runner)
  assert.equal(runner.read_only, true)
  assert.deepEqual(runner.tmpfs, ['/tmp'])
  assert.deepEqual(runner.volumes, ['data:/data', './config:/config:ro'])
})

test('docker: build-image runs in a container of its own, as root and privileged, which `up` leaves alone (D220)', () => {
  const service = compose('compose.yaml').services['build-image']
  assert.deepEqual(service.profiles, ['build-image'])
  assert.deepEqual(service.command, ['build-image'])
  assert.equal(service.user, 'root')
  assert.equal(service.privileged, true)
  assert.equal(service.restart, 'no')
  assert.equal(service.env_file, undefined)
  assert.deepEqual(service.volumes, ['data:/data', './config:/config:ro'])
})

test("docker: the KVM files give the runner the host's /dev/kvm, through the kvm group under rootful Docker, and as scooter-runner in both", () => {
  const rootful = compose('compose.kvm.yaml').services
  assert.deepEqual(Object.keys(rootful), ['runner'])
  assert.deepEqual(rootful.runner.devices, ['/dev/kvm:/dev/kvm'])
  assert.equal(rootful.runner.group_add.length, 1)
  assert.match(rootful.runner.group_add[0], /^\$\{KVM_GID:\?/)
  assert.equal(rootful.runner.user, undefined)
  const rootless = compose('compose.kvm-rootless.yaml').services
  assert.deepEqual(rootless, { runner: { devices: ['/dev/kvm:/dev/kvm'] } })
  // The udev rule it gives sets an ACL for the uid the host gives scooter-runner.
  assert.match(read('compose.kvm-rootless.yaml'), /SUBSYSTEM=="misc", KERNEL=="kvm", RUN\+="\/usr\/bin\/setfacl -m u:<uid>:rw \$devnode"/)
  assert.match(read('compose.kvm-rootless.yaml'), /'\$1 <= 10002 && 10002 < \$1 \+ \$3 \{ print \$2 \+ 10002 - \$1 \}' \/proc\/self\/uid_map/)
})

test('docker: docker compose reads each combination of the files', { skip: findProgram('docker') === null ? 'Docker is not installed' : false }, async t => {
  // In a folder of its own, with empty env files, as a checkout with its env files has it.
  const dir = makeTestDir(t)
  for (const name of ['compose.yaml', 'compose.kvm.yaml', 'compose.kvm-rootless.yaml']) fs.copyFileSync(path.join(REPO, name), path.join(dir, name))
  for (const name of ['bridge.env', 'runner.env']) fs.writeFileSync(path.join(dir, name), '')
  const proc = createProc({ log: createTestLog().log })
  const env = { PATH: process.env.PATH, HOME: dir, KVM_GID: '992' }
  for (const files of [['compose.yaml'], ['compose.yaml', 'compose.kvm.yaml'], ['compose.yaml', 'compose.kvm-rootless.yaml']]) {
    const result = await proc.run('docker', ['compose', ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'], { cwd: dir, env })
    assert.equal(result.code, 0, `${files.join(' ')}: ${result.stderr}`)
    const runner = JSON.parse(result.stdout).services.runner
    assert.equal(runner.user, USERS.runner, files.join(' '))
    if (files.length > 1) assert.equal(runner.devices[0].source, '/dev/kvm')
  }
  // Without KVM_GID, the rootful file says what to set.
  const result = await proc.run('docker', ['compose', '-f', 'compose.yaml', '-f', 'compose.kvm.yaml', 'config'], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir } })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /set KVM_GID in \.env to the host's kvm group id/)
})
