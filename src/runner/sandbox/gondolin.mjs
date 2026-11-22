// The real sandbox: one Gondolin micro-VM for each run.
//
// `openGondolinSandbox` is the runner's `openSandbox`. At the runner's start, after it has freed
// what pi left, it:
// - gives the runner its home and temporary folder under `runner/`, where Gondolin keeps
//   its certificate authority, its list of running VMs, the VMs' disk overlays and their sockets,
//   and empties the temporary folder, which a runner that was killed leaves full;
// - checks the VM image: there, built for the pi version the build file pins, for this machine,
//   knowing the owner's time zone (`image.mjs`);
// - picks the accelerator (`accel.mjs`), and checks that QEMU is installed.
//
// `run(spec)` then boots a fresh VM from `runner/image/` for each run, with the spec's `files`
// mounted at the host's own path through the providers of `view.mjs`, which show the VM only what
// the run may read and let it change only what it may write, and Gondolin's own mount point moved
// off `/data`; runs the program from its argument list through `env -i`, so it gets the spec's
// environment and nothing else; and closes the VM on every path: when the program exits, at the
// timeout, when the runner stops, and when the run writes more than it may.
// Closing is what stops the program: aborting the command in Gondolin 0.14.0 doesn't.
//
// The network is the policy's (`policy.mjs`): it checks and logs every request the VM makes,
// and the key, which the VM sees only as a placeholder, is swapped in on requests to OpenRouter.
// Tests give one with the scripted fake model behind the policy, in OpenRouter's place.
//
// Only `src/runner/sandbox/` loads Gondolin, and this module loads it only
// once the runner's folders are set, because Gondolin fixes the folder of its list of running VMs
// when it loads.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { emptyFolder, ensureDir } from '../../common/files.mjs'
import { limits } from '../../common/limits.mjs'
import { errorFields } from '../../common/log.mjs'
import { findProgram } from '../../common/proc.mjs'
import { systemClock } from '../../common/time.mjs'
import { pickAccelerator } from './accel.mjs'
import { checkImage, machineArch, pinnedPiVersion, qemuProgram, readBuildFile } from './image.mjs'
import { GUEST_PATH, SandboxSetupError, checkRunSpec, createOutput } from './index.mjs'
import { policyNetwork } from './policy.mjs'
import { viewProvider } from './view.mjs'

// Where Gondolin's own file system goes in the VM, instead of `/data`, which is where Scooter's
// folders are in Docker. `/run` is a temporary file system of the VM's boot.
export const FUSE_MOUNT = '/run/gondolin-vfs'

// QEMU's machine for pi's VMs, with KVM and under emulation alike. Gondolin 0.14.0 gives
// x86_64 `microvm` with KVM, and `q35` under emulation; `microvm` hangs in the guest kernel's APIC
// setup under nested KVM with 2 processors, as in a VM of a cloud provider, where `q35` boots, and
// boots sooner on the machine itself too. On arm64 Gondolin's own choice, `virt`, stands.
export function machineType(arch = machineArch()) {
  return arch === 'x86_64' ? 'q35' : undefined
}

// The image's `env`, through which every command runs, so it gets exactly the spec's environment.
export const ENV_PROGRAM = '/usr/bin/env'

// A Unix socket's path can be at most 107 bytes. Gondolin puts five in the temporary folder, with
// names of up to 37 bytes, and one in its list of running VMs, named by a UUID.
const SOCKET_PATH_MAX_BYTES = 107
const TMP_SOCKET_NAME_BYTES = 37
const SESSION_SOCKET_NAME_BYTES = 41

// The placeholder the VM sees for a secret, new for each run. It is worth nothing outside the
// runner: Gondolin puts the secret in its place only on requests to the secret's hosts.
function placeholderFor(name) {
  return `scooter-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-placeholder-${crypto.randomBytes(24).toString('hex')}`
}

// Where Gondolin keeps its things: its certificate authority under the runner's home, which keeps
// it from one start to the next; and its list of running VMs, each with a socket, in the
// temporary folder, which a start empties, and where a socket's path is shortest.
// Whether Gondolin's sockets fit under `tmp`, as the runner's temporary folder: a socket's path
// can't be longer than the system takes.
export function socketsFit(tmp) {
  return Buffer.byteLength(tmp) + 1 + TMP_SOCKET_NAME_BYTES <= SOCKET_PATH_MAX_BYTES && Buffer.byteLength(path.join(tmp, 'sessions')) + 1 + SESSION_SOCKET_NAME_BYTES <= SOCKET_PATH_MAX_BYTES
}

