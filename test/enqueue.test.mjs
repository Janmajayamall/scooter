// `scooter backfill`: its arguments, checked against `agents.yaml` and the datastore; the job's
// file it writes; and what it says, with its exit codes.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { holdInstance } from '../src/common/instance.mjs'
import { readJob } from '../src/common/jobfile.mjs'
import { limits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { BackfillError, parseArgs, queueJob, runBackfill } from '../src/runner/enqueue.mjs'
import { createFakeClock } from './support/clock.mjs'
import { exampleYaml, line, writeConfig, writeDatastore } from './support/runner.mjs'
import { runnerSettings } from './support/test-runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const modeOf = file => fs.statSync(file).mode & 0o7777

// Lines over three UTC days: 7, 9 and 10 November. No line was stored on the 8th.
const LINES = [
  line.text(1, '2026-11-07T07:00:00Z', 'lunch with sam'),
  line.text(2, '2026-11-07T12:00:00Z', 'call with ana'),
  { ...line.text(3, '2026-11-08T23:59:00Z', 'caught up late'), day: '2026/11/09' },
  line.text(4, '2026-11-09T10:00:00Z', 'coffee 120'),
  line.text(5, '2026-11-10T10:00:00Z', 'dinner'),
]

function setup(t, { lines = LINES, yaml = exampleYaml() } = {}) {
  const root = makeTestDir(t)
  const settings = runnerSettings(root)
  const paths = makePaths(settings)
  writeConfig(paths.configDir, { yaml })
  fs.mkdirSync(paths.datastore, { recursive: true })
  writeDatastore(paths, lines)
  const clock = createFakeClock('2026-11-10T12:00:00Z')
  const file = (name, text) => {
    const full = path.join(root, name)
    fs.writeFileSync(full, text)
    return full
  }
  // As the command runs where the runner's user isn't there, as in development, unless `users`
  // gives the users there are and `uid` who runs it.
  const run = async (args, { users = {}, uid = process.getuid?.(), docker = false } = {}) => {
    let out = ''
    let err = ''
    const proc = { findUser: async name => users[name] ?? null }
    const code = await runBackfill({ args, settings, clock, proc, uid, docker, stdout: { write: text => (out += text) }, stderr: { write: text => (err += text) } })
    return { code, out, err }
  }
  return { root, settings, paths, clock, file, run, queue: args => queueJob({ args, settings, clock }) }
}

const refusal = async (promise, lines) => {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BackfillError, error.stack)
    assert.deepEqual(error.problems, lines)
    return true
  })
}

test('backfill command: its command line, each fault at once', () => {
  assert.deepEqual(parseArgs(['lifelog', '--from', '2026-11-09', '--skills', 'books', 'people', '--writes', 'agents/lifelog/views/books.csv', 'agents/lifelog/views/people/', '--empty', '--hold-live', '--prompt', 'p.md']), {
    agent: 'lifelog',
    from: '2026-11-09',
    skills: ['books', 'people'],
    writes: ['agents/lifelog/views/books.csv', 'agents/lifelog/views/people/'],
    empty: true,
    holdLive: true,
    prompt: 'p.md',
    agentFile: null,
  })
  assert.deepEqual(parseArgs(['--agent-file', 'try.yaml', '--from', '812']), { agent: null, from: '812', skills: null, writes: null, empty: false, holdLive: false, prompt: null, agentFile: 'try.yaml' })
  // `--from` and `--prompt` take one value: what follows is the agent's name.
  assert.equal(parseArgs(['--from', '812', 'lifelog']).agent, 'lifelog')
  const faults = args => {
    try {
      parseArgs(args)
      return []
    } catch (error) {
      assert.ok(error instanceof BackfillError)
      return error.problems
    }
  }
  assert.deepEqual(faults([]), ['name the agent to run, such as lifelog, or give one in a file with --agent-file'])
  assert.deepEqual(faults(['lifelog', 'other']), ['name one agent; it was given lifelog other'])
  assert.deepEqual(faults(['lifelog', '--reset', '--from']), ['--reset is no flag of scooter backfill', '--from needs a value'])
  assert.deepEqual(faults(['lifelog', '--skills', '--empty', '--empty']), ['--skills needs one value or more', '--empty is given twice'])
  assert.deepEqual(faults(['lifelog', '--skills', 'books', 'books']), ['--skills names books twice'])
  assert.deepEqual(faults(['lifelog', '--agent-file', 'try.yaml', '--skills', 'books', '--writes', 'x', '--empty', '--hold-live', '--prompt', 'p.md']), [
    'with --agent-file, the agent is the file\'s: name no other, as lifelog',
    "--skills can't go with --agent-file, whose file gives the agent's own skills, writes and prompts",
    "--writes can't go with --agent-file, whose file gives the agent's own skills, writes and prompts",
    "--empty can't go with --agent-file, whose file gives the agent's own skills, writes and prompts",
    "--hold-live can't go with --agent-file, whose file gives the agent's own skills, writes and prompts",
    "--prompt can't go with --agent-file, whose file gives the agent's own skills, writes and prompts",
  ])
})

