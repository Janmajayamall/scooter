// Lock files (5.5 and 6.4 of DESIGN.md): created exclusively, holding the pid, the start time and
// a deadline. How the runner and the bridge use the two locks together is tested with them.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { lockExists, readLock, releaseLock, takeLock } from '../src/common/locks.mjs'
import { createFakeClock } from './support/clock.mjs'
import { makeTestDir } from './support/tmp.mjs'

const at = text => Date.parse(text)

test('locks: a lock records who took it, when, and when its work must be over', t => {
  const dir = makeTestDir(t)
  const file = path.join(dir, 'run.lock')
  const clock = createFakeClock('2026-11-09T15:50:02Z')
  assert.equal(lockExists(file), false)
  assert.equal(readLock(file), null)

  // A run's deadline is its start plus the agent's timeout (6.4).
  assert.equal(takeLock(file, { clock, deadline: clock.now() + 10 * 60 * 1000 }), true)
  assert.equal(lockExists(file), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    pid: process.pid,
    at: '2026-11-09T15:50:02Z',
    deadline: '2026-11-09T16:00:02Z',
  })
  assert.deepEqual(readLock(file), { pid: process.pid, at: at('2026-11-09T15:50:02Z'), deadline: at('2026-11-09T16:00:02Z') })
  assert.equal(fs.statSync(file).mode & 0o7777, 0o600)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['run.lock', 'tmp'])
})

test('locks: a lock that is held is not taken again', t => {
  const dir = makeTestDir(t)
  const file = path.join(dir, 'backup.lock')
  const clock = createFakeClock('2026-11-09T22:00:00Z')
  assert.equal(takeLock(file, { clock, pid: 100 }), true)
  clock.set('2026-11-09T22:05:00Z')
  assert.equal(takeLock(file, { clock, pid: 200 }), false)
  // The holder's record is untouched. A lock without a deadline says so.
  assert.deepEqual(readLock(file), { pid: 100, at: at('2026-11-09T22:00:00Z'), deadline: null })
  assert.deepEqual(fs.readdirSync(dir).sort(), ['backup.lock', 'tmp'])

  releaseLock(file)
  assert.equal(lockExists(file), false)
  assert.equal(takeLock(file, { clock, pid: 200 }), true)
  assert.equal(readLock(file).pid, 200)
  // Releasing a lock that isn't there is fine: a leftover is removed at startup, if there is one.
  releaseLock(file)
  releaseLock(file)
})

test('locks: a lock nobody can read is still a lock', t => {
  const dir = makeTestDir(t)
  const file = path.join(dir, 'run.lock')
  for (const contents of ['', 'not json', '{"pid":"7","at":"yesterday","deadline":12}', '[]', 'null']) {
    fs.writeFileSync(file, contents)
    assert.equal(lockExists(file), true)
    assert.deepEqual(readLock(file), { pid: null, at: null, deadline: null }, contents)
    assert.equal(takeLock(file), false)
  }
})

test('locks: of several processes that try at once, one gets the lock', async t => {
  const dir = makeTestDir(t)
  const file = path.join(dir, 'run.lock')
  const go = path.join(dir, 'go')
  const locks = fileURLToPath(new URL('../src/common/locks.mjs', import.meta.url))
  // Each process waits for the same signal, a file, and then tries to take the lock.
  const script = `
    import fs from 'node:fs'
    import { takeLock } from ${JSON.stringify(locks)}
    process.stdout.write('ready\\n')
    while (!fs.existsSync(${JSON.stringify(go)})) {}
    process.stdout.write(takeLock(${JSON.stringify(file)}) ? 'taken' : 'held')
  `
  const contenders = Array.from({ length: 6 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    return {
      child,
      ready: new Promise(resolve => child.stdout.once('data', resolve)),
      result: new Promise(resolve => child.once('close', () => resolve(output.replace('ready\n', '')))),
    }
  })
  await Promise.all(contenders.map(contender => contender.ready))
  fs.writeFileSync(go, '')
  const results = await Promise.all(contenders.map(contender => contender.result))

  assert.equal(results.filter(result => result === 'taken').length, 1, results.join(' '))
  assert.equal(results.filter(result => result === 'held').length, 5, results.join(' '))
  const winner = contenders[results.indexOf('taken')].child.pid
  assert.equal(readLock(file).pid, winner)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['go', 'run.lock', 'tmp'])
})
