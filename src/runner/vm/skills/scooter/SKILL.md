---
name: scooter
description: How to read the owner's messages in the datastore by their numbers, with the show command and the index file, and what each field of a line means. Use it whenever you need to see a message, what it replies to, or the message an edit, a deletion or a reaction is of.
---

# The datastore, and `show`

Every message the owner sends Scooter, and everything Scooter sends back, is one line of the datastore: a JSON object on a line of its own in a `log.jsonl`, in a folder for the UTC date the line was written, such as `datastore/2026/11/09/log.jsonl`, with its attachments beside it. Each line has a number, its `seq`, which never changes, and one `seq` counts across every channel and every day. Lines are only ever added: an edit, a deletion or a reaction is a line of its own, which points at the message it changes. The datastore is read-only to you.

The paths below are those of a data folder at `/data`; `show` and the index file give yours.

## show

`show <seq>…` prints each line with that number, one after another:

```text
$ show 1054
1054  Mon 9 Nov 2026 21:22  /data/datastore/2026/11/09/log.jsonl:216
{"seq":1054,"kind":"edit","dir":"in","at":"2026-11-09T15:52:00Z","source":"whatsapp","sourceId":"3EB0B7C6D5E4F3A2B1C0","trust":"owner","target":1051,"text":"coffee 150"}
  points at 1051  Mon 9 Nov 2026 21:14  /data/datastore/2026/11/09/log.jsonl:213
  {"seq":1051,"kind":"message","dir":"in","at":"2026-11-09T15:44:00Z","source":"whatsapp","sourceId":"3EB0B7C6D5E4F3A2B1C0","trust":"owner","text":"coffee 120"}
```

- The first line of each is its header: the `seq`, when it was sent in the owner's time zone, and where the line is, its log and its line number there.
- Then the line exactly as it is stored.
- Then each of its attachments, by its full path, as `  file /data/datastore/2026/11/09/1042.jpg`. Read it with your tools.
- Then, indented, the one line it points at, if it points at one: the message an edit, a deletion or a reaction is of (`target`), or the message it replies to (`replyTo`), in the same way.
- Only that one line. `show` doesn't print what the line it points at points at in turn, or anything that points at the line, such as its replies, the reactions to it, or its edits and its deletion: show those by their own numbers. A reply's own line can hold a short preview of what it quotes, in `data`.
- A number that isn't a line of this run prints `no such line`, and `show` fails. A line that arrived after your run started is one of these.

Several numbers print one after another, each after an empty line:

```text
$ show 1053 1043
1053  Mon 9 Nov 2026 21:20  /data/datastore/2026/11/09/log.jsonl:215
{"seq":1053,"kind":"message","dir":"in","at":"2026-11-09T15:50:00Z","source":"whatsapp","sourceId":"3EB0A1C9D8E7F6A5B4C3","trust":"owner","replyTo":1043,"text":"work","data":{"quoted":"Blue Tokai, ₹450 at 12:40: work or personal?"}}
  points at 1043  Mon 9 Nov 2026 12:43  /data/datastore/2026/11/09/log.jsonl:205
  {"seq":1043,"kind":"message","dir":"out","at":"2026-11-09T07:13:00Z","source":"whatsapp","sourceId":"3EB0FF01A2B3C4D5E6F7","by":"lifelog","replyTo":1042,"text":"Blue Tokai, ₹450 at 12:40: work or personal?"}

1043  Mon 9 Nov 2026 12:43  /data/datastore/2026/11/09/log.jsonl:205
{"seq":1043,"kind":"message","dir":"out","at":"2026-11-09T07:13:00Z","source":"whatsapp","sourceId":"3EB0FF01A2B3C4D5E6F7","by":"lifelog","replyTo":1042,"text":"Blue Tokai, ₹450 at 12:40: work or personal?"}
  points at 1042  Mon 9 Nov 2026 12:42  /data/datastore/2026/11/09/log.jsonl:204
  {"seq":1042,"kind":"message","dir":"in","at":"2026-11-09T07:12:00Z","source":"whatsapp","sourceId":"3EB0A1B2C3D4E5F6A7B8","trust":"owner","text":"","files":[{"path":"1042.jpg","mime":"image/jpeg","bytes":482113}]}
    file /data/datastore/2026/11/09/1042.jpg
```

```text
$ show 99999
99999  no such line
```

## The index file

`run/index.txt`, in your folder, is the index `show` reads: one line for each line of the datastore when your run started, in order, with where the line is, its kind, and the number of the line it points at, if any:

```text
1051 /data/datastore/2026/11/09/log.jsonl:213 message
1053 /data/datastore/2026/11/09/log.jsonl:215 message 1043
1054 /data/datastore/2026/11/09/log.jsonl:216 edit 1051
```

So `grep ' edit 1051$' run/index.txt` finds the edits of 1051, and `grep ' 1051$' run/index.txt` every line that points at it.

## The format of a line

A line holds these fields, in this order, each only where the table says:

| Field | Holds |
|---|---|
| `seq` | The line's number |
| `kind` | `message`, `edit`, `delete` or `reaction` |
| `dir` | `in`, from the owner, or `out`, sent by Scooter |
| `at` | When it was sent, in UTC, to the second: `2026-11-09T15:43:02Z`. `show`'s header gives it in the owner's time zone |
| `source` | The channel: `whatsapp` or `email` |
| `sourceId` | The channel's own ID for it, when the channel has one |
| `trust` | On an `in` line: `owner`, the owner's own words, or `external`, data that isn't |
| `by` | On an `out` line: who sent it, an agent by its name, or `runner` or `bridge` for Scooter's own messages, such as a notice |
| `replyTo` | On a message that replies to another: that message's `seq` |
| `target` | On an edit, a deletion or a reaction: the `seq` of the message it is of |
| `text` | On a message and an edit: the text, a caption or an email's body, `""` if none. An edit's is the message's whole new text |
| `files` | On a message with attachments: each `{"path", "mime", "name", "bytes"}`, `path` a file in the line's own folder, and `name` the file's own name, when the channel gave one. An email's first file is the whole email, `.eml` |
| `media` | On a message whose media couldn't be stored: `{"type", "mime", "error"}` |
| `data` | What the channel keeps of the line: `subject`, an email's subject; `quoted`, a short preview of the message a WhatsApp message quotes; `forwarded`, `true` when it was forwarded, so the words are someone else's; `emoji`, a reaction's, `""` when it was taken back |

The datastore can also hold a line of another kind or channel, or with other fields, which an earlier version of Scooter wrote. `show` prints it as it is stored.
