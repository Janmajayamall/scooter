// Backfills: `until` and covering every message once,
// running only when nothing live waits, what a batch may change, its silence and its summary, its
// progress across a restart, dropping it, and its own retries and pauses.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { backfillIntro, backfillSummary, countRows, settleBackfill } from '../src/runner/backfill.mjs'
import { line, writeConfig } from './support/runner.mjs'
import { MINUTE, SECOND, prepareTestRunner, startTestRunner } from './support/test-runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
const START = '2026-11-09T15:50:30Z'

function backfillYaml({ backfill = true, writes = '[agents/lifelog/views/people.csv]' } = {}) {
  return `agents:
  lifelog:
    model: anthropic/claude-sonnet-5.5
    prompt: prompts/lifelog.md
    skills: [skills/expenses, skills/people]
    writes: [agents/lifelog/views/, agents/lifelog/memory/]
    sends: [whatsapp]
    session: daily
    reply_mode: quiet
    ack_reaction: "✅"
    timeout_minutes: 10
    run:
      - on: new-messages
        channels: [whatsapp, email]
${backfill ? `      - backfill: people-1\n        skill: people\n        writes: ${writes}\n` : ''}`
}

// Two of the owner's days in Kolkata, already handled by live runs, before the people skill was
// added. `words` adds keywords for the pi stub to an item's text.
function history(words = {}) {
  const text = (seq, base) => `${base}${words[seq] ? ` ${words[seq]}` : ''}`
  return [
    line.text(1, '2026-11-07T07:00:00Z', text(1, 'lunch with sam')), // Sat 7 Nov, 12:30
    line.sent(2, '2026-11-07T07:01:00Z', 'Logged.'),
    line.text(3, '2026-11-07T12:00:00Z', text(3, 'call with ana')), // Sat 7 Nov, 17:30
    line.text(4, '2026-11-08T04:00:00Z', text(4, 'coffee 120')), // Sun 8 Nov, 09:30
    line.text(5, '2026-11-08T14:00:00Z', text(5, 'dinner with sam and ana')), // Sun 8 Nov, 19:30
  ]
}

const LAST_RUN = { at: '2026-11-08T14:00:30Z', ok: true, seqs: [5], durationMs: 1000 }
const HANDLED = { ...initialAgentState(), cursor: 5, lastRun: LAST_RUN }

async function openBackfill(t, { words, lines = [], state = HANDLED, yaml = backfillYaml() } = {}) {
  const prepared = prepareTestRunner(t, { yaml, lines: [...history(words), ...lines], state, start: START })
  return { prepared, ...(await startTestRunner(t, prepared)) }
}

const itemsSeen = sandbox => sandbox.seen().map(call => call.items)
const sessionOf = call => call.argv[call.argv.indexOf('--session-id') + 1]
const skillsOf = call => call.argv.flatMap((arg, n) => (arg === '--skill' ? [path.basename(call.argv[n + 1])] : []))

// ---------------------------------------------------------------------------------------------
// As the runner runs it

