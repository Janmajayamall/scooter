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
  // The longest text one outbox entry sends, in characters: four chunks of `CHUNK_CHARS`, which go
  // out as four to eight messages, since a text is cut at a break in the second half of each
  // chunk. A longer one is cut, with a line that says so, when it is written. The agent's answers
  // are its own to make as long as it likes, and one text of a megabyte would otherwise take the
  // bot number half an hour of sending, one message every `SEND_INTERVAL` (5.3, 6.7).
  TEXT_MAX_CHARS: 14000,
  // The largest `entry.json` or `sending.json` the bridge reads. A text at its longest takes far
  // less, so a larger file was written by something else than `writeOutboxEntry` (5.3).
  OUTBOX_ENTRY_MAX_BYTES: 1 * MB,
  // A send that fails is tried again after a wait that starts at `first` and doubles up to `max`.
  // After `SEND_ATTEMPTS` failed tries of the same message, made while its channel was linked, the
  // entry no longer holds back the ones after it, and is given up on once one of theirs goes and
  // it fails again. Entries are sent in order, so one that can never go out would otherwise hold
  // back every one after it, the replies to `/status` among them (5.3). The same waits space out
  // the tries of a look at the outbox that failed, and of a reply to a command that couldn't be
  // written (5.4).
  SEND_RETRY_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
  SEND_ATTEMPTS: 8,
  // Where wacli posts its webhooks, on loopback (5.1, 5.2).
  WEBHOOK_PORT: 8787,
  // The largest webhook body accepted from wacli (5.2).
  WEBHOOK_MAX_BYTES: 2 * MB,
  // WhatsApp catch-up: how often, how far back before the newest line, and how many rows (5.2).
  CATCHUP_INTERVAL: 10 * MINUTE,
  CATCHUP_OVERLAP: 2 * MINUTE,
  CATCHUP_LIMIT: 500,
  // Retries for a failed media download, and the wait before each. A download that fails for good
  // leaves the message without its attachment, so the retries are spaced out enough for a
  // reconnecting wacli to come back (5.2).
  MEDIA_DOWNLOAD_RETRIES: 2,
  MEDIA_DOWNLOAD_RETRY_WAIT: 10 * SECOND,
  // The longest a wacli call other than `sync` may take before the bridge stops it. wacli stops
  // its own commands after 5 minutes (its `--timeout`); this bounds a call that doesn't, so one
  // stuck download can't hold up every message after it (5.1, 5.2).
  WACLI_CALL_TIMEOUT: 6 * MINUTE,
  // The largest attachment, or email, that's stored (4.4, 5.6).
  ATTACHMENT_MAX_BYTES: 100 * MB,
  // The longest extension an attachment's stored name takes from its original name, in
  // characters. A longer one is no extension, and the MIME type decides instead (4.4).
  ATTACHMENT_EXT_MAX_CHARS: 10,
  // Where an email's body is cut, in characters (5.6).
  EMAIL_TEXT_MAX_CHARS: 20000,
  // Where an email's subject is cut, in characters (5.6). Nothing else bounds it: it goes into the
  // datastore, the agent's prompt, and the `✅ Email:` text that stands for a reaction to an email,
  // which would otherwise go out as a message every `CHUNK_CHARS` (5.3).
  EMAIL_SUBJECT_MAX_CHARS: 1000,
  // The most of an email's header block that the bridge reads for the sender check (5.6). The
  // owner's mail has a few kilobytes of headers; one whose header block doesn't end within this is
  // ambiguous, and skipped.
  EMAIL_HEADER_MAX_BYTES: 256 * KB,
  // The largest `parsed.json` the bridge reads from the mail spool (5.6). The reader keeps an
  // email's text and subject one character past where the bridge cuts them, and hands over an
  // email whose description would be larger as one it couldn't parse, so a larger file was written
  // by something else than the reader.
  EMAIL_PARSED_MAX_BYTES: 1 * MB,
  // The longest original file name of an email's attachment, in characters: the reader cuts a
  // longer one, and the bridge refuses a `parsed.json` with one (5.6). The bridge names the stored
  // file itself (4.1), so this is only what the owner called it, as a line's `name` (4.2).
  ATTACHMENT_NAME_MAX_CHARS: 255,
  // A spool folder the bridge couldn't take for a reason of its own, such as a full disk, is
  // tried again after a wait that starts at `first` and doubles up to `max`. The folder stays,
  // so the email isn't lost, and the folders after it wait (5.6).
  SPOOL_RETRY_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
  // How many of the mailbox's newest messages `email-check` lists, and how long its run of the
  // email reader may take before it is stopped, so a server that doesn't answer can't hold the
  // command for the five minutes imapflow waits on a quiet connection (8.4).
  EMAIL_CHECK_COUNT: 5,
  EMAIL_CHECK_TIMEOUT: 2 * MINUTE,
  // The largest `state.json` or `status.json` of the runner's, or `state.json` of the email
  // reader's, that the bridge reads for `/status` (5.4). They are a few kilobytes each, written by
  // another user, and the bridge reads them as root, as files that user controls.
  STATUS_FILE_MAX_BYTES: 4 * MB,
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
  // The longest line of the network log that a reader takes. A longer one is skipped and counted,
  // as a line that isn't one is. The policy writes lines of a few hundred bytes; the bound is what
  // keeps a reader's memory fixed however the log was written (6.9, 6.13).
  NETLOG_LINE_MAX_BYTES: 16 * KB,
  // The most of each memory file, `preferences.md` and `needs-review.md`, that goes into the
  // agent's system prompt. pi writes them, and one that grew without bound would make every run's
  // request too large, with no run left that could shorten it (6.5).
  MEMORY_MAX_BYTES: 64 * KB,
  // The longest a git command of the runner may take before it is stopped (6.2, 6.8).
  GIT_CALL_TIMEOUT: 1 * MINUTE,
  // The most `views/` and `memory/` may hold together after a run, in bytes. pi can make a file of
  // any size in an instant, all holes, and git reads every byte of a file to add it, so a run that
  // leaves more fails before git reads anything, rather than git running past `GIT_CALL_TIMEOUT`
  // (6.8). On the plan's Linux machine git adds this much in about 2 seconds, and the views of a
  // year of daily use take about 1 MB.
  AGENT_FILES_MAX_BYTES: 100 * MB,
  // The most files and folders `views/` and `memory/` may hold together after a run. pi can make
  // hundreds of thousands in a run, and some of git's work grows faster than their number, such as
  // taking them out of the index again, so a run that leaves more fails before git reads anything
  // (6.8). A year of daily use makes about 380, a day page and a month's folder at a time, and git
  // adds this many small files in about a tenth of a second on the plan's Linux machine.
  AGENT_FILES_MAX_COUNT: 20000,
  // The largest session file copied back from a run. pi wrote it, and the whole session goes to
  // the model on every request, so a larger one couldn't be sent anyway (6.6, 6.13).
  SESSION_MAX_BYTES: 100 * MB,
  // The longest reason kept in `state.json` or quoted in a notice, in characters: the agent's own
  // reason on a `FAILED` line, or OpenRouter's error (6.8, 6.9). Both come from outside the
  // runner's code.
  REASON_MAX_CHARS: 200,
  // How much of a message's text a notice quotes to name it, in characters (6.9).
  NOTICE_QUOTE_CHARS: 40,
  // The most texts one answer of the agent's sends: more than a full batch needs, a question about
  // each of its 20 items and a few lines besides. The rest are dropped and counted in the log, so
  // a misled run can't flood the owner's chat (6.7).
  ANSWER_MAX_TEXTS: 25,
  // The values a number in `agents.yaml` may take, lowest and highest (6.1). A run can't be given
  // less than a minute, and a slip of the hand can't keep a backup waiting for hours (5.5).
  CONFIG_RANGES: {
    timeout_minutes: [1, 120],
  },
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
