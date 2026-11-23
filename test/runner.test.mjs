// The runner as a whole, with the fake
// sandbox: failures and their notices, pauses and outages, the locks, scheduled tasks, sessions,
// `status.json` and the emulation notice, startup, and the loop.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { readLock, takeLock } from '../src/common/locks.mjs'
import { readRunnerStatus } from '../src/common/runnerstatus.mjs'
import { icuTzRelease } from '../src/runner/agentdir.mjs'
import { openRunner, runRunner, startRunner } from '../src/runner/main.mjs'
import { acquireRunLock } from '../src/runner/run.mjs'
import { EMULATION_NOTICE } from '../src/runner/status.mjs'
import { deepTree } from './support/deep-tree.mjs'
import { createFakeSandbox } from './support/fake-sandbox.mjs'
import { actFull, holds } from './support/full-disk.mjs'
import { CHECK_IN_PROMPT, exampleYaml, fillerLines, line, writeDatastore } from './support/runner.mjs'
import { MINUTE, SECOND, gitOf, openTestRunner, outboxOf, prepareTestRunner, startTestRunner } from './support/test-runner.mjs'
import { atEnd } from './support/tmp.mjs'

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
const START = '2026-11-09T15:50:30Z'
const HANDLED = { cursor: 1041, retry: [], failed: [], backfillDone: [], scheduled: {}, lastRun: null }

function openWith(t, lines, options = {}) {
  return openTestRunner(t, { lines: [...fillerLines(1041), ...lines], state: HANDLED, start: START, ...options })
}

// Lets the runner see what was added, waits out the quiet period, and runs what comes next.
async function runNext(runner, clock) {
  await runner.tick()
  await clock.advance(8 * SECOND)
  return runner.tick()
}

// ---------------------------------------------------------------------------------------------
// Failures

test('failures: a crash discards the run\'s changes, counts an attempt, and sends one notice for the first failure in a row', async t => {
  const { runner, clock, state, outbox, git, views, add, paths, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
  await runNext(runner, clock)
  assert.equal(views('notes.csv'), 'seq,text\n1042,"coffee 150"\n')
  outbox({ take: true })

  // pi files #1043 and changes the view, then crashes: the view is as it was committed.
  add(line.text(1043, '2026-11-09T15:51:00Z', 'lunch 300 MEMORY'))
  sandbox.behave({ crash: 3 })
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
  assert.equal(views('notes.csv'), 'seq,text\n1042,"coffee 150"\n')
  assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'memory')), [])
  assert.equal(git('status', '--porcelain', '--', 'views', 'memory'), '')
  assert.deepEqual(state().retry, [{ seq: 1043, attempts: 1, due: '2026-11-09T15:51:46Z', reason: 'pi exited with code 3' }])
  assert.equal(state().cursor, 1043)
  assert.deepEqual(state().lastRun, { at: '2026-11-09T15:50:46Z', ok: false, seqs: [1043], durationMs: 0 })
  assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: "⚠️ I couldn't process your last messages (pi exited with code 3). I'll try again." }])

  // The second failure in a row sends nothing.
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).outcome, { ok: false, cause: 'other' })
  assert.equal(state().retry[0].attempts, 2)
  assert.deepEqual(outbox({ take: true }), [])

  // A run that gets through ends the row; the next failure is the first of another.
  sandbox.behave(null)
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(state().retry, [])
  outbox({ take: true })
  add(line.text(1044, '2026-11-09T15:53:00Z', 'tea CRASH'))
  await runNext(runner, clock)
  assert.equal(outbox({ take: true }).length, 1)
})

test('failures: a network log that can\'t be read doesn\'t keep a failed run from being recorded (the fifth review of milestone 4)', async t => {
  const { runner, clock, state, outbox, paths, events } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 CRASH')])
  // A day's log that can't be read: a folder in its place. Too large to read whole was the same.
  fs.mkdirSync(paths.networkLog('2026-11-09'), { recursive: true })
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
  assert.equal(state().cursor, 1042)
  assert.deepEqual(state().retry.map(entry => [entry.seq, entry.attempts]), [[1042, 1]])
  assert.equal(outbox({ take: true }).length, 1)
  assert.ok(events().includes('runner.netlog_unreadable'))
})

// Puts a switch in the runner's git: `fail(subcommand)` says how a command fails, or null for
// none: `{ timedOut: true }`, as a command stopped after `GIT_CALL_TIMEOUT`, or `{ code }`. The
// fake sandbox keeps the real `proc`. Call before the runner starts.
function gitSwitch(prepared) {
  const real = prepared.proc
  let fail = () => null
  prepared.proc = {
    ...real,
    run: async (program, args, options) => {
      // The subcommand is the first argument that isn't `-c` or its setting.
      const how = program === 'git' ? fail(args.find((arg, n) => arg !== '-c' && args[n - 1] !== '-c')) : null
      if (!how) return real.run(program, args, options)
      return { code: how.timedOut ? null : how.code, signal: how.timedOut ? 'SIGTERM' : null, stdout: '', stderr: '', timedOut: how.timedOut === true }
    },
  }
  return { set: next => (fail = next ?? (() => null)) }
}

