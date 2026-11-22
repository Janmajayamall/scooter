// What Gondolin and the VM image do, which the sandbox will rely on.
//
// These are the VM checks of milestone 0 in docs/plans/completed/v2-linux-implementation/v2-linux-implementation.md, and
// `docs/architecture/sandbox.md` gives the facts they found. They run the pinned Gondolin against an image
// built from config/image/build.json, so they are also what to run again after upgrading either.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makePaths } from '../../src/common/paths.mjs'
import { icuTzRelease, prepareRun } from '../../src/runner/agentdir.mjs'
import { readMarks, readSends } from '../../src/runner/report.mjs'
import { openDatastore } from '../../src/runner/datastore.mjs'
import { piEnv as runnerPiEnv, piFiles } from '../../src/runner/run.mjs'
import { createFakeModel } from '../support/fake-model.mjs'
import { headerTimes } from '../support/icu-tz.mjs'
import { pinnedPiVersion, readBuildFile } from '../support/image.mjs'
import { fillerLines, line, writeDatastore } from '../support/runner.mjs'
import { atEnd, makeTestDir } from '../support/tmp.mjs'
import {
  FUSE_MOUNT,
  GUEST_PATH,
  PI,
  SESSIONS_DIR,
  designFiles,
  makeDataDir,
  onPath,
  piEnv,
  runIn,
  runPi,
  sh,
  startVm,
  toolResults,
  vmSkipReason,
} from '../support/vm.mjs'

const options = { skip: vmSkipReason(), timeout: 300_000 }
const READ_ONLY = /Read-only file system/
const NOT_THERE = /No such file or directory/

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

