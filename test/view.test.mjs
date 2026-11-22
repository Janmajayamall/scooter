// What a run's VM sees of the host, and what it may change (`src/runner/sandbox/view.mjs`), with
// the provider called as Gondolin's file system service calls it, on the host, without a VM. pi
// runs as root in the VM and could talk to that service itself, with any path, rather than
// through the VM's kernel, which follows links on its own: so these give it paths the kernel
// wouldn't, links on the host among them. `test/tools/vm.test.mjs` shows the same rules in a VM.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isShown, mayChange, viewOf, viewProvider, writeRule } from '../src/runner/sandbox/view.mjs'
import { makeTestDir } from './support/tmp.mjs'
import { gondolin } from './support/vm.mjs'

// A root with a folder and two files the run may change, a folder and a file it may only read,
// a hidden folder in that, and a file it doesn't see; and links on the host from where it may
// write to where it may not.
function layOut(t) {
  const dir = makeTestDir(t)
  const root = path.join(dir, 'root')
  for (const folder of ['allowed/sub', 'empty', 'ro/secret', 'folder.txt/inside']) fs.mkdirSync(path.join(root, folder), { recursive: true })
  for (const [file, text] of [
    ['allowed/old.txt', 'old\n'],
    ['ro/keep.txt', 'keep\n'],
    ['ro/secret/hidden.txt', 'hidden\n'],
    ['file.txt', 'file\n'],
    ['unnamed.txt', 'unnamed\n'],
  ]) {
    fs.writeFileSync(path.join(root, file), text)
  }
  fs.symlinkSync('../ro/keep.txt', path.join(root, 'allowed', 'to-keep'))
  fs.symlinkSync(path.join(root, 'ro', 'keep.txt'), path.join(root, 'allowed', 'to-keep-in-full'))
  fs.symlinkSync('../ro', path.join(root, 'allowed', 'to-ro'))
  fs.symlinkSync('../ro/secret/hidden.txt', path.join(root, 'allowed', 'to-hidden'))
  fs.symlinkSync('../unnamed.txt', path.join(root, 'allowed', 'to-unnamed'))
  fs.symlinkSync('old.txt', path.join(root, 'allowed', 'to-old'))
  const files = {
    root,
    reads: [`${root}/ro`],
    writes: [
      { path: `${root}/allowed`, folder: true },
      { path: `${root}/empty`, folder: true },
      { path: `${root}/file.txt`, folder: false },
      { path: `${root}/new.txt`, folder: false },
      { path: `${root}/folder.txt`, folder: false },
    ],
    hide: [`${root}/ro/secret`],
  }
  const provider = viewProvider(gondolin, files, new gondolin.RealFSProvider(root))
  return { root, files, provider }
}

// Rejected with the errno `code` names, as the guest is given it: Gondolin's own errors name a
// number it can't name otherwise, as `ERRNO_2`.
async function refusedWith(code, promise, what) {
  await assert.rejects(promise, error => error.code === code || error.code === `ERRNO_${os.constants.errno[code]}`, what)
}

test('view: what the VM sees, and what writes lets it change, by path', () => {
  const view = viewOf({
    root: '/data',
    reads: ['/data/datastore', '/data/agents/lifelog', '/data/agents/lifelog/run'],
    writes: [
      { path: '/data/agents/lifelog/views', folder: true },
      { path: '/data/agents/lifelog/run/session', folder: true },
      { path: '/data/notes/todo.md', folder: false },
    ],
    hide: ['/data/agents/lifelog/sessions'],
  })
  for (const shown of ['/', '/agents', '/agents/lifelog', '/agents/lifelog/state.json', '/datastore/2026/11/09/log.jsonl', '/notes', '/notes/todo.md']) {
    assert.equal(isShown(view, shown), true, shown)
  }
  for (const hidden of ['/agents/lifelog/sessions', '/agents/lifelog/sessions/a.jsonl', '/runner', '/agents/.discarded', '/notes/other.md', '/notes/todo.md.bak', '/datastores']) {
    assert.equal(isShown(view, hidden), false, hidden)
  }

  assert.equal(writeRule(view, '/agents/lifelog/views/a.csv'), 'inside')
  assert.equal(writeRule(view, '/agents/lifelog/views'), 'folder')
  assert.equal(writeRule(view, '/notes/todo.md'), 'file')
  for (const p of ['/agents/lifelog', '/agents/lifelog/state.json', '/agents/lifelog/run/system.md', '/agents/lifelog/views2', '/notes/todo.md/x', '/datastore/a']) assert.equal(writeRule(view, p), null, p)

  // A folder of writes may be made, removed and given a mode, and nothing else; a file anything but
  // made or removed as a folder.
  for (const op of ['mkdir', 'rmdir', 'chmod']) assert.equal(mayChange(view, op, '/agents/lifelog/views'), true, op)
  for (const op of ['open', 'unlink', 'rename', 'link', 'symlink', 'truncate']) assert.equal(mayChange(view, op, '/agents/lifelog/views'), false, op)
  for (const op of ['open', 'unlink', 'rename', 'link', 'symlink', 'truncate', 'chmod']) assert.equal(mayChange(view, op, '/notes/todo.md'), true, op)
  for (const op of ['mkdir', 'rmdir']) assert.equal(mayChange(view, op, '/notes/todo.md'), false, op)
  for (const op of ['open', 'mkdir', 'rmdir', 'unlink', 'rename', 'link', 'symlink', 'chmod', 'truncate']) {
    assert.equal(mayChange(view, op, '/agents/lifelog/views/sub/a.csv'), true, op)
    assert.equal(mayChange(view, op, '/agents/lifelog/state.json'), false, op)
  }
})

