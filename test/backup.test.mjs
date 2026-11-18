// Backups (5.5 of DESIGN.md; section 10, "Backups"): the lock coordination with a restic stub, a
// backup that waits for a run to finish and goes ahead once `run.lock` is 2 minutes past its time,
// and a leftover `backup.lock` removed at startup; restic's arguments and environment; the
// schedule; the replies, the notices and `/status`; the commands; and, when restic is installed, a
// real round trip: init, back up, no plaintext in the repository, the wrong password failing, the
// restore matching, and `--force` needed for a target that isn't empty.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { BACKUPS_OFF, OFF_REPLY, backUp, createBackups, createRestic, restoreArgs, runBackupInit, runCheck, runRestore, runSnapshots, snapshotBase } from '../src/bridge/backup.mjs'
import { startBridge } from '../src/bridge/main.mjs'
import { openBridgeState } from '../src/bridge/state.mjs'
import { createIds, ensureDir, listHandOffs } from '../src/common/files.mjs'
import { holdInstance } from '../src/common/instance.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { lockExists, releaseLock, takeLock } from '../src/common/locks.mjs'
import { writeOutboxEntry } from '../src/common/outbox.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { acquireRunLock } from '../src/runner/run.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { createMailReaderStub } from './support/mail-reader.mjs'
import { AUTHSERV, OWNER_ADDRESSES } from './support/mail-samples.mjs'
import { createResticStub, realRestic } from './support/restic.mjs'
import { isRoot, mayCreateUsers } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'
import { OWNER_NUMBER, createWacliStub, listRow, waitFor, webhookPayload } from './support/wacli.mjs'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
const START = '2026-11-09T15:50:30Z'

const BACKUP = {
  repository: 's3:https://account.r2.cloudflarestorage.com/bucket/scooter',
  password: 'correct horse battery staple',
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 12,
  forceCheck: false,
  restoreTarget: '/',
  env: { AWS_DEFAULT_REGION: 'auto', AWS_ACCESS_KEY_ID: 'key-id', AWS_SECRET_ACCESS_KEY: 'key-secret' },
}

// The mailbox's settings, for the bridge with email on. The reader is its stub, which reaches no
// mailbox (`support/mail-reader.mjs`).
const EMAIL = { host: 'imap.example.com', port: 993, user: 'scooter.inbox@example.com', password: 'app-password', ownerAddresses: OWNER_ADDRESSES, authservId: AUTHSERV, checkSeconds: 60 }

function settingsFor(root, extra = {}) {
  return {
    side: 'bridge',
    dataDir: path.join(root, 'data'),
    configDir: path.join(root, 'config'),
    timeZone: 'Asia/Kolkata',
    ownerNumber: OWNER_NUMBER,
    ownerJids: [],
    defaultChannel: 'whatsapp',
    email: null,
    backupTime: '03:30',
    ...extra,
    backup: extra.backup === null ? null : { ...BACKUP, ...extra.backup },
  }
}

// An outbox entry the data folder holds before a backup, which isn't one of the backup's.
const FIXTURE_ENTRY = '20261109T155000000-0001'

// The folders a backup holds, as a bridge and a runner leave them, with a file in each.
function fillDataFolder(paths) {
  const files = {
    [path.join(paths.datastore, '2026/11/09/log.jsonl')]: '{"seq":1,"text":"PLAINTEXT-RECEIPT-MARKER"}\n',
    [path.join(paths.datastore, '2026/11/09/1.jpg')]: 'jpeg bytes',
    [path.join(paths.agentViews('lifelog'), 'expenses.csv')]: 'date,amount\n2026-11-09,450\n',
    [path.join(paths.agentState('lifelog'))]: '{"cursor":1}\n',
    [path.join(paths.wacliStore, 'wacli.db')]: 'the WhatsApp session',
    [path.join(paths.wacliCache, 'thumbnail')]: 'a cache',
    [paths.bridgeState]: '{"firstStart":"2026-11-09T15:43:02Z","ownerChat":null,"lastBackup":null,"commandSeq":0}\n',
    [paths.mailState]: '{"next":5}\n',
    [paths.networkLog('2026-11-09')]: '{"event":"request"}\n',
    [path.join(paths.outbox, FIXTURE_ENTRY, 'entry.json')]: '{"type":"text","by":"runner","text":"hi"}\n',
    [path.join(paths.agentDiscarded('lifelog'), 'views-1', 'left.csv')]: 'being removed',
    [path.join(paths.runnerImage, 'rootfs.ext4')]: 'the VM image',
  }
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  fs.mkdirSync(paths.locks, { recursive: true })
}

