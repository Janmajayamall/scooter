// The real sandbox: a Gondolin VM for each run,
// booted from the built image, with what it sees and may change, the environment, the network and the limits of
// `src/runner/sandbox/gondolin.mjs`. And the milestone's end to end: one batch through the real
// sandbox, with the scripted fake model in place of OpenRouter.
//
// These need QEMU, `SCOOTER_TEST_IMAGE` and `debugfs`, and skip themselves without them. With KVM
// (`sg kvm -c 'npm test'` on the plan's machine) they take about a minute; under emulation, several.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { overrideLimits } from '../src/common/limits.mjs'
import { readNetworkLog } from '../src/common/netlog.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { systemClock } from '../src/common/time.mjs'
import { icuTzRelease } from '../src/runner/agentdir.mjs'
import { openRunner } from '../src/runner/main.mjs'
import { rebuildAgent } from '../src/runner/rebuild.mjs'
import { EMULATION_NOTICE } from '../src/runner/status.mjs'
import { piFiles } from '../src/runner/run.mjs'
import { kvmProblem } from '../src/runner/sandbox/accel.mjs'
import { FUSE_MOUNT, bootCheck, gondolinFolders, machineType } from '../src/runner/sandbox/gondolin.mjs'
import { GUEST_HOME, GUEST_PATH } from '../src/runner/sandbox/index.mjs'
import { createFakeModel } from './support/fake-model.mjs'
import { createTestLog } from './support/log.mjs'
import { line, writeConfig, writeDatastore } from './support/runner.mjs'
import { fakeModelNetwork, keepEnvironment, linkTestImage, openTestSandbox, sandboxSkipReason } from './support/sandbox.mjs'
import { toolResults } from './support/vm.mjs'
import { KEY, runnerSettings } from './support/test-runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const options = { skip: sandboxSkipReason(), timeout: 600_000 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(condition, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

// A data folder laid out as the runner leaves it before a run: the agent's folder, with a session
// in `sessions/`, and a datastore with one line.
function prepare(t, settings = {}) {
  const root = makeTestDir(t)
  const config = runnerSettings(root, settings)
  const paths = makePaths(config)
  writeConfig(paths.configDir)
  const agent = paths.agentDir('lifelog')
  for (const folder of ['views', 'memory', 'sessions', 'run/session', 'run/send']) fs.mkdirSync(path.join(agent, folder), { recursive: true })
  fs.writeFileSync(path.join(agent, 'state.json'), '{}\n')
  fs.writeFileSync(path.join(agent, 'run', 'index.txt'), '')
  fs.writeFileSync(path.join(agent, 'sessions', 'lifelog-2026-11-08.jsonl'), '{"type":"session"}\n')
  fs.writeFileSync(path.join(agent, 'views', 'expenses.csv'), 'date,amount\n')
  fs.mkdirSync(paths.datastore, { recursive: true })
  writeDatastore(paths, [line.text(1, '2026-11-09T15:50:00Z', 'coffee 150')])
  const { log, entries } = createTestLog()
  return { root, paths, settings: config, log, entries, clock: systemClock }
}

// The agent of the example config, as far as what its VM sees and may change goes.
const AGENT = { name: 'lifelog', reads: ['datastore/', 'agents/lifelog/'], writes: ['agents/lifelog/views/', 'agents/lifelog/memory/'] }

// A spec for a command, with what a run's VM sees and may change, and the environment of `env`.
function specOf(paths, argv, { env = {}, timeoutMs = 120_000, cwd = paths.agentDir('lifelog'), files = piFiles(paths, AGENT) } = {}) {
  return {
    argv,
    cwd,
    env: { PATH: GUEST_PATH, HOME: GUEST_HOME, LANG: 'C.UTF-8', TZ: 'Asia/Kolkata', ...env },
    files,
    timeoutMs,
    policy: { model: 'anthropic/claude-sonnet-5.5', internet: false, zdr: true, secrets: { OPENROUTER_API_KEY: { hosts: ['openrouter.ai'], value: KEY } } },
  }
}

const sh = (paths, script, extra) => specOf(paths, ['/bin/sh', '-c', script], extra)

// The QEMU of each VM started, from the sandbox's log.
const qemuPids = entries => entries.filter(entry => entry.event === 'sandbox.vm_started').map(entry => entry.qemu)

test('sandbox: a VM boots from the built image and runs pi --version, in under 3 seconds with KVM', options, async t => {
  const prepared = prepare(t)
  const sandbox = await openTestSandbox(t, prepared)
  assert.equal(sandbox.accel, kvmProblem() === null ? 'kvm' : 'emulation')
  assert.match(sandbox.imageBuiltAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)

  const result = await sandbox.run(specOf(prepared.paths, ['pi', '--version']))
  assert.deepEqual({ ...result, signal: undefined }, { code: 0, signal: undefined, stdout: '1.5.2\n', stderr: '', timedOut: false, wroteTooMuch: false })

  // The fastest of three boots.
  for (let n = 0; n < 2; n++) assert.equal((await sandbox.run(specOf(prepared.paths, ['/bin/true']))).code, 0)
  const boots = prepared.entries.filter(entry => entry.event === 'sandbox.vm_started').map(entry => entry.ms)
  t.diagnostic(`boot with ${sandbox.accel}: ${boots.join(', ')} ms`)
  if (sandbox.accel === 'kvm') assert.ok(Math.min(...boots) < 3000, `the fastest boot took ${Math.min(...boots)} ms`)
  // Every VM is closed: no QEMU is left, and nothing in the temporary folder.
  for (const pid of qemuPids(prepared.entries)) assert.equal(isAlive(pid), false)
  assert.deepEqual(fs.readdirSync(prepared.paths.runnerTmp), [])
})

test("sandbox: pi's VMs get QEMU's q35 machine on x86_64, with KVM as under emulation, and Gondolin's own on arm64", () => {
  // microvm, Gondolin's choice with KVM, hangs under nested KVM with 2 processors.
  assert.equal(machineType('x86_64'), 'q35')
  assert.equal(machineType('aarch64'), undefined)
})

