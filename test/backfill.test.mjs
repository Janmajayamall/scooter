// Jobs of `scooter backfill`, as the runner runs them, with the fake sandbox and the pi stub: a job
// taken at the runner's next look; its start, the tag and `--empty`; covering every line up to
// where it stops once, a day at a time, and sending nothing until its message; running only when
// nothing live waits, or holding live runs back with `--hold-live`; what a batch may change; its
// prompt, `--prompt` or the trigger's; an agent given in a file; its progress across a restart, and
// a stop at each step; cancelling it; its own retries and pauses; and what the runner makes of a job
// file that isn't one.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { initialAgentState } from '../src/common/agentstate.mjs'
import { readJob } from '../src/common/jobfile.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { releaseLock, takeLock } from '../src/common/locks.mjs'
import { jobLane, jobSummary, settleJobBatch, tagMessage } from '../src/runner/backfill.mjs'
import { queueJob } from '../src/runner/enqueue.mjs'
import { NEW_MESSAGES_PROMPT, line, writeConfig } from './support/runner.mjs'
import { isRoot } from './support/root.mjs'
import { MINUTE, SECOND, prepareTestRunner, startTestRunner } from './support/test-runner.mjs'
import { atEnd } from './support/tmp.mjs'

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
const START = '2026-11-09T15:50:30Z'

function jobYaml({ checkIn = false } = {}) {
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
        prompt: ${JSON.stringify(NEW_MESSAGES_PROMPT)}
${checkIn ? '      - at: "21:30"\n        tag: check-in\n        prompt: Check in.\n' : ''}`
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

// The test's folders, and a runner on them.
async function open(t, { words, lines = [], state = HANDLED, yaml = jobYaml() } = {}) {
  const prepared = prepareTestRunner(t, { yaml, lines: [...history(words), ...lines], state, start: START })
  return { prepared, ...(await startTestRunner(t, prepared)) }
}

// Queues a job with the command's own code, on the test's folders and clock. Returns the job and
// its file.
const queue = (prepared, args) => queueJob({ args, settings: prepared.settings, clock: prepared.clock })

const jobOn = (file, agent = 'lifelog') => readJob(file, { agent }).job
const itemsSeen = sandbox => sandbox.seen().map(call => call.items)
const sessionOf = call => call.argv[call.argv.indexOf('--session-id') + 1]
const skillsOf = call => call.argv.flatMap((arg, n) => (arg === '--skill' ? [path.basename(call.argv[n + 1])] : []))
const PEOPLE = ['--skills', 'people', '--writes', 'agents/lifelog/views/people.csv']

// ---------------------------------------------------------------------------------------------
// As the runner runs it

test('backfill: a job is taken at the next look, tagged, and covers every line up to the live cursor once, a day at a time, sending nothing until its message', async t => {
  const { prepared, runner, clock, state, outbox, git, views, add, paths, sandbox, entries } = await open(t, { words: { 3: 'UNSURE', 4: 'SAY', 5: 'FAIL' } })
  const { job, file } = await queue(prepared, ['lifelog', ...PEOPLE])
  assert.equal(file, path.join(paths.agentJobs('lifelog'), `${job.id}.json`))
  assert.deepEqual(jobOn(file).progress, null)

  // Its start: the tag, and where it stops, the live cursor then.
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill-start', id: job.id }, outcome: 'started' })
  const head = git('rev-parse', 'HEAD').trim()
  assert.equal(git('rev-parse', `before-backfill-${job.id}^{commit}`).trim(), head)
  assert.equal(git('cat-file', 'tag', `before-backfill-${job.id}`).split('\n\n').slice(1).join('\n\n'), tagMessage(job))
  assert.deepEqual(jobOn(file).progress, { started: '2026-11-09T15:50:30Z', until: 5, cursor: 0, given: 0, retry: [], skipped: [] })
  assert.ok(entries.some(entry => entry.event === 'runner.job_started' && entry.job === job.id && entry.until === 5))

  // Saturday: #1 and #3; #2, which Scooter sent, is passed over. The prompt is the one for new
  // messages, of that day's time, with what the job may change.
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill', id: job.id }, outcome: { ok: true, cause: null } })
  const [first] = sandbox.seen()
  assert.deepEqual(first.items, [1, 3])
  assert.equal(
    first.prompt,
    `Now: Saturday 7 November 2026, 17:30 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.
Your folder: ${paths.agentDir('lifelog')}
The datastore: ${paths.datastore}
This run may change: ${paths.agentDir('lifelog')}/views/people.csv
Given before: none
New: 1 3
`,
  )
  // Its own session for the day, its skills alone after the runner's, and the agent's prompt of
  // live runs.
  assert.equal(sessionOf(first), `lifelog-backfill-${job.id}-2026-11-07`)
  assert.deepEqual(skillsOf(first), ['scooter', 'people'])
  assert.match(first.systemPrompt, /You are lifelog\./)
  assert.equal(git('log', '-1', '--format=%s', '--name-only'), `lifelog: backfill ${job.id} #1-#3\n\nviews/people.csv\n`)
  assert.deepEqual(jobOn(file).progress, { started: '2026-11-09T15:50:30Z', until: 5, cursor: 3, given: 2, retry: [], skipped: [] })
  // Silent, and the live runs' own record is left alone.
  assert.deepEqual(outbox(), [])
  assert.deepEqual(state().lastRun, LAST_RUN)
  assert.deepEqual(state().cursor, 5)

  // Sunday: #4, whose text the stub sends, and #5, which it can't read, and says so. Neither is
  // sent: what send queued is dropped, and counted.
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(sandbox.seen()[1].items, [4, 5])
  assert.deepEqual(entries.filter(entry => entry.event === 'runner.sends_dropped').map(entry => entry.silent), [2])
  assert.equal(sessionOf(sandbox.seen()[1]), `lifelog-backfill-${job.id}-2026-11-08`)
  assert.match(sandbox.seen()[1].prompt, /^Now: Sunday 8 November 2026, 19:30 /)
  assert.deepEqual(jobOn(file).progress, { started: '2026-11-09T15:50:30Z', until: 5, cursor: 5, given: 4, retry: [], skipped: [5] })
  assert.deepEqual(outbox(), [])
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')).sort(), [`lifelog-backfill-${job.id}-2026-11-07.jsonl`, `lifelog-backfill-${job.id}-2026-11-08.jsonl`])
  assert.deepEqual(itemsSeen(sandbox), [
    [1, 3],
    [4, 5],
  ])

  // Its message, which counts no rows, then its file and its sessions go. The tag stays.
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-finished', id: job.id })
  assert.equal(views('people.csv').split('\n').filter(Boolean).length, 4)
  assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: `Backfill ${job.id} of lifelog finished: it was given 4 lines, and gave up on #5.` }])
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
  assert.equal(git('rev-parse', `before-backfill-${job.id}^{commit}`).trim(), head)
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })

  // A new message is the live runs', which reply.
  add(line.text(6, '2026-11-09T15:51:00Z', 'tea'))
  await runner.tick()
  await clock.advance(8 * SECOND)
  assert.deepEqual(await runner.tick(), { action: { kind: 'messages' }, outcome: { ok: true, cause: null } })
  assert.deepEqual(sandbox.seen()[2].items, [6])
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 6, emoji: '✅', channels: ['whatsapp'] }])
})

