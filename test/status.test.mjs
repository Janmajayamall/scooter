// `scooter status`: what it says about the bridge, each channel, the newest message, the runner
// and its agent, the network log and the backups, from the files it can read, with times in
// `SCOOTER_TZ`; what it says when they aren't there yet, or can't be read; that it changes nothing;
// and the bridge's `status.json`, which the bridge writes for it.

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { checkBridgeStatus, createStatusFile, readBridgeStatus, readIndex, runStatus, statusText, writeBridgeStatus } from '../src/bridge/status.mjs'
import { writeFileAtomic } from '../src/common/files.mjs'
import { holdInstance } from '../src/common/instance.mjs'
import { limits } from '../src/common/limits.mjs'
import { takeLock } from '../src/common/locks.mjs'
import { formatNetworkLogLine } from '../src/common/netlog.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { indexOf, line, writeDatastore } from './support/runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const SECOND = 1000

// 21:20 in Asia/Kolkata on Monday 9 November 2026; 10:50 in New York.
const NOW = Date.parse('2026-11-09T15:50:30Z')

const LINES = [
  line.text(1, '2026-11-08T10:00:00Z', 'yesterday'),
  line.text(2, '2026-11-09T14:00:00Z', 'ran 5k'),
  line.sent(3, '2026-11-09T14:01:00Z', 'Logged.'),
  line.text(4, '2026-11-09T15:40:00Z', 'coffee 150'),
  line.email(5, '2026-11-09T15:45:00Z', 'Booking', 'Your train.'),
  line.edit(6, '2026-11-09T15:46:00Z', 4, 'coffee 120'),
  line.reaction(7, '2026-11-09T15:50:00Z', 4, '👍'),
]

// The bridge's part, as a running bridge writes it.
const BRIDGE = {
  startedAt: '2026-11-09T06:00:00Z',
  writtenAt: '2026-11-09T15:50:12Z',
  stoppedAt: null,
  channels: { whatsapp: 'WhatsApp: linked', email: 'Email: connected, last checked 21:20; 2 stored and 1 skipped in the last 24 hours.' },
  backups: 'Backups: last 03:30, snapshot 1a2b3c4d. Next Tue 10 Nov 03:30.',
}

const STATUS = {
  startedAt: '2026-11-09T06:00:00Z',
  accel: 'kvm',
  zdr: true,
  internet: false,
  imageBuiltAt: '2026-11-08T12:31:40Z',
  agents: { lifelog: { model: 'anthropic/claude-sonnet-5.5', timeoutMinutes: 10, reads: ['whatsapp'] } },
}

const STATE = {
  cursor: 3,
  retry: [{ seq: 2, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'not reported' }],
  failed: [
    { seq: 1, at: '2026-11-09T12:00:00Z', reason: 'unreadable' },
    { seq: 3, at: '2026-11-09T12:00:00Z', reason: 'unreadable' },
  ],
  backfill: { id: 'people-1', until: 3, cursor: 1, retry: [], skipped: [] },
  backfillDone: [],
  scheduled: {},
  lastRun: { at: '2026-11-09T15:48:00Z', ok: false, seqs: [2], durationMs: 48211 },
  paused: { since: '2026-11-09T15:48:50Z', cause: 'setup', reason: 'OpenRouter: No endpoints found matching your data policy', next: '2026-11-09T16:18:50Z', tries: 1 },
}

function setup(t) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const status = ({ timeZone = 'Asia/Kolkata', lines = LINES, now = NOW } = {}) => statusText({ now, settings: { timeZone }, paths, index: indexOf(lines) })
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomic(file, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const netlog = (date, entries) => {
    fs.mkdirSync(paths.networkLogDir, { recursive: true })
    fs.appendFileSync(paths.networkLog(date), entries.map(formatNetworkLogLine).join(''))
  }
  return { root, paths, status, write, netlog }
}

const request = (id, at, host = 'openrouter.ai') => ({ id, at, event: 'request', host, method: 'POST', path: '/api/v1/messages' })

