# Scooter v2 on Linux: implementation plan

Status: active. Written 2026-11-15.

This plan turns `docs/DESIGN.md` into an ordered list of milestones for the agent, or agents, that build Scooter v2. Read these first:

- **`docs/DESIGN.md`** is the specification. Numbers in parentheses, such as (5.3), are its sections.
- **`docs/ARCHITECTURE.md`** describes the components, their boundaries and the decisions. Its section 8 lists the changes made to DESIGN.md while planning, numbered by row, with the reason for each. "Row 8" in this plan means row 8 of that table. DESIGN.md includes every one of them, so the two documents agree.

This plan adds what those two leave out: the order of work, the files, the smaller rules DESIGN.md leaves open, and how each milestone is proved done. Under each milestone, **Rules** lists those smaller rules, and the rows that milestone touches.

## 1. Scope

**In:** everything in DESIGN.md, which covers Linux only (row 1).
- Both ways to deploy: native systemd services, and Docker Compose.
- amd64, verified on the machine in section 3. Keep the code architecture-neutral (QEMU's binary name, the image's architecture, download names). arm64 can't be verified on that machine.

**Deferred with macOS.** Don't build these:
- launchd services, the macOS data paths in `setup`, and Apple's hypervisor;
- notes for Docker Desktop, OrbStack and Colima;
- passing the test suite on a Mac, as a requirement.

Keep the portability rules in section 10 of DESIGN.md where they cost nothing: poll instead of `fs.watch`, no `/proc`, no GNU-only command flags. They keep macOS cheap to add later.

## 2. Rules for the work

1. **Branch.** The work lands on `main`. The earlier prototype is no longer in the repository (the top of DESIGN.md).
2. **One milestone, one pull request** or one series of commits. It ends with `npm test` passing on Linux and a commit that describes it. Commits and pull requests follow `AGENTS.md`.
3. **Open questions.** When DESIGN.md and ARCHITECTURE.md don't settle something, pick the simplest option that keeps the principles, and record it in `docs/DECISIONS.md`: the question, the choice and the reason. Don't change anything in section 2 of DESIGN.md without asking the owner.
4. **Tests** use `node:test`, no real credentials and no network. Each test works in its own temporary folder, with `TMPDIR` inside it. Time comes from an injectable clock, and constants are overridden through `src/common/limits.mjs`.
5. **Code.**
   - ES modules, in `.mjs` files.
   - No third-party library beyond the four in ARCHITECTURE.md 4.3.
   - Programs are started with an argument list, never through a shell.
   - Every tuning number is in `src/common/limits.mjs`.
   - Logs carry no message text or file contents.
   - The import rules of ARCHITECTURE.md 4.2 hold, and a test checks them.
6. **Gates.** Some checks need root, the owner's phone or real keys. Section 6 says how each is met: root comes from a throwaway VM, and the rest wait for the owner. Don't work around them.

**Every milestone is done when:**
- `npm test` passes on the Linux machine from a clean checkout (`npm ci`);
- the tests it names exist and cover the cases listed in section 10 of DESIGN.md;
- new choices are in `docs/DECISIONS.md`;
- its description says what was run to verify it, with the results, and what wasn't verified.

## 3. The Linux machine

The owner's Linux machine, reached over SSH as the user `agentw`. The owner has the address; it isn't written here on purpose. Inspected on 2026-11-15.

| | |
|---|---|
| System | Ubuntu 24.04.4, kernel 7.0, x86_64, 22 threads, 62 GB of memory, systemd 255 |
| There | Node 22.23.2 and npm 10.9.8 (under `~/.local/opt`, on `PATH`), git 2.43, QEMU 8.2.2, `cpio`, `e2fsprogs`, Docker 29.7.1 with Compose and buildx, `gh`, `jq`, `gcc` |
| KVM | Usable: `agentw` is in the `kvm` group |
| Docker | Rootless. Its containers can't open `/dev/kvm` (13.4), so VMs inside them run under emulation |
| Missing | Go, restic, wacli, `lz4`, `tini`. pi is only needed inside the VM image |
| Root | None on the machine itself: `sudo` asks for a password. A VM started there with QEMU gives root inside it, and KVM works in that VM too (section 6) |
| Cross-building | No arm64 emulation, for Docker or for QEMU |

**What follows:**
- Everything runs there as `agentw` in development mode (8.5): no user switching, `DATA_DIR` and `CONFIG_DIR` pointing into a work folder. VMs run with KVM.
- restic and wacli come as release binaries, checked against their checksums, in `~/.local/bin` (milestone 0). Go isn't needed.
- The VM image is built with Gondolin's container build, which needs no root under rootless Docker.
- Anything that needs root happens in a throwaway VM (section 6), never on the machine itself: creating users, installing services, a system-wide Node, `lz4`.
- Node lives under `agentw`'s home, which other users can't enter. A native install needs a Node the service users can run (gate G1, in the VM).

**Facts found while planning.** Those that changed DESIGN.md are also in its section 13:

