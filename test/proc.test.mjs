// Running programs: an explicit environment, an argument list and no shell, a timeout, stopping
// with SIGTERM then SIGKILL, restarts with backoff, and running as another user, which is skipped
// with one warning when not root (3.2, 5.1 and section 10 of DESIGN.md).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { limits } from '../src/common/limits.mjs'
import { createProc, findProgram } from '../src/common/proc.mjs'
import { createFakeClock } from './support/clock.mjs'
import { createTestLog } from './support/log.mjs'
import { skipUnlessRoot, skipUnlessUsers } from './support/root.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

const NODE = process.execPath

function setup(options = {}) {
  const clock = createFakeClock()
  const { log, entries, events } = createTestLog({ clock })
  return { clock, entries, events, proc: createProc({ log, clock, ...options }) }
}

// Waits, in real time, until a file exists. Programs under test use files to say how far they got.
async function fileAppears(file) {
  while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 5))
}

const pidIsAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('proc: the result holds the exit code and both outputs', async () => {
  const { proc } = setup()
  const result = await proc.run(NODE, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'])
  assert.deepEqual(result, { code: 3, signal: null, stdout: 'out\n', stderr: 'err\n', timedOut: false })
  assert.equal((await proc.run(NODE, ['-e', ''])).code, 0)
})

test('proc: the program gets exactly the environment it is given', async t => {
  const { proc } = setup()
  process.env.SCOOTER_TEST_SECRET = 'must not leak'
  atEnd(t, () => delete process.env.SCOOTER_TEST_SECRET)
  const print = ['-e', 'process.stdout.write(JSON.stringify(process.env))']

  // By default nothing at all, not even PATH: nothing is inherited.
  assert.deepEqual(JSON.parse((await proc.run(NODE, print)).stdout), {})
  const env = { HOME: '/data/wacli', TZ: 'UTC' }
  assert.deepEqual(JSON.parse((await proc.run(NODE, print, { env })).stdout), env)
})

test('proc: arguments arrive as they are, and no shell reads them', async t => {
  const { proc } = setup()
  const dir = makeTestDir(t)
  const args = ['', 'two words', '$(touch injected)', '`touch injected`', '; touch injected', '"quoted"', "it's", '--flag', 'ünïcödé ✅', 'a\nb', '$HOME', '*']
  const result = await proc.run(NODE, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args], { cwd: dir })
  assert.deepEqual(JSON.parse(result.stdout), args)
  assert.deepEqual(fs.readdirSync(dir), ['tmp'])
})

test('proc: the working folder and the input', async t => {
  const { proc } = setup()
  const dir = makeTestDir(t)
  const where = await proc.run(NODE, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir })
  assert.equal(where.stdout, dir)
  const echo = await proc.run(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'line one\nline two\n' })
  assert.equal(echo.stdout, 'line one\nline two\n')
  // Without input, the program's stdin is closed, so it can't wait for any.
  const closed = await proc.run(NODE, ['-e', 'process.stdin.resume().on("end", () => console.log("end of input"))'])
  assert.equal(closed.stdout, 'end of input\n')
  // A program that doesn't read its input still ends with its own result.
  const ignored = await proc.run(NODE, ['-e', 'process.exit(4)'], { input: 'x'.repeat(1_000_000) })
  assert.equal(ignored.code, 4)
})

