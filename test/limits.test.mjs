// The constants module (8.6 of DESIGN.md): every value the design gives, and how tests change one.

import assert from 'node:assert/strict'
import test from 'node:test'
import { limits, overrideLimits } from '../src/common/limits.mjs'

const SECOND = 1000
const MINUTE = 60 * SECOND
const MB = 1024 * 1024

test('limits: the values of 8.6, and the webhook port', () => {
  const expected = {
    BATCH_MAX_ITEMS: 20,
    PROMPT_MAX_BYTES: 96 * 1024,
    MAX_ATTEMPTS: 4,
    RETRY_WAIT: MINUTE,
    OUTAGE_RETRY_WAITS: [MINUTE, 5 * MINUTE, 30 * MINUTE],
    SETUP_RETRY_WAIT: 30 * MINUTE,
    FAILED_KEEP: 100,
    POLL_INTERVAL: SECOND,
    SEND_INTERVAL: 5 * SECOND,
    CHUNK_CHARS: 3500,
    WEBHOOK_PORT: 8787,
    WEBHOOK_MAX_BYTES: 2 * MB,
    CATCHUP_INTERVAL: 10 * MINUTE,
    CATCHUP_OVERLAP: 2 * MINUTE,
    CATCHUP_LIMIT: 500,
    MEDIA_DOWNLOAD_RETRIES: 2,
    ATTACHMENT_MAX_BYTES: 100 * MB,
    EMAIL_TEXT_MAX_CHARS: 20000,
    MODEL_REQUEST_MAX_BYTES: 50 * MB,
    RESTART_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
    STOP_GRACE: 15 * SECOND,
    AUTH_CHECK_INTERVAL: MINUTE,
    BACKUP_LOCK_EXTRA: 2 * MINUTE,
    RESTIC_CHECK_WEEKDAY: 7,
    STATUS_WINDOW: 24 * 60 * MINUTE,
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.deepEqual(limits[name], value, name)
  }
})

test('limits: the prompt fits in one command-line argument', () => {
  // Linux refuses a single argument of 128 KB or more (13.3).
  assert.ok(limits.PROMPT_MAX_BYTES < 128 * 1024)
})

test('limits: a test changes a constant and puts it back', () => {
  const restore = overrideLimits({ MAX_ATTEMPTS: 2, RETRY_WAIT: 5 })
  assert.equal(limits.MAX_ATTEMPTS, 2)
  assert.equal(limits.RETRY_WAIT, 5)
  restore()
  assert.equal(limits.MAX_ATTEMPTS, 4)
  assert.equal(limits.RETRY_WAIT, MINUTE)
})

test('limits: a name that does not exist is refused', () => {
  assert.throws(() => overrideLimits({ MAX_ATTEMPT: 2 }), /no such limit: MAX_ATTEMPT/)
  assert.throws(() => {
    limits.NEW_LIMIT = 1
  }, TypeError)
})