test("sandbox: doctor's boot check boots a VM with the runner's accelerator, in a folder of its own, and changes nothing in the data folder", options, async t => {
  const prepared = prepare(t)
  await linkTestImage(prepared.paths)
  keepEnvironment(t)
  fs.mkdirSync(path.dirname(prepared.paths.imageBuild), { recursive: true })
  fs.copyFileSync(new URL('../config/image/build.json', import.meta.url), prepared.paths.imageBuild)
  const snapshot = () =>
    fs
      .readdirSync(prepared.paths.dataDir, { recursive: true })
      .sort()
      .map(name => {
        const stat = fs.lstatSync(path.join(prepared.paths.dataDir, name))
        return `${name} ${stat.mode} ${stat.size} ${stat.mtimeMs}`
      })
  const before = snapshot()
  const booted = await bootCheck({ paths: prepared.paths, settings: prepared.settings })
  t.diagnostic(`boot with ${booted.accel}: ${booted.ms} ms`)
  assert.equal(booted.accel, kvmProblem() === null ? 'kvm' : 'emulation')
  assert.ok(booted.ms > 0)
  assert.deepEqual(snapshot(), before)
})

test("sandbox: doctor's boot check, stopped during the boot, closes its VM and removes its folder; with a TMPDIR too long for Gondolin's sockets it boots in /tmp", options, async t => {
  const prepared = prepare(t)
  await linkTestImage(prepared.paths)
  keepEnvironment(t)
  fs.mkdirSync(path.dirname(prepared.paths.imageBuild), { recursive: true })
  fs.copyFileSync(new URL('../config/image/build.json', import.meta.url), prepared.paths.imageBuild)
  const scratch = base => fs.readdirSync(base).filter(name => name.startsWith('scooter-doctor-'))
  // The sandbox sets the process's temporary folder to its own, as the runner's does.
  const tmp = os.tmpdir()
  const stop = new AbortController()
  const checking = bootCheck({ paths: prepared.paths, settings: prepared.settings, signal: stop.signal })
  // The boot check's QEMU, by its folder, whose name is its own, on its command line.
  const [folder] = scratch(tmp)
  const qemus = () => {
    try {
      return execFileSync('pgrep', ['-f', path.join(tmp, folder)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  await waitFor(() => qemus().length > 0, "the boot check's QEMU")
  stop.abort()
  await assert.rejects(checking, /doctor was stopped during the boot/)
  await waitFor(() => qemus().length === 0, 'no QEMU')
  assert.deepEqual(scratch(tmp), [])

  const long = path.join(tmp, 'x'.repeat(90))
  fs.mkdirSync(long)
  const before = process.env.TMPDIR
  process.env.TMPDIR = long
  try {
    assert.equal(os.tmpdir(), long)
    const booted = await bootCheck({ paths: prepared.paths, settings: prepared.settings })
    assert.ok(booted.ms > 0)
  } finally {
    process.env.TMPDIR = before
  }
  assert.deepEqual(scratch(long), [])
})

test("sandbox: what a run's VM sees, at the host's paths, may be changed only where writes names and in run/session, run/send and run/marks.txt, with sessions/ not there, even through a link", options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  const agent = paths.agentDir('lifelog')
  const day = path.join(paths.datastore, '2026', '11', '09')
  const script = `
    try() { if "$@" 2>/dev/null; then echo "$*: ok"; else echo "$*: refused"; fi; }
    try touch ${agent}/views/new.csv
    try mkdir ${agent}/memory/notes
    try touch ${agent}/run/session/s.jsonl
    try sh -c 'echo x >> ${agent}/state.json'
    try touch ${agent}/new.txt
    try sh -c 'echo x > ${agent}/run/index.txt'
    try sh -c 'echo x > ${agent}/run/send/1.json'
    try sh -c 'echo done 1 >> ${agent}/run/marks.txt'
    try sh -c 'echo x > ${agent}/run/marks2.txt'
    try sh -c 'echo x >> ${day}/log.jsonl'
    try rm ${day}/log.jsonl
    try chmod 600 ${agent}/state.json
    try mkdir ${paths.datastore}/2027
    try cat ${day}/log.jsonl
    try ls ${agent}/sessions
    try mkdir ${agent}/sessions
    try ln -s ${agent}/sessions ${agent}/views/link
    try ls ${agent}/views/link/
    try ln -s ../sessions ${agent}/memory/link
    try cat ${agent}/memory/link/lifelog-2026-11-08.jsonl
    try ls ${FUSE_MOUNT}${agent}/sessions
    try ls /data
    try ls ${paths.runner}
    try ls ${paths.exchange}
    try ls ${paths.configDir}
  `
  const result = await sandbox.run(sh(paths, script))
  assert.equal(result.code, 0, result.stderr)
  const lines = result.stdout.trim().split('\n')
  const expect = (command, answer) => assert.ok(lines.includes(`${command}: ${answer}`), `${command}: expected ${answer}, in\n${result.stdout}`)
  expect(`touch ${agent}/views/new.csv`, 'ok')
  expect(`mkdir ${agent}/memory/notes`, 'ok')
  expect(`touch ${agent}/run/session/s.jsonl`, 'ok')
  expect(`sh -c echo x >> ${agent}/state.json`, 'refused')
  expect(`touch ${agent}/new.txt`, 'refused')
  expect(`sh -c echo x > ${agent}/run/index.txt`, 'refused')
  // The run's own places in run/: the messages send queues, and the marks file.
  expect(`sh -c echo x > ${agent}/run/send/1.json`, 'ok')
  expect(`sh -c echo done 1 >> ${agent}/run/marks.txt`, 'ok')
  expect(`sh -c echo x > ${agent}/run/marks2.txt`, 'refused')
  expect(`sh -c echo x >> ${day}/log.jsonl`, 'refused')
  expect(`rm ${day}/log.jsonl`, 'refused')
  expect(`chmod 600 ${agent}/state.json`, 'refused')
  expect(`mkdir ${paths.datastore}/2027`, 'refused')
  expect(`cat ${day}/log.jsonl`, 'ok')
  // sessions/ isn't there, can't be made, and a link to it leads nowhere.
  expect(`ls ${agent}/sessions`, 'refused')
  expect(`mkdir ${agent}/sessions`, 'refused')
  expect(`ls ${agent}/views/link/`, 'refused')
  expect(`cat ${agent}/memory/link/lifelog-2026-11-08.jsonl`, 'refused')
  expect(`ls ${FUSE_MOUNT}${agent}/sessions`, 'refused')
  // Nothing else of the host: not Gondolin's default mount point, nor the runner's or the
  // exchange's folders, nor the configuration.
  for (const folder of ['/data', paths.runner, paths.exchange, paths.configDir]) expect(`ls ${folder}`, 'refused')

  // What the VM wrote is on the host, and the host's own files are as they were.
  assert.ok(fs.existsSync(path.join(agent, 'views', 'new.csv')))
  assert.ok(fs.existsSync(path.join(agent, 'run', 'session', 's.jsonl')))
  assert.deepEqual(fs.readdirSync(path.join(agent, 'sessions')), ['lifelog-2026-11-08.jsonl'])
  assert.equal(fs.readFileSync(path.join(agent, 'state.json'), 'utf8'), '{}\n')
})

test("sandbox: writes that name one file, a folder in another entry, and a path outside the agent's folder, each as the VM may change it; and a backfill's narrower writes", options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  const agent = paths.agentDir('lifelog')
  fs.mkdirSync(path.join(paths.dataDir, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(paths.dataDir, 'notes', 'todo.md'), '- one\n')
  fs.writeFileSync(path.join(agent, 'memory', 'preferences.md'), '- rule\n')
  const try_ = 'try() { if "$@" 2>/dev/null; then echo "$*: ok"; else echo "$*: refused"; fi; }'
  const outcomes = async (files, commands) => {
    const result = await sandbox.run(sh(paths, `${try_}\n${commands.map(command => `try ${command}`).join('\n')}`, { files }))
    assert.equal(result.code, 0, result.stderr)
    return Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(': ').reverse()).map(([answer, ...command]) => [command.reverse().join(': '), answer]))
  }

  // reads names only the datastore; writes a file of views/, the memory folder, a folder in it,
  // and a file outside the agent's folder.
  const writes = ['agents/lifelog/views/books.csv', 'agents/lifelog/memory/', 'agents/lifelog/memory/people/', 'notes/todo.md']
  const files = piFiles(paths, { name: 'lifelog', reads: ['datastore/'], writes })
  const answers = await outcomes(files, [
    `touch ${agent}/views/books.csv`,
    `touch ${agent}/views/expenses.csv`,
    `ls ${agent}/views/expenses.csv`,
    `mkdir ${agent}/views/books.csv.d`,
    `mkdir ${agent}/memory/people`,
    `touch ${agent}/memory/people/sam.md`,
    `sh -c 'echo x >> ${agent}/memory/preferences.md'`,
    `sh -c 'echo x >> ${paths.dataDir}/notes/todo.md'`,
    `touch ${paths.dataDir}/notes/other.md`,
    `test -s ${agent}/state.json`,
    `test -d ${agent}/run/session`,
    `touch ${agent}/run/session/s.jsonl`,
  ])
  assert.deepEqual(answers, {
    [`touch ${agent}/views/books.csv`]: 'ok',
    [`touch ${agent}/views/expenses.csv`]: 'refused',
    [`ls ${agent}/views/expenses.csv`]: 'refused',
    [`mkdir ${agent}/views/books.csv.d`]: 'refused',
    [`mkdir ${agent}/memory/people`]: 'ok',
    [`touch ${agent}/memory/people/sam.md`]: 'ok',
    [`sh -c echo x >> ${agent}/memory/preferences.md`]: 'ok',
    [`sh -c echo x >> ${paths.dataDir}/notes/todo.md`]: 'ok',
    [`touch ${paths.dataDir}/notes/other.md`]: 'refused',
    // The agent's folder isn't in reads, but for what writes names and run/.
    [`test -s ${agent}/state.json`]: 'refused',
    [`test -d ${agent}/run/session`]: 'ok',
    [`touch ${agent}/run/session/s.jsonl`]: 'ok',
  })
  assert.equal(fs.readFileSync(path.join(paths.dataDir, 'notes', 'todo.md'), 'utf8'), '- one\nx\n')
  assert.equal(fs.existsSync(path.join(agent, 'views', 'expenses.csv')), true)

  // A backfill's batch: the agent's writes are seen, and only the backfill's changed.
  const narrow = piFiles(paths, AGENT, ['agents/lifelog/views/people.csv'])
  const backfill = await outcomes(narrow, [`touch ${agent}/views/people.csv`, `sh -c 'echo x >> ${agent}/views/expenses.csv'`, `test -s ${agent}/views/expenses.csv`, `touch ${agent}/memory/new.md`])
  assert.deepEqual(backfill, {
    [`touch ${agent}/views/people.csv`]: 'ok',
    [`sh -c echo x >> ${agent}/views/expenses.csv`]: 'refused',
    [`test -s ${agent}/views/expenses.csv`]: 'ok',
    [`touch ${agent}/memory/new.md`]: 'refused',
  })
  assert.equal(fs.readFileSync(path.join(agent, 'views', 'expenses.csv'), 'utf8'), 'date,amount\n')
})

test('sandbox: nothing survives between runs, neither files outside the mounts nor background processes', options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  const first = await sandbox.run(
    sh(paths, 'echo x > /root/left; echo x > /tmp/left; echo x > /var/tmp/left; echo x > /etc/left; (setsid sleep 1000 >/dev/null 2>&1 &); sleep 1; pgrep -x sleep >/dev/null && echo running'),
  )
  assert.equal(first.code, 0, first.stderr)
  assert.equal(first.stdout, 'running\n')
  const second = await sandbox.run(sh(paths, 'ls /root/left /tmp/left /var/tmp/left /etc/left 2>/dev/null; pgrep -x sleep || echo none'))
  assert.equal(second.stdout, 'none\n')
})