test('backfill command: it writes the job into the agent\'s folder, whole, 0600, and says where; the runner takes it at its next look', async t => {
  const { paths, run } = setup(t)
  const { code, out, err } = await run(['lifelog', '--skills', 'people', '--writes', 'agents/lifelog/views/people.csv', 'agents/lifelog/views/people.csv/../people/'])
  assert.equal(code, 2)
  assert.match(err, /^scooter backfill: --writes 2 must be a path in the data folder/)
  assert.equal(out, '')
  assert.equal(fs.existsSync(paths.agentJobs('lifelog')), false)

  const done = await run(['lifelog', '--skills', 'people', '--writes', 'agents/lifelog/views/people.csv', '--hold-live'])
  assert.equal(done.code, 0)
  assert.equal(done.err, '')
  const id = '20261110T120000000-0001'
  const file = path.join(paths.agentJobs('lifelog'), `${id}.json`)
  assert.equal(done.out, `Queued backfill ${id} of lifelog, from #1: ${file}\nThe runner isn't running: it takes it when it starts. Remove the file to cancel it.\n`)
  assert.deepEqual(readJob(file, { agent: 'lifelog' }).job, {
    id,
    agent: 'lifelog',
    written: '2026-11-10T12:00:00Z',
    from: 1,
    skills: ['people'],
    writes: ['agents/lifelog/views/people.csv'],
    empty: false,
    holdLive: true,
    prompt: null,
    agentFile: null,
    progress: null,
  })
  assert.equal(modeOf(file), 0o600)
  assert.equal(modeOf(paths.agentJobs('lifelog')), 0o700)
  // Nothing else is left in the folder.
  assert.deepEqual(fs.readdirSync(paths.agentJobs('lifelog')), [`${id}.json`])

  // With the runner running; and a second command in the same millisecond gets a name of its own.
  fs.mkdirSync(paths.runner, { recursive: true })
  const runner = await holdInstance(paths.runnerSocket, 'runner')
  atEnd(t, () => runner.close())
  const second = await run(['lifelog'])
  const next = path.join(paths.agentJobs('lifelog'), '20261110T120000000-0002.json')
  assert.equal(second.out, `Queued backfill 20261110T120000000-0002 of lifelog, from #1: ${next}\nThe runner takes it at its next look. Remove the file to cancel it.\n`)
  assert.equal(fs.readdirSync(paths.agentJobs('lifelog')).length, 2)
})

test('backfill command: a name taken, as by a command run in the same millisecond, gives the job the next ID', async t => {
  const { paths, queue } = setup(t)
  const first = await queue(['lifelog'])
  // Another command, with the same clock, makes the same first ID.
  const second = await queue(['lifelog'])
  assert.equal(first.job.id, '20261110T120000000-0001')
  assert.equal(second.job.id, '20261110T120000000-0002')
  assert.equal(readJob(second.file, { agent: 'lifelog' }).job.id, second.job.id)
  assert.deepEqual(fs.readdirSync(paths.agentJobs('lifelog')).sort(), ['20261110T120000000-0001.json', '20261110T120000000-0002.json'])
})