test('failures: an error in checking or committing what pi left fails the run and counts an attempt, without stopping the runner', async t => {
  const prepared = prepareTestRunner(t, { lines: [...fillerLines(1041), line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 MEMORY')], state: HANDLED, start: START })
  const git = gitSwitch(prepared)
  const { runner, clock, state, outbox, paths, sandbox, events } = await startTestRunner(t, prepared)

  // `git add` stopped once its time is up, as the review saw for a folder of 900,000 names.
  git.set(command => (command === 'add' ? { timedOut: true } : null))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
  assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: "couldn't commit the run's files (git add: timed out)" }])
  assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: "⚠️ I couldn't process your last messages (couldn't commit the run's files (git add: timed out)). I'll try again." }])
  assert.ok(events().includes('runner.files_failed'))
  // Thrown away, and the session not kept.
  assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'views')), [])
  assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'memory')), [])
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])

  // The same for `git commit`, at the next try: nothing is kept that the commit would have held.
  git.set(command => (command === 'commit' ? { code: 128 } : null))
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).outcome, { ok: false, cause: 'other' })
  assert.deepEqual(state().retry.map(entry => [entry.attempts, entry.reason]), [[2, "couldn't commit the run's files (git commit: exit code 128)"]])
  assert.equal(gitOf(paths, 'status', '--porcelain', '--', 'views', 'memory'), '')
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])

  // Once git works, the next try commits.
  git.set(null)
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  assert.equal(gitOf(paths, 'show', '--name-only', '--format=%s', 'HEAD'), 'lifelog: #1042\n\nmemory/preferences.md\nviews/notes.csv\n')
  assert.deepEqual(state().retry, [])
  assert.equal(sandbox.runs.length, 3)
})

test('failures: a clean-up that can\'t finish records the run first, then stops the runner; the start after cleans up, and the next try counts the next attempt', async t => {
  const prepared = prepareTestRunner(t, { lines: [...fillerLines(1041), line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 CRASH')], state: HANDLED, start: START })
  const git = gitSwitch(prepared)
  const { runner, clock, state, outbox, sandbox } = await startTestRunner(t, prepared)
  git.set(command => (command === 'read-tree' ? { code: 128 } : null))
  await runner.tick()
  await clock.advance(8 * SECOND)
  await assert.rejects(runner.tick(), /^Error: git read-tree: exit code 128$/)
  // The attempt is counted, and the owner told, before the runner stops.
  assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'pi exited with code 3' }])
  assert.equal(state().cursor, 1042)
  assert.equal(outbox({ take: true }).length, 1)

  // Its service manager starts it again; git works, the start cleans up, and the next try is
  // attempt 2, not the same batch run again for nothing.
  runner.close()
  git.set(null)
  const restarted = await startTestRunner(t, prepared)
  assert.equal(gitOf(prepared.paths, 'status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  await clock.advance(MINUTE)
  assert.deepEqual((await restarted.runner.tick()).outcome, { ok: false, cause: 'other' })
  assert.equal(restarted.state().retry[0].attempts, 2)
  assert.equal(sandbox.runs.length, 2)
})

test('failures: a timeout closes the run, which counts an attempt; run.lock records when the run must be over', async t => {
  const { runner, clock, state, outbox, sandbox, paths, views } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee HANG')])
  await runner.tick()
  await clock.advance(8 * SECOND)
  const running = runner.tick()
  await sandbox.whenHung()
  // The lock says when this run must be over: its start plus the agent's timeout.
  const lock = readLock(paths.runLock)
  assert.equal(lock.deadline, Date.parse('2026-11-09T15:50:38Z') + 10 * MINUTE)
  assert.equal(lock.pid, process.pid)
  assert.ok(fs.existsSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), 'notes.csv')))

  await clock.advance(10 * MINUTE)
  assert.deepEqual((await running).outcome, { ok: false, cause: 'other' })
  assert.equal(readLock(paths.runLock), null)
  assert.throws(() => views('notes.csv'), /ENOENT/)
  assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T16:01:38Z', reason: 'timed out' }])
  assert.deepEqual(outbox(), [{ type: 'text', by: 'runner', text: "⚠️ I couldn't process your last messages (timed out). I'll try again." }])
})

