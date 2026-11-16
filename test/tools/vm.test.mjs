// What Gondolin and the VM image do, which the sandbox will rely on.
//
// These are the VM checks of milestone 0 in docs/plans/active/v2-linux-implementation.md, and
// docs/DECISIONS.md says what each one settled. They run the pinned Gondolin against an image
// built from config/image/build.json, so they are also what to run again after upgrading either.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createFakeModel } from '../support/fake-model.mjs'
import { pinnedPiVersion, readBuildFile } from '../support/image.mjs'
import { atEnd, makeTestDir } from '../support/tmp.mjs'
import {
  FUSE_MOUNT,
  GUEST_PATH,
  PI,
  SESSIONS_DIR,
  designMounts,
  makeDataDir,
  onPath,
  runIn,
  runPi,
  sh,
  startVm,
  vmSkipReason,
} from '../support/vm.mjs'

const options = { skip: vmSkipReason(), timeout: 300_000 }
const READ_ONLY = /Read-only file system/

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Whether a folder holds the disk overlay Gondolin makes for a running VM.
function hasDiskOverlay(dir) {
  return fs.readdirSync(dir).some(name => /^gondolin-disk-.*\.qcow2$/.test(name))
}

async function waitFor(condition, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

test('image: it holds Alpine, Node, pi and the tools the build file asks for', options, async t => {
  makeTestDir(t)
  const build = readBuildFile()
  const vm = await startVm(t)
  const output = async (argv, env = {}) => {
    const result = await runIn(vm, argv, { env: { PATH: GUEST_PATH, ...env } })
    assert.equal(result.exitCode, 0, `${argv.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
  }

  assert.equal(await output(['cat', '/etc/alpine-release']), build.alpine.version)

  const [major, minor] = (await output(['node', '--version'])).slice(1).split('.').map(Number)
  assert.ok(major > 22 || (major === 22 && minor >= 19), `Node ${major}.${minor} is older than 22.19`)

  // pi's version is pinned in the build file's install command. The image's own record of it is
  // pi's package.json, which can be read without running pi.
  const packageJson = '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json'
  const installed = JSON.parse(await vm.fs.readFile(packageJson, { encoding: 'utf-8' }))
  assert.equal(installed.version, pinnedPiVersion())
  assert.equal(await output([PI, '--version']), pinnedPiVersion())

  for (const [program, flag] of [
    ['pdftotext', '-v'],
    ['heif-convert', '--version'],
    ['git', '--version'],
    ['rg', '--version'],
    ['fd', '--version'],
    ['curl', '--version'],
    ['bash', '--version'],
  ]) {
    await output([program, flag])
  }

  assert.equal(await output(['git', 'config', '--system', '--get-all', 'safe.directory']), '*')

  // pi runs with TZ set to the owner's time zone. Without the zone files, the C library falls
  // back to UTC and says nothing.
  assert.equal(await output(['date', '+%Z %z'], { TZ: 'Asia/Kolkata' }), 'IST +0530')
  assert.equal(await output(['node', '-p', 'new Date(0).getTimezoneOffset()'], { TZ: 'Asia/Kolkata' }), '-330')
})

test("VM 1: mounts sit at the host's own paths, read-only except the three writable folders", options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const { agent, datastore } = data
  // Things on the host that pi must not see.
  fs.mkdirSync(path.join(dir, 'data', 'exchange', 'outbox'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside the data folder\n')
  // An older session, kept by the runner.
  fs.writeFileSync(`${agent}/sessions/lifelog-2026-11-08.jsonl`, '{"type":"session"}\n')
  const vm = await startVm(t, { mounts: designMounts(data) })

  // Reading works everywhere under the two mounts, at the same paths as on the host.
  for (const file of [`${agent}/memory/preferences.md`, `${datastore}/2026/11/09/log.jsonl`, `${data.skill}/SKILL.md`]) {
    assert.equal((await sh(vm, `cat ${file}`)).stdout, fs.readFileSync(file, 'utf8'))
  }

  // That goes for all of the agent's folder: its state and its older sessions too.
  assert.equal((await sh(vm, `cat ${agent}/state.json`)).stdout, '{"cursor":1049}\n')
  assert.equal((await sh(vm, `cat ${agent}/sessions/lifelog-2026-11-08.jsonl`)).stdout, '{"type":"session"}\n')

  // Nothing else from the host is there.
  assert.equal((await sh(vm, `ls ${dir}/data`)).stdout, 'agents\ndatastore\n')
  assert.equal((await sh(vm, `ls ${dir}`)).stdout, 'data\n')

  // The agent's folder and the datastore refuse every kind of change.
  for (const command of [
    `echo x > ${agent}/new.txt`,
    `echo x > ${agent}/state.json`,
    `echo x > ${agent}/run/new.txt`,
    `echo x > ${agent}/run/system.md`,
    `echo x > ${agent}/run/config/skills/expenses/SKILL.md`,
    `echo x > ${agent}/sessions/lifelog-2026-11-10.jsonl`,
    `rm ${agent}/state.json`,
    `mkdir ${agent}/new`,
    `chmod 777 ${agent}/state.json`,
    `echo x > ${datastore}/new.txt`,
    `echo x >> ${datastore}/2026/11/09/log.jsonl`,
    `rm ${datastore}/2026/11/09/log.jsonl`,
  ]) {
    const result = await sh(vm, command)
    assert.notEqual(result.exitCode, 0, `${command} should fail`)
    assert.match(result.stderr, READ_ONLY, command)
  }
  assert.equal(fs.readFileSync(`${agent}/state.json`, 'utf8'), '{"cursor":1049}\n')
  assert.deepEqual(fs.readdirSync(agent).sort(), ['memory', 'run', 'sessions', 'state.json', 'views'])
  assert.deepEqual(fs.readdirSync(`${agent}/sessions`), ['lifelog-2026-11-08.jsonl'])
  assert.deepEqual(fs.readdirSync(datastore), ['2026'])

  // The three writable folders take files, and the host sees them at once. One of the three is
  // two levels down, inside the read-only `run/`.
  const writable = [
    'views/expenses.csv',
    'views/days/2026/11/2026-11-09.md',
    'memory/needs-review.md',
    'run/session/lifelog-2026-11-09.jsonl',
  ]
  for (const file of writable) {
    const result = await sh(vm, `mkdir -p "$(dirname ${agent}/${file})" && echo written in the VM > ${agent}/${file}`)
    assert.equal(result.exitCode, 0, `${file}: ${result.stderr}`)
    assert.equal(fs.readFileSync(`${agent}/${file}`, 'utf8'), 'written in the VM\n')
  }

  // Gondolin shows every mount under its own mount point too, with the same protection.
  assert.equal((await sh(vm, `cat ${FUSE_MOUNT}${agent}/state.json`)).stdout, '{"cursor":1049}\n')
  assert.match((await sh(vm, `echo x > ${FUSE_MOUNT}${agent}/state.json`)).stderr, READ_ONLY)

  // The mount point was moved, so nothing of Gondolin's is at /data.
  assert.notEqual((await sh(vm, 'ls /data')).exitCode, 0)
})

test('VM 1: a folder inside a mount can be hidden from the VM', options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const { agent } = data
  fs.writeFileSync(`${agent}/sessions/lifelog-2026-11-08.jsonl`, '{"type":"session"}\n')
  const mounts = designMounts(data)
  mounts[agent].hide = ['/sessions']
  const vm = await startVm(t, { mounts })

  // The folder is not there, at either of the two paths the mount has, and the rest is.
  assert.equal((await sh(vm, `ls ${agent}`)).stdout, 'memory\nrun\nstate.json\nviews\n')
  for (const root of [agent, `${FUSE_MOUNT}${agent}`]) {
    const read = await sh(vm, `cat ${root}/sessions/lifelog-2026-11-08.jsonl`)
    assert.notEqual(read.exitCode, 0)
    assert.match(read.stderr, /No such file or directory/)
  }
  assert.equal((await sh(vm, `cat ${agent}/views/../sessions/lifelog-2026-11-08.jsonl`)).stdout, '')
  // It can't be made anew either, to stand in for the hidden one.
  assert.match((await sh(vm, `mkdir ${agent}/sessions`)).stderr, READ_ONLY)
  assert.deepEqual(fs.readdirSync(`${agent}/sessions`), ['lifelog-2026-11-08.jsonl'])
})

test('VM 1: the same mounts work under /data, as in Docker, once the mount point is moved', options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const guest = { agent: '/data/agents/lifelog', datastore: '/data/datastore' }
  const vm = await startVm(t, { mounts: designMounts(data, guest) })

  assert.equal((await sh(vm, 'ls /data')).stdout, 'agents\ndatastore\n')
  const log = fs.readFileSync(`${data.day}/log.jsonl`, 'utf8')
  assert.equal((await sh(vm, 'cat /data/datastore/2026/11/09/log.jsonl')).stdout, log)
  assert.match((await sh(vm, 'echo x > /data/agents/lifelog/state.json')).stderr, READ_ONLY)
  assert.match((await sh(vm, 'echo x > /data/datastore/new.txt')).stderr, READ_ONLY)
  for (const folder of ['views', 'memory', 'run/session']) {
    assert.equal((await sh(vm, `echo ok > /data/agents/lifelog/${folder}/a.txt`)).exitCode, 0)
    assert.equal(fs.readFileSync(`${data.agent}/${folder}/a.txt`, 'utf8'), 'ok\n')
  }
})

test("VM 1: with Gondolin's default mount point, mounts under /data keep the VM from starting", options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const guest = { agent: '/data/agents/lifelog', datastore: '/data/datastore' }
  // A healthy VM is ready in about 2 seconds with KVM and about 7 under emulation.
  const start = startVm(t, { mounts: designMounts(data, guest), fuseMount: null, startTimeoutMs: 45_000 })
  await assert.rejects(start, /startup timed out/)
})

test('VM 2: a command runs from an argument list, in a given folder, with no shell in between', options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const vm = await startVm(t, { mounts: designMounts(data) })
  // A program that reports what it was started with.
  const report = 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), env: process.env }))'
  const echo = ['/usr/bin/node', '-e', report, '--']
  const prompts = [
    'plain',
    'two words',
    '',
    '$(touch /tmp/canary-1)',
    '`touch /tmp/canary-2`',
    '; touch /tmp/canary-3 ;',
    '\'single\' "double" \\backslash',
    'line one\nline two\ttab',
    '- starts with a dash',
    '--looks-like-a-flag',
    '₹450 ☕ ✅ नमस्ते',
    '*',
    '~',
    '$HOME',
  ]

  // Gondolin's own way: an argument list and a working folder.
  const direct = await vm.exec([...echo, ...prompts], { cwd: data.agent })
  assert.equal(direct.exitCode, 0, direct.stderr)
  const seen = JSON.parse(direct.stdout)
  assert.deepEqual(seen.argv, prompts)
  assert.equal(seen.cwd, data.agent)

  // Left alone, the VM gives a command these variables. None comes from the host's environment.
  assert.deepEqual(Object.keys(seen.env).sort(), [
    'CURL_CA_BUNDLE',
    'HOME',
    'NODE_EXTRA_CA_CERTS',
    'PATH',
    'PWD',
    'REQUESTS_CA_BUNDLE',
    'SHLVL',
    'SSL_CERT_FILE',
    'TERM',
    'TMPDIR',
    'UV_SYSTEM_CERTS',
  ])
  // Its PATH leaves out /usr/local/bin, where pi is.
  assert.equal(seen.env.PATH, '/usr/sbin:/usr/bin:/sbin:/bin')

  // Variables passed with the command are added to those, not put in their place.
  const added = JSON.parse((await vm.exec(echo, { env: { TZ: 'Asia/Kolkata' } })).stdout)
  assert.equal(added.env.TZ, 'Asia/Kolkata')
  assert.ok('NODE_EXTRA_CA_CERTS' in added.env)

  // Through `env -i` the command gets exactly the variables given, and the arguments still arrive
  // untouched.
  const exact = await runIn(vm, [...echo, ...prompts], { cwd: data.agent, env: { PATH: GUEST_PATH, TZ: 'Asia/Kolkata' } })
  assert.equal(exact.exitCode, 0, exact.stderr)
  const exactSeen = JSON.parse(exact.stdout)
  assert.deepEqual(exactSeen.argv, prompts)
  assert.equal(exactSeen.cwd, data.agent)
  assert.deepEqual(Object.keys(exactSeen.env).sort(), ['PATH', 'TZ'])

  // No shell read the arguments.
  assert.equal((await sh(vm, 'ls /tmp | grep -c canary')).stdout.trim(), '0')

  // What failures look like: a missing folder and a missing program both end with 127.
  const noFolder = await vm.exec(['/bin/pwd'], { cwd: '/no/such/folder' })
  assert.equal(noFolder.exitCode, 127)
  const noProgram = await vm.exec(['/no/such/program'])
  assert.equal(noProgram.exitCode, 127)
  assert.equal(noProgram.stderr, 'exec failed\n')
})

test('VM 3: closing the VM while pi runs ends the run and leaves no QEMU and no temporary files', options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const started = path.join(data.agent, 'views', 'started')
  const model = createFakeModel([
    { tool: 'bash', args: { command: `echo started > ${started}; sleep 600` } },
    { text: 'never reached' },
  ])
  const vm = await startVm(t, { model, mounts: designMounts(data) })
  const qemu = vm.getHostPid()
  assert.ok(isAlive(qemu))
  // While it runs, the VM keeps a disk overlay and five sockets in the temporary folder, and a
  // session entry in Gondolin's cache folder.
  assert.ok(hasDiskOverlay(process.env.TMPDIR))
  assert.ok(fs.readdirSync(SESSIONS_DIR).length > 0)

  const session = { dir: data.session, id: 'lifelog-2026-11-09' }
  const run = runPi(vm, { prompt: 'take your time', session }, { cwd: data.agent })
  const outcome = run.then(
    result => ({ result }),
    error => ({ error }),
  )
  await waitFor(() => fs.existsSync(started), "pi's bash tool to start")

  const before = Date.now()
  await vm.close()
  assert.ok(Date.now() - before < 15_000, 'closing took too long')

  // The run does not end with an exit code: the promise for it is rejected.
  const { result, error } = await outcome
  assert.equal(result, undefined)
  assert.ok(error instanceof Error)

  await waitFor(() => !isAlive(qemu), 'QEMU to exit', 15_000)
  assert.deepEqual(fs.readdirSync(process.env.TMPDIR), [])
  assert.deepEqual(fs.readdirSync(SESSIONS_DIR), [])

  // pi had already written its session file. The runner copies nothing back after a failed run.
  assert.equal(fs.readdirSync(data.session).length, 1)
})

test("VM 4: killing the starting process's group leaves no QEMU; killing the process alone leaves one", options, async t => {
  const dir = makeTestDir(t)
  const holder = new URL('../support/vm-holder.mjs', import.meta.url).pathname

  // Starts a VM from a process in a group of its own, as a service manager starts the runner.
  async function startHolder(name) {
    const tmp = path.join(dir, name)
    fs.mkdirSync(tmp)
    const child = spawn(process.execPath, [holder], {
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, TMPDIR: tmp, XDG_CACHE_HOME: path.join(dir, `${name}-cache`) },
    })
    const exited = new Promise(resolve => child.once('exit', resolve))
    const line = await new Promise((resolve, reject) => {
      child.stdout.once('data', chunk => resolve(String(chunk)))
      child.once('exit', () => reject(new Error('the VM holder exited before starting its VM')))
    })
    const qemu = Number(line)
    atEnd(t, () => {
      for (const pid of [-child.pid, qemu]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    })
    return { child, qemu, tmp, exited }
  }

  for (const signal of ['SIGKILL', 'SIGTERM']) {
    // Only the starting process: QEMU lives on, with nothing left to talk to.
    const alone = await startHolder(`alone-${signal}`)
    process.kill(alone.child.pid, signal)
    await alone.exited
    await sleep(2000)
    assert.ok(isAlive(alone.qemu), `QEMU should outlive its starter after ${signal}`)
    // It is still in the dead process's group, so the group can be stopped afterwards.
    process.kill(-alone.child.pid, 'SIGKILL')
    await waitFor(() => !isAlive(alone.qemu), 'the orphaned QEMU to exit', 15_000)

    // The whole group: QEMU goes with it.
    const group = await startHolder(`group-${signal}`)
    process.kill(-group.child.pid, signal)
    await group.exited
    await waitFor(() => !isAlive(group.qemu), `QEMU to exit after ${signal} to the group`, 15_000)

    // Either way the VM's files stay behind in the temporary folder, for the next start to sweep.
    for (const { tmp } of [alone, group]) {
      assert.ok(hasDiskOverlay(tmp), 'the disk overlay should be left behind')
    }
  }
})

const needsGit = { ...options, skip: options.skip || (onPath('git') ? false : 'git is not installed') }

test('VM 5: git log works on the read-only agent folder', needsGit, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  // The agent's folder as the runner makes it (section 6.2).
  const identity = ['-c', 'user.name=Scooter', '-c', 'user.email=scooter@localhost']
  const git = (...args) => execFileSync('git', ['-C', data.agent, ...identity, ...args], { encoding: 'utf8' })
  fs.writeFileSync(path.join(data.agent, '.gitignore'), '/sessions/\n/run/\n/state.json\n')
  git('init', '--quiet', '--initial-branch=main')
  git('add', '--all')
  git('commit', '--quiet', '--no-gpg-sign', '--message', 'lifelog: #1040')
  const head = git('rev-parse', 'HEAD').trim()

  const vm = await startVm(t, { mounts: designMounts(data) })
  const inAgent = (argv, env = {}) => runIn(vm, argv, { cwd: data.agent, env: { PATH: GUEST_PATH, HOME: '/root', ...env } })

  const log = await inAgent(['git', 'log', '--format=%H %an <%ae> %s'])
  assert.equal(log.exitCode, 0, log.stderr)
  assert.equal(log.stdout, `${head} Scooter <scooter@localhost> lifelog: #1040\n`)

  // A change pi makes shows up in git's view of the folder, and git can't record it.
  fs.appendFileSync(path.join(data.agent, 'memory', 'preferences.md'), '- 2026-11-09 (#1050): Track tea.\n')
  const status = await inAgent(['git', 'status', '--short'])
  assert.equal(status.exitCode, 0, status.stderr)
  assert.equal(status.stdout, ' M memory/preferences.md\n')
  const commit = await inAgent(['git', 'commit', '--all', '--message', 'from inside the VM'])
  assert.notEqual(commit.exitCode, 0)
  assert.equal(git('rev-parse', 'HEAD').trim(), head)

  // The files belong to the runner's user and the VM runs as root, so git only reads the
  // repository because the image marks every folder as safe.
  const refused = await inAgent(['git', 'log', '--oneline'], { GIT_CONFIG_NOSYSTEM: '1' })
  assert.notEqual(refused.exitCode, 0)
  assert.match(refused.stderr, /dubious ownership/)
})
