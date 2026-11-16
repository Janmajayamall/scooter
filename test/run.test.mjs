// One run, from the lock to the state (6.6 to 6.8 of DESIGN.md; section 10, "Runner"), through the
// fake sandbox and the pi stub: what pi is given, what it leaves, what is committed and sent, and
// what the state says afterwards.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { readLock } from '../src/common/locks.mjs'
import { skipIfRoot } from './support/root.mjs'
import { exampleYaml, fillerLines, line } from './support/runner.mjs'
import { KEY, MINUTE, SECOND, openTestRunner } from './support/test-runner.mjs'

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
const START = '2026-11-09T15:50:30Z'

test('run: the pi stub takes a message from the datastore to a committed view and a correct state.json', async t => {
  const { runner, clock, state, outbox, git, views, paths, sandbox } = await openTestRunner(t, {
    lines: [...fillerLines(1041), line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')],
    state: { cursor: 1041, commandSeq: 0, retry: [], failed: [], session: null, onceDone: [], backfillDone: [], scheduled: {}, lastRun: null },
    start: START,
  })

  // The owner has just written: the runner waits for them to be quiet.
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND)
  const { action, outcome } = await runner.tick()
  assert.deepEqual(action, { kind: 'messages' })
  assert.deepEqual(outcome, { ok: true, cause: null })

  // The view, committed by Scooter with the batch's numbers.
  assert.equal(views('notes.csv'), 'seq,text\n1042,"#1042 21:20 text: \\"coffee 150\\""\n')
  assert.equal(git('log', '-1', '--format=%an <%ae>%n%s'), 'Scooter <scooter@localhost>\nlifelog: #1042\n')
  assert.equal(git('status', '--porcelain'), '')

  // The ✅ reaction, in quiet mode, and the state.
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 1042, emoji: '✅' }])
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
const HANDLED = { cursor: 1041, commandSeq: 0, retry: [], failed: [], session: null, onceDone: [], backfillDone: [], scheduled: {}, lastRun: null }

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

test('run: the sandbox gets pi\'s command, the mounts of 6.6 with sessions/ hidden, its environment and the network policy', async t => {
  const { runner, clock, sandbox, paths } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150')])
  fs.writeFileSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-08.jsonl'), '{"type":"session"}\n')
  await runNext(runner, clock)
  const [{ spec, env }] = sandbox.runs
  const agent = paths.agentDir('lifelog')
  const run = path.join(agent, 'run')

  assert.equal(spec.cwd, agent)
  assert.equal(spec.timeoutMs, 10 * MINUTE)
  assert.deepEqual(spec.mounts, [
    { path: agent, writable: false, hide: ['sessions'] },
    { path: path.join(agent, 'views'), writable: true, hide: [] },
    { path: path.join(agent, 'memory'), writable: true, hide: [] },
    { path: path.join(run, 'session'), writable: true, hide: [] },
    { path: paths.datastore, writable: false, hide: [] },
  ])
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
    path.join(run, 'system.md'),
    ...['expenses', 'runs', 'meals', 'travel', 'people', 'day-pages'].flatMap(skill => ['--skill', path.join(run, 'config', 'skills', skill)]),
    '--',
  ])
  assert.match(spec.argv.at(-1), /^\[scooter\] Now: Monday 9 November 2026, 21:20 \(Asia\/Kolkata\)\. Home currency: INR\. Reply mode: quiet\. Internet: off\.\n/)

  // The environment of 6.6 and nothing else, with a placeholder where the key would be.
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'OPENROUTER_API_KEY', 'PATH', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'TZ'])
  assert.deepEqual({ ...env, OPENROUTER_API_KEY: undefined }, {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/root',
    LANG: 'C.UTF-8',
    TZ: 'Asia/Kolkata',
    PI_SKIP_VERSION_CHECK: '1',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    OPENROUTER_API_KEY: undefined,
  })
  assert.match(env.OPENROUTER_API_KEY, /^placeholder-/)
  assert.ok(!JSON.stringify([spec.argv, spec.env, env]).includes(KEY))

  // The policy: the configured model, internet off, ZDR on, and the key only for OpenRouter.
  assert.deepEqual(spec.policy, { model: 'anthropic/claude-sonnet-5.5', internet: false, zdr: true, secrets: { OPENROUTER_API_KEY: { hosts: ['openrouter.ai'], value: KEY } } })

  // What pi found: no sessions/, the current session's folder empty, the system prompt and every
  // skill readable, and the same environment.
  const [seen] = sandbox.seen()
  assert.equal(seen.sessionsVisible, false)
  assert.deepEqual(seen.sessionFiles, [])
  assert.match(seen.systemPrompt, /^# How you work with Scooter\n/)
  assert.deepEqual(seen.skills, [true, true, true, true, true, true])
  assert.equal(seen.cwd, agent)
  assert.deepEqual(seen.env, env)
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

test('run: a /new among the messages starts the session the batch goes into', async t => {
  const { runner, clock, sandbox, outbox } = await openWith(t, [line.command(1042, '2026-11-09T15:50:00Z', '/new'), line.text(1043, '2026-11-09T15:50:01Z', 'start again')])
  assert.equal((await runner.tick()).action.kind, 'commands')
  await runNext(runner, clock)
  assert.equal(sandbox.runs[0].spec.argv[sandbox.runs[0].spec.argv.indexOf('--session-id') + 1], 'lifelog-2026-11-09-1')
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'runner', text: 'Started a fresh conversation.', about: 1042 },
    { type: 'react', by: 'lifelog', target: 1043, emoji: '✅' },
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
      assert.deepEqual(fs.readdirSync(paths.agentViews('lifelog')), [], keyword)
      assert.deepEqual(fs.readdirSync(paths.agentMemory('lifelog')), [], keyword)
      assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '', keyword)
      assert.equal(git('rev-list', '--count', 'HEAD'), '1\n', keyword)
      assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [], keyword)
      assert.deepEqual(outbox(), [{ type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (unexpected file ${file}). I'll try again.` }], keyword)
      assert.equal(sandbox.runs.length, 1)
    })
  }
})

