// `scooter setup`: a native install on Linux (8.4 and 8.5 of DESIGN.md; ARCHITECTURE.md 6).
//
// Run as root, from the code's own folder, with the Node the services will run:
//
//   sudo node /opt/scooter/src/cli.mjs setup      the first time, before `scooter` is there
//   sudo scooter setup [--no-services]            afterwards
//
// In order, each step safe to repeat:
// 1. **Check**, before anything is made: root; systemd, unless `--no-services`; a Node ≥ 22.19
//    that every service user can run, and the code in a folder they can read, both changed by root
//    alone (row 16); and env files, if they are there already, that name the data and config
//    folders setup makes.
// 2. **Users:** `scooter-wacli`, `scooter-runner` and `scooter-mail`, system users without a login
//    shell or a home; `scooter-runner` in the `kvm` group (row 4).
// 3. **Folders:** the data folder and its folders, with the owners and modes of 3.2, and the
//    config folder, copied from the code's `config/` if it isn't there.
// 4. **Env files:** `bridge.env` and `runner.env`, from the examples, with `DATA_DIR` and
//    `CONFIG_DIR` filled in, if they aren't there. Never written over.
// 5. **Command:** `/usr/local/bin/scooter`, which runs the code's `src/cli.mjs` with this Node.
// 6. **Services:** the two units of `deploy/systemd/`, installed and enabled, and not started: the
//    env files may still be empty. `--no-services` leaves this step out, for a container or a test,
//    where systemd isn't running.
//
// As root, in folders other users own, setup makes only what is missing, and sets owners and
// modes through a descriptor that follows no link (`settleFolder`, D206); what is already there
// inside them is theirs, and left alone.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TMP_PREFIX, ensureDir, settleFolder, writeFileAtomic } from '../common/files.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc, findProgram } from '../common/proc.mjs'
import { parseEnvFile } from '../common/settings.mjs'

// Where a native install keeps everything (8.5).
export const NATIVE = {
  dataDir: '/var/lib/scooter',
  envDir: '/etc/scooter',
  configDir: '/etc/scooter/config',
  binDir: '/usr/local/bin',
  unitDir: '/etc/systemd/system',
}

// Scooter's users, by their part (3.2; row 4). Tests give names of their own, so they never touch
// an install's.
export const USERS = { wacli: 'scooter-wacli', runner: 'scooter-runner', mail: 'scooter-mail' }
export const KVM_GROUP = 'kvm'

// The units of `deploy/systemd/`, which run `<binDir>/scooter`.
export const UNITS = ['scooter-bridge.service', 'scooter-runner.service']

// The oldest Node Scooter runs on (8.5; `package.json`).
export const NODE_MIN = [22, 19]

// The code's own folder: the one that holds `src/`.
export const CODE_DIR = fileURLToPath(new URL('../..', import.meta.url))

const ROOT = { uid: 0, gid: 0 }

// Setup can't go on as the machine is, or as it was called. `scooter setup` exits with 2.
export class SetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SetupError'
  }
}

// ---------------------------------------------------------------------------------------------
// Step 1: the checks

// What is wrong with a Node version such as `22.23.2`, or null.
export function nodeVersionProblem(version) {
  const [major, minor] = version.split('.').map(Number)
  const [needMajor, needMinor] = NODE_MIN
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null
  return `Node ${version} is too old: Scooter needs ${needMajor}.${needMinor} or later`
}

const octal = mode => `0${(mode & 0o7777).toString(8)}`

// What keeps every user from reaching `target`, and only root from changing it: each folder above
// it must be searchable by everyone, and root's, and writable by nobody else, unless it is sticky,
// as `/tmp` is, where nobody else can rename what is root's. `owner` is a uid trusted as root is,
// for tests, which can't make files of root's. Returns statements that name a path.
export function pathProblems(target, { owner = 0 } = {}) {
  const problems = []
  const folders = []
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    folders.unshift(current)
    if (current === path.dirname(current)) break
  }
  for (const folder of folders) {
    const stat = fs.statSync(folder)
    if ((stat.mode & 0o001) === 0) problems.push(`${folder} can't be passed through by other users (mode ${octal(stat.mode)})`)
    problems.push(...writerProblems(folder, stat, owner, { sticky: true }))
  }
  return problems
}

