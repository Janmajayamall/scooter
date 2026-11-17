# Scooter v2: architecture

This document is the map of Scooter v2: its components, what each one is responsible for, where the boundaries between them run, how they depend on each other, and the decisions that shaped them.

`docs/DESIGN.md` is the specification. It holds the details: formats, constants and exact rules. Numbers in parentheses, such as (5.3), are its sections. Section 8 here lists the changes made to DESIGN.md while planning, with the reason for each.

Scope: v2 on Linux. macOS comes later (section 9).

## 1. The system on one page

The owner sends receipts, screenshots, photos, tickets and notes to a WhatsApp bot number, or emails them to a mailbox of Scooter's own. Scooter keeps every message for good. An AI agent files them into spreadsheets and a page per day, and asks when it's unsure. Everything is backed up nightly, encrypted.

```
   WhatsApp            mailbox (IMAP)
     ▲ │                    │
     │ ▼                    ▼
 ┌─────────┐         ┌──────────────┐
 │  wacli  │         │ email reader │
 └─────────┘         └──────────────┘
     ▲ │ webhook, CLI       │ spool
     │ ▼                    ▼
 ┌──────────────────────────────────┐                      ┌──────────────────────────────────┐
 │ bridge                           │ ───▶  datastore ───▶ │ runner                           │
 │ channels · intake · delivery     │                      │ triggers · batches · state · git │
 │ commands · backups               │ ◀───   outbox  ◀──── │ ┌──────────────────────────────┐ │
 └────────────────┬─────────────────┘                      │ │ network policy and its log   │─┼──▶ OpenRouter
                  │ restic                                 │ └──────────────▲───────────────┘ │
                  ▼                                        │ ┌──────────────┴───────────────┐ │
            backup bucket                                  │ │ pi, in a fresh VM            │ │
                                                           │ └──────────────┬───────────────┘ │
                                                           └────────────────┼─────────────────┘
                                                                            ▼
                                                                views and memory, in git
```

**The path of one message:**

1. The owner sends a receipt photo to the bot. wacli, a linked device of the bot's number, receives it and posts a signed webhook to the bridge on loopback.
2. The bridge's WhatsApp module checks the signature and drops anything that isn't from the owner. The core downloads the photo, takes the next `seq`, and appends one line to the datastore.
3. The runner polls the datastore and sees a new work item. After 8 quiet seconds it builds a batch and a prompt, takes the run lock, boots a fresh VM and runs pi in it.
4. pi reads the photo from the datastore, which is mounted read-only, updates `views/expenses.csv` and the day page, and ends its answer with `DONE: 1042`. Each request it makes to the model goes through the runner's network policy, which checks it, swaps in the real key and logs it.
5. The runner checks the files pi left, commits them, writes outbox entries (here, a ✅ reaction) and updates `state.json`.
6. The bridge takes the outbox entry, sends the reaction through wacli, and appends an `out` line to the datastore.

**What must always hold** (the principles in section 1 of DESIGN.md, as invariants):

1. The datastore is the record. Lines are appended and never changed. Everything else can be rebuilt from it.
2. Only Scooter's own code talks to the outside world. The agent reaches nothing directly.
3. The model does the judgment; code does the bookkeeping.
4. The agent runs in a fresh VM for every batch, with no secrets, and can write only its views, memory and session.
5. The configuration belongs to the owner. The agent can't change its config, prompt or skills.
6. The bot is quiet unless it has a question or is asked something.

## 2. Components

| Component | Runs as | Lifetime | Role |
|---|---|---|---|
| Bridge | root | service | Talks to the channels, writes the datastore, delivers replies, runs backups |
| wacli | `scooter-wacli`, started by the bridge | one long-running sync, plus short calls | Holds the WhatsApp session; receives, downloads and sends |
| Email reader | `scooter-mail`, started by the bridge | long-running | Reads the mailbox, parses each email, hands it over through a spool |
| Runner | `scooter-runner`, in the `kvm` group | service | Decides when the agent runs and on what, applies the network policy, keeps the books |
| pi | inside a fresh VM | one run, minutes | Reads messages and attachments, edits views and memory, reports what it handled |
| restic | root, started by the bridge | one backup | Encrypts and uploads |

The folders they share are passive: the datastore, the exchange, the agent's folder, the runner's folder and the config. Section 3.3 says who can touch which.

### 2.1 The bridge

**Role:** Scooter's only link to the owner, and the only writer of the record.

**Does:**
- runs and supervises the channels' programs, wacli and the email reader, each as its own user;
- turns what they receive into datastore lines, through one write queue;
- delivers outbox entries: chooses the channel, paces and splits messages, and logs each one it sends;
- answers `/status`, `/backup` and `/help`;
- runs the nightly backup.