test('sandbox: from inside the VM, another host, DNS to an outside resolver, UDP and private addresses are refused, and the environment holds only the placeholder', options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared

  // A server on every address of the host, which counts what reaches it.
  const hits = []
  const server = http.createServer((request, response) => {
    hits.push(request.url)
    response.end('the host\n')
  })
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
  atEnd(t, () => new Promise(resolve => server.close(resolve)))
  const datagrams = []
  const udp = dgram.createSocket('udp4')
  udp.on('message', message => datagrams.push(message))
  await new Promise(resolve => udp.bind(0, '0.0.0.0', resolve))
  atEnd(t, () => new Promise(resolve => udp.close(resolve)))
  const port = server.address().port
  const udpPort = udp.address().port
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find(address => address.family === 'IPv4' && !address.internal)?.address
  const script = `
    probe() { label=$1; shift; if out=$("$@" 2>&1); then echo "$label: ok $out"; else echo "$label: refused"; fi; }
    probe example probe_http https://example.com/
    probe http-example curl -sS -f -m 8 http://example.com/
    probe metadata curl -sS -f -m 8 http://169.254.169.254/latest/meta-data/
    probe loopback curl -sS -f -m 8 http://127.0.0.1:${port}/
    probe lan curl -sS -f -m 8 http://${lan ?? '192.168.1.1'}:${port}/
    probe private curl -sS -f -m 8 http://10.0.0.1/
    probe dns sh -c "nslookup example.com 8.8.8.8 | grep -A3 '^Name' | grep -q 192.0.2.1"
    for target in ${lan ?? '192.168.1.1'} 8.8.8.8; do echo udp | nc -u -w 2 $target ${udpPort} >/dev/null 2>&1; done
    env | sort
  `.replace(/probe_http/g, 'curl -sS -f -m 8')
  for (const [name, network] of [
    ['the network policy, with internet access off', undefined],
    ['with the fake model at OpenRouter, behind the policy', await fakeModelNetwork(t, createFakeModel([{ text: 'Done.' }]), prepared)],
  ]) {
    await t.test(name, async () => {
      hits.length = 0
      datagrams.length = 0
      fs.rmSync(paths.networkLogDir, { recursive: true, force: true })
      const sandbox = await openTestSandbox(t, { ...prepared, network })
      const result = await sandbox.run(sh(paths, script))
      assert.equal(result.code, 0, result.stderr)
      const lines = result.stdout.trim().split('\n')
      for (const probe of ['example', 'http-example', 'metadata', 'loopback', 'lan', 'private']) {
        assert.ok(lines.includes(`${probe}: refused`), `${probe} wasn't refused:\n${result.stdout}`)
      }
      // DNS is answered inside the runner, with a made-up address, whatever resolver is asked.
      assert.ok(lines.includes('dns: ok '), result.stdout)
      assert.deepEqual(hits, [])
      assert.deepEqual(datagrams, [])
      // The policy refused each HTTP(S) request, and said why; nothing went out. The host's
      // loopback, from inside the VM, is the VM's own.
      const logged = readNetworkLog(paths, { from: Date.now() - 600_000, to: Date.now() + 1000 }).entries
      assert.deepEqual(
        logged.map(entry => `${entry.event} ${entry.host} ${entry.reason}`).sort(),
        [
          'refused 10.0.0.1 plain HTTP isn\'t allowed',
          'refused 169.254.169.254 plain HTTP isn\'t allowed',
          `refused ${lan ?? '192.168.1.1'} plain HTTP isn't allowed`,
          'refused example.com host not allowed',
          'refused example.com plain HTTP isn\'t allowed',
        ].sort(),
      )

      // The environment: exactly the spec's, and the key's placeholder, which isn't the key.
      const env = Object.fromEntries(lines.filter(entry => /^[A-Z_]+=/.test(entry)).map(entry => entry.split(/=(.*)/s).slice(0, 2)))
      assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'OPENROUTER_API_KEY', 'PATH', 'PWD', 'SHLVL', 'TZ'].sort())
      assert.notEqual(env.OPENROUTER_API_KEY, KEY)
      assert.ok(!result.stdout.includes(KEY))
      assert.ok(env.OPENROUTER_API_KEY.length > 20)
    })
  }
})

