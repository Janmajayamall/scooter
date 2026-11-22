// The agent's instructions (`docs/architecture/agent.md`; the plan's milestone 11): the default
// config in `config/`, its prompt and its five skills, read against the documents themselves; the
// protocol that ships with the runner, read against the parser of its answers; and the skill that
// ships with the runner, read against the line format (`line.mjs`) and what `show` prints.
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
import { answerEntries, parseAnswer, reportsOf } from '../src/runner/answer.mjs'
import { RUNNER_SKILL, loadConfig, parseConfig, skillFileProblem } from '../src/runner/config.mjs'
import { openDatastore } from '../src/runner/datastore.mjs'
import { SECTIONS, loadProtocol } from '../src/runner/prompt.mjs'
import { SKILLS, exampleYaml, fillerLines, indexOf, line, writeConfig } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const CONFIG = path.join(REPO, 'config')
const AGENT = fs.readFileSync(path.join(REPO, 'docs', 'architecture', 'agent.md'), 'utf8')
const DATASTORE = fs.readFileSync(path.join(REPO, 'docs', 'architecture', 'datastore.md'), 'utf8')
const RUNNER_SKILL_FILE = fs.readFileSync(path.join(REPO, 'src', 'runner', 'vm', 'skills', RUNNER_SKILL, 'SKILL.md'), 'utf8')
const read = (...parts) => fs.readFileSync(path.join(CONFIG, ...parts), 'utf8')
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
  const { agents } = loadConfig({ paths: makePaths({ dataDir: path.join(root, 'data'), configDir: CONFIG }) })
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