// The bridge's backups, on a data folder of the test's, with the restic stub, the fake clock, and
// stand-ins for what the bridge stops and starts again, which say what restic had been asked by
// then.
function harness(t, { extra = {}, start = START, quiesce, resume, onFatal } = {}) {
  const root = makeTestDir(t)
  const stub = createResticStub(t, root)
  const clock = createFakeClock(start)
  const { log, entries, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const settings = settingsFor(root, extra)
  const paths = makePaths(settings)
  fillDataFolder(paths)
  const state = openBridgeState({ paths, clock, log })
  const happened = []
  const backups = createBackups({
    settings,
    paths,
    proc,
    log,
    clock,
    ids: createIds(clock),
    state,
    quiesce: quiesce ?? (async () => happened.push(['quiesce', stub.commands().length])),
    resume: resume ?? (async () => happened.push(['resume', stub.commands().length])),
    onFatal,
  })
  atEnd(t, () => backups.stop())
  // The bridge writes its own entries to its own outbox (D205).
  const outbox = () => listHandOffs(paths.bridgeOutbox).map(id => JSON.parse(fs.readFileSync(path.join(paths.bridgeOutbox, id, 'entry.json'), 'utf8')))
  return { root, stub, clock, log, entries, events, proc, settings, paths, state, backups, happened, outbox }
}

// Moves the fake clock on a second at a time, waiting each time for the code under test to sleep.
async function seconds(clock, count) {
  for (let i = 0; i < count; i++) {
    await clock.whenSleeping()
    await clock.advance(SECOND)
  }
}

// ---------------------------------------------------------------------------------------------
// The locks (5.5, rows 6 and 7)

test('backups: a backup takes backup.lock, waits for a run to finish, and stops the writers only while restic runs', async t => {
  const h = harness(t)
  takeLock(h.paths.runLock, { deadline: h.clock.now() + 10 * MINUTE, clock: h.clock })
  const done = h.backups.request('signal')
  await h.clock.whenSleeping()
  // Its own lock first, then the other's.
  assert.equal(lockExists(h.paths.backupLock), true)
  assert.match(h.backups.statusLine(h.clock.now()), /^Backups: one in progress since 21:20, waiting for the agent's run to end; none yet\. Next Tue 10 Nov 03:30\.$/)

  await h.clock.advance(9 * MINUTE)
  assert.deepEqual(h.stub.commands(), [])
  assert.deepEqual(h.happened, [])
  releaseLock(h.paths.runLock)
  await h.clock.advance(SECOND)
  assert.deepEqual(await done, { ok: true, snapshot: 'abcd1234', checked: false })

  assert.deepEqual(h.stub.commands(), ['backup', 'forget'])
  // The channels and delivery stopped before restic started, and started again once it was done.
  assert.deepEqual(h.happened, [['quiesce', 0], ['resume', 2]])
  assert.equal(lockExists(h.paths.backupLock), false)
  assert.equal(h.events().filter(event => event === 'backup.waiting').length, 1)
  // While it holds backup.lock no run starts; once it is gone, one does.
  assert.equal(acquireRunLock({ paths: h.paths, deadline: h.clock.now() + MINUTE, clock: h.clock }), 'taken')
})

test('backups: the runner gives way to a backup in progress, and a run taken first holds the backup back', async t => {
  const h = harness(t, { extra: { backup: {} } })
  h.stub.fixtures({ hold: ['backup'] })
  const done = h.backups.request('signal')
  await h.stub.holding('backup')
  // When both locks appear together the runner gives way (6.4): it takes its lock, sees the
  // backup's, and lets go of its own.
  assert.equal(acquireRunLock({ paths: h.paths, deadline: h.clock.now() + MINUTE, clock: h.clock }), 'backup')
  assert.equal(lockExists(h.paths.runLock), false)
  h.stub.release('backup')
  assert.equal((await done).ok, true)
})

test('backups: once run.lock is 2 minutes past its time, and no runner holds its socket, a runner that died left it, and the backup goes ahead', async t => {
  const h = harness(t)
  takeLock(h.paths.runLock, { deadline: h.clock.now() + MINUTE, clock: h.clock })
  const done = h.backups.request('scheduled')
  await h.clock.whenSleeping()
  await h.clock.advance(2 * MINUTE + 59 * SECOND)
  assert.deepEqual(h.stub.commands(), [])
  // Its time plus BACKUP_LOCK_EXTRA.
  await seconds(h.clock, 1)
  assert.equal((await done).ok, true)
  assert.deepEqual(h.stub.commands(), ['backup', 'forget'])
  assert.ok(h.events().includes('backup.run_lock_left'))
  // Only the runner removes its lock, at its next start.
  assert.equal(lockExists(h.paths.runLock), true)
})

test('backups: past its time, a runner that still holds runner.sock is at work, packing or cleaning up, and the backup waits on (the plan, milestone 10)', async t => {
  const h = harness(t)
  const runner = await holdInstance(h.paths.runnerSocket, 'runner')
  atEnd(t, () => runner.close())
  takeLock(h.paths.runLock, { deadline: h.clock.now() - HOUR, clock: h.clock })
  const done = h.backups.request('scheduled')
  await seconds(h.clock, 30)
  assert.deepEqual(h.stub.commands(), [])
  assert.equal(h.events().filter(event => event === 'backup.run_overdue').length, 1)
  // The runner is done: it lets go of run.lock, and the backup goes on.
  releaseLock(h.paths.runLock)
  await seconds(h.clock, 1)
  assert.equal((await done).ok, true)
  assert.ok(!h.events().includes('backup.run_lock_left'))

  // A runner that dies holding the lock: its socket stops answering, and the backup goes ahead.
  takeLock(h.paths.runLock, { deadline: h.clock.now() - HOUR, clock: h.clock })
  const again = h.backups.request('scheduled')
  await seconds(h.clock, 3)
  assert.equal(h.stub.commands().length, 2)
  await runner.close()
  await seconds(h.clock, 1)
  assert.equal((await again).ok, true)
  assert.ok(h.events().includes('backup.run_lock_left'))
})

test('backups: a run.lock that is a link, a FIFO or not a lock is past its time, and holds the backup only while a runner answers', async t => {
  const h = harness(t)
  // A FIFO isn't waited on: the bridge's one thread would wait with it.
  execFileSync('mkfifo', [h.paths.runLock])
  assert.equal((await h.backups.request('signal')).ok, true)
  fs.rmSync(h.paths.runLock)
  fs.symlinkSync(path.join(h.root, 'elsewhere'), h.paths.runLock)
  assert.equal((await h.backups.request('signal')).ok, true)
  fs.rmSync(h.paths.runLock)
  fs.writeFileSync(h.paths.runLock, 'not a lock')
  assert.equal((await h.backups.request('signal')).ok, true)
  // With a runner that answers, such a lock holds the backup until it goes.
  const runner = await holdInstance(h.paths.runnerSocket, 'runner')
  atEnd(t, () => runner.close())
  const held = h.backups.request('signal')
  await seconds(h.clock, 3)
  assert.equal(h.stub.commands().length, 6)
  fs.rmSync(h.paths.runLock)
  await seconds(h.clock, 1)
  assert.equal((await held).ok, true)
})

test('backups: a leftover backup.lock is removed when the bridge starts, and a backup removes its own when it is done, whatever happened', async t => {
  const root = makeTestDir(t)
  createWacliStub(t, root).fixtures({ paired: false })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0 }))
  const settings = settingsFor(root, { backup: null })
  const paths = makePaths(settings)
  fs.mkdirSync(paths.locks, { recursive: true })
  takeLock(paths.backupLock)
  const clock = createFakeClock(START)
  const { log, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const bridge = await startBridge({ settings, clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc })
  atEnd(t, () => bridge.stop())
  assert.equal(lockExists(paths.backupLock), false)
  assert.ok(events().includes('bridge.lock_removed'))
  // Backups are off without a repository: said once at startup.
  assert.ok(events().includes('backup.off'))

  const h = harness(t)
  h.stub.fixtures({ exit: { backup: 1 }, stderr: { backup: 'Fatal: unable to open repository\n' } })
  assert.equal((await h.backups.request('signal')).ok, false)
  assert.equal(lockExists(h.paths.backupLock), false)
  assert.deepEqual(h.happened, [['quiesce', 0], ['resume', 1]])
})

// ---------------------------------------------------------------------------------------------
// restic's command lines and environment

test('backups: restic backs up the folders of 5.5, leaves out the caches and what is being removed, forgets by the retention, and gets only the backup settings', async t => {
  const h = harness(t, { extra: { backup: { keepDaily: 14, keepWeekly: 0, keepMonthly: 24 } } })
  // Email is off, so there is no mail folder, and it isn't asked for.
  fs.rmSync(h.paths.mail, { recursive: true })
  assert.equal((await h.backups.request('signal')).ok, true)
  const [backup, forget] = h.stub.calls()
  const p = h.paths
  assert.deepEqual(backup.args, [
    '--cache-dir',
    p.backupCache,
    'backup',
    p.datastore,
    p.agents,
    p.wacli,
    p.bridge,
    p.networkLogDir,
    p.outbox,
    '--host',
    'scooter',
    '--tag',
    'scooter',
    '--group-by',
    'host,tags',
    '--exclude',
    p.wacliCache,
    '--exclude',
    p.agentsDiscarded,
    '--exclude-caches',
  ])
  // Scooter's snapshots are one group, whatever folders each holds (D195).
  assert.deepEqual(forget.args, ['--cache-dir', p.backupCache, 'forget', '--host', 'scooter', '--tag', 'scooter', '--group-by', 'host,tags', '--keep-daily', '14', '--keep-weekly', '0', '--keep-monthly', '24', '--prune'])
  for (const call of [backup, forget]) {
    // The settings in its environment, never on its command line, and nothing else of the bridge's.
    assert.deepEqual(call.env, {
      RESTIC_REPOSITORY: BACKUP.repository,
      RESTIC_PASSWORD: BACKUP.password,
      AWS_DEFAULT_REGION: 'auto',
      AWS_ACCESS_KEY_ID: 'key-id',
      AWS_SECRET_ACCESS_KEY: 'key-secret',
      TMPDIR: process.env.TMPDIR,
      TZ: 'UTC',
    })
    assert.ok(!call.args.some(arg => arg.includes(BACKUP.password) || arg.includes('key-secret')))
    // As the bridge's own user: root in an install, which reads every folder it backs up.
    assert.equal(call.uid, process.getuid())
  }
})

