// `scooter doctor`: what it checks, and that it reports
// each missing piece with its fix: no accelerator, no QEMU, no image, wrong folder modes, and the
// rest. It changes nothing, and asks OpenRouter only for its public list of the endpoints that keep
// no data, which these tests answer themselves.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ConfigError, loadConfig } from '../src/runner/config.mjs'
import { IMAGE_RECORD, checkImage, machineArch, pinnedPiVersion, qemuProgram, readBuildFile } from '../src/runner/sandbox/image.mjs'
import { kvmProblem } from '../src/runner/sandbox/accel.mjs'
import { ZDR_ENDPOINTS_URL, accelCheck, bootCheckResult, envFileCheck, kvmFix, openRouterChecks, reportText, runChecks, wrongUser } from '../src/ops/doctor.mjs'
import { USERS, dataFolders } from '../src/ops/setup.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { makeFakeImage } from './support/fake-image.mjs'
import { writeConfig } from './support/runner.mjs'
import { runnerSettings } from './support/test-runner.mjs'
import { skipIfRoot } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const BUILD_JSON = new URL('../config/image/build.json', import.meta.url)
const MODEL = 'anthropic/claude-sonnet-5.5'

// OpenRouter's list, as it was on 2026-11-18, cut to a few endpoints.
const ZDR_LIST = {
  data: [
    { name: 'Amazon Bedrock | anthropic/claude-sonnet-5.5-20260928', model_id: MODEL, provider_name: 'Amazon Bedrock', tag: 'amazon-bedrock/us-east-1', safety_retention: false },
    { name: 'Google | anthropic/claude-sonnet-5.5-20260928', model_id: MODEL, provider_name: 'Google', tag: 'google-vertex/global', safety_retention: true },
    { name: 'Google | anthropic/claude-sonnet-5-20260630', model_id: 'anthropic/claude-sonnet-5', provider_name: 'Google', tag: 'google-vertex/us', safety_retention: false },
  ],
}

// A `fetch` that answers the list, or fails as an unreachable host does.
function fakeFetch({ answer = ZDR_LIST, status = 200, fail = null } = {}) {
  const asked = []
  const fetch = async (url, options) => {
    asked.push({ url, options })
    if (fail) throw Object.assign(new TypeError('fetch failed'), { cause: { code: fail } })
    return new Response(JSON.stringify(answer), { status })
  }
  return { fetch, asked }
}

// A runner's install, as `setup` and `build-image` leave it, in the test's folder: the config, the
// image, the data folder's folders with their owners and modes, and the runner's env file. The users are
// all the test's own user, which owns every folder, since a test can't give a folder away.
function install(t, { accel = 'auto', zdr = true } = {}) {
  const root = makeTestDir(t)
  fs.chmodSync(root, 0o755)
  const settings = runnerSettings(root, { agentAccel: accel, zdr })
  const paths = makePaths(settings)
  writeConfig(paths.configDir)
  fs.mkdirSync(path.dirname(paths.imageBuild), { recursive: true })
  fs.copyFileSync(BUILD_JSON, paths.imageBuild)
  const me = { uid: process.getuid(), gid: process.getgid() }
  const ids = { wacli: me, runner: me, mail: me, root: me }
  for (const { path: folder, mode } of dataFolders(paths, ids)) {
    fs.mkdirSync(folder, { recursive: true })
    fs.chmodSync(folder, mode)
  }
  makeFakeImage(paths.runnerImage, { ext4: false })
  fs.writeFileSync(path.join(paths.runnerImage, IMAGE_RECORD), JSON.stringify({ builtAt: '2026-11-18T08:14:00Z', pi: '1.5.2', arch: machineArch(), zones: ['Asia/Kolkata', 'UTC'] }))
  const envDir = path.join(root, 'etc')
  fs.mkdirSync(envDir)
  fs.writeFileSync(path.join(envDir, 'runner.env'), 'OPENROUTER_API_KEY=x\n', { mode: 0o600 })

  // QEMU, as stand-ins first on the PATH.
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  for (const program of [qemuProgram(), 'qemu-img']) fs.writeFileSync(path.join(bin, program), '#!/bin/sh\n', { mode: 0o755 })
  const before = process.env.PATH
  process.env.PATH = bin
  atEnd(t, () => {
    process.env.PATH = before
  })

  const users = { [USERS.wacli]: me, [USERS.runner]: me, [USERS.mail]: me }
  const proc = { findUser: async name => users[name] ?? null }
  // A VM that boots, as the real `bootCheck` finds it, without booting one.
  const booted = []
  const bootCheck = async ({ paths: given }) => {
    booted.push(given.dataDir)
    return { accel: 'kvm', ms: 1234 }
  }
  const runner = { loadConfig, ConfigError, readBuildFile, pinnedPiVersion, checkImage, qemuProgram, kvmProblem: () => null, bootCheck }
  const check = (changes = {}) => runChecks({ settings, runner, proc, envDir, root: me, docker: false, fetch: fakeFetch().fetch, ...changes })
  return { root, settings, paths, envDir, bin, users, proc, runner, check, booted }
}