test("view: the provider refuses each change outside writes, with EROFS, and leaves the host as it was", async t => {
  const { root, provider } = layOut(t)
  const before = fs.readFileSync(path.join(root, 'ro', 'keep.txt'), 'utf8')
  await refusedWith('EROFS', provider.open('/ro/keep.txt', 'w'), 'open for writing')
  await refusedWith('EROFS', provider.open('/ro/keep.txt', 'a'), 'open for appending')
  await refusedWith('EROFS', provider.open('/ro/keep.txt', 'r+'), 'open for reading and writing')
  await refusedWith('EROFS', provider.open('/ro/keep.txt', fs.constants.O_WRONLY), 'open with flags as a number')
  await refusedWith('EROFS', provider.open('/ro/new.txt', 'w'), 'making a file')
  await refusedWith('EROFS', provider.open('/new.txt.bak', 'w'), 'making a file beside an allowed one')
  await refusedWith('EROFS', provider.mkdir('/ro/d'), 'mkdir')
  await refusedWith('EROFS', provider.rmdir('/ro/secret'), 'rmdir')
  await refusedWith('EROFS', provider.unlink('/ro/keep.txt'), 'unlink')
  await refusedWith('EROFS', provider.rename('/ro/keep.txt', '/allowed/k.txt'), 'rename from')
  await refusedWith('EROFS', provider.rename('/allowed/old.txt', '/ro/old.txt'), 'rename to')
  await refusedWith('EROFS', provider.link('/ro/keep.txt', '/allowed/hard'), 'link from')
  await refusedWith('EROFS', provider.link('/allowed/old.txt', '/ro/hard'), 'link to')
  await refusedWith('EROFS', provider.symlink('keep.txt', '/ro/link'), 'symlink')
  await refusedWith('EROFS', provider.chmod('/ro/keep.txt', 0o600), 'chmod')
  await refusedWith('EROFS', provider.truncate('/ro/keep.txt', 0), 'truncate')
  assert.equal(fs.readFileSync(path.join(root, 'ro', 'keep.txt'), 'utf8'), before)
  assert.deepEqual(fs.readdirSync(path.join(root, 'ro')).sort(), ['keep.txt', 'secret'])
  assert.equal(fs.statSync(path.join(root, 'ro', 'keep.txt')).mode & 0o777, 0o644 & ~process.umask() & 0o777)
  assert.equal(fs.existsSync(path.join(root, 'new.txt.bak')), false)
})

test('view: a path given with .., a doubled / or a link on the host is judged by where it lands', async t => {
  const { root, provider } = layOut(t)
  // The kernel in the VM would resolve these itself; given straight to the service, they land
  // where the host would take them.
  await refusedWith('EROFS', provider.open('/allowed/../ro/keep.txt', 'w'), '..')
  await refusedWith('EROFS', provider.open('/allowed/to-keep', 'w'), 'a link to a file outside')
  await refusedWith('EROFS', provider.open('/allowed/to-keep-in-full', 'w'), 'a link by its full path')
  await refusedWith('EROFS', provider.chmod('/allowed/to-keep', 0o600), 'chmod through a link')
  await refusedWith('EROFS', provider.truncate('/allowed/to-keep', 0), 'truncate through a link')
  await refusedWith('EROFS', provider.link('/allowed/to-keep', '/allowed/hard'), 'a hard link to what a link leads to')
  await refusedWith('EROFS', provider.open('/allowed/to-ro/new.txt', 'w'), 'a file made through a linked folder')
  await refusedWith('EROFS', provider.mkdir('/allowed/to-ro/d'), 'a folder made through a linked folder')
  await refusedWith('EROFS', provider.unlink('/allowed/to-ro/keep.txt'), 'a file removed through a linked folder')
  await refusedWith('EROFS', provider.rename('/allowed/old.txt', '/allowed/to-ro/old.txt'), 'a rename into a linked folder')
  await refusedWith('EROFS', provider.symlink('x', '/allowed/to-ro/link'), 'a link made through a linked folder')
  assert.equal(fs.readFileSync(path.join(root, 'ro', 'keep.txt'), 'utf8'), 'keep\n')
  assert.deepEqual(fs.readdirSync(path.join(root, 'ro')).sort(), ['keep.txt', 'secret'])

  // Reading through a link to what the VM doesn't see finds nothing.
  await refusedWith('ENOENT', provider.open('/allowed/to-hidden', 'r'), 'a link to a hidden file')
  await refusedWith('ENOENT', provider.open('/allowed/to-unnamed', 'r'), 'a link to a file nothing names')
  await refusedWith('EROFS', provider.link('/allowed/to-hidden', '/allowed/hard'), 'a hard link to a hidden file')
  assert.equal(fs.existsSync(path.join(root, 'allowed', 'hard')), false)

  // What lands inside writes is allowed, whatever way it is given.
  const handle = await provider.open('/allowed//sub/../a.txt', 'w')
  await handle.close()
  assert.equal(fs.existsSync(path.join(root, 'allowed', 'a.txt')), true)
  const through = await provider.open('/allowed/to-old', 'a')
  await through.write(Buffer.from('more\n'), 0, 5, null)
  await through.close()
  assert.equal(fs.readFileSync(path.join(root, 'allowed', 'old.txt'), 'utf8'), 'old\nmore\n')
})