test('status: before the bridge and the runner have ever started, it says so', t => {
  const { status } = setup(t)
  assert.equal(
    status(),
    [
      'Scooter, Mon 9 Nov 21:20 (Asia/Kolkata)',
      '',
      "Bridge: it hasn't written its status yet, so there is nothing to say about the channels or the backups.",
      'Newest message: #5, 21:15, on email',
      '',
      "Runner: it hasn't started yet, so there is nothing to say about the agent or its VMs.",
      'Network, last 24 hours: 0 requests to 0 hosts.',
    ].join('\n'),
  )
  assert.match(status({ lines: [] }), /^Newest message: none yet$/m)
})

test('status: the bridge\'s part as it last wrote it, the runner\'s settings, the agent\'s runs, its counts and the network log, in the owner\'s time zone', t => {
  const { status, write, netlog, paths } = setup(t)
  write(paths.bridgeStatus, BRIDGE)
  write(paths.runnerStatus, STATUS)
  write(paths.agentState('lifelog'), STATE)
  // Within the last 24 hours: three requests to two hosts, with what came of them, and one refused
  // and four more a run only counted. One older is left out.
  netlog('2026-11-08', [request('20261108T155000000-0001', '2026-11-08T15:50:00Z'), request('20261108T160000000-0001', '2026-11-08T16:00:00Z')])
  netlog('2026-11-09', [
    request('20261109T120000000-0001', '2026-11-09T12:00:00Z'),
    { id: '20261109T120000000-0001', at: '2026-11-09T12:00:01Z', event: 'response', status: 401, ms: 120 },
    { id: '20261109T120000000-0001', at: '2026-11-09T12:00:01Z', event: 'end', sent: 9000, received: 300, ms: 130 },
    request('20261109T120100000-0001', '2026-11-09T12:01:00Z', 'example.com'),
    { at: '2026-11-09T12:02:00Z', event: 'refused', host: 'example.org', reason: 'host not allowed' },
    { at: '2026-11-09T12:03:00Z', event: 'unlogged', refused: 4 },
  ])
  assert.equal(
    status(),
    [
      'Scooter, Mon 9 Nov 21:20 (Asia/Kolkata)',
      '',
      'Bridge: started 11:30; it last wrote its status 21:20.',
      'WhatsApp: linked',
      'Email: connected, last checked 21:20; 2 stored and 1 skipped in the last 24 hours.',
      'Newest message: #5, 21:15, on email',
      '',
      'Runner: started 11:30. VMs run with KVM; their image was built Sun 8 Nov 18:01.',
      "Zero data retention: on. The agent's internet access: off.",
      'Network, last 24 hours: 3 requests to 2 hosts, and 5 refused.',
      '',
      'lifelog: last run 21:18, failed, 1 message, 48 s.',
      'Runs are paused since 21:18: OpenRouter: No endpoints found matching your data policy. Next try 21:48.',
      // #4 and its edit #6 are after the cursor and from WhatsApp; the email isn't read; the
      // reaction isn't work.
      'Messages: 2 pending, 1 retrying, 2 failed.',
      'Backfill people-1: at #1 of #3.',
      '',
      BRIDGE.backups,
    ].join('\n'),
  )
})