| Fact | Where it matters |
|---|---|
| Ubuntu and Debian have a `mail` user, uid 8 | Row 4; milestones 12 and 13 |
| Linux refuses a single command-line argument over 128 KB: 120,000 bytes worked, 140,000 failed | Row 12; milestone 3 |
| Gondolin 0.14.0 mounts its file system at `/data` in the guest by default, and shows each mount there too | Row 14; milestones 7 and 13 |
| Gondolin's image builder runs install commands in a chroot: root natively, or its container build. It unpacks Alpine's packages itself and runs none of their scripts | Row 8; milestones 0, 7 and 12 |
| pi 1.5.2 installs 123 packages. Two declare install scripts, and pi needs neither: `@google/genai` runs an `echo`, and `protobufjs` prints a warning about how it's depended on. pi pins its 22 direct dependencies exactly, its own sibling packages among them. Nothing pins the packages below those, so they may differ from one build to the next | Row 8; milestone 0 (pi 8) |
| Aborting a command in Gondolin 0.14.0 doesn't stop the guest process; only closing the VM does | Timeouts; milestone 7 |
| Gondolin keeps its certificate authority and session files in `~/.cache/gondolin`, and its disk overlays in the temporary folder | Row 16; milestone 7 |
| pi 1.5.2 has a `--no-mcp` flag. It also takes `@file` arguments as part of the message, which could carry a prompt too long for one argument, should the size limit ever need lifting | Rows 12 and 13; milestone 0 |
| Port 8787 is free on the machine | Milestone 2 |

**Kinds of check:**

| Kind | How | Needs |
|---|---|---|
| Hermetic tests | `npm test` | Nothing |
| Root tests | The same suite as root in a container: `docker run --rm -e SCOOTER_ROOT_TESTS=1 -v "$PWD":/src -w /src node:24-trixie sh -c 'npm ci && npm test'` | Docker. Tests that create users run only with `SCOOTER_ROOT_TESTS=1`, so nobody creates users on a real host by running the suite as root |
| Sandbox tests | Part of `npm test`; they skip themselves without QEMU or without `SCOOTER_TEST_IMAGE`, a folder holding a built image | QEMU, and KVM for speed |
| Live checks | Scripts in `test/live/`, run by hand | Network. They reach the real OpenRouter with a dummy key |
| Gates | Section 6 | A root VM for G1 to G3; the owner for G4 |

## 4. Milestones

| # | Milestone | DESIGN.md | After | The agent can verify it alone |
|---|---|---|---|---|
| 0 | Check the tools | 6.6, 13, 14 | | yes |
| 1 | Foundations and the datastore | 11.1 | | yes |
| 2 | Bridge intake: WhatsApp | 11.2 | 1 | yes, against a stub |
| 3 | Runner: planning | 11.3 | 1 | yes |
| 4 | Runner: running | 11.3 | 3, 0 | yes, against a fake sandbox |
| 5 | Delivery and commands | 11.4 | 2, 4 | yes |
| 6 | Email | 11.2 | 2; its end-to-end test needs 5 | yes, against a fake mailbox |
| 7 | Sandbox and VM image | 11.5 | 4, 0 | yes |
| 8 | Network policy and log | 11.5 | 7 | yes |
| 9 | Rebuild and backfill | 11.5 | 4, 5 | yes |
| 10 | Backups | 11.6 | 5 | yes |
| 11 | The agent's instructions | 11.7 | 4; its dry run needs 8 | yes |
| 12 | Native install | 11.5 | 5, 6, 8, 10 | yes, with gates G1 and G2 in a root VM |
| 13 | Docker | 11.5 | 12 | yes, with gate G3 in a root VM |
| 14 | Docs and final check | 11.7, 11.8 | all | partly: gate G4 |

Three tracks can run side by side once milestone 1 is in, as long as no two agents edit the same files: the bridge (2, 6, 10), the runner (3, 4, 9) and the sandbox (7, 8). They meet at 5 and 12.

### Milestone 0: check the tools

**Goal:** settle the tool behavior that later code depends on, before that code is written. No product code.

**Set up** on the Linux machine, without root:
- restic 0.19.1 and wacli 0.26.0 in `~/.local/bin`, each checked against its published checksum (13.1, 13.3);
- a scratch folder with Gondolin 0.14.0, and a first `config/image/build.json`: Alpine pinned, pi 1.5.2, the packages in 6.12. Build it with Gondolin's container build;
- a scripted fake model that answers from inside the request hook, so pi runs whole sessions without OpenRouter. Keep it under `test/support/`: milestones 7 and 8 use it again.

The prototype behind 13.4 is in `~/ww/gondolin-spike` on that machine, with its report in `REPORT.md`. Use it as a reference for how Gondolin's API was called and what was measured. Write Scooter's code fresh against DESIGN.md: the prototype predates several rules. For example, it has no ZDR, and it answers 403 where 6.13 says 400.

**Check,** and record each outcome in `docs/DECISIONS.md`:

