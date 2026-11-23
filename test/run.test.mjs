// One run, from the lock to the state, through the
// fake sandbox and the pi stub: what pi is given, what it leaves, what is committed and sent, and
// what the state says afterwards.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { overrideLimits } from '../src/common/limits.mjs'
import { readLock } from '../src/common/locks.mjs'
import { actFull, holds } from './support/full-disk.mjs'
import { skipIfRoot } from './support/root.mjs'
import { exampleYaml, fillerLines, line, writeConfig } from './support/runner.mjs'
import { KEY, MINUTE, SECOND, openTestRunner, prepareTestRunner, startTestRunner } from './support/test-runner.mjs'

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
const START = '2026-11-09T15:50:30Z'

test('run: the pi stub takes a message from the datastore to a committed view and a correct state.json', async t => {
  const { runner, clock, state, outbox, git, views, paths, sandbox } = await openTestRunner(t, {
    lines: [...fillerLines(1041), line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')],
    state: { cursor: 1041, retry: [], failed: [], backfillDone: [], scheduled: {}, lastRun: null },
    start: START,
  })

  // The owner has just written: the runner waits for them to be quiet.
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND)
  const { action, outcome } = await runner.tick()
  assert.deepEqual(action, { kind: 'messages' })
  assert.deepEqual(outcome, { ok: true, cause: null })

  // The view, committed by Scooter with the batch's numbers.
  assert.equal(views('notes.csv'), 'seq,text\n1042,"coffee 150"\n')
  assert.equal(git('log', '-1', '--format=%an <%ae>%n%s'), 'Scooter <scooter@localhost>\nlifelog: #1042\n')
  assert.equal(git('status', '--porcelain'), '')

  // The ✅ reaction, in quiet mode, and the state.
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 1042, emoji: '✅', channels: ['whatsapp'] }])
  const after = state()
  assert.equal(after.cursor, 1042)
  assert.deepEqual(after.retry, [])
  assert.deepEqual(after.failed, [])
  assert.deepEqual(after.lastRun, { at: '2026-11-09T15:50:38Z', ok: true, seqs: [1042], durationMs: 0 })
  assert.equal(after.paused, undefined)

  // The session is kept for the next run, and the lock is gone.
  assert.ok(fs.existsSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-09.jsonl')))
  assert.equal(readLock(paths.runLock), null)
  assert.equal(sandbox.runs.length, 1)

  // Nothing more to do.
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
})

// A state that has dealt with the 1,041 lines of filler.
const HANDLED = { cursor: 1041, retry: [], failed: [], backfillDone: [], scheduled: {}, lastRun: null }

// A runner with the filler and `lines` after it, at 21:20 in Kolkata.
function openWith(t, lines, options = {}) {
  return openTestRunner(t, { lines: [...fillerLines(1041), ...lines], state: HANDLED, start: START, ...options })
}

// Lets the runner see what was added, waits out the quiet period, and runs what comes next.
async function runNext(runner, clock) {
  await runner.tick()
  await clock.advance(8 * SECOND)
  return runner.tick()
}