test('backfill: --prompt gives the job\'s runs a prompt of their own, filled in as a trigger\'s is, kept in the job and with its tag; the agent\'s own prompt stays', async t => {
  const { prepared, runner, sandbox, git, paths } = await open(t)
  const promptFile = path.join(prepared.root, 'books.md')
  const text = '# Backfill for people\nFile only what belongs in $run.writes$, and mark done a message that holds nothing for it. It costs $5.\nNew: $seq.unread$\nGiven before: $seq.retry$\n'
  fs.writeFileSync(promptFile, text)
  const { job, file } = await queue(prepared, ['lifelog', ...PEOPLE, '--prompt', promptFile])
  assert.equal(jobOn(file).prompt, text)
  // The file is read once: changed or gone after, the job keeps what it was.
  fs.rmSync(promptFile)
  await runner.tick()
  assert.ok(git('cat-file', 'tag', `before-backfill-${job.id}`).endsWith(`\n\nPrompt:\n\n${text}`))
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  const [call] = sandbox.seen()
  assert.equal(call.prompt, `# Backfill for people\nFile only what belongs in ${paths.agentDir('lifelog')}/views/people.csv, and mark done a message that holds nothing for it. It costs $5.\nNew: 1 3\nGiven before: none\n`)
  assert.equal(call.systemPrompt, 'You are lifelog.\n')
  assert.deepEqual(call.items, [1, 3])
})

test('backfill: with sends: [], the batches send nothing and the message still goes, as the runner\'s own', async t => {
  const { prepared, runner, outbox } = await open(t, { words: { 4: 'SAY' }, yaml: jobYaml().replace('sends: [whatsapp]', 'sends: []') })
  const { job } = await queue(prepared, ['lifelog'])
  for (const kind of ['backfill-start', 'backfill', 'backfill']) assert.equal((await runner.tick()).action.kind, kind)
  assert.deepEqual(outbox(), [])
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-finished', id: job.id })
  assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: `Backfill ${job.id} of lifelog finished: it was given 4 lines, and gave up on none.` }])
})

test('backfill: without --hold-live its steps run only when nothing live is waiting, and a message that arrives during a batch is handled right after it', async t => {
  const { prepared, runner, clock, state, sandbox, add, outbox } = await open(t, { lines: [line.text(6, '2026-11-09T15:50:00Z', 'tea')] })
  const { job, file } = await queue(prepared, ['lifelog', ...PEOPLE])
  // #6 waits after the live cursor: the owner's quiet period, then the live batch; then the start,
  // with where it stops the live cursor then.
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'messages' })
  assert.deepEqual(state().cursor, 6)
  outbox({ take: true })
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-start', id: job.id })
  assert.equal(jobOn(file).progress.until, 6)

  // A message arrives while a batch of the job runs.
  const run = sandbox.run.bind(sandbox)
  let arrives = true
  sandbox.run = async (spec, options) => {
    if (arrives) add(line.text(7, '2026-11-09T15:51:00Z', 'lunch 300'))
    arrives = false
    return run(spec, options)
  }
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill', id: job.id })
  // The next batch is the live one, once the owner has been quiet; the job waits for it.
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'messages' })
  assert.deepEqual(outbox(), [{ type: 'react', by: 'lifelog', target: 7, emoji: '✅', channels: ['whatsapp'] }])
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill', id: job.id })
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill', id: job.id })
  assert.deepEqual(itemsSeen(sandbox), [[6], [1, 3], [7], [4, 5], [6]])
  // Where it stops stayed where it was: #7 was the live runs'.
  assert.deepEqual(jobOn(file).progress.until, 6)
})