export function gondolinFolders(paths) {
  const cache = path.join(paths.runnerHome, '.cache')
  return {
    cache,
    certificates: path.join(cache, 'gondolin', 'ssl'),
    sessions: path.join(paths.runnerTmp, 'sessions'),
  }
}

// An error for the guest: Gondolin sends its code back as the errno of the call.
function guestError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code, errno: 0 })
}

// What one run may still write through what it may change (`RUN_WRITE_MAX_BYTES`,
// `RUN_NAMES_MAX_COUNT`). Once either is passed, every later write or new name is refused with
// ENOSPC, and `over` is called once.
function createBudget(over) {
  let bytes = 0
  let names = 0
  let passed = null
  const refuse = what => {
    if (passed === null) {
      passed = what
      over(what)
    }
    throw guestError('ENOSPC', 'this run has written all it may')
  }
  return {
    get passed() {
      return passed
    },
    write(length) {
      if (passed !== null) refuse(passed)
      bytes += length
      if (bytes > limits.RUN_WRITE_MAX_BYTES) refuse('bytes')
    },
    name() {
      if (passed !== null) refuse(passed)
      names += 1
      if (names > limits.RUN_NAMES_MAX_COUNT) refuse('names')
    },
  }
}

// Gondolin's provider of `host`, which counts what is written through it against `budget`.
// Gondolin's hooks see every write and every open, folder and hard link; a symbolic link passes
// them by, so it is counted here. Only what the run may change reaches it to be counted
// (`view.mjs`).
function budgetedProvider(gondolin, host, budget) {
  const isNew = file => {
    try {
      fs.lstatSync(path.join(host, file))
      return false
    } catch {
      return true
    }
  }
  const before = context => {
    if (context.op === 'write') budget.write(context.length ?? 0)
    else if (context.op === 'mkdir' || context.op === 'link') budget.name()
    else if (context.op === 'open' && typeof context.flags === 'string' && /[wa]/.test(context.flags) && isNew(context.path)) budget.name()
  }
  class BudgetedProvider extends gondolin.SandboxVfsProvider {
    async symlink(target, file, type) {
      budget.name()
      return super.symlink(target, file, type)
    }
    symlinkSync(target, file, type) {
      budget.name()
      return super.symlinkSync(target, file, type)
    }
  }
  return new BudgetedProvider(new gondolin.RealFSProvider(host), { before })
}

// Gondolin's mounts for a spec's `files`: its root, at the host's own path, through the providers
// that show and let through only what the run may read and write (`view.mjs`).
function mountsOf(gondolin, files, budget) {
  return { [files.root]: viewProvider(gondolin, files, budgetedProvider(gondolin, files.root, budget)) }
}

// A stream that hands what is written to it to `collect`, as the output arrives.
function sink(collect) {
  return new Writable({
    write(chunk, _encoding, done) {
      collect(chunk)
      done()
    },
  })
}