test('backfills: until is the live cursor when it starts, every message up to it is covered once, a day at a time, and nothing is sent until its summary', async t => {
  const { runner, clock, state, outbox, git, views, add, paths, sandbox } = await openBackfill(t, { words: { 3: 'UNSURE', 4: 'SAY', 5: 'FAIL' } })
  assert.deepEqual(state().backfill, { id: 'people-1', until: 5, cursor: 0, retry: [], skipped: [] })

  // Saturday: #1 and #3, with #2, which Scooter sent, as context.
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill', id: 'people-1' }, outcome: { ok: true, cause: null } })
  const [first] = sandbox.seen()
  assert.deepEqual(first.items, [1, 3])
  const prompt = first.prompt.split('\n')
  assert.equal(
    prompt[0],
    `Backfill (from your configuration, not a message from the owner): file these messages for the people skill only. Change only ${paths.dataDir}/agents/lifelog/views/people.csv.`,
  )
  assert.equal(prompt[1], '[scooter] Now: Saturday 7 November 2026, 17:30 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.')
  assert.match(first.prompt, /^#2 12:31 you sent: "Logged."$/m)
  // Its own session for the day, the backfill's skill alone after the runner's, and the live
  // system prompt.
  assert.equal(sessionOf(first), 'lifelog-backfill-people-1-2026-11-07')
  assert.deepEqual(skillsOf(first), ['scooter', 'people'])
  assert.match(first.systemPrompt, /You are lifelog\./)
  assert.equal(git('log', '-1', '--format=%s', '--name-only'), 'lifelog: backfill people-1 #1-#3\n\nviews/people.csv\n')
  assert.deepEqual(state().backfill, { id: 'people-1', until: 5, cursor: 3, retry: [], skipped: [] })
  // Silent, and the live runs' own record is left alone.
  assert.deepEqual(outbox(), [])
  assert.deepEqual(state().lastRun, LAST_RUN)

  // Sunday: #4, whose text the stub sends, and #5, which it can't read. Neither is sent.
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(sandbox.seen()[1].items, [4, 5])
  assert.equal(sessionOf(sandbox.seen()[1]), 'lifelog-backfill-people-1-2026-11-08')
  assert.match(sandbox.seen()[1].prompt.split('\n')[1], /Now: Sunday 8 November 2026, 19:30 /)
  assert.equal(git('log', '-1', '--format=%s'), 'lifelog: backfill people-1 #4-#5\n')
  assert.deepEqual(state().backfill, { id: 'people-1', until: 5, cursor: 5, retry: [], skipped: [5] })
  assert.deepEqual(outbox(), [])
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')).sort(), ['lifelog-backfill-people-1-2026-11-07.jsonl', 'lifelog-backfill-people-1-2026-11-08.jsonl'])

  // Every message up to `until` once, and nothing after it.
  assert.deepEqual(itemsSeen(sandbox), [
    [1, 3],
    [4, 5],
  ])

  // Its summary, and it is done.
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-finished', id: 'people-1' })
  assert.equal(views('people.csv').split('\n').filter(Boolean).length, 4)
  assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: 'Backfill people-1 finished: views/people.csv has 3 rows, 1 marked ❓. Skipped: #5.' }])
  assert.equal(state().backfill, undefined)
  assert.deepEqual(state().backfillDone, ['people-1'])
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })

  // A new message is the live runs', which reply.
  add(line.text(6, '2026-11-09T15:51:00Z', 'tea'))
  await runner.tick()
  await clock.advance(8 * SECOND)
  assert.deepEqual(await runner.tick(), { action: { kind: 'messages' }, outcome: { ok: true, cause: null } })
  assert.deepEqual(sandbox.seen()[2].items, [6])
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 6, emoji: '✅', channels: ['whatsapp'] }])
})

test('backfills: with sends: [], the batches send nothing and the summary still goes, as the runner\'s own', async t => {
  const { runner, outbox } = await openBackfill(t, { words: { 4: 'SAY' }, yaml: backfillYaml().replace('sends: [whatsapp]', 'sends: []') })
  for (const kind of ['backfill', 'backfill']) assert.equal((await runner.tick()).action.kind, kind)
  assert.deepEqual(outbox(), [])
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-finished', id: 'people-1' })
  assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: 'Backfill people-1 finished: views/people.csv has 4 rows, none marked ❓.' }])
})

test('backfills: its batches run only when nothing live is waiting, and a message that arrives during one is handled right after it', async t => {
  const { runner, clock, state, sandbox, add, outbox } = await openBackfill(t, { lines: [line.text(6, '2026-11-09T15:50:00Z', 'tea')] })
  // #6 waits after the live cursor: the owner's quiet period, then the live batch.
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'messages' })
  assert.deepEqual(state().cursor, 6)
  outbox({ take: true })

  // A message arrives while a backfill batch runs.
  const run = sandbox.run.bind(sandbox)
  let arrives = true
  sandbox.run = async (spec, options) => {
    if (arrives) add(line.text(7, '2026-11-09T15:51:00Z', 'lunch 300'))
    arrives = false
    return run(spec, options)
  }
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill', id: 'people-1' })
  // The next batch is the live one, once the owner has been quiet; the backfill waits for it.
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'messages' })
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 7, emoji: '✅', channels: ['whatsapp'] }])
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill', id: 'people-1' })
  assert.deepEqual(itemsSeen(sandbox), [[6], [1, 3], [7], [4, 5]])
  // The backfill's `until` stayed where it was: #6 and #7 were the live runs'.
  assert.deepEqual(state().backfill.until, 5)
})

