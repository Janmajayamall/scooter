// Every fixed number that tunes how Scooter behaves (section 8.6 of DESIGN.md).
//
// These are constants, not settings. Code reads them as `limits.NAME` at the moment it needs one
// and never repeats a number inline, so a test can change one through `overrideLimits`.
// Durations are in milliseconds and sizes in bytes.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const KB = 1024
const MB = 1024 * KB

const values = {
  // The most messages in one batch, retries first (6.5).
  BATCH_MAX_ITEMS: 20,
  // The largest prompt. It's one command-line argument, and Linux refuses one over 128 KB (6.5).
  PROMPT_MAX_BYTES: 96 * KB,
  // Attempts before a message moves to `failed` (6.8).
  MAX_ATTEMPTS: 4,
  // The wait before a message that failed for its own reasons is tried again (6.8).
  RETRY_WAIT: 1 * MINUTE,
  // The waits between tries while OpenRouter is down. The last one repeats (6.9).
  OUTAGE_RETRY_WAITS: [1 * MINUTE, 5 * MINUTE, 30 * MINUTE],
  // The wait between tries after a setup error (6.9).
  SETUP_RETRY_WAIT: 30 * MINUTE,
  // How many entries `failed` keeps (6.8).
  FAILED_KEEP: 100,
  // How often the runner looks for new lines, and the bridge checks the outbox and the email
  // spool (5.3, 5.6, 6.4).
  POLL_INTERVAL: 1 * SECOND,
  // At most one WhatsApp message this often, so the bot number doesn't look like spam. wacli warns
  // about sends closer together than 5 seconds (5.3, 13.1).
  SEND_INTERVAL: 5 * SECOND,
  // The longest piece of a reply, in characters, under WhatsApp's limit (5.3).
  CHUNK_CHARS: 3500,
  // Where wacli posts its webhooks, on loopback (5.1, 5.2).
  WEBHOOK_PORT: 8787,
  // The largest webhook body accepted from wacli (5.2).
  WEBHOOK_MAX_BYTES: 2 * MB,
  // WhatsApp catch-up: how often, how far back before the newest line, and how many rows (5.2).
  CATCHUP_INTERVAL: 10 * MINUTE,
  CATCHUP_OVERLAP: 2 * MINUTE,
  CATCHUP_LIMIT: 500,
  // Retries for a failed media download (5.2).
  MEDIA_DOWNLOAD_RETRIES: 2,
  // The largest attachment, or email, that's stored (4.4, 5.6).
  ATTACHMENT_MAX_BYTES: 100 * MB,
  // The longest extension an attachment's stored name takes from its original name, in
  // characters. A longer one is no extension, and the MIME type decides instead (4.4).
  ATTACHMENT_EXT_MAX_CHARS: 10,
  // Where an email's body is cut, in characters (5.6).
  EMAIL_TEXT_MAX_CHARS: 20000,
  // The largest model request the network policy reads (6.13).
  MODEL_REQUEST_MAX_BYTES: 50 * MB,
  // Restart waits for wacli and the email reader: the first wait, then doubling up to `max`
  // (5.1, 5.6).
  RESTART_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
  // From SIGTERM to SIGKILL when stopping a program (5.1).
  STOP_GRACE: 15 * SECOND,
  // How often an unpaired wacli is checked again (5.1).
  AUTH_CHECK_INTERVAL: 1 * MINUTE,
  // How long past the time in `run.lock` a backup still waits for the run to finish (5.5).
  BACKUP_LOCK_EXTRA: 2 * MINUTE,
  // The ISO weekday on which backups also run `restic check`: 7 is Sunday (5.5).
  RESTIC_CHECK_WEEKDAY: 7,
  // The period `/status` counts over (5.4, 6.13).
  STATUS_WINDOW: 24 * HOUR,
  // The values a numeric setting may take, lowest and highest (8.2). A setting outside its range
  // stops the service at startup, so a bad value can't make Scooter run batches in a tight loop,
  // hammer the mailbox, or keep no backups (8.6).
  SETTING_RANGES: {
    BATCH_SECONDS: [1, 600],
    SESSION_ROLLOVER_HOUR: [0, 23],
    EMAIL_IMAP_PORT: [1, 65535],
    EMAIL_CHECK_SECONDS: [10, 3600],
    RESTIC_KEEP_DAILY: [1, 3650],
    RESTIC_KEEP_WEEKLY: [0, 520],
    RESTIC_KEEP_MONTHLY: [0, 1200],
  },
}

// No names can be added or removed, so a misspelled name fails instead of reading `undefined`.
export const limits = Object.seal(values)

// Changes some constants and returns a function that puts the old values back. For tests.
export function overrideLimits(changes) {
  const before = {}
  for (const name of Object.keys(changes)) {
    if (!Object.hasOwn(limits, name)) throw new Error(`no such limit: ${name}`)
    before[name] = limits[name]
  }
  Object.assign(limits, changes)
  return () => Object.assign(limits, before)
}