// What lets a user other than root change `file`: its owner, or its mode.
function writerProblems(file, stat, owner, { sticky = false } = {}) {
  if (stat.uid !== 0 && stat.uid !== owner) return [`${file} belongs to uid ${stat.uid}, not root`]
  if ((stat.mode & 0o022) !== 0 && !(sticky && (stat.mode & 0o1000) !== 0)) return [`${file} can be written by users other than root (mode ${octal(stat.mode)})`]
  return []
}

// What is wrong with the Node at `node` for the services (row 16): it must be a version Scooter
// runs on, at a path every user can reach, and changed by root alone, since the bridge runs it as
// root. Returns statements.
export function nodeProblems(node, { version = process.versions.node, owner = 0 } = {}) {
  const problems = []
  const tooOld = nodeVersionProblem(version)
  if (tooOld) problems.push(tooOld)
  const real = fs.realpathSync(node)
  problems.push(...pathProblems(real, { owner }))
  const stat = fs.statSync(real)
  if ((stat.mode & 0o001) === 0) problems.push(`${real} can't be run by other users (mode ${octal(stat.mode)})`)
  problems.push(...writerProblems(real, stat, owner))
  return problems
}

// The most problems the check of the code lists; the rest are counted.
const LISTED_MAX = 10

// What is wrong with the code in `dir` for the services (row 16): every service user must be able
// to read it, and only root change it, since the bridge runs it as root. Every folder above it and
// in it is checked, and every file in it but under `.git`; a link is taken as it is. Its
// dependencies must be installed. Returns statements.
export function codeProblems(dir, { owner = 0 } = {}) {
  const problems = pathProblems(dir, { owner })
  let more = 0
  const note = problem => (problems.length < LISTED_MAX ? problems.push(problem) : more++)
  const folders = [dir]
  while (folders.length > 0) {
    const folder = folders.pop()
    const stat = fs.lstatSync(folder)
    if ((stat.mode & 0o005) !== 0o005) note(`${folder} can't be read by other users (mode ${octal(stat.mode)})`)
    for (const problem of writerProblems(folder, stat, owner)) note(problem)
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const inner = path.join(folder, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!(folder === dir && entry.name === '.git')) folders.push(inner)
        continue
      }
      const file = fs.lstatSync(inner)
      if ((file.mode & 0o004) === 0) note(`${inner} can't be read by other users (mode ${octal(file.mode)})`)
      for (const problem of writerProblems(inner, file, owner)) note(problem)
    }
  }
  if (more > 0) problems.push(`and ${more} more like these`)
  let dependencies = {}
  try {
    dependencies = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies ?? {}
  } catch (error) {
    problems.push(`${path.join(dir, 'package.json')} can't be read (${error.code ?? error.name})`)
  }
  const missing = Object.keys(dependencies).filter(name => !fs.existsSync(path.join(dir, 'node_modules', name, 'package.json')))
  if (missing.length > 0) problems.push(`${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} installed: run npm ci --omit=dev --ignore-scripts in ${dir}`)
  return problems
}

