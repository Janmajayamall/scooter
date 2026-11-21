// The restic stub, for the backup coordination tests.
//
// `createResticStub` puts a wrapper named `restic` first on `PATH`, which runs `restic-stub.mjs`.
// The wrapper is a Node file with this Node's own path in its `#!` line, as wacli's is
// (`wacli.mjs`): restic's environment has no `PATH`, and a shell would add to the environment that
// the stub records.

import fs from 'node:fs'
import path from 'node:path'
import { findProgram } from '../../src/common/proc.mjs'
import { atEnd } from './tmp.mjs'
import { waitFor } from './wacli.mjs'

const STUB = new URL('./restic-stub.mjs', import.meta.url)

// The real restic, when it is installed, for the round trip; null when it isn't.
export const realRestic = findProgram('restic')

// Sets up the stub in `dir` for the test `t`, and puts it first on PATH until the test ends.
export function createResticStub(t, dir) {
  const bin = path.join(dir, 'bin')
  const control = path.join(dir, 'restic-stub')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(control, { recursive: true })
  fs.writeFileSync(path.join(bin, 'restic'), `#!${process.execPath}\nimport(${JSON.stringify(STUB.href)})\n`, { mode: 0o755 })

  let fixtures = {}
  const writeFixtures = () => {
    fs.writeFileSync(path.join(control, 'fixtures.json.tmp'), JSON.stringify(fixtures))
    fs.renameSync(path.join(control, 'fixtures.json.tmp'), path.join(control, 'fixtures.json'))
  }
  writeFixtures()

  const before = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${before}`
  atEnd(t, () => {
    process.env.PATH = before
  })

  const commandOf = args => {
    let rest = args
    while (rest[0] === '--no-cache' || rest[0] === '--cache-dir') rest = rest.slice(rest[0] === '--cache-dir' ? 2 : 1)
    return rest[0]
  }
  const stub = {
    control,

    // Changes some fixtures. What isn't named stays as it was.
    fixtures(changes) {
      fixtures = { ...fixtures, ...changes }
      writeFixtures()
    },

    // Every call so far, in order, as `{ args, env, uid, gid, pid, command }`, `command` being the
    // first word after the global options, such as `backup`.
    calls() {
      const file = path.join(control, 'calls.jsonl')
      if (!fs.existsSync(file)) return []
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .map(call => ({ ...call, command: commandOf(call.args) }))
    },

    commands: () => stub.calls().map(call => call.command),

    // Waits until a held command has started, and lets it go on.
    holding: command => waitFor(() => fs.existsSync(path.join(control, `holding-${command}`)), `restic ${command} to start`),
    release(command) {
      fs.writeFileSync(path.join(control, `release-${command}`), '')
    },
    stopped: command => fs.existsSync(path.join(control, `stopped-${command}`)),
  }
  return stub
}