test('backups: restic check runs on Sundays in SCOOTER_TZ, and after every backup with FORCE_CHECK=1', async t => {
  // 03:30 on Sunday 15 November in Kolkata is Saturday in UTC.
  const sunday = harness(t, { start: '2026-11-14T22:00:00Z' })
  assert.deepEqual(await sunday.backups.request('scheduled'), { ok: true, snapshot: 'abcd1234', checked: true })
  assert.deepEqual(sunday.stub.commands(), ['backup', 'forget', 'check'])

  const monday = harness(t, { start: '2026-11-15T22:00:00Z' })
  assert.equal((await monday.backups.request('scheduled')).checked, false)
  const forced = harness(t, { start: '2026-11-15T22:00:00Z', extra: { backup: { forceCheck: true } } })
  assert.equal((await forced.backups.request('scheduled')).checked, true)
  assert.deepEqual(forced.stub.commands(), ['backup', 'forget', 'check'])
})

// ---------------------------------------------------------------------------------------------
// Results: the state, the replies and the notices (5.5, "Results")

test('backups: /backup always replies, with the snapshot or the error; the result is kept for /status', async t => {
  const h = harness(t)
  assert.equal(h.backups.ask(41), null)
  await h.backups.idle()
  assert.deepEqual(h.outbox(), [{ type: 'text', by: 'bridge', text: 'Backed up: snapshot abcd1234.', about: 41 }])
  assert.deepEqual(h.state.get().lastBackup, { at: START, ok: true, snapshot: 'abcd1234', reason: null })
  assert.equal(h.backups.statusLine(h.clock.now()), 'Backups: last 21:20, snapshot abcd1234. Next Tue 10 Nov 03:30.')

  // restic's own words, for the owner, and never in the log.
  const said = 'Fatal: unable to open repository at s3:https://account.r2.cloudflarestorage.com/bucket/scooter: Access Denied.'
  h.stub.fixtures({ exit: { backup: 1 }, stderr: { backup: `open repository\n${said}\n` } })
  await h.clock.advance(HOUR)
  h.backups.ask(42)
  await h.backups.idle()
  const reason = `restic backup: ${said.slice(0, -1)}`
  assert.deepEqual(h.outbox().at(-1), { type: 'text', by: 'bridge', text: `⚠️ The backup failed: ${reason}.`, about: 42 })
  assert.deepEqual(h.state.get().lastBackup, { at: '2026-11-09T16:50:30Z', ok: false, snapshot: null, reason })
  assert.equal(h.backups.statusLine(h.clock.now()), `Backups: the last, 22:20, failed (${reason}). Next Tue 10 Nov 03:30.`)
  assert.ok(!h.entries.some(entry => JSON.stringify(entry).includes('Access Denied')))
  assert.deepEqual(
    h.entries.filter(entry => entry.event === 'backup.failed').map(({ step, exitCode, snapshot }) => ({ step, exitCode, snapshot })),
    [{ step: 'backup', exitCode: 1, snapshot: null }],
  )

  // The codes restic gives meaning to, in words; a snapshot saved before a step failed.
  const cases = [
    [{ exit: { backup: 12 } }, "⚠️ The backup failed: RESTIC_PASSWORD doesn't open the backup repository."],
    [{ exit: { backup: 10 } }, "⚠️ The backup failed: the backup repository doesn't exist yet: run `scooter backup-init`."],
    [{ exit: { backup: 11 } }, '⚠️ The backup failed: the backup repository is locked by another restic, such as a check that is running.'],
    [{ exit: { backup: 3 } }, "⚠️ The backup saved snapshot abcd1234, but didn't finish: restic couldn't read some files, so the snapshot is incomplete."],
    [{ exit: { forget: 1 }, stderr: { forget: 'Fatal: unable to prune\n' } }, "⚠️ The backup saved snapshot abcd1234, but didn't finish: restic forget: Fatal: unable to prune."],
    [{ snapshot: 'none' }, "⚠️ The backup failed: restic backup didn't say which snapshot it saved."],
  ]
  for (const [fixtures, text] of cases) {
    h.stub.fixtures({ exit: {}, stderr: {}, snapshot: 'abcd1234', ...fixtures })
    h.backups.ask(43)
    await h.backups.idle()
    assert.equal(h.outbox().at(-1).text, text)
  }
  // A failed forget stops the backup there: no check, even with FORCE_CHECK.
  assert.ok(!h.stub.commands().includes('check'))
})

test('backups: a scheduled backup says nothing when it works, and tells the owner when it fails; a /backup that joins one gets the reply', async t => {
  const h = harness(t)
  await h.backups.request('scheduled')
  assert.deepEqual(h.outbox(), [])

  h.stub.fixtures({ exit: { backup: 12 } })
  await h.backups.request('scheduled')
  assert.deepEqual(h.outbox(), [
    {
      type: 'text',
      by: 'bridge',
      text: "⚠️ The backup failed: RESTIC_PASSWORD doesn't open the backup repository. The next one is at Tue 10 Nov 03:30. Send /backup to try again now.",
    },
  ])

  // SIGUSR1 is a backup the owner didn't ask for by message, as a scheduled one is.
  h.stub.fixtures({ exit: {}, hold: ['backup'] })
  const scheduled = h.backups.request('scheduled')
  await h.stub.holding('backup')
  // A request during a backup joins it, and only the reply goes out.
  assert.equal(h.backups.ask(50), null)
  const joined = h.backups.request('signal')
  h.stub.fixtures({ exit: { backup: 1 } })
  h.stub.release('backup')
  assert.equal(await scheduled, await joined)
  assert.deepEqual(h.outbox().slice(1), [{ type: 'text', by: 'bridge', text: '⚠️ The backup failed: restic backup exited with code 1.', about: 50 }])
  assert.deepEqual(h.stub.commands(), ['backup', 'forget', 'backup', 'backup'])
})

test('backups: a restic step that takes longer than RESTIC_TIMEOUT is stopped, and the backup fails', async t => {
  const h = harness(t)
  atEnd(t, overrideLimits({ RESTIC_TIMEOUT: 10 * MINUTE }))
  h.stub.fixtures({ hold: ['backup'] })
  h.backups.ask(7)
  await h.stub.holding('backup')
  await h.clock.whenSleeping()
  await h.clock.advance(10 * MINUTE)
  await h.backups.idle()
  assert.equal(h.stub.stopped('backup'), true)
  assert.equal(h.outbox()[0].text, '⚠️ The backup failed: restic backup took longer than 10 minutes, and was stopped.')
  assert.deepEqual(h.happened, [['quiesce', 0], ['resume', 1]])
})