test('sandbox: with internet access on, nothing reaches a private address given as a number, and plain HTTP is refused', options, async t => {
  const prepared = prepare(t, { agentInternet: true })
  const { paths } = prepared
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find(address => address.family === 'IPv4' && !address.internal)?.address ?? '192.168.1.1'
  // Addresses, not names, so nothing is looked up outside the machine. What this shows is that
  // nothing reaches them, and that the policy refuses plain HTTP. HTTPS to an address given as a
  // number fails at the TLS handshake, before the policy sees anything of it, whether the address
  // is private or not: the review of milestone 8 found a public one, 203.0.113.9, refused the same
  // way. What keeps a name that resolves to a private address out is Gondolin's `isIpAllowed`,
  // which the policy leaves on, and which `policy.test.mjs` asks about private and public addresses.
  const script = `
    probe() { label=$1; shift; if out=$("$@" 2>&1); then echo "$label: ok $out"; else echo "$label: refused"; fi; }
    probe metadata curl -sS -f -k -m 8 https://169.254.169.254/latest/meta-data/
    probe lan curl -sS -f -k -m 8 https://${lan}/
    probe private curl -sS -f -k -m 8 https://10.0.0.1/
    probe http curl -sS -f -m 8 http://203.0.113.9/
  `
  const sandbox = await openTestSandbox(t, prepared)
  const spec = { ...sh(paths, script), policy: { ...sh(paths, script).policy, internet: true } }
  const result = await sandbox.run(spec)
  assert.equal(result.code, 0, result.stderr)
  for (const probe of ['metadata', 'lan', 'private', 'http']) assert.ok(result.stdout.includes(`${probe}: refused`), result.stdout)
  const logged = readNetworkLog(paths, { from: Date.now() - 600_000, to: Date.now() + 1000 }).entries
  t.diagnostic(logged.map(entry => JSON.stringify(entry)).join('\n'))
  // No answer came from any of them.
  assert.deepEqual(logged.filter(entry => entry.event === 'response'), [])
  assert.ok(logged.some(entry => entry.event === 'refused' && entry.host === '203.0.113.9' && entry.reason === "plain HTTP isn't allowed"))
})