const byName = (checks, name) => checks.filter(check => check.name === name)
const failed = checks => checks.filter(check => check.status !== 'ok').map(check => `${check.name}: ${check.status}`)

test('doctor: with everything there, every check passes, and the report says so', async t => {
  const { check, paths } = install(t)
  const { fetch, asked } = fakeFetch()
  const checks = await check({ fetch })
  assert.deepEqual(failed(checks), [])
  assert.deepEqual(
    checks.map(entry => entry.name),
    ['config', 'accelerator', 'QEMU', 'VM image', 'VM boot', 'folders', 'env files', 'OpenRouter', 'ZDR'],
  )
  assert.equal(byName(checks, 'VM boot')[0].text, 'a VM booted in 1.2 seconds, with KVM')
  assert.match(byName(checks, 'config')[0].text, new RegExp(`the agent's model is ${MODEL}`))
  assert.equal(byName(checks, 'accelerator')[0].text, 'KVM')
  assert.match(byName(checks, 'VM image')[0].text, /^built 2026-11-18T08:14:00Z, with pi 1\.5\.2/)
  assert.match(byName(checks, 'folders')[0].text, new RegExp(`${paths.dataDir} and its folders have their owners and modes`))
  assert.equal(byName(checks, 'ZDR')[0].text, `2 endpoints of ${MODEL} keep no data: Amazon Bedrock (amazon-bedrock/us-east-1), Google (google-vertex/global), with safety retention`)
  // It asked for OpenRouter's public list, with no key and nothing else.
  assert.deepEqual(asked.map(entry => entry.url), [ZDR_ENDPOINTS_URL])
  assert.deepEqual(Object.keys(asked[0].options.headers), ['accept'])
  const report = reportText(checks)
  assert.match(report, /^ok {4}config: /m)
  assert.match(report, /The runner has what it needs\.\n$/)
})