test('run: the sandbox gets pi\'s command, what the VM sees and may change with sessions/ hidden, its environment and the network policy', async t => {
  const { runner, clock, sandbox, paths } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
  fs.writeFileSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-08.jsonl'), '{"type":"session"}\n')
  await runNext(runner, clock)
  const [{ spec, env }] = sandbox.runs
  const agent = paths.agentDir('lifelog')
  const run = path.join(agent, 'run')

  assert.equal(spec.cwd, agent)
  assert.equal(spec.timeoutMs, 10 * MINUTE)
  // The data folder, of which the VM sees what reads and writes name, and run/, and may change what
  // writes names, and run/session/, run/send/ and run/marks.txt; never sessions/.
  assert.deepEqual(spec.files, {
    root: paths.dataDir,
    reads: [paths.datastore, agent, path.join(agent, 'views'), path.join(agent, 'memory'), run],
    writes: [
      { path: path.join(agent, 'views'), folder: true },
      { path: path.join(agent, 'memory'), folder: true },
      { path: path.join(run, 'session'), folder: true },
      { path: path.join(run, 'send'), folder: true },
      { path: path.join(run, 'marks.txt'), folder: false },
    ],
    hide: [paths.agentSessions('lifelog')],
  })
  assert.deepEqual(spec.argv.slice(0, -1), [
    'pi',
    '-p',
    '--no-approve',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-mcp',
    '--offline',
    '--provider',
    'openrouter',
    '--model',
    'anthropic/claude-sonnet-5.5',
    '--thinking',
    'low',
    '--tools',
    'read,bash,edit,write,grep,find,ls',
    '--session-dir',
    path.join(run, 'session'),
    '--session-id',
    'lifelog-2026-11-09',
    '--append-system-prompt',
    path.join(run, 'config', 'prompts', 'lifelog.md'),
    '--skill',
    path.join(run, 'skills', 'scooter'),
    ...['expenses', 'runs', 'meals', 'travel', 'people'].flatMap(skill => ['--skill', path.join(run, 'config', 'skills', skill)]),
    '--',
  ])
  // The prompt, the last argument, after `--`: the trigger's, filled in.
  assert.equal(
    spec.argv.at(-1),
    `Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.\nYour folder: ${agent}\nThe datastore: ${paths.datastore}\nThis run may change: ${agent}/views/ ${agent}/memory/\nNew: 1042\nGiven before: none\n`,
  )

  // pi's environment and nothing else, with a placeholder where the key would be.
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'ICU_TIMEZONE_FILES_DIR', 'LANG', 'OPENROUTER_API_KEY', 'PATH', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'TZ'])
  assert.deepEqual({ ...env, OPENROUTER_API_KEY: undefined }, {
    PATH: `${path.join(run, 'bin')}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: '/root',
    LANG: 'C.UTF-8',
    TZ: 'Asia/Kolkata',
    ICU_TIMEZONE_FILES_DIR: path.join(run, 'icu-tz'),
    PI_SKIP_VERSION_CHECK: '1',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    OPENROUTER_API_KEY: undefined,
  })
  assert.match(env.OPENROUTER_API_KEY, /^placeholder-/)
  assert.ok(!JSON.stringify([spec.argv, spec.env, env]).includes(KEY))

  // The policy: the configured model, internet off, ZDR on, and the key only for OpenRouter.
  assert.deepEqual(spec.policy, { model: 'anthropic/claude-sonnet-5.5', internet: false, zdr: true, secrets: { OPENROUTER_API_KEY: { hosts: ['openrouter.ai'], value: KEY } } })

  // What pi found: no sessions/, the current session's folder empty, the agent's prompt, which pi
  // appends to its system prompt, and every skill readable, and the same environment.
  const [seen] = sandbox.seen()
  assert.equal(seen.sessionsVisible, false)
  assert.deepEqual(seen.sessionFiles, [])
  assert.equal(seen.systemPrompt, 'You are lifelog.\n')
  assert.deepEqual(seen.skills, [true, true, true, true, true, true])
  assert.equal(seen.cwd, agent)
  assert.deepEqual(seen.env, env)
})

test("run: the agent finds show on its PATH, and it prints the batch's lines from the run's index file, in the owner's time", async t => {
  const { runner, clock, sandbox, paths, state } = await openWith(t, [line.text(1042, '2026-11-09T15:44:00Z', 'coffee 120'), line.edit(1043, '2026-11-09T15:50:00Z', 1042, 'coffee 150 SHOW')])
  const { outcome } = await runNext(runner, clock)
  assert.deepEqual(outcome, { ok: true, cause: null })
  const [seen] = sandbox.seen()
  assert.equal(seen.show.folder, paths.agentRunBin('lifelog'))
  assert.equal(seen.show.code, 0, seen.show.stderr)
  const log = paths.dayLog('2026/11/09')
  const stored = fs.readFileSync(log, 'utf8').split('\n')
  assert.equal(
    seen.show.stdout,
    [
      `1042  Mon 9 Nov 2026 21:14 +05:30  ${log}:1`,
      stored[0],
      '',
      `1043  Mon 9 Nov 2026 21:20 +05:30  ${log}:2`,
      stored[1],
      `  points at 1042  Mon 9 Nov 2026 21:14 +05:30  ${log}:1`,
      `  ${stored[0]}`,
      '',
    ].join('\n'),
  )
  // The index file holds every line the runner had read, the 1,041 of filler among them.
  const index = fs.readFileSync(paths.agentRunIndex('lifelog'), 'utf8').split('\n')
  assert.equal(index.length, 1044)
  assert.equal(index[1042], `1043 ${log}:2 edit 1042`)
  // The run is what it was without show: both items marked, the cursor past them.
  assert.equal(state().cursor, 1043)
  assert.deepEqual(state().retry, [])
})

test('run: with internet access on, the policy and the prompt say so', async t => {
  const { runner, clock, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')], { settings: { agentInternet: true, zdr: false } })
  await runNext(runner, clock)
  const [{ spec }] = sandbox.runs
  assert.equal(spec.policy.internet, true)
  assert.equal(spec.policy.zdr, false)
  assert.match(spec.argv.at(-1), /Reply mode: quiet\. Internet: on\.\n/)
})

test('run: sessions: only the current one is copied in, and only it is copied back, after a run that succeeded', async t => {
  const { runner, clock, sandbox, paths, add, state } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
  const sessions = paths.agentSessions('lifelog')
  const kept = path.join(sessions, 'lifelog-2026-11-09.jsonl')
  fs.writeFileSync(path.join(sessions, 'lifelog-2026-11-08.jsonl'), '{"type":"session","id":"lifelog-2026-11-08"}\n')

  // The first run of the day starts the session, in a file pi names itself.
  await runNext(runner, clock)
  assert.equal(sandbox.seen()[0].sessionContinued, false)
  const first = fs.readFileSync(kept, 'utf8')
  assert.match(first, /^{"type":"session","version":3,"id":"lifelog-2026-11-09",/)
  assert.equal(first.split('\n').length, 3)

  // The next continues it: it is copied in under its ID, and pi finds it by its first line.
  add(line.text(1043, '2026-11-09T15:51:00Z', 'lunch 300'))
  await runNext(runner, clock)
  assert.deepEqual(sandbox.seen()[1].sessionFiles, ['lifelog-2026-11-09.jsonl'])
  assert.equal(sandbox.seen()[1].sessionContinued, true)
  assert.equal(fs.readFileSync(kept, 'utf8').split('\n').length, 4)
  // The other day's session was never shown, and is as it was.
  assert.equal(fs.readFileSync(path.join(sessions, 'lifelog-2026-11-08.jsonl'), 'utf8'), '{"type":"session","id":"lifelog-2026-11-08"}\n')

  // A run that fails copies nothing back.
  add(line.text(1044, '2026-11-09T15:52:00Z', 'tea CRASH'))
  await runNext(runner, clock)
  assert.equal(state().lastRun.ok, false)
  assert.equal(fs.readFileSync(kept, 'utf8').split('\n').length, 4)

  // Nor does one that leaves its session as a link.
  fs.rmSync(kept)
  add(line.text(1045, '2026-11-09T15:53:00Z', 'link SESSIONLINK'))
  await runNext(runner, clock)
  assert.deepEqual(state().lastRun.seqs, [1045])
  assert.equal(state().lastRun.ok, true)
  assert.equal(fs.existsSync(kept), false)
})

test('run: with session: none, pi keeps no session', async t => {
  const yaml = exampleYaml().replace('session: daily', 'session: none')
  const { runner, clock, sandbox, paths } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')], { yaml })
  await runNext(runner, clock)
  const argv = sandbox.runs[0].spec.argv
  assert.ok(argv.includes('--no-session'))
  assert.ok(!argv.includes('--session-id'))
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
})

test('run: a text such as /new is a message the agent is given, and its batch goes into the day\'s session', async t => {
  const { runner, clock, sandbox, outbox, state } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', '/new'), line.text(1043, '2026-11-09T15:50:01Z', 'start again')])
  assert.equal((await runner.tick()).action.kind, 'idle')
  await runNext(runner, clock)
  assert.equal(sandbox.runs.length, 1)
  const argv = sandbox.runs[0].spec.argv
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'lifelog-2026-11-09')
  assert.match(argv.at(-1), /^New: 1042 1043$/m)
  assert.ok(!argv.at(-1).includes('/new'))
  assert.deepEqual(state().lastRun.seqs, [1042, 1043])
  assert.deepEqual(outbox(), [
    { type: 'react', by: 'lifelog', target: 1042, emoji: '✅', channels: ['whatsapp'] },
    { type: 'react', by: 'lifelog', target: 1043, emoji: '✅', channels: ['whatsapp'] },
  ])
})

test('run: a link, a FIFO, a dot name or a file git ignores fails the run; the clean-up removes it, and the session isn\'t kept', async t => {
  for (const [keyword, file] of [
    ['DOTFILE', 'views/.hidden'],
    ['SYMLINK', 'views/link.csv'],
    ['FIFO', 'memory/pipe'],
    ['IGNORED', 'views/scratch.tmp'],
  ]) {
    await t.test(keyword, async t => {
      const { runner, clock, paths, state, outbox, git, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', `coffee ${keyword}`)])
      // A file git ignores can only come from a rule pi can't write; the test adds one.
      fs.appendFileSync(path.join(paths.agentDir('lifelog'), '.git', 'info', 'exclude'), 'views/*.tmp\n')
      const { outcome } = await runNext(runner, clock)
      assert.deepEqual(outcome, { ok: false, cause: 'other' }, keyword)
      const after = state()
      assert.deepEqual(after.retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: `unexpected file ${file}` }], keyword)
      assert.equal(after.cursor, 1042)
      // Everything the run wrote is gone, the file first.
      assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'views')), [], keyword)
      assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'memory')), [], keyword)
      assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '', keyword)
      assert.equal(git('rev-list', '--count', 'HEAD'), '1\n', keyword)
      assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [], keyword)
      assert.deepEqual(outbox(), [{ type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (unexpected file ${file}). I'll try again.` }], keyword)
      assert.equal(sandbox.runs.length, 1)
    })
  }
})

