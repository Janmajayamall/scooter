# Agents, runs and backfills on a simpler model

Status: active. Written 2026-11-21 from [issue 25](https://github.com/Janmajayamall/scooter/issues/25), which holds the owner's decisions of that day. The workflow [`agent-model.workflow.js`](agent-model.workflow.js), beside this plan, runs it.

Every agent of this work is new, remembers nothing, and starts here. Read this plan whole, then issue 25 (`gh issue view 25`), then `AGENTS.md` and what it tells you to read. Your prompt gives your role, implementer, reviewer or fixer, and a piece's number. [How the work runs](#how-the-work-runs) says what each role does, the piece's own heading says what the piece covers, and [This machine](#this-machine) says how to run things here.

## Why

Scooter was built with the runner knowing a good deal about one agent, lifelog: its views, its day pages, its memory files, the format of its answers. The owner reviewed issues 16 and 17, which asked to remove the day pages and the WhatsApp commands, and decided to go further. The system is to know three things about an agent: its skills, the paths it may read, and the paths it may write. Everything else about lifelog lives in lifelog's own prompt and skills.

Scooter has never been run for real. There is no install, no datastore and no state to carry over, so nothing in this work keeps backward compatibility: no code reads an old `state.json`, an old `agents.yaml` or a line this work stops writing, except as [piece 3](#piece-3-the-datastore-two-checks-and-data) says for the datastore from then on.

## What is built

Issue 25 is the record of what was decided, and this plan says how it is built and in what order. In short:

- **Gone:** day pages, the four WhatsApp commands, `once` triggers, `backfill` triggers, `scooter rebuild`, the answer format and its parser, the rendered prompt, the protocol that ships with the runner, and the runner's reading of the memory files.
- **The datastore** is checked one way when written and another when read, and keeps what only the agent reads in a `data` object.
- **`agents.yaml`** gives each agent `reads`, `writes` and `sends`, and each trigger its `channels` and its own `prompt`, with variables.
- **A run** gets numbers, not rendered messages. In its VM the agent has three commands: `show` to read a line, `send` to say something to the owner, `mark` to say what became of a line. The runner acts on what `send` and `mark` left, once the run has passed.
- **`scooter backfill`** queues a job that runs an agent over history, with its own scope.
- **`scooter status`** prints what `/status` replied.

### Where this plan goes beyond the issue

The issue was silent on these, or a later decision of the owner's changed what one of its sentences rested on. The owner agreed to all six on 2026-11-21, "yes to all", and the issue was brought up to date with them. Put each beside the rule it settles in the documents, with its reason, as `AGENTS.md` says for a choice the documents didn't settle.

1. **The three commands ship with the runner, and each run gets a copy.** The issue says they are in the VM image. They are files of the runner's, copied into `run/` for each run, as the prompt and the skills are, and found on the VM's `PATH`. *Why:* a command and the runner must agree on the index file, the marks and the entries, and an image is built at another time than the runner is installed; and the fake sandbox can then run the same files. No piece changes `config/image/build.json`.
2. **`sends` is enforced where a message's channel is chosen.** The runner can't tell which channel an entry will go out on: the bridge chooses it. So an agent's entry carries the channels it may go out on, and the bridge drops and logs one whose chosen channel isn't among them ([piece 4](#piece-4-what-an-agent-may-read-write-and-send)).
3. **A channel is named by one trigger at most.** The first trigger in `run` with a line pending from one of its channels starts the run, and the run uses that trigger's prompt. It is given everything pending from every channel the agent's triggers name.
4. **Only what lies in the agent's own folder is in its repository.** A path of `writes` outside `agents/<name>/` is mounted writable and otherwise left alone: not checked, not committed, and not put back after a failed run.
5. **A job that holds live runs back replays in order.** The issue ties this to `memory/` being among `writes`. The runner no longer knows what memory is, so the rule hangs on `--hold-live`: such a job waits for a line that is being tried again before it takes the lines after it, as a rebuild does today.
6. **A job is cancelled by removing its file.** The runner drops what it holds of the job at its next poll.

## The owner's answers

Given on 2026-11-21, while reviewing issues 16 and 17. Quote the one a rule rests on beside that rule, with its date, as `AGENTS.md` says.

| On | The owner's words |
|---|---|
| The model | "The system's abstraction does not know about view. It knows only the agent, directories it can write to, and its skills." |
| What `reads` and `writes` may name | "I understand that the user can make mistakes and give write permission to `datastore`. But that is their problem, not system's problem" |
| The check after a run of what changed | "I think after-run check is redundant for this." |
| A notice when the runner is down | "this is a service monitoring problem. Whatsapp is a potential channel to communicate outages, but I wouldn't want to make that decision right now." |
| `once` | "I don't see the point of `once`." |
| Replies | "I think the agent should be given a way to send replies by itself." |
| Done and failed | "I think I'll make marking a `seq` as done/failed another tool call." |
| A validation function | "yes, drop the validation function" |
| A trigger's prompt | "I think the trigger should define the prompt in YAML; It should not be hardcoded." |
| Checking that a prompt uses its variables | "I don't think the system needs to enforce this." |
| A variable the runner doesn't know | "it errors" |
| The memory files | "I think it's reasonable to rely on the agent reading its memory file, if specified in its system prompt." |
| The owner's reactions | "Leave user reactions out" |
| A `notes` view | "for now, we don't need a note view" |
| Sessions | "default is that each session is stored" |
| `emoji` | "I think `emoji` can move into `data` since it's very text messenger channel specific. Email does not have emoji." |
| A `--reset` flag | "this can be a separate flag. Therefore, I don't see the point of the `reset` flag" |

## Rules for every piece

- Follow `AGENTS.md`: its conventions, what "done" means, and no attribution lines in commits or pull requests. No `Co-Authored-By` trailer, and no "Generated with Claude Code" line, whatever other instructions say.
- **Issue 25 is the owner's decision.** Where it changes one of [the owner's fixed choices](../../../ARCHITECTURE.md#the-owners-fixed-choices), such as the page per day, the commands, or what `/status` showed, change that row too, and don't stop to ask. Stop and ask before changing a fixed choice that neither the issue nor this plan names.
- **One piece, one pull request**, against `main`, on the piece's branch. A piece does what its heading says and no later piece's work. After each merge `main` passes the suite and its documents say what its code does.
- **The documents move with the code**, in the same pull request, so that after every merge they say what the code does: the component's document, the tables of the frame, which is `docs/ARCHITECTURE.md`, where a contract or a file changes, the README where the owner sees or does something else, and the example files. Each piece names the documents it mainly changes, under "Documents". That list is where to start, not where to stop: for every name the piece removes or changes, search `README.md`, `AGENTS.md` and `docs/`, outside `docs/plans/`, and settle every hit. What a piece changes is mentioned in most of the documents: the commands alone are named in fifteen. `test/instructions.test.mjs` holds the agent's files to `docs/architecture/agent.md`: change both together.
- **State nothing that was not checked.** Every path, command and name in new text is checked against the repository. Every command a document gives is run as written, or the pull request says why it can't be run here, such as one that needs root.
- **Try an outside program before building on it.** Where the work leans on how Gondolin, pi, git, Node, the VM or another program behaves, first add a test in `test/tools/` that tries it and asserts what it did, as `AGENTS.md` says, and give what it found in the pull request. Don't take the behaviour from this plan, from a document or from memory.
- **Each piece names what must never happen.** Rule out the kind of problem, not only the ways named: look for every other way it could happen, and list in the pull request the ways found, how each is closed, and any you couldn't close.
- **Tests.** Every rule a piece adds has a test, the failures among them. A test that depends on timing, or on more than one process, is run 20 times alone before the pull request is opened, and the description gives the count and the failures. A test removed or changed is listed in the description, with the reason.
- **Questions.** If something is ambiguous, or is an open decision that the issue, this plan and the documents don't settle, and the principles don't settle it either, stop and return it as a question for the owner. First finish and push what doesn't depend on the answer, and put all your questions in one return. An answer that comes back goes beside the rule it settles, quoted with its date.
- Leave the files under `docs/plans/completed/` as they are. Don't change this plan or its workflow: if the plan is wrong, say so in the pull request, or ask.

### What must never happen, in any piece

They are stated in full here. Each piece's own heading says again, in words, the ones that bear on it, with the ways known so far.

1. **Something the agent leaves stops the runner.** Nothing pi does or leaves, in any folder or file it can write, may stop the runner, at the end of the run or at the next start; make it wait without a limit; or make it give the same lines again without counting an attempt. The four rules of [A run, and the agent's folder](../../../architecture/run.md#the-clean-up) hold for everything pi can write, new folders included: limit what is accepted before anything reads it; put back what git doesn't record; fail the run, don't stop the runner; and make the clean-up unstoppable.
2. **A process with more rights follows a path that one with fewer controls.** Root, the bridge's CLI commands among it, reads, copies and removes in a folder another user controls only by the rules of [Folders other users control](../../../ARCHITECTURE.md#folders-other-users-control). The runner treats every file pi could have written the same way.
3. **A stop, a crash or a full disk between two steps that belong together loses something, or repeats something without end.** A hand-off is atomic. Where two steps can't be, their order is the one whose crash only repeats work, and the document says what a crash between them costs.
4. **Something is left of what a piece removes.** No code path, setting, field of a strict format, test, comment or sentence of a document still serves or names it.
5. **What a piece doesn't name changes.** Behaviour outside the piece stays as it is, and its tests pass unchanged.

## The pieces

In this order, each from the `main` the one before it left.

| # | Piece | Branch |
|---|---|---|
| 1 | Day pages and `once` go | `agent-model-1` |
| 2 | The commands go, and `scooter status` comes | `agent-model-2` |
| 3 | The datastore: two checks, and `data` | `agent-model-3` |
| 4 | What an agent may read, write and send | `agent-model-4` |
| 5 | The index file and `show` | `agent-model-5` |
| 6 | `send` and `mark`, in place of the answer | `agent-model-6` |
| 7 | Prompts in `agents.yaml`, and what a run is given | `agent-model-7` |
| 8 | `scooter backfill`, in place of the trigger and `rebuild` | `agent-model-8` |
| 9 | The frame, the README, and a last check | `agent-model-9` |

Each piece's pull request has the title "Agent model, piece N: " and the piece's name from this table.

## Piece 1: day pages and `once` go

**Build.**

- **Day pages.** Remove the `day-pages` skill and every mention of a day page: in `config/prompts/lifelog.md` (lines 3, 11, 13, 15, 20 and 23 today), `config/skills/travel/SKILL.md` (line 34) and `config/skills/meals/SKILL.md` (line 19), `config/agents.yaml`, `src/runner/protocol.md`, the backfill's code (`DAY_PAGES`, `mayChange`, `backfillSkills`, `backfillIntro`, and `DAY_PAGES_SKILL` and the rules on `views/days/` in `config.mjs`), the tests, `AGENTS.md`, the README and the documents. A backfill then gets its own skill alone, and may change only what its `writes` names.
- **No `notes` view.** Lifelog's prompt says that a message which fits no view has nothing filed, and is reported done.
- **`once`.** Remove the trigger, `onceDone` from the state's format, and what a rebuild did with it.

**Documents.** Mainly `docs/architecture/agent.md` (the skills' table, the template, the prompt's list of views), `rebuild-and-backfill.md` and `configuration.md` (what a backfill may change, the triggers), `runner.md` and `run.md` (the state, the tasks), the frame, `AGENTS.md` and the README; and every other that the search finds.

**What must never happen.** **Something is left of what the piece removes**, or **what the piece doesn't name changes**. Known ways: a test fixture or the pi stub still writes a day page; `test/instructions.test.mjs` still takes the day page's template from `docs/architecture/agent.md`; a document still counts six skills or six views; the word "page" in a rule about something else, such as a PDF's pages, is removed by a search and replace; the stub's own `views/notes.csv`, which is a test's file and not a view of lifelog's, is taken for one; `once` as an English word is removed from a sentence. Look for every other way.

**The review checks.** A search of the whole repository, outside `docs/plans/`, for what the piece removed, by every name it had. The suite, three runs. That a backfill's batch which changes a file outside its `writes` still fails, and one that changes a file inside them passes.

## Piece 2: the commands go, and `scooter status` comes

**Build.**

- **The commands.** Remove `/status`, `/backup`, `/help` and `/new`: the bridge's and the runner's handling of them, `takesCommands` on the channels, the `command` kind of line and `COMMANDS`, and `commandSeq` in both states. A text such as `/status` is then an ordinary message. A session's ID is `<agent>-<day>`, and the state's `session` field goes with `/new`. Sessions stay as they are otherwise: `session` is the owner's choice for each agent, `daily` by default, and a day's session ends at `SESSION_ROLLOVER_HOUR`.
- **`scooter status`**, a CLI command of the bridge's side, prints the report `/status` gave. The running bridge writes its live part, each channel's status and the backups, to `bridge/status.json`, atomically, whenever it changes. The command reads only files: that one, the datastore, and the runner's three files as today. It works with the bridge stopped, and says when the bridge last wrote. In Docker it runs as `docker compose run --rm bridge status`.
- **Backups.** `SIGUSR1` is the one way to ask for a backup. A failed backup's notice says when the next one is, and names no command. The `/backup` request, its replies and the texts that named a command go.
- **No notice on WhatsApp when the runner is down.** Quote the owner's answer beside it, and say what shows it instead: the logs, and `scooter status`.

**Documents.** Mainly `docs/architecture/bridge.md` (its Commands and /status sections, its state), `runner.md` (Commands, State, Sessions), `backups.md` (asking for a backup), `datastore.md` (the line format), `configuration.md` (the CLI's table), the frame's diagram, contracts and glossary, and the README's table of commands; and every other that the search finds.

**What must never happen.**

- **A process with more rights follows a path that one with fewer controls.** `scooter status` runs as root on a native install, and reads files the runner's user controls. It reads them as the bridge's `/status` did. Known ways it could go wrong: a FIFO or a link in place of `runner/status.json` or an agent's `state.json`; a file larger than its limit; an agent's name that leads a path elsewhere. Look for every other way.
- **The command changes nothing.** It takes no lock and no socket, writes no file, and can run while the bridge runs, while a backup runs, and beside a second copy of itself.
- **`bridge/status.json` holds no secret**, and nothing in the report does.
- **A stop or a crash between two steps that belong together loses something.** A bridge that stops between a change and the write leaves the last file, which says when it was written.
- **Something is left of the commands.** Known ways: a `command` kind in a strict format, such as the line's, the index's or a record's; a test's datastore holding a command line; a notice or a document telling the owner to send one; the planner's first step; the README's table.

**The review checks.** `scooter status` run in a development data folder, with the bridge running and with it stopped, and in the root run. The search, as in piece 1. The suite, three runs.

## Piece 3: the datastore: two checks, and `data`

**Build.**

- **Two checks.** The store's check of a line it writes stays as strict as it is. A reader checks only what every reader depends on: `seq`, one more than the last; `dir`; `at`; that `kind` and `source` are names; and the type of each field this version's code acts on, where the line has it. A line of a kind or a channel this version doesn't know is kept in the index and passed over, as the cursor passes over a line that isn't work. A top-level field this version doesn't know is ignored.
- **A channel that is gone.** A reply about one of its lines goes to `DEFAULT_CHANNEL`, as a reply about an email does.
- **`data`.** `subject`, `quoted`, `forwarded` and `emoji` move into `data`, a JSON object on the line that the datastore doesn't look into. A channel's record carries its own `data`, and the rule that an email has a subject moves into the email channel. Delivery fills `data.emoji` on the line of a reaction Scooter sent. The outbox entry keeps its own `emoji` field: that is another contract. `text`, `files`, `media`, `trust` and `by` stay top-level, for the reasons issue 25 gives.
- **The rule from here on**, in the datastore's document: stop writing a kind, a channel or a field, and keep reading it.

**Documents.** Mainly `docs/architecture/datastore.md` (the line format, reading, the rules), `bridge.md` (the record), `email.md`, `whatsapp.md`, `delivery.md` (choosing the channel) and `run.md` (the notices); and every other that the search finds.

**What must never happen.**

- **A line this version doesn't know stops a service, or misleads it.** Neither the bridge nor the runner may stop, or act wrongly, on a line of a kind, a channel or a field it doesn't know, or on anything at all in `data`. Known ways: the index, delivery, the status report or a notice reads a field that the reading check doesn't guarantee; an edit, a deletion, a reaction or a reply points at a line of an unknown kind; the duplicate rules meet one; `data` is missing, is a list, or holds a `subject` that isn't a string, where the "✅ Email:" text and the notice about a message given up on read it; a reply is routed by a `source` that no channel has; a count of pending lines takes an unknown line for work. Look for every other way.
- **The store writes a line the strict check refuses.** Loosening the reader must not loosen the writer.
- **Something is left of the four fields at top level.**

**The review checks.** A datastore written by hand that holds, among ordinary lines, a line of an unknown kind (the old `command` will do), one of an unknown channel, one with an unknown top-level field, and several kinds of wrong `data`: both services start on it and go on, the cursor passes it, and a reply about each goes out. Every place that reads a field of a line, checked against what the reading check guarantees. The suite, three runs.

## Piece 4: what an agent may read, write and send

**Build.**

- **`reads` and `writes`** in `agents.yaml` name files or folders, relative to the data folder. Left out, `reads` is the whole datastore and the agent's own folder. No list limits what either may name: quote the owner's answer beside it.
- **`channels`** on an `on: new-messages` trigger says which channels' messages start a run, and takes the place of the agent's `reads` as a list of channels. More than one such trigger is allowed, and a channel is named by one at most. The runner's `status.json` gives the channels under that name.
- **`sends`** lists the channels the agent's messages may go out on, in place of `can_message`. An entry of the agent's carries them, and the bridge drops and logs an entry whose chosen channel isn't among them. An empty list sends nothing of the agent's. The runner's and the bridge's own entries carry none, and go out as today.
- **The mounts** of a run come from them: what `reads` names read-only, what `writes` names writable, and, whatever the two say, what a run needs of its own: `run/` read-only, with the run's own writable folders in it. `sessions/` is always hidden.
- **The sandbox enforces `writes`**, files as well as folders: for each run it lets through only that run's `writes`, through a provider that refuses every changing operation on any other path, as Gondolin's `ReadonlyProvider` refuses them all. A write elsewhere fails inside the VM, and the run goes on. A backfill's `writes` narrows its own runs the same way: until piece 8 removes the trigger, its `writes` takes paths of the same form, and they lie inside the agent's own `writes`.
- **The comparison after a run** of what changed against what was allowed goes: `mayChange`, and the failure it made.
- **The agent's repository** holds what `writes` names inside the agent's own folder, in place of the fixed `views` and `memory`: those paths are what the file check walks, what is committed, and what the clean-up puts back. A path of `writes` outside the agent's folder is mounted and otherwise left alone, and the document gives that as its cost.

**Documents.** Mainly `docs/architecture/configuration.md` (`agents.yaml`), `sandbox.md` (the interface, the mounts), `run.md` (after a successful run, the clean-up, the agent's folder), `runner.md` (when the agent runs, `status.json`), `exchange.md` (outbox entries), `delivery.md` (choosing the channel), and the frame's table of folders; and every other that the search finds.

**Facts to check first**, as tests in `test/tools/vm.test.mjs`, in a VM: that a provider of this kind refuses each changing operation outside the allowed paths, among them `open` for writing, `mkdir`, `rmdir`, `unlink`, `rename` from and to, `link`, `symlink`, `chmod` and `truncate`, and allows each inside them; that a file which doesn't exist yet can be made at an allowed path and nowhere beside it; and what the VM sees when the write is refused.

**What must never happen.**

- **The VM changes something `writes` doesn't name.** Known ways: an operation the provider doesn't cover; a rename from an allowed path to another, or the other way; a hard link or a symbolic link to a path outside; an allowed file replaced by a folder, or a folder by a file; a path given with `..`, a doubled `/` or a link in it; an entry of `writes` inside an entry of `reads`, and the other way round; an entry of a backfill wider than the agent's own. Look for every other way.
- **Something the agent leaves stops the runner**, in any path of `writes`, whatever it is. Known ways: an entry that is one file, which pi removes, replaces with a link, a FIFO or a folder, or gives a second name; an entry that doesn't exist when the runner starts; one entry inside another; an entry outside the agent's folder, which the runner must never read; the clean-up's setting aside, which today renames two folders it knows; the limits on count and size, which are on the two folders together today. Look for every other way.
- **An agent's message goes out on a channel `sends` doesn't name.** Known ways: a reply about an email, which goes out on the default channel; a text that replies to nothing; a reaction; an entry written by a runner of before this piece.
- **Something is left** of `can_message`, of the agent's `reads` as channels, or of the fixed names `views` and `memory` in the runner's code.

**The review checks.** The provider's tests run in a VM, and then tries of the reviewer's own from inside a VM to change a path outside `writes`. An `agents.yaml` whose `writes` name one file, a folder inside another entry, and a path outside the agent's folder: a run on each. That nothing the agent leaves there stops the runner, tried again on those, with the stub's keywords that leave what git won't take. The suite, three runs.

## Piece 5: the index file and `show`

**Build.**

- **The index file.** Before each run the runner writes its index into `run/`, one line for each `seq` in the log: where the line is, its kind, and the line it points at, if any.
  ```text
  1051 /data/datastore/2026/11/09/log.jsonl:213 message
  1054 /data/datastore/2026/11/09/log.jsonl:216 edit 1051
  ```
- **`show <seq>…`**, a program that ships with the runner. Each run gets a copy in `run/`, found on the VM's `PATH`. It prints what issue 25 shows: each line as stored, under a header with its `seq`, its time in the owner's time zone and where it is; each attachment with its full path; and the one line it points at through `replyTo` or `target`. One hop only, and nothing that points back at the line. A number that isn't in the run's index file prints "no such line", and the command fails.
- **A skill that ships with the runner**, which every run is given beside the agent's own. It describes `show` and the format of a line. A test holds it to `line.mjs`. `agents.yaml` refuses an agent's skill of the same name.
- Nothing else changes in this piece: the prompt is still rendered, and the answer still read.

**Documents.** Mainly `docs/architecture/agent.md` (how pi is run, the skills), `run.md` (what `run/` holds), `sandbox.md` (the environment), `datastore.md` (reading), and the frame's map, for the new files; and every other that the search finds.

**Facts to check first**, in a VM: that a program copied into `run/` runs by its name from the `PATH` the runner gives, also from a program pi's `bash` tool starts; and that `TZ` gives it the owner's local time.

**What must never happen.**

- **`show` prints something the log doesn't hold, or prints the wrong line.** Known ways: the log grows during the run; a line longer than a buffer; a text with line breaks or bytes that aren't UTF-8; an attachment's name with a space; the newest day's log ending in half a line; a time printed in UTC, or wrong across midnight or a change of the clocks; a line of a kind the reader passes over. Look for every other way.
- **pi changes the index file or the program.** They are read-only in the VM, and the runner reads neither back.
- **What the piece doesn't name changes:** a run's outcome is what it was before this piece.

**The review checks.** `show` run by hand against a datastore with every kind of line, a reply, an edit of a line in an earlier day's folder, an email with two attachments and a line of an unknown kind; and in a VM, through pi's `bash`. The index file compared with the log, line by line, for a datastore of several days. The suite, three runs.

## Piece 6: `send` and `mark`, in place of the answer

**Build.**

- **`send [--reply-to <seq>] "<text>"`**, shipped and copied as `show` is. It takes the text from standard input when none is given. It writes an entry into a folder of `run/` that is writable for that run.
- **`mark done <seq>…`** and **`mark failed <seq> "<reason>"`** write into a file of the run.
- **After a run that passed**, which is pi exiting with 0 and its files passing the check, in this order: the commit; the session; the outbox, from what `send` left; the state, from the marks; the ✅, in quiet mode, for each message marked done that the run didn't reply to; the packing.
  - A `seq` marked done is finished. One marked failed is given up on, and not tried again. One marked neither way is given again, up to `MAX_ATTEMPTS`. One marked both ways is failed. One the run wasn't given is ignored and logged.
  - At most `ANSWER_MAX_TEXTS` entries of one run go out, the first ones, and the rest are dropped and counted in the log. Give the constant a name that fits.
  - A scheduled run's marks are ignored and logged. A backfill's or a rebuild's entries are dropped: a replay sends nothing.
- **After a run that failed**: nothing it asked to send goes out, its marks count for nothing, and every line it was given has used an attempt, as today.
- **The answer** is no longer read: `answer.mjs` goes, and nothing in pi's output decides anything or reaches a log.
- **The protocol** is split, and `src/runner/protocol.md` goes. What describes the system, the three commands, the line format, and what the VM can write and reach, goes into the skill that ships with the runner. What describes lifelog, best guesses, ❓, the open questions, standing instructions, goes into `config/prompts/lifelog.md`.
- **The memory files** are no longer read into the system prompt. Lifelog's prompt tells the agent to read them before anything else.
- **The pi stub** reports through `send` and `mark`, by running the shipped programs.

**Documents.** Mainly `docs/architecture/agent.md` (the protocol, the memory), `run.md` (reading the answer, after a successful run, failures), `runner.md` (the system prompt), `exchange.md`, and the frame's contracts; and every other that the search finds.

**What must never happen.**

- **Something the agent leaves stops the runner**, in the run's own writable folders. The runner reads what `send` and `mark` left as files pi controls. Known ways: the marks file, or an entry, is a link, a FIFO, a folder, unreadable, or larger than its limit; a million entries; a tree too deep to remove; a name that isn't UTF-8; a full disk; an entry whose JSON is valid and whose text is a megabyte, or holds U+0000; a `--reply-to` that names a reaction, a line Scooter sent, or no line at all; a mark with a number of twenty digits. What is there is removed before the run is recorded, as `run/session/` is. Look for every other way.
- **A failed run sends something, or settles a line.** Known ways: the runner stops between pi's exit and the check; the check fails after the entries were read; a run that timed out after marking.
- **A stop or a crash between two steps of the order above loses something, or repeats it without end.** A crash between the outbox and the state gives the lines again, and the agent may then ask a second time: say so as the cost, since the context that showed the agent what it had sent goes in piece 7.
- **A message is settled by anything but its own mark.**
- **Something is left of the answer format**, in the code, the stub, the agent's files or the documents.

**The review checks.** That nothing the agent leaves stops the runner, tried on the run's folders, with each known way and others of the reviewer's own. A run that fails at each step after pi's exit: nothing sent, nothing settled, an attempt counted. The three commands run by hand, with texts that hold quotes, line breaks and `$`. The suite, three runs, and each new test that depends on timing 20 times.

## Piece 7: prompts in `agents.yaml`, and what a run is given

**Build.**

- **A `prompt` for each trigger**, the message pi is given for that run, in place of `task` and of the prompt the runner rendered. A variable is `$`, a name of letters and dots, and `$`. One the runner doesn't know is a fault of `agents.yaml`, reported at the start as any other. The system doesn't check that a prompt uses any.

  | Variable | Holds |
  |---|---|
  | `$now$` | The run's time in the owner's time zone; in a backfill, the time of the batch's lines |
  | `$user.timezone$`, `$user.currency$` | `SCOOTER_TZ` and `HOME_CURRENCY` |
  | `$reply_mode$`, `$internet$` | `quiet` or `confirm`; `on` or `off` |
  | `$agent.dir$`, `$datastore.dir$` | The two paths inside the VM |
  | `$seq.unread$` | The numbers of the new lines: `1051 1054 1060` |
  | `$seq.retry$` | The numbers of lines given before and not finished, each with its attempt: `1047 (attempt 2 of 4)` |
  | `$run.writes$` | What this run may write |

  A list with nothing in it reads `none`.
- **What a run is given.** The lines after the agent's position that are work, a message, an edit or a deletion from its triggers' channels, and those waiting to be tried again, at most `BATCH_MAX_ITEMS`.
  - A message that is already deleted is never given: the runner settles it itself, and gives only its deletion.
  - An edit or a deletion of a message that was given up on brings the message back, at its first attempt, as today.
  - The runner settles no other `seq` because of another.
- **Gone:** the rendered prompt with its sections, the context, the texts cut to fit, and "as it is now". A message carries nothing about a later edit or deletion: the edit and the deletion are lines of their own, and the index file says what each is of. The owner's reactions aren't work, and aren't shown to the agent.
- **The default files.** `config/agents.yaml` gives each trigger its prompt, and `config/prompts/lifelog.md` says how lifelog works now: read the memory files first; read each line with `show`; for an edit or a deletion, look up the line it points at and change or remove what was filed from it, if anything; mark every `seq` given, and only those. A backfill's run uses the prompt of the agent's trigger for messages, so that prompt carries `$run.writes$`.

**Documents.** Mainly `docs/architecture/runner.md` (the batch, the prompt, when the agent runs), `configuration.md` (the triggers), `agent.md` (the prompt) and `rebuild-and-backfill.md` (replayed batches); and every other that the search finds.

**What must never happen.**

- **Something a channel delivered is in the prompt.** The prompt holds the owner's template, the runner's own settings, and numbers. No text, name or path that came from a message enters it, so nothing in a message can pass for the prompt's own words or for a flag of pi's. Known ways: a file's name, a subject, a reason a run gave for a failure. Look for every other way.
- **A line is lost, or given without end.** Every line that is work is given until it is marked, or has used its attempts. Known ways: the message that is already deleted, whose deletion must still be given, also when the message waits to be tried again or was given up on; an edit that arrives while its message waits; a batch cut at its limit between a message and its edit; a restart between two batches; a channel that left every trigger's `channels` while its lines waited.
- **A prompt can't be given to pi.** It is one argument, and Linux refuses one of 128 KB. Known ways: a long template; a variable in a value; `$` in the owner's own text, as in "$5".
- **Something is left** of `task`, the rendered prompt or the context.

**The review checks.** The default prompt, rendered for a batch and for a scheduled run, read for what it tells the agent. The lost-line rule, tried with deletions and edits in every order against a message that is new, waiting, given up on and done. A dry run in a VM with the stub, from a WhatsApp message to its ✅. The suite, three runs.

## Piece 8: `scooter backfill`, in place of the trigger and `rebuild`

**Build.**

```text
scooter backfill <agent> [--from <UTC date or seq>] [--skills <names>] [--writes <paths>] [--empty] [--hold-live]
scooter backfill --agent-file <file> [--from <UTC date or seq>]
```

- **A job, not a setting.** The command runs as the runner's user. It checks its arguments against `agents.yaml`, writes a job file into the agent's folder, atomically, and exits. The running runner takes the job at its next poll, with no restart. The job holds its own position, its retries and what it gave up on, so it goes on after a restart. Jobs of an agent run one at a time, in the order they were written. `state.json` loses `backfill` and `backfillDone`, and `scooter status` shows a job and how far it has got.
- **An agent of `agents.yaml`** can be run with fewer skills and narrower writes. `--writes` names paths inside the agent's own `writes`.
- **An agent given in a file** is one agent in the format `agents.yaml` gives one. Its name is no agent's of `agents.yaml`, its `writes` lie inside its own folder, `agents/<name>/`, which the runner makes, and it sends nothing.
- **`--from`** is a UTC date, the day folder a line was stored in, or a `seq`. The job stops at the agent's position when the job starts, and for an agent given in a file, at the newest line then.
- **`--empty`** clears what the job's `writes` name, and commits that, before the first batch.
- **`--hold-live`** makes live runs wait until the job has finished, across restarts too, and makes the job replay in order: it waits for a line that is being tried again before it takes the lines after it. Without the flag, a batch of the job starts only when nothing live is waiting.
- **Before any job** the runner tags the agent's last commit.
- **When a job has finished** the runner sends one message, which says how many lines the job was given and which it gave up on. It counts no CSV rows.
- **Kept from today's replays:** a batch is one of the owner's days; `$now$` is the batch's own time; a job's runs send nothing; a job has sessions of its own, one for each of the owner's days, which go when it is over; a setup error or an outage pauses every run.
- **Gone:** the `backfill` trigger, `scooter rebuild`, and `src/runner/rebuild.mjs`.
- **The README** says how to file a new skill's history, how to file everything again from empty, how to try a prompt against history with an agent of its own, and how to cancel a job.

**Documents.** Mainly `docs/architecture/rebuild-and-backfill.md`, written again, `configuration.md` (the CLI, the triggers), `runner.md` (the state, when the agent runs), `shared-code.md` (who holds the runner's socket), `bridge.md` (the status report) and the README; and every other that the search finds.

**What must never happen.**

- **A job changes something outside its `writes`, or sends something.** The sandbox holds the first, as for any run.
- **A job and live runs meet wrongly.** With `--hold-live` no live run starts before the job has finished, after a restart or a pause either. Without it, a message never waits for more than the batch in progress. Known ways: a job taken while a run is in progress; a scheduled run that comes due; two jobs of one agent; a job of a second agent; a backup's lock.
- **A line of the job's range is given twice, or never.** Known ways: `--from` as a date with no day folder of that date; a `seq` past the newest line; a line caught up late, whose own time is earlier than its day folder's; a restart between two batches; the job's file rewritten while the runner holds it.
- **A stop, a crash or a full disk between two steps that belong together loses something, or repeats it without end.** Known ways: a crash after the tag and before `--empty`'s commit; after the last batch and before the message; after the message and before the job is marked finished, which sends it twice and never loses it; a full disk when the job's file is saved.
- **A job's file stops the runner.** The runner's user writes it, and the runner still reads it as it reads its own state: strictly, and a file that isn't a job is refused and logged, without stopping the runner.
- **Something is left** of the trigger, of `rebuild` or of their state.

**The review checks.** Each of the README's four procedures run as written against a development data folder, with the fake sandbox. A job stopped and started again at each step. `--hold-live` with messages arriving meanwhile. The suite, three runs, and each new test that depends on timing 20 times.

## Piece 9: the frame, the README, and a last check

**Build.**

- **`docs/ARCHITECTURE.md`**, read whole against the code: what Scooter does, the path of one message, the map, the boundaries, the contracts, the glossary, the table of changes, the owner's fixed choices, and what is deferred. Every file under `src/` is in the map once.
- **`AGENTS.md`**: what Scooter is, and the conventions for tests that name what changed, such as the stubs.
- **The README**, read whole: daily use, the agent's instructions and how to add a skill, backups, backfills, what to do when something goes wrong, the known limits, development with its counts, and the list for the first real run, which gains what only a real model can show: that the agent reads its memory files first, and uses `show`, `send` and `mark` as its instructions say.
- **The example files**: `config/agents.yaml`, `bridge.env.example` and `runner.env.example`.
- **The smaller points** of the reviews of pieces 1 to 8 that are still open.

**What must never happen.**

- **Something in `AGENTS.md`, `docs/ARCHITECTURE.md` or the README is false, or was not checked.** Every path, command and name exists as written, every command runs as written or says why it can't here, and what they say the code does, it does.
- **A link between documents leads nowhere**, and a file under `src/` is missing from the map or listed twice. Check both by script, as the completed plan `docs/plans/completed/docs-restructure/docs-restructure.md` describes under "The checks by script", and put the scripts in the pull request.
- **Something is left of what pieces 1 to 8 removed.** No code path, setting, field of a strict format, test, comment or sentence of a document still serves or names it.

**The review checks.** Every path, command and name of the three documents against the repository, with every command that can run here run as written. The two scripts. A search for each thing pieces 1 to 8 removed. The suite, three runs.

## How the work runs

The workflow runs a piece through implement, review, fix and review again, for at most two reviews. An approved pull request is merged into `main`, and the next piece starts from the new `main`. The workflow stops and returns to the owner on a question, on a pull request not approved after two reviews, on a merge that fails, and when an agent returns nothing. The implementer and the fixer run on Opus 5.5, and the reviewer on Fable 5.2, all at the `xhigh` effort level.

### The implementer

- Work on the piece's branch, cut from the latest `origin/main`, in the checkout at `~/scooter`. If the branch or its pull request exists already, read the pull request's description and comments and the branch's commits, and continue from there.
- Read the reviews on the pull requests already merged for this work, from the branches `agent-model-1` onwards. Settle the smaller points in them that are still open and that your piece touches, and say in your pull request which you settled and which you left.
- Do the piece's "Facts to check first" before the code that leans on them.
- Commit and push as you go, so that the work survives if you stop.
- Run the suite, three runs, as [This machine](#this-machine) gives them. Then open the pull request against `main`, with the piece's title and [the description below](#the-pull-requests-description).
- If your prompt carries a question and the owner's answer, put both in the pull request's description, and go on from the answer.
- Keep your working notes in a scratch folder, not in the repository.

### The reviewer

- Check the pull request out exactly as pushed, in a clean clone in a scratch folder, and remove the clone afterwards. Change nothing: no commits, no pushes, no edits to the description.
- Do the piece's review checks. Repeat what the description claims: run its commands again, run the suite's three runs, run each test that depends on timing 20 times, and recount its numbers.
- Try to break each rule of what must never happen that the piece names: beyond the ways the plan and the description list, look for one more.
- Read the documents the piece changed against its code, and run every command they give.
- If the pull request already has a review, check that each point in it was fixed, or answered with a good reason.
- Post the review as one comment on the pull request. List each problem that must be fixed before merging, with its file and line and what would settle it. Note smaller points separately. End with a line that reads `Verdict: approve` or `Verdict: changes requested`. Approve only when nothing must be fixed.
- There are two reviews at most. In the first, give every problem you can find, not the first few: the second review is the last.

### The fixer

- Read the pull request's description and its comments. Fix what is right. Where you disagree, reply on the pull request with your reason, instead of changing it.
- Where the review found one more way to break a rule, don't close that way alone: go through the kind again, and say what else you found.
- Run again the runs that your changes touch, and bring the description up to date with them.
- Push to the same branch, and add a comment that lists what you changed.

### The pull request's description

- What the piece built and removed.
- Each choice the issue, the plan and the documents left open: what was chosen, why, and where in the documents it now is.
- For each rule of what must never happen that the piece names: the ways found, how each is closed, and any not closed.
- The facts about outside programs that were tried first: what was tried, and what it did.
- Every test removed or changed, with the reason, and the tests added.
- What was run, with the results: the suite's three runs, each with its counts of tests, passes, failures and skips, and the repeated runs of tests that depend on timing.
- Every document changed. For each name the piece removed or changed, what the search of the documents found, and each hit left as it is, with the reason.
- Every command the documents now give, and whether it was run as written.
- What could not be verified.
- The smaller points of earlier reviews: which were settled, and which were left.
- Any question, and the owner's answer.

## This machine

- The owner's Linux machine, as the user `agentw`, in the checkout at `~/scooter`. Agents work one at a time. Never use `sudo`, and install nothing outside the home folder.
- Scratch clones and tools go in `~/scooter-scratch/<name>`, outside the repository, and are removed afterwards, from outside them: never from a shell working inside the folder.
- Node 26.13.1 is installed with fnm, in the home folder. A shell that doesn't find `node` needs this first: `export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"`.
- `gh` is signed in with the owner's account, and git commits carry the owner's name.
- KVM is usable through `sg kvm`, Docker is rootless, and neither wacli nor restic is installed, so their tests skip.
- The VM image is at `~/scooter-test-image`. No piece changes `config/image/build.json`, so it isn't built again. If a piece finds it must change the image, that is a question for the owner.
- The suite, in a checkout where `npm ci` has run. The README's [Development](../../../../README.md#development) section says what each run needs and why tests skip in it.
  - **Plain:** `npm test`. On `main` at `683e286`, on 2026-11-21, it ran 775 tests: 720 passed, 0 failed and 55 skipped, in about a minute.
  - **With the VM image and KVM:** `SCOOTER_TEST_IMAGE="$HOME/scooter-test-image" GONDOLIN_CPU=max,sgx=off sg kvm -c 'npm test'`. On `main` at `683e286`, on 2026-11-21, it ran 777 tests: 759 passed, 0 failed and 18 skipped, in about 3 minutes. The README says why `GONDOLIN_CPU` is needed on this machine.
  - **As root, in a container:** `docker run --rm -e SCOOTER_ROOT_TESTS=1 -v "$PWD":/src -w /src node:24-trixie sh -c 'npm ci && npm test'`. On `main` at `683e286`, on 2026-11-21, in a clean clone, it ran 775 tests: 709 passed, 0 failed and 66 skipped, in about a minute after `npm ci`. It leaves the checkout's `node_modules` as the container made it: run `npm ci` again afterwards.
- Never run two copies of the suite at once: the test that runs `scooter bridge` as a process takes port 8787, and skips itself when the port is taken (issue 18). When a test fails, run it again alone, and on `main`, before taking it for the change's fault. Report it either way, and leave tests that fail now and then on `main` to issue 18.
