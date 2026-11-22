// What git does with the paths the runner gives it, which the check, the commit and the clean-up of
// the agent's repository rely on (`src/runner/git.mjs`). The runner names what `writes` names in
// the agent's folder, files as well as folders, and one of them can be missing: a file the agent
// hasn't made yet, or has removed. `docs/architecture/run.md` gives the facts these find. The suite
// needs git wherever it runs, so these don't skip.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makeTestDir } from '../support/tmp.mjs'

// A repository with one committed file, `views/a.csv`, and git run on it as the runner runs it:
// no config of the system's or the user's.
function repository(t) {
  const dir = makeTestDir(t)
  const git = (args, env = {}) =>
    spawnSync('git', ['-c', 'user.name=Scooter', '-c', 'user.email=scooter@localhost', '-c', 'commit.gpgSign=false', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GIT_DIR: path.join(dir, '.git'), GIT_WORK_TREE: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env },
    })
  assert.equal(git(['init', '--quiet', '--initial-branch=main']).status, 0)
  fs.mkdirSync(path.join(dir, 'views'))
  fs.writeFileSync(path.join(dir, 'views', 'a.csv'), 'a\n')
  assert.equal(git(['add', '-A', '--', 'views']).status, 0)
  assert.equal(git(['commit', '--quiet', '-m', 'first']).status, 0)
  return { dir, git }
}

test('git: add -A fails on a path that is neither on disk nor in the index, and stages the removal of one that is only in the index', t => {
  const { dir, git } = repository(t)
  const missing = git(['add', '-A', '--ignore-errors', '--', 'views/missing.csv'])
  assert.equal(missing.status, 128)
  assert.match(missing.stderr, /pathspec 'views\/missing.csv' did not match any files/)

  fs.rmSync(path.join(dir, 'views', 'a.csv'))
  assert.equal(git(['add', '-A', '--', 'views/a.csv']).status, 0)
  assert.equal(git(['status', '--porcelain', '--', 'views/a.csv']).stdout, 'D  views/a.csv\n')

  // Nothing else that reads a path fails on one that is missing.
  for (const args of [
    ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', 'views/missing.csv'],
    ['diff', '--cached', '--quiet', '--', 'views/missing.csv'],
    ['ls-files', '-z', '--', 'views/missing.csv'],
    ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'views/missing.csv'],
  ]) {
    const result = git(args)
    assert.equal(result.status, 0, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
  }
})

test('git: a path is a pattern unless GIT_LITERAL_PATHSPECS=1, and add -A with no path takes the whole tree', t => {
  const { dir, git } = repository(t)
  fs.writeFileSync(path.join(dir, 'views', 'b.csv'), 'b\n')
  fs.writeFileSync(path.join(dir, 'views', 'c.csv'), 'c\n')
  fs.writeFileSync(path.join(dir, 'other.txt'), 'other\n')

  // Taken as it is written, `views/?.csv` names a file that isn't there.
  assert.equal(git(['add', '-A', '--', 'views/?.csv'], { GIT_LITERAL_PATHSPECS: '1' }).status, 128)
  assert.equal(git(['diff', '--cached', '--name-only']).stdout, '')
  fs.writeFileSync(path.join(dir, 'views', '?.csv'), 'mark\n')
  assert.equal(git(['add', '-A', '--', 'views/?.csv'], { GIT_LITERAL_PATHSPECS: '1' }).status, 0)
  assert.equal(git(['diff', '--cached', '--name-only']).stdout, 'views/?.csv\n')
  assert.equal(git(['reset', '--quiet']).status, 0)
  fs.rmSync(path.join(dir, 'views', '?.csv'))

  // Otherwise it is a pattern, which takes the files it matches.
  assert.equal(git(['add', '-A', '--', 'views/?.csv']).status, 0)
  assert.equal(git(['diff', '--cached', '--name-only']).stdout, 'views/b.csv\nviews/c.csv\n')
  assert.equal(git(['reset', '--quiet']).status, 0)

  assert.equal(git(['add', '-A', '--']).status, 0)
  assert.equal(git(['diff', '--cached', '--name-only']).stdout, 'other.txt\nviews/b.csv\nviews/c.csv\n')
})

test('git: add -A stages a path whose kind changed, a file become a folder or the other way, and takes a path through a file without a word but in add', t => {
  const { dir, git } = repository(t)
  const literal = { GIT_LITERAL_PATHSPECS: '1' }
  fs.writeFileSync(path.join(dir, 'notes'), 'n\n')
  fs.mkdirSync(path.join(dir, 'm.md'))
  fs.writeFileSync(path.join(dir, 'm.md', 'x'), 'x\n')
  assert.equal(git(['add', '-A', '--', 'notes', 'm.md'], literal).status, 0)
  assert.equal(git(['commit', '--quiet', '-m', 'second']).status, 0)
  // ls-tree -r names a file by its path, and a folder by the files in it.
  assert.deepEqual(git(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'notes', 'm.md'], literal).stdout.split('\0').filter(Boolean), ['m.md/x', 'notes'])

  // A file become a folder, and a folder gone, with the index the last commit's.
  fs.rmSync(path.join(dir, 'notes'))
  fs.mkdirSync(path.join(dir, 'notes'))
  fs.writeFileSync(path.join(dir, 'notes', 'a.md'), 'a\n')
  fs.rmSync(path.join(dir, 'm.md'), { recursive: true })
  assert.equal(git(['add', '-A', '--', 'notes', 'm.md'], literal).status, 0)
  assert.equal(git(['status', '--porcelain', '--', 'notes', 'm.md']).stdout, 'D  m.md/x\nD  notes\nA  notes/a.md\n')
  assert.equal(git(['reset', '--quiet']).status, 0)
  // A folder become a file.
  fs.writeFileSync(path.join(dir, 'm.md'), 'f\n')
  assert.equal(git(['add', '-A', '--', 'm.md'], literal).status, 0)
  assert.equal(git(['status', '--porcelain', '--', 'm.md']).stdout, 'A  m.md\nD  m.md/x\n')
  assert.equal(git(['reset', '--quiet']).status, 0)

  // A path that runs through a file: what reads paths takes it without a word; add refuses it.
  fs.rmSync(path.join(dir, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'notes'), 'n\n')
  for (const args of [
    ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--', 'notes/2026/books.csv'],
    ['diff', '--cached', '--quiet', '--', 'notes/2026/books.csv'],
    ['ls-files', '-z', '--', 'notes/2026/books.csv'],
    ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', 'notes/2026/books.csv'],
  ]) {
    const result = git(args, literal)
    assert.equal(result.status, 0, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
  }
  const through = git(['add', '-A', '--ignore-errors', '--', 'notes/2026/books.csv'], literal)
  assert.equal(through.status, 128)
  assert.match(through.stderr, /pathspec 'notes\/2026\/books.csv' did not match any files/)
})
