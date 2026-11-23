// The agent's instructions (`docs/architecture/agent.md`; the plan's milestone 11): the default
// config in `config/`, its prompt and its five skills, read against the documents themselves; and
// the skill that ships with the runner, read against the line format (`line.mjs`), what `show`,
// `send` and `mark` print, and what the runner makes of what they leave (`report.mjs`).
//
// The files are the repository's own, as `setup` copies them and Docker mounts them. What the
// agent's document gives word for word, the views' list, the CSV headers and the categories, is
// taken from it, so the two can't drift apart. The default `agents.yaml` is held to the tests' own
// example of the format, `exampleYaml`, which the other tests of the config use.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createIndex } from '../src/common/datastore/index.mjs'
import { DIRECTIONS, FIELDS, KINDS, SOURCES, TRUSTS, checkLine } from '../src/common/datastore/line.mjs'
import { limits } from '../src/common/limits.mjs'
import { OWN_AUTHORS } from '../src/common/outbox.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { indexFileText, prepareRun } from '../src/runner/agentdir.mjs'
import { RUNNER_SKILL, loadConfig, parseConfig, skillFileProblem } from '../src/runner/config.mjs'
import { openDatastore } from '../src/runner/datastore.mjs'
import { readMarks, readSends } from '../src/runner/report.mjs'
import { piEnv } from '../src/runner/run.mjs'
import { NEW_MESSAGES_PROMPT, SKILLS, exampleYaml, writeConfig } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const CONFIG = path.join(REPO, 'config')
const AGENT = fs.readFileSync(path.join(REPO, 'docs', 'architecture', 'agent.md'), 'utf8')
const DATASTORE = fs.readFileSync(path.join(REPO, 'docs', 'architecture', 'datastore.md'), 'utf8')
const RUNNER_SKILL_FILE = fs.readFileSync(path.join(REPO, 'src', 'runner', 'vm', 'skills', RUNNER_SKILL, 'SKILL.md'), 'utf8')
const read = (...parts) => fs.readFileSync(path.join(CONFIG, ...parts), 'utf8')
// The runner's settings that fill in a prompt's variables.
const SETTINGS = { timeZone: 'Asia/Kolkata', homeCurrency: 'INR', agentInternet: false }
const linesOf = text => text.split('\n')

