// A temporary folder for one test.
//
// Every test works in a folder of its own and sets `TMPDIR` inside it (section 10 of DESIGN.md),
// so nothing a test writes lands in the real temporary folder. The folder is removed when the test
// ends, and `TMPDIR` is put back.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { restoreAccess } from '../../src/common/files.mjs'

// A Unix socket's path can be at most 107 bytes, and the programs under test put sockets in
// `TMPDIR`. Gondolin's longest socket name is 37 bytes, so the folder must leave room for it.
const TMPDIR_MAX_BYTES = 107 - 1 - 37

const stacks = new WeakMap()

// Runs `fn` when the test ends. What was registered last runs first, so a VM is closed before the
// folder it works in is removed. `t` is the test context from `node:test`.
export function atEnd(t, fn) {
  let stack = stacks.get(t)
  if (!stack) {
    stack = []
    stacks.set(t, stack)
    t.after(async () => {
      let failure
      for (const cleanup of stack.reverse()) {
        try {
          await cleanup()
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
    })
  }
  stack.push(fn)
}

// Returns the test's folder.
export function makeTestDir(t) {
  const before = process.env.TMPDIR
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scooter-'))
  const tmp = path.join(dir, 'tmp')
  fs.mkdirSync(tmp)
  if (Buffer.byteLength(tmp) > TMPDIR_MAX_BYTES) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(`the temporary folder ${tmp} is too long for a Unix socket; set TMPDIR to a shorter path`)
  }
  process.env.TMPDIR = tmp

  atEnd(t, () => {
    if (before === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = before
    // A test can leave files and folders their owner can't read, as pi can (milestone 4).
    restoreAccess(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
