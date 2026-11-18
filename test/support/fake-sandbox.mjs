// A fake sandbox, for the runner's tests (section 10 of DESIGN.md): it runs the pi stub
// (`pi-stub.mjs`) as a local process, in a temporary folder laid out like the VM's mounts.
//
// It takes the same spec as the real sandbox (`src/runner/sandbox/index.mjs`) and checks it. For
// each run it makes a folder that stands for the VM's root, and puts each mount at its path there:
// a link to the host's folder, or, for a mount with hidden paths, a folder of links to everything
// in it but those. So, as in the VM, the agent's `sessions/` isn't there at all. What it doesn't
// do is make the read-only mounts read-only: the real VM's tests show that (milestone 7).
//
// The stub gets the spec's environment, the secrets' placeholders, and a few `PI_STUB_*` variables
// of its own, which it leaves out of what it records. Its output is kept as the real sandbox keeps
// it (`createOutput`). A test sets `wroteTooMuch` to have a run end as one the real sandbox stopped
// for writing too much.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GUEST_HOME, checkRunSpec, createOutput } from '../../src/runner/sandbox/index.mjs'

const STUB = new URL('./pi-stub.mjs', import.meta.url).pathname

// Puts each mount at its path under `root`.
function layOut(root, mounts) {
  for (const mount of [...mounts].sort((a, b) => a.path.length - b.path.length)) {
    const target = path.join(root, mount.path)
    // A mount inside one already laid out is reached through its link, at the same host folder.
    if (fs.existsSync(target) && fs.realpathSync(target) === fs.realpathSync(mount.path)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (mount.hide.length === 0) {
      fs.symlinkSync(mount.path, target)
      continue
    }
    if (mount.hide.some(hidden => hidden.includes('/'))) throw new Error('the fake sandbox hides only names at the top of a mount')
    fs.mkdirSync(target)
    for (const name of fs.readdirSync(mount.path)) {
      if (!mount.hide.includes(name)) fs.symlinkSync(path.join(mount.path, name), path.join(target, name))
    }
  }
}

// Returns the sandbox. `root` is a folder of the test's for the VMs' folders and the stub's
// control folder; `paths` the data folder's paths, for the network log; `proc` and `clock` the
// test's. `accel` and `imageBuiltAt` are what the sandbox says of itself.
export function createFakeSandbox({ root, paths, proc, clock, accel = 'kvm', imageBuiltAt = '2026-11-09T10:00:00Z' }) {
  const control = path.join(root, 'pi-stub')
  fs.mkdirSync(control, { recursive: true })
  let count = 0
  const runs = []

  return {
    accel,
    imageBuiltAt,

    // Every spec it was given, with the environment pi got: the spec's, and the placeholders.
    runs,

    // Set to true for the next runs to end as the real sandbox ends a run that wrote too much.
    wroteTooMuch: false,

    async run(spec, { signal } = {}) {
      const problems = checkRunSpec(spec)
      if (problems.length > 0) throw new Error(`the fake sandbox was given a bad spec: ${problems.join('; ')}`)
      const vm = path.join(root, `vm-${++count}`)
      fs.mkdirSync(vm)
      try {
        layOut(vm, spec.mounts)
        fs.mkdirSync(path.join(vm, GUEST_HOME), { recursive: true })
        const placeholders = Object.fromEntries(Object.keys(spec.policy.secrets).map(name => [name, `placeholder-${randomUUID()}`]))
        const env = { ...spec.env, ...placeholders }
        runs.push({ spec: structuredClone(spec), env })
        const result = await proc.run(process.execPath, [STUB, ...spec.argv.slice(1)], {
          env: {
            ...env,
            PI_STUB_ROOT: vm,
            PI_STUB_CONTROL: control,
            PI_STUB_NETLOG: paths.networkLogDir,
            PI_STUB_NOW: String(clock.now()),
            PI_STUB_PATH: process.env.PATH ?? '',
          },
          cwd: path.join(vm, spec.cwd),
          timeout: spec.timeoutMs,
          signal,
        })
        const stopped = result.timedOut || signal?.aborted === true
        // Kept as the real sandbox keeps it: the start of stdout and the end of stderr.
        const output = createOutput()
        output.add('stdout', result.stdout)
        output.add('stderr', result.stderr)
        const kept = output.result()
        const wroteTooMuch = this.wroteTooMuch === true
        return {
          code: stopped || wroteTooMuch ? null : result.code,
          signal: result.signal,
          stdout: kept.stdout,
          stderr: kept.stderr,
          stdoutCut: kept.stdoutCut,
          timedOut: result.timedOut,
          wroteTooMuch,
        }
      } finally {
        fs.rmSync(vm, { recursive: true, force: true })
      }
    },

    // Sets what the stub does whatever the messages say (`pi-stub.mjs`), or, with null, goes back
    // to the keywords alone.
    behave(behavior) {
      const file = path.join(control, 'behavior.json')
      if (behavior === null) fs.rmSync(file, { force: true })
      else fs.writeFileSync(file, JSON.stringify(behavior))
    },

    // What the stub saw on each run, in order.
    seen() {
      const file = path.join(control, 'calls.jsonl')
      if (!fs.existsSync(file)) return []
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    },

    // Resolves once the stub has started to wait for ever, as `HANG` and `NOANSWER` have it do.
    async whenHung() {
      const marker = path.join(control, 'hung')
      for (let n = 0; n < 1000 && !fs.existsSync(marker); n++) await new Promise(resolve => setTimeout(resolve, 10))
      if (!fs.existsSync(marker)) throw new Error('the pi stub never started to wait')
      fs.rmSync(marker)
    },
  }
}