| # | Check | Decides |
|---|---|---|
| pi 1 | Skills given with `--skill` load when `--no-skills` is set | Whether `--no-skills` stays (6.6) |
| pi 2 | Which file pi writes for a `--session-id` in a `--session-dir`, and that a second run with the same ID continues it | What the runner copies in and out (6.6) |
| pi 3 | Whether `edit` and `write` leave temporary files or dotfiles beside the file they change | Whether the file check in 6.8 would fail every run |
| pi 4 | `--no-mcp` works together with `-p` | Row 13 |
| pi 5 | With `-p`: what stdout holds, and the exit code after a normal run, after a 401 from the model, and when the VM is closed mid-run | Answer parsing and failure detection (6.7, 6.9) |
| pi 6 | Every request pi makes with `--offline` on both routes: paths, top-level fields and `anthropic-beta` values | The policy's allowlists (6.13, 14). Save them as fixtures for milestone 8 |
| pi 7 | A 100 KB prompt argument works, and one over 128 KB fails | Row 12 |
| pi 8 | pi runs, tools included, when it was installed with `npm install --ignore-scripts` | Row 8. If pi needs its install scripts, stop and ask the owner before milestone 7 |
| VM 1 | Mounts at the host's own absolute paths: a read-only folder with writable subfolders, one of them two levels down, with Gondolin's mount point moved off `/data` | 6.6; row 14 |
| VM 2 | How to run a command from an argument list in a given working folder, with no shell reading the prompt | 6.6 |
| VM 3 | Closing the VM while pi runs ends the run, and leaves no QEMU and no temporary files | Timeouts (6.6) |
| VM 4 | Killing the starting process's whole group leaves no QEMU; killing only the process leaves one | Supervision (6.6) |
| VM 5 | In the VM, `git log` works on the read-only agent folder | 6.2, 6.12 |
| wacli 1 | Whether `sync` can take the webhook secret from its environment | 5.1, 14 |
| wacli 2 | The output and exit code of `auth status` when not paired | 5.1 |
| wacli 3 | The commands and flags in 13.1 exist as written | 5.1 to 5.3 |

**Done when** every check has an entry saying what was run, what happened and what follows. If an outcome contradicts DESIGN.md or this plan, raise it with the owner before starting the milestone that depends on it.

### Milestone 1: foundations and the datastore

**Goal:** the shared base, and the datastore with its recovery. (11.1)

**Build:**
- `package.json`: private, `"type": "module"`, Node ≥ 22.19, `bin` pointing at `src/cli.mjs`, the four libraries pinned to exact versions (ARCHITECTURE.md 4.3), and `npm test` running `node --test`. Commit the lock file.
- `src/cli.mjs`: the command table of 8.4. Each command loads one side only.
- `src/common/limits.mjs`: every constant in 8.6, plus `WEBHOOK_PORT` (8787).
- `src/common/settings.mjs`: loads one side's env file and validates it. Errors name the variable.
- `src/common/paths.mjs`: every path under `DATA_DIR` and `CONFIG_DIR`, in one place.
- `src/common/time.mjs`: UTC helpers; conversion to and from `SCOOTER_TZ`; the next UTC instant of a local `HH:MM` or `Sun 18:00`, correct across daylight-saving changes; an injectable clock.
- `src/common/log.mjs`: one JSON line per event.
- `src/common/files.mjs`: atomic file writes; the folder hand-off (`.tmp-<id>`, then a rename) that the outbox and the mail spool share; sortable IDs.
- `src/common/proc.mjs`: runs a program with an explicit environment, a timeout, and a uid and gid; stops it with SIGTERM, then SIGKILL; supervises with `RESTART_BACKOFF`. When not root, it skips switching users and logs one warning (10).
- `src/common/locks.mjs`: lock files created exclusively, holding the pid, the start time and a deadline.
- `src/common/datastore/`: the line format (4.2), a reader, and the in-memory index: `seq` to line, `(source, sourceId)` to `seq`, and each message's current text and whether it's deleted.
- `src/bridge/store.mjs`: the single writer (4.3, 4.4).
- `bridge.env.example` and `runner.env.example`: started here, and kept current from now on.
- `test/support/`: temporary folders with `TMPDIR` inside, the fake clock, and the test that enforces the import rules.

**Rules:**
- **Env files.** One format that Scooter's loader, systemd's `EnvironmentFile` and Compose's `env_file` all read the same way: `KEY=value` lines, `#` comments, optional single quotes, no variable expansion. The loader reads `<side>.env` from `SCOOTER_ENV_DIR` (default `/etc/scooter`) when the file exists. Variables already in the environment win (8.2).
- **Reading.** A reader takes only complete lines, and leaves a partial last line for its next poll. Only the writer truncates, and only at startup.

**Tests** (10): Datastore; Time, for storage and conversion; settings; locks; the store's owner, group and modes, as a root test.

**Done when** the datastore tests pass, including recovery from an incomplete last line.

### Milestone 2: bridge intake, WhatsApp

**Goal:** WhatsApp messages from the owner become datastore lines. (11.2; 5, 5.1, 5.2)

**Build:**
- `src/bridge/channels/index.mjs`: the channel functions (ARCHITECTURE.md 2.1) and the shape of a record.
- `src/bridge/intake.mjs`: records to lines (5.2 step 6): messages, replies, reactions, edits, deletions and commands; attachments with their retries; the `media` object for what couldn't be stored.
- `src/bridge/channels/whatsapp.mjs`:
  - the wacli client and its environment (5.1);
  - the sync supervisor and the pairing check;
  - the webhook server (5.2 step 1);
  - normalization (13.1), the filters and owner matching (steps 2 to 5);
  - catch-up (step 7).
- `src/bridge/state.mjs`: `bridge/state.json`.
- `src/bridge/main.mjs`: starts the channels and connects them to intake and the store.
- `test/support/`: a fake channel; and a wacli stub, a Node script behind a wrapper placed first on `PATH`, that records its arguments and environment, answers from fixtures and can post signed webhooks.

