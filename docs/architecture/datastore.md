# The datastore

The datastore is Scooter's source of truth: every message in and out, appended and never changed. Everything else, the views, the memory, the sessions and the runner's state, is derived from it and can be rebuilt ([Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way)). This document covers its layout, the format of a line, how lines are written, and how they are read back.

The bridge is its one writer, through the store. Two read it: the runner, and pi through a read-only mount. It is the interface from the bridge to the runner, but not a queue: it holds no reader's position. The runner keeps its own, in its `state.json` ([State](runner.md#state)).

Who owns its folders, and their modes, is in [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners).

## Files

- `src/bridge/store.mjs`: the store, the only writer.
- `src/common/datastore/line.mjs`: the line format and its two checks, the store's `checkLine` and a reader's `checkReadLine`; which lines this version knows, `isKnown`; and reading `data`, `dataText` and `dataFlag`.
- `src/common/datastore/index.mjs`: the index the bridge and the runner each keep.
- `src/common/datastore/reader.mjs`: reading the lines back, by polling.

## Layout

```
datastore/
  2026/11/09/
    log.jsonl      one JSON object per line, in the order the bridge wrote them
    1042.jpg       attachments: <seq>.<ext>, and <seq>-2.<ext>, <seq>-3.<ext>… for further files of the same message
```

- A day folder is the **arrival date** in UTC: the day the bridge wrote the line. The message's own time is in `at`. The two differ only for a message that arrives late, such as one caught up after downtime.
- Folder dates never go backwards. If the clock reads earlier than the newest folder's date, the line goes in the newest folder. So the files, read in date order, give the lines in `seq` order, and each attachment sits beside its line.
- Folders are only storage. The agent dates what it files by the owner's day, so a row may be dated a day before or after the folder its message is in.
- The store is never told the owner's time zone: a day folder is the UTC date of its clock.

## The line format

A line is checked one way when it is written and another when it is read, both in `line.mjs`:

- **The store's check**, `checkLine`, is the table below as code. The store checks every line before it writes it, and writes nothing else ([Writing](#writing)).
- **A reader's check**, `checkReadLine`, holds a line only to what every reader depends on ([Reading a line](#reading-a-line)). The bridge's store, the runner and `scooter status` read by it.

*Why two:* one strict check served the writer and the readers, so a kind or a channel taken out of the code would have made every old line of it a damaged datastore, which stops both services, and every field taken out would have done the same.

