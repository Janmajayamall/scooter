// A fake sandbox, for the runner's tests: it runs the pi stub
// (`pi-stub.mjs`) as a local process, in a temporary folder laid out like what the VM sees.
//
// It takes the same spec as the real sandbox (`src/runner/sandbox/index.mjs`) and checks it. For
// each run it makes a folder that stands for the VM's root, and puts each path the spec's `files`
// shows at its path there: a link to the host's file or folder, or, for a folder that holds a
// hidden path, a folder of links to everything in it but that. So, as in the VM, the agent's
// `sessions/` isn't there at all. What it doesn't do is keep the stub from changing what `writes`
// doesn't name: it gives the stub the run's `writes` (`PI_STUB_WRITES`), and the stub writes only
// there, as the VM would let it, noting each write it leaves out. The real VM's tests show the
// sandbox holding pi to them (`test/tools/vm.test.mjs`, `test/sandbox.test.mjs`).
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

// Whether the absolute path `inner` is `outer` or in it.
const isIn = (inner, outer) => inner === outer || inner.startsWith(`${outer}/`)

// Puts each path `files` shows at its path under `root`: what `reads` and `writes` name, with the
// folders that lead there; never what `hide` names.
function layOut(root, files) {
  const shown = [...new Set([...files.reads, ...files.writes.map(write => write.path)])].sort((a, b) => a.length - b.length)
  // A link to `host` at `target`, or, when `host` holds a hidden path, a folder of links to all
  // it holds but that.
  const place = (host, target) => {
    if (files.hide.some(hidden => isIn(host, hidden))) return
    if (!files.hide.some(hidden => isIn(hidden, host))) {
      fs.symlinkSync(host, target)
      return
    }
    fs.mkdirSync(target)
    for (const name of fs.readdirSync(host)) place(path.join(host, name), path.join(target, name))
  }
  for (const entry of shown) {
    // One in another is reached through it.
    if (shown.some(other => other !== entry && isIn(entry, other))) continue
    const target = path.join(root, entry)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    place(entry, target)
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
        layOut(vm, spec.files)
        fs.mkdirSync(path.join(vm, GUEST_HOME), { recursive: true })
        const placeholders = Object.fromEntries(Object.keys(spec.policy.secrets).map(name => [name, `placeholder-${randomUUID()}`]))
        const env = { ...spec.env, ...placeholders }
        runs.push({ spec: structuredClone(spec), env })
        const result = await proc.run(process.execPath, [STUB, ...spec.argv.slice(1)], {
          env: {
            ...env,
            PI_STUB_ROOT: vm,
            PI_STUB_WRITES: JSON.stringify(spec.files.writes),
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

    // The writes the stub left out on each run, as the VM would have refused them: their paths in
    // the VM, in order.
    refused() {
      const file = path.join(control, 'refused.txt')
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
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