test('doctor: no accelerator, with its fix natively and in Docker; a forced one fails, and auto falls back with a warning', async t => {
  const { check, runner } = install(t)
  const checks = await check({ runner: { ...runner, kvmProblem: () => 'EACCES' } })
  const [accel] = byName(checks, 'accelerator')
  assert.equal(accel.status, 'warn')
  assert.match(accel.fix, /scooter-runner can't open \/dev\/kvm \(EACCES\): sudo scooter setup puts it in the kvm group/)
  // A warning isn't a failure: the runner runs.
  assert.match(reportText(checks), /The runner has what it needs/)

  assert.equal(accelCheck('kvm', 'ENOENT').status, 'fail')
  assert.match(accelCheck('kvm', 'ENOENT').fix, /this machine has no \/dev\/kvm: turn on virtualization/)
  assert.match(accelCheck('auto', 'ENOENT', { docker: true }).fix, /compose\.kvm\.yaml \(rootful Docker\) or compose\.kvm-rootless\.yaml \(rootless Docker\) to COMPOSE_FILE/)
  assert.match(kvmFix('EACCES', { docker: true }), /^scooter-runner can't open \/dev\/kvm in its container \(EACCES\): with rootful Docker, compose\.kvm\.yaml .*KVM_GID.*rootless Docker, the udev rule compose\.kvm-rootless\.yaml gives/)
  assert.equal(accelCheck('emulation', null).status, 'ok')
  assert.equal(accelCheck('hvf', null).status, 'fail')
  assert.equal(accelCheck('auto', null).text, 'KVM')
})

test('doctor: no QEMU, and no image, or one for another pi, each with its fix', async t => {
  const { check, bin, paths } = install(t)
  fs.rmSync(path.join(bin, 'qemu-img'))
  fs.rmSync(path.join(paths.runnerImage, IMAGE_RECORD))
  let checks = await check()
  const [qemu] = byName(checks, 'QEMU')
  assert.equal(qemu.status, 'fail')
  assert.equal(qemu.text, "qemu-img isn't on the PATH")
  assert.match(qemu.fix, /^install QEMU, such as apt install qemu-system-/)
  const [image] = byName(checks, 'VM image')
  assert.equal(image.status, 'fail')
  assert.match(image.text, /has no scooter-image\.json/)
  assert.equal(image.fix, 'sudo scooter build-image')
  // Without QEMU or an image, no VM is booted.
  assert.deepEqual(byName(checks, 'VM boot'), [])
  assert.match(reportText(checks), /2 things to fix\.\n$/)

  fs.rmSync(paths.runnerImage, { recursive: true })
  checks = await check()
  assert.match(byName(checks, 'VM image')[0].text, /^there is no VM image in /)
  makeFakeImage(paths.runnerImage, { ext4: false })
  fs.writeFileSync(path.join(paths.runnerImage, IMAGE_RECORD), JSON.stringify({ builtAt: '2026-11-18T08:14:00Z', pi: '1.4.0', arch: machineArch(), zones: ['Asia/Kolkata'] }))
  checks = await check({ docker: true })
  assert.match(byName(checks, 'VM image')[0].text, /has pi 1\.4\.0, and config\/image\/build\.json pins 1\.5\.2/)
  assert.equal(byName(checks, 'VM image')[0].fix, 'docker compose run --rm build-image, with the runner stopped')
})

test('doctor: stopped during the boot check, it hands the boot check its signal, which closes the VM, and makes no check after it', async t => {
  // `bootCheck` closes its VM on the signal (sandbox.test.mjs).
  const { check, runner } = install(t)
  const stopping = new AbortController()
  const given = []
  const bootCheck = async ({ signal }) => {
    given.push(signal)
    stopping.abort()
    throw new Error('doctor was stopped during the boot')
  }
  const checks = await check({ runner: { ...runner, bootCheck }, signal: stopping.signal })
  assert.deepEqual(given, [stopping.signal])
  assert.deepEqual(checks.map(entry => entry.name), ['config', 'accelerator', 'QEMU', 'VM image'])
})

test("doctor: stopped while it waits for OpenRouter's answer, it stops waiting, and makes no check of OpenRouter", async t => {
  // Its handlers once took Ctrl-C's own ending away, and the
  // wait went on for up to DOCTOR_TIMEOUT.
  const { check } = install(t)
  const stopping = new AbortController()
  const given = []
  const fetch = (url, { signal }) => {
    given.push(signal)
    stopping.abort()
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason))
    })
  }
  const started = Date.now()
  const checks = await check({ fetch, signal: stopping.signal })
  assert.ok(Date.now() - started < 5000)
  assert.equal(given.length, 1)
  assert.equal(given[0].aborted, true)
  assert.deepEqual(checks.map(entry => entry.name), ['config', 'accelerator', 'QEMU', 'VM image', 'VM boot', 'folders', 'env files'])
})