**The rule from here on:** stop writing a kind, a channel or a field, and keep reading it. A kind or a channel this version stops writing goes from the store's check, and a reader passes its lines over; a field goes from the store's check, and a reader ignores it. *Why:* the datastore is kept for good ([What Scooter does](../ARCHITECTURE.md#what-scooter-does)), and the lines a version wrote stay in it after the next version has stopped writing them.

| Field | Type | Present | Meaning |
|---|---|---|---|
| `seq` | integer | always | The message's permanent number. Starts at 1, goes up by 1, never reused |
| `kind` | string | always | `message`, `edit`, `delete` or `reaction` |
| `dir` | string | always | `in` (from a source) or `out` (sent by Scooter) |
| `at` | string | always | When it was sent: ISO 8601 in UTC (`Z`), to the second |
| `source` | string | always | The channel: `whatsapp` or `email` |
| `sourceId` | string | when the source has one | The channel's own ID: the WhatsApp message ID, or the email's `Message-ID` |
| `trust` | string | `dir: in` | `owner` (may give instructions) or `external` (data only; unused in v2) |
| `by` | string | `dir: out` | Who produced it: the agent's name, `runner` or `bridge` |
| `text` | string | `message`, `edit` | The text, a media caption, or an email's body. `""` if none |
| `files` | array | messages with stored attachments | `[{"path": "1042.jpg", "mime": "image/jpeg", "name": "receipt.jpg", "bytes": 482113}]`. `path` is a file name in the line's own day folder; `name` is the original file name, if the source gave one |
| `media` | object | media that couldn't be stored | `{"type": "image", "mime": "image/jpeg", "error": "download failed"}` |
| `replyTo` | integer | replies | `seq` of the quoted message |
| `target` | integer | `edit`, `delete`, `reaction` | `seq` of the message it refers to |
| `data` | object | when the channel, or delivery, keeps something of the line | What the channel keeps that only the agent reads ([data](#data)) |

The store's check goes both ways: a field the table doesn't have is refused, and so is a field on a kind of line the table doesn't give it to. `files`, `media` and `replyTo` are on messages only; `trust` only on `in` lines and `by` only on `out` lines; `replyTo` and `target` must be lower than the line's own `seq`. `data`, on a line of any kind, is an object of values JSON holds, which read back as they were written: no `undefined`, no number that isn't finite, no `-0`, which reads back as `0`, nothing but plain objects and lists, and no list with holes. It is left out rather than written empty. A line is written with its fields in one order, `FIELDS` in `line.mjs`, the order the examples below show.
*Why:* the line is a contract between the bridge, the runner and pi ([The contracts](../ARCHITECTURE.md#the-contracts)). A field in the wrong place is a bug in the writer, and it is cheapest to catch at the one place lines are written. *Cost:* adding a field means changing `line.mjs` first.

Examples:

```jsonl
{"seq":1042,"kind":"message","dir":"in","at":"2026-11-09T15:43:02Z","source":"whatsapp","sourceId":"3EB0A1B2C3D4E5F6A7B8","trust":"owner","text":"","files":[{"path":"1042.jpg","mime":"image/jpeg","bytes":482113}]}
{"seq":1043,"kind":"message","dir":"out","at":"2026-11-09T15:43:40Z","source":"whatsapp","sourceId":"3EB0FF01A2B3C4D5E6F7","by":"lifelog","replyTo":1042,"text":"Blue Tokai, ₹450 at 12:40: work or personal?"}
{"seq":1044,"kind":"message","dir":"in","at":"2026-11-09T15:50:11Z","source":"whatsapp","sourceId":"3EB0A1C9D8E7F6A5B4C3","trust":"owner","replyTo":1043,"text":"work","data":{"quoted":"Blue Tokai, ₹450 at 12:40: work or personal?"}}
{"seq":1045,"kind":"reaction","dir":"out","at":"2026-11-09T15:50:30Z","source":"whatsapp","sourceId":"3EB0FF02A3B4C5D6E7F8","by":"lifelog","target":1044,"data":{"emoji":"✅"}}
{"seq":1071,"kind":"message","dir":"in","at":"2026-11-09T16:12:40Z","source":"email","sourceId":"CAF3x9qR2-example@mail.gmail.com","trust":"owner","text":"Recording from today's call.","files":[{"path":"1071.eml","mime":"message/rfc822","bytes":19262388},{"path":"1071-2.m4a","mime":"audio/mp4","name":"Call with Sam.m4a","bytes":14206977}],"data":{"subject":"Call with Sam"}}
```

### data

`data` is a JSON object that only the agent reads. The channel's module owns what is in it and puts it in the record it hands over ([Channels](bridge.md#channels)); intake writes it on the line as it is, and the datastore doesn't look into it. A field is top-level when every channel's lines have it, or when Scooter's own code acts on it; any other goes in `data`. What the channels keep there now:

| In `data` | On | Kept by | Meaning |
|---|---|---|---|
| `subject` | an email's `message`, always | the email channel ([The record of an email](email.md#the-record-of-an-email)) | The email's subject. `""` if none |
| `quoted` | a WhatsApp `message` that quotes another, when wacli gives a preview of it | the WhatsApp channel ([From a message to a record](whatsapp.md#from-a-message-to-a-record)) | A short preview of the quoted message, useful when it predates the datastore |
| `forwarded` | a WhatsApp `message`, when true | the WhatsApp channel | `true`: the message was forwarded, so it's someone else's words |
| `emoji` | a `reaction` | the WhatsApp channel for the owner's, delivery for Scooter's ([`out` lines](delivery.md#out-lines)) | The reaction; `""` means it was removed |

*Why these four:* none is on every channel's lines, email having no reactions, and Scooter's code acts on none of them. The owner, on 2026-11-21: "I think `emoji` can move into `data` since it's very text messenger channel specific. Email does not have emoji." Three things of the runner's and the bridge's show one: the agent's prompt ([The prompt](runner.md#the-prompt)), the `✅ Email:` text ([Choosing the channel](delivery.md#choosing-the-channel)) and the notice about a message given up on ([Notices](run.md#notices)). *Why the rest stays top-level:* `text` and `files`, since the store names and copies the files, and tells a repeated edit from a new one by its text; `media`, since the notice about a message given up on reads it; and `trust` and `by`, since the core sets one or the other on every line of every channel.

**What reads `data` checks it first,** since neither check looks into it: `data` can be missing, a list or a string, and hold anything under any name, on a line written by hand or by another version. `dataText` gives what it holds under a name only when `data` is an object and that is a string, and `dataFlag` only `true`; anything else counts as not there, and nothing is taken from what an object inherits. So an email whose subject isn't a string shows as `email ""` in the prompt and as `✅ Email: (no subject)`, and a reaction without an emoji as `reacted to #1046`.

### Reading a line

`checkReadLine` holds a line to what every reader depends on, and to nothing else:

- `seq`, a whole number, 1 or more; that it is one more than the last is the index's to check ([The index](#the-index));
- `dir`, `in` or `out`;
- `at`, a UTC time to the second;
- `kind` and `source`, each a name: a lowercase letter, then lowercase letters, digits and hyphens. *Why:* a reader goes by them, compares them with its own, and logs them, and a name is safe to compare and to log as it is;
- the type of each field this version's code acts on, where the line has it: `sourceId` and `by`, strings that aren't empty; `replyTo` and `target`, a `seq` before the line's own; `text`, a string; `files`, a list of at least one file, each read by its `path`, a name in the line's own day folder, its `mime`, a string that isn't empty, and its `name`, a string where there is one; and `media`, an object whose `type` and `error` are strings that aren't empty and whose `mime` is a string where there is one.

A field it doesn't know is ignored, at the top level or in a file or `media`, and so is `trust`, which no code of this version reads, and everything in `data`. A complete line that isn't JSON, or fails the check, is damage ([Starting up](#starting-up), [Reading](#reading)).

**A line this version knows** (`isKnown`) is one of its kinds and channels, with the fields its kind needs: a message its `text`, an edit its `target` and `text`, a deletion and a reaction their `target`. Any other line is kept in the index by its `seq`, and passed over, as the runner passes over a line that isn't work ([The index](#the-index)):

- it is no message to edit, delete, react to or quote, and the store refuses a line that points at it as its target ([Writing](#writing));
- the runner gives it to the agent neither as work nor as context, and its cursor goes past it ([When the agent runs](runner.md#when-the-agent-runs));
- `scooter status` counts it neither as the newest message nor as one pending ([scooter status](bridge.md#scooter-status));
- a text that replies to it goes to its channel, or to `DEFAULT_CHANNEL` when that channel is gone, unquoted, and a reaction to it is dropped ([Choosing the channel](delivery.md#choosing-the-channel)).

pi still reads it in the datastore, as it reads every line. *Why passed over, and not refused:* a line an earlier version wrote, such as the `command` kind before `/status` was taken out, or a line of a channel taken out, would otherwise stop both services for good. *Why "the fields its kind needs":* the code acts on them, and a message without a text could be neither shown nor edited. *Cost:* a message passed over is filed by no run; its line stays, for the agent to read, and for a later version.

## Writing

The store is the only module that appends a line, stores an attachment or truncates a log. Every line, incoming and outgoing, goes through its one queue, so `seq` order is the order of the lines in the files.
*Why:* with one writer, recovery after a crash is truncating an incomplete last line.

- **For each line:** take the next `seq`; copy any attachments into the day folder under a temporary name and rename each to its final name; then append the line with a single `write` call followed by `fsync`.
- **`seq` and `files` are the store's to set.** The caller gives the line without them, and the attachments as files already downloaded, `{ path, mime, name }`. The store copies them and leaves the originals, which belong to whoever staged them.
- **An attachment that can't be copied** stores nothing and uses up no `seq`. What becomes of its message is intake's ([Intake](bridge.md#intake)).
- **Never rewrite or delete a line.** Edits, deletions and reactions are new lines that point at their target.
- **A target must be a message,** one this version knows ([Reading a line](#reading-a-line)). The store refuses an edit, a deletion or a reaction whose target is any other line.
- **Only what passes the store's check is written,** whatever a reader takes: a line of a kind, a channel or a field this version doesn't write is refused, as any line that isn't well formed is, and uses up no `seq`.
- **Owners and modes** are those of [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners), set explicitly on every folder and file the store makes, so the umask doesn't matter. The owner is given by whoever opens the store, as `{ uid, gid }`, and left alone without one ([Starting up](bridge.md#starting-up)).
- **A failed write stops the store.** If a line's `write` or `fsync` fails, the log may end in part of a line, which only a start removes. So the store refuses every later append until the bridge restarts.

## Starting up

At startup the store reads every `log.jsonl` in date order and rebuilds the index.

- **Part of a line at the very end** of the newest log is left by a crash, and removed. Nothing else is.
- **A damaged datastore stops the store,** which then changes nothing: a complete line that isn't JSON or fails a reader's check ([Reading a line](#reading-a-line)), a `seq` that isn't one more than the one before, or part of a line in a day that isn't the newest. The error names the file and the line, and quotes nothing. A line of a kind, a channel or a field this version doesn't know is no damage: it is kept, and passed over.
- **What a crash left in the newest day folder** is removed: unfinished copies, named `.tmp-…`, and attachments whose `seq` is past the last line's. An attachment left so would otherwise sit under the number of the next line, which may have none of its own.

## Rules

- **Duplicates.** A `message` whose `(source, sourceId)` is already in the index is skipped. The webhook and catch-up can both deliver the same event ([Catch-up](whatsapp.md#catch-up)), so the other kinds have rules too:
  - an `edit` carries the ID of the message it changes ([wacli's formats](whatsapp.md#waclis-formats)), so it is skipped when its text equals its target's current text;
  - a `delete` is skipped when its target is already deleted;
  - a `reaction` is skipped when its own `(source, sourceId)` is already stored.

  A line of a kind this version doesn't know holds its `(source, sourceId)` as a message does ([The index](#the-index)), so a message or a reaction that comes with that ID is skipped.

  An `out` line whose `sourceId` is taken is reported as a duplicate, for delivery to decide what to do ([`out` lines](delivery.md#out-lines)).
- **Attachment names:** `<seq>.<ext>` for a message's first file, and `<seq>-<n>.<ext>` for the `n`th. The extension is the original file name's, in lower case, if it is letters and digits and no longer than `ATTACHMENT_EXT_MAX_CHARS`; otherwise it comes from the MIME type, by a table in `store.mjs`; otherwise it is `bin`. A file with no MIME type is recorded as `application/octet-stream`.
- **What intake decides:** the size limit, which applies before a download, and what isn't stored at all both need to know the channel, so they are intake's and the channels' ([Intake](bridge.md#intake)).

## The index

The bridge and the runner each build the same index from the same lines, `createIndex` in `index.mjs`, and `scooter status` builds it too. It answers: which line has this `seq`, and in which day folder and at which line number of its log; which `seq` has this channel ID; and what a message says now, after its edits, and whether it was deleted.

- Every line that passes a reader's check is in it by its `seq`, a line this version doesn't know among them.
- Every line but an edit or a deletion is known by its own ID, a line of a kind this version doesn't know among them, and the first line with an ID keeps it. *Why that line too:* the `command` kind an earlier version wrote carried the ID of the WhatsApp message it was, and catch-up, listing that message again, would otherwise have it stored a second time, as a message.
- Edits and deletions are never looked up by ID. *Why:* an edit carries its message's ID, and one that took it over would send replies and reactions to the edit.
- What a message says now is kept only for a message this version knows, and changed only by an edit or a deletion it knows ([Reading a line](#reading-a-line)). For any other line, `current` says it isn't a message.
- It refuses a line whose `seq` isn't one more than the last, or whose day folder is before the newest.

## Reading

A reader, `createReader` in `reader.mjs`, starts at the first line and keeps its own place: the day folder, and how many bytes of that day's log it has taken. It takes every path from `paths.mjs`.

- Each line is checked by a reader's check, not the store's ([Reading a line](#reading-a-line)).
- A poll gives all of its new lines or none. A complete line that isn't JSON or fails the check makes it throw, naming the file and the line, and stay where it was before the poll. *Why:* a reader that gave half a poll's lines and then failed would have moved past lines nobody received.
- It takes only complete lines. Part of a line at the end is left for its next poll: either the rest arrives, or the store removes the part when it next starts.
- It never changes anything. The import rule that holds the store to being the only writer is in [The code's layers](../ARCHITECTURE.md#the-codes-layers).