// Opens the sandbox (see the top of this file). `network(policy, { placeholders })` gives, for a
// run, the options of Gondolin's `createHttpHooks` apart from the secrets, and may give `close()`,
// called once the run's VM has closed; it is the network policy unless a test gives another.
// `kvmDevice` is for tests.
export async function openGondolinSandbox({ paths, settings, log, clock = systemClock, network, kvmDevice }) {
  const folders = gondolinFolders(paths)
  if (Buffer.byteLength(paths.runnerTmp) + 1 + TMP_SOCKET_NAME_BYTES > SOCKET_PATH_MAX_BYTES) {
    throw new SandboxSetupError(`${paths.runnerTmp} is too long a path for the sockets Gondolin puts there: the data folder needs a shorter path`)
  }
  if (Buffer.byteLength(folders.sessions) + 1 + SESSION_SOCKET_NAME_BYTES > SOCKET_PATH_MAX_BYTES) {
    throw new SandboxSetupError(`${folders.sessions} is too long a path for the sockets Gondolin puts there: the data folder needs a shorter path`)
  }

  const pinned = pinnedPiVersion(readBuildFile(paths.imageBuild), paths.imageBuild)
  const image = checkImage({ dir: paths.runnerImage, pinned, timeZone: settings.timeZone })
  const accel = pickAccelerator(settings.agentAccel, kvmDevice ? { device: kvmDevice } : {})
  for (const program of [qemuProgram(), 'qemu-img']) {
    if (findProgram(program) === null) throw new SandboxSetupError(`QEMU isn't installed: ${program} isn't on the PATH`)
  }

  // The runner's home and temporary folder. Gondolin reads them from the process's
  // environment, the temporary folder at each VM and the rest when it loads.
  for (const folder of [paths.runnerHome, paths.runnerTmp]) ensureDir(folder, { mode: 0o700 })
  emptyFolder(paths.runnerTmp)
  process.env.HOME = paths.runnerHome
  process.env.TMPDIR = paths.runnerTmp
  process.env.XDG_CACHE_HOME = folders.cache
  process.env.GONDOLIN_SESSIONS_DIR = folders.sessions
  const gondolin = await import('@earendil-works/gondolin')

  network ??= policyNetwork({ paths, clock, log })

  if (accel.fellBack) log.warn('sandbox.emulation', { setting: settings.agentAccel, kvm: accel.problem })
  log.info('sandbox.opened', { accel: accel.accel, imageBuiltAt: image.builtAt, pi: pinned })

  async function run(spec, { signal } = {}) {
    const problems = checkRunSpec(spec)
    if (problems.length > 0) throw new Error(`the sandbox was given a bad spec: ${problems.join('; ')}`)
    const startedAt = clock.now()

    // Everything that ends the run before the program does: the timeout, a stop, or a run that
    // wrote too much. Each closes the VM.
    const ending = new AbortController()
    let why = null
    const end = reason => {
      why ??= reason
      ending.abort()
    }
    const budget = createBudget(what => {
      log.warn('sandbox.write_limit', { passed: what })
      end('writes')
    })
    const placeholders = {}
    const secrets = {}
    for (const [name, { hosts, value }] of Object.entries(spec.policy.secrets)) {
      placeholders[name] = placeholderFor(name)
      secrets[name] = { hosts, value, placeholder: placeholders[name] }
    }
    const { close: closeNetwork = () => {}, ...hookOptions } = network(spec.policy, { placeholders })

    let hooks
    let vm
    try {
      hooks = gondolin.createHttpHooks({ ...hookOptions, secrets })
      vm = await gondolin.VM.create({
        sandbox: { imagePath: image.dir, accel: accel.qemu, machineType: machineType(), mitmCertDir: folders.certificates, console: 'none' },
        memory: `${Math.floor(limits.VM_MEMORY_BYTES / (1024 * 1024))}M`,
        cpus: limits.VM_CPUS,
        allowWebSockets: false,
        httpHooks: hooks.httpHooks,
        // A request's body is read whole by the policy for OpenRouter; Gondolin refuses a larger one
        // before it reaches the policy.
        maxHttpBodyBytes: limits.MODEL_REQUEST_MAX_BYTES,
        vfs: { mounts: mountsOf(gondolin, spec.files, budget), fuseMount: FUSE_MOUNT },
        startTimeoutMs: Math.min(limits.VM_START_TIMEOUT, spec.timeoutMs),
        sessionLabel: 'scooter runner',
      })
    } catch (error) {
      closeNetwork()
      throw error
    }
    let closed = null
    const close = () => (closed ??= vm.close().catch(error => log.warn('sandbox.close_failed', errorFields(error))))
    ending.signal.addEventListener('abort', close, { once: true })
    const stop = () => end('stopped')
    if (signal?.aborted) stop()
    signal?.addEventListener('abort', stop, { once: true })
    clock.sleep(spec.timeoutMs, { signal: ending.signal }).then(
      () => end('timeout'),
      () => {},
    )

    const output = createOutput()
    // How the VM ended, when nothing ended it on purpose (`why`): `exited` when the program did,
    // `lost` when the command failed under it, such as when its QEMU was killed, and `not_started`
    // when it never booted.
    let ended = 'not_started'
    try {
      let started = false
      try {
        if (!ending.signal.aborted) {
          await vm.start()
          started = true
        }
      } catch (error) {
        if (!ending.signal.aborted) {
          log.error('sandbox.start_failed', { accel: accel.accel, ...errorFields(error) })
          throw Object.assign(new Error(`the VM couldn't start: ${error.message}`), { cause: error })
        }
      }
      // The run's time ran out before the VM booted, as when it is no longer than the start limit:
      // the VM couldn't start, which is the machine's fault, not pi's.
      if (!started && why === 'timeout') {
        log.error('sandbox.start_failed', { accel: accel.accel, error: 'timeout', ms: clock.now() - startedAt })
        throw new Error("the VM couldn't start: it didn't boot within the run's time")
      }
      let result = null
      if (!ending.signal.aborted) {
        log.info('sandbox.vm_started', { accel: accel.accel, ms: clock.now() - startedAt, qemu: vm.getHostPid() ?? undefined })
        ended = 'exited'
        const assignments = Object.entries({ ...spec.env, ...hooks.env }).map(([name, value]) => `${name}=${value}`)
        // The command settles once the program has exited and its output has closed.
        const execution = vm.exec([ENV_PROGRAM, '-i', ...assignments, ...spec.argv], {
          cwd: spec.cwd,
          stdout: sink(chunk => output.add('stdout', chunk)),
          stderr: sink(chunk => output.add('stderr', chunk)),
        })
        const finished = Promise.resolve(execution).catch(error => {
          if (why === null) {
            ended = 'lost'
            log.error('sandbox.vm_lost', { accel: accel.accel, ms: clock.now() - startedAt, ...errorFields(error) })
          }
          return null
        })
        const aborted = new Promise(resolve => ending.signal.addEventListener('abort', () => resolve(null), { once: true }))
        result = await Promise.race([finished, aborted])
        // A program that ended at the same moment as a limit still counts as stopped by it.
        if (why !== null) result = null
      }
      const kept = output.result()
      const exited = result !== null
      return {
        code: exited ? result.exitCode : null,
        signal: exited ? (result.signal ?? null) : null,
        stdout: kept.stdout,
        stderr: kept.stderr,
        stdoutCut: kept.stdoutCut,
        timedOut: why === 'timeout',
        wroteTooMuch: why === 'writes',
      }
    } finally {
      ending.abort()
      signal?.removeEventListener('abort', stop)
      await close()
      closeNetwork()
      log.info('sandbox.vm_closed', { ms: clock.now() - startedAt, ended: why ?? ended })
    }
  }

  return { accel: accel.accel, imageBuiltAt: image.builtAt, run }
}