**Rules:**
- **Duplicates** for edits, deletions and reactions: row 9.
- **Catch-up** starts from the newest incoming WhatsApp line (row 10). When a page of 500 comes back full, it continues from the last row's time.
- **Commands.** A WhatsApp text is a command when, after trimming, it equals one of the four exactly.
- **Keep wacli's formats in two functions,** one for webhook payloads and one for list rows. How wacli reports edits, deletions and `@lid` senders is only known for sure after pairing (gate G4), and a correction should touch nothing else.

**Tests** (10): Intake, all of it; Least privilege, for wacli's environment and command line.

**Done when** signed webhook posts end up as the right datastore lines and attachments, and unsigned ones don't.

### Milestone 3: runner, planning

**Goal:** from the datastore, the state and the clock, the runner works out what the agent should do next and what it should be told. Nothing runs yet. (11.3; 6.1 to 6.5)

**Build:**
- `src/runner/config.mjs`: `agents.yaml` and its validation (6.1). The only file that imports `yaml`.
- `src/runner/agentdir.mjs`: the agent's folder, `git init`, the `.gitignore` and the first commit (6.2); building `run/` before a run.
- `src/runner/state.mjs`: `state.json` (6.3); transitions as pure functions; atomic writes, mode 0600.
- `src/runner/triggers.mjs`: what's next (6.4): commands, new messages after the quiet period, `at` tasks, `once` tasks, a backfill batch when idle, and nothing while paused.
- `src/runner/batch.mjs`: the batch and its context (6.5).
- `src/runner/prompt.mjs`: the prompt and `run/system.md` (6.5).
- `src/runner/protocol.md`: the protocol (7.1).

**Rules:**
- **Prompt size** (row 12). The batch stops growing at `PROMPT_MAX_BYTES`, and always keeps at least one item. An item too long for the limit is shown cut, followed by where the rest is: its line in `log.jsonl`, or its `.eml` file.
- **Commands** (row 11). Before building a batch, the runner handles command lines newer than `commandSeq`, writes any reply to the outbox, and saves the state at once.
- **Schedule.** `at` values are unique within an agent, because they are the keys of `state.scheduled`. A task that comes due during a run or a pause waits, and runs afterwards.

**Tests** (10):
- Runner: batching after the quiet period, and the batch's two limits; context lines and reply labels; emails in the prompt; an edit or deletion bringing in its message from `retry` or `failed`.
- Time: scheduled tasks at the right local time across a daylight-saving change; a changed `SCOOTER_TZ` between restarts.
- Config: each validation error names the field.

Use the prompt shown in 6.5 as the first expected output.

**Done when** fixtures of datastore lines, a state and a clock produce the expected next action, batch and prompt.

### Milestone 4: runner, running

**Goal:** one run, from lock to state update, against a fake sandbox. (11.3; 6.6 to 6.9)

**Build:**
- `src/runner/sandbox/index.mjs`: the sandbox interface. Run this argument list, in this folder, with this environment, these mounts, this timeout and this policy; return the exit code, stdout, stderr and whether it timed out.
- `test/support/`: a fake sandbox that runs a pi stub as a local process, in a temporary folder laid out like the mounts. The stub reads the prompt and picks its behavior from keywords in the messages: `DONE`, `FAILED`, unreported items, questions, unexpected files, a crash, a hang, and a given OpenRouter status, which it writes to the network log in the real format.
- `src/runner/run.mjs`: takes `run.lock`, builds pi's command (6.6, with what milestone 0 found), runs it, then follows 6.8 after a success or 6.9 after a failure.
- `src/runner/answer.mjs`: parsing (6.7).
- `src/runner/git.mjs`: the unexpected-file check, the commit, and the clean-up limited to `views/` and `memory/` (6.8, 6.9).
- Sessions: the session ID, copying in and out, and `/new` (6.6, 5.4).
- `src/common/outbox.mjs`: writing an entry. The runner writes replies, ✅ reactions and notices (5.3, 6.8). Milestone 3 wrote it, for the reply to `/new`.
- `src/runner/failures.mjs`: the cause, read from the network log; pauses and their schedules; attempts; notices (6.9).
- `src/runner/status.mjs`: `runner/status.json` (row 6). The formats of `state.json` and `status.json`, and readers for them, go in `src/common/`, because the bridge reads both for `/status`. Milestone 3 put `state.json`'s there, in `src/common/agentstate.mjs`.
- `src/runner/main.mjs`: startup and the loop.

**Rules:**
- **Locks:** row 7.
- **Hidden paths.** The sandbox interface's list of mounts says what is hidden inside each mount: `sessions/` in the agent's folder (6.6; `docs/DECISIONS.md`, 0.8). A runner test checks that the sandbox is given it, and the fake sandbox leaves `sessions/` out of its folder, as the VM does.
- **The first-failure notice** is decided from `lastRun.ok`. Backfill batches don't change `lastRun`.
- **A failed task.** A scheduled or `once` task that fails on a setup error or an outage stays due, and is the next try. One that fails for another reason isn't retried: a scheduled task runs at its next time; a `once` task is recorded in `onceDone` only after it succeeds, so it runs again at the next startup.
- **The emulation notice:** row 15.

**Tests** (10): the rest of Runner, except rebuilds and backfills; Answer parsing.

**Done when** the pi stub can take a message from the datastore to a committed view and a correct `state.json`, including retries and failures.

### Milestone 5: delivery and commands

**Goal:** replies reach the owner, and the commands work. This completes the path from webhook to reply. (11.4; 5.3, 5.4)