test('run: a file or a folder the runner can\'t read, a name git refuses, or a file past the size limit, fails the run; the clean-up removes it, and the next try runs', async t => {
  for (const [leave, file, skip] of [
    ['LOCKEDFILE', 'views/locked.csv', skipIfRoot],
    ['LOCKEDDIR', 'memory/locked', skipIfRoot],
    ['GITNAME', 'views/git~1', false],
    // A file of holes, a byte over AGENT_FILES_MAX_BYTES: found before git reads it.
    ['BIGFILE', 'views/big.csv', false],
  ]) {
    await t.test(leave, { skip }, async t => {
      const { runner, clock, paths, state, outbox, git, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 MEMORY')])
      sandbox.behave({ leave })
      assert.deepEqual((await runNext(runner, clock)).outcome, { ok: false, cause: 'other' })
      assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: `unexpected file ${file}` }])
      // Everything the run wrote is gone, and nothing is staged; the session isn't kept.
      assert.deepEqual(fs.readdirSync(paths.agentViews('lifelog')), [])
      assert.deepEqual(fs.readdirSync(paths.agentMemory('lifelog')), [])
      assert.equal(git('status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
      assert.equal(git('rev-list', '--count', 'HEAD'), '1\n')
      assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
      assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: `⚠️ I couldn't process your last messages (unexpected file ${file}). I'll try again.` }])

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

test('run: empty folders don\'t fail the run, and are removed, so views and memory hold nothing the commit doesn\'t', async t => {
  const { runner, clock, paths, state, git, outbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 EMPTYDIRS')])
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.deepEqual(state().retry, [])
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 1042, emoji: '✅' }])
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

test('run: a folder the runner can\'t read in run/session/ is passed over, a session file it can\'t read isn\'t kept, and the next runs start', { skip: skipIfRoot }, async t => {
  const { runner, clock, paths, state, add, sandbox, events } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee RUNLOCKED')])
  const kept = path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-09.jsonl')
  // Anything but the session in run/session/ is ignored (6.6).
  assert.deepEqual((await runNext(runner, clock)).outcome, { ok: true, cause: null })
  assert.equal(fs.readFileSync(kept, 'utf8').split('\n').length, 3)

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

test('run: the commit holds views and memory, with the batch\'s numbers, and a run that changes nothing commits nothing', async t => {
  const { runner, clock, git, add } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 150 MEMORY'), line.text(1043, '2026-11-09T15:50:01Z', 'lunch ASK')])
  await runNext(runner, clock)
  assert.equal(git('log', '-1', '--format=%s'), 'lifelog: #1042 #1043\n')
  assert.equal(git('show', '--name-only', '--format=', 'HEAD'), 'memory/needs-review.md\nmemory/preferences.md\nviews/notes.csv\n')

  add(line.text(1044, '2026-11-09T15:51:00Z', 'nothing to file IGNORE'))
  await runNext(runner, clock)
  assert.equal(git('rev-list', '--count', 'HEAD'), '2\n')
})

test('run: replies, quoted or about the newest item, and a ✅ for the rest of what was done', async t => {
  const { runner, clock, outbox, state } = await openWith(t, [
    line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY'),
    line.text(1043, '2026-11-09T15:50:01Z', 'Blue Tokai ASK'),
    line.text(1044, '2026-11-09T15:50:02Z', 'unreadable FAIL'),
    line.text(1045, '2026-11-09T15:50:03Z', 'lunch 300'),
  ])
  await runNext(runner, clock)
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'lifelog', text: 'Filed #1042.\nI couldn\'t read #1044.', about: 1045 },
    { type: 'text', by: 'lifelog', text: 'Work or personal?', replyTo: 1043 },
    { type: 'react', by: 'lifelog', target: 1042, emoji: '✅' },
    { type: 'react', by: 'lifelog', target: 1045, emoji: '✅' },
  ])
  // FAILED goes straight to failed, and the agent's own text explains it: no notice.
  assert.deepEqual(state().failed, [{ seq: 1044, at: '2026-11-09T15:50:38Z', reason: "can't read it" }])
  assert.deepEqual(state().retry, [])
})

test('run: a REPLY_TO a number that doesn\'t exist is sent without a quote, and numbers not in the batch are ignored and logged', async t => {
  const { runner, clock, outbox, state, entries } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee REPLYTO=4242 UNKNOWN')])
  await runNext(runner, clock)
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'lifelog', text: 'About #4242.', about: 1042 },
    { type: 'react', by: 'lifelog', target: 1042, emoji: '✅' },
  ])
  assert.deepEqual(state().failed, [])
  assert.deepEqual(
    entries.filter(entry => entry.event === 'runner.answer_unknown').map(entry => entry.seqs),
    [[888888, 999999]],
  )
})

