// `/status` (5.4 of DESIGN.md; section 10, "Time" for `/status`): what the bridge says about each
// channel, the newest message, the runner and its agent, the network log and the backups, from the
// files it can read, with times in `SCOOTER_TZ`; and what it says when the runner hasn't written
// them yet, or they can't be read.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { statusText } from '../src/bridge/status.mjs'
import { writeFileAtomic } from '../src/common/files.mjs'
import { limits } from '../src/common/limits.mjs'
import { formatNetworkLogLine } from '../src/common/netlog.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createFakeChannel } from './support/fake-channel.mjs'
import { indexOf, line } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

// The line about backups, which `createBackups().statusLine` makes (test/backup.test.mjs), and the
// reply only passes on.
const BACKUPS = 'Backups: last 03:30, snapshot 1a2b3c4d. Next Tue 10 Nov 03:30.'

// 21:20 in Asia/Kolkata on Monday 9 November 2026; 10:50 in New York.
const NOW = Date.parse('2026-11-09T15:50:30Z')

const LINES = [
  line.text(1, '2026-11-08T10:00:00Z', 'yesterday'),
  line.text(2, '2026-11-09T14:00:00Z', 'ran 5k'),
  line.sent(3, '2026-11-09T14:01:00Z', 'Logged.'),
  line.text(4, '2026-11-09T15:40:00Z', 'coffee 150'),
  line.email(5, '2026-11-09T15:45:00Z', 'Booking', 'Your train.'),
  line.edit(6, '2026-11-09T15:46:00Z', 4, 'coffee 120'),
  line.command(7, '2026-11-09T15:50:00Z', '/status'),
]

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
  commandSeq: 0,
  retry: [{ seq: 2, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'not reported' }],
  failed: [
    { seq: 1, at: '2026-11-09T12:00:00Z', reason: 'unreadable' },
    { seq: 3, at: '2026-11-09T12:00:00Z', reason: 'unreadable' },
  ],
  session: null,
  onceDone: [],
  backfill: { id: 'people-1', until: 3, cursor: 1, retry: [], skipped: [] },
  backfillDone: [],
  scheduled: {},
  lastRun: { at: '2026-11-09T15:48:00Z', ok: false, seqs: [2], durationMs: 48211 },
  paused: { since: '2026-11-09T15:48:50Z', cause: 'setup', reason: 'OpenRouter: No endpoints found matching your data policy', next: '2026-11-09T16:18:50Z', tries: 1 },
}

function setup(t) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const channels = new Map([['whatsapp', { ...createFakeChannel({ name: 'whatsapp' }), status: () => 'WhatsApp: linked' }]])
  const status = ({ timeZone = 'Asia/Kolkata', lines = LINES } = {}) =>
    statusText({ now: NOW, settings: { timeZone }, paths, channels, index: indexOf(lines), backups: BACKUPS })
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

test('status: before the runner has ever started, it says so', t => {
  const { status } = setup(t)
  assert.equal(
    status(),
    [
      'Scooter, Mon 9 Nov 21:20 (Asia/Kolkata)',
      '',
      'WhatsApp: linked',
      'Newest message: #5, 21:15, on email',
      '',
      "Runner: it hasn't started yet, so there is nothing to say about the agent or its VMs.",
      'Network, last 24 hours: 0 requests to 0 hosts.',
      '',
      BACKUPS,
    ].join('\n'),
  )
  assert.match(status({ lines: [] }), /^Newest message: none yet$/m)
})

test('status: the runner\'s settings, the agent\'s runs, its counts and the network log, in the owner\'s time zone', t => {
  const { status, write, netlog, paths } = setup(t)
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
      'WhatsApp: linked',
      'Newest message: #5, 21:15, on email',
      '',
      'Runner: started 11:30. VMs run with KVM; their image was built Sun 8 Nov 18:01.',
      "Zero data retention: on. The agent's internet access: off.",
      'Network, last 24 hours: 3 requests to 2 hosts, and 5 refused.',
      '',
      'lifelog: last run 21:18, failed, 1 message, 48 s.',
      'Runs are paused since 21:18: OpenRouter: No endpoints found matching your data policy. Next try 21:48.',
      // #4 and its edit #6 are after the cursor and from WhatsApp; the email isn't read; the
      // command isn't work.
      'Messages: 2 pending, 1 retrying, 2 failed.',
      'Backfill people-1: at #1 of #3.',
      '',
      BACKUPS,
    ].join('\n'),
  )
})

test('status: a runner that waits before it goes on, after stopping on an error, says until when and why, and nothing once the wait is over (D229)', t => {
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
  write(paths.runnerStatus, { ...STATUS, accel: 'emulation', zdr: false, internet: true, imageBuiltAt: null })
  const { paused: _, backfill: __, ...running } = STATE
  write(paths.agentState('lifelog'), { ...running, lastRun: { at: '2026-11-09T15:48:00Z', ok: true, seqs: [], durationMs: 185_000 } })
  assert.equal(
    status({ timeZone: 'America/New_York' }),
    [
      'Scooter, Mon 9 Nov 10:50 (America/New_York)',
      '',
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
      BACKUPS,
    ].join('\n'),
  )
})

test('status: an agent that hasn\'t run, and files that can\'t be read, are said to be so', t => {
  const { status, write, paths } = setup(t)
  write(paths.runnerStatus, STATUS)
  assert.match(status(), /^lifelog: it hasn't run yet\.$/m)
  write(paths.agentState('lifelog'), '{"cursor":')
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
})

test('status: the runner\'s files are read without following a link or waiting on a FIFO, as files another user controls', t => {
  const { status, write, paths, root } = setup(t)
  write(paths.runnerStatus, STATUS)
  write(paths.agentState('lifelog'), '{}')
  // As the runner's user could leave them: a FIFO for status.json, a link to a file the runner
  // can't read for state.json, and a FIFO for the day's network log.
  fs.rmSync(paths.runnerStatus)
  execFileSync('mkfifo', [paths.runnerStatus])
  const secret = path.join(root, 'secret.json')
  fs.writeFileSync(secret, JSON.stringify({ cursor: 0 }))
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
})
