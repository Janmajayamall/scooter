// The real sandbox (section 10 of DESIGN.md, "Sandbox"; 6.6, 6.12): a Gondolin VM for each run,
// booted from the built image, with the mounts, the environment, the network and the limits of
// `src/runner/sandbox/gondolin.mjs`. And the milestone's end to end: one batch through the real
// sandbox, with the scripted fake model in place of OpenRouter.
//
// These need QEMU, `SCOOTER_TEST_IMAGE` and `debugfs`, and skip themselves without them. With KVM
// (`sg kvm -c 'npm test'` on the plan's machine) they take about a minute; under emulation, several.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { systemClock } from '../src/common/time.mjs'
import { openRunner } from '../src/runner/main.mjs'
import { EMULATION_NOTICE } from '../src/runner/status.mjs'
import { piMounts } from '../src/runner/run.mjs'
import { kvmProblem } from '../src/runner/sandbox/accel.mjs'
import { FUSE_MOUNT, gondolinFolders } from '../src/runner/sandbox/gondolin.mjs'
import { GUEST_HOME, GUEST_PATH } from '../src/runner/sandbox/index.mjs'
import { createFakeModel } from './support/fake-model.mjs'
import { createTestLog } from './support/log.mjs'
import { line, writeConfig, writeDatastore } from './support/runner.mjs'
import { fakeModelNetwork, openTestSandbox, sandboxSkipReason } from './support/sandbox.mjs'
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
  for (const folder of ['views', 'memory', 'sessions', 'run/session']) fs.mkdirSync(path.join(agent, folder), { recursive: true })
  fs.writeFileSync(path.join(agent, 'state.json'), '{}\n')
  fs.writeFileSync(path.join(agent, 'sessions', 'lifelog-2026-11-08.jsonl'), '{"type":"session"}\n')
  fs.writeFileSync(path.join(agent, 'views', 'expenses.csv'), 'date,amount\n')
  fs.mkdirSync(paths.datastore, { recursive: true })
  writeDatastore(paths, [line.text(1, '2026-11-09T15:50:00Z', 'coffee 150')])
  const { log, entries } = createTestLog()
  return { root, paths, settings: config, log, entries, clock: systemClock }
}

// A spec for a command, with the mounts of 6.6 and the environment of `env`.
function specOf(paths, argv, { env = {}, timeoutMs = 120_000, cwd = paths.agentDir('lifelog'), mounts = piMounts(paths, 'lifelog') } = {}) {
  return {
    argv,
    cwd,
    env: { PATH: GUEST_PATH, HOME: GUEST_HOME, LANG: 'C.UTF-8', TZ: 'Asia/Kolkata', ...env },
    mounts,
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
  assert.deepEqual({ ...result, signal: undefined }, { code: 0, signal: undefined, stdout: '1.5.2\n', stderr: '', stdoutCut: false, timedOut: false, wroteTooMuch: false })

  // The fastest of three boots.
  for (let n = 0; n < 2; n++) assert.equal((await sandbox.run(specOf(prepared.paths, ['/bin/true']))).code, 0)
  const boots = prepared.entries.filter(entry => entry.event === 'sandbox.vm_started').map(entry => entry.ms)
  t.diagnostic(`boot with ${sandbox.accel}: ${boots.join(', ')} ms`)
  if (sandbox.accel === 'kvm') assert.ok(Math.min(...boots) < 3000, `the fastest boot took ${Math.min(...boots)} ms`)
  // Every VM is closed: no QEMU is left, and nothing in the temporary folder.
  for (const pid of qemuPids(prepared.entries)) assert.equal(isAlive(pid), false)
  assert.deepEqual(fs.readdirSync(prepared.paths.runnerTmp), [])
})

test("sandbox: the mounts: at the host's paths, read-only but for views, memory and run/session, with sessions/ not there, even through a link", options, async t => {
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
    try sh -c 'echo x > ${agent}/run/system.md'
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
  expect(`sh -c echo x > ${agent}/run/system.md`, 'refused')
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
    ['until milestone 8, no host at all', undefined],
    ['with the fake model at OpenRouter', fakeModelNetwork(createFakeModel([{ text: 'DONE' }]))],
  ]) {
    await t.test(name, async () => {
      hits.length = 0
      datagrams.length = 0
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

      // The environment: exactly the spec's, and the key's placeholder, which isn't the key.
      const env = Object.fromEntries(lines.filter(entry => /^[A-Z_]+=/.test(entry)).map(entry => entry.split(/=(.*)/s).slice(0, 2)))
      assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'OPENROUTER_API_KEY', 'PATH', 'PWD', 'SHLVL', 'TZ'].sort())
      assert.notEqual(env.OPENROUTER_API_KEY, KEY)
      assert.ok(!result.stdout.includes(KEY))
      assert.ok(env.OPENROUTER_API_KEY.length > 20)
    })
  }
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
  const views = paths.agentViews('lifelog')
  const memory = paths.agentMemory('lifelog')

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

