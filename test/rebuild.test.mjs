// Rebuilding an agent's views, with the fake sandbox: a
// rebuild stops at the `seq` that was newest when it started, so later messages get normal
// replies; `Now:` is each batch's own time, and batches don't cross the owner's days; the state it
// leaves; that nothing else of the runner's runs beside it; and its failures, pauses and stops.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { lockExists, readLock, releaseLock, takeLock } from '../src/common/locks.mjs'
import { openRunner } from '../src/runner/main.mjs'
import { RebuildError, rebuildAgent, rebuildTag, runRebuild } from '../src/runner/rebuild.mjs'
import { line, writeDatastore } from './support/runner.mjs'
import { MINUTE, SECOND, gitOf, outboxOf, prepareTestRunner, startTestRunner } from './support/test-runner.mjs'

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
const START = '2026-11-09T15:50:30Z'
const TAG = 'before-rebuild-20261109T155030Z'

function rebuildYaml() {
  return `agents:
  lifelog:
    model: anthropic/claude-sonnet-5.5
    prompt: prompts/lifelog.md
    skills: [skills/expenses, skills/runs, skills/people]
    writes: [agents/lifelog/views/, agents/lifelog/memory/]
    sends: [whatsapp]
    session: daily
    reply_mode: quiet
    ack_reaction: "✅"
    timeout_minutes: 10
    run:
      - on: new-messages
        channels: [whatsapp, email]
      - backfill: people-1
        skill: people
        writes: [agents/lifelog/views/people.csv]
      - backfill: runs-1
        skill: runs
        writes: [agents/lifelog/views/runs.csv]
`
}

// Two of the owner's days in Kolkata, which live runs handled before the rebuild.
const HISTORY = [
  line.text(1, '2026-11-07T16:00:00Z', 'ran 5k'), // Sat 7 Nov, 21:30
  line.sent(2, '2026-11-07T16:01:00Z', 'Logged.'),
  line.sent(3, '2026-11-07T16:05:00Z', 'Noted.'),
  line.text(4, '2026-11-08T04:00:00Z', 'start tracking coffee MEMORY'), // Sun 8 Nov, 09:30
  line.reaction(5, '2026-11-08T04:01:00Z', 4, '👍'),
  line.text(6, '2026-11-08T05:00:00Z', 'coffee 120'), // Sun 8 Nov, 10:30
]
const HANDLED = { cursor: 6, retry: [], failed: [], backfillDone: [], scheduled: {}, lastRun: { at: '2026-11-08T05:00:30Z', ok: true, seqs: [6], durationMs: 1000 } }

function commitByHand(paths, message) {
  gitOf(paths, 'add', '-A', '--', 'views', 'memory')
  gitOf(paths, '-c', 'user.name=Scooter', '-c', 'user.email=scooter@localhost', 'commit', '--quiet', '-m', message)
}

// The test's folders, with an agent folder as live runs left it: a view and a rule committed, a
// session, and the backfill people-1 under way, which the runner's start began.
async function prepare(t, { lines = HISTORY, state = HANDLED } = {}) {
  const prepared = prepareTestRunner(t, { yaml: rebuildYaml(), lines, state, start: START })
  const { runner } = await startTestRunner(t, prepared)
  await runner.close()
  const { paths } = prepared
  fs.writeFileSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), 'old.csv'), 'seq,text\n1,ran 5k\n')
  fs.writeFileSync(path.join(paths.agentMemory('lifelog'), 'preferences.md'), '- 2026-11-01 (#0): an old rule.\n')
  commitByHand(paths, 'lifelog: #1 #4 #6')
  fs.writeFileSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-08.jsonl'), '{"type":"session"}\n')
  return prepared
}

// Starts a rebuild of the test's folders. Returns its promise, and what it said.
function startRebuild(prepared, options = {}) {
  const said = []
  const { settings, sandbox, clock, log, proc } = prepared
  const done = rebuildAgent({ settings, agentName: 'lifelog', openSandbox: async () => sandbox, clock, log, proc, say: text => said.push(text), ...options })
  return { done, said }
}

