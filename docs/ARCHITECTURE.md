# Scooter: architecture

This document is the way into Scooter's design: what it does, how one message goes through it, its components and where each is described, the boundaries between them, the contracts they share, and the reasons for how it is built. It holds what belongs to no single component. Each component has a document of its own in `docs/architecture/`, with its files, its rules, the reason beside each rule that needs one, and the facts about outside tools it relies on. Each fact is stated in one place, and a document refers to another by a link to the heading.

Read this document whole, then the document of the component you change. The README is the operator's guide: installing, running and the known limits ([README](../README.md)). How to work on the code, and what "done" means, is in [AGENTS.md](../AGENTS.md).

Scope: v2 on Linux.

## What Scooter does

The owner sends receipts, run screenshots, food photos, travel tickets, notes about time spent with people, and other short notes to a second WhatsApp number, the bot. They can also email things to a mailbox of Scooter's own, such as a forwarded booking or a file. Scooter keeps every message for good. An AI agent turns the messages into spreadsheets, and asks the owner when it's unsure. Everything is backed up nightly, encrypted. Answering questions about the data, and acting for the owner, are for a separate assistant later ([Deferred and out of scope](#deferred-and-out-of-scope)).

The principles, which hold everywhere:

1. **The datastore is the source of truth.** Every message in and out is appended to it and never changed. Everything else is derived from it and can be rebuilt.
2. **Only Scooter's own code talks to the outside world.** The bridge holds the WhatsApp session, the mailbox and the backup credentials; the runner holds the OpenRouter key. The agent reaches nothing directly: everything it sends goes through the runner, which checks and logs it.
3. **The model does the judgment; code does the bookkeeping.** The runner decides what the agent works on, tracks progress, retries and commits. The agent reads messages, updates files and reports what it handled. So progress never depends on the model remembering anything.
4. **The agent is sandboxed.** pi runs in a fresh virtual machine for every batch, with no secrets, and can write only what the owner's `writes` names, by default its own views and memory, its session, and the messages it asks to send and its marks. It can reach OpenRouter and nothing else, unless the owner turns its internet access on. The runner checks and logs every request, and nothing pi does survives the VM.
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
 │ backups · status                 │ ◀───   outbox  ◀──── │ ┌──────────────────────────────┐ │
 └────────────────┬─────────────────┘                      │ │ network policy and its log   │─┼──▶ OpenRouter
                  │ restic                                 │ └──────────────▲───────────────┘ │
                  ▼                                        │ ┌──────────────┴───────────────┐ │
            backup bucket                                  │ │ pi, in a fresh VM            │ │
                                                           │ └──────────────┬───────────────┘ │
                                                           └────────────────┼─────────────────┘
                                                                            ▼
                                                                the agent's files, in git
```

1. The owner sends a receipt photo to the bot. wacli, a linked device of the bot's number, receives it and posts a signed webhook to the bridge on loopback ([The webhook](architecture/whatsapp.md#the-webhook)).
2. The WhatsApp channel checks the signature and drops anything that isn't the owner's ([From a message to a record](architecture/whatsapp.md#from-a-message-to-a-record)). Intake downloads the photo, and the store gives the message the next `seq` and appends one line to the datastore ([Intake](architecture/bridge.md#intake), [Writing](architecture/datastore.md#writing)).
3. The runner polls the datastore and sees a new work item. Once the owner has been quiet for `BATCH_SECONDS`, it builds a batch, fills in the prompt of the trigger `on: new-messages` with the batch's numbers, here 1042, takes the run lock, boots a fresh VM and runs pi in it ([When the agent runs](architecture/runner.md#when-the-agent-runs), [The prompt](architecture/runner.md#the-prompt), [A run](architecture/run.md#a-run), [A VM for each run](architecture/sandbox.md#a-vm-for-each-run)).
4. pi reads line 1042 with `show`, and the photo from the datastore, which is mounted read-only, updates `views/expenses.csv`, and runs `mark done 1042` ([send and mark](architecture/agent.md#send-and-mark)). Each request it makes to the model goes through the runner's network policy, which checks it, swaps in the real key and logs it ([the network policy](architecture/network-policy.md)).
5. The runner checks the files pi left, commits them, updates its state from pi's marks, and writes an outbox entry, here a ✅ reaction ([After a successful run](architecture/run.md#after-a-successful-run), [What send and mark leave](architecture/run.md#what-send-and-mark-leave), [Outbox entries](architecture/exchange.md#outbox-entries)).
6. The bridge takes the outbox entry, sends the reaction through wacli, and appends an `out` line to the datastore ([Sending an entry](architecture/delivery.md#sending-an-entry)).

An email takes the same way from step 2, through the email reader's spool and the sender check ([The email channel](architecture/email.md)), and the reply about it reaches the owner on WhatsApp.

## The map

Each component, its document, and its files. Every file under `src/` belongs to one component.

| Component | Document | Files |
|---|---|---|
| The datastore | [datastore.md](architecture/datastore.md) | `src/bridge/store.mjs`, `src/common/datastore/index.mjs`, `src/common/datastore/line.mjs`, `src/common/datastore/reader.mjs` |
| The bridge | [bridge.md](architecture/bridge.md) | `src/bridge/main.mjs`, `src/bridge/channels/index.mjs`, `src/bridge/intake.mjs`, `src/bridge/status.mjs`, `src/bridge/state.mjs` |
| The WhatsApp channel | [whatsapp.md](architecture/whatsapp.md) | `src/bridge/channels/whatsapp.mjs` |
| The email channel | [email.md](architecture/email.md) | `src/bridge/channels/email.mjs`, `src/mail/reader.mjs`, `src/mail/imap.mjs`, `src/mail/parse.mjs`, `src/mail/spool.mjs` |
| Delivery | [delivery.md](architecture/delivery.md) | `src/bridge/outbox.mjs` |
| The exchange | [exchange.md](architecture/exchange.md) | `src/common/outbox.mjs`, `src/common/locks.mjs` |
| Backups | [backups.md](architecture/backups.md) | `src/bridge/backup.mjs` |
| Shared code | [shared-code.md](architecture/shared-code.md) | `src/common/files.mjs`, `src/common/proc.mjs`, `src/common/instance.mjs`, `src/common/log.mjs`, `src/common/time.mjs`, `src/common/paths.mjs` |
| The runner | [runner.md](architecture/runner.md) | `src/runner/main.mjs`, `src/runner/triggers.mjs`, `src/runner/batch.mjs`, `src/runner/prompt.mjs`, `src/runner/datastore.mjs`, `src/runner/state.mjs`, `src/runner/status.mjs`, `src/runner/restarts.mjs`, `src/common/agentstate.mjs`, `src/common/runnerstatus.mjs` |
| A run, and the agent's folder | [run.md](architecture/run.md) | `src/runner/run.mjs`, `src/runner/report.mjs`, `src/runner/failures.mjs`, `src/runner/agentdir.mjs`, `src/runner/git.mjs` |
| Backfill | [backfill.md](architecture/backfill.md) | `src/runner/enqueue.mjs`, `src/runner/backfill.mjs`, `src/runner/replay.mjs`, `src/common/jobfile.mjs` |
| The sandbox and the VM image | [sandbox.md](architecture/sandbox.md) | `src/runner/sandbox/index.mjs`, `src/runner/sandbox/gondolin.mjs`, `src/runner/sandbox/view.mjs`, `src/runner/sandbox/accel.mjs`, `src/runner/sandbox/image.mjs`, `config/image/build.json` |
| The network policy | [network-policy.md](architecture/network-policy.md) | `src/runner/sandbox/policy.mjs`, `src/runner/sandbox/netlog.mjs`, `src/common/netlog.mjs` |
| The agent and its instructions | [agent.md](architecture/agent.md) | `src/runner/vm/skills/scooter/SKILL.md`, `src/runner/vm/bin/show.mjs`, `src/runner/vm/bin/send.mjs`, `src/runner/vm/bin/mark.mjs`, `src/runner/vm/icu-tz/zoneinfo64.res`, `src/runner/vm/icu-tz/metaZones.res`, `src/runner/vm/icu-tz/timezoneTypes.res`, `src/runner/vm/icu-tz/windowsZones.res`, `src/runner/vm/icu-tz/release.txt`, `src/runner/vm/icu-tz/LICENSE`, `src/runner/vm/icu-tz/README.md`, `config/prompts/lifelog.md`, `config/skills/expenses/SKILL.md`, `config/skills/meals/SKILL.md`, `config/skills/people/SKILL.md`, `config/skills/runs/SKILL.md`, `config/skills/travel/SKILL.md` |
| Configuration and the CLI | [configuration.md](architecture/configuration.md) | `src/cli.mjs`, `src/common/settings.mjs`, `src/common/limits.mjs`, `src/runner/config.mjs`, `config/agents.yaml`, `bridge.env.example`, `runner.env.example` |
| Install, native and Docker | [install.md](architecture/install.md) | `src/ops/setup.mjs`, `src/ops/doctor.mjs`, `deploy/systemd/scooter-bridge.service`, `deploy/systemd/scooter-runner.service`, `Dockerfile`, `.dockerignore`, `compose.yaml`, `compose.kvm.yaml`, `compose.kvm-rootless.yaml` |

The exchange, the folder the two services coordinate through, is a component of its own, since both services follow its two contracts. The runner is two components, its planner and service, and a run with the agent's folder, which the runner owns and is the only committer of: one document would be too long to read whole. `src/common/` is split by what each file defines: a format goes with the component that owns the contract, and what belongs to no side is shared code.

## The boundaries

### Trust

| Level | What | How it's treated |
|---|---|---|
| The owner | Their WhatsApp IDs ([Owner matching](architecture/whatsapp.md#owner-matching)); their email addresses, when the mail passes DMARC ([The sender check](architecture/email.md#the-sender-check)) | The only source of instructions |
| Scooter's own code | The bridge and the runner | Holds the secrets. The bridge's process loads no third-party library; the runner's loads `yaml` and Gondolin |
| Third-party programs that face the outside | wacli; the email reader, with `imapflow` and `postal-mime` | Their own users, their own folders, only their own settings. What they hand over is validated |
| A third-party program with the bridge's privileges | restic | Pinned and checksummed ([Running restic](architecture/backups.md#running-restic)) |
| The agent | pi, and the model behind it | No secrets, no network of its own, and only what `writes` names, its session, and its places in `run/` for `send` and `mark`, to write. What it writes passes the file check and git, and what `send` and `mark` leave is read as files it controls; nothing it prints decides anything, and of a run that fails only the last line on stderr is read, for OpenRouter's own words |
| Content | Text in images, PDFs, documents, forwarded messages, quoted email and web pages | Data, never instructions. The runner's skill tells the model so; the sandbox limits what a misled model can do |

*Cost of the programs that face the outside:* wacli and the email reader can reach the internet. A malicious version of either, or of a library the reader uses, could send out what it holds, the WhatsApp session and the messages it handles, or the mailbox's password and the emails, and could hand the bridge fake messages from the owner.

### Processes and users

| Process | User | Started by | Can reach |
|---|---|---|---|
| Bridge | root | systemd, or Docker | Every data folder, being root |
| wacli | `scooter-wacli` | the bridge | `wacli/` |
| Email reader | `scooter-mail` | the bridge | `mail/` |
| restic | root | the bridge | The folders it backs up |
| Runner | `scooter-runner`, with the `kvm` group where it is given | systemd, or Docker | `agents/`, `exchange/`, `runner/`; `datastore/` and `config/` read-only |
| QEMU | `scooter-runner` | the runner, through Gondolin | What the runner shows the VM |
| pi | the VM's own root | the runner | What the runner shows the VM, and changes only what `writes` names, its session, and what `send` and `mark` write |

Scooter has four users: root for the bridge, `scooter-wacli`, `scooter-runner` and `scooter-mail`. The prefix keeps them apart from accounts a system already has: Debian and Ubuntu ship a `mail` user (uid 8 on Ubuntu 24.04, whose group can write the system's mail spool, `/var/mail`), and Debian 12's and Alpine 3.24's images have one too; the `node:24-trixie-slim` image wasn't pulled to check, but Debian's base system defines the account. Sharing an account would share its files and its environment.
- Natively, `setup` makes them as system users, which the system numbers, and everything refers to them by name ([setup](architecture/install.md#setup)).
- In Docker, the image gives them the uids 10001, 10002 and 10003, so the data volume's files are theirs in every container. The runner runs as `scooter-runner` in every Docker setup, rootless Docker included.
- Natively, `scooter-runner` is also in the `kvm` group. How it reaches `/dev/kvm` in Docker is in [KVM](architecture/install.md#kvm).

### Folders and their owners

Paths are under the data folder: `DATA_DIR`, `/var/lib/scooter` in a native install and `/data` in Docker. The config folder is `CONFIG_DIR`.

| Folder | Owner and mode | Bridge | Runner | pi | wacli | Email reader |
|---|---|---|---|---|---|---|
| `datastore` | root, group `scooter-runner`; folders 0750, files 0640 | writes | reads | reads, as the default `reads` names it | no | no |
| `agents` | `scooter-runner`, 0700 | reads; writes only on restore | writes | what `reads` names, by default its own folder, never `sessions/` or `jobs/`; writes what `writes` names, by default `views/` and `memory/`, and `run/session/`, `run/send/` and `run/marks.txt` | no | no |
| `exchange` | `scooter-runner`, 0700 | takes entries, and keeps a sending file of each in `bridge/`; writes `backup.lock` | writes entries and `run.lock` | no | no | no |
| `runner` | `scooter-runner`, 0700 | reads the network log and `status.json`; connects to `runner.sock` | writes | no | no | no |
| `bridge` | root, 0700 | writes | no | no | no | no |
| `wacli` | `scooter-wacli`, 0700 | copies media out of `staging/` | no | no | writes | no |
| `mail` | `scooter-mail`, 0700 | takes spool folders | no | no | no | writes |
| `config` | root, group `scooter-runner`; folders 0750, files 0640 | no | reads | sees only the run's copy | no | no |

What each holds: `datastore`, the log and its attachments; `agents`, one folder per agent ([The agent's folder](architecture/run.md#the-agents-folder)); `exchange`, `outbox/` and `locks/`; `runner`, the network log, the VM image, `status.json`, and the runner's home and temporary folder; `bridge`, the bridge's state, its `status.json` in a folder of its own, `status/`, its own outbox, its sending files, `incoming/` and restic's cache; `wacli`, the WhatsApp session and wacli's message store; `mail`, the email reader's position and its spool; `config`, `agents.yaml`, the prompt, the skills and the VM image's build file, in Docker a read-only bind mount of `./config`.

The data folder itself is root's, 0755: every service user passes through it to reach its own. Each service's environment holds only its own settings, and each reads only its own env file ([Secrets](#secrets)). The folders are passive: nothing in them runs. pi sees only what the runner shows its VM: what the agent's `reads` and `writes` name, which the owner may set to name any of these folders ([agents.yaml](architecture/configuration.md#agentsyaml)), and the table gives what the default names.

**In Docker** one named volume holds the whole data folder, at `/data` in every container, so that `build-image` and `restore` work in it as natively, and the bridge reaches `runner/runner.sock`. What each service reads and writes is then kept by the owners and modes above, as natively, and a new volume starts as a copy of the image's `/data`, whose folders have them. *Cost:* read-only mounts were a second wall, and are gone: the bridge, as root, could write `runner/`, which it only reads, as it can natively, and the runner's container sees the names of the bridge's, wacli's and the email reader's folders, not what they hold.

### Folders other users control

The bridge, as root, takes what it needs out of three folders other users control: `mail/spool/` ([The spool, the bridge's side](architecture/email.md#the-spool-the-bridges-side)), `wacli/staging/` ([Downloads](architecture/whatsapp.md#downloads)) and `exchange/outbox/` ([Taking entries from the runner's outbox](architecture/delivery.md#taking-entries-from-the-runners-outbox)); and in a fourth, `exchange/locks/`, it takes `backup.lock` and reads `run.lock` ([The locks](architecture/exchange.md#the-locks)). Each such user could put a link where the folder was, or in a file's place. So, in every one, the bridge keeps the rules below, and each of those documents gives only what is its own: the names, the sizes, the owners, the waits and the log events.

- **It uses the folder only while it is that user's folder and not a link** (`checkOwnFolder`). Otherwise it takes and removes nothing there.
- **It reads and copies a file there only with the functions of [Files another program controls](architecture/shared-code.md#files-another-program-controls).** Each document says the size it allows, and whether what it takes must also be that user's. *Why:* a link, or a hard link, in a file's place would have root read a file that user can't, such as a key, and pass it on: from `wacli/staging/`, into the datastore, where the runner and pi read it.
- **It removes only the names it gives or expects there**, each unlinked, and a folder only once that empties it. It leaves the rest, and logs it: what it doesn't know, what isn't a folder, and a folder holding anything else. It never removes what that user couldn't remove itself. *Why:* the review of the email channel made `mail/spool` a link to the data folder, and the bridge, removing everything under it as root, deleted `agents`, `bridge` and `datastore` within three looks.
- **What it leaves there stays** until that user removes it; a well-behaved email reader, wacli or runner leaves nothing of the kind.
- **It writes nothing in them**, but `backup.lock` in `exchange/locks/`, which the runner must see where it looks ([The locks](architecture/exchange.md#the-locks)). Its sending files, and its own entries, are in `bridge/` ([Sending an entry](architecture/delivery.md#sending-an-entry)).
- **Where root makes a folder in a folder another user owns**, as `setup` and the bridge make wacli's, it sets the folder's owner and mode through what it opened, which follows no link (`settleFolder`). *Why:* the folder's owner could rename what root made and put a link in its place between the making and the `chmod` and `chown`, and be given whatever the link led to, `/etc/shadow` among them.

*Cost, accepted:* Node has no calls relative to a folder it has open (`openat`, `unlinkat`), so a user who controls one of these folders can swap a link in between the bridge's check of it and its use. Such a swap reaches only files with the names the bridge removes there, which nothing else of Scooter's or the system's has, and empty folders, which are all a folder's removal takes; and where the bridge makes `backup.lock`, under that name. Only the runner's user controls `exchange/`, and an escape from pi's VM is needed to reach it.

`scooter status`, as root on a native install, also reads in folders the runner's user controls: `runner/status.json`, an agent's `state.json` and the jobs' files of `scooter backfill`, and the network log's days, in `agents/`, `agents/<name>/`, `agents/<name>/jobs/` and `runner/log/`. It keeps the first two rules. The first without the check of the owner: it uses each of those folders only while it is a folder and not a link. The second but for a day of the log, which it reads as a stream, opened without following a link and only if it is a regular file. It writes and removes nothing there. A link swapped in between its check and its read reaches only a file named `state.json`, `<ID>.json` or a day of the log, and shows only what passes the check of an agent's state, of a job's file or of the log's lines ([scooter status](architecture/bridge.md#scooter-status), [The job's file](architecture/backfill.md#the-jobs-file)).

`build-image`, as root on a native install, also works beside a folder another user controls, the runner's: [build-image](architecture/sandbox.md#build-image).

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

- The bridge reads `bridge.env` and the runner `runner.env`, each with only what its service needs, and neither reads the other's.
- Within the bridge, each program gets only its own settings: [wacli](architecture/whatsapp.md#running-wacli), [the email reader](architecture/email.md#the-email-reader) and [restic](architecture/backups.md#running-restic).
- pi sees a placeholder where the key would be, which is worthless outside the runner.
- No secret goes on a command line, where every user of the machine can read it, except the webhook secret ([Running wacli](architecture/whatsapp.md#running-wacli)).

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
| The services' sockets | runner, `build-image` ↔ bridge, `restore` | `src/common/instance.mjs` | [One service per data folder](architecture/shared-code.md#one-service-per-data-folder) |
| A job's file | `scooter backfill` → runner, `scooter status` | `src/common/jobfile.mjs` | [The job's file](architecture/backfill.md#the-jobs-file) |
| `state.json` of an agent | runner → `scooter status` | `src/common/agentstate.mjs` | [State](architecture/runner.md#state) |
| `status.json` | runner → `scooter status` | `src/common/runnerstatus.mjs` | [status.json](architecture/runner.md#statusjson) |
| The bridge's `status.json` | bridge → `scooter status` | `src/bridge/status.mjs` | [The bridge's status.json](architecture/bridge.md#the-bridges-statusjson) |
| The network log line | runner → `scooter status`, owner | `src/common/netlog.mjs` | [The log](architecture/network-policy.md#the-log) |
| The sandbox interface | runner ↔ sandbox | `src/runner/sandbox/index.mjs` | [The sandbox interface](architecture/sandbox.md#the-sandbox-interface) |
| The prompt | runner → pi: a trigger's `prompt`, its variables filled in | `src/runner/prompt.mjs` | [The prompt](architecture/runner.md#the-prompt) |
| The index file | runner → `show`, pi | `src/runner/agentdir.mjs` | [The index file](architecture/run.md#the-index-file) |
| The zone rules' `release.txt` | the repository → runner, `show` | `src/runner/vm/icu-tz/release.txt` | [The zone rules](architecture/agent.md#the-zone-rules) |
| What `send` and `mark` leave | `send`, `mark` → runner | `src/runner/report.mjs` | [What send and mark leave](architecture/run.md#what-send-and-mark-leave) |
| `agents.yaml` | owner → runner | `src/runner/config.mjs` | [agents.yaml](architecture/configuration.md#agentsyaml) |
| The env files | owner → both services | `src/common/settings.mjs` | [The env files](architecture/configuration.md#the-env-files) |

## The code's layers

```
src/cli.mjs ──▶ one side per CLI command

src/bridge  ──▶ src/common          no third-party libraries
src/runner  ──▶ src/common          yaml (config only), @earendil-works/gondolin (sandbox only)
src/mail    ──▶ src/common (part)   imapflow, postal-mime
src/ops     ──▶ src/common          setup and doctor
```

The rules, which `test/imports.test.mjs` checks by reading every file under `src/` (`test/support/imports.mjs`):

1. `src/common` imports nothing from the other folders.
2. `src/bridge` and `src/runner` never import each other. They share only what is in `src/common`. `src/ops` imports only `src/common`.
3. `src/mail` imports from `src/common` only `files`, `limits` and `log`, and doesn't reach `settings.mjs` through another module either.
4. Each of the four libraries is imported only where the diagram allows, `yaml` only by `src/runner/config.mjs` and Gondolin only in `src/runner/sandbox/`, and nothing else is imported that isn't a `node:` module. `src/cli.mjs` imports a CLI command's code only with `import()`, so a CLI command loads only its side.
5. One place for each outside contact, as the test sees it:
   - only `src/bridge/store.mjs` appends to the datastore: only it imports `encodeLine`, and nothing in `src/common/datastore/` calls a function that changes a file;
   - only `src/common/proc.mjs` imports `node:child_process`, and in the bridge only the two channel modules, `backup.mjs` and `main.mjs`, which makes the one `proc` the bridge shares and looks up its users, import `proc.mjs`;
   - the strings `'wacli'`, `'restic'` and the email reader's path appear only in the module that runs that program: `whatsapp.mjs`, `backup.mjs` and `email.mjs` (`paths.mjs` may name wacli's folder).
6. Every tuning number is in `src/common/limits.mjs`. No scan can tell a tuning number from any other number, so no test checks this one.

## Why it is built this way

- **The datastore is the only source of truth.** Views, memory, sessions and state are derived, and a backfill from empty can file them again ([Backfill](architecture/backfill.md)). So a bug in the runner or a bad run can cost a backfill, never data.
- **Two services that share folders, not sockets.** The bridge and the runner never call each other: the datastore carries work one way and the outbox carries replies back. *Why:* each holds different secrets; either can be down or restart without losing anything, and neither needs the other to be up: without the runner, messages are stored and handled once it is back, and without the bridge, replies wait in the outbox; nothing listens for connections; and the queue is plain files the owner can read. Every hand-off between them is atomic ([Atomic files and hand-offs](architecture/shared-code.md#atomic-files-and-hand-offs)).
- **Polling, every `POLL_INTERVAL`.** No file watchers and no signals between the services. *Why:* the volume is a handful of messages a day, and a poll behaves the same on every system.
- **`seq` is the only name a message has outside the bridge.** The agent, the outbox, the runner's state and the views' `source` column all use it; channel IDs stay in the datastore and the bridge. So the agent can't name a channel or a recipient, and adding a channel changes nothing past the bridge.
- **Secrets are split by process.** Settled with the owner. The bridge has the WhatsApp session, the mailbox password and the backup credentials; the runner has the OpenRouter key; pi gets a placeholder ([Secrets](#secrets)). So no single compromise yields everything.
- **The bridge runs as root,** because it starts wacli and the email reader as other users, and reads every folder for backups. What that costs is among the README's [Known limits](../README.md#known-limits).
- **Programs that face the outside get their own user.** wacli and the email reader run third-party code that parses whatever the internet sends. Each can read and write only its own folder and sees only its own settings, and the bridge validates what they hand over.
- **The runner is its own unprivileged user.** A flaw in QEMU or the guest kernel could let pi out of its VM and into the runner; there it would reach the OpenRouter key and the agents' folders, but not the bridge's secrets.
- **One module per outside contact** ([The code's layers](#the-codes-layers)), and one module per channel, so another channel, such as Telegram, is one more module ([Channels](architecture/bridge.md#channels)).
- **Everything third-party is pinned** to an exact version, and downloads are checked against published checksums.
- **The bridge uses no third-party library.** It reads no YAML: `config/` is the runner's ([Folders and their owners](#folders-and-their-owners)).

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
| Time | Every time Scooter stores or compares is in UTC: the datastore's times and day folders, the times in `state.json`, outbox IDs and logs. The owner's time zone (`SCOOTER_TZ`) is used only for what the owner sees or sets: replies, `scooter status`, views, the times in the agent's prompt, and the schedule settings (scheduled tasks, `BACKUP_TIME`, `SESSION_ROLLOVER_HOUR`), which code turns into UTC instants. |
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
| core | The bridge apart from its channels: the store, intake, delivery and the backups |
| record | A message as a channel hands it to the core, the same for every channel |
| line | One JSON object in the datastore, for one message, edit, deletion or reaction, in or out |
| `data` | The object on a line that holds what its channel keeps and Scooter's code doesn't act on, such as an email's subject |
| known line | A line of a kind and a channel this version has, with the fields its kind needs; any other is kept, and passed over |
| `seq` | A line's permanent number, and the only name a message has outside the bridge |
| datastore | The append-only log of lines, a `log.jsonl` per day folder with the attachments beside it |
| day folder | `datastore/YYYY/MM/DD`, the UTC date a line was written |
| intake | The core's half of receiving: records to lines |
| store | The datastore's one writer, `src/bridge/store.mjs`. wacli's own is its message store |
| index | What the bridge and the runner each keep in memory of the datastore: lines by `seq` and by channel ID, and what each message says now |
| index file | `run/index.txt`: the runner's index as a file, written for each run, one line for each `seq` with where the line is, its kind and the line it points at |
| `show` | The program that ships with the runner, which pi runs in its VM to print lines of the datastore by their `seq`, through the index file |
| `send`, `mark` | The programs that ship with the runner, which pi runs in its VM to queue a message to the owner, in `run/send/`, and to mark a line it was given done or failed, in `run/marks.txt`. The runner acts on what they leave once the run has passed |
| zone rules | ICU's time zone rules for one release of the tz database, which ship with the runner in `src/runner/vm/icu-tz/`, and which every Node in pi's VM converts times with, through each run's copy, `run/icu-tz/` |
| webhook | wacli's post to the bridge, on loopback, for each message it receives |
| catch-up | The bridge listing wacli's message store for what the webhook missed |
| pairing | Linking wacli to the bot's number; wacli is linked when paired |
| email reader | The program, run as `scooter-mail`, that reads the mailbox |
| spool | `mail/spool/`, where the email reader hands each email over as a folder |
| sender check | The bridge's test that an email is the owner's |
| CLI command | A command of `src/cli.mjs`, such as `scooter status` or `scooter restore`. Scooter takes no command by message: whatever the owner sends is a message |
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
| work item | An `in` line from a channel the agent's triggers for new messages name, of kind `message`, `edit` or `delete`, that this version knows. A message already deleted is one the runner settles itself, and never gives |
| batch | The work items one run is given |
| run | One run of pi, in one VM, on one batch or scheduled task |
| trigger | An entry of an agent's `run` in `agents.yaml`, which says when it runs: on new messages of its `channels`, or at a time ([agents.yaml](architecture/configuration.md#agentsyaml)) |
| prompt | The message pi is given for a run: the `prompt` of the trigger that starts it, with its variables, such as `$now$` and `$seq.unread$`, filled in. The agent's prompt is another: the file of the config folder, such as `prompts/lifelog.md`, that pi appends to its system prompt |
| scheduled task | The run of a trigger `at` a time, such as the evening check-in, which is given no lines, and named by its trigger's `tag`, such as `check-in`, in the log and the notices |
| view | A file lifelog keeps in its `views/`, such as `expenses.csv`, which its `writes` names. The runner doesn't know views: they are the agent's prompt's and skills' |
| memory | Lifelog's `memory/`: the owner's standing instructions and the open questions, which lifelog's prompt tells the agent to read first. The runner doesn't read it |
| `reads`, `writes` | What `agents.yaml` lets an agent's VM see, and change: files and folders of the data folder ([agents.yaml](architecture/configuration.md#agentsyaml)) |
| repository | The agent's folder as git keeps it: what its `writes` names there ([The agent's folder](architecture/run.md#the-agents-folder)) |
| `sends` | The channels an agent's messages may go out on |
| session | pi's conversation, kept by the runner for each of the owner's days |
| network policy | The runner's rules for what pi's VM may send |
| network log | The runner's log of every request pi's VM made |
| placeholder | What pi's VM holds where the OpenRouter key would be |
| backfill, job | History given to an agent again, from the first line or a chosen point, without sending anything: a job, which `scooter backfill` writes as a file in the agent's folder, `jobs/<ID>.json`, and the running runner takes ([Backfill](architecture/backfill.md)) |
| agent given in a file | An agent of a job of its own, `scooter backfill --agent-file`, in the format of `agents.yaml`, which writes only in its own folder and sends nothing: the way to try a prompt or a skill against history |

## To change X, look here

| To change | Modules | Tests | Documents |
|---|---|---|---|
| The line format | `src/common/datastore/line.mjs`, `src/bridge/store.mjs`, `src/common/datastore/index.mjs`, every reader of a line, the runner's skill (`src/runner/vm/skills/scooter/SKILL.md`) | `test/datastore.test.mjs`, `test/intake.test.mjs`, `test/batch.test.mjs`, `test/instructions.test.mjs` | [datastore](architecture/datastore.md), [show, and the runner's skill](architecture/agent.md#show-and-the-runners-skill) |
| What becomes a line, attachments | `src/bridge/intake.mjs`, `src/bridge/channels/index.mjs` | `test/intake.test.mjs`, `test/bridge.test.mjs` | [bridge](architecture/bridge.md), [datastore](architecture/datastore.md) |
| WhatsApp: webhook, filters, owner matching, catch-up, downloads, `pair` | `src/bridge/channels/whatsapp.mjs` | `test/whatsapp.test.mjs`, `test/support/wacli-stub.mjs`, `test/tools/wacli.test.mjs` | [whatsapp](architecture/whatsapp.md) |
| Email: the reader, parsing, the spool, the sender check, `email-check` | `src/mail/`, `src/bridge/channels/email.mjs` | `test/email.test.mjs`, `test/mail-reader.test.mjs`, `test/mail-imap.test.mjs`, `test/mail-parse.test.mjs` | [email](architecture/email.md) |
| The bridge's start, stop and state | `src/bridge/main.mjs`, `src/bridge/state.mjs` | `test/bridge.test.mjs` | [Starting up](architecture/bridge.md#starting-up), [The bridge's state](architecture/bridge.md#the-bridges-state) |
| Another channel | a module in `src/bridge/channels/`, `src/bridge/main.mjs`, `SOURCES` in `src/common/datastore/line.mjs` | `test/support/fake-channel.mjs`, `test/routing.test.mjs` | [bridge](architecture/bridge.md), [delivery](architecture/delivery.md) |
| Routing, chunks, pacing, failed sends | `src/bridge/outbox.mjs` | `test/delivery.test.mjs`, `test/routing.test.mjs` | [delivery](architecture/delivery.md) |
| The outbox entry, or the locks | `src/common/outbox.mjs`, `src/common/locks.mjs`, and both services' users of them | `test/outbox.test.mjs`, `test/locks.test.mjs`, `test/delivery.test.mjs`, `test/backup.test.mjs`, `test/runner.test.mjs` | [exchange](architecture/exchange.md) |
| `scooter status`, or the bridge's `status.json` | `src/bridge/status.mjs`, `src/bridge/main.mjs` | `test/status.test.mjs`, `test/bridge.test.mjs` | [scooter status](architecture/bridge.md#scooter-status) |
| Backups and restore | `src/bridge/backup.mjs` | `test/backup.test.mjs`, `test/support/restic-stub.mjs` | [backups](architecture/backups.md) |
| Files, programs, logs, time, sockets | `src/common/files.mjs`, `src/common/proc.mjs`, `src/common/log.mjs`, `src/common/time.mjs`, `src/common/instance.mjs` | `test/files.test.mjs`, `test/proc.test.mjs`, `test/log.test.mjs`, `test/time.test.mjs` | [shared code](architecture/shared-code.md) |
| A path in the data folder or the config folder | `src/common/paths.mjs` | `test/paths.test.mjs` | [shared code](architecture/shared-code.md), [Folders and their owners](#folders-and-their-owners) |
| The runner's files that `scooter status` reads | `src/common/agentstate.mjs`, `src/common/runnerstatus.mjs`, `src/common/jobfile.mjs`, `src/bridge/status.mjs` | `test/agentstate.test.mjs`, `test/runnerfiles.test.mjs`, `test/jobfile.test.mjs`, `test/status.test.mjs`, `test/backfill.test.mjs` | [State](architecture/runner.md#state), [status.json](architecture/runner.md#statusjson), [The job's file](architecture/backfill.md#the-jobs-file), [scooter status](architecture/bridge.md#scooter-status) |
| A constant | `src/common/limits.mjs` | `test/limits.test.mjs` | the document of the component that uses it; [Constants](architecture/configuration.md#constants) |
| A setting | `src/common/settings.mjs`, the example env file | `test/settings.test.mjs`, `test/cli.test.mjs` | the document of the component that reads it; [The env files](architecture/configuration.md#the-env-files) |
| A CLI command | `src/cli.mjs` | `test/cli.test.mjs` | [The CLI](architecture/configuration.md#the-cli), and the document of the component it belongs to |
| `agents.yaml` | `src/runner/config.mjs`, `config/agents.yaml` | `test/config.test.mjs`, `test/instructions.test.mjs` | [agents.yaml](architecture/configuration.md#agentsyaml) |
| The runner's start, loop and restarts | `src/runner/main.mjs`, `src/runner/restarts.mjs`, `src/runner/status.mjs` | `test/runner.test.mjs`, `test/restarts.test.mjs`, `test/runnerfiles.test.mjs` | [the runner](architecture/runner.md) |
| When the agent runs, the batch, the prompt and its variables | `src/runner/triggers.mjs`, `src/runner/batch.mjs`, `src/runner/prompt.mjs`, `src/runner/config.mjs` | `test/triggers.test.mjs`, `test/batch.test.mjs`, `test/planning.test.mjs`, `test/config.test.mjs` | [the runner](architecture/runner.md) |
| What `send` and `mark` leave, after a run, failures | `src/runner/report.mjs`, `src/runner/run.mjs`, `src/runner/failures.mjs`, `src/runner/git.mjs`, `src/runner/agentdir.mjs` | `test/report.test.mjs`, `test/run.test.mjs`, `test/failures.test.mjs`, `test/runner.test.mjs`, `test/agentdir.test.mjs`, `test/tools/git.test.mjs` | [A run, and the agent's folder](architecture/run.md) |
| `scooter backfill`, or how the runner runs a job | `src/runner/enqueue.mjs`, `src/runner/backfill.mjs`, `src/runner/replay.mjs`, `src/common/jobfile.mjs`, `src/runner/triggers.mjs` | `test/enqueue.test.mjs`, `test/backfill.test.mjs`, `test/jobfile.test.mjs`, `test/replay.test.mjs`, `test/triggers.test.mjs` | [backfill](architecture/backfill.md) |
| The sandbox or the VM image | `src/runner/sandbox/`, `config/image/build.json` | `test/sandbox.test.mjs`, `test/view.test.mjs`, `test/image.test.mjs`, `test/accel.test.mjs`, `test/tools/vm.test.mjs` | [the sandbox](architecture/sandbox.md) |
| The network policy or its log | `src/runner/sandbox/policy.mjs`, `src/runner/sandbox/netlog.mjs`, `src/common/netlog.mjs` | `test/policy.test.mjs`, `test/fixtures/pi-requests/` | [the network policy](architecture/network-policy.md) |
| The agent's instructions | `src/runner/vm/skills/`, `config/prompts/`, `config/skills/` | `test/instructions.test.mjs` | [the agent](architecture/agent.md) |
| `show` or the index file | `src/runner/vm/bin/show.mjs`, `src/runner/agentdir.mjs`, `src/runner/vm/skills/scooter/SKILL.md` | `test/show.test.mjs`, `test/instructions.test.mjs`, `test/agentdir.test.mjs`, `test/tools/vm.test.mjs` | [show, and the runner's skill](architecture/agent.md#show-and-the-runners-skill), [The index file](architecture/run.md#the-index-file) |
| `send` or `mark`, or what the runner makes of what they leave | `src/runner/vm/bin/send.mjs`, `src/runner/vm/bin/mark.mjs`, `src/runner/report.mjs`, `src/runner/run.mjs`, `src/runner/vm/skills/scooter/SKILL.md` | `test/report.test.mjs`, `test/run.test.mjs`, `test/instructions.test.mjs`, `test/tools/vm.test.mjs` | [send and mark](architecture/agent.md#send-and-mark), [What send and mark leave](architecture/run.md#what-send-and-mark-leave) |
| The zone rules, or updating them | `src/runner/vm/icu-tz/`, `src/runner/vm/bin/show.mjs`, `src/runner/agentdir.mjs`, `src/runner/run.mjs` (`piEnv`), `src/runner/main.mjs` | `test/tools/icu-tz.test.mjs`, `test/show.test.mjs`, `test/agentdir.test.mjs`, `test/runner.test.mjs`, `test/tools/vm.test.mjs`, `test/sandbox.test.mjs` | [The zone rules](architecture/agent.md#the-zone-rules), [Environment](architecture/sandbox.md#environment) |
| pi's version | `config/image/build.json`, `src/runner/sandbox/policy.mjs`, `test/fixtures/pi-requests/` (`test/tools/capture-pi-requests.mjs`) | `test/tools/pi.test.mjs`, `test/tools/fixtures.test.mjs`, `test/policy.test.mjs`, `test/image.test.mjs` | [Facts about pi 1.5.2](architecture/agent.md#facts-about-pi-152), [What pi sends](architecture/network-policy.md#what-pi-sends), [The VM image](architecture/sandbox.md#the-vm-image) |
| Gondolin's version | `package.json`, `src/runner/sandbox/` | `test/tools/vm.test.mjs`, `test/sandbox.test.mjs`, `test/policy.test.mjs` | [Facts about Gondolin 0.14.0](architecture/sandbox.md#facts-about-gondolin-0140), [Facts about Gondolin's network](architecture/network-policy.md#facts-about-gondolins-network) |
| The native install or Docker | `src/ops/`, `deploy/systemd/`, `Dockerfile`, `.dockerignore`, `compose.yaml`, `compose.kvm.yaml`, `compose.kvm-rootless.yaml` | `test/setup.test.mjs`, `test/doctor.test.mjs`, `test/units.test.mjs`, `test/docker.test.mjs` | [install](architecture/install.md), the [README](../README.md) |

## Deferred and out of scope

**Deferred with macOS:** launchd daemons for the two services; Apple's hypervisor for pi's VMs (`AGENT_ACCEL=hvf`, which stays a known value and fails on Linux, as any accelerator that can't be used does); building the VM image on a Mac; a data folder such as `/usr/local/var/scooter` in `setup`; running under Docker Desktop, OrbStack or Colima, the `./config` bind mount included; and the test suite passing on a Mac. Notes for then:
- Scooter works only while the Mac is awake, so stop it from sleeping (System Settings › Energy, or `caffeinate -s`). Catch-up collects what arrived while it slept.
- Docker Desktop gives containers no hypervisor, so on a Mac the native install is the fast one.
- With Docker Desktop, OrbStack or Colima, keep the project folder in the home folder (Colima shares only that), and set Docker to start at login so `restart: unless-stopped` brings Scooter back.

**Not run:** arm64, which the machine Scooter was built on can't run ([Known limits](../README.md#known-limits)). The code stays architecture-neutral.

**Out of scope for v2:**
- More than one agent, and channels other than WhatsApp and the owner's email, such as Telegram or bank alerts.
- Sending email, and keeping email from anyone but the owner.
- Approvals for preference changes, notices about them, and a way to undo one.
- A way to put messages in `failed` back in the queue. Until then, editing or resending a message brings it back.
- Group chats, and messages typed directly on the bot's phone.
- Voice transcription, reminders, and a web interface.
- Answering questions about the data, sending views as files, and acting for the owner, such as creating calendar events. These belong to a separate assistant agent, later.

**Where later work plugs in:**

| Later | Plugs in at | Already there |
|---|---|---|
| Telegram, or another channel | A module in `src/bridge/channels/` | The channel's members; `source` on every line; routing by the line an entry points at |
| Bank feeds and other data that isn't the owner's words | A channel that writes lines with `trust: "external"` | The `trust` field; `channels` per trigger |
| More agents | `agents.yaml` | The map of agents; `reads`, `writes` and `sends`; `by` on `out` lines and entries; one folder per agent |
| The assistant | A reader of the views | Views in git, written only by Scooter |
