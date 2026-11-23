# The exchange

The exchange is the folder the two services coordinate through, `exchange/` in the data folder: `outbox/`, which carries messages to send from the runner to the bridge, and `locks/`, which keeps runs and backups apart. Who owns it, and who can reach it, is in [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners). This document covers the two contracts it holds, the outbox entry and the lock files, which both services follow. How the bridge sends an entry is [delivery](delivery.md). The runner writes one for each message `send` queued and each reaction to a line marked done ([What send and mark leave](run.md#what-send-and-mark-leave)), for a notice ([Notices](run.md#notices)) and for a backfill's message when its job has finished ([Finishing](backfill.md#finishing)).

## Files

- `src/common/outbox.mjs`: the outbox entry's format and its check, `checkOutboxEntry`, the cut of a long text, and writing an entry, `writeOutboxEntry`.
- `src/common/locks.mjs`: the lock files: taking, reading and releasing one.

## Outbox entries

- **An entry** is a folder `outbox/<id>/` holding `entry.json`. It is written as `outbox/.tmp-<id>/` and renamed once complete, so the bridge never sees half of one; if the name is taken, it takes the next ID ([Atomic files and hand-offs](shared-code.md#atomic-files-and-hand-offs)). IDs are the UTC time of its making and a counter, so entries sort in the order they were made: `20261109T155015123-0001`.
- **`entry.json`** is one of two types:
  ```json
  {"type": "text", "by": "lifelog", "text": "Blue Tokai, ₹450 at 12:40: work or personal?", "replyTo": 1042, "channels": ["whatsapp"]}
  {"type": "text", "by": "lifelog", "text": "Logged the run and the coffee.", "about": 1061, "channels": ["whatsapp"]}
  {"type": "text", "by": "runner", "text": "⚠️ I couldn't process your last messages (timeout). I'll try again."}
  {"type": "react", "by": "lifelog", "target": 1044, "emoji": "✅", "channels": ["whatsapp"]}
  ```
  - There is no recipient field: everything goes to the owner. An entry names messages only by `seq`, and never a channel: the bridge picks the channel from the line it points at ([Choosing the channel](delivery.md#choosing-the-channel)).
  - `replyTo` is the message a text answers, quoted.
  - `about` is the newest message a text answers, not quoted: the runner sets it on a message `send` queued without `--reply-to`, or with one that names no message.
  - A text with neither is something Scooter says on its own.
  - `by` is the agent's name, `runner` or `bridge`. `agents.yaml` keeps an agent from taking either of the last two ([agents.yaml](configuration.md#agentsyaml)).
  - `channels` is on an agent's entry, and only there: the channels its `sends` names, at least one, each once, on which alone the bridge sends it ([Choosing the channel](delivery.md#choosing-the-channel)). *Why the entry carries them:* the bridge chooses the channel, and doesn't read `agents.yaml`. *Why required:* an entry of the agent's without them, such as one a runner of before `sends` wrote, is refused, rather than sent on any channel. The runner's and the bridge's own entries carry none, and go out whatever an agent's `sends` says.
- **The check.** `checkOutboxEntry` is this format as code, strict, as `checkLine` is for the lines the store writes ([The line format](datastore.md#the-line-format)). `writeOutboxEntry` writes every entry through it, and the bridge checks every entry it reads.
- **A text is at most `TEXT_MAX_CHARS` characters**, a character being a Unicode code point, so an emoji counts once and is never split: four times `CHUNK_CHARS` ([Chunks](delivery.md#chunks)). `writeOutboxEntry` cuts a longer one, for the runner's entries and the bridge's alike, and ends it with `[The rest of this message was too long to send.]`; `checkOutboxEntry` refuses a longer one, so the bridge refuses an entry not written that way. *Why:* the agent's texts are its own to make as long as it likes, and one of a megabyte would take the bot's number half an hour to send. It is cut where it is written, not refused: a refusal would throw in the runner after a run that went well, and stop it. *Cost:* one run can still send `RUN_MAX_SENDS` texts of up to eight messages each.
- **U+0000** in a text is written as U+FFFD by the same cut, which also keeps a text of nothing else from being empty; `checkOutboxEntry` refuses a text or an emoji that holds one, so the bridge drops such an entry at once. *Why:* the channel's program takes the text as a command-line argument, and no program takes one with U+0000 in it: the send could never start, and the entry would hold the outbox back for all its tries.
- `writeOutboxEntry` makes the outbox folder, 0700, when it is missing, as in development, and takes the outbox to write to: the runner's, or the bridge's own ([The bridge's own entries](delivery.md#the-bridges-own-entries)).

## The locks

Two lock files in `locks/` keep runs and backups apart: `run.lock`, which the runner takes for each run, a job's batches among them, and for a job's start ([The start](backfill.md#the-start)); and `backup.lock`, which the bridge takes for each backup.

- **A lock** is one line of JSON: `{"pid":4211,"at":"2026-11-09T15:50:02Z","deadline":"2026-11-09T16:00:02Z"}`, the times in UTC to the second, `deadline` null when there is none. It is written under a temporary name and hard-linked into place. *Why:* a link fails if the name exists, which makes taking the lock exclusive, and the name appears with its contents complete, so nobody reads half a lock. A lock that can't be read still counts as held.
- **Each side takes its own lock first, and then looks for the other's.** *Why:* looking before taking would let a run and a backup start at the same instant. When the two appear together, the runner gives way: it releases `run.lock` and waits while `backup.lock` is there.
- **`run.lock` records when its work must be over**: the run's start plus the agent's timeout. The bridge waits for it to go. Past that time and `BACKUP_LOCK_EXTRA` more, the backup goes ahead, but only when nothing holds `runner/runner.sock`; while something does, it is a runner at work after its run, and the backup waits on, logging `backup.run_overdue` once. Only a socket counts, not a link to one. A `run.lock` whose time can't be read is past it.
  *Why:* every holder of `run.lock` holds the runner's socket for as long as it lives ([One service per data folder](shared-code.md#one-service-per-data-folder)), and the runner may keep `run.lock` past its time, while it packs its repository and cleans up after a run, with no time limit ([A run](run.md#a-run)). A lock a dead runner left can't hold backups back for good, since its socket no longer answers. The pid in `run.lock` would mean nothing in the bridge's container.
  *Cost:* a runner that hangs while it holds `run.lock` holds backups back, but not for good: each check leaves a connection in the socket's queue, which Node makes 511 long, so a holder that takes no connection for 512 checks, one every `POLL_INTERVAL`, answers no more, and the backup goes ahead. Nothing the runner does after a run blocks its thread that long. The runner's user could hold backups back anyway, with a `run.lock` whose time is far ahead.
- **Leftovers.** Each side removes its own leftover lock at its start: the bridge `backup.lock`, logged as `bridge.lock_removed`, since only the bridge takes it and only one bridge runs on a data folder; the runner `run.lock`. *Why:* a leftover `backup.lock` would stop the agent for good.
- **The bridge in the runner's folder.** `locks/` is a folder the runner's user controls, and the bridge takes and removes `backup.lock` and reads `run.lock` there by the rules of [Folders other users control](../ARCHITECTURE.md#folders-other-users-control): `run.lock` with `readUntrustedFile`, up to `STATUS_FILE_MAX_BYTES`, whoever owns it, as `scooter status` reads the runner's other files ([scooter status](bridge.md#scooter-status)).
- What a backup does once it holds `backup.lock`, and what the runner does while it waits, are in [Consistency](backups.md#consistency) and [The loop](runner.md#the-loop).
