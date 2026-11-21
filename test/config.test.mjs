// The agents' configuration (6.1 of DESIGN.md; section 10, "Config"): the example of 6.1 is read
// as it stands, and each validation error names the field, and its line.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makePaths } from '../src/common/paths.mjs'
import { ConfigError, loadConfig, parseConfig } from '../src/runner/config.mjs'
import { SKILLS, exampleYaml, writeConfig } from './support/runner.mjs'
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

// The example's text with one setting's line changed: `key: old value` becomes `key: value`.
const change = (text, key, value) => text.replace(new RegExp(`^(\\s*)${key}:.*$`, 'm'), `$1${key}: ${value}`)

test('config: the example of 6.1 is read as it stands', t => {
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
    reads: ['whatsapp', 'email'],
    session: 'daily',
    replyMode: 'quiet',
    ackReaction: '✅',
    canMessage: true,
    timeoutMinutes: 10,
    run: {
      newMessages: true,
      scheduled: [
        {
          at: '21:30',
          schedule: { weekday: null, hour: 21, minute: 30 },
          task: 'Evening check-in. List in a few lines what you filed today, mention anything that looks missing, and list the open questions.',
        },
      ],
      once: [],
      backfill: [{ id: 'people-1', skill: 'people', writes: ['views/people.csv'] }],
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
  assert.deepEqual(parse(change(base, 'reads', '[email]')).agents[0].reads, ['email'])
  // An unquoted time is a string in YAML 1.2, not a number of minutes as in YAML 1.1.
  const runs = `    run:
      - at: 09:05
        task: Morning.
      - at: Sun 18:00
        task: Weekly review.
      - once: poems
        task: Write poems.
      - backfill: people-1
        skill: people
        writes: [views/people.csv, views/people/]
`
  const { run } = parse(base.replace(/    run:[\s\S]*$/, runs)).agents[0]
  assert.equal(run.newMessages, false)
  assert.deepEqual(
    run.scheduled.map(entry => [entry.at, entry.schedule]),
    [
      ['09:05', { weekday: null, hour: 9, minute: 5 }],
      ['Sun 18:00', { weekday: 7, hour: 18, minute: 0 }],
    ],
  )
  assert.deepEqual(run.once, [{ id: 'poems', task: 'Write poems.' }])
  assert.deepEqual(run.backfill, [{ id: 'people-1', skill: 'people', writes: ['views/people.csv', 'views/people/'] }])
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
    [change(base, 'reads', '[sms]'), 'agents.lifelog.reads', /must list whatsapp or email, or both, once each/],
    [change(base, 'reads', '[]'), 'agents.lifelog.reads', /must list whatsapp or email/],
    [change(base, 'reads', '[email, email]'), 'agents.lifelog.reads', /once each/],
    [change(base, 'session', 'weekly'), 'agents.lifelog.session', /must be daily or none/],
    [change(base, 'reply_mode', 'loud'), 'agents.lifelog.reply_mode', /must be quiet or confirm/],
    [change(base, 'ack_reaction', 'ok'), 'agents.lifelog.ack_reaction', /must be one emoji, such as "✅", or "" for none/],
    [change(base, 'ack_reaction', '"✅✅"'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [change(base, 'ack_reaction', '~'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    // One grapheme, but a letter, a digit or a sign, not an emoji.
    [change(base, 'ack_reaction', 'k'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [change(base, 'ack_reaction', '"7"'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [change(base, 'ack_reaction', '"é"'), 'agents.lifelog.ack_reaction', /must be one emoji/],
    [change(base, 'can_message', '"yes"'), 'agents.lifelog.can_message', /must be true or false/],
    [change(base, 'timeout_minutes', '0'), 'agents.lifelog.timeout_minutes', /must be a whole number of minutes from 1 to 120/],
    [change(base, 'timeout_minutes', '121'), 'agents.lifelog.timeout_minutes', /from 1 to 120/],
    [change(base, 'timeout_minutes', '1.5'), 'agents.lifelog.timeout_minutes', /from 1 to 120/],
    [base.replace('    model:', '    modle:'), 'agents.lifelog.modle', /is not a setting of an agent/],
    [base.replace(/^\s*session:.*\n/m, ''), 'agents.lifelog.session', /is missing/],
    [base.replace('lifelog:', 'Lifelog:'), 'agents.Lifelog', /is not a name for an agent/],
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
    ['      - new-messages\n', 'agents.lifelog.run[0]', /must be a map with one of on, at, once or backfill/],
    ['      - on: new-messages\n        at: "21:30"\n', 'agents.lifelog.run[0]', /must have exactly one of on, at, once or backfill/],
    ['      - task: Something.\n', 'agents.lifelog.run[0]', /must have exactly one of/],
    ['      - on: old-messages\n', 'agents.lifelog.run[0].on', /must be new-messages/],
    ['      - on: new-messages\n      - on: new-messages\n', 'agents.lifelog.run[1].on', /is given twice/],
    ['      - at: "25:00"\n        task: Late.\n', 'agents.lifelog.run[0].at', /must be a time as "HH:MM", or a weekday and a time as "Sun 18:00"/],
    ['      - at: "sun 18:00"\n        task: Weekly.\n', 'agents.lifelog.run[0].at', /must be a time/],
    ['      - at: "21:30"\n        task: One.\n      - at: "21:30"\n        task: Two.\n', 'agents.lifelog.run[1].at', /is 21:30, which another entry has too/],
    ['      - at: "21:30"\n', 'agents.lifelog.run[0].task', /is missing/],
    ['      - at: "21:30"\n        task: "  "\n', 'agents.lifelog.run[0].task', /must be the task, as text/],
    ['      - at: "21:30"\n        task: Check in.\n        skill: people\n', 'agents.lifelog.run[0].skill', /doesn't belong with at/],
    ['      - once: Poems!\n        task: Poems.\n', 'agents.lifelog.run[0].once', /must be an ID of lowercase letters, digits and hyphens/],
    ['      - once: poems\n        task: A.\n      - once: poems\n        task: B.\n', 'agents.lifelog.run[1].once', /is poems, which another once entry has too/],
    ['      - backfill: b1\n        skill: day-pages\n        writes: [views/x.csv]\n', 'agents.lifelog.run[0].skill', /can't be day-pages/],
    ['      - backfill: b1\n        skill: swimming\n        writes: [views/x.csv]\n', 'agents.lifelog.run[0].skill', /must name one of the agent's skills/],
    ['      - backfill: b1\n        skill: people\n        writes: views/people.csv\n', 'agents.lifelog.run[0].writes', /must be a list of what the backfill may change/],
    ['      - backfill: b1\n        skill: people\n        writes: []\n', 'agents.lifelog.run[0].writes', /must be a list/],
    ['      - backfill: b1\n        skill: people\n', 'agents.lifelog.run[0].writes', /is missing/],
    ['      - backfill: b1\n        skill: people\n        writes: [views/a.csv, views/a.csv]\n', 'agents.lifelog.run[0].writes[1]', /is views\/a.csv, which is listed twice/],
    ['      - backfill: b1\n        skill: people\n        writes: [views/a.csv]\n      - backfill: b1\n        skill: runs\n        writes: [views/b.csv]\n', 'agents.lifelog.run[1].backfill', /is b1, which another backfill entry has too/],
  ]
  for (const [entries, field, message] of cases) {
    const problems = faults(entries.startsWith('    run:') ? base.replace(/    run:[\s\S]*$/, entries) : withRun(entries))
    const problem = problems.find(candidate => candidate.field === field)
    assert.ok(problem, `${field}: ${JSON.stringify(problems)}`)
    assert.match(problem.message, message, field)
  }

  // What a backfill may change: files, or folders ending in /, inside views/ and outside views/days/.
  for (const write of ['views/days/2026/11/2026-11-09.md', 'views/days/', 'views/days', 'views/', 'views', 'memory/x.md', 'views/../memory/x.md', 'views/./x.csv', 'views//x.csv', 'views/.hidden', '/views/x.csv', 'x.csv']) {
    const problems = faults(withRun(`      - backfill: b1\n        skill: people\n        writes: ["${write}"]\n`))
    assert.ok(
      problems.some(problem => problem.field === 'agents.lifelog.run[0].writes[0]' && /inside views\/ and outside views\/days\//.test(problem.message)),
      `${write}: ${JSON.stringify(problems)}`,
    )
  }
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

test("config: a skill's SKILL.md gives the folder's name and a description, as pi takes them (D197)", t => {
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
  // The review of milestone 11, point 4: it stopped the runner with EACCES and exit code 1.
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
  assert.deepEqual(agents[0].skills.map(skill => skill.name), ['expenses', 'expenses-old', 'meals', 'travel', 'people', 'day-pages'])
})

test('config: loadConfig reads agents.yaml from the config folder, and names it when it can\'t', t => {
  const { root, configDir } = setup(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir })
  assert.equal(loadConfig({ paths }).agents[0].name, 'lifelog')
  fs.rmSync(paths.agentsYaml)
  assert.throws(() => loadConfig({ paths }), error => error instanceof ConfigError && error.message === `${paths.agentsYaml} can't be read (ENOENT)`)
  fs.writeFileSync(paths.agentsYaml, change(exampleYaml(), 'session', 'weekly'))
  assert.throws(() => loadConfig({ paths }), error => error.message.startsWith(`${paths.agentsYaml}, line `))
})