test("VM 1: what a run sees sits at the host's own paths, read-only except what writes names and run/session", options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const { agent, datastore } = data
  // Things on the host that pi must not see.
  fs.mkdirSync(path.join(dir, 'data', 'exchange', 'outbox'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside the data folder\n')
  // An older session, kept by the runner.
  fs.writeFileSync(`${agent}/sessions/lifelog-2026-11-08.jsonl`, '{"type":"session"}\n')
  const vm = await startVm(t, { files: designFiles(data) })

  // Reading works in what reads names, at the same paths as on the host.
  for (const file of [`${agent}/memory/preferences.md`, `${datastore}/2026/11/09/log.jsonl`, `${data.skill}/SKILL.md`]) {
    assert.equal((await sh(vm, `cat ${file}`)).stdout, fs.readFileSync(file, 'utf8'))
  }

  // That goes for the runner's state too. Of the agent's folder only `sessions/` is missing: the
  // run hides it, and the next test says how well.
  assert.equal((await sh(vm, `cat ${agent}/state.json`)).stdout, '{"cursor":1049}\n')
  assert.equal((await sh(vm, `ls ${agent}`)).stdout, 'memory\nrun\nstate.json\nviews\n')

  // Nothing else from the host is there, and a link made in a writable folder doesn't bring it in:
  // the VM follows links itself, inside its own file system.
  assert.equal((await sh(vm, `ls ${dir}/data`)).stdout, 'agents\ndatastore\n')
  assert.equal((await sh(vm, `ls ${dir}`)).stdout, 'data\n')
  const linked = await sh(vm, `ln -s ${dir}/outside.txt ${agent}/views/outside && cat ${agent}/views/outside`)
  assert.notEqual(linked.exitCode, 0)
  assert.equal(linked.stdout, '')
  assert.match(linked.stderr, NOT_THERE)
  assert.equal(fs.readlinkSync(`${agent}/views/outside`), `${dir}/outside.txt`)
  fs.unlinkSync(`${agent}/views/outside`)

  // The agent's folder and the datastore refuse every kind of change.
  for (const command of [
    `echo x > ${agent}/new.txt`,
    `echo x > ${agent}/state.json`,
    `echo x > ${agent}/run/new.txt`,
    `echo x > ${agent}/run/config/prompts/lifelog.md`,
    `echo x > ${agent}/run/config/skills/expenses/SKILL.md`,
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

  // The three folders the run may change take files, and the host sees them at once. One of the
  // three is two levels down, inside the read-only `run/`.
  const writable = [
    'views/expenses.csv',
    'views/books/2026/11/dune.md',
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

test('VM 1: sessions/ is hidden from the VM, which could read it otherwise', options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const { agent } = data
  // An older session, kept by the runner.
  const name = 'lifelog-2026-11-08.jsonl'
  fs.writeFileSync(`${agent}/sessions/${name}`, '{"type":"session"}\n')

  // The agent's folder, shown read-only, shows all of it, the older sessions included. That is why
  // a run hides the folder.
  const open = await startVm(t, { files: { ...designFiles(data), hide: [] } })
  assert.equal((await sh(open, `ls ${agent}`)).stdout, 'memory\nrun\nsessions\nstate.json\nviews\n')
  assert.equal((await sh(open, `cat ${agent}/sessions/${name}`)).stdout, '{"type":"session"}\n')
  assert.match((await sh(open, `echo x > ${agent}/sessions/lifelog-2026-11-10.jsonl`)).stderr, READ_ONLY)
  await open.close()

  // As a run has it, the folder is not there, at either of the two paths the mount has, and the
  // rest is.
  const vm = await startVm(t, { files: designFiles(data) })
  assert.equal((await sh(vm, `ls ${agent}`)).stdout, 'memory\nrun\nstate.json\nviews\n')
  assert.equal((await sh(vm, `find ${agent} -name '*.jsonl'`)).stdout, '')
  for (const root of [agent, `${FUSE_MOUNT}${agent}`]) {
    const read = await sh(vm, `cat ${root}/sessions/${name}`)
    assert.notEqual(read.exitCode, 0)
    assert.match(read.stderr, NOT_THERE)
  }

  // No way round leads to it either. The VM follows a link itself, so a link made in a writable
  // folder ends at the same missing path, whether it names the folder from beside it or in full.
  for (const command of [
    `cat ${agent}/views/../sessions/${name}`,
    `ln -s ../sessions ${agent}/views/beside && cat ${agent}/views/beside/${name}`,
    `ln -s ${agent}/sessions ${agent}/memory/in-full && cat ${agent}/memory/in-full/${name}`,
    `ln -s ../../sessions/${name} ${agent}/run/session/one-file && cat ${agent}/run/session/one-file`,
    `ln ${agent}/sessions/${name} ${agent}/views/hard-link`,
  ]) {
    const result = await sh(vm, command)
    assert.notEqual(result.exitCode, 0, command)
    assert.equal(result.stdout, '', command)
    assert.match(result.stderr, NOT_THERE, command)
  }

  // It can't be made anew, to stand in for the hidden one, and nothing can be put into it.
  assert.match((await sh(vm, `mkdir ${agent}/sessions`)).stderr, READ_ONLY)
  assert.notEqual((await sh(vm, `echo x > ${agent}/sessions/lifelog-2026-11-10.jsonl`)).exitCode, 0)
  assert.deepEqual(fs.readdirSync(`${agent}/sessions`), [name])
  assert.equal(fs.readFileSync(`${agent}/sessions/${name}`, 'utf8'), '{"type":"session"}\n')
})

test('VM 1: the same works with the data folder at /data, as in Docker, once the mount point is moved', options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const vm = await startVm(t, { files: designFiles(data), at: '/data' })

  assert.equal((await sh(vm, 'ls /data')).stdout, 'agents\ndatastore\n')
  assert.equal((await sh(vm, 'ls /data/agents/lifelog')).stdout, 'memory\nrun\nstate.json\nviews\n')
  const log = fs.readFileSync(`${data.day}/log.jsonl`, 'utf8')
  assert.equal((await sh(vm, 'cat /data/datastore/2026/11/09/log.jsonl')).stdout, log)
  assert.match((await sh(vm, 'echo x > /data/agents/lifelog/state.json')).stderr, READ_ONLY)
  assert.match((await sh(vm, 'echo x > /data/datastore/new.txt')).stderr, READ_ONLY)
  for (const folder of ['views', 'memory', 'run/session']) {
    assert.equal((await sh(vm, `echo ok > /data/agents/lifelog/${folder}/a.txt`)).exitCode, 0)
    assert.equal(fs.readFileSync(`${data.agent}/${folder}/a.txt`, 'utf8'), 'ok\n')
  }
})

test("VM 1: with Gondolin's default mount point, a mount at /data keeps the VM from starting", options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  // A healthy VM is ready in about 2 seconds with KVM and about 7 under emulation. With mounts
  // under /data, as before the data folder was mounted whole, the VM's start timed out instead.
  const start = startVm(t, { files: designFiles(data), at: '/data', fuseMount: null, startTimeoutMs: 45_000 })
  await assert.rejects(start, /vfs mount \/etc\/gondolin not ready/)
})

// Every name under `dir`, with its kind, mode, links and contents: what a refused change must
// leave as it was.
function snapshot(dir) {
  const found = {}
  const walk = (folder, relative) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const full = path.join(folder, name)
      const inner = relative === '' ? name : `${relative}/${name}`
      const stat = fs.lstatSync(full)
      const kind = stat.isDirectory() ? 'folder' : stat.isSymbolicLink() ? `link ${fs.readlinkSync(full)}` : stat.isFile() ? 'file' : 'other'
      found[inner] = `${kind} ${(stat.mode & 0o7777).toString(8)} ${stat.nlink} ${stat.isFile() ? fs.readFileSync(full, 'utf8') : ''}`
      if (stat.isDirectory()) walk(full, inner)
    }
  }
  walk(dir, '')
  return found
}

test("VM 6: the sandbox's provider lets the VM change what writes names, files as well as folders, and nothing else", options, async t => {
  const dir = makeTestDir(t)
  const root = path.join(dir, 'root')
  for (const folder of ['allowed/sub', 'empty', 'ro/empty', 'ro/secret']) fs.mkdirSync(path.join(root, folder), { recursive: true })
  for (const [file, text] of [
    ['allowed/old.txt', 'old\n'],
    ['ro/keep.txt', 'keep\n'],
    ['ro/secret/hidden.txt', 'hidden\n'],
    ['file.txt', 'file\n'],
    ['ro-file.txt', 'ro\n'],
    ['unnamed.txt', 'unnamed\n'],
  ]) {
    fs.writeFileSync(path.join(root, file), text)
  }
  const files = {
    root,
    reads: [`${root}/ro`, `${root}/ro-file.txt`],
    writes: [
      { path: `${root}/allowed`, folder: true },
      { path: `${root}/empty`, folder: true },
      { path: `${root}/file.txt`, folder: false },
      { path: `${root}/new.txt`, folder: false },
    ],
    hide: [`${root}/ro/secret`],
  }
  const vm = await startVm(t, { files })
  const run = command => sh(vm, `cd ${root} && ${command}`)

  // The VM sees what reads and writes name, and the folders that lead there, and nothing else.
  assert.equal((await run('ls')).stdout, 'allowed\nempty\nfile.txt\nro\nro-file.txt\n')
  assert.equal((await run('ls ro')).stdout, 'empty\nkeep.txt\n')
  for (const command of ['cat unnamed.txt', 'cat ro/secret/hidden.txt']) {
    const result = await run(command)
    assert.notEqual(result.exitCode, 0, command)
    assert.match(result.stderr, NOT_THERE, command)
  }

  // Each change outside what writes names is refused with "Read-only file system", and the host is
  // as it was. The VM goes on.
  for (const command of [
    'echo x > ro/keep.txt',
    'echo x >> ro/keep.txt',
    'echo x > ro/new.txt',
    'echo x > ro-file.txt',
    'echo x > beside.txt',
    'echo x > new.txt.bak',
    'echo x > allowed/../ro/keep.txt',
    'mkdir ro/d',
    'mkdir new.txt',
    'rmdir ro/empty',
    'rm ro/keep.txt',
    'rm ro-file.txt',
    'mv ro/keep.txt allowed/moved.txt',
    'mv allowed/old.txt ro/moved.txt',
    'mv allowed/old.txt ro-file.txt',
    'mv allowed allowed-2',
    'ln ro/keep.txt allowed/hard',
    'ln allowed/old.txt ro/hard',
    'ln -s keep.txt ro/link',
    'chmod 600 ro/keep.txt',
    'chmod 600 ro-file.txt',
    'truncate -s 0 ro/keep.txt',
    'truncate -s 0 ro-file.txt',
  ]) {
    const before = snapshot(root)
    const result = await run(command)
    assert.notEqual(result.exitCode, 0, `${command} should fail`)
    assert.match(result.stderr, READ_ONLY, command)
    assert.deepEqual(snapshot(root), before, command)
  }

  // A program in the VM is given EROFS, as pi's tools would be.
  const refused = await runIn(vm, ['node', '-e', `try { require('fs').writeFileSync('${root}/ro/keep.txt', 'x') } catch (error) { process.stdout.write(error.code) }`], {
    env: { PATH: GUEST_PATH },
  })
  assert.equal(refused.stdout, 'EROFS')

  // A link made where the run may write leads nowhere else: the VM follows it itself.
  assert.equal((await run('ln -s ../ro/keep.txt allowed/to-keep && ln -s ../ro allowed/to-ro')).exitCode, 0)
  for (const command of ['echo x > allowed/to-keep', 'echo x > allowed/to-ro/new.txt', 'chmod 600 allowed/to-keep', 'ln allowed/to-keep allowed/hard']) {
    const result = await run(command)
    assert.notEqual(result.exitCode, 0, command)
    assert.match(result.stderr, READ_ONLY, command)
  }
  assert.equal(fs.readFileSync(path.join(root, 'ro', 'keep.txt'), 'utf8'), 'keep\n')
  assert.deepEqual(fs.readdirSync(path.join(root, 'ro')).sort(), ['empty', 'keep.txt', 'secret'])

  // A link made to what the VM doesn't see is there, and can be listed and removed, while what it
  // leads to stays out of sight.
  assert.equal((await run('ln -s ../ro/secret allowed/s')).exitCode, 0)
  assert.match((await run('ls -l allowed/s')).stdout, /allowed\/s -> \.\.\/ro\/secret/)
  assert.match((await run('cat allowed/s/hidden.txt')).stderr, NOT_THERE)
  assert.equal((await run('mv allowed/s allowed/sub/s && rm allowed/sub/s')).exitCode, 0)
  assert.equal(fs.existsSync(path.join(root, 'allowed', 'sub', 's')), false)

  // Inside a folder writes names, every change is allowed.
  for (const command of [
    'echo a > allowed/a.txt',
    'echo b >> allowed/a.txt',
    'mkdir allowed/d',
    'rmdir allowed/d',
    'mv allowed/a.txt allowed/sub/a.txt',
    'ln allowed/sub/a.txt allowed/hard',
    'ln -s a.txt allowed/sub/link',
    'chmod 640 allowed/hard',
    'truncate -s 1 allowed/hard',
    'rm allowed/hard',
    'echo c > allowed//sub/../c.txt',
  ]) {
    const result = await run(command)
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`)
  }
  assert.equal(fs.readFileSync(path.join(root, 'allowed', 'sub', 'a.txt'), 'utf8'), 'a')
  assert.equal(fs.statSync(path.join(root, 'allowed', 'sub', 'a.txt')).mode & 0o777, 0o640)
  assert.equal(fs.readlinkSync(path.join(root, 'allowed', 'sub', 'link')), 'a.txt')
  assert.equal(fs.readFileSync(path.join(root, 'allowed', 'c.txt'), 'utf8'), 'c\n')

  // Gondolin's file system has no `mknod`: a FIFO or a device can't be made, there either.
  for (const command of ['mkfifo allowed/pipe', 'mknod allowed/null c 1 3']) {
    const result = await run(command)
    assert.notEqual(result.exitCode, 0, command)
    assert.match(result.stderr, /Not supported/, command)
  }
  assert.equal(fs.existsSync(path.join(root, 'allowed', 'pipe')), false)

  // A file writes names can be written, truncated, given a mode, moved away and back, removed and
  // made again; and one that isn't there yet can be made, where nothing beside it can.
  for (const command of [
    'echo f > file.txt',
    'truncate -s 1 file.txt',
    'chmod 640 file.txt',
    'mv file.txt allowed/file.txt',
    'mv allowed/file.txt file.txt',
    'rm file.txt',
    'echo again > file.txt',
    'echo made > new.txt',
  ]) {
    const result = await run(command)
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`)
  }
  assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'again\n')
  assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'made\n')
  assert.equal(fs.existsSync(path.join(root, 'beside.txt')), false)

  // A folder writes names can be removed and made again, and nothing else put in its place; a
  // file it names can't become a folder.
  for (const [command, ok] of [
    ['rmdir empty', true],
    ['echo x > empty', false],
    ['ln -s allowed empty', false],
    ['mkdir empty', true],
    ['rm new.txt', true],
    ['mkdir new.txt', false],
  ]) {
    const result = await run(command)
    assert.equal(result.exitCode === 0, ok, `${command}: ${result.stderr}`)
    if (!ok) assert.match(result.stderr, READ_ONLY, command)
  }
  assert.equal(fs.lstatSync(path.join(root, 'empty')).isDirectory(), true)
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false)
})