test('run: confirm mode sends the text and no reactions; can_message: false sends nothing', async t => {
  const confirm = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY')], { yaml: exampleYaml().replace('reply_mode: quiet', 'reply_mode: confirm') })
  await runNext(confirm.runner, confirm.clock)
  assert.deepEqual(confirm.outbox(), [{ type: 'text', by: 'lifelog', text: 'Filed #1042.', about: 1042 }])
  assert.match(confirm.sandbox.runs[0].spec.argv.at(-1), /Reply mode: confirm\./)

  const silent = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee SAY'), line.text(1043, '2026-11-09T15:50:01Z', 'tea ASK')], {
    yaml: exampleYaml().replace('can_message: true', 'can_message: false'),
  })
  await runNext(silent.runner, silent.clock)
  assert.deepEqual(silent.outbox(), [])
  assert.equal(silent.state().cursor, 1043)
  assert.equal(silent.views('notes.csv').split('\n').length, 4)
})

test('run: an item not reported is tried again a minute later, as a retry, and given up on after 4 attempts', async t => {
  const { runner, clock, outbox, state, sandbox } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'coffee 120 IGNORE')])
  await runNext(runner, clock)
  assert.deepEqual(state().retry, [{ seq: 1042, attempts: 1, due: '2026-11-09T15:51:38Z', reason: 'not reported' }])
  assert.deepEqual(outbox(), [])

  // Not before it is due.
  await clock.advance(MINUTE - SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  for (const attempt of [2, 3, 4]) {
    await clock.advance(SECOND)
    assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
    assert.match(sandbox.runs.at(-1).spec.argv.at(-1), new RegExp(`Retrying \\(not handled yet\\):\\n#1042 21:20 text: "coffee 120 IGNORE" \\(attempt ${attempt} of 4\\)`))
    if (attempt < 4) await clock.advance(MINUTE - SECOND)
  }
  assert.deepEqual(state().retry, [])
  assert.deepEqual(state().failed, [{ seq: 1042, at: '2026-11-09T15:53:38Z', reason: 'not handled after 4 attempts' }])
  assert.deepEqual(outbox(), [{ type: 'text', by: 'runner', text: '⚠️ I gave up on #1042 ("coffee 120 IGNORE") after 4 attempts. Send it again if it matters.' }])
  assert.equal(sandbox.runs.length, 4)
})

test('run: an edit of a failed message brings it back into the batch, and it leaves failed', async t => {
  const { runner, clock, state, add } = await openWith(t, [line.text(1042, '2026-11-09T15:50:00Z', 'blurry FAIL')])
  await runNext(runner, clock)
  assert.deepEqual(state().failed.map(entry => entry.seq), [1042])
  add(line.edit(1043, '2026-11-09T15:51:00Z', 1042, 'coffee 150'))
  await runNext(runner, clock)
  assert.deepEqual(state().lastRun.seqs, [1042, 1043])
  assert.deepEqual(state().failed, [])
  assert.deepEqual(state().retry, [])
})
