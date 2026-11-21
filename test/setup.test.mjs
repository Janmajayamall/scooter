// `scooter setup`: the decisions it
// makes, its checks, and, as root in the plan's container, the install it leaves: the users and
// folders, what wacli and the email reader can't read, and which env file each service can read.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { SettingsError, loadFolders, loadSettings, parseEnvFile } from '../src/common/settings.mjs'
import {
  NATIVE,
  SetupError,
  USERS,
  codeProblems,
  configOwner,
  dataFolders,
  envFileProblems,
  envFileText,
  envFiles,
  kvmMembership,
  nodeProblems,
  nodeVersionProblem,
  pathProblems,
  runSetup,
  setup,
  wrapperText,
} from '../src/ops/setup.mjs'
import { createTestLog } from './support/log.mjs'
import { skipIfRoot, skipUnlessUsers } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const REPO = new URL('..', import.meta.url).pathname
const ROOT = { uid: 0, gid: 0 }
const IDS = { wacli: { uid: 991, gid: 981 }, runner: { uid: 992, gid: 982 }, mail: { uid: 993, gid: 983 } }

// ---------------------------------------------------------------------------------------------
// The decisions

test('setup: the data folder\'s folders, with their owners and modes, and those it makes inside other users\' folders', () => {
  const paths = makePaths({ dataDir: '/var/lib/scooter', configDir: '/etc/scooter/config' })
  const table = dataFolders(paths, IDS).map(({ path: folder, owner, mode, inside }) => [folder.replace('/var/lib/scooter', 'DATA'), owner, `0${mode.toString(8)}`, inside])
  assert.deepEqual(table, [
    ['DATA', ROOT, '0755', false],
    // Root's, with the runner's group: the runner reads it; only the bridge writes it.
    ['DATA/datastore', { uid: 0, gid: 982 }, '0750', false],
    ['DATA/agents', IDS.runner, '0700', false],
    ['DATA/exchange', IDS.runner, '0700', false],
    ['DATA/exchange/outbox', IDS.runner, '0700', true],
    ['DATA/exchange/locks', IDS.runner, '0700', true],
    ['DATA/runner', IDS.runner, '0700', false],
    ['DATA/bridge', ROOT, '0700', false],
    ['DATA/wacli', IDS.wacli, '0700', false],
    ...['store', 'staging', 'config', 'state', 'cache'].map(name => [`DATA/wacli/${name}`, IDS.wacli, '0700', true]),
    ['DATA/mail', IDS.mail, '0700', false],
    ['DATA/mail/spool', IDS.mail, '0700', true],
  ])
  // The config is root's, readable by the runner alone; the env files each their service's.
  assert.deepEqual(configOwner(IDS), { owner: { uid: 0, gid: 982 }, folderMode: 0o750, fileMode: 0o640 })
  assert.deepEqual(envFiles('/etc/scooter', IDS), [
    { side: 'bridge', file: '/etc/scooter/bridge.env', owner: ROOT },
    { side: 'runner', file: '/etc/scooter/runner.env', owner: IDS.runner },
  ])
  assert.deepEqual(USERS, { wacli: 'scooter-wacli', runner: 'scooter-runner', mail: 'scooter-mail' })
  assert.deepEqual(NATIVE, { dataDir: '/var/lib/scooter', envDir: '/etc/scooter', configDir: '/etc/scooter/config', binDir: '/usr/local/bin', unitDir: '/etc/systemd/system' })
})