test('backfill: with --hold-live, live runs and scheduled tasks wait until the job has finished, across a restart and a pause, and it waits for a line tried again before the lines after it', async t => {
  const { prepared, runner, clock, state, sandbox, add, outbox, paths } = await open(t, { words: { 3: 'IGNORE' }, yaml: jobYaml({ checkIn: true }), state: { ...HANDLED, scheduled: { '21:30': '2026-11-08' } } })
  const { job, file } = await queue(prepared, ['lifelog', '--writes', 'agents/lifelog/views/', '--hold-live'])
  // A message, and the check-in due: neither runs before the job.
  add(line.text(6, '2026-11-09T15:50:40Z', 'tea'))
  await clock.advance(30 * SECOND)
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-start', id: job.id })
  assert.equal(jobOn(file).progress.until, 5)
  // Saturday: #3 isn't marked, and waits to be tried again; Sunday waits with it.
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill', id: job.id }, outcome: { ok: true, cause: null } })
  assert.deepEqual(jobOn(file).progress.retry.map(entry => entry.seq), [3])
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'backfill' })

  // Across a restart, and a pause.
  await runner.close()
  const again = await startTestRunner(t, prepared)
  assert.deepEqual((await again.runner.tick()).action, { kind: 'idle', reason: 'backfill' })
  await clock.advance(MINUTE)
  sandbox.behave({ openrouter: 503 })
  assert.deepEqual((await again.runner.tick()).outcome, { ok: false, cause: 'outage' })
  assert.equal(state().paused.cause, 'outage')
  await clock.advance(MINUTE)
  sandbox.behave(null)
  // #3, given again, and nothing of Sunday's with it; it isn't marked again.
  assert.deepEqual((await again.runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(itemsSeen(sandbox), [[1, 3], [3], [3]])
  assert.equal(state().paused, undefined)
  for (let n = 0; n < 2; n++) {
    await clock.advance(MINUTE)
    assert.deepEqual((await again.runner.tick()).action, { kind: 'backfill', id: job.id })
  }
  // Given up on after its fourth attempt; then Sunday.
  assert.deepEqual(jobOn(file).progress.skipped, [3])
  assert.deepEqual((await again.runner.tick()).action, { kind: 'backfill', id: job.id })
  assert.deepEqual(itemsSeen(sandbox), [[1, 3], [3], [3], [3], [3], [4, 5]])
  assert.deepEqual(outbox(), [])
  assert.deepEqual(state().cursor, 5)
  // Then its message, and the live runs go on.
  assert.deepEqual((await again.runner.tick()).action, { kind: 'backfill-finished', id: job.id })
  outbox({ take: true })
  assert.deepEqual((await again.runner.tick()).action, { kind: 'messages' })
  assert.deepEqual(fs.readdirSync(paths.agentJobs('lifelog')), [])
})

test('backfill: with --hold-live, a scheduled task that comes due during the job runs once it has finished', async t => {
  const { prepared, runner, clock } = await open(t, { yaml: jobYaml({ checkIn: true }) })
  const { job } = await queue(prepared, ['lifelog', ...PEOPLE, '--hold-live'])
  // 21:31: the check-in is due, and waits.
  await clock.advance(11 * MINUTE)
  for (const kind of ['backfill-start', 'backfill', 'backfill', 'backfill-finished']) assert.deepEqual((await runner.tick()).action, { kind, id: job.id })
  assert.deepEqual((await runner.tick()).action, { kind: 'scheduled', at: '21:30', tag: 'check-in', date: '2026-11-09', prompt: 'Check in.' })
})

test("backfill: a batch's VM may change only the job's writes: a write anywhere else is refused, and the batch goes on", async t => {
  const { prepared, runner, git, views, paths, sandbox } = await open(t, { words: { 1: 'MEMORY', 3: 'OUTSIDE' } })
  const { job, file } = await queue(prepared, ['lifelog', ...PEOPLE])
  await runner.tick()
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  // The sandbox was given the job's writes in place of the agent's, and shows the agent's; never
  // the sessions or the jobs.
  const agent = paths.agentDir('lifelog')
  const { files } = sandbox.runs[0].spec
  assert.deepEqual(files.writes, [
    { path: path.join(agent, 'views', 'people.csv'), folder: false },
    { path: paths.agentRunSession('lifelog'), folder: true },
    { path: paths.agentRunSend('lifelog'), folder: true },
    { path: paths.agentRunMarks('lifelog'), folder: false },
  ])
  for (const folder of ['views', 'memory']) assert.ok(files.reads.includes(path.join(agent, folder)), folder)
  assert.deepEqual(files.hide, [paths.agentSessions('lifelog'), paths.agentJobs('lifelog')])
  // The VM refuses the writes anywhere else, which the stub stands for: the view outside them,
  // and the memory.
  assert.deepEqual(sandbox.refused(), [path.join(agent, 'views', 'notes.csv'), path.join(agent, 'memory', 'preferences.md')])
  assert.equal(git('log', '-1', '--format=%s', '--name-only'), `lifelog: backfill ${job.id} #1-#3\n\nviews/people.csv\n`)
  assert.deepEqual(fs.readdirSync(path.join(agent, 'views')), ['people.csv'])
  assert.deepEqual(fs.readdirSync(path.join(agent, 'memory')), [])
  assert.equal(views('people.csv').split('\n').filter(Boolean).length, 3)
  assert.deepEqual(jobOn(file).progress.cursor, 3)
})