// Waits for a rebuild to end, moving the fake clock on whenever it waits for a retry or a pause,
// and taking a backup's lock away when it waits for that, after `onBackup()` has looked at what
// the rebuild has done by then.
async function drive(prepared, done, { onBackup = () => {} } = {}) {
  const { clock, entries, paths } = prepared
  let settled = false
  done.then(
    () => (settled = true),
    () => (settled = true),
  )
  let handled = 0
  while (!settled) {
    await new Promise(resolve => setImmediate(resolve))
    const waits = entries.filter(entry => entry.event === 'rebuild.waiting')
    if (waits.length === handled) continue
    const wait = waits[handled++]
    if (wait.for === 'backup') {
      await onBackup()
      releaseLock(paths.backupLock)
    }
    await clock.advance(wait.ms)
  }
  return done
}

// Has the sandbox call `before(count)` ahead of each run, counting from 1.
function beforeEachRun(sandbox, before) {
  const run = sandbox.run.bind(sandbox)
  let count = 0
  sandbox.run = async (spec, options) => {
    await before(++count)
    return run(spec, options)
  }
}

const state = paths => JSON.parse(fs.readFileSync(paths.agentState('lifelog'), 'utf8'))

test("rebuild: it stops at the seq that was newest when it started, so later messages get normal replies; Now: is each batch's own time, and batches don't cross the owner's days", async t => {
  const prepared = await prepare(t)
  const { paths, sandbox } = prepared
  assert.equal(state(paths).backfill.id, 'people-1')
  const before = gitOf(paths, 'rev-parse', 'HEAD').trim()
  // The owner writes while the rebuild runs: the bridge stores it.
  beforeEachRun(sandbox, count => {
    if (count === 1) writeDatastore(paths, [line.text(7, '2026-11-09T15:51:00Z', 'tea ASK')])
  })

  const { done, said } = startRebuild(prepared)
  const result = await drive(prepared, done)
  assert.deepEqual(result, { stopped: false, tag: TAG, until: 6, cursor: 6, batches: 2, failed: [] })

  // One batch for each of the owner's days, each with its own time and session, and nothing after
  // #6. The old rule is gone: rules are learned again as they come.
  const seen = sandbox.seen()
  assert.deepEqual(
    seen.map(call => call.items),
    [[1], [4, 6]],
  )
  assert.deepEqual(
    seen.map(call => call.prompt.split('\n')[0]),
    [
      '[scooter] Now: Saturday 7 November 2026, 21:30 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.',
      '[scooter] Now: Sunday 8 November 2026, 10:30 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.',
    ],
  )
  assert.deepEqual(
    seen.map(call => call.argv[call.argv.indexOf('--session-id') + 1]),
    ['lifelog-rebuild-2026-11-07', 'lifelog-rebuild-2026-11-08'],
  )
  assert.ok(seen.every(call => !call.prompt.includes('#7')))
  assert.match(seen[0].systemPrompt, /## memory\/preferences\.md\n\n\(empty\)/)
  // Every skill.
  assert.equal(seen[0].skills.length, 3)

  // The views and memory, rebuilt, in one commit on the tagged one.
  assert.equal(gitOf(paths, 'rev-parse', TAG).trim(), before)
  assert.equal(gitOf(paths, 'log', '-2', '--format=%s'), 'lifelog: rebuild\nlifelog: #1 #4 #6\n')
  assert.equal(gitOf(paths, 'rev-parse', 'HEAD^').trim(), before)
  assert.equal(gitOf(paths, 'status', '--porcelain'), '')
  assert.deepEqual(fs.readdirSync(path.join(paths.agentDir('lifelog'), 'views')), ['notes.csv'])
  assert.equal(
    fs.readFileSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), 'notes.csv'), 'utf8'),
    'seq,text\n1,"#1 21:30 text: \\"ran 5k\\""\n4,"#4 09:30 text: \\"start tracking coffee MEMORY\\""\n6,"#6 10:30 text: \\"coffee 120\\""\n',
  )
  assert.equal(fs.readFileSync(path.join(paths.agentMemory('lifelog'), 'preferences.md'), 'utf8'), '- 2026-11-09 (#1): Track coffee.\n')
  // Its sessions served it alone, and the old one is gone.
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])

  // The state: `cursor` at #6, and every backfill done.
  assert.deepEqual(state(paths), {
    cursor: 6,
    retry: [],
    failed: [],
    backfillDone: ['people-1', 'runs-1'],
    scheduled: {},
    lastRun: null,
  })
  // Silent, and it lets go of the locks.
  assert.deepEqual(outboxOf(paths), [])
  assert.equal(lockExists(paths.runLock), false)
  assert.deepEqual(said, [
    `Rebuilding lifelog from the datastore, up to #6. The last commit before the rebuild is tagged ${TAG}.`,
    '2026-11-07 #1: done.',
    '2026-11-08 #4-#6: done.',
    'Rebuilt lifelog up to #6, in 2 batches, committed as "lifelog: rebuild".',
  ])

  // The runner, started again, answers #7, which came after, with a reply.
  const { runner, clock, outbox } = await startTestRunner(t, prepared)
  await runner.tick()
  await clock.advance(8 * SECOND)
  assert.deepEqual(await runner.tick(), { action: { kind: 'messages' }, outcome: { ok: true, cause: null } })
  assert.deepEqual(sandbox.seen()[2].items, [7])
  assert.deepEqual(outbox(), [{ type: 'text', by: 'lifelog', text: 'Work or personal?', replyTo: 7, channels: ['whatsapp'] }])
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
})