test("instructions: a run's system prompt is the protocol, then the prompt, then the memory, with the five skills copied for pi", t => {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: CONFIG })
  const [agent] = loadConfig({ paths }).agents
  fs.mkdirSync(paths.agentMemory('lifelog'), { recursive: true })
  fs.writeFileSync(path.join(paths.agentMemory('lifelog'), 'preferences.md'), '- 2026-11-09 (#1060): Track coffee and tea in meals.csv as "drink".\n')
  const prepared = prepareRun({ paths, timeZone: 'Asia/Kolkata', agent, protocol: loadProtocol(), index: createIndex(), sessionId: 'lifelog-2026-11-09' })
  const system = fs.readFileSync(prepared.systemFile, 'utf8')
  const protocolAt = system.indexOf('# How you work with Scooter')
  const promptAt = system.indexOf('# You are lifelog')
  const memoryAt = system.indexOf('# Your memory\n\n## memory/preferences.md\n\n- 2026-11-09 (#1060)')
  assert.ok(protocolAt === 0 && promptAt > protocolAt && memoryAt > promptAt, `${protocolAt} ${promptAt} ${memoryAt}`)
  assert.deepEqual(prepared.skillDirs, [path.join(paths.agentRunSkills('lifelog'), 'scooter'), ...SKILLS.map(name => path.join(paths.agentRunConfig('lifelog'), 'skills', name))])
  for (const name of SKILLS) assert.equal(fs.readFileSync(path.join(paths.agentRunConfig('lifelog'), 'skills', name, 'SKILL.md'), 'utf8'), read('skills', name, 'SKILL.md'))
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
  prepareRun({ paths, timeZone: 'Asia/Kolkata', agent, protocol: '', index: datastore.index })

  for (const { args, output } of examples) {
    const result = spawnSync(process.execPath, [path.join(paths.agentRunBin('lifelog'), 'show'), ...args], { env: {}, encoding: 'utf8' })
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
// The protocol against the parser

test('protocol: its example answer is read as it says', () => {
  const protocol = loadProtocol()
  const example = fencedBlocks(protocol).find(block => block.body.startsWith('REPLY_TO:')).body
  const answer = parseAnswer(example)
  assert.deepEqual(answer.done, [1050, 1051, 1052])
  assert.deepEqual(answer.failed, [{ seq: 1053, reason: 'the PDF needs a password' }])
  assert.deepEqual(answer.messages.map(message => message.replyTo), [1052, 1053])
  assert.equal(answer.noReply, false)
  assert.equal(answer.unreadable, 0)

  // In quiet mode: the two replies, and a reaction to each message done that wasn't replied to.
  const lines = [1050, 1051, 1052, 1053].map(seq => line.text(seq, '2026-11-09T15:43:00Z', `message ${seq}`))
  const index = indexOf([...fillerLines(1049), ...lines])
  const reports = reportsOf(answer, [1050, 1051, 1052, 1053])
  assert.deepEqual([...reports.done], [1050, 1051, 1052])
  const agent = { name: 'lifelog', sends: ['whatsapp'], replyMode: 'quiet', ackReaction: '✅' }
  const entries = answerEntries({ answer, agent, index, about: 1053, done: reports.done })
  assert.deepEqual(
    entries.map(entry => (entry.type === 'text' ? `text ${entry.replyTo}` : `react ${entry.target}`)),
    ['text 1052', 'text 1053', 'react 1050', 'react 1051'],
  )
})

test('protocol: what it says of each line is what the parser does', () => {
  const protocol = loadProtocol()
  const said = words => assert.ok(protocol.includes(words), words)

  // A `#` is fine; a range isn't read.
  said('A `#` before a number is fine.')
  assert.deepEqual(parseAnswer('DONE: #1050 #1051').done, [1050, 1051])
  said('a range such as `1050-1053` isn\'t read')
  assert.deepEqual(parseAnswer('DONE: 1050-1053'), { done: [], failed: [], messages: [], noReply: false, unreadable: 1 })

  // The reason on the same line.
  said('`FAILED: <number> <reason>`')
  assert.deepEqual(parseAnswer('FAILED: 1053 the PDF needs a password').failed, [{ seq: 1053, reason: 'the PDF needs a password' }])

  // `REPLY_TO` with nothing else on its line; a line that starts with an instruction but can't be
  // read is dropped, and isn't sent.
  said('put `REPLY_TO: <number>` on a line of its own before it, with nothing else on that line')
  said("A line that starts with one of them but can't be read is dropped, and isn't sent to the owner either.")
  const extra = parseAnswer('REPLY_TO: 1052 about the ticket\nIs it for Sam too?\nDONE: 1052')
  assert.deepEqual(extra.messages, [{ replyTo: null, text: 'Is it for Sam too?' }])
  assert.equal(extra.unreadable, 1)
  // Text before the first `REPLY_TO` is a message of its own; everything after one, up to the
  // next, is one message.
  said('Text before the first `REPLY_TO` is sent as a message of its own.')
  assert.deepEqual(parseAnswer('Filed both.\nREPLY_TO: 1052\nFor Sam too?\nAnd the return?\nREPLY_TO: 1053\nLocked.').messages, [
    { replyTo: null, text: 'Filed both.' },
    { replyTo: 1052, text: 'For Sam too?\nAnd the return?' },
    { replyTo: 1053, text: 'Locked.' },
  ])

  // `NO_REPLY` anywhere sends none of the text.
  said('a `NO_REPLY` line anywhere in the answer sends none of its text')
  const quiet = parseAnswer('Filed the coffee.\nNO_REPLY\nDONE: 1050')
  const index = indexOf([...fillerLines(1049), line.text(1050, '2026-11-09T15:43:00Z', 'coffee 150')])
  const agent = { name: 'lifelog', sends: ['whatsapp'], replyMode: 'quiet', ackReaction: '✅' }
  assert.deepEqual(answerEntries({ answer: quiet, agent, index, about: 1050, done: new Set([1050]) }), [
    { type: 'react', by: 'lifelog', target: 1050, emoji: '✅', channels: ['whatsapp'] },
  ])

  // Instructions are read at the start of a line, in capitals with their colon, after trimming.
  said('each at the start of its own line: the word in capitals, then its colon')
  assert.deepEqual(parseAnswer('  DONE: 1050  ').done, [1050])
  for (const text of ['**DONE: 1050**', '- DONE: 1050', 'done: 1050', 'DONE 1050', '`DONE: 1050`']) assert.deepEqual(parseAnswer(text).done, [], text)

  // The number of messages one answer sends.
  said(`Scooter sends at most ${limits.ANSWER_MAX_TEXTS} messages from one answer, the first ones, and drops the rest.`)

  // The sections of the prompt, by the names `prompt.mjs` gives them.
  for (const heading of [SECTIONS.new, SECTIONS.retrying, SECTIONS.context]) said(`**${heading.replace(/:$/, '')}:**`)
  said(`\`${SECTIONS.task}\``)
})