test("backfills: a batch's VM may change only the backfill's writes: a write anywhere else is refused, and the batch goes on", async t => {
  const { runner, state, git, views, paths, sandbox } = await openBackfill(t, { words: { 1: 'MEMORY', 3: 'OUTSIDE' } })
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill', id: 'people-1' }, outcome: { ok: true, cause: null } })
  // The sandbox was given the backfill's writes in place of the agent's, and shows the agent's.
  const agent = paths.agentDir('lifelog')
  const { files } = sandbox.runs[0].spec
  assert.deepEqual(files.writes, [
    { path: path.join(agent, 'views', 'people.csv'), folder: false },
    { path: paths.agentRunSession('lifelog'), folder: true },
  ])
  for (const folder of ['views', 'memory']) assert.ok(files.reads.includes(path.join(agent, folder)), folder)
  // The VM refuses the writes anywhere else, which the stub stands for: the view outside them,
  // and the memory.
  assert.deepEqual(sandbox.refused(), [path.join(agent, 'views', 'notes.csv'), path.join(agent, 'memory', 'preferences.md')])
  assert.equal(git('log', '-1', '--format=%s', '--name-only'), 'lifelog: backfill people-1 #1-#3\n\nviews/people.csv\n')
  assert.deepEqual(fs.readdirSync(path.join(agent, 'views')), ['people.csv'])
  assert.deepEqual(fs.readdirSync(paths.agentMemory('lifelog')), [])
  assert.equal(views('people.csv').split('\n').filter(Boolean).length, 3)
  assert.deepEqual(state().backfill, { id: 'people-1', until: 5, cursor: 3, retry: [], skipped: [] })
})

