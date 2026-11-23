# The runner

The runner is the agent's supervisor and bookkeeper. It watches the datastore and decides when the agent runs and on what, builds the batch and fills in its prompt, and hands each run to [A run, and the agent's folder](run.md), which runs pi in [the sandbox](sandbox.md) under [the network policy](network-policy.md), checks and commits what pi left, and writes the outbox entries. It keeps the state, and runs the jobs of `scooter backfill` ([backfill](backfill.md)). Its user, its folders and what it can reach are in [The boundaries](../ARCHITECTURE.md#the-boundaries).

This document covers the planner, pure functions from the state, the datastore and the clock to the next action (`nextAction`), and the service around it: its start, its loop, its state and its restarts. [A run, and the agent's folder](run.md) covers the executor, one run from the lock to the state (`performRun`).

The runner never:
- judges what a message says, or shows it: it gives the model the line's number, and the model reads it ([The prompt](#the-prompt));
- trusts pi beyond what `send` and `mark` leave, which it reads as files pi controls, once a run has passed ([What send and mark leave](run.md#what-send-and-mark-leave)). The file check and git are the gate for what pi wrote ([After a successful run](run.md#after-a-successful-run)).

## Files

- `src/runner/main.mjs`: starting up, and the loop: `openRunner`, `startRunner` and `runRunner`.
- `src/runner/triggers.mjs`: what the agent does next, `nextAction`.
- `src/runner/batch.mjs`: the batch, and the trigger whose prompt it is given.
- `src/runner/prompt.mjs`: the prompt's variables, their values, and how long a prompt can be once they are filled in.
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
| `HOME_CURRENCY` | `INR` | An ISO currency code, `$user.currency$` in a prompt ([The prompt](#the-prompt)) |

## Starting up

In this order:
1. `runner.env`, and `agents.yaml`, which stops the runner on any fault, naming the field, with exit code 2 ([agents.yaml](configuration.md#agentsyaml)).
2. The runner's folders, which `setup` makes in an install, and `runner/runner.sock`, held for as long as the runner lives ([One service per data folder](shared-code.md#one-service-per-data-folder)). *Why:* a second runner would run the same batches, write `state.json` against the first, and remove the first one's `run.lock` when it starts, so a backup could start during a run.
3. What pi wrote that may still take room, removed before any folder is made: what an earlier clean-up set aside and couldn't remove, and what the run could write in `run/`, `run/session/`, `run/send/` and `run/marks.txt` (`clearRunWrites`). *Why:* after a run that filled the disk, a crash can leave the clean-up cut short, a folder of `writes` set aside and not made again, or `run/session/` or `run/send/` full; making that folder again then needs a block the disk hasn't got ([Facts about git, Node and Linux](run.md#facts-about-git-node-and-linux)), and a start that made its folders first couldn't start at all. So the folders of `writes` are made by the clean-up, once it has freed what pi wrote there.
4. The agent's folder, made if it is new ([The agent's folder](run.md#the-agents-folder)), with `agents/.discarded/<agent>/`, which is kept from then on; and git's leftover lock files, removed.
5. [The clean-up](run.md#the-clean-up), which throws away what a run cut short by a crash or a stop left uncommitted. It takes no `run.lock`: it commits nothing, and a lock would make a file before what pi wrote is freed, on a disk pi may have filled. A backup taken meanwhile holds a repository whose commits are whole, and at worst the agent's files in part, which the next start puts back from the last commit. *Cost:* changes the owner makes by hand in what `writes` names in the agent's folder, and leaves uncommitted, are thrown away at the next start.
6. The sandbox, which checks the image and picks the accelerator ([the sandbox](sandbox.md)). A sandbox that can't run as it is set up (`SandboxSetupError`) stops the runner with exit code 2. It opens after the clean-up, since it may make folders in `runner/tmp`.
7. A leftover `run.lock`, removed and logged as `runner.lock_removed` ([The locks](exchange.md#the-locks)).
8. The emulation notice, then `status.json` ([status.json](#statusjson)).
9. The state at a start ([State](#state)), and the datastore; the sessions of every agent's jobs whose files are gone, removed ([Cancelling](backfill.md#cancelling)); and the release of the zone rules that ship for the VM, whose files are checked, and which is logged as `runner.zone_rules_differ`, with the runner's own, when the runner's Node's is another ([The zone rules](agent.md#the-zone-rules)).
10. Where the runner keeps its own waits, the wait after a stop on an error ([Restarts](#restarts)); then the loop.

Any other failure to start or to go on exits with 1.

## The loop

One thing at a time: a round reads the new lines, asks `nextAction` what comes next, does it, and sleeps `POLL_INTERVAL`, after a run too. So runs never overlap, and are at least `POLL_INTERVAL` apart, which the cause of a failure relies on ([Failures](run.md#failures)).

- An error in a round, such as a damaged datastore, stops the runner with exit code 1, and its service manager starts it again ([Restarts](#restarts)); the start says what is wrong. A run cut short that way changes nothing, and its batch runs again. The errors that come of what pi left are the exceptions, so that nothing pi left can make the runner run a batch again without counting an attempt: what they do instead is in [After a successful run](run.md#after-a-successful-run) and [The clean-up](run.md#the-clean-up).
- Waiting for `backup.lock`, or for a `run.lock` that isn't the runner's own, which nothing of Scooter's but the runner makes, is logged once, when it starts (`runner.waiting`).
- A stop, on `SIGTERM` or `SIGINT`, aborts a run in progress: the sandbox closes the VM, the lock is let go of, and the run is one cut short, whose changes are thrown away as after a crash ([Failures](run.md#failures)).

## When the agent runs

The runner notices new lines by polling, every `POLL_INTERVAL`, the size of the newest `log.jsonl` and whether there is a newer day folder; it makes no network calls for this. What comes first, in each round:

1. **Nothing while paused** ([Failures](run.md#failures)) until the next try: no batches, scheduled tasks or steps of a job.
2. **New messages**, of the channels the triggers `on: new-messages` name: when there are work items to give after the cursor, or retries that are due, and the runner saw the newest incoming line arrive at least `BATCH_SECONDS` ago. Without such a trigger no line is work, and messages wait. A message already deleted is no work to give ([The batch](#the-batch)), so it starts no run.
3. **A scheduled task** (`at`) that is due. It waits for messages that are ready, and doesn't wait for messages still in their quiet period.
4. **A step of a job of `scooter backfill`**, its start, a batch or its message, only when nothing live is waiting; a job with `--hold-live` comes before 2 and 3 instead, until it has finished ([When a job runs](backfill.md#when-a-job-runs)). A job of an agent given in a file that waits after a setup error or an outage of its own gives no batch until its next try. Before each round the runner looks at the jobs' files, and takes one when it holds none ([Taking a job](backfill.md#taking-a-job)).

*Why this order:* messages before a scheduled task, because the evening check-in reports what was filed; a job last, so that it never holds up live work, unless the owner asks for that with `--hold-live`.

- **The quiet period** counts from when the runner saw the newest incoming line arrive, not from its `at`. Any `in` line counts, of any kind and any source. Lines already there when the runner starts count as seen then, so a start waits `BATCH_SECONDS`. *Why:* `at` is the channel's: a message caught up after downtime has an old one, and a batch would start while catch-up is still storing lines; an email's comes from its `Date` header, which can lie in the future.
- **Scheduled tasks.** `at` is `HH:MM`, or a weekday and `HH:MM`, in `SCOOTER_TZ`, by the rule of [Time](shared-code.md#time) (`previousLocalTime`). `scheduled[at]` is the owner's date of the last occurrence dealt with. A task is due when its last occurrence has a later date. One that comes due during a run or a pause is still due afterwards, and several that passed during a long pause run once. Its date is recorded once it has run, or failed for pi's own reasons; one that meets a setup error or an outage keeps its old date, so it stays due. A scheduled run gets its trigger's prompt and no lines ([The prompt](#the-prompt)). The log line that starts its run, `runner.run_started`, names the task by its trigger's `tag`, as the notice of its failure does ([Notices](run.md#notices)); the state keeps it by its `at` ([agents.yaml](configuration.md#agentsyaml)).
- **At a start**, every occurrence up to now counts as dealt with: `scheduled[at]` becomes the date of the last one, in the zone the runner starts with, so a runner that starts after the time waits until the next day, and a changed `SCOOTER_TZ` takes effect at once. The dates of `at` values no longer in the config are dropped. A start during a pause keeps every date as it is instead, so a task a pause holds back stays due across the start, and is the try the start brings forward; a task new in the config starts from now, as at any start. *Why:* comparing dates of the owner's day keeps one run a day across clock changes, and overwriting at a start lets a changed zone start from where it is, where a date from a zone far ahead would hold the task back for up to two days. *Cost:* on the day the zone changes, a task can run twice or not at all; and a zone changed during a pause takes effect for the dates only at the first start after the pause.
- **Overlap:** runs never overlap ([The loop](#the-loop)). A run's lock is in [A run](run.md#a-run), and how it keeps runs and backups apart in [The locks](exchange.md#the-locks).

## State

The runner alone writes `agents/<agent>/state.json`, atomically, mode 0600, indented for the owner who reads it. Its format, and the check every reader and writer applies, are `src/common/agentstate.mjs`, which `scooter status` reads too ([scooter status](bridge.md#scooter-status)).

```json
{
  "cursor": 1049,
  "retry": [{"seq": 1047, "attempts": 1, "due": "2026-11-09T15:51:00Z", "reason": "not marked"}],
  "failed": [{"seq": 1031, "at": "2026-11-09T12:32:11Z", "reason": "unreadable PDF"}],
  "scheduled": {"21:30": "2026-11-09"},
  "lastRun": {"at": "2026-11-09T15:50:15Z", "ok": true, "seqs": [1050, 1051, 1053], "durationMs": 48211}
}
```

- `cursor` is the highest `seq` the runner has dealt with, by giving it to the agent or by skipping it. Everything after it is new.
- An item in `retry` may have 0 `attempts`: after a setup error or an outage, a new item waits there with its count unchanged.
- `paused` exists only while a setup error or an outage holds runs back: `{ since, cause, reason, next, tries }`, `cause` being `setup` or `outage`, and `tries` the failed tries in a row.
- A job of `scooter backfill` keeps its own lane, its cursor, its retries and what it gave up on, in its own file, not here ([The job's file](backfill.md#the-jobs-file)); its batches change only `paused` here, and those of an agent given in a file not even that: such a job keeps its own wait in its file.
- `lastRun` is `{ at, ok, seqs, durationMs }`, `at` being the run's start. A scheduled task is a live run too, with no `seqs`.
- An agent that has never run has `cursor` 0, empty lists, `scheduled` `{}`, and `lastRun` null.
- Times are UTC. The dates in `scheduled` are dates of the owner's day, since the schedule follows it.
- The check is strict: every field above, of its type, and no other. It refuses an item in `retry` after the cursor.

**Work items** are `in` lines from a channel one of the agent's triggers `on: new-messages` names in its `channels` ([agents.yaml](configuration.md#agentsyaml)), of kind `message`, `edit` or `delete`, of the lines this version knows ([Reading a line](datastore.md#reading-a-line)). The channels of every such trigger are the agent's, whichever trigger names one, so one cursor is enough. Everything else isn't work, and the cursor moves past it, and the agent is neither given it nor marks it: the messages Scooter sent, the reactions, the owner's among them, the lines of a channel no trigger names, and a line this version doesn't know, of a kind or a channel it doesn't have or without a field its kind needs. The agent can read any of them with `show` ([show, and the runner's skill](agent.md#show-and-the-runners-skill)). *Why the owner's reactions aren't work:* the owner, on 2026-11-21: "Leave user reactions out". A work item that is a message already deleted is the runner's to settle, and is never given ([The batch](#the-batch)).

**At a start** the runner sets the scheduled tasks' dates ([When the agent runs](#when-the-agent-runs)), and tries a pause again at once.

## Sessions

- **The session's day** is the owner's local date, or the day before while the local clock is before `SESSION_ROLLOVER_HOUR`. It goes by the clock, not by hours since midnight, so on a day the clocks change it still changes at that hour.
- **The session's ID** is `<agent>-<day>`, so a day's session ends at `SESSION_ROLLOVER_HOUR`, or when its file is removed from `sessions/`. With `session: none`, pi runs without one. A scheduled task runs in the day's session too, so the evening check-in knows what the day's runs filed.
- How a session is kept, and what a run may do to it, is in [The session's copy](run.md#the-sessions-copy).

## The batch

A batch is due retries first, then work items to give after the cursor, oldest first, at most `BATCH_MAX_ITEMS` in all (`selectCandidates` and `assembleBatch`, in `src/runner/batch.mjs`).

- **A message already deleted is never given:** one the index shows deleted when the batch is drawn. The runner settles it itself, and gives only its deletion, a work item of its own. One after the cursor is passed over, as the lines the batch covers are. One that waits in `retry` is due no more, and leaves it with the next batch, whatever comes of that run. One given up on, in `failed`, leaves it when its deletion is in the batch, as an edit or a deletion brought such a message back before. Its deletion comes after it, so the batch that settles it always comes. *Why:* issue 25, the owner's decision: "A message that is already deleted is never given: the runner settles it itself, and gives only its deletion." Nothing is to be filed from a message the owner has deleted, and its deletion, given in its turn, has the agent remove what a run filed from it, if anything.
- **An edit in the batch brings in the message it changes** when that message waits in `retry`, due or not, or is in `failed`, and isn't deleted. It joins as a retry; one taken from `failed` leaves it and starts again at attempt 1. These may take the batch past `BATCH_MAX_ITEMS`, by at most one for each edit. *Why:* otherwise the edit could be handled before the message it changes, and the retry would later file the old text. In the batch the agent takes its lines in the order of their numbers, so the message comes before its edit ([The prompt](agent.md#the-prompt)). A deletion brings in nothing: its message is already deleted.
- **The runner settles no line because of another.** A message and its edit are each marked on their own; marking one leaves the other as it was. The one exception is a message already deleted, above.
- An item in `retry` whose line isn't a work item of the agent, which only a changed `channels`, a damaged state, or a line this version no longer knows gives, is never due, and starts no batch. It waits there, with its attempts, and is given again once a trigger names its channel again. *Cost:* the lines of a channel no trigger names are no work, so those new after the cursor when the channel left every trigger, and those that arrive while none names it, are passed over for good, as the next batch's cursor goes past them.
- **What it covers:** the lines up to the first work item to give that it leaves for later, or up to the newest line. The lines in that stretch that aren't work, and the messages already deleted, are dealt with too. Where the cursor goes after the run is in [Failures](run.md#failures).
- **The newest item**, which a message `send` queued without `--reply-to` is about ([What send and mark leave](run.md#what-send-and-mark-leave)), is the item with the highest `seq`.

A batch has no limit in bytes: its prompt holds numbers, not texts, and how long a prompt can be is held at the start ([The prompt](#the-prompt)).

## The prompt

The prompt is pi's user message, the one argument after `--` ([How pi is run](agent.md#how-pi-is-run)): the `prompt` of the trigger that starts the run, as `agents.yaml` gives it ([agents.yaml](configuration.md#agentsyaml)), with each of its variables filled in, and nothing else. `src/runner/prompt.mjs` defines the variables and fills them in. The owner, on 2026-11-21: "I think the trigger should define the prompt in YAML; It should not be hardcoded."

- **Which trigger's:** a batch's is the first trigger `on: new-messages`, in the order of `run`, that names the channel of one of the lines the batch gives (`triggerOf`). The batch holds what is pending from every channel the triggers name, up to its limit ([The batch](#the-batch)). A scheduled run's is its own. A job's batches are given a live batch's, or the job's own, `--prompt`, with what the job may change ([Its batches](backfill.md#its-batches)). *Why the lines it gives:* the first trigger with a line pending from one of its channels starts the run, with its own prompt, which the owner agreed to on 2026-11-21, among the six points the plan of the agent model added to issue 25: "yes to all". Read as the lines the run is given, the prompt is always that of a channel whose lines are in it, also when the batch's limit leaves the line of another channel for later.
- **A variable** is `$`, a name of letters, dots and `_` that starts with a letter, and `$`, such as `$seq.unread$`. Any other `$` is the prompt's own text, as in "costs $5", or `$1x$`. Each variable is replaced by its value once, as it is: a value is never read again for variables, and nothing in it is read as a pattern of the replacement. *Why `_`:* `$reply_mode$`, a name issue 25 gives, holds one.

| Variable | Holds | Such as |
|---|---|---|
| `$now$` | The run's time in the owner's time zone, `SCOOTER_TZ`; in a job's batch, the time of the batch's newest line | `Monday 9 November 2026, 21:20` |
| `$user.timezone$`, `$user.currency$` | `SCOOTER_TZ` and `HOME_CURRENCY` | `Asia/Kolkata`, `INR` |
| `$reply_mode$`, `$internet$` | The agent's `reply_mode`, `quiet` or `confirm`; and `AGENT_INTERNET`, `on` or `off` ([Settings](network-policy.md#settings)) | `quiet`, `off` |
| `$agent.dir$`, `$datastore.dir$` | The agent's folder and the datastore, at the same paths inside the VM | `/data/agents/lifelog`, `/data/datastore` |
| `$seq.unread$` | The numbers of the new lines, by `seq`, a space between each | `1050 1051 1052` |
| `$seq.retry$` | The numbers of the lines given before and not finished, by `seq`, each with the attempt this run is, `, ` between each | `1047 (attempt 2 of 4)` |
| `$run.writes$` | What this run may change: the agent's `writes`, or a job's, each as a path in the VM, a folder ending in `/`, a space between each; a path that holds a space, a quote or a control character as a JSON string, so the list reads one way | `/data/agents/lifelog/views/ /data/agents/lifelog/memory/` |

A list with nothing in it reads `none`: the two lists of lines in a scheduled run, and `$run.writes$` when the run may change nothing. A line brought back from `failed` by an edit is given before, at attempt 1.

- **The numbers, not the lines.** Nothing a channel delivered goes into the prompt: no text, name, subject or path of a message's, nor a number of its own. The values are the owner's settings, Scooter's own paths, a time and the numbers of the lines. *Why:* so nothing in a message can pass for the prompt's own words, or for a flag of pi's. The agent reads each line with `show`, which prints it as stored ([show, and the runner's skill](agent.md#show-and-the-runners-skill)). A message is given as it was sent: a later edit or deletion of it is a line of its own, given in its turn, and the index file says what each is of ([The index file](run.md#the-index-file)). The owner's reactions and the messages Scooter sent aren't given, and the agent reads any of them with `show`. *Cost:* a run spends a tool call, and its tokens, to read its lines, which the prompt once showed it.
- **Checked at the start**, as any fault of `agents.yaml` is ([agents.yaml](configuration.md#agentsyaml)): a variable the runner doesn't know is a fault that names it. The owner, on 2026-11-21, of such a variable: "it errors". The system doesn't check that a prompt uses any variable: the owner, the same day, "I don't think the system needs to enforce this." So a prompt for new messages without `$seq.unread$` gives the agent no numbers to mark, and a line it doesn't mark is given again, up to `MAX_ATTEMPTS` ([Failures](run.md#failures)).
- **How long it can be.** The prompt is one command-line argument, so the runner holds, at its start, each trigger's prompt within `PROMPT_MAX_BYTES` once filled in with the longest value each of its variables can take (`longestValues`, `longestPrompt`): the settings, the paths and `writes` as they are; `$now$` at its longest; and `BATCH_MAX_ITEMS` new lines and twice as many given before, the due retries and the messages their edits bring in, each `seq` and attempt of the most digits a safe integer has. One past the limit is a fault that says how long it can be. A job's prompt, its own or the trigger's, is held so too, with `$run.writes$` the job's writes, which can be longer than the agent's, when the job is written and when the runner takes it ([The command](backfill.md#the-command)). *Why:* Linux refuses a single argument of 128 KB or more: in a VM from the image, a prompt of 131,071 bytes reached the model whole, and one of 131,072 never started, exit code 127 and `exec failed` on stderr, with no request (`pi 7` in `test/tools/pi.test.mjs`); on Ubuntu 24.04 an argument of 120,000 bytes worked and one of 140,000 failed, "Argument list too long". Thirty arguments of 100 KB each were taken together, so only the single argument matters. A prompt over it would look like a crash of pi in every run of its trigger, and use the attempts of its lines.
- **What pi can't be given.** A prompt that holds U+0000, which no command line can carry, or half of a pair of UTF-16 surrogates, which is no character, is refused at the start, and so is one that starts with `@`: pi 1.5.2 takes an argument that starts with `@` as the name of a file to attach, after `--` too, and with no such file fails before any request (`pi 9` in `test/tools/pi.test.mjs`). No variable's value starts with `@`. Anything else reaches the model as it is: a prompt that starts with `/`, `!` or `-`, a variable's path among them, and the patterns a JavaScript replacement reads, such as `$&`. `/skill:` and the name of one of the run's skills, at its start, puts the skill's text in the message ([Facts about pi 1.5.2](agent.md#facts-about-pi-152)).

The default prompt for new messages ([agents.yaml](configuration.md#agentsyaml)), filled in for a batch of #1050 to #1054, new, and #1047, given a second time, at 21:20 in Kolkata, with the data folder at `/data`:

```text
Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.
Your folder: /data/agents/lifelog
The datastore: /data/datastore
This run may change: /data/agents/lifelog/views/ /data/agents/lifelog/memory/
Given before: 1047 (attempt 2 of 4)
New: 1050 1051 1052 1053 1054
```

**The system prompt** is pi's own, with the run's copy of the agent's prompt appended ([How pi is run](agent.md#how-pi-is-run)): the runner adds nothing to it. What the system says to the agent is in the runner's skill ([show, and the runner's skill](agent.md#show-and-the-runners-skill)), and the memory files are the agent's to read, as its prompt says ([Memory](agent.md#memory)): the runner reads nothing in `memory/`.

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