test('backups: a bridge that stops during a backup stops restic, starts nothing again, lets go of backup.lock, and tells a /backup it stopped', async t => {
  const h = harness(t)
  h.stub.fixtures({ hold: ['backup'] })
  h.backups.ask(9)
  await h.stub.holding('backup')
  await h.backups.stop()
  assert.equal(h.stub.stopped('backup'), true)
  assert.deepEqual(h.happened, [['quiesce', 0]])
  assert.equal(lockExists(h.paths.backupLock), false)
  assert.deepEqual(h.outbox(), [{ type: 'text', by: 'bridge', text: 'The backup was stopped, because the bridge was stopping. Send /backup to try again.', about: 9 }])
  // It isn't a backup that failed.
  assert.equal(h.state.get().lastBackup, null)

  // One waiting for a run stops too, before it has stopped anything.
  const w = harness(t)
  takeLock(w.paths.runLock, { deadline: w.clock.now() + 10 * MINUTE, clock: w.clock })
  const waiting = w.backups.request('scheduled')
  await w.clock.whenSleeping()
  await w.backups.stop()
  assert.deepEqual(await waiting, { stopped: true })
  assert.deepEqual([w.happened, w.stub.commands(), lockExists(w.paths.backupLock)], [[], [], false])
})

test('backups: a stop that comes as a backup ends is over only once that backup is told: its result kept and its reply written', async t => {
  const h = harness(t)
  let stop
  const stopped = new Promise(resolve => (stop = resolve))
  const update = h.state.update
  // The bridge's stop comes as the result is kept, before the reply is written.
  h.state.update = changes => {
    const result = update(changes)
    if (changes.lastBackup) stop(h.backups.stop())
    return result
  }
  const order = []
  const told = h.backups.request('command', { about: 5 }).then(() => order.push('told'))
  // Resolves once the stop is over.
  await stopped
  order.push('stopped')
  await told
  assert.deepEqual(order, ['told', 'stopped'])
  assert.deepEqual(h.outbox(), [{ type: 'text', by: 'bridge', text: 'Backed up: snapshot abcd1234.', about: 5 }])
})

test('backups: a failure to start the writers again is fatal, and backup.lock goes all the same', async t => {
  let fatal = null
  const h = harness(t, {
    resume: async () => {
      throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    },
    onFatal: error => (fatal = error),
  })
  assert.equal((await h.backups.request('signal')).ok, true)
  assert.equal(fatal.code, 'EADDRINUSE')
  assert.equal(lockExists(h.paths.backupLock), false)
})

test('backups: exchange/locks is used only while it is the runner\'s folder and not a link', async t => {
  const h = harness(t)
  const elsewhere = path.join(h.root, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.rmSync(h.paths.locks, { recursive: true })
  fs.symlinkSync(elsewhere, h.paths.locks)
  h.backups.ask(3)
  await h.backups.idle()
  assert.match(h.outbox()[0].text, /^⚠️ The backup failed: the bridge couldn't back up \(EUNTRUSTED: not used: a symbolic link\)\.$/)
  assert.deepEqual(fs.readdirSync(elsewhere), [])
  assert.deepEqual(h.stub.commands(), [])
  assert.deepEqual(h.happened, [])
})

// ---------------------------------------------------------------------------------------------
// The schedule (5.5, "Schedule")

// Moves the clock to `time`, and waits for a backup that starts there to be told.
async function until(h, time) {
  await h.clock.advance(Date.parse(time) - h.clock.now())
  await h.backups.idle()
}

test('backups: daily at BACKUP_TIME in SCOOTER_TZ; a bridge started after the day\'s time backs up the next day', async t => {
  // 21:20 on Monday in Kolkata: the first is 03:30 on Tuesday.
  const h = harness(t)
  h.backups.start()
  assert.deepEqual(h.entries.find(entry => entry.event === 'backup.scheduled').next, '2026-11-09T22:00:00Z')
  await until(h, '2026-11-09T21:59:59Z')
  assert.deepEqual(h.stub.commands(), [])
  await until(h, '2026-11-09T22:00:00Z')
  await waitFor(() => h.events().includes('backup.finished'), 'the backup')
  await until(h, '2026-11-10T21:59:59Z')
  assert.equal(h.events().filter(event => event === 'backup.finished').length, 1)
  await until(h, '2026-11-10T22:00:00Z')
  await waitFor(() => h.events().filter(event => event === 'backup.finished').length === 2, 'the second backup')

  // 04:30 on Tuesday: the first is on Wednesday.
  const late = harness(t, { start: '2026-11-09T23:00:00Z' })
  late.backups.start()
  assert.equal(late.entries.find(entry => entry.event === 'backup.scheduled').next, '2026-11-10T22:00:00Z')
})

test('backups: across a daylight-saving change the backup runs once a day, at the local time', async t => {
  // New York leaves daylight saving at 02:00 on Sunday 1 November 2026, and 01:30 comes twice.
  const h = harness(t, { start: '2026-10-31T12:00:00Z', extra: { timeZone: 'America/New_York', backupTime: '01:30' } })
  h.backups.start()
  for (const [time, count] of [
    ['2026-11-01T05:30:00Z', 1], // 01:30 EDT, the first of the two
    ['2026-11-01T06:30:00Z', 1], // 01:30 EST, the same local time again
    ['2026-11-02T06:30:00Z', 2],
  ]) {
    await until(h, time)
    await waitFor(() => h.events().filter(event => event === 'backup.finished').length === count, `backup ${count}`)
  }
  assert.deepEqual(
    h.entries.filter(entry => entry.event === 'backup.started').map(entry => entry.at),
    ['2026-11-01T05:30:00Z', '2026-11-02T06:30:00Z'],
  )
})

test('backups: off without RESTIC_REPOSITORY, with a warning at startup; BACKUP_TIME=off leaves only /backup and SIGUSR1', async t => {
  const off = harness(t, { extra: { backup: null } })
  off.backups.start()
  assert.deepEqual(off.entries.find(entry => entry.event === 'backup.off').reason, BACKUPS_OFF)
  assert.equal(off.backups.ask(5), OFF_REPLY)
  assert.deepEqual(await off.backups.request('signal'), { off: true })
  assert.equal(off.backups.statusLine(off.clock.now()), "Backups: off, because RESTIC_REPOSITORY isn't set in bridge.env.")
  assert.deepEqual(off.stub.commands(), [])

  const unscheduled = harness(t, { extra: { backupTime: null } })
  unscheduled.backups.start()
  await unscheduled.clock.advance(48 * HOUR)
  assert.deepEqual(unscheduled.stub.commands(), [])
  assert.equal(unscheduled.backups.statusLine(unscheduled.clock.now()), 'Backups: none yet. None is scheduled: BACKUP_TIME is off.')
  assert.equal((await unscheduled.backups.request('signal')).ok, true)
})

// ---------------------------------------------------------------------------------------------
// The bridge as a whole

test('backups: in the bridge, WhatsApp and delivery stop while restic runs and start again after, with a new webhook secret', async t => {
  const root = makeTestDir(t)
  const wacli = createWacliStub(t, root)
  wacli.fixtures({ paired: true, messages: [] })
  const restic = createResticStub(t, root)
  restic.fixtures({ hold: ['backup'] })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0, WACLI_CALL_TIMEOUT: 365 * 24 * HOUR }))
  const clock = createFakeClock(START)
  const { log, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const settings = settingsFor(root)
  const bridge = await startBridge({ settings, clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc })
  atEnd(t, () => bridge.stop())
  const whatsapp = bridge.channels.get('whatsapp')
  await waitFor(() => wacli.callsOf('sync').length === 1 && whatsapp.status() === 'WhatsApp: linked', 'sync to start')
  const secretOf = call => call.args[call.args.indexOf('--webhook-secret') + 1]

  const webhook = wacli.callsOf('sync')[0].args[wacli.callsOf('sync')[0].args.indexOf('--webhook') + 1]
  const done = bridge.backups.request('signal')
  await restic.holding('backup')
  assert.equal(whatsapp.status(), 'WhatsApp: stopped')
  // Nothing reaches the bridge, and nothing goes out.
  await assert.rejects(fetch(webhook, { method: 'POST', body: '{}' }))
  await writeOutboxEntry({ paths: bridge.paths, ids: createIds(clock), entry: { type: 'text', by: 'runner', text: 'Held back.' } })
  for (let i = 0; i < 10; i++) await clock.advance(SECOND)
  assert.deepEqual(wacli.callsOf('send text'), [])

  restic.release('backup')
  assert.equal((await done).ok, true)
  await waitFor(() => wacli.callsOf('sync').length === 2 && whatsapp.status() === 'WhatsApp: linked', 'sync to start again')
  assert.notEqual(secretOf(wacli.callsOf('sync')[1]), secretOf(wacli.callsOf('sync')[0]))
  await waitFor(
    async () => {
      await clock.advance(SECOND)
      return wacli.callsOf('send text').length === 1
    },
    'the held-back message',
  )
  assert.ok(events().indexOf('whatsapp.stopped') < events().indexOf('backup.step'))
  assert.equal(lockExists(bridge.paths.backupLock), false)
  assert.match(bridge.backups.statusLine(clock.now()), /^Backups: last 21:20, snapshot abcd1234\. Next Tue 10 Nov 03:30\.$/)
})

