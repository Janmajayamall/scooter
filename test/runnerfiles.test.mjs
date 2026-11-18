// The formats the runner shares (6.3 of DESIGN.md; row 6), and the sandbox interface (6.6;
// ARCHITECTURE.md 2.7): `status.json` and its reader for `/status`, and the spec a sandbox takes.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { RunnerStatusError, checkRunnerStatus, readRunnerStatus } from '../src/common/runnerstatus.mjs'
import { checkRunSpec } from '../src/runner/sandbox/index.mjs'
import { makeTestDir } from './support/tmp.mjs'

const STATUS = {
  startedAt: '2026-11-09T15:00:02Z',
  accel: 'kvm',
  zdr: true,
  internet: false,
  imageBuiltAt: '2026-11-09T12:31:40Z',
  agents: { lifelog: { model: 'anthropic/claude-sonnet-5.5', timeoutMinutes: 10, reads: ['whatsapp', 'email'] } },
}

test('status.json: the format, each fault naming its field', () => {
  assert.deepEqual(checkRunnerStatus(STATUS), [])
  assert.deepEqual(checkRunnerStatus({ ...STATUS, imageBuiltAt: null }), [])
  // A runner that waits before it goes on (D229); an older runner's status has no `restart`.
  assert.deepEqual(checkRunnerStatus({ ...STATUS, restart: null }), [])
  assert.deepEqual(checkRunnerStatus({ ...STATUS, restart: { stops: 2, until: '2026-11-09T12:40:00Z', reason: 'ENOSPC' } }), [])
  assert.deepEqual(checkRunnerStatus({ ...STATUS, restart: { stops: 1, until: '2026-11-09T12:40:00Z', reason: null } }), [])
  const cases = [
    [{ restart: { stops: 0, until: '2026-11-09T12:40:00Z', reason: null } }, 'restart must be null or { stops, until, reason }'],
    [{ restart: { stops: 1, until: 'soon', reason: null } }, 'restart must be null or { stops, until, reason }'],
    [{ restart: { stops: 1, until: '2026-11-09T12:40:00Z', reason: 'x'.repeat(201) } }, 'restart must be null or { stops, until, reason }'],
    [{ accel: 'hvf' }, 'accel must be one of kvm, emulation'],
    [{ zdr: 'on' }, 'zdr must be true or false'],
    [{ startedAt: 'now' }, 'startedAt must be a UTC time to the second'],
    [{ imageBuiltAt: '2026-11-09' }, 'imageBuiltAt must be a UTC time to the second, or null'],
    [{ agents: { lifelog: { ...STATUS.agents.lifelog, reads: ['telegram'] } } }, 'agents.lifelog.reads must list sources such as whatsapp and email'],
    [{ agents: { lifelog: { ...STATUS.agents.lifelog, timeoutMinutes: 0 } } }, 'agents.lifelog.timeoutMinutes must be a whole number of minutes'],
    [{ agents: { lifelog: { ...STATUS.agents.lifelog, key: 'x' } } }, 'agents.lifelog.key is not a field of the status'],
    [{ extra: 1 }, 'extra is not a field of the status'],
    // The bridge makes paths of the names, for `/status`.
    [{ agents: { '../etc': STATUS.agents.lifelog } }, 'agents must be named as agents.yaml names them, such as lifelog'],
    [{ internet: undefined }, 'internet is missing'],
  ]
  for (const [changes, problem] of cases) {
    const problems = checkRunnerStatus(JSON.parse(JSON.stringify({ ...STATUS, ...changes })))
    assert.ok(problems.includes(problem), `${problem}: ${JSON.stringify(problems)}`)
  }
})

test('status.json: read back; none before the runner first starts; a damaged one names itself', t => {
  const file = path.join(makeTestDir(t), 'status.json')
  assert.equal(readRunnerStatus(file), null)
  fs.writeFileSync(file, JSON.stringify(STATUS))
  assert.deepEqual(readRunnerStatus(file), STATUS)
  fs.writeFileSync(file, '{"accel":')
  assert.throws(() => readRunnerStatus(file), error => error instanceof RunnerStatusError && error.message === `${file} is not JSON`)
  fs.writeFileSync(file, JSON.stringify({ ...STATUS, accel: 'fast' }))
  assert.throws(() => readRunnerStatus(file), new RegExp(`^RunnerStatusError: ${file.replaceAll('/', '\\/')}: accel must be one of kvm, emulation$`))
})

test('sandbox: a run\'s spec is checked, and a secret is the sandbox\'s to set', () => {
  const spec = {
    argv: ['pi', '-p', '--', 'hello'],
    cwd: '/data/agents/lifelog',
    env: { PATH: '/usr/bin', TZ: 'Asia/Kolkata' },
    mounts: [
      { path: '/data/agents/lifelog', writable: false, hide: ['sessions'] },
      { path: '/data/agents/lifelog/views', writable: true, hide: [] },
    ],
    timeoutMs: 600000,
    policy: { model: 'anthropic/claude-sonnet-5.5', internet: false, zdr: true, secrets: { OPENROUTER_API_KEY: { hosts: ['openrouter.ai'], value: 'sk' } } },
  }
  assert.deepEqual(checkRunSpec(spec), [])
  const cases = [
    [{ argv: [] }, 'argv must be a list of strings, the program first'],
    [{ cwd: 'agents/lifelog' }, 'cwd must be an absolute path'],
    [{ env: { TZ: 5 } }, 'env must map names to strings'],
    [{ env: { OPENROUTER_API_KEY: 'sk' } }, "env.OPENROUTER_API_KEY is a secret's, and the sandbox sets it"],
    [{ mounts: [{ path: 'data', writable: true, hide: [] }] }, 'mounts[0].path must be an absolute path'],
    [{ mounts: [{ path: '/data', writable: 'yes', hide: [] }] }, 'mounts[0].writable must be true or false'],
    [{ mounts: [{ path: '/data', writable: false, hide: ['../etc'] }] }, 'mounts[0].hide must list paths inside the mount'],
    [{ mounts: [{ path: '/data', writable: false, hide: ['/sessions'] }] }, 'mounts[0].hide must list paths inside the mount'],
    // A writable mount hides nothing: the real sandbox would let the VM make the path again.
    [{ mounts: [{ path: '/data', writable: true, hide: ['sessions'] }] }, 'mounts[0].hide must be empty: only a read-only mount hides paths'],
    [{ timeoutMs: 0 }, 'timeoutMs must be a whole number of milliseconds'],
    [{ policy: { ...spec.policy, internet: 'off' } }, 'policy.internet must be true or false'],
    [{ policy: { ...spec.policy, secrets: { KEY: 'sk' } } }, 'policy.secrets.KEY must be { hosts, value }'],
  ]
  for (const [changes, problem] of cases) {
    const problems = checkRunSpec({ ...spec, ...changes })
    assert.ok(problems.includes(problem), `${problem}: ${JSON.stringify(problems)}`)
  }
})
