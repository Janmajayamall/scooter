// The sandbox interface (6.6 of DESIGN.md; ARCHITECTURE.md 2.7): how the runner runs pi without
// knowing what runs it. The real sandbox is a Gondolin VM (`gondolin.mjs`, milestone 7); the tests
// use a fake that runs a stub of pi as a local process (`test/support/fake-sandbox.mjs`).
//
// A sandbox is an object:
//
//   {
//     accel,             how its VMs run: `kvm` or `emulation` (`ACCELERATORS` in
//                        `src/common/runnerstatus.mjs`)
//     imageBuiltAt,      when the VM image was built, as a UTC time, or null
//     run(spec, { signal })
//   }
//
// `run` runs one command, as `spec` says, in a fresh VM that is closed when it returns:
//
//   {
//     argv: ['pi', '-p', …],          the program and its arguments; no shell reads them
//     cwd: '/data/agents/lifelog',    the folder it runs in
//     env: { PATH, HOME, … },         its whole environment, apart from the secrets below
//     mounts: [{ path, writable, hide }],
//     timeoutMs,                      after this long the VM is closed
//     policy: { model, internet, zdr, secrets },
//   }
//
// - `mounts`: each host folder `path`, at the same path inside the VM, read-only unless
//   `writable`. `hide` lists paths inside a read-only mount, from its root, that the VM doesn't
//   see at all and can't create, such as `sessions` in the agent's folder; a writable mount hides
//   nothing. A mount inside another takes its place there. Nothing else of the host is visible.
// - `policy`: the network policy for the run (6.13): the model OpenRouter may be asked for, whether
//   the agent's internet access is on, and whether to ask for zero data retention. `secrets` maps
//   a variable's name to `{ hosts, value }`: the program gets the variable holding a placeholder,
//   and the sandbox puts `value` in its place only on requests to `hosts`.
// - `signal` aborts the run: the VM is closed, as for a timeout.
//
// It resolves with `{ code, signal, stdout, stderr, timedOut, stdoutCut, wroteTooMuch }`. `code` is
// the program's exit code, or null when it didn't exit by itself: it timed out, was aborted, went
// past what a run may write, or the VM was lost. It rejects only when the command couldn't be run
// at all, such as when the VM doesn't start.
//
// Nothing pi does may stop the runner (`docs/DECISIONS.md`, 4.7), so a sandbox bounds what a run
// can take from it:
// - **Output.** It keeps the start of stdout, pi's answer, and the end of stderr, where OpenRouter's
//   error is, up to `SANDBOX_STDOUT_MAX_BYTES` and `SANDBOX_STDERR_MAX_BYTES` (`createOutput`).
//   `stdoutCut` says the answer was cut, which fails the run as pi's own failure.
// - **Writes.** The real sandbox stops a run that writes more than `RUN_WRITE_MAX_BYTES`, or makes
//   more than `RUN_NAMES_MAX_COUNT` names, through its writable mounts: it refuses the write, closes
//   the VM, and says `wroteTooMuch`, which fails the run as pi's own failure too.

import path from 'node:path'
import { limits } from '../../common/limits.mjs'

// A sandbox that can't run anything as it is set up: no image, an image built for another pi, an
// accelerator that was forced and isn't there. The runner doesn't start, and says why (exit code 2).
export class SandboxSetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SandboxSetupError'
  }
}