test('backups: in the bridge, with email on, the email reader stops before restic starts, mail/ is backed up, and the reader starts again', async t => {
  const root = makeTestDir(t)
  const wacli = createWacliStub(t, root)
  wacli.fixtures({ paired: true, messages: [] })
  const reader = createMailReaderStub(root)
  const restic = createResticStub(t, root)
  restic.fixtures({ hold: ['backup'] })
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0, WACLI_CALL_TIMEOUT: 365 * 24 * HOUR }))
  const clock = createFakeClock(START)
  const { log, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const settings = settingsFor(root, { email: EMAIL })
  const bridge = await startBridge({ settings, clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc, emailReader: reader.reader })
  atEnd(t, () => bridge.stop())
  await waitFor(() => wacli.callsOf('sync').length === 1 && reader.calls().length === 1, 'sync and the reader to start')

  const done = bridge.backups.request('signal')
  await restic.holding('backup')
  // The reader is gone before restic reads mail/.
  assert.throws(() => process.kill(reader.calls()[0].pid, 0), { code: 'ESRCH' })
  assert.ok(events().indexOf('email.stopped') < events().indexOf('backup.writers_stopped'))
  assert.ok(restic.calls()[0].args.includes(bridge.paths.mail))
  assert.equal(reader.calls().length, 1)

  restic.release('backup')
  assert.equal((await done).ok, true)
  await waitFor(() => reader.calls().length === 2 && wacli.callsOf('sync').length === 2, 'the reader and sync to start again')
  assert.ok(events().lastIndexOf('email.started') > events().indexOf('backup.step'))
})

test('backups: in the bridge, a download the backup cut short, and the messages after it, are stored after it, in order (D179)', async t => {
  const root = makeTestDir(t)
  const wacli = createWacliStub(t, root)
  wacli.fixtures({ paired: true, messages: [], media: { P1: { as: 'hang' } } })
  const restic = createResticStub(t, root)
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0, WACLI_CALL_TIMEOUT: 365 * 24 * HOUR }))
  const clock = createFakeClock(START)
  const { log } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const bridge = await startBridge({ settings: settingsFor(root), clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc })
  atEnd(t, () => bridge.stop())
  await waitFor(() => wacli.callsOf('sync').length === 1, 'sync to start')
  const lines = () => [...bridge.store.index.entries()].map(entry => entry.line)

  // After the bridge's first start, which catch-up lists from while nothing is stored, and five
  // minutes apart, past CATCHUP_OVERLAP.
  const photoAt = '2026-11-09T15:51:00Z'
  const textAt = '2026-11-09T15:56:00Z'
  assert.equal(await wacli.postWebhook(webhookPayload({ ID: 'P1', Timestamp: photoAt, Media: { Type: 'image', Caption: '', Filename: '', MimeType: 'image/jpeg', FileLength: 9 } })), 200)
  await waitFor(() => wacli.callsOf('media download').length === 1, 'the download to start')
  assert.equal(await wacli.postWebhook(webhookPayload({ ID: 'T1', Timestamp: textAt, Text: 'coffee 150' })), 200)
  await new Promise(resolve => setTimeout(resolve, 20))
  wacli.fixtures({
    media: { P1: { content: 'the photo' } },
    messages: [listRow({ MsgID: 'P1', Timestamp: photoAt, MediaType: 'image', MimeType: 'image/jpeg' }), listRow({ MsgID: 'T1', Timestamp: textAt, Text: 'coffee 150' })],
  })
  assert.equal((await bridge.backups.request('signal')).ok, true)
  await waitFor(() => lines().length === 2, 'catch-up to bring both back')
  assert.deepEqual(
    lines().map(line => [line.seq, line.sourceId]),
    [
      [1, 'P1'],
      [2, 'T1'],
    ],
  )
  assert.deepEqual(lines()[0].files, [{ path: '1.jpg', mime: 'image/jpeg', bytes: 9 }])
  assert.deepEqual(restic.commands(), ['backup', 'forget'])
})

