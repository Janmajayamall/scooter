// The two systemd units of a native install (the plan's milestone 12): what they
// say, and `systemd-analyze verify` on both, which skips itself where systemd isn't installed.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { limits } from '../src/common/limits.mjs'
import { createProc, findProgram } from '../src/common/proc.mjs'
import { NATIVE, UNITS, USERS } from '../src/ops/setup.mjs'
import { SERVICE_MANAGER_WAITS } from '../src/runner/restarts.mjs'
import { createTestLog } from './support/log.mjs'
import { makeTestDir } from './support/tmp.mjs'

const UNIT_DIR = new URL('../deploy/systemd/', import.meta.url)
const COMMAND = path.join(NATIVE.binDir, 'scooter')

// A unit's `[Service]` settings, each name with its values in order.
function serviceOf(text) {
  const settings = {}
  let section = null
  for (const line of text.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue
    const header = /^\[(\w+)\]$/.exec(line)
    if (header) {
      section = header[1]
      continue
    }
    const [name, ...value] = line.split('=')
    const key = `${section}.${name}`
    settings[key] = [...(settings[key] ?? []), value.join('=')]
  }
  return settings
}

const units = Object.fromEntries(UNITS.map(unit => [unit, serviceOf(fs.readFileSync(new URL(unit, UNIT_DIR), 'utf8'))]))

test('units: the bridge runs as root, the runner as its user with the kvm group, both stopped whole, restarted on failure, in UTC', () => {
  const bridge = units['scooter-bridge.service']
  const runner = units['scooter-runner.service']
  assert.deepEqual(bridge['Service.ExecStart'], [`${COMMAND} bridge`])
  assert.deepEqual(runner['Service.ExecStart'], [`${COMMAND} runner`])
  assert.equal(bridge['Service.User'], undefined)
  assert.deepEqual(runner['Service.User'], [USERS.runner])
  assert.deepEqual(runner['Service.Group'], [USERS.runner])
  assert.deepEqual(runner['Service.SupplementaryGroups'], ['kvm'])
  for (const unit of [bridge, runner]) {
    // VMs die with the runner, and wacli and the email reader with the bridge.
    assert.deepEqual(unit['Service.KillMode'], ['control-group'])
    assert.deepEqual(unit['Service.Restart'], ['on-failure'])
    assert.equal(unit['Service.Environment'][0], 'TZ=UTC')
    assert.deepEqual(unit['Install.WantedBy'], ['multi-user.target'])
    // Nothing else of the environment: each service reads its own env file.
    assert.equal(unit['Service.EnvironmentFile'], undefined)
  }
  // The runner's restarts wait 1 minute, then about 5, then 30: a fault that stays after pi
  // has run would otherwise run pi again every few seconds.
  assert.deepEqual([runner['Service.RestartSec'], runner['Service.RestartSteps'], runner['Service.RestartMaxDelaySec']], [['1min'], ['2'], ['30min']])
  assert.deepEqual([bridge['Service.RestartSec'], bridge['Service.RestartSteps'], bridge['Service.RestartMaxDelaySec']], [['5s'], ['6'], ['5min']])
  // systemd keeps those waits, so the runner keeps none of its own; the bridge is told nothing.
  assert.deepEqual(runner['Service.Environment'], ['TZ=UTC', `SCOOTER_RESTART_WAITS=${SERVICE_MANAGER_WAITS}`])
  assert.deepEqual(bridge['Service.Environment'], ['TZ=UTC'])
})

test('units: the waits the runner keeps itself where its service manager doesn\'t are those systemd works out for the runner\'s unit', () => {
  // systemd's waits grow from RestartSec to RestartMaxDelaySec in RestartSteps steps, each the one
  // before times (max / first) ^ (1 / steps), and stay at the last, as measured on systemd 255.
  const runner = units['scooter-runner.service']
  const minutes = value => Number(/^(\d+)min$/.exec(value)[1]) * 60_000
  const first = minutes(runner['Service.RestartSec'][0])
  const max = minutes(runner['Service.RestartMaxDelaySec'][0])
  const steps = Number(runner['Service.RestartSteps'][0])
  const systemd = Array.from({ length: steps + 1 }, (_, n) => Math.round(first * (max / first) ** (n / steps)))
  assert.deepEqual(limits.RUNNER_RESTART_WAITS, systemd)
})

const analyze = findProgram('systemd-analyze', `${process.env.PATH ?? ''}:/usr/bin:/bin`)

test('units: systemd-analyze verify finds nothing to say of either', { skip: analyze === null ? 'systemd-analyze is not installed' : false }, async t => {
  // It checks that the command exists, so it is given a stand-in at a path of the test's own.
  const root = makeTestDir(t)
  const command = path.join(root, 'scooter')
  fs.writeFileSync(command, '#!/bin/sh\n', { mode: 0o755 })
  const proc = createProc({ log: createTestLog().log })
  for (const unit of UNITS) {
    const copy = path.join(root, unit)
    fs.writeFileSync(copy, fs.readFileSync(new URL(unit, UNIT_DIR), 'utf8').replaceAll(COMMAND, command))
    const result = await proc.run(analyze, ['verify', '--man=no', copy], { env: { PATH: process.env.PATH } })
    // It warns of an unknown setting, or a value it can't take, and still exits with 0.
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], unit)
  }
})
