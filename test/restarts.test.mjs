// The runner's own waits between its starts (`src/runner/restarts.mjs`): where its service
// manager doesn't wait, as Docker's doesn't, a fault that stays after pi has run must not run pi
// more often than the native unit's waits allow. Docker is played here by starting the
// runner again at once, each time it stops on its own.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { limits } from '../src/common/limits.mjs'
import { readRunnerStatus } from '../src/common/runnerstatus.mjs'
import { isoSeconds, parseIsoSeconds } from '../src/common/time.mjs'
import { startRunner } from '../src/runner/main.mjs'
import { keepsRestartWaits, restartNotice, restartUntil, restartWait, stopReason } from '../src/runner/restarts.mjs'
import { fillerLines, line, writeDatastore } from './support/runner.mjs'
import { MINUTE, SECOND, outboxOf, prepareTestRunner } from './support/test-runner.mjs'
import { atEnd } from './support/tmp.mjs'

const START = '2026-11-09T15:50:30Z'
const HANDLED = { cursor: 1041, retry: [], failed: [], scheduled: {}, lastRun: null }

test('restarts: the waits are the native unit\'s, from the stop, and the reason is the error\'s code or name', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 50].map(restartWait), [0, MINUTE, limits.RUNNER_RESTART_WAITS[1], 30 * MINUTE, 30 * MINUTE, 30 * MINUTE])
  assert.ok(limits.RUNNER_RESTART_WAITS[1] > 5 * MINUTE && limits.RUNNER_RESTART_WAITS[1] < 6 * MINUTE)
  const at = Date.parse('2026-11-09T15:00:00Z')
  assert.equal(restartUntil({ stops: 0, startedAt: '2026-11-09T14:00:00Z', stoppedAt: '2026-11-09T15:00:00Z', reason: null }), null)
  assert.equal(restartUntil({ stops: 1, startedAt: '2026-11-09T14:00:00Z', stoppedAt: '2026-11-09T15:00:00Z', reason: 'ENOSPC' }), at + MINUTE)
  // A start that couldn't record its stop, killed or out of power: from when it started.
  assert.equal(restartUntil({ stops: 3, startedAt: '2026-11-09T15:00:00Z', stoppedAt: null, reason: null }), at + 30 * MINUTE)
  // The code or the name, never the message, which can quote what was being read.
  assert.equal(stopReason(Object.assign(new Error('ENOSPC: no space left, open "/data/x"'), { code: 'ENOSPC' })), 'ENOSPC')
  assert.equal(stopReason(new SyntaxError('Unexpected token "s", "secret" is not valid JSON')), 'SyntaxError')
  const notice = restartNotice({ record: { stops: 1, startedAt: null, stoppedAt: null, reason: 'ENOSPC' }, until: at + MINUTE, now: at, timeZone: 'Asia/Kolkata' })
  assert.deepEqual(notice, {
    type: 'text',
    by: 'runner',
    text: '⚠️ I stopped on an error (ENOSPC), so I wait until 20:31 before I go on, and longer if it happens again. Restarting the runner ends the wait.',
  })
})

test('restarts: the runner keeps its own waits unless its environment says systemd keeps them, as the native unit does', () => {
  assert.equal(keepsRestartWaits({}), true)
  assert.equal(keepsRestartWaits({ SCOOTER_RESTART_WAITS: '' }), true)
  assert.equal(keepsRestartWaits({ SCOOTER_RESTART_WAITS: 'systemd' }), false)
})