**Build:**
- `src/bridge/outbox.mjs`: the processor (5.3): order, pacing, routing, chunking, quoting, reactions, `out` lines, and pausing for backups.
- Sending, in `whatsapp.mjs`: `sendText` and `react`.
- The startup check of `DEFAULT_CHANNEL`.
- `src/bridge/commands.mjs` and `src/bridge/status.mjs`: `/status`, `/help`, and `/backup` with a placeholder until milestone 10.

**Rules:**
- **Crash safety** (row 3). `sending.json` holds the entry and the number of chunks already sent, and is rewritten after each chunk. At startup, every `sending.json` is sent again from the next chunk, texts and reactions alike.
- **Entry IDs.** Two processes write entries. If a name is taken at the rename, take the next counter.
- **Link previews.** Every text is sent with `--no-preview` (5.3). The owner decided this after milestone 0 (`docs/DECISIONS.md`, 0.8).
- **`/status`** reports what it can read. Before the runner has ever started, it says so.

**Tests** (10): Delivery, where recovery is now a resend from the recorded chunk; Routing.

**Done when:**
- an end-to-end test goes from a signed webhook to a quoted reply sent through the wacli stub and logged as an `out` line;
- `/status` reports the runner's state.

### Milestone 6: email

**Goal:** the owner's emails become datastore lines. (11.2; 5.6)

**Build:**
- `src/mail/reader.mjs`, with `imap.mjs` (the mailbox adapter over `imapflow`), `parse.mjs` (`postal-mime`, and HTML to text), the spool writer and the position file.
- `src/bridge/channels/email.mjs`: the reader's supervisor and environment; the spool consumer and its checks; the sender check; the datastore line; the skip log and its counts; `status()`.
- `email-check` (8.4).
- `test/support/`: a fake mailbox behind the adapter; sample emails as Gmail, Apple Mail and Outlook send them, including HTML-only mail, a forwarded booking and an audio attachment.

**Rules:**
- **The sender check** reads the raw header block. Addresses are compared without regard to case. "Topmost" is the first `Authentication-Results` header after unfolding; its server name is its first token; and `dmarc=pass` must be a result, not text inside a comment.

**Tests** (10): Email, all of it; Least privilege, for the reader's environment.

**Done when:**
- sample emails from the fake mailbox end up as the right lines and attachments, and mail that fails the sender check isn't stored;
- an end-to-end test goes from an email to an unquoted reply on WhatsApp.

### Milestone 7: sandbox and VM image

**Goal:** pi runs in a real VM. (11.5; 6.6, 6.12)

**Build:**
- `src/runner/sandbox/gondolin.mjs`: one VM per run, booted from `runner/image/`; the mounts and the environment of 6.6; the timeout; closing the VM on every path; sweeping the temporary folder at startup.
- `src/runner/sandbox/accel.mjs`: `AGENT_ACCEL` (6.6).
- `src/runner/sandbox/image.mjs` and `build-image`: builds from `config/image/build.json`, writes `packages.txt`, records the pi version and the build time, and provides the startup check (6.12).
- `scooter runner` in `src/cli.mjs`: `runRunner` in `src/runner/main.mjs` with this sandbox as its `openSandbox`. Milestone 4 left the command unbuilt, since nothing could run pi yet (`docs/DECISIONS.md`, milestone 4).

**Rules:**
- **Building:** row 8. As root, build natively. Otherwise use Gondolin's container build when Docker or Podman is there. Otherwise stop, and say which of the two is needed. Install pi with `--ignore-scripts`. The build's commands never run pi or anything else npm installed, because a native build would run it as root on the host; read pi's installed version from its `package.json`.
- **The pi version** is pinned in `config/image/build.json`, in the install command. The runner reads it from there, strictly, to compare with the image.
- **Home and temporary folder:** `runner/home` and `runner/tmp` (row 16).
- **Timeouts** close the VM. Aborting the command isn't enough in Gondolin 0.14.0.
- **Mount point:** row 14.
- **`sessions/`** is hidden from the VM with Gondolin's `ShadowProvider` (6.6). The owner decided this after milestone 0 (`docs/DECISIONS.md`, 0.8), and `test/support/vm.mjs` has the call.

**Tests** (10): Sandbox, all of it.

**Done when,** on the Linux machine with KVM:
- the sandbox tests pass, and a VM boots in under 3 seconds;
- one batch runs end to end through the real sandbox with the scripted fake model: pi reads a message, writes a view, and the runner commits it.

### Milestone 8: network policy and log

**Goal:** everything pi sends is checked and logged. (11.5; 6.13)

**Build:**
- `src/runner/sandbox/policy.mjs`: the hosts; the key swap; the two routes and their checks; re-encoding; ZDR; the internet switch.
- `src/runner/sandbox/netlog.mjs`: writing the log. `src/common/netlog.mjs`: its format and a reader, shared by the runner's failure handling and the bridge's `/status`. Milestone 4 wrote the format and the reader, with an `error` line for a request that got no answer, because its failure handling reads the log (`docs/DECISIONS.md`, milestone 4).
- The fixtures from milestone 0: the pinned pi's requests on both routes.
- The real log connected to failure handling and to `/status`.
- `test/live/`: a script that runs pi in a VM against the real OpenRouter with a dummy key.

