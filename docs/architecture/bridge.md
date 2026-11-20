# The bridge

The bridge is Scooter's only link to the owner, and the only writer of the datastore. It runs the channels' programs, turns what they receive into datastore lines, delivers the outbox, answers the bridge's commands, and makes the backups. This document covers its core: how it starts and stops, what it asks of a channel, intake, its commands and `/status`, and its state. Each channel, delivery and the backups have documents of their own: [the WhatsApp channel](whatsapp.md), [the email channel](email.md), [delivery](delivery.md) and [backups](backups.md).

Which user it runs as, what it can reach and which secrets it holds are in [The boundaries](../ARCHITECTURE.md#the-boundaries). It never talks to OpenRouter, runs or signals pi, or decides anything about a message's content beyond recognizing a command.

## Files

- `src/bridge/main.mjs`: `scooter bridge`: starting, stopping, and `SIGUSR1`.
- `src/bridge/channels/index.mjs`: what the core asks of a channel, and the record, with its check.
- `src/bridge/intake.mjs`: records to datastore lines, with their attachments.
- `src/bridge/commands.mjs`: the commands the bridge answers.
- `src/bridge/status.mjs`: the text of `/status`.
- `src/bridge/state.mjs`: the bridge's state, `bridge/state.json`.

## Channels

The bridge reaches the owner through channels: WhatsApp, which receives and sends, and email, which only receives. Each channel is one module in `src/bridge/channels/`, and only that module deals with its service. The rest of the bridge, the **core** (the store, intake, delivery, the commands and the backups), calls every channel through the same object, so another channel, such as Telegram, is one more module. Tests drive the core with a fake channel, `test/support/fake-channel.mjs`.

| Member | What it is |
|---|---|
| `name` | `whatsapp` or `email`: the `source` of the lines its records become |
| `takesCommands` | Whether a text from it can be a command |
| `keepsUntilStored` | Whether a message stays with the channel until intake has stored it, so that one the bridge can't store now, for a reason of its own such as a full disk, is handed over again later |
| `start(onRecord)` | Starts receiving, and calls `onRecord(record)` for each message from the owner, awaiting what it returns. The channel drops everything else itself |
| `stop()` | Stops receiving, for backups and shutdown |
| `download(record, n, path)` | Saves the record's `n`th attachment, counting from 1, at `path`, a file in a folder only the bridge can write. Rejects if it can't: with the code `EFBIG` when it is too large to store, and with `bridgeSide: true` when the copy failed on the bridge's side, such as on a full disk |
| `status()` | One line for `/status` |
| `canSend`, `canReact` | Whether it can send text, and react to a message |
| `ready()` | Whether it can send now |
| `sendText(text, quoteId, { signal })` | Sends `text`, quoting the message whose channel ID is `quoteId` when it isn't null, and resolves with the new message's channel ID, or null if the channel gave none. Rejects if it couldn't send. `signal` stops it, for a bridge that is stopping |
| `react(id, emoji, { signal })` | Reacts with `emoji` to the owner's message whose channel ID is `id`, and resolves as `sendText` does |

A **record** is a message in channel-neutral form, the same for every channel. `checkRecord` is its shape in code, and intake refuses, and logs, a record that fails it, which is a bug in its channel.

| Field | What it holds |
|---|---|
| `source` | The channel's name |
| `id` | The channel's own ID, which becomes `sourceId`. For an edit or a deletion, the ID of the message it changes |
| `at` | When it was sent, as a UTC time to the second, or null when the channel doesn't know, and then the time it arrived |
| `text` | Its text, or a media caption; `""` if none |
| `subject` | An email's subject, `""` if none; on email only |
| `attachments` | What it carries, each `{ type, mime, name, bytes, error }`: the kind of media, the MIME type, the original file name and the size when the channel knows them (else null), and `error` when the core must not try to download it, saying why (else null) |
| `replyToId`, `replyToPreview` | The ID of the message it quotes, and the channel's short text of it, or null |
| `reactionToId`, `reactionEmoji` | For a reaction, the ID of the message reacted to and the emoji, `""` for a removed reaction; both null otherwise |
| `edited`, `revoked`, `forwarded` | Whether it is an edit of `id`, a deletion of `id`, or someone else's words |

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
10. It starts the channels, answers the commands it hadn't answered, starts delivery, which first sends what was left from where a crash cut it short, and starts the backups' schedule.

A start that fails prints why and exits with 1, or with 2 when it can't start because of how it is configured: `DEFAULT_CHANNEL`, or `EMAIL_AUTHSERV_ID`.

**Stopping**, on `SIGTERM` or `SIGINT`: the backups, cutting short one in progress ([Results](backups.md#results)); then delivery, cutting short a send in progress, which goes out again at the next start; then the channels; then it waits for what intake was handed to be stored and the commands it brought to be answered, lets go of its socket, and exits with 0. A store that stops taking lines ([Writing](datastore.md#writing)) stops the bridge too, with 1, so its service manager starts it again. `SIGUSR1` asks for a backup ([When backups run](backups.md#when-backups-run)).

**What it needs.** Neither service needs the other ([Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way)). What the bridge does when wacli isn't paired, the mailbox can't be reached, the runner's files aren't there or backups have no repository is in [Pairing](whatsapp.md#pairing), [The email reader](email.md#the-email-reader), [/status](#status) and [When backups run](backups.md#when-backups-run).

## Intake

Intake turns records into datastore lines, the same for every channel, in `intake.mjs`. It takes one record at a time, in the order they come, from the webhook and catch-up alike, so the two never race each other to the store.

- **Which line:**
  - A deletion becomes a `delete`, an edit an `edit` with the new text, and a reaction a `reaction`, each with the `seq` of the message it refers to as `target`. One whose target isn't a message or a command in the datastore is skipped, as having an unknown target.
  - A record is a `command` when its channel takes commands, it has no attachments, and its trimmed text is exactly one of `COMMANDS`. The line's text is the trimmed command. A command that quotes a message is still a command, and its line has no `replyTo`, which only messages have; a forwarded command is a command too. An email is never a command.
  - Anything else becomes a `message`, with `trust: "owner"`. A reply gets `replyTo`, the `seq` of the message whose `sourceId` it quotes when that is known, and `quoted`, the channel's preview of it.
- **Duplicates** are the store's to skip ([Rules](datastore.md#rules)). A message whose ID is stored is skipped before its attachments are downloaded again: catch-up lists the same rows again and again.
- **Attachments.** Each is downloaded with the channel's `download` into `bridge/incoming/`, handed to the store, which copies it into the day folder, and then removed. One that can't be stored leaves a `media` object on the line, from `MEDIA_ERRORS` in `intake.mjs`:
  - `too large, not downloaded`, when the channel gives its size as over `ATTACHMENT_MAX_BYTES`, or the download is refused as too large (`EFBIG`), which isn't tried again;
  - the record's own `error`, for media that isn't a file;
  - `download failed`, after `MEDIA_DOWNLOAD_RETRIES` more tries, `MEDIA_DOWNLOAD_RETRY_WAIT` apart. *Why:* a download that fails for good leaves the message without its attachment for ever, and an immediate retry would meet the same reconnecting wacli;
  - `could not be stored`, when the store couldn't copy it, and the message is stored without its files.
- **A channel that keeps its messages until they are stored** (`keepsUntilStored`), as email's spool does, is the exception: a failure on the bridge's side, any failure to copy a file into the day folder among them, stores nothing of the message, and the channel hands it over again later, files and all. A failure that isn't the bridge's, from such a channel, isn't tried again ([The spool, the bridge's side](email.md#the-spool-the-bridges-side)).
- **A stop.** A download that its channel's stop cut short, with the code `ESTOPPED`, isn't tried again, and its message isn't stored as `download failed`: it is left, logged as skipped, for the channel to hand over again. From then on intake stores nothing of that channel, and leaves every record it takes from it, until the bridge says the channel starts again (`intake.started`), which it does before it starts a channel it stopped. That takes its turn after the records intake was handed before it, so those are still left. *Why:* WhatsApp's catch-up brings back what was left, in order, as long as nothing of the channel after it is stored ([Catch-up](whatsapp.md#catch-up)); a message stored after the one left would move catch-up past it. *Cost:* a message whose download a stop cut short, and those after it, are stored only when catch-up lists them, a few seconds after the channel starts again; a command among them is answered then.
- **Handed again.** A record intake didn't store, and that its channel must hand over again, is said so, with `again: true`: one a stop left, one that failed for a reason of the bridge's, such as a bug, and one the store stopped for.
- **A failed store** stops intake and the bridge ([Writing](datastore.md#writing)).

Intake also tells the bridge when it has stored a command, and keeps the time of the newest incoming line of each channel.

## Commands

Commands come only from WhatsApp. They're logged as `command` lines, and the runner never shows them to the agent ([the runner](runner.md) (not yet written)). *Why:* a command is an instruction to Scooter, not a message to file.

| Command | Handled by | Effect |
|---|---|---|
| `/status` | bridge | Replies with what [/status](#status) lists |
| `/backup` | bridge | Starts a backup, or joins the one in progress, and replies once it is over ([Asking for a backup](backups.md#asking-for-a-backup)) |
| `/help` | bridge | Lists the commands (`HELP_TEXT` in `commands.mjs`) |
| `/new` | runner | The runner's ([the runner](runner.md) (not yet written)). The bridge passes over it |

The bridge answers from the datastore, as the runner does with its own. Its state keeps `commandSeq`, the `seq` of the newest command line it has handled. When intake has stored a command, and once at startup, it handles every command line after `commandSeq`, one at a time: it writes the reply, `by: "bridge"` with `about` set to the command, so it goes back where the command came from, and then saves the state. `/new` only moves `commandSeq`.
*Why:* the datastore is the source of truth, and this answers each command once, also across a crash, at worst twice.

- A state written before the bridge handled commands has no `commandSeq`, and gets the newest line's `seq`, as does a state made at the first start: commands sent before are never answered late.
- A reply that can't be written, as on a full disk, is tried again after a wait that doubles, `SEND_RETRY_BACKOFF`, without waiting for another command. Stopping the bridge ends the wait.

## /status

`/status` replies with, for each part, one line or a few, built by `status.mjs`. Times are in `SCOOTER_TZ`, as the agent's prompt shows them (`shortLocalTime`).

- each channel's `status()` ([Pairing](whatsapp.md#pairing), [What /status says of email](email.md#what-status-says-of-email));
- the newest message the owner sent, by `seq`, time and channel;
- from the runner's `status.json`: when the runner started, KVM or emulation, when the VM image was built, whether zero data retention and the agent's internet access are on, and, while the runner waits before it goes on after stopping on an error, until when and why;
- from the network log, over `STATUS_WINDOW`: the requests, the hosts they went to, and the requests refused, those a run only counted in an `unlogged` line among them;
- for each agent `status.json` names, from its `state.json`: its last run, with its result, what it held and how long it took; whether runs are paused, since when, why and the next try; the messages pending, retrying and failed, pending being the work items after its cursor from the sources it reads (`reads` in `status.json`); and a backfill and how far it has got;
- the backups ([What the bridge keeps of a backup](backups.md#what-the-bridge-keeps-of-a-backup)).

What it says about the runner comes from three of the runner's files, since it reads neither the runner's env file nor `config/` ([Secrets](../ARCHITECTURE.md#secrets), [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners)): `status.json`, each agent's `state.json`, and the network log ([The contracts](../ARCHITECTURE.md#the-contracts)). It reports what it can read. Before the runner has ever started there is no `status.json`, and `/status` says so, with no agent to report on. A file that can't be read is said to be so, with the reason's code, and the rest is reported. The format of `status.json` refuses an agent's name `agents.yaml` wouldn't allow, because the bridge makes a path of it.

It reads them as files the runner's user controls: `status.json` and `state.json` with `readUntrustedFile`, up to `STATUS_FILE_MAX_BYTES`, and each day of the network log opened without following a link and without waiting on a FIFO, and read only if it is a regular file. One that isn't is unreadable, with the code `EUNTRUSTED`. *Why:* the bridge reads them as root; a FIFO in place of `status.json` kept `/status`, and the bridge's one thread, waiting.

## The bridge's state

`bridge/state.json` is the bridge's alone: written atomically, mode 0600, in its own folder. It is made at the very first start. A file there that isn't a state stops the bridge, naming the file: it is written atomically, so a crash doesn't leave one.

| Field | What it holds, and where its rules are |
|---|---|
| `firstStart` | When the bridge first started; never changed ([Catch-up](whatsapp.md#catch-up)) |
| `ownerChat` | `{ jid, at }`: the chat of the owner's newest WhatsApp message, and its time ([Owner matching](whatsapp.md#owner-matching)) |
| `lastBackup` | `{ at, ok, snapshot, reason }` ([What the bridge keeps of a backup](backups.md#what-the-bridge-keeps-of-a-backup)) |
| `commandSeq` | The newest command line handled ([Commands](#commands)) |
| `catchUp` | Where WhatsApp's catch-up has got to in each of the owner's chats ([Catch-up](whatsapp.md#catch-up)) |