// A runner whose batch, #1042, meets a fault that stays once pi has run: the outbox can't be
// written, so the runner stops on the message the run sent, before the run is recorded, and runs
// the same batch at its next start. `fault` can be turned off. Each start is as Docker's, at once
// after the last stop.
function faulty(t) {
  const prepared = prepareTestRunner(t, { lines: [...fillerLines(1041), line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 SAY')], state: HANDLED, start: START })
  const { clock, paths, sandbox } = prepared
  const control = { fault: true, piRuns: [], notices: [] }
  const keepNotices = () => {
    if (fs.existsSync(paths.outbox) && fs.statSync(paths.outbox).isDirectory()) control.notices.push(...outboxOf(paths, { take: true }).map(entry => entry.text))
  }
  const openSandbox = async () => ({
    accel: sandbox.accel,
    imageBuiltAt: sandbox.imageBuiltAt,
    async run(spec, options) {
      control.piRuns.push(clock.now())
      const result = await sandbox.run(spec, options)
      if (control.fault) {
        keepNotices()
        fs.rmSync(paths.outbox, { recursive: true, force: true })
        fs.writeFileSync(paths.outbox, '')
      }
      return result
    },
  })
  // Starts the runner, with an outbox it can write its notices to.
  control.start = async ({ restartWaits = true } = {}) => {
    if (fs.existsSync(paths.outbox) && !fs.statSync(paths.outbox).isDirectory()) fs.rmSync(paths.outbox)
    fs.mkdirSync(paths.outbox, { recursive: true, mode: 0o700 })
    const runner = await startRunner({ ...prepared, openSandbox, restartWaits })
    atEnd(t, () => runner.stop())
    return runner
  }
  // Moves the clock on a second at a time, giving the runner real time between, until it stops on
  // its own, and stops it as `scooter runner` then does. Returns when it stopped.
  control.untilStopped = async runner => {
    const stopped = runner.fatal.then(() => true)
    for (;;) {
      const done = await Promise.race([stopped, clock.whenSleeping().then(() => false)])
      if (done) break
      await new Promise(resolve => setTimeout(resolve, 5))
      await clock.advance(SECOND)
    }
    await runner.stop()
    return fs.existsSync(paths.runnerRestarts) ? parseIsoSeconds(control.record().stoppedAt) : clock.now()
  }
  control.record = () => JSON.parse(fs.readFileSync(paths.runnerRestarts, 'utf8'))
  return { ...prepared, ...control, control }
}

test('restarts: started again at once after each stop, a fault that stays runs pi 1 minute after the first stop, about 5½ after the second, then every 30, and the first wait tells the owner once', async t => {
  const context = faulty(t)
  const { clock, paths, control } = context

  // The first start runs pi, and stops on the fault.
  let runner = await control.start()
  let stoppedAt = await control.untilStopped(runner)
  const first = stoppedAt
  assert.equal(control.piRuns.length, 1)
  assert.deepEqual(control.record(), { stops: 1, startedAt: START, stoppedAt: isoSeconds(stoppedAt), reason: 'ENOTDIR' })

  for (const [n, wait] of [
    [1, MINUTE],
    [2, limits.RUNNER_RESTART_WAITS[1]],
    [3, 30 * MINUTE],
    [4, 30 * MINUTE],
  ]) {
    runner = await control.start()
    // It says so in status.json, for `scooter status`, and waits before anything can run pi.
    const until = stoppedAt + wait
    assert.deepEqual(readRunnerStatus(paths.runnerStatus).restart, { stops: n, until: isoSeconds(until), reason: 'ENOTDIR' })
    await clock.whenSleeping()
    assert.equal(control.piRuns.length, n)
    stoppedAt = await control.untilStopped(runner)
    assert.equal(control.piRuns.length, n + 1)
    const ran = control.piRuns.at(-1)
    assert.ok(ran >= until && ran < until + MINUTE, `pi ran ${(ran - until) / SECOND} s after the wait for ${n} stops`)
    assert.equal(control.record().stops, n + 1)
  }
  // One notice, at the first wait.
  assert.deepEqual(control.notices, [
    `⚠️ I stopped on an error (ENOTDIR), so I wait until ${shortTime(first + MINUTE)} before I go on, and longer if it happens again. Restarting the runner ends the wait.`,
  ])
})

// `HH:MM` in Asia/Kolkata, for a time on the test's day.
function shortTime(ms) {
  const local = new Date(ms + 5.5 * 60 * MINUTE)
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}

test('restarts: a stop asked for ends the waiting, and a run recorded makes the next stop the first in a row again', async t => {
  const context = faulty(t)
  const { clock, paths, control } = context
  let runner = await control.start()
  await control.untilStopped(runner)
  runner = await control.start()
  await control.untilStopped(runner)
  assert.equal(control.record().stops, 2)

  // Waiting about 5½ minutes, it is stopped, as `docker compose restart runner` stops it.
  const startedAt = isoSeconds(clock.now())
  runner = await control.start()
  await clock.whenSleeping()
  assert.ok(clock.sleeping().some(ms => ms > 5 * MINUTE))
  assert.equal(readRunnerStatus(paths.runnerStatus).restart.stops, 2)
  await runner.stop()
  assert.equal(control.record().stops, 0)
  assert.equal(control.piRuns.length, 2)
  // Stopped, it no longer waits, so `scooter status` doesn't say it does, as `docker compose stop
  // runner` would leave it; the rest of status.json stays.
  const status = readRunnerStatus(paths.runnerStatus)
  assert.equal(status.restart, null)
  assert.equal(status.startedAt, startedAt)

  // So the next start doesn't wait; the fault is gone, and the run is recorded.
  control.fault = false
  runner = await control.start()
  assert.equal(readRunnerStatus(paths.runnerStatus).restart, null)
  for (let n = 0; n < 20 && control.piRuns.length < 3; n++) {
    await clock.whenSleeping()
    await clock.advance(SECOND)
  }
  for (let n = 0; n < 500 && JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8')).cursor !== 1042; n++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8')).cursor, 1042)
  assert.equal(control.record().stops, 1)

  // The fault comes back with the next batch: the first stop in a row, a minute's wait, and a notice.
  control.fault = true
  writeDatastore(paths, [line.text(1043, '2026-11-09T16:00:00Z', 'tea 80')])
  const stoppedAt = await control.untilStopped(runner)
  assert.equal(control.record().stops, 1)
  control.notices.length = 0
  runner = await control.start()
  assert.deepEqual(readRunnerStatus(paths.runnerStatus).restart, { stops: 1, until: isoSeconds(stoppedAt + MINUTE), reason: 'ENOTDIR' })
  await clock.whenSleeping()
  await control.untilStopped(runner)
  assert.equal(control.notices.length, 1)
})

test('restarts: where systemd keeps the waits, the runner keeps none and writes nothing; and one that can\'t record its start runs nothing', async t => {
  const context = faulty(t)
  const { paths, control } = context
  let runner = await control.start({ restartWaits: false })
  await control.untilStopped(runner)
  runner = await control.start({ restartWaits: false })
  assert.equal(readRunnerStatus(paths.runnerStatus).restart, null)
  await control.untilStopped(runner)
  assert.equal(control.piRuns.length, 2)
  assert.equal(fs.existsSync(paths.runnerRestarts), false)

  // A record that can't be written, here a folder in its place: the start stops before any run.
  fs.mkdirSync(`${paths.runnerRestarts}/x`, { recursive: true })
  runner = await control.start()
  const error = await runner.fatal
  assert.equal(error.code, 'EISDIR')
  assert.equal(control.piRuns.length, 2)
})