test('backfills: its progress survives a restart, and removing its entry drops it', async t => {
  const { prepared, runner, sandbox, state, paths } = await openBackfill(t)
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  await runner.close()

  // Started again, it goes on from its cursor.
  const again = await startTestRunner(t, prepared)
  assert.deepEqual(state().backfill, { id: 'people-1', until: 5, cursor: 3, retry: [], skipped: [] })
  assert.deepEqual((await again.runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(itemsSeen(sandbox), [
    [1, 3],
    [4, 5],
  ])
  await again.runner.close()

  // Its entry gone from the config, a start drops it, and its sessions, without a word.
  writeConfig(paths.configDir, { yaml: backfillYaml({ backfill: false }) })
  const dropped = await startTestRunner(t, prepared)
  assert.equal(state().backfill, undefined)
  assert.deepEqual(state().backfillDone, [])
  assert.ok(dropped.events().includes('runner.backfill_dropped'))
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
  assert.deepEqual((await dropped.runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  assert.deepEqual(dropped.outbox(), [])
})

test('backfills: a setup error pauses every run without a notice, and the items keep their attempts; a live failure after it sends its own', async t => {
  const { runner, clock, state, outbox, sandbox, add } = await openBackfill(t)
  sandbox.behave({ openrouter: 401 })
  assert.deepEqual((await runner.tick()).outcome, { ok: false, cause: 'setup' })
  const after = state()
  assert.equal(after.paused.cause, 'setup')
  assert.deepEqual(after.backfill.retry.map(entry => [entry.seq, entry.attempts]), [
    [1, 0],
    [3, 0],
  ])
  assert.deepEqual(outbox(), [])
  assert.deepEqual(after.lastRun, LAST_RUN)

  // While paused, nothing runs, live or not.
  add(line.text(6, '2026-11-09T15:51:00Z', 'tea'))
  await clock.advance(10 * SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'paused' })

  // At the next try the live message goes first, and its failure is the first of the live runs'
  // row: it sends the notice.
  await clock.advance(30 * MINUTE)
  assert.deepEqual(await runner.tick(), { action: { kind: 'messages' }, outcome: { ok: false, cause: 'setup' } })
  assert.equal(outbox({ take: true }).length, 1)

  // Once OpenRouter answers, both lanes go on.
  sandbox.behave(null)
  await clock.advance(30 * MINUTE)
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill', id: 'people-1' }, outcome: { ok: true, cause: null } })
  assert.equal(state().paused, undefined)
  assert.deepEqual(state().backfill.retry, [])
  assert.deepEqual(state().backfill.cursor, 3)
})

// ---------------------------------------------------------------------------------------------
// The parts

test('backfill: the prompt line names what a batch may change, as the VM has it', () => {
  const paths = makePaths({ dataDir: '/data', configDir: '/config' })
  const entry = { id: 'people-1', skill: 'people', writes: ['agents/lifelog/views/people.csv', 'agents/lifelog/views/people/'] }
  assert.equal(
    backfillIntro(entry, paths),
    'Backfill (from your configuration, not a message from the owner): file these messages for the people skill only. Change only /data/agents/lifelog/views/people.csv and /data/agents/lifelog/views/people/.',
  )
  assert.equal(backfillIntro({ ...entry, writes: ['agents/lifelog/views/people.csv'] }, paths).endsWith(' Change only /data/agents/lifelog/views/people.csv.'), true)
})

test("backfill: counting a CSV's rows, and those marked ❓", () => {
  assert.deepEqual(countRows(''), { rows: 0, unsure: 0 })
  assert.deepEqual(countRows('date,person,note\n'), { rows: 0, unsure: 0 })
  const text = 'date,person,note,source\n2026-11-07,Sam,"lunch, then a walk",#1\n2026-11-07,Ana,"a call\nabout ""Goa"" ❓",#3\r\n\n2026-11-08,❓,dinner,#5\n'
  assert.deepEqual(countRows(text), { rows: 3, unsure: 2 })
  // A ❓ in the header isn't a row's.
  assert.deepEqual(countRows('who ❓,note\nSam,x'), { rows: 1, unsure: 0 })
})

test("backfill: the summary counts each CSV in writes, a folder's included, and lists what was skipped", t => {
  const paths = makePaths({ dataDir: makeTestDir(t), configDir: '/config' })
  const views = path.join(paths.agentDir('lifelog'), 'views')
  fs.mkdirSync(path.join(views, 'people', 'b'), { recursive: true })
  fs.writeFileSync(path.join(views, 'people.csv'), 'a,b\n1,2\n')
  fs.writeFileSync(path.join(views, 'people', 'b', '2026.csv'), 'a,b\n1,❓\n2,3\n')
  fs.writeFileSync(path.join(views, 'people', 'notes.md'), 'x\n')
  fs.symlinkSync('/etc/hostname', path.join(views, 'people', 'link.csv'))
  const agent = { name: 'lifelog' }
  const summary = writes => backfillSummary({ paths, agent, entry: { id: 'people-1', skill: 'people', writes }, skipped: [1207, 1031] })
  assert.equal(summary(['agents/lifelog/views/people.csv']), 'Backfill people-1 finished: views/people.csv has 1 row, none marked ❓. Skipped: #1031, #1207.')
  assert.equal(
    summary(['agents/lifelog/views/people/', 'agents/lifelog/views/missing.csv', 'agents/lifelog/views/none/', 'agents/lifelog/views/notes.md']),
    "Backfill people-1 finished: views/people/b/2026.csv has 2 rows, 1 marked ❓; views/missing.csv isn't there; views/none/ holds no CSV file. Skipped: #1031, #1207.",
  )
  assert.equal(backfillSummary({ paths, agent, entry: { id: 'notes-1', skill: 'notes', writes: ['agents/lifelog/views/notes.md'] }, skipped: [] }), 'Backfill notes-1 finished.')
  // A path of writes outside the agent's folder is never read, so nothing there is counted.
  fs.mkdirSync(path.join(paths.dataDir, 'shared'), { recursive: true })
  fs.writeFileSync(path.join(paths.dataDir, 'shared', 'people.csv'), 'a,b\n1,2\n')
  assert.equal(summary(['shared/people.csv', 'shared/']), 'Backfill people-1 finished. Skipped: #1031, #1207.')
})

test('backfill: the summary reads nothing through a link a run left on the way to its writes, and takes what is behind it as not there', t => {
  const paths = makePaths({ dataDir: makeTestDir(t), configDir: '/config' })
  const notes = path.join(paths.agentDir('lifelog'), 'notes')
  // Where the link leads, outside every entry: CSV files with the names the backfill's writes give.
  const outside = path.join(paths.dataDir, 'elsewhere')
  fs.mkdirSync(path.join(outside, 'books'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'books.csv'), 'a\n1\n')
  fs.writeFileSync(path.join(outside, 'books', 'x.csv'), 'a\n1\n2\n')
  fs.mkdirSync(notes, { recursive: true })
  fs.symlinkSync(outside, path.join(notes, '2026'))
  const summary = backfillSummary({ paths, agent: { name: 'lifelog' }, entry: { id: 'books-1', skill: 'books', writes: ['agents/lifelog/notes/2026/books.csv', 'agents/lifelog/notes/2026/books/'] }, skipped: [] })
  assert.equal(summary, "Backfill books-1 finished: notes/2026/books.csv isn't there; notes/2026/books/ holds no CSV file.")
})

test("backfill: a batch's outcome settles the backfill's lane, as a live batch's settles the live one", () => {
  const backfill = { id: 'people-1', until: 50, cursor: 10, retry: [{ seq: 4, attempts: 3, due: '2026-11-09T15:00:00Z', reason: 'not reported' }], skipped: [2, 7] }
  const state = { ...HANDLED, cursor: 60, backfill }
  // #4 on its fourth attempt, #7 brought back from skipped by an edit, and #11 to #13 new.
  const batch = {
    items: [
      { seq: 4, origin: 'retry', attempt: 4 },
      { seq: 7, origin: 'failed', attempt: 1 },
      { seq: 11, origin: 'new', attempt: 1 },
      { seq: 12, origin: 'new', attempt: 1 },
      { seq: 13, origin: 'new', attempt: 1 },
    ],
    covered: 14,
  }
  const now = Date.parse('2026-11-09T15:50:00Z')
  const ok = settleBackfill(state, batch, { ok: true, done: new Set([7, 11]), failed: new Map([[12, "can't read it"]]) }, { now })
  assert.deepEqual(ok.state.backfill, {
    id: 'people-1',
    until: 50,
    cursor: 14,
    retry: [{ seq: 13, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'not reported' }],
    skipped: [2, 4, 12],
  })
  assert.deepEqual(ok.givenUp, [4])
  // The live lane, and `lastRun`, as they were.
  assert.deepEqual([ok.state.cursor, ok.state.retry, ok.state.failed, ok.state.lastRun], [60, [], [], LAST_RUN])

  // An outage: every item waits, due at once, its attempts as they were, and runs pause.
  const down = settleBackfill(state, batch, { ok: false, cause: 'outage', reason: "OpenRouter didn't answer" }, { now })
  assert.deepEqual(
    down.state.backfill.retry.map(entry => [entry.seq, entry.attempts, entry.due]),
    [
      [4, 3, '2026-11-09T15:50:00Z'],
      [7, 0, '2026-11-09T15:50:00Z'],
      [11, 0, '2026-11-09T15:50:00Z'],
      [12, 0, '2026-11-09T15:50:00Z'],
      [13, 0, '2026-11-09T15:50:00Z'],
    ],
  )
  assert.deepEqual(down.state.backfill.skipped, [2])
  assert.equal(down.state.paused.cause, 'outage')
  assert.deepEqual(down.state.lastRun, LAST_RUN)
  // A run that gets through ends the pause.
  assert.equal(settleBackfill(down.state, { items: [], covered: 14 }, { ok: true, done: new Set(), failed: new Map() }, { now }).state.paused, undefined)
})