test('failures: a 401, 402, 403 or 404 pauses runs, counts no attempt, and is tried every 30 minutes and at a restart', async t => {
  const prepared = prepareTestRunner(t, { lines: [...fillerLines(1041), line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')], state: HANDLED, start: START })
  const { runner, clock, state, outbox, sandbox, add } = await startTestRunner(t, prepared)
  sandbox.behave({ openrouter: 404, message: 'No endpoints found matching your data policy' })
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'setup' })
  const reason = 'OpenRouter: No endpoints found matching your data policy'
  assert.deepEqual(state().paused, { since: '2026-11-09T15:50:38Z', cause: 'setup', reason, next: '2026-11-09T16:20:38Z', tries: 1 })
  assert.deepEqual(state().retry, [{ seq: 1042, attempts: 0, due: '2026-11-09T15:50:38Z', reason }])
  assert.deepEqual(outbox({ take: true }), [
    { type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (${reason}). Runs are paused until this is fixed. I'll try again every 30 minutes.` },
  ])

  // Nothing runs while paused, and messages that arrive wait.
  add(line.text(1043, '2026-11-09T15:55:00Z', 'lunch 300'))
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'paused' })
  await clock.advance(29 * MINUTE)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'paused' })
  assert.equal(sandbox.runs.length, 1)

  // The next try, in 30 minutes, fails the same way: one try more, and no notice.
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).outcome, { ok: false, cause: 'setup' })
  assert.deepEqual(state().paused.tries, 2)
  assert.deepEqual(
    state().retry.map(entry => [entry.seq, entry.attempts]),
    [
      [1042, 0],
      [1043, 0],
    ],
  )
  assert.deepEqual(outbox({ take: true }), [])

  // A restart tries again at once, once the owner has been quiet. The key has been fixed: the
  // whole batch is handled.
  runner.close()
  sandbox.behave(null)
  await clock.advance(MINUTE)
  const restarted = await startTestRunner(t, prepared)
  assert.equal(restarted.state().paused.next, '2026-11-09T16:21:38Z')
  assert.deepEqual((await runNext(restarted.runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(state().lastRun.seqs, [1042, 1043])
  assert.equal(state().paused, undefined)
  assert.deepEqual(state().retry, [])
  assert.deepEqual(state().failed, [])
})

test('failures: a 408, 429, 5xx or no answer is tried after 1, 5 and 30 minutes, then every 30, without counting attempts', async t => {
  for (const [behavior, reason] of [
    [{ openrouter: 429 }, 'OpenRouter: stub error 429'],
    [{ openrouter: 503 }, 'OpenRouter: stub error 503'],
    [{ unreachable: true }, "OpenRouter didn't answer"],
  ]) {
    await t.test(JSON.stringify(behavior), async t => {
      const { runner, clock, state, outbox, sandbox, add } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
      sandbox.behave(behavior)
      assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'outage' })
      assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (${reason}). I'll try again.` }])
      const waits = []
      for (let n = 0; n < 4; n++) {
        const { since, next } = state().paused
        assert.equal(since, '2026-11-09T15:50:38Z')
        waits.push((Date.parse(next) - clock.now()) / MINUTE)
        await clock.advance(Date.parse(next) - clock.now() - SECOND)
        assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'paused' })
        await clock.advance(SECOND)
        assert.deepEqual((await runner.tick()).outcome, { ok: false, cause: 'outage' })
      }
      waits.push((Date.parse(state().paused.next) - clock.now()) / MINUTE)
      assert.deepEqual(waits, [1, 5, 30, 30, 30])
      assert.deepEqual(state().retry.map(entry => entry.attempts), [0])
      assert.deepEqual(outbox(), [])

      // A message that arrived meanwhile goes in the same batch once OpenRouter is back.
      add(line.text(1043, '2026-11-09T17:00:00Z', 'lunch 300'))
      sandbox.behave(null)
      await runner.tick()
      await clock.advance(30 * MINUTE)
      assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
      assert.deepEqual(state().lastRun.seqs, [1042, 1043])
      assert.deepEqual(state().retry, [])
      assert.equal(state().paused, undefined)
    })
  }
})

test("failures: the network policy refusing pi's first request at OpenRouter pauses runs; refusing a later one counts an attempt", async t => {
  const reason = 'a field the pinned pi doesn\'t send: "web_search_options"'
  await t.test('first', async t => {
    const { runner, clock, state, outbox, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
    sandbox.behave({ refused: 'first' })
    assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'setup' })
    const why = `the network policy refused pi's request: ${reason}`
    assert.equal(state().paused.reason, why)
    assert.deepEqual(state().retry, [{ seq: 1042, attempts: 0, due: '2026-11-09T15:50:38Z', reason: why }])
    assert.deepEqual(outbox(), [
      { type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (${why}). Runs are paused until this is fixed. I'll try again every 30 minutes.` },
    ])
  })
  await t.test('after a request went out', async t => {
    const { runner, clock, state, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
    sandbox.behave({ refused: 'later' })
    assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
    assert.equal(state().paused, undefined)
    assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: `the network policy refused a request: ${reason}` }])
  })
})

