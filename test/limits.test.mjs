// The constants module (8.6 of DESIGN.md): every value the design gives, and how tests change one.

import assert from 'node:assert/strict'
import test from 'node:test'
import { limits, overrideLimits } from '../src/common/limits.mjs'

const SECOND = 1000
const MINUTE = 60 * SECOND
const MB = 1024 * 1024

test('limits: the values of 8.6, the webhook port, and those of milestones 2 to 5', () => {
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
    // Not in 8.6: docs/DECISIONS.md, milestone 2.
    MEDIA_DOWNLOAD_RETRY_WAIT: 10 * SECOND,
    WACLI_CALL_TIMEOUT: 6 * MINUTE,
    ATTACHMENT_MAX_BYTES: 100 * MB,
    EMAIL_TEXT_MAX_CHARS: 20000,
    MODEL_REQUEST_MAX_BYTES: 50 * MB,
    RESTART_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
    STOP_GRACE: 15 * SECOND,
    AUTH_CHECK_INTERVAL: MINUTE,
    BACKUP_LOCK_EXTRA: 2 * MINUTE,
    RESTIC_CHECK_WEEKDAY: 7,
    STATUS_WINDOW: 24 * 60 * MINUTE,
    // Not in 8.6: docs/DECISIONS.md, milestone 3.
    MEMORY_MAX_BYTES: 64 * 1024,
    GIT_CALL_TIMEOUT: MINUTE,
    CONFIG_RANGES: { timeout_minutes: [1, 120] },
    // Not in 8.6: docs/DECISIONS.md, milestone 4.
    SESSION_MAX_BYTES: 100 * MB,
    REASON_MAX_CHARS: 200,
    NOTICE_QUOTE_CHARS: 40,
    AGENT_FILES_MAX_BYTES: 100 * MB,
    // Milestone 4, after the owner's answer (docs/DECISIONS.md, 4.7).
    AGENT_FILES_MAX_COUNT: 20000,
    ANSWER_MAX_TEXTS: 25,
    // Milestone 5: docs/DECISIONS.md, milestone 5.
    TEXT_MAX_CHARS: 14000,
    OUTBOX_ENTRY_MAX_BYTES: MB,
    SEND_RETRY_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
    SEND_ATTEMPTS: 8,
    NETLOG_LINE_MAX_BYTES: 16 * 1024,
    // Milestone 6: docs/DECISIONS.md, milestone 6.
    EMAIL_SUBJECT_MAX_CHARS: 1000,
    EMAIL_HEADER_MAX_BYTES: 256 * 1024,
    EMAIL_PARSED_MAX_BYTES: MB,
    // Milestone 6, after its review.
    ATTACHMENT_NAME_MAX_CHARS: 255,
    SPOOL_RETRY_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
    EMAIL_CHECK_COUNT: 5,
    EMAIL_CHECK_TIMEOUT: 2 * MINUTE,
    STATUS_FILE_MAX_BYTES: 4 * MB,
    // Milestone 7: docs/DECISIONS.md, milestone 7.
    VM_MEMORY_BYTES: 2048 * MB,
    VM_CPUS: 2,
    VM_START_TIMEOUT: MINUTE,
    SANDBOX_STDOUT_MAX_BYTES: MB,
    SANDBOX_STDERR_MAX_BYTES: 64 * 1024,
    RUN_WRITE_MAX_BYTES: 1024 * MB,
    RUN_NAMES_MAX_COUNT: 100000,
    // Milestone 7, after its review.
    APK_INDEX_TIMEOUT: MINUTE,
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.deepEqual(limits[name], value, name)
  }
})

test('limits: an email\'s text and subject at their longest fit the description the bridge reads, with room for its attachments', () => {
  // The reader keeps one character past each cut; JSON writes a control character as six bytes.
  const longest = (limits.EMAIL_TEXT_MAX_CHARS + 1 + limits.EMAIL_SUBJECT_MAX_CHARS + 1) * 6
  assert.ok(longest * 4 < limits.EMAIL_PARSED_MAX_BYTES)
  // A `✅ Email:` text, which stands for a reaction to an email, goes out as one message.
  assert.ok(limits.EMAIL_SUBJECT_MAX_CHARS + 20 < limits.CHUNK_CHARS)
})

test('limits: a text at its longest is a few chunks, and its entry far under what the bridge reads', () => {
  assert.equal(limits.TEXT_MAX_CHARS, 4 * limits.CHUNK_CHARS)
  // A character JSON writes longest is a control character, as six bytes.
  assert.ok(limits.TEXT_MAX_CHARS * 6 + 1024 < limits.OUTBOX_ENTRY_MAX_BYTES)
})

test('limits: a run may write what the runner accepts after it several times over', () => {
  assert.ok(limits.RUN_WRITE_MAX_BYTES >= 4 * (limits.AGENT_FILES_MAX_BYTES + limits.SESSION_MAX_BYTES))
  assert.ok(limits.RUN_NAMES_MAX_COUNT >= 4 * limits.AGENT_FILES_MAX_COUNT)
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