test('setup: the env files are the examples with DATA_DIR and CONFIG_DIR filled in, and each service reads them so', t => {
  const root = makeTestDir(t)
  for (const side of ['bridge', 'runner']) {
    const example = fs.readFileSync(path.join(REPO, `${side}.env.example`), 'utf8')
    const text = envFileText(example, NATIVE)
    const parsed = parseEnvFile(text)
    assert.deepEqual(parsed.problems, [])
    assert.equal(parsed.values.get('DATA_DIR'), '/var/lib/scooter')
    assert.equal(parsed.values.get('CONFIG_DIR'), '/etc/scooter/config')
    // Only those two lines changed.
    const changed = text.split('\n').filter((line, n) => line !== example.split('\n')[n])
    assert.deepEqual(changed, ['DATA_DIR=/var/lib/scooter', 'CONFIG_DIR=/etc/scooter/config'])
    fs.writeFileSync(path.join(root, `${side}.env`), text)
  }
  // Each side reads its own file, and only that: the other's needn't even be readable.
  const env = { SCOOTER_ENV_DIR: root, OWNER_NUMBER: '+919812345678', OPENROUTER_API_KEY: 'x' }
  assert.deepEqual(loadFolders('runner', { env }), { dataDir: '/var/lib/scooter', configDir: '/etc/scooter/config' })
  fs.chmodSync(path.join(root, 'bridge.env'), 0o000)
  assert.equal(loadSettings('runner', { env }).dataDir, '/var/lib/scooter')
  fs.chmodSync(path.join(root, 'bridge.env'), 0o600)
  fs.chmodSync(path.join(root, 'runner.env'), 0o000)
  assert.equal(loadSettings('bridge', { env }).configDir, '/etc/scooter/config')
  // A folder with a character an env file quotes.
  assert.match(envFileText('# DATA_DIR=/data\n# CONFIG_DIR=/config\n', { dataDir: '/srv/a b', configDir: '/c' }), /^DATA_DIR='\/srv\/a b'$/m)
  assert.throws(() => envFileText('# DATA_DIR=/data\n', NATIVE), /no line "# CONFIG_DIR=…"/)
})

test('setup: an env file that is there already must name its folders, since setup never writes over it', t => {
  const root = makeTestDir(t)
  const file = path.join(root, 'runner.env')
  assert.deepEqual(envFileProblems(file, NATIVE), [])
  fs.writeFileSync(file, envFileText(fs.readFileSync(path.join(REPO, 'runner.env.example'), 'utf8'), NATIVE))
  assert.deepEqual(envFileProblems(file, NATIVE), [])
  // As the example is, copied by hand: the service would use /data and /config.
  fs.copyFileSync(path.join(REPO, 'runner.env.example'), file)
  assert.deepEqual(envFileProblems(file, NATIVE), [
    `${file} doesn't set DATA_DIR, where setup keeps it in /var/lib/scooter: set DATA_DIR=/var/lib/scooter there, or remove the file to have setup write it`,
    `${file} doesn't set CONFIG_DIR, where setup keeps it in /etc/scooter/config: set CONFIG_DIR=/etc/scooter/config there, or remove the file to have setup write it`,
  ])
  fs.writeFileSync(file, 'DATA_DIR=/srv/scooter\nCONFIG_DIR=/etc/scooter/config\n')
  assert.match(envFileProblems(file, NATIVE)[0], /sets DATA_DIR to \/srv\/scooter, where setup keeps it in \/var\/lib\/scooter/)
  fs.writeFileSync(file, 'DATA_DIR = x\n')
  assert.match(envFileProblems(file, NATIVE)[0], /line 1: expected KEY=value/)
})

test('setup: the scooter command execs Node with the code\'s cli.mjs, so Node is the main process', async t => {
  const root = makeTestDir(t)
  const cli = path.join(root, 'cli.mjs')
  fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }))\n')
  const text = wrapperText({ node: process.execPath, cli })
  assert.equal(text, `#!/bin/sh\n# Scooter's command, written by \`scooter setup\`, which writes it again each time it runs.\nexec '${process.execPath}' '${cli}' "$@"\n`)
  const wrapper = path.join(root, 'scooter')
  fs.writeFileSync(wrapper, text, { mode: 0o755 })
  const child = spawn(wrapper, ['bridge', 'with space', "it's"], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', chunk => (out += chunk))
  await new Promise(resolve => child.on('close', resolve))
  // The process started is Node itself: `systemctl kill --kill-whom=main` reaches the bridge.
  assert.deepEqual(JSON.parse(out), { pid: child.pid, args: ['bridge', 'with space', "it's"] })
  assert.throws(() => wrapperText({ node: "/opt/it's/node", cli }), SetupError)
})

// ---------------------------------------------------------------------------------------------
// The checks