test('backfill: --empty empties what the job\'s writes name in the agent\'s folder, and commits that before the first batch, after the tag; a stop between steps does them again, and the tag stays before them', async t => {
  const { prepared, runner, git, paths, sandbox } = await open(t)
  const agent = paths.agentDir('lifelog')
  // What live runs filed: two views and a rule.
  fs.writeFileSync(path.join(agent, 'views', 'people.csv'), 'seq,text\n1,old\n')
  fs.writeFileSync(path.join(agent, 'views', 'expenses.csv'), 'seq,text\n4,coffee\n')
  fs.writeFileSync(path.join(agent, 'memory', 'preferences.md'), '- a rule\n')
  git('add', '-A', '--', 'views', 'memory')
  git('-c', 'user.name=Scooter', '-c', 'user.email=scooter@localhost', 'commit', '--quiet', '-m', 'lifelog: #1 #4')
  const before = git('rev-parse', 'HEAD').trim()
  const { job, file } = await queue(prepared, ['lifelog', '--writes', 'agents/lifelog/views/', '--empty'])

  // A stop after the tag and the emptying's commit, before the job's progress is saved: the save
  // fails, as on a full disk, and the runner stops.
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === file) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' })
    return rename(from, to)
  }
  try {
    await assert.rejects(runner.tick(), { code: 'ENOSPC' })
  } finally {
    fs.renameSync = rename
  }
  assert.equal(jobOn(file).progress, null)
  assert.equal(git('rev-parse', `before-backfill-${job.id}^{commit}`).trim(), before)
  assert.equal(git('log', '-1', '--format=%s'), `lifelog: backfill ${job.id}, from empty\n`)

  // Started again, the start is done again: the tag stays, emptying changes nothing, and nothing
  // is committed twice.
  await runner.close()
  const again = await startTestRunner(t, prepared)
  assert.deepEqual((await again.runner.tick()).outcome, 'started')
  assert.equal(git('rev-parse', `before-backfill-${job.id}^{commit}`).trim(), before)
  assert.equal(git('log', '-3', '--format=%s'), `lifelog: backfill ${job.id}, from empty\nlifelog: #1 #4\nlifelog: initial commit\n`)
  assert.equal(git('show', '--stat', '--format=', 'HEAD').trim().split('\n').at(-1).trim(), '2 files changed, 4 deletions(-)')
  assert.deepEqual(fs.readdirSync(path.join(agent, 'views')), [])
  // The memory, outside the job's writes, is as it was.
  assert.equal(fs.readFileSync(path.join(agent, 'memory', 'preferences.md'), 'utf8'), '- a rule\n')
  assert.deepEqual((await again.runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(itemsSeen(sandbox), [[1, 3]])
})

test("backfill: --empty passes over an entry whose way is blocked, and empties nothing where a link on it leads", async t => {
  const yaml = jobYaml().replace('writes: [agents/lifelog/views/, agents/lifelog/memory/]', 'writes: [agents/lifelog/views/, agents/lifelog/notes/2026/books.csv]')
  const { prepared, runner, git, paths } = await open(t, { yaml })
  const agent = paths.agentDir('lifelog')
  const outside = path.join(paths.dataDir, 'elsewhere')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'books.csv'), 'kept\n')
  fs.rmSync(path.join(agent, 'notes', '2026'), { recursive: true })
  fs.symlinkSync(outside, path.join(agent, 'notes', '2026'))
  fs.writeFileSync(path.join(agent, 'views', 'a.csv'), 'a\n')
  git('add', '--', 'views')
  git('-c', 'user.name=Scooter', '-c', 'user.email=scooter@localhost', 'commit', '--quiet', '-m', 'lifelog: #1')
  const { job } = await queue(prepared, ['lifelog', '--empty'])
  assert.deepEqual((await runner.tick()).outcome, 'started')
  assert.equal(fs.readFileSync(path.join(outside, 'books.csv'), 'utf8'), 'kept\n')
  assert.deepEqual(fs.readdirSync(path.join(agent, 'views')), [])
  assert.equal(git('log', '-1', '--format=%s'), `lifelog: backfill ${job.id}, from empty\n`)
})