test('backups: in the bridge, a /backup waiting for a run doesn\'t hold back a /status sent after it, and replies once it is done', async t => {
  const root = makeTestDir(t)
  const wacli = createWacliStub(t, root)
  wacli.fixtures({ paired: true, messages: [] })
  createResticStub(t, root)
  atEnd(t, overrideLimits({ WEBHOOK_PORT: 0, WACLI_CALL_TIMEOUT: 365 * 24 * HOUR }))
  const clock = createFakeClock(START)
  const { log } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const bridge = await startBridge({ settings: settingsFor(root), clock, log, proc: isRoot ? { ...proc, lookupUser: async () => null } : proc })
  atEnd(t, () => bridge.stop())
  await waitFor(() => wacli.callsOf('sync').length === 1, 'sync to start')
  const post = async (id, text) => {
    assert.equal(await wacli.postWebhook(webhookPayload({ ID: id, Timestamp: '2026-11-09T15:50:00Z', Text: text })), 200)
    await new Promise(resolve => setTimeout(resolve, 20))
    await bridge.intake.idle()
    await bridge.commands.idle()
  }
  const replies = () => listHandOffs(bridge.paths.bridgeOutbox).map(id => JSON.parse(fs.readFileSync(path.join(bridge.paths.bridgeOutbox, id, 'entry.json'), 'utf8')))

  // A run is under way.
  takeLock(bridge.paths.runLock, { deadline: clock.now() + 10 * MINUTE, clock })
  await post('B1', '/backup')
  await post('S1', '/status')
  const [status] = replies()
  assert.equal(status.about, 2)
  assert.match(status.text, /^Backups: one in progress since 21:20, waiting for the agent's run to end; none yet\. Next Tue 10 Nov 03:30\.$/m)
  assert.equal(bridge.state.get().commandSeq, 2)

  releaseLock(bridge.paths.runLock)
  await clock.advance(SECOND)
  await bridge.backups.idle()
  // Delivery, started again, may have sent the reply to /status already.
  assert.deepEqual(replies().at(-1), { type: 'text', by: 'bridge', text: 'Backed up: snapshot abcd1234.', about: 1 })
})

// ---------------------------------------------------------------------------------------------
// The commands (8.4)

function cli(t, extra) {
  const root = makeTestDir(t)
  const stub = createResticStub(t, root)
  const settings = settingsFor(root, extra)
  const clock = createFakeClock(START)
  const { log } = createTestLog({ clock })
  // As root, `restore` needs Scooter's users, which this machine may not have; a test below has
  // what it does without them.
  const proc = isRoot ? { ...createProc({ log, clock }), lookupUser: async () => null } : createProc({ log, clock })
  const run = async (command, args = [], more = {}) => {
    let out = ''
    let err = ''
    const code = await command({ args, settings: { ...settings, ...more }, stdout: { write: text => (out += text) }, stderr: { write: text => (err += text) }, clock, log, proc })
    return { code, out, err }
  }
  return { root, stub, settings, paths: makePaths(settings), run }
}

test('backups: each command exits with 2 and says why without RESTIC_REPOSITORY, or with arguments it doesn\'t take', async t => {
  const { run } = cli(t, { backup: null })
  for (const [command, name] of [[runBackupInit, 'backup-init'], [runSnapshots, 'snapshots'], [runCheck, 'check'], [runRestore, 'restore']]) {
    assert.deepEqual(await run(command), { code: 2, out: '', err: `scooter ${name}: ${BACKUPS_OFF}, so there is no backup repository to use\n` })
  }
  const on = cli(t)
  assert.deepEqual(await on.run(runSnapshots, ['--all']), { code: 2, out: '', err: 'scooter snapshots: it takes no arguments\n' })
  assert.equal((await on.run(runRestore, ['1a2b3c4d', 'latest'])).code, 2)
  assert.deepEqual(on.stub.commands(), [])
  assert.deepEqual(restoreArgs([]), { snapshot: 'latest', force: false })
  assert.deepEqual(restoreArgs(['--force', '1a2b3c4d']), { snapshot: '1a2b3c4d', force: true })
  for (const args of [['--force', '--force'], ['-f'], ['1A2B3C4D'], ['abc'], ['latest', '1a2b3c4d']]) assert.equal(restoreArgs(args), null, args.join(' '))
})

test('backups: backup-init is safe to repeat, asking restic cat config first', async t => {
  const { stub, run } = cli(t)
  stub.fixtures({ repository: false })
  const first = await run(runBackupInit)
  assert.equal(first.code, 0)
  assert.match(first.out, /^created restic repository/)
  assert.deepEqual(stub.commands(), ['cat', 'init'])
  assert.deepEqual(await run(runBackupInit), { code: 0, out: 'The backup repository is there already, and nothing was changed.\n', err: '' })
  assert.deepEqual(stub.commands(), ['cat', 'init', 'cat'])
  // The commands use no cache: restic would need a home without one.
  assert.ok(stub.calls().every(call => call.args[0] === '--no-cache'))

  stub.fixtures({ exit: { cat: 12 } })
  assert.deepEqual(await run(runBackupInit), { code: 1, out: '', err: "scooter backup-init: RESTIC_PASSWORD doesn't open the backup repository\n" })
})

test('backups: snapshots lists Scooter\'s, with times in SCOOTER_TZ; check passes restic\'s report and its failure on', async t => {
  const { stub, run } = cli(t)
  const listed = await run(runSnapshots)
  assert.equal(listed.code, 0)
  assert.match(listed.out, /^ID +Time/)
  const call = stub.calls()[0]
  assert.deepEqual(call.args, ['--no-cache', 'snapshots', '--host', 'scooter', '--tag', 'scooter'])
  assert.equal(call.env.TZ, 'Asia/Kolkata')
  assert.deepEqual(await run(runCheck), { code: 0, out: 'no errors were found\n', err: '' })
  stub.fixtures({ exit: { check: 1 }, stderr: { check: 'Fatal: repository contains errors\n' } })
  assert.deepEqual(await run(runCheck), { code: 1, out: 'no errors were found\n', err: 'Fatal: repository contains errors\nscooter check: restic check: Fatal: repository contains errors\n' })
})

const SNAPSHOT_ID = 'abcd1234'.padEnd(64, '0')
function snapshotOf(dataDir, folders = ['datastore', 'agents', 'wacli', 'bridge', 'mail', 'runner/log', 'exchange/outbox']) {
  return { time: '2026-11-09T22:00:01.123456789Z', id: SNAPSHOT_ID, short_id: 'abcd1234', hostname: 'scooter', tags: ['scooter'], paths: folders.map(folder => `${dataDir}/${folder}`) }
}

test('backups: restore takes only Scooter\'s snapshots, and restores the data folder\'s folders in one go, deleting what the snapshot doesn\'t hold there and nothing else', async t => {
  const { root, stub, paths, run } = cli(t)
  const target = path.join(root, 'restored')
  stub.fixtures({ snapshots: [snapshotOf('/var/lib/scooter')] })
  const done = await run(runRestore, [], { backup: { ...BACKUP, restoreTarget: target } })
  assert.deepEqual(done, { code: 0, out: `restore done\nRestored snapshot abcd1234, made Tue 10 Nov 03:30, into ${target}/var/lib/scooter.\n`, err: '' })
  const [find, restore] = stub.calls()
  assert.deepEqual(find.args, ['--no-cache', 'snapshots', '--json', '--host', 'scooter', '--tag', 'scooter', 'latest'])
  assert.deepEqual(restore.args, [
    '--no-cache',
    'restore',
    `${SNAPSHOT_ID}:/var/lib/scooter`,
    '--target',
    `${target}/var/lib/scooter`,
    ...['datastore', 'agents', 'wacli', 'bridge', 'mail', 'runner/log', 'exchange/outbox'].flatMap(folder => ['--include', `/${folder}`]),
    '--delete',
    '--ownership-by-name',
  ])
  // The data folder it made, which every service user passes through.
  assert.equal(fs.statSync(`${target}/var/lib/scooter`).mode & 0o777, 0o755)
  assert.equal(restore.env.TZ, 'UTC')
  assert.equal(restore.env.RESTIC_PASSWORD, BACKUP.password)

  // A snapshot named by its ID; and one that isn't a backup of Scooter's isn't touched.
  assert.equal((await run(runRestore, ['abcd1234', '--force'], { backup: { ...BACKUP, restoreTarget: target } })).code, 0)
  assert.equal(stub.calls()[2].args.at(-1), 'abcd1234')
  for (const shot of [{ ...snapshotOf('/data'), paths: ['/etc'] }, snapshotOf('/data', ['datastore', 'datastore']), { ...snapshotOf('/data'), paths: ['/a/datastore', '/b/agents'] }, { ...snapshotOf('/data'), id: '../x' }]) {
    stub.fixtures({ snapshots: [shot] })
    const refused = await run(runRestore, ['--force'], { backup: { ...BACKUP, restoreTarget: target } })
    assert.equal(refused.code, 2)
    assert.match(refused.err, /isn't one of Scooter's backups/)
  }
  stub.fixtures({ snapshots: [] })
  assert.deepEqual(await run(runRestore), { code: 2, out: '', err: 'scooter restore: there is no backup to restore yet\n' })
  assert.equal(snapshotBase([`${paths.dataDir}/datastore`, `${paths.dataDir}/runner/log`]).base, paths.dataDir)
})

test('backups: restore refuses a target that isn\'t empty without --force, and the live data folder while the bridge or the runner runs on it', async t => {
  const { root, stub, paths, run } = cli(t)
  stub.fixtures({ snapshots: [snapshotOf(paths.dataDir)] })
  // Into the data folder itself: RESTORE_TARGET is /.
  fs.mkdirSync(path.join(paths.datastore, '2026'), { recursive: true })
  fs.mkdirSync(paths.agents, { recursive: true })
  const full = await run(runRestore)
  assert.equal(full.code, 2)
  assert.equal(full.err, `scooter restore: ${paths.datastore} isn't empty: restore into an empty folder, or add --force to replace what is there with the snapshot\n`)
  assert.deepEqual(stub.commands(), ['snapshots'])

  fs.mkdirSync(paths.bridge, { recursive: true })
  const bridge = await holdInstance(paths.bridgeSocket, 'bridge')
  const running = await run(runRestore, ['--force'])
  await bridge.close()
  assert.equal(running.code, 2)
  assert.match(running.err, /the bridge is running on .* answers\): stop the bridge and the runner first/)
  fs.mkdirSync(paths.runner, { recursive: true })
  const runner = await holdInstance(paths.runnerSocket, 'runner')
  assert.match((await run(runRestore, ['--force'])).err, /the runner is running on/)
  await runner.close()

  assert.equal((await run(runRestore, ['--force'])).code, 0)
  assert.deepEqual(stub.commands(), ['snapshots', 'snapshots', 'snapshots', 'snapshots', 'restore'])
  // restic's failure, said.
  stub.fixtures({ exit: { restore: 1 }, stderr: { restore: 'Fatal: wrong password or no key found\n' } })
  assert.deepEqual(await run(runRestore, ['--force']), { code: 1, out: '', err: 'scooter restore: restic restore: Fatal: wrong password or no key found\n' })
  void root
})