test('backfill command: --from is the day folder a line was stored in, or the first after it, or a seq; past the newest line is refused', async t => {
  const { queue } = setup(t)
  const from = async value => (await queue(['lifelog', '--from', value])).job.from
  assert.equal((await queue(['lifelog'])).job.from, 1)
  assert.equal(await from('2026-11-07'), 1)
  // No line was stored on the 8th: the first after it. The line caught up late, whose own time is
  // the 8th, is in the 9th's folder, and is the first of that day.
  assert.equal(await from('2026-11-08'), 3)
  assert.equal(await from('2026-11-09'), 3)
  assert.equal(await from('2026-01-01'), 1)
  assert.equal(await from('4'), 4)
  assert.equal(await from('5'), 5)
  await refusal(queue(['lifelog', '--from', '6']), ['--from #6 is past the newest line: the newest line is #5, stored on 2026-11-10'])
  await refusal(queue(['lifelog', '--from', '2026-11-11']), ['--from 2026-11-11: no line was stored on or after it; the newest line is #5, stored on 2026-11-10'])
  for (const value of ['0', '1.5', '-3', 'today', '2026-11-31', '9007199254740993']) {
    await assert.rejects(queue(['lifelog', '--from', value]), BackfillError, value)
  }
})

test('backfill command: an empty datastore takes no --from, and a job from the first line', async t => {
  const { queue } = setup(t, { lines: [] })
  assert.equal((await queue(['lifelog'])).job.from, 1)
  await refusal(queue(['lifelog', '--from', '1']), ['--from #1 is past the newest line: the datastore holds no line yet'])
})

test('backfill command: an agent of agents.yaml, its skills and its writes, each fault at once', async t => {
  const { queue } = setup(t)
  await refusal(queue(['lifelog-old']), ['agents.yaml has no agent called lifelog-old; it has lifelog'])
  await refusal(queue(['lifelog', '--skills', 'books', 'people', 'swimming', '--writes', 'datastore/', 'agents/lifelog/views/a.csv']), [
    '--skills names books, which is no skill of lifelog: its skills are expenses, runs, meals, travel, people',
    '--skills names swimming, which is no skill of lifelog: its skills are expenses, runs, meals, travel, people',
    "--writes 1 is datastore/, which isn't in the writes of lifelog: a job may change only what its agent may",
  ])
})