test('rebuild: it empties what writes names in whatever shape it finds, and passes over an entry with a file on its way', async t => {
  const prepared = await prepare(t)
  const { paths } = prepared
  const agent = paths.agentDir('lifelog')
  // writes names, besides, a file and a folder under notes, which is a file a change of writes
  // left, as the backfills' files need their own; and a file that is there.
  fs.writeFileSync(path.join(agent, 'notes'), 'in the way\n')
  fs.writeFileSync(path.join(agent, 'todo.md'), '- a\n')
  gitOf(paths, 'add', '--', 'notes', 'todo.md')
  commitByHand(paths, 'lifelog: by hand')
  const yaml = rebuildYaml().replace('writes: [agents/lifelog/views/, agents/lifelog/memory/]', 'writes: [agents/lifelog/views/, agents/lifelog/memory/, agents/lifelog/notes/a.md, agents/lifelog/notes/b/, agents/lifelog/todo.md]')
  fs.writeFileSync(paths.agentsYaml, yaml)
  const { done } = startRebuild(prepared)
  const result = await drive(prepared, done)
  assert.equal(result.stopped, false)
  assert.equal(fs.readFileSync(path.join(agent, 'notes'), 'utf8'), 'in the way\n')
  // The file of writes was emptied away, and that committed.
  assert.equal(fs.existsSync(path.join(agent, 'todo.md')), false)
  assert.equal(gitOf(paths, 'ls-files', 'todo.md', 'notes'), 'notes\n')
})

test('rebuild: it passes over an entry with a link on its way, and empties nothing where the link leads', async t => {
  const prepared = await prepare(t)
  const { paths, root, entries } = prepared
  const agent = paths.agentDir('lifelog')
  // A link that a run left in notes/, under an earlier writes, to a folder outside the entries
  // that holds their names; writes now names entries behind it.
  const outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(outside, 'kept'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'kept', 'a.md'), "not the agent's\n")
  fs.writeFileSync(path.join(outside, 'books.csv'), "not the agent's either\n")
  fs.mkdirSync(path.join(agent, 'notes'))
  fs.symlinkSync(outside, path.join(agent, 'notes', 'out'))
  const yaml = rebuildYaml().replace('writes: [agents/lifelog/views/, agents/lifelog/memory/]', 'writes: [agents/lifelog/views/, agents/lifelog/memory/, agents/lifelog/notes/out/kept/, agents/lifelog/notes/out/books.csv]')
  fs.writeFileSync(paths.agentsYaml, yaml)
  const { done } = startRebuild(prepared)
  const result = await drive(prepared, done)
  assert.equal(result.stopped, false)
  assert.deepEqual(fs.readdirSync(outside).sort(), ['books.csv', 'kept'])
  assert.deepEqual(fs.readdirSync(path.join(outside, 'kept')), ['a.md'])
  assert.equal(fs.readFileSync(path.join(outside, 'books.csv'), 'utf8'), "not the agent's either\n")
  assert.equal(fs.readlinkSync(path.join(agent, 'notes', 'out')), outside)
  assert.deepEqual(entries.filter(entry => entry.event === 'agent.entry_blocked').map(entry => entry.entry).slice(0, 2), ['notes/out/kept', 'notes/out/books.csv'])
})