test("doctor: a VM boots from the image with the runner's accelerator, in its own folder; one that doesn't is a failure, with its fix", async t => {
  const { check, runner, paths, booted } = install(t)
  await check()
  assert.deepEqual(booted, [paths.dataDir])
  // KVM that opens and doesn't boot a VM, as under nested virtualization.
  const checks = await check({ runner: { ...runner, bootCheck: async () => Promise.reject(new Error("the VM couldn't start: timeout")) } })
  const [boot] = byName(checks, 'VM boot')
  assert.equal(boot.status, 'fail')
  assert.equal(boot.text, "a VM didn't boot from the image: the VM couldn't start: timeout")
  assert.match(boot.fix, /enable nested virtualization for it, or set AGENT_ACCEL=emulation in runner\.env/)
  assert.match(bootCheckResult({ error: new Error('x'), docker: true }).fix, /runner\.env beside compose\.yaml.*docker compose run --rm build-image/)
  assert.equal(bootCheckResult({ booted: { accel: 'emulation', ms: 6100 } }).text, 'a VM booted in 6.1 seconds, with emulation')
})

test("doctor: it runs as the runner's user where that user is there, and says how", async () => {
  const proc = users => ({ findUser: async name => users[name] ?? null })
  assert.equal(await wrongUser({ proc: proc({}), uid: 0 }), null)
  assert.equal(await wrongUser({ proc: proc({ [USERS.runner]: { uid: 997, gid: 997 } }), uid: 997 }), null)
  assert.equal(
    await wrongUser({ proc: proc({ [USERS.runner]: { uid: 997, gid: 997 } }), uid: 0, docker: false }),
    'doctor checks what the runner can reach, so it runs as scooter-runner, not as uid 0: sudo -u scooter-runner scooter doctor',
  )
  assert.match(await wrongUser({ proc: proc({ [USERS.runner]: { uid: 10002, gid: 10002 } }), uid: 0, docker: true }), /: docker compose run --rm runner doctor$/)
})

test('doctor: a folder with the wrong mode or owner, or no users, each with its fix', async t => {
  const { check, paths, users, proc } = install(t)
  fs.chmodSync(paths.agents, 0o755)
  fs.chmodSync(paths.datastore, 0o700)
  let checks = await check()
  const folders = byName(checks, 'folders')
  assert.deepEqual(
    folders.map(entry => [entry.status, entry.text.replaceAll(paths.dataDir, 'DATA').replace(/\d+:\d+/g, 'U:G')]),
    [
      ['fail', 'DATA/datastore is U:G, mode 0700, where it must be U:G, mode 0750'],
      ['fail', 'DATA/agents is U:G, mode 0755, where it must be U:G, mode 0700'],
    ],
  )
  assert.ok(folders.every(entry => entry.fix === 'sudo scooter setup, which sets them'))
  checks = await check({ docker: true })
  assert.match(byName(checks, 'folders')[0].fix, /^docker compose run --rm --entrypoint sh bridge -c 'chown \d+:\d+ \S+\/datastore && chmod 0750 \S+\/datastore'$/)

  // A data folder another user could write would let them steer build-image, as root.
  fs.chmodSync(paths.agents, 0o700)
  fs.chmodSync(paths.datastore, 0o750)
  fs.chmodSync(paths.dataDir, 0o777)
  checks = await check()
  assert.match(byName(checks, 'folders')[0].text, /data is \d+:\d+, mode 0777, where it must be \d+:\d+, mode 0755$/)
  fs.chmodSync(paths.dataDir, 0o755)

  delete users[USERS.mail]
  checks = await check({ proc })
  assert.deepEqual(
    byName(checks, 'folders').map(entry => [entry.status, entry.text, entry.fix]),
    [['fail', "there is no user scooter-mail on this machine, so the owners of the folders can't be checked", 'sudo scooter setup, which makes them']],
  )
})