// What is wrong with an env file that is there already: it must name the data and config folders
// setup makes, since setup never writes over it, and a service reading it would otherwise use other
// folders, `/data` and `/config` when it names none. Returns statements.
export function envFileProblems(file, { dataDir, configDir }) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    return [`${file} can't be read (${error.code ?? error.name})`]
  }
  const { values, problems } = parseEnvFile(text)
  if (problems.length > 0) return problems.map(problem => `${file}, line ${problem.line}: ${problem.message}`)
  const found = []
  for (const [name, want] of [
    ['DATA_DIR', dataDir],
    ['CONFIG_DIR', configDir],
  ]) {
    const value = values.get(name)?.trim()
    if (value === want) continue
    const now = value ? `sets ${name} to ${value}` : `doesn't set ${name}`
    found.push(`${file} ${now}, where setup keeps it in ${want}: set ${name}=${want} there, or remove the file to have setup write it`)
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// The decisions

// The folders of 3.2 in the data folder, each `{ path, owner, mode }`, in the order they are made,
// for the users' `{ uid, gid }`, `ids.wacli`, `ids.runner` and `ids.mail`, and root's, `ids.root`,
// which tests give as their own. `inside` marks a folder in a folder another user owns: setup makes
// it if it is missing, and leaves it alone otherwise. `doctor` checks the same folders.
export function dataFolders(paths, ids) {
  const { runner, wacli, mail, root = ROOT } = ids
  const of = (folder, owner, mode, inside = false) => ({ path: folder, owner, mode, inside })
  return [
    // Every service user passes through it to its own; only root writes it, which `build-image`
    // checks (D151).
    of(paths.dataDir, root, 0o755),
    // Root's, with the runner's group, so the runner reads it and only the bridge writes it.
    of(paths.datastore, { uid: root.uid, gid: runner.gid }, 0o750),
    of(paths.agents, runner, 0o700),
    of(paths.exchange, runner, 0o700),
    // The runner's, so that neither the runner nor the bridge finds one the other made (D108, D184).
    of(paths.outbox, runner, 0o700, true),
    of(paths.locks, runner, 0o700, true),
    of(paths.runner, runner, 0o700),
    of(paths.bridge, root, 0o700),
    of(paths.wacli, wacli, 0o700),
    // wacli's home, store, staging and XDG folders (5.1), which the bridge otherwise makes.
    ...[paths.wacliStore, paths.wacliStaging, paths.wacliConfig, paths.wacliState, paths.wacliCache].map(folder => of(folder, wacli, 0o700, true)),
    of(paths.mail, mail, 0o700),
    of(paths.mailSpool, mail, 0o700, true),
  ]
}

// The owner and modes of the copy of `config/`: root's, readable by the runner alone (3.2).
export function configOwner(ids) {
  return { owner: { uid: 0, gid: ids.runner.gid }, folderMode: 0o750, fileMode: 0o640 }
}

// The env files, each `{ side, file, owner }`: `bridge.env` root's, `runner.env` the runner's,
// both 0600 (8.2).
export function envFiles(envDir, ids) {
  return [
    { side: 'bridge', file: path.join(envDir, 'bridge.env'), owner: ROOT },
    { side: 'runner', file: path.join(envDir, 'runner.env'), owner: ids.runner },
  ]
}

// An example env file's text with `DATA_DIR` and `CONFIG_DIR` filled in: the lines that give them
// as comments become settings. Throws if the example has no such lines.
export function envFileText(example, { dataDir, configDir }) {
  let text = example
  for (const [name, value] of [
    ['DATA_DIR', dataDir],
    ['CONFIG_DIR', configDir],
  ]) {
    const line = new RegExp(`^# ${name}=.*$`, 'm')
    if (!line.test(text)) throw new Error(`the example env file has no line "# ${name}=…" to fill in`)
    text = text.replace(line, `${name}=${envValue(value)}`)
  }
  return text
}

// A value as an env file holds it (`settings.mjs`): as it is, or in single quotes when it has a
// character that needs them.
function envValue(value) {
  if (value.includes("'") || value.includes('\n')) throw new SetupError(`${value} can't be written in an env file`)
  return /[$\\"#\s]/.test(value) ? `'${value}'` : value
}

// A word as the shell reads it, in single quotes.
function shellWord(word) {
  if (word.includes("'")) throw new SetupError(`${word} can't be written in the scooter command: it has a single quote`)
  return `'${word}'`
}

// The text of `<binDir>/scooter`: it runs the code's `src/cli.mjs` with `node`. It `exec`s Node,
// so that Node is the bridge's main process, and a signal for the bridge reaches it (D196).
export function wrapperText({ node, cli }) {
  return [
    '#!/bin/sh',
    '# Scooter\'s command, written by `scooter setup`, which writes it again each time it runs.',
    `exec ${shellWord(node)} ${shellWord(cli)} "$@"`,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// The steps

// Makes or sets one folder of `dataFolders`. Returns `made`, `set` or `kept`.
function applyFolder({ path: folder, owner, mode, inside }, { follow = false } = {}) {
  let stat
  try {
    stat = follow ? fs.statSync(folder) : fs.lstatSync(folder)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    fs.mkdirSync(folder, { mode })
    settleFolder(folder, { mode, owner })
    return 'made'
  }
  if (inside) return 'kept'
  if (!stat.isDirectory()) throw new SetupError(`${folder} isn't a folder: move it aside, and run setup again`)
  if (stat.uid === owner.uid && stat.gid === owner.gid && (stat.mode & 0o7777) === mode) return 'kept'
  if (follow) {
    // The data folder itself may be a link the owner made, to another disk: it, and the folder it
    // is in, are root's.
    fs.chownSync(folder, owner.uid, owner.gid)
    fs.chmodSync(folder, mode)
  } else {
    settleFolder(folder, { mode, owner })
  }
  return 'set'
}

// Copies the folder `source` into `target`, which must not exist, with `owner` and the modes
// given: through a temporary folder beside it, renamed into place once complete, so a copy cut
// short is never taken for the config. A link in `source` is refused.
function copyFolder(source, target, { owner, folderMode, fileMode }) {
  const tmp = path.join(path.dirname(target), `${TMP_PREFIX}${path.basename(target)}-${process.pid}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  const copy = (from, to) => {
    fs.mkdirSync(to, { mode: folderMode })
    settleFolder(to, { mode: folderMode, owner })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const inner = path.join(from, entry.name)
      if (entry.isDirectory()) copy(inner, path.join(to, entry.name))
      else if (entry.isFile()) writeFileAtomic(path.join(to, entry.name), fs.readFileSync(inner), { mode: fileMode, owner })
      else throw new SetupError(`${inner} is neither a file nor a folder, and isn't copied`)
    }
  }
  try {
    copy(source, tmp)
    fs.renameSync(tmp, target)
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw error
  }
}

// Writes `text` to `file` if nothing is there, with `mode` and `owner`. Returns false when
// something is there already, which is left as it is.
function writeNewFile(file, text, { mode, owner }) {
  const tmp = path.join(path.dirname(file), `${TMP_PREFIX}${path.basename(file)}-${process.pid}`)
  fs.rmSync(tmp, { force: true })
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    fs.writeFileSync(fd, text)
    fs.fchmodSync(fd, mode)
    fs.fchownSync(fd, owner.uid, owner.gid)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(tmp, file)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

// Sets the owner and mode of a file that is there already, through a descriptor that follows no
// link. Throws a `SetupError` for what isn't a regular file.
function settleFile(file, { mode, owner }) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    if (error.code === 'ELOOP') throw new SetupError(`${file} is a link: make it a file, and run setup again`)
    throw error
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new SetupError(`${file} isn't a file: move it aside, and run setup again`)
    fs.fchmodSync(fd, mode)
    fs.fchownSync(fd, owner.uid, owner.gid)
  } finally {
    fs.closeSync(fd)
  }
}

// Where the programs setup runs are: `useradd`, `usermod` and `systemctl` are often in a folder
// only root's `PATH` has.
const SBIN_PATH = `${process.env.PATH ?? ''}${path.delimiter}/usr/sbin${path.delimiter}/sbin${path.delimiter}/usr/bin${path.delimiter}/bin`

// The shell setup gives its users: none they can log in with.
function noLoginShell() {
  for (const shell of ['/usr/sbin/nologin', '/sbin/nologin']) if (fs.existsSync(shell)) return shell
  return '/bin/false'
}

// Sets Scooter up on this machine (see the top of this file). Returns the lines it reports, as
// `{ done, next }`. Throws a `SetupError` when a check fails, before anything is made.
//
// - `locations`: `NATIVE`, or a test's own folders: `{ dataDir, envDir, configDir, binDir, unitDir }`.
// - `codeDir`, `node`: the code, and the Node that runs it, which `<binDir>/scooter` uses.
// - `users`, `kvmGroup`: names; tests give their own.
// - `services`: false for `--no-services`.
// - `isRoot`, `systemd`: whether this process is root, and systemd runs the machine.
// - `proc`: what `createProc` returns.
export async function setup({ locations = NATIVE, codeDir = CODE_DIR, node = process.execPath, users = USERS, kvmGroup = KVM_GROUP, services = true, isRoot = process.getuid?.() === 0, systemd = fs.existsSync('/run/systemd/system'), proc }) {
  const { dataDir, envDir, configDir, binDir, unitDir } = locations
  const done = []

  // 1. The checks.
  if (!isRoot) throw new SetupError('setup makes users, folders and services, so it runs as root: sudo scooter setup')
  if (services && !systemd) throw new SetupError("systemd isn't running this machine, so the services can't be installed: run setup with --no-services, and start `scooter bridge` and `scooter runner` some other way")
  const code = fs.realpathSync(codeDir)
  const cli = path.join(code, 'src', 'cli.mjs')
  const problems = [
    ...nodeProblems(node).map(problem => `Node: ${problem}`),
    ...codeProblems(code).map(problem => `the code: ${problem}`),
    ...['bridge', 'runner'].flatMap(side => envFileProblems(path.join(envDir, `${side}.env`), { dataDir, configDir })),
  ]
  if (problems.length > 0) {
    throw new SetupError(
      [
        "setup checks that Scooter's users can run Node and read the code, which only root may change, as in /opt/scooter with a Node installed for the whole system (8.5), and stopped:",
        ...problems.map(problem => `- ${problem}`),
      ].join('\n'),
    )
  }
  done.push(`Checked: root${services ? ', systemd' : ''}, Node ${process.versions.node} at ${fs.realpathSync(node)}, and the code in ${code}.`)

  // 2. The users.
  const env = { PATH: SBIN_PATH }
  const runAt = async (program, args) => {
    const found = findProgram(program, SBIN_PATH)
    if (found === null) throw new Error(`${program} isn't installed`)
    const result = await proc.run(found, args, { env })
    if (result.code !== 0) throw new Error(`${program} ${args[0]} failed with exit code ${result.code}: ${result.stderr.trim().split('\n').at(-1) ?? ''}`)
    return result
  }
  const made = []
  for (const name of Object.values(users)) {
    if ((await proc.findUser(name)) !== null) continue
    await runAt('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', noLoginShell(), '--comment', 'Scooter', '--', name])
    made.push(name)
  }
  const ids = {}
  for (const [part, name] of Object.entries(users)) {
    ids[part] = await proc.findUser(name)
    if (ids[part] === null) throw new Error(`the user ${name} can't be found after it was made`)
  }
  let kvm
  if ((await proc.findGroup(kvmGroup)) === null) {
    kvm = `there is no ${kvmGroup} group on this machine, so pi's VMs will run under emulation; \`sudo -u ${users.runner} scooter doctor\` says how to enable KVM, and setup, run again, adds ${users.runner} to the group`
  } else {
    const groups = await runAt('id', ['-nG', '--', users.runner])
    if (groups.stdout.trim().split(/\s+/).includes(kvmGroup)) {
      kvm = `${users.runner} is in the ${kvmGroup} group`
    } else {
      await runAt('usermod', ['--append', '--groups', kvmGroup, '--', users.runner])
      kvm = `${users.runner} is now in the ${kvmGroup} group`
    }
  }
  done.push(`Users: ${made.length > 0 ? `made ${made.join(', ')}` : `${Object.values(users).join(', ')} were there`}; ${kvm}.`)

  // 3. The folders.
  const paths = makePaths({ dataDir, configDir })
  ensureDir(path.dirname(dataDir), { mode: 0o755 })
  const counts = { made: 0, set: 0, kept: 0 }
  for (const folder of dataFolders(paths, ids)) counts[applyFolder(folder, { follow: folder.path === paths.dataDir })] += 1
  ensureDir(envDir, { mode: 0o755 })
  applyFolder({ path: envDir, owner: ROOT, mode: 0o755 }, { follow: true })
  let config
  if (fs.existsSync(configDir)) {
    config = `${configDir} was there, and is left as it is`
  } else {
    ensureDir(path.dirname(configDir), { mode: 0o755 })
    copyFolder(path.join(code, 'config'), configDir, configOwner(ids))
    config = `${configDir} copied from ${path.join(code, 'config')}`
  }
  done.push(`Folders: in ${dataDir}, ${counts.made} made, ${counts.set} given their owners and modes, ${counts.kept} as they were; ${config}.`)

  // 4. The env files.
  const written = []
  for (const { side, file, owner } of envFiles(envDir, ids)) {
    const text = envFileText(fs.readFileSync(path.join(code, `${side}.env.example`), 'utf8'), { dataDir, configDir })
    if (writeNewFile(file, text, { mode: 0o600, owner })) written.push(file)
    else settleFile(file, { mode: 0o600, owner })
  }
  done.push(`Env files: ${written.length > 0 ? `wrote ${written.join(' and ')}` : 'both were there, and are left as they are'}; each is its service's, mode 0600.`)

  // 5. The command.
  ensureDir(binDir, { mode: 0o755 })
  const command = path.join(binDir, 'scooter')
  writeFileAtomic(command, wrapperText({ node: fs.realpathSync(node), cli }), { mode: 0o755, owner: ROOT })
  done.push(`Command: ${command} runs ${cli} with ${fs.realpathSync(node)}.`)

  // 6. The services.
  if (services) {
    for (const unit of UNITS) writeFileAtomic(path.join(unitDir, unit), fs.readFileSync(path.join(code, 'deploy', 'systemd', unit)), { mode: 0o644, owner: ROOT })
    await runAt('systemctl', ['daemon-reload'])
    await runAt('systemctl', ['enable', ...UNITS])
    done.push(`Services: ${UNITS.join(' and ')} installed in ${unitDir} and enabled, so they start when the machine does; not started now.`)
  } else {
    done.push('Services: not installed (--no-services).')
  }

  const bridgeEnv = path.join(envDir, 'bridge.env')
  const runnerEnv = path.join(envDir, 'runner.env')
  const next = [
    'Next:',
    `1. Fill in ${bridgeEnv} (OWNER_NUMBER, and the mailbox and backups if you use them) and ${runnerEnv} (OPENROUTER_API_KEY).`,
    '2. Build the VM image pi runs in: sudo scooter build-image',
    "3. Link WhatsApp to the bot's number: sudo scooter pair",
    services ? '4. Start Scooter: sudo systemctl start scooter-bridge scooter-runner' : '4. Start `scooter bridge` as root, and `scooter runner` as scooter-runner, under something that stops each one\'s whole process group.',
    `5. Check what the runner needs: sudo -u ${users.runner} scooter doctor`,
  ]
  return { done, next }
}

// `scooter setup [--no-services]`: sets Scooter up natively (8.4). Exits with 2 when a check fails
// or it was called wrongly, and with 1 when a step fails.
export async function runSetup({ args = [], stdout = process.stdout, stderr = process.stderr }) {
  const services = !args.includes('--no-services')
  const unknown = args.filter(arg => arg !== '--no-services')
  if (unknown.length > 0) {
    stderr.write(`scooter setup: it takes only --no-services, not ${unknown.join(' ')}\n`)
    return 2
  }
  const log = createLog({ component: 'setup' })
  const proc = createProc({ log })
  try {
    const { done, next } = await setup({ services, proc })
    stdout.write(`${[...done, '', ...next].join('\n')}\n`)
    return 0
  } catch (error) {
    if (error instanceof SetupError) {
      stderr.write(`scooter setup: ${error.message}\n`)
      return 2
    }
    log.error('setup.failed', errorFields(error))
    stderr.write(`scooter setup: ${error.message}\n`)
    return 1
  }
}