test('run: a file or a folder the runner can\'t read, a name git refuses, a file with two names, or past the limits on size and count, fails the run; the clean-up removes it, and the next try runs', async t => {
  for (const [leave, file, skip] of [
    ['LOCKEDFILE', 'views/locked.csv', skipIfRoot],
    ['LOCKEDDIR', 'memory/locked', skipIfRoot],
    ['GITNAME', 'views/git~1', false],
    // A file of holes, a byte over AGENT_FILES_MAX_BYTES: found before git reads it.
    ['BIGFILE', 'views/big.csv', false],
    // AGENT_FILES_MAX_COUNT names and the view: found before git reads any, at the name that
    // passes the limit, in the order the folder gives them.
    ['MANYFILES', /^views\/many\/\d+\.csv$/, false],
    ['HARDLINK', 'views/notes-copy.csv', false],
    // A tree whose paths pass what the system takes, made by moving a folder into another: the
    // path at which it does is named, cut as a reason is, and the clean-up removes it all.
    ['DEEPTREE', /^views\/t1\/d+…$/, false],
  ]) {
    await t.test(leave, { skip }, async t => {
      const { runner, clock, paths, state, outbox, git, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 MEMORY')])
      sandbox.behave({ leave })
      assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
      const [retry] = state().retry
      assert.deepEqual({ ...retry, reason: undefined }, { seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: undefined })
      const found = retry.reason.replace(/^unexpected file /, '')
      if (file instanceof RegExp) assert.match(found, file)
      else assert.equal(found, file)
      // Everything the run wrote is gone, and nothing is staged; the session isn't kept.
      assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'views')), [])
      assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'memory')), [])
      assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
      assert.equal(git('rev-list', '--count', 'HEAD'), '1\n')
      assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
      assert.deepEqual(fs.readdirSync(paths.agentRunSession('lifelog')), [])
      assert.deepEqual(fs.readdirSync(paths.agentDiscarded('lifelog')), [])
      assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (unexpected file ${found}). I'll try again.` }])

      // A minute later the item is tried again, and gets through.
      sandbox.behave(null)
      await clock.advance(MINUTE)
      assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
      assert.equal(git('show', '--name-only', '--format=%s', 'HEAD'), 'lifelog: #1042\n\nmemory/preferences.md\nviews/notes.csv\n')
      assert.deepEqual(state().retry, [])
      assert.equal(sandbox.runs.length, 2)
    })
  }
})

test("run: nothing pi prints counts: an answer of the old format, or one longer than the sandbox keeps, marks and sends nothing, and the run passes", async t => {
  t.after(overrideLimits({ SANDBOX_STDOUT_MAX_BYTES: 16 }))
  const { runner, clock, state, outbox, git, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 OLDANSWER'), line.text(1043, '2026-11-09T15:50:01Z', 'tea ASK')])
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  // The stub printed `DONE` lines and a `REPLY_TO`, past what the sandbox keeps of stdout, and
  // neither marked nor sent: both lines are given again, at their second attempt, and nothing goes
  // to the owner. What it filed is committed.
  assert.deepEqual(state().retry, [
    { seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'not marked' },
    { seq: 1043, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'not marked' },
  ])
  assert.deepEqual(outbox(), [])
  assert.equal(git('log', '-1', '--format=%s'), 'lifelog: #1042 #1043\n')
  assert.deepEqual(sandbox.reported(), [])
})

test('run: a run the sandbox stopped for writing too much fails as pi\'s own failure, and what it wrote is thrown away', async t => {
  const { runner, clock, paths, state, git, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
  sandbox.wroteTooMuch = true
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
  assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'pi wrote more than a run may' }])
  assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'views')), [])
  assert.equal(git('rev-list', '--count', 'HEAD'), '1\n')
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])

  sandbox.wroteTooMuch = false
  await clock.advance(MINUTE)
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
})

test('run: empty folders don\'t fail the run, and are removed, so views and memory hold nothing the commit doesn\'t', async t => {
  const { runner, clock, paths, state, git, outbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 EMPTYDIRS')])
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(state().retry, [])
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 1042, emoji: '✅', channels: ['whatsapp'] }])
  assert.equal(git('show', '--name-only', '--format=%s', 'HEAD'), 'lifelog: #1042\n\nviews/notes.csv\n')
  // Everything there, files and folders, against what the commit holds, with the folders above.
  const agent = paths.agentDir('lifelog')
  const present = []
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(agent, relative), { withFileTypes: true })) {
      present.push(`${relative}/${entry.name}`)
      if (entry.isDirectory()) walk(`${relative}/${entry.name}`)
    }
  }
  walk('views')
  walk('memory')
  const committed = new Set()
  for (const file of git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'views', 'memory').split('\n').filter(Boolean)) {
    const parts = file.split('/')
    for (let n = 2; n <= parts.length; n++) committed.add(parts.slice(0, n).join('/'))
  }
  assert.deepEqual(present.sort(), [...committed].sort())
  assert.deepEqual(present, ['views/notes.csv'])
})

test('run: the modes pi set, which git doesn\'t record, are put back after a run that succeeds, and the next run writes', async t => {
  const { runner, clock, paths, state, git, add, views } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 READONLY')])
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(git('show', '--name-only', '--format=%s', 'HEAD'), 'lifelog: #1042\n\nviews/notes.csv\nviews/sub/later.csv\n')
  // The folder, a folder in it and a file, which pi left without write access: the runner's again.
  const modeOf = file => fs.statSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), file)).mode & 0o7777
  assert.deepEqual(['.', 'sub', 'notes.csv', 'sub/later.csv'].map(modeOf), [0o700, 0o700, 0o600, 0o600])
  assert.equal(git('status', '--porcelain', '--', 'views', 'memory'), '')

  add(line.text(1043, '2026-11-09T15:51:00Z', 'lunch 300'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(views('notes.csv').split('\n').length, 4)
  assert.deepEqual(state().retry, [])
})

