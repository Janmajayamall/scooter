// The real sandbox: one Gondolin micro-VM for each run (6.6 of DESIGN.md; ARCHITECTURE.md 2.7).
//
// `openGondolinSandbox` is the runner's `openSandbox`. At the runner's start, after it has freed
// what pi left (D89 of `docs/DECISIONS.md`), it:
// - gives the runner its home and temporary folder under `runner/` (row 16), where Gondolin keeps
//   its certificate authority, its list of running VMs, the VMs' disk overlays and their sockets,
//   and empties the temporary folder, which a runner that was killed leaves full;
// - checks the VM image: there, built for the pi version the build file pins, for this machine,
//   knowing the owner's time zone (6.12; `image.mjs`);
// - picks the accelerator (`accel.mjs`), and checks that QEMU is installed.
//
// `run(spec)` then boots a fresh VM from `runner/image/` for each run, with the spec's mounts at
// the host's own paths, Gondolin's own mount point moved off `/data` (row 14), `sessions/` hidden
// with `ShadowProvider`; runs the program from its argument list through `env -i`, so it gets the
// spec's environment and nothing else (0.5, VM 2); and closes the VM on every path: when the
// program exits, at the timeout, when the runner stops, and when the run writes more than it may.
// Closing is what stops the program: aborting the command in Gondolin 0.14.0 doesn't (13.4).
//
// The network is the policy's (6.13), which milestone 8 builds. Until then a VM reaches nothing:
// every request is refused, and the key is swapped in nowhere (`refuseNetwork`). Tests give the
// scripted fake model in its place.
//
// Only `src/runner/sandbox/` loads Gondolin (ARCHITECTURE.md 4.2), and this module loads it only
// once the runner's folders are set, because Gondolin fixes the folder of its list of running VMs
// when it loads.

import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { emptyFolder, ensureDir } from '../../common/files.mjs'
import { limits } from '../../common/limits.mjs'
import { errorFields } from '../../common/log.mjs'
import { findProgram } from '../../common/proc.mjs'
import { systemClock } from '../../common/time.mjs'
import { pickAccelerator } from './accel.mjs'
import { checkImage, pinnedPiVersion, qemuProgram, readBuildFile } from './image.mjs'
import { SandboxSetupError, checkRunSpec, createOutput } from './index.mjs'

// Where Gondolin's own file system goes in the VM, instead of `/data`, which is where Scooter's
// folders are in Docker (row 14; 0.5, VM 1). `/run` is a temporary file system of the VM's boot.
export const FUSE_MOUNT = '/run/gondolin-vfs'

// The image's `env`, through which every command runs, so it gets exactly the spec's environment.
export const ENV_PROGRAM = '/usr/bin/env'

// A Unix socket's path can be at most 107 bytes. Gondolin puts five in the temporary folder, with
// names of up to 37 bytes, and one in its list of running VMs, named by a UUID.
const SOCKET_PATH_MAX_BYTES = 107
const TMP_SOCKET_NAME_BYTES = 37
const SESSION_SOCKET_NAME_BYTES = 41

// The network until milestone 8's policy: Gondolin refuses every request, before any goes out, and
// answers DNS with made-up addresses inside the runner.
export function refuseNetwork() {
  return { allowedHosts: [], isRequestAllowed: async () => false }
}

// Where Gondolin keeps its things: its certificate authority under the runner's home, which keeps
// it from one start to the next; and its list of running VMs, each with a socket, in the
// temporary folder, which a start empties, and where a socket's path is shortest.
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

// What one run may still write through its writable mounts (`RUN_WRITE_MAX_BYTES`,
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

// A writable mount of `host`, which counts what is written through it against `budget`. Gondolin's
// hooks see every write and every open, folder and hard link; a symbolic link passes them by, so it
// is counted here.
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

// Gondolin's mounts for a spec's: at the host's paths; read-only unless writable; with the hidden
// paths shadowed, so the VM finds nothing there and can't make anything (13.4).
function mountsOf(gondolin, mounts, budget) {
  const providers = {}
  for (const mount of mounts) {
    if (mount.writable) {
      providers[mount.path] = budgetedProvider(gondolin, mount.path, budget)
      continue
    }
    let provider = new gondolin.RealFSProvider(mount.path)
    if (mount.hide.length > 0) {
      provider = new gondolin.ShadowProvider(provider, {
        shouldShadow: gondolin.createShadowPathPredicate(mount.hide.map(hidden => `/${hidden}`)),
      })
    }
    providers[mount.path] = new gondolin.ReadonlyProvider(provider)
  }
  return providers
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

// Opens the sandbox (see the top of this file). `network(policy)` gives the options of Gondolin's
// `createHttpHooks` for a run, apart from the secrets; `kvmDevice` is for tests.
export async function openGondolinSandbox({ paths, settings, log, clock = systemClock, network = refuseNetwork, kvmDevice }) {
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

  // The runner's home and temporary folder (6.6; row 16). Gondolin reads them from the process's
  // environment, the temporary folder at each VM and the rest when it loads.
  for (const folder of [paths.runnerHome, paths.runnerTmp]) ensureDir(folder, { mode: 0o700 })
  emptyFolder(paths.runnerTmp)
  process.env.HOME = paths.runnerHome
  process.env.TMPDIR = paths.runnerTmp
  process.env.XDG_CACHE_HOME = folders.cache
  process.env.GONDOLIN_SESSIONS_DIR = folders.sessions
  const gondolin = await import('@earendil-works/gondolin')

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
    const secrets = {}
    for (const [name, { hosts, value }] of Object.entries(spec.policy.secrets)) secrets[name] = { hosts, value }
    const hooks = gondolin.createHttpHooks({ ...network(spec.policy), secrets })

    const vm = await gondolin.VM.create({
      sandbox: { imagePath: image.dir, accel: accel.qemu, mitmCertDir: folders.certificates, console: 'none' },
      memory: `${Math.floor(limits.VM_MEMORY_BYTES / (1024 * 1024))}M`,
      cpus: limits.VM_CPUS,
      allowWebSockets: false,
      httpHooks: hooks.httpHooks,
      vfs: { mounts: mountsOf(gondolin, spec.mounts, budget), fuseMount: FUSE_MOUNT },
      startTimeoutMs: Math.min(limits.VM_START_TIMEOUT, spec.timeoutMs),
      sessionLabel: 'scooter runner',
    })
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
      try {
        if (!ending.signal.aborted) await vm.start()
      } catch (error) {
        if (!ending.signal.aborted) {
          log.error('sandbox.start_failed', { accel: accel.accel, ...errorFields(error) })
          throw Object.assign(new Error(`the VM couldn't start: ${error.message}`), { cause: error })
        }
      }
      let result = null
      if (!ending.signal.aborted) {
        log.info('sandbox.vm_started', { accel: accel.accel, ms: clock.now() - startedAt, qemu: vm.getHostPid() ?? undefined })
        ended = 'exited'
        const assignments = Object.entries({ ...spec.env, ...hooks.env }).map(([name, value]) => `${name}=${value}`)
        // The command settles once the program has exited and its output has closed (D139).
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
      log.info('sandbox.vm_closed', { ms: clock.now() - startedAt, ended: why ?? ended })
    }
  }

  return { accel: accel.accel, imageBuiltAt: image.builtAt, run }
}