test('backups: restore refuses when runner/ or exchange/ is a link, which restic would follow, or isn\'t a folder, and asks restic for no restore (D198)', async t => {
  const { root, stub, run } = cli(t)
  const target = path.join(root, 'restored')
  const data = `${target}/var/lib/scooter`
  const elsewhere = path.join(root, 'elsewhere')
  fs.mkdirSync(path.join(elsewhere, 'log'), { recursive: true })
  fs.writeFileSync(path.join(elsewhere, 'log', 'kept.jsonl'), 'kept\n')
  stub.fixtures({ snapshots: [snapshotOf('/var/lib/scooter')] })
  const restore = () => run(runRestore, ['--force'], { backup: { ...BACKUP, restoreTarget: target } })

  for (const between of ['runner', 'exchange']) {
    fs.mkdirSync(data, { recursive: true })
    fs.symlinkSync(elsewhere, path.join(data, between))
    assert.deepEqual(await restore(), {
      code: 2,
      out: '',
      err: `scooter restore: ${data}/${between} is a link: restic would write where it leads, and with --force delete there. Remove the link, or restore into another RESTORE_TARGET\n`,
    })
    fs.rmSync(path.join(data, between))
    fs.writeFileSync(path.join(data, between), 'a file\n')
    assert.deepEqual((await restore()).err, `scooter restore: ${data}/${between} isn't a folder: remove it, or restore into another RESTORE_TARGET\n`)
    fs.rmSync(path.join(data, between))
  }
  assert.deepEqual(stub.commands(), ['snapshots', 'snapshots', 'snapshots', 'snapshots'])
  assert.deepEqual(fs.readdirSync(path.join(elsewhere, 'log')), ['kept.jsonl'])
  // A link at a folder the restore holds is restic's to replace, and doesn't stop it; nor do the
  // folders between, as folders.
  fs.mkdirSync(path.join(data, 'runner'))
  fs.mkdirSync(path.join(data, 'exchange'))
  fs.symlinkSync(elsewhere, path.join(data, 'agents'))
  assert.equal((await restore()).code, 0)
  assert.deepEqual(stub.commands().slice(-2), ['snapshots', 'restore'])
})

test('backups: as root, restore refuses until setup has made Scooter\'s users, whose names its files get as owners, and asks restic nothing', async t => {
  const { root, stub, settings } = cli(t)
  stub.fixtures({ snapshots: [snapshotOf('/var/lib/scooter')] })
  const clock = createFakeClock(START)
  const { log } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const restore = async lookupUser => {
    let err = ''
    const backup = { ...BACKUP, restoreTarget: path.join(root, 'restored') }
    const code = await runRestore({ args: ['--force'], settings: { ...settings, backup }, stdout: { write: () => {} }, stderr: { write: text => (err += text) }, clock, log, proc: { ...proc, lookupUser } })
    return { code, err }
  }
  // As root on a machine `setup` hasn't made ready: `lookupUser` says so, as `id` does.
  const missing = await restore(async name => {
    if (name === 'scooter-mail') throw new Error(`there is no user ${name} on this machine`)
    return { uid: 0, gid: 0 }
  })
  assert.deepEqual(missing, { code: 2, err: "scooter restore: there is no user scooter-mail on this machine: run `scooter setup` first, which makes Scooter's users, so each file restored gets its owner\n" })
  assert.deepEqual(stub.commands(), [])
  // As root once they are there; and not root, when there are no owners to give.
  assert.equal((await restore(async () => ({ uid: 0, gid: 0 }))).code, 0)
  assert.equal((await restore(async () => null)).code, 0)
  assert.deepEqual(stub.commands(), ['snapshots', 'restore', 'snapshots', 'restore'])
})

// ---------------------------------------------------------------------------------------------
// The real round trip, when restic is installed (section 10)

const withRestic = { skip: realRestic === null ? 'restic is not installed' : false }