test('run: a folder the runner can\'t read in run/session/ is passed over, a session file it can\'t read isn\'t kept, and the next runs start', { skip: skipIfRoot }, async t => {
  const { runner, clock, paths, state, add, sandbox, events } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee RUNLOCKED')])
  const kept = path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-09.jsonl')
  // Anything but the session in run/session/ is ignored, and once the session is kept, the
  // folder is emptied, before the run is recorded.
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(fs.readFileSync(kept, 'utf8').split('\n').length, 3)
  assert.deepEqual(fs.readdirSync(paths.agentRunSession('lifelog')), [])

  // The next run empties run/ first; its session file is refused, like a link, and the one kept
  // before stays.
  add(line.text(1043, '2026-11-09T15:51:00Z', 'tea SESSIONLOCKED'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(sandbox.seen()[1].sessionContinued, true)
  assert.ok(events().includes('runner.session_refused'))
  assert.equal(fs.readFileSync(kept, 'utf8').split('\n').length, 3)

  add(line.text(1044, '2026-11-09T15:52:00Z', 'lunch 300'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(sandbox.seen()[2].sessionFiles, ['lifelog-2026-11-09.jsonl'])
  assert.deepEqual(state().lastRun.seqs, [1044])
})

test('run: a tree in run/session/ whose paths pass what the system takes is emptied, and the next runs start', async t => {
  const { runner, clock, paths, state, add, events } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee DEEPSESSION')])
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.ok(fs.existsSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-09.jsonl')))
  assert.deepEqual(fs.readdirSync(paths.agentRunSession('lifelog')), [])
  assert.equal(events().includes('runner.run_left'), false)

  add(line.text(1043, '2026-11-09T15:51:00Z', 'lunch 300'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(state().lastRun.seqs, [1043])
})

test('run: on a disk pi filled, a failed run frees what pi wrote before it makes anything, and is recorded', async t => {
  for (const session of ['daily', 'none']) {
    await t.test(`session: ${session}`, async t => {
      const { runner, clock, paths, state, outbox, git, sandbox, events } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 FILLDISK')], {
        yaml: exampleYaml().replace('session: daily', `session: ${session}`),
      })
      const folders = [path.join(paths.agentDir('lifelog'), 'views'), path.join(paths.agentDir('lifelog'), 'memory'), paths.agentRunSession('lifelog'), paths.agentDiscarded('lifelog')]
      // pi leaves fill.bin in views/ and in run/session/, and exits with 0. Until both are gone,
      // nothing can be made: neither the folders the clean-up makes again, nor the outbox entry,
      // nor the state.
      t.after(actFull(() => holds(folders, 'fill.bin')))
      assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
      assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'unexpected file views/fill.bin' }])
      assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: "⚠️ I couldn't process your last messages (unexpected file views/fill.bin). I'll try again." }])
      for (const folder of folders) assert.deepEqual(fs.readdirSync(folder), [], folder)
      assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
      assert.deepEqual(events().filter(event => event.endsWith('_left')), [])

      // The next try runs, and commits.
      sandbox.behave({ leave: 'nothing' })
      await clock.advance(MINUTE)
      assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
      assert.equal(git('log', '-1', '--format=%s'), 'lifelog: #1042\n')
    })
  }
})

test('run: the commit holds views and memory, with the batch\'s numbers, and a run that changes nothing commits nothing', async t => {
  const { runner, clock, git, add } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 MEMORY'), line.text(1043, '2026-11-09T15:50:01Z', 'lunch ASK')])
  await runNext(runner, clock)
  assert.equal(git('log', '-1', '--format=%s'), 'lifelog: #1042 #1043\n')
  assert.equal(git('show', '--name-only', '--format=', 'HEAD'), 'memory/needs-review.md\nmemory/preferences.md\nviews/notes.csv\n')

  add(line.text(1044, '2026-11-09T15:51:00Z', 'nothing to file IGNORE'))
  await runNext(runner, clock)
  assert.equal(git('rev-list', '--count', 'HEAD'), '2\n')
})

test('run: what send queued goes out, quoted or about the newest item, then the state from the marks, then a ✅ for the rest of what was marked done', async t => {
  const { runner, clock, outbox, state, sandbox, paths } = await openWith(t, [
    line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY'),
    line.text(1043, '2026-11-09T15:50:01Z', 'Blue Tokai ASK'),
    line.text(1044, '2026-11-09T15:50:02Z', 'unreadable FAIL'),
    line.text(1045, '2026-11-09T15:50:03Z', 'lunch 300'),
  ])
  await runNext(runner, clock)
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'lifelog', text: 'Filed #1042.', about: 1045, channels: ['whatsapp'] },
    { type: 'text', by: 'lifelog', text: "I couldn't read #1044.", about: 1045, channels: ['whatsapp'] },
    { type: 'text', by: 'lifelog', text: 'Work or personal?', replyTo: 1043, channels: ['whatsapp'] },
    { type: 'react', by: 'lifelog', target: 1042, emoji: '✅', channels: ['whatsapp'] },
    { type: 'react', by: 'lifelog', target: 1045, emoji: '✅', channels: ['whatsapp'] },
  ])
  // A line marked failed goes straight to failed, and the agent's own message explains it: no
  // notice.
  assert.deepEqual(state().failed, [{ seq: 1044, at: '2026-11-09T15:50:38Z', reason: "can't read it" }])
  assert.deepEqual(state().retry, [])
  // The stub ran send and mark from the run's bin/, and each said what it did.
  const [reported] = sandbox.reported()
  assert.deepEqual(reported.map(({ program, code, stdout, folder }) => [program, code, stdout, folder]), [
    ['send', 0, 'send: queued; it goes to the owner once this run has passed\n', paths.agentRunBin('lifelog')],
    ['send', 0, 'send: queued; it goes to the owner once this run has passed\n', paths.agentRunBin('lifelog')],
    ['send', 0, 'send: queued; it goes to the owner once this run has passed\n', paths.agentRunBin('lifelog')],
    ['mark', 0, 'mark: 1042, 1043 and 1045 marked done\n', paths.agentRunBin('lifelog')],
    ['mark', 0, 'mark: 1044 marked failed\n', paths.agentRunBin('lifelog')],
  ])
  // What send and mark left is cleared once read.
  assert.deepEqual(fs.readdirSync(paths.agentRunSend('lifelog')), [])
  assert.equal(fs.existsSync(paths.agentRunMarks('lifelog')), false)
})

test('run: an error writing the outbox at a message, before the state, records nothing; one at the ✅, after the state, leaves the run recorded and loses only the ✅', async t => {
  const message = { type: 'text', by: 'lifelog', text: 'Filed #1042.', about: 1042, channels: ['whatsapp'] }
  // The batch, which the stub marks done, with a message for SAY; the entry handed to the outbox
  // that fails, the n-th; whether the run is recorded; and what the outbox holds afterwards.
  for (const [name, text, fails, recorded, sent] of [
    ['at the first message', 'coffee SAY', 1, false, []],
    ['at the ✅, after one message', 'coffee SAY', 2, true, [message]],
    ['at the ✅, the only entry', 'coffee 150', 1, true, []],
  ]) {
    await t.test(name, async t => {
      const { runner, clock, state, outbox, paths } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', text)])
      const before = state()
      // Handing an entry over to the outbox ends in a rename into it, which fails as a full disk or
      // a disk error would fail it.
      const rename = fs.renameSync
      let handed = 0
      t.mock.method(fs, 'renameSync', (from, to) => {
        if (path.dirname(to) === paths.outbox && ++handed === fails) throw Object.assign(new Error(`EIO: i/o error, rename '${from}' -> '${to}'`), { code: 'EIO' })
        return rename(from, to)
      })
      // It stops the runner, as any error writing the outbox does.
      await assert.rejects(runNext(runner, clock), { code: 'EIO' })
      assert.equal(handed, fails)
      assert.deepEqual(outbox(), sent)
      if (recorded) {
        assert.equal(state().cursor, 1042)
        assert.deepEqual(state().retry, [])
        assert.deepEqual(state().lastRun, { at: '2026-11-09T15:50:38Z', ok: true, seqs: [1042], durationMs: 0 })
      } else {
        assert.deepEqual(state(), before)
      }
    })
  }
})