test('sandbox: it keeps the start of stdout and the end of stderr, and says when stdout was cut', options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  t.after(overrideLimits({ SANDBOX_STDOUT_MAX_BYTES: 1000, SANDBOX_STDERR_MAX_BYTES: 500 }))
  const result = await sandbox.run(sh(paths, "head -c 5000 /dev/zero | tr '\\0' a; head -c 3000 /dev/zero | tr '\\0' b >&2; echo END >&2"))
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'a'.repeat(1000))
  assert.equal(result.stdoutCut, true)
  assert.equal(result.stderr, `${'b'.repeat(496)}END\n`)
  const short = await sandbox.run(sh(paths, 'echo answer'))
  assert.deepEqual({ stdout: short.stdout, stdoutCut: short.stdoutCut }, { stdout: 'answer\n', stdoutCut: false })
})

test("sandbox: a VM that doesn't start in time fails the run as one that couldn't run, and leaves nothing", options, async t => {
  const prepared = prepare(t)
  const { paths } = prepared
  const sandbox = await openTestSandbox(t, prepared)
  t.after(overrideLimits({ VM_START_TIMEOUT: 1 }))
  await assert.rejects(sandbox.run(sh(paths, 'true')), /^Error: the VM couldn't start/)
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
    { text: 'NO_REPLY\nDONE: 1' },
  ])
  const clock = systemClock
  const runner = await openRunner({
    settings: { ...settings, batchSeconds: 1 },
    clock,
    log,
    openSandbox: options => openTestSandbox(t, { ...prepared, ...options, network: fakeModelNetwork(model) }),
  })
  atEnd(t, () => runner.close())

  // The quiet period, then the run.
  let outcome
  for (let n = 0; n < 20 && outcome === undefined; n++) {
    outcome = (await runner.tick()).outcome
    if (outcome === undefined) await sleep(200)
  }
  assert.deepEqual(outcome, { ok: true, cause: null })

  // pi read the message's line in the datastore, through its read-only mount: the tool's result,
  // which the model got with the next request, holds what only the file has, its WhatsApp ID.
  const [first, second] = model.modelRequests
  assert.match(JSON.stringify(first.body), /New messages:\\n#1 [^"]* text: \\"coffee 150 at Blue Tokai\\"/)
  assert.match(JSON.stringify(second.body), /3EB0E2E0000000000001/)
  assert.doesNotMatch(JSON.stringify(first.body), /3EB0E2E0000000000001/)
  // The view, committed by Scooter with the batch's number.
  assert.equal(fs.readFileSync(path.join(paths.agentViews('lifelog'), 'expenses.csv'), 'utf8'), 'date,time,merchant,amount,currency,source\n2026-11-09,21:20,Blue Tokai,150,INR,#1\n')
  const git = (...args) => spawnText('git', args, { GIT_DIR: path.join(paths.agentDir('lifelog'), '.git'), GIT_WORK_TREE: paths.agentDir('lifelog') })
  assert.equal(await git('log', '-1', '--format=%an%n%s'), 'Scooter\nlifelog: #1\n')
  assert.equal(await git('status', '--porcelain'), '')
  // The state, the ✅, and the session kept.
  const state = JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8'))
  assert.equal(state.cursor, 1)
  assert.equal(state.lastRun.ok, true)
  const outbox = fs.readdirSync(paths.outbox).sort().map(id => JSON.parse(fs.readFileSync(path.join(paths.outbox, id, 'entry.json'), 'utf8')))
  // Under emulation the runner's first start also told the owner its VMs fell back to it (6.6).
  const notices = runner.sandbox.accel === 'emulation' ? [{ type: 'text', by: 'runner', text: EMULATION_NOTICE }] : []
  assert.deepEqual(outbox, [...notices, { type: 'react', by: 'lifelog', target: 1, emoji: '✅' }])
  assert.equal(fs.readdirSync(paths.agentSessions('lifelog')).length, 1)
  // The VM is closed, and the request went to the fake model with the placeholder, not the key.
  assert.ok(entries.some(entry => entry.event === 'sandbox.vm_closed'))
  assert.ok(!JSON.stringify(model.requests.map(request => request.headers)).includes(KEY))
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