test('sandbox: a timeout closes the VM, and leaves no QEMU and no temporary files', options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  const started = Date.now()
  const timeoutMs = sandbox.accel === 'kvm' ? 8000 : 30_000
  const result = await sandbox.run(sh(paths, 'echo started; sleep 600', { timeoutMs }))
  assert.deepEqual({ code: result.code, timedOut: result.timedOut, wroteTooMuch: result.wroteTooMuch, stdout: result.stdout }, { code: null, timedOut: true, wroteTooMuch: false, stdout: 'started\n' })
  assert.ok(Date.now() - started < timeoutMs + 10_000)
  const [pid] = qemuPids(prepared.entries)
  assert.equal(isAlive(pid), false)
  assert.deepEqual(fs.readdirSync(paths.runnerTmp), [])

  // A stop does the same.
  const stop = new AbortController()
  const running = sandbox.run(sh(paths, 'sleep 600'), { signal: stop.signal })
  await waitFor(() => qemuPids(prepared.entries).length === 2, 'the second VM')
  stop.abort()
  const stopped = await running
  assert.deepEqual({ code: stopped.code, timedOut: stopped.timedOut }, { code: null, timedOut: false })
  assert.equal(isAlive(qemuPids(prepared.entries)[1]), false)
  assert.deepEqual(fs.readdirSync(paths.runnerTmp), [])
})

test("sandbox: stopping the runner's process group leaves no QEMU behind", options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  // The holder's own sandbox needs the image and the build file in place, and a short runner/tmp.
  await openTestSandbox(t, prepared)
  const holder = spawn(process.execPath, [new URL('./support/sandbox-holder.mjs', import.meta.url).pathname, paths.dataDir, paths.configDir], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: process.env,
  })
  atEnd(t, () => {
    try {
      process.kill(-holder.pid, 'SIGKILL')
    } catch {}
  })
  let output = ''
  holder.stdout.on('data', chunk => (output += chunk))
  await waitFor(() => /^\d+\n/.test(output), 'the holder to start its VM', 120_000)
  const qemu = Number(output.trim())
  assert.ok(isAlive(qemu))
  process.kill(-holder.pid, 'SIGKILL')
  await waitFor(() => !isAlive(qemu), 'QEMU to end with its group', 10_000)
})

test('sandbox: a run that writes more, or makes more names, than a run may is stopped, and its VM closed', options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  t.after(overrideLimits({ RUN_WRITE_MAX_BYTES: 1024 * 1024, RUN_NAMES_MAX_COUNT: 40 }))
  const views = path.join(paths.agentDir('lifelog'), 'views')
  const memory = path.join(paths.agentDir('lifelog'), 'memory')

  // Within both, nothing is stopped.
  const within = await sandbox.run(sh(paths, `head -c 500000 /dev/zero > ${views}/a.bin; for i in $(seq 1 20); do : > ${memory}/f$i; done; echo done`))
  assert.deepEqual({ code: within.code, wroteTooMuch: within.wroteTooMuch, stdout: within.stdout }, { code: 0, wroteTooMuch: false, stdout: 'done\n' })

  for (const [what, script] of [
    ['bytes', `dd if=/dev/zero of=${views}/big.bin bs=65536 count=64 2>/dev/null; sleep 600`],
    ['files', `for i in $(seq 1 100); do : > ${memory}/g$i; done; sleep 600`],
    ['folders', `for i in $(seq 1 100); do mkdir ${views}/d$i; done; sleep 600`],
    ['links', `for i in $(seq 1 100); do ln -s x ${paths.agentRunSession('lifelog')}/l$i; done; sleep 600`],
  ]) {
    const result = await sandbox.run(sh(paths, script))
    assert.deepEqual({ code: result.code, wroteTooMuch: result.wroteTooMuch, timedOut: result.timedOut }, { code: null, wroteTooMuch: true, timedOut: false }, what)
  }
  // What got through stayed within the limits: the writes refused once they passed.
  assert.ok(fs.statSync(path.join(views, 'big.bin')).size <= 1024 * 1024)
  assert.ok(fs.readdirSync(memory).filter(name => name.startsWith('g')).length <= 40)
  assert.deepEqual(fs.readdirSync(paths.runnerTmp), [])
})

test('sandbox: it keeps the start of stdout and the end of stderr, and drops the rest', options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  t.after(overrideLimits({ SANDBOX_STDOUT_MAX_BYTES: 1000, SANDBOX_STDERR_MAX_BYTES: 500 }))
  const result = await sandbox.run(sh(paths, "head -c 5000 /dev/zero | tr '\\0' a; head -c 3000 /dev/zero | tr '\\0' b >&2; echo END >&2"))
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'a'.repeat(1000))
  assert.equal(result.stderr, `${'b'.repeat(496)}END\n`)
  const short = await sandbox.run(sh(paths, 'echo short'))
  assert.equal(short.stdout, 'short\n')
})

test("sandbox: a VM that doesn't start in time fails the run as one that couldn't run, and leaves nothing", options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  t.after(overrideLimits({ VM_START_TIMEOUT: 1 }))
  await assert.rejects(sandbox.run(sh(paths, 'true')), /^Error: the VM couldn't start/)
  await waitFor(() => fs.readdirSync(paths.runnerTmp).length === 0, 'the temporary folder to empty', 10_000)
  // The log says it never started, not that a program exited.
  assert.deepEqual(prepared.entries.filter(entry => entry.event === 'sandbox.vm_closed').map(entry => entry.ended), ['not_started'])

  // The run's own time running out first, as when it is no longer than the start limit, is the
  // same.
  const restore = overrideLimits({ VM_START_TIMEOUT: 600_000 })
  try {
    await assert.rejects(sandbox.run(sh(paths, 'true', { timeoutMs: 200 })), /^Error: the VM couldn't start: it didn't boot within the run's time/)
  } finally {
    restore()
  }
  await waitFor(() => fs.readdirSync(paths.runnerTmp).length === 0, 'the temporary folder to empty', 10_000)
})

test('sandbox: a VM lost under its program, as when its QEMU is killed, ends the run, and the log says so', options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  const running = sandbox.run(sh(paths, 'sleep 600'))
  await waitFor(() => qemuPids(prepared.entries).length === 1, 'the VM')
  await sleep(1000)
  process.kill(qemuPids(prepared.entries)[0], 'SIGKILL')
  const result = await running
  assert.deepEqual({ code: result.code, timedOut: result.timedOut, wroteTooMuch: result.wroteTooMuch }, { code: null, timedOut: false, wroteTooMuch: false })
  const lost = prepared.entries.filter(entry => entry.event === 'sandbox.vm_lost')
  assert.equal(lost.length, 1)
  t.diagnostic(`lost: ${JSON.stringify(lost[0])}`)
  assert.equal(typeof lost[0].error, 'string')
  assert.deepEqual(prepared.entries.filter(entry => entry.event === 'sandbox.vm_closed').map(entry => entry.ended), ['lost'])
  await waitFor(() => fs.readdirSync(paths.runnerTmp).length === 0, 'the temporary folder to empty', 10_000)
})

