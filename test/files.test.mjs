// Atomic file writes, the folder hand-off that the outbox and the mail spool share, and sortable
// IDs (5.3, 5.6 and 6.3 of DESIGN.md).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createIds, ensureDir, handOff, listHandOffs, readJsonFile, writeFileAtomic } from '../src/common/files.mjs'
import { createFakeClock } from './support/clock.mjs'
import { skipUnlessRoot } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const modeOf = file => fs.statSync(file).mode & 0o7777

// Sets the umask for one test.
function withUmask(t, mask) {
  const before = process.umask(mask)
  atEnd(t, () => process.umask(before))
}

test('files: an atomic write replaces the file whole, and leaves nothing else behind', t => {
  const dir = makeTestDir(t)
  const file = path.join(dir, 'state.json')

  writeFileAtomic(file, '{"cursor":1}\n')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"cursor":1}\n')
  writeFileAtomic(file, '{"cursor":2}\n')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"cursor":2}\n')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['state.json', 'tmp'])
  assert.deepEqual(readJsonFile(file), { cursor: 2 })
  assert.equal(readJsonFile(path.join(dir, 'missing.json')), undefined)
})

test('files: the mode is the one asked for, whatever the umask', t => {
  const dir = makeTestDir(t)
  for (const mask of [0o000, 0o022, 0o077]) {
    withUmask(t, mask)
    const secret = path.join(dir, `secret-${mask}`)
    writeFileAtomic(secret, 'x')
    assert.equal(modeOf(secret), 0o600)
    const shared = path.join(dir, `shared-${mask}`)
    writeFileAtomic(shared, 'x', { mode: 0o640 })
    assert.equal(modeOf(shared), 0o640)
    // Writing again keeps the mode asked for, not the old file's.
    writeFileAtomic(shared, 'y', { mode: 0o600 })
    assert.equal(modeOf(shared), 0o600)

    const nested = path.join(dir, `a-${mask}`, 'b', 'c')
    ensureDir(nested, { mode: 0o750 })
    assert.equal(modeOf(nested), 0o750)
    assert.equal(modeOf(path.dirname(nested)), 0o750)
  }
})