**Rules:**
- **ZDR is a switch per route** in the code. If the messages route turns out to refuse the `provider` fields (14), they're left out on that route, and the key's guardrail enforces ZDR alone.
- **What failure handling reads** (`docs/DECISIONS.md`, D82 and 4.6). A `response` line written only at the end of a stream makes a run that times out mid-stream an outage, tried every 30 minutes for good; writing it when the status arrives avoids that. And a request the policy refuses on `openrouter.ai` has a `refused` line and no `request` line, so a run that ends on one reads as pi's own failure, and uses the items' attempts. When the refused request is the pinned pi's own, no longer matching the allowlist, that is nearer a setup error: settle how the log tells the runner which it was.

**Tests** (10): Network policy, all of it, with a fake upstream.

**Done when** the policy tests pass and, on the Linux machine, pi in a VM reaches OpenRouter's chat endpoint with a dummy key while `https://example.com` is refused. OpenRouter answers 401, and the runner treats that as a setup error.

### Milestone 9: rebuild and backfill

**Goal:** history can be replayed. (11.5; 6.10, 6.11)

**Build:**
- Replayed batches, shared by both: one of the owner's days per batch, its own session, `Now:` taken from the batch, and the locks.
- `src/runner/rebuild.mjs` and the `rebuild` command (6.10).
- `src/runner/backfill.mjs` (6.11): its lane in the state, when it runs, what it may change, its commits and its summary.

**Rules:**
- `rebuild` refuses to start while `run.lock` exists. It can't tell whether an idle runner is up, so the README says to stop the runner first.
- A runner started during a rebuild removes the rebuild's `run.lock` and git's lock files, and throws away its uncommitted changes (`docs/DECISIONS.md`, D89 and 4.6). If `rebuild` holds `runner/runner.sock` (D90), a runner can't start during it, and `rebuild` can tell whether a runner is up.
- A rebuild sets `commandSeq` to the `seq` it stops at (6.10; row 11), so old commands aren't answered again.

**Tests** (10, under Runner): Rebuilds; Backfills.

**Done when** those tests pass with the fake sandbox.

### Milestone 10: backups

**Goal:** nightly encrypted backups, and restore. (11.6; 5.5)

**Build:**
- `src/bridge/backup.mjs` (row 2): `init`, `run`, `snapshots`, `check` and `restore`, with the arguments, retention, weekly check and exit codes that 5.5 gives; the schedule; the consistency steps; results and notices.
- The commands `backup-init`, `snapshots`, `check` and `restore`; `/backup`; `SIGUSR1`.
- `test/support/`: a restic stub, for the coordination tests.

**Rules:**
- **Locks and the wait:** rows 6 and 7.

**Tests** (10): Backups. The coordination, with the stub. With restic installed, the real round trip against a repository in a temporary folder.

**Done when** both pass on the Linux machine.

### Milestone 11: the agent's instructions

**Goal:** the agent knows its job. (11.7; section 7)

**Build:** `config/prompts/lifelog.md` (7.2); the six skills (7.3); the default `config/agents.yaml` (6.1); the final `config/image/build.json`; and a last pass over `protocol.md` against the parser.

**Tests:** every skill folder has a `SKILL.md` with `name` and `description`; the default config validates; each view in the prompt names a skill that exists; each CSV header matches 7.3.

**Done when** the files are complete, and the pinned pi runs one batch end to end in the sandbox with these files and a dummy key.

### Milestone 12: native install

**Goal:** Scooter installs and runs as two systemd services. (11.5; 8.4, 8.5)

**Build:**
- `src/ops/setup.mjs`. In order, each step safe to repeat:
  1. **Check:** root; systemd; a Node ≥ 22.19 that every service user can run; the code in a folder they can read (row 16).
  2. **Users:** `scooter-wacli`, `scooter-runner` and `scooter-mail` as system users without a login shell; `scooter-runner` added to `kvm` (row 4).
  3. **Folders:** the data folders with the owners and modes of ARCHITECTURE.md 3.3; `/etc/scooter/config` copied from the repository's `config/` if it isn't there.
  4. **Env files:** written from the examples if they don't exist, mode 0600, with `DATA_DIR` and `CONFIG_DIR` filled in. Never overwritten.
  5. **Command:** `/usr/local/bin/scooter`, a wrapper that runs `src/cli.mjs`.
  6. **Services:** the two units installed and enabled. `setup` prints what to do next and doesn't start them, since the env files may still be empty. `--no-services` skips this step, for containers and tests, where systemd isn't running.
- `deploy/systemd/scooter-bridge.service`: root. `scooter-runner.service`: `User=scooter-runner`, `SupplementaryGroups=kvm`, its home and temporary folder under `runner/`. Both: `KillMode=control-group`, restart on failure, `TZ=UTC`.
  - The runner stops on an error and leans on the service manager's backoff (`docs/DECISIONS.md`, D93). A fault that stays, such as a full disk at the commit, runs pi again at every start, and each start waits out the quiet period, so systemd's default start limit (5 starts in 10 seconds) never applies. Give `scooter-runner.service` a `RestartSec`, or steps that grow, chosen with that in mind (4.6).
- `src/ops/doctor.mjs` (8.4).
- `pair`, and anything in 8.4 not built yet.

**Tests:**
- Hermetic: the decisions `setup` and `doctor` make, such as which users, modes, mounts and settings; `doctor` reports each missing piece with its fix.
- Root tests, in a container: `setup` without services creates the users and folders; wacli and the email reader, run as their users, can't read `datastore`, `agents`, `exchange`, `runner` or `bridge`; each service reads only its own env file.
- `systemd-analyze verify` on both units.

