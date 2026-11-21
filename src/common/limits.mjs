// Every fixed number that tunes how Scooter behaves.
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
  // The most messages in one batch, retries first.
  BATCH_MAX_ITEMS: 20,
  // The largest prompt. It's one command-line argument, and Linux refuses one over 128 KB.
  PROMPT_MAX_BYTES: 96 * KB,
  // Attempts before a message moves to `failed`.
  MAX_ATTEMPTS: 4,
  // The wait before a message that failed for its own reasons is tried again.
  RETRY_WAIT: 1 * MINUTE,
  // The waits between tries while OpenRouter is down. The last one repeats.
  OUTAGE_RETRY_WAITS: [1 * MINUTE, 5 * MINUTE, 30 * MINUTE],
  // The wait between tries after a setup error.
  SETUP_RETRY_WAIT: 30 * MINUTE,
  // The waits before a runner that stopped on an error goes on again, after one stop, two, and
  // three or more in a row, where its service manager doesn't wait: those the native unit has
  // systemd keep, 1 minute, then 1 minute × √30, about 5½, then 30. A fault that stays
  // after pi has run then spends on OpenRouter at most twice an hour, as an outage does.
  RUNNER_RESTART_WAITS: [1 * MINUTE, Math.round(MINUTE * Math.sqrt(30)), 30 * MINUTE],
  // How many entries `failed` keeps.
  FAILED_KEEP: 100,
  // How often the runner looks for new lines, and the bridge checks the outbox and the email
  // spool.
  POLL_INTERVAL: 1 * SECOND,
  // At most one WhatsApp message this often, so the bot number doesn't look like spam. wacli warns
  // about sends closer together than 5 seconds.
  SEND_INTERVAL: 5 * SECOND,
  // The longest piece of a reply, in characters, under WhatsApp's limit.
  CHUNK_CHARS: 3500,
  // The longest text one outbox entry sends, in characters: four chunks of `CHUNK_CHARS`, which go
  // out as four to eight messages, since a text is cut at a break in the second half of each
  // chunk. A longer one is cut, with a line that says so, when it is written. The agent's answers
  // are its own to make as long as it likes, and one text of a megabyte would otherwise take the
  // bot number half an hour of sending, one message every `SEND_INTERVAL`.
  TEXT_MAX_CHARS: 14000,
  // The largest `entry.json` or `sending.json` the bridge reads. A text at its longest takes far
  // less, so a larger file was written by something else than `writeOutboxEntry`.
  OUTBOX_ENTRY_MAX_BYTES: 1 * MB,
  // A send that fails is tried again after a wait that starts at `first` and doubles up to `max`.
  // After `SEND_ATTEMPTS` failed tries of the same message, made while its channel was linked, the
  // entry no longer holds back the ones after it, and is given up on once one of theirs goes and
  // it fails again. Entries are sent in order, so one that can never go out would otherwise hold
  // back every one after it, the replies to `/status` among them. The same waits space out
  // the tries of a look at the outbox that failed, and of a reply to a command that couldn't be
  // written.
  SEND_RETRY_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
  SEND_ATTEMPTS: 8,
  // Where wacli posts its webhooks, on loopback.
  WEBHOOK_PORT: 8787,
  // The largest webhook body accepted from wacli.
  WEBHOOK_MAX_BYTES: 2 * MB,
  // WhatsApp catch-up: how often, how far back before where catch-up had got to, and how many
  // rows a page.
  CATCHUP_INTERVAL: 10 * MINUTE,
  CATCHUP_OVERLAP: 2 * MINUTE,
  CATCHUP_LIMIT: 500,
  // Retries for a failed media download, and the wait before each. A download that fails for good
  // leaves the message without its attachment, so the retries are spaced out enough for a
  // reconnecting wacli to come back.
  MEDIA_DOWNLOAD_RETRIES: 2,
  MEDIA_DOWNLOAD_RETRY_WAIT: 10 * SECOND,
  // The longest a wacli call other than `sync` may take before the bridge stops it. wacli stops
  // its own commands after 5 minutes (its `--timeout`); this bounds a call that doesn't, so one
  // stuck download can't hold up every message after it.
  WACLI_CALL_TIMEOUT: 6 * MINUTE,
  // The largest attachment, or email, that's stored.
  ATTACHMENT_MAX_BYTES: 100 * MB,
  // The longest extension an attachment's stored name takes from its original name, in
  // characters. A longer one is no extension, and the MIME type decides instead.
  ATTACHMENT_EXT_MAX_CHARS: 10,
  // Where an email's body is cut, in characters.
  EMAIL_TEXT_MAX_CHARS: 20000,
  // Where an email's subject is cut, in characters. Nothing else bounds it: it goes into the
  // datastore, the agent's prompt, and the `✅ Email:` text that stands for a reaction to an email,
  // which would otherwise go out as a message every `CHUNK_CHARS`.
  EMAIL_SUBJECT_MAX_CHARS: 1000,
  // The most of an email's header block that the bridge reads for the sender check. The
  // owner's mail has a few kilobytes of headers; one whose header block doesn't end within this is
  // ambiguous, and skipped.
  EMAIL_HEADER_MAX_BYTES: 256 * KB,
  // The largest `parsed.json` the bridge reads from the mail spool. The reader keeps an
  // email's text and subject one character past where the bridge cuts them, and hands over an
  // email whose description would be larger as one it couldn't parse, so a larger file was written
  // by something else than the reader.
  EMAIL_PARSED_MAX_BYTES: 1 * MB,
  // The longest original file name of an email's attachment, in characters: the reader cuts a
  // longer one, and the bridge refuses a `parsed.json` with one. The bridge names the stored
  // file itself, so this is only what the owner called it, as a line's `name`.
  ATTACHMENT_NAME_MAX_CHARS: 255,
  // The most of a name the bridge logs, in characters, of one it leaves in a folder another user
  // controls, such as a folder in the runner's outbox that isn't an entry's. Its length in
  // bytes is logged beside it.
  LOGGED_NAME_MAX_CHARS: 64,
  // A spool folder the bridge couldn't take for a reason of its own, such as a full disk, is
  // tried again after a wait that starts at `first` and doubles up to `max`. The folder stays,
  // so the email isn't lost, and the folders after it wait.
  SPOOL_RETRY_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
  // How many of the mailbox's newest messages `email-check` lists, and how long its run of the
  // email reader may take before it is stopped, so a server that doesn't answer can't hold the
  // command for the five minutes imapflow waits on a quiet connection.
  EMAIL_CHECK_COUNT: 5,
  EMAIL_CHECK_TIMEOUT: 2 * MINUTE,
  // The largest `state.json` or `status.json` of the runner's, or `state.json` of the email
  // reader's, that the bridge reads for `/status`, and the largest `run.lock` it reads before
  // a backup. They are a few kilobytes at most, written by another user, and the bridge reads
  // them as root, as files that user controls.
  STATUS_FILE_MAX_BYTES: 4 * MB,
  // The largest model request the network policy reads.
  MODEL_REQUEST_MAX_BYTES: 50 * MB,
  // Restart waits for wacli and the email reader: the first wait, then doubling up to `max`.
  RESTART_BACKOFF: { first: 5 * SECOND, factor: 2, max: 5 * MINUTE },
  // From SIGTERM to SIGKILL when stopping a program.
  STOP_GRACE: 15 * SECOND,
  // How often an unpaired wacli is checked again.
  AUTH_CHECK_INTERVAL: 1 * MINUTE,
  // How long past the time in `run.lock` a backup still waits for the run to finish. Past
  // it, the backup waits on only while a runner still holds its socket, at work after its run.
  BACKUP_LOCK_EXTRA: 2 * MINUTE,
  // The ISO weekday on which backups also run `restic check`: 7 is Sunday.
  RESTIC_CHECK_WEEKDAY: 7,
  // The longest one step of a backup, restic's backup, forget or check, may take before the bridge
  // stops it, and the backup fails. The channels are stopped and the runner waits for as long
  // as a backup lasts, so a restic that hung would stop Scooter for good. A first backup of years
  // of photos over a slow uplink can take hours; what it uploaded is used again by the next one.
  RESTIC_TIMEOUT: 6 * HOUR,
  // The period `/status` counts over.
  STATUS_WINDOW: 24 * HOUR,
  // The longest line of the network log that a reader takes. A longer one is skipped and counted,
  // as a line that isn't one is. The policy writes lines of a few hundred bytes; the bound is what
  // keeps a reader's memory fixed however the log was written.
  NETLOG_LINE_MAX_BYTES: 16 * KB,
  // The longest path a line of the network log keeps, in characters. A path is pi's to choose, and
  // could be as long as a request's head; cut here, every line the policy writes fits within
  // `NETLOG_LINE_MAX_BYTES`, so no reader skips one.
  NETLOG_PATH_MAX_CHARS: 1000,
  // The most requests one run may make that the network policy lets out, and the most it refuses
  // that the log takes one by one. A request that goes out takes a line before it goes, and up to
  // two more after, so the requests past the first are refused; refusals past the second are
  // counted, and the count written once, when the run ends. A run of pi makes a request a turn, a
  // few hundred at most in the longest run `agents.yaml` allows; a misled one could make tens of
  // thousands, each a line the runner and `/status` read.
  RUN_REQUESTS_MAX: 1000,
  RUN_REFUSALS_LOGGED_MAX: 100,
  // The most of each memory file, `preferences.md` and `needs-review.md`, that goes into the
  // agent's system prompt. pi writes them, and one that grew without bound would make every run's
  // request too large, with no run left that could shorten it.
  MEMORY_MAX_BYTES: 64 * KB,
  // The longest a git command of the runner may take before it is stopped.
  GIT_CALL_TIMEOUT: 1 * MINUTE,
  // The most `views/` and `memory/` may hold together after a run, in bytes. pi can make a file of
  // any size in an instant, all holes, and git reads every byte of a file to add it, so a run that
  // leaves more fails before git reads anything, rather than git running past `GIT_CALL_TIMEOUT`.
  // On the plan's Linux machine git adds this much in about 2 seconds, and the views of a
  // year of daily use take about 1 MB.
  AGENT_FILES_MAX_BYTES: 100 * MB,
  // The most files and folders `views/` and `memory/` may hold together after a run. pi can make
  // hundreds of thousands in a run, and some of git's work grows faster than their number, such as
  // taking them out of the index again, so a run that leaves more fails before git reads anything.
  // The default skills keep five CSV files, and the memory two more, which grow in rows, not in
  // number; git adds this many small files in about a tenth of a second on the plan's Linux machine.
  AGENT_FILES_MAX_COUNT: 20000,
  // The largest session file copied back from a run. pi wrote it, and the whole session goes to
  // the model on every request, so a larger one couldn't be sent anyway.
  SESSION_MAX_BYTES: 100 * MB,
  // The longest reason kept in `state.json` or quoted in a notice, in characters: the agent's own
  // reason on a `FAILED` line, or OpenRouter's error. Both come from outside the
  // runner's code.
  REASON_MAX_CHARS: 200,
  // How much of a message's text a notice quotes to name it, in characters.
  NOTICE_QUOTE_CHARS: 40,
  // The most texts one answer of the agent's sends: more than a full batch needs, a question about
  // each of its 20 items and a few lines besides. The rest are dropped and counted in the log, so
  // a misled run can't flood the owner's chat.
  ANSWER_MAX_TEXTS: 25,
  // pi's VMs: their memory and how many processors they get. pi, its tools and the files it
  // reads run in the memory, and so do the VM's `/tmp` and `/root`, which can each take half of it.
  VM_MEMORY_BYTES: 2 * 1024 * MB,
  VM_CPUS: 2,
  // The longest a VM may take to boot before the sandbox gives up on it, and the run is a setup
  // error, "the VM couldn't start". A VM boots in about 2 seconds with KVM and 6 under
  // emulation; Gondolin's own limit is 2 minutes, which a VM that never starts would spend at
  // every try.
  VM_START_TIMEOUT: 1 * MINUTE,
  // The most of pi's output the sandbox keeps: the start of stdout, which is pi's answer, and the
  // end of stderr, where OpenRouter's error is. With `-p` pi prints only its answer, a
  // few kilobytes, and nothing else bounds it. An answer cut here fails the run as pi's own failure.
  SANDBOX_STDOUT_MAX_BYTES: 1 * MB,
  SANDBOX_STDERR_MAX_BYTES: 64 * KB,
  // The most one run may write through the VM's writable folders, `views/`, `memory/` and
  // `run/session/`, in bytes written and in names made (files, folders and links). The bridge
  // writes on the same disk, so a run that writes more is stopped, its VM closed, and the run
  // fails as pi's own failure; the runner then frees what it wrote. A run leaves at most
  // `AGENT_FILES_MAX_BYTES` and `AGENT_FILES_MAX_COUNT` in the two folders and a session of
  // `SESSION_MAX_BYTES`; these leave room for rewriting them several times over.
  RUN_WRITE_MAX_BYTES: 1024 * MB,
  RUN_NAMES_MAX_COUNT: 100000,
  // The longest `build-image` waits for Alpine's index of one repository, body and all, when it
  // writes `packages.txt` after a build. It holds `runner/runner.sock` meanwhile, so no
  // runner can start, and an index of a couple of megabytes comes in seconds.
  APK_INDEX_TIMEOUT: 1 * MINUTE,
  // The longest `doctor` waits for OpenRouter's list of the endpoints that keep no data, and the
  // largest it reads. The list was 1.2 MB on 2026-11-18, and a host that doesn't answer is
  // one of the things doctor reports.
  DOCTOR_TIMEOUT: 30 * SECOND,
  DOCTOR_RESPONSE_MAX_BYTES: 32 * MB,
  // The values a number in `agents.yaml` may take, lowest and highest. A run can't be given
  // less than a minute, and a slip of the hand can't keep a backup waiting for hours.
  CONFIG_RANGES: {
    timeout_minutes: [1, 120],
  },
  // The values a numeric setting may take, lowest and highest. A setting outside its range
  // stops the service at startup, so a bad value can't make Scooter run batches in a tight loop,
  // hammer the mailbox, or keep no backups.
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

// No name can be added or removed: a write to a misspelled name throws, and `overrideLimits`
// refuses one, but a read of one gives `undefined`.
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