**Holds:** the WhatsApp session (in wacli's folder), the mailbox password and the backup credentials. It never has the OpenRouter key.

**Structure:** a channel-neutral **core** (the store, intake, delivery, commands, backups) and one **channel module** per channel. The core calls every channel through the same functions:

| Function | Does |
|---|---|
| `start(onRecord)` | Starts receiving, and calls `onRecord` for each message from the owner |
| `stop()` | Stops receiving, for backups and shutdown |
| `download(record, n, path)` | Saves the record's `n`th attachment |
| `sendText(text, quoteId)` | Sends text, quoting `quoteId` if given; returns the new message's ID |
| `react(id, emoji)` | Reacts to a message; returns the reaction's ID |
| `status()` | One line for `/status` |

A **record** is a message in channel-neutral form. The core turns records into lines, and tests drive the core with a fake channel.

**Boundaries.** The bridge never:
- talks to OpenRouter, or runs or signals pi;
- reads `config/`, so it knows nothing about agents, prompts or skills;
- changes views, memory or `state.json`, except when restoring a backup;
- decides anything about a message's content, beyond recognizing the four commands.

### 2.2 The WhatsApp channel and wacli

wacli is a third-party, unofficial program. It runs as `scooter-wacli` with a minimal environment and can read and write only `wacli/`.

`src/bridge/channels/whatsapp.mjs` is the only code that runs it. The module:
- supervises `wacli sync --follow`, restarting it with backoff, and waits for pairing when the session isn't authenticated;
- serves the webhook on `127.0.0.1:8787`, accepting only bodies signed with a secret that's new on every start;
- normalizes payloads, and drops everything that isn't the owner's one-to-one chat: other senders, groups, broadcasts, stickers, empty messages and the bot's own echoes;
- catches up at startup and every 10 minutes by listing the owner's chat, so nothing depends on the webhook, which is best-effort;
- sends text and reactions, and downloads media through `wacli/staging`.

**Boundaries.** Everything wacli says is input to check. wacli never touches the datastore. Non-owner traffic stops in this module and never reaches the core. Every text is sent with wacli's link previews off, so a link in a reply, which the agent wrote, makes wacli fetch nothing (5.3).

### 2.3 The email channel and the email reader

The email reader, `src/mail/reader.mjs`, is a separate program that runs as `scooter-mail`. It is the only code that uses `imapflow` and `postal-mime`, so neither library runs in the bridge's process. It:
- keeps one TLS connection to the mailbox, opened read-only, waiting with IDLE and checking at least every minute;
- fetches headers first, and the whole message only when `From` is one of the owner's addresses;
- parses each message, and writes it as a folder in `mail/spool/`;
- keeps its position (`UIDVALIDITY` and the next UID) in `mail/state.json`.

`src/bridge/channels/email.mjs` supervises the reader and takes the spool folders in order. It treats them as untrusted: it validates `parsed.json`, enforces size limits and picks file names itself. Then it applies the **sender check**, which is Scooter's own code reading the raw headers, and writes the line or logs the skip.

**Boundaries.** Email only comes in. The reader never deletes, moves or flags mail. It gets the mailbox settings and nothing else. An email is never a command, an edit, a deletion or a reaction.

### 2.4 The datastore

An append-only log, one `log.jsonl` per arrival day, with attachments beside it (4).

- One writer: the bridge. Two readers: the runner, and pi through a read-only mount.
- Every line has a `seq`. It holds both directions: `in` lines from the owner and `out` lines for what Scooter sent.
- Edits, deletions and reactions are new lines that point at their target.

It is the interface from the bridge to the runner. It is not a queue: it holds no consumer state. The runner's position is in its own `state.json`.

### 2.5 The exchange

Two folders the services use to coordinate:

- **`outbox/`** carries messages to send, from the runner to the bridge. The bridge also puts its own messages there, so there is one delivery path. Each entry is a folder, renamed into place when complete, and deleted once delivered. Entries have no recipient: everything goes to the owner.
- **`locks/`** holds `run.lock`, taken by the runner for each run, and `backup.lock`, taken by the bridge for each backup.

pi can't reach the exchange: it isn't mounted into the VM.

### 2.6 The runner

**Role:** the agent's supervisor and bookkeeper, and the only holder of the OpenRouter key.

**Does:**
- validates `agents.yaml` and refuses to start on any error;
- watches the datastore, and decides when the agent runs: new messages after a quiet period, scheduled and one-off tasks, backfill batches when idle, and nothing while paused;
- builds the batch and the prompt, and prepares the run's folder: the system prompt, a copy of the prompt and skills, and a copy of the current session;
- runs pi in the sandbox, under the network policy;
- reads pi's answer, checks the files it left, commits them, writes the outbox entries and updates `state.json`;
- works out why a run failed, retries or pauses accordingly, and tells the owner once;
- handles `/new`, and runs `rebuild` and backfills.

**Structure:**
- a **planner**: pure functions from the state, the datastore and the clock to the next action (which command, batch or task);
- an **executor**: one run from lock to state update;
- the **sandbox** (2.7) and the **network policy** (2.8).

**Boundaries.** The runner never:
- talks to WhatsApp or the mailbox, or writes the datastore;
- reads `bridge/`, `wacli/` or `mail/`;
- judges message content: it shows it to the model;
- trusts pi beyond the protocol lines in its answer. The file check and git are the gate for what pi wrote.

### 2.7 The sandbox

Every run gets a fresh Gondolin micro-VM on QEMU, booted from an image Scooter builds: Alpine with Node, the pinned pi, `pdftotext`, `heif-convert`, git, ripgrep, fd, `tzdata` and `curl` (6.6, 6.12).

- **Mounts**, at the same paths as on the host: the agent's folder read-only, except `views/`, `memory/` and `run/session/`, which are writable, and `sessions/`, which is hidden; and the datastore read-only. Nothing else from the host is visible.
- **Environment:** a short fixed list, with a placeholder where the key would be.
- **Acceleration:** KVM when the runner can open `/dev/kvm`, otherwise emulation, which is announced. A forced accelerator that can't be used stops the runner.
- **Lifetime:** the runner closes the VM when pi exits or the timeout passes. Nothing inside it survives.

The runner reaches it through one small interface: run this command, with these mounts, this environment, this timeout and this policy, and return the exit code and output. Tests use a fake that runs a stub of pi as a local process.

### 2.8 The network policy and its log

The VM has no network of its own. Gondolin's host side, inside the runner's process, handles everything it sends (6.13):

- DNS is answered inside the runner with made-up addresses.
- UDP, raw TCP and private addresses are refused.
- HTTP(S) goes out only to allowed hosts. The runner terminates the VM's TLS with its own certificate authority, so it sees each request in full.

The rules for what goes out:
- **Hosts:** `openrouter.ai`; with `AGENT_INTERNET=on`, also any public host over HTTPS.
- **The key:** swapped in for the placeholder only on requests to `openrouter.ai`.
- **Requests to OpenRouter:** only the two chat routes, only the configured model, only the fields and tools the pinned pi sends, and only inline images and documents. The runner forwards its own re-encoding of the body it checked.
- **Zero data retention:** set on every request.

Every request is logged before it leaves, without headers, bodies or query strings. Three things read the log: the runner, to learn why a run failed; the bridge, for the counts in `/status`; and the owner.

### 2.9 pi and its instructions

pi is a third-party coding agent, run headless with every kind of discovery turned off and seven tools: `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`.

It is given:
- the **prompt**: the batch, with times in the owner's time zone;
- the **system prompt**: the protocol, which ships with the runner; the agent's prompt, from `config/`; and the current memory;
- the **skills**, from that run's copy of `config/`.

It produces changes to `views/` and `memory/`, and a final answer that ends with protocol lines (`DONE`, `FAILED`, `REPLY_TO`, `NO_REPLY`).

**Boundaries.** pi holds no secret, has no network of its own, and can write only `views/`, `memory/` and its session copy. It can't change its config, the state, the git history, the datastore, the outbox or any other session. It can't read the other sessions either: `sessions/` is hidden from the VM.

### 2.10 The agent's folder

`agents/lifelog/` is a git repository owned by the runner (6.2):

| Path | Holds | In git |
|---|---|---|
| `views/` | The CSVs and the day pages | yes |
| `memory/` | `preferences.md` and `needs-review.md` | yes |
| `sessions/` | pi's sessions, hidden from the VM; pi only ever gets a copy of the current one | no |
| `run/` | Rebuilt before each run: `system.md`, `config/`, `session/` | no |
| `state.json` | The runner's bookkeeping | no |

The runner is the only committer. Git history is the audit trail for everything the agent changed.

### 2.11 Backups

The bridge backs up with restic to an S3-compatible bucket: nightly at `BACKUP_TIME`, on `/backup`, and on `SIGUSR1` (5.5, 8.4). The backup logic is a Node module in the bridge, and restic is the only program it runs.

- **In:** the datastore, the agents' folders, wacli's folder without its cache, the bridge's and the email reader's state, the network log and the outbox.
- **Out:** the env files, the VM image and caches.
- **Consistency:** the bridge takes `backup.lock`, waits for a run in progress to end, stops the channels, pauses delivery, backs up, and starts everything again.

### 2.12 Configuration

| What | Where | Read by | Changed by |
|---|---|---|---|
| Agents, prompts, skills, the VM image's build file | `config/` | the runner only | the owner |
| Settings and secrets | `bridge.env`, `runner.env` | each service reads its own | the owner |
| Tuning constants | `src/common/limits.mjs` | code | a code change |

### 2.13 The CLI

`src/cli.mjs` is the one entry point. Each command belongs to one side and loads only that side's settings (8.4):

| Side | Commands |
|---|---|
| Bridge | `bridge`, `pair`, `email-check`, `backup-init`, `snapshots`, `check`, `restore` |
| Runner | `runner`, `doctor`, `rebuild` |
| Root, on the host | `setup`, `build-image` |

### 2.14 Shared code

`src/common/` holds what both services need: settings, constants, paths, logging, time zones, atomic files, process handling, locks, and the formats they share (datastore lines, outbox entries, the network log, `state.json` and `status.json` readers). It contains no behavior that belongs to one side.

## 3. Boundaries

### 3.1 Trust

| Level | What | How it's treated |
|---|---|---|
| The owner | Their WhatsApp IDs; their email addresses, when the mail passes DMARC | The only source of instructions and commands |
| Scooter's own code | The bridge and the runner | Holds the secrets. The bridge's process loads no third-party library; the runner's loads `yaml` and Gondolin |
| Third-party programs that face the outside | wacli; the email reader with `imapflow` and `postal-mime` | Their own users, their own folders, only their own settings. What they hand over is validated |
| Third-party program with the bridge's privileges | restic | Pinned and checksummed. Gets only the backup settings |
| The agent | pi, and the model behind it | No secrets, no network of its own, and only three writable folders. Its output passes the file check, git and the answer parser |
| Content | Text in images, PDFs, documents, forwarded messages, quoted email and web pages | Data, never instructions. The protocol tells the model so; the sandbox limits what a misled model can do |

### 3.2 Users and processes

| Process | User | Started by | Can reach |
|---|---|---|---|
| Bridge | root | systemd, or Docker | Every data folder, being root; by design it leaves `config/` alone |
| wacli | `scooter-wacli` | the bridge | `wacli/` |
| Email reader | `scooter-mail` | the bridge | `mail/` |
| restic | root | the bridge | The folders it backs up |
| Runner | `scooter-runner`, group `kvm` | systemd, or Docker | `agents/`, `exchange/`, `runner/`; `datastore/` and `config/` read-only |
| QEMU | `scooter-runner` | the runner, through Gondolin | What the runner mounts |
| pi | the VM's own root | the runner | The mounts |

### 3.3 Files

Paths are under the data folder: `DATA_DIR` natively, `/data` in Docker.

| Folder | Owner and mode | Bridge | Runner | pi | wacli | Email reader |
|---|---|---|---|---|---|---|
| `datastore` | root, group `scooter-runner`; 0750 and 0640 | writes | reads | reads | no | no |
| `agents` | `scooter-runner`, 0700 | reads; writes only on restore | writes | reads, except `sessions/`; writes `views/`, `memory/`, `run/session/` | no | no |
| `exchange` | `scooter-runner`, 0700 | takes entries; writes its own entries and `backup.lock` | writes entries and `run.lock` | no | no | no |
| `runner` | `scooter-runner`, 0700 | reads the log and `status.json` | writes | no | no | no |
| `bridge` | root, 0700 | writes | no | no | no | no |
| `wacli` | `scooter-wacli`, 0700 | copies media out of `staging/` | no | no | writes | no |
| `mail` | `scooter-mail`, 0700 | takes spool folders | no | no | no | writes |
| `config` | root; readable by `scooter-runner` | no | reads | sees only the run's copy | no | no |

### 3.4 Network

| From | To | Notes |
|---|---|---|
| wacli | WhatsApp | outbound. Texts go out with link previews off, so wacli fetches no link (5.3) |
| Email reader | the mailbox's IMAP server, port 993 | outbound, TLS |
| restic | the backup bucket | outbound, HTTPS |
| wacli | the bridge, `127.0.0.1:8787` | loopback only, signed |
| Runner | `openrouter.ai`; public HTTPS hosts when internet is on | outbound, on pi's behalf |
| pi's VM | nothing | everything goes through the policy |
| Outside | nothing | no port is published |

### 3.5 Secrets

| Secret | Kept in | Reaches |
|---|---|---|
| WhatsApp session | `wacli/` | wacli |
| Webhook secret | the bridge's memory; new on every start | wacli's command line, which is the only way wacli 0.26.0 takes it (`docs/DECISIONS.md`, 0.6) |
| Mailbox password | `bridge.env` | the email reader's environment |
| Backup password and bucket keys | `bridge.env` | restic's environment |
| OpenRouter key | `runner.env` | Gondolin's secret table in the runner; requests to `openrouter.ai` |
| The policy's certificate authority key | the runner's home, under `runner/` | the runner |

pi sees a placeholder. No secret goes on a command line, except the webhook secret, which wacli takes no other way.

### 3.6 Contracts

These are the interfaces between components. Changing one means changing both sides.

| Contract | Between | Defined in |
|---|---|---|
| Datastore line | bridge → runner, pi | 4.2 |
| Channel functions | bridge core ↔ channel modules | 5, and 2.1 above |
| Webhook payload and wacli's JSON output | wacli → WhatsApp module | 13.1 |
| Mail spool folder | email reader → email module | 5.6 |
| Outbox entry | runner, bridge → bridge | 5.3 |
| Lock files | bridge ↔ runner | 5.5, 6.4, and decision 10 below |
| `state.json` | runner → bridge (`/status`) | 6.3 |
| `status.json` | runner → bridge (`/status`) | 6.3 |
| Network log line | runner → bridge, owner | 6.13 |
| Sandbox interface | runner ↔ sandbox | 2.7 above |
| Prompt and answer protocol | runner ↔ pi | 6.5, 6.7, 7.1 |
| `agents.yaml`, env files | owner → runner, both services | 6.1, 8.2 |

## 4. Dependencies

### 4.1 At run time

Neither service needs the other to be up. Each does its own half and the folders hold the rest.

| Component | Needs | For | When it's missing |
|---|---|---|---|
| Bridge | a paired wacli | receiving and sending on WhatsApp | It logs that `pair` is needed and checks every minute. Email still arrives; outbox entries wait |
| Bridge | the mailbox | receiving email | The reader reconnects with backoff. WhatsApp is unaffected |
| Bridge | the runner | nothing | Messages are stored; they're handled when the runner is back |
| Bridge | the runner's files | `/status` | It reports what it can read |
| Bridge | a restic repository | backups | Backups are off, with a warning at startup |
| Runner | the bridge | nothing | It works through what's in the datastore; replies wait in the outbox |
| Runner | a valid `agents.yaml` | starting | It stops, naming the field |
| Runner | the VM image, built for the pinned pi | starting | It stops, saying to run `build-image` |
| Runner | an accelerator | speed | It falls back to emulation and tells the owner, unless one was forced |
| Runner | OpenRouter | every run | A refused key, model or credit pauses runs; an outage is retried with backoff. Messages wait and none ends up failed |
| pi | the policy, the mounts | everything | The run fails and is retried |

### 4.2 In the code

```
src/cli.mjs ──▶ one side per command

src/bridge  ──▶ src/common          no third-party libraries
src/runner  ──▶ src/common          yaml (config only), @earendil-works/gondolin (sandbox only)
src/mail    ──▶ src/common (part)   imapflow, postal-mime
src/ops     ──▶ src/common          setup and doctor
```

Rules, checked by a test that scans imports:

1. `src/common` imports nothing from the other folders.
2. `src/bridge` and `src/runner` never import each other. They share only the formats in `src/common`.
3. `src/mail` imports from `src/common` only files, limits and logging, and never the bridge's settings.
4. One place for each outside contact:
   - only `src/bridge/store.mjs` appends to the datastore;
   - only `src/bridge/channels/whatsapp.mjs` runs wacli;
   - only `src/bridge/channels/email.mjs` runs the email reader;
   - only `src/bridge/backup.mjs` runs restic;
   - only `src/runner/sandbox/` imports Gondolin;
   - only `src/runner/config.mjs` imports `yaml`.
5. Every tuning number is in `src/common/limits.mjs`.

### 4.3 Third-party

All pinned to exact versions. The library versions are the ones DESIGN.md gives as examples; if one has a newer fix release when work starts, pin that instead and record it in `docs/DECISIONS.md`.

| Dependency | Version | Used by | Note |
|---|---|---|---|
| Node.js | ≥ 22.19 | everything | Gondolin and pi need it |
| wacli | 0.26.0 | WhatsApp module | Unofficial; a WhatsApp protocol change can break it |
| pi (`@earendil-works/pi-coding-agent`) | 1.5.2 | inside the VM image | The policy's allowlists match this version's requests |
| Gondolin (`@earendil-works/gondolin`) | 0.14.0 | sandbox | Pre-1.0; the next version changes how hooks run |
| QEMU | the host's | sandbox | With KVM where available |
| restic | 0.19.1 | backups | |
| `yaml` | 2.9.1 | runner config | |
| `imapflow`, `postal-mime` | 2.11.0, 4.2.1 | email reader | Never loaded by the bridge |
| OpenRouter | | runner | The model is configurable; default `anthropic/claude-sonnet-5.5` |

### 4.4 Starting up

**Bridge:** load `bridge.env`; read the datastore and rebuild the index; remove a leftover `backup.lock`; start the channels; send what was left in the outbox; then loop.

**Runner:** load `runner.env`; validate `agents.yaml`; free what pi left, then create the agent's folder if it's new and throw away a run's uncommitted changes; check the image and pick the accelerator; remove a leftover `run.lock`; write `status.json`; run any `once` task and start any backfill; then loop.

## 5. Flows

### 5.1 A run

1. **Trigger.** There are work items after the cursor, or retries that are due, and the runner saw the newest incoming line arrive at least 8 seconds ago. Runs aren't paused.
2. **Commands.** The runner handles command lines it hasn't handled yet. `/new` bumps the session.
3. **Batch.** Due retries first, then new work items, oldest first, up to 20 and up to the prompt's size limit. An edit or deletion brings in the message it changes.
4. **Lock.** Take `run.lock`, recording when the run must be over, then look for `backup.lock`. If a backup holds it, release `run.lock` and wait.
5. **Prepare.** Write `run/system.md`, copy the prompt and skills into `run/config/`, and copy the current session into `run/session/`.
6. **Run.** Boot the VM, run pi, close the VM.
7. **After a successful run**, in this order: check the files, commit, copy the session back, write the outbox entries, update the state. A crash part-way only means the batch runs again. An error in checking or committing the files fails the run, as an unexpected file does.
8. **Release** the lock.

### 5.2 A failed run

The runner throws away the run's session changes and its uncommitted changes: it empties `run/session/`, sets `views/` and `memory/` aside, removes what it set aside, and takes the last commit's back. Nothing pi left can stop that, however deep it goes or however full it left the disk: everything pi wrote is freed before anything new is made. Then it reads OpenRouter's last response during the run from the network log:

| Cause | Sign | What happens |
|---|---|---|
| Setup error | 401, 402, 403 or 404 | Runs pause. A try every 30 minutes and on restart. No item counts an attempt |
| Outage | 408, 429, 5xx, or no answer | Tries after 1, 5 and 30 minutes, then every 30. No item counts an attempt |
| Anything else | pi crashed or timed out, or left an unexpected file, or files that couldn't be checked or committed | Every item counts an attempt and is due again in a minute. After 4, it moves to `failed` |

The owner gets one notice for the first failure in a row, and one when items are given up on.

### 5.3 Delivery

1. The bridge takes outbox entries in order, one message every 5 seconds.
2. It finds the channel from the line the entry points at. A reply goes to that line's channel if it can send; everything else goes to `DEFAULT_CHANNEL`.
3. It renames `entry.json` to `sending.json`, sends, appends an `out` line, and deletes the entry. Long texts go out in chunks. Every text goes out with wacli's link previews off.
4. After a crash, an entry still marked as sending is sent again, from the first chunk not recorded as sent.

### 5.4 A backup

1. The bridge takes `backup.lock`, then waits for `run.lock` to go.
2. It stops the channels and pauses delivery.
3. restic backs up, then prunes old snapshots; on Sundays it also checks the repository.
4. The bridge starts the channels and delivery again, and releases the lock. Catch-up collects what arrived meanwhile.

### 5.5 Rebuild and backfill

Both replay history through the agent, one of the owner's days at a time, with the prompt's `Now:` set to the time of the batch, and without sending anything.

- **`rebuild`** runs with the runner stopped. It empties the views, memory and sessions, and replays the whole datastore up to the newest `seq` at the time it started.
- **A backfill** fills one new view. It runs inside the runner, only when nothing live is waiting, with its own cursor and retry list, and may change only the paths it names and the day pages.

## 6. Deployment on Linux

| | Native | Docker Compose | Development |
|---|---|---|---|
| Set up by | `sudo scooter setup` | `docker compose build` | nothing |
| Services | `scooter-bridge.service` as root; `scooter-runner.service` as `scooter-runner` | `bridge` and `runner`, one image | two processes run by hand |
| Users | created by `setup` | defined in the image, with fixed uids | the developer's own; user switching is skipped with one warning |
| Data and settings | `/var/lib/scooter`, `/etc/scooter` | volumes; `./config` bind-mounted | `DATA_DIR`, `CONFIG_DIR` |
| KVM | the `kvm` group, through `SupplementaryGroups` | `/dev/kvm` passed in: by group on rootful Docker, by a udev rule on rootless | the developer's `kvm` group |
| VMs die with the runner | `KillMode=control-group` | the runner is the container's main process | not guaranteed |

In every mode there are no published ports.

## 7. Decisions

Each entry says what was decided, why, and what follows from it. "Settled" means it was agreed with the owner and is in section 2 of DESIGN.md: don't change it without asking.

### 7.1 The record

1. **The datastore is the only record.** Every message in and out is appended and never changed. Views, memory, sessions and state are derived, and `rebuild` can recreate them. *So:* a bug in the runner or a bad run can cost a rebuild, never data. (1, 4)
2. **One writer, one queue.** Only the bridge appends, through a single queue, so `seq` order is line order and recovery after a crash is truncating an incomplete last line. Edits, deletions and reactions are new lines that point at their target. (4.3)
3. **`seq` is the only name a message has outside the bridge.** The agent, the outbox, `state.json` and the views' `source` column all use it; channel IDs stay in the datastore and the bridge. *So:* the agent can't name a channel or a recipient, and adding a channel changes nothing past the bridge. (5.3)
4. **Day folders follow the arrival date in UTC and never go backwards,** even if the clock does. The message's own time is in `at`. *So:* reading the folders in date order gives `seq` order, and each attachment sits beside its line. (4.1)
5. **The bridge logs what it sends.** An `out` line follows each successful send. *So:* the record has both sides of the conversation, and the agent sees its own earlier replies as context, which is what stops duplicates after a retried batch. (5.3, 6.8)
6. **UTC inside, the owner's time zone at the edges.** Settled. Everything stored or compared is UTC. `SCOOTER_TZ` is applied only where the owner reads or sets a time. Only pi runs with `TZ` set to it, because it writes what the owner reads. (2, 8.2)

### 7.2 Processes and boundaries

7. **Two services that share folders, not sockets.** The bridge and the runner never call each other: the datastore carries work one way and the outbox carries replies back. *Why:* each holds different secrets; either can be down or restart without losing anything; nothing listens for connections; and the queue is plain files the owner can read. (3)
8. **Polling, once a second.** No file watchers and no signals between the services. *Why:* the volume is a handful of messages a day, and a poll behaves the same on every system. (6.4, 10)
9. **Hand-offs are atomic renames.** Outbox entries and mail spool folders are written as `.tmp-<id>` and renamed when complete; state files are written to a temporary file and renamed. *So:* a reader never sees half of anything. (5.3, 5.6, 6.3)
10. **Two lock files keep runs and backups apart.** Each side creates its own lock first and then looks for the other's. The runner backs off if it finds `backup.lock`; the bridge waits for `run.lock` to go. `run.lock` records when its run must be over, and the bridge waits no longer than that plus 2 minutes. Each side removes its own leftover lock at startup. *Why:* checking before creating would let a run and a backup start at the same instant. (5.5, 6.4; section 8, rows 6 and 7)
11. **Secrets are split by process.** Settled. The bridge has the WhatsApp session, the mailbox password and the backup credentials; the runner has the OpenRouter key; each reads only its own env file. pi gets a placeholder. *So:* no single compromise yields everything. (3.2, 9)
12. **The bridge runs as root.** *Why:* it has to start wacli and the email reader as other users, and read every folder for backups. *Cost, accepted:* a flaw in the bridge exposes the machine on a native install. Running it as its own user, with systemd starting the other two, is a possible later change. (9)
13. **Programs that face the outside get their own user.** wacli and the email reader run third-party code that parses whatever the internet sends. Each can read and write only its own folder and sees only its own settings. The bridge validates what they hand over. (3.2, 5.6)
14. **The runner is its own unprivileged user.** *So:* an escape from the VM reaches the OpenRouter key and the agent's folders, but not the bridge's secrets. (9)

### 7.3 Channels

15. **One module per channel, behind one set of functions.** The core is channel-neutral and is tested with a fake channel. *So:* another channel, such as Telegram, is one more module. (5)
16. **WhatsApp through wacli, as a linked device of a separate bot number.** Settled. The webhook is best-effort (5 seconds, no retries), so catch-up is what makes intake complete, and duplicate checks let the two overlap. The first start imports no history. (5.1, 5.2)
17. **Only the owner gets in.** WhatsApp: the owner's IDs, in a one-to-one chat. Email: exactly one `From`, on the owner's list, and the provider's own topmost `Authentication-Results` header says `dmarc=pass`. The email check is Scooter's own code in the bridge, not the library's, and anything ambiguous is skipped. (5.2, 5.6)
18. **Email only comes in.** Settled. It goes to a mailbox used only by Scooter, which the reader never changes, so the mailbox doubles as a copy. Replies about an email go to WhatsApp. (5.6)
19. **Commands are not messages.** They come only from WhatsApp, are logged as `command` lines and are never shown to the agent as work. The bridge answers three; `/new` reaches the runner through the datastore, like everything else. (5.4)
20. **Delivery is at-least-once.** `sending.json` marks an entry in flight and records how many chunks went out. After a crash the bridge sends the rest again; the worst case is one repeated message. Decided with the owner on 2026-11-15, in place of searching wacli's store for what was sent. (5.3; section 8, row 3)
21. **A reply follows the message it answers; everything else goes to `DEFAULT_CHANNEL`.** Settled. The bridge reads the channel from the line an entry points at. In v2 only WhatsApp can send, so replies about emails arrive there, unquoted. (5.3)
22. **Sending is paced:** one message every 5 seconds and chunks of at most 3,500 characters, so the bot number doesn't look like spam. (5.3, 8.6)

### 7.4 The runner and the agent

23. **The model does the judgment; code does the bookkeeping.** The runner chooses the batch, tracks the cursor, retries and failures, commits and sends. The agent reads, edits files and reports. *So:* progress never depends on the model remembering anything. (1, 6)
24. **The agent reports in four kinds of line** at the end of its answer: `DONE`, `FAILED`, `REPLY_TO` and `NO_REPLY`. The protocol that describes them ships with the runner, not in `config/`, because the runner parses it. (6.7, 7.1)
25. **The agent never waits for the owner.** It files its best guess, marks it ❓, notes the question in `memory/needs-review.md`, and asks. An item it asked about counts as done. *So:* the runner has no "waiting for an answer" state. (7.1)
26. **After a run: files, git, session, outbox, state, in that order.** *Why:* a crash at any point only causes the batch to run again, and the agent then sees the replies already sent and the rows already filed; and the session never remembers rows a crash threw away. An error in checking or committing the files fails the run rather than stopping the runner. (6.8; `docs/DECISIONS.md`, D88 and 4.7)
27. **The cause of a failure comes from the network log.** OpenRouter's last response during the run decides between a pause, a backoff and a counted attempt. *So:* an outage or a revoked key never uses up a message's four attempts. (6.9)
28. **A batch is what arrived before a quiet moment:** 8 seconds without a new message, retries first, at most 20 items and at most the prompt's size limit. An edit or deletion brings in the message it changes, so the two are never handled out of order. (6.4, 6.5; section 8, row 12)
29. **Views and memory are in git, and the runner is the only committer.** A run that leaves anything git wouldn't record (a symlink, a dotfile, an ignored file) fails and is cleaned up. *So:* everything a run changes is visible and revertible, and nothing hidden carries over. (6.2, 6.8)
30. **Sessions belong to the runner.** `sessions/` is hidden from the VM. pi gets a copy of the current day's session, and only that one file is copied back, after a successful run. *So:* a run can extend its own session but can't read or touch another, or plant one for later. (6.6)
31. **The configuration belongs to the owner.** `config/` is read-only to the runner and invisible to pi, which sees a copy made for that run. (1, 8.5)
32. **Preferences need no approval.** Settled. Standing instructions the owner gives by message go into `memory/preferences.md`; git history is the audit trail. The runner doesn't check them. (2, 7.4)
33. **One agent, in a format that allows more.** Settled. `agents.yaml` is a map of agents, and v2 refuses more than one. (2, 6.1)
34. **Replays keep the past's clock.** In a rebuild or a backfill, a batch covers one of the owner's days and the prompt's `Now:` is the batch's own time, so "today" in an old message means what it meant then. Replays send nothing. (6.10, 6.11)
35. **Quiet by default.** Settled. A handled message gets a ✅ reaction, and text is sent only for a question or an answer. (1, 6.8)

### 7.5 The sandbox and the network

36. **A fresh VM for every run.** Settled. Whatever pi does inside is gone when the VM closes, apart from what it wrote to the three writable folders. (6.6)
37. **The same paths inside the VM as on the host.** *So:* the paths in the prompt, in pi's tool calls and in the day pages' links read the same everywhere. (6.6)
38. **The VM has no network; the runner makes pi's requests.** DNS never leaves the runner, only HTTP(S) to allowed hosts goes out, and the runner sees every request in full because it terminates the VM's TLS. (3.1, 6.13)
39. **pi never holds the key.** Settled. The VM has a placeholder, and the runner swaps in the real key only on requests to `openrouter.ai`. (6.13)
40. **An allowlist for what may be asked of OpenRouter.** Two routes, the configured model, the fields the pinned pi sends, client tools only and inline media only. The runner forwards its own re-encoding of the checked body, so a duplicated key can't show the check one value and OpenRouter another. *Why:* without this, OpenRouter could fetch from the web for the agent, past the policy and its log. *Cost:* every pi upgrade means capturing its requests again. (6.13)
41. **Zero data retention, twice.** Settled. The runner sets it on every request, and the owner enforces it on Scooter's key, because a request can tighten OpenRouter's settings but not loosen them. (6.13)
42. **Log before sending, and never log content.** The `request` line is written before the request leaves, so nothing goes out unrecorded even if the runner crashes. Lines hold hosts, paths, statuses, sizes and timings. Responses are logged from the HTTP client's events, because a response hook in Gondolin 0.14.0 would hold back streaming. (6.13)
43. **A forced accelerator fails instead of falling back.** `auto` takes the fastest available and says which; `kvm` or `emulation` is taken literally. *Why:* Gondolin falls back to emulation silently, which is about ten times slower. (6.6)
44. **VMs die with the runner.** Gondolin leaves QEMU running if the process that started it is killed, so the runner always runs under something that stops its whole process group. (6.6)
45. **Scooter builds its own VM image,** from a build file with pinned versions. It includes ripgrep and fd, which pi would otherwise download while it runs. The runner refuses to start with a missing image or one built for another pi version. (6.12)
46. **Internet is off unless the owner turns it on.** Settled. Off, the agent reaches only OpenRouter's two chat routes. On, it can also reach public HTTPS sites, and every request is still logged. (2, 6.13)

### 7.6 Operations

47. **Backups are restic, nightly, encrypted before upload.** Settled. Consistency comes from stopping writers for the length of the backup, not from snapshots. The logic is in Node, in the bridge, as decided with the owner on 2026-11-15. (5.5; section 8, row 2)
48. **Two ways to deploy on Linux,** native services or Docker Compose, at the owner's choice. Settled. Neither publishes a port. (8.3, 8.5)
49. **Constants are not settings.** Every tuning number lives in one module, with a comment saying what it protects. A value becomes a setting only when the owner has a reason to change it, and then it gets a valid range and a test. (8.6)
50. **Everything third-party is pinned** to an exact version, and downloads are checked against published checksums. (2, 13)
51. **Logs carry no content:** IDs, kinds, sizes and timings, never message text or file contents. (9)

## 8. Changes made to DESIGN.md while planning

DESIGN.md was updated on 2026-11-15 to include everything in this table, so the two documents agree. The table is the record of what changed and why. If the two ever disagree again, DESIGN.md is the specification, and this document is the one to fix.

Rows 1 to 3 are the owner's decisions of that day. The rest were worked out while planning, each from a gap or a contradiction in DESIGN.md or from a fact about the tools, by its own rule: the simplest option that keeps the principles. The owner confirmed row 8 the same day, with the condition it states.

| # | DESIGN.md said | It now says | Why |
|---|---|---|---|
| 1 | Linux and macOS (2, 8.5) | Linux only for now. Nothing is built or tested for macOS: no launchd services, no Apple hypervisor, no macOS notes for Docker. What it said about macOS is kept as notes for later, in its section 12 | The owner's decision. The portability rules in section 10 are kept where they cost nothing |
| 2 | Backups run through `scripts/backup.sh` (5.5) | A Node module in the bridge runs restic directly. The commands and their behavior are unchanged | The owner's decision: one language, one test framework |
| 3 | After a crash, `findSent` searches wacli's store for a text that may have gone out (5, 5.3) | No `findSent`. `sending.json` records how many chunks were sent, and the rest are sent again | The owner's decision: at worst one repeated message |
| 4 | Users `wacli`, `runner` and `mail` (3.2) | `scooter-wacli`, `scooter-runner` and `scooter-mail`. Fixed uids 10001 to 10003 in the Docker image only; natively `setup` creates system users and refers to them by name | Ubuntu, Debian and Alpine already have a `mail` user (uid 8). It was seen on the Linux machine and in Debian 12 and Alpine images; `node:24-trixie-slim` wasn't pulled to check, but Debian's base system defines the account. On Ubuntu its group can write the system's mail spool, and sharing an account would share its files and its environment |
| 5 | "Only root can write" the outbox (5.3) | The runner's user and root can. pi can't, because the exchange isn't mounted into its VM | 3.2 gives the exchange to the runner's user |
| 6 | `/status` shows the accelerator and whether ZDR is on, and backups wait for "the agent's timeout" (5.4, 5.5), but the bridge reads neither `config/` nor `runner.env` | The runner writes `runner/status.json` (accelerator, ZDR, internet, model, the image's build time, each agent's timeout and sources). `run.lock` records when its run must be over. `AGENT_INTERNET` becomes the runner's setting alone, where 8.2 gave it to both services, and `/status` shows it from `status.json` | The bridge needs these facts and has no other way to learn them. A second copy of the internet setting in `bridge.env` could disagree with the one the runner uses |
| 7 | Each side checks the other's lock, then takes its own (5.5, 6.4) | Each takes its own lock first, then checks the other's. The bridge removes a leftover `backup.lock` at startup, as the runner does for `run.lock`. If `run.lock` outlives its deadline plus 2 minutes, the backup goes ahead | Check-then-take lets both start at once. A stale `backup.lock` would stop the agent for good |
| 8 | `build-image` runs as the runner's user (8.4, 8.5) | Natively it runs as root and hands the image to the runner's user. Without root it uses Gondolin's container build when Docker or Podman is available. pi is installed with `--ignore-scripts`, as 8.3 does for Scooter's own packages, and the build's commands never run pi or anything else npm installed. If pi turns out not to work without its install scripts, the owner decides again | Gondolin 0.14.0 runs the build's install commands in a chroot, which needs root. *Cost:* a native build runs as root on the host, where DESIGN.md meant an unprivileged user, and a chroot doesn't contain root. What runs is Gondolin's builder, then Alpine's shell, npm and git inside the image's folder. Gondolin unpacks Alpine's packages itself and runs none of their scripts. With `--ignore-scripts`, pi's packages are only unpacked too, so none of their code runs as root. The build runs only when the owner starts it, never in a service. The owner confirmed this on 2026-11-15 |
| 9 | Duplicates are defined for `message` lines only (4.4) | Also: an `edit` whose text equals the target's current text is skipped; a `delete` of a deleted message is skipped; a `reaction` is checked by its own ID | The webhook and catch-up can both deliver the same event, and an edit carries the original message's ID |
| 10 | Catch-up starts 2 minutes before the newest incoming `at` (5.2) | Before the newest incoming WhatsApp line | An email arriving while wacli is down would move the start past missed WhatsApp messages |
| 11 | `/new` is handled "before building a batch" (6.4) | `state.json` also keeps `commandSeq`, the newest command handled. A `/new` applies to all work not yet given to the agent. A rebuild sets `commandSeq` to the `seq` it stops at, so old commands aren't answered again (6.10) | Without it, a crash or a failed batch would handle the same `/new` twice |
| 12 | A batch has at most 20 items (6.5), and the prompt is one command-line argument (6.6) | A batch also stops at `PROMPT_MAX_BYTES` (96 KB), always keeping at least one item. An item too long for that is shown cut, with the path to the rest | Linux refuses a single argument over 128 KB, checked on the target machine. A batch of long emails would fail on every attempt and end up in `failed` |
| 13 | pi's flags (6.6) | Also `--no-mcp` | pi 1.5.2 has MCP support built in. 13.2 lists the flag; the command in 6.6 leaves it out |
| 14 | Mounts at the host's paths (6.6) | The same, with Gondolin's own mount point moved off `/data` | Gondolin's file system mounts at `/data` by default, which is where Scooter's folders are in Docker |
| 15 | Falling back to emulation sends a notice at every startup (6.6) | Only when the accelerator changes to emulation | A runner that keeps restarting would send the bot's number a message each time |
| 16 | Where a native install keeps the code wasn't said (8.5) | The code lives in a root-owned folder every service user can read, with a system-wide Node. `setup` checks both. The runner's home and temporary folder are under `runner/` | The service users must be able to run Node and read the code. Gondolin needs a writable home and temporary folder, and its leftovers must be easy to sweep |
| 17 | The bridge uses `yaml` (2) | It doesn't | It reads no YAML: `config/` is the runner's |

Kept as designed, after being considered for cutting on 2026-11-15: Docker Compose as a deployment option, backfills, `once` tasks, and daily sessions with `/new`.

Four smaller things were aligned in DESIGN.md at the same time, without changing what Scooter does:
- the two channel modules are named `.mjs`, like every other file (5, 8.1);
- the suggested layout in 8.1 matches section 4.2 here;
- section 11 points to the plan for the order of work;
- the command that runs the tests as root sets `SCOOTER_ROOT_TESTS=1`, which the tests that create users wait for, so running the suite as root on a real machine creates none (10).

On 2026-11-16 the owner removed the earlier prototype from the repository and moved the work from the `v2` branch to `main`. The top of DESIGN.md says so.

Changes made to DESIGN.md after planning, while building, are recorded in `docs/DECISIONS.md`, each with the question behind it and the owner's answer. The first two came from milestone 0's checks of the tools, and the owner decided both on 2026-11-16 (section 0.8 there). This document includes them:
- The bridge sends every WhatsApp text with `--no-preview`. Otherwise wacli fetches the first link in the text, which the agent wrote, to build a link preview (5.3; sections 2.2, 3.4 and 5.3 here).
- The VM's mount of the agent's folder hides `sessions/`. A read-only mount alone let pi read every earlier session, where 6.6 said it never sees them (6.6; sections 2.7, 2.9, 2.10 and 3.3 here, and decision 30).

## 9. Deferred, and where the design leaves room

**Deferred with macOS:** launchd services, Apple's hypervisor (`AGENT_ACCEL=hvf` stays a known value and fails on Linux, as any unavailable accelerator does), the macOS data paths in `setup`, and running under Docker Desktop, OrbStack or Colima.

**Not verified on the Linux machine at hand:** arm64, since it has no arm64 emulation for either Docker or QEMU. The code stays architecture-neutral.

**Out of scope for v2** (12): more than one agent, other channels, sending email, approvals for preferences, `/retry` and `/undo`, group chats, voice transcription, and anything that answers questions or acts for the owner. Those last belong to a separate assistant.

**Where later work plugs in:**

| Later | Plugs in at | Already there |
|---|---|---|
| Telegram, or another channel | A module in `src/bridge/channels/` | The channel functions; `source` on every line; routing by the line an entry points at |
| Bank feeds and other data that isn't the owner's words | A channel that writes lines with `trust: "external"` | The `trust` field; `reads` per agent |
| More agents | `agents.yaml` | The map of agents; `reads`; `by` on `out` lines; one folder per agent |
| The assistant | A reader of the views | Views in git, written only by Scooter |
