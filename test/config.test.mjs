// The agents' configuration: the example config is read
// as it stands, and each validation error names the field, and its line.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makePaths } from '../src/common/paths.mjs'
import { limits } from '../src/common/limits.mjs'
import { ConfigError, RUNNER_SKILL, loadConfig, parseConfig } from '../src/runner/config.mjs'
import { longestValues } from '../src/runner/prompt.mjs'
import { CHECK_IN_PROMPT, NEW_MESSAGES_PROMPT, SKILLS, exampleYaml, writeConfig } from './support/runner.mjs'
import { skipIfRoot } from './support/root.mjs'
import { makeTestDir } from './support/tmp.mjs'

function setup(t, options) {
  const root = makeTestDir(t)
  const configDir = writeConfig(path.join(root, 'config'), options)
  const parse = text => parseConfig(text, { configDir, file: 'agents.yaml' })
  // The messages of the faults `text` has.
  const faults = text => {
    try {
      parse(text)
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      return error.problems
    }
    assert.fail('the config was accepted')
  }
  return { root, configDir, parse, faults }
}

// The runner's settings that fill in a prompt's variables.
const SETTINGS = { timeZone: 'Asia/Kolkata', homeCurrency: 'INR', agentInternet: false }

// The example's text with one setting's line changed: `key: old value` becomes `key: value`.
const change = (text, key, value) => text.replace(new RegExp(`^(\\s*)${key}:.*$`, 'm'), `$1${key}: ${value}`)

test('config: the example config is read as it stands', t => {
  const { configDir, parse } = setup(t)
  const { agents } = parse(exampleYaml({ backfill: true }))
  assert.equal(agents.length, 1)
  const [agent] = agents
  const real = fs.realpathSync(configDir)
  assert.deepEqual(agent, {
    name: 'lifelog',
    model: 'anthropic/claude-sonnet-5.5',
    thinking: 'low',
    prompt: { path: 'prompts/lifelog.md', file: path.join(real, 'prompts/lifelog.md') },
    skills: SKILLS.map(name => ({ name, path: `skills/${name}`, dir: path.join(real, 'skills', name) })),
    reads: ['datastore/', 'agents/lifelog/'],
    writes: ['agents/lifelog/views/', 'agents/lifelog/memory/'],
    repository: ['views/', 'memory/'],
    sends: ['whatsapp'],
    channels: ['whatsapp', 'email'],
    session: 'daily',
    replyMode: 'quiet',
    ackReaction: '✅',
    timeoutMinutes: 10,
    run: {
      newMessages: [{ channels: ['whatsapp', 'email'], prompt: NEW_MESSAGES_PROMPT }],
      scheduled: [{ at: '21:30', schedule: { weekday: null, hour: 21, minute: 30 }, prompt: CHECK_IN_PROMPT }],
      backfill: [{ id: 'people-1', skill: 'people', writes: ['agents/lifelog/views/people.csv'] }],
    },
  })
})

test('config: what else is accepted', t => {
  const { parse } = setup(t)
  const base = exampleYaml()
  // `thinking` may be left out; `ack_reaction` may be "" or one emoji of several code points.
  assert.equal(parse(base.replace(/^\s*thinking:.*\n/m, '')).agents[0].thinking, null)
  assert.equal(parse(change(base, 'ack_reaction', '""')).agents[0].ackReaction, '')
  assert.equal(parse(change(base, 'ack_reaction', '"👍🏽"')).agents[0].ackReaction, '👍🏽')
  assert.equal(parse(change(base, 'ack_reaction', '"❤️"')).agents[0].ackReaction, '❤️')
  assert.equal(parse(change(base, 'ack_reaction', '"🇮🇳"')).agents[0].ackReaction, '🇮🇳')
  assert.equal(parse(change(base, 'ack_reaction', '"1️⃣"')).agents[0].ackReaction, '1️⃣')
  // Models of other forms in pi's catalog.
  for (const model of ['~anthropic/claude-sonnet-latest', 'google/gemma-3-4b-it:free', 'anthropic/claude-sonnet-5.5:batch']) {
    assert.equal(parse(change(base, 'model', model)).agents[0].model, model)
  }
  // reads, writes and sends, which may be empty, and reads, which may be left out.
  assert.deepEqual(parse(change(base, 'reads', '[datastore/2026/]')).agents[0].reads, ['datastore/2026/'])
  assert.deepEqual(parse(base.replace(/^\s*reads:.*\n/m, '')).agents[0].reads, ['datastore/', 'agents/lifelog/'])
  for (const key of ['reads', 'writes', 'sends']) assert.deepEqual(parse(change(base, key, '[]')).agents[0][key], [], key)
  assert.deepEqual(parse(change(base, 'sends', '[email, whatsapp]')).agents[0].sends, ['email', 'whatsapp'])
  // An unquoted time is a string in YAML 1.2, not a number of minutes as in YAML 1.1.
  const runs = `    run:
      - at: 09:05
        prompt: Morning.
      - at: Sun 18:00
        prompt: Weekly review.
      - backfill: people-1
        skill: people
        writes: [agents/lifelog/views/people.csv, agents/lifelog/views/people/]
`
  const { run, channels } = parse(base.replace(/    run:[\s\S]*$/, runs)).agents[0]
  assert.deepEqual(run.newMessages, [])
  assert.deepEqual(channels, [])
  assert.deepEqual(
    run.scheduled.map(entry => [entry.at, entry.schedule]),
    [
      ['09:05', { weekday: null, hour: 9, minute: 5 }],
      ['Sun 18:00', { weekday: 7, hour: 18, minute: 0 }],
    ],
  )
  assert.deepEqual(run.backfill, [{ id: 'people-1', skill: 'people', writes: ['agents/lifelog/views/people.csv', 'agents/lifelog/views/people/'] }])
  // Paths are cleaned: a leading ./ and a trailing / don't matter.
  const agent = parse(base.replace('prompt: prompts/lifelog.md', 'prompt: ./prompts//lifelog.md').replace('- skills/runs', '- skills/runs/')).agents[0]
  assert.equal(agent.prompt.path, 'prompts/lifelog.md')
  assert.equal(agent.skills[1].path, 'skills/runs')
})