test('files: a failed write leaves the old file and no temporary one', t => {
  const dir = makeTestDir(t)
  const file = path.join(dir, 'state.json')
  writeFileAtomic(file, 'old')
  // A folder can't be renamed over by a file.
  const blocked = path.join(dir, 'blocked')
  fs.mkdirSync(blocked)
  fs.writeFileSync(path.join(blocked, 'inside'), '')
  assert.throws(() => writeFileAtomic(blocked, 'new'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['blocked', 'state.json', 'tmp'])
})

test('files: making a folder leaves folders that exist as they are', t => {
  const dir = makeTestDir(t)
  const existing = path.join(dir, 'existing')
  fs.mkdirSync(existing, { mode: 0o755 })
  fs.chmodSync(existing, 0o755)
  ensureDir(path.join(existing, 'new'), { mode: 0o700 })
  ensureDir(path.join(existing, 'new'), { mode: 0o700 })
  assert.equal(modeOf(existing), 0o755)
  assert.equal(modeOf(path.join(existing, 'new')), 0o700)
})

test('files: IDs are the UTC time and a counter, and sort in the order they were made', () => {
  const clock = createFakeClock('2026-11-09T15:50:15.123Z')
  const ids = createIds(clock)
  assert.equal(ids.next(), '20261109T155015123-0001')
  assert.equal(ids.next(), '20261109T155015123-0002')
  clock.set('2026-11-09T15:50:15.124Z')
  assert.equal(ids.next(), '20261109T155015124-0001')

  // The clock going back doesn't make an ID that sorts before the last.
  clock.set('2026-11-09T15:00:00.000Z')
  assert.equal(ids.next(), '20261109T155015124-0002')

  // More IDs in one millisecond than the counter holds move on to the next millisecond.
  const many = createIds(createFakeClock('2026-11-09T15:50:15.123Z'))
  const made = Array.from({ length: 10001 }, () => many.next())
  assert.equal(made[9998], '20261109T155015123-9999')
  assert.equal(made[9999], '20261109T155015124-0001')
  assert.deepEqual([...made].sort(), made)
  assert.equal(new Set(made).size, made.length)
})

test('files: a folder is handed over only once it is complete', async t => {
  const dir = makeTestDir(t)
  const outbox = path.join(dir, 'outbox')
  fs.mkdirSync(outbox)
  const ids = createIds(createFakeClock('2026-11-09T15:50:15.123Z'))

  let seenWhileFilling
  const id = await handOff(outbox, ids, async tmp => {
    assert.equal(path.basename(tmp), '.tmp-20261109T155015123-0001')
    fs.writeFileSync(path.join(tmp, 'entry.json'), '{"type":"text"}')
    // A reader that looks now sees nothing to take.
    seenWhileFilling = listHandOffs(outbox)
  })
  assert.equal(id, '20261109T155015123-0001')
  assert.deepEqual(seenWhileFilling, [])
  assert.deepEqual(listHandOffs(outbox), [id])
  assert.equal(fs.readFileSync(path.join(outbox, id, 'entry.json'), 'utf8'), '{"type":"text"}')
  assert.deepEqual(fs.readdirSync(outbox), [id])
  assert.equal(modeOf(path.join(outbox, id)), 0o700)
})

test('files: hand-offs are listed oldest first, without the unfinished ones', async t => {
  const dir = makeTestDir(t)
  const clock = createFakeClock('2026-11-09T15:50:15.123Z')
  const ids = createIds(clock)
  const made = []
  for (let n = 0; n < 3; n++) {
    made.push(await handOff(dir, ids, tmp => fs.writeFileSync(path.join(tmp, 'entry.json'), String(n))))
    clock.set(clock.now() + 1000)
  }
  fs.mkdirSync(path.join(dir, '.tmp-20261109T155000000-0001'))
  // `tmp` is the test's own temporary folder, and not a hand-off.
  assert.deepEqual(listHandOffs(dir).filter(name => name !== 'tmp'), made)
  assert.deepEqual(listHandOffs(path.join(dir, 'missing')), [])
})

test('files: a hand-off that fails leaves nothing', async t => {
  const dir = makeTestDir(t)
  const spool = path.join(dir, 'spool')
  fs.mkdirSync(spool)
  const ids = createIds(createFakeClock())
  await assert.rejects(
    handOff(spool, ids, tmp => {
      fs.writeFileSync(path.join(tmp, 'message.eml'), 'half')
      throw new Error('connection lost')
    }),
    /connection lost/,
  )
  assert.deepEqual(fs.readdirSync(spool), [])
})

test('files: two writers that make the same ID get different names', async t => {
  const dir = makeTestDir(t)
  const outbox = path.join(dir, 'outbox')
  fs.mkdirSync(outbox)
  // The runner and the bridge both write entries, each with its own counter (5.3).
  const runner = createIds(createFakeClock('2026-11-09T15:50:15.123Z'))
  const bridge = createIds(createFakeClock('2026-11-09T15:50:15.123Z'))

  // One after the other: the name is taken when the second renames.
  const first = await handOff(outbox, runner, tmp => fs.writeFileSync(path.join(tmp, 'entry.json'), 'runner'))
  const second = await handOff(outbox, bridge, tmp => fs.writeFileSync(path.join(tmp, 'entry.json'), 'bridge'))
  assert.equal(first, '20261109T155015123-0001')
  assert.equal(second, '20261109T155015123-0002')

  // At the same moment: the temporary name is taken when the second starts.
  const [third, fourth] = await Promise.all([
    handOff(outbox, runner, tmp => fs.writeFileSync(path.join(tmp, 'entry.json'), 'runner')),
    handOff(outbox, bridge, tmp => fs.writeFileSync(path.join(tmp, 'entry.json'), 'bridge')),
  ])
  assert.equal(new Set([first, second, third, fourth]).size, 4)
  assert.deepEqual(listHandOffs(outbox), [first, second, third, fourth].sort())
  for (const [id, by] of [
    [first, 'runner'],
    [second, 'bridge'],
    [third, 'runner'],
    [fourth, 'bridge'],
  ]) {
    assert.equal(fs.readFileSync(path.join(outbox, id, 'entry.json'), 'utf8'), by)
  }
  assert.deepEqual(fs.readdirSync(outbox).filter(name => name.startsWith('.')), [])
})

test('files: an owner is given to what is created', { skip: skipUnlessRoot }, t => {
  const dir = makeTestDir(t)
  const owner = { uid: 12001, gid: 12002 }
  const folder = path.join(dir, 'a', 'b')
  ensureDir(folder, { mode: 0o750, owner })
  const file = path.join(folder, 'state.json')
  writeFileAtomic(file, '{}', { mode: 0o640, owner })
  for (const target of [path.join(dir, 'a'), folder, file]) {
    const stat = fs.statSync(target)
    assert.deepEqual({ uid: stat.uid, gid: stat.gid }, owner, target)
  }
  // What was already there keeps its owner.
  assert.equal(fs.statSync(dir).uid, 0)
})