// The section of a document's text that starts with `heading`, up to the next heading of its level.
function designSection(heading, text) {
  const start = text.indexOf(`\n${heading}\n`)
  assert.notEqual(start, -1, heading)
  const level = heading.match(/^#+ /)[0]
  const end = text.indexOf(`\n${level}`, start + heading.length + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

// The fenced blocks of a Markdown text, as `{ info, body }`.
function fencedBlocks(text) {
  return [...text.matchAll(/^```([a-z]*)\n([\s\S]*?)^```$/gm)].map(match => ({ info: match[1], body: match[2] }))
}

// The table of skills in the agent's document: for each skill, its view, what the row says of it,
// and the CSV header the row starts with, which every row has.
function designSkills() {
  const rows = [...designSection('## Skills', AGENT).matchAll(/^\| `([a-z-]+)` \| `([^`]+)` \| (.*) \|$/gm)]
  return rows.map(([, name, view, contents]) => {
    const header = /^Header `([^`]+)`/.exec(contents)
    assert.ok(header, `${name}: its row gives no header`)
    return { name, view, contents, header: header[1] }
  })
}

// The skills folder's own skills.
const skillFolders = () => fs.readdirSync(path.join(CONFIG, 'skills')).sort()

test('instructions: the default config validates, and is the tests\' example', t => {
  const root = makeTestDir(t)
  const { agents } = loadConfig({ paths: makePaths({ dataDir: path.join(root, 'data'), configDir: CONFIG }), settings: SETTINGS })
  assert.equal(agents.length, 1)
  const [agent] = agents
  assert.equal(agent.prompt.file, fs.realpathSync(path.join(CONFIG, 'prompts', 'lifelog.md')))
  assert.deepEqual(
    agent.skills.map(skill => [skill.name, skill.path, skill.dir]),
    SKILLS.map(name => [name, `skills/${name}`, fs.realpathSync(path.join(CONFIG, 'skills', name))]),
  )

  // The tests' example, read the same way, gives the same agent but for where its files are.
  const example = parseConfig(exampleYaml(), { configDir: writeConfig(path.join(root, 'example')) }).agents[0]
  const withoutFiles = ({ prompt, skills, ...rest }) => ({ ...rest, prompt: prompt.path, skills: skills.map(skill => skill.path) })
  assert.deepEqual(withoutFiles(agent), withoutFiles(example))

  // And the file holds the example's lines, as the owner will read them there, comments included.
  const lines = linesOf(read('agents.yaml'))
  for (const wanted of linesOf(exampleYaml().trimEnd())) {
    const kept = wanted.replace('# paths are relative to /config', '# paths are relative to this config folder')
    assert.ok(lines.includes(kept), kept)
  }
})

test('instructions: every skill folder has a SKILL.md with its name and a description, and the config lists every one', () => {
  assert.deepEqual(skillFolders(), [...SKILLS].sort())
  for (const name of skillFolders()) {
    const text = read('skills', name, 'SKILL.md')
    assert.equal(skillFileProblem(text, name), null, name)
    // What the description says: the view it keeps, and when to use it.
    const description = /^description: (.*)$/m.exec(text)[1]
    const view = designSkills().find(skill => skill.name === name).view
    assert.ok(description.includes(view), `${name}: ${description}`)
    assert.match(description, /\bUse it\b/, name)
    // Nothing else is in a skill's folder: the runner copies all of it into every run.
    assert.deepEqual(fs.readdirSync(path.join(CONFIG, 'skills', name)), ['SKILL.md'], name)
  }
  // The skills of the agent's document, no more and no fewer.
  assert.deepEqual(designSkills().map(skill => skill.name), SKILLS)
})

test('instructions: each view in the prompt names a skill that exists, as the agent\'s document lists them', () => {
  const prompt = read('prompts', 'lifelog.md')
  const block = fencedBlocks(designSection('## The prompt', AGENT)).find(fenced => fenced.body.startsWith('Views (all under views/):')).body
  // The list is in the prompt as the agent's document gives it, line for line.
  assert.ok(prompt.includes(block), block)

  const views = linesOf(block.trimEnd()).slice(1).map(text => /^- ([^:]+): (.*) \(skill: ([a-z-]+)\)$/.exec(text))
  assert.ok(views.every(Boolean))
  assert.deepEqual(views.map(match => match[3]), SKILLS)
  for (const [, file, , skill] of views) {
    assert.ok(skillFolders().includes(skill), skill)
    // The skill keeps that view: the agent's document says so, and so does the skill's own heading.
    const design = designSkills().find(entry => entry.name === skill)
    assert.equal(design.view, `views/${file}`)
    assert.match(read('skills', skill, 'SKILL.md'), new RegExp(`^# .*: \`views/${file.replace(/[.]/g, '\\.')}\`$`, 'm'), skill)
  }
})

test('instructions: each CSV header is the one the agent\'s document gives, and the expenses skill has its categories', () => {
  // Every skill keeps a CSV view: `designSkills` holds each row to a header.
  for (const { name, view, header } of designSkills()) {
    assert.ok(view.endsWith('.csv'), view)
    const text = read('skills', name, 'SKILL.md')
    // The header is the one CSV block of the skill, and its every column is described.
    const blocks = fencedBlocks(text).filter(block => block.info === 'csv')
    assert.deepEqual(blocks.map(block => block.body), [`${header}\n`], name)
    for (const column of header.split(',')) assert.match(text, new RegExp(`^- (\`[a-z_]+\`, )*\`${column}\`[,:]`, 'm'), `${name}: ${column}`)
  }

  const categories = /Categories: ([^;]+); add new ones only when the owner asks/.exec(designSkills().find(skill => skill.name === 'expenses').contents)[1].replace(/\.$/, '').split(', ')
  assert.equal(categories.length, 10)
  const expenses = read('skills', 'expenses', 'SKILL.md')
  const listed = /^- `category`: one of (.*), written exactly so\./m.exec(expenses)[1]
  assert.deepEqual([...listed.matchAll(/`([^`]+)`/g)].map(match => match[1]), categories)
})

test("instructions: pi appends the agent's prompt to its system prompt, as the config folder has it, with the runner's skill and the five skills copied for pi", t => {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: CONFIG })
  const [agent] = loadConfig({ paths, settings: SETTINGS }).agents
  const prepared = prepareRun({ paths, agent, index: createIndex(), sessionId: 'lifelog-2026-11-09' })
  assert.equal(prepared.promptFile, path.join(paths.agentRunConfig('lifelog'), 'prompts', 'lifelog.md'))
  assert.equal(fs.readFileSync(prepared.promptFile, 'utf8'), read('prompts', 'lifelog.md'))
  assert.deepEqual(prepared.skillDirs, [path.join(paths.agentRunSkills('lifelog'), 'scooter'), ...SKILLS.map(name => path.join(paths.agentRunConfig('lifelog'), 'skills', name))])
  for (const name of SKILLS) assert.equal(fs.readFileSync(path.join(paths.agentRunConfig('lifelog'), 'skills', name, 'SKILL.md'), 'utf8'), read('skills', name, 'SKILL.md'))
})

test("instructions: the prompt says to read the runner's skill and the two memory files first, as the agent's document gives it", () => {
  const prompt = read('prompts', 'lifelog.md')
  const block = fencedBlocks(designSection('## The prompt', AGENT)).find(fenced => fenced.body.startsWith('Before anything else, on every run:')).body
  assert.ok(prompt.includes(block), block)
  // Before the views, and naming the skill by the name it has, and each memory file.
  assert.ok(prompt.indexOf(block) < prompt.indexOf('Views (all under views/):'))
  for (const words of [`\`${RUNNER_SKILL}\` skill`, '`memory/preferences.md`', '`memory/needs-review.md`']) assert.ok(block.includes(words), words)
  // The runner's skill says to read it first too, where pi offers it, in its description.
  assert.match(/^description: (.*)$/m.exec(RUNNER_SKILL_FILE)[1], /Read it before anything else, on every run\.$/)
})

test("instructions: the prompt says how each line given is handled, as the agent's document gives it, and the default prompt for new messages gives what it relies on", () => {
  const prompt = read('prompts', 'lifelog.md')
  const block = fencedBlocks(designSection('## The prompt', AGENT)).find(fenced => fenced.body.startsWith('Then take each line')).body
  assert.ok(prompt.includes(block), block)
  for (const words of ['`show`', '`mark`', 'an edit or a deletion', 'Mark every number you were given, and only those.']) assert.ok(block.includes(words), words)
  // The default prompt for new messages, the agent's document's own, gives the time, the lines'
  // numbers and what the run may change, which lifelog's prompt reads: its backfill rule goes by
  // whether the run may change `memory/`.
  const config = read('agents.yaml')
  for (const text of NEW_MESSAGES_PROMPT.trimEnd().split('\n')) assert.ok(config.includes(`          ${text}\n`), text)
  const shown = fencedBlocks(designSection('## The prompt', AGENT)).find(fenced => fenced.info === 'yaml' && fenced.body.includes('$seq.unread$'))
  assert.ok(shown, "agent.md shows the default prompt for new messages")
  for (const text of NEW_MESSAGES_PROMPT.trimEnd().split('\n')) assert.ok(shown.body.includes(text), text)
  for (const variable of ['$now$', '$seq.unread$', '$seq.retry$', '$run.writes$']) assert.ok(NEW_MESSAGES_PROMPT.includes(variable), variable)
  assert.ok(prompt.includes('When the run\'s message says this run may change views but not `memory/`'))
  assert.match(NEW_MESSAGES_PROMPT, /^Now: \$now\$/)
  assert.ok(prompt.includes('Today is the date after `Now:` in the run\'s message'))
})

// ---------------------------------------------------------------------------------------------
// The runner's own skill, against the line format and `show`

// The words in backticks in a text.
const ticked = text => [...text.matchAll(/`([^`]*)`/g)].map(match => match[1])

test("runner's skill: it is a skill pi takes, under the name agents.yaml keeps for it", () => {
  assert.equal(skillFileProblem(RUNNER_SKILL_FILE, RUNNER_SKILL), null)
  assert.match(RUNNER_SKILL_FILE, /^---\nname: scooter\ndescription: /)
})

test("runner's skill: its table of a line's fields is line.mjs's, in order, with each kind, direction, channel and trust, and what data holds as datastore.md gives it", () => {
  const section = designSection('## The format of a line', RUNNER_SKILL_FILE)
  const rows = new Map([...section.matchAll(/^\| `([a-zA-Z]+)` \| (.*) \|$/gm)].map(([, field, holds]) => [field, holds]))
  assert.deepEqual([...rows.keys()], FIELDS)
  assert.deepEqual(ticked(rows.get('kind')), KINDS)
  assert.deepEqual(ticked(rows.get('dir')), DIRECTIONS)
  assert.deepEqual(ticked(rows.get('source')), SOURCES)
  // Those two say first which lines they are on: what follows the colon is what they hold.
  const afterColon = field => rows.get(field).split(': ').slice(1).join(': ')
  assert.deepEqual(ticked(afterColon('trust')), TRUSTS)
  assert.deepEqual(ticked(afterColon('by')), OWN_AUTHORS)
  // What `data` holds: each name before its comma, as the datastore's document lists them.
  const kept = afterColon('data')
    .split('; ')
    .map(part => /^`([a-z]+)`, /.exec(part)?.[1])
  const documented = [...designSection('### data', DATASTORE).matchAll(/^\| `([a-z]+)` \| /gm)].map(match => match[1])
  assert.deepEqual(kept, documented)
})

// The runner's skill's examples of `show`, `{ args, output }`, and every line they show as stored.
function skillExamples() {
  const examples = fencedBlocks(RUNNER_SKILL_FILE)
    .filter(block => block.body.startsWith('$ show '))
    .map(block => {
      const [command, ...output] = block.body.split('\n')
      return { args: command.slice('$ show '.length).split(' '), output: output.join('\n') }
    })
  const stored = new Map()
  for (const { output } of examples) {
    for (const text of output.split('\n')) {
      if (!text.trimStart().startsWith('{')) continue
      const stripped = text.trimStart()
      stored.set(JSON.parse(stripped).seq, stripped)
    }
  }
  return { examples, stored }
}

test("runner's skill: each line its examples show is one the store would write", () => {
  const { examples, stored } = skillExamples()
  assert.ok(examples.length >= 3)
  assert.ok(stored.size >= 5)
  for (const [seq, text] of stored) assert.deepEqual(checkLine(JSON.parse(text)), [], `#${seq}`)
})