test('proc: a program is found on Scooter\'s PATH, though its own environment has none', async t => {
  const { proc } = setup()
  const dir = makeTestDir(t)
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  // A stub placed first on PATH, as the tests of later milestones place wacli, pi and restic.
  fs.writeFileSync(path.join(bin, 'stub'), `#!${NODE}\nprocess.stdout.write('stub ran with PATH=' + process.env.PATH)\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'not-executable'), 'x', { mode: 0o644 })
  fs.mkdirSync(path.join(bin, 'folder'))
  const before = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${before}`
  atEnd(t, () => (process.env.PATH = before))

  assert.equal(findProgram('stub'), path.join(bin, 'stub'))
  assert.equal(findProgram('not-executable'), null)
  assert.equal(findProgram('folder'), null)
  assert.equal(findProgram('/somewhere/else/program'), '/somewhere/else/program')
  assert.equal((await proc.run('stub')).stdout, 'stub ran with PATH=undefined')

  await assert.rejects(proc.run('no-such-program-anywhere'), error => {
    assert.equal(error.code, 'ENOENT')
    assert.match(error.message, /program not found: no-such-program-anywhere/)
    return true
  })
  await assert.rejects(proc.run(path.join(bin, 'missing')), error => error.code === 'ENOENT')
})

test('proc: a timeout stops the program with SIGTERM', async t => {
  const { proc, clock } = setup()
  const dir = makeTestDir(t)
  const ready = path.join(dir, 'ready')
  // It says it has started before it signals that it's ready, so the output is there by then.
  const script = `console.log('started'); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`
  const running = proc.run(NODE, ['-e', script], { timeout: 60_000 })
  await fileAppears(ready)

  await clock.advance(59_999)
  await clock.advance(1)
  const result = await running
  assert.deepEqual(result, { code: null, signal: 'SIGTERM', stdout: 'started\n', stderr: '', timedOut: true })
  assert.deepEqual(clock.sleeping(), [])
})

test('proc: a program that ignores SIGTERM gets SIGKILL after the grace period', async t => {
  const { proc, clock } = setup()
  const dir = makeTestDir(t)
  const ready = path.join(dir, 'ready')
  const termed = path.join(dir, 'termed')
  const script = `
    const fs = require('fs')
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termed)}, ''))
    fs.writeFileSync(${JSON.stringify(ready)}, '')
    setInterval(() => {}, 1000)
  `
  const running = proc.run(NODE, ['-e', script], { timeout: 10_000 })
  await fileAppears(ready)
  await clock.advance(10_000)
  await fileAppears(termed)

  let done = false
  running.then(() => (done = true))
  await clock.advance(limits.STOP_GRACE - 1)
  assert.equal(done, false)
  await clock.advance(1)
  const result = await running
  assert.equal(result.signal, 'SIGKILL')
  assert.equal(result.timedOut, true)
})

test('proc: a stopped program is waited for until it exits, even when what it started holds its output', async t => {
  const { proc, clock } = setup()
  const dir = makeTestDir(t)
  const ready = path.join(dir, 'ready')
  // A wrapper that starts its real program without `exec`: the program outlives it, with the
  // wrapper's stdout and stderr, and ignores SIGTERM besides.
  const inner = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000)`
  const wrapper = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`
  const running = proc.run(NODE, ['-e', wrapper], { timeout: 1000 })
  await fileAppears(ready)
  const innerPid = Number(fs.readFileSync(ready, 'utf8'))
  atEnd(t, () => {
    if (pidIsAlive(innerPid)) process.kill(innerPid, 'SIGKILL')
  })

  await clock.advance(1000)
  const result = await running
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.timedOut, true)
  assert.deepEqual(clock.sleeping(), [])
  // What it left behind is still running. The signals go to the program alone (D25).
  assert.ok(pidIsAlive(innerPid))
})

test('proc: a program that ends in time is not disturbed, and leaves no timer', async () => {
  const { proc, clock } = setup()
  const result = await proc.run(NODE, ['-e', 'console.log("quick")'], { timeout: 60_000 })
  assert.deepEqual(result, { code: 0, signal: null, stdout: 'quick\n', stderr: '', timedOut: false })
  assert.deepEqual(clock.sleeping(), [])
})

test('proc: an abort signal stops the program the same way', async t => {
  const { proc } = setup()
  const dir = makeTestDir(t)
  const ready = path.join(dir, 'ready')
  const controller = new AbortController()
  const script = `require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`
  const running = proc.run(NODE, ['-e', script], { signal: controller.signal })
  await fileAppears(ready)
  controller.abort()
  const result = await running
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.timedOut, false)

  // Already aborted: the program is stopped as soon as it starts.
  const late = await proc.run(NODE, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal })
  assert.equal(late.signal, 'SIGTERM')
})

test('proc: not root, so running as another user is skipped, with one warning', async () => {
  const { proc, entries } = setup({ isRoot: () => false })
  const user = { uid: 10001, gid: 10001 }
  const whoami = ['-e', 'process.stdout.write(String(process.getuid()))']

  assert.equal((await proc.run(NODE, whoami, { user })).stdout, String(process.getuid()))
  assert.equal((await proc.run(NODE, whoami, { user })).stdout, String(process.getuid()))
  assert.equal(await proc.lookupUser('scooter-wacli'), null)
  const supervisor = proc.supervise(NODE, ['-e', 'setInterval(() => {}, 1000)'], { user })
  await supervisor.stop()

  const warnings = entries.filter(entry => entry.level === 'warn')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].event, 'proc.not_root')

  // Without a user to switch to, there is nothing to warn about.
  const quiet = setup({ isRoot: () => false })
  await quiet.proc.run(NODE, ['-e', ''])
  assert.deepEqual(quiet.entries, [])
})

test('proc: as root, a program runs as the user it is given, without root\'s groups', { skip: skipUnlessRoot }, async () => {
  const { proc, entries } = setup()
  const user = { uid: 12001, gid: 12002 }
  const script = 'process.stdout.write(JSON.stringify([process.getuid(), process.getgid(), process.getgroups()]))'
  const result = await proc.run(NODE, ['-e', script], { user })
  const [uid, gid, groups] = JSON.parse(result.stdout)
  assert.equal(uid, 12001)
  assert.equal(gid, 12002)
  assert.deepEqual(groups.filter(group => group !== 12002), [])
  assert.deepEqual(entries, [])
})