test("rebuild: it doesn't start while a runner runs or run.lock is there, and nothing of the runner's starts while it runs", async t => {
  const prepared = await prepare(t)
  const { paths, sandbox, settings, clock, log, proc } = prepared

  const { runner } = await startTestRunner(t, prepared)
  await assert.rejects(startRebuild(prepared).done, error => error instanceof RebuildError && /can't run while the runner, another rebuild or build-image does/.test(error.message))
  await runner.close()

  takeLock(paths.runLock, { clock })
  await assert.rejects(startRebuild(prepared).done, error => error instanceof RebuildError && error.message.includes(`${paths.runLock} is there, though no runner or rebuild is running: one stopped by force left it`))
  releaseLock(paths.runLock)
  // Nothing was changed by either.
  assert.equal(gitOf(paths, 'tag', '--list'), '')

  // During a rebuild's batch, a runner can't start, so it can't take the rebuild's lock away or
  // throw its work away.
  let open
  const gate = new Promise(resolve => (open = resolve))
  let inRun
  const running = new Promise(resolve => (inRun = resolve))
  beforeEachRun(sandbox, async count => {
    if (count !== 1) return
    inRun()
    await gate
  })
  const { done } = startRebuild(prepared)
  await running
  await assert.rejects(openRunner({ settings, openSandbox: async () => sandbox, clock, log, proc }), /another runner, rebuild or build-image is running on this data folder/)
  assert.equal(readLock(paths.runLock).pid, process.pid)
  assert.equal(gitOf(paths, 'log', '-1', '--format=%s'), 'lifelog: rebuild, from empty\n')
  open()
  assert.equal((await drive(prepared, done)).stopped, false)
  // Once it is over, a runner starts.
  const again = await startTestRunner(t, prepared)
  await again.runner.close()
})

test('rebuild: a failed batch is thrown away and tried again; it gives way to a backup, waits out an outage, and gives up on an item after 4 attempts, without a word to the owner', async t => {
  const lines = [
    line.text(1, '2026-11-08T04:00:00Z', 'coffee 120'), // Sun 8 Nov, 09:30
    line.text(2, '2026-11-08T05:00:00Z', 'tea IGNORE'),
    line.text(3, '2026-11-09T05:00:00Z', 'lunch 300'), // Mon 9 Nov, 10:30
  ]
  const prepared = await prepare(t, { lines, state: { ...HANDLED, cursor: 3 } })
  const { paths, sandbox, clock } = prepared
  // A backup holds its lock when the rebuild starts; OpenRouter is down for its first try.
  takeLock(paths.backupLock, { clock })
  beforeEachRun(sandbox, count => sandbox.behave(count === 1 ? { openrouter: 503 } : null))

  const { done, said } = startRebuild(prepared)
  const result = await drive(prepared, done)
  assert.deepEqual(result, { stopped: false, tag: TAG, until: 3, cursor: 3, batches: 6, failed: [2] })
  // An item tried again is waited for: the next day waits until it is done with.
  assert.deepEqual(
    sandbox.seen().map(call => call.items),
    [[1, 2], [1, 2], [2], [2], [2], [3]],
  )
  // A backup held its lock when the rebuild started: it changed nothing before it was over.
  assert.deepEqual(said, [
    'Waiting for a backup to finish.',
    `Rebuilding lifelog from the datastore, up to #3. The last commit before the rebuild is tagged ${TAG}.`,
    "2026-11-08 #1-#2: paused (OpenRouter: stub error 503) until 21:21.",
    '2026-11-08 #1-#2: done; not reported, tried again: #2.',
    '2026-11-08 #2: done; not reported, tried again: #2.',
    '2026-11-08 #2: done; not reported, tried again: #2.',
    '2026-11-08 #2: done; given up on: #2.',
    '2026-11-09 #3: done.',
    'Rebuilt lifelog up to #3, in 6 batches, committed as "lifelog: rebuild".',
    'Given up on: #2. An edit of one of these messages brings it back.',
  ])
  const after = state(paths)
  assert.deepEqual(after.failed.map(entry => [entry.seq, entry.reason]), [[2, 'not handled after 4 attempts']])
  assert.deepEqual([after.cursor, after.retry, after.paused], [3, [], undefined])
  assert.equal(
    fs.readFileSync(path.join(path.join(paths.agentDir('lifelog'), 'views'), 'notes.csv'), 'utf8'),
    'seq,text\n1,"#1 09:30 text: \\"coffee 120\\" (attempt 1 of 4)"\n3,"#3 10:30 text: \\"lunch 300\\""\n',
  )
  assert.deepEqual(outboxOf(paths), [])
})

test('rebuild: its own steps take run.lock and give way to a backup, as its batches do, so a backup never reads views or .git while it changes them', async t => {
  const prepared = await prepare(t)
  const { paths, sandbox, clock } = prepared
  const head = gitOf(paths, 'rev-parse', 'HEAD')
  // A backup holds its lock when the rebuild starts, and takes it again during the last batch.
  takeLock(paths.backupLock, { clock })
  beforeEachRun(sandbox, count => {
    if (count === 2) takeLock(paths.backupLock, { clock })
  })
  const looks = []
  const { done, said } = startRebuild(prepared)
  const result = await drive(prepared, done, {
    onBackup: () =>
      looks.push({
        tags: gitOf(paths, 'tag', '--list'),
        last: gitOf(paths, 'log', '-1', '--format=%s'),
        views: fs.readdirSync(path.join(paths.agentDir('lifelog'), 'views')).sort(),
        runLock: lockExists(paths.runLock),
      }),
  })
  assert.equal(result.stopped, false)
  assert.deepEqual(looks, [
    // Before step 1: nothing tagged, emptied or committed.
    { tags: '', last: 'lifelog: #1 #4 #6\n', views: ['old.csv'], runLock: false },
    // Before step 5: the last batch's commit, not yet folded into one.
    { tags: `${TAG}\n`, last: 'lifelog: rebuild #4-#6\n', views: ['notes.csv'], runLock: false },
  ])
  assert.equal(said.filter(line => line === 'Waiting for a backup to finish.').length, 2)
  assert.equal(gitOf(paths, 'log', '-1', '--format=%s'), 'lifelog: rebuild\n')
  assert.equal(gitOf(paths, 'rev-parse', 'HEAD^'), head)
  assert.equal(lockExists(paths.runLock), false)

  // Stopped while it waits before its first step, it has changed nothing.
  takeLock(paths.backupLock, { clock })
  const stopping = new AbortController()
  const waiting = startRebuild(prepared, { signal: stopping.signal })
  await prepared.clock.whenSleeping()
  stopping.abort()
  assert.deepEqual(await waiting.done, { stopped: true, tag: null, until: 6, cursor: 0, batches: 0, failed: [] })
  assert.deepEqual(waiting.said, ['Waiting for a backup to finish.', 'Stopped before it changed anything.'])
  assert.equal(gitOf(paths, 'log', '-1', '--format=%s'), 'lifelog: rebuild\n')
})

test('rebuild: an item not reported is tried again before the days after it, which are never its context', async t => {
  const lines = [
    line.text(1, '2026-11-07T07:00:00Z', 'from now on, tea is a drink IGNORE'), // Sat 7 Nov, 12:30
    line.sent(2, '2026-11-07T07:01:00Z', 'Noted.'),
    line.text(3, '2026-11-08T04:00:00Z', 'tea 40'), // Sun 8 Nov, 09:30
    line.sent(4, '2026-11-08T04:01:00Z', 'Logged tea.'),
    line.text(5, '2026-11-09T04:00:00Z', 'tea 45'), // Mon 9 Nov, 09:30
    line.sent(6, '2026-11-09T04:01:00Z', 'Logged tea.'),
  ]
  const prepared = await prepare(t, { lines, state: { ...HANDLED, cursor: 6 } })
  const { sandbox } = prepared
  const result = await drive(prepared, startRebuild(prepared).done)
  assert.deepEqual(result.failed, [1])
  assert.deepEqual(
    sandbox.seen().map(call => call.items),
    [[1], [1], [1], [1], [3], [5]],
  )
  for (const call of sandbox.seen().slice(0, 4)) {
    assert.match(call.prompt, /^\[scooter\] Now: Saturday 7 November 2026, 12:30 /)
    assert.match(call.prompt, /^#2 12:31 you sent: "Noted\."$/m)
    assert.ok(!call.prompt.includes('Logged tea'))
  }
})

test('rebuild: with session: none, its batches run without a session, and it leaves none', async t => {
  const prepared = await prepare(t)
  const { paths, sandbox } = prepared
  fs.writeFileSync(paths.agentsYaml, rebuildYaml().replace('session: daily', 'session: none'))
  const result = await drive(prepared, startRebuild(prepared).done)
  assert.equal(result.batches, 2)
  for (const call of sandbox.seen()) {
    assert.ok(call.argv.includes('--no-session'))
    assert.ok(!call.argv.includes('--session-id'))
  }
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
})

test('rebuild: a closed terminal, SIGHUP, stops it as SIGTERM does, and lets go of run.lock, so the next rebuild can start', async t => {
  const prepared = await prepare(t)
  const { settings, sandbox, paths } = prepared
  beforeEachRun(sandbox, count => {
    if (count === 1) process.emit('SIGHUP', 'SIGHUP')
  })
  let out = ''
  const code = await runRebuild({ args: ['lifelog'], settings, openSandbox: async () => sandbox, stdout: { write: text => (out += text) }, stderr: { write: () => {} }, clock: prepared.clock, log: prepared.log })
  assert.equal(code, 1)
  assert.match(out, /Stopped at #0 of #6, with the agent's files rebuilt only in part\. Run the rebuild again; it starts from the beginning\.\n$/)
  assert.equal(lockExists(paths.runLock), false)
  assert.equal(process.listenerCount('SIGHUP'), 0)
  prepared.clock.set(Date.parse(START) + MINUTE)
  assert.equal((await drive(prepared, startRebuild(prepared).done)).stopped, false)
})

test('rebuild: stopped, it throws the batch in progress away, and leaves a state from which a runner goes on after the rebuild\'s seq', async t => {
  const prepared = await prepare(t)
  const { paths, sandbox } = prepared
  const stopping = new AbortController()
  beforeEachRun(sandbox, count => {
    if (count === 2) stopping.abort()
  })
  const { done, said } = startRebuild(prepared, { signal: stopping.signal })
  const result = await drive(prepared, done)
  assert.deepEqual(result, { stopped: true, tag: TAG, until: 6, cursor: 3, batches: 1, failed: [] })
  assert.equal(said.at(-1), "Stopped at #3 of #6, with the agent's files rebuilt only in part. Run the rebuild again; it starts from the beginning.")
  // The first day is committed; the second thrown away.
  assert.equal(gitOf(paths, 'log', '-1', '--format=%s'), 'lifelog: rebuild #1\n')
  assert.equal(gitOf(paths, 'status', '--porcelain'), '')
  assert.deepEqual(fs.readdirSync(paths.agentMemory('lifelog')), [])
  assert.equal(state(paths).cursor, 6)
  assert.equal(lockExists(paths.runLock), false)

  // Run again, it starts from the beginning, with a tag of its own.
  prepared.clock.set(Date.parse(START) + MINUTE)
  const again = await drive(prepared, startRebuild(prepared).done)
  assert.deepEqual([again.stopped, again.tag, again.batches], [false, 'before-rebuild-20261109T155130Z', 2])
  assert.equal(gitOf(paths, 'rev-parse', 'HEAD^').trim(), gitOf(paths, 'rev-parse', 'before-rebuild-20261109T155130Z').trim())
})

test('rebuild: scooter rebuild names an agent, and says why it can\'t start', async t => {
  const prepared = await prepare(t)
  const { settings, sandbox } = prepared
  const run = async args => {
    let out = ''
    let err = ''
    const code = await runRebuild({ args, settings, openSandbox: async () => sandbox, stdout: { write: text => (out += text) }, stderr: { write: text => (err += text) }, clock: prepared.clock, log: prepared.log })
    return { code, out, err }
  }
  for (const args of [[], ['lifelog', 'extra'], ['--all']]) {
    assert.deepEqual(await run(args), { code: 2, out: '', err: 'scooter rebuild: name the agent to rebuild, such as: scooter rebuild lifelog\n' })
  }
  assert.deepEqual(await run(['nobody']), { code: 2, out: '', err: 'scooter rebuild: agents.yaml has no agent called nobody; it has lifelog\n' })
  fs.writeFileSync(prepared.paths.agentsYaml, 'agents: {}\n')
  const bad = await run(['lifelog'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /^scooter rebuild: .*agents must hold exactly one agent/)
  fs.writeFileSync(prepared.paths.agentsYaml, rebuildYaml())
  const ok = await run(['lifelog'])
  assert.equal(ok.code, 0)
  assert.match(ok.out, /^Rebuilding lifelog from the datastore, up to #6\./)
  assert.equal(rebuildTag(Date.parse('2026-11-18T10:15:00Z')), 'before-rebuild-20261118T101500Z')
})