test("runner's skill: its examples of show and of the index file are what show prints, and the index file holds, for a datastore of those lines", t => {
  const { examples, stored } = skillExamples()
  // The data folder at /data, as the examples have it, stands in for the test's own. The day folder
  // of 9 November starts at #839, so that the lines are where the examples say, and the lines that
  // aren't the examples' are the owner's.
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const asInDocker = text => text.replaceAll(paths.dataDir, '/data')
  const last = Math.max(...stored.keys())
  const days = { '2026/11/08': [], '2026/11/09': [] }
  for (let seq = 1; seq <= last; seq++) {
    const day = seq < 839 ? '2026/11/08' : '2026/11/09'
    const filler = { seq, kind: 'message', dir: 'in', at: `${day.replaceAll('/', '-')}T05:00:00Z`, source: 'whatsapp', sourceId: `FILLER${seq}`, trust: 'owner', text: `filler ${seq}` }
    days[day].push(stored.get(seq) ?? JSON.stringify(filler))
  }
  for (const [day, texts] of Object.entries(days)) {
    fs.mkdirSync(paths.dayDir(day), { recursive: true })
    fs.writeFileSync(paths.dayLog(day), `${texts.join('\n')}\n`)
  }
  const datastore = openDatastore({ paths })
  datastore.poll()
  fs.mkdirSync(path.join(paths.configDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(paths.configDir, 'prompts', 'lifelog.md'), 'You are lifelog.\n')
  fs.mkdirSync(paths.agentDir('lifelog'), { recursive: true })
  const agent = { name: 'lifelog', prompt: { path: 'prompts/lifelog.md', file: path.join(paths.configDir, 'prompts', 'lifelog.md') }, skills: [] }
  prepareRun({ paths, agent, index: datastore.index })

  for (const { args, output } of examples) {
    const env = piEnv({ timeZone: 'Asia/Kolkata', binDir: paths.agentRunBin('lifelog'), icuTzDir: paths.agentRunIcuTz('lifelog') })
    const result = spawnSync(process.execPath, [path.join(paths.agentRunBin('lifelog'), 'show'), ...args], { env, encoding: 'utf8' })
    assert.equal(asInDocker(result.stdout), output, args.join(' '))
    assert.equal(result.status, output.includes('no such line') ? 1 : 0, args.join(' '))
  }

  // The index file's example is its lines, as the runner writes them.
  const index = linesOf(asInDocker(indexFileText(datastore.index, paths)))
  const example = fencedBlocks(designSection('## The index file', RUNNER_SKILL_FILE))[0].body.trimEnd()
  for (const text of linesOf(example)) assert.ok(index.includes(text), text)
  // And the searches it gives find what it says.
  assert.deepEqual(index.filter(text => text.endsWith(' edit 1051')).map(text => text.split(' ')[0]), ['1054'])
  assert.ok(RUNNER_SKILL_FILE.includes("`grep ' edit 1051$' run/index.txt` finds the edits of 1051, and `grep ' 1051$' run/index.txt` every line that points at it."))
})

// ---------------------------------------------------------------------------------------------
// The runner's own skill, against `send`, `mark` and what the runner makes of what they leave

// The skill's examples of `send` and `mark`, as one script, the commands with their here-documents,
// and what they print.
function commandExamples() {
  const blocks = fencedBlocks(RUNNER_SKILL_FILE).filter(block => /^\$ (send|mark) /.test(block.body))
  const script = []
  const printed = []
  for (const { body } of blocks) {
    let input = null
    for (const text of body.trimEnd().split('\n')) {
      if (input !== null) {
        script.push(text)
        if (text === input) input = null
      } else if (text.startsWith('$ ')) {
        script.push(text.slice(2))
        input = /<<'([A-Z]+)'$/.exec(text)?.[1] ?? null
      } else {
        printed.push(text)
      }
    }
  }
  return { script: script.join('\n'), printed: printed.join('\n') }
}

test("runner's skill: its examples of send and mark, run in bash as the agent runs them, print what it shows, and leave what the runner reads as it says", t => {
  const { script, printed } = commandExamples()
  assert.match(script, /^mark done /m)
  assert.match(script, /^mark failed /m)
  assert.match(script, /^send --reply-to /m)
  assert.match(script, /^send <<'END'$/m)
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  fs.mkdirSync(path.join(paths.configDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(paths.configDir, 'prompts', 'lifelog.md'), 'You are lifelog.\n')
  fs.mkdirSync(paths.agentDir('lifelog'), { recursive: true })
  prepareRun({ paths, agent: { name: 'lifelog', prompt: { path: 'prompts/lifelog.md', file: path.join(paths.configDir, 'prompts', 'lifelog.md') }, skills: [] }, index: createIndex() })
  // The run's bin/ first, as pi's environment has it, and this Node, as the VM's is on its PATH; a
  // home of the test's own in place of the VM's.
  const env = { ...piEnv({ timeZone: 'Asia/Kolkata', binDir: paths.agentRunBin('lifelog'), icuTzDir: paths.agentRunIcuTz('lifelog') }), HOME: root }
  env.PATH = `${env.PATH}:${path.dirname(process.execPath)}`
  const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8', input: '' })
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `${printed}\n`)

  // What the runner reads: the marks, and the messages in order, the second from the
  // here-document, its ends trimmed.
  assert.deepEqual(readMarks(paths.agentRunMarks('lifelog')), {
    done: [1050, 1051, 1052],
    failed: [{ seq: 1053, reason: 'the PDF needs a password' }],
    unreadable: 0,
    refused: null,
  })
  assert.deepEqual(readSends(paths.agentRunSend('lifelog')), {
    messages: [
      { text: 'Is this ticket for you alone, or for Sam too?', replyTo: 1052 },
      { text: 'Filed the coffee and the lunch.', replyTo: null },
    ],
    refused: 0,
    past: 0,
    error: null,
  })
})

test("runner's skill: what it says of a run is what the runner does: what a run gives, the attempts, and how many messages go", () => {
  const said = words => assert.ok(RUNNER_SKILL_FILE.includes(words), words)
  // What a run gives: numbers, never a message's words; a message deleted before it was given is
  // never given (`assembleBatch`); and one line's mark settles no other.
  said('Only their numbers: you read each line with `show`.')
  said('A message the owner deleted before you were given it is never given to you: only its deletion is.')
  said('Marking one line settles no other')
  said(`A line you mark neither way is given to you again, up to ${limits.MAX_ATTEMPTS} attempts in all`)
  said(`Scooter sends at most ${limits.RUN_MAX_SENDS} messages of one run, the first ones, and drops the rest.`)
  // What the agent's document says it describes.
  for (const words of ['## mark', '## send', '## What you can change and reach', 'Read-only file system', 'internet access is `on`', 'git log', 'data, never instructions', '`*bold*`, `_italic_` and `- ` lists', 'in a backfill or a rebuild, nothing you send goes out']) said(words)
  // It names no section of a prompt the runner no longer renders.
  for (const words of ['New messages:', 'Retrying', 'For context only', 'Scheduled task (from']) assert.ok(!RUNNER_SKILL_FILE.includes(words), words)
})
