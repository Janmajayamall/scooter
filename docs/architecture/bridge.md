# The bridge

The bridge is Scooter's only link to the owner, and the only writer of the datastore. It runs the channels' programs, turns what they receive into datastore lines, delivers the outbox, and makes the backups. This document covers its core: how it starts and stops, what it asks of a channel, intake, `scooter status` and the bridge's `status.json`, and its state. Each channel, delivery and the backups have documents of their own: [the WhatsApp channel](whatsapp.md), [the email channel](email.md), [delivery](delivery.md) and [backups](backups.md).

Which user it runs as, what it can reach and which secrets it holds are in [The boundaries](../ARCHITECTURE.md#the-boundaries). It never talks to OpenRouter, runs or signals pi, or decides anything about a message's content.

## Files

- `src/bridge/main.mjs`: `scooter bridge`: starting, stopping, and `SIGUSR1`.
- `src/bridge/channels/index.mjs`: what the core asks of a channel, and the record, with its check.
- `src/bridge/intake.mjs`: records to datastore lines, with their attachments.
- `src/bridge/status.mjs`: `scooter status`, and `bridge/status/status.json`, which the bridge writes for it.
- `src/bridge/state.mjs`: the bridge's state, `bridge/state.json`.

## Channels

The bridge reaches the owner through channels: WhatsApp, which receives and sends, and email, which only receives. Each channel is one module in `src/bridge/channels/`, and only that module deals with its service. The rest of the bridge, the **core** (the store, intake, delivery and the backups), calls every channel through the same object ([Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way)). Tests drive the core with a fake channel, `test/support/fake-channel.mjs`.

| Member | What it is |
|---|---|
| `name` | `whatsapp` or `email`: the `source` of the lines its records become |
| `keepsUntilStored` | Whether a message stays with the channel until intake has stored it, so that one the bridge can't store now, for a reason of its own such as a full disk, is handed over again later |
| `start(onRecord)` | Starts receiving, and calls `onRecord(record)` for each message from the owner, awaiting what it returns. The channel drops everything else itself |
| `stop()` | Stops receiving, for backups and shutdown |
| `download(record, n, path)` | Saves the record's `n`th attachment, counting from 1, at `path`, a file in a folder only the bridge can write. Rejects if it can't: with the code `EFBIG` when it is too large to store, and with `bridgeSide: true` when the copy failed on the bridge's side, such as on a full disk |
| `status()` | One line for `scooter status`, which the bridge writes to `bridge/status/status.json` ([scooter status](#scooter-status)) |
| `canSend`, `canReact` | Whether it can send text, and react to a message |
| `ready()` | Whether it can send now |
| `sendText(text, quoteId, { signal })` | Sends `text`, quoting the message whose channel ID is `quoteId` when it isn't null, and resolves with the new message's channel ID, or null if the channel gave none. Rejects if it couldn't send. `signal` stops it, for a bridge that is stopping |
| `react(id, emoji, { signal })` | Reacts with `emoji` to the owner's message whose channel ID is `id`, and resolves as `sendText` does |

A **record** is a message in channel-neutral form, the same for every channel: what the core acts on, and the channel's own `data`. `checkRecord` is its shape in code, and intake refuses, and logs, a record that fails it, which is a bug in its channel.

| Field | What it holds |
|---|---|
| `source` | The channel's name |
| `id` | The channel's own ID, which becomes `sourceId`. For an edit or a deletion, the ID of the message it changes |
| `at` | When it was sent, as a UTC time to the second, or null when the channel doesn't know, and then the time it arrived |
| `text` | Its text, or a media caption; `""` if none |
| `attachments` | What it carries, each `{ type, mime, name, bytes, error }`: the kind of media, the MIME type, the original file name and the size when the channel knows them (else null), and `error` when the core must not try to download it, saying why (else null) |
| `replyToId` | The ID of the message it quotes, or null |
| `reactionToId` | For a reaction, the ID of the message reacted to; null otherwise |
| `edited`, `revoked` | Whether it is an edit of `id`, or a deletion of `id` |
| `data` | An object of JSON values, `{}` for none: what the channel keeps of the message that the core doesn't act on, which becomes the line's `data` ([data](datastore.md#data)). The channel's module owns what is in it, and its rules, such as that an email has a subject; the core checks only that it is an object of JSON values |

## Starting up

`scooter bridge` starts the bridge, in this order:

1. It checks `EMAIL_AUTHSERV_ID` ([Settings](email.md#settings)).
2. It looks up `scooter-wacli` and `scooter-runner`, and `scooter-mail` with email on. Not root, it finds none, and switching users and setting owners is skipped, with one warning ([Running programs](shared-code.md#running-programs)).
3. It makes the data folder and its own folder, if they are missing, with the owners and modes of [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners). `setup` makes both in an install.
4. It makes `exchange/`, `exchange/outbox/` and `exchange/locks/`, if they are missing, with the runner's owner and mode ([Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners)). *Why:* had the bridge made them as root, the runner couldn't write its entries or take `run.lock` there, and would fail every run.
5. It takes `bridge/bridge.sock`, so it is the only bridge on the data folder ([One service per data folder](shared-code.md#one-service-per-data-folder)). *Why:* two bridges on one datastore would give out the same `seq`, and neither would start again until the log was repaired by hand.
6. It removes a leftover `backup.lock` ([The locks](exchange.md#the-locks)).
7. It empties `bridge/incoming/`: attachments that waited for the store when it last stopped. Their messages weren't stored, and the channel hands them over again.
8. It opens the store, owned by root with the group of `scooter-runner`, then its state.
9. It makes its channels, WhatsApp and, when `EMAIL_IMAP_HOST` is set, email, and checks `DEFAULT_CHANNEL` against them ([Choosing the channel](delivery.md#choosing-the-channel)).
10. It starts the channels; then delivery, which first sends what was left from where a crash cut it short; the backups' schedule; and the writing of `bridge/status/status.json` ([The bridge's status.json](#the-bridges-statusjson)).

A start that fails prints why and exits with 1, or with 2 when it can't start because of how it is configured: a `DEFAULT_CHANNEL` that can't send ([Choosing the channel](delivery.md#choosing-the-channel)), or email on without `EMAIL_AUTHSERV_ID` ([Settings](email.md#settings)).

**Stopping**, on `SIGTERM` or `SIGINT`: the backups, cutting short one in progress ([Results](backups.md#results)); then delivery, cutting short a send in progress, which goes out again at the next start; then the channels; then it waits for what intake was handed to be stored, writes `bridge/status/status.json` once more, saying it stopped, lets go of its socket, and exits with 0. A store that stops taking lines ([Writing](datastore.md#writing)) stops the bridge too, with 1, so its service manager starts it again. `SIGUSR1` asks for a backup ([When backups run](backups.md#when-backups-run)).

**What it needs.** Neither service needs the other ([Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way)). What the bridge does when wacli isn't paired, the mailbox can't be reached or backups have no repository is in [Pairing](whatsapp.md#pairing), [The email reader](email.md#the-email-reader) and [When backups run](backups.md#when-backups-run); what `scooter status` says when the runner's files aren't there, in [scooter status](#scooter-status).

## Intake

Intake turns records into datastore lines, the same for every channel, in `intake.mjs`. It takes one record at a time, in the order they come, from the webhook and catch-up alike, so the two never race each other to the store.

- **Which line:**
  - A deletion becomes a `delete`, an edit an `edit` with the new text, and a reaction a `reaction`, each with the `seq` of the message it refers to as `target`. One whose target isn't a message in the datastore, of the lines this version knows ([Reading a line](datastore.md#reading-a-line)), is skipped, as having an unknown target.
  - Anything else becomes a `message`, with `trust: "owner"`, whatever its text: a text such as `/status` is a message like any other, which the agent is given. Scooter takes no commands by message; the owner asks the machine, with `scooter status` ([scooter status](#scooter-status)). A reply gets `replyTo`, the `seq` of the line whose `sourceId` it quotes when that is known.
  - **The record's `data`** goes on whatever line it becomes, as it is, and is left out when it holds nothing. Intake doesn't look into it.
- **Duplicates** are the store's to skip ([Rules](datastore.md#rules)). A message whose ID is stored is skipped before its attachments are downloaded again: catch-up lists the same rows again and again.
- **Attachments.** Each is downloaded with the channel's `download` into `bridge/incoming/`, handed to the store, which copies it into the day folder, and then removed. One that can't be stored leaves a `media` object on the line, from `MEDIA_ERRORS` in `intake.mjs`:
  - `too large, not downloaded`, when the channel gives its size as over `ATTACHMENT_MAX_BYTES`, or the download is refused as too large (`EFBIG`), which isn't tried again;
  - the record's own `error`, for media that isn't a file;
  - `download failed`, after `MEDIA_DOWNLOAD_RETRIES` more tries, `MEDIA_DOWNLOAD_RETRY_WAIT` apart. *Why:* a download that fails for good leaves the message without its attachment for ever, and an immediate retry would meet the same reconnecting wacli;
  - `could not be stored`, when the store couldn't copy it, and the message is stored without its files.
- **A channel that keeps its messages until they are stored** (`keepsUntilStored`), as email's spool does, is the exception: a failure on the bridge's side, any failure to copy a file into the day folder among them, stores nothing of the message, and the channel hands it over again later, files and all. A failure that isn't the bridge's, from such a channel, isn't tried again ([The spool, the bridge's side](email.md#the-spool-the-bridges-side)).
- **A stop.** A download that its channel's stop cut short, with the code `ESTOPPED`, isn't tried again, and its message isn't stored as `download failed`: it is left, logged as skipped, for the channel to hand over again. From then on intake stores nothing of that channel, and leaves every record it takes from it, until the bridge says the channel starts again (`intake.started`), which it does before it starts a channel it stopped. That takes its turn after the records intake was handed before it, so those are still left. *Why:* WhatsApp's catch-up brings back what was left, in order, as long as nothing of the channel after it is stored ([Catch-up](whatsapp.md#catch-up)); a message stored after the one left would move catch-up past it. *Cost:* a message whose download a stop cut short, and those after it, are stored only when catch-up lists them, a few seconds after the channel starts again.
- **Handed again.** A record intake didn't store, and that its channel must hand over again, is said so, with `again: true`: one a stop left, one that failed for a reason of the bridge's, such as a bug, and one the store stopped for.
- **A failed store** stops intake and the bridge ([Writing](datastore.md#writing)).

Intake also keeps the time of the newest incoming line of each channel.

## scooter status

`scooter status`, a CLI command of the bridge's side ([The CLI](configuration.md#the-cli)), prints how Scooter is doing, in lines built by `status.mjs`: natively `sudo scooter status`, and in Docker `docker compose run --rm bridge status`. Times are in `SCOOTER_TZ`, as the agent's prompt shows them (`shortLocalTime`).

- whether the bridge is started, since when, and when it last wrote `bridge/status/status.json`, or when it stopped;
- each channel's `status()`, as the bridge last wrote it ([Pairing](whatsapp.md#pairing), [What scooter status says of email](email.md#what-scooter-status-says-of-email));
- the newest message the owner sent, by `seq`, time and channel, of the lines this version knows ([Reading a line](datastore.md#reading-a-line));
- from the runner's `status.json`: when the runner started, KVM or emulation, when the VM image was built, whether zero data retention and the agent's internet access are on, and, while the runner waits before it goes on after stopping on an error, until when and why;
- from the network log, over `STATUS_WINDOW`: the requests, the hosts they went to, and the requests refused, those a run only counted in an `unlogged` line among them;
- for each agent `status.json` names, from its `state.json`: its last run, with its result, what it held and how long it took; whether runs are paused, since when, why and the next try; the messages pending, retrying and failed, pending being the work items after its cursor from the channels its triggers name (`channels` in `status.json`), but a message already deleted, which the runner never gives; as for the runner, a line this version doesn't know is never one ([The batch](runner.md#the-batch));
- each job of `scooter backfill`, oldest first, from its file in the jobs' folder of an agent's folder, of any agent's, one given in a file among them ([The job's file](backfill.md#the-jobs-file)): waiting to start, a job the runner refused among them, which only the log says ([Taking a job](backfill.md#taking-a-job)), or how far it has got, `at #1203 of #1890`, with the lines given, given up on and to be tried again, whether live runs wait for it, and whether it waits after a setup error or an outage of its own, since when, why and the next try ([Its batches](backfill.md#its-batches)); or that its file can't be read, or isn't named as a job's is;
- the backups, as the bridge last wrote them ([What the bridge keeps of a backup](backups.md#what-the-bridge-keeps-of-a-backup)).

**It reads only files**, so it works with the bridge stopped: `bridge/status/status.json`, the datastore, and four kinds of the runner's files, since a command of the bridge's side reads neither the runner's env file nor `config/` ([Secrets](../ARCHITECTURE.md#secrets), [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners)): `status.json`, each agent's `state.json`, the jobs' files, and the network log ([The contracts](../ARCHITECTURE.md#the-contracts)). It reports what it can read. Before the bridge has written its status, and before the runner has ever started, it says so, with nothing to say of the channels and the backups, or of the agent. A file that can't be read is said to be so, with the reason's code, and the rest is reported. The agents' names it makes paths of are checked as [status.json](runner.md#statusjson) says. A datastore that can't be read is said to be so, where the error says, in words that quote no line, and the pending messages aren't counted.

**It changes nothing.** It takes no lock and no socket, and writes no file: it reads the datastore as the runner does, leaving part of a line a crash left where it is ([Reading](datastore.md#reading)). So it runs while the bridge runs, while a backup runs, and beside a second copy of itself. It takes no arguments, exits with 2 when given any, and with 0 once it has printed, whatever it could read.

**The runner's files.** Natively it runs as root, and the runner's user writes the runner's files, so it reads them as files that user controls: `status.json` and `state.json` with `readUntrustedFile`, up to `STATUS_FILE_MAX_BYTES`, a job's file so too, up to `JOB_FILE_MAX_BYTES` (`readJob`), and each day of the network log opened without following a link and without waiting on a FIFO, and read only if it is a regular file. One that isn't is unreadable, with the code `EUNTRUSTED`. The agent's folder and the network log's are used only while each is a folder and not a link (`checkOwnFolder`); one that isn't is unreadable the same way. So are `agents/`, each agent's folder and its `jobs/` when it looks for jobs: a name in `agents/` that no agent could have, such as `.discarded`, is passed over, and so is an agent's folder or its `jobs/` that is a link or a file, or can't be read, with no job in it; `agents/` itself a link makes the jobs unreadable. *Why:* root reads them: a FIFO in place of `status.json` would keep the command waiting for good, a link in its place would have root read what it leads to, and a link in place of the agent's folder, or the log's, the files of those names wherever it led. *Cost, accepted:* as in [Folders other users control](../ARCHITECTURE.md#folders-other-users-control), the runner's user can swap a link in between the check of a folder and the read of a file in it; what that reaches is a file with the name `state.json` or `<ID>.json`, read only if it is a regular file with one name, or a day of the log, read only if it is a regular file, and each is shown only once it passes the check of an agent's state, of a job's file, or of the log's lines. A day of the log is read without a check of how many names it has: a hard link there to a file the runner's user can't read and write is one Linux refuses to make while `fs.protected_hardlinks` is 1, and only lines in the log's format would be counted, never shown. A day of the log as large as the disk allows, or sparse, is read whole, in bounded memory, for as long as that takes: the command waits, and Ctrl-C ends it. The agents `status.json` names are bounded only by `STATUS_FILE_MAX_BYTES`, and the report has a part for each.

**What it prints.** Every control character in the report, a line break among them, every format character, such as the marks that turn text right to left, and the line and paragraph separators (`\p{Cc}`, `\p{Cf}`, `\p{Zl}` and `\p{Zp}`), are printed as U+FFFD. *Why:* the reasons the runner records, the names in the jobs' folders and restic's words reach root's terminal, and a terminal acts on what some control characters say; a line break in a reason could also pass for a line of the report, and a mark that turns text right to left could show the rest of a line reversed. *Cost:* a joiner inside an emoji is one of them, so such an emoji in a reason shows in pieces.

**No secret** is in the report or in `bridge/status/status.json`: the bridge's lines are fixed words, counts, times, a snapshot's ID and the reason a backup failed, in restic's words with the backup's secrets hidden ([Running restic](backups.md#running-restic)); the runner's part is numbers, times, which accelerator runs the VMs and which settings are on, and the reasons the runner recorded, in its own words, OpenRouter's or the network policy's, or with a name pi chose, and pi holds no secret ([Secrets](../ARCHITECTURE.md#secrets)).

### The bridge's status.json

The running bridge writes what only it knows, each channel's line and the backups' line, to `bridge/status/status.json`, atomically, mode 0600, in a folder of its own in the bridge's, `bridge/status/`, 0700, which it makes if it is missing:

```json
{"startedAt":"2026-11-09T06:00:00Z","writtenAt":"2026-11-09T15:50:12Z","stoppedAt":null,"channels":{"whatsapp":"WhatsApp: linked"},"backups":"Backups: last 03:30, snapshot 1a2b3c4d. Next Tue 10 Nov 03:30."}
```

- **When:** at its start; then every `POLL_INTERVAL` it renders the lines, and writes the file when they differ from what it last wrote; and once more when it stops, with `stoppedAt`. *Why on a poll:* a line changes on events in the channels and the backups, and also with the clock, as the counts of the last 24 hours and a time shown against a new day do, and polling is how the services notice change ([Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way)).
- **The lines are rendered at `writtenAt`,** with times against that instant, in `SCOOTER_TZ`. While the bridge runs, they are what it rendered at most `POLL_INTERVAL` ago, though `writtenAt` is when they last changed; once it has stopped, the report says when, and they are from then.
- **A stop or a crash between a change and the write** leaves the last file, which says when it was written; a crash leaves `stoppedAt` null. The report says when the bridge last wrote, and the logs, or the service manager, say whether it runs. A write that fails, as on a full disk, is logged once (`bridge.status_not_written`), and tried again at the next look. Lines that can't be rendered, which nothing is known to cause, are logged once too (`bridge.status_not_rendered`), and nothing is written until they can, but at the stop, which writes the lines last rendered, saying it stopped.
- **Backups leave it out**, as its folder, `bridge/status/` ([What a backup holds](backups.md#what-a-backup-holds)): it is written while a backup runs, so that the report shows the backup, and it says how the bridge that wrote it was doing, which a restore can't bring back. *Why a folder of its own:* each write makes a temporary file beside the file, and renames it into place; in `bridge/`, which the backup holds, restic could meet that file, and back it up, or find it gone before it read it.
- Its format, and the check every reader and writer applies, are `checkBridgeStatus` in `status.mjs`; only `scooter status` reads it.

### No notice when the runner is down

Neither service tells the owner on WhatsApp that the other is down. The owner, on 2026-11-21: "this is a service monitoring problem. Whatsapp is a potential channel to communicate outages, but I wouldn't want to make that decision right now." Until it is decided, the logs of both services, or the service manager, say whether each runs. `scooter status` doesn't say that the runner is down: it prints for a runner that stopped what it prints for one that runs, and shows the outage only in what follows from it, the messages pending and the time of the last run, and in the wait after a stop on an error where the runner keeps that wait itself. *Why:* `runner/status.json` is written at a start, and nothing in it says the runner has stopped; and the command reads only files.

## The bridge's state

`bridge/state.json` is the bridge's alone: written atomically, mode 0600, in its own folder. It is made at the very first start. A file there that isn't a state stops the bridge, naming the file: it is written atomically, so a crash doesn't leave one.

| Field | What it holds, and where its rules are |
|---|---|
| `firstStart` | When the bridge first started; never changed ([Catch-up](whatsapp.md#catch-up)) |
| `ownerChat` | `{ jid, at }`: the chat of the owner's newest WhatsApp message, and its time ([Owner matching](whatsapp.md#owner-matching)) |
| `lastBackup` | `{ at, ok, snapshot, reason }` ([What the bridge keeps of a backup](backups.md#what-the-bridge-keeps-of-a-backup)) |
| `catchUp` | Where WhatsApp's catch-up has got to in each of the owner's chats ([Catch-up](whatsapp.md#catch-up)) |