test('failures: a run that times out waiting for OpenRouter is an outage', async t => {
  const { runner, clock, state, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee NOANSWER')])
  await runner.tick()
  await clock.advance(8 * SECOND)
  const running = runner.tick()
  await sandbox.whenHung()
  await clock.advance(10 * MINUTE)
  assert.deepEqual((await running).outcome, { ok: false, cause: 'outage' })
  assert.equal(state().paused.reason, "OpenRouter didn't answer")
  assert.equal(state().retry[0].attempts, 0)
})

test('failures: a sandbox that can\'t run pi pauses runs as a setup error', async t => {
  const { runner, clock, state, sandbox, outbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee')])
  sandbox.run = async () => {
    throw Object.assign(new Error('qemu-system-x86_64: not found'), { code: 'ENOENT' })
  }
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'setup' })
  assert.equal(state().paused.reason, "the VM couldn't start")
  assert.equal(state().retry[0].attempts, 0)
  assert.equal(outbox().length, 1)
})

test('failures: items that run out of attempts in failing runs are given up on, with one notice', async t => {
  const { runner, clock, state, outbox, sandbox } = await openWith(t, [
    line.text(1042, '2026-11-09T15:50:00Z', 'coffee 120'),
    line.text(1043, '2026-11-09T15:50:01Z', '', { files: [{ path: '1043.jpg', mime: 'image/jpeg', bytes: 10 }] }),
  ])
  sandbox.behave({ crash: 1 })
  await runNext(runner, clock)
  for (let n = 0; n < 3; n++) {
    await clock.advance(MINUTE)
    await runner.tick()
  }
  assert.deepEqual(state().retry, [])
  assert.deepEqual(
    state().failed.map(entry => [entry.seq, entry.reason]),
    [
      [1042, 'not handled after 4 attempts'],
      [1043, 'not handled after 4 attempts'],
    ],
  )
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'runner', text: "⚠️ I couldn't process your last messages (pi exited with code 1). I'll try again." },
    { type: 'text', by: 'runner', text: '⚠️ I gave up on #1042 ("coffee 120") and #1043 (a photo) after 4 attempts. Send them again if they matter.' },
  ])
})

// ---------------------------------------------------------------------------------------------
// Locks

test('locks: no run while a backup holds its lock, and runs go on once it is gone', async t => {
  const { runner, clock, paths, sandbox, state, entries } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee')])
  fs.writeFileSync(paths.backupLock, '{"pid":1,"at":"2026-11-09T15:50:00Z","deadline":null}\n')
  assert.deepEqual((await runNext(runner, clock)).outcome, 'waiting')
  await clock.advance(SECOND)
  assert.deepEqual((await runner.tick()).outcome, 'waiting')
  assert.equal(sandbox.runs.length, 0)
  assert.equal(fs.existsSync(paths.runLock), false)
  assert.equal(state().cursor, 1041)
  // Said once, not every second.
  assert.equal(entries.filter(entry => entry.event === 'runner.waiting').length, 1)

  fs.rmSync(paths.backupLock)
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  assert.equal(state().cursor, 1042)
})

test('locks: the runner takes its own lock before it looks for the backup\'s, and gives way when both are there', async t => {
  const { paths, clock } = await openWith(t, [])
  const deadline = clock.now() + 10 * MINUTE
  assert.equal(acquireRunLock({ paths, deadline, clock }), 'taken')
  assert.equal(readLock(paths.runLock).deadline, Math.floor(deadline / 1000) * 1000)
  // A second run, or a rebuild, can't take it.
  assert.equal(acquireRunLock({ paths, deadline, clock }), 'busy')
  fs.rmSync(paths.runLock)

  // A backup that took its lock first: the runner gives way, and lets go of its own, so the backup,
  // which then looks for run.lock, finds none.
  assert.equal(takeLock(paths.backupLock, { clock }), true)
  assert.equal(acquireRunLock({ paths, deadline, clock }), 'backup')
  assert.equal(fs.existsSync(paths.runLock), false)
})

// ---------------------------------------------------------------------------------------------
// Tasks and sessions

test('tasks: the evening check-in runs at 21:30 with its prompt, is logged by its tag, sends its text on its own, and is done for the day', async t => {
  const { runner, clock, state, outbox, sandbox, git, entries } = await openWith(t, [], { yaml: exampleYaml() })
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  await clock.advance(10 * MINUTE - 30 * SECOND)
  const { action, outcome } = await runner.tick()
  assert.equal(action.kind, 'scheduled')
  assert.deepEqual(outcome, { ok: true, cause: null })
  // Its trigger's prompt, filled in: it gives no lines.
  assert.equal(sandbox.runs[0].spec.argv.at(-1), CHECK_IN_PROMPT.replace('$now$', 'Monday 9 November 2026, 21:30').replace('$user.timezone$', 'Asia/Kolkata').replace('$reply_mode$', 'quiet'))
  // The log names the task by its tag: `at` is the time of the log's own line.
  assert.deepEqual(
    entries.filter(entry => entry.event === 'runner.run_started'),
    [{ at: '2026-11-09T16:00:00Z', level: 'info', component: 'test', event: 'runner.run_started', agent: 'lifelog', job: 'scheduled', seqs: [], tag: 'check-in', session: 'lifelog-2026-11-09' }],
  )
  // Its text is Scooter's own: no `about`, so it goes to DEFAULT_CHANNEL, if sends names it.
  assert.deepEqual(outbox(), [{ type: 'text', by: 'lifelog', text: 'Today: nothing missing.', channels: ['whatsapp'] }])
  assert.deepEqual(state().scheduled, { '21:30': '2026-11-09' })
  assert.deepEqual(state().lastRun.seqs, [])
  assert.equal(state().cursor, 1041)
  // Nothing changed, so nothing was committed.
  assert.equal(git('rev-list', '--count', 'HEAD'), '1\n')
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
})

