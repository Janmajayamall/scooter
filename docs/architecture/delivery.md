# Delivery

Delivery is the bridge's side of the outbox: it takes the entries the runner and the bridge itself write ([Outbox entries](exchange.md#outbox-entries)), chooses the channel for each, sends it in paced chunks through the channel, logs each message it sends as an `out` line, and makes sure a crash can repeat a message but never lose one. It is part of [the bridge](bridge.md).

## Files

- `src/bridge/outbox.mjs`: delivery: taking entries, routing, chunking, pacing, the sending file, `out` lines, waiting, failed sends, and pausing for a backup.

## Settings

In `bridge.env`:

| Variable | Default | Meaning |
|---|---|---|
| `DEFAULT_CHANNEL` | `whatsapp` | Where messages Scooter sends on its own go, and replies about emails ([Choosing the channel](#choosing-the-channel)) |

## Order

- Every `POLL_INTERVAL` delivery looks at the outboxes and takes the entries in the order of their IDs, which is the order they were made. An entry that can't go out yet holds back the ones after it.
- **Two outboxes.** The runner's entries are in `exchange/outbox/`, and the bridge's own in `bridge/outbox/` ([The bridge's own entries](#the-bridges-own-entries)). The two are taken together, in the order of their IDs; of a bridge's entry and a runner's with the same ID, made in the same millisecond, the bridge's goes first. *Cost:* two entries of the two services made in the same millisecond go in no set order between them; within each service, entries keep their order.

## Choosing the channel

`routeEntry` looks at the line an entry's `replyTo`, `about` or `target` points at, and uses its `source`. The agent never names a channel: it refers to messages only by `seq`.

- **A `text`** goes to the channel of the line `replyTo` or `about` names when that channel is running and can send; otherwise, as for an email or a line that doesn't exist, to `DEFAULT_CHANNEL`, without a quote. With `replyTo` it quotes, on the first chunk only: an edit or a deletion as the message it changes, a command as the message it was, and a line Scooter sent by the ID its channel gave it. A line with no channel ID, or one that isn't a message, isn't quoted, and the text still goes to its channel.
- **A `react`** goes to the channel of the message its target is or changes, by that message's channel ID, if the channel can react. A reaction to an email becomes the text `✅ Email: <subject>`, or `✅ Email: (no subject)`, on `DEFAULT_CHANNEL`, so the owner knows it arrived; it is cut as an entry's text is ([Outbox entries](exchange.md#outbox-entries)). A reaction to a line that doesn't exist, to a line Scooter sent, or to a reaction, is dropped and logged, and so is one whose channel can't react. *Why:* Scooter reacts only to the owner's messages; WhatsApp's `send react` names the owner as the sender.
- **A `text` with neither `replyTo` nor `about`** goes to `DEFAULT_CHANNEL`: scheduled tasks, notices, the backfill summary and the bridge's backup messages.
- **`DEFAULT_CHANNEL`** must be a channel that is running and can send (`defaultChannelProblem`), so in v2 it can only be `whatsapp`. The settings accept `whatsapp` or `email`; the bridge refuses to start with one that can't send, before it starts any channel, and `scooter bridge` exits with 2. *Why:* whether a channel can send is the channel module's to say.

The rule that a reply follows the message it answers and everything else goes to `DEFAULT_CHANNEL` is [the owner's fixed choice](../ARCHITECTURE.md#the-owners-fixed-choices). In v2 only WhatsApp can send, so replies about emails arrive there, unquoted.

## Chunks

A text is split into pieces of at most `CHUNK_CHARS` characters, a character being a Unicode code point, so an emoji is never split (`splitText`). A piece that would be too long is cut at the last paragraph break in its second half, or else the last line break there, or else the last space, or else at the limit. The breaks where it is cut, and blank lines at the start of a piece, are left out, and so is a piece of nothing but spaces. Each piece is sent with the channel's `sendText`, quoting only with the first.
*Why:* looking only in the second half keeps every piece but the last at least half full; without it, a break near the start of a long piece would make a piece of a few characters. So a text at its longest, four chunks, goes out as four to eight messages. Filling pieces further would cut texts in the middle of a paragraph more often.

## Pacing

At most one message every `SEND_INTERVAL`, texts, chunks and reactions alike, on every channel, measured from the start of the last try, failed ones included. A bridge that starts afresh sends its first message at once.
*Why:* so the bot's number doesn't look like spam. wacli warns when two sends come less than 5 seconds apart, and notes the time of each attempt ([Facts about wacli 0.26.0](whatsapp.md#facts-about-wacli-0260)). wacli's own spacing option isn't used: one place is enough. *Cost:* in quiet mode the ✅ reactions to a batch go out one `SEND_INTERVAL` apart.
*The owner's answer:* asked on 2026-11-16, "On the send interval, I would raise it to 5 seconds: a reply in three parts then takes 10 seconds instead of 3, and replies to your own chat aren't urgent", the owner answered "yes to all". Whether that is slow enough for WhatsApp isn't known: WhatsApp doesn't publish its limits, and 5 seconds is the threshold wacli's authors chose for their warning.

## Sending an entry

Delivery is at least once: a crash can send one message twice, and never loses one. Before an entry's first message goes, the bridge keeps a **sending file**, `{"entry": {…}, "sent": n}`, written atomically, mode 0600: the entry, and how many of its messages have gone out. Then, for each message:

1. the sending file is written again, with the count it has. If that fails, as on a full disk, the message isn't sent;
2. the message is sent;
3. its `out` line is appended;
4. the sending file is written with one more, or, after the last, the entry is removed.

- **At startup**, every entry the bridge has a sending file of is sent again from the first message the file doesn't count as sent; a reaction is simply sent again. The bridge doesn't search wacli's store for what already went out.
- **Nothing is sent that the sending file couldn't then record.** A message whose `out` line the store refuses is counted as sent all the same, the sending file written, and the bridge stops; its `out` line is missing. *Why:* otherwise a disk that can't be written would make a bridge that restarts for it send the same message at every start, as fast as its service manager restarts it.
- *The owner's answer*, 2026-11-15, in place of searching wacli's store for a text that may have gone out: no search; the sending file records how many chunks were sent, and the rest are sent again, at worst one repeated message.

**Where the sending file is.** The bridge writes nothing in the runner's outbox ([Folders other users control](../ARCHITECTURE.md#folders-other-users-control)). For a runner's entry it reads `entry.json` once, and keeps the sending file in its own folder, `bridge/sending/<id>.json`, written before anything goes out and once more after the last message. From then on that file wins over what the entry's folder holds, so what the runner's user does to the folder changes nothing the bridge sends. It goes once nothing of the entry is left to take again: its folder gone, no folder any more, such as a link put in its place, or holding no `entry.json`. *Why:* the runner's user could put a link in an entry's place between the bridge's look and its write, and steer the write, as root, into the folder the link leads to. *Cost:* no install has entries of an older bridge, which kept `sending.json` in the entry's folder; such a folder holds no `entry.json`, and is refused and left.

## Taking entries from the runner's outbox

The outbox is the runner's folder ([Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners)), and the bridge, as root, takes what it needs from it as from any folder another user controls ([Folders other users control](../ARCHITECTURE.md#folders-other-users-control)).

- It takes entries only while the outbox is the runner's folder and not a link. While it isn't, none of the runner's entries is taken, not even one the bridge has a sending file of, whose removal would reach through the link; the bridge's own entries still go, `/status`'s reply among them. That is logged once, and once again when the outbox can be taken from (`outbox.runner_outbox_taken`), and the look doesn't fail for it.
- It takes only folders named as entry IDs are (`isId`). Any other name is left, and logged once, with its first `LOGGED_NAME_MAX_CHARS` characters and its length. *Why:* the sending file is named after the entry, and a name of 240 characters made it too long for the system, so every look failed.
- `entry.json` is read with `readUntrustedFile`: without following a link, only a regular file with one name, of at most `OUTBOX_ENTRY_MAX_BYTES`, which a text at its longest stays far under. An entry that isn't a folder, has no `entry.json`, isn't JSON, or fails `checkOutboxEntry`, is logged with the reason, which names fields and never repeats values, and removed. *Why:* a link left in place of an entry would have root read a file the runner's user can't; an escape from pi's VM reaches that user.
- It removes a runner's entry only by `entry.json`, unlinked, and then the folder, which goes only once that empties it. What it can't remove so, or what isn't a folder, it leaves, and logs once (`outbox.not_removed`).

## The bridge's own entries

The bridge's own messages, its replies to `/status`, `/backup` and `/help`, and its backup notices, are entries in its own outbox, `bridge/outbox/`, which only root can write, in the same form, `by: "bridge"`. Their sending file is `sending.json` in the entry's folder there, and the bridge removes such an entry by `entry.json`, `sending.json`, and what a write of `sending.json` cut short left.

## `out` lines

After each message that goes out, an `out` line is appended: the channel as `source`, the ID the channel returned as `sourceId`, and `by` from the entry. A chunk that quoted a line has that line's `seq` as `replyTo`, which is what `replyTo` is on a line: the quoted message. So a reply about an email, which isn't quoted, has none, and the agent's prompt shows it as "you sent".
- A message the channel gave no ID for is logged without `sourceId`, and not sent again.
- If the datastore already holds a line with that ID, the `out` line is logged without it (`outbox.id_taken`). *Why:* if wacli answered a reaction with the ID of the message reacted to, every ✅ would go out and none would be recorded.

*Why `out` lines:* the datastore then has both sides of the conversation, and the agent sees its own earlier replies as context, which is what stops duplicates after a batch that is tried again.

## Waiting and failed sends

- **While an entry's channel can't send** (`ready()`), such as WhatsApp before `pair`, the entry waits, and the ones after it with it, logged once.
- **A send that fails** is logged, without its text, and tried again after a wait that doubles, `SEND_RETRY_BACKOFF`. A text goes without its quote once half of `SEND_ATTEMPTS` tries, rounded up, have failed: wacli needs the quoted message in its store, which a store made afresh, after pairing again, wouldn't have.
- **Passed over.** Each entry keeps its own failed tries and its own next try. After `SEND_ATTEMPTS` failed tries made while its channel could send, it is logged as `outbox.passed_over`: it is still tried first, after its own wait, but when it fails the look goes on to the next entry. A failure after which the channel can't send, such as sync stopping, isn't counted. An entry with nothing behind it holds nothing back, and is tried after the longest wait.
- **Given up.** When a message of a later entry goes out, the channel works: each entry passed over gets one last try, and the look starts over so that it comes next. If that try fails too, the entry is given up on, logged as `outbox.given_up` with its ID, type, author, all its failures and how far it got, and removed. *Cost:* a message given up on reaches neither the owner nor the datastore; the log says so.
- **Order after an outage.** Before an entry behind ones passed over is tried, they are tried again, in order, whatever their own waits. So an outage, during which wacli says it is linked and every send fails, gives up on nothing, and once it ends the entries go in order. The one exception is an entry tried in the very look during which sends began to work again, after the ones passed over ahead of it failed in that look: it goes first, and they follow, in order. No rule can undo a message once it has gone.
- *Why:* entries go in order, so one that can never go out would otherwise hold back every reply after it, `/status`'s among them, for good; and an outage, like the runner's, must not use up an entry's tries. *Cost:* during an outage each entry is tried at its own pace and each failure is logged; while an entry behind ones passed over ramps up, each of its tries brings a try of each of them.
- **A look at the outbox that fails** for another reason, such as a disk that can't be written, is tried again after the same waits, and logged each time.

## Pausing and stopping

`pause()` stops delivery between two messages, for a backup, and `resume()` starts it again ([Consistency](backups.md#consistency)). When the bridge stops, a send in progress is stopped through the channel's `signal`, and goes out again at the next start ([Starting up](bridge.md#starting-up)).

Logs name entries by their ID, and never hold their text.