test('backfill: its progress survives a restart; removing its file cancels it at the next look, also during a batch, and its sessions go', async t => {
  const { prepared, runner, sandbox, paths, outbox, entries } = await open(t)
  const { job, file } = await queue(prepared, ['lifelog', ...PEOPLE])
  await runner.tick()
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  await runner.close()

  // Started again, it goes on from its cursor.
  const again = await startTestRunner(t, prepared)
  assert.deepEqual((await again.runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(itemsSeen(sandbox), [
    [1, 3],
    [4, 5],
  ])
  assert.equal(fs.readdirSync(paths.agentSessions('lifelog')).length, 2)

  // Removed: dropped at the next look, without a word, and its sessions go.
  fs.rmSync(file)
  assert.deepEqual((await again.runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
  assert.ok(again.events().includes('runner.job_cancelled'))
  assert.deepEqual(outbox(), [])

  // Removed while a batch runs: the batch is recorded, the file isn't made again, and the job is
  // dropped.
  const second = await queue(prepared, ['lifelog', ...PEOPLE])
  await again.runner.tick()
  const run = sandbox.run.bind(sandbox)
  sandbox.run = async (spec, options) => {
    fs.rmSync(second.file)
    return run(spec, options)
  }
  assert.deepEqual((await again.runner.tick()).outcome, { ok: true, cause: null })
  assert.equal(fs.existsSync(second.file), false)
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), [])
  assert.deepEqual((await again.runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  assert.equal(entries.filter(entry => entry.event === 'runner.job_cancelled').length, 2)

  // A job removed while the runner was stopped leaves sessions, which the next start removes.
  await again.runner.close()
  fs.writeFileSync(path.join(paths.agentSessions('lifelog'), `lifelog-backfill-${job.id}-2026-11-07.jsonl`), '{}\n')
  fs.writeFileSync(path.join(paths.agentSessions('lifelog'), 'lifelog-2026-11-09.jsonl'), '{}\n')
  await startTestRunner(t, prepared)
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog')), ['lifelog-2026-11-09.jsonl'])
})

test('backfill: a stop after the last batch, or after the message, sends the message again and never loses it', async t => {
  const { prepared, runner, outbox } = await open(t)
  const { job, file } = await queue(prepared, ['lifelog', ...PEOPLE])
  for (let n = 0; n < 3; n++) await runner.tick()
  assert.equal(jobOn(file).progress.cursor, 5)
  await runner.close()
  // After the last batch: the message comes at the next start.
  const again = await startTestRunner(t, prepared)
  // After the message, before the file goes: the file's removal fails, and the runner stops.
  const rm = fs.rmSync
  fs.rmSync = (target, ...rest) => {
    if (target === file) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    return rm(target, ...rest)
  }
  try {
    await assert.rejects(again.runner.tick(), { code: 'EIO' })
  } finally {
    fs.rmSync = rm
  }
  await again.runner.close()
  const third = await startTestRunner(t, prepared)
  assert.deepEqual((await third.runner.tick()).action, { kind: 'backfill-finished', id: job.id })
  const text = `Backfill ${job.id} of lifelog finished: it was given 4 lines, and gave up on none.`
  assert.deepEqual(outbox(), [
    { type: 'text', by: 'runner', text },
    { type: 'text', by: 'runner', text },
  ])
  assert.equal(fs.existsSync(file), false)
})

test('backfill: a setup error pauses every run without a notice, and the items keep their attempts; a live failure after it sends its own', async t => {
  const { prepared, runner, clock, state, outbox, sandbox, add } = await open(t)
  const { job, file } = await queue(prepared, ['lifelog', ...PEOPLE])
  await runner.tick()
  sandbox.behave({ openrouter: 401 })
  assert.deepEqual((await runner.tick()).outcome, { ok: false, cause: 'setup' })
  assert.equal(state().paused.cause, 'setup')
  assert.deepEqual(
    jobOn(file).progress.retry.map(entry => [entry.seq, entry.attempts]),
    [
      [1, 0],
      [3, 0],
    ],
  )
  assert.deepEqual(outbox(), [])
  assert.deepEqual(state().lastRun, LAST_RUN)

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
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill', id: job.id }, outcome: { ok: true, cause: null } })
  assert.equal(state().paused, undefined)
  assert.deepEqual(jobOn(file).progress.retry, [])
  assert.deepEqual(jobOn(file).progress.cursor, 3)
})

test('backfill: jobs run one at a time, in the order they were written, a job of an agent given in a file among them, which runs in a folder of its own', async t => {
  const { prepared, runner, sandbox, paths, git, outbox } = await open(t, { lines: [line.text(6, '2026-11-09T15:00:00Z', 'tea')], state: { ...HANDLED, cursor: 6 } })
  const config = paths.configDir
  fs.writeFileSync(path.join(config, 'prompts', 'try.md'), 'You are a try.\n')
  const agentFile = path.join(prepared.root, 'try.yaml')
  fs.writeFileSync(
    agentFile,
    jobYaml()
      .replace('  lifelog:', '  lifelog-try:')
      .replace('prompts/lifelog.md', 'prompts/try.md')
      .replace('writes: [agents/lifelog/views/, agents/lifelog/memory/]', 'writes: [agents/lifelog-try/views/]')
      .replace('sends: [whatsapp]', 'sends: []'),
  )
  const first = await queue(prepared, ['lifelog', ...PEOPLE, '--from', '4'])
  await prepared.clock.advance(1)
  const second = await queue(prepared, ['--agent-file', agentFile, '--from', '2026-11-08'])
  assert.equal(second.file, path.join(paths.agentJobs('lifelog-try'), `${second.job.id}.json`))
  assert.ok(first.job.id < second.job.id)

  // The first: from #4, up to #6.
  for (let n = 0; n < 4; n++) await runner.tick()
  assert.deepEqual(itemsSeen(sandbox), [[4, 5], [6]])
  assert.equal(outbox({ take: true })[0].text, `Backfill ${first.job.id} of lifelog finished: it was given 3 lines, and gave up on none.`)

  // The second, in its own folder: made, with its own repository and its tag; its prompt and skills;
  // what it may change, its own; up to the newest line when it starts.
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-start', id: second.job.id })
  const tryDir = paths.agentDir('lifelog-try')
  const tryGit = (...args) => git('--git-dir', path.join(tryDir, '.git'), '--work-tree', tryDir, ...args)
  assert.equal(tryGit('log', '--format=%s'), 'lifelog-try: initial commit\n')
  assert.ok(tryGit('cat-file', 'tag', `before-backfill-${second.job.id}`).includes('\n\nThe agent, as given in its file:\n\nagents:\n  lifelog-try:\n'))
  assert.equal(jobOn(second.file, 'lifelog-try').progress.until, 6)
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  const call = sandbox.seen()[2]
  assert.deepEqual(call.items, [4, 5])
  assert.equal(call.systemPrompt, 'You are a try.\n')
  assert.equal(sessionOf(call), `lifelog-try-backfill-${second.job.id}-2026-11-08`)
  assert.deepEqual(sandbox.runs[2].spec.files.writes[0], { path: path.join(tryDir, 'views'), folder: true })
  assert.equal(sandbox.runs[2].spec.cwd, tryDir)
  assert.equal(tryGit('log', '-1', '--format=%s', '--name-only'), `lifelog-try: backfill ${second.job.id} #4-#5\n\nviews/notes.csv\n`)
  // lifelog's folder is as its job left it.
  assert.equal(git('log', '-1', '--format=%s'), `lifelog: backfill ${first.job.id} #6\n`)
  await runner.tick()
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-finished', id: second.job.id })
  assert.deepEqual(outbox({ take: true }), [{ type: 'text', by: 'runner', text: `Backfill ${second.job.id} of lifelog-try finished: it was given 3 lines, and gave up on none.` }])
  assert.deepEqual(fs.readdirSync(paths.agentSessions('lifelog-try')), [])
})

test("backfill: a job's file that isn't one, or a job that can't run as the config is now, is refused and logged once while it stays so, and the runner goes on with the next", async t => {
  const { prepared, runner, paths, entries, sandbox } = await open(t)
  const jobs = paths.agentJobs('lifelog')
  fs.mkdirSync(jobs, { recursive: true })
  const good = await queue(prepared, ['lifelog', ...PEOPLE])
  const base = jobOn(good.file)
  const named = n => path.join(jobs, `20261109T150${n}00000-0001.json`)
  const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  // Each sorts before the good one.
  write(named(1), '{"id": ')
  write(named(2), { ...base, id: '20261109T150200000-0001', progress: { started: base.written, until: 5, cursor: 2, given: 0, retry: [{ seq: 3, attempts: 1, due: base.written, reason: 'x' }], skipped: [] } })
  write(named(3), { ...base, id: '20261109T150300000-0001', skills: ['swimming'] })
  write(named(4), { ...base, id: '20261109T150400000-0001', writes: ['agents/lifelog/state.json'] })
  write(named(5), { ...base, id: '20261109T150500000-0001', prompt: 'Now: $nwo$' })
  write(named(6), { ...base, id: '20261109T150600000-0001', agent: 'lifelog-old', agentFile: null })
  fs.mkdirSync(named(7))
  fs.symlinkSync(good.file, named(8))
  write(path.join(jobs, '20261109T1500-notes.txt'), 'x')
  const fifo = named(9)
  const { spawnSync } = await import('node:child_process')
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
  // One of the agent's of agents.yaml that is now no agent of it.
  fs.mkdirSync(paths.agentJobs('lifelog-old'), { recursive: true })
  write(path.join(paths.agentJobs('lifelog-old'), '20261109T150000000-0001.json'), { ...base, id: '20261109T150000000-0001', agent: 'lifelog-old' })

  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-start', id: good.job.id })
  const refused = entries.filter(entry => entry.event === 'runner.job_refused')
  assert.deepEqual(refused.map(entry => entry.file).sort(), [...['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(n => `20261109T150${n}00000-0001.json`), '20261109T1500-notes.txt'].sort())
  for (const [file, reason] of [
    ['20261109T150100000-0001.json', /is not JSON$/],
    ['20261109T150200000-0001.json', /progress\.retry\[0\]\.seq is after the cursor$/],
    ['20261109T150300000-0001.json', /skills names swimming, which is no skill of lifelog$/],
    ['20261109T150400000-0001.json', /--writes 1 is agents\/lifelog\/state\.json, which isn't in the writes of lifelog/],
    ['20261109T150500000-0001.json', /its prompt holds \$nwo\$, which is no variable the runner knows/],
    ['20261109T150600000-0001.json', /agent is lifelog-old, where the file is in the folder of lifelog$/],
    ['20261109T150700000-0001.json', /EISDIR|not a regular file/],
    ['20261109T150800000-0001.json', /a symbolic link/],
    ['20261109T150900000-0001.json', /not a regular file/],
    ['20261109T1500-notes.txt', /is named as no job is/],
  ]) {
    assert.match(refused.find(entry => entry.file === file).reason, reason, file)
  }
  assert.match(refused.find(entry => entry.agent === 'lifelog-old').reason, /lifelog-old is no agent of agents\.yaml, which has lifelog$/)

  // While it holds a job, the runner takes no other. Once it is over, it looks again: those that
  // stay as they were aren't logged again; one that changed is looked at again.
  for (const kind of ['backfill', 'backfill', 'backfill-finished']) assert.equal((await runner.tick()).action.kind, kind)
  assert.deepEqual(itemsSeen(sandbox), [
    [1, 3],
    [4, 5],
  ])
  write(named(3), { ...base, id: '20261109T150300000-0001', skills: ['diving'] })
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  assert.deepEqual((await runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  const again = entries.filter(entry => entry.event === 'runner.job_refused').slice(11)
  assert.deepEqual(again.map(entry => entry.file), ['20261109T150300000-0001.json'])
  assert.match(again[0].reason, /skills names diving, which is no skill of lifelog$/)
})

test("backfill: a job's file too large, one the runner can't read, and an agent given in a file that isn't one, or names another, are refused too", async t => {
  const { prepared, runner, paths, entries } = await open(t)
  const good = await queue(prepared, ['lifelog', ...PEOPLE])
  const base = jobOn(good.file)
  const jobs = paths.agentJobs('lifelog')
  const named = n => path.join(jobs, `20261109T150${n}00000-0001.json`)
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value))
  write(named(1), { ...base, id: '20261109T150100000-0001', prompt: `Now: $now$${' '.repeat(4096)}` })
  atEnd(t, overrideLimits({ JOB_FILE_MAX_BYTES: 4096 }))
  // One the runner can't read: root reads every file.
  if (!isRoot) {
    write(named(2), { ...base, id: '20261109T150200000-0001' })
    fs.chmodSync(named(2), 0o000)
  }
  const tryJobs = paths.agentJobs('lifelog-try')
  fs.mkdirSync(tryJobs, { recursive: true })
  const agentFile = { ...base, agent: 'lifelog-try', skills: null, writes: null }
  write(path.join(tryJobs, '20261109T150300000-0001.json'), { ...agentFile, id: '20261109T150300000-0001', agentFile: 'agents:\n  lifelog-try: {}\n' })
  write(path.join(tryJobs, '20261109T150400000-0001.json'), { ...agentFile, id: '20261109T150400000-0001', agentFile: jobYaml().replace('  lifelog:', '  lifelog-other:').replace('writes: [agents/lifelog/views/, agents/lifelog/memory/]', 'writes: [agents/lifelog-other/views/]').replace('sends: [whatsapp]', 'sends: []') })
  // Folders an agent's jobs could be in that are no folders to read, passed over: one the runner
  // can't read, a file, and a link.
  fs.mkdirSync(paths.agentJobs('locked'), { recursive: true })
  write(path.join(paths.agentJobs('locked'), '20261109T150000000-0001.json'), { ...base, agent: 'locked', id: '20261109T150000000-0001' })
  fs.chmodSync(paths.agentJobs('locked'), 0o000)
  atEnd(t, () => fs.chmodSync(paths.agentJobs('locked'), 0o700))
  fs.mkdirSync(paths.agentDir('filed'))
  fs.writeFileSync(paths.agentJobs('filed'), 'x')
  fs.symlinkSync(jobs, path.join(paths.agents, 'linked'))
  assert.deepEqual((await runner.tick()).action, { kind: 'backfill-start', id: good.job.id })
  const reasons = Object.fromEntries(entries.filter(entry => entry.event === 'runner.job_refused').map(entry => [entry.file, entry.reason]))
  assert.match(reasons['20261109T150100000-0001.json'], /too large/)
  if (!isRoot) assert.match(reasons['20261109T150200000-0001.json'], /EACCES|permission denied/)
  assert.match(reasons['20261109T150300000-0001.json'], /its agentFile, line 2: agents\.lifelog-try\.model is missing/)
  assert.match(reasons['20261109T150400000-0001.json'], /its agentFile gives lifelog-other, where the job is of lifelog-try/)
  // Nothing of theirs was made: no folder for an agent given in a file that wasn't taken.
  assert.deepEqual(fs.readdirSync(paths.agentDir('lifelog-try')), ['jobs'])
})

test("backfill: a job's start gives way to a backup, as a run does, and changes nothing until the backup is over", async t => {
  const { prepared, runner, paths, git } = await open(t)
  const { job } = await queue(prepared, ['lifelog', ...PEOPLE, '--empty'])
  assert.equal(takeLock(paths.backupLock, { clock: prepared.clock }), true)
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill-start', id: job.id }, outcome: 'waiting' })
  assert.equal(git('tag', '-l'), '')
  assert.equal(jobOn(path.join(paths.agentJobs('lifelog'), `${job.id}.json`)).progress, null)
  assert.equal(fs.existsSync(paths.runLock), false)
  releaseLock(paths.backupLock)
  assert.deepEqual(await runner.tick(), { action: { kind: 'backfill-start', id: job.id }, outcome: 'started' })
  assert.equal(git('tag', '-l'), `before-backfill-${job.id}\n`)
})

test('backfill: a job file rewritten while the runner holds it is written over with the runner\'s own count, and logged; one replaced by something else is dropped and left alone', async t => {
  const { prepared, runner, entries, sandbox } = await open(t)
  const { file } = await queue(prepared, ['lifelog', ...PEOPLE])
  await runner.tick()
  const started = jobOn(file)
  // Rewritten to give the lines again from the start: the runner's count wins.
  fs.writeFileSync(file, JSON.stringify({ ...started, progress: { ...started.progress, cursor: 0 } }))
  await runner.tick()
  assert.deepEqual(jobOn(file).progress.cursor, 3)
  assert.ok(entries.some(entry => entry.event === 'runner.job_rewritten'))
  // Replaced by a folder during a batch: the batch is recorded, the job dropped, the folder left.
  const run = sandbox.run.bind(sandbox)
  sandbox.run = async (spec, options) => {
    fs.rmSync(file)
    fs.mkdirSync(file)
    return run(spec, options)
  }
  assert.deepEqual((await runner.tick()).outcome, { ok: true, cause: null })
  assert.ok(fs.statSync(file).isDirectory())
  assert.ok(entries.some(entry => entry.event === 'runner.job_replaced'))
  assert.deepEqual(itemsSeen(sandbox), [
    [1, 3],
    [4, 5],
  ])
})

test("backfill: a full disk when the job's file is saved after a batch stops the runner, and the batch is given again after the start", async t => {
  const { prepared, runner, sandbox } = await open(t)
  const { file } = await queue(prepared, ['lifelog', ...PEOPLE])
  await runner.tick()
  // The disk is full when the job is saved, after the commit: the runner stops, as when the state
  // can't be saved.
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === file) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' })
    return rename(from, to)
  }
  try {
    await assert.rejects(runner.tick(), { code: 'ENOSPC' })
  } finally {
    fs.renameSync = rename
  }
  assert.equal(jobOn(file).progress.cursor, 0)
  await runner.close()
  // Started again, with room: the batch again, once, and then the next.
  const again = await startTestRunner(t, prepared)
  assert.deepEqual((await again.runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual((await again.runner.tick()).outcome, { ok: true, cause: null })
  assert.deepEqual(itemsSeen(sandbox), [
    [1, 3],
    [1, 3],
    [4, 5],
  ])
  assert.equal(jobOn(file).progress.cursor, 5)
})

// ---------------------------------------------------------------------------------------------
// The parts

test("backfill: a batch's outcome settles the job's lane, as a live batch's settles the live one, and counts the lines given", () => {
  const progress = { started: '2026-11-09T15:00:00Z', until: 50, cursor: 10, given: 7, retry: [{ seq: 4, attempts: 3, due: '2026-11-09T15:00:00Z', reason: 'not marked' }], skipped: [2, 7] }
  assert.deepEqual(jobLane(progress), { cursor: 10, retry: progress.retry, failed: [{ seq: 2 }, { seq: 7 }] })
  // #4 on its fourth attempt, #7 brought back from skipped by an edit, and #11 to #13 new.
  const batch = {
    items: [
      { seq: 4, origin: 'retry', attempt: 4 },
      { seq: 7, origin: 'failed', attempt: 1 },
      { seq: 11, origin: 'new', attempt: 1 },
      { seq: 12, origin: 'new', attempt: 1 },
      { seq: 13, origin: 'new', attempt: 1 },
    ],
    settled: [],
    covered: 14,
  }
  const now = Date.parse('2026-11-09T15:50:00Z')
  const ok = settleJobBatch(progress, batch, { ok: true, done: new Set([7, 11]), failed: new Map([[12, "can't read it"]]) }, { now })
  assert.deepEqual(ok.progress, {
    started: '2026-11-09T15:00:00Z',
    until: 50,
    cursor: 14,
    given: 10,
    retry: [{ seq: 13, attempts: 1, due: '2026-11-09T15:51:00Z', reason: 'not marked' }],
    skipped: [2, 4, 12],
  })
  assert.deepEqual(ok.givenUp, [4])

  // An outage: every item waits, due at once, its attempts as they were; the lines are given all
  // the same, and counted once.
  const down = settleJobBatch(progress, batch, { ok: false, cause: 'outage', reason: "OpenRouter didn't answer" }, { now })
  assert.deepEqual(
    down.progress.retry.map(entry => [entry.seq, entry.attempts, entry.due]),
    [
      [4, 3, '2026-11-09T15:50:00Z'],
      [7, 0, '2026-11-09T15:50:00Z'],
      [11, 0, '2026-11-09T15:50:00Z'],
      [12, 0, '2026-11-09T15:50:00Z'],
      [13, 0, '2026-11-09T15:50:00Z'],
    ],
  )
  assert.deepEqual([down.progress.skipped, down.progress.given], [[2], 10])

  // A message deleted since it was given, which the batch settles, leaves the lane's retries, and
  // its skipped, whatever comes of the run.
  const withDeleted = { ...progress, retry: [...progress.retry, { seq: 9, attempts: 1, due: '2026-11-09T16:00:00Z', reason: 'not marked' }], skipped: [2, 7, 8] }
  for (const outcome of [{ ok: true, done: new Set([4, 7, 11, 12, 13]), failed: new Map() }, { ok: false, cause: 'other', reason: 'timed out' }]) {
    const deleted = settleJobBatch(withDeleted, { ...batch, settled: [8, 9] }, outcome, { now })
    assert.ok(!deleted.progress.retry.some(entry => entry.seq === 9))
    assert.ok(!deleted.progress.skipped.includes(8))
  }
})

test("backfill: the job's message names how many lines it was given and which it gave up on, and its tag's message what it was asked", () => {
  const job = {
    id: '20261123T101500123-0001',
    agent: 'lifelog',
    written: '2026-11-23T10:15:00Z',
    from: 812,
    skills: ['books'],
    writes: ['agents/lifelog/views/books.csv'],
    empty: false,
    holdLive: true,
    prompt: '# Books\nFile only $run.writes$.\n',
    agentFile: null,
    progress: { started: '2026-11-23T10:15:03Z', until: 1890, cursor: 1890, given: 1, retry: [], skipped: [] },
  }
  assert.equal(jobSummary(job), 'Backfill 20261123T101500123-0001 of lifelog finished: it was given 1 line, and gave up on none.')
  assert.equal(jobSummary({ ...job, progress: { ...job.progress, given: 143, skipped: [1207, 1031] } }), 'Backfill 20261123T101500123-0001 of lifelog finished: it was given 143 lines, and gave up on #1031 and #1207.')
  assert.equal(jobSummary({ ...job, progress: { ...job.progress, given: 3, skipped: [3, 1, 2] } }), 'Backfill 20261123T101500123-0001 of lifelog finished: it was given 3 lines, and gave up on #1, #2 and #3.')
  assert.equal(
    tagMessage(job),
    'Before backfill 20261123T101500123-0001 of lifelog, written 2026-11-23T10:15:00Z.\n\nFrom: #812\nSkills: books\nWrites: agents/lifelog/views/books.csv\nEmpty: no\nHold live: yes\n\nPrompt:\n\n# Books\nFile only $run.writes$.\n',
  )
  assert.equal(
    tagMessage({ ...job, skills: null, writes: null, empty: true, holdLive: false, prompt: null }),
    "Before backfill 20261123T101500123-0001 of lifelog, written 2026-11-23T10:15:00Z.\n\nFrom: #812\nSkills: the agent's\nWrites: the agent's\nEmpty: yes\nHold live: no\nPrompt: that of the agent's trigger for new messages, in agents.yaml\n",
  )
  assert.equal(
    tagMessage({ ...job, agent: 'lifelog-try', skills: null, writes: null, holdLive: false, prompt: null, agentFile: 'agents:\n  lifelog-try: {}\n' }),
    'Before backfill 20261123T101500123-0001 of lifelog-try, written 2026-11-23T10:15:00Z.\n\nFrom: #812\n\nThe agent, as given in its file:\n\nagents:\n  lifelog-try: {}\n',
  )
})

test('backfill: a job in progress whose config changed while the runner was stopped, its skill gone from agents.yaml, is refused at the next start, and nothing of it runs', async t => {
  const { prepared, runner, paths, entries } = await open(t)
  const { job } = await queue(prepared, ['lifelog', ...PEOPLE])
  await runner.tick()
  await runner.close()
  // The people skill gone from the config: the job can't run as it is now.
  writeConfig(paths.configDir, { yaml: jobYaml().replace('skills: [skills/expenses, skills/people]', 'skills: [skills/expenses]') })
  const again = await startTestRunner(t, prepared)
  assert.deepEqual((await again.runner.tick()).action, { kind: 'idle', reason: 'nothing' })
  assert.match(entries.filter(entry => entry.event === 'runner.job_refused').at(-1).reason, new RegExp(`${job.id}\\.json: skills names people, which is no skill of lifelog$`))
})
