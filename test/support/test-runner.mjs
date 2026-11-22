// A runner for tests: the real runner (`src/runner/main.mjs`) on a temporary data folder, with the
// fake sandbox and a fake clock. Tests drive it a round at a time with `tick()`.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ENTRY_FILE } from '../../src/common/outbox.mjs'
import { listHandOffs } from '../../src/common/files.mjs'
import { makePaths } from '../../src/common/paths.mjs'
import { createProc } from '../../src/common/proc.mjs'
import { openRunner } from '../../src/runner/main.mjs'
import { loadState, saveState } from '../../src/runner/state.mjs'
import { createFakeClock } from './clock.mjs'
import { createFakeSandbox } from './fake-sandbox.mjs'
import { createTestLog } from './log.mjs'
import { writeConfig, writeDatastore } from './runner.mjs'
import { atEnd, makeTestDir } from './tmp.mjs'

export const SECOND = 1000
export const MINUTE = 60 * SECOND

// A stand-in for the OpenRouter key. No test sends it anywhere.
export const KEY = `sk-or-v1-${'7'.repeat(64)}`

// The runner's settings, as `loadSettings('runner')` gives them, for `dataDir` and `configDir`.
export function runnerSettings(root, changes = {}) {
  return {
    side: 'runner',
    dataDir: path.join(root, 'data'),
    configDir: path.join(root, 'config'),
    timeZone: 'Asia/Kolkata',
    openrouterApiKey: KEY,
    zdr: true,
    homeCurrency: 'INR',
    batchSeconds: 8,
    sessionRolloverHour: 4,
    agentInternet: false,
    agentAccel: 'auto',
    ...changes,
  }
}

// Makes the test's folders: the config (`yaml`, as `writeConfig` takes it), the datastore's `lines`,
// and the agent's `state` if one is given. Returns what `openTestRunner` needs, without a runner.
export function prepareTestRunner(t, { yaml, lines = [], state, start = '2026-11-09T15:50:30Z', settings = {}, accel } = {}) {
  const root = makeTestDir(t)
  const config = runnerSettings(root, settings)
  const paths = makePaths(config)
  writeConfig(paths.configDir, yaml === undefined ? {} : { yaml })
  fs.mkdirSync(paths.datastore, { recursive: true })
  writeDatastore(paths, lines)
  if (state) {
    fs.mkdirSync(paths.agentDir('lifelog'), { recursive: true, mode: 0o700 })
    saveState(paths.agentState('lifelog'), state)
  }
  const clock = createFakeClock(start)
  const { log, entries, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const sandbox = createFakeSandbox({ root: path.join(root, 'sandbox'), paths, proc, clock, accel })
  return { root, paths, settings: config, clock, log, entries, events, proc, sandbox }
}

// The outbox entries waiting, oldest first, as `{ id, entry }`. With `take`, they are removed, as
// the bridge would once it had sent them.
export function outboxOf(paths, { take = false } = {}) {
  return listHandOffs(paths.outbox).map(id => {
    const entry = JSON.parse(fs.readFileSync(path.join(paths.outbox, id, ENTRY_FILE), 'utf8'))
    if (take) fs.rmSync(path.join(paths.outbox, id), { recursive: true })
    return entry
  })
}

// Runs git on the agent's repository, for looking at it from a test.
export function gitOf(paths, ...args) {
  const dir = paths.agentDir('lifelog')
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })
}

// Starts the runner on the folders `prepareTestRunner` made, and closes it when the test ends.
export async function startTestRunner(t, prepared) {
  const { settings, sandbox, clock, log, proc, paths } = prepared
  const runner = await openRunner({ settings, openSandbox: async () => sandbox, clock, log, proc })
  atEnd(t, () => runner.close())
  return {
    ...prepared,
    runner,
    // The state on disk.
    state: () => loadState(paths.agentState('lifelog')),
    // Adds lines to the datastore, as the bridge would.
    add: (...lines) => writeDatastore(paths, lines),
    outbox: options => outboxOf(paths, options),
    git: (...args) => gitOf(paths, ...args),
    views: name => fs.readFileSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), name), 'utf8'),
  }
}

// Both at once.
export async function openTestRunner(t, options) {
  return startTestRunner(t, prepareTestRunner(t, options))
}