test('proc: as root, a user is looked up by name', { skip: skipUnlessRoot }, async () => {
  const { proc } = setup()
  assert.deepEqual(await proc.lookupUser('root'), { uid: 0, gid: 0 })
  await assert.rejects(proc.lookupUser('scooter-no-such-user'), /there is no user scooter-no-such-user/)
  await assert.rejects(proc.lookupUser('-u'), /not a user name/)
  await assert.rejects(proc.lookupUser('root; id'), /not a user name/)
})

test('proc: as root, a user that setup would create is found', { skip: skipUnlessUsers }, async () => {
  const { proc } = setup()
  // What `setup` does for each of Scooter's users (8.4): a system user without a login shell.
  const add = await proc.run('useradd', ['--system', '--user-group', '--shell', '/usr/sbin/nologin', 'scooter-test-user'], {
    env: { PATH: process.env.PATH },
  })
  assert.equal(add.code, 0, add.stderr)
  try {
    const user = await proc.lookupUser('scooter-test-user')
    assert.ok(user.uid > 0 && user.gid > 0)
    const whoami = await proc.run('id', ['-un'], { user, env: { PATH: process.env.PATH } })
    assert.equal(whoami.stdout, 'scooter-test-user\n')
  } finally {
    await proc.run('userdel', ['scooter-test-user'], { env: { PATH: process.env.PATH } })
  }
})

test('proc: a supervised program is restarted after 5 seconds, then 10, doubling up to 5 minutes', async () => {
  const { proc, clock, entries } = setup()
  const exits = []
  const starts = []
  const supervisor = proc.supervise(NODE, ['-e', 'process.exit(7)'], {
    onStart: ({ pid }) => starts.push(pid),
    onExit: exit => exits.push(exit),
  })

  const SECOND = 1000
  const expected = [5, 10, 20, 40, 80, 160, 300, 300].map(seconds => seconds * SECOND)
  for (const wait of expected) {
    await clock.whenSleeping()
    assert.deepEqual(clock.sleeping(), [wait])
    assert.equal(starts.length, exits.length)
    // Nothing is restarted before the wait is over.
    await clock.advance(wait - 1)
    assert.deepEqual(clock.sleeping(), [1])
    await clock.advance(1)
  }
  await clock.whenSleeping()
  await supervisor.stop()

  assert.deepEqual(exits.map(exit => exit.restartIn), [...expected, 300 * SECOND])
  assert.deepEqual(exits.map(exit => [exit.code, exit.signal]), exits.map(() => [7, null]))
  assert.equal(new Set(starts).size, 9)
  // The log names the program and never its arguments, which may hold a secret (5.1).
  const text = JSON.stringify(entries)
  assert.ok(text.includes(`"program":"${path.basename(NODE)}"`))
  assert.ok(!text.includes('process.exit'))
  assert.deepEqual([...new Set(entries.map(entry => entry.event))], ['proc.started', 'proc.exited', 'proc.stopped'])
})

test('proc: after a run as long as the longest wait, the wait starts again at 5 seconds', async t => {
  const { proc, clock } = setup()
  const dir = makeTestDir(t)
  // The program runs until the file `stop-<n>` appears, where n counts its starts.
  const counter = path.join(dir, 'count')
  const script = `
    const fs = require('fs')
    const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1 : 1
    fs.writeFileSync(${JSON.stringify(counter)} + '.next', String(n))
    fs.renameSync(${JSON.stringify(counter)} + '.next', ${JSON.stringify(counter)})
    setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(dir, 'stop-'))} + n)) process.exit(1) }, 5)
  `
  const started = async n => {
    while (!fs.existsSync(counter) || fs.readFileSync(counter, 'utf8') !== String(n)) await new Promise(resolve => setTimeout(resolve, 5))
  }
  const exits = []
  const supervisor = proc.supervise(NODE, ['-e', script], { onExit: exit => exits.push(exit) })

  // Two short runs: the wait doubles.
  for (const n of [1, 2]) {
    await started(n)
    fs.writeFileSync(path.join(dir, `stop-${n}`), '')
    await clock.whenSleeping()
    await clock.advance(clock.sleeping()[0])
  }
  // A run of five minutes: the program was working, so the next wait is the first again.
  await started(3)
  clock.set(clock.now() + limits.RESTART_BACKOFF.max)
  fs.writeFileSync(path.join(dir, 'stop-3'), '')
  await clock.whenSleeping()
  await clock.advance(clock.sleeping()[0])
  // And a short one after that doubles from there.
  await started(4)
  fs.writeFileSync(path.join(dir, 'stop-4'), '')
  await clock.whenSleeping()
  await supervisor.stop()

  assert.deepEqual(exits.map(exit => exit.restartIn), [5000, 10000, 5000, 10000])
  assert.equal(exits[2].ms, limits.RESTART_BACKOFF.max)
})