test('doctor: a bad agents.yaml names the field; the ZDR check is then left for later', async t => {
  const { check, paths } = install(t)
  fs.writeFileSync(paths.agentsYaml, 'agents:\n  lifelog:\n    model: 42\n')
  const checks = await check()
  const [config] = byName(checks, 'config')
  assert.equal(config.status, 'fail')
  assert.match(config.text, /agents\.lifelog\.model/)
  assert.equal(config.fix, `correct ${paths.agentsYaml}`)
  assert.deepEqual(byName(checks, 'ZDR').map(entry => [entry.status, entry.text]), [['warn', "not checked: agents.yaml can't be read"]])
})

test('doctor: OpenRouter out of reach, a model with no endpoint that keeps no data, and ZDR off', async t => {
  const { check } = install(t)
  let checks = await check({ fetch: fakeFetch({ fail: 'ENOTFOUND' }).fetch })
  assert.deepEqual(
    checks.filter(entry => entry.name === 'OpenRouter' || entry.name === 'ZDR').map(entry => [entry.name, entry.status, entry.text]),
    [['OpenRouter', 'fail', "openrouter.ai can't be reached from here (ENOTFOUND)"]],
  )
  checks = await check({ fetch: fakeFetch({ answer: { data: ZDR_LIST.data.slice(2) } }).fetch })
  const [zdr] = byName(checks, 'ZDR')
  assert.equal(zdr.status, 'fail')
  assert.equal(zdr.text, `no endpoint of ${MODEL} keeps no data, so OpenRouter would refuse every run`)
  assert.match(zdr.fix, /OPENROUTER_ZDR=off/)
  // OpenRouter answers, but not with the list.
  checks = await check({ fetch: fakeFetch({ answer: { error: 'busy' }, status: 503 }).fetch })
  assert.deepEqual(byName(checks, 'ZDR').map(entry => entry.status), ['warn'])
  assert.equal(byName(checks, 'OpenRouter')[0].text, 'openrouter.ai answers (HTTP 503)')

  assert.deepEqual(openRouterChecks({ status: 200, endpoints: [] }, { model: MODEL, zdrOn: false })[1], { name: 'ZDR', status: 'ok', text: 'off (OPENROUTER_ZDR=off), so not checked' })
})

test('doctor: the runner\'s env file must be its own, mode 0600, and the bridge\'s out of its reach', { skip: skipIfRoot }, async t => {
  const { envDir } = install(t)
  assert.equal(envFileCheck(envDir).status, 'ok')
  fs.chmodSync(path.join(envDir, 'runner.env'), 0o644)
  assert.match(envFileCheck(envDir).text, /runner\.env is \d+, mode 0644, where it must be the runner's, 0600/)
  fs.chmodSync(path.join(envDir, 'runner.env'), 0o600)
  // A bridge.env the runner can read.
  fs.writeFileSync(path.join(envDir, 'bridge.env'), 'RESTIC_PASSWORD=x\n', { mode: 0o644 })
  const check = envFileCheck(envDir)
  assert.equal(check.status, 'fail')
  assert.match(check.text, /the runner can read \S+bridge\.env, which holds the bridge's secrets/)
  // Out of its reach, as root's file of mode 0600 is.
  fs.chmodSync(path.join(envDir, 'bridge.env'), 0o000)
  assert.equal(envFileCheck(envDir).status, 'ok')
  // In Docker there are no files: the settings come from the environment.
  assert.match(envFileCheck(path.join(envDir, 'none')).text, /^none in /)
})

test('doctor: it changes nothing in the data folder', async t => {
  const { check, paths } = install(t)
  const snapshot = () =>
    fs
      .readdirSync(paths.dataDir, { recursive: true })
      .sort()
      .map(name => {
        const stat = fs.lstatSync(path.join(paths.dataDir, name))
        return `${name} ${stat.mode} ${stat.size} ${stat.mtimeMs}`
      })
  const before = snapshot()
  await check({ runner: { ...install(t).runner, kvmProblem: () => 'ENOENT' } })
  assert.deepEqual(snapshot(), before)
})