test('view: inside writes every change is allowed; a folder of writes keeps its place, and a file stays a file', async t => {
  const { root, provider } = layOut(t)
  const made = await provider.open('/allowed/a.txt', 'w')
  await made.close()
  await provider.mkdir('/allowed/d')
  await provider.rename('/allowed/a.txt', '/allowed/d/a.txt')
  await provider.link('/allowed/d/a.txt', '/allowed/hard')
  assert.equal(fs.statSync(path.join(root, 'allowed', 'hard')).nlink, 2)
  await provider.symlink('a.txt', '/allowed/d/link')
  await provider.chmod('/allowed/hard', 0o640)
  await provider.truncate('/allowed/hard', 3)
  assert.equal(fs.statSync(path.join(root, 'allowed', 'd', 'a.txt')).size, 3)
  await provider.unlink('/allowed/hard')
  await provider.unlink('/allowed/d/link')
  await provider.unlink('/allowed/d/a.txt')
  await provider.rmdir('/allowed/d')

  // A file of writes, there or not yet.
  for (const file of ['/file.txt', '/new.txt']) {
    const handle = await provider.open(file, 'w')
    await handle.close()
  }
  await provider.chmod('/file.txt', 0o600)
  await provider.rename('/file.txt', '/allowed/file.txt')
  await provider.rename('/allowed/file.txt', '/file.txt')
  await provider.unlink('/new.txt')
  await refusedWith('EROFS', provider.mkdir('/new.txt'), 'a file of writes made a folder')
  await refusedWith('EROFS', provider.rmdir('/file.txt'), 'rmdir on a file of writes')

  // A folder of writes.
  await provider.rmdir('/empty')
  await refusedWith('EROFS', provider.open('/empty', 'w'), 'a file where a folder of writes was')
  await refusedWith('EROFS', provider.symlink('allowed', '/empty'), 'a link where a folder of writes was')
  await refusedWith('EROFS', provider.rename('/allowed/sub', '/empty'), 'a folder moved where a folder of writes was')
  await provider.mkdir('/empty')
  await provider.chmod('/empty', 0o700)
  await refusedWith('EROFS', provider.rename('/allowed', '/allowed-2'), 'a folder of writes moved')
  await refusedWith('EROFS', provider.rename('/empty', '/allowed/empty'), 'a folder of writes moved into another')
  assert.equal(fs.lstatSync(path.join(root, 'empty')).isDirectory(), true)
  assert.equal(fs.lstatSync(path.join(root, 'allowed')).isDirectory(), true)

  // A file of writes that is a folder on the host can't be moved, with what it holds, or changed.
  await refusedWith('EROFS', provider.rename('/folder.txt', '/allowed/folder'), 'a folder named as a file, moved')
  await refusedWith('EROFS', provider.rename('/allowed/old.txt', '/folder.txt'), 'a file moved onto a folder named as a file')
  await refusedWith('EROFS', provider.chmod('/folder.txt', 0o700), 'a folder named as a file, given a mode')
  await refusedWith('EROFS', provider.open('/folder.txt/inside/x.txt', 'w'), 'a file made in a folder named as a file')
  assert.equal(fs.lstatSync(path.join(root, 'folder.txt', 'inside')).isDirectory(), true)
})

test('view: what nothing names, and what is hidden, the VM neither sees nor lists', async t => {
  const { provider } = layOut(t)
  assert.deepEqual((await provider.readdir('/')).sort(), ['allowed', 'empty', 'file.txt', 'folder.txt', 'ro'])
  assert.deepEqual((await provider.readdir('/ro')).sort(), ['keep.txt'])
  for (const p of ['/unnamed.txt', '/ro/secret', '/ro/secret/hidden.txt']) {
    await refusedWith('ENOENT', provider.stat(p), p)
    await refusedWith('ENOENT', provider.open(p, 'r'), p)
  }
  await refusedWith('ENOENT', provider.readdir('/ro/secret'), 'listing a hidden folder')
})