test('tasks: a scheduled task that fails for its own reasons waits for its next time; after an outage it is the next try', async t => {
  // A runner that starts at 21:30 or later leaves the day's check-in for the next day.
  const after = await openWith(t, [], { start: '2026-11-09T16:00:00Z' })
  assert.deepEqual(after.state().scheduled, { '21:30': '2026-11-09' })
  assert.deepEqual((await after.runner.tick()).action, { kind: 'idle', reason: 'nothing' })

  const late = await openWith(t, [], { start: '2026-11-09T15:59:59Z' })
  late.sandbox.behave({ crash: 2 })
  await late.clock.advance(SECOND)
  assert.deepEqual((await late.runner.tick()).outcome, { ok: false, cause: 'other' })
  assert.deepEqual(late.state().scheduled, { '21:30': '2026-11-09' })
  assert.equal(late.sandbox.runs.length, 1)
  assert.deepEqual(late.outbox(), [{ type: 'text', by: 'runner', text: "⚠️ I couldn't run the scheduled task check-in (pi exited with code 2). It runs again at its next time." }])

  const outage = await openWith(t, [], { start: '2026-11-09T15:59:59Z' })
  outage.sandbox.behave({ openrouter: 502 })
  await outage.clock.advance(SECOND)
  assert.deepEqual((await outage.runner.tick()).outcome, { ok: false, cause: 'outage' })
  assert.deepEqual(outage.state().scheduled, { '21:30': '2026-11-08' })
  outage.sandbox.behave(null)
  await outage.clock.advance(MINUTE)
  const retried = await outage.runner.tick()
  assert.equal(retried.action.kind, 'scheduled')
  assert.deepEqual(retried.outcome, { ok: true, cause: null })
  assert.deepEqual(outage.state().scheduled, { '21:30': '2026-11-09' })
})

test('tasks: a scheduled task that a setup error holds back is still the next try when the runner restarts', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: '2026-11-09T15:59:59Z' })
  const { runner, clock, state, sandbox } = await startTestRunner(t, prepared)
  sandbox.behave({ openrouter: 401 })
  await clock.advance(SECOND)
  assert.deepEqual((await runner.tick()).outcome, { ok: false, cause: 'setup' })
  assert.deepEqual(state().scheduled, { '21:30': '2026-11-08' })

  // The key is fixed and the runner restarts, after the task's time: the task is tried at once.
  runner.close()
  sandbox.behave(null)
  await clock.advance(MINUTE)
  const restarted = await startTestRunner(t, prepared)
  assert.deepEqual(restarted.state().scheduled, { '21:30': '2026-11-08' })
  const { action, outcome } = await restarted.runner.tick()
  assert.deepEqual(action, { kind: 'scheduled', at: '21:30', tag: 'check-in', date: '2026-11-09', prompt: CHECK_IN_PROMPT })
  assert.deepEqual(outcome, { ok: true, cause: null })
  assert.equal(state().paused, undefined)
  assert.deepEqual(state().scheduled, { '21:30': '2026-11-09' })
})