test('status: a bridge that stopped says when, and its lines are from then; one that wrote long ago says when', t => {
  const { status, write, paths } = setup(t)
  write(paths.bridgeStatus, { ...BRIDGE, writtenAt: '2026-11-08T17:00:00Z', stoppedAt: '2026-11-08T17:00:00Z', channels: { whatsapp: 'WhatsApp: stopped' } })
  const text = status()
  assert.match(text, /^Bridge: stopped Sun 8 Nov 22:30, when it last wrote its status\.\nWhatsApp: stopped\nNewest message: #5, 21:15, on email$/m)
  assert.ok(text.endsWith(`\n\n${BRIDGE.backups}`))
  // A bridge that stopped without saying so, as after a crash, leaves the time it last wrote.
  write(paths.bridgeStatus, { ...BRIDGE, writtenAt: '2026-11-08T17:00:00Z' })
  assert.match(status(), /^Bridge: started 11:30; it last wrote its status Sun 8 Nov 22:30\.$/m)
})

test('status: a runner that waits before it goes on, after stopping on an error, says until when and why, and nothing once the wait is over', t => {
  const { status, write, paths } = setup(t)
  const runnerLines = () => status().split('\n').filter(text => text.startsWith('Runner') || text.startsWith('The runner'))
  write(paths.runnerStatus, { ...STATUS, startedAt: '2026-11-09T15:50:00Z', restart: { stops: 3, until: '2026-11-09T16:20:00Z', reason: 'ENOSPC' } })
  assert.deepEqual(runnerLines(), [
    'Runner: started 21:20. VMs run with KVM; their image was built Sun 8 Nov 18:01.',
    'The runner waits until 21:50 before it goes on: it stopped on an error (ENOSPC), 3 times in a row. Restarting it ends the wait.',
  ])
  write(paths.runnerStatus, { ...STATUS, restart: { stops: 1, until: '2026-11-09T15:51:00Z', reason: null } })
  assert.equal(runnerLines()[1], "The runner waits until 21:21 before it goes on: it stopped, and couldn't record why. Restarting it ends the wait.")
  // Over, or none: nothing is said. A status an older runner wrote has no `restart`.
  write(paths.runnerStatus, { ...STATUS, restart: { stops: 1, until: '2026-11-09T15:50:30Z', reason: 'ENOSPC' } })
  assert.equal(runnerLines().length, 1)
  write(paths.runnerStatus, { ...STATUS, restart: null })
  assert.equal(runnerLines().length, 1)
})

test('status: the same files in another time zone', t => {
  const { status, write, paths } = setup(t)
  write(paths.bridgeStatus, { ...BRIDGE, channels: { whatsapp: 'WhatsApp: linked' } })
  write(paths.runnerStatus, { ...STATUS, accel: 'emulation', zdr: false, internet: true, imageBuiltAt: null })
  const { paused: _, backfill: __, ...running } = STATE
  write(paths.agentState('lifelog'), { ...running, lastRun: { at: '2026-11-09T15:48:00Z', ok: true, seqs: [], durationMs: 185_000 } })
  assert.equal(
    status({ timeZone: 'America/New_York' }),
    [
      'Scooter, Mon 9 Nov 10:50 (America/New_York)',
      '',
      'Bridge: started 01:00; it last wrote its status 10:50.',
      'WhatsApp: linked',
      'Newest message: #5, 10:45, on email',
      '',
      'Runner: started 01:00. VMs run with emulation, which is much slower; their image was built when, unknown.',
      "Zero data retention: off. The agent's internet access: on.",
      'Network, last 24 hours: 0 requests to 0 hosts.',
      '',
      'lifelog: last run 10:48, ok, a task, 3 min 5 s.',
      "Runs aren't paused.",
      'Messages: 2 pending, 1 retrying, 2 failed.',
      '',
      BRIDGE.backups,
    ].join('\n'),
  )
})

test('status: an agent that hasn\'t run, and files that can\'t be read, are said to be so', t => {
  const { status, write, paths } = setup(t)
  write(paths.runnerStatus, STATUS)
  assert.match(status(), /^lifelog: it hasn't run yet\.$/m)
  write(paths.agentState('lifelog'), '{"cursor":')
  assert.match(status(), /^lifelog: its state\.json can't be read \(not a state\)\.$/m)
  // A state of before this version, with the fields of the commands and of `/new`, isn't one.
  write(paths.agentState('lifelog'), { ...STATE, commandSeq: 0, session: null })
  assert.match(status(), /^lifelog: its state\.json can't be read \(not a state\)\.$/m)
  // A folder where a day of the network log should be.
  fs.mkdirSync(paths.networkLog('2026-11-09'), { recursive: true })
  assert.match(status(), /^Network log: it can't be read \(EUNTRUSTED\)\.$/m)
  write(paths.runnerStatus, '{"accel": "warp"}')
  const text = status()
  assert.match(text, /^Runner: its status\.json can't be read \(not a status\)\.$/m)
  // Nothing is known of the agents then.
  assert.ok(!text.includes('lifelog'))
  // An agent's name that isn't one is no path to read.
  write(paths.runnerStatus, { ...STATUS, agents: { '../../etc': STATUS.agents.lifelog } })
  assert.match(status(), /^Runner: its status\.json can't be read \(not a status\)\.$/m)

  // The bridge's: not JSON, not a status, too large; and nothing is said of the channels or the
  // backups then.
  const unreadable = why => new RegExp(`^Bridge: its status\\.json can't be read \\(${why}\\), so there is nothing to say about the channels or the backups\\.\\nNewest message: `, 'm')
  write(paths.bridgeStatus, '{"startedAt":')
  assert.match(status(), unreadable('not a status'))
  write(paths.bridgeStatus, { ...BRIDGE, channels: { telegram: 'Telegram: linked' } })
  assert.match(status(), unreadable('not a status'))
  write(paths.bridgeStatus, ' '.repeat(limits.STATUS_FILE_MAX_BYTES + 1))
  assert.match(status(), unreadable('EFBIG'))
  assert.ok(!status().includes('Backups'))
})

test('status: the runner\'s files, and the folders they are in, are read without following a link or waiting on a FIFO, as files another user controls', t => {
  const { status, write, paths, root } = setup(t)
  write(paths.runnerStatus, STATUS)
  write(paths.agentState('lifelog'), '{}')
  // As the runner's user could leave them: a FIFO for status.json, a link to a file the runner
  // can't read for state.json, and a FIFO for the day's network log.
  fs.rmSync(paths.runnerStatus)
  execFileSync('mkfifo', [paths.runnerStatus])
  const secret = path.join(root, 'secret.json')
  fs.writeFileSync(secret, JSON.stringify(STATE))
  fs.rmSync(paths.agentState('lifelog'))
  fs.symlinkSync(secret, paths.agentState('lifelog'))
  fs.mkdirSync(paths.networkLogDir, { recursive: true })
  execFileSync('mkfifo', [paths.networkLog('2026-11-09')])
  const started = Date.now()
  const text = status()
  assert.ok(Date.now() - started < 1000)
  assert.match(text, /^Runner: its status\.json can't be read \(EUNTRUSTED\)\.$/m)
  assert.match(text, /^Network log: it can't be read \(EUNTRUSTED\)\.$/m)
  // With status.json back, the link in place of state.json is said to be unreadable too.
  fs.rmSync(paths.runnerStatus)
  write(paths.runnerStatus, STATUS)
  assert.match(status(), /^lifelog: its state\.json can't be read \(EUNTRUSTED\)\.$/m)
  // And one too large to be the runner's.
  fs.rmSync(paths.agentState('lifelog'))
  write(paths.agentState('lifelog'), ' '.repeat(limits.STATUS_FILE_MAX_BYTES + 1))
  assert.match(status(), /^lifelog: its state\.json can't be read \(EFBIG\)\.$/m)

  // A link in place of the agent's folder, or of the network log's, to folders whose files would
  // be read as the runner's: neither is followed.
  const elsewhere = path.join(root, 'elsewhere')
  fs.mkdirSync(elsewhere)
  fs.writeFileSync(path.join(elsewhere, 'state.json'), JSON.stringify(STATE))
  fs.writeFileSync(path.join(elsewhere, '2026-11-09.jsonl'), formatNetworkLogLine(request('20261109T120000000-0001', '2026-11-09T12:00:00Z')))
  fs.rmSync(paths.agentDir('lifelog'), { recursive: true })
  fs.symlinkSync(elsewhere, paths.agentDir('lifelog'))
  fs.rmSync(paths.networkLogDir, { recursive: true })
  fs.symlinkSync(elsewhere, paths.networkLogDir)
  const linked = status()
  assert.match(linked, /^lifelog: its state\.json can't be read \(EUNTRUSTED\)\.$/m)
  assert.match(linked, /^Network log: it can't be read \(EUNTRUSTED\)\.$/m)
})

test('status: a control or format character, or a line separator, in what another user wrote, such as a reason, is printed as U+FFFD, and can\'t start a line of its own', t => {
  const { status, write, paths } = setup(t)
  const escape = '\u001b]2;owned\u0007\u001b[2J'
  write(paths.bridgeStatus, { ...BRIDGE, backups: `Backups: the last, 03:30, failed (restic backup: ${escape}).` })
  write(paths.runnerStatus, { ...STATUS, restart: { stops: 1, until: '2026-11-09T16:20:00Z', reason: `E${escape}` } })
  write(paths.agentState('lifelog'), { ...STATE, paused: { ...STATE.paused, reason: `fine\nlifelog: last run 21:19, ok, 9 messages, 1 s.\r${escape}` }, backfill: { ...STATE.backfill, id: `x${escape}` } })
  const text = status()
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  assert.equal(text.split('\n').filter(text => text.startsWith('lifelog:')).length, 1)
  const shown = '\uFFFD]2;owned\uFFFD\uFFFD[2J'
  assert.match(text, new RegExp(`^The runner waits until 21:50 before it goes on: it stopped on an error \\(E${shown.replace(/[[\]]/g, '\\$&')}\\)\\. Restarting it ends the wait\\.$`, 'm'))
  assert.ok(text.includes(`Runs are paused since 21:18: fine\uFFFDlifelog: last run 21:19, ok, 9 messages, 1 s.\uFFFD${shown}. Next try 21:48.`))
  assert.ok(text.includes(`Backfill x${shown}: at #1 of #3.`))
  assert.ok(text.endsWith(`Backups: the last, 03:30, failed (restic backup: ${shown}).`))
  // A format character, such as the one that shows the rest of a line right to left, and the line
  // and paragraph separators.
  write(paths.agentState('lifelog'), { ...STATE, paused: { ...STATE.paused, reason: 'a\u202Eb\u2066c\u200Fd\u2028e\u2029f\uFEFFg' } })
  assert.ok(status().includes('Runs are paused since 21:18: a\uFFFDb\uFFFDc\uFFFDd\uFFFDe\uFFFDf\uFFFDg. Next try 21:48.'))
})

test('status: the datastore is read without changing it, part of a line a crash left included, and a damaged one is said to be so', t => {
  const { paths, write } = setup(t)
  writeDatastore(paths, LINES)
  // Part of a line, as a crash, or the bridge writing, leaves it.
  fs.appendFileSync(paths.dayLog('2026/11/09'), '{"seq":8,"kind":"mess')
  const before = fs.readFileSync(paths.dayLog('2026/11/09'))
  const index = readIndex(paths)
  assert.equal(index.lastSeq, 7)
  assert.deepEqual(fs.readFileSync(paths.dayLog('2026/11/09')), before)
  const settings = { timeZone: 'Asia/Kolkata' }
  assert.match(statusText({ now: NOW, settings, paths, index }), /^Newest message: #5, 21:15, on email$/m)

  // A line that isn't one: the report says where, and goes on without the datastore.
  fs.writeFileSync(paths.dayLog('2026/11/09'), `${before.toString('utf8').split('\n').slice(0, 1).join('\n')}\n{"seq":3,"kind":"command","text":"/status"}\n`)
  const broken = readIndex(paths)
  assert.ok(broken instanceof Error)
  const log = paths.dayLog('2026/11/09')
  write(paths.runnerStatus, STATUS)
  write(paths.agentState('lifelog'), STATE)
  const text = statusText({ now: NOW, settings, paths, index: broken })
  assert.ok(text.includes(`Newest message: the datastore can't be read (${log}, line 2: kind must be one of message, edit, delete, reaction; `), text)
  assert.match(text, /^Messages: 1 retrying, 2 failed; those pending can't be counted without the datastore\.$/m)
  assert.ok(!text.includes('/status'))
})

// Every file and folder under `dir`, with what a change would show: its type, size, mode, owner,
// times and contents.
function snapshot(dir) {
  const out = {}
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      const stat = fs.lstatSync(full)
      out[path.relative(dir, full)] = [stat.mode, stat.uid, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, entry.isFile() ? fs.readFileSync(full, 'base64') : null]
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}

test('status: scooter status prints the report and changes nothing: no file, no lock and no socket, with the bridge running, a backup under way and a second copy beside it', async t => {
  const { root, paths, write } = setup(t)
  writeDatastore(paths, LINES)
  write(paths.bridgeStatus, BRIDGE)
  write(paths.runnerStatus, STATUS)
  write(paths.agentState('lifelog'), STATE)
  // A bridge holds its socket, and a backup its lock.
  fs.mkdirSync(paths.locks, { recursive: true })
  const bridge = await holdInstance(paths.bridgeSocket, 'bridge')
  atEnd(t, () => bridge.close())
  takeLock(paths.backupLock, { clock: createFakeClock(NOW) })
  const before = snapshot(paths.dataDir)

  // In the process, with the given clock.
  const settings = { timeZone: 'Asia/Kolkata', dataDir: paths.dataDir, configDir: paths.configDir }
  let out = ''
  const code = await runStatus({ settings, stdout: { write: text => (out += text) }, stderr: { write: text => assert.fail(text) }, clock: createFakeClock(NOW) })
  assert.equal(code, 0)
  assert.equal(out, `${statusText({ now: NOW, settings, paths, index: readIndex(paths) })}\n`)
  // It takes no arguments.
  let err = ''
  assert.equal(await runStatus({ args: ['--now'], settings, stdout: { write: text => assert.fail(text) }, stderr: { write: text => (err += text) } }), 2)
  assert.equal(err, 'scooter status: it takes no arguments\n')

  // As a program, the bridge's side, two copies at once.
  const envDir = path.join(root, 'env')
  fs.mkdirSync(envDir)
  fs.writeFileSync(path.join(envDir, 'bridge.env'), `OWNER_NUMBER=+919812345678\nDATA_DIR=${paths.dataDir}\nCONFIG_DIR=${paths.configDir}\n`)
  const exec = promisify(execFile)
  const env = { PATH: process.env.PATH, SCOOTER_ENV_DIR: envDir, TMPDIR: process.env.TMPDIR }
  const both = await Promise.all([exec(process.execPath, [CLI, 'status'], { env }), exec(process.execPath, [CLI, 'status'], { env })])
  for (const { stdout, stderr } of both) {
    assert.equal(stderr, '')
    assert.match(stdout, /^Scooter, \w{3} \d+ \w{3} \d\d:\d\d \(Asia\/Kolkata\)\n\nBridge: started /)
    assert.match(stdout, /^Messages: 2 pending, 1 retrying, 2 failed\.$/m)
  }
  assert.deepEqual(snapshot(paths.dataDir), before)
})

// ---------------------------------------------------------------------------------------------
// The bridge's status.json

test('status: the bridge\'s status.json is checked when written and when read, and each fault names its field', t => {
  assert.deepEqual(checkBridgeStatus(BRIDGE), [])
  assert.deepEqual(checkBridgeStatus({ ...BRIDGE, stoppedAt: '2026-11-09T16:00:00Z' }), [])
  const cases = [
    [{ startedAt: 'today' }, 'startedAt must be a UTC time to the second'],
    [{ writtenAt: undefined }, 'writtenAt is missing'],
    [{ stoppedAt: 'later' }, 'stoppedAt must be a UTC time to the second, or null'],
    [{ channels: { whatsapp: '' } }, 'channels must give a line for each channel, named whatsapp or email'],
    [{ channels: { telegram: 'Telegram: linked' } }, 'channels must give a line for each channel, named whatsapp or email'],
    [{ channels: ['WhatsApp: linked'] }, 'channels must give a line for each channel, named whatsapp or email'],
    [{ backups: null }, 'backups must be a line'],
    [{ commands: [] }, 'commands is not a field of the status'],
  ]
  for (const [changes, problem] of cases) {
    const status = JSON.parse(JSON.stringify({ ...BRIDGE, ...changes }))
    assert.ok(checkBridgeStatus(status).includes(problem), `${problem}: ${JSON.stringify(checkBridgeStatus(status))}`)
  }
  assert.deepEqual(checkBridgeStatus([]), ['the status must be an object'])
})

test('status: the bridge writes status.json at its start, whenever what it says changes, and once more when it stops; a write that fails is tried at the next look', async t => {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: root, configDir: path.join(root, 'config') })
  fs.mkdirSync(paths.bridge)
  const clock = createFakeClock(NOW)
  const { log, entries } = createTestLog({ clock })
  let part = { channels: { whatsapp: 'WhatsApp: starting' }, backups: 'Backups: none yet. Next Tue 10 Nov 03:30.' }
  const renders = []
  const file = createStatusFile({
    paths,
    clock,
    log,
    render: now => {
      renders.push(now)
      return part
    },
  })
  atEnd(t, () => file.stop())
  file.start()
  assert.deepEqual(readBridgeStatus(paths), { startedAt: '2026-11-09T15:50:30Z', writtenAt: '2026-11-09T15:50:30Z', stoppedAt: null, ...part })
  assert.equal(fs.statSync(paths.bridgeStatus).mode & 0o777, 0o600)
  const ino = () => fs.statSync(paths.bridgeStatus).ino

  // A look every second; nothing changed, nothing written.
  const first = ino()
  await clock.advance(3 * SECOND)
  assert.equal(renders.length, 4)
  assert.equal(ino(), first)
  // A change is written at the next look.
  part = { ...part, channels: { whatsapp: 'WhatsApp: linked' } }
  await clock.advance(SECOND)
  assert.deepEqual(readBridgeStatus(paths), { startedAt: '2026-11-09T15:50:30Z', writtenAt: '2026-11-09T15:50:34Z', stoppedAt: null, ...part })

  // A write that fails, as on a full disk: logged once, and the file stays as it was.
  fs.rmSync(paths.bridge, { recursive: true })
  fs.writeFileSync(paths.bridge, 'not a folder')
  part = { ...part, channels: { whatsapp: 'WhatsApp: wacli stopped, and starts again shortly' } }
  await clock.advance(3 * SECOND)
  assert.deepEqual(entries.filter(entry => entry.event === 'bridge.status_not_written').map(entry => entry.code), ['ENOTDIR'])
  // Once it works again, the next look writes it, and says so.
  fs.rmSync(paths.bridge)
  fs.mkdirSync(paths.bridge)
  await clock.advance(SECOND)
  assert.deepEqual(readBridgeStatus(paths).channels, part.channels)
  assert.ok(entries.some(entry => entry.event === 'bridge.status_written'))

  // A render that throws is logged once, and the file kept; once it works again, that is logged,
  // and its lines written.
  const kept = readBridgeStatus(paths)
  part = null
  await clock.advance(3 * SECOND)
  assert.equal(entries.filter(entry => entry.event === 'bridge.status_not_rendered').length, 1)
  assert.deepEqual(readBridgeStatus(paths), kept)
  part = { channels: { whatsapp: 'WhatsApp: stopped' }, backups: 'Backups: none yet. Next Tue 10 Nov 03:30.' }
  await clock.advance(SECOND)
  assert.ok(entries.some(entry => entry.event === 'bridge.status_rendered'))
  assert.deepEqual(readBridgeStatus(paths), { startedAt: '2026-11-09T15:50:30Z', writtenAt: '2026-11-09T15:50:42Z', stoppedAt: null, ...part })

  // Stopped: no more looks, and once more, with when.
  await clock.advance(SECOND)
  await file.stop()
  assert.deepEqual(clock.sleeping(), [])
  assert.deepEqual(readBridgeStatus(paths), { startedAt: '2026-11-09T15:50:30Z', writtenAt: '2026-11-09T15:50:43Z', stoppedAt: '2026-11-09T15:50:43Z', ...part })

  // A render that throws when the bridge stops: the lines it last rendered, saying it stopped.
  let broken = false
  const again = createStatusFile({
    paths,
    clock,
    log,
    render: () => {
      if (broken) throw new Error('no lines')
      return part
    },
  })
  again.start()
  await clock.advance(SECOND)
  broken = true
  await again.stop()
  assert.deepEqual(readBridgeStatus(paths), { startedAt: '2026-11-09T15:50:43Z', writtenAt: '2026-11-09T15:50:44Z', stoppedAt: '2026-11-09T15:50:44Z', ...part })

  // What isn't a status is never written.
  assert.throws(() => writeBridgeStatus(paths, { ...BRIDGE, backups: '' }), /not a bridge status: backups must be a line/)
  // The file, and the temporary file of each write, are in a folder of their own, which backups
  // leave out whole.
  assert.deepEqual(fs.readdirSync(paths.bridge), ['status'])
  assert.deepEqual(fs.readdirSync(paths.bridgeStatusDir), ['status.json'])
  assert.equal(fs.statSync(paths.bridgeStatusDir).mode & 0o777, 0o700)
})