**Done when** those pass, and gate G2 passes in the root VM (section 6).

### Milestone 13: Docker

**Goal:** the same system from one image and two Compose services. (11.5; 8.3)

**Build:**
- `Dockerfile` (8.3), with the users of row 4 at uids 10001 to 10003.
- `compose.yaml` (8.3), with the three KVM cases as documented variants: rootful Docker, rootless Docker with the udev rule, and none.
- `build-image` in Docker. Work out how it runs there (row 8) and record it: as root in the runner container if the builder's chroot works there, otherwise as a one-off with the privileges it needs.

**Check** on the Linux machine, which has rootless Docker:
- `docker compose build` succeeds;
- both services start; `doctor` in the runner container reports emulation, and why;
- wacli and the email reader run as their users in the bridge container and can't read the other folders;
- the runner container works with its read-only root file system (14);
- pi in a VM in the runner container reaches OpenRouter with a dummy key, and `https://example.com` is refused;
- the mounts work with the data under `/data` (row 14).

**Not verifiable there:** KVM inside a container, which gate G3 covers in the root VM; and the arm64 image, which nothing here can cover. Record the arm64 gap in `docs/DECISIONS.md`.

**Done when** the checks above pass, and gate G3 passes in the root VM (section 6).

### Milestone 14: docs and final check

**Goal:** someone else can install and run it, and nothing in DESIGN.md is silently missing. (11.7, 11.8)

**Build:**
- `README.md`, covering what 11.7 lists, for Linux: native setup and Docker, with KVM in each case and the udev rule for rootless Docker; the bot number, the mailbox, the OpenRouter key and its guardrail; the env files; daily use, commands, backups, restore, rebuilds and development; the security model and how to read the network log.
- The final `bridge.env.example` and `runner.env.example`.
- "Check on the first real run" in the README: the items of gate G4.

**Final check:**
1. Re-read DESIGN.md section by section and tick off every requirement. List anything not done in `docs/DECISIONS.md`.
2. Run `npm test` from a clean checkout on the Linux machine, then the root tests, the sandbox tests and the live check.
3. Move this plan to `docs/plans/completed/`.

## 5. Where each required test lands

| Section 10 of DESIGN.md | Milestone |
|---|---|
| Datastore | 1 |
| Time | 1 for storage and conversion; 3 for schedules and the prompt; 5 for `/status` |
| Intake | 2 |
| Email | 6 |
| Least privilege | 1 for folder modes; 2 for wacli; 6 for the reader; 12 for installed users and env files |
| Runner | 3 and 4; 9 for rebuilds and backfills |
| Answer parsing | 4 |
| Delivery, Routing | 5; 6 for the email end-to-end case |
| Network policy | 8 |
| Sandbox | 7 |
| Backups | 10 |
| Config | 3 for validation; 12 for `doctor` |

## 6. Gates: what needs root, and what needs the owner

G1 to G3 need root. G4 needs the owner: the agent stops there, says what it needs, and carries on with whatever doesn't depend on it.

**Root comes from a throwaway VM.** `agentw` has no root on the Linux machine and gets none (decided with the owner on 2026-11-16). For G1 to G3 the agent starts an Ubuntu VM on that machine with QEMU, as `agentw`, and is root inside it.

- Never use `sudo` on the Linux machine itself, and install nothing there outside `agentw`'s home.
- Use an official Ubuntu 24.04 cloud image, checked against its published `SHA256SUMS`. Keep the VM's files in a scratch folder outside the repository.
- Run it with KVM and the host's CPU (`-cpu host`), so KVM also works inside it. Start from 4 CPUs, 8 GB of memory and a 40 GB disk; the machine has room for more.
- Use user-mode networking, with the VM's SSH port forwarded to a port on `127.0.0.1` only.
- Where a gate says "the host", that is the VM. Get the code into it by cloning the pull request's branch from GitHub.
- Start each gate from a fresh disk. When the gate is done, shut the VM down, delete its disk, and check that no QEMU process of yours is left.
- Nothing in the VM is kept. Put what was run, and what happened, in the pull request and in `docs/DECISIONS.md`.

This was tried on 2026-11-16, with 4 CPUs and 4 GB:
- The image is about 600 MB. The VM booted in about 8 seconds.
- Its default user, `ubuntu`, has passwordless `sudo`, and systemd reported `running`.
- `/dev/kvm` worked inside the VM, so Scooter's own VMs can use KVM there. They will be slower than on the machine itself.
- The cloud-init seed was an ISO made with `xorriso`, labeled `CIDATA`, holding an SSH key for the default user.
- Ubuntu already has a group called `admin`, and cloud-init failed to create a user of that name.
- A fresh image has git, and no Node, Docker, QEMU or `lz4`.

The install on the machine Scooter will live on is not part of these gates. It stays with the owner, with G4.