test("run: a --reply-to a number that doesn't exist, a reaction or a line Scooter sent is sent, without a quote or quoting Scooter's own line; numbers not in the batch are ignored and logged", async t => {
  const { runner, clock, outbox, state, entries } = await openWith(t, [
    line.sent(1042, '2026-11-09T15:49:00Z', 'Logged the cab.'),
    line.reaction(1043, '2026-11-09T15:49:30Z', 1042, '👍'),
    line.text(1044, '2026-11-09T15:50:00Z', 'coffee REPLYTO=4242 REPLYTO=1043 REPLYTO=1042 UNKNOWN'),
  ])
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'lifelog', text: 'About #4242.', about: 1044, channels: ['whatsapp'] },
    { type: 'text', by: 'lifelog', text: 'About #1043.', about: 1044, channels: ['whatsapp'] },
    { type: 'text', by: 'lifelog', text: 'About #1042.', replyTo: 1042, channels: ['whatsapp'] },
    { type: 'react', by: 'lifelog', target: 1044, emoji: '✅', channels: ['whatsapp'] },
  ])
  assert.deepEqual(state().failed, [])
  assert.deepEqual(state().retry, [])
  assert.deepEqual(
    entries.filter(entry => entry.event === 'runner.marks_unknown').map(entry => [entry.count, entry.seqs]),
    [[2, [888888, 999999]]],
  )
})

// The example config with `writes` naming one file of views/, the memory folder and a folder in
// it, and a folder outside the agent's folder.
const SPLIT_WRITES = '[agents/lifelog/views/books.csv, agents/lifelog/memory/, agents/lifelog/memory/people/, shared/]'

