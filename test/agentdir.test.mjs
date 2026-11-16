// The agent's folder (6.2 of DESIGN.md) and `run/`, built before each run (6.5, 6.6): git, the
// `.gitignore` and the first commit; the copy of the config; the session copied in; and
// `run/system.md`, with the memory read without following links.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { GITIGNORE, ensureAgentDir, prepareRun } from '../src/runner/agentdir.mjs'
import { loadConfig } from '../src/runner/config.mjs'
import { createGit } from '../src/runner/git.mjs'
import { loadProtocol, readMemoryFile, renderSystemPrompt } from '../src/runner/prompt.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { writeConfig } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const modeOf = file => fs.statSync(file).mode & 0o7777
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })

function setup(t) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  writeConfig(paths.configDir)
  const clock = createFakeClock('2026-11-09T15:43:02Z')
  const { log, events } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const dir = paths.agentDir('lifelog')
  const agentGit = createGit({ proc, dir, clock })
  const ensure = () => ensureAgentDir({ paths, name: 'lifelog', git: agentGit, log })
  const agent = () => loadConfig({ paths }).agents[0]
  return { root, paths, clock, events, dir, ensure, agent }
}

test('agent folder: made on the first start, with git, a .gitignore and one commit by Scooter', async t => {
  const { paths, dir, ensure, events } = setup(t)
  await ensure()
  for (const folder of [paths.agents, dir, paths.agentViews('lifelog'), paths.agentMemory('lifelog'), paths.agentSessions('lifelog'), paths.agentRun('lifelog')]) {
    assert.equal(modeOf(folder), 0o700, folder)
  }
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '/sessions/\n/run/\n/state.json\n')
  assert.equal(GITIGNORE, '/sessions/\n/run/\n/state.json\n')

  const commit = git(dir, 'cat-file', '-p', 'HEAD')
  assert.match(commit, /^author Scooter <scooter@localhost> 1794238982 \+0000$/m)
  assert.match(commit, /^committer Scooter <scooter@localhost> 1794238982 \+0000$/m)
  assert.doesNotMatch(commit, /gpgsig/)
  assert.match(commit, /\n\nlifelog: initial commit\n$/)
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main\n')
  assert.equal(git(dir, 'ls-files'), '.gitignore\n')
  assert.deepEqual(events(), ['agent.git_init', 'agent.created'])

  // Safe to repeat: a second start changes nothing.
  await ensure()
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1\n')
})

test('agent folder: the .gitignore is anchored, so it can\'t match anything in views/ or memory/', async t => {
  const { dir, ensure } = setup(t)
  await ensure()
  const ignored = file => {
    try {
      git(dir, 'check-ignore', '--no-index', '-q', file)
      return true
    } catch {
      return false
    }
  }
  for (const file of ['sessions/lifelog-2026-11-09.jsonl', 'run/system.md', 'run/session/x.jsonl', 'state.json']) assert.equal(ignored(file), true, file)
  for (const file of ['views/sessions/a.csv', 'views/run/b.md', 'views/state.json', 'memory/run/x.md', 'memory/state.json']) assert.equal(ignored(file), false, file)
})

test('agent folder: a start that a crash cut short is finished', async t => {
  const { dir, ensure } = setup(t)
  // The folder is there, with no repository.
  fs.mkdirSync(path.join(dir, 'views'), { recursive: true, mode: 0o700 })
  await ensure()
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1\n')

  // A repository with no commit yet.
  fs.rmSync(path.join(dir, '.git'), { recursive: true })
  git(dir, 'init', '--quiet')
  await ensure()
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1\n')
  assert.equal(git(dir, 'ls-files'), '.gitignore\n')
})