test('config: each validation error names the field, and its line', t => {
  const { faults } = setup(t)
  const base = exampleYaml()
  const cases = [
    // [what the file says, the field, what the message says]
    [change(base, 'model', 'not a model'), 'agents.lifelog.model', /must be an OpenRouter model ID/],
    [change(base, 'model', 'anthropic/claude-sonnet-5.5:online'), 'agents.lifelog.model', /must not be an :online model/],
    [change(base, 'thinking', 'extreme'), 'agents.lifelog.thinking', /must be off, minimal, low, medium, high, xhigh or max/],
    [change(base, 'prompt', 'prompts/nope.md'), 'agents.lifelog.prompt', /names prompts\/nope.md, which isn't in the config folder/],
    [change(base, 'prompt', '/etc/passwd'), 'agents.lifelog.prompt', /must be relative to the config folder/],
    [change(base, 'prompt', '../outside.md'), 'agents.lifelog.prompt', /must name something inside the config folder/],
    [change(base, 'prompt', 'prompts'), 'agents.lifelog.prompt', /names prompts, which isn't a file/],
    [change(base, 'prompt', '42'), 'agents.lifelog.prompt', /must be a path inside the config folder/],
    [change(base, 'skills', 'skills/expenses'), 'agents.lifelog.skills', /must be a list of skill folders/],
    [base.replace('- skills/runs', '- skills/swimming'), 'agents.lifelog.skills[1]', /names skills\/swimming, which isn't in the config folder/],
    [base.replace('- skills/runs', '- prompts/lifelog.md'), 'agents.lifelog.skills[1]', /names prompts\/lifelog.md, which isn't a folder/],
    [base.replace('- skills/runs', '- prompts'), 'agents.lifelog.skills[1]', /names prompts, which has no SKILL.md/],
    [base.replace('- skills/runs', '- skills/expenses'), 'agents.lifelog.skills[1]', /names a skill called expenses, as skills\[0\] does/],
    [change(base, 'reads', 'datastore/'), 'agents.lifelog.reads', /must be a list of paths in the data folder, such as \[datastore\/\]/],
    [change(base, 'writes', '[agents/lifelog/views/, agents/lifelog/views]'), 'agents.lifelog.writes[1]', /is agents\/lifelog\/views, which writes\[0\] names too/],
    [change(base, 'writes', '[agents/lifelog/notes.md, agents/lifelog/notes.md/x]'), 'agents.lifelog.writes[1]', /is agents\/lifelog\/notes.md\/x, which lies in agents\/lifelog\/notes.md, a file/],
    [change(base, 'sends', '[sms]'), 'agents.lifelog.sends', /must list whatsapp or email, or both, once each, or be \[\] for none/],
    [change(base, 'sends', '[email, email]'), 'agents.lifelog.sends', /once each/],
    [change(base, 'sends', 'whatsapp'), 'agents.lifelog.sends', /must list whatsapp or email/],
    [change(base, 'session', 'weekly'), 'agents.lifelog.session', /must be daily or none/],
    [change(base, 'reply_mode', 'loud'), 'agents.lifelog.reply_mode', /must be quiet or confirm/],
    [change(base, 'ack_reaction', 'ok'), 'agents.lifelog.ack_reaction', /must be one emoji, such as "✅", or "" for none/],
    [change(base, 'ack_reaction', '"✅✅"'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [change(base, 'ack_reaction', '~'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    // One grapheme, but a letter, a digit or a sign, not an emoji.
    [change(base, 'ack_reaction', 'k'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [change(base, 'ack_reaction', '"7"'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [change(base, 'ack_reaction', '"é"'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [base.replace('    session:', '    can_message: true\n    session:'), 'agents.lifelog.can_message', /is not a setting of an agent/],
    [change(base, 'timeout_minutes', '0'), 'agents.lifelog.timeout_minutes', /must be a whole number of minutes from 1 to 120/],
    [change(base, 'timeout_minutes', '121'), 'agents.lifelog.timeout_minutes', /from 1 to 120/],
    [change(base, 'timeout_minutes', '1.5'), 'agents.lifelog.timeout_minutes', /from 1 to 120/],
    [base.replace('    model:', '    modle:'), 'agents.lifelog.modle', /is not a setting of an agent/],
    [base.replace(/^\s*session:.*\n/m, ''), 'agents.lifelog.session', /is missing/],
    [base.replace(/^\s*writes:.*\n/m, ''), 'agents.lifelog.writes', /is missing/],
    [base.replace(/^\s*sends:.*\n/m, ''), 'agents.lifelog.sends', /is missing/],
    [base.replace('lifelog:', 'Lifelog:'), 'agents.Lifelog', /is not a name for an agent/],
    // The names Scooter's own messages carry.
    [base.replace('lifelog:', 'runner:').replaceAll('agents/lifelog/', 'agents/runner/'), 'agents.runner', /is not a name for an agent: runner or bridge is the name of Scooter's own messages/],
    [base.replace('lifelog:', 'bridge:').replaceAll('agents/lifelog/', 'agents/bridge/'), 'agents.bridge', /is not a name for an agent/],
    [`${base}  other:\n    model: x/y\n`, 'agents', /must hold exactly one agent in this version; it holds 2/],
    [`${base}extra: 1\n`, 'extra', /is not a setting of agents.yaml/],
    ['agents: []\n', 'agents', /must be a map of agents by name/],
    ['', 'agents', /is missing/],
  ]
  for (const [text, field, message] of cases) {
    const problems = faults(text)
    const problem = problems.find(candidate => candidate.field === field)
    assert.ok(problem, `${field}: ${JSON.stringify(problems)}`)
    assert.match(problem.message, message, field)
    // The message names the field, and the file and the line when there is one.
    assert.ok(problem.message.includes(field), problem.message)
    assert.match(problem.message, /^agents\.yaml(, line \d+)?: /, problem.message)
  }

  // The line is the field's own.
  const problems = faults(change(base, 'session', 'weekly'))
  const lineOfSession = base.split('\n').findIndex(text => text.includes('session:')) + 1
  assert.equal(problems[0].line, lineOfSession)
  assert.equal(problems[0].message, `agents.yaml, line ${lineOfSession}: agents.lifelog.session must be daily or none`)
})

test('config: each error in `run` names the entry and the field', t => {
  const { faults } = setup(t)
  const base = exampleYaml()
  const withRun = entries => base.replace(/    run:[\s\S]*$/, `    run:\n${entries}`)
  const cases = [
    ['    run: new-messages\n', 'agents.lifelog.run', /must be a list of when the agent runs/],
    ['      - new-messages\n', 'agents.lifelog.run[0]', /must be a map with one of on, at or backfill/],
    ['      - on: new-messages\n        at: "21:30"\n', 'agents.lifelog.run[0]', /must have exactly one of on, at or backfill/],
    ['      - prompt: Something.\n', 'agents.lifelog.run[0]', /must have exactly one of/],
    ['      - on: old-messages\n        channels: [whatsapp]\n        prompt: New.\n', 'agents.lifelog.run[0].on', /must be new-messages/],
    ['      - on: new-messages\n', 'agents.lifelog.run[0].channels', /is missing/],
    ['      - on: new-messages\n        channels: [whatsapp]\n', 'agents.lifelog.run[0].prompt', /is missing/],
    ['      - on: new-messages\n        channels: [whatsapp]\n        task: New.\n', 'agents.lifelog.run[0].task', /doesn't belong with on/],
    ['      - on: new-messages\n        channels: []\n        prompt: New.\n', 'agents.lifelog.run[0].channels', /must list whatsapp or email, or both, once each$/],
    ['      - on: new-messages\n        channels: [sms]\n', 'agents.lifelog.run[0].channels', /must list whatsapp or email/],
    ['      - on: new-messages\n        channels: [email, email]\n', 'agents.lifelog.run[0].channels', /once each/],
    [
      '      - on: new-messages\n        channels: [whatsapp, email]\n        prompt: One.\n      - on: new-messages\n        channels: [email]\n        prompt: Two.\n',
      'agents.lifelog.run[1].channels',
      /names email, which agents\.lifelog\.run\[0\]\.channels names too: a channel starts the runs of one trigger at most/,
    ],
    ['      - at: "25:00"\n        prompt: Late.\n', 'agents.lifelog.run[0].at', /must be a time as "HH:MM", or a weekday and a time as "Sun 18:00"/],
    ['      - at: "sun 18:00"\n        prompt: Weekly.\n', 'agents.lifelog.run[0].at', /must be a time/],
    ['      - at: "21:30"\n        prompt: One.\n      - at: "21:30"\n        prompt: Two.\n', 'agents.lifelog.run[1].at', /is 21:30, which another entry has too/],
    ['      - at: "21:30"\n', 'agents.lifelog.run[0].prompt', /is missing/],
    ['      - at: "21:30"\n        prompt: "  "\n', 'agents.lifelog.run[0].prompt', /must be the message pi is given for the run, as text/],
    ['      - at: "21:30"\n        task: Check in.\n', 'agents.lifelog.run[0].task', /doesn't belong with at/],
    ['      - at: "21:30"\n        prompt: Check in.\n        skill: people\n', 'agents.lifelog.run[0].skill', /doesn't belong with at/],
    ['      - at: "21:30"\n        prompt: Check in.\n        channels: [whatsapp]\n', 'agents.lifelog.run[0].channels', /doesn't belong with at/],
    ['      - backfill: People!\n        skill: people\n        writes: [agents/lifelog/views/x.csv]\n', 'agents.lifelog.run[0].backfill', /must be an ID of lowercase letters, digits and hyphens/],
    ['      - backfill: b1\n        skill: people\n        writes: [agents/lifelog/views/x.csv]\n        prompt: Also this.\n', 'agents.lifelog.run[0].prompt', /doesn't belong with backfill/],
    ['      - backfill: b1\n        skill: swimming\n        writes: [agents/lifelog/views/x.csv]\n', 'agents.lifelog.run[0].skill', /must name one of the agent's skills/],
    ['      - backfill: b1\n        skill: people\n        writes: agents/lifelog/views/people.csv\n', 'agents.lifelog.run[0].writes', /must be a list of what the backfill may change/],
    ['      - backfill: b1\n        skill: people\n        writes: []\n', 'agents.lifelog.run[0].writes', /must be a list/],
    ['      - backfill: b1\n        skill: people\n', 'agents.lifelog.run[0].writes', /is missing/],
    [
      '      - backfill: b1\n        skill: people\n        writes: [agents/lifelog/views/a.csv, agents/lifelog/views/a.csv]\n',
      'agents.lifelog.run[0].writes[1]',
      /is agents\/lifelog\/views\/a.csv, which writes\[0\] names too/,
    ],
    [
      '      - backfill: b1\n        skill: people\n        writes: [agents/lifelog/views/a.csv]\n      - backfill: b1\n        skill: runs\n        writes: [agents/lifelog/views/b.csv]\n',
      'agents.lifelog.run[1].backfill',
      /is b1, which another backfill entry has too/,
    ],
  ]
  for (const [entries, field, message] of cases) {
    const problems = faults(entries.startsWith('    run:') ? base.replace(/    run:[\s\S]*$/, entries) : withRun(entries))
    const problem = problems.find(candidate => candidate.field === field)
    assert.ok(problem, `${field}: ${JSON.stringify(problems)}`)
    assert.match(problem.message, message, field)
  }

  // More than one trigger for new messages, each with channels of its own.
  const { parse } = setup(t)
  const two = parse(withRun('      - on: new-messages\n        channels: [email]\n        prompt: Emails.\n      - on: new-messages\n        channels: [whatsapp]\n        prompt: Messages.\n')).agents[0]
  assert.deepEqual(two.run.newMessages, [
    { channels: ['email'], prompt: 'Emails.' },
    { channels: ['whatsapp'], prompt: 'Messages.' },
  ])
  assert.deepEqual(two.channels, ['email', 'whatsapp'])

  // What a backfill may change lies in what the agent may: each path in a folder of the agent's
  // writes, or a file it names.
  for (const write of ['agents/lifelog/views/', 'agents/lifelog/views/people.csv', 'agents/lifelog/memory/a/b.md']) {
    const agent = parse(withRun(`      - backfill: b1\n        skill: people\n        writes: ["${write}"]\n`)).agents[0]
    assert.deepEqual(agent.run.backfill[0].writes, [write], write)
  }
  for (const write of ['agents/lifelog/views', 'agents/lifelog/', 'agents/lifelog/state.json', 'agents/lifelog/viewsx/a.csv', 'datastore/']) {
    const problems = faults(withRun(`      - backfill: b1\n        skill: people\n        writes: ["${write}"]\n`))
    assert.ok(
      problems.some(problem => problem.field === 'agents.lifelog.run[0].writes[0]' && problem.message.endsWith("which isn't in the agent's writes: a backfill may change only what the agent may")),
      `${write}: ${JSON.stringify(problems)}`,
    )
  }
  for (const write of ['agents/lifelog/views/../memory/x.md', 'agents/lifelog/views/./x.csv', 'agents/lifelog/views//x.csv', '/agents/lifelog/views/x.csv', '']) {
    const problems = faults(withRun(`      - backfill: b1\n        skill: people\n        writes: ["${write}"]\n`))
    assert.ok(
      problems.some(problem => problem.field === 'agents.lifelog.run[0].writes[0]' && /must be a path in the data folder/.test(problem.message)),
      `${write}: ${JSON.stringify(problems)}`,
    )
  }
})

test('config: reads and writes name paths of the data folder, of any kind, and writes none the runner keeps for itself', t => {
  const { parse, faults } = setup(t)
  const base = exampleYaml()
  // No list limits what they may name, but their form.
  const agent = parse(change(change(base, 'reads', '[datastore/, notes.md, agents/lifelog/, exchange/]'), 'writes', '[agents/lifelog/views/books.csv, agents/lifelog/notes/, agents/lifelog/views/, notes/, datastore/]')).agents[0]
  assert.deepEqual(agent.reads, ['datastore/', 'notes.md', 'agents/lifelog/', 'exchange/'])
  assert.deepEqual(agent.writes, ['agents/lifelog/views/books.csv', 'agents/lifelog/notes/', 'agents/lifelog/views/', 'notes/', 'datastore/'])
  // The repository keeps what writes names in the agent's folder, an entry in another left out.
  assert.deepEqual(agent.repository, ['notes/', 'views/'])
  assert.deepEqual(parse(change(base, 'writes', '[agents/lifelog/views/books.csv, agents/lifelog/memory/a.md]')).agents[0].repository, ['views/books.csv', 'memory/a.md'])

  for (const [write, message] of [
    ['agents/lifelog/', /is agents\/lifelog\/, which holds agents\/lifelog\/, the agent's folder, where the runner keeps its state, its repository, run\/ and the sessions: name what the agent may write in it, such as agents\/lifelog\/views\//],
    ['agents/', /which holds agents\/lifelog\/, the agent's folder/],
    ['agents/lifelog', /which holds agents\/lifelog\/, the agent's folder/],
    ['agents/lifelog/state.json', /is agents\/lifelog\/state.json, which the agent can't write: in its folder the runner keeps state.json, run\/, sessions\/ and its repository's .git, and the commit refuses a name that starts with a dot/],
    ['agents/lifelog/run/', /which the agent can't write/],
    ['agents/lifelog/run/session/', /which the agent can't write/],
    ['agents/lifelog/sessions/', /which the agent can't write/],
    ['agents/lifelog/.git/', /which the agent can't write/],
    ['agents/lifelog/.gitignore', /which the agent can't write/],
    ['agents/lifelog/views/.hidden/', /which the agent can't write/],
    ['../outside/', /must be a path in the data folder, such as agents\/lifelog\/views\/: relative to it, without a ., .. or empty part, and a folder ending in \//],
    ['/data/agents/lifelog/views/', /must be a path in the data folder/],
    ['agents/lifelog//views/', /must be a path in the data folder/],
    ['./agents/lifelog/views/', /must be a path in the data folder/],
    ['agents\\\\lifelog', /must be a path in the data folder/],
    // Where the clean-up sets aside what it throws away, beside the agent's folder.
    ['agents/.discarded/', /is agents\/.discarded\/, which the agent can't write: the runner sets aside there what a clean-up throws away, and removes it/],
    ['agents/.discarded/lifelog/', /which the agent can't write: the runner sets aside there/],
    ['agents/.discarded', /which the agent can't write: the runner sets aside there/],
    // A name no file system takes, which the runner couldn't make.
    [`agents/lifelog/${'a'.repeat(256)}/`, /has a name of 256 bytes, where a file system takes 255 at most/],
    [`agents/lifelog/views/${'é'.repeat(128)}.csv`, /has a name of 260 bytes, where a file system takes 255 at most/],
  ]) {
    const problems = faults(change(base, 'writes', `["${write}"]`))
    const problem = problems.find(candidate => candidate.field === 'agents.lifelog.writes[0]')
    assert.ok(problem, `${write}: ${JSON.stringify(problems)}`)
    assert.match(problem.message, message, write)
  }
  assert.match(faults(change(base, 'writes', '[42]')).find(problem => problem.field === 'agents.lifelog.writes[0]').message, /must be a path in the data folder/)
  // A name of 255 bytes is the longest a file system takes; reads is held to the same.
  assert.deepEqual(parse(change(base, 'writes', `[agents/lifelog/${'a'.repeat(255)}/]`)).agents[0].repository, [`${'a'.repeat(255)}/`])
  assert.match(faults(change(base, 'reads', `[${'a'.repeat(256)}.md]`))[0].message, /agents\.lifelog\.reads\[0\] has a name of 259 bytes/)
  // reads may name the runner's own, which the VM then sees, but for sessions/, which it never does.
  assert.deepEqual(parse(change(base, 'reads', '[agents/, runner/]')).agents[0].reads, ['agents/', 'runner/'])
  assert.match(faults(change(base, 'reads', '[../etc/]'))[0].message, /agents\.lifelog\.reads\[0\] must be a path in the data folder, such as datastore\//)
})

test('config: every fault is reported at once', t => {
  const { faults } = setup(t)
  let text = exampleYaml()
  text = change(text, 'model', 'nope')
  text = change(text, 'session', 'weekly')
  text = change(text, 'timeout_minutes', '0')
  const fields = faults(text).map(problem => problem.field)
  assert.deepEqual(fields, ['agents.lifelog.model', 'agents.lifelog.session', 'agents.lifelog.timeout_minutes'])
})

test('config: a file that isn\'t YAML is refused with its line', t => {
  const { faults } = setup(t)
  const duplicate = faults('agents:\n  lifelog:\n    model: a/b\n    model: a/c\n')
  assert.equal(duplicate.length, 1)
  assert.match(duplicate[0].message, /^agents\.yaml, line 4: Map keys must be unique$/)
  const broken = faults('agents:\n  lifelog: [1,\n')
  assert.match(broken[0].message, /^agents\.yaml, line \d+: /)
  // A tag the core schema doesn't know is refused too, rather than read as something else.
  assert.match(faults('agents: !thing {}\n')[0].message, /Unresolved tag/)
})

test('config: a skill holds only files and folders, and everything is inside the config folder', t => {
  const { root, configDir, faults } = setup(t)
  const base = exampleYaml()
  // A link inside a skill's folder would put whatever it leads to in front of pi.
  fs.writeFileSync(path.join(root, 'secret'), 'key')
  fs.symlinkSync(path.join(root, 'secret'), path.join(configDir, 'skills', 'runs', 'notes.md'))
  const linked = faults(base)
  assert.equal(linked[0].field, 'agents.lifelog.skills[1]')
  assert.match(linked[0].message, /holds notes.md: a skill's folder holds only files and folders/)
  fs.rmSync(path.join(configDir, 'skills', 'runs', 'notes.md'))

  // A prompt that is a link out of the config folder.
  fs.writeFileSync(path.join(root, 'prompt.md'), 'elsewhere')
  fs.symlinkSync(path.join(root, 'prompt.md'), path.join(configDir, 'prompts', 'outside.md'))
  const outside = faults(change(base, 'prompt', 'prompts/outside.md'))
  assert.match(outside[0].message, /names prompts\/outside.md, which leads outside the config folder/)

  // A skill folder that is a link elsewhere inside the config folder is fine. The skill is named
  // by the link, which is the folder pi is given.
  fs.mkdirSync(path.join(configDir, 'library', 'running'), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'library', 'running', 'SKILL.md'), '---\nname: running\ndescription: Runs.\n---\n')
  fs.symlinkSync(path.join(configDir, 'library', 'running'), path.join(configDir, 'skills', 'running'))
  const { agents } = parseConfig(base.replace('- skills/runs', '- skills/running'), { configDir })
  assert.equal(agents[0].skills[1].name, 'running')
  assert.equal(agents[0].skills[1].dir, fs.realpathSync(path.join(configDir, 'library', 'running')))
})

test("config: a skill's SKILL.md gives the folder's name and a description, as pi takes them", t => {
  const { configDir, faults, parse } = setup(t)
  const base = exampleYaml()
  const skillFile = path.join(configDir, 'skills', 'runs', 'SKILL.md')
  const cases = [
    // [the SKILL.md, what the message says after "whose SKILL.md"]
    ['# Runs\n', /has no frontmatter: it must start with a block between two --- lines/],
    ['---\nname: runs\ndescription: Runs.\n', /has no frontmatter/],
    ['---\nname: runs\ndescription: Runs: and walks: too\n---\n', /has frontmatter that isn't YAML: /],
    ['---\nname: runs\nname: runs\ndescription: Runs.\n---\n', /has frontmatter that isn't YAML: Map keys must be unique/],
    ['---\n- runs\n---\n', /has frontmatter that is no map of name and description/],
    ['---\n---\n', /has frontmatter that is no map/],
    ['---\ndescription: Runs.\n---\n', /has no name: it must be runs, the folder's name/],
    ['---\nname: Runs\ndescription: Runs.\n---\n', /gives the name "Runs": it must be runs, the folder's name/],
    ['---\nname: running\ndescription: Runs.\n---\n', /gives the name "running": it must be runs/],
    ['---\nname: runs\n---\n', /has no description, which says when to use the skill: pi doesn't load a skill without one/],
    ['---\nname: runs\ndescription: "  "\n---\n', /has no description/],
    ['---\nname: runs\ndescription: 42\n---\n', /has no description/],
    [`---\nname: runs\ndescription: ${'x'.repeat(1025)}\n---\n`, /has a description of 1025 characters, where the Agent Skills format allows 1024, and pi warns of more/],
    // pi leaves it out of what it offers the model.
    ['---\nname: runs\ndescription: Runs.\ndisable-model-invocation: true\n---\n', /says disable-model-invocation: true, so pi wouldn't offer it to the model/],
    ['---\nname: 42\ndescription: Runs.\n---\n', /gives the name "42": it must be runs/],
  ]
  for (const [text, message] of cases) {
    fs.writeFileSync(skillFile, text)
    const problems = faults(base)
    assert.equal(problems.length, 1, text)
    assert.equal(problems[0].field, 'agents.lifelog.skills[1]', text)
    assert.match(problems[0].message, /^agents\.yaml, line \d+: agents\.lifelog\.skills\[1\] names skills\/runs, whose SKILL\.md /, text)
    assert.match(problems[0].message, message, text)
  }

  // A folder's name pi doesn't take is refused, though SKILL.md gives the same.
  for (const name of ['Running', 'runs--old', '-runs', 'runs_old', 'r'.repeat(65)]) {
    fs.mkdirSync(path.join(configDir, 'skills', name))
    fs.writeFileSync(path.join(configDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Runs.\n---\n`)
    const problems = faults(base.replace('- skills/runs', `- skills/${name}`))
    assert.match(problems[0].message, new RegExp(`gives the name ${name}, which pi doesn't take: at most 64 lowercase letters, digits and single hyphens`), name)
    fs.rmSync(path.join(configDir, 'skills', name), { recursive: true })
  }

  // What pi accepts is accepted: a byte-order mark, Windows line breaks, a description of 1024
  // characters, other keys, `disable-model-invocation: false`, and a body after the frontmatter.
  for (const text of [
    '\uFEFF---\r\nname: runs\r\ndescription: Runs.\r\n---\r\n# Runs\r\n',
    '---\nname: runs\ndescription: Runs.\ndisable-model-invocation: false\n---\n',
    `---\nname: runs\ndescription: ${'é'.repeat(1024)}\n---\n`,
    '---\nname: runs\ndescription: >-\n  Runs, walks\n  and workouts.\nlicense: MIT\n---\n\n# Runs\n\nThe body.\n',
  ]) {
    fs.writeFileSync(skillFile, text)
    assert.equal(parse(base).agents[0].skills[1].name, 'runs', text)
  }

  // A folder named with digits only, whose name YAML reads as a number, as pi takes it.
  fs.mkdirSync(path.join(configDir, 'skills', '42'))
  fs.writeFileSync(path.join(configDir, 'skills', '42', 'SKILL.md'), '---\nname: 42\ndescription: The answer.\n---\n')
  assert.equal(parse(base.replace('- skills/runs', '- skills/42')).agents[0].skills[1].name, '42')
})

test("config: a SKILL.md the runner can't read is a fault that names the field, listed with the others", { skip: skipIfRoot }, t => {
  // Such a file once stopped the runner with EACCES and exit code 1.
  const { configDir, faults } = setup(t)
  const skillFile = path.join(configDir, 'skills', 'meals', 'SKILL.md')
  fs.chmodSync(skillFile, 0o000)
  const problems = faults(exampleYaml().replace('timeout_minutes: 10', 'timeout_minutes: 0'))
  assert.deepEqual(
    problems.map(problem => problem.field),
    ['agents.lifelog.skills[2]', 'agents.lifelog.timeout_minutes'],
  )
  assert.match(problems[0].message, /names skills\/meals, whose SKILL\.md can't be read \(EACCES\)$/)
})

test('config: no prompt or skill lies inside another skill\'s folder, where their copies would overlap', t => {
  const { configDir, faults } = setup(t)
  const base = exampleYaml()
  fs.mkdirSync(path.join(configDir, 'skills', 'expenses', 'receipts'))
  fs.writeFileSync(path.join(configDir, 'skills', 'expenses', 'receipts', 'SKILL.md'), '---\nname: receipts\ndescription: x\n---\n')

  const nested = faults(base.replace('- skills/runs', '- skills/expenses/receipts'))
  assert.equal(nested.length, 1)
  assert.equal(nested[0].field, 'agents.lifelog.skills[1]')
  assert.match(nested[0].message, /line 8: agents\.lifelog\.skills\[1\] names skills\/expenses\/receipts, which is inside the skill skills\/expenses: skills can't hold each other$/)

  // The same the other way round: the inner one listed first.
  const first = faults(base.replace('- skills/expenses', '- skills/expenses/receipts\n      - skills/expenses'))
  assert.equal(first[0].field, 'agents.lifelog.skills[0]')

  const prompt = faults(change(base, 'prompt', 'skills/expenses/SKILL.md'))
  assert.equal(prompt.length, 1)
  assert.equal(prompt[0].field, 'agents.lifelog.prompt')
  assert.match(prompt[0].message, /names skills\/expenses\/SKILL\.md, which is inside the skill skills\/expenses: the prompt is a file of its own$/)

  // Names that only begin the same are apart.
  fs.mkdirSync(path.join(configDir, 'skills', 'expenses-old'))
  fs.writeFileSync(path.join(configDir, 'skills', 'expenses-old', 'SKILL.md'), '---\nname: expenses-old\ndescription: Old expenses.\n---\n')
  const { agents } = parseConfig(base.replace('- skills/runs', '- skills/expenses-old'), { configDir })
  assert.deepEqual(agents[0].skills.map(skill => skill.name), ['expenses', 'expenses-old', 'meals', 'travel', 'people'])
})

test("config: no skill of the agent's has the name of the runner's own, which every run is given", t => {
  const { configDir, faults } = setup(t)
  const base = exampleYaml()
  assert.equal(RUNNER_SKILL, 'scooter')
  // Wherever its folder is, the skill's name is its folder's.
  for (const folder of ['skills/scooter', 'more/scooter']) {
    fs.mkdirSync(path.join(configDir, folder), { recursive: true })
    fs.writeFileSync(path.join(configDir, folder, 'SKILL.md'), '---\nname: scooter\ndescription: Mine.\n---\n')
    const named = faults(base.replace('- skills/runs', `- ${folder}`))
    assert.equal(named.length, 1, folder)
    assert.equal(named[0].field, 'agents.lifelog.skills[1]')
    assert.match(named[0].message, /line 8: agents\.lifelog\.skills\[1\] names a skill called scooter, the name of the skill that ships with the runner, which every run is given: each skill's folder needs a name of its own$/)
  }
  // A name that only begins the same is a name of its own.
  fs.mkdirSync(path.join(configDir, 'skills', 'scooter-notes'))
  fs.writeFileSync(path.join(configDir, 'skills', 'scooter-notes', 'SKILL.md'), '---\nname: scooter-notes\ndescription: Notes.\n---\n')
  assert.equal(parseConfig(base.replace('- skills/runs', '- skills/scooter-notes'), { configDir }).agents[0].skills[1].name, 'scooter-notes')
})

test('config: loadConfig reads agents.yaml from the config folder, names it when it can\'t, and holds paths to what the system takes in the data folder', t => {
  const { root, configDir } = setup(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir })
  const load = () => loadConfig({ paths, settings: SETTINGS })
  assert.equal(load().agents[0].name, 'lifelog')
  fs.rmSync(paths.agentsYaml)
  assert.throws(load, error => error instanceof ConfigError && error.message === `${paths.agentsYaml} can't be read (ENOENT)`)
  fs.writeFileSync(paths.agentsYaml, change(exampleYaml(), 'session', 'weekly'))
  assert.throws(load, error => error.message.startsWith(`${paths.agentsYaml}, line `))

  // A path of reads or writes that, in the data folder, would pass what the system takes as a
  // path: the runner couldn't make it.
  const deep = Array.from({ length: 17 }, () => 'a'.repeat(250)).join('/')
  fs.writeFileSync(paths.agentsYaml, change(exampleYaml(), 'writes', `[agents/lifelog/views/, agents/lifelog/${deep}/]`))
  assert.throws(
    load,
    error => error instanceof ConfigError && error.problems.length === 1 && /agents\.lifelog\.writes\[1\] makes, in the data folder, a path of more than 4095 bytes, which the system doesn't take/.test(error.message),
  )
})

// The example's text with the evening check-in's prompt in place of its own.
const withCheckIn = (text, prompt) => text.replace(/^( {8}prompt: )>-\n(?: {10}.*\n)+/m, (whole, key) => `${key}${prompt}\n`)

test("config: a trigger's prompt is text pi can be given, and holds no variable the runner doesn't know", t => {
  const { parse, faults } = setup(t)
  const base = exampleYaml()
  // A `$` that starts no variable is the owner's text; every variable the runner knows is taken.
  const own = 'Costs $5, or US$ 6; $$ and $ now$ and $1x$ are text. $now$ $user.timezone$ $user.currency$ $reply_mode$ $internet$ $agent.dir$ $datastore.dir$ $seq.unread$ $seq.retry$ $run.writes$'
  assert.equal(parse(withCheckIn(base, JSON.stringify(own))).agents[0].run.scheduled[0].prompt, own)
  // A prompt that starts with a space, a line break or a `/`, which pi takes as text.
  for (const prompt of ['" @sam"', '"\\n@sam"', '"/compact"']) assert.equal(parse(withCheckIn(base, prompt)).agents[0].run.scheduled[0].prompt, JSON.parse(prompt), prompt)

  const cases = [
    ['"$nwo$ and $user.zone$, and $nwo$ again"', /holds \$nwo\$ or \$user\.zone\$, which are no variables the runner knows: they are \$now\$, \$user\.timezone\$, .* or \$run\.writes\$$/],
    ['"Today: $Now$"', /holds \$Now\$, which is no variable the runner knows/],
    ['"$constructor$ $toString$"', /holds \$constructor\$ or \$toString\$, which are no variables/],
    ['"@lifelog, the evening check-in"', /starts with @, which makes pi take the whole prompt as the name of a file to attach/],
    ['"Check in.\\0"', /holds the character U\+0000, which a command line can't carry/],
    ['"Check in. \\uD83D"', /holds half of a pair of UTF-16 surrogates/],
    ['""', /must be the message pi is given for the run, as text/],
    ['"  \\n "', /must be the message pi is given for the run, as text/],
    ['7', /must be the message pi is given for the run, as text/],
    ['[a, b]', /must be the message pi is given for the run, as text/],
  ]
  for (const [prompt, message] of cases) {
    const problems = faults(withCheckIn(base, prompt))
    const problem = problems.find(candidate => candidate.field === 'agents.lifelog.run[1].prompt')
    assert.ok(problem, `${prompt}: ${JSON.stringify(problems)}`)
    assert.match(problem.message, message, prompt)
    assert.match(problem.message, /^agents\.yaml, line \d+: agents\.lifelog\.run\[1\]\.prompt /)
  }
  // The line is the field's own.
  const lineOfPrompt = base.split('\n').findIndex(text => text.includes('prompt: >-')) + 1
  assert.equal(faults(withCheckIn(base, '"$nwo$"'))[0].line, lineOfPrompt)
  // The same for a trigger for new messages.
  const messages = faults(base.replace('New: $seq.unread$', 'New: $seq.new$'))
  assert.deepEqual(messages.map(problem => problem.field), ['agents.lifelog.run[0].prompt'])
  // Every fault at once: a trigger's prompt at fault, and a channel another trigger names too.
  const second = '      - on: new-messages\n        channels: [email]\n        prompt: "@email"\n'
  const both = faults(base.replace('      - at: "21:30"', at => `${second}${at}`).replace('New: $seq.unread$', 'New: $seq.new$'))
  assert.deepEqual(both.map(problem => problem.field).sort(), ['agents.lifelog.run[0].prompt', 'agents.lifelog.run[1].channels', 'agents.lifelog.run[1].prompt'])
})

test("config: a trigger's prompt, filled in with the longest values its variables can take, is within PROMPT_MAX_BYTES, a backfill's writes and the settings counted", t => {
  const { configDir } = setup(t)
  const dataDir = '/data'
  const faultsOf = (text, settings = SETTINGS) => {
    try {
      parseConfig(text, { configDir, dataDir, settings, file: 'agents.yaml' })
      return []
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      return error.problems
    }
  }
  const base = exampleYaml({ backfill: true })
  // The example's own prompts are far within it.
  assert.deepEqual(faultsOf(base), [])

  // A prompt of its own text, a byte within the limit and a byte past it, as a scheduled task's.
  const agent = { name: 'lifelog', replyMode: 'quiet', writes: ['agents/lifelog/views/', 'agents/lifelog/memory/'] }
  const nowMost = longestValues({ agent, paths: makePaths({ dataDir, configDir }), settings: SETTINGS }).now
  const within = `$now$${'x'.repeat(limits.PROMPT_MAX_BYTES - nowMost)}`
  assert.deepEqual(faultsOf(withCheckIn(base, `"${within}"`)), [])
  const past = faultsOf(withCheckIn(base, `"${within}x"`))
  assert.deepEqual(past.map(problem => problem.field), ['agents.lifelog.run[1].prompt'])
  assert.match(past[0].message, new RegExp(`can make a prompt of ${limits.PROMPT_MAX_BYTES + 1} bytes, filled in with the longest values its variables can take, where pi can be given ${limits.PROMPT_MAX_BYTES} at most, as one argument: shorten it$`))
  // A variable counts as the longest it can be: each line's number as the largest a seq can be.
  const numbers = `"${'$seq.unread$ '.repeat(Math.ceil(limits.PROMPT_MAX_BYTES / (limits.BATCH_MAX_ITEMS * 17)))}"`
  assert.equal(faultsOf(withCheckIn(base, numbers)).length, 1)
  // Without the data folder or the settings, as only some tests parse it, the lengths aren't held.
  assert.deepEqual(faultsOf(withCheckIn(base, numbers), null), [])

  // The settings' values count: a time zone's name, many times over.
  const zones = `"${'$user.timezone$'.repeat(Math.floor(limits.PROMPT_MAX_BYTES / 'Asia/Kolkata'.length))}"`
  assert.deepEqual(faultsOf(withCheckIn(base, zones)), [])
  assert.equal(faultsOf(withCheckIn(base, zones), { ...SETTINGS, timeZone: 'America/Argentina/ComodRivadavia' }).length, 1)

  // The prompt for new messages is a backfill's too, filled in with the backfill's writes, which
  // can be longer than the agent's own; a scheduled task's isn't.
  const files = Array.from({ length: 450 }, (_, n) => `agents/lifelog/views/${'f'.repeat(200)}-${n}.csv`)
  const longBackfill = base.replace('writes: [agents/lifelog/views/people.csv]', `writes: [${files.join(', ')}]`)
  assert.deepEqual(faultsOf(withCheckIn(longBackfill, '"$run.writes$"')).map(problem => problem.field), ['agents.lifelog.run[0].prompt'])
})