// Boots one VM as a run does, with the accelerator the runner would use, and runs `true` in it, for
// `doctor`: KVM can open and still not
// boot a VM, as under nested virtualization. Nothing of the data folder changes, and a runner at
// work keeps its own: Gondolin's home and temporary folder, and the network log, are a folder of
// its own in the system's temporary folder, removed afterwards; the VM sees an empty folder of it,
// and reaches no host. Returns `{ accel, ms }`, how its VMs run and how long the boot took. Throws
// a `SandboxSetupError` when the sandbox can't open, and an error when the VM doesn't boot within
// `VM_START_TIMEOUT`, or `signal` stops it first, which closes the VM: `doctor` stops it on a
// signal, so a `doctor` killed during the boot leaves no QEMU.
//
// Its folder is in the system's temporary folder, or in `/tmp` when a `TMPDIR` of the owner's is
// too long a path for Gondolin's sockets.
export async function bootCheck({ paths, settings, clock = systemClock, signal = null }) {
  const base = socketsFit(path.join(os.tmpdir(), 'scooter-doctor-XXXXXX', 'tmp')) ? os.tmpdir() : '/tmp'
  const scratch = fs.mkdtempSync(path.join(base, 'scooter-doctor-'))
  const booted = []
  const quiet = { info: (event, fields) => event === 'sandbox.vm_started' && booted.push(fields.ms), warn: () => {}, error: () => {} }
  try {
    const own = {
      ...paths,
      runnerHome: path.join(scratch, 'home'),
      runnerTmp: path.join(scratch, 'tmp'),
      networkLogDir: path.join(scratch, 'log'),
      networkLog: date => path.join(scratch, 'log', `${date}.jsonl`),
    }
    const empty = path.join(scratch, 'empty')
    fs.mkdirSync(empty, { mode: 0o700 })
    const sandbox = await openGondolinSandbox({ paths: own, settings, log: quiet, clock })
    const result = await sandbox.run(
      {
        argv: ['true'],
        cwd: '/',
        env: { PATH: GUEST_PATH },
        files: { root: scratch, reads: [empty], writes: [], hide: [] },
        // The boot has its own limit, `VM_START_TIMEOUT`; `true` then takes no time.
        timeoutMs: 2 * limits.VM_START_TIMEOUT,
        policy: { model: 'none', internet: false, zdr: true, secrets: {} },
      },
      { signal },
    )
    if (signal?.aborted) throw new Error('doctor was stopped during the boot')
    if (result.code !== 0) throw new Error(`the VM booted, and \`true\` ended with ${result.timedOut ? 'a timeout' : `exit code ${result.code}`}`)
    return { accel: sandbox.accel, ms: booted[0] ?? null }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