test('run folder: a fresh copy of the prompt and skills, the session, and system.md', async t => {
  const { paths, dir, ensure, agent } = setup(t)
  await ensure()
  // A skill with a script that can be run, in a folder of its own.
  const runs = path.join(paths.configDir, 'skills', 'runs')
  fs.mkdirSync(path.join(runs, 'scripts'))
  fs.writeFileSync(path.join(runs, 'scripts', 'pace.sh'), '#!/bin/sh\n', { mode: 0o755 })
  // Left from the run before.
  fs.mkdirSync(path.join(dir, 'run', 'session'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'run', 'session', 'old.jsonl'), 'old')
  fs.writeFileSync(path.join(dir, 'run', 'leftover'), 'x')
  // The runner's copy of today's session.
  fs.writeFileSync(path.join(dir, 'sessions', 'lifelog-2026-11-09.jsonl'), '{"type":"session"}\n')
  fs.writeFileSync(path.join(dir, 'memory', 'preferences.md'), '- 2026-11-09 (#1060): Track coffee in meals.csv as "drink".\n')

  const result = prepareRun({ paths, agent: agent(), protocol: '# Protocol\n', sessionId: 'lifelog-2026-11-09' })
  const run = path.join(dir, 'run')
  assert.deepEqual(result, {
    systemFile: path.join(run, 'system.md'),
    skillDirs: ['expenses', 'runs', 'meals', 'travel', 'people', 'day-pages'].map(name => path.join(run, 'config', 'skills', name)),
    sessionDir: path.join(run, 'session'),
    sessionFile: path.join(run, 'session', 'lifelog-2026-11-09.jsonl'),
  })
  assert.deepEqual(fs.readdirSync(run).sort(), ['config', 'session', 'system.md'])
  assert.deepEqual(fs.readdirSync(path.join(run, 'session')), ['lifelog-2026-11-09.jsonl'])
  assert.equal(fs.readFileSync(path.join(run, 'config', 'prompts', 'lifelog.md'), 'utf8'), 'You are lifelog.\n')
  assert.match(fs.readFileSync(path.join(run, 'config', 'skills', 'runs', 'SKILL.md'), 'utf8'), /^---\nname: runs\n/)
  assert.equal(modeOf(path.join(run, 'config', 'skills', 'runs', 'scripts', 'pace.sh')), 0o700)
  assert.equal(modeOf(path.join(run, 'config', 'skills', 'runs', 'SKILL.md')), 0o600)
  assert.equal(modeOf(path.join(run, 'system.md')), 0o600)
  for (const folder of [run, path.join(run, 'config'), path.join(run, 'session')]) assert.equal(modeOf(folder), 0o700)
  assert.equal(
    fs.readFileSync(result.systemFile, 'utf8'),
    `# Protocol

You are lifelog.

# Your memory

## memory/preferences.md

- 2026-11-09 (#1060): Track coffee in meals.csv as "drink".

## memory/needs-review.md

(empty)
`,
  )

  // A new day's session: nothing to copy. A backfill gets only the skills it names.
  const other = prepareRun({ paths, agent: agent(), protocol: '# Protocol\n', sessionId: 'lifelog-2026-11-10', skills: agent().skills.slice(4) })
  assert.equal(other.sessionFile, null)
  assert.deepEqual(fs.readdirSync(path.join(run, 'session')), [])
  assert.deepEqual(fs.readdirSync(path.join(run, 'config', 'skills')).sort(), ['day-pages', 'people'])
  // `session: none` has no session at all.
  assert.equal(prepareRun({ paths, agent: agent(), protocol: '# Protocol\n' }).sessionFile, null)
})

test('run folder: a session file that is a link isn\'t copied in', async t => {
  const { root, paths, dir, ensure, agent } = setup(t)
  await ensure()
  fs.writeFileSync(path.join(root, 'elsewhere.jsonl'), 'not a session')
  fs.symlinkSync(path.join(root, 'elsewhere.jsonl'), path.join(dir, 'sessions', 'lifelog-2026-11-09.jsonl'))
  const result = prepareRun({ paths, agent: agent(), protocol: '', sessionId: 'lifelog-2026-11-09' })
  assert.equal(result.sessionFile, null)
  assert.deepEqual(fs.readdirSync(result.sessionDir), [])
})

test('run folder: something in the config that isn\'t a file or a folder stops the run', async t => {
  const { root, paths, ensure, agent } = setup(t)
  await ensure()
  const config = agent()
  // Added after the config was checked at startup.
  fs.writeFileSync(path.join(root, 'secret'), 'key')
  fs.symlinkSync(path.join(root, 'secret'), path.join(paths.configDir, 'skills', 'people', 'notes.md'))
  assert.throws(() => prepareRun({ paths, agent: config, protocol: '' }), error => error.code === 'ECONFIG')
})

test('memory: read without following a link, only from a regular file, and at most MEMORY_MAX_BYTES', t => {
  const root = makeTestDir(t)
  const file = name => path.join(root, name)
  assert.equal(readMemoryFile(file('missing.md')), null)
  fs.writeFileSync(file('plain.md'), '- one\n')
  assert.deepEqual(readMemoryFile(file('plain.md')), { text: '- one\n', cut: false })

  // pi writes the memory folder: a link to the runner's env file must not put the key in the prompt.
  fs.writeFileSync(file('runner.env'), 'OPENROUTER_API_KEY=sk-or-secret\n')
  fs.symlinkSync(file('runner.env'), file('link.md'))
  assert.deepEqual(readMemoryFile(file('link.md')), { text: '(not a regular file, so not read)', cut: false })
  // A FIFO isn't waited on.
  execFileSync('mkfifo', [file('fifo.md')])
  assert.deepEqual(readMemoryFile(file('fifo.md')), { text: '(not a regular file, so not read)', cut: false })
  fs.mkdirSync(file('folder.md'))
  assert.deepEqual(readMemoryFile(file('folder.md')), { text: '(not a regular file, so not read)', cut: false })

  // Too long: cut, without splitting a character, and the prompt says so.
  fs.writeFileSync(file('long.md'), `${'a'.repeat(64 * 1024 - 1)}€ and more`)
  const long = readMemoryFile(file('long.md'))
  assert.equal(long.cut, true)
  assert.equal(long.text, 'a'.repeat(64 * 1024 - 1))
  const system = renderSystemPrompt({ protocol: 'P', prompt: 'Q', preferences: long, needsReview: { text: '\n', cut: false } })
  assert.match(system, /a\n\n\(The file is longer than 65536 bytes, and only its beginning is shown\. Shorten it\.\)\n\n## memory\/needs-review\.md\n\n\(empty\)\n$/)
})

test('protocol: it ships with the runner and says what the answer parser reads', () => {
  const protocol = loadProtocol()
  for (const words of ['DONE: <number>', 'FAILED: <number> <reason>', 'REPLY_TO: <number>', 'NO_REPLY', 'memory/needs-review.md', 'memory/preferences.md', 'Internet: on', 'git log', 'backfill', '`*bold*`, `_italic_` and `- ` lists']) {
    assert.ok(protocol.includes(words), words)
  }
})
