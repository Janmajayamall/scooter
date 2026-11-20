# The email channel

The owner can also email Scooter: a forwarded booking or invoice, or a file such as a voice memo, perhaps announced in a WhatsApp message ("I've emailed you the recording"). Email only comes in ([The owner's fixed choices](../ARCHITECTURE.md#the-owners-fixed-choices)): the channel can't send or react, and replies about an email go to `DEFAULT_CHANNEL` ([Choosing the channel](delivery.md#choosing-the-channel)). An email is never a command, an edit, a deletion or a reaction.

The channel has two halves. The **email reader**, a program of its own run as `scooter-mail`, reads the mailbox and hands each email over as a folder in its **spool**. The **email module** of [the bridge](bridge.md#channels) supervises the reader, takes the spool's folders, applies the **sender check**, and hands each email to the core as a record. The reader is the only part of Scooter that uses `imapflow` and `postal-mime`, so their code never runs in the bridge's process.

## Files

- `src/bridge/channels/email.mjs`: the email module: the reader's environment and supervision, the spool's consumer and its checks, the sender check, the record, the skip log and its counts, `status()`, and `scooter email-check`.
- `src/mail/reader.mjs`: the email reader, `node src/mail/reader.mjs run`, and its `newest` mode for `email-check`.
- `src/mail/imap.mjs`: the mailbox adapter over `imapflow`.
- `src/mail/parse.mjs`: parsing with `postal-mime`, HTML to text, and the reader's loose check of `From`.
- `src/mail/spool.mjs`: writing the spool, and the reader's position file.

## Settings

In `bridge.env`. Email is on when `EMAIL_IMAP_HOST` is set; off, the other mailbox variables aren't looked at.

| Variable | Default | Read by | Meaning |
|---|---|---|---|
| `EMAIL_IMAP_HOST` | empty | email reader | The Scooter mailbox's IMAP server, such as `imap.gmail.com`. Empty turns email off |
| `EMAIL_IMAP_PORT` | `993` | email reader | IMAP over TLS |
| `EMAIL_USER`, `EMAIL_PASSWORD` | required for email | email reader | The mailbox's address, and an app password for it |
| `EMAIL_OWNER_ADDRESSES` | required for email | both | The owner's addresses, comma-separated; mail from any other address is skipped |
| `EMAIL_AUTHSERV_ID` | required by the bridge for email | the bridge | The server name the mailbox's provider writes in `Authentication-Results`, such as `mx.google.com` |
| `EMAIL_CHECK_SECONDS` | `60` | email reader | The longest the reader goes between looks, even with IDLE |

`EMAIL_AUTHSERV_ID` isn't required by the settings, so `email-check` runs without it, to help find it. The bridge refuses to start with email on and without it, says to run `email-check`, and exits with 2.

## The mailbox

An address used only by Scooter, at a provider that allows IMAP with an app password, such as Gmail, iCloud or Fastmail. Never the owner's own mailbox, or the bridge would see all their mail. *Cost:* the provider keeps the emails sent to Scooter; and anyone who controls the owner's email account can give Scooter instructions, as with their WhatsApp.

## The email reader

- **Started** by the email module as `scooter-mail`, as `node --disable-sigusr1 src/mail/reader.mjs run`, with the bridge's own Node, in `mail/` as its working folder, and started again with the waits of `RESTART_BACKOFF` whenever it exits ([Running programs](shared-code.md#running-programs)). It reads and writes only `mail/`, which the module makes 0700 for `scooter-mail` when missing.
- **`--disable-sigusr1`.** *Why:* `systemctl kill` signals every process of the unit unless given `--kill-whom`, and Node answers a `SIGUSR1` it has no listener for by opening its debugger on `127.0.0.1:9229`, where any local user could run code as `scooter-mail`, which holds the mailbox's password. With the flag Node ignores the signal from its start: no debugger, no exit, no listener called. A listener in the reader would leave the moments before it was added. (Node has had the flag since 22.14.)
- **Environment:** exactly `HOME` (`mail/`), `TZ=UTC`, `PATH=/usr/local/bin:/usr/bin:/bin`, `LANG=C.UTF-8`, and the six mailbox settings, `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_OWNER_ADDRESSES` and `EMAIL_CHECK_SECONDS` (`readerEnv`). Not `EMAIL_AUTHSERV_ID`, which only the bridge reads. The password never goes on its command line. A fixed `PATH` and `LANG` give it nothing of the bridge's environment.
- **Logs.** Its stderr joins the bridge's: its log lines are Scooter's own, and imapflow logs nothing (`logger: false`).
- **Reading.** One TLS connection to the mailbox, with `INBOX` opened read-only, waiting for new mail with IDLE, and looking at least every `EMAIL_CHECK_SECONDS` in case IDLE misses something. It never deletes, moves or flags mail, so the mailbox doubles as a copy.
- **Any error with the mailbox ends it**, with exit code 1: a failed connection, login or command, or a lost connection. The bridge's restart is how it reconnects with backoff: one place for backoff, and every connection a fresh process. `SIGTERM` ends it with 0, after it has saved `connected: false` and logged out. WhatsApp goes on meanwhile.
- **For each new message, in UID order,** it fetches the header block first, and the whole message only when a `From` header names one of `EMAIL_OWNER_ADDRESSES`: a `From`, unfolded as the sender check unfolds it, that contains an owner's address, in any case. That is looser than the sender check by construction, so everything the check could keep is fetched whole. Other mail is handed over with its headers only, so the bridge can log and count it; mail that isn't the owner's is never fetched whole.
- **Too large.** A message over `ATTACHMENT_MAX_BYTES`, or one whose size the server doesn't give, isn't fetched; mail providers cap messages far below that, and IMAP requires the size in an answer that asks for it. Its headers are handed over, and if it passes the sender check it is stored without its body, with `media` `too large, not downloaded`, so the agent can tell the owner.
- **`n:*`.** IMAP always returns the newest message for `n:*`, even one below `n`, so the reader ignores UIDs below `next`.
- **The adapter.** The reader reaches the mailbox through `imap.mjs`: `open`, `list(from)`, `header(uid)`, `source(uid)`, `search({ since })`, `newest(count)`, `news({ signal })` and `close`, each one IMAP command or two through imapflow, holding no logic of the reader's and nothing that changes the mailbox. *Why:* the reader's tests use a fake mailbox with the same functions (`test/support/fake-mailbox.mjs`), and the adapter's own tests run imapflow for real against a small IMAP server of the tests' own (`test/support/imap-server.mjs`).

## The position

`mail/state.json`, written atomically, mode 0600: `{ uidValidity, next, newest, parsing, connected, checkedAt }`.

- `next` is the UID after the last message handed over. It moves only once that message's folder is renamed into the spool, so a reader that ends in the middle of an email hands it over again.
- The first time email is on, `next` is the mailbox's `UIDNEXT`, so nothing already there is imported.
- `newest` is when the newest message handed over arrived. If `UIDVALIDITY` changes, the server has renumbered the mailbox: the reader logs it, and `next` becomes the lowest UID the server gives for `SINCE` the day before `newest`, a date in UTC a day early since `SINCE` takes a date in the server's own zone, and everything from it on is handed over again. The bridge skips what it holds by `Message-ID` ([Rules](datastore.md#rules)). Before anything was handed over, `next` is the new `UIDNEXT`. *Cost:* an email without a `Message-ID` is stored again after a renumbering, under its new UID.
- `parsing` is set to a message's UID before the reader parses it whole, and cleared as soon as postal-mime has returned or thrown, before the folder is written. A start that finds it set for the next message hands that message over unparsed (`mail.parse_failed`). *Why:* a message that ends the reader while it is parsed, killed at `STOP_GRACE` or out of memory, would end it at every start. Cleared only once the folder was renamed, a spool the reader couldn't write would look like such a parse. A `UIDVALIDITY` change clears it too. *Cost:* a reader stopped while parsing, which a backup's stop can do to a large email, hands that one over unparsed.
- A position that can't be read, which only something other than the reader makes, is logged (`mail.position_unreadable`), and the reader starts from `UIDNEXT`, as the first time.
- `connected` and `checkedAt`, written after every look, are for `/status`.

## Parsing

With `postal-mime`, in `parse.mjs`.

- **The body** is the plain-text part, or else the HTML part turned into text by `htmlToText`, Scooter's own, since postal-mime gives an HTML-only email no text. One pass that finds each `<` and `>` once: comments, `head`, `script`, `style`, `template` and `title` dropped with what they hold; a line break at `br` and at block elements, a blank line around paragraphs, headings and rules; `- ` before a list item; a space between table cells; spaces run together; character references decoded (numeric ones, the XML five, Latin-1's names and HTML 4's punctuation and symbols). A tag, a comment or a script that never ends drops the rest. Where a hidden element ends is looked for in a copy with only A to Z lowered, since `toLowerCase` makes some letters two characters. *Why:* the HTML is a stranger's at worst, and every email goes through it, so it takes time in step with its length.
- **Attachments:** every attachment postal-mime finds, an image shown inside the body included. *Why:* Apple Mail sends a photo as an image the HTML body shows inline. *Cost:* a forwarded newsletter's logos are attachments too.
- **A message that can't be parsed** is handed over raw, saying so, so one malformed email can't hold up the ones after it.

## The spool

Each message becomes a folder in `mail/spool/`, written as `.tmp-<id>/` and renamed when complete, with IDs that sort in arrival order ([Files](shared-code.md#files)). `spool.mjs` writes it, and the email module checks it, field by field, refusing any other.

- `message.eml`: the raw message, or only its headers.
- `parsed.json`: `{ uid, uidValidity, arrivedAt, size, fetched, parsed, subject, text, attachments }`, each attachment `{ name, mime, bytes }` in the order of the parts. `fetched` is `whole` or `headers`; `parsed` is false for an email postal-mime couldn't parse, which then has no subject, text or attachments.
- `part-1`, `part-2`…: the attachments.

Sizes are bounded on both sides, so a well-behaved reader never writes what the bridge refuses: the reader keeps the subject and the text to one character past where the bridge cuts them, so the bridge can tell a cut is due; an attachment's name to `ATTACHMENT_NAME_MAX_CHARS`, which the bridge refuses past; a MIME type that isn't `type/subtype` becomes `application/octet-stream`; and an email whose description would pass `EMAIL_PARSED_MAX_BYTES`, as with thousands of attachments, is handed over unparsed.

## The spool, the bridge's side

The `mail/` folder is the reader's, and the bridge, as root, takes what it needs from it as from any folder another user controls ([Folders other users control](../ARCHITECTURE.md#folders-other-users-control)).

- Every `POLL_INTERVAL` it takes the complete folders in order, only while the spool is the reader's folder and not a link. A look that finds otherwise takes and removes nothing, is logged, and is tried again after `SPOOL_RETRY_BACKOFF`.
- A folder is taken only if it is a folder, and the reader's when the bridge knows its user. `parsed.json` is read with `readUntrustedFile`, up to `EMAIL_PARSED_MAX_BYTES`; `message.eml`'s header block with `readUntrustedStart`; and the parts are copied with `copyUntrustedFile`; all without following a link, as regular files with one name, belonging to `scooter-mail` ([Files](shared-code.md#files)). The bridge never takes a file name from `parsed.json`: it reads `part-<n>` by position, and the store names the stored file.
- A folder whose `parsed.json` or `message.eml` isn't one to take is logged as refused (`email.refused`), with the reason, and removed. A skipped email is counted and removed; a stored or duplicate one is removed.
- **Removing.** A folder is removed by the names the reader writes in one, `message.eml`, `parsed.json` and `part-<n>`, each unlinked, and then the folder, which goes only once that empties it. What isn't the reader's, or isn't a folder, and a folder holding anything else, is left where it is, and logged once (`email.not_removed`). *Why:* the reader could put a link in the spool's place or a folder's, and deleting everything under a path would then delete, as root, whatever the link leads to.
- **An email the bridge can't store whole for a reason of its own** stays in the spool, whole, and is tried again after `SPOOL_RETRY_BACKOFF`; the folders after it wait, in order. That is one the store can't take, and one whose files the bridge can't copy out of the spool or into the day folder ([Intake](bridge.md#intake)). A failure to open a file of the spool is the email's own only when it is `ENOENT` on that file, a file that isn't the reader's or isn't a regular file with one name (`EUNTRUSTED`), or one too large (`EFBIG`); anything else, such as `EMFILE`, is the bridge's. Only a file of the email's own that fails so leaves the email stored without it, with a `media` object saying so. *Cost:* a fault of the bridge's that lasts, such as a `bridge/incoming/` it can't write, holds back every email behind the first, until it is mended. When the store has stopped, the consumer stops with the bridge.
- `stop()` stops the reader, and waits for the spool folder it is taking.

## The sender check

Scooter's own code in the bridge, not library code, reading the raw headers in `message.eml`. A message is kept only if:

- it has exactly one `From` header, holding a single address listed in `EMAIL_OWNER_ADDRESSES`;
- and its topmost `Authentication-Results` header, which the mailbox's provider adds when the mail arrives, names `EMAIL_AUTHSERV_ID` and holds exactly one `dmarc` result, `pass`.

Anyone can write the owner's address in `From`; the DMARC result says whether the owner's own provider really sent it. How the headers are read:

- **The header block** is read from the first `EMAIL_HEADER_MAX_BYTES` of `message.eml`, as UTF-8, up to the first empty line, unfolding continuation lines. A block that doesn't end there, or a line that is neither a header (printable ASCII without a colon, then a colon) nor a continuation, makes the email unreadable, and it is skipped: anything ambiguous is skipped, since the owner's own mail never is.
- **`From`** is walked as RFC 5322 has it, quoted strings and nested comments passed over: an address in `<…>` with nothing after it but spaces and comments, or else a bare address. A `,` outside them is several addresses, and a `:` or `;` a group; either is skipped. The address is compared with `EMAIL_OWNER_ADDRESSES` exactly, without regard to case.
- **`Authentication-Results`**: the first after unfolding. Comments are no part of a result: they are dropped, then it is split at `;` outside quoted strings. Its first token is the server, compared with `EMAIL_AUTHSERV_ID` without regard to case.
- **A skip** is logged as `email.skipped`, with the UID, the sender (the address, when there is one) and the reason, which names the rule; never the subject or the contents. It is counted for `/status`.

## The record of an email

A record ([Channels](bridge.md#channels)) with `source: "email"`, which intake writes as a `message` with `trust: "owner"`.

- **`id`**, the line's `sourceId`, is the one `Message-ID` that reads as `<…>` of printable ASCII, without the brackets, or else `imap-<UIDVALIDITY>-<UID>`.
- **`at`** comes from the one `Date` header of RFC 5322's form, `[Mon, ]9 Nov 2026 21:12[:28] +0530`, comments dropped, with its zone, `+hhmm`, `-hhmm` or one of the names RFC 5322 gives; anything else, a date without a zone among them, is the arrival time. *Why:* a date without a zone would be read in the bridge's own, and code never depends on that ([Time](shared-code.md#time)). The bridge reads both from the raw headers, since it needs them also for an email postal-mime couldn't parse.
- **`subject`** is cut at `EMAIL_SUBJECT_MAX_CHARS`, then ` […]`. *Why:* nothing else bounds it, and it goes into the datastore, the agent's prompt, and the text that stands for a reaction to an email ([Choosing the channel](delivery.md#choosing-the-channel)).
- **`text`** is the body, cut at `EMAIL_TEXT_MAX_CHARS`, then `[The rest of this email was too long to keep here. The whole email is in its .eml file.]`.
- **Attachments:** first the whole message, `{ type: 'email', mime: 'message/rfc822' }`, stored as `<seq>.eml`; then the parts, each typed `image`, `audio`, `video` or `document` by its MIME type. An email that couldn't be parsed adds `{ type: 'email', error: 'could not be parsed' }`, which intake turns into its `media`; one fetched without its body has the whole message as too large.
- **Intake keeps an email's files only if the first, the whole message, was stored.** *Why:* the agent's prompt names an email's first file as the whole email, and without it the store would give the first part that name.

## What /status says of email

`Email: connected, last checked 21:40; 2 stored and 1 skipped in the last 24 hours.` The state comes from the reader's `state.json`, read as a file `scooter-mail` controls, up to `STATUS_FILE_MAX_BYTES`, and from whether the reader is running: `connecting to the mailbox`, `the reader stopped, and starts again shortly`, or `stopped`. The counts are kept in memory, over `STATUS_WINDOW`; within that long of the bridge's start the line says `since the bridge started` instead. Times past the window are dropped whenever one is added, as well as when `/status` is asked, so a mailbox strangers write to keeps a day of times at most. *Why:* skips are stored nowhere else, and a record in memory is the simplest.

## email-check

`scooter email-check` runs the reader's `newest` mode once, as `scooter-mail`, with the reader's environment, for at most `EMAIL_CHECK_TIMEOUT`, and prints each of the newest `EMAIL_CHECK_COUNT` messages with its UID, when it arrived, its `From` address, the server named in its topmost `Authentication-Results`, and whether the sender check would keep it, or why not. It stores nothing. Without `EMAIL_AUTHSERV_ID` it says how to choose it. It exits with 2 when email is off, and with 1 when the reader couldn't read the mailbox, after the reader's log lines.

## Libraries

`imapflow` and `postal-mime`, pinned in `package.json`, loaded only by the reader. What hasn't been run against a real mailbox, imapflow over TLS with an app password, the provider's IDLE and `Authentication-Results`, and postal-mime on mail the owner's apps sent, is in the README's [Check on the first real run](../../README.md#check-on-the-first-real-run).