test('proc: stopping a supervised program sends SIGTERM, then SIGKILL, and restarts nothing', async t => {
  const { proc, clock, events } = setup()
  const dir = makeTestDir(t)
  const ready = path.join(dir, 'ready')
  const termed = path.join(dir, 'termed')

  // One that ends on SIGTERM.
  let pid
  const polite = proc.supervise(NODE, ['-e', `require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`], {
    onStart: start => (pid = start.pid),
  })
  await fileAppears(ready)
  assert.ok(pidIsAlive(pid))
  await polite.stop()
  assert.ok(!pidIsAlive(pid))
  assert.deepEqual(clock.sleeping(), [])
  assert.deepEqual(events(), ['proc.started', 'proc.stopped'])

  // One that ignores it.
  fs.rmSync(ready)
  const script = `
    const fs = require('fs')
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termed)}, ''))
    fs.writeFileSync(${JSON.stringify(ready)}, '')
    setInterval(() => {}, 1000)
  `
  const stubborn = proc.supervise(NODE, ['-e', script], { onStart: start => (pid = start.pid) })
  await fileAppears(ready)
  let stopped = false
  const stopping = stubborn.stop().then(() => (stopped = true))
  await fileAppears(termed)
  await clock.advance(limits.STOP_GRACE - 1)
  assert.equal(stopped, false)
  assert.ok(pidIsAlive(pid))
  await clock.advance(1)
  await stopping
  assert.ok(!pidIsAlive(pid))

  // Stopping during the wait between restarts ends the wait.
  const failing = proc.supervise(NODE, ['-e', 'process.exit(1)'])
  await clock.whenSleeping()
  await failing.stop()
  assert.deepEqual(clock.sleeping(), [])
  await failing.done
})

test('proc: a supervised program starts only once the check before each start lets it', async t => {
  const { proc, clock } = setup()
  const dir = makeTestDir(t)
  const ready = path.join(dir, 'ready')
  const checks = []
  let allow = false
  const exits = []
  const supervisor = proc.supervise(NODE, ['-e', `require('fs').writeFileSync(${JSON.stringify(ready)}, ''); process.exit(3)`], {
    // Checks once a minute until it is allowed, as the WhatsApp module waits for pairing.
    async before({ signal }) {
      for (;;) {
        checks.push(clock.now())
        if (allow) return
        await clock.sleep(60_000, { signal })
      }
    },
    onExit: exit => exits.push(exit),
  })

  await clock.whenSleeping()
  await clock.advance(60_000)
  await clock.whenSleeping()
  assert.equal(checks.length, 2)
  assert.equal(fs.existsSync(ready), false)

  allow = true
  await clock.advance(60_000)
  await clock.whenSleeping()
  assert.equal(fs.existsSync(ready), true)
  // The time spent waiting isn't part of the run, and the restart waits as usual, then checks again.
  assert.equal(exits.length, 1)
  assert.ok(exits[0].ms < 60_000)
  assert.deepEqual(clock.sleeping(), [5000])
  await clock.advance(5000)
  await clock.whenSleeping()
  assert.equal(checks.length, 4)

  // Stopping while the check waits ends it.
  allow = false
  fs.rmSync(ready)
  await clock.advance(10_000)
  await clock.whenSleeping()
  assert.equal(checks.length, 5)
  assert.deepEqual(clock.sleeping(), [60_000])
  await supervisor.stop()
  assert.deepEqual(clock.sleeping(), [])
  assert.equal(fs.existsSync(ready), false)

  // A check that fails counts as a start that failed.
  const failing = proc.supervise(NODE, ['-e', ''], {
    before: async () => {
      throw new Error('no')
    },
    onExit: exit => exits.push(exit),
  })
  await clock.whenSleeping()
  await failing.stop()
  assert.deepEqual(exits.at(-1), { code: null, signal: null, ms: 0, restartIn: 5000 })
})

test('proc: a supervised program that can\'t be started is tried again, with the same waits', async () => {
  const { proc, clock, entries } = setup()
  const exits = []
  const supervisor = proc.supervise('no-such-program-anywhere', [], { onExit: exit => exits.push(exit) })
  await clock.whenSleeping()
  await clock.advance(5000)
  await clock.whenSleeping()
  await supervisor.stop()
  assert.deepEqual(exits, [
    { code: null, signal: null, ms: 0, restartIn: 5000 },
    { code: null, signal: null, ms: 0, restartIn: 10000 },
  ])
  assert.deepEqual(
    entries.filter(entry => entry.event === 'proc.exited').map(entry => entry.code),
    ['ENOENT', 'ENOENT'],
  )
})