test("run: writes naming a file, a folder in another entry and a folder outside the agent's folder: the repository keeps what is in the agent's folder, and the rest is left alone", async t => {
  const { runner, clock, add, git, paths, sandbox, state } = await openWith(t, [], { yaml: exampleYaml().replace(/writes: \[.*\]/, `writes: ${SPLIT_WRITES}`) })
  const agent = paths.agentDir('lifelog')
  const shared = path.join(paths.dataDir, 'shared')
  fs.mkdirSync(shared)
  // The folder the file is in is there for it, and nothing else of views/ is the repository's.
  assert.equal(fs.statSync(path.join(agent, 'views')).isDirectory(), true)

  add(line.text(1042, '2026-11-09T15:50:00Z', 'book ASK SHARED'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  // The stub filed its row in the one file it may, asked in memory/, and wrote outside.
  assert.equal(git('log', '-1', '--format=%s', '--name-only'), 'lifelog: #1042\n\nmemory/needs-review.md\nviews/books.csv\n')
  assert.deepEqual(sandbox.refused(), [])
  assert.equal(fs.readFileSync(path.join(shared, 'shared.txt'), 'utf8'), 'from the agent\n')
  assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  assert.deepEqual(sandbox.runs[0].spec.files.writes.map(write => [path.relative(paths.dataDir, write.path), write.folder]), [
    ['agents/lifelog/views/books.csv', false],
    ['agents/lifelog/memory', true],
    ['agents/lifelog/memory/people', true],
    ['shared', true],
    ['agents/lifelog/run/session', true],
    ['agents/lifelog/run/send', true],
    ['agents/lifelog/run/marks.txt', false],
  ])

  // A run that fails: what it changed in the agent's folder is thrown away, its file made a link
  // among it, and what it wrote outside is left as it is.
  add(line.text(1043, '2026-11-09T15:51:00Z', 'more FILELINK SHARED CRASH'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
  assert.equal(fs.lstatSync(path.join(agent, 'views', 'books.csv')).isFile(), true)
  assert.equal(fs.readFileSync(path.join(agent, 'views', 'books.csv'), 'utf8'), 'seq,text\n1042,"book ASK SHARED"\n')
  assert.equal(fs.readFileSync(path.join(shared, 'shared.txt'), 'utf8'), 'from the agent\nfrom the agent\n')
  assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  assert.equal(state().retry[0].seq, 1043)
})

test('run: a file writes names, made a link, removed, or given a second name, fails the run or is committed, and never stops the runner', async t => {
  const { runner, clock, add, git, paths, state, sandbox } = await openWith(t, [], { yaml: exampleYaml().replace(/writes: \[.*\]/, `writes: ${SPLIT_WRITES}`) })
  const books = path.join(paths.agentDir('lifelog'), 'views', 'books.csv')
  add(line.text(1042, '2026-11-09T15:50:00Z', 'first'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  const committed = fs.readFileSync(books, 'utf8')

  // A link, and a second name, fail the run, and the clean-up puts the file back.
  for (const [n, word, reason] of [
    [1043, 'FILELINK', 'unexpected file views/books.csv'],
    [1044, 'FILEHARD', 'unexpected file views/books.csv'],
  ]) {
    add(line.text(n, `2026-11-09T15:5${n - 1040}:00Z`, 'again'))
    sandbox.behave({ words: [word] })
    await clock.advance(MINUTE)
    assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' }, word)
    assert.equal(state().retry.find(entry => entry.seq === n).reason, reason, word)
    assert.equal(fs.readFileSync(books, 'utf8'), committed, word)
    assert.equal(fs.lstatSync(books).nlink, 1, word)
    assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '', word)
  }

  // Removing it is a change like any other, and is committed.
  add(line.text(1045, '2026-11-09T15:55:00Z', 'gone'))
  sandbox.behave({ words: ['FILEGONE'] })
  await clock.advance(MINUTE)
  const removed = await runNext(runner, clock)
  assert.deepEqual(removed.outcome, { ok: true, cause: null })
  assert.equal(git('show', '--stat', '--format=%s', 'HEAD').split('\n')[0], 'lifelog: #1043 #1044 #1045')
  assert.equal(fs.existsSync(books), false)
  assert.equal(git('ls-files', 'views'), '')

  // A file the run's writes name that isn't there, and isn't in the last commit, is no fault.
  sandbox.behave(null)
  add(line.text(1046, '2026-11-09T15:56:00Z', 'nothing IGNORE'))
  await clock.advance(MINUTE)
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
})

test('run: writes naming memory as a file, which a run makes, and then memory/ as a folder, never stop the runner', async t => {
  // memory as a file: what writes gives with the / of the default left out.
  const prepared = prepareTestRunner(t, {
    lines: fillerLines(1041),
    state: HANDLED,
    start: START,
    yaml: exampleYaml().replace(/writes: \[.*\]/, 'writes: [agents/lifelog/views/, agents/lifelog/memory]'),
  })
  const { runner, clock, add, git, paths, state, sandbox, entries } = await startTestRunner(t, prepared)
  const memory = path.join(paths.agentDir('lifelog'), 'memory')
  add(line.text(1042, '2026-11-09T15:50:00Z', 'remember FILEWRITE'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(fs.readFileSync(memory, 'utf8'), '1042\n')
  assert.equal(git('ls-files', 'memory'), 'memory\n')

  // The next run goes on: the runner reads nothing in memory, a file or a folder.
  add(line.text(1043, '2026-11-09T15:51:00Z', 'coffee'))
  await clock.advance(MINUTE)
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(sandbox.seen().at(-1).systemPrompt, 'You are lifelog.\n')
  assert.deepEqual(state().retry, [])
  assert.equal(state().cursor, 1043)

  // writes now names memory/ as a folder again, with memory a file in the last commit: the start
  // leaves the file out and makes the folder, the runs go on, and the next commit records it.
  runner.close()
  writeConfig(paths.configDir, { yaml: exampleYaml() })
  const restarted = await startTestRunner(t, prepared)
  assert.equal(fs.lstatSync(memory).isDirectory(), true)
  restarted.add(line.text(1044, '2026-11-09T15:52:00Z', 'tea MEMORY'))
  await clock.advance(MINUTE)
  assert.deepEqual((await runNext(restarted.runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(git('ls-files', 'memory'), 'memory/preferences.md\n')
  assert.equal(git('show', '--format=%s', '--name-status', 'HEAD'), 'lifelog: #1044\n\nD\tmemory\nA\tmemory/preferences.md\nM\tviews/notes.csv\n')
  assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  assert.equal(restarted.state().cursor, 1044)
  assert.deepEqual(entries.filter(entry => entry.level === 'error'), [])
})

test('run: a file left on the way to what writes names, after writes changed, is passed over at the start and by every run, and logged', async t => {
  const prepared = prepareTestRunner(t, {
    lines: fillerLines(1041),
    state: HANDLED,
    start: START,
    yaml: exampleYaml().replace(/writes: \[.*\]/, 'writes: [agents/lifelog/views/, agents/lifelog/notes/]'),
  })
  const { runner, clock, add, git, paths } = await startTestRunner(t, prepared)
  const notes = path.join(paths.agentDir('lifelog'), 'notes')
  // What a run of this writes may leave, and commit: a file in notes/.
  fs.writeFileSync(path.join(notes, '2026'), 'a file\n')
  add(line.text(1042, '2026-11-09T15:50:00Z', 'coffee'))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(git('ls-files', 'notes'), 'notes/2026\n')

  // writes now names a file and a folder under notes/2026, which is that file.
  runner.close()
  writeConfig(paths.configDir, { yaml: exampleYaml().replace(/writes: \[.*\]/, 'writes: [agents/lifelog/views/, agents/lifelog/notes/2026/books.csv, agents/lifelog/notes/2026/books/]') })
  const restarted = await startTestRunner(t, prepared)
  for (const [seq, text] of [[1043, 'tea'], [1044, 'cake CRASH']]) {
    restarted.add(line.text(seq, `2026-11-09T15:5${seq - 1042}:00Z`, text))
    await clock.advance(MINUTE)
    await runNext(restarted.runner, clock)
  }
  assert.equal(restarted.state().cursor, 1044)
  assert.equal(restarted.state().retry[0].seq, 1044)
  assert.equal(fs.readFileSync(path.join(notes, '2026'), 'utf8'), 'a file\n')
  // The start's clean-up, and the failed run's, each say which entries they passed over.
  assert.deepEqual(
    prepared.entries.filter(entry => entry.event === 'agent.entry_blocked').map(entry => entry.entry),
    ['notes/2026/books.csv', 'notes/2026/books', 'notes/2026/books.csv', 'notes/2026/books'],
  )
})

test('run: a link left on the way to what writes names, by a run the runner never cleaned up after, is passed over at the start and by every run, and nothing is done where it leads', async t => {
  const prepared = prepareTestRunner(t, {
    lines: fillerLines(1041),
    state: HANDLED,
    start: START,
    yaml: exampleYaml().replace(/writes: \[.*\]/, 'writes: [agents/lifelog/views/, agents/lifelog/notes/]'),
  })
  const { runner, clock, paths } = await startTestRunner(t, prepared)
  const notes = path.join(paths.agentDir('lifelog'), 'notes')
  // What a run of this writes may make in notes/, which the clean-up after the run would set
  // aside, and a runner killed while pi runs leaves, as closing it here does: a link to nothing,
  // one to a folder outside every entry, and one to the agents' folder.
  runner.close()
  const kept = path.join(paths.exchange, 'kept')
  fs.mkdirSync(kept)
  fs.writeFileSync(path.join(kept, 'a.txt'), "not the agent's\n")
  fs.symlinkSync('nowhere', path.join(notes, '2026'))
  fs.symlinkSync('../../../exchange', path.join(notes, 'shared'))
  fs.symlinkSync('../..', path.join(notes, 'up'))

  // writes now names entries behind each.
  const blocked = ['notes/2026/q1/books.csv', 'notes/2026/books', 'notes/shared/kept', 'notes/up/made']
  writeConfig(paths.configDir, { yaml: exampleYaml().replace(/writes: \[.*\]/, 'writes: [agents/lifelog/views/, agents/lifelog/notes/2026/q1/books.csv, agents/lifelog/notes/2026/books/, agents/lifelog/notes/shared/kept/, agents/lifelog/notes/up/made/]') })
  const restarted = await startTestRunner(t, prepared)
  const outcomes = []
  for (const [seq, text] of [[1042, 'tea'], [1043, 'cake CRASH']]) {
    restarted.add(line.text(seq, `2026-11-09T15:5${seq - 1040}:00Z`, text))
    await clock.advance(MINUTE)
    outcomes.push((await runNext(restarted.runner, clock)).outcome)
  }
  // The run that passed committed what it wrote in views/; the one that failed counted an attempt.
  assert.deepEqual(outcomes, [{ ok: true, cause: null }, { ok: false, cause: 'other' }])
  assert.equal(restarted.git('log', '-1', '--format=%s'), 'lifelog: #1042\n')
  assert.equal(restarted.state().cursor, 1043)
  assert.equal(restarted.state().retry[0].seq, 1043)
  // Where the links lead, nothing was set aside, removed or made, and the links are as they were.
  assert.deepEqual(fs.readdirSync(kept), ['a.txt'])
  assert.equal(fs.readFileSync(path.join(kept, 'a.txt'), 'utf8'), "not the agent's\n")
  assert.equal(fs.existsSync(path.join(paths.agents, 'made')), false)
  assert.deepEqual(fs.readdirSync(notes).sort(), ['2026', 'shared', 'up'])
  // The start's clean-up, and the failed run's, each say which entries they passed over.
  assert.deepEqual(prepared.entries.filter(entry => entry.event === 'agent.entry_blocked').map(entry => entry.entry), [...blocked, ...blocked])
  assert.deepEqual(prepared.entries.filter(entry => entry.level === 'error'), [])
})

test('run: confirm mode sends the text and no reactions; sends: [] sends nothing', async t => {
  const confirm = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY')], { yaml: exampleYaml().replace('reply_mode: quiet', 'reply_mode: confirm') })
  await runNext(confirm.runner, confirm.clock)
  assert.deepEqual(confirm.outbox(), [{ type: 'text', by: 'lifelog', text: 'Filed #1042.', about: 1042, channels: ['whatsapp'] }])
  assert.match(confirm.sandbox.runs[0].spec.argv.at(-1), /Reply mode: confirm\./)

  const silent = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY'), line.text(1043, '2026-11-09T15:50:01Z', 'tea ASK')], {
    yaml: exampleYaml().replace('sends: [whatsapp]', 'sends: []'),
  })
  await runNext(silent.runner, silent.clock)
  assert.deepEqual(silent.outbox(), [])
  assert.equal(silent.state().cursor, 1043)
  assert.equal(silent.views('notes.csv').split('\n').length, 4)
})

test('run: an item not marked is tried again a minute later, as a retry, and given up on after 4 attempts', async t => {
  const { runner, clock, outbox, state, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 120 IGNORE')])
  await runNext(runner, clock)
  assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'not marked' }])
  assert.deepEqual(outbox(), [])

  // Not before it is due.
  await clock.advance(MINUTE - SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  for (const attempt of [2, 3, 4]) {
    await clock.advance(SECOND)
    assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
    assert.match(sandbox.runs.at(-1).spec.argv.at(-1), new RegExp(`^New: none\\nGiven before: 1042 \\(attempt ${attempt} of 4\\)$`, 'm'))
    if (attempt < 4) await clock.advance(MINUTE - SECOND)
  }
  assert.deepEqual(state().retry, [])
  assert.deepEqual(state().failed, [{ seq: 1042, at: '2026-11-09T15:53:38Z', reason: 'not handled after 4 attempts' }])
  assert.deepEqual(outbox(), [{ type: 'text', by: 'runner', text: '⚠️ I gave up on #1042 ("coffee 120 IGNORE") after 4 attempts. Send it again if it matters.' }])
  assert.equal(sandbox.runs.length, 4)
})

test('run: an edit of a failed message brings it back into the batch, and it leaves failed', async t => {
  const { runner, clock, state, add, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'blurry')])
  sandbox.behave({ words: ['FAIL'] })
  await runNext(runner, clock)
  assert.deepEqual(state().failed.map(entry => entry.seq), [1042])
  sandbox.behave(null)
  add(line.edit(1043, '2026-11-09T15:51:00Z', 1042, 'coffee 150'))
  await runNext(runner, clock)
  assert.deepEqual(state().lastRun.seqs, [1042, 1043])
  assert.match(sandbox.runs.at(-1).spec.argv.at(-1), /^New: 1043\nGiven before: 1042 \(attempt 1 of 4\)$/m)
  assert.deepEqual(state().failed, [])
  assert.deepEqual(state().retry, [])
})

test('run: a message deleted before it was given is never given, and its deletion is; one deleted while it waits leaves retry with the batch that gives its deletion', async t => {
  const { runner, clock, state, add, sandbox, outbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 120'), line.delete(1043, '2026-11-09T15:50:01Z', 1042)])
  await runNext(runner, clock)
  assert.deepEqual(state().lastRun.seqs, [1043])
  assert.match(sandbox.runs.at(-1).spec.argv.at(-1), /^New: 1043\nGiven before: none$/m)
  assert.deepEqual([state().cursor, state().retry, state().failed], [1043, [], []])
  // No ✅ for a deletion, nor for the message it deleted.
  assert.deepEqual(outbox(), [])

  // #1044 isn't marked, and waits; deleted meanwhile, it is no more given, and its deletion's batch
  // settles it.
  add(line.text(1044, '2026-11-09T15:51:00Z', 'lunch IGNORE'))
  await runNext(runner, clock)
  assert.deepEqual(state().retry.map(entry => entry.seq), [1044])
  add(line.delete(1045, '2026-11-09T15:51:30Z', 1044))
  await runNext(runner, clock)
  assert.deepEqual(state().lastRun.seqs, [1045])
  assert.deepEqual([state().retry, state().failed], [[], []])
  await clock.advance(5 * MINUTE)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
})

// ---------------------------------------------------------------------------------------------
// What a run leaves in run/ for the runner: it never stops the runner

test('run: nothing a run leaves in run/send/ or as run/marks.txt, in place of what send and mark write, stops the runner, and the next run runs', async t => {
  const notMarked = { seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'not marked' }
  const react = { type: 'react', by: 'lifelog', target: 1042, emoji: '✅', channels: ['whatsapp'] }
  const text = (words, extra = { about: 1042 }) => ({ type: 'text', by: 'lifelog', text: words, ...extra, channels: ['whatsapp'] })
  // What each leaves, and what comes of it: the line's retry, if any, what goes out, and the log.
  for (const [what, { retry = [], sends = [react], logged = {}, skip = false }] of [
    // The marks file as anything but the file mark writes: refused whole, so the line is given
    // again, with its attempt counted, and gets no ✅.
    ['MARKSLINK', { retry: [notMarked], sends: [], logged: { 'runner.marks_refused': 'EUNTRUSTED' } }],
    ['MARKSFIFO', { retry: [notMarked], sends: [], logged: { 'runner.marks_refused': 'EUNTRUSTED' } }],
    ['MARKSDIR', { retry: [notMarked], sends: [], logged: { 'runner.marks_refused': 'EUNTRUSTED' } }],
    ['MARKSHARD', { retry: [notMarked], sends: [], logged: { 'runner.marks_refused': 'EUNTRUSTED' } }],
    ['MARKSBIG', { retry: [notMarked], sends: [], logged: { 'runner.marks_refused': 'EFBIG' } }],
    ['MARKSLOCKED', { retry: [notMarked], sends: [], logged: { 'runner.marks_refused': 'EACCES' }, skip: skipIfRoot }],
    // Lines mark doesn't write, beside its own: passed over and counted, and its own counts.
    ['MARKSODD', { logged: { 'runner.marks_unreadable': 11 } }],
    // An entry as anything but what send writes: refused, and nothing of it goes out.
    ['SENDLINK', { logged: { 'runner.sends_dropped': { refused: 1 } } }],
    ['SENDFIFO', { logged: { 'runner.sends_dropped': { refused: 1 } } }],
    ['SENDDIR', { logged: { 'runner.sends_dropped': { refused: 1 } } }],
    ['SENDHARD', { logged: { 'runner.sends_dropped': { refused: 1 } } }],
    ['SENDBIG', { logged: { 'runner.sends_dropped': { refused: 1 } } }],
    ['SENDLOCKED', { logged: { 'runner.sends_dropped': { refused: 1 } }, skip: skipIfRoot }],
    ['SENDODD', { logged: { 'runner.sends_dropped': { refused: 15 } } }],
    ['SENDDEEP', { logged: { 'runner.sends_dropped': { refused: 1 } } }],
    // Entries send could write: a text of nearly a megabyte, cut where every text is; U+0000 and
    // half a surrogate pair, made something a channel can send; and a thousand, the first 25 sent.
    ['SENDLONG', { sends: 'long' }],
    ['SENDNUL', { sends: [text('a\ufffdb\ufffdc'), react] }],
    ['SENDMANY', { sends: 'many', logged: { 'runner.sends_dropped': { past: 975 } } }],
  ]) {
    await t.test(what, { skip }, async t => {
      const { runner, clock, state, outbox, sandbox, paths, add, entries, git } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
      sandbox.behave({ runLeaves: what })
      assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
      assert.deepEqual(state().retry, retry)
      assert.equal(state().cursor, 1042)
      assert.equal(git('log', '-1', '--format=%s'), 'lifelog: #1042\n')
      const sent = outbox({ take: true })
      if (sends === 'long') {
        assert.equal(sent.length, 2)
        assert.ok([...sent[0].text].length <= 14000)
        assert.match(sent[0].text, /^long long .*\[The rest of this message was too long to send\.\]$/s)
        assert.deepEqual(sent[1], react)
      } else if (sends === 'many') {
        assert.deepEqual(sent, [...Array.from({ length: 25 }, (_, n) => text(`Message ${n + 1}.`)), react])
      } else {
        assert.deepEqual(sent, sends)
      }
      for (const [event, fields] of Object.entries(logged)) {
        const found = entries.filter(entry => entry.event === event)
        assert.equal(found.length, 1, event)
        if (typeof fields === 'object') for (const [name, value] of Object.entries(fields)) assert.equal(found[0][name], value, `${event} ${name}`)
        else assert.equal(event === 'runner.marks_refused' ? found[0].error : found[0].lines, fields, event)
      }
      // Cleared before the run was recorded, whatever it was; nothing was left that couldn't be.
      assert.deepEqual(fs.readdirSync(paths.agentRunSend('lifelog')), [])
      assert.equal(fs.existsSync(paths.agentRunMarks('lifelog')), false)
      assert.deepEqual(fs.readdirSync(paths.agentRunSession('lifelog')), [])
      assert.deepEqual(entries.filter(entry => entry.event === 'runner.run_left' || entry.level === 'error'), [])

      // The next run runs, and marks as it should.
      sandbox.behave(null)
      add(line.text(1043, '2026-11-09T15:51:00Z', 'tea'))
      await clock.advance(MINUTE)
      assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
      assert.deepEqual(state().retry, [])
      assert.equal(state().cursor, 1043)
    })
  }
})

test('run: on a disk pi filled through run/send/, a run that passed frees it before it keeps the session, or writes the outbox or the state', async t => {
  const { runner, clock, paths, state, outbox, events, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY')])
  // pi leaves fill.bin in run/send/ beside the message it queued, and exits with 0. Until it is
  // gone, nothing can be made: not the session's copy, the outbox entries, or the state.
  sandbox.behave({ runLeaves: 'FILLSEND' })
  t.after(actFull(() => holds([paths.agentRunSend('lifelog')], 'fill.bin')))
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'lifelog', text: 'Filed #1042.', about: 1042, channels: ['whatsapp'] },
    { type: 'react', by: 'lifelog', target: 1042, emoji: '✅', channels: ['whatsapp'] },
  ])
  assert.deepEqual(state().retry, [])
  assert.equal(state().cursor, 1042)
  assert.ok(fs.existsSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-09.jsonl')))
  assert.deepEqual(fs.readdirSync(paths.agentRunSend('lifelog')), [])
  assert.deepEqual(events().filter(event => event === 'runner.session_refused' || event.endsWith('_left')), [])
})

test('run: a run that marks and sends, then fails, crashed or timed out, sends nothing and settles nothing, and each line it was given has used an attempt', async t => {
  for (const [how, behavior, reason] of [
    ['crashed', { late: true, crash: 3 }, 'pi exited with code 3'],
    ['timed out', { late: true, hang: true }, 'timed out'],
  ]) {
    await t.test(how, async t => {
      const { runner, clock, state, outbox, sandbox, paths, git } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY'), line.text(1043, '2026-11-09T15:50:01Z', 'lunch ASK')])
      sandbox.behave(behavior)
      await runner.tick()
      await clock.advance(8 * SECOND)
      const ticking = runner.tick()
      if (behavior.hang) {
        await sandbox.whenHung()
        await clock.advance(10 * MINUTE)
      }
      assert.deepEqual((await ticking).outcome, { ok: false, cause: 'other' })
      // It did mark and send: the stub's programs said so.
      assert.deepEqual(sandbox.reported()[0].map(({ program, code }) => [program, code]), [['send', 0], ['send', 0], ['mark', 0]])
      // Nothing of it was read: no message, no ✅, both lines given again at their second attempt.
      assert.deepEqual(outbox(), [{ type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (${reason}). I'll try again.` }])
      assert.deepEqual(state().retry.map(entry => [entry.seq, entry.attempts, entry.reason]), [[1042, 1, reason], [1043, 1, reason]])
      assert.deepEqual(state().failed, [])
      assert.equal(git('rev-list', '--count', 'HEAD'), '1\n')
      assert.deepEqual(fs.readdirSync(paths.agentRunSend('lifelog')), [])
      assert.equal(fs.existsSync(paths.agentRunMarks('lifelog')), false)
    })
  }
})

test('run: a scheduled run sends what send queued to DEFAULT_CHANNEL, and its marks are ignored and logged', async t => {
  const { runner, clock, state, outbox, entries, sandbox } = await openWith(t, [], { start: '2026-11-09T15:59:50Z', state: { ...HANDLED, scheduled: { '21:30': '2026-11-08' } } })
  // The stub marks two numbers as well as sending the task's message.
  sandbox.behave({ words: ['UNKNOWN'] })
  await clock.advance(MINUTE)
  const { action, outcome } = await runner.tick()
  assert.equal(action.kind, 'scheduled')
  assert.deepEqual(outcome, { ok: true, cause: null })
  // No `about`: Scooter says it on its own, so it goes to DEFAULT_CHANNEL.
  assert.deepEqual(outbox(), [{ type: 'text', by: 'lifelog', text: 'Today: nothing missing.', channels: ['whatsapp'] }])
  assert.deepEqual(state().scheduled, { '21:30': '2026-11-09' })
  assert.deepEqual(state().retry, [])
  assert.deepEqual(state().failed, [])
  assert.deepEqual(
    entries.filter(entry => entry.event === 'runner.marks_unknown').map(entry => [entry.count, entry.seqs]),
    [[2, [888888, 999999]]],
  )
})