test('sessions: a day\'s session ends at SESSION_ROLLOVER_HOUR, and the runs after it go into the next day\'s', async t => {
  // 03:59:30 in Asia/Kolkata on Tuesday 10 November: still Monday's session.
  const { runner, clock, add, sandbox, paths, state } = await openTestRunner(t, {
    lines: [...fillerLines(1041), line.text(1042, '2026-11-09T22:29:00Z', 'late tea')],
    state: HANDLED,
    start: '2026-11-09T22:29:30Z',
  })
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  // 04:00:30, past the rollover hour: Tuesday's.
  await clock.advance(MINUTE - 8 * SECOND)
  add(line.text(1043, '2026-11-09T22:30:00Z', 'early run'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(state().lastRun.seqs, [1043])
  assert.deepEqual(
    sandbox.runs.map(({ spec }) => spec.argv[spec.argv.indexOf('--session-id') + 1]),
    ['lifelog-2026-11-09', 'lifelog-2026-11-10'],
  )
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')).sort(), ['lifelog-2026-11-09.jsonl', 'lifelog-2026-11-10.jsonl'])
  // The new session didn't continue the old one.
  assert.equal(sandbox.seen()[1].sessionContinued, false)
  // A session whose file is removed ends too: the next run starts it again.
  fs.rmSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-10.jsonl'))
  add(line.text(1044, '2026-11-09T22:31:00Z', 'and breakfast'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(sandbox.runs[2].spec.argv[sandbox.runs[2].spec.argv.indexOf('--session-id') + 1], 'lifelog-2026-11-10')
  assert.equal(sandbox.seen()[2].sessionContinued, false)
})

// ---------------------------------------------------------------------------------------------
// Startup, status.json and the emulation notice

test('status: status.json holds what scooter status shows of the runner\'s settings', async t => {
  const { paths } = await openWith(t, [], { settings: { agentInternet: true, zdr: false } })
  assert.deepEqual(readRunnerStatus(paths.runnerStatus), {
    startedAt: '2026-11-09T15:50:30Z',
    accel: 'kvm',
    zdr: false,
    internet: true,
    imageBuiltAt: '2026-11-09T10:00:00Z',
    agents: { lifelog: { model: 'anthropic/claude-sonnet-5.5', timeoutMinutes: 10, channels: ['whatsapp', 'email'] } },
    restart: null,
  })
  assert.equal(fs.statSync(paths.runnerStatus).mode & 0o777, 0o600)
})

test('status: the emulation notice goes out when the accelerator changes to emulation, and not again at the next start', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: START, accel: 'emulation' })
  const notices = () => outboxOf(prepared.paths, { take: true }).map(entry => entry.text)
  const start = async ({ accel, setting = 'auto' }) => {
    const sandbox = createFakeSandbox({ root: path.join(prepared.root, `sandbox-${accel}`), paths: prepared.paths, proc: prepared.proc, clock: prepared.clock, accel })
    const runner = await openRunner({ ...prepared, settings: { ...prepared.settings, agentAccel: setting }, openSandbox: async () => sandbox })
    await runner.close()
    return readRunnerStatus(prepared.paths.runnerStatus).accel
  }

  // The first start falls back to emulation: one notice.
  assert.equal(await start({ accel: 'emulation' }), 'emulation')
  assert.deepEqual(notices(), [EMULATION_NOTICE])
  // A restart, still under emulation: none.
  await start({ accel: 'emulation' })
  assert.deepEqual(notices(), [])
  // KVM comes back, then goes again: another.
  await start({ accel: 'kvm' })
  assert.deepEqual(notices(), [])
  await start({ accel: 'emulation' })
  assert.deepEqual(notices(), [EMULATION_NOTICE])
  // Emulation asked for, after KVM, hasn't fallen back: none.
  await start({ accel: 'kvm' })
  await start({ accel: 'emulation', setting: 'emulation' })
  assert.deepEqual(notices(), [])
  assert.match(EMULATION_NOTICE, /^⚠️ My VMs run under emulation now/)
})

test('startup: a leftover run.lock is removed, and changes a run left uncommitted are thrown away', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: START })
  const first = await startTestRunner(t, prepared)
  first.runner.close()
  // A runner killed during a run leaves its lock and pi's changes.
  fs.writeFileSync(prepared.paths.runLock, '{"pid":4211,"at":"2026-11-09T15:50:02Z","deadline":"2026-11-09T16:00:02Z"}\n')
  fs.writeFileSync(path.join(path.join(prepared.paths.agentDir('lifelog'), 'views'), 'half.csv'), 'x\n')
  fs.symlinkSync('/etc/hostname', path.join(path.join(prepared.paths.agentDir('lifelog'), 'memory'), 'link.md'))
  // A folder pi took the runner's access away from, with another inside.
  const locked = path.join(path.join(prepared.paths.agentDir('lifelog'), 'views'), 'locked')
  fs.mkdirSync(path.join(locked, 'deep'), { recursive: true })
  fs.writeFileSync(path.join(locked, 'deep', 'notes.csv'), 'x\n')
  fs.chmodSync(path.join(locked, 'deep'), 0o000)
  fs.chmodSync(locked, 0o000)
  // And a git killed while it held the index and the branch, by a power cut or a SIGKILL.
  const gitDir = path.join(prepared.paths.agentDir('lifelog'), '.git')
  fs.writeFileSync(path.join(gitDir, 'index.lock'), '')
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main.lock'), '')
  const second = await startTestRunner(t, prepared)
  assert.equal(fs.existsSync(prepared.paths.runLock), false)
  assert.deepEqual(fs.readdirSync(path.join(prepared.paths.agentDir('lifelog'), 'views')), [])
  assert.deepEqual(fs.readdirSync(path.join(prepared.paths.agentDir('lifelog'), 'memory')), [])
  assert.ok(prepared.events().includes('runner.lock_removed'))
  assert.ok(prepared.events().includes('agent.git_lock_removed'))

  // The next run commits.
  second.add(line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150'))
  assert.deepEqual((await runNext(second.runner, prepared.clock)).outcome, { ok: true, cause: null })
  assert.equal(second.git('log', '-1', '--format=%s'), 'lifelog: #1042\n')
})

