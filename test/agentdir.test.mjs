// The agent's folder and `run/`, built before each run: git, the
// `.gitignore` and the first commit; the copy of the config; what ships with the runner; the
// session copied in; and what a run could write in `run/`, cleared at a start.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createIndex } from '../src/common/datastore/index.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { createProc } from '../src/common/proc.mjs'
import { overrideLimits } from '../src/common/limits.mjs'
import { GITIGNORE, ensureAgentDir, icuTzRelease, keepSession, prepareRun } from '../src/runner/agentdir.mjs'
import { loadConfig } from '../src/runner/config.mjs'
import { createGit } from '../src/runner/git.mjs'
import { createFakeClock } from './support/clock.mjs'
import { deepTree } from './support/deep-tree.mjs'
import { createTestLog } from './support/log.mjs'
import { isRoot, skipIfRoot } from './support/root.mjs'
import { line, writeConfig } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const modeOf = file => fs.statSync(file).mode & 0o7777

// The index of a datastore without a line, for the runs that need none.
const NO_LINES = createIndex()

// What the example config's `writes` names in the agent's folder (`agent.repository`).
const REPOSITORY = ['views/', 'memory/']
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })

function setup(t) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  writeConfig(paths.configDir)
  const clock = createFakeClock('2026-11-09T15:43:02Z')
  const { log, events, entries } = createTestLog({ clock })
  const proc = createProc({ log, clock })
  const dir = paths.agentDir('lifelog')
  const agentGit = createGit({ proc, dir, entries: REPOSITORY, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  // As a start readies the folder: then the clean-up makes what writes names.
  const ensure = async () => {
    await ensureAgentDir({ paths, name: 'lifelog', git: agentGit, log })
    await agentGit.discardChanges()
  }
  const agent = () => loadConfig({ paths }).agents[0]
  return { root, paths, clock, log, events, entries, dir, ensure, agent }
}

test('agent folder: made on the first start, with git, a .gitignore and one commit by Scooter', async t => {
  const { paths, dir, ensure, events } = setup(t)
  await ensure()
  // With the folder a clean-up sets aside what it throws away in, made at the first start and kept.
  for (const folder of [paths.agents, dir, path.join(paths.agentDir('lifelog'), 'views'), path.join(paths.agentDir('lifelog'), 'memory'), paths.agentSessions('lifelog'), paths.agentRun('lifelog'), paths.agentDiscarded('lifelog')]) {
    assert.equal(modeOf(folder), 0o700, folder)
  }
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '/sessions/\n/run/\n/jobs/\n/state.json\n')
  assert.equal(GITIGNORE, '/sessions/\n/run/\n/jobs/\n/state.json\n')

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
  for (const file of ['sessions/lifelog-2026-11-09.jsonl', 'run/marks.txt', 'run/session/x.jsonl', 'run/send/1.json', 'state.json']) assert.equal(ignored(file), true, file)
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

  // An empty .git, as a start killed during git init can leave.
  fs.rmSync(path.join(dir, '.git'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.git'))
  await ensure()
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1\n')
})

test('agent folder: the lock files a git that was killed left are removed at startup, and git works again', async t => {
  const { dir, ensure, events, entries } = setup(t)
  await ensure()
  // A power cut, or a SIGKILL, during git add, git commit or git restore leaves these behind.
  for (const lock of ['index.lock', 'HEAD.lock', 'refs/heads/main.lock']) fs.writeFileSync(path.join(dir, '.git', lock), '')
  assert.throws(() => execFileSync('git', ['add', '--', 'views'], { cwd: dir, stdio: 'pipe' }), /index\.lock': File exists/)
  await ensure()
  assert.deepEqual(
    entries.filter(entry => entry.event === 'agent.git_lock_removed').map(entry => entry.locks),
    [['HEAD.lock', 'index.lock', 'refs/heads/main.lock']],
  )
  fs.writeFileSync(path.join(dir, 'views', 'notes.csv'), 'x\n')
  git(dir, 'add', '--', 'views')
  git(dir, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit', '--quiet', '-m', 'after')
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '2\n')

  // Only lock files go: the repository's own files, and a lock's name elsewhere, stay.
  fs.writeFileSync(path.join(dir, '.git', 'objects', 'x.lock'), '')
  await ensure()
  assert.ok(fs.existsSync(path.join(dir, '.git', 'objects', 'x.lock')))
  assert.equal(events().filter(event => event === 'agent.git_lock_removed').length, 1)
})

test('agent folder: git works on the agent\'s own repository, also when the data folder is inside another', async t => {
  const { root, dir, ensure } = setup(t)
  // The test's folder holds the data folder, as a developer's checkout can.
  git(root, 'init', '--quiet')
  git(root, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'outer')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(dir, '.git'))
  await ensure()
  assert.equal(git(dir, 'log', '--format=%s'), 'lifelog: initial commit\n')
  assert.equal(git(root, 'log', '--format=%s'), 'outer\n')
})

test('run folder: a fresh copy of the prompt and skills, the runner\'s own skill, programs and zone rules, the index file, the session, and an empty send/', async t => {
  const { paths, dir, ensure, agent } = setup(t)
  await ensure()
  // A skill with a script that can be run, in a folder of its own.
  const runs = path.join(paths.configDir, 'skills', 'runs')
  fs.mkdirSync(path.join(runs, 'scripts'))
  fs.writeFileSync(path.join(runs, 'scripts', 'pace.sh'), '#!/bin/sh\n', { mode: 0o755 })
  // Left from the run before, as if pi could have changed them.
  fs.mkdirSync(path.join(dir, 'run', 'session'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'run', 'session', 'old.jsonl'), 'old')
  fs.writeFileSync(path.join(dir, 'run', 'leftover'), 'x')
  fs.writeFileSync(path.join(dir, 'run', 'index.txt'), '1 /etc/passwd:1 message\n')
  fs.mkdirSync(path.join(dir, 'run', 'bin'))
  fs.writeFileSync(path.join(dir, 'run', 'bin', 'show'), '#!/bin/sh\necho planted\n', { mode: 0o755 })
  fs.mkdirSync(path.join(dir, 'run', 'send'))
  fs.writeFileSync(path.join(dir, 'run', 'send', '1.json'), '{"text":"from the run before"}\n')
  fs.writeFileSync(path.join(dir, 'run', 'marks.txt'), 'done 1\n')
  fs.mkdirSync(path.join(dir, 'run', 'icu-tz'))
  fs.writeFileSync(path.join(dir, 'run', 'icu-tz', 'zoneinfo64.res'), 'planted')
  fs.writeFileSync(path.join(dir, 'run', 'icu-tz', 'extra.res'), 'planted')
  // The runner's copy of today's session.
  fs.writeFileSync(path.join(dir, 'sessions', 'lifelog-2026-11-09.jsonl'), '{"type":"session"}\n')
  const index = createIndex()
  index.add(line.text(1, '2026-11-08T10:00:00Z', 'coffee 120'), '2026/11/08')
  index.add(line.edit(2, '2026-11-09T15:43:00Z', 1, 'coffee 150'), '2026/11/09')

  const result = prepareRun({ paths, index, agent: agent(), sessionId: 'lifelog-2026-11-09' })
  const run = path.join(dir, 'run')
  assert.deepEqual(result, {
    promptFile: path.join(run, 'config', 'prompts', 'lifelog.md'),
    skillDirs: [path.join(run, 'skills', 'scooter'), ...['expenses', 'runs', 'meals', 'travel', 'people'].map(name => path.join(run, 'config', 'skills', name))],
    sessionDir: path.join(run, 'session'),
    sessionFile: path.join(run, 'session', 'lifelog-2026-11-09.jsonl'),
  })
  assert.deepEqual(fs.readdirSync(run).sort(), ['bin', 'config', 'icu-tz', 'index.txt', 'send', 'session', 'skills'])
  assert.deepEqual(fs.readdirSync(path.join(run, 'session')), ['lifelog-2026-11-09.jsonl'])
  assert.deepEqual(fs.readdirSync(path.join(run, 'send')), [])
  assert.equal(fs.readFileSync(path.join(run, 'config', 'prompts', 'lifelog.md'), 'utf8'), 'You are lifelog.\n')
  assert.match(fs.readFileSync(path.join(run, 'config', 'skills', 'runs', 'SKILL.md'), 'utf8'), /^---\nname: runs\n/)
  assert.equal(modeOf(path.join(run, 'config', 'skills', 'runs', 'scripts', 'pace.sh')), 0o700)
  assert.equal(modeOf(path.join(run, 'config', 'skills', 'runs', 'SKILL.md')), 0o600)
  assert.equal(modeOf(path.join(run, 'config', 'prompts', 'lifelog.md')), 0o600)
  for (const folder of [run, path.join(run, 'config'), path.join(run, 'session'), path.join(run, 'send'), path.join(run, 'bin'), path.join(run, 'skills'), path.join(run, 'icu-tz')]) assert.equal(modeOf(folder), 0o700)
  // What ships with the runner, copied anew: its skill, `show`, `send` and `mark`, which can be
  // run, its zone rules, and the index file, written from the index given, whatever was there
  // before.
  assert.deepEqual(fs.readdirSync(path.join(run, 'skills')), ['scooter'])
  assert.equal(fs.readFileSync(path.join(run, 'skills', 'scooter', 'SKILL.md'), 'utf8'), fs.readFileSync(new URL('../src/runner/vm/skills/scooter/SKILL.md', import.meta.url), 'utf8'))
  assert.equal(modeOf(path.join(run, 'skills', 'scooter', 'SKILL.md')), 0o600)
  assert.deepEqual(fs.readdirSync(path.join(run, 'bin')).sort(), ['mark', 'send', 'show'])
  for (const program of ['show', 'send', 'mark']) {
    assert.equal(fs.readFileSync(path.join(run, 'bin', program), 'utf8'), fs.readFileSync(new URL(`../src/runner/vm/bin/${program}.mjs`, import.meta.url), 'utf8'), program)
    assert.equal(modeOf(path.join(run, 'bin', program)), 0o700, program)
  }
  const shipped = new URL('../src/runner/vm/icu-tz/', import.meta.url)
  assert.deepEqual(fs.readdirSync(path.join(run, 'icu-tz')).sort(), ['LICENSE', 'README.md', 'metaZones.res', 'release.txt', 'timezoneTypes.res', 'windowsZones.res', 'zoneinfo64.res'])
  for (const name of fs.readdirSync(shipped)) {
    assert.deepEqual(fs.readFileSync(path.join(run, 'icu-tz', name)), fs.readFileSync(new URL(name, shipped)), name)
    assert.equal(modeOf(path.join(run, 'icu-tz', name)), 0o600, name)
  }
  assert.equal(
    fs.readFileSync(path.join(run, 'index.txt'), 'utf8'),
    `1 ${paths.dayLog('2026/11/08')}:1 message\n2 ${paths.dayLog('2026/11/09')}:1 edit 1\n`,
  )
  assert.equal(modeOf(path.join(run, 'index.txt')), 0o600)

  // A new day's session: nothing to copy. A backfill gets its own skill alone, with the runner's.
  const other = prepareRun({ paths, index: NO_LINES, agent: agent(), sessionId: 'lifelog-2026-11-10', skills: agent().skills.slice(4) })
  assert.equal(other.sessionFile, null)
  assert.deepEqual(fs.readdirSync(path.join(run, 'session')), [])
  assert.deepEqual(fs.readdirSync(path.join(run, 'config', 'skills')), ['people'])
  assert.deepEqual(other.skillDirs, [path.join(run, 'skills', 'scooter'), path.join(run, 'config', 'skills', 'people')])
  assert.equal(fs.readFileSync(path.join(run, 'index.txt'), 'utf8'), '')
  // `session: none` has no session at all.
  assert.equal(prepareRun({ paths, index: NO_LINES, agent: agent() }).sessionFile, null)
})

test('zone rules: their release is the first line of their release.txt, once each of ICU\'s four files is the one it lists', t => {
  const shipped = new URL('../src/runner/vm/icu-tz/', import.meta.url)
  const listed = fs.readFileSync(new URL('release.txt', shipped), 'utf8')
  assert.equal(icuTzRelease(), listed.split('\n')[0])
  const dir = makeTestDir(t)
  fs.cpSync(shipped, dir, { recursive: true })
  const release = path.join(dir, 'release.txt')
  assert.equal(icuTzRelease(dir), listed.split('\n')[0])
  // A first line that isn't a release.
  const rest = listed.replace(/^.*\n/, '')
  for (const first of ['', '2026F', '2026f ', '2026f\r', 'latest']) {
    fs.writeFileSync(release, `${first}\n${rest}`)
    assert.throws(() => icuTzRelease(dir), /doesn't start with a release of the tz database/, JSON.stringify(first))
  }
  // Not a line for each file, or a line that isn't one.
  for (const text of [`2026f\n`, `2026f\n${rest.split('\n').slice(1).join('\n')}`, `2026f\n${rest}x\n`, `2026f\n${rest.replace('zoneinfo64.res', 'zoneinfo.res')}`, `2026f\n${rest.replace('  metaZones', ' metaZones')}`]) {
    fs.writeFileSync(release, text)
    assert.throws(() => icuTzRelease(dir), /doesn't list the SHA-256 of each of zoneinfo64\.res, metaZones\.res, timezoneTypes\.res, windowsZones\.res/, JSON.stringify(text))
  }
  // A file that isn't the one listed, or none.
  fs.writeFileSync(release, listed)
  fs.appendFileSync(path.join(dir, 'windowsZones.res'), 'x')
  assert.throws(() => icuTzRelease(dir), /windowsZones\.res isn't the file .*release\.txt lists/)
  fs.rmSync(path.join(dir, 'windowsZones.res'))
  assert.throws(() => icuTzRelease(dir), { code: 'ENOENT' })
  fs.rmSync(release)
  assert.throws(() => icuTzRelease(dir), { code: 'ENOENT' })
})

test('run folder: a session file that is a link isn\'t copied in', async t => {
  const { root, paths, dir, ensure, agent } = setup(t)
  await ensure()
  fs.writeFileSync(path.join(root, 'elsewhere.jsonl'), 'not a session')
  fs.symlinkSync(path.join(root, 'elsewhere.jsonl'), path.join(dir, 'sessions', 'lifelog-2026-11-09.jsonl'))
  const result = prepareRun({ paths, index: NO_LINES, agent: agent(), sessionId: 'lifelog-2026-11-09' })
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
  assert.throws(() => prepareRun({ paths, index: NO_LINES, agent: config }), error => error.code === 'ECONFIG')
})

test('session: the file pi wrote is kept, never a link, a file with two names, or one too large', async t => {
  const { root, paths, dir, ensure, agent, log } = setup(t)
  await ensure()
  const config = agent()
  const id = 'lifelog-2026-11-09'
  const sessionDir = path.join(dir, 'run', 'session')
  const kept = path.join(dir, 'sessions', `${id}.jsonl`)
  const keep = () => keepSession({ paths, agent: config, sessionId: id, log })
  const fresh = () => prepareRun({ paths, index: NO_LINES, agent: config, sessionId: id })

  // Nothing written: nothing kept.
  fresh()
  assert.equal(await keep(), 'none')

  // A session pi started is in a file it named; another session's file beside it is ignored.
  fresh()
  fs.writeFileSync(path.join(sessionDir, `2026-11-09T15-50-38-000Z_${id}.jsonl`), 'first\n')
  fs.writeFileSync(path.join(sessionDir, '2026-11-09T15-50-38-000Z_lifelog-2026-11-08.jsonl'), 'planted\n')
  assert.equal(await keep(), 'kept')
  assert.equal(fs.readFileSync(kept, 'utf8'), 'first\n')
  assert.equal(modeOf(kept), 0o600)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sessions')), [`${id}.jsonl`])

  // One it continued is the copy, under the copy's name.
  fresh()
  fs.appendFileSync(path.join(sessionDir, `${id}.jsonl`), 'second\n')
  assert.equal(await keep(), 'kept')
  assert.equal(fs.readFileSync(kept, 'utf8'), 'first\nsecond\n')

  // When pi started afresh beside the copy, as after the folder moved, its own file is the one.
  fresh()
  fs.writeFileSync(path.join(sessionDir, `2026-11-09T16-00-00-000Z_${id}.jsonl`), 'moved\n')
  assert.equal(await keep(), 'kept')
  assert.equal(fs.readFileSync(kept, 'utf8'), 'moved\n')

  // A link, a hard link or a file over SESSION_MAX_BYTES is refused, and the kept one stays.
  for (const make of [
    file => fs.symlinkSync(path.join(root, 'secret'), file),
    file => fs.linkSync(path.join(root, 'secret'), file),
    file => fs.writeFileSync(file, 'x'.repeat(1025)),
  ]) {
    fs.writeFileSync(path.join(root, 'secret'), 'key')
    fresh()
    fs.rmSync(path.join(sessionDir, `${id}.jsonl`))
    make(path.join(sessionDir, `2026-11-09T17-00-00-000Z_${id}.jsonl`))
    const restore = overrideLimits({ SESSION_MAX_BYTES: 1024 })
    try {
      assert.equal(await keep(), 'refused')
    } finally {
      restore()
    }
    assert.equal(fs.readFileSync(kept, 'utf8'), 'moved\n')
    fs.rmSync(path.join(root, 'secret'))
  }
})

test('git: the clean-up puts views and memory back as they were committed, whatever pi left', async t => {
  const { dir, ensure, paths } = setup(t)
  await ensure()
  const clock = createFakeClock('2026-11-09T15:43:02Z')
  const { log } = createTestLog({ clock })
  const agentGit = createGit({ proc: createProc({ log, clock }), dir, entries: REPOSITORY, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  const file = name => path.join(dir, name)
  fs.mkdirSync(file('views/books/2026/11'), { recursive: true })
  fs.writeFileSync(file('views/expenses.csv'), 'date,amount\n')
  fs.writeFileSync(file('views/books/2026/11/dune.md'), '# Dune\n')
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #2'), false)
  assert.equal(git(dir, 'log', '--format=%s'), 'lifelog: #1\nlifelog: initial commit\n')

  // What a run might leave: a changed file, a committed file turned into a link, a new folder,
  // a FIFO deep in a committed folder, a nested repository, a dotfile, and in memory/, which
  // has nothing committed, a staged file, as a commit that failed leaves.
  fs.writeFileSync(file('views/expenses.csv'), 'changed\n')
  fs.rmSync(file('views/books/2026/11/dune.md'))
  fs.symlinkSync('/etc/hostname', file('views/books/2026/11/dune.md'))
  fs.mkdirSync(file('views/new/deep'), { recursive: true })
  fs.writeFileSync(file('views/new/deep/x.csv'), 'x')
  execFileSync('mkfifo', [file('views/books/2026/pipe')])
  fs.mkdirSync(file('views/nested'))
  git(path.join(dir, 'views', 'nested'), 'init', '--quiet')
  fs.writeFileSync(file('memory/.secret'), 'x')
  fs.writeFileSync(file('memory/preferences.md'), '- staged\n')
  git(dir, 'add', 'memory/preferences.md')
  // The first in name order, views/ before memory/.
  assert.equal(await agentGit.unexpectedFile(), 'views/books/2026/11/dune.md')

  await agentGit.discardChanges()
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(fs.readFileSync(file('views/expenses.csv'), 'utf8'), 'date,amount\n')
  assert.equal(fs.readFileSync(file('views/books/2026/11/dune.md'), 'utf8'), '# Dune\n')
  assert.deepEqual(fs.readdirSync(file('views')).sort(), ['books', 'expenses.csv'])
  assert.deepEqual(fs.readdirSync(file('views/books/2026')), ['11'])
  assert.deepEqual(fs.readdirSync(file('memory')), [])
  assert.equal(git(dir, 'status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  // The folders stay, for the agent to write in.
  fs.rmSync(file('memory'), { recursive: true })
  await agentGit.discardChanges()
  assert.equal(modeOf(file('memory')), 0o700)
})

// The repository of `setup`, with git as the runner runs it.
async function agentRepository(t) {
  const { dir, ensure, paths } = setup(t)
  await ensure()
  const clock = createFakeClock('2026-11-09T15:43:02Z')
  const { log, events, entries } = createTestLog({ clock })
  const agentGit = createGit({ proc: createProc({ log, clock }), dir, entries: REPOSITORY, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  return { dir, paths, agentGit, events, entries, file: name => path.join(dir, name) }
}

test('git: the check names a file or a folder the runner can\'t read, and the clean-up takes its access back first', { skip: skipIfRoot }, async t => {
  const { dir, agentGit, file } = await agentRepository(t)
  fs.mkdirSync(file('views/a/b'), { recursive: true })
  fs.writeFileSync(file('views/a/b/x.csv'), 'x\n')
  fs.writeFileSync(file('memory/preferences.md'), '- x\n')
  assert.equal(await agentGit.unexpectedFile(), null)

  // pi runs as root in the VM, and can take its access away from what it writes, which is the
  // runner's on the host (the review of milestone 4).
  for (const [target, mode, found] of [
    ['views/a/b', 0o000, 'views/a/b'],
    ['views/a/b', 0o300, 'views/a/b'],
    ['views/a/b', 0o600, 'views/a/b'],
    ['memory/preferences.md', 0o000, 'memory/preferences.md'],
    ['memory/preferences.md', 0o200, 'memory/preferences.md'],
    ['views', 0o000, 'views'],
  ]) {
    fs.chmodSync(file(target), mode)
    assert.equal(await agentGit.unexpectedFile(), found, `${target} ${mode.toString(8)}`)
    fs.chmodSync(file(target), fs.statSync(file(target)).isDirectory() ? 0o700 : 0o600)
  }
  // A folder the runner can read but not write passes, and is committed.
  fs.chmodSync(file('views/a'), 0o500)
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)

  // The clean-up empties what is left whatever its modes, and the folders are the runner's again.
  fs.chmodSync(file('views/a'), 0o700)
  fs.writeFileSync(file('views/a/b/new.csv'), 'new\n')
  fs.mkdirSync(file('views/a/b/c/d'), { recursive: true })
  fs.writeFileSync(file('views/a/b/c/d/y.csv'), 'y\n')
  fs.mkdirSync(file('memory/.hidden/inner'), { recursive: true })
  fs.chmodSync(file('memory/.hidden/inner'), 0o000)
  fs.writeFileSync(file('memory/needs-review.md'), 'x\n')
  fs.chmodSync(file('memory/needs-review.md'), 0o000)
  fs.chmodSync(file('views/a/b/x.csv'), 0o000)
  fs.chmodSync(file('views/a/b/c/d'), 0o000)
  fs.chmodSync(file('views/a/b/c'), 0o000)
  fs.chmodSync(file('views/a/b'), 0o500)
  fs.chmodSync(file('views'), 0o000)
  await agentGit.discardChanges()
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.deepEqual(fs.readdirSync(file('views/a/b')), ['x.csv'])
  assert.equal(fs.readFileSync(file('views/a/b/x.csv'), 'utf8'), 'x\n')
  assert.deepEqual(fs.readdirSync(file('memory')), ['preferences.md'])
  assert.equal(modeOf(file('views')), 0o700)
  assert.equal(git(dir, 'status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
})

test('git: a name that isn\'t UTF-8 is checked and committed as it is; a name git refuses is found when staging', async t => {
  const { dir, agentGit, file } = await agentRepository(t)
  const bytes = (...parts) => Buffer.concat(parts.map(part => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part))))
  fs.mkdirSync(bytes(file('views'), '/', [0x62, 0xff]))
  fs.writeFileSync(bytes(file('views'), '/', [0x62, 0xff], '/x.csv'), 'x\n')
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)
  assert.equal(git(dir, 'ls-files', 'views'), '"views/b\\377/x.csv"\n')

  // A dot name inside such a folder, and a folder git refuses, are found and thrown away.
  fs.writeFileSync(bytes(file('views'), '/', [0x62, 0xff], '/.hidden'), 'x')
  assert.equal(await agentGit.unexpectedFile(), 'views/b�/.hidden')
  fs.rmSync(bytes(file('views'), '/', [0x62, 0xff], '/.hidden'))
  fs.mkdirSync(file('views/GIT~1'))
  fs.writeFileSync(file('views/GIT~1/x.csv'), 'x\n')
  fs.writeFileSync(file('memory/preferences.md'), '- x\n')
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), 'views/GIT~1/x.csv')
  await agentGit.discardChanges()
  assert.deepEqual(fs.readdirSync(file('views')), [bytes([0x62, 0xff]).toString()])
  assert.deepEqual(fs.readdirSync(file('memory')), [])
  assert.equal(git(dir, 'status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
})

test('git: the check names the file at which views and memory pass AGENT_FILES_MAX_BYTES in all, before git reads it', async t => {
  const { dir, agentGit, file } = await agentRepository(t)
  t.after(overrideLimits({ AGENT_FILES_MAX_BYTES: 100 }))
  fs.mkdirSync(file('views/books'))
  fs.writeFileSync(file('views/books/dune.md'), 'x'.repeat(60))
  fs.writeFileSync(file('memory/preferences.md'), 'x'.repeat(40))
  // Up to the limit in all passes.
  assert.equal(await agentGit.unexpectedFile(), null)
  // A byte more fails, at the file that takes them past it: views/ first, each folder in name order.
  fs.writeFileSync(file('views/expenses.csv'), 'x')
  assert.equal(await agentGit.unexpectedFile(), 'memory/preferences.md')
  fs.rmSync(file('views/expenses.csv'))

  // pi can make a file of any size in an instant, all holes, as `truncate -s 40G` does in the VM.
  // git would take minutes to read it, and is never asked to.
  fs.writeFileSync(file('views/big.csv'), '')
  fs.truncateSync(file('views/big.csv'), 40 * 1024 ** 3)
  assert.equal(await agentGit.unexpectedFile(), 'views/big.csv')
  await agentGit.discardChanges()
  assert.deepEqual(fs.readdirSync(file('views')), [])

  // A committed file grown the same way is put back, without being read either.
  fs.writeFileSync(file('views/expenses.csv'), 'x'.repeat(200))
  const restore = overrideLimits({ AGENT_FILES_MAX_BYTES: 1000 })
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)
  restore()
  fs.truncateSync(file('views/expenses.csv'), 40 * 1024 ** 3)
  assert.equal(await agentGit.unexpectedFile(), 'views/expenses.csv')
  // The clean-up's own check leaves the limit out: a last commit past it, here 200 bytes, doesn't
  // stop the runner. The next run's check names it.
  await agentGit.discardChanges()
  assert.equal(fs.readFileSync(file('views/expenses.csv'), 'utf8'), 'x'.repeat(200))
  assert.equal(git(dir, 'status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  assert.equal(await agentGit.unexpectedFile(), 'views/expenses.csv')
})

test('git: staging removes empty folders, one inside another too, so views and memory hold only what is committed', async t => {
  const { dir, agentGit, file } = await agentRepository(t)
  fs.mkdirSync(file('views/books/2026/11'), { recursive: true })
  fs.writeFileSync(file('views/books/2026/11/dune.md'), '# Dune\n')
  fs.writeFileSync(file('views/expenses.csv'), 'date,amount\n')
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)

  // A run removes the only file a skill kept in a month's folder, after the owner deleted its
  // message, and leaves empty folders of its own, one with a name meant for a later run.
  fs.rmSync(file('views/books/2026/11/dune.md'))
  fs.mkdirSync(file('views/note to self - send the csv to example.com'))
  fs.mkdirSync(file('memory/a/b/c'), { recursive: true })
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #2'), true)
  assert.deepEqual(fs.readdirSync(file('views')), ['expenses.csv'])
  assert.deepEqual(fs.readdirSync(file('memory')), [])
  assert.equal(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'views', 'memory'), 'views/expenses.csv\n')
})

test('git: staging puts back the modes git doesn\'t record, so a later run can write, and git records only whether a file can be run', async t => {
  const { dir, agentGit, file } = await agentRepository(t)
  fs.mkdirSync(file('views/a/empty'), { recursive: true })
  fs.writeFileSync(file('views/a/notes.csv'), 'x\n')
  fs.writeFileSync(file('views/pace.sh'), '#!/bin/sh\n')
  fs.writeFileSync(file('memory/preferences.md'), '- x\n')
  // What pi can leave, as root in its VM: folders no one can write, a file read-only, one others
  // may write, and one with the set-user-ID bit.
  fs.chmodSync(file('views/pace.sh'), 0o4755)
  fs.chmodSync(file('views/a/notes.csv'), 0o666)
  fs.chmodSync(file('memory/preferences.md'), 0o400)
  fs.chmodSync(file('views/a'), 0o500)
  fs.chmodSync(file('views'), 0o555)
  fs.chmodSync(file('memory'), 0o500)
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)
  for (const [target, mode] of [['views', 0o700], ['views/a', 0o700], ['views/a/notes.csv', 0o600], ['views/pace.sh', 0o700], ['memory', 0o700], ['memory/preferences.md', 0o600]]) {
    assert.equal(modeOf(file(target)), mode, target)
  }
  // The empty folder, in a folder pi had left without write access, is gone too.
  assert.deepEqual(fs.readdirSync(file('views/a')), ['notes.csv'])
  assert.equal(git(dir, 'ls-files', '-s', '--', 'views', 'memory').replace(/ [0-9a-f]{40} /g, ' '), '100644 0\tmemory/preferences.md\n100644 0\tviews/a/notes.csv\n100755 0\tviews/pace.sh\n')
  assert.equal(git(dir, 'status', '--porcelain', '--', 'views', 'memory'), '')
  fs.appendFileSync(file('memory/preferences.md'), '- y\n')
  fs.writeFileSync(file('views/a/later.csv'), 'y\n')
})

test('git: the check names the name at which views and memory pass AGENT_FILES_MAX_COUNT files and folders in all, before git reads any', async t => {
  const { agentGit, file } = await agentRepository(t)
  t.after(overrideLimits({ AGENT_FILES_MAX_COUNT: 5 }))
  fs.mkdirSync(file('views/books/2026'), { recursive: true })
  fs.writeFileSync(file('views/books/2026/dune.md'), '# Dune\n')
  fs.writeFileSync(file('views/expenses.csv'), 'date,amount\n')
  fs.writeFileSync(file('memory/preferences.md'), '- x\n')
  // Five names in all, folders counted: the limit passes.
  assert.equal(await agentGit.unexpectedFile(), null)
  // One more fails, at the name that passes it, in the order its folder gives them.
  fs.writeFileSync(file('memory/needs-review.md'), '- x\n')
  assert.match(await agentGit.unexpectedFile(), /^memory\/(needs-review|preferences)\.md$/)
  fs.rmSync(file('memory/needs-review.md'))

  // A folder of many names is read only up to the one that passes the limit; the clean-up removes
  // them all.
  fs.mkdirSync(file('views/many'))
  for (let n = 0; n < 5000; n++) fs.writeFileSync(file(`views/many/${n}.csv`), '')
  assert.match(await agentGit.unexpectedFile(), /^views\/many\/\d+\.csv$/)
  await agentGit.discardChanges()
  assert.deepEqual(fs.readdirSync(file('views')), [])
})

test('git: the check names a file with more than one name, which git would record as two', async t => {
  const { agentGit, file } = await agentRepository(t)
  fs.writeFileSync(file('views/notes.csv'), 'x\n')
  fs.linkSync(file('views/notes.csv'), file('views/notes-copy.csv'))
  assert.equal(await agentGit.unexpectedFile(), 'views/notes-copy.csv')
  await agentGit.discardChanges()
  assert.deepEqual(fs.readdirSync(file('views')), [])
})

test('git: the clean-up sets the folders aside and puts back the last commit, whatever the index holds, and removes what it set aside', async t => {
  const { dir, paths, agentGit, file } = await agentRepository(t)
  fs.mkdirSync(file('views/books'), { recursive: true })
  fs.writeFileSync(file('views/books/dune.md'), '# Dune\n')
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)

  // memory/ has nothing committed, and 30,000 names staged in it, as a check that failed at
  // staging or a crash before the commit leaves. Taking them out of the index one folder at a time
  // takes time that grows faster than their number: 900,000 took past GIT_CALL_TIMEOUT.
  fs.mkdirSync(file('memory/many'))
  for (let n = 0; n < 30000; n++) fs.writeFileSync(file(`memory/many/${n}.md`), '')
  git(dir, 'add', '--', 'memory')
  // views/ is now a link to elsewhere, which a rename moves as a link; and a clean-up before
  // couldn't remove all it set aside.
  fs.rmSync(file('views'), { recursive: true })
  fs.symlinkSync('/etc', file('views'))
  const discarded = paths.agentDiscarded('lifelog')
  // What is set aside is named by a number, which the next set aside then passes.
  fs.mkdirSync(path.join(discarded, '1', 'locked'), { recursive: true })
  fs.writeFileSync(path.join(discarded, '1', 'locked', 'x.csv'), 'x')
  fs.chmodSync(path.join(discarded, '1', 'locked'), 0o000)

  await agentGit.discardChanges()
  assert.equal(fs.lstatSync(file('views')).isDirectory(), true)
  assert.equal(fs.readFileSync(file('views/books/dune.md'), 'utf8'), '# Dune\n')
  assert.deepEqual(fs.readdirSync(file('memory')), [])
  assert.equal(git(dir, 'ls-files'), '.gitignore\nviews/books/dune.md\n')
  assert.equal(git(dir, 'status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  assert.equal(modeOf(file('views')), 0o700)
  assert.equal(modeOf(file('memory')), 0o700)
  // Nothing set aside is left, from this clean-up or the one before; the folder it was set aside
  // in stays, for the next clean-up.
  assert.deepEqual(fs.readdirSync(path.dirname(discarded)), ['lifelog'])
  assert.deepEqual(fs.readdirSync(discarded), [])
  assert.ok(fs.existsSync('/etc/hostname'))
})

test('git: what a failed run staged doesn\'t stay in the repository after the clean-up (the fifth review of milestone 4)', async t => {
  const { dir, agentGit, file, events } = await agentRepository(t)
  fs.writeFileSync(file('views/kept.csv'), 'kept\n')
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)
  const kept = git(dir, 'rev-parse', 'HEAD:views/kept.csv').trim()

  // A run stages a large file beside a name git refuses, and fails: `git add` has copied the file
  // into `.git/objects` by then.
  fs.writeFileSync(file('views/big.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
  fs.writeFileSync(file('views/git~1'), 'x')
  assert.equal(await agentGit.stage(), 'views/git~1')
  const staged = git(dir, 'hash-object', file('views/big.bin')).trim()
  git(dir, 'cat-file', '-e', staged)

  await agentGit.discardChanges()
  assert.throws(() => git(dir, 'cat-file', '-e', staged))
  // What the last commit holds stays.
  git(dir, 'cat-file', '-e', kept)
  assert.equal(git(dir, 'fsck', '--no-progress', '--unreachable'), '')
  assert.ok(!events().includes('agent.prune_failed'))
})

test('git: the check names a path longer than the system takes, and the clean-up removes what pi left and puts back what was committed, whatever the length of their paths', async t => {
  const { dir, paths, agentGit, file, events } = await agentRepository(t)
  const discarded = paths.agentDiscarded('lifelog')
  // A tree moved into another, as `mv` makes it in the VM, has paths past the limit. The check
  // names the first of them, before git reads anything, and the clean-up removes it all.
  deepTree(file('views'))
  const found = await agentGit.unexpectedFile()
  assert.match(found, /^views\/t1(\/d{200}){12}\/t2(\/d{200})+$/)
  assert.ok(Buffer.byteLength(path.join(dir, found)) > 4095)
  assert.ok(Buffer.byteLength(path.join(dir, path.dirname(found))) <= 4095)
  await agentGit.discardChanges()
  assert.deepEqual(fs.readdirSync(file('views')), [])
  assert.deepEqual(fs.readdirSync(discarded), [])

  // A file whose path is 4,090 bytes, which the system takes, is committed. Set aside, its path is
  // longer than that, and the clean-up removes it all the same, then puts it back from git.
  const folders = []
  let length = Buffer.byteLength(file('views'))
  while (4090 - length - 1 > 255) {
    folders.push('e'.repeat(200))
    length += 201
  }
  const deep = path.join(file('views'), ...folders, 'f'.repeat(4090 - length - 1))
  assert.equal(Buffer.byteLength(deep), 4090)
  fs.mkdirSync(path.dirname(deep), { recursive: true })
  fs.writeFileSync(deep, 'committed\n')
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)
  fs.writeFileSync(deep, 'changed\n')
  fs.writeFileSync(path.join(path.dirname(deep), 'new.csv'), 'x\n')
  await agentGit.discardChanges()
  assert.equal(fs.readFileSync(deep, 'utf8'), 'committed\n')
  assert.deepEqual(fs.readdirSync(path.dirname(deep)), [path.basename(deep)])
  assert.deepEqual(fs.readdirSync(discarded), [])
  assert.equal(git(dir, 'status', '--porcelain', '--ignored', '--', 'views', 'memory'), '')
  assert.equal(events().includes('agent.discarded_left'), false)
})

test('git: a commit doesn\'t pack the repository on its own; the runner packs it, in the foreground', async t => {
  const { dir, agentGit, file } = await agentRepository(t)
  // git packs once it finds enough loose objects; here, as few as it can count.
  git(dir, 'config', 'gc.auto', '1')
  const blobs = path.join(dir, 'run', 'blobs')
  fs.mkdirSync(blobs, { recursive: true })
  for (let n = 0; n < 3000; n++) fs.writeFileSync(path.join(blobs, String(n)), `blob ${n}\n`)
  execFileSync('git', ['hash-object', '-w', '--stdin-paths'], { cwd: dir, input: fs.readdirSync(blobs).map(name => path.join(blobs, name)).join('\n'), env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  const packs = () => fs.readdirSync(path.join(dir, '.git', 'objects', 'pack')).filter(name => name.endsWith('.pack'))
  fs.writeFileSync(file('views/notes.csv'), 'x\n')
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), true)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual(packs(), [])

  await agentGit.pack()
  assert.equal(packs().length, 1)
  assert.equal(fs.existsSync(path.join(dir, '.git', 'gc.pid')), false)
  assert.equal(git(dir, 'log', '--format=%s'), 'lifelog: #1\nlifelog: initial commit\n')
})

test('run folder: what the runner can\'t read in run/session/ is emptied, and a session file it can\'t read is refused', { skip: skipIfRoot }, async t => {
  const { paths, dir, ensure, agent, log } = setup(t)
  await ensure()
  const config = agent()
  const id = 'lifelog-2026-11-09'
  const sessionDir = path.join(dir, 'run', 'session')
  prepareRun({ paths, index: NO_LINES, agent: config, sessionId: id })
  fs.mkdirSync(path.join(sessionDir, 'locked'))
  fs.writeFileSync(path.join(sessionDir, 'locked', 'x'), 'x')
  fs.chmodSync(path.join(sessionDir, 'locked'), 0o000)
  fs.writeFileSync(path.join(sessionDir, `2026-11-09T15-50-38-000Z_${id}.jsonl`), 'first\n')
  fs.chmodSync(path.join(sessionDir, `2026-11-09T15-50-38-000Z_${id}.jsonl`), 0o000)
  assert.equal(await keepSession({ paths, agent: config, sessionId: id, log }), 'refused')
  fs.chmodSync(sessionDir, 0o000)
  assert.equal(await keepSession({ paths, agent: config, sessionId: id, log }), 'refused')

  prepareRun({ paths, index: NO_LINES, agent: config, sessionId: id })
  assert.deepEqual(fs.readdirSync(sessionDir), [])
  assert.equal(fs.existsSync(path.join(dir, 'sessions', `${id}.jsonl`)), false)
})

test('agent folder: a start clears what a run could write in run/, its session, the messages it queued and its marks, before it makes anything', async t => {
  const { paths, dir, ensure, agent } = setup(t)
  await ensure()
  prepareRun({ paths, index: NO_LINES, agent: agent() })
  // What a run the runner never cleaned up after left, pi's to choose: a tree too deep to remove
  // by its paths, and a marks file that is a folder.
  fs.writeFileSync(path.join(dir, 'run', 'session', 'x.jsonl'), 'x')
  deepTree(path.join(dir, 'run', 'send'))
  fs.mkdirSync(path.join(dir, 'run', 'marks.txt'))
  fs.writeFileSync(path.join(dir, 'run', 'marks.txt', 'done'), 'done 1\n')
  await ensure()
  assert.deepEqual(fs.readdirSync(path.join(dir, 'run', 'session')), [])
  assert.deepEqual(fs.readdirSync(path.join(dir, 'run', 'send')), [])
  assert.equal(fs.existsSync(path.join(dir, 'run', 'marks.txt')), false)
})

test("run folder: the runner reads nothing at memory, so nothing a run left there, a link, a folder it can't search or a file it can't read, stops a run's preparing", async t => {
  const { root, paths, dir, ensure, agent } = setup(t)
  await ensure()
  const memory = path.join(dir, 'memory')
  const prepare = () => prepareRun({ paths, index: NO_LINES, agent: agent() })
  fs.mkdirSync(path.join(root, 'other'))
  fs.writeFileSync(path.join(root, 'other', 'preferences.md'), "- not this agent's\n")
  fs.rmSync(memory, { recursive: true })
  fs.symlinkSync(path.join(root, 'other'), memory)
  assert.equal(fs.readFileSync(prepare().promptFile, 'utf8'), 'You are lifelog.\n')
  fs.rmSync(memory)
  fs.mkdirSync(memory)
  fs.writeFileSync(path.join(memory, 'preferences.md'), '- a rule\n')
  fs.chmodSync(path.join(memory, 'preferences.md'), 0o000)
  fs.writeFileSync(path.join(memory, 'needs-review.md'), '- a question\n')
  assert.equal(fs.readFileSync(prepare().promptFile, 'utf8'), 'You are lifelog.\n')
  fs.chmodSync(memory, 0o000)
  assert.equal(fs.readFileSync(prepare().promptFile, 'utf8'), 'You are lifelog.\n')
  fs.chmodSync(memory, 0o700)
})

test("git: a repository of files as well as folders: what isn't there yet is made a place for, a missing file is no fault, and the clean-up puts back what it set aside", async t => {
  const { dir, paths, log, clock } = setup(t)
  const entries = ['views/books/2026.csv', 'notes/', 'memory/preferences.md']
  const agentGit = createGit({ proc: createProc({ log, clock }), dir, entries, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  await ensureAgentDir({ paths, name: 'lifelog', git: agentGit, log })
  await agentGit.discardChanges()
  // A start makes each folder, and the folder each file is in, and no file.
  for (const folder of ['views/books', 'notes', 'memory']) assert.equal(modeOf(path.join(dir, folder)), 0o700, folder)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'views', 'books')), [])
  const file = name => path.join(dir, name)

  // Files that aren't there, and aren't in the last commit, are passed over and left out of git.
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), false)

  fs.writeFileSync(file('views/books/2026.csv'), 'title\n')
  fs.writeFileSync(file('notes/a.md'), 'a\n')
  // Beside the file, outside the repository: never staged.
  fs.writeFileSync(file('views/books/other.csv'), 'other\n')
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #2'), true)
  assert.equal(git(dir, 'ls-files'), '.gitignore\nnotes/a.md\nviews/books/2026.csv\n')

  // The check walks a file as it walks a folder's: a link, or a second name, is unexpected.
  fs.rmSync(file('views/books/2026.csv'))
  fs.symlinkSync('/etc/hostname', file('views/books/2026.csv'))
  assert.equal(await agentGit.unexpectedFile(), 'views/books/2026.csv')
  await agentGit.discardChanges()
  assert.equal(fs.readFileSync(file('views/books/2026.csv'), 'utf8'), 'title\n')
  fs.linkSync(file('views/books/2026.csv'), file('notes/second.md'))
  assert.equal(await agentGit.unexpectedFile(), 'views/books/2026.csv')
  await agentGit.discardChanges()
  assert.equal(fs.lstatSync(file('views/books/2026.csv')).nlink, 1)
  assert.deepEqual(fs.readdirSync(file('notes')), ['a.md'])
  // What lies beside a file of the repository is none of the clean-up's.
  assert.equal(fs.readFileSync(file('views/books/other.csv'), 'utf8'), 'other\n')

  // A file removed is a change, committed; and one made where a file isn't committed is thrown away.
  fs.rmSync(file('views/books/2026.csv'))
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #3'), true)
  assert.equal(git(dir, 'ls-files'), '.gitignore\nnotes/a.md\n')
  fs.writeFileSync(file('memory/preferences.md'), '- a rule\n')
  await agentGit.discardChanges()
  assert.equal(fs.existsSync(file('memory/preferences.md')), false)
  assert.equal(fs.existsSync(file('views/books/2026.csv')), false)
})

test('git: with nothing in the repository, nothing is staged or committed, and git is never given no path', async t => {
  const { dir, paths, log, clock } = setup(t)
  const agentGit = createGit({ proc: createProc({ log, clock }), dir, entries: [], discardDir: paths.agentDiscarded('lifelog'), log, clock })
  await ensureAgentDir({ paths, name: 'lifelog', git: agentGit, log })
  await agentGit.discardChanges()
  // What git would take with no path given: the whole tree.
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'x\n')
  assert.equal(await agentGit.unexpectedFile(), null)
  assert.equal(await agentGit.stage(), null)
  assert.equal(await agentGit.commitStaged('lifelog: #1'), false)
  await agentGit.discardChanges()
  assert.equal(git(dir, 'ls-files'), '.gitignore\n')
  assert.equal(fs.readFileSync(path.join(dir, 'stray.txt'), 'utf8'), 'x\n')
})

test('git: an entry in the other shape than writes gives it, as a change of writes can leave one committed, is unexpected, left out by the clean-up, and its removal committed by the next run', async t => {
  const { dir, paths, log, clock, events } = setup(t)
  const gitFor = entries => createGit({ proc: createProc({ log, clock }), dir, entries, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  const folderGit = gitFor(['views/', 'notes.md'])
  await ensureAgentDir({ paths, name: 'lifelog', git: folderGit, log })
  await folderGit.discardChanges()
  fs.mkdirSync(path.join(dir, 'views', 'books.csv'))
  fs.writeFileSync(path.join(dir, 'views', 'books.csv', 'old.csv'), 'old\n')
  fs.writeFileSync(path.join(dir, 'notes.md'), 'a note\n')
  assert.equal(await folderGit.stage(), null)
  assert.equal(await folderGit.commitStaged('lifelog: #1'), true)

  // writes now names views/books.csv as a file, and notes.md as a folder: what the last commit
  // has there is the other shape, which the VM could change neither way.
  const fileGit = gitFor(['views/books.csv', 'notes.md/'])
  assert.equal(await fileGit.unexpectedFile(), 'views/books.csv')
  // A start's clean-up leaves both out, and makes the folder writes names.
  await fileGit.discardChanges()
  assert.equal(fs.existsSync(path.join(dir, 'views', 'books.csv')), false)
  assert.equal(fs.lstatSync(path.join(dir, 'notes.md')).isDirectory(), true)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes.md')), [])
  assert.equal(await fileGit.unexpectedFile(), null)
  assert.deepEqual(events().filter(event => event.startsWith('agent.entry')), [])

  // The next run that passes commits the removal, with what it wrote in the new shape.
  fs.writeFileSync(path.join(dir, 'views', 'books.csv'), 'title\n')
  fs.writeFileSync(path.join(dir, 'notes.md', 'a.md'), 'a\n')
  assert.equal(await fileGit.stage(), null)
  assert.equal(await fileGit.commitStaged('lifelog: #2'), true)
  assert.equal(git(dir, 'ls-files'), '.gitignore\nnotes.md/a.md\nviews/books.csv\n')
  await fileGit.discardChanges()
  assert.equal(fs.readFileSync(path.join(dir, 'views', 'books.csv'), 'utf8'), 'title\n')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes.md')), ['a.md'])

  // With nothing written meanwhile, the removal alone is committed.
  const back = gitFor(['views/', 'notes.md'])
  await back.discardChanges()
  assert.equal(fs.existsSync(path.join(dir, 'notes.md')), false)
  assert.equal(await back.stage(), null)
  assert.equal(await back.commitStaged('lifelog: #3'), true)
  assert.equal(git(dir, 'ls-files'), '.gitignore\nviews/books.csv\n')
})

test('git: an entry with a file on its way, as a change of writes can leave one, is passed over by the check, staging and the clean-up, which say so, and stops nothing', async t => {
  const { dir, paths, log, clock, events, entries: logged } = setup(t)
  const gitFor = entries => createGit({ proc: createProc({ log, clock }), dir, entries, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  const before = gitFor(['notes/'])
  await ensureAgentDir({ paths, name: 'lifelog', git: before, log })
  await before.discardChanges()
  fs.writeFileSync(path.join(dir, 'notes', '2026'), 'a file\n')
  assert.equal(await before.stage(), null)
  assert.equal(await before.commitStaged('lifelog: #1'), true)

  // writes now names a file and a folder under notes/2026, which is a file; and a file under one
  // that was never committed.
  fs.writeFileSync(path.join(dir, 'loose'), 'never committed\n')
  const after = gitFor(['notes/2026/books.csv', 'notes/2026/books/', 'loose/a.md'])
  for (let n = 0; n < 2; n++) {
    await after.discardChanges()
    assert.equal(await after.unexpectedFile(), null)
    assert.equal(await after.stage(), null)
    assert.equal(await after.commitStaged('lifelog: #2'), false)
  }
  // The files in the way are left as they are: they aren't the entries'.
  assert.equal(fs.readFileSync(path.join(dir, 'notes', '2026'), 'utf8'), 'a file\n')
  assert.equal(fs.readFileSync(path.join(dir, 'loose'), 'utf8'), 'never committed\n')
  assert.equal(git(dir, 'ls-files'), '.gitignore\nnotes/2026\n')
  assert.deepEqual(
    logged.filter(entry => entry.event === 'agent.entry_blocked').map(entry => entry.entry),
    ['notes/2026/books.csv', 'notes/2026/books', 'loose/a.md', 'notes/2026/books.csv', 'notes/2026/books', 'loose/a.md'],
  )
  assert.ok(events().includes('agent.entry_blocked'))

  // Once the file in the way is gone, the entry is made as any other.
  fs.rmSync(path.join(dir, 'notes', '2026'))
  await after.discardChanges()
  assert.equal(fs.lstatSync(path.join(dir, 'notes', '2026', 'books')).isDirectory(), true)
})

test('git: an entry with a link on its way, as a run the runner never cleaned up after can leave one, is passed over before anything is set aside, made, staged or checked there, and nothing is done where the link leads', async t => {
  const { root, dir, paths, log, clock, entries: logged } = setup(t)
  const gitFor = entries => createGit({ proc: createProc({ log, clock }), dir, entries, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  const before = gitFor(['notes/'])
  await ensureAgentDir({ paths, name: 'lifelog', git: before, log })
  await before.discardChanges()
  // What a run of that writes may make in notes/, and a runner killed before the clean-up leaves:
  // a link to nothing; one to a folder outside the entries, which holds the names of entries; and
  // one to the agents' folder.
  const outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(outside, 'kept'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'kept', 'a.md'), "not the agent's\n")
  fs.writeFileSync(path.join(outside, 'books.csv'), "not the agent's either\n")
  fs.symlinkSync('nowhere', path.join(dir, 'notes', '2026'))
  fs.symlinkSync(outside, path.join(dir, 'notes', 'out'))
  fs.symlinkSync('../..', path.join(dir, 'notes', 'up'))

  // writes now names entries behind each, files and folders, there and not there.
  const blocked = ['notes/2026/q1/books.csv', 'notes/2026/books/', 'notes/out/kept/', 'notes/out/books.csv', 'notes/out/new/', 'notes/up/made/']
  const after = gitFor([...blocked, 'views/'])
  for (let n = 0; n < 2; n++) {
    await after.discardChanges()
    assert.equal(await after.unexpectedFile(), null)
    assert.equal(await after.stage(), null)
    assert.equal(await after.commitStaged('lifelog: #2'), false)
  }
  // Where the links lead, nothing was set aside, removed or made, and the links are as they were.
  assert.deepEqual(fs.readdirSync(outside).sort(), ['books.csv', 'kept'])
  assert.deepEqual(fs.readdirSync(path.join(outside, 'kept')), ['a.md'])
  assert.equal(fs.readFileSync(path.join(outside, 'kept', 'a.md'), 'utf8'), "not the agent's\n")
  assert.equal(fs.readFileSync(path.join(outside, 'books.csv'), 'utf8'), "not the agent's either\n")
  assert.equal(fs.existsSync(path.join(paths.agents, 'made')), false)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes')).sort(), ['2026', 'out', 'up'])
  assert.equal(fs.readlinkSync(path.join(dir, 'notes', '2026')), 'nowhere')
  assert.deepEqual(fs.readdirSync(paths.agentDiscarded('lifelog')), [])
  // The entry whose way is open is the clean-up's as ever.
  assert.equal(modeOf(path.join(dir, 'views')), 0o700)
  const names = blocked.map(entry => entry.replace(/\/$/, ''))
  assert.deepEqual(logged.filter(entry => entry.event === 'agent.entry_blocked').map(entry => entry.entry), [...names, ...names])

  // Once the link is gone, the entries behind it are made as any other.
  fs.rmSync(path.join(dir, 'notes', 'out'))
  await after.discardChanges()
  assert.equal(fs.lstatSync(path.join(dir, 'notes', 'out', 'kept')).isDirectory(), true)
  assert.equal(fs.lstatSync(path.join(dir, 'notes', 'out', 'new')).isDirectory(), true)
  assert.equal(fs.existsSync(path.join(dir, 'notes', 'out', 'books.csv')), false)
})

test("git: an entry with a folder the runner can't search on its way, as a run the runner never cleaned up after can leave one, is passed over too, and what the folder holds is left as it is", { skip: skipIfRoot }, async t => {
  const { dir, paths, log, clock, entries: logged } = setup(t)
  const gitFor = entries => createGit({ proc: createProc({ log, clock }), dir, entries, discardDir: paths.agentDiscarded('lifelog'), log, clock })
  const before = gitFor(['notes/'])
  await ensureAgentDir({ paths, name: 'lifelog', git: before, log })
  await before.discardChanges()
  // A folder in notes/ that holds an entry's names, whose mode a run made 000.
  const shut = path.join(dir, 'notes', '2026')
  fs.mkdirSync(path.join(shut, 'books'), { recursive: true })
  fs.writeFileSync(path.join(shut, 'books.csv'), 'a row\n')
  fs.chmodSync(shut, 0o000)

  const blocked = ['notes/2026/books.csv', 'notes/2026/books/', 'notes/2026/q1/x.csv']
  const after = gitFor(blocked)
  for (let n = 0; n < 2; n++) {
    await after.discardChanges()
    assert.equal(await after.unexpectedFile(), null)
    assert.equal(await after.stage(), null)
    assert.equal(await after.commitStaged('lifelog: #2'), false)
  }
  assert.equal(modeOf(shut), 0o000)
  const names = blocked.map(entry => entry.replace(/\/$/, ''))
  assert.deepEqual(logged.filter(entry => entry.event === 'agent.entry_blocked').map(entry => entry.entry), [...names, ...names])
  fs.chmodSync(shut, 0o700)
  assert.deepEqual(fs.readdirSync(shut).sort(), ['books', 'books.csv'])
  assert.equal(fs.readFileSync(path.join(shut, 'books.csv'), 'utf8'), 'a row\n')

  // Once the runner can search it, the entries in it are the entries: what no commit holds goes.
  await after.discardChanges()
  assert.deepEqual(fs.readdirSync(shut).sort(), ['books', 'q1'])
})

test('git: what the clean-up sets aside is named by a number, so an entry whose name is as long as the system takes is set aside too', async t => {
  const { dir, paths, log, clock } = setup(t)
  const long = 'a'.repeat(255)
  const agentGit = createGit({ proc: createProc({ log, clock }), dir, entries: [`${long}/`, `b${'b'.repeat(254)}`], discardDir: paths.agentDiscarded('lifelog'), log, clock })
  await ensureAgentDir({ paths, name: 'lifelog', git: agentGit, log })
  await agentGit.discardChanges()
  for (let n = 0; n < 2; n++) {
    fs.writeFileSync(path.join(dir, long, 'x.md'), 'x\n')
    fs.writeFileSync(path.join(dir, 'b'.repeat(255)), 'x\n')
    await agentGit.discardChanges()
    assert.deepEqual(fs.readdirSync(path.join(dir, long)), [])
    assert.equal(fs.existsSync(path.join(dir, 'b'.repeat(255))), false)
  }
})

test('git: the limits count a file of writes as a name, and weigh it, with what the folders hold', async t => {
  const { dir, paths, log, clock } = setup(t)
  const agentGit = createGit({ proc: createProc({ log, clock }), dir, entries: ['a.md', 'views/', 'b.md'], discardDir: paths.agentDiscarded('lifelog'), log, clock })
  await ensureAgentDir({ paths, name: 'lifelog', git: agentGit, log })
  await agentGit.discardChanges()
  // Two files of writes, each of 10 bytes, and a folder of writes with two files of 10 bytes: four
  // names, the folder of writes itself not among them, of 40 bytes in all, counted in the order
  // writes gives them, and a folder's names in the order the folder gives them.
  for (const name of ['a.md', 'b.md', 'views/x.csv', 'views/y.csv']) fs.writeFileSync(path.join(dir, name), '123456789\n')
  const found = limits => agentGit.unexpectedFile(undefined, limits)
  assert.equal(await found({ maxCount: 4, maxBytes: 40 }), null)
  assert.equal(await found({ maxCount: 0, maxBytes: 40 }), 'a.md')
  assert.match(await found({ maxCount: 1, maxBytes: 40 }), /^views\/[xy]\.csv$/)
  assert.match(await found({ maxCount: 2, maxBytes: 40 }), /^views\/[xy]\.csv$/)
  assert.equal(await found({ maxCount: 3, maxBytes: 40 }), 'b.md')
  // The sizes are added in name order.
  assert.equal(await found({ maxCount: 4, maxBytes: 9 }), 'a.md')
  assert.equal(await found({ maxCount: 4, maxBytes: 25 }), 'views/y.csv')
  assert.equal(await found({ maxCount: 4, maxBytes: 39 }), 'b.md')
})