// Collects a program's output as both sandboxes keep it: the first `SANDBOX_STDOUT_MAX_BYTES` of
// stdout and the last `SANDBOX_STDERR_MAX_BYTES` of stderr. `add(stream, chunk)` takes each piece
// as it comes, so the memory it holds is bounded whatever the program prints; `result()` gives
// `{ stdout, stderr, stdoutCut }`, as text.
export function createOutput() {
  const stdoutMax = limits.SANDBOX_STDOUT_MAX_BYTES
  const stderrMax = limits.SANDBOX_STDERR_MAX_BYTES
  const stdout = []
  let stdoutBytes = 0
  let stdoutCut = false
  let stderr = []
  let stderrBytes = 0
  return {
    add(stream, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stream === 'stdout') {
        const room = stdoutMax - stdoutBytes
        if (bytes.length > room) stdoutCut = true
        if (room > 0) {
          const kept = bytes.subarray(0, room)
          stdout.push(kept)
          stdoutBytes += kept.length
        }
        return
      }
      stderr.push(bytes)
      stderrBytes += bytes.length
      if (stderrBytes > 2 * stderrMax) {
        const joined = Buffer.concat(stderr)
        stderr = [joined.subarray(joined.length - stderrMax)]
        stderrBytes = stderrMax
      }
    },
    result() {
      const err = Buffer.concat(stderr)
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: err.subarray(Math.max(0, err.length - stderrMax)).toString('utf8'),
        stdoutCut,
      }
    },
  }
}

// The one host pi's requests to the model go to, and the only one its key is sent to (6.13).
export const OPENROUTER_HOST = 'openrouter.ai'

// What the VM image has (6.12): pi's program, the `PATH` its tools need, and a home folder made
// fresh at each boot.
export const PI_PROGRAM = 'pi'
export const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export const GUEST_HOME = '/root'

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

// What is wrong with a run's spec, as a list of statements that name fields. An empty list means
// it is well formed. Both sandboxes check what they are given.
export function checkRunSpec(spec) {
  if (!isObject(spec)) return ['the spec must be an object']
  const problems = []
  if (!Array.isArray(spec.argv) || spec.argv.length === 0 || !spec.argv.every(arg => typeof arg === 'string')) {
    problems.push('argv must be a list of strings, the program first')
  }
  if (typeof spec.cwd !== 'string' || !path.isAbsolute(spec.cwd)) problems.push('cwd must be an absolute path')
  if (!isObject(spec.env) || !Object.values(spec.env).every(value => typeof value === 'string')) problems.push('env must map names to strings')
  if (!Array.isArray(spec.mounts) || spec.mounts.length === 0) {
    problems.push('mounts must be a list')
  } else {
    spec.mounts.forEach((mount, n) => {
      if (!isObject(mount) || typeof mount.path !== 'string' || !path.isAbsolute(mount.path)) problems.push(`mounts[${n}].path must be an absolute path`)
      else if (typeof mount.writable !== 'boolean') problems.push(`mounts[${n}].writable must be true or false`)
      else if (!Array.isArray(mount.hide) || !mount.hide.every(inner => typeof inner === 'string' && inner !== '' && !path.isAbsolute(inner) && !inner.split('/').includes('..'))) {
        problems.push(`mounts[${n}].hide must list paths inside the mount`)
      } else if (mount.writable && mount.hide.length > 0) {
        // The VM could make what is hidden again, through the writable mount.
        problems.push(`mounts[${n}].hide must be empty: only a read-only mount hides paths`)
      }
    })
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) problems.push('timeoutMs must be a whole number of milliseconds')
  const policy = spec.policy
  if (!isObject(policy)) {
    problems.push('policy must be an object')
  } else {
    if (typeof policy.model !== 'string' || policy.model === '') problems.push('policy.model must be a model ID')
    for (const name of ['internet', 'zdr']) {
      if (typeof policy[name] !== 'boolean') problems.push(`policy.${name} must be true or false`)
    }
    if (!isObject(policy.secrets)) problems.push('policy.secrets must be an object')
    else {
      for (const [name, secret] of Object.entries(policy.secrets)) {
        if (Object.hasOwn(spec.env ?? {}, name)) problems.push(`env.${name} is a secret's, and the sandbox sets it`)
        if (!isObject(secret) || !Array.isArray(secret.hosts) || typeof secret.value !== 'string') problems.push(`policy.secrets.${name} must be { hosts, value }`)
      }
    }
  }
  return problems
}