test("startup: the runner says once in its log when its own Node's zone rules are another release than those that ship for the VM, and goes on", async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: START })
  const vm = icuTzRelease()
  const start = async options => {
    prepared.entries.length = 0
    const runner = await openRunner({ settings: prepared.settings, openSandbox: async () => prepared.sandbox, clock: prepared.clock, log: prepared.log, proc: prepared.proc, ...options })
    const said = prepared.entries.filter(entry => entry.event === 'runner.zone_rules_differ').map(({ level, runner, vm }) => ({ level, runner, vm }))
    // It goes on: a round of the loop runs.
    await runner.tick()
    runner.close()
    return said
  }
  // Another release: one line, with both.
  assert.deepEqual(await start({ runnerTz: '2020a' }), [{ level: 'info', runner: '2020a', vm }])
  // The same: none.
  assert.deepEqual(await start({ runnerTz: vm }), [])
  // By default, this Node's own.
  assert.deepEqual(await start({}), process.versions.tz === vm ? [] : [{ level: 'info', runner: process.versions.tz, vm }])
  assert.match(vm, /^\d{4}[a-z]+$/)
})

test('startup: trees whose paths pass what the system takes, in views/, run/session/ and what a clean-up set aside, don\'t keep the runner from starting', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: START })
  const first = await startTestRunner(t, prepared)
  first.runner.close()
  // pi made them by moving a folder into another (the fourth review of milestone 4); a run cut
  // short left the first two, and a clean-up that couldn't remove it the third.
  const { paths } = prepared
  const discarded = paths.agentDiscarded('lifelog')
  fs.mkdirSync(path.join(discarded, 'views-1'), { recursive: true })
  for (const dir of [path.join(paths.agentDir('lifelog'), 'views'), paths.agentRunSession('lifelog'), path.join(discarded, 'views-1')]) deepTree(dir)

  const second = await startTestRunner(t, prepared)
  for (const dir of [path.join(paths.agentDir('lifelog'), 'views'), paths.agentRunSession('lifelog'), discarded]) assert.deepEqual(fs.readdirSync(dir), [], dir)
  assert.deepEqual(prepared.events().filter(event => event.endsWith('_left')), [])
  second.add(line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150'))
  assert.deepEqual((await runNext(second.runner, prepared.clock)).outcome, { ok: true, cause: null })
})

test('startup: on a disk pi filled, the start frees what pi wrote before it makes any folder', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: START })
  const first = await startTestRunner(t, prepared)
  first.runner.close()
  // A crash, after a run that filled the disk, cut its clean-up short once views/ was set aside and
  // before it was made again; run/session/ was still full too.
  const { paths } = prepared
  const discarded = paths.agentDiscarded('lifelog')
  fs.mkdirSync(discarded, { recursive: true })
  fs.renameSync(path.join(paths.agentDir('lifelog'), 'views'), path.join(discarded, 'views-1'))
  fs.mkdirSync(paths.agentRunSession('lifelog'))
  for (const file of [path.join(discarded, 'views-1', 'fill.bin'), path.join(paths.agentRunSession('lifelog'), 'fill.bin')]) {
    fs.writeFileSync(file, '')
    fs.truncateSync(file, 1024 ** 3)
  }
  const restore = actFull(() => holds([paths.agentRunSession('lifelog'), discarded], 'fill.bin'))
  let second
  try {
    second = await startTestRunner(t, prepared)
  } finally {
    restore()
  }
  assert.equal(fs.statSync(path.join(paths.agentDir('lifelog'), 'views')).isDirectory(), true)
  for (const dir of [path.join(paths.agentDir('lifelog'), 'views'), paths.agentRunSession('lifelog'), discarded]) assert.deepEqual(fs.readdirSync(dir), [], dir)
  second.add(line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150'))
  assert.deepEqual((await runNext(second.runner, prepared.clock)).outcome, { ok: true, cause: null })
})

test('startup: on a disk pi filled, a folder of writes that pi removed is made again only once what pi wrote is freed', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: START })
  const first = await startTestRunner(t, prepared)
  first.runner.close()
  // pi removed views/, which the VM allows of a folder writes names, and filled the disk in
  // memory/; then a crash, before the clean-up.
  const { paths } = prepared
  const agent = paths.agentDir('lifelog')
  fs.rmdirSync(path.join(agent, 'views'))
  const fill = path.join(agent, 'memory', 'fill.bin')
  fs.writeFileSync(fill, '')
  fs.truncateSync(fill, 1024 ** 3)
  const restore = actFull(() => holds([path.join(agent, 'memory'), paths.agentDiscarded('lifelog')], 'fill.bin'))
  let second
  try {
    second = await startTestRunner(t, prepared)
  } finally {
    restore()
  }
  for (const folder of ['views', 'memory']) assert.deepEqual(fs.readdirSync(path.join(agent, folder)), [], folder)
  second.add(line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150'))
  assert.deepEqual((await runNext(second.runner, prepared.clock)).outcome, { ok: true, cause: null })
})