test("sandbox: opening it empties the runner's temporary folder, and gives the runner its home and temporary folder", options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  fs.mkdirSync(path.join(paths.runnerTmp, 'gondolin-left'), { recursive: true })
  fs.writeFileSync(path.join(paths.runnerTmp, 'gondolin-disk-1234.qcow2'), 'left by a runner that was killed')
  await openTestSandbox(t, prepared)
  assert.deepEqual(fs.readdirSync(paths.runnerTmp), [])
  assert.equal(process.env.HOME, paths.runnerHome)
  assert.equal(process.env.TMPDIR, paths.runnerTmp)
  assert.equal(process.env.XDG_CACHE_HOME, gondolinFolders(paths).cache)
  assert.equal(process.env.GONDOLIN_SESSIONS_DIR, path.join(paths.runnerTmp, 'sessions'))
})

test('sandbox: AGENT_ACCEL=emulation runs its VMs under emulation, and says so', options, async t => {
  const prepared = prepare(t, { agentAccel: 'emulation' })
  const sandbox = await openTestSandbox(t, prepared)
  assert.equal(sandbox.accel, 'emulation')
  const result = await sandbox.run(specOf(prepared.paths, ['pi', '--version']))
  assert.equal(result.stdout, '1.5.2\n')
  assert.deepEqual(
    prepared.entries.filter(entry => entry.event === 'sandbox.vm_started').map(entry => entry.accel),
    ['emulation'],
  )
})

// ---------------------------------------------------------------------------------------------
// The milestone's end to end

test('sandbox: one batch end to end through the real sandbox: pi reads a message, writes a view, and the runner commits it', options, async t => {
  const prepared = prepare(t)
  const { paths, settings, log, entries } = prepared
  // The runner's own folders start empty: it makes the agent's folder itself.
  fs.rmSync(paths.agents, { recursive: true })
  const dayLog = path.join(paths.datastore, '2026', '11', '09', 'log.jsonl')
  fs.rmSync(dayLog)
  writeDatastore(paths, [line.text(1, '2026-11-09T15:50:00Z', 'coffee 150 at Blue Tokai', { sourceId: '3EB0E2E0000000000001' })])

  const model = createFakeModel([
    { tool: 'read', args: { path: dayLog } },
    { tool: 'write', args: { path: 'views/expenses.csv', content: 'date,time,merchant,amount,currency,source\n2026-11-09,21:20,Blue Tokai,150,INR,#1\n' } },
    { tool: 'bash', args: { command: 'mark done 1' } },
    { text: 'Filed the coffee.' },
  ])
  const clock = systemClock
  const runner = await openRunner({
    settings: { ...settings, batchSeconds: 1 },
    clock,
    log,
    openSandbox: async options => openTestSandbox(t, { ...prepared, ...options, network: await fakeModelNetwork(t, model, options) }),
  })
  atEnd(t, () => runner.close())

  // The quiet period, then the run.
  let outcome
  for (let n = 0; n < 20 && outcome === undefined; n++) {
    outcome = (await runner.tick()).outcome
    if (outcome === undefined) await sleep(200)
  }
  assert.deepEqual(outcome, { ok: true, cause: null })

  // pi read the message's line in the datastore, which its VM sees read-only: the tool's result,
  // which the model got with the next request, holds what only the file has, its WhatsApp ID.
  const [first, second] = model.modelRequests
  assert.match(JSON.stringify(first.body), /New messages:\\n#1 [^"]* text: \\"coffee 150 at Blue Tokai\\"/)
  assert.match(JSON.stringify(second.body), /3EB0E2E0000000000001/)
  assert.doesNotMatch(JSON.stringify(first.body), /3EB0E2E0000000000001/)
  // The view, committed by Scooter with the batch's number.
  assert.equal(fs.readFileSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), 'expenses.csv'), 'utf8'), 'date,time,merchant,amount,currency,source\n2026-11-09,21:20,Blue Tokai,150,INR,#1\n')
  const git = (...args) => spawnText('git', args, { GIT_DIR: path.join(paths.agentDir('lifelog'), '.git'), GIT_WORK_TREE: paths.agentDir('lifelog') })
  assert.equal(await git('log', '-1', '--format=%an%n%s'), 'Scooter\nlifelog: #1\n')
  assert.equal(await git('status', '--porcelain'), '')
  // The state, from the mark, the ✅, and the session kept.
  const state = JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8'))
  assert.equal(state.cursor, 1)
  assert.deepEqual(state.retry, [])
  assert.equal(state.lastRun.ok, true)
  const outbox = fs.readdirSync(paths.outbox).sort().map(id => JSON.parse(fs.readFileSync(path.join(paths.outbox, id, 'entry.json'), 'utf8')))
  // Under emulation the runner's first start also told the owner its VMs fell back to it.
  const notices = runner.sandbox.accel === 'emulation' ? [{ type: 'text', by: 'runner', text: EMULATION_NOTICE }] : []
  assert.deepEqual(outbox, [...notices, { type: 'react', by: 'lifelog', target: 1, emoji: '✅', channels: ['whatsapp'] }])
  assert.equal(fs.readdirSync(paths.agentSessions('lifelog')).length, 1)
  // The VM is closed, and the request went to the fake model with the placeholder, not the key.
  assert.ok(entries.some(entry => entry.event === 'sandbox.vm_closed'))
  assert.ok(!JSON.stringify(model.requests.map(request => request.headers)).includes(KEY))
  // pi's own requests passed the policy, which asked for zero data retention in each, and the log
  // has each of them, with OpenRouter's answer.
  assert.equal(model.modelRequests.length, 4)
  for (const request of model.modelRequests) assert.deepEqual(request.body.provider, { zdr: true, data_collection: 'deny' })
  const logged = readNetworkLog(paths, { from: Date.now() - 600_000, to: Date.now() + 1000 }).entries
  assert.deepEqual(
    logged.map(entry => entry.event),
    Array(4).fill(['request', 'response', 'end']).flat(),
  )
  assert.deepEqual([...new Set(logged.filter(entry => entry.event === 'request').map(entry => `${entry.method} ${entry.host}${entry.path}`))], ['POST openrouter.ai/api/v1/messages'])
  assert.deepEqual([...new Set(logged.filter(entry => entry.event === 'response').map(entry => entry.status))], [200])
})

