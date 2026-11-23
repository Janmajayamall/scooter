// The CLI's table of commands, and that each command loads one side only.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { COMMANDS, main } from '../src/cli.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { inDocker } from '../src/common/proc.mjs'
import { isRoot } from './support/root.mjs'
import { line, writeConfig, writeDatastore } from './support/runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

// A native install of the runner's, in the test's folder, for a CLI command that runs as the
// runner's user only:
// - `runnerUser(uid)`: `scooter-runner` is a user at `uid`, or there is none with null, as `id`
//   tells the CLI: a stand-in for `id`, first on Scooter's PATH while the test runs, that knows no
//   other user.
// - `envFile(readable)`: `runner.env`, with the runner's settings, which only the runner's user can
//   read, as `setup` leaves it, 0600 and its own: unreadable, mode 0. Root reads a file of any mode,
//   so as root a folder stands in its place, which no one can read as a file.
// - `env`: the environment to run the command with, and `files()`, every name in the test's folder.
function nativeInstall(t) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const bin = path.join(root, 'bin')
  const envDir = path.join(root, 'etc')
  fs.mkdirSync(bin)
  fs.mkdirSync(envDir)
  const before = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${before}`
  atEnd(t, () => {
    process.env.PATH = before
  })
  const runnerUser = uid => {
    const answer = uid === null ? 'exit 1' : `[ "$3" = scooter-runner ] || exit 1\necho ${uid}`
    fs.writeFileSync(path.join(bin, 'id'), `#!/bin/sh\n${answer}\n`)
    fs.chmodSync(path.join(bin, 'id'), 0o755)
  }
  const file = path.join(envDir, 'runner.env')
  const envFile = readable => {
    fs.rmSync(file, { recursive: true, force: true })
    if (isRoot && !readable) {
      fs.mkdirSync(file)
    } else {
      fs.writeFileSync(file, `OPENROUTER_API_KEY=sk-or-v1-runner\nDATA_DIR=${paths.dataDir}\nCONFIG_DIR=${paths.configDir}\n`)
      fs.chmodSync(file, readable ? 0o600 : 0o000)
    }
  }
  const files = () => fs.readdirSync(root, { recursive: true }).sort()
  return { paths, runnerUser, envFile, file, env: { SCOOTER_ENV_DIR: envDir }, files, unreadable: isRoot ? 'EISDIR' : 'EACCES' }
}

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

test('cli: the CLI\'s commands, each with its side', () => {
  const sides = Object.fromEntries(Object.entries(COMMANDS).map(([name, command]) => [name, command.side]))
  assert.deepEqual(sides, {
    bridge: 'bridge',
    runner: 'runner',
    setup: 'host',
    doctor: 'runner',
    'build-image': 'host',
    pair: 'bridge',
    'email-check': 'bridge',
    status: 'bridge',
    'backup-init': 'bridge',
    snapshots: 'bridge',
    check: 'bridge',
    restore: 'bridge',
    backfill: 'runner',
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

test("cli: backfill looks at who runs it before the runner's settings are read: another user, who can't read runner.env, is refused and told how to run it, nothing read or made", async t => {
  const { paths, runnerUser, envFile, file, env, files, unreadable } = nativeInstall(t)
  writeConfig(paths.configDir)
  fs.mkdirSync(paths.datastore, { recursive: true })
  writeDatastore(paths, [line.text(1, '2026-11-09T10:00:00Z', 'coffee 120')])
  const uid = process.getuid()
  const how = inDocker() ? 'docker compose run --rm runner backfill …' : 'sudo -u scooter-runner scooter backfill …'

  // Another user than the runner's, root among them: refused, exit 2, with the command to run, and
  // runner.env, which it can't read, not read; given no argument too, which would print the usage.
  runnerUser(uid + 1)
  envFile(false)
  const before = files()
  for (const args of [['lifelog', '--empty'], []]) {
    assert.deepEqual(await run(['backfill', ...args], { env }), {
      code: 2,
      out: '',
      err: `scooter backfill: backfill writes the job into the runner's folder, so it runs as scooter-runner, not as uid ${uid}: ${how}\n`,
    })
  }
  assert.deepEqual(files(), before)
  assert.equal(fs.existsSync(paths.agents), false)

  // As the runner's user, the settings are read after the look: one it can't read is said, and with
  // them it queues the job. So it does where there is no such user, as in development.
  runnerUser(uid)
  assert.deepEqual(await run(['backfill', 'lifelog'], { env }), {
    code: 2,
    out: '',
    err: `scooter backfill: ${file} can't be read (${unreadable})\nscooter backfill: OPENROUTER_API_KEY is required\n`,
  })
  envFile(true)
  const queued = await run(['backfill', 'lifelog'], { env })
  assert.equal(queued.code, 0, queued.err)
  assert.match(queued.out, /^Queued backfill \S+ of lifelog, from #1: /)
  runnerUser(null)
  assert.equal((await run(['backfill', 'lifelog'], { env })).code, 0)
  assert.equal(fs.readdirSync(paths.agentJobs('lifelog')).length, 2)
})

test("cli: doctor looks at who runs it before the runner's settings are read: another user, who can't read runner.env, is refused and told how to run it, nothing read or made", async t => {
  const { runnerUser, envFile, file, env, files, unreadable } = nativeInstall(t)
  const uid = process.getuid()
  const how = inDocker() ? 'docker compose run --rm runner doctor' : 'sudo -u scooter-runner scooter doctor'

  // Another user than the runner's, root among them: refused, exit 2, with the command to run, and
  // runner.env, which it can't read, not read.
  runnerUser(uid + 1)
  envFile(false)
  const before = files()
  assert.deepEqual(await run(['doctor'], { env }), {
    code: 2,
    out: '',
    err: `scooter doctor: doctor checks what the runner can reach, so it runs as scooter-runner, not as uid ${uid}: ${how}\n`,
  })
  assert.deepEqual(files(), before)

  // As the runner's user, and where there is no such user, as in development, the settings are read
  // after the look: one it can't read is said, before any check.
  for (const runner of [uid, null]) {
    runnerUser(runner)
    assert.deepEqual(await run(['doctor'], { env }), {
      code: 2,
      out: '',
      err: `scooter doctor: ${file} can't be read (${unreadable})\nscooter doctor: OPENROUTER_API_KEY is required\n`,
    })
  }
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
  // The four libraries, pinned to exact versions, and nothing else.
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