**G1. Prerequisites for a native install** (in the root VM; before milestone 12's check there)
- A system-wide Node ≥ 22.19.
- `lz4`, QEMU, `cpio` and `e2fsprogs`, from `apt`.
- restic 0.19.1 and wacli 0.26.0 in `/usr/local/bin`, checked against their checksums.
- The code in a root-owned folder, such as `/opt/scooter`, with `npm ci --omit=dev --ignore-scripts`.

**G2. The native install** (in the root VM; ends milestone 12)
1. `sudo scooter setup`, then fill in the two env files. A dummy OpenRouter key is enough here.
2. `sudo scooter build-image`. This is the first native build as root (14).
3. Start both services. `sudo -u scooter-runner scooter doctor` passes.
4. As `scooter-wacli` and as `scooter-mail`, reading `datastore`, `agents`, `exchange`, `runner` and `bridge` fails.
5. Kill the runner during a run: no QEMU process is left.

**G3. KVM inside Docker** (in the root VM; ends milestone 13)
- Rootful Docker: `devices`, `user` and `group_add`, as in 8.3.
- Rootless Docker: install the udev rule from the README, then run the runner container with `AGENT_ACCEL=kvm`.
- In both cases `doctor` in the runner container reports KVM, and a VM boots there. Record how long it takes. The 3-second mark was measured on the machine itself, and a VM inside a VM is slower, so it isn't a pass mark here.

**G4. The first real run** (the owner's phone, accounts and keys; after milestone 14)

Set up:
- the bot number, paired with `scooter pair`;
- Scooter's own OpenRouter key, with the guardrail of 6.13;
- the mailbox and its app password, then `scooter email-check` to find `EMAIL_AUTHSERV_ID`;
- the backup bucket, then `scooter backup-init`.

Then check, and correct the code where reality differs:
- a receipt photo ends up in `expenses.csv`, read through pi's `read` tool;
- a real batch runs end to end in the sandbox;
- the messages route accepts the `provider` fields; ZDR-only routing works for the model, and how much latency it adds;
- wacli: how an edit and a deletion arrive, `FromMe` and `Chat` included, for the owner's own edit and deletion (`docs/DECISIONS.md`, D42 and 3.3); `send react --sender` in a one-to-one chat; owner matching when messages come from an `@lid` ID; a text with a link in it, sent with `--no-preview`, arrives without a preview, and wacli fetches nothing for it (`docs/DECISIONS.md`, 0.8, says how to tell);
- email: IDLE with the app password; the `Authentication-Results` header and its `dmarc=` result; the owner's own mail passes DMARC; `postal-mime` on a forwarded booking and on an audio attachment;
- a backup to the real bucket, and a restore into an empty folder.

## 7. Where each unverified item gets verified

The items of section 14 of DESIGN.md:

| Item | Where |
|---|---|
| The model reads photos through pi's `read` tool | G4 |
| The fields and `anthropic-beta` values pi sends; other OpenRouter paths | Milestone 0 (pi 6), used in 8 |
| `--skill` with `--no-skills` | Milestone 0 (pi 1) |
| `--no-mcp` with `-p`; pi installed with `--ignore-scripts` | Milestone 0 (pi 4 and pi 8) |
| A real batch with the owner's key | G4 |
| `provider.zdr` on the messages route; ZDR-only routing and its latency | G4 |
| KVM inside a container, rootful and rootless | G3, in the root VM |
| Gondolin on a Mac; launchd | Deferred with macOS |
| Building the VM image natively on Linux | G2, as root. Milestone 0 covers the container build |
| Building the VM image in the runner container | Milestone 13 |
| The runner container with a read-only root file system | Milestone 13 |
| `wacli send react --sender`; edits and deletions; `@lid` owners | G4 |
| A text with a link, sent with `--no-preview`: no preview, and nothing fetched | G4. Milestone 0 (wacli 3) covers wacli's documentation, its source and the flag |
| `imapflow` with an app password; the `Authentication-Results` header; DMARC on the owner's mail; `postal-mime` on real mail | G4. Milestone 6 covers samples |
| The webhook secret from wacli's environment | Milestone 0 (wacli 1) |
| `docker compose build` | Milestone 13, for amd64 |
| The image on arm64; Docker Desktop, OrbStack and Colima | Not verifiable on this machine; the macOS runtimes are deferred |

## 8. Risks

| Risk | What limits it |
|---|---|
| Gondolin is pre-1.0, and the code leans on 0.14.0's behavior: hooks in the runner's process, logging from the HTTP client's events | The exact pin. Milestone 0's checks and milestone 7's tests are the upgrade suite |
| pi's requests change with its version, and the policy fails closed | The pin in `build.json`; fixtures captured from the pinned pi; refusals log the field names |
| The VM image's build needs root or a container, and no root is at hand | Row 8. The container build is checked in milestone 0, the root build at G2 |
| A native image build runs as root on the host: Gondolin's builder, then Alpine's shell, npm and git in a chroot | `--ignore-scripts`, and build commands that never run pi, so no code from pi's packages runs as root (check pi 8). The build runs only when the owner starts it. If pi needs its install scripts, the owner decides again: a build in a rootless container avoids host root altogether |
| wacli's real behavior for edits, deletions and `@lid` is unknown until pairing | Its formats sit in two functions (milestone 2); G4 corrects them |
| The messages route may refuse the ZDR fields | The per-route switch (milestone 8); the key's guardrail still enforces ZDR |
| Emulation in a rootless container is slow: about 13 seconds before pi's first request (13.4) | Generous timeouts in milestone 13's checks; KVM at G3 |
| No root on the Linux machine | The root tests run in a container. G1 to G3 run in a throwaway VM, where the agent is root (section 6) |
| In the root VM, Scooter starts its own VMs inside a VM | Nested virtualization is on, and KVM answered inside a test VM. Timings there are slower, so time limits are checked on the machine itself |
| arm64 is never run | Architecture-neutral code; recorded as unverified |