test('backfill command: --prompt is read now, kept in the job, and checked as a trigger\'s prompt is, with the job\'s writes', async t => {
  const { queue, file, root } = setup(t)
  const text = '# People\nFile only what belongs in $run.writes$. It costs $5.\nNew: $seq.unread$\n'
  const { job } = await queue(['lifelog', '--prompt', file('p.md', `\uFEFF${text}`)])
  assert.equal(job.prompt, text)

  const faults = async (name, contents, extra = []) => {
    const given = contents === null ? path.join(root, name) : file(name, contents)
    try {
      await queue(['lifelog', ...extra, '--prompt', given])
      return []
    } catch (error) {
      assert.ok(error instanceof BackfillError, error.stack)
      return error.problems.map(problem => problem.replace(given, '<file>'))
    }
  }
  assert.deepEqual(await faults('none.md', null), ['--prompt <file> can\'t be read (ENOENT)'])
  fs.mkdirSync(path.join(root, 'folder.md'))
  assert.deepEqual(await faults('folder.md', null), ["--prompt <file> isn't a file"])
  assert.deepEqual(await faults('latin1.md', Buffer.from([0x63, 0x61, 0x66, 0xe9])), ["--prompt <file> isn't text in UTF-8"])
  assert.deepEqual(await faults('big.md', 'x'.repeat(limits.PROMPT_MAX_BYTES + 1)), [`--prompt <file> is ${limits.PROMPT_MAX_BYTES + 1} bytes, where it can be ${limits.PROMPT_MAX_BYTES} at most`])
  assert.deepEqual(await faults('blank.md', '  \n'), ['--prompt <file> must be the message pi is given for the run, as text'])
  assert.deepEqual(await faults('at.md', '@views/people.csv'), ['--prompt <file> starts with @, which makes pi take the whole prompt as the name of a file to attach: start it with anything else'])
  assert.match((await faults('nwo.md', 'Now: $nwo$'))[0], /^--prompt <file> holds \$nwo\$, which is no variable the runner knows: they are \$now\$, /)
  assert.deepEqual(await faults('nul.md', 'a\0b'), ["--prompt <file> holds the character U+0000, which a command line can't carry"])
  // A prompt that fits with the agent's writes, but not with the job's, here many long names.
  const writes = Array.from({ length: 450 }, (_, n) => `agents/lifelog/views/${'f'.repeat(200)}-${n}.csv`)
  assert.deepEqual(await faults('fits.md', '$run.writes$'), [])
  assert.match((await faults('long.md', '$run.writes$', ['--writes', ...writes]))[0], /^--prompt <file> can make a prompt of \d+ bytes, filled in with the longest values its variables can take, where pi can be given 98304 at most/)
  // Without --prompt, the trigger's prompt is held to the job's writes too.
  await assert.rejects(queue(['lifelog', '--writes', ...writes]), error => {
    assert.match(error.problems[0], /^the prompt of the trigger for new messages from whatsapp and email, given what --writes names, can make a prompt of \d+ bytes/)
    return true
  })
})

test('backfill command: an agent given in a file, read now and kept in the job, in a folder of its own, which it makes', async t => {
  const { queue, file, paths } = setup(t)
  const own = exampleYaml()
    .replace('  lifelog:', '  lifelog-try:')
    .replace('writes: [agents/lifelog/views/, agents/lifelog/memory/]', 'writes: [agents/lifelog-try/views/]')
    .replace('sends: [whatsapp]', 'sends: []')
  const given = file('try.yaml', own)
  const { job, file: written } = await queue(['--agent-file', given, '--from', '2026-11-09'])
  assert.equal(written, path.join(paths.agentJobs('lifelog-try'), `${job.id}.json`))
  assert.deepEqual([job.agent, job.from, job.agentFile, job.skills, job.writes, job.prompt, job.empty, job.holdLive], ['lifelog-try', 3, own, null, null, null, false, false])
  assert.equal((fs.statSync(paths.agentDir('lifelog-try')).mode & 0o777), 0o700)

  const faults = async text => {
    const name = file('bad.yaml', text)
    try {
      await queue(['--agent-file', name])
      return []
    } catch (error) {
      assert.ok(error instanceof BackfillError, error.stack)
      return error.problems.map(problem => problem.replace(name, '<file>'))
    }
  }
  assert.deepEqual(await faults(own.replace('sends: []', 'sends: [whatsapp]').replace('writes: [agents/lifelog-try/views/]', 'writes: [agents/lifelog/views/]')), [
    "<file>, line 15: agents.lifelog-try.writes[0] is agents/lifelog/views/, which isn't in agents/lifelog-try/: an agent given in a file writes only in its own folder",
    '<file>, line 16: agents.lifelog-try.sends must be []: an agent given in a file sends nothing',
  ])
  assert.deepEqual(await faults(exampleYaml()), [
    '<file>, line 3: agents.lifelog is the name of an agent of agents.yaml: an agent given in a file needs a name of its own, and runs in a folder of its own',
    '<file>, line 16: agents.lifelog.sends must be []: an agent given in a file sends nothing',
  ])
  assert.deepEqual(await faults('agents: ['), ['<file>, line 1: Flow sequence in block collection must be sufficiently indented and end with a ]'])
  await refusal(queue(['--agent-file', path.join(paths.dataDir, 'none.yaml')]), [`--agent-file ${path.join(paths.dataDir, 'none.yaml')} can't be read (ENOENT)`])
  const big = file('big.yaml', 'x'.repeat(limits.JOB_AGENT_FILE_MAX_BYTES + 1))
  await refusal(queue(['--agent-file', big]), [`--agent-file ${big} is ${limits.JOB_AGENT_FILE_MAX_BYTES + 1} bytes, where it can be ${limits.JOB_AGENT_FILE_MAX_BYTES} at most`])
})

