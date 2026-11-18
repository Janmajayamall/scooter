// The command table of 8.4 of DESIGN.md, and that each command loads one side only.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { COMMANDS, main } from '../src/cli.mjs'
import { makeTestDir } from './support/tmp.mjs'

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

// Runs `main` and collects what it prints.
async function run(argv, options = {}) {
  let out = ''
  let err = ''
  const code = await main(argv, {
    env: { SCOOTER_ENV_DIR: '/nonexistent' },
    stdout: { write: text => (out += text) },
    stderr: { write: text => (err += text) },
    ...options,
  })
  return { code, out, err }
}

test('cli: the commands of 8.4, each with its side', () => {
  const sides = Object.fromEntries(Object.entries(COMMANDS).map(([name, command]) => [name, command.side]))
  assert.deepEqual(sides, {
    bridge: 'bridge',
    runner: 'runner',
    setup: 'host',
    doctor: 'runner',
    'build-image': 'host',
    pair: 'bridge',
    'email-check': 'bridge',
    'backup-init': 'bridge',
    snapshots: 'bridge',
    check: 'bridge',
    restore: 'bridge',
    rebuild: 'runner',
  })
  for (const [name, command] of Object.entries(COMMANDS)) {
    assert.ok(command.usage.startsWith(name), name)
    assert.ok(command.summary.length > 0, name)
  }
})

test('cli: help lists every command', async () => {
  for (const flag of ['--help', '-h', 'help']) {
    const { code, out, err } = await run([flag])
    assert.equal(code, 0)
    assert.equal(err, '')
    for (const command of Object.values(COMMANDS)) assert.ok(out.includes(`  ${command.usage}`), command.usage)
  }
})

test('cli: no command, or one that does not exist, is a usage error', async () => {
  const none = await run([])
  assert.equal(none.code, 2)
  assert.equal(none.out, '')
  assert.match(none.err, /^Usage: scooter <command>/)

  const unknown = await run(['frobnicate'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.err, /^scooter: no such command: frobnicate\n\nUsage:/)
  // A name every object has is not a command.
  assert.equal((await run(['constructor'])).code, 2)
})

test('cli: a command that is not built yet says so', async () => {
  for (const name of Object.keys(COMMANDS)) {
    if (COMMANDS[name].load) continue
    const { code, err } = await run([name])
    assert.equal(code, 1, name)
    assert.equal(err, `scooter ${name}: this command isn't built yet\n`)
  }
})

test('cli: a command gets its own side\'s settings and nothing of the other\'s', async t => {
  const dir = makeTestDir(t)
  fs.writeFileSync(path.join(dir, 'bridge.env'), 'OWNER_NUMBER=+919812345678\nDATA_DIR=/srv/data\n')
  fs.writeFileSync(path.join(dir, 'runner.env'), 'OPENROUTER_API_KEY=sk-or-v1-runner\nDATA_DIR=/srv/data\n')
  const seen = []
  const command = side => ({
    side,
    usage: `${side}-thing`,
    where: side,
    summary: 'A test command',
    load: async () => context => {
      seen.push(context)
    },
  })
  const commands = { 'bridge-thing': command('bridge'), 'runner-thing': command('runner'), 'host-thing': command('host') }
  const options = { env: { SCOOTER_ENV_DIR: dir }, commands }

  assert.equal((await run(['bridge-thing', '--flag', 'value'], options)).code, 0)
  assert.equal((await run(['runner-thing'], options)).code, 0)
  assert.equal((await run(['host-thing'], options)).code, 0)

  const [bridge, runner, host] = seen
  assert.deepEqual(bridge.args, ['--flag', 'value'])
  assert.equal(bridge.settings.side, 'bridge')
  assert.equal(bridge.settings.ownerNumber, '919812345678')
  assert.ok(!JSON.stringify(bridge.settings).includes('sk-or-v1-runner'))
  assert.equal(runner.settings.side, 'runner')
  assert.equal(runner.settings.openrouterApiKey, 'sk-or-v1-runner')
  assert.ok(!JSON.stringify(runner.settings).includes('919812345678'))
  // The two commands root runs on the machine itself load neither side's settings.
  assert.equal(host.settings, null)

  // The other side's file is never read: with it broken, the command still runs.
  fs.writeFileSync(path.join(dir, 'runner.env'), 'not an env file')
  assert.equal((await run(['bridge-thing'], options)).code, 0)
  assert.equal((await run(['runner-thing'], options)).code, 2)
})

test('cli: a settings fault stops the command before its code is loaded, and names the variable', async () => {
  let loaded = false
  const commands = {
    runner: {
      side: 'runner',
      usage: 'runner',
      where: 'runner',
      summary: 'Run the runner',
      load: async () => {
        loaded = true
        return () => 0
      },
    },
  }
  const { code, out, err } = await run(['runner'], { env: { SCOOTER_ENV_DIR: '/nonexistent', AGENT_ACCEL: 'fast' }, commands })
  assert.equal(code, 2)
  assert.equal(out, '')
  assert.equal(err, 'scooter runner: OPENROUTER_API_KEY is required\nscooter runner: AGENT_ACCEL must be auto, kvm, emulation or hvf\n')
  assert.equal(loaded, false)
})

test('cli: a command\'s result is the exit code', async () => {
  const commands = {
    fails: { side: 'host', usage: 'fails', where: 'the host', summary: 'Fails', load: async () => async () => 3 },
    prints: {
      side: 'host',
      usage: 'prints',
      where: 'the host',
      summary: 'Prints',
      load: async () => ({ stdout }) => {
        stdout.write('hello\n')
      },
    },
  }
  assert.equal((await run(['fails'], { commands })).code, 3)
  assert.deepEqual(await run(['prints'], { commands }), { code: 0, out: 'hello\n', err: '' })
})

test('cli: run as a program, directly and through a link', async t => {
  const exec = promisify(execFile)
  const env = { PATH: process.env.PATH, SCOOTER_ENV_DIR: '/nonexistent' }
  const help = await exec(process.execPath, [CLI, '--help'], { env })
  assert.match(help.stdout, /^Usage: scooter <command>/)

  // The file is executable and starts Node itself, as the `bin` entry of package.json needs.
  assert.ok(fs.statSync(CLI).mode & 0o111)
  const dir = makeTestDir(t)
  const link = path.join(dir, 'scooter')
  fs.symlinkSync(CLI, link)
  const linked = await exec(link, ['help'], { env })
  assert.equal(linked.stdout, help.stdout)

  // A bridge command, without the bridge's settings, says what is missing.
  await assert.rejects(exec(link, ['pair'], { env }), error => {
    assert.equal(error.code, 2)
    assert.equal(error.stderr, 'scooter pair: OWNER_NUMBER is required\n')
    return true
  })
  await assert.rejects(exec(link, [], { env }), error => error.code === 2)
})

test('cli: package.json points at it', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.engines.node, '>=22.19')
  assert.deepEqual(pkg.bin, { scooter: 'src/cli.mjs' })
  // The four libraries, pinned to exact versions (4.3 of ARCHITECTURE.md), and nothing else.
  assert.deepEqual(pkg.dependencies, {
    '@earendil-works/gondolin': '0.14.0',
    imapflow: '2.11.0',
    'postal-mime': '4.2.1',
    yaml: '2.9.1',
  })
  assert.equal(pkg.devDependencies, undefined)
  const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version, name)
  }
})
