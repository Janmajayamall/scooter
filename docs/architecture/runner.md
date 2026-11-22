# The runner

The runner is the agent's supervisor and bookkeeper. It watches the datastore and decides when the agent runs and on what, builds the batch and the prompt, and hands each run to [A run, and the agent's folder](run.md), which runs pi in [the sandbox](sandbox.md) under [the network policy](network-policy.md), checks and commits what pi left, and writes the outbox entries. It keeps the state and runs backfills; a rebuild runs with the runner stopped ([rebuild and backfill](rebuild-and-backfill.md)). Its user, its folders and what it can reach are in [The boundaries](../ARCHITECTURE.md#the-boundaries).

This document covers the planner, pure functions from the state, the datastore and the clock to the next action (`nextAction`), and the service around it: its start, its loop, its state and its restarts. [A run, and the agent's folder](run.md) covers the executor, one run from the lock to the state (`performRun`).

The runner never:
- judges what a message says: it shows it to the model;
- trusts pi beyond the instruction lines of its answer. The file check and git are the gate for what pi wrote ([After a successful run](run.md#after-a-successful-run)).

## Files

- `src/runner/main.mjs`: starting up, and the loop: `openRunner`, `startRunner` and `runRunner`.
- `src/runner/triggers.mjs`: what the agent does next, `nextAction`.
- `src/runner/batch.mjs`: the batch, its context and its size.
- `src/runner/prompt.mjs`: the prompt, and `run/system.md`.
- `src/runner/datastore.mjs`: the runner's view of the datastore: the index, and when it last saw an incoming line.
- `src/runner/state.mjs`: reading and writing `state.json`; sessions; the state at a start.
- `src/runner/status.mjs`: `status.json`, and the emulation notice.
- `src/runner/restarts.mjs`: the runner's own waits between starts.
- `src/common/agentstate.mjs`: the format of `state.json`, its check and its reader, for the runner and for `scooter status`.
- `src/common/runnerstatus.mjs`: the format of `status.json`, its check and its reader, for the runner and for `scooter status`.

## Settings

In `runner.env`, beside the settings of [the network policy](network-policy.md#settings) and [the sandbox](sandbox.md#settings):

| Variable | Default | Meaning |
|---|---|---|
| `BATCH_SECONDS` | `8` | How long the owner must be quiet before a batch runs ([When the agent runs](#when-the-agent-runs)) |
| `SESSION_ROLLOVER_HOUR` | `4` | The local hour at which the daily session changes ([Sessions](#sessions)) |
| `HOME_CURRENCY` | `INR` | An ISO currency code, given to the agent in the prompt ([The prompt](#the-prompt)) |

## Starting up

In this order:
1. `runner.env`, and `agents.yaml`, which stops the runner on any fault, naming the field, with exit code 2 ([agents.yaml](configuration.md#agentsyaml)).
2. The runner's folders, which `setup` makes in an install, and `runner/runner.sock`, held for as long as the runner lives ([One service per data folder](shared-code.md#one-service-per-data-folder)). *Why:* a second runner would run the same batches, write `state.json` against the first, and remove the first one's `run.lock` when it starts, so a backup could start during a run.
3. What pi wrote that may still take room, removed before any folder is made: what an earlier clean-up set aside and couldn't remove, and what is in `run/session/`. *Why:* after a run that filled the disk, a crash can leave the clean-up cut short, a folder of `writes` set aside and not made again, or `run/session/` full; making that folder again then needs a block the disk hasn't got ([Facts about git, Node and Linux](run.md#facts-about-git-node-and-linux)), and a start that made its folders first couldn't start at all. So the folders of `writes` are made by the clean-up, once it has freed what pi wrote there.
4. The agent's folder, made if it is new ([The agent's folder](run.md#the-agents-folder)), with `agents/.discarded/<agent>/`, which is kept from then on; and git's leftover lock files, removed.
5. [The clean-up](run.md#the-clean-up), which throws away what a run cut short by a crash or a stop left uncommitted. It takes no `run.lock`: it commits nothing, and a lock would make a file before what pi wrote is freed, on a disk pi may have filled. A backup taken meanwhile holds a repository whose commits are whole, and at worst the agent's files in part, which the next start puts back from the last commit. *Cost:* changes the owner makes by hand in what `writes` names in the agent's folder, and leaves uncommitted, are thrown away at the next start.
6. The sandbox, which checks the image and picks the accelerator ([the sandbox](sandbox.md)). A sandbox that can't run as it is set up (`SandboxSetupError`) stops the runner with exit code 2. It opens after the clean-up, since it may make folders in `runner/tmp`.
7. A leftover `run.lock`, removed and logged as `runner.lock_removed` ([The locks](exchange.md#the-locks)).
8. The emulation notice, then `status.json` ([status.json](#statusjson)).
9. The state at a start ([State](#state)), the datastore, and the protocol.
10. Where the runner keeps its own waits, the wait after a stop on an error ([Restarts](#restarts)); then the loop.

Any other failure to start or to go on exits with 1.

## The loop

One thing at a time: a round reads the new lines, asks `nextAction` what comes next, does it, and sleeps `POLL_INTERVAL`, after a run too. So runs never overlap, and are at least `POLL_INTERVAL` apart, which the cause of a failure relies on ([Failures](run.md#failures)).

- An error in a round, such as a damaged datastore, stops the runner with exit code 1, and its service manager starts it again ([Restarts](#restarts)); the start says what is wrong. A run cut short that way changes nothing, and its batch runs again. The errors that come of what pi left are the exceptions, so that nothing pi left can make the runner run a batch again without counting an attempt: what they do instead is in [After a successful run](run.md#after-a-successful-run) and [The clean-up](run.md#the-clean-up).
- Waiting for `backup.lock`, or for a `run.lock` that isn't the runner's own, as a rebuild holds it, is logged once, when it starts (`runner.waiting`).
- A stop, on `SIGTERM` or `SIGINT`, aborts a run in progress: the sandbox closes the VM, the lock is let go of, and the run is one cut short, whose changes are thrown away as after a crash ([Failures](run.md#failures)).

## When the agent runs

The runner notices new lines by polling, every `POLL_INTERVAL`, the size of the newest `log.jsonl` and whether there is a newer day folder; it makes no network calls for this. What comes first, in each round:

1. **Nothing while paused** ([Failures](run.md#failures)) until the next try: no batches, scheduled tasks or backfill batches.
2. **New messages**, of the channels the triggers `on: new-messages` name: when there are work items after the cursor, or retries that are due, and the runner saw the newest incoming line arrive at least `BATCH_SECONDS` ago. Without such a trigger no line is work, and messages wait.
3. **A scheduled task** (`at`) that is due. It waits for messages that are ready, and doesn't wait for messages still in their quiet period.
4. **A backfill batch**, only when nothing live is waiting ([Backfill](rebuild-and-backfill.md#backfill)).

*Why this order:* messages before a scheduled task, because the evening check-in reports what was filed; the backfill last, so that it never holds up live work.

- **The quiet period** counts from when the runner saw the newest incoming line arrive, not from its `at`. Any `in` line counts, of any kind and any source. Lines already there when the runner starts count as seen then, so a start waits `BATCH_SECONDS`. *Why:* `at` is the channel's: a message caught up after downtime has an old one, and a batch would start while catch-up is still storing lines; an email's comes from its `Date` header, which can lie in the future.
- **Scheduled tasks.** `at` is `HH:MM`, or a weekday and `HH:MM`, in `SCOOTER_TZ`, by the rule of [Time](shared-code.md#time) (`previousLocalTime`). `scheduled[at]` is the owner's date of the last occurrence dealt with. A task is due when its last occurrence has a later date. One that comes due during a run or a pause is still due afterwards, and several that passed during a long pause run once. Its date is recorded once it has run, or failed for pi's own reasons; one that meets a setup error or an outage keeps its old date, so it stays due. A scheduled run gets its task and no messages.
- **At a start**, every occurrence up to now counts as dealt with: `scheduled[at]` becomes the date of the last one, in the zone the runner starts with, so a runner that starts after the time waits until the next day, and a changed `SCOOTER_TZ` takes effect at once. The dates of `at` values no longer in the config are dropped. A start during a pause keeps every date as it is instead, so a task a pause holds back stays due across the start, and is the try the start brings forward; a task new in the config starts from now, as at any start. *Why:* comparing dates of the owner's day keeps one run a day across clock changes, and overwriting at a start lets a changed zone start from where it is, where a date from a zone far ahead would hold the task back for up to two days. *Cost:* on the day the zone changes, a task can run twice or not at all; and a zone changed during a pause takes effect for the dates only at the first start after the pause.
- **Overlap:** runs never overlap ([The loop](#the-loop)). A run's lock is in [A run](run.md#a-run), and how it keeps runs and backups apart in [The locks](exchange.md#the-locks).

## State

The runner alone writes `agents/<agent>/state.json`, atomically, mode 0600, indented for the owner who reads it. Its format, and the check every reader and writer applies, are `src/common/agentstate.mjs`, which `scooter status` reads too ([scooter status](bridge.md#scooter-status)).

```json
{
  "cursor": 1049,
  "retry": [{"seq": 1047, "attempts": 1, "due": "2026-11-09T15:51:00Z", "reason": "not reported"}],
  "failed": [{"seq": 1031, "at": "2026-11-09T12:32:11Z", "reason": "unreadable PDF"}],
  "backfill": {"id": "people-1", "until": 1890, "cursor": 812, "retry": [], "skipped": [1031]},
  "backfillDone": [],
  "scheduled": {"21:30": "2026-11-09"},
  "lastRun": {"at": "2026-11-09T15:50:15Z", "ok": true, "seqs": [1050, 1051, 1053], "durationMs": 48211}
}
```

- `cursor` is the highest `seq` the runner has dealt with, by giving it to the agent or by skipping it. Everything after it is new.
- An item in `retry` may have 0 `attempts`: after a setup error or an outage, a new item waits there with its count unchanged.
- `paused` exists only while a setup error or an outage holds runs back: `{ since, cause, reason, next, tries }`, `cause` being `setup` or `outage`, and `tries` the failed tries in a row.
- `backfill` exists only while a backfill is in progress; `backfillDone` lists the finished ones ([Backfill](rebuild-and-backfill.md#backfill)).
- `lastRun` is `{ at, ok, seqs, durationMs }`, `at` being the run's start. A scheduled task is a live run too, with no `seqs`.
- An agent that has never run has `cursor` 0, empty lists, `scheduled` `{}`, and `lastRun` null.
- Times are UTC. The dates in `scheduled` are dates of the owner's day, since the schedule follows it.
- The check is strict: every field above, of its type, and no other. It refuses an item in `retry` after its lane's cursor, the backfill's included.

**Work items** are `in` lines from a channel one of the agent's triggers `on: new-messages` names in its `channels` ([agents.yaml](configuration.md#agentsyaml)), of kind `message`, `edit` or `delete`, of the lines this version knows ([Reading a line](datastore.md#reading-a-line)). The channels of every such trigger are the agent's, whichever trigger names one, so one cursor is enough. Everything else isn't work: the cursor moves past it, and the agent doesn't report on it. Of that, the messages Scooter sent and the reactions are shown to the agent as context ([The prompt](#the-prompt)); a line this version doesn't know, of a kind or a channel it doesn't have or without a field its kind needs, is passed over, as neither work nor context.

**At a start**, besides the scheduled tasks' dates ([When the agent runs](#when-the-agent-runs)), the runner starts or drops a backfill, as [Backfill](rebuild-and-backfill.md#backfill) says.

## Sessions

- **The session's day** is the owner's local date, or the day before while the local clock is before `SESSION_ROLLOVER_HOUR`. It goes by the clock, not by hours since midnight, so on a day the clocks change it still changes at that hour.
- **The session's ID** is `<agent>-<day>`, so a day's session ends at `SESSION_ROLLOVER_HOUR`, or when its file is removed from `sessions/`. With `session: none`, pi runs without one. A scheduled task runs in the day's session too, so the evening check-in knows what the day's runs filed.
- How a session is kept, and what a run may do to it, is in [The session's copy](run.md#the-sessions-copy).

## The batch

A batch is due retries first, then work items after the cursor, oldest first, at most `BATCH_MAX_ITEMS` in all.

- **An edit or a deletion in the batch brings in the message it changes** when that message waits in `retry`, due or not, or is in `failed`. It joins as a retry; one taken from `failed` leaves it and starts again at attempt 1. These may take the batch past `BATCH_MAX_ITEMS`. *Why:* otherwise the edit could be handled before the message it changes, and the retry would later file the old text.
- An item in `retry` whose line isn't a work item of the agent, which only changed `channels`, a damaged state, or a line this version no longer knows gives, is never due, and starts no batch.
- **What it covers:** the lines up to the first work item it leaves for later, or up to the newest line, with the context and the lines of channels no trigger names in that stretch. Where the cursor goes after the run is in [Failures](run.md#failures).
- **The context:** the messages Scooter sent and the reactions, of the lines this version knows, from the oldest item to the end of what the batch covers, plus every message an item quotes.
- **The newest item**, which an answer's plain text is about ([Reading the answer](run.md#reading-the-answer)), is the item with the highest `seq`.

**The size limit.** The prompt is one command-line argument, so the batch also stops growing before the prompt would pass `PROMPT_MAX_BYTES`, though it always keeps at least one item. It grows one item at a time, with what each brings in. When even the first item is too long:
1. if it fits on its own, the oldest context lines are left out, and a line says how many;
2. otherwise its texts, and those of the messages it quotes, are cut, as little as will do, keeping all the context if that then fits and none if not. A cut text is followed by where the rest is: `(cut; the whole text is line 3 of /data/datastore/2026/11/09/log.jsonl)`, the line its current text is in, which the index keeps, or `(cut; the whole email is …/1071.eml)`. The context's texts are never cut: each is a sent chunk or a reaction;
3. if even that is too long, as an email with hundreds of attachments could be, the prompt is cut at the limit, and says so.

The cut is searched for a stretch at a time, between the lengths of the texts it applies to, from the highest down: within a stretch the prompt grows with the cut, but at a text's whole length it is shorter than just below, since the text is then shown without its note.

*Why:* Linux refuses a single argument of 128 KB or more: in a VM from the image, a prompt of 131,071 bytes reached the model whole, and one of 131,072 never started, exit code 127 and `exec failed` on stderr, with no request; on Ubuntu 24.04 an argument of 120,000 bytes worked and one of 140,000 failed, "Argument list too long". Thirty arguments of 100 KB each were taken together, so only the single argument matters. Without the limit, a prompt over it would look like a crash of pi, and a batch of long emails would fail on every attempt and end in `failed`.

## The prompt

The prompt is pi's user message: a header, then the batch's items, their context, or a task. `src/runner/prompt.mjs` defines it.

```
[scooter] Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.
Your folder: /data/agents/lifelog. Attachments are in /data/datastore (read-only).

New messages:
#1050 21:13 photo /data/datastore/2026/11/09/1050.jpg (image/jpeg), caption: "lunch with sam"
#1051 21:14 text: "coffee 150" (edited in #1054)
#1052 21:15 document "ticket.pdf" /data/datastore/2026/11/09/1052.pdf (application/pdf)
#1053 21:20 text: "work"
      ↳ reply to #1043, which you sent: "Blue Tokai, ₹450 at 12:40: work or personal?"
#1054 21:22 edit of #1051, now: "coffee 150"

Retrying (not handled yet):
#1047 20:02 text: "ran 5k in 28 min" (attempt 2 of 4)

For context only (no action, no DONE):
#1049 21:05 you sent: "Logged ₹340 Uber."
#1048 21:04 the owner reacted 👍 to #1046
```

- **Times** are in `SCOOTER_TZ`, converted from the datastore's UTC times, because the agent writes the dates the owner reads: an item's time is shown by `shortLocalTime` ([Time](shared-code.md#time)), against `Now:`, and "today" is the owner's local date. The header gives the home currency, the reply mode and whether internet access is on ([Settings](network-policy.md#settings)).
- **Every text** the owner or the agent wrote is a JSON string, so a line break or a quote in it can't pass for the prompt's own lines.
- **A file's kind** comes from its MIME type: `photo`, `video`, `audio` or `document`, with its absolute path, its MIME type and its original name. A message's further files are `attachment` lines under it. Media that couldn't be stored says so: `photo, not stored (download failed)`, with the caption if there is one.
- **Every message is shown as it is now:** with the text of its latest edit, marked `(edited in #<seq>)`, or, if it was deleted, `(deleted in #<seq>)` in place of its content. That holds for new items, retries and quoted messages. An edit is `edit of #1051, now: "<its own text>"`, and a deletion `deletion of #1051`.
- **A reply** shows the quoted message and who sent it: "you sent", "the owner sent", `↳ reply to an earlier message: "<the quoted preview>"` when Scooter doesn't have it, or `↳ reply to #N: "<quoted>"` for a line the index can't show as a message, such as one this version doesn't know. A reply to a photo shows the photo's path. Forwarded messages are marked as forwarded.
- **What the prompt takes from a line's `data`**, the quoted preview, whether it was forwarded, an email's subject and a reaction's emoji ([data](datastore.md#data)), it takes only when it is of its type there: a preview that isn't a string isn't shown, a message is forwarded only when `forwarded` is `true`, an email without a subject shows `email ""`, and a reaction without an emoji `the owner reacted to #1046`.
- **Context lines** are listed newest first, and say who sent them: `you` for the agent's own, `the owner` for the owner's, and `Scooter` for the runner's and the bridge's, such as notices. One is shown with the message it replies to: `you sent, in reply to #1047: "…"`.
- **An email** shows `email`, its subject and its text, then each attachment, and the whole message; one that couldn't be read adds `email not stored (could not be parsed)`:
  ```
  #1071 21:42 email "Call with Sam": "Recording from today's call."
        attachment "Call with Sam.m4a" /data/datastore/2026/11/09/1071-2.m4a (audio/mp4)
        whole email /data/datastore/2026/11/09/1071.eml
  ```
- **A scheduled run** shows `Scheduled task (from your configuration, not a message from the owner):` and the task, instead of messages.

**The system prompt.** Before each run the runner writes `run/system.md`, which pi gets with `--append-system-prompt`. It holds, in order:
1. the protocol, `src/runner/protocol.md`, which ships with the runner ([The protocol](agent.md#the-protocol));
2. the agent's prompt, from the run's copy of the config folder;
3. a `# Your memory` section with what `memory/preferences.md` and `memory/needs-review.md` hold, or "(empty)".

Each memory file is opened without following a link, and only a regular file is read, at most `MEMORY_MAX_BYTES` of it; otherwise the section says the file wasn't read, or was cut and should be shortened. When `memory` is itself a file, which `writes` may name as one, there is no memory file in it, and the section says "(empty)", as with no `memory/` at all: a path through a file names nothing. *Why:* pi writes `memory/`, as the default `writes` lets it. A run that leaves a link there fails and is cleaned up, but a runner stopped before the clean-up would read the link at its next run, and a link to `runner.env` would put the OpenRouter key into the prompt. A file that grew without bound would make every request too large, and no run could then shorten it. And an error there would stop every run before pi, without counting an attempt.

## Restarts

The runner stops on an error that isn't pi's, such as a damaged datastore or a state it can't save, and its service manager starts it again. A fault that stays after pi has run would then run pi, and spend on OpenRouter, at every start. So the starts wait 1 minute after the first stop in a row, 1 minute × √30, about 5½, after the second, and 30 minutes after each from the third (`RUNNER_RESTART_WAITS`), OpenRouter's outage waits, so such a fault spends at most twice an hour, as an outage does. It never gives up.

- **Natively** systemd keeps these waits ([Restarts](install.md#restarts)). The runner's unit sets `SCOOTER_RESTART_WAITS=systemd`, and the runner then keeps no count of its stops and no waits of its own, so that a start by hand brings it back at once.
- **Anywhere else** it keeps them itself, as in Docker, whose restart policy starts it again at once ([Restarts](install.md#restarts)). The owner answered "ok" on 2026-11-18 to closing this, of which they had been told: "if a fault persists after pi has run, Docker restarts the runner at once and pi runs again each time, spending on OpenRouter."
  - **Its count of stops,** in `runner/restarts.json`, mode 0600: how many starts in a row have ended other than by a stop the runner was asked for, when the latest started and stopped, and why. A start that follows a stop on an error waits from that stop, or from the start before it when the stop couldn't be recorded, such as after a kill or a lost power. Then it records itself as the next stop in a row, and runs nothing if it can't. So a start that ends in a crash counts, though it could write nothing then; and on a disk too full to write the count, the runner stops before pi.
  - **When it waits:** after the steps of a start that run nothing of pi's, and before the loop ([Starting up](#starting-up)). *Why there:* those steps say what is wrong first, and `status.json`, which needs the sandbox opened, can then say that the runner waits. A start that stops in those steps, such as on a bad `agents.yaml`, a missing VM image or a damaged datastore, runs nothing of pi's, records nothing, waits for nothing and sends no notice; its service manager's own restarts pace it ([Restarts](install.md#restarts)). *Why it records nothing:* its next start would stop in the same steps before it came to the wait, so recording it would pace nothing.
  - **What ends the waiting:** a stop the runner is asked for, by `SIGTERM` or `SIGINT`, makes the count 0, so restarting the runner, by hand or with the machine, starts it at once; and a run recorded since the start makes the next stop the first in a row. Only a run that got through can, so a fault that stops every run before it is recorded keeps counting.
  - **The owner sees it:** the first wait in a row sends one notice ([Notices](run.md#notices)), saying why and until when, such as "⚠️ I stopped on an error (ENOSPC), so I wait until 21:31 before I go on, and longer if it happens again. Restarting the runner ends the wait.", and `status.json` says so while it waits ([status.json](#statusjson)). The reason is the error's code or name (`errorFields`, [Logging](shared-code.md#logging)).

*Why the runner keeps them by default, and the unit turns them off:* however the runner is started again, a fault that stays must not run pi more often, and the unit is Scooter's own file, which says so where systemd's waits are set. `SCOOTER_RESTART_WAITS` isn't a setting of `runner.env`, which refuses it: it isn't the owner's to choose. *Cost:* in Docker a runner that stopped on an error waits at least a minute, also when a restart alone would have mended it; restarting it ends that. In development, a runner that stopped on an error waits at its next start, and Ctrl-C ends that wait too. `runner/restarts.json` is one more file in `runner/`, which backups don't hold.

## status.json

`scooter status` is a command of the bridge's side, which reads neither the config folder nor `runner.env` ([Secrets](../ARCHITECTURE.md#secrets)), so the runner writes what it needs from them ([scooter status](bridge.md#scooter-status)). At every start it writes `runner/status.json`, atomically, mode 0600: `{ startedAt, accel, zdr, internet, imageBuiltAt, agents: { <name>: { model, timeoutMinutes, channels } }, restart }`. `accel` is `kvm` or `emulation`; `imageBuiltAt` is null when the sandbox doesn't know it; the model is each agent's, as `agents.yaml` has it, and `channels` the channels its triggers for new messages name, whose lines `scooter status` counts as pending; and `restart`, where the runner keeps its own waits, says whether this start waits before it goes on, how many stops, until when and why ([Restarts](#restarts)). A runner stopped during that wait writes it again without `restart`, as best it can, so `scooter status` doesn't say it waits. Its format, `src/common/runnerstatus.mjs`, refuses an agent's name `agents.yaml` wouldn't allow, because `scooter status` makes a path of it. A `status.json` that can't be read at a start is logged and counts as none.

**The emulation notice.** At a start, when `AGENT_ACCEL=auto`, the sandbox runs under emulation and the `status.json` of the last start doesn't say `emulation`, the runner sends a notice ([Notices](run.md#notices)): "⚠️ My VMs run under emulation now, because KVM isn't available, so each batch takes much longer. Run `scooter doctor` on the runner to see how to enable KVM." A first start counts as a change. `AGENT_ACCEL=emulation` sends none: nothing fell back. The notice is written before `status.json`, so a crash between the two sends it twice rather than never. *Why only on a change:* a runner that keeps restarting would otherwise message the owner each time.