test('backfill command: its exit codes: 2 for a call or a configuration it can\'t take, with the usage when given nothing; 1 for a datastore it can\'t read', async t => {
  const { run, paths } = setup(t)
  const nothing = await run([])
  assert.equal(nothing.code, 2)
  assert.equal(
    nothing.err,
    'scooter backfill: name the agent to run, such as lifelog, or give one in a file with --agent-file\nUsage:\n  scooter backfill <agent> [--from <UTC date or seq>] [--skills <names>] [--writes <paths>] [--empty] [--hold-live] [--prompt <file>]\n  scooter backfill --agent-file <file> [--from <UTC date or seq>]\n',
  )
  fs.writeFileSync(paths.agentsYaml, exampleYaml().replace('reply_mode: quiet', 'reply_mode: chatty'))
  const config = await run(['lifelog'])
  assert.equal(config.code, 2)
  assert.match(config.err, /^scooter backfill: .*agents\.yaml, line 18: agents\.lifelog\.reply_mode must be quiet or confirm\n$/)
  fs.writeFileSync(paths.agentsYaml, exampleYaml())
  fs.appendFileSync(paths.dayLog('2026/11/10'), '{"seq": 6, "half\n')
  const damaged = await run(['lifelog'])
  assert.equal(damaged.code, 1)
  assert.match(damaged.err, /^scooter backfill: .*2026\/11\/10\/log\.jsonl, line 2: /)
  assert.equal(fs.existsSync(paths.agentJobs('lifelog')), false)
})

test("backfill command: it runs as the runner's user where that user is there, refusing any other before it reads or makes anything, and says how", async t => {
  const { run, paths } = setup(t)
  const users = { 'scooter-runner': { uid: 997, gid: 997 } }
  // As root, or any user but the runner's: refused, exit 2, naming the command to run, and nothing
  // read or made, so not the fault of agents.yaml either.
  fs.writeFileSync(paths.agentsYaml, exampleYaml().replace('reply_mode: quiet', 'reply_mode: chatty'))
  for (const uid of [0, 1000]) {
    const refused = await run(['lifelog', '--empty'], { users, uid })
    assert.equal(refused.code, 2)
    assert.equal(refused.err, `scooter backfill: backfill writes the job into the runner's folder, so it runs as scooter-runner, not as uid ${uid}: sudo -u scooter-runner scooter backfill …\n`)
    assert.equal(refused.out, '')
  }
  const docker = await run(['lifelog'], { users: { 'scooter-runner': { uid: 10002, gid: 10002 } }, uid: 0, docker: true })
  assert.equal(docker.code, 2)
  assert.match(docker.err, /, not as uid 0: docker compose run --rm runner backfill …\n$/)
  assert.equal((await run([], { users, uid: 0 })).code, 2)
  assert.equal(fs.existsSync(paths.agentDir('lifelog')), false)
  assert.equal(fs.existsSync(paths.agents), false)

  // As the runner's user, and where that user isn't there, as in development: it runs.
  fs.writeFileSync(paths.agentsYaml, exampleYaml())
  const own = await run(['lifelog'], { users, uid: 997 })
  assert.equal(own.code, 0, own.err)
  const none = await run(['lifelog'], { users: {}, uid: 0 })
  assert.equal(none.code, 0, none.err)
  assert.equal(fs.readdirSync(paths.agentJobs('lifelog')).length, 2)
})
