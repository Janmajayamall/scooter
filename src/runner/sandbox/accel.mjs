// How pi's VMs are accelerated: `AGENT_ACCEL` (6.6 of DESIGN.md; ARCHITECTURE.md decision 43).
//
// - `auto`, the default, uses KVM when the runner can open `/dev/kvm` for reading and writing, and
//   emulation otherwise. The runner says which at startup, `/status` shows it, and falling back to
//   emulation tells the owner once (`src/runner/status.mjs`).
// - `kvm` and `emulation` force one. A forced KVM that can't be used stops the runner with an error
//   that says how to enable it, rather than quietly using emulation, about ten times slower.
// - `hvf`, Apple's hypervisor, is a value kept for macOS (section 12). On Linux it stops the runner
//   like any other forced accelerator that isn't there.
//
// Gondolin would pick by itself, and falls back to emulation without a word. So the sandbox always
// tells it which to use, from here.

import fs from 'node:fs'
import { SandboxSetupError } from './index.mjs'

export const KVM_DEVICE = '/dev/kvm'

// Thrown when the configured accelerator can't be used. The message is for the owner, and says how
// to fix it.
export class AccelError extends SandboxSetupError {
  constructor(message) {
    super(message)
    this.name = 'AccelError'
  }
}

// Why KVM can't be used here, as an error code (`ENOENT`, `EACCES`…), or null when it can. Opening
// the device is what QEMU does; a permission check alone would miss an ACL or a device that isn't one.
export function kvmProblem(device = KVM_DEVICE) {
  let fd
  try {
    fd = fs.openSync(device, fs.constants.O_RDWR | fs.constants.O_CLOEXEC)
  } catch (error) {
    return error.code ?? 'EIO'
  }
  try {
    if (!fs.fstatSync(fd).isCharacterDevice()) return 'ENODEV'
    return null
  } finally {
    fs.closeSync(fd)
  }
}

// How to make KVM usable, for an error code from `kvmProblem`.
export function kvmHelp(problem, device = KVM_DEVICE) {
  const access =
    problem === 'ENOENT'
      ? `${device} doesn't exist: this machine has no KVM. Turn on virtualization in its firmware, or nested virtualization if it is itself a VM; in Docker, pass the device to the runner`
      : `${device} can't be opened for reading and writing (${problem}). Natively, the runner's user must be in the kvm group, which \`scooter setup\` does. In Docker, pass the device to the runner, with the kvm group (rootful Docker) or the udev rule of the README (rootless Docker)`
  return `${access}. \`scooter doctor\` says which case this is.`
}

// Picks the accelerator for `setting`, `AGENT_ACCEL`'s value. Returns `{ accel, qemu, fellBack }`:
// `accel` is what the runner reports, `kvm` or `emulation`; `qemu` what QEMU is given, `kvm` or
// `tcg`; and `fellBack` is true when `auto` had to use emulation, with `problem` saying why. Throws
// an `AccelError` for a forced accelerator that can't be used.
export function pickAccelerator(setting, { device = KVM_DEVICE } = {}) {
  if (setting === 'emulation') return { accel: 'emulation', qemu: 'tcg', fellBack: false, problem: null }
  if (setting === 'hvf') {
    throw new AccelError("AGENT_ACCEL=hvf is Apple's hypervisor, which only macOS has. On Linux, set AGENT_ACCEL to auto, kvm or emulation.")
  }
  const problem = kvmProblem(device)
  if (problem === null) return { accel: 'kvm', qemu: 'kvm', fellBack: false, problem: null }
  if (setting === 'kvm') throw new AccelError(`AGENT_ACCEL=kvm, but KVM can't be used: ${kvmHelp(problem, device)} Or set AGENT_ACCEL=auto to fall back to emulation.`)
  if (setting === 'auto') return { accel: 'emulation', qemu: 'tcg', fellBack: true, problem }
  throw new AccelError(`AGENT_ACCEL must be auto, kvm or emulation, not ${setting}`)
}
