# The datastore

The datastore is Scooter's source of truth: every message in and out, appended and never changed. Everything else, the views, the memory, the sessions and the runner's state, is derived from it and can be rebuilt ([Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way)). This document covers its layout, the format of a line, how lines are written, and how they are read back.

The bridge is its one writer, through the store. Two read it: the runner, and pi through a read-only mount. It is the interface from the bridge to the runner, but not a queue: it holds no reader's position. The runner keeps its own, in its `state.json` ([State](runner.md#state)).

Who owns its folders, and their modes, is in [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners).

## Files

- `src/bridge/store.mjs`: the store, the only writer.
- `src/common/datastore/line.mjs`: the line format and its check, `checkLine`, and the four commands, `COMMANDS`.
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
- Folders are only storage. The agent dates what it files by the owner's day, so a day page may link to attachments in the folder before or after its date.
- The store is never told the owner's time zone: a day folder is the UTC date of its clock.

## The line format

`checkLine` in `line.mjs` is this table as code. The store checks every line before it writes it, and every reader checks every line it reads.

| Field | Type | Present | Meaning |
|---|---|---|---|
| `seq` | integer | always | The message's permanent number. Starts at 1, goes up by 1, never reused |
| `kind` | string | always | `message`, `edit`, `delete`, `reaction` or `command` |
| `dir` | string | always | `in` (from a source) or `out` (sent by Scooter) |
| `at` | string | always | When it was sent: ISO 8601 in UTC (`Z`), to the second |
| `source` | string | always | The channel: `whatsapp` or `email` |
| `sourceId` | string | when the source has one | The channel's own ID: the WhatsApp message ID, or the email's `Message-ID` |
| `trust` | string | `dir: in` | `owner` (may give instructions) or `external` (data only; unused in v2) |
| `by` | string | `dir: out` | Who produced it: the agent's name, `runner` or `bridge` |
| `text` | string | `message`, `edit`, `command` | The text, a media caption, or an email's body. `""` if none. On a `command`, one of `COMMANDS` |
| `subject` | string | an email's `message` | The email's subject. `""` if none |
| `files` | array | messages with stored attachments | `[{"path": "1042.jpg", "mime": "image/jpeg", "name": "receipt.jpg", "bytes": 482113}]`. `path` is a file name in the line's own day folder; `name` is the original file name, if the source gave one |
| `media` | object | media that couldn't be stored | `{"type": "image", "mime": "image/jpeg", "error": "download failed"}` |
| `replyTo` | integer | replies | `seq` of the quoted message |
| `quoted` | string | when the source gives it | A short preview of the quoted message, useful when it predates the datastore |
| `forwarded` | boolean | when true | The message was forwarded, so it's someone else's words |
| `target` | integer | `edit`, `delete`, `reaction` | `seq` of the message it refers to |
| `emoji` | string | `reaction` | The reaction; `""` means it was removed |