// The text of a recorded request's system prompt: a field of its own on the messages route, which
// is a string or a list of parts.
function systemPromptOf(request) {
  const { system } = request.body
  return typeof system === 'string' ? system : system.map(part => part.text ?? '').join('\n')
}

test("sandbox: the agent's instructions of config/ through the real sandbox: pi is given the prompt, the runner's skill and the five skills, reads two, finds show, send, mark and the zone rules that ship with the runner, files a message by them, says so with send and marks it with mark", options, async t => {
  const prepared = prepare(t)
  const { paths, settings, log } = prepared
  // The repository's own config folder, as `setup` copies it and Docker mounts it.
  fs.rmSync(paths.configDir, { recursive: true })
  fs.cpSync(new URL('../config', import.meta.url), paths.configDir, { recursive: true })
  fs.rmSync(paths.agents, { recursive: true })

  const skills = path.join(paths.agentRunConfig('lifelog'), 'skills')
  const header = 'date,time,merchant,description,amount,currency,category,payment,split,note,source'
  const runnerSkillCopy = path.join(paths.agentRunSkills('lifelog'), 'scooter', 'SKILL.md')
  const model = createFakeModel([
    { tool: 'read', args: { path: runnerSkillCopy } },
    { tool: 'read', args: { path: `${skills}/expenses/SKILL.md` } },
    { tool: 'bash', args: { command: 'command -v pdftotext pdftoppm heif-convert curl git node show send mark' } },
    { tool: 'bash', args: { command: 'node -p process.versions.tz; printenv ICU_TIMEZONE_FILES_DIR' } },
    { tool: 'write', args: { path: 'views/expenses.csv', content: `${header}\n2026-11-09,21:20,Blue Tokai,coffee,150,INR,Food & drink,,,,#1\n` } },
    { tool: 'bash', args: { command: "send <<'END'\nFiled the coffee at Blue Tokai: ₹150, \"Food & drink\".\nEND\nmark done 1" } },
    { text: 'Filed it.' },
  ])
  const runner = await openRunner({
    settings: { ...settings, batchSeconds: 1 },
    clock: systemClock,
    log,
    openSandbox: async options => openTestSandbox(t, { ...prepared, ...options, network: await fakeModelNetwork(t, model, options) }),
  })
  atEnd(t, () => runner.close())
  let outcome
  for (let n = 0; n < 20 && outcome === undefined; n++) {
    outcome = (await runner.tick()).outcome
    if (outcome === undefined) await sleep(200)
  }
  assert.deepEqual(outcome, { ok: true, cause: null })

  // The system prompt: pi's own, with the agent's prompt appended, as the config folder has it,
  // and pi's list of the skills: the runner's, at its copy in run/skills/, then the five, each at
  // its copy in run/config/, with the description its SKILL.md gives. No memory: the agent reads
  // its own.
  const [first, second, third, fourth, fifth, , seventh] = model.modelRequests
  const system = systemPromptOf(first)
  assert.ok(system.includes(fs.readFileSync(new URL('../config/prompts/lifelog.md', import.meta.url), 'utf8').trimEnd()))
  assert.ok(!system.includes('# Your memory'))
  const offered = [...system.matchAll(/<skill>\s*<name>(.*?)<\/name>\s*<description>(.*?)<\/description>\s*<location>(.*?)<\/location>/gs)]
  const runnerSkill = new URL('../src/runner/vm/skills/scooter/SKILL.md', import.meta.url)
  assert.deepEqual(offered.map(([, name, , location]) => [name, location]), [
    ['scooter', path.join(paths.agentRunSkills('lifelog'), 'scooter', 'SKILL.md')],
    ...['expenses', 'runs', 'meals', 'travel', 'people'].map(name => [name, `${skills}/${name}/SKILL.md`]),
  ])
  for (const [, name, description] of offered) {
    const file = name === 'scooter' ? runnerSkill : new URL(`../config/skills/${name}/SKILL.md`, import.meta.url)
    const own = /^description: (.*)$/m.exec(fs.readFileSync(file, 'utf8'))[1]
    assert.equal(description.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&'), own, name)
  }
  // pi read the skills from their copies; the programs the instructions name are in the image, and
  // `show`, `send` and `mark` are found in the run's copy, first on the PATH.
  assert.equal(toolResults(second.body)[0].text, fs.readFileSync(runnerSkill, 'utf8'))
  assert.equal(toolResults(third.body)[1].text, fs.readFileSync(new URL('../config/skills/expenses/SKILL.md', import.meta.url), 'utf8'))
  const found = toolResults(fourth.body)[2].text.trim().split('\n')
  assert.equal(found.length, 9, found.join('\n'))
  assert.deepEqual(found.slice(-3), ['show', 'send', 'mark'].map(program => path.join(paths.agentRunBin('lifelog'), program)))
  // What pi's bash tool runs gets the variable, and its Node converts with the rules it names, the
  // run's copy of those that ship with the runner.
  assert.equal(toolResults(fifth.body)[3].text, `${icuTzRelease()}\n${paths.agentRunIcuTz('lifelog')}\n`)
  // send and mark, from pi's bash tool, said what they did.
  assert.equal(toolResults(seventh.body)[5].text, 'send: queued; it goes to the owner once this run has passed\nmark: 1 marked done\n')

  // What pi wrote, committed; the message, and the ✅ from the mark; and what send and mark left,
  // cleared.
  const git = (...args) => spawnText('git', args, { GIT_DIR: path.join(paths.agentDir('lifelog'), '.git'), GIT_WORK_TREE: paths.agentDir('lifelog') })
  assert.equal(await git('log', '-1', '--format=%s', '--name-only'), 'lifelog: #1\n\nviews/expenses.csv\n')
  assert.equal(await git('status', '--porcelain'), '')
  const outbox = fs.readdirSync(paths.outbox).sort().map(id => JSON.parse(fs.readFileSync(path.join(paths.outbox, id, 'entry.json'), 'utf8')))
  assert.deepEqual(outbox.filter(entry => entry.by === 'lifelog'), [
    { type: 'text', by: 'lifelog', text: 'Filed the coffee at Blue Tokai: ₹150, "Food & drink".', about: 1, channels: ['whatsapp'] },
    { type: 'react', by: 'lifelog', target: 1, emoji: '✅', channels: ['whatsapp'] },
  ])
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8')).retry, [])
  assert.deepEqual(fs.readdirSync(paths.agentRunSend('lifelog')), [])
  assert.equal(fs.existsSync(paths.agentRunMarks('lifelog')), false)
})

test("sandbox: a rebuild's batch through the real sandbox: Now: is the message's own time, pi reads it and writes a view, and the rebuild commits it as one, sending nothing", options, async t => {
  const prepared = prepare(t)
  const { paths, settings, log } = prepared
  // The rebuild makes the agent's folder itself; the datastore holds one message of Sunday.
  fs.rmSync(paths.agents, { recursive: true })
  fs.rmSync(paths.datastore, { recursive: true })
  writeDatastore(paths, [line.text(1, '2026-11-08T05:00:00Z', 'coffee 120 at Blue Tokai', { sourceId: '3EB0E2E0000000000002' })])
  const sunday = path.join(paths.datastore, '2026', '11', '08', 'log.jsonl')
  const model = createFakeModel([
    { tool: 'read', args: { path: sunday } },
    { tool: 'write', args: { path: 'views/expenses.csv', content: 'date,time,merchant,amount,currency,source\n2026-11-08,10:30,Blue Tokai,120,INR,#1\n' } },
    { tool: 'bash', args: { command: "send 'Filed the coffee.'; mark done 1" } },
    { text: 'Filed it.' },
  ])
  const said = []
  const result = await rebuildAgent({
    settings,
    agentName: 'lifelog',
    clock: systemClock,
    log,
    say: text => said.push(text),
    openSandbox: async options => openTestSandbox(t, { ...prepared, ...options, network: await fakeModelNetwork(t, model, options) }),
  })
  assert.deepEqual({ ...result, tag: undefined }, { stopped: false, tag: undefined, until: 1, cursor: 1, batches: 1, failed: [] })
  assert.match(result.tag, /^before-rebuild-\d{8}T\d{6}Z$/)

  // The prompt has the message's own time, and pi read its line, which its VM sees read-only.
  const [first, second] = model.modelRequests
  assert.match(JSON.stringify(first.body), /\[scooter\] Now: Sunday 8 November 2026, 10:30 \(Asia\/Kolkata\)/)
  assert.match(JSON.stringify(first.body), /New messages:\\n#1 10:30 text: \\"coffee 120 at Blue Tokai\\"/)
  assert.match(JSON.stringify(second.body), /3EB0E2E0000000000002/)
  // One commit on the tagged one, the view in it, its session gone, and nothing sent: what the
  // batch queued with send is dropped.
  const git = (...args) => spawnText('git', args, { GIT_DIR: path.join(paths.agentDir('lifelog'), '.git'), GIT_WORK_TREE: paths.agentDir('lifelog') })
  assert.equal(await git('log', '--format=%s'), 'lifelog: rebuild\nlifelog: initial commit\n')
  assert.equal(await git('rev-parse', 'HEAD^'), await git('rev-parse', result.tag))
  assert.equal(fs.readFileSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), 'expenses.csv'), 'utf8'), 'date,time,merchant,amount,currency,source\n2026-11-08,10:30,Blue Tokai,120,INR,#1\n')
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
  assert.ok(!fs.existsSync(paths.outbox) || fs.readdirSync(paths.outbox).length === 0)
  const state = JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8'))
  assert.deepEqual([state.cursor, state.lastRun], [1, null])
  assert.equal(said.at(-1), 'Rebuilt lifelog up to #1, in 1 batch, committed as "lifelog: rebuild".')
})