test('VM 2: a command runs from an argument list, in a given folder, with no shell in between', options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const vm = await startVm(t, { files: designFiles(data) })
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
  const vm = await startVm(t, { model, files: designFiles(data) })
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

    // Either way the VM's files stay behind in the temporary folder, and its entry in Gondolin's
    // list of running VMs under the cache folder, for the next start to sweep.
    for (const { tmp } of [alone, group]) {
      assert.ok(hasDiskOverlay(tmp), 'the disk overlay should be left behind')
      const sessions = path.join(`${tmp}-cache`, 'gondolin', 'sessions')
      assert.ok(fs.readdirSync(sessions).length > 0, "the VM's entry in Gondolin's list should be left behind")
    }
  }
})

test("VM 7: a program the runner copies into run/ runs by its name from the PATH it gives, and from pi's bash tool, read-only, with the zone rules that ship with the runner", options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const paths = makePaths({ dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') })
  // A datastore of its own, laid out as the bridge writes it: a photo, and an edit of it at
  // midnight in Kolkata.
  fs.rmSync(paths.datastore, { recursive: true })
  writeDatastore(paths, [
    ...fillerLines(4),
    line.text(5, '2026-11-09T15:43:00Z', 'lunch', { files: [{ path: '5.jpg', mime: 'image/jpeg', bytes: 1 }] }),
    line.edit(6, '2026-11-09T18:30:00Z', 5, 'lunch with Sam'),
  ])
  const datastore = openDatastore({ paths })
  datastore.poll()
  fs.mkdirSync(path.join(paths.configDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(paths.configDir, 'prompts', 'lifelog.md'), 'You are lifelog.\n')
  const agent = { name: 'lifelog', prompt: { path: 'prompts/lifelog.md', file: path.join(paths.configDir, 'prompts', 'lifelog.md') }, skills: [] }
  // `run/` as the runner makes it for a run.
  prepareRun({ paths, agent, index: datastore.index })
  const bin = paths.agentRunBin('lifelog')
  const icuTz = paths.agentRunIcuTz('lifelog')
  const release = icuTzRelease()
  const env = tz => runnerPiEnv({ timeZone: tz, binDir: bin, icuTzDir: icuTz })
  const log = day => paths.dayLog(day)
  const kolkata = [
    `6  Tue 10 Nov 2026 00:00 +05:30  ${log('2026/11/09')}:2`,
    fs.readFileSync(log('2026/11/09'), 'utf8').split('\n')[1],
    `  points at 5  Mon 9 Nov 2026 21:13 +05:30  ${log('2026/11/09')}:1`,
    `  ${fs.readFileSync(log('2026/11/09'), 'utf8').split('\n')[0]}`,
    `    file ${paths.dayDir('2026/11/09')}/5.jpg`,
    '',
  ].join('\n')

  const model = createFakeModel([
    { tool: 'bash', args: { command: 'show 6; echo "exit $?"; show 7; echo "exit $?"; node -p process.versions.tz; printenv ICU_TIMEZONE_FILES_DIR' } },
    { text: 'Shown.' },
  ])
  const vm = await startVm(t, { model, files: designFiles(data) })
  const inAgent = (argv, environment) => runIn(vm, argv, { cwd: data.agent, env: environment })

  // By its name, from the PATH the runner gives: by `env`, as the sandbox runs pi, and from a
  // shell, as pi's bash tool runs a command. The image's Node runs the copy, a file without an
  // extension in ES module syntax, as a module, and says nothing of it on stderr. The time is the
  // owner's, across their midnight.
  for (const argv of [['show', '6'], ['bash', '-c', 'show 6'], ['sh', '-c', 'cd /tmp && show 6']]) {
    const shown = await inAgent(argv, env('Asia/Kolkata'))
    assert.equal(shown.exitCode, 0, `${argv.join(' ')}: ${shown.stderr}`)
    assert.equal(shown.stdout, kolkata, argv.join(' '))
    assert.equal(shown.stderr, '', argv.join(' '))
  }
  // The same as the host prints, with the same environment: the two Nodes convert with the same
  // rules, those of the run's copy (`VM 8`).
  const host = spawnSync(process.execPath, [path.join(bin, 'show'), '6'], { env: env('Asia/Kolkata'), encoding: 'utf8' })
  assert.equal(host.stdout, kolkata)

  // The program, the index file and the zone rules are read-only in the VM, as the rest of `run/`
  // is.
  for (const command of [
    `echo x > ${bin}/show`,
    `rm ${bin}/show`,
    `chmod 600 ${bin}/show`,
    `mv ${bin}/show ${bin}/old`,
    `echo x > ${bin}/send`,
    `echo x >> ${paths.agentRunIndex('lifelog')}`,
    `rm ${paths.agentRunIndex('lifelog')}`,
    `echo x > ${icuTz}/zoneinfo64.res`,
    `echo 2020a > ${icuTz}/release.txt`,
    `rm ${icuTz}/metaZones.res`,
    `mv ${icuTz} ${bin}/icu-tz`,
    `echo x > ${icuTz}/extra.res`,
  ]) {
    const result = await sh(vm, command)
    assert.notEqual(result.exitCode, 0, `${command} should fail`)
    assert.match(result.stderr, READ_ONLY, command)
  }
  assert.equal(fs.readFileSync(path.join(bin, 'show'), 'utf8'), fs.readFileSync(new URL('../../src/runner/vm/bin/show.mjs', import.meta.url), 'utf8'))
  assert.deepEqual(fs.readdirSync(bin).sort(), ['mark', 'send', 'show'])
  for (const name of fs.readdirSync(new URL('../../src/runner/vm/icu-tz/', import.meta.url))) {
    assert.deepEqual(fs.readFileSync(path.join(icuTz, name)), fs.readFileSync(new URL(`../../src/runner/vm/icu-tz/${name}`, import.meta.url)), name)
  }

  // From pi's bash tool, with the environment the runner gives pi: the variable reaches what the
  // tool runs, and the Node there converts with the shipped rules.
  const result = await runPi(vm, { prompt: 'show me 6' }, { cwd: data.agent, env: piEnv(vm, { bin, icuTz }) })
  assert.equal(result.exitCode, 0, result.stderr)
  const [bash] = toolResults(model.modelRequests.at(-1).body)
  assert.equal(bash.isError, false, bash.text)
  assert.equal(bash.text, `${kolkata}exit 0\n7  no such line\nexit 1\n${release}\n${icuTz}\n`)
})

test("VM 9: send and mark, copied into run/bin/ as show is, run by their names from pi's bash tool, with nothing on standard input, and write only into run/send/ and run/marks.txt, which the runner reads as they left them", options, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  const paths = makePaths({ dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') })
  fs.mkdirSync(path.join(paths.configDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(paths.configDir, 'prompts', 'lifelog.md'), 'You are lifelog.\n')
  fs.rmSync(paths.datastore, { recursive: true })
  writeDatastore(paths, fillerLines(1050))
  const datastore = openDatastore({ paths })
  datastore.poll()
  // `run/` as the runner makes it for a run: an empty send/, and no marks.txt.
  prepareRun({ paths, agent: { name: 'lifelog', prompt: { path: 'prompts/lifelog.md', file: path.join(paths.configDir, 'prompts', 'lifelog.md') }, skills: [] }, index: datastore.index })
  const run = paths.agentRun('lifelog')
  const bin = paths.agentRunBin('lifelog')
  const index = fs.readFileSync(paths.agentRunIndex('lifelog'), 'utf8')
  const queued = 'send: queued; it goes to the owner once this run has passed'
  // What the agent types: a reply with quotes and a `$` in single quotes, a text with line breaks,
  // a `$` and backticks through a here-document, a send with no text at all, its marks, and writes
  // where neither program writes.
  const command = [
    `send --reply-to 1050 'He said "₹450, not $45".'; echo "exit $?"`,
    "send <<'END'",
    'Two lines,',
    'with $HOME and `ticks` as they are.',
    'END',
    'echo "exit $?"',
    'send; echo "exit $?"',
    'mark done 1050 1049; echo "exit $?"',
    `mark failed 1048 "can't read it"; echo "exit $?"`,
    `echo x > ${run}/index.txt; echo "exit $?"`,
    `echo x > ${run}/marks-2.txt; echo "exit $?"`,
    `mkdir ${run}/send/sub && rmdir ${run}/send/sub; echo "exit $?"`,
  ].join('\n')
  const model = createFakeModel([{ tool: 'bash', args: { command } }, { text: 'Done.' }])
  const vm = await startVm(t, { model, files: designFiles(data) })
  const result = await runPi(vm, { prompt: 'send and mark' }, { cwd: data.agent, env: piEnv(vm, { bin, icuTz: paths.agentRunIcuTz('lifelog') }) })
  assert.equal(result.exitCode, 0, result.stderr)
  const [bash] = toolResults(model.modelRequests.at(-1).body)
  // What each said, the usage of send after its refusal, and the two writes the VM refused.
  const usage = spawnSync(process.execPath, [path.join(bin, 'send'), '--help'], { encoding: 'utf8' }).stdout
  assert.equal(
    bash.text,
    [
      queued,
      'exit 0',
      queued,
      'exit 0',
      'send: nothing to send: give the text as an argument, or on standard input',
      usage.trimEnd(),
      'exit 2',
      'mark: 1050 and 1049 marked done',
      'exit 0',
      'mark: 1048 marked failed',
      'exit 0',
      `/bin/bash: line 10: ${run}/index.txt: Read-only file system`,
      'exit 1',
      `/bin/bash: line 11: ${run}/marks-2.txt: Read-only file system`,
      'exit 1',
      'exit 0',
      '',
    ].join('\n'),
  )

  // On the host, as the runner reads them: the two messages in order, and the marks.
  assert.deepEqual(readSends(paths.agentRunSend('lifelog')), {
    messages: [
      { text: 'He said "₹450, not $45".', replyTo: 1050 },
      { text: 'Two lines,\nwith $HOME and `ticks` as they are.', replyTo: null },
    ],
    refused: 0,
    past: 0,
    error: null,
  })
  assert.deepEqual(readMarks(paths.agentRunMarks('lifelog')), {
    done: [1050, 1049],
    failed: [{ seq: 1048, reason: "can't read it" }],
    unreadable: 0,
    refused: null,
  })
  assert.deepEqual(fs.readdirSync(run).sort(), ['bin', 'config', 'icu-tz', 'index.txt', 'marks.txt', 'send', 'session', 'skills'])
  assert.equal(fs.readFileSync(paths.agentRunIndex('lifelog'), 'utf8'), index)
})

test("VM 8: the image's Node converts with the zone rules that ship with the runner where pi's environment points it at them, and show prints the owner's time with them, or none", options, async t => {
  const dir = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(dir, 'data'), configDir: path.join(dir, 'config') })
  // The times the review of show found the image's own rules an hour off at, or without a time: in
  // Vancouver and Coyhaique on 1 November 2026, Asunción on 1 April and Casablanca on 1 October;
  // London's two changes of the clocks; and Kolkata's local mean time, an offset with seconds.
  const ats = ['1850-01-01T00:00:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-04-01T00:30:00Z', '2026-10-01T00:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', '2026-11-01T12:30:00Z']
  writeDatastore(
    paths,
    ats.map((at, n) => line.text(n + 1, at, 'x')),
  )
  const datastore = openDatastore({ paths })
  datastore.poll()
  fs.mkdirSync(path.join(paths.configDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(paths.configDir, 'prompts', 'lifelog.md'), 'You are lifelog.\n')
  const prompt = { path: 'prompts/lifelog.md', file: path.join(paths.configDir, 'prompts', 'lifelog.md') }
  // A run's `run/`, as the runner makes it; and two more, whose copy of the rules is then damaged
  // on the host, where the VM can't: `zoneinfo64.res` cut to half, and changed by a byte.
  for (const name of ['lifelog', 'cut', 'changed']) {
    fs.mkdirSync(paths.agentDir(name), { recursive: true })
    prepareRun({ paths, agent: { name, prompt, skills: [] }, index: datastore.index })
  }
  const zoneinfo = name => path.join(paths.agentRunIcuTz(name), 'zoneinfo64.res')
  fs.truncateSync(zoneinfo('cut'), fs.statSync(zoneinfo('cut')).size / 2)
  const bytes = fs.readFileSync(zoneinfo('changed'))
  bytes[100_000] ^= 0xff
  fs.writeFileSync(zoneinfo('changed'), bytes)
  // And the rules as they ship, outside `run/`.
  const other = path.join(paths.agentDir('lifelog'), 'other-icu-tz')
  fs.cpSync(new URL('../../src/runner/vm/icu-tz/', import.meta.url), other, { recursive: true })
  const vm = await startVm(t, { files: piFiles(paths, { name: 'lifelog', reads: ['datastore/', 'agents/'], writes: [] }) })

  const release = icuTzRelease()
  const cwd = paths.agentDir('lifelog')
  const env = (tz, name = 'lifelog') => runnerPiEnv({ timeZone: tz, binDir: paths.agentRunBin(name), icuTzDir: paths.agentRunIcuTz(name) })
  const tzOf = async environment => {
    const result = await runIn(vm, ['node', '-p', 'process.versions.tz'], { cwd, env: environment })
    assert.equal(result.exitCode, 0, result.stderr)
    return result.stdout.trim()
  }

  // Started as the sandbox starts pi, with pi's environment: the shipped release. Without the
  // variable: the image's own, which isn't.
  assert.equal(await tzOf(env('Asia/Kolkata')), release)
  const own = await runIn(vm, ['node', '-p', '`${process.versions.node} ICU ${process.versions.icu} tz ${process.versions.tz}`'], { env: { PATH: GUEST_PATH } })
  t.diagnostic(`the image's Node without the variable: ${own.stdout.trim()}`)
  assert.equal(await tzOf({ PATH: GUEST_PATH }) === release, false)

  // In each zone, what the shipped rules give, by the runner's own time code in a Node given them,
  // and what the host prints with the same environment.
  const seqs = ats.map((_, n) => String(n + 1))
  const headers = text =>
    text
      .split('\n')
      .filter(row => /^\d {2}/.test(row))
      .map(row => row.split('  ')[1])
  for (const zone of ['America/Coyhaique', 'America/Vancouver', 'America/Asuncion', 'Africa/Casablanca', 'Europe/London', 'Asia/Kolkata']) {
    const shown = await runIn(vm, ['show', ...seqs], { cwd, env: env(zone) })
    assert.equal(shown.exitCode, 0, `${zone}: ${shown.stderr}`)
    assert.deepEqual(headers(shown.stdout), headerTimes(zone, ats), zone)
    const host = spawnSync(process.execPath, [path.join(paths.agentRunBin('lifelog'), 'show'), ...seqs], { env: env(zone), encoding: 'utf8' })
    assert.equal(shown.stdout, host.stdout, zone)
  }
  // The review's, with the offset worked out from the conversion: the image's ICU 76 names
  // Casablanca's offset of 0 `GMT`, where ICU 78 writes `GMT+00:00`.
  const header = async (zone, seq) => headers((await runIn(vm, ['show', seq], { cwd, env: env(zone) })).stdout)[0]
  assert.equal(await header('America/Vancouver', '8'), 'Sun 1 Nov 2026 05:30 -07:00')
  assert.equal(await header('America/Coyhaique', '8'), 'Sun 1 Nov 2026 09:30 -03:00')
  assert.equal(await header('America/Asuncion', '4'), 'Tue 31 Mar 2026 21:30 -03:00')
  assert.equal(await header('Africa/Casablanca', '5'), 'Thu 1 Oct 2026 00:30 +00:00')
  assert.equal(await header('Asia/Kolkata', '1'), 'Tue 1 Jan 1850 05:53 +05:53:28')

  // Without the run's rules whole and in use, or without a zone they know, it prints nothing, and
  // says which, with exit code 2.
  const rules = paths.agentRunIcuTz('lifelog')
  const without = (environment, name) => Object.fromEntries(Object.entries(environment).filter(([key]) => key !== name))
  const refusals = [
    ['lifelog', without(env('Asia/Kolkata'), 'ICU_TIMEZONE_FILES_DIR'), `ICU_TIMEZONE_FILES_DIR isn't set to the run's zone rules, ${rules}, so Node would convert with rules of its own`],
    ['lifelog', { ...env('Asia/Kolkata'), ICU_TIMEZONE_FILES_DIR: other }, `ICU_TIMEZONE_FILES_DIR is ${other}, not the run's zone rules, ${rules}`],
    ['lifelog', without(env('Asia/Kolkata'), 'TZ'), "TZ isn't set, so the owner's time can't be shown"],
    ['lifelog', env('Mars/Olympus'), `TZ is Mars/Olympus, which the run's zone rules, tz ${release}, don't know as a time zone`],
    ['changed', env('Asia/Kolkata', 'changed'), `the run's zone rules, ${paths.agentRunIcuTz('changed')}, are missing or damaged (zoneinfo64.res: not the file release.txt lists)`],
  ]
  for (const [name, environment, message] of refusals) {
    const shown = await runIn(vm, ['show', '8'], { cwd: paths.agentDir(name), env: environment })
    assert.deepEqual({ code: shown.exitCode, stdout: shown.stdout, stderr: shown.stderr }, { code: 2, stdout: '', stderr: `show: ${message}\n` }, message)
  }
  // Why the files are checked: the image's ICU takes a `zoneinfo64.res` changed by a byte as it is.
  assert.equal(await tzOf(env('Asia/Kolkata', 'changed')), release)
  // And one cut short leaves it no zone rules at all, or, now and then, makes it die as it starts,
  // with a segmentation fault, before any of `show` runs: either way `show` prints no time, saying
  // why when it gets to run. Tried by hand, 24 starts each with the file cut to half, to its first
  // 1,000 bytes, to its first 64, and to all but its last 1,000: 7 of the 96 died.
  for (let n = 0; n < 4; n++) {
    const started = await runIn(vm, ['node', '-p', 'JSON.stringify(process.versions.tz)'], { cwd, env: env('Asia/Kolkata', 'cut') })
    assert.ok(started.exitCode === 139 || (started.exitCode === 0 && started.stdout === '""\n'), JSON.stringify(started))
    const cut = await runIn(vm, ['show', '8'], { cwd: paths.agentDir('cut'), env: env('Asia/Kolkata', 'cut') })
    const said = `show: the run's zone rules, ${paths.agentRunIcuTz('cut')}, are missing or damaged (zoneinfo64.res: not the file release.txt lists)\n`
    assert.ok(cut.stdout === '' && ((cut.exitCode === 2 && cut.stderr === said) || (cut.exitCode === 139 && cut.stderr === '')), JSON.stringify(cut))
  }
})

const needsGit = { ...options, skip: options.skip || (onPath('git') ? false : 'git is not installed') }

test('VM 5: git log works on the read-only agent folder', needsGit, async t => {
  const dir = makeTestDir(t)
  const data = makeDataDir(dir)
  // The agent's folder as the runner makes it.
  const identity = ['-c', 'user.name=Scooter', '-c', 'user.email=scooter@localhost']
  const git = (...args) => execFileSync('git', ['-C', data.agent, ...identity, ...args], { encoding: 'utf8' })
  fs.writeFileSync(path.join(data.agent, '.gitignore'), '/sessions/\n/run/\n/state.json\n')
  git('init', '--quiet', '--initial-branch=main')
  git('add', '--all')
  git('commit', '--quiet', '--no-gpg-sign', '--message', 'lifelog: #1040')
  const head = git('rev-parse', 'HEAD').trim()

  const vm = await startVm(t, { files: designFiles(data) })
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
