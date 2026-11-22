// The runner's planning, end to end (milestone 3 of the plan): from datastore lines on disk, a
// `state.json` and a clock, the runner works out the next action, the batch and the prompt, and
// builds `run/` for it. Nothing is run.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { ensureAgentDir, prepareRun } from '../src/runner/agentdir.mjs'
import { buildBatch, buildTaskPrompt } from '../src/runner/batch.mjs'
import { loadConfig } from '../src/runner/config.mjs'
import { openDatastore } from '../src/runner/datastore.mjs'
import { createGit } from '../src/runner/git.mjs'
import { loadState, saveState, sessionId, startupState } from '../src/runner/state.mjs'
import { nextAction } from '../src/runner/triggers.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { EXAMPLE_NOW, EXAMPLE_PROMPT, exampleLines, exampleState, line, writeConfig, writeDatastore } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const SECOND = 1000
const SETTINGS = { timeZone: 'Asia/Kolkata', homeCurrency: 'INR', agentInternet: false, batchSeconds: 8, sessionRolloverHour: 4 }

function setup(t) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  writeConfig(paths.configDir)
  writeDatastore(paths, exampleLines())
  const stateFile = paths.agentState('lifelog')
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 })
  saveState(stateFile, exampleState())
  // Eight seconds before the example's time: the owner has just written.
  const clock = createFakeClock(Date.parse(EXAMPLE_NOW) - 8 * SECOND)
  const { log, events, entries } = createTestLog({ clock })
  // The prompt as pi would see it in Docker, where the data folder is /data.
  const asInDocker = text => text.replaceAll(paths.dataDir, '/data')
  return { root, paths, stateFile, clock, log, events, entries, asInDocker }
}