test('startup: one runner per data folder, and a bad agents.yaml stops it with exit code 2, naming the field', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(3), start: START })
  await startTestRunner(t, prepared)
  await assert.rejects(openRunner({ ...prepared, openSandbox: async () => prepared.sandbox }), /another runner, rebuild or build-image is running on this data folder/)

  fs.writeFileSync(prepared.paths.agentsYaml, exampleYaml().replace('reply_mode: quiet', 'reply_mode: chatty'))
  let err = ''
  const code = await runRunner({ settings: { ...prepared.settings, dataDir: path.join(prepared.root, 'other') }, stderr: { write: text => (err += text) }, openSandbox: async () => prepared.sandbox, clock: prepared.clock })
  assert.equal(code, 2)
  assert.match(err, /^scooter runner: .*agents\.yaml, line \d+: agents\.lifelog\.reply_mode must be quiet or confirm\n$/)

  // A prompt's variable the runner doesn't know, and one that its settings and paths make too
  // long once filled in, are faults of agents.yaml too, at the start, before anything runs.
  fs.writeFileSync(prepared.paths.agentsYaml, exampleYaml().replace('New: $seq.unread$', 'New: $seq.new$'))
  err = ''
  assert.equal(await runRunner({ settings: { ...prepared.settings, dataDir: path.join(prepared.root, 'other') }, stderr: { write: text => (err += text) }, openSandbox: async () => prepared.sandbox, clock: prepared.clock }), 2)
  assert.match(err, /^scooter runner: .*agents\.yaml, line \d+: agents\.lifelog\.run\[0\]\.prompt holds \$seq\.new\$, which is no variable the runner knows: /)
  fs.writeFileSync(prepared.paths.agentsYaml, exampleYaml().replace('New: $seq.unread$', () => `New: $seq.unread$ ${'$agent.dir$ '.repeat(800)}`))
  err = ''
  const deep = path.join(prepared.root, 'other', 'a'.repeat(100))
  assert.equal(await runRunner({ settings: { ...prepared.settings, dataDir: deep }, stderr: { write: text => (err += text) }, openSandbox: async () => prepared.sandbox, clock: prepared.clock }), 2)
  assert.match(err, /agents\.lifelog\.run\[0\]\.prompt can make a prompt of \d+ bytes, filled in with the longest values its variables can take, where pi can be given 98304 at most/)
  assert.ok(!fs.existsSync(path.join(deep, 'agents')))
})

// ---------------------------------------------------------------------------------------------
// The loop

test('loop: the runner polls once a second, runs a batch when the owner is quiet, and stops in the middle of a run', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(1041), state: HANDLED, start: START })
  const { clock, paths, sandbox } = prepared
  const runner = await startRunner({ ...prepared, openSandbox: async () => sandbox })
  atEnd(t, () => runner.stop())
  const state = () => JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8'))
  const seconds = async count => {
    for (let n = 0; n < count; n++) {
      await clock.whenSleeping()
      await clock.advance(SECOND)
    }
  }

  // The bridge stores a message; the runner sees it within a second, and runs after 8 quiet ones.
  await seconds(1)
  writeDatastore(paths, [line.text(1042, '2026-11-09T15:50:31Z', 'coffee')])
  await seconds(8)
  assert.equal(sandbox.runs.length, 0)
  await seconds(1)
  await waitFor(() => state().cursor === 1042)
  assert.equal(sandbox.runs.length, 1)

  // A run in progress when the runner stops is thrown away, as after a crash, and its lock let go.
  writeDatastore(paths, [line.text(1043, '2026-11-09T15:51:00Z', 'tea HANG')])
  await seconds(10)
  await sandbox.whenHung()
  assert.ok(fs.existsSync(paths.runLock))
  await runner.stop()
  assert.equal(state().cursor, 1042)
  assert.equal(fs.existsSync(paths.runLock), false)
  assert.equal(fs.readFileSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), 'notes.csv'), 'utf8').split('\n').length, 3)
  assert.ok(prepared.events().includes('runner.run_stopped'))
  assert.ok(prepared.events().includes('runner.stopped'))
})

test('loop: a damaged datastore stops the runner', async t => {
  const prepared = prepareTestRunner(t, { lines: fillerLines(3), start: START })
  const runner = await startRunner({ ...prepared, openSandbox: async () => prepared.sandbox })
  atEnd(t, () => runner.stop())
  await prepared.clock.whenSleeping()
  fs.appendFileSync(prepared.paths.dayLog('2026/11/08'), `${JSON.stringify(line.text(9, '2026-11-08T11:00:00Z', 'skips a seq'))}\n`)
  await prepared.clock.advance(SECOND)
  const error = await runner.fatal
  assert.equal(error.name, 'DatastoreError')
  assert.ok(prepared.events().includes('runner.failed'))
})

async function waitFor(condition) {
  for (let n = 0; n < 500 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(condition())
}