test('backups: a real round trip with restic: init, back up, no plaintext, the wrong password fails, the restore matches, and --force is needed for a target that isn\'t empty', withRestic, async t => {
  const root = makeTestDir(t)
  const clock = createFakeClock('2026-11-10T22:00:00Z')
  const { log, entries } = createTestLog({ clock })
  // As root, `restore` needs Scooter's users, which this machine may not have: the root test of
  // owners by name below makes them.
  const proc = isRoot ? { ...createProc({ log, clock }), lookupUser: async () => null } : createProc({ log, clock })
  const repository = path.join(root, 'repository')
  const settings = settingsFor(root, { backup: { repository, restoreTarget: path.join(root, 'restored'), env: {} } })
  const paths = makePaths(settings)
  fillDataFolder(paths)
  ensureDir(paths.bridge)
  const run = async (command, args = [], more = {}) => {
    let out = ''
    let err = ''
    const code = await command({ args, settings: { ...settings, ...more }, stdout: { write: text => (out += text) }, stderr: { write: text => (err += text) }, clock, log, proc })
    return { code, out, err }
  }

  const init = await run(runBackupInit)
  assert.equal(init.code, 0, init.err)
  assert.match(init.out, /created restic repository/)
  assert.deepEqual(await run(runBackupInit), { code: 0, out: 'The backup repository is there already, and nothing was changed.\n', err: '' })

  const { snapshot, checked } = await backUp({ settings, paths, proc, log, clock })
  assert.match(snapshot, /^[0-9a-f]{8}$/)
  assert.equal(checked, false)
  assert.ok(entries.some(entry => entry.event === 'backup.step' && entry.step === 'forget' && entry.exitCode === 0))
  // The cache restic kept in the bridge's folder marks itself, and isn't backed up.
  assert.ok(fs.existsSync(path.join(paths.backupCache, 'CACHEDIR.TAG')))

  // Everything in the repository is encrypted.
  for (const file of fs.readdirSync(repository, { recursive: true })) {
    const full = path.join(repository, file)
    if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full).includes('PLAINTEXT-RECEIPT-MARKER'), file)
  }
  // The wrong password opens nothing.
  const wrong = await run(runSnapshots, [], { backup: { ...settings.backup, password: 'wrong' } })
  assert.equal(wrong.code, 1)
  assert.match(wrong.err, /scooter snapshots: RESTIC_PASSWORD doesn't open the backup repository\n$/)
  const listed = await run(runSnapshots)
  assert.equal(listed.code, 0)
  assert.ok(listed.out.includes(snapshot))
  assert.equal((await run(runCheck)).code, 0)

  // Restored into an empty folder: the folders as they were, but what a backup leaves out.
  const restored = await run(runRestore)
  assert.equal(restored.code, 0, restored.err)
  const back = makePaths({ dataDir: path.join(settings.backup.restoreTarget, paths.dataDir), configDir: '/' })
  const tree = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort().map(name => [name, fs.statSync(path.join(dir, name)).isFile() ? fs.readFileSync(path.join(dir, name), 'utf8') : null]) : [])
  for (const name of ['datastore', 'agents', 'mail', 'outbox', 'networkLogDir']) {
    const original = tree(paths[name]).filter(([file]) => !file.startsWith('.discarded'))
    assert.deepEqual(tree(back[name]), original, name)
  }
  assert.deepEqual(tree(back.wacli), [['store', null], ['store/wacli.db', 'the WhatsApp session']])
  assert.equal(fs.existsSync(back.agentsDiscarded), false)
  assert.equal(fs.existsSync(back.backupCache), false)
  assert.equal(fs.existsSync(back.runnerImage), false)
  assert.equal(fs.existsSync(back.locks), false)
  assert.equal(fs.statSync(back.datastore).mode & 0o777, fs.statSync(paths.datastore).mode & 0o777)

  // Not empty now: --force is needed, and replaces what is there with the snapshot.
  fs.writeFileSync(path.join(back.datastore, '2026/11/09/log.jsonl'), 'changed\n')
  fs.mkdirSync(path.join(back.datastore, '2026/11/10'))
  fs.writeFileSync(path.join(back.datastore, '2026/11/10/log.jsonl'), 'a later day\n')
  fs.mkdirSync(back.runnerImage, { recursive: true })
  fs.writeFileSync(path.join(back.runnerImage, 'rootfs.ext4'), 'an image of its own')
  const refused = await run(runRestore)
  assert.equal(refused.code, 2)
  assert.match(refused.err, /^scooter restore: .* aren't empty: restore into an empty folder, or add --force/)
  const forced = await run(runRestore, [snapshot, '--force'])
  assert.equal(forced.code, 0, forced.err)
  assert.deepEqual(tree(back.datastore), tree(paths.datastore))
  // What isn't one of the folders a backup holds is left alone.
  assert.equal(fs.readFileSync(path.join(back.runnerImage, 'rootfs.ext4'), 'utf8'), 'an image of its own')
})

test('backups: with restic, Scooter\'s snapshots are one group whatever folders they hold, so forget keeps to the retention when a folder appears (D195)', withRestic, async t => {
  const root = makeTestDir(t)
  const clock = createFakeClock('2026-11-10T22:00:00Z')
  const { log } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  // One daily snapshot. restic 0.19 also keeps a group's oldest while it has fewer days than the
  // policy keeps, which a retention of one day leaves out of the test.
  const settings = settingsFor(root, { backup: { repository: path.join(root, 'repository'), env: {}, keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } })
  const paths = makePaths(settings)
  fillDataFolder(paths)
  ensureDir(paths.bridge)
  // Email is off at first, so mail/ isn't backed up.
  fs.rmSync(paths.mail, { recursive: true })
  const quiet = { write: () => {} }
  assert.equal(await runBackupInit({ args: [], settings, stdout: quiet, stderr: quiet, clock, log, proc }), 0)
  const first = await backUp({ settings, paths, proc, log, clock })
  // Then it is turned on, and the folders backed up change.
  fs.mkdirSync(paths.mail)
  fs.writeFileSync(paths.mailState, '{"next":5}\n')
  const second = await backUp({ settings, paths, proc, log, clock })
  const listed = await createRestic({ backup: settings.backup, paths, proc })(['snapshots', '--json'])
  const shots = JSON.parse(listed.stdout)
  // Both were made today, as restic dates them, and keep-daily keeps the newest of a day. By host
  // and paths, restic would keep the first too, as the newest of its own group, and for good.
  const day = shot => shot.time.slice(0, 10)
  if (shots.length === 2 && day(shots[0]) !== day(shots[1])) return t.skip('the two backups fell on two days')
  assert.deepEqual(shots.map(shot => shot.short_id), [second.snapshot])
  assert.notEqual(first.snapshot, second.snapshot)
})

test('backups: as root, a restore gives each file its owner by name, on a machine where the user has another number', { skip: !mayCreateUsers ? 'needs root and SCOOTER_ROOT_TESTS=1' : realRestic === null ? 'restic is not installed' : false }, async t => {
  const root = makeTestDir(t)
  fs.chmodSync(root, 0o755)
  const clock = createFakeClock('2026-11-10T22:00:00Z')
  const { log } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const env = { PATH: process.env.PATH }
  const addUser = async name => {
    const add = await proc.run('useradd', ['--system', '--user-group', '--shell', '/usr/sbin/nologin', name], { env })
    assert.equal(add.code, 0, add.stderr)
    atEnd(t, () => proc.run('userdel', [name], { env }))
  }
  // Scooter's users, as `setup` makes them, without which a restore as root refuses.
  for (const user of ['scooter-wacli', 'scooter-runner', 'scooter-mail']) {
    if ((await proc.run('id', ['-u', '--', user], { env })).code !== 0) await addUser(user)
  }
  const name = 'scooter-test-restore'
  await addUser(name)
  const before = await proc.lookupUser(name)

  const settings = settingsFor(root, { backup: { repository: path.join(root, 'repository'), restoreTarget: path.join(root, 'restored'), env: {} } })
  const paths = makePaths(settings)
  fillDataFolder(paths)
  fs.chownSync(paths.agents, before.uid, before.gid)
  fs.chownSync(paths.agentViews('lifelog'), before.uid, before.gid)
  fs.chownSync(path.join(paths.agentViews('lifelog'), 'expenses.csv'), before.uid, before.gid)
  const context = { settings, clock, log, proc, stdout: { write: () => {} }, stderr: { write: () => {} } }
  assert.equal(await runBackupInit({ ...context, args: [] }), 0)
  await backUp({ settings, paths, proc, log, clock })

  // The user has another number now, as on a machine `setup` made afresh.
  const moved = await proc.run('usermod', ['--uid', String(before.uid + 7), name], { env })
  assert.equal(moved.code, 0, moved.stderr)
  const after = await proc.lookupUser(name)
  assert.equal(await runRestore({ ...context, args: [] }), 0)
  const back = makePaths({ dataDir: path.join(settings.backup.restoreTarget, paths.dataDir), configDir: '/' })
  for (const file of [back.agents, back.agentViews('lifelog'), path.join(back.agentViews('lifelog'), 'expenses.csv')]) {
    assert.equal(fs.statSync(file).uid, after.uid, file)
  }
  assert.equal(fs.statSync(back.datastore).uid, 0)
})