test('planning: from the datastore, the state and the clock to the next action, the batch and the prompt', async t => {
  const { paths, stateFile, clock, log, asInDocker } = setup(t)

  // What the runner does at startup.
  const { agents: [agent] } = loadConfig({ paths })
  await ensureAgentDir({ paths, name: agent.name, git: createGit({ proc: createProc({ log, clock }), dir: paths.agentDir(agent.name), discardDir: paths.agentDiscarded(agent.name), log, clock }), log })
  const started = startupState(loadState(stateFile), agent, { now: clock.now(), timeZone: SETTINGS.timeZone })
  saveState(stateFile, started.state)
  const datastore = openDatastore({ paths, clock })
  assert.equal(datastore.poll(), 1054)

  const ask = () =>
    nextAction({
      agent,
      state: loadState(stateFile),
      index: datastore.index,
      now: clock.now(),
      timeZone: SETTINGS.timeZone,
      batchSeconds: SETTINGS.batchSeconds,
      incomingSeenAt: datastore.incomingSeenAt,
    })

  // Everything there was seen at startup, so the owner counts as having just written.
  assert.deepEqual(ask(), { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND - 1)
  assert.deepEqual(ask(), { kind: 'idle', reason: 'quiet' })
  await clock.advance(1)
  assert.deepEqual(ask(), { kind: 'messages' })

  const { batch, prompt } = buildBatch({
    agent,
    state: loadState(stateFile),
    index: datastore.index,
    paths,
    now: clock.now(),
    timeZone: SETTINGS.timeZone,
    homeCurrency: SETTINGS.homeCurrency,
    internet: SETTINGS.agentInternet,
  })
  assert.equal(asInDocker(prompt), EXAMPLE_PROMPT)
  assert.deepEqual(batch.items.map(item => item.seq), [1047, 1050, 1051, 1052, 1053, 1054])
  assert.equal(batch.covered, 1054)

  // The run's folder, for the day's session.
  const session = sessionId(agent.name, { now: clock.now(), timeZone: SETTINGS.timeZone, rolloverHour: SETTINGS.sessionRolloverHour })
  assert.equal(session, 'lifelog-2026-11-09')
  // What pi appends to its system prompt is the agent's prompt, as the config folder has it, and
  // nothing else.
  const run = prepareRun({ paths, agent, index: datastore.index, sessionId: session })
  assert.equal(fs.readFileSync(run.promptFile, 'utf8'), 'You are lifelog.\n')
})

test('planning: a text such as /new is a message, which waits for the owner to be quiet and goes into the batch', async t => {
  const { paths, stateFile, clock } = setup(t)
  const { agents: [agent] } = loadConfig({ paths })
  const datastore = openDatastore({ paths, clock })
  datastore.poll()
  // The owner sends /new, then another message.
  writeDatastore(paths, [line.text(1055, '2026-11-09T15:50:25Z', '/new'), line.text(1056, '2026-11-09T15:50:26Z', 'start again')])
  await clock.advance(5 * SECOND)
  assert.equal(datastore.poll(), 2)

  const ask = () =>
    nextAction({ agent, state: loadState(stateFile), index: datastore.index, now: clock.now(), timeZone: SETTINGS.timeZone, batchSeconds: 8, incomingSeenAt: datastore.incomingSeenAt })
  assert.deepEqual(ask(), { kind: 'idle', reason: 'quiet' })
  await clock.advance(8 * SECOND)
  assert.deepEqual(ask(), { kind: 'messages' })
  const { batch, prompt } = buildBatch({ agent, state: loadState(stateFile), index: datastore.index, paths, now: clock.now(), timeZone: SETTINGS.timeZone, homeCurrency: 'INR', internet: false })
  assert.deepEqual(batch.items.map(item => item.seq), [1047, 1050, 1051, 1052, 1053, 1054, 1055, 1056])
  assert.equal(batch.covered, 1056)
  assert.match(prompt, /^#1055 21:20 text: "\/new"$/m)
  // Nothing was written but the datastore's lines: no reply, and the state as it was.
  assert.deepEqual(fs.existsSync(paths.outbox) ? fs.readdirSync(paths.outbox) : [], [])
  assert.deepEqual(loadState(stateFile), exampleState())
})

test('planning: the evening check-in comes due at 21:30, after the messages, with its own prompt', async t => {
  const { paths, stateFile, clock } = setup(t)
  const { agents: [agent] } = loadConfig({ paths })
  // The runner starts at 21:20; the check-in hasn't come due today.
  saveState(stateFile, startupState({ ...exampleState(), cursor: 1054, retry: [] }, agent, { now: clock.now(), timeZone: SETTINGS.timeZone }).state)
  const datastore = openDatastore({ paths, clock })
  datastore.poll()
  const ask = () =>
    nextAction({ agent, state: loadState(stateFile), index: datastore.index, now: clock.now(), timeZone: SETTINGS.timeZone, batchSeconds: 8, incomingSeenAt: datastore.incomingSeenAt })
  assert.deepEqual(ask(), { kind: 'idle', reason: 'nothing' })
  clock.set('2026-11-09T16:00:00Z')
  const action = ask()
  assert.equal(action.kind, 'scheduled')
  assert.deepEqual([action.at, action.date], ['21:30', '2026-11-09'])
  const prompt = buildTaskPrompt({ agent, task: action.task, paths, now: clock.now(), timeZone: SETTINGS.timeZone, homeCurrency: 'INR', internet: false })
  assert.match(
    prompt,
    /^\[scooter\] Now: Monday 9 November 2026, 21:30 \(Asia\/Kolkata\)\. .*\n.*\n\nScheduled task \(from your configuration, not a message from the owner\):\nEvening check-in\. List in a few lines what you filed today, mention anything that looks missing, and list the open questions\.$/,
  )
})

test('planning: the runner\'s view of the datastore notes when it last saw the owner, and stops on a damaged log', async t => {
  const { paths, clock } = setup(t)
  const datastore = openDatastore({ paths, clock })
  assert.equal(datastore.incomingSeenAt, null)
  datastore.poll()
  const first = clock.now()
  assert.equal(datastore.incomingSeenAt, first)
  // Something sent, or nothing new, isn't the owner.
  await clock.advance(30 * SECOND)
  writeDatastore(paths, [line.sent(1055, '2026-11-09T15:51:00Z', 'Noted.')])
  assert.equal(datastore.poll(), 1)
  assert.equal(datastore.poll(), 0)
  assert.equal(datastore.incomingSeenAt, first)
  // A message whose own time is far in the future, as an email's Date header can be, counts from
  // when it was seen.
  writeDatastore(paths, [line.email(1056, '2027-01-01T00:00:00Z', 'From the future', 'x', { day: '2026/11/09' })])
  datastore.poll()
  assert.equal(datastore.incomingSeenAt, clock.now())
  assert.equal(datastore.index.get(1056).number, 15)

  // A line that skips a seq is damage, and the message names where.
  writeDatastore(paths, [line.text(1058, '2026-11-09T15:52:00Z', 'skipped one')])
  assert.throws(() => datastore.poll(), new RegExp(`^DatastoreError: ${paths.dayLog('2026/11/09').replaceAll('/', '\\/')}, line 16: seq 1058 follows seq 1056`))
})