test("sandbox: pi in a VM reaches OpenRouter through the policy, OpenRouter answers 401, and the runner takes it as a setup error", options, async t => {
  const prepared = prepare(t)
  const { paths, settings, log } = prepared
  fs.rmSync(paths.agents, { recursive: true })
  const model = createFakeModel([{ status: 401, message: 'User not found.' }])
  const runner = await openRunner({
    settings: { ...settings, batchSeconds: 1 },
    clock: systemClock,
    log,
    openSandbox: async options => openTestSandbox(t, { ...prepared, ...options, network: await fakeModelNetwork(t, model, options) }),
  })
  atEnd(t, () => runner.close())
  let outcome
  for (let n = 0; n < 20 && outcome === undefined; n++) {
    outcome = (await runner.tick()).outcome
    if (outcome === undefined) await sleep(200)
  }
  assert.deepEqual(outcome, { ok: false, cause: 'setup' })
  const state = JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8'))
  assert.equal(state.paused.cause, 'setup')
  assert.equal(state.paused.reason, 'OpenRouter: User not found.')
  assert.equal(state.retry[0].attempts, 0)
  const logged = readNetworkLog(paths, { from: Date.now() - 600_000, to: Date.now() + 1000 }).entries
  assert.deepEqual(logged.map(entry => entry.event), ['request', 'response', 'end'])
  assert.equal(logged[1].status, 401)
})

function spawnText(program, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env } })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`${program} exited with ${code}`))))
  })
}
