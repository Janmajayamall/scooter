// Logging: one JSON line per event, and no message text or file contents (section 9 of DESIGN.md).

import assert from 'node:assert/strict'
import test from 'node:test'
import { createLog, errorFields } from '../src/common/log.mjs'
import { createFakeClock } from './support/clock.mjs'

function capture(component = 'bridge') {
  const lines = []
  const log = createLog({ component, clock: createFakeClock('2026-11-09T15:43:02Z'), write: line => lines.push(line) })
  return { log, lines }
}

test('log: one JSON object per line, with the time in UTC', () => {
  const { log, lines } = capture()
  log.info('store.appended', { seq: 1042, kind: 'message', bytes: 187, stored: true, sourceId: null })
  log.warn('proc.exited', { exitCode: 1 })
  log.error('store.write_failed')

  assert.equal(lines.length, 3)
  for (const line of lines) {
    assert.ok(line.endsWith('\n'))
    assert.equal(line.indexOf('\n'), line.length - 1)
  }
  assert.deepEqual(JSON.parse(lines[0]), {
    at: '2026-11-09T15:43:02Z',
    level: 'info',
    component: 'bridge',
    event: 'store.appended',
    seq: 1042,
    kind: 'message',
    bytes: 187,
    stored: true,
    sourceId: null,
  })
  assert.equal(JSON.parse(lines[1]).level, 'warn')
  assert.deepEqual(JSON.parse(lines[2]), { at: '2026-11-09T15:43:02Z', level: 'error', component: 'bridge', event: 'store.write_failed' })
})

test('log: a datastore line passed whole gives away no content', () => {
  const { log, lines } = capture()
  const line = {
    seq: 1071,
    kind: 'message',
    source: 'email',
    subject: 'Call with Sam',
    text: 'Recording from today\'s call.',
    quoted: 'see you at 5',
    files: [{ path: '1071.eml', mime: 'message/rfc822', name: 'secret plans.eml', bytes: 19262388 }],
    media: { type: 'image', error: 'download failed' },
  }
  log.info('intake.stored', line)

  const entry = JSON.parse(lines[0])
  assert.deepEqual(entry, {
    at: '2026-11-09T15:43:02Z',
    level: 'info',
    component: 'bridge',
    event: 'intake.stored',
    seq: 1071,
    kind: 'message',
    source: 'email',
    subject: '[withheld]',
    text: '[withheld]',
    quoted: '[withheld]',
    files: '[array]',
    media: '[object]',
  })
  for (const secret of ['Sam', 'Recording', 'see you', 'secret plans']) assert.ok(!lines[0].includes(secret), secret)
})

test('log: fields are plain values, and the log\'s own fields can\'t be replaced', () => {
  const { log, lines } = capture('runner')
  log.info('run.done', { seqs: [1050, 1051], level: 'fake', component: 'fake', at: 'fake', event: 'fake', skipped: undefined, when: new Date(0) })
  assert.deepEqual(JSON.parse(lines[0]), {
    at: '2026-11-09T15:43:02Z',
    level: 'info',
    component: 'runner',
    event: 'run.done',
    seqs: [1050, 1051],
    when: '[object]',
  })
})

test('log: an error is described without its message', () => {
  // A parsing error quotes what was being parsed, which may be a message.
  let parsing
  try {
    JSON.parse('coffee 150 at Blue Tokai')
  } catch (error) {
    parsing = error
  }
  assert.deepEqual(errorFields(parsing), { error: 'SyntaxError' })

  const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/data/x'"), { code: 'ENOENT', syscall: 'open' })
  assert.deepEqual(errorFields(missing), { error: 'Error', code: 'ENOENT', syscall: 'open' })
  assert.deepEqual(errorFields('just a string'), { error: 'Error' })
  // A program that failed: its exit code and whether it timed out say why, and repeat nothing it
  // printed.
  const failed = Object.assign(new Error('wacli media download: exit code 1'), { code: 'EWACLI', exitCode: 1, timedOut: false })
  assert.deepEqual(errorFields(failed), { error: 'Error', code: 'EWACLI', exitCode: 1 })
  const timedOut = Object.assign(new Error('wacli messages list: timed out'), { code: 'EWACLI', exitCode: null, timedOut: true })
  assert.deepEqual(errorFields(timedOut), { error: 'Error', code: 'EWACLI', timedOut: true })
  assert.deepEqual(errorFields(Object.assign(new Error('x'), { exitCode: '1', timedOut: 'yes' })), { error: 'Error' })

  const { log, lines } = capture()
  log.error('intake.failed', { seq: 7, ...errorFields(parsing) })
  assert.ok(!lines[0].includes('coffee'))
})

test('log: by default lines go to stderr', t => {
  const written = []
  t.mock.method(process.stderr, 'write', chunk => written.push(chunk))
  createLog({ component: 'bridge' }).info('started')
  t.mock.restoreAll()
  assert.equal(written.length, 1)
  assert.equal(JSON.parse(written[0]).event, 'started')
})