The check goes both ways: a field the table doesn't have is refused, and so is a field on a kind of line the table doesn't give it to. `files`, `media`, `replyTo`, `quoted` and `forwarded` are on messages only; `trust` only on `in` lines and `by` only on `out` lines; `replyTo` and `target` must be lower than the line's own `seq`. A line is written with its fields in one order, `FIELDS` in `line.mjs`, the order the examples below show.
*Why:* the line is a contract between the bridge, the runner and pi ([The contracts](../ARCHITECTURE.md#the-contracts)). A field in the wrong place is a bug in the writer, and it is cheapest to catch at the one place lines are written. *Cost:* adding a field means changing `line.mjs` first.

Examples:

```jsonl
{"seq":1042,"kind":"message","dir":"in","at":"2026-11-09T15:43:02Z","source":"whatsapp","sourceId":"3EB0A1B2C3D4E5F6A7B8","trust":"owner","text":"","files":[{"path":"1042.jpg","mime":"image/jpeg","bytes":482113}]}
{"seq":1043,"kind":"message","dir":"out","at":"2026-11-09T15:43:40Z","source":"whatsapp","sourceId":"3EB0FF01A2B3C4D5E6F7","by":"lifelog","replyTo":1042,"text":"Blue Tokai, ₹450 at 12:40: work or personal?"}
{"seq":1044,"kind":"message","dir":"in","at":"2026-11-09T15:50:11Z","source":"whatsapp","sourceId":"3EB0A1C9D8E7F6A5B4C3","trust":"owner","replyTo":1043,"quoted":"Blue Tokai, ₹450 at 12:40: work or personal?","text":"work"}
{"seq":1045,"kind":"reaction","dir":"out","at":"2026-11-09T15:50:30Z","source":"whatsapp","sourceId":"3EB0FF02A3B4C5D6E7F8","by":"lifelog","target":1044,"emoji":"✅"}
{"seq":1071,"kind":"message","dir":"in","at":"2026-11-09T16:12:40Z","source":"email","sourceId":"CAF3x9qR2-example@mail.gmail.com","trust":"owner","subject":"Call with Sam","text":"Recording from today's call.","files":[{"path":"1071.eml","mime":"message/rfc822","bytes":19262388},{"path":"1071-2.m4a","mime":"audio/mp4","name":"Call with Sam.m4a","bytes":14206977}]}
```

## Writing

The store is the only module that appends a line, stores an attachment or truncates a log. Every line, incoming and outgoing, goes through its one queue, so `seq` order is the order of the lines in the files.
*Why:* with one writer, recovery after a crash is truncating an incomplete last line.

- **For each line:** take the next `seq`; copy any attachments into the day folder under a temporary name and rename each to its final name; then append the line with a single `write` call followed by `fsync`.
- **`seq` and `files` are the store's to set.** The caller gives the line without them, and the attachments as files already downloaded, `{ path, mime, name }`. The store copies them and leaves the originals, which belong to whoever staged them.
- **An attachment that can't be copied** stores nothing and uses up no `seq`. What becomes of its message is intake's ([Intake](bridge.md#intake)).
- **Never rewrite or delete a line.** Edits, deletions and reactions are new lines that point at their target.
- **A target must be a message or a command.** The store refuses an edit, a deletion or a reaction whose target is any other kind of line.
- **Owners and modes** are those of [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners), set explicitly on every folder and file the store makes, so the umask doesn't matter. The owner is given by whoever opens the store, as `{ uid, gid }`, and left alone without one ([Starting up](bridge.md#starting-up)).
- **A failed write stops the store.** If a line's `write` or `fsync` fails, the log may end in part of a line, which only a start removes. So the store refuses every later append until the bridge restarts.

## Starting up

At startup the store reads every `log.jsonl` in date order and rebuilds the index.

- **Part of a line at the very end** of the newest log is left by a crash, and removed. Nothing else is.
- **A damaged datastore stops the store,** which then changes nothing: a complete line that isn't a line, a `seq` that isn't one more than the one before, or part of a line in a day that isn't the newest. The error names the file and the line, and quotes nothing.
- **What a crash left in the newest day folder** is removed: unfinished copies, named `.tmp-…`, and attachments whose `seq` is past the last line's. An attachment left so would otherwise sit under the number of the next line, which may have none of its own.

## Rules

- **Duplicates.** A `message` or a `command` whose `(source, sourceId)` is already in the index is skipped. The webhook and catch-up can both deliver the same event ([Catch-up](whatsapp.md#catch-up)), so the other kinds have rules too:
  - an `edit` carries the ID of the message it changes ([wacli's formats](whatsapp.md#waclis-formats)), so it is skipped when its text equals its target's current text;
  - a `delete` is skipped when its target is already deleted;
  - a `reaction` is skipped when its own `(source, sourceId)` is already stored.

  An `out` line whose `sourceId` is taken is reported as a duplicate, for delivery to decide what to do ([`out` lines](delivery.md#out-lines)).
- **Attachment names:** `<seq>.<ext>` for a message's first file, and `<seq>-<n>.<ext>` for the `n`th. The extension is the original file name's, in lower case, if it is letters and digits and no longer than `ATTACHMENT_EXT_MAX_CHARS`; otherwise it comes from the MIME type, by a table in `store.mjs`; otherwise it is `bin`. A file with no MIME type is recorded as `application/octet-stream`.
- **What intake decides:** the size limit, which applies before a download, and what isn't stored at all both need to know the channel, so they are intake's and the channels' ([Intake](bridge.md#intake)).

## The index

The bridge and the runner each build the same index from the same lines, `createIndex` in `index.mjs`. It answers: which line has this `seq`, and in which day folder and at which line number of its log; which `seq` has this channel ID; and what a message or a command says now, after its edits, and whether it was deleted. It also keeps the `seq` of every command.

- Messages, commands and reactions are known by their own ID, and the first line with an ID keeps it.
- Edits and deletions are never looked up by ID. *Why:* an edit carries its message's ID, and one that took it over would send replies and reactions to the edit.
- It refuses a line whose `seq` isn't one more than the last, or whose day folder is before the newest.

## Reading

A reader, `createReader` in `reader.mjs`, starts at the first line and keeps its own place: the day folder, and how many bytes of that day's log it has taken. It takes every path from `paths.mjs`.

- A poll gives all of its new lines or none. A complete line that isn't a line makes it throw, naming the file and the line, and stay where it was before the poll. *Why:* a reader that gave half a poll's lines and then failed would have moved past lines nobody received.
- It takes only complete lines. Part of a line at the end is left for its next poll: either the rest arrives, or the store removes the part when it next starts.
- It never changes anything. The import rule that holds the store to being the only writer is in [The code's layers](../ARCHITECTURE.md#the-codes-layers).