// A tree as a native install's code is, owned by this test's user, which the checks take as root.
function codeTree(root) {
  const code = path.join(root, 'opt', 'scooter')
  for (const folder of ['src', 'node_modules/yaml', '.git/objects']) fs.mkdirSync(path.join(code, folder), { recursive: true, mode: 0o755 })
  fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ dependencies: { yaml: '2.9.1' } }), { mode: 0o644 })
  fs.writeFileSync(path.join(code, 'src', 'cli.mjs'), '', { mode: 0o755 })
  fs.writeFileSync(path.join(code, 'node_modules', 'yaml', 'package.json'), '{}', { mode: 0o644 })
  fs.writeFileSync(path.join(code, '.git', 'objects', 'x'), '', { mode: 0o600 })
  for (const folder of [root, path.join(root, 'opt'), code]) fs.chmodSync(folder, 0o755)
  return code
}

test('setup: the code must be readable by every user and changed by root alone, with its dependencies installed', t => {
  const root = makeTestDir(t)
  const owner = process.getuid()
  const code = codeTree(root)
  assert.deepEqual(codeProblems(code, { owner }), [])
  fs.chmodSync(path.join(code, 'src', 'cli.mjs'), 0o750)
  fs.chmodSync(path.join(code, 'src'), 0o775)
  fs.rmSync(path.join(code, 'node_modules', 'yaml'), { recursive: true })
  assert.deepEqual(codeProblems(code, { owner }), [
    `${path.join(code, 'src')} can be written by users other than root (mode 0775)`,
    `${path.join(code, 'src', 'cli.mjs')} can't be read by other users (mode 0750)`,
    `yaml isn't installed: run npm ci --omit=dev --ignore-scripts in ${code}`,
  ])
  // In someone's home folder, which other users can't pass through.
  fs.chmodSync(path.join(root, 'opt'), 0o750)
  assert.match(pathProblems(path.join(code, 'src'), { owner }).join('\n'), /opt can't be passed through by other users \(mode 0750\)/)
})

test('setup: Node must be one Scooter runs on, that every user can run and only root change', t => {
  const root = makeTestDir(t)
  const owner = process.getuid()
  const bin = path.join(root, 'usr', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  for (const folder of [root, path.join(root, 'usr'), bin]) fs.chmodSync(folder, 0o755)
  const node = path.join(bin, 'node')
  fs.writeFileSync(node, '', { mode: 0o755 })
  assert.deepEqual(nodeProblems(node, { owner, version: '22.23.2' }), [])
  assert.deepEqual(nodeProblems(node, { owner, version: '24.1.0' }), [])
  assert.deepEqual(nodeProblems(node, { owner, version: '22.18.0' }), ['Node 22.18.0 is too old: Scooter needs 22.19 or later'])
  assert.equal(nodeVersionProblem('23.0.0'), null)
  fs.chmodSync(node, 0o750)
  assert.deepEqual(nodeProblems(node, { owner, version: '22.23.2' }), [`${node} can't be run by other users (mode 0750)`])
  fs.chmodSync(node, 0o757)
  assert.deepEqual(nodeProblems(node, { owner, version: '22.23.2' }), [`${node} can be written by users other than root (mode 0757)`])
  // Through a link, the file it leads to is checked.
  fs.chmodSync(node, 0o755)
  const link = path.join(root, 'node-link')
  fs.symlinkSync(node, link)
  assert.deepEqual(nodeProblems(link, { owner, version: '22.23.2' }), [])
})

test("setup: with services, a machine without a kvm group gets one, which the runner's unit names; without them, none", async () => {
  // A machine as each case has it: its groups, and who is in them.
  const machine = (groups = {}) => {
    const calls = []
    return {
      calls,
      findGroup: async name => (Object.hasOwn(groups, name) ? 999 : null),
      run: async (program, args) => {
        calls.push([program, ...args])
        if (program === 'groupadd') groups[args.at(-1)] = []
        if (program === 'usermod') groups[args[2]].push(args.at(-1))
        if (program === 'id') return { stdout: `${args.at(-1)} ${Object.keys(groups).filter(group => groups[group].includes(args.at(-1))).join(' ')}\n` }
        return { stdout: '' }
      },
    }
  }
  // No group, with services: made, then the runner put in it.
  let found = machine()
  assert.equal(
    await kvmMembership({ runner: 'scooter-runner', kvmGroup: 'kvm', services: true, ...found }),
    "there was no kvm group, which the runner's service names, so setup made one; scooter-runner is now in the kvm group",
  )
  assert.deepEqual(found.calls.map(call => call[0]), ['groupadd', 'id', 'usermod'])
  assert.deepEqual(found.calls[0], ['groupadd', '--system', '--', 'kvm'])
  // No group, without services: none made.
  found = machine()
  assert.match(await kvmMembership({ runner: 'scooter-runner', kvmGroup: 'kvm', services: false, ...found }), /^there is no kvm group on this machine, so pi's VMs will run under emulation/)
  assert.deepEqual(found.calls, [])
  // A group: the runner put in it once.
  found = machine({ kvm: [] })
  assert.equal(await kvmMembership({ runner: 'scooter-runner', kvmGroup: 'kvm', services: true, ...found }), 'scooter-runner is now in the kvm group')
  assert.equal(await kvmMembership({ runner: 'scooter-runner', kvmGroup: 'kvm', services: true, ...found }), 'scooter-runner is in the kvm group')
  assert.deepEqual(found.calls.map(call => call[0]), ['id', 'usermod', 'id'])
})

test('setup: not as root, without systemd, or with code a user could change, it stops before making anything', { skip: skipIfRoot }, async t => {
  const root = makeTestDir(t)
  const locations = { dataDir: path.join(root, 'data'), envDir: path.join(root, 'etc'), configDir: path.join(root, 'etc', 'config'), binDir: path.join(root, 'bin'), unitDir: path.join(root, 'units') }
  const proc = createProc({ log: createTestLog().log })
  await assert.rejects(setup({ locations, proc, isRoot: false }), /runs as root: sudo scooter setup/)
  await assert.rejects(setup({ locations, proc, isRoot: true, systemd: false }), /systemd isn't running this machine.*--no-services/)
  // As root, from code in this user's folders, which only root may change.
  await assert.rejects(setup({ locations, proc, isRoot: true, services: false }), error => {
    assert.ok(error instanceof SetupError)
    assert.match(error.message, /^setup checks that Scooter's users can run Node and read the code/)
    assert.match(error.message, /^- the code: .* belongs to uid \d+, not root$/m)
    return true
  })
  assert.equal(fs.existsSync(locations.dataDir), false)
  assert.equal(fs.existsSync(locations.envDir), false)

  const out = { stdout: '', stderr: '' }
  const streams = { stdout: { write: text => (out.stdout += text) }, stderr: { write: text => (out.stderr += text) } }
  assert.equal(await runSetup({ args: ['--yes'], ...streams }), 2)
  assert.equal(out.stderr, 'scooter setup: it takes only --no-services, not --yes\n')
  assert.equal(await runSetup({ args: ['--no-services'], ...streams }), 2)
  assert.match(out.stderr, /scooter setup: setup makes users, folders and services, so it runs as root/)
})

// ---------------------------------------------------------------------------------------------
// As root, in the plan's container (SCOOTER_ROOT_TESTS=1)

// Names of the test's own, so that it touches no install's users, nor those other root tests make.
const TEST_USERS = { wacli: 'sct12-wacli', runner: 'sct12-runner', mail: 'sct12-mail' }
const TEST_KVM = 'sct12-kvm'

test('setup: as root, without services, it makes the users and folders, twice over; wacli and the email reader can read none of the others\' folders; each service reads only its own env file', { skip: skipUnlessUsers }, async t => {
  const root = makeTestDir(t)
  fs.chmodSync(root, 0o755)
  const { log } = createTestLog()
  const proc = createProc({ log })
  const env = { PATH: process.env.PATH }
  atEnd(t, async () => {
    for (const name of Object.values(TEST_USERS)) await proc.run('userdel', [name], { env })
    await proc.run('groupdel', [TEST_KVM], { env })
  })
  assert.equal((await proc.run('groupadd', ['--system', TEST_KVM], { env })).code, 0)

  // The code, root's, as in /opt/scooter: this checkout's files that setup reads.
  const code = path.join(root, 'opt', 'scooter')
  for (const part of ['src', 'config', 'deploy', 'package.json', 'bridge.env.example', 'runner.env.example', 'node_modules/yaml']) {
    fs.cpSync(path.join(REPO, part), path.join(code, part), { recursive: true })
  }
  fs.writeFileSync(path.join(code, 'package.json'), JSON.stringify({ dependencies: { yaml: '2.9.1' } }))
  for (const folder of [path.join(root, 'opt'), code]) fs.chmodSync(folder, 0o755)
  const chmodTree = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const inner = path.join(folder, entry.name)
      fs.chmodSync(inner, entry.isDirectory() ? 0o755 : 0o644)
      if (entry.isDirectory()) chmodTree(inner)
    }
  }
  chmodTree(code)

  const locations = { dataDir: path.join(root, 'var', 'lib', 'scooter'), envDir: path.join(root, 'etc', 'scooter'), configDir: path.join(root, 'etc', 'scooter', 'config'), binDir: path.join(root, 'bin'), unitDir: path.join(root, 'units') }
  fs.mkdirSync(path.join(root, 'etc'), { mode: 0o755 })
  const first = await setup({ locations, codeDir: code, users: TEST_USERS, kvmGroup: TEST_KVM, services: false, proc })
  assert.match(first.done.join('\n'), /^Users: made sct12-wacli, sct12-runner, sct12-mail; sct12-runner is now in the sct12-kvm group\.$/m)
  assert.match(first.done.join('\n'), /^Services: not installed \(--no-services\)\.$/m)

  // System users, without a login shell or a home; the runner in the kvm group.
  const ids = {}
  for (const [part, name] of Object.entries(TEST_USERS)) {
    ids[part] = await proc.findUser(name)
    const entry = (await proc.run('getent', ['passwd', name], { env })).stdout.trim().split(':')
    assert.equal(entry[6], '/usr/sbin/nologin', name)
    assert.equal(entry[5], '/nonexistent', name)
    assert.ok(ids[part].uid < 1000, `${name} is a system user`)
  }
  assert.ok((await proc.run('id', ['-nG', TEST_USERS.runner], { env })).stdout.split(/\s+/).includes(TEST_KVM))

  // The folders, with their owners and modes.
  const paths = makePaths({ dataDir: locations.dataDir, configDir: locations.configDir })
  for (const { path: folder, owner, mode } of dataFolders(paths, ids)) {
    const stat = fs.lstatSync(folder)
    assert.deepEqual({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 }, { ...owner, mode }, folder)
  }
  // The config, copied, root's and the runner's group's; the env files, each its service's, 0600.
  const agentsYaml = fs.statSync(path.join(locations.configDir, 'agents.yaml'))
  assert.deepEqual([agentsYaml.uid, agentsYaml.gid, agentsYaml.mode & 0o777], [0, ids.runner.gid, 0o640])
  assert.equal(fs.readFileSync(path.join(locations.configDir, 'agents.yaml'), 'utf8'), fs.readFileSync(path.join(REPO, 'config', 'agents.yaml'), 'utf8'))
  for (const [file, owner] of [
    ['bridge.env', ROOT],
    ['runner.env', ids.runner],
  ]) {
    const stat = fs.statSync(path.join(locations.envDir, file))
    assert.deepEqual([stat.uid, stat.gid, stat.mode & 0o777], [owner.uid, owner.gid, 0o600], file)
  }
  const wrapper = fs.statSync(path.join(locations.binDir, 'scooter'))
  assert.deepEqual([wrapper.uid, wrapper.mode & 0o777], [0, 0o755])

  // Run again: nothing new, the owner's edits kept, and a folder whose mode went wrong put right.
  const runnerEnv = path.join(locations.envDir, 'runner.env')
  fs.writeFileSync(runnerEnv, fs.readFileSync(runnerEnv, 'utf8').replace(/^OPENROUTER_API_KEY=$/m, 'OPENROUTER_API_KEY=kept'))
  fs.appendFileSync(path.join(locations.configDir, 'agents.yaml'), '# kept\n')
  fs.chmodSync(paths.agents, 0o755)
  const second = await setup({ locations, codeDir: code, users: TEST_USERS, kvmGroup: TEST_KVM, services: false, proc })
  assert.match(second.done.join('\n'), /^Users: sct12-wacli, sct12-runner, sct12-mail were there; sct12-runner is in the sct12-kvm group\.$/m)
  assert.match(second.done.join('\n'), /^Folders: in \S+, 0 made, 1 given their owners and modes, 15 as they were; \S+ was there, and is left as it is\.$/m)
  assert.match(second.done.join('\n'), /^Env files: both were there, and are left as they are/m)
  assert.match(fs.readFileSync(runnerEnv, 'utf8'), /^OPENROUTER_API_KEY=kept$/m)
  assert.match(fs.readFileSync(path.join(locations.configDir, 'agents.yaml'), 'utf8'), /# kept\n$/)
  assert.equal(fs.statSync(paths.agents).mode & 0o777, 0o700)

  // Something in each folder, as a running Scooter leaves it.
  const secrets = {
    datastore: path.join(paths.datastore, 'log.jsonl'),
    agents: path.join(paths.agents, 'state.json'),
    exchange: path.join(paths.exchange, 'note'),
    runner: path.join(paths.runner, 'status.json'),
    bridge: path.join(paths.bridge, 'state.json'),
  }
  for (const file of Object.values(secrets)) fs.writeFileSync(file, 'secret', { mode: 0o600 })
  const tryRead = async (user, target) => {
    const script = `const fs = require('fs'); try { fs.statSync(${JSON.stringify(target)}).isDirectory() ? fs.readdirSync(${JSON.stringify(target)}) : fs.readFileSync(${JSON.stringify(target)}); console.log('read') } catch (error) { console.log(error.code) }`
    return (await proc.run(process.execPath, ['-e', script], { user, cwd: '/' })).stdout.trim()
  }
  // wacli and the email reader, as their users, can't read the datastore, the agents, the
  // exchange, the runner's folder or the bridge's, nor anything in them; nor either env file.
  for (const part of ['wacli', 'mail']) {
    for (const [name, file] of Object.entries(secrets)) {
      assert.equal(await tryRead(ids[part], path.join(paths.dataDir, name)), 'EACCES', `${part} reading ${name}`)
      assert.equal(await tryRead(ids[part], file), 'EACCES', `${part} reading ${file}`)
    }
    for (const file of ['bridge.env', 'runner.env']) assert.equal(await tryRead(ids[part], path.join(locations.envDir, file)), 'EACCES', `${part} reading ${file}`)
    // Each reaches its own folder.
    assert.equal(await tryRead(ids[part], part === 'wacli' ? paths.wacliStore : paths.mailSpool), 'read', part)
  }
  // The runner reads its own env file and not the bridge's, the datastore by its group, and the
  // config; the bridge, as root, reads its own.
  assert.equal(await tryRead(ids.runner, path.join(locations.envDir, 'runner.env')), 'read')
  assert.equal(await tryRead(ids.runner, path.join(locations.envDir, 'bridge.env')), 'EACCES')
  assert.equal(await tryRead(ids.runner, secrets.bridge), 'EACCES')
  assert.equal(await tryRead(ids.runner, paths.datastore), 'read')
  assert.equal(await tryRead(ids.runner, path.join(locations.configDir, 'skills', 'expenses', 'SKILL.md')), 'read')
  // Each side loads its own file as its service does.
  const settingsEnv = { SCOOTER_ENV_DIR: locations.envDir, OWNER_NUMBER: '+919812345678' }
  assert.equal(loadSettings('bridge', { env: settingsEnv }).dataDir, locations.dataDir)
  const runnerLoad = `import(${JSON.stringify(path.join(code, 'src', 'common', 'settings.mjs'))}).then(({ loadSettings }) => { const s = loadSettings('runner', { env: { SCOOTER_ENV_DIR: ${JSON.stringify(locations.envDir)} } }); console.log(s.dataDir, s.openrouterApiKey) })`
  assert.equal((await proc.run(process.execPath, ['-e', runnerLoad], { user: ids.runner, cwd: '/' })).stdout.trim(), `${locations.dataDir} kept`)
  assert.throws(() => loadSettings('bridge', { env: { SCOOTER_ENV_DIR: locations.envDir } }), SettingsError)
})
