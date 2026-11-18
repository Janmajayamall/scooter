// `AGENT_ACCEL` (6.6 of DESIGN.md; section 10, "Sandbox"): `auto` picks the fastest accelerator
// there is and says which; a forced one that isn't there stops the runner with an error that says
// how to enable it. The device is given to `pickAccelerator`, so the cases run without KVM.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { AccelError, kvmProblem, pickAccelerator } from '../src/runner/sandbox/accel.mjs'
import { SandboxSetupError } from '../src/runner/sandbox/index.mjs'
import { skipIfRoot } from './support/root.mjs'
import { makeTestDir } from './support/tmp.mjs'

// A character device anyone can open for reading and writing, standing in for a usable /dev/kvm.
const OPENABLE = '/dev/null'

test('accel: auto uses KVM when the device opens, and says it fell back to emulation, and why, when it doesn\'t', t => {
  const dir = makeTestDir(t)
  assert.equal(kvmProblem(OPENABLE), null)
  assert.deepEqual(pickAccelerator('auto', { device: OPENABLE }), { accel: 'kvm', qemu: 'kvm', fellBack: false, problem: null })

  const missing = path.join(dir, 'kvm')
  assert.deepEqual(pickAccelerator('auto', { device: missing }), { accel: 'emulation', qemu: 'tcg', fellBack: true, problem: 'ENOENT' })

  // A file isn't the device, whoever opens it.
  const file = path.join(dir, 'not-a-device')
  fs.writeFileSync(file, '')
  assert.equal(kvmProblem(file), 'ENODEV')
  assert.equal(pickAccelerator('auto', { device: file }).accel, 'emulation')
})

test('accel: a device the runner may not open is no KVM', { skip: skipIfRoot }, t => {
  const dir = makeTestDir(t)
  const locked = path.join(dir, 'kvm')
  fs.writeFileSync(locked, '')
  fs.chmodSync(locked, 0o000)
  assert.equal(kvmProblem(locked), 'EACCES')
  assert.deepEqual(pickAccelerator('auto', { device: locked }), { accel: 'emulation', qemu: 'tcg', fellBack: true, problem: 'EACCES' })
  assert.throws(() => pickAccelerator('kvm', { device: locked }), error => {
    assert.ok(error instanceof AccelError)
    assert.match(error.message, /^AGENT_ACCEL=kvm, but KVM can't be used: .*can't be opened for reading and writing \(EACCES\)\. Natively, the runner's user must be in the kvm group/)
    assert.match(error.message, /Or set AGENT_ACCEL=auto to fall back to emulation\.$/)
    return true
  })
})

test('accel: a forced accelerator is taken as it is, and one that isn\'t there stops the runner with how to enable it', t => {
  const dir = makeTestDir(t)
  assert.deepEqual(pickAccelerator('kvm', { device: OPENABLE }), { accel: 'kvm', qemu: 'kvm', fellBack: false, problem: null })
  // Emulation is taken even where KVM works, and nothing fell back.
  assert.deepEqual(pickAccelerator('emulation', { device: OPENABLE }), { accel: 'emulation', qemu: 'tcg', fellBack: false, problem: null })

  assert.throws(
    () => pickAccelerator('kvm', { device: path.join(dir, 'kvm') }),
    error => error instanceof SandboxSetupError && /doesn't exist: this machine has no KVM\. Turn on virtualization/.test(error.message),
  )
  // Apple's hypervisor is kept for macOS, and refused on Linux like any accelerator that isn't there.
  assert.throws(() => pickAccelerator('hvf', { device: OPENABLE }), /AGENT_ACCEL=hvf is Apple's hypervisor, which only macOS has/)
})
