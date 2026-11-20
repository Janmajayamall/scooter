# Scooter: architecture

This document is the way into Scooter's design: what it does, how one message goes through it, its components and where each is described, the boundaries between them, the contracts they share, and the reasons for how it is built. It holds what belongs to no single component. Each component has a document of its own in `docs/architecture/`, with its files, its rules, the reason beside each rule that needs one, and the facts about outside tools it relies on. Each fact is stated in one place, and a document refers to another by a link to the heading.

Read this document whole, then the document of the component you change. The README is the operator's guide: installing, running and the known limits ([README](../README.md)). A link marked "(not yet written)" leads to a component document still to come: until then its rules are in `docs/DESIGN.md` and `docs/DECISIONS.md`, and the old text of this document for those components is at its end, under [Old text, still to be moved](#old-text-still-to-be-moved).

Scope: v2 on Linux.

## What Scooter does

The owner sends receipts, run screenshots, food photos, travel tickets, notes about time spent with people, and other short notes to a second WhatsApp number, the bot. They can also email things to a mailbox of Scooter's own, such as a forwarded booking or a file. Scooter keeps every message for good. An AI agent turns the messages into spreadsheets and a page per day, and asks the owner when it's unsure. Everything is backed up nightly, encrypted. Answering questions about the data, and acting for the owner, are for a separate assistant later ([Deferred and out of scope](#deferred-and-out-of-scope)).

The principles, which hold everywhere:

1. **The datastore is the source of truth.** Every message in and out is appended to it and never changed. Everything else is derived from it and can be rebuilt.
2. **Only Scooter's own code talks to the outside world.** The bridge holds the WhatsApp session, the mailbox and the backup credentials; the runner holds the OpenRouter key. The agent reaches nothing directly: everything it sends goes through the runner, which checks and logs it.
3. **The model does the judgment; code does the bookkeeping.** The runner decides what the agent works on, tracks progress, retries and commits. The agent reads messages, updates files and reports what it handled. So progress never depends on the model remembering anything.
4. **The agent is sandboxed.** pi runs in a fresh virtual machine for every batch, with no secrets, and can write only its own views, memory and session. It can reach OpenRouter and nothing else, unless the owner turns its internet access on. The runner checks and logs every request, and nothing pi does survives the VM.
5. **The configuration belongs to the owner.** The agent can't change its config, prompt or skills.
6. **Quiet by default.** The bot speaks when it has a question or is asked something. Otherwise it reacts ✅.

## The path of one message

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

1. The owner sends a receipt photo to the bot. wacli, a linked device of the bot's number, receives it and posts a signed webhook to the bridge on loopback ([The webhook](architecture/whatsapp.md#the-webhook)).
2. The WhatsApp channel checks the signature and drops anything that isn't the owner's ([From a message to a record](architecture/whatsapp.md#from-a-message-to-a-record)). Intake downloads the photo, and the store gives the message the next `seq` and appends one line to the datastore ([Intake](architecture/bridge.md#intake), [Writing](architecture/datastore.md#writing)).
3. The runner polls the datastore and sees a new work item. Once the owner has been quiet for `BATCH_SECONDS`, it builds a batch and a prompt, takes the run lock, boots a fresh VM and runs pi in it ([the runner](architecture/runner.md) (not yet written), [the sandbox](architecture/sandbox.md) (not yet written)).
4. pi reads the photo from the datastore, which is mounted read-only, updates `views/expenses.csv` and the day page, and ends its answer with `DONE: 1042`. Each request it makes to the model goes through the runner's network policy, which checks it, swaps in the real key and logs it ([the network policy](architecture/network-policy.md) (not yet written)).
5. The runner checks the files pi left, commits them, writes outbox entries, here a ✅ reaction, and updates its state ([Outbox entries](architecture/exchange.md#outbox-entries)).
6. The bridge takes the outbox entry, sends the reaction through wacli, and appends an `out` line to the datastore ([Sending an entry](architecture/delivery.md#sending-an-entry)).

An email takes the same way from step 2, through the email reader's spool and the sender check ([The email channel](architecture/email.md)), and the reply about it reaches the owner on WhatsApp.

## The map

Each component, its document, and its files. Every file under `src/` belongs to one component.

| Component | Document | Files |
|---|---|---|
| The datastore | [datastore.md](architecture/datastore.md) | `src/bridge/store.mjs`, `src/common/datastore/index.mjs`, `src/common/datastore/line.mjs`, `src/common/datastore/reader.mjs` |
| The bridge | [bridge.md](architecture/bridge.md) | `src/bridge/main.mjs`, `src/bridge/channels/index.mjs`, `src/bridge/intake.mjs`, `src/bridge/commands.mjs`, `src/bridge/status.mjs`, `src/bridge/state.mjs` |
| The WhatsApp channel | [whatsapp.md](architecture/whatsapp.md) | `src/bridge/channels/whatsapp.mjs` |
| The email channel | [email.md](architecture/email.md) | `src/bridge/channels/email.mjs`, `src/mail/reader.mjs`, `src/mail/imap.mjs`, `src/mail/parse.mjs`, `src/mail/spool.mjs` |
| Delivery | [delivery.md](architecture/delivery.md) | `src/bridge/outbox.mjs` |
| The exchange | [exchange.md](architecture/exchange.md) | `src/common/outbox.mjs`, `src/common/locks.mjs` |
| Backups | [backups.md](architecture/backups.md) | `src/bridge/backup.mjs` |
| Shared code | [shared-code.md](architecture/shared-code.md) | `src/common/files.mjs`, `src/common/proc.mjs`, `src/common/instance.mjs`, `src/common/log.mjs`, `src/common/time.mjs`, `src/common/paths.mjs` |
| The runner, and the agent's folder | [runner.md](architecture/runner.md) (not yet written) | `src/runner/main.mjs`, `src/runner/run.mjs`, `src/runner/triggers.mjs`, `src/runner/batch.mjs`, `src/runner/prompt.mjs`, `src/runner/answer.mjs`, `src/runner/failures.mjs`, `src/runner/commands.mjs`, `src/runner/datastore.mjs`, `src/runner/state.mjs`, `src/runner/status.mjs`, `src/runner/restarts.mjs`, `src/runner/agentdir.mjs`, `src/runner/git.mjs`, `src/common/agentstate.mjs`, `src/common/runnerstatus.mjs` |
| Rebuild and backfill | [rebuild-and-backfill.md](architecture/rebuild-and-backfill.md) (not yet written) | `src/runner/rebuild.mjs`, `src/runner/backfill.mjs`, `src/runner/replay.mjs` |
| The sandbox and the VM image | [sandbox.md](architecture/sandbox.md) (not yet written) | `src/runner/sandbox/index.mjs`, `src/runner/sandbox/gondolin.mjs`, `src/runner/sandbox/accel.mjs`, `src/runner/sandbox/image.mjs`, `config/image/build.json` |
| The network policy | [network-policy.md](architecture/network-policy.md) (not yet written) | `src/runner/sandbox/policy.mjs`, `src/runner/sandbox/netlog.mjs`, `src/common/netlog.mjs` |
| The agent and its instructions | [agent.md](architecture/agent.md) (not yet written) | `src/runner/protocol.md`, `config/prompts/lifelog.md`, `config/skills/day-pages/SKILL.md`, `config/skills/expenses/SKILL.md`, `config/skills/meals/SKILL.md`, `config/skills/people/SKILL.md`, `config/skills/runs/SKILL.md`, `config/skills/travel/SKILL.md` |
| Configuration and the CLI | [configuration.md](architecture/configuration.md) (not yet written) | `src/cli.mjs`, `src/common/settings.mjs`, `src/common/limits.mjs`, `src/runner/config.mjs`, `config/agents.yaml`, `bridge.env.example`, `runner.env.example` |
| Install, native and Docker | [install.md](architecture/install.md) (not yet written) | `src/ops/setup.mjs`, `src/ops/doctor.mjs`, `deploy/systemd/scooter-bridge.service`, `deploy/systemd/scooter-runner.service`, `Dockerfile`, `.dockerignore`, `compose.yaml`, `compose.kvm.yaml`, `compose.kvm-rootless.yaml` |

The exchange, the folder the two services coordinate through, is a component of its own, since both services follow its two contracts. The agent's folder is the runner's: the runner owns it and is its only committer. `src/common/` is split by what each file defines: a format goes with the component that owns the contract, and what belongs to no side is shared code.

## The boundaries

### Trust

| Level | What | How it's treated |
|---|---|---|
| The owner | Their WhatsApp IDs ([Owner matching](architecture/whatsapp.md#owner-matching)); their email addresses, when the mail passes DMARC ([The sender check](architecture/email.md#the-sender-check)) | The only source of instructions and commands |
| Scooter's own code | The bridge and the runner | Holds the secrets. The bridge's process loads no third-party library; the runner's loads `yaml` and Gondolin |
| Third-party programs that face the outside | wacli; the email reader, with `imapflow` and `postal-mime` | Their own users, their own folders, only their own settings. What they hand over is validated |
| A third-party program with the bridge's privileges | restic | Pinned and checksummed ([Running restic](architecture/backups.md#running-restic)) |
| The agent | pi, and the model behind it | No secrets, no network of its own, and only three writable folders. Its output passes the file check, git and the answer parser |
| Content | Text in images, PDFs, documents, forwarded messages, quoted email and web pages | Data, never instructions. The protocol tells the model so; the sandbox limits what a misled model can do |

*Cost of the programs that face the outside:* wacli and the email reader can reach the internet. A malicious version of either, or of a library the reader uses, could send out what it holds, the WhatsApp session and the messages it handles, or the mailbox's password and the emails, and could hand the bridge fake messages from the owner.

### Processes and users

| Process | User | Started by | Can reach |
|---|---|---|---|
| Bridge | root | systemd, or Docker | Every data folder, being root; it leaves `config/` alone |
| wacli | `scooter-wacli` | the bridge | `wacli/` |
| Email reader | `scooter-mail` | the bridge | `mail/` |
| restic | root | the bridge | The folders it backs up |
| Runner | `scooter-runner`, group `kvm` | systemd, or Docker | `agents/`, `exchange/`, `runner/`; `datastore/` and `config/` read-only |
| QEMU | `scooter-runner` | the runner, through Gondolin | What the runner mounts |
| pi | the VM's own root | the runner | The mounts |

Scooter has four users: root for the bridge, `scooter-wacli`, `scooter-runner` and `scooter-mail`. The prefix keeps them apart from accounts a system already has: Debian and Ubuntu ship a `mail` user (uid 8 on Ubuntu 24.04, whose group can write the system's mail spool, `/var/mail`), and Debian 12's and Alpine 3.24's images have one too; the `node:24-trixie-slim` image wasn't pulled to check, but Debian's base system defines the account. Sharing an account would share its files and its environment.
- Natively, `setup` makes them as system users, which the system numbers, and everything refers to them by name ([install](architecture/install.md) (not yet written)).
- In Docker, the image gives them the uids 10001, 10002 and 10003, so the data volume's files are theirs in every container. The runner runs as `scooter-runner` in every Docker setup, rootless Docker included.
- `scooter-runner` is also in the host's `kvm` group.

### Folders and their owners

Paths are under the data folder: `DATA_DIR`, `/var/lib/scooter` in a native install and `/data` in Docker. The config folder is `CONFIG_DIR`.

| Folder | Owner and mode | Bridge | Runner | pi | wacli | Email reader |
|---|---|---|---|---|---|---|
| `datastore` | root, group `scooter-runner`; folders 0750, files 0640 | writes | reads | reads | no | no |
| `agents` | `scooter-runner`, 0700 | reads; writes only on restore | writes | reads, except `sessions/`; writes `views/`, `memory/`, `run/session/` | no | no |
| `exchange` | `scooter-runner`, 0700 | takes entries, and keeps a sending file of each in `bridge/`; writes `backup.lock` | writes entries and `run.lock` | no | no | no |
| `runner` | `scooter-runner`, 0700 | reads the network log and `status.json`; connects to `runner.sock` | writes | no | no | no |
| `bridge` | root, 0700 | writes | no | no | no | no |
| `wacli` | `scooter-wacli`, 0700 | copies media out of `staging/` | no | no | writes | no |
| `mail` | `scooter-mail`, 0700 | takes spool folders | no | no | no | writes |
| `config` | root, group `scooter-runner`; folders 0750, files 0640 | no | reads | sees only the run's copy | no | no |

What each holds: `datastore`, the log and its attachments; `agents`, one folder per agent ([the runner](architecture/runner.md) (not yet written)); `exchange`, `outbox/` and `locks/`; `runner`, the network log, the VM image, `status.json`, and the runner's home and temporary folder; `bridge`, the bridge's state, its own outbox, its sending files, `incoming/` and restic's cache; `wacli`, the WhatsApp session and wacli's message store; `mail`, the email reader's position and its spool; `config`, `agents.yaml`, the prompt, the skills and the VM image's build file, in Docker a read-only bind mount of `./config`.

The data folder itself is root's, 0755: every service user passes through it to reach its own. Each service's environment holds only its own settings, and each reads only its own env file ([Secrets](#secrets)). The folders are passive: nothing in them runs. pi sees only what the runner mounts into its VM.

**In Docker** one named volume holds the whole data folder, at `/data` in every container, so that `build-image` and `restore` work in it as natively, and the bridge reaches `runner/runner.sock`. What each service reads and writes is then kept by the owners and modes above, as natively, and a new volume starts as a copy of the image's `/data`, whose folders have them. *Cost:* read-only mounts were a second wall, and are gone: the bridge, as root, could write `runner/`, which it only reads, as it can natively, and the runner's container sees the names of the bridge's, wacli's and the email reader's folders, not what they hold.

### Folders other users control

The bridge, as root, takes what it needs out of three folders other users control: `mail/spool/` ([The spool, the bridge's side](architecture/email.md#the-spool-the-bridges-side)), `wacli/staging/` ([Downloads](architecture/whatsapp.md#downloads)) and `exchange/outbox/` ([Taking entries from the runner's outbox](architecture/delivery.md#taking-entries-from-the-runners-outbox)). Each such user could put a link where the folder was, or in a file's place. So, in every one:

- **It uses the folder only while it is that user's folder and not a link** (`checkOwnFolder`). Otherwise it takes and removes nothing there.
- **It reads a file only without following a link**, and only a regular file with one name, of a bounded size, and the user's where it knows the user ([Files another program controls](architecture/shared-code.md#files-another-program-controls)).
- **It removes only the names it gives or expects there**, a folder only once that empties it, and leaves what it doesn't know, logged once. It never removes what that user couldn't remove itself. *Why:* the review of the email channel made `mail/spool` a link to the data folder, and the bridge, removing everything under it as root, deleted `agents`, `bridge` and `datastore` within three looks.
- **What it leaves there stays** until that user removes it; a well-behaved email reader, wacli or runner leaves nothing of the kind.
- **It writes nothing in them**, but `backup.lock` in `exchange/locks/`, which the runner must see where it looks ([The locks](architecture/exchange.md#the-locks)). Its sending files, and its own entries, are in `bridge/` ([Sending an entry](architecture/delivery.md#sending-an-entry)).
- **Where root makes a folder in a folder another user owns**, as `setup` and the bridge make wacli's, it sets the folder's owner and mode through what it opened, which follows no link (`settleFolder`). *Why:* the folder's owner could rename what root made and put a link in its place between the making and the `chmod` and `chown`, and be given whatever the link led to, `/etc/shadow` among them.

*Cost, accepted:* Node has no calls relative to a folder it has open (`openat`, `unlinkat`), so a user who controls one of these folders can swap a link in between the bridge's check of it and its use. Such a swap reaches only files with the names the bridge removes there, which nothing else of Scooter's or the system's has, and empty folders, which are all a folder's removal takes; and where the bridge makes `backup.lock`, under that name. Only the runner's user controls `exchange/`, and an escape from pi's VM is needed to reach it.

`build-image`, as root on a native install, also works beside a folder another user controls, the runner's: [the VM image](architecture/sandbox.md) (not yet written).

### The network

| From | To | Notes |
|---|---|---|
| wacli | WhatsApp | outbound. Texts go out with link previews off, so wacli fetches no link ([Sending](architecture/whatsapp.md#sending)) |
| Email reader | the mailbox's IMAP server, port 993 by default | outbound, TLS |
| restic | the backup bucket | outbound, HTTPS |
| wacli | the bridge, `127.0.0.1`, `WEBHOOK_PORT` | loopback only, signed |
| Runner | `openrouter.ai`; public HTTPS hosts when internet is on | outbound, on pi's behalf |
| pi's VM | nothing | everything goes through the policy |
| Outside | nothing | no port is published |

### Secrets

| Secret | Kept in | Reaches |
|---|---|---|
| WhatsApp session | `wacli/` | wacli |
| Webhook secret | the bridge's memory ([Running wacli](architecture/whatsapp.md#running-wacli)) | wacli's command line |
| Mailbox password | `bridge.env` | the email reader's environment |
| Backup password and bucket keys | `bridge.env` | restic's environment |
| OpenRouter key | `runner.env` | Gondolin's secret table in the runner; requests to `openrouter.ai` |
| The policy's certificate authority key | the runner's home, under `runner/` | the runner |

- The bridge reads `bridge.env` and the runner `runner.env`, each with only what its service needs, and neither reads the other's. The bridge reads neither `runner.env` nor `config/`.
- Within the bridge, each program gets only its own settings: [wacli](architecture/whatsapp.md#running-wacli), [the email reader](architecture/email.md#the-email-reader) and [restic](architecture/backups.md#running-restic).
- pi sees a placeholder where the key would be, which is worthless outside the runner.
- No secret goes on a command line, where every user of the machine can read it, except the webhook secret, which wacli takes no other way.

## The contracts

The interfaces between components. Changing one means changing both sides. Each is defined by one module, and its rules are in the document of the component that owns that module.

| Contract | Between | Defined in | Rules in |
|---|---|---|---|
| The datastore line | bridge → runner, pi | `src/common/datastore/line.mjs` | [The line format](architecture/datastore.md#the-line-format) |
| The channel and its record | the bridge's core ↔ the channel modules | `src/bridge/channels/index.mjs` | [Channels](architecture/bridge.md#channels) |
| wacli's webhook payload and its JSON output | wacli → the WhatsApp channel | `src/bridge/channels/whatsapp.mjs` | [wacli's formats](architecture/whatsapp.md#waclis-formats) |
| The mail spool folder, and the reader's `state.json` | email reader → the email module | `src/mail/spool.mjs` | [The spool](architecture/email.md#the-spool), [The position](architecture/email.md#the-position) |
| The outbox entry | runner, bridge → delivery | `src/common/outbox.mjs` | [Outbox entries](architecture/exchange.md#outbox-entries) |
| The lock files | bridge ↔ runner | `src/common/locks.mjs` | [The locks](architecture/exchange.md#the-locks) |
| The services' sockets | runner, rebuild, `build-image` ↔ bridge, `restore` | `src/common/instance.mjs` | [One service per data folder](architecture/shared-code.md#one-service-per-data-folder) |
| `state.json` of an agent | runner → bridge (`/status`) | `src/common/agentstate.mjs` | [the runner](architecture/runner.md) (not yet written) |
| `status.json` | runner → bridge (`/status`) | `src/common/runnerstatus.mjs` | [the runner](architecture/runner.md) (not yet written) |
| The network log line | runner → bridge, owner | `src/common/netlog.mjs` | [the network policy](architecture/network-policy.md) (not yet written) |
| The sandbox interface | runner ↔ sandbox | `src/runner/sandbox/index.mjs` | [the sandbox](architecture/sandbox.md) (not yet written) |
| The prompt | runner → pi | `src/runner/prompt.mjs` | [the runner](architecture/runner.md) (not yet written) |
| The answer | pi → runner | `src/runner/answer.mjs` | [the runner](architecture/runner.md) (not yet written) |
| `agents.yaml` | owner → runner | `src/runner/config.mjs` | [configuration](architecture/configuration.md) (not yet written) |
| The env files | owner → both services | `src/common/settings.mjs` | [configuration](architecture/configuration.md) (not yet written) |

## The code's layers

```
src/cli.mjs ──▶ one side per command

src/bridge  ──▶ src/common          no third-party libraries
src/runner  ──▶ src/common          yaml (config only), @earendil-works/gondolin (sandbox only)
src/mail    ──▶ src/common (part)   imapflow, postal-mime
src/ops     ──▶ src/common          setup and doctor
```

The rules, which `test/imports.test.mjs` checks by reading every file under `src/` (`test/support/imports.mjs`):

1. `src/common` imports nothing from the other folders.
2. `src/bridge` and `src/runner` never import each other. They share only what is in `src/common`. `src/ops` imports only `src/common`.
3. `src/mail` imports from `src/common` only `files`, `limits` and `log`, and doesn't reach `settings.mjs` through another module either.
4. Each of the four libraries is imported only where the diagram allows, `yaml` only by `src/runner/config.mjs` and Gondolin only in `src/runner/sandbox/`, and nothing else is imported that isn't a `node:` module. `src/cli.mjs` imports a command's code only with `import()`, so a command loads only its side.
5. One place for each outside contact, as the test sees it:
   - only `src/bridge/store.mjs` appends to the datastore: only it imports `encodeLine`, and nothing in `src/common/datastore/` calls a function that changes a file;
   - only `src/common/proc.mjs` imports `node:child_process`, and in the bridge only the two channel modules, `backup.mjs` and `main.mjs`, which makes the one `proc` the bridge shares and looks up its users, import `proc.mjs`;
   - the strings `'wacli'`, `'restic'` and the email reader's path appear only in the module that runs that program: `whatsapp.mjs`, `backup.mjs` and `email.mjs` (`paths.mjs` may name wacli's folder).
6. Every tuning number is in `src/common/limits.mjs`. No scan can tell a tuning number from any other number, so no test checks this one.

## Why it is built this way

- **The datastore is the only source of truth.** Views, memory, sessions and state are derived, and a rebuild can recreate them. So a bug in the runner or a bad run can cost a rebuild, never data.
- **Two services that share folders, not sockets.** The bridge and the runner never call each other: the datastore carries work one way and the outbox carries replies back. *Why:* each holds different secrets; either can be down or restart without losing anything, and neither needs the other to be up: without the runner messages are stored, and without the bridge replies wait in the outbox; nothing listens for connections; and the queue is plain files the owner can read. Every hand-off between them is atomic ([Atomic files and hand-offs](architecture/shared-code.md#atomic-files-and-hand-offs)).
- **Polling, once a second,** `POLL_INTERVAL`. No file watchers and no signals between the services. *Why:* the volume is a handful of messages a day, and a poll behaves the same on every system.
- **`seq` is the only name a message has outside the bridge.** The agent, the outbox, the runner's state and the views' `source` column all use it; channel IDs stay in the datastore and the bridge. So the agent can't name a channel or a recipient, and adding a channel changes nothing past the bridge.
- **Secrets are split by process.** Settled with the owner. The bridge has the WhatsApp session, the mailbox password and the backup credentials; the runner has the OpenRouter key; pi gets a placeholder ([Secrets](#secrets)). So no single compromise yields everything.
- **The bridge runs as root,** because it starts wacli and the email reader as other users, and reads every folder for backups. What that costs is among the README's [Known limits](../README.md#known-limits).
- **Programs that face the outside get their own user.** wacli and the email reader run third-party code that parses whatever the internet sends. Each can read and write only its own folder and sees only its own settings, and the bridge validates what they hand over.
- **The runner is its own unprivileged user.** A flaw in QEMU or the guest kernel could let pi out of its VM and into the runner; there it would reach the OpenRouter key and the agents' folders, but not the bridge's secrets.
- **One module per outside contact** ([The code's layers](#the-codes-layers)), and one module per channel, so another channel, such as Telegram, is one more module ([Channels](architecture/bridge.md#channels)).
- **Everything third-party is pinned** to an exact version, and downloads are checked against published checksums.
- **The bridge uses no third-party library.** It reads no YAML: `config/` is the runner's.

## The owner's fixed choices

These were settled with the owner. **Don't change any of them without asking the owner.**

| Topic | Choice |
|---|---|
| Channel | WhatsApp. The bot has its own number, registered in WhatsApp Business on the owner's phone. wacli v0.26.0 runs as a linked device of that number. |
| Email | The owner can also email Scooter, at a mailbox used only by Scooter. Email only comes in: Scooter never sends any, and replies about an email arrive on WhatsApp. Only mail from the owner's own addresses that passes DMARC is kept. |
| Default channel | Replies go back to the channel of the message they answer. What Scooter sends on its own, such as scheduled tasks and notices, and replies about emails go to `DEFAULT_CHANNEL`, which in v2 can only be `whatsapp`. |
| Agent | pi (`@earendil-works/pi-coding-agent`) through OpenRouter. The model is configurable; the default is `anthropic/claude-sonnet-5.5`. |
| Sandbox | pi runs in a fresh Gondolin micro-VM for every batch. The runner holds the OpenRouter key and swaps it in on pi's requests; pi only ever sees a placeholder. |
| Data retention | Every OpenRouter request goes only to endpoints that keep no prompts or responses. The runner adds OpenRouter's zero-data-retention flag to each request (`OPENROUTER_ZDR=on`, the default), and the owner also enforces it on Scooter's OpenRouter key. |
| Number of agents | One agent, named `lifelog`. The config format allows more later; v2 refuses more than one. |
| Code | Node.js, ES modules. The runner uses `yaml` to read `agents.yaml`, and `@earendil-works/gondolin` to run pi in a VM, each pinned to an exact version. The email reader, which runs apart as its own user, uses `imapflow` and `postal-mime`. The bridge uses no third-party library. Tests use `node:test`. |
| Platforms | Linux, on amd64 and arm64. pi's VMs run fast with KVM, and fall back to much slower emulation where it isn't available, such as in a container that can't open `/dev/kvm`. macOS comes later, and nothing is built or tested for it until then: the owner decided on 2026-11-15 that Scooter is Linux-only for now. |
| Deployment | The owner's choice: native systemd services, or Docker Compose with one image and two services (`bridge` and `runner`). Either way there are no published ports. |
| Backups | restic 0.19.1 to an S3-compatible bucket (Cloudflare R2 or Backblaze B2), encrypted on the server before upload, nightly. Consistency comes from stopping the writers for the length of the backup, not from snapshots. |
| Settings | Time zone, home currency, reply mode, model, the agent's internet access and how its VMs are accelerated are configurable. |
| Internet | The agent has no internet access unless the owner turns it on (`AGENT_INTERNET=on`). Off, its VM can reach only OpenRouter's two chat endpoints. On, it can also reach public HTTPS websites. In both modes the runner refuses requests that would make OpenRouter fetch from the web for the agent, and logs every request: when, which host and path, and how many bytes each way, but not what was sent. |
| Time | Every time Scooter stores or compares is in UTC: the datastore's times and day folders, the times in `state.json`, outbox IDs and logs. The owner's time zone (`SCOOTER_TZ`) is used only for what the owner sees or sets: replies, `/status`, views and day pages, the times in the agent's prompt, and the schedule settings (scheduled tasks, `BACKUP_TIME`, `SESSION_ROLLOVER_HOUR`), which code turns into UTC instants. |
| Replies | Quiet mode by default. |
| Preferences | Standing instructions the owner gives by message go in the agent's memory (`preferences.md`). There's no approval step and no change notice; git history is the audit trail. |

## Glossary

The project's own names, each used one way in these documents.

| Name | Means |
|---|---|
| owner | The one person Scooter works for, and the only one it takes messages from |
| bot | The second WhatsApp number, which the owner writes to |
| bridge | The service that talks to the channels, writes the datastore, delivers the outbox and makes backups |
| runner | The service that decides when the agent runs and on what, runs it, and keeps the books |
| pi | The coding agent program, run in a VM for each run |
| agent | pi and the model behind it, as one; `lifelog` is its name |
| channel | A way to the owner: WhatsApp or email, each one module of the bridge |
| core | The bridge apart from its channels: the store, intake, delivery, the commands and the backups |
| record | A message as a channel hands it to the core, the same for every channel |
| line | One JSON object in the datastore, for one message, edit, deletion, reaction or command, in or out |
| `seq` | A line's permanent number, and the only name a message has outside the bridge |
| datastore | The append-only log of lines, a `log.jsonl` per day folder with the attachments beside it |
| day folder | `datastore/YYYY/MM/DD`, the UTC date a line was written |
| intake | The core's half of receiving: records to lines |
| store | The datastore's one writer, `src/bridge/store.mjs` |
| index | What the bridge and the runner each keep in memory of the datastore: lines by `seq` and by channel ID, and what each message says now |
| webhook | wacli's post to the bridge, on loopback, for each message it receives |
| catch-up | The bridge listing wacli's store for what the webhook missed |
| pairing | Linking wacli to the bot's number; wacli is linked when paired |
| email reader | The program, run as `scooter-mail`, that reads the mailbox |
| spool | `mail/spool/`, where the email reader hands each email over as a folder |
| sender check | The bridge's test that an email is the owner's |
| command | `/status`, `/backup`, `/help` or `/new`, sent on WhatsApp |
| exchange | `exchange/`, the runner's folder that holds the outbox and the locks |
| outbox | Where messages to send wait as entries: the runner's, `exchange/outbox/`, and the bridge's own, `bridge/outbox/` |
| entry | One message to send, a folder holding `entry.json` |
| sending file | What the bridge keeps of an entry it is sending: the entry, and how many of its messages have gone |
| `out` line | A line for what Scooter sent |
| delivery | The bridge sending the outbox's entries |
| chunk | One message of a text that is sent as several |
| notice | A message the runner, or the bridge, sends on its own about a failure |
| lock | `run.lock` or `backup.lock`, which keep runs and backups apart |
| data folder | `DATA_DIR`: where every folder of Scooter's data is |
| config folder | `CONFIG_DIR`: the owner's `agents.yaml`, prompt, skills and the VM image's build file |
| env file | `bridge.env` or `runner.env`: a service's settings |
| owner's day | A date in `SCOOTER_TZ` |
| work item | An `in` line from a source the agent reads, of kind `message`, `edit` or `delete` |
| batch | The work items one run is given |
| run | One run of pi, in one VM, on one batch or task |
| view | A file the agent keeps in `views/`: a CSV or a day page |
| memory | The agent's `memory/`: the owner's standing instructions and the open questions |
| session | pi's conversation, kept by the runner for each of the owner's days |
| network policy | The runner's rules for what pi's VM may send |
| network log | The runner's log of every request pi's VM made |
| placeholder | What pi's VM holds where the OpenRouter key would be |
| rebuild, backfill | Replaying history through the agent: all of it again, or for one new view |

## To change X, look here

| To change | Modules | Tests | Documents |
|---|---|---|---|
| The line format | `src/common/datastore/line.mjs`, `src/bridge/store.mjs`, `src/common/datastore/index.mjs`, every reader of a line | `test/datastore.test.mjs`, `test/intake.test.mjs`, `test/batch.test.mjs` | [datastore](architecture/datastore.md), [the runner](architecture/runner.md) (not yet written) |
| What becomes a line, attachments, commands recognized | `src/bridge/intake.mjs`, `src/bridge/channels/index.mjs` | `test/intake.test.mjs`, `test/bridge.test.mjs` | [bridge](architecture/bridge.md), [datastore](architecture/datastore.md) |
| WhatsApp: webhook, filters, owner matching, catch-up, downloads, `pair` | `src/bridge/channels/whatsapp.mjs` | `test/whatsapp.test.mjs`, `test/support/wacli-stub.mjs`, `test/tools/wacli.test.mjs` | [whatsapp](architecture/whatsapp.md) |
| Email: the reader, parsing, the spool, the sender check, `email-check` | `src/mail/`, `src/bridge/channels/email.mjs` | `test/email.test.mjs`, `test/mail-reader.test.mjs`, `test/mail-imap.test.mjs`, `test/mail-parse.test.mjs` | [email](architecture/email.md) |
| Another channel | a module in `src/bridge/channels/`, `src/bridge/main.mjs`, `SOURCES` in `src/common/datastore/line.mjs` | `test/support/fake-channel.mjs`, `test/routing.test.mjs` | [bridge](architecture/bridge.md), [delivery](architecture/delivery.md) |
| Routing, chunks, pacing, failed sends | `src/bridge/outbox.mjs` | `test/delivery.test.mjs`, `test/routing.test.mjs` | [delivery](architecture/delivery.md) |
| The outbox entry, or the locks | `src/common/outbox.mjs`, `src/common/locks.mjs`, and both services' users of them | `test/outbox.test.mjs`, `test/locks.test.mjs`, `test/delivery.test.mjs`, `test/backup.test.mjs`, `test/runner.test.mjs` | [exchange](architecture/exchange.md) |
| A command the bridge answers, or `/status` | `src/bridge/commands.mjs` (`HELP_TEXT`), `src/bridge/status.mjs`, `COMMANDS` in `src/common/datastore/line.mjs` | `test/status.test.mjs`, `test/bridge.test.mjs` | [bridge](architecture/bridge.md) |
| Backups and restore | `src/bridge/backup.mjs` | `test/backup.test.mjs`, `test/support/restic-stub.mjs` | [backups](architecture/backups.md) |
| Files, programs, logs, time, sockets | `src/common/files.mjs`, `src/common/proc.mjs`, `src/common/log.mjs`, `src/common/time.mjs`, `src/common/instance.mjs` | `test/files.test.mjs`, `test/proc.test.mjs`, `test/log.test.mjs`, `test/time.test.mjs` | [shared code](architecture/shared-code.md) |
| A constant | `src/common/limits.mjs` | `test/limits.test.mjs` | the document of the component that uses it; [configuration](architecture/configuration.md) (not yet written) |
| A setting | `src/common/settings.mjs`, the example env file | `test/settings.test.mjs`, `test/cli.test.mjs` | the document of the component that reads it; [configuration](architecture/configuration.md) (not yet written) |
| A command of the CLI | `src/cli.mjs` | `test/cli.test.mjs` | [configuration](architecture/configuration.md) (not yet written) |
| `agents.yaml` | `src/runner/config.mjs`, `config/agents.yaml` | `test/config.test.mjs`, `test/instructions.test.mjs` | [configuration](architecture/configuration.md) (not yet written) |
| When the agent runs, the batch, the prompt | `src/runner/triggers.mjs`, `src/runner/batch.mjs`, `src/runner/prompt.mjs` | `test/triggers.test.mjs`, `test/batch.test.mjs`, `test/planning.test.mjs` | [the runner](architecture/runner.md) (not yet written) |
| Reading the answer, after a run, failures | `src/runner/answer.mjs`, `src/runner/run.mjs`, `src/runner/failures.mjs`, `src/runner/git.mjs`, `src/runner/agentdir.mjs` | `test/answer.test.mjs`, `test/run.test.mjs`, `test/failures.test.mjs`, `test/runner.test.mjs`, `test/agentdir.test.mjs` | [the runner](architecture/runner.md) (not yet written) |
| Rebuilds and backfills | `src/runner/rebuild.mjs`, `src/runner/backfill.mjs`, `src/runner/replay.mjs` | `test/rebuild.test.mjs`, `test/backfill.test.mjs`, `test/replay.test.mjs` | [rebuild and backfill](architecture/rebuild-and-backfill.md) (not yet written) |
| The sandbox or the VM image | `src/runner/sandbox/`, `config/image/build.json` | `test/sandbox.test.mjs`, `test/image.test.mjs`, `test/accel.test.mjs`, `test/tools/vm.test.mjs` | [the sandbox](architecture/sandbox.md) (not yet written) |
| The network policy or its log | `src/runner/sandbox/policy.mjs`, `src/runner/sandbox/netlog.mjs`, `src/common/netlog.mjs` | `test/policy.test.mjs`, `test/fixtures/pi-requests/` | [the network policy](architecture/network-policy.md) (not yet written) |
| The agent's instructions | `src/runner/protocol.md`, `config/prompts/`, `config/skills/` | `test/instructions.test.mjs` | [the agent](architecture/agent.md) (not yet written) |
| The native install or Docker | `src/ops/`, `deploy/systemd/`, `Dockerfile`, `compose.yaml`, `compose.kvm.yaml`, `compose.kvm-rootless.yaml` | `test/setup.test.mjs`, `test/doctor.test.mjs`, `test/units.test.mjs`, `test/docker.test.mjs` | [install](architecture/install.md) (not yet written), the [README](../README.md) |

## Deferred and out of scope

**Deferred with macOS:** launchd daemons for the two services; Apple's hypervisor for pi's VMs (`AGENT_ACCEL=hvf`, which stays a known value and fails on Linux, as any accelerator that can't be used does); a data folder such as `/usr/local/var/scooter` in `setup`; running under Docker Desktop, OrbStack or Colima; and the test suite passing on a Mac. Notes for then:
- Scooter works only while the Mac is awake, so stop it from sleeping (System Settings › Energy, or `caffeinate -s`). Catch-up collects what arrived while it slept.
- Docker Desktop gives containers no hypervisor, so on a Mac the native install is the fast one.
- With Docker Desktop, OrbStack or Colima, keep the project folder in the home folder (Colima shares only that), and set Docker to start at login so `restart: unless-stopped` brings Scooter back.

**Not run:** arm64, which the machine Scooter was built on can't run ([Known limits](../README.md#known-limits)). The code stays architecture-neutral.

**Out of scope for v2:**
- More than one agent, and channels other than WhatsApp and the owner's email, such as Telegram or bank alerts.
- Sending email, and keeping email from anyone but the owner.
- Approvals for preference changes, notices about them, and an `/undo` command.
- A `/retry` command that puts messages in `failed` back in the queue. Until then, editing or resending a message brings it back.
- Group chats, and messages typed directly on the bot's phone.
- Voice transcription, reminders, and a web interface.
- Answering questions about the data, sending views as files, and acting for the owner, such as creating calendar events. These belong to a separate assistant agent, later.

**Where later work plugs in:**

| Later | Plugs in at | Already there |
|---|---|---|
| Telegram, or another channel | A module in `src/bridge/channels/` | The channel's members; `source` on every line; routing by the line an entry points at |
| Bank feeds and other data that isn't the owner's words | A channel that writes lines with `trust: "external"` | The `trust` field; `reads` per agent |
| More agents | `agents.yaml` | The map of agents; `reads`; `by` on `out` lines; one folder per agent |
| The assistant | A reader of the views | Views in git, written only by Scooter |

## Old text, still to be moved

The text of the old `docs/ARCHITECTURE.md` for the components whose documents pieces 2 and 3 write, as it was, but for its headings, one level down, and references that would otherwise lead nowhere. Numbers in parentheses, such as (6.6), are sections of `docs/DESIGN.md`. It goes as those documents are written.

### 2. Components

#### 2.6 The runner

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

#### 2.7 The sandbox

Every run gets a fresh Gondolin micro-VM on QEMU, booted from an image Scooter builds: Alpine with Node, the pinned pi, `pdftotext`, `heif-convert`, git, ripgrep, fd, `tzdata` and `curl` (6.6, 6.12).

- **Mounts**, at the same paths as on the host: the agent's folder read-only, except `views/`, `memory/` and `run/session/`, which are writable, and `sessions/`, which is hidden; and the datastore read-only. Nothing else from the host is visible.
- **Environment:** a short fixed list, with a placeholder where the key would be.
- **Acceleration:** KVM when the runner can open `/dev/kvm`, otherwise emulation, which is announced. A forced accelerator that can't be used stops the runner.
- **Lifetime:** the runner closes the VM when pi exits or the timeout passes. Nothing inside it survives.
- **Limits:** the sandbox keeps the start of pi's answer and the end of its errors, and closes the VM of a run that writes more, or makes more files, than a run may, so nothing pi does can stop the runner or fill the disk the bridge writes on (6.6).
- **The image:** `build-image` builds it, natively as root or in a container (in Docker, a privileged container of its own), in a folder beside the runner's, records what it holds beside it, and renames it into the runner's folder when it is complete. The runner refuses to start with a missing image, one built for another pi, or one that doesn't know the owner's time zone (6.12).

The runner reaches it through one small interface: run this command, with these mounts, this environment, this timeout and this policy, and return the exit code and output. Tests use a fake that runs a stub of pi as a local process.

#### 2.8 The network policy and its log

The VM has no network of its own. Gondolin's host side, inside the runner's process, handles everything it sends (6.13):

- DNS is answered inside the runner with made-up addresses.
- UDP, raw TCP and private addresses are refused.
- HTTP(S) goes out only to allowed hosts. The runner terminates the VM's TLS with its own certificate authority, so it sees each request in full.

The rules for what goes out:
- **Hosts:** `openrouter.ai`; with `AGENT_INTERNET=on`, also any public host over HTTPS.
- **The key:** swapped in for the placeholder only on requests to `openrouter.ai`, and only in the header pi sends it in. A request there with a key of its own is refused, as is one elsewhere that carries the placeholder or the key.
- **Requests to OpenRouter:** only the two chat routes, only the configured model, only the fields and tools the pinned pi sends, and only inline images and documents. The runner forwards its own re-encoding of the body it checked.
- **Zero data retention:** set on every request.

Every request is logged before it leaves, without headers, bodies or query strings, and its status as soon as it arrives, from the HTTP client's diagnostics events, which hold back no streamed answer. What one run adds to the log is bounded. Three things read the log: the runner, to learn why a run failed; the bridge, for the counts in `/status`; and the owner. The policy is `src/runner/sandbox/policy.mjs`, and the log's writer `netlog.mjs` beside it (`docs/DECISIONS.md`, milestone 8).

#### 2.9 pi and its instructions

pi is a third-party coding agent, run headless with every kind of discovery turned off and seven tools: `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`.

It is given:
- the **prompt**: the batch, with times in the owner's time zone;
- the **system prompt**: the protocol, which ships with the runner; the agent's prompt, from `config/`; and the current memory;
- the **skills**, from that run's copy of `config/`.

It produces changes to `views/` and `memory/`, and a final answer that ends with protocol lines (`DONE`, `FAILED`, `REPLY_TO`, `NO_REPLY`).

**Boundaries.** pi holds no secret, has no network of its own, and can write only `views/`, `memory/` and its session copy. It can't change its config, the state, the git history, the datastore, the outbox or any other session. It can't read the other sessions either: `sessions/` is hidden from the VM.

#### 2.10 The agent's folder

`agents/lifelog/` is a git repository owned by the runner (6.2):

| Path | Holds | In git |
|---|---|---|
| `views/` | The CSVs and the day pages | yes |
| `memory/` | `preferences.md` and `needs-review.md` | yes |
| `sessions/` | pi's sessions, hidden from the VM; pi only ever gets a copy of the current one | no |
| `run/` | Rebuilt before each run: `system.md`, `config/`, `session/` | no |
| `state.json` | The runner's bookkeeping | no |

The runner is the only committer. Git history is the audit trail for everything the agent changed.

#### 2.12 Configuration

| What | Where | Read by | Changed by |
|---|---|---|---|
| Agents, prompts, skills, the VM image's build file | `config/` | the runner only | the owner |
| Settings and secrets | `bridge.env`, `runner.env` | each service its own ([Secrets](#secrets)) | the owner |
| Tuning constants | `src/common/limits.mjs` | code | a code change |

#### 2.13 The CLI

`src/cli.mjs` is the one entry point. Each command belongs to one side and loads only that side's settings (8.4):

| Side | Commands |
|---|---|
| Bridge | `bridge`, `pair`, `email-check`, `backup-init`, `snapshots`, `check`, `restore` |
| Runner | `runner`, `doctor`, `rebuild` |
| Root, on the host | `setup`, `build-image` |

### 4. Dependencies

#### 4.1 At run time

| Component | Needs | For | When it's missing |
|---|---|---|---|
| Runner | the bridge | nothing | It works through what's in the datastore; replies wait in the outbox |
| Runner | a valid `agents.yaml` | starting | It stops, naming the field |
| Runner | the VM image, built for the pinned pi | starting | It stops, saying to run `build-image` |
| Runner | an accelerator | speed | It falls back to emulation and tells the owner, unless one was forced |
| Runner | OpenRouter | every run | A refused key, model or credit pauses runs; an outage is retried with backoff. Messages wait and none ends up failed |
| pi | the policy, the mounts | everything | The run fails and is retried |

#### 4.3 Third-party

| Dependency | Version | Used by | Note |
|---|---|---|---|
| Node.js | ≥ 22.19 | everything | Gondolin and pi need it |
| pi (`@earendil-works/pi-coding-agent`) | 1.5.2 | inside the VM image | The policy's allowlists match this version's requests |
| Gondolin (`@earendil-works/gondolin`) | 0.14.0 | sandbox | Pre-1.0; the next version changes how hooks run |
| QEMU | the host's | sandbox | With KVM where available |
| `yaml` | 2.9.1 | runner config | |
| OpenRouter | | runner | The model is configurable; default `anthropic/claude-sonnet-5.5` |

#### 4.4 Starting up

**Runner:** load `runner.env`; validate `agents.yaml`; free what pi left, then create the agent's folder if it's new and throw away a run's uncommitted changes; check the image and pick the accelerator; remove a leftover `run.lock`; write `status.json`; run any `once` task and start any backfill; then loop.

### 5. Flows

#### 5.1 A run

1. **Trigger.** There are work items after the cursor, or retries that are due, and the runner saw the newest incoming line arrive at least 8 seconds ago. Runs aren't paused.
2. **Commands.** The runner handles command lines it hasn't handled yet. `/new` bumps the session.
3. **Batch.** Due retries first, then new work items, oldest first, up to 20 and up to the prompt's size limit. An edit or deletion brings in the message it changes.
4. **Lock.** Take `run.lock`, as [The locks](architecture/exchange.md#the-locks) says.
5. **Prepare.** Write `run/system.md`, copy the prompt and skills into `run/config/`, and copy the current session into `run/session/`.
6. **Run.** Boot the VM, run pi, close the VM.
7. **After a successful run**, in this order: check the files, commit, copy the session back, write the outbox entries, update the state. A crash part-way only means the batch runs again. An error in checking or committing the files fails the run, as an unexpected file does.
8. **Release** the lock.

#### 5.2 A failed run

The runner throws away the run's session changes and its uncommitted changes: it empties `run/session/`, sets `views/` and `memory/` aside, removes what it set aside, and takes the last commit's back. Nothing pi left can stop that, however deep it goes or however full it left the disk: everything pi wrote is freed before anything new is made. Then it reads OpenRouter's last response during the run from the network log:

| Cause | Sign | What happens |
|---|---|---|
| Setup error | 401, 402, 403 or 404 | Runs pause. A try every 30 minutes and on restart. No item counts an attempt |
| Outage | 408, 429, 5xx, or no answer | Tries after 1, 5 and 30 minutes, then every 30. No item counts an attempt |
| Anything else | pi crashed or timed out, or left an unexpected file, or files that couldn't be checked or committed | Every item counts an attempt and is due again in a minute. After 4, it moves to `failed` |

The owner gets one notice for the first failure in a row, and one when items are given up on.

An error that stops the runner itself, such as a state it can't save, has its service manager start it again: natively systemd waits 1 minute, about 5½, then 30 between starts; where the service manager doesn't wait, as in Docker, the runner keeps the same waits itself, in `runner/restarts.json`, and `/status` shows them, so a fault that stays after pi has run can't run pi every few seconds (`docs/DECISIONS.md`, D207, D229).

#### 5.5 Rebuild and backfill

Both replay history through the agent, one of the owner's days at a time, with the prompt's `Now:` set to the time of the batch, and without sending anything.

- **`rebuild`** runs with the runner stopped, and holds the runner's socket, so no runner starts during it. It tags the last commit, empties the views, memory and sessions, replays the whole datastore up to the newest `seq` at the time it started, keeping its progress in memory and waiting for an item tried again before it goes on, and commits the result as one commit (`src/runner/rebuild.mjs`). Its own steps, like its batches, take `run.lock` and give way to a backup.
- **A backfill** fills one new view. It runs inside the runner, only when nothing live is waiting, with its own cursor and retry list, and may change only the paths it names and the day pages (`src/runner/backfill.mjs`).

What the two share, the batches of one day, their time and sessions, is in `src/runner/replay.mjs`, and each batch is a run like a live one (`run.mjs`), which sends nothing.

### 6. Deployment on Linux

| | Native | Docker Compose | Development |
|---|---|---|---|
| Set up by | `sudo scooter setup` | `docker compose build`; the image's `/data` makes the data volume's folders | nothing |
| Services | `scooter-bridge.service` as root; `scooter-runner.service` as `scooter-runner` | `bridge` and `runner`, one image | two processes run by hand |
| Users | [Processes and users](#processes-and-users) | [Processes and users](#processes-and-users) | the developer's own ([Running programs](architecture/shared-code.md#running-programs)) |
| Data and settings | `/var/lib/scooter`, `/etc/scooter` | one volume for the data folder ([Folders and their owners](#folders-and-their-owners)); `./config` bind-mounted; an env file for each service | `DATA_DIR`, `CONFIG_DIR` |
| KVM | the `kvm` group, through `SupplementaryGroups` | `/dev/kvm` passed in: by group on rootful Docker, by a udev rule for the runner's host uid on rootless, each a Compose file of its own | the developer's `kvm` group |
| The VM image | `sudo scooter build-image` | `docker compose run --rm build-image`, a privileged container of its own | `scooter build-image`, with Docker or Podman |
| VMs die with the runner | `KillMode=control-group` | the runner is the container's main process | not guaranteed |
| Waits between the runner's starts | systemd's (`RestartSec`, `RestartSteps`) | the runner's own: Docker's restart policy doesn't wait | the runner's own, after a stop on an error |

In every mode there are no published ports.

### 7. Decisions

Each entry says what was decided, why, and what follows from it. "Settled" means it was agreed with the owner and is among [the owner's fixed choices](#the-owners-fixed-choices): don't change it without asking.

#### 7.4 The runner and the agent

24. **The agent reports in four kinds of line** at the end of its answer: `DONE`, `FAILED`, `REPLY_TO` and `NO_REPLY`. The protocol that describes them ships with the runner, not in `config/`, because the runner parses it. (6.7, 7.1)
25. **The agent never waits for the owner.** It files its best guess, marks it ❓, notes the question in `memory/needs-review.md`, and asks. An item it asked about counts as done. *So:* the runner has no "waiting for an answer" state. (7.1)
26. **After a run: files, git, session, outbox, state, in that order.** *Why:* a crash at any point only causes the batch to run again, and the agent then sees the replies already sent and the rows already filed; and the session never remembers rows a crash threw away. An error in checking or committing the files fails the run rather than stopping the runner. (6.8; `docs/DECISIONS.md`, D88 and 4.7)
27. **The cause of a failure comes from the network log.** OpenRouter's last response during the run decides between a pause, a backoff and a counted attempt. *So:* an outage or a revoked key never uses up a message's four attempts. (6.9)
28. **A batch is what arrived before a quiet moment:** 8 seconds without a new message, retries first, at most 20 items and at most the prompt's size limit. An edit or deletion brings in the message it changes, so the two are never handled out of order. (6.4, 6.5; section 8, row 12)
29. **Views and memory are in git, and the runner is the only committer.** A run that leaves anything git wouldn't record (a symlink, a dotfile, an ignored file) fails and is cleaned up. *So:* everything a run changes is visible and revertible, and nothing hidden carries over. (6.2, 6.8)
30. **Sessions belong to the runner.** `sessions/` is hidden from the VM. pi gets a copy of the current day's session, and only that one file is copied back, after a successful run. *So:* a run can extend its own session but can't read or touch another, or plant one for later. (6.6)
31. **The configuration belongs to the owner.** `config/` is read-only to the runner and invisible to pi, which sees a copy made for that run. ([What Scooter does](#what-scooter-does), 8.5)
32. **Preferences need no approval.** Settled. Standing instructions the owner gives by message go into `memory/preferences.md`; git history is the audit trail. The runner doesn't check them. ([the owner's fixed choices](#the-owners-fixed-choices), 7.4)
33. **One agent, in a format that allows more.** Settled. `agents.yaml` is a map of agents, and v2 refuses more than one. ([the owner's fixed choices](#the-owners-fixed-choices), 6.1)
34. **Replays keep the past's clock.** In a rebuild or a backfill, a batch covers one of the owner's days and the prompt's `Now:` is the batch's own time, so "today" in an old message means what it meant then. Replays send nothing. (6.10, 6.11)
35. **Quiet by default.** Settled. A handled message gets a ✅ reaction, and text is sent only for a question or an answer. ([What Scooter does](#what-scooter-does), 6.8)

#### 7.5 The sandbox and the network

36. **A fresh VM for every run.** Settled. Whatever pi does inside is gone when the VM closes, apart from what it wrote to the three writable folders. (6.6)
37. **The same paths inside the VM as on the host.** *So:* the paths in the prompt, in pi's tool calls and in the day pages' links read the same everywhere. (6.6)
38. **The VM has no network; the runner makes pi's requests.** DNS never leaves the runner, only HTTP(S) to allowed hosts goes out, and the runner sees every request in full because it terminates the VM's TLS. ([The network](#the-network), 6.13)
39. **pi never holds the key.** Settled. The VM has a placeholder, and the runner swaps in the real key only on requests to `openrouter.ai`. (6.13)
40. **An allowlist for what may be asked of OpenRouter.** Two routes, the configured model, the fields the pinned pi sends, client tools only and inline media only. The runner forwards its own re-encoding of the checked body, so a duplicated key can't show the check one value and OpenRouter another. *Why:* without this, OpenRouter could fetch from the web for the agent, past the policy and its log. *Cost:* every pi upgrade means capturing its requests again. (6.13)
41. **Zero data retention, twice.** Settled. The runner sets it on every request, and the owner enforces it on Scooter's key, because a request can tighten OpenRouter's settings but not loosen them. (6.13)
42. **Log before sending, and never log content.** The `request` line is written before the request leaves, so nothing goes out unrecorded even if the runner crashes. Lines hold hosts, paths, statuses, sizes and timings. Responses are logged from the HTTP client's events, because a response hook in Gondolin 0.14.0 would hold back streaming. (6.13)
43. **A forced accelerator fails instead of falling back.** `auto` takes the fastest available and says which; `kvm` or `emulation` is taken literally. *Why:* Gondolin falls back to emulation silently, which is about ten times slower. (6.6)
44. **VMs die with the runner.** Gondolin leaves QEMU running if the process that started it is killed, so the runner always runs under something that stops its whole process group. (6.6)
45. **Scooter builds its own VM image,** from a build file with pinned versions. It includes ripgrep and fd, which pi would otherwise download while it runs. The runner refuses to start with a missing image or one built for another pi version. (6.12)
46. **Internet is off unless the owner turns it on.** Settled. Off, the agent reaches only OpenRouter's two chat routes. On, it can also reach public HTTPS sites, and every request is still logged. ([the owner's fixed choices](#the-owners-fixed-choices), 6.13)

#### 7.6 Operations

48. **Two ways to deploy on Linux,** native services or Docker Compose, at the owner's choice. Settled. Neither publishes a port. (8.3, 8.5)
49. **Constants are not settings.** Every tuning number lives in one module, with a comment saying what it protects. A value becomes a setting only when the owner has a reason to change it, and then it gets a valid range and a test. (8.6)

### 8. Changes made to DESIGN.md while planning

DESIGN.md was updated on 2026-11-15 to include each row below. Rows 1 to 3, the owner's decisions of that day, and the other rows of the bridge's side, are beside their rules now, in the documents of [the map](#the-map). The rest were worked out while planning, each from a gap or a contradiction in DESIGN.md or from a fact about the tools, by its own rule: the simplest option that keeps the principles. The owner confirmed row 8 the same day, with the condition it states.

| # | DESIGN.md said | It now says | Why |
|---|---|---|---|
| 6 | `/status` shows the accelerator and whether ZDR is on, and backups wait for "the agent's timeout" ([/status](architecture/bridge.md#status), [The locks](architecture/exchange.md#the-locks)), but the bridge reads neither `config/` nor `runner.env` | The runner writes `runner/status.json` (accelerator, ZDR, internet, model, the image's build time, each agent's timeout and sources). `AGENT_INTERNET` becomes the runner's setting alone, where 8.2 gave it to both services, and `/status` shows it from `status.json` | The bridge needs these facts and has no other way to learn them. A second copy of the internet setting in `bridge.env` could disagree with the one the runner uses |
| 8 | `build-image` runs as the runner's user (8.4, 8.5) | Natively it runs as root and hands the image to the runner's user. Without root it uses Gondolin's container build when Docker or Podman is available. pi is installed with `--ignore-scripts`, as 8.3 does for Scooter's own packages, and the build's commands never run pi or anything else npm installed. If pi turns out not to work without its install scripts, the owner decides again | Gondolin 0.14.0 runs the build's install commands in a chroot, which needs root. *Cost:* a native build runs as root on the host, where DESIGN.md meant an unprivileged user, and a chroot doesn't contain root. What runs is Gondolin's builder, then Alpine's shell, npm and git inside the image's folder. Gondolin unpacks Alpine's packages itself and runs none of their scripts. With `--ignore-scripts`, pi's packages are only unpacked too, so none of their code runs as root. The build runs only when the owner starts it, never in a service. The owner confirmed this on 2026-11-15 |
| 11 | `/new` is handled "before building a batch" (6.4) | `state.json` also keeps `commandSeq`, the newest command handled. A `/new` applies to all work not yet given to the agent. A rebuild sets `commandSeq` to the `seq` it stops at, so old commands aren't answered again (6.10) | Without it, a crash or a failed batch would handle the same `/new` twice |
| 12 | A batch has at most 20 items (6.5), and the prompt is one command-line argument (6.6) | A batch also stops at `PROMPT_MAX_BYTES` (96 KB), always keeping at least one item. An item too long for that is shown cut, with the path to the rest | Linux refuses a single argument over 128 KB, checked on the target machine. A batch of long emails would fail on every attempt and end up in `failed` |
| 13 | pi's flags (6.6) | Also `--no-mcp` | pi 1.5.2 has MCP support built in. 13.2 lists the flag; the command in 6.6 leaves it out |
| 14 | Mounts at the host's paths (6.6) | The same, with Gondolin's own mount point moved off `/data` | Gondolin's file system mounts at `/data` by default, which is where Scooter's folders are in Docker |
| 15 | Falling back to emulation sends a notice at every startup (6.6) | Only when the accelerator changes to emulation | A runner that keeps restarting would send the bot's number a message each time |
| 16 | Where a native install keeps the code wasn't said (8.5) | The code lives in a root-owned folder every service user can read, with a system-wide Node. `setup` checks both. The runner's home and temporary folder are under `runner/` | The service users must be able to run Node and read the code. Gondolin needs a writable home and temporary folder, and its leftovers must be easy to sweep |

Kept as designed, after being considered for cutting on 2026-11-15: Docker Compose as a deployment option, backfills, `once` tasks, and daily sessions with `/new`.
