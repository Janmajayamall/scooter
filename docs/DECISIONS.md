# Decisions

This file records what was decided while building Scooter v2, where `docs/DESIGN.md` and `docs/ARCHITECTURE.md` left something open, and what each check of the tools found. It also records the changes made to DESIGN.md while building, each with the question put to the owner and the answer. Each entry gives the question, the choice and the reason. Numbers in parentheses, such as (8.4), are sections of DESIGN.md. "Row 16" is row 16 of the table in section 8 of the old ARCHITECTURE.md, now in its old text. "The plan" is `docs/plans/completed/v2-linux-implementation/v2-linux-implementation.md`.

## Milestone 0: check the tools

Done on 2026-11-16, on the Linux machine of section 3 of the plan. No product code was written. Two outcomes went to the owner as questions; each answer is beside the rule it settled, in [Sending](architecture/whatsapp.md#sending) and [Mounts](architecture/sandbox.md#mounts). What the milestone left in the repository:

| Path | What |
|---|---|
| `package.json`, `package-lock.json`, `.npmrc` | Gondolin 0.14.0, pinned, and `npm test` |

### 0.2 Setup

**restic and wacli** are in `~/.local/bin`, installed by hand with the commands below. Each archive was checked against the checksum file published with its release, and both checks said `OK`.

```
cd ~/ww/scooter-scratch/downloads

curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2
curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/SHA256SUMS
grep ' restic_0.19.1_linux_amd64.bz2$' SHA256SUMS | sha256sum -c -
bzip2 -dkc restic_0.19.1_linux_amd64.bz2 > restic.bin
install -m 0755 restic.bin ~/.local/bin/restic

curl -fsSLO https://github.com/openclaw/wacli/releases/download/v0.26.0/wacli_0.26.0_linux_amd64.tar.gz
curl -fsSL -o wacli-checksums.txt https://github.com/openclaw/wacli/releases/download/v0.26.0/checksums.txt
grep ' wacli_0.26.0_linux_amd64.tar.gz$' wacli-checksums.txt | sha256sum -c -
mkdir wacli-extract && tar -xzf wacli_0.26.0_linux_amd64.tar.gz -C wacli-extract ./wacli
install -m 0755 wacli-extract/wacli ~/.local/bin/wacli
```

| Archive | sha256 |
|---|---|
| `restic_0.19.1_linux_amd64.bz2` | `f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c` |
| `restic_0.19.1_linux_arm64.bz2` | `a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465` |
| `wacli_0.26.0_linux_amd64.tar.gz` | `2c28f65e2f9aaf32585288229db1f916c6c5fb5db9513715017d528513604b44`, as 13.1 gives it |

`restic version` prints `restic 0.19.1 compiled with go1.26.4 on linux/amd64`, and `wacli --version` prints `wacli 0.26.0`. The prebuilt wacli is linked against glibc.

**The scratch folder** is `~/ww/scooter-scratch` on the Linux machine: `gondolin/` holds a plain install of Gondolin 0.14.0, `downloads/` the two checked archives, and `image/` the built VM image that `SCOOTER_TEST_IMAGE` points at. Nothing in the repository depends on it.

### 0.3 Decisions

**D1. A `package.json` already, with Gondolin alone.**
*Question:* the plan builds `package.json` in milestone 1, but every milestone is done only when `npm ci` and `npm test` pass.
*Choice:* a minimal one now: private, ES modules, Node 22.19 or newer, `npm test`, and `@earendil-works/gondolin` pinned to 0.14.0, the one library these checks use. Milestone 1 adds `bin` and the other three libraries.
*Reason:* the smallest file that lets the done-when rule hold.

**D2. `npm test` runs `node --test "test/**/*.test.mjs"`.**
*Question:* which files are tests.
*Choice:* only files named `*.test.mjs`.
*Reason:* without a pattern, `node --test` runs every `.mjs` file under `test/`. That would include the helpers in `test/support/`, the capture script, and later the live checks in `test/live/`, which need the network.

**D3. `.npmrc` sets `ignore-scripts=true`.**
*Question:* whether `npm ci` may run the install scripts of dependencies.
*Choice:* no, for everyone who installs from the repository.
*Reason:* 8.3 and gate G1 install with `--ignore-scripts`. Two of Gondolin's dependencies, `ssh2` and `cpu-features`, compile native add-ons in their install scripts. A plain install on this machine, which has a compiler, built both, and a production install has neither. With the setting, development runs what production runs. All of milestone 0's checks passed on an install made this way.

**D4. The checks are tests, kept in `test/tools/`.**
*Question:* where the milestone's checks live once they have been run.
*Choice:* as `node:test` tests that assert what was found, and skip themselves where they can't run.
*Reason:* the plan's risk table makes them the suite to run again after upgrading Gondolin or pi. A test that states the outcome fails when the outcome changes. A note in this file would not.

**D9. restic and wacli were installed by hand.**
*Question:* whether to add an install script.
*Choice:* no script. The commands are in 0.2.
*Reason:* nothing else needs one yet. Gate G1 and the Dockerfile install the two in their own ways.

**D12. Changes to DESIGN.md made while building are recorded in this file.**
*Question:* section 8 of ARCHITECTURE.md is the record of the changes made to DESIGN.md while planning, and the plan refers to its rows by number. The owner's two answers of milestone 0 changed DESIGN.md again.
*Choice:* the record of such a change is its entry here, with the question and the answer. The table in ARCHITECTURE.md keeps its 17 rows, and a paragraph below it points here. So does the top of DESIGN.md.
*Reason:* rule 3 of section 2 of the plan puts what is decided while building in this file. The table's own introduction says its rows are the changes of 2026-11-15, made while planning.

## Milestone 1: foundations and the datastore

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. DESIGN.md and ARCHITECTURE.md are unchanged.

What the milestone left in the repository:

| Path | What |
|---|---|
| `package.json`, `package-lock.json` | `bin`, and the four libraries pinned |
| `src/cli.mjs` | The command table of 8.4. No command is built yet |
| `src/common/` | `limits`, `settings`, `paths`, `time`, `log`, `files`, `proc`, `locks`, and `datastore/` with the line format, the reader and the index |
| `bridge.env.example`, `runner.env.example` | Every variable of 8.2, explained |
| `test/support/` | The fake clock, a log that keeps its entries, the switches for root tests, and the checker for the import rules |
| `test/*.test.mjs` | One file for each module, and `imports.test.mjs` |

### 1.1 Decisions

**D13. The four libraries, at the versions the documents give.**
*Question:* the old architecture document's list of third-party code says to pin a newer fix release where there is one.
*Choice:* `@earendil-works/gondolin` 0.14.0, `yaml` 2.9.1, `imapflow` 2.11.0 and `postal-mime` 4.2.1.
*Reason:* on 2026-11-16 npm had no newer fix release of any of them. `imapflow` has 2.12.0 and 2.12.1, both of 2026-11-15. That is a new minor release, not a fix release of 2.11, so it isn't taken.

**D14. The env file format is the part all three readers share, and anything else is refused.**
*Question:* the plan wants one format that Scooter's loader, systemd's `EnvironmentFile` and Compose's `env_file` read the same way, and names its parts: `KEY=value`, `#` comments, optional single quotes, no expansion.
*Choice:* the loader takes exactly that, and treats every other line as an error that names the file, the line and the variable:
- a comment is a line of its own;
- a name is letters, digits and `_`, with nothing before it and no space around the `=`;
- an unquoted value is trimmed, and may not contain `$`, `\`, `#`, `'` or `"`;
- a quoted value is inside single quotes, on one line, and is taken exactly as written;
- a name may be set once.

So a value can't contain a single quote at all.
*Reason:* a line the three read differently would give the service one value under systemd and another under Compose. 1.2 has what each of them does with such lines. The loader is stricter than it has to be in four places, where the three happen to agree: `#` without a space before it, a lone `'`, plain double quotes, and spaces around the `=`. One short rule, "anything unusual goes in single quotes", is easier to follow than the exact edge of each.

**D15. A variable in an env file that isn't one of that service's is an error.**
*Question:* what to do with a name the service doesn't know.
*Choice:* in the file, it stops the service, and the message names it. If it is the other service's variable, the message says which file it belongs in. Unknown variables in the environment itself are ignored, as they have to be.
*Reason:* a misspelled name would otherwise be ignored without a word: `EMAIL_IMAP_HOTS` would leave email off. And the runner's key in `bridge.env` would sit where the bridge can read it, against [Secrets](ARCHITECTURE.md#secrets). *Cost:* the env files hold Scooter's settings and nothing else. Under Compose there is no file to read, only the environment, so this check does nothing there.

**D16. An empty value means the variable isn't set.**
*Choice:* empty, or only spaces, takes the default, and for a required variable is the same as leaving it out. A variable set but empty in the environment still wins over the file (8.2).
*Reason:* Compose passes `KEY=` on as an empty variable, and the example files have such lines. [The email channel's settings](architecture/email.md#settings) already say that an empty `EMAIL_IMAP_HOST` turns email off.

**D17. Each numeric setting has a range. The ranges are in `limits.mjs`, and the defaults are in `settings.mjs`.**
*Question:* 8.6 says a value becomes a setting only with a valid range and a test, and gives no ranges.
*Choice:*

| Setting | Range |
|---|---|
| `BATCH_SECONDS` | 1 to 600 |
| `SESSION_ROLLOVER_HOUR` | 0 to 23 |
| `EMAIL_IMAP_PORT` | 1 to 65535 |
| `EMAIL_CHECK_SECONDS` | 10 to 3600 |
| `RESTIC_KEEP_DAILY` | 1 to 3650 |
| `RESTIC_KEEP_WEEKLY` | 0 to 520 |
| `RESTIC_KEEP_MONTHLY` | 0 to 1200 |

*Reason:* the low ends are what protects: a batch can't start on every poll, the mailbox isn't asked more than every 10 seconds, and at least one daily backup is kept. The high ends only catch slips of the hand. A range is a fixed number that protects behavior, so it is a constant (`SETTING_RANGES`). A default is the setting's own value, so it stays with the setting's check; the defaults are in the Settings of [the runner](architecture/runner.md#settings), [the email channel](architecture/email.md#settings) and [backups](architecture/backups.md#settings).

**D19. Other settings rules.**
- Loading returns an object and never changes the environment. A program the service starts gets only what it is handed ([Secrets](ARCHITECTURE.md#secrets)).
- Every fault is reported at once, each naming its variable. No message repeats a value, because a value may be a secret.
- When email and backups are on, and which of their settings each then needs, and how the owner's number and email addresses are read: the Settings of [the WhatsApp channel](architecture/whatsapp.md#settings), [the email channel](architecture/email.md#settings) and [backups](architecture/backups.md#settings).
- `DATA_DIR` and `CONFIG_DIR` default to `/data` and `/config` and must be absolute paths.
- `AGENT_ACCEL=hvf` passes the settings; what the runner does with it is in [Acceleration](architecture/sandbox.md#acceleration).
- `SCOOTER_ENV_DIR` is read from the environment alone.

**D20. Constants: units, how tests change them, and two additions.**
*Choice:* durations are in milliseconds and sizes in bytes, under the names 8.6 gives. `limits` is one object that code reads at the moment of use, and `overrideLimits` changes values for a test and returns the function that puts them back. Besides `WEBHOOK_PORT`, which the plan adds, there are two more: `SETTING_RANGES` (D17) and `ATTACHMENT_EXT_MAX_CHARS`, 10, the longest extension an attachment's stored name takes from its original name.
*Reason:* 8.6 wants every tuning number in the module and tests overriding them through it.

**D30. The CLI.**
*Choice:* the table has the twelve commands of 8.4, each with a side: `bridge`, `runner`, or `host` for `setup` and `build-image`, which ARCHITECTURE.md 2.13 lists as root's, on the host. A `bridge` or `runner` command gets its side's settings and the other side's env file is never opened. A `host` command gets none here: what `setup` and `build-image` read is for milestones 12 and 7 to settle. A command's code is imported only when the command runs. No command is built yet, and each says so and exits with 1. Exit codes: 0, 1 when a command fails, and 2 when it can't start because of how it was called or configured, which matches the 2 that [The CLI commands](architecture/backups.md#the-cli-commands) gives the backup commands.

**D32. Two kinds of root test.**
*Choice:* tests that need root, to give files away or to run a program as another user, run whenever the suite runs as root, with made-up numeric IDs. Tests that create a user run only with `SCOOTER_ROOT_TESTS=1` as well.
*Reason:* section 10 keeps user creation behind that variable, so running the suite as root on a real machine creates none. A numeric owner needs no user to exist.

### 1.2 Facts found: how systemd and Compose read an env file

Checked by hand on 2026-11-16, with systemd 255 (`systemd-run --user -p EnvironmentFile=…`) and Docker Compose v5.3.1 (`env_file:`), each running a script that prints its environment.

A file in the format of D14 came out the same from both, and the same as from `parseEnvFile`: comments, also indented ones; an empty value; a value with spaces inside; spaces around a value, which both trim; a URL; and single-quoted values holding `$$`, `${HOME}`, `\`, `#`, double quotes and spaces at the ends, all kept as written.

Lines outside the format:

| Line | systemd | Compose |
|---|---|---|
| `A=pa$$word` | `pa$$word` | `pa$word` |
| `B=${HOME}/x` | `${HOME}/x` | the home folder, then `/x` |
| `C=back\slash` | `backslash` | `back\slash` |
| `D=value # comment` | `value # comment` | `value` |
| `M='two' words` | `twowords` | `two` |
| `export I=1` | nothing set | `I` is `1` |
| `; L=1` | a comment | the whole file is refused |
| `H`, a bare name | ignored | taken from Compose's own environment |
| `E=value#1`, `F="double"`, `G=it's`, `J = 1`, a space before the name | the same in both | the same in both |

*So:* the loader refuses all of these, the last row too (D14).

## Milestone 2: bridge intake, WhatsApp

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. DESIGN.md and ARCHITECTURE.md changed only where they still listed as open what milestone 0 had settled.

It also settled the smaller points of the reviews of milestones 0 and 1, in code, tests and documents (2.2).

### 2.1 Decisions

**D52. The wacli stub.**
*Choice:* the wrapper first on `PATH` is a Node file whose `#!` line names this Node's own path, and it imports `test/support/wacli-stub.mjs`. Its control folder is beside it. The stub records every call (arguments, environment, user, group, pid), answers from fixtures read afresh at each call, and, running as `sync --follow`, posts the files the test puts in its `webhooks/` folder, signed with the secret on its command line.
*Reason:* 10 says shell wrappers. wacli's environment has no `PATH` to find `node` on, and `dash` adds `PWD` to the environment the stub would record, so the least-privilege test couldn't check that wacli gets exactly its six variables.
*Also:* the tests run the bridge in-process with a fake clock, and once as a real process, `scooter bridge` on the real port, which skips itself when the port is in use. As root, the tests give no users, so wacli runs as root, except one test that runs it as made-up IDs and checks the owners and modes (D32). The tests move the clock ten minutes at a time, so they give wacli calls a timeout far beyond that, except the test of the timeout.

**D53. Where the VM tests keep Gondolin's cache folder.**
*Question:* `test/support/vm.mjs` makes Gondolin's cache folder in the real temporary folder when the module loads, in every process that imports it, whether or not a VM test runs (the review of milestone 0, point 5).
*Choice:* kept as milestone 0 made it. Gondolin fixes the folder for its list of running VMs when its module loads ([Facts about Gondolin 0.14.0](architecture/sandbox.md#facts-about-gondolin-0140)), before any test has a folder of its own, and the folder is removed when the process exits.
*Cost:* a process that is killed leaves `scooter-vm-*` in the temporary folder. Rule 4 of section 2 of the plan has each test work in its own folder; this is one folder per test process instead.

### 2.2 The reviews of milestones 0 and 1

Both pull requests were approved with smaller points listed. Those of milestone 0 are below, with what became of each; those of milestone 1 were settled in the code of the bridge's side and the datastore, whose documents hold the rules.

The review of milestone 0 (pull request 1):

| # | Point | What became of it |
|---|---|---|
| 5 | `test/support/vm.mjs` makes a folder outside the test's own | Settled by recording the choice (D53) |

## Milestone 3: runner, planning

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. What it decided of the runner is in [the runner](architecture/runner.md); what is left here is of the configuration.

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/runner/config.mjs` | `agents.yaml` and its validation; the only module that imports `yaml` |
| `src/common/time.mjs`, `src/common/datastore/index.mjs`, `src/common/limits.mjs` | `previousLocalTime`, `isDate`, `shiftDate`; each line's number in its log, and the commands; three constants |
| `test/config.test.mjs`, `agentstate`, `triggers`, `batch`, `agentdir`, `outbox`, `planning` | The tests of this milestone |


### 3.1 Decisions

**D54. `agents.yaml`: every field is required except `thinking`, and a key the format doesn't have is a fault.**
*Question:* 6.1 marks `thinking` as optional and says nothing of the others, nor of keys it doesn't list.
*Choice:* the others are required. An unknown key, at any level, is a fault that names it, as an unknown variable in an env file is (D15). The file is read as YAML 1.2 with the core schema, so `on:` is a key and not `true`, and `21:30` unquoted is a time and not 1,290 minutes, as YAML 1.1 would have them. Duplicate keys, and the warnings of the parser, such as a tag it doesn't know, are faults too. Every fault is reported at once, each as `agents.yaml, line 14: agents.lifelog.run[1].at must be …`: the file, the line, and the field's path, with lists counted from 0.
*Reason:* 6.1 lists no defaults, and a default the owner didn't write is a setting they can't see. A misspelled `reply_mod` would otherwise leave the default in force without a word.

**D55. A model is an OpenRouter ID, and not an `:online` one.**
*Choice:* `model` matches `~?provider/name[:variant]` in lowercase letters, digits, `.`, `_`, `-` and `:`, which all 403 models of pi's catalog do ([What pi sends](architecture/network-policy.md#what-pi-sends)). One that ends in `:online` is refused at startup, with the reason.
*Reason:* the network policy refuses such a model ([Requests to OpenRouter](architecture/network-policy.md#requests-to-openrouter)), so every run would fail. Saying so at startup is cheaper.

**D56. Paths in the config, and what a skill is.**
- A path is relative to the config folder, cleaned (`./`, `//` and a trailing `/` don't matter), and must name something inside the folder after links are followed. A link out of it is a fault.
- A skill's name is its folder's name, and two skills can't share one: a backfill names its skill that way, and the name is a folder in `run/config/`.
- A skill's folder holds only files and folders, and a `SKILL.md`. A link inside one is a fault at startup; what a run does with one that appears later is in [A run](architecture/run.md#a-run).

**D57. `ack_reaction` is one emoji, or "".**
*Choice:* one grapheme, such as `✅`, `👍🏽` or `❤️`, with no space or control character in it.
*Reason:* a WhatsApp reaction is one emoji. A word would fail on every quiet run.

**D58. `timeout_minutes` from 1 to 120.**
*Choice:* a new constant, `CONFIG_RANGES`, as `SETTING_RANGES` is for the env files (D17).
*Reason:* 8.6 wants a range for a number the owner sets. The low end keeps a run from being cut off before pi starts; the high end is a slip of the hand, and also how long a backup can wait ([The locks](architecture/exchange.md#the-locks)).

**D59. The entries of `run`.**
- Each entry has exactly one of `on`, `at`, `once` and `backfill`, and only the keys that go with it.
- `on: new-messages` is the only `on`, and is given at most once. What it does is in [When the agent runs](architecture/runner.md#when-the-agent-runs).
- `at` values are unique, as the plan's rule says: they are the keys of `scheduled`.
- `once` and `backfill` IDs are lowercase letters, digits and hyphens, and unique within their kind. They go into session names and commit messages ([rebuild and backfill](architecture/rebuild-and-backfill.md)).
- `run` may be empty: an agent that runs on nothing is the owner's to configure.

**D60. What a backfill may change.**
*Choice:* `writes` is a list of at least one path, each `views/<…>` with at least one part after `views/`: a file, or a folder ending in `/`. Refused: `views/` itself, `views/days` and anything in it, `..`, `.`, empty parts, and names starting with a dot. A backfill's `skill` is one of the agent's skills, by name, other than `day-pages`.
*Reason:* 6.1 and [Backfill](architecture/rebuild-and-backfill.md#backfill), and names the file check would refuse anyway ([After a successful run](architecture/run.md#after-a-successful-run)).

### 3.2 Facts found

- **YAML.** `yaml` 2.9.1 with `version: '1.2'` and `schema: 'core'` reads `09:05` as a string, `on` as a key, and `010` as 10. A duplicate key is an error, and an unknown tag a warning that the config turns into a fault.

## Milestone 4: runner, running

Done on 2026-11-17, and after the owner's answer and the fourth review on 2026-11-18, on the Linux machine of section 3 of the plan. What it decided is in [the runner](architecture/runner.md) and [A run, and the agent's folder](architecture/run.md), with the owner's answer beside the rules it settled, in [The clean-up](architecture/run.md#the-clean-up). What is left here are two points of the review of milestone 3 that settled rules of the configuration.

### 4.3 The review of milestone 3

| # | Point | What became of it |
|---|---|---|
| 2 | A prompt or skill inside another skill's folder makes every run fail | Settled: a fault at startup that names the field, either way round. Test in `config` |
| 7 | Smaller still | `ack_reaction: k` is refused: the grapheme must hold a pictograph, a flag or a keycap. With a test. The rest of the point is in [Commands](architecture/runner.md#commands) and [The batch](architecture/runner.md#the-batch) |

## Milestone 5: delivery and commands

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. DESIGN.md changed in 5, 5.1, 5.3, 8.6 and section 10, to say what this milestone settled; those sections are now the documents of the bridge's side, in [the map](ARCHITECTURE.md#the-map).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/common/limits.mjs`, `time.mjs`, `runnerstatus.mjs` | Five constants; `shortLocalTime`; agents' names checked in `status.json` |

## Milestone 7: sandbox and VM image

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. What it decided is in [the sandbox and the VM image](architecture/sandbox.md).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/cli.mjs`, `src/runner/main.mjs` | `scooter runner` with the Gondolin sandbox, and `scooter build-image`; a sandbox that can't run as it is set up exits with 2 |
| `src/common/settings.mjs`, `limits.mjs`, `paths.mjs` | `loadFolders`, for `build-image`; eight constants; `imageStaging` |
| `test/sandbox`, `image`, `accel` | This milestone's tests, with additions to `run`, `failures`, `limits`, `email` and `whatsapp` |

## Milestone 8: network policy and log

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. What it decided is in [the network policy](architecture/network-policy.md), with what it settled of the sandbox in [the sandbox and the VM image](architecture/sandbox.md) and of the cause of a failure in [Failures](architecture/run.md#failures).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/common/limits.mjs` | Three constants |

## Milestone 9: rebuild and backfill

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. What it decided is in [rebuild and backfill](architecture/rebuild-and-backfill.md), with what it settled of the network policy in [the network policy](architecture/network-policy.md).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/cli.mjs` | `scooter rebuild` |

## Milestone 11: the agent's instructions

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. What it decided of the agent's instructions is in [the agent and its instructions](architecture/agent.md), and of the image in [The VM image](architecture/sandbox.md#the-vm-image); what is left here is of the configuration. It also settled the three smaller points of the second review of milestone 10, which are in [backups](architecture/backups.md) and [the exchange](architecture/exchange.md).

What the milestone left in the repository:

| Path | What |
|---|---|
| `config/agents.yaml` | The default config: the example of 6.1 (D199) |
| `src/runner/config.mjs` | A skill's `SKILL.md` checked at startup (D197) |
| `test/instructions.test.mjs` | This milestone's tests, which read the files against DESIGN.md 6.1 and [agent.md](architecture/agent.md), and the protocol against the parser |
| `test/config.test.mjs`, `backup.test.mjs`, `sandbox.test.mjs` | A skill's `SKILL.md`; the link at `runner/` or `exchange/`; one batch through the real sandbox with the files of `config/` |
| `test/live/openrouter.mjs` | The live check, now with the files of `config/` |

### 11.1 Decisions

**D197. A skill's `SKILL.md` gives its folder's name and a description, and the runner checks both at startup.**
*Question:* 6.1 checks only that each skill's folder has a `SKILL.md`, and [Skills](architecture/agent.md#skills) says it starts with frontmatter that has `name` and `description`. pi 1.5.2 reads the frontmatter as YAML and offers the model each skill by its name and description, with the path of its file ([Facts about pi 1.5.2](architecture/agent.md#facts-about-pi-152)). It leaves out a skill whose description is missing or empty, or whose frontmatter isn't YAML, and takes the name from the frontmatter, only warning when it isn't the folder's or isn't of the Agent Skills format's form (`dist/core/skills.js` in pi's package). The runner, the prompt's list of views and a backfill's `skill` name a skill by its folder.
*Choice:* the runner's validation reads each skill's frontmatter as pi does, a first line `---` and YAML up to the next line that starts `---`, a byte-order mark and Windows line breaks allowed, and refuses, naming the skill's field (`agents.lifelog.skills[1] names skills/runs, whose SKILL.md has no description, …`): no frontmatter; frontmatter that isn't YAML, or isn't a map; no `name`, or one other than the folder's; a name pi doesn't take, which is at most 64 lowercase letters, digits and single hyphens between them; no `description`, or an empty one; and one longer than 1,024 characters. Other keys, such as `license`, are left alone.
*Reason:* an owner who adds a skill and forgets its description would otherwise have a runner that starts and an agent that never sees the skill, and nothing would say so; a name other than the folder's would have pi offer the model `expense-tracking` where the prompt says `(skill: expenses)`. 6.1's rule is that any error stops the runner with a message that names the field. The two numbers are pi's, not tuning numbers, so they stay beside the check in `config.mjs`, as Gondolin's socket limits stay in `gondolin.mjs`.
*Cost:* a skill folder named as pi only warns about, such as `Receipts` or `receipts_old`, is refused.

**D199. The default `config/agents.yaml` is the example of 6.1.**
*Choice:* 6.1's example as it stands, with its comments, the commented `once` and `backfill` entries among them, under a two-line comment that says what the file is. So the evening check-in at 21:30 is on. One comment says the paths are "relative to this config folder", where 6.1 says `/config`, which is the folder's name in Docker only.
*Reason:* 6.1 specifies the file, and the owner edits it. The check-in is a message the bot sends on its own every evening, where the bot is quiet by default (principle 6), but 6.1 has it, so it stays, and the plan's milestone 14 has the README say how to remove it.

## Milestone 12: native install

Done on 2026-11-18, on the Linux machine of section 3 of the plan, with gates G1 and G2 in a throwaway root VM on it (section 6 of the plan). Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. DESIGN.md changed in 5.3, now [delivery](architecture/delivery.md), 6.1, 7.3, now [Skills](architecture/agent.md#skills), 8.4, 8.5, 8.6, section 9, whose rules are now in the documents of [the map](ARCHITECTURE.md#the-map), and section 10, to say what this milestone settled (12.4 here). It also settled the eight smaller points of the review of milestone 11, and the point the first review of milestone 4 left for this one (12.3).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/ops/setup.mjs` | `scooter setup [--no-services]`: the checks, the users, the folders, the env files, the command and the services (D209 to D213) |
| `src/ops/doctor.mjs` | `scooter doctor` (D214) |
| `deploy/systemd/scooter-bridge.service`, `scooter-runner.service` | The two units (D207) |
| `src/common/proc.mjs` | `findUser`, which any user may ask, and `findGroup` |
| `src/common/limits.mjs` | `DOCTOR_TIMEOUT` and `DOCTOR_RESPONSE_MAX_BYTES` |
| `src/cli.mjs` | `setup`, `doctor` and `pair` built: every command of 8.4 is |
| `src/runner/config.mjs` | The review of milestone 11, points 3 to 5 (D208) |
| `test/setup.test.mjs`, `doctor.test.mjs`, `units.test.mjs` | This milestone's tests, the root test among them |
| `test/delivery.test.mjs`, `files.test.mjs`, `whatsapp.test.mjs`, `config.test.mjs` | The record in `bridge/`, and the link swapped in once an entry is taken; `settleFolder`; `pair`; the skill checks |

### 12.1 Decisions

**D207. The two units, and how they restart** (the first review of milestone 4; the plan's rule for this milestone).
*Choice:* `deploy/systemd/scooter-bridge.service` runs `/usr/local/bin/scooter bridge` as root; `scooter-runner.service` runs `/usr/local/bin/scooter runner` as `scooter-runner`, with its group and `SupplementaryGroups=kvm`. Both: `Type=exec`, `Environment=TZ=UTC`, `KillMode=control-group`, `Restart=on-failure`, after `network-online.target`, wanted by `multi-user.target`, and no `EnvironmentFile`: each service reads its own env file (8.2). The restarts:
- the runner's after 1 minute, then about 5½, then 30 minutes, and every 30 after (`RestartSec=1min`, `RestartSteps=2`, `RestartMaxDelaySec=30min`): the runner's waits ([Restarts](architecture/runner.md#restarts));
- the bridge's after 5 seconds, doubling to 5 minutes (`RestartSec=5s`, `RestartSteps=6`, `RestartMaxDelaySec=5min`): `RESTART_BACKOFF`, as the bridge restarts wacli and the email reader.

The runner's home and temporary folder aren't set in its unit: the runner sets them itself ([The runner's own folders](architecture/sandbox.md#the-runners-own-folders)), which the plan's rule allows, and one place says where they are.
*Reason:* the runner stops on an error and leans on its service manager, whose waits are its own ([Restarts](architecture/runner.md#restarts)). Each of its starts waits out the quiet period first ([When the agent runs](architecture/runner.md#when-the-agent-runs)), so systemd's start limit, 5 starts in 10 seconds, never stops one that keeps failing after pi has run. `Type=exec` makes a start fail when the command can't be run.
*Cost:* systemd counts the restarts until the unit is started by hand or the machine starts again, not after a run that lasted (12.2): from a third crash since then, the runner comes back after 30 minutes. Messages wait meanwhile, and none is lost. `RestartSteps` needs systemd 254; Ubuntu 24.04 has 255, and an older systemd warns of the two settings and restarts every minute.

**D208. The skill checks the review of milestone 11 asked for** (its points 3, 4 and 5).
*Choice:* the runner's check of a skill's `SKILL.md` (D197) now:
- refuses `disable-model-invocation: true`, which keeps pi from offering the skill to the model; `false` is accepted;
- takes a name YAML reads as a number, such as `42` for a folder named `42`, as written, as pi does;
- says a description over 1,024 characters passes what the Agent Skills format allows, which pi warns of, where it said pi takes no more;
- makes a `SKILL.md` it can't read a fault that names the field, listed with the others, where it stopped the runner with `EACCES` and exit code 1;
- writes the byte-order mark as `﻿`, in the check and its test.
*Reason:* the review's ways. Each is a case where the runner would start and the agent never see a skill, or where the message didn't say what pi does.

**D209. Where `setup` puts things, and what a second run does.**
*Choice:* the data in `/var/lib/scooter`, the env files in `/etc/scooter`, the config in `/etc/scooter/config`, the command in `/usr/local/bin`, the units in `/etc/systemd/system` (8.5). Every step is safe to repeat:
- the checks come first, and make nothing (D210);
- users and the `kvm` group's membership are added when missing (D212);
- the folders of [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners) in the data folder are made when missing, and those directly in it given their owners and modes again; a folder in another user's folder, such as `wacli/store`, is made when missing, through `settleFolder` ([Atomic files and hand-offs](architecture/shared-code.md#atomic-files-and-hand-offs)), and otherwise left alone, as that user's; the data folder itself may be a link the owner made to another disk;
- the config is copied, through a temporary folder renamed into place, only when `/etc/scooter/config` isn't there, with the owner and modes of [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners): it is the owner's from then on;
- the env files are written only when missing, and otherwise given their owners and modes again, their text left alone (D211);
- the command and the units are written again each time, so a moved Node or a changed unit is taken up.
`--no-services` leaves the units out and doesn't need systemd; `setup` prints what to do next, and starts nothing.
*Reason:* 8.4 and the plan. Owners and modes put right by a second run are what a restore or a hand's slip can change, and the folders directly in the data folder can be set safely: only root can write the data folder. *Not done:* a data folder elsewhere: `setup` refuses env files that name another (D211). Moving it is the owner's, by hand.

**D210. What `setup` checks of Node and the code** (row 16).
*Choice:* before it makes anything, `setup` refuses, listing every problem, unless:
- it runs as root, and systemd runs the machine (`/run/systemd/system`), unless `--no-services`;
- the Node running it, which `/usr/local/bin/scooter` will run, is 22.19 or later; every folder above its real path can be passed through by every user; it can be run by every user; and it and those folders are root's and writable by root alone, a sticky folder such as `/tmp` allowed above;
- the code, the folder holding `src/cli.mjs`, is the same: every folder above it as Node's, and every folder and file in it, `.git` aside, readable by every user, root's and writable by root alone; and the dependencies of its `package.json` are installed in its `node_modules`.
*Reason:* row 16: the service users must run Node and read the code, which they can't in someone's home folder; and the bridge runs both as root, so a user who could change either could run code as root. *Cost:* a file of the code someone made writable by its group stops `setup` with its name, and up to ten such are listed.

**D211. The env files.**
*Choice:* written from `bridge.env.example` and `runner.env.example`, with their `# DATA_DIR=` and `# CONFIG_DIR=` lines made settings of the folders `setup` uses, nothing else changed; `bridge.env` root's and `runner.env` the runner's, mode 0600, written to a temporary file and linked into place, so one that appears meanwhile isn't written over. One that is there already must name those two folders, or `setup` stops at its check, saying to set them or remove the file.
*Reason:* 8.2 and the plan. A file copied by hand from an example names neither, and the service would then use `/data` and `/config`.

**D212. Scooter's users.**
*Choice:* `useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin`, the shell `/sbin/nologin` or `/bin/false` where that isn't there; `scooter-runner` added to `kvm` with `usermod --append --groups`. A machine with no `kvm` group, such as a container, gets none: `setup` says pi's VMs will run under emulation, that `doctor` says how to enable KVM, and that running `setup` again adds the runner to the group. The names are `USERS`; the root test gives names of its own.
*Reason:* [Processes and users](ARCHITECTURE.md#processes-and-users). No home: wacli's is given by the bridge, the runner's set by the runner, and the email reader's by the bridge ([Running wacli](architecture/whatsapp.md#running-wacli), [The email reader](architecture/email.md#the-email-reader), [The runner's own folders](architecture/sandbox.md#the-runners-own-folders)); `/nonexistent` is Debian's way. Creating a `kvm` group where the kernel offers no KVM would change nothing.

**D213. `/usr/local/bin/scooter`.**
*Choice:* a shell script, root's, mode 0755, that `exec`s the real path of the Node that ran `setup` with the code's `src/cli.mjs`, both in single quotes, and refuses a path that holds one. The first `setup` is run as `sudo node /opt/scooter/src/cli.mjs setup`, or `sudo /opt/scooter/src/cli.mjs setup`, since it writes the command.
*Reason:* the plan's rule ([When backups run](architecture/backups.md#when-backups-run)): with `exec`, Node is the service's main process, which `systemctl kill --kill-whom=main -s USR1 scooter-bridge` reaches. G2 shows it (12.5).

**D214. `doctor`.**
*Choice:* it runs as the runner's user, with the runner's settings, and reports, in order, each check as `ok`, `warn` or `fail`, with a fix for what isn't `ok`: `agents.yaml`, as the runner checks it; the accelerator; QEMU, the system emulator and `qemu-img`; the image, as the runner checks it; the folders of [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners) against `setup`'s own table (D209), those it can look at; the env files, the runner's its own and 0600, the bridge's out of its reach, none in Docker; whether `openrouter.ai` answers; and, with ZDR on, the configured model's endpoints in OpenRouter's public list of the endpoints that keep no data, `GET /api/v1/endpoints/zdr`, with those with safety retention marked. It exits with 1 when something failed, and 0 otherwise.
- Emulation under `AGENT_ACCEL=auto` is a warning: the runner runs. A forced accelerator that can't be used, and a model with no endpoint that keeps no data under ZDR, are failures.
- How to enable KVM depends on where it runs: natively, the `kvm` group, through `setup` and the unit; in Docker (`/.dockerenv`), the device and `group_add` for rootful Docker, or the README's udev rule for rootless; and the firmware, or nested virtualization, when there is no `/dev/kvm`.
- The fixes name `sudo scooter setup` and `sudo scooter build-image` natively, and in Docker the command that would do it.
- It sends OpenRouter no key and nothing of the owner's, and reads at most `DOCTOR_RESPONSE_MAX_BYTES` within `DOCTOR_TIMEOUT`.
*Reason:* 8.4. The runner's own checks, of the config, the image and the accelerator, are what it uses: `src/cli.mjs` hands them to `doctor` as `runner`, as it hands `runRunner` its sandbox, so `src/ops` still imports only `src/common` ([The code's layers](ARCHITECTURE.md#the-codes-layers)), as `setup.mjs` does.

### 12.2 Facts found

- **systemd's restart counter** (systemd 255, on the Linux machine, with a unit of the user's own manager that failed at once, then after running 8 seconds): with `RestartSteps` and `RestartMaxDelaySec` the waits grow as D207 has them, 1, 2, 4 and 8 seconds for 1 second, 3 steps and 8 seconds; and the counter doesn't go back after a run that lasted: the waits stayed at their longest. It goes back when the unit is started by hand.
- **`systemd-analyze verify`** exits with 0 when a unit has a setting it doesn't know, or a value it can't take, and says so on stderr; it fails when the command isn't there. So the test gives each unit a stand-in command, and wants nothing on either stream.
- Ubuntu 24.04's cloud image has no `bzip2`, which restic's release needs to be unpacked; G1 installs it with the rest.

### 12.3 The reviews of the pull requests merged before this one

Pull request 12, milestone 11, was approved by its review with eight smaller points. All eight are settled:

| # | Point | What became of it |
|---|---|---|
| 3 | A skill with `disable-model-invocation: true` passes the check, and the model never sees it | Settled (D208): refused. Test in `config` |
| 4 | An unreadable `SKILL.md`, a name of digits, and the words about 1,024 characters | Settled (D208): a fault that names the field; the name taken as written; the format's limit. Tests in `config` |
| 5 | The byte-order mark written as the character | Settled (D208): `﻿` in both |
| 6 | The plan's note for the README holds natively only | Settled: the plan's milestone 14 says what an upgrade does to `./config` in Docker |

The points earlier reviews and milestones left:

| From | Point | What became of it |
|---|---|---|
| Milestone 4, first review | `RestartSec` for the runner's unit | Settled (D207) |
| Milestone 10, what wasn't verified | A native restore | Run at G2 (12.5) |

### 12.4 Changes to DESIGN.md

None changes what Scooter does beyond what this milestone settled:
- 6.1: a skill doesn't set `disable-model-invocation: true` (D208).
- 8.4: `setup`'s steps and `--no-services`; what `doctor` checks, and its exit code (D209, D214).
- 8.5: the first `setup`, the units' restarts, and the command's `exec` (D207, D213).
- 8.6: `DOCTOR_TIMEOUT` and `DOCTOR_RESPONSE_MAX_BYTES`.
- Section 10: Least privilege, with `setup`'s root test. The required tests of delivery: the link swapped in once an entry is taken.

The plan's milestone 14 has what this milestone leaves for the README.

### 12.5 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, restic 0.19.1, systemd 255. `4ef9630` holds all the code and tests; the commit after it records this section and nothing else. The code was the same at `515dcb8`, where the runs marked so were made.

| Command | Result |
|---|---|
| `npm ci && npm test`, on a clean clone of the branch from GitHub at `4ef9630` | 744 tests: 697 pass, none fail. 47 skip themselves: 35 need the image, 8 need root, and 4 need root and `SCOOTER_ROOT_TESTS=1`. `systemd-analyze verify` runs, and finds nothing to say of either unit |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'`, at `515dcb8` | 746 tests: 734 pass, none fail, in 113 seconds. The 12 that need root skip themselves. No QEMU left |
| The root-test command of section 3 of the plan, on a second clean clone at `4ef9630`, with `~/.local/bin/restic` mounted at `/usr/local/bin/restic` | Node 24.22.3: 744 tests, 684 pass, none fail. 60 skip themselves: 35 need the image, 4 `mke2fs`, 4 wacli, 2 run `scooter bridge` as a process, 1 `systemd-analyze`, and 14 are about what root can read or write anyway. `setup`'s root test runs, and passes; so do the restic round trip and the restore of owners by name |
| The same, at `515dcb8`, without restic | 744 tests, 681 pass, none fail, 63 skip |
| By hand, a user unit of systemd 255 restarted with `RestartSteps` | 12.2: the waits grew, and didn't go back after runs that lasted |

**Gate G1**, in a throwaway Ubuntu 24.04 VM on the Linux machine: the official cloud image, checked against its `SHA256SUMS`, on a fresh 40 GB disk, with KVM, `-cpu host`, 4 processors and 8 GB, user-mode networking, SSH on `127.0.0.1` only, booted in 12 seconds; `/dev/kvm` there.
- Node 22.23.2, the official tarball, checked against its `SHASUMS256.txt`, unpacked into `/usr/local`, root's.
- `bzip2`, `lz4`, `qemu-system-x86`, `qemu-utils`, `cpio`, `e2fsprogs` and `git` from `apt`: QEMU 8.2.2, e2fsprogs 1.47.0.
- restic 0.19.1 and wacli 0.26.0, the releases of milestone 0, checked against their checksums there, in `/usr/local/bin`.
- `/opt/scooter`, cloned as root from the pull request's branch at `515dcb8`, with `npm ci --omit=dev --ignore-scripts`.

**Gate G2**, in the same VM:

| Step | What was run | What happened |
|---|---|---|
| 1 | `sudo /opt/scooter/src/cli.mjs setup`, then `sudo scooter setup`; the two env files filled in, a dummy number and a dummy key | The first made the three users (system users, `/nonexistent`, `nologin`), `scooter-runner` in `kvm`, the 16 folders with the owners and modes of [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners), the config's copy, root's with the runner's group, `bridge.env` root's and `runner.env` the runner's, both 0600, `/usr/local/bin/scooter`, and the two units, enabled and not started. The second changed nothing. Exit code 0 both times |
| 2 | `sudo scooter build-image` | The first native build as root: 16 seconds, 527 MB, the image the runner's, `.image-build/` gone |
| 3 | `sudo systemctl start scooter-bridge scooter-runner`, then `sudo -u scooter-runner scooter doctor` | Both active; their main processes are Node, the runner's with the `kvm` group. The bridge waits for `pair`; the runner uses KVM. `doctor` passed every check, with 6 endpoints of the model that keep no data, and exited with 0 |
| 4 | As `scooter-wacli` and as `scooter-mail`: `ls` on `datastore`, `agents`, `exchange`, `runner` and `bridge`; `cat` on the agent's `state.json`, the bridge's, both env files and `agents.yaml` | Every one: permission denied. Each lists its own folder. The runner can't read `bridge.env` |
| 5 | A `once` task added to the config, the runner restarted, and once its QEMU was there, 0.4 seconds in, `sudo systemctl kill --kill-whom=main --signal=SIGKILL scooter-runner` | systemd stopped the rest of the unit: within 3 seconds no process of `scooter-runner` and no QEMU was left. The unit restarted a minute later, removed the `run.lock` the killed runner left, and ran the task again |

Also in G2: `SIGUSR1` with `--kill-whom=main` started a backup to a local restic repository, which stopped and started the WhatsApp channel and made a snapshot; with both services stopped, `sudo scooter restore` refused a folder that wasn't empty, `--force` restored the snapshot, removing a file made since and putting back one removed, every folder with its owner; with the services running it refused, naming the bridge's socket. The VM was then shut down and its disk deleted; no QEMU of `agentw` was left.

The tests the plan asks of this milestone, and where they are:

| Required | Where |
|---|---|
| Hermetic: the decisions `setup` and `doctor` make, such as which users, modes, mounts and settings | `setup.test.mjs`: the folders of [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners) with their owners and modes, the config's and the env files', the env files' text, the command, and the checks of Node, the code and existing env files; `doctor.test.mjs` |
| Hermetic: `doctor` reports each missing piece with its fix | `doctor.test.mjs`: no accelerator, natively and in Docker; no QEMU; no image, and one for another pi; wrong folder modes; no users; a bad `agents.yaml`; OpenRouter out of reach; no endpoint that keeps no data; the env files |
| Root, in a container: `setup` without services creates the users and folders | `setup.test.mjs`, the root test, run twice over |
| Root: wacli and the email reader, run as their users, can't read `datastore`, `agents`, `exchange`, `runner` or `bridge` | The same test, as the two users, on each folder and a file in it |
| Root: each service reads only its own env file | The same test: the runner reads `runner.env` and not `bridge.env`, wacli and the email reader neither, and each side loads its own; and `setup.test.mjs`, the second test, without root |
| `systemd-analyze verify` on both units | `units.test.mjs`, which skips itself where systemd isn't installed |
| What the bridge writes in the outbox, with a root test | `delivery.test.mjs`, the test of the swap; it runs as root in the container too |

Beyond those: `pair`, in `whatsapp.test.mjs`; `settleFolder`, in `files.test.mjs`; the bridge's own outbox and its record, in `delivery.test.mjs`; the units' settings, in `units.test.mjs`; the review's points in `config.test.mjs`.

Not verified:
- **`pair` against WhatsApp**, and the bridge with a paired wacli (gate G4). The tests run the wacli stub; in G2 wacli was unpaired.
- **The units on another systemd.** `RestartSteps` needs 254; on an older one the runner restarts every minute (D207).
- **The install on the machine Scooter will live on**, which stays with the owner (section 6 of the plan), and **arm64**.

## Milestone 13: Docker

Done on 2026-11-18, on the Linux machine of section 3 of the plan, which has rootless Docker, with gate G3 in a throwaway root VM on it (section 6 of the plan). Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. DESIGN.md changed in 3.2, now [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners), 4.3, now [Writing](architecture/datastore.md#writing), 6.6, 6.12 and section 9, now [the sandbox](architecture/sandbox.md), 8.3, 8.4, 8.5, 13.4 and sections 10 and 14, to say what this milestone settled (13.4 here). It also settled the seven smaller points of the review of milestone 12, and the point the second review of milestone 6 left for this one (13.3).

What the milestone left in the repository:

| Path | What |
|---|---|
| `Dockerfile`, `.dockerignore` | The image (D221) |
| `compose.yaml` | The two services, the one data volume, and `build-image`'s container (D219, D220, D222) |
| `compose.kvm.yaml`, `compose.kvm-rootless.yaml` | KVM under rootful and under rootless Docker; `compose.yaml` alone is the third case, without KVM (D217, D222) |
| `src/ops/doctor.mjs`, `src/cli.mjs` | A VM's boot, the runner's user, and the fixes in Docker (D224) |
| `src/ops/setup.mjs` | The kvm group, with services (D225) |
| `src/common/proc.mjs`, `src/bridge/main.mjs` | `inDocker`, which `doctor` and `build-image` ask; a comment (13.3) |
| `test/docker.test.mjs` | This milestone's tests: the Dockerfile and the Compose files against `setup.mjs`, 8.3 and 0.2, and `docker compose config` where Docker is installed |
| `test/live/data-mounts.mjs` | A live check, run by hand in the runner's container: a run's mounts with the data folder at `/data` ([Mounts](architecture/sandbox.md#mounts)) |
| `test/delivery.test.mjs`, `doctor`, `setup`, `image`, `sandbox`, `whatsapp` | The review's points, the boot check and the machine |

### 13.1 Decisions

**D217. The runner's user under rootless Docker** (the plan's rule for this milestone, the outbox's owner in rootless Docker, which the second review of milestone 6 raised).
*Question:* 8.3 ran the runner as the container's root under rootless Docker, with no `user:`, because only the user that runs Docker could be given `/dev/kvm`. The runner then makes its folders, the outbox among them, as uid 0, and the bridge, which takes the runner's entries only while the outbox is `scooter-runner`'s ([Folders other users control](ARCHITECTURE.md#folders-other-users-control)), looks that user up as 10002 and refuses the outbox for good. Which user owns the runner's folders there, and how does the bridge know?
*Choice:* the runner runs as `scooter-runner` under rootless Docker too, as [Processes and users](ARCHITECTURE.md#processes-and-users) has it; the bridge knows it as it always has, by its name. Rootless Docker gives each uid of a container a uid of its own on the host, from the range `/etc/subuid` gives the user that runs Docker: 10002 is that range's start plus 10001, 175537 on the Linux machine, whose range starts at 165536. The udev rule `compose.kvm-rootless.yaml` gives, and the README will, lets that uid read and write `/dev/kvm` with an ACL, set again at each of the device's events: `SUBSYSTEM=="misc", KERNEL=="kvm", RUN+="/usr/bin/setfacl -m u:<uid>:rw $devnode"`. The uid comes from Docker's own map, as the user that runs Docker: `docker run --rm --entrypoint awk scooter:local '$1 <= 10002 && 10002 < $1 + $3 { print $2 + 10002 - $1 }' /proc/self/uid_map`.
*Reason:* the runner is its own unprivileged user everywhere ([Processes and users](ARCHITECTURE.md#processes-and-users); [Why it is built this way](ARCHITECTURE.md#why-it-is-built-this-way)), and the bridge's checks hold as they are, with no setting and no second case: nothing in the code changes. The runner as the container's root would be, on the host, the user that runs Docker and its daemon; it would make its files root's, which a later switch to another variant would leave the runner unable to write; and it would make one volume for the whole data folder (D219) unsafe, since the container's root reads every folder in it. An ACL for one host uid is the narrowest grant there is.
*Cost:* the owner works out a uid with the command above and writes it in the rule; a change of the Docker user's range needs the rule again. systemd's `uaccess`, which Ubuntu gives `/dev/kvm`, sets the users' ACLs afresh at the device's events while a seat has an active session, as on a desktop, which is what 13.4 saw on the Linux machine; the rule's `setfacl` then puts this one back, so a VM starting in that moment, milliseconds after another VM of the machine started or stopped, could fail to start, a setup error that pauses runs for 30 minutes. A server has no seat session, and in the root VM the ACL stayed through every VM (13.5). `MODE="0666"` on `/dev/kvm`, systemd's own default, would leave no such moment, and would give every user of the machine KVM, which Ubuntu chose not to; the owner may choose it. DESIGN.md 8.3 now runs the rootless runner as `scooter-runner`, and gives that uid, not the Docker user, the access of its own.

**D219. In Docker, one volume holds the whole data folder** (the plan's rules for this milestone: `build-image` in Docker, and `restore` in Docker).
*Question:* the design's table of folders, now [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners), gave each folder a volume of its own, mounted read-only where a service only reads it. `build-image` builds in `/data/.image-build/` and renames the image into `/data/runner/image/`, which must be one file system, and, as root, refuses a `/data` another user can write ([build-image](architecture/sandbox.md#build-image)); with a volume for each folder, `/data` is the container's own file system, read-only in the runner's. And `restore` writes `runner/log/`, which the bridge's container couldn't.
*Choice:* one named volume, `data`, at `/data` in the bridge's container, the runner's and `build-image`'s, as the plan's example has it. What it is for, how the owners and modes keep the services apart in it, and what it costs, is in [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners). The image's `/data` holds the folders with the owners and modes `setup` gives a native install (`dataFolders`), and a new named volume starts as a copy of it. A Docker install is then the native install's layout, which `setup`'s and `doctor`'s checks, `setup`'s root test and G2 have checked.
*Cost:* a bind mount of a host folder in the volume's place starts empty, not as a copy of the image's `/data`, and the runner can't make its folders in a `/data` of root's: the README should say to keep the named volume, or to make the folders with their owners first.

**D220. In Docker, `build-image` runs in a container of its own: `docker compose run --rm build-image`, as root and privileged** (the plan's rule for this milestone; 8.3 left the command to when it was first tried).
*Question:* as root in the runner's container if the builder's chroot works there, otherwise as a one-off with the privileges it needs ([build-image](architecture/sandbox.md#build-image)).
*Found:* it doesn't work in the runner's container. As `scooter-runner` the build needs root, or a container runtime, which the container doesn't have. As root (`docker compose run --rm --user root runner build-image`), Gondolin's native builder can't make its cache under the read-only root file system, and the mount of `/proc` its chroot needs is refused there without `CAP_SYS_ADMIN` (13.2).
*Choice:* a service of its own in `compose.yaml`, `build-image`, from the same image, which only `docker compose run` starts (its profile): `user: root`, `privileged: true`, the data volume and `./config` read-only, and no env file: it reads only `DATA_DIR` and `CONFIG_DIR`, which `compose.yaml` sets. It builds natively, as root, as `sudo scooter build-image` does, in the one volume. What `build-image` says in the runner's container is in [build-image](architecture/sandbox.md#build-image).
*Reason:* the privileges Gondolin's own container build takes, `--privileged`, on a container that runs only the build, only when the owner starts it, and is removed afterwards; the runner's service keeps none of them. Fewer, such as `CAP_SYS_ADMIN` with Docker's masks of `/proc` and AppArmor's profile lifted, weren't tried: they differ between rootful and rootless Docker, for a container that runs nothing else.
*Cost:* under rootful Docker a privileged container is root on the host, with its devices: the build runs what a native build as root runs ([build-image](architecture/sandbox.md#build-image)). Under rootless Docker it is the user that runs Docker, with no root on the host. The build took 14 to 17 seconds, and the image was 527 MB (13.5).

**D221. The image.**
*Choice:* 8.3's two stages. `golang:1.27-trixie` builds wacli 0.26.0 with 13.1's command. `node:24-trixie-slim` installs 8.3's packages without their recommendations, QEMU for `TARGETARCH` (`qemu-system-x86` or `qemu-system-arm`), and `qemu-utils`, for `qemu-img`, which Gondolin runs and `doctor` checks. restic 0.19.1 is checked against the checksums milestone 0 took from the release's `SHA256SUMS` (0.2), written in the Dockerfile for each architecture, rather than against a `SHA256SUMS` fetched beside it, which would only say that the two came from the same place. The users are made as `setup` makes them (D212), at 10001 to 10003; the data folder as D219 says; the app is root's, installed with `npm ci --omit=dev --ignore-scripts`; `TZ=UTC`; and the entry point is `tini -- node /app/src/cli.mjs`, with `help` when no command is given. `.dockerignore` lets only `package.json`, the lock file and `src/` into the build, so no env file or data folder is copied in. A test holds the users, the folders and restic's checksums to `setup.mjs` and this file.
*Reason:* 8.3. tini passes a signal on to Node, the service's main process, so `docker compose kill -s SIGUSR1 bridge` starts a backup ([When backups run](architecture/backups.md#when-backups-run)); as the container's first process it takes every process of the container with it when it ends, so the runner's QEMU doesn't outlive the runner's container ([Supervision](architecture/sandbox.md#supervision); 13.5).
*Found:* the image is 775 MB, with QEMU 10.0.13 and Node 24.22.3. It built in 28 seconds on the Linux machine, wacli's stage in 12.

**D222. `compose.yaml`, and the KVM cases as files of their own.**
*Choice:* `compose.yaml` has 8.3's two services, from the image it builds, `scooter:local`, each with `restart: unless-stopped`, `no-new-privileges`, `stop_grace_period: 30s`, log rotation of 10 MB × 3 in Docker's `json-file` driver, `DATA_DIR=/data` and `CONFIG_DIR=/config`, its own env file, and no port. The bridge has `hostname: scooter`; the runner `user: scooter-runner`, `read_only: true` with a `tmpfs` at `/tmp`, and `./config` read-only. Alone, it runs pi's VMs under emulation, the third case. The other two are added by naming them in `COMPOSE_FILE` in a `.env` file beside it, which every `docker compose` command there reads: `compose.kvm.yaml`, for rootful Docker, gives the runner `/dev/kvm` and the host's kvm group by its id, `KVM_GID` in `.env`, and stops with a message saying so when that isn't set; `compose.kvm-rootless.yaml`, for rootless Docker, gives it `/dev/kvm`, and holds D217's udev rule. The project is named `scooter`, so the volume is `scooter_data`.
*Reason:* the plan asks for the three cases as documented variants. Files of their own let the owner choose one without editing a file git tracks, which an upgrade's `git pull` would otherwise meet as a conflict, and a test reads each. git ignores `.env`, as it does the env files.
*Not changed:* how Docker restarts the runner ([Restarts](architecture/runner.md#restarts)).

**D223. Backups and restore in Docker** (the plan's rule for this milestone).
*Choice, and what was found:*
- The bridge tells a runner at work from one that is gone by connecting to `runner/runner.sock` ([The locks](architecture/exchange.md#the-locks)). In the one volume (D219), from the bridge's container to the runner's, the socket answers, and `restore`, in a container of its own, found the bridge's (13.5).
- `restore` runs as natively, in a container of the bridge's: `docker compose stop`, then `docker compose run --rm bridge restore [snapshot] [--force]`. It refuses while either service runs, by their sockets, and writes `runner/log/` with the rest, each file to its owner by name ([Restore](architecture/backups.md#restore)), which the image's users make the same uids in every container.
- The bridge's `hostname: scooter` holds in the containers `docker compose run` makes of it too, so restic's locks and its snapshots name the host `scooter` in every one ([What a backup holds](architecture/backups.md#what-a-backup-holds)).
- `docker compose kill -s SIGUSR1 bridge` reaches the bridge through tini, and starts a backup ([When backups run](architecture/backups.md#when-backups-run)).
*Reason:* the plan's rules. One volume makes Docker's restore the native one.

**D224. `doctor` boots a VM, and runs as the runner's user** (the review of milestone 12, smaller points 2 and 7).
*Choice:*
- After the image's check, when QEMU and the image are there and the accelerator can be used, `doctor` boots one VM from the image, and reports how long the boot took; or that it didn't boot, with the fix: nested virtualization for a machine that is itself a VM, or `AGENT_ACCEL=emulation`, or building the image again. The runner's own code does it ([The boot check](architecture/sandbox.md#the-boot-check)), which `src/cli.mjs` hands to `doctor`.
- Where `scooter-runner` is a user of the machine, `doctor` refuses to run as another, with exit code 2, and says how to run it: `sudo -u scooter-runner scooter doctor`, or in Docker `docker compose run --rm runner doctor`, which runs as that user. Without that user, as in development, it runs as whoever runs it.
- Its fixes in Docker name the KVM files (D222), `docker compose run --rm build-image` (D220), and the command that sets a folder's owner and mode in a container of the bridge's.
*Reason:* the review's ways. Opening `/dev/kvm`, which is what 8.4 asks, said "KVM" in the root VM of G2, where no VM booted, which opening it doesn't cover ([Acceleration](architecture/sandbox.md#acceleration)); and as root, `doctor` reported a fault that wasn't one, and every check saw what root sees.
*Cost:* `doctor` takes a VM's boot longer: 1 to 2 seconds with KVM, 4 to 5 under emulation (13.5).

**D225. With services, `setup` makes the kvm group when there is none** (the review of milestone 12, smaller point 1).
*Choice:* `setup`, when it installs the services, makes a system group `kvm` on a machine that has none, then puts `scooter-runner` in it. Without services it makes none, and says pi's VMs will run under emulation, as before (D212).
*Reason:* the runner's unit names the group (`SupplementaryGroups=kvm`), and systemd refuses to start a unit whose group isn't there (216/GROUP, the review's probe). With the group and no `/dev/kvm`, the runner starts, and falls back to emulation, which `doctor` explains.

**D228. arm64 isn't verified** (the plan's rule for this milestone).
*Choice:* the image builds for the machine's architecture by `TARGETARCH`: QEMU's package, restic's file and checksum, and wacli from source; an architecture other than amd64 or arm64 stops the build, saying so. `machineArch`, `qemuProgram` and `machineType` choose by Node's `process.arch`, and the VM image's build file names no architecture ([The VM image](architecture/sandbox.md#the-vm-image)).
*Not verified:* nothing has built or run the image on arm64. The Linux machine has no arm64 emulation for Docker or for QEMU (section 3 of the plan), nor has the root VM. Whether the arm64 image holds everything Gondolin's `virt` machine needs, without the packages' recommendations, is unknown until then. restic's arm64 checksum is the release's (0.2), and wacli's source builds for both (13.1).

### 13.2 Facts found

- **Gondolin's native build in the runner's container**, as root: under the read-only root file system it can't make its cache, `ENOENT: … mkdir '/root/.cache/gondolin/sandbox-helpers'`, and `mount -t proc` there is refused, `permission denied`. As root in a privileged container, under rootless and rootful Docker, it builds (D220).
- **Rootless Docker's uids:** container uid 10002 is host uid 175537 on the Linux machine, the range of `/etc/subuid` starting at 165536; `/dev/kvm` in a container is the host's device, shown as `65534:65534`, and opens by the host's permissions for that uid (D217).
- **A new named volume** mounted at `/data` starts as a copy of the image's `/data`, owners and modes kept, under rootless Docker too (D219).
- **`docker compose run`** gives a one-off container of the bridge its `hostname`, `scooter`.
- **Ubuntu 24.04 in the root VM** restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns = 1`): rootless Docker needs an AppArmor profile for `rootlesskit`, which Docker's documentation gives. The build containers of rootless Docker there timed out asking 10.0.2.3, the root VM's resolver on QEMU's user-mode network, for names; `"dns"` in the Docker user's `daemon.json` set others. Neither is Scooter's, but an owner of rootless Docker on Ubuntu 24.04 meets the first.

### 13.3 The reviews of the pull requests merged before this one

Pull request 13, milestone 12, was approved by its review with seven smaller points. All seven are settled:

| # | Point | What became of it |
|---|---|---|
| 1 | Without a kvm group, the runner's unit can't start, though `setup` says its VMs will run under emulation | Settled (D225), the review's first way: with services, `setup` makes the group. Test in `setup`, with a machine without one |
| 2 | `sudo scooter doctor`, as root, reports a failure that isn't one | Settled (D224), the review's first way: where `scooter-runner` is there, `doctor` runs as it alone, and says how. Test in `doctor`; and in the runner's container as root, exit code 2 (13.5) |
| 6 | Stale words | Settled: the comment in `main.mjs`, `RUNNER_CHECKS` in `doctor.mjs`, and section 14 of DESIGN.md, which now says G2 built the image natively |
| 7 | For milestone 13: `doctor` says KVM where no VM boots; catch-up fails while wacli is unpaired | Settled: `doctor` boots a VM (D224), and `q35` boots under nested KVM ([The machine](architecture/sandbox.md#the-machine)); catch-up waits for the pairing's first check ([Catch-up](architecture/whatsapp.md#catch-up)). Tests in `doctor`, `sandbox` and `whatsapp`; the last fails on `main` |

The points earlier reviews and milestones left:

| From | Point | What became of it |
|---|---|---|
| Milestone 6, second review | The outbox's owner in rootless Docker | Settled (D217): the runner runs as `scooter-runner` there too |
| Milestone 10, what wasn't verified | Backups in Docker: the socket across containers, and `restore` | Run (D223; 13.5) |

### 13.4 Changes to DESIGN.md

None changes what Scooter does beyond what 8.3 left open and the review asked:
- 8.3: the image (D221); one volume, the runner's user, `build-image`'s container, and the KVM files, with the udev rule for scooter-runner's uid under rootless Docker (D217, D219, D220, D222); `restore` in Docker (D223).
- 8.4: `build-image` in Docker; `doctor` boots a VM and runs as the runner's user (D224).
- 8.5: `setup` makes the kvm group when it installs the services (D225).
- 13.4: rootful Docker with `devices` and `group_add` was tried at G3.
- Section 10: Least privilege and Config, as this milestone tests them; the Docker files' test. The required tests of delivery, as this milestone tests them.
- Section 14: KVM in a container, building the image in Docker and natively, the read-only root file system and `docker compose build` were checked; arm64 wasn't (D228).

ARCHITECTURE.md 6 says the same of Docker. The plan's milestone 14 has what this milestone leaves for the README, and the runner's restarts in Docker among what isn't done ([Restarts](architecture/runner.md#restarts)).

### 13.5 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, restic 0.19.1, Docker 29.7.1 rootless with Compose 5.3.1. `462daa1` holds all the code and tests; the commits after it change the documents only.

| Command | Result |
|---|---|
| `npm ci && npm test`, on a clean clone of the branch from GitHub at `462daa1` | 758 tests: 710 pass, none fail. 48 skip themselves: 36 need the image, 8 need root, and 4 need root and `SCOOTER_ROOT_TESTS=1`. `docker compose config` reads each combination of the Compose files |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 760 tests: 748 pass, none fail, in 116 seconds. The 12 that need root skip themselves. Boots with KVM on `q35`: 1.4 to 1.9 seconds under the suite's load. No QEMU left |
| The root-test command of section 3 of the plan, on a second clean clone at `462daa1`, with `~/.local/bin/restic` mounted at `/usr/local/bin/restic` | Node 24.22.3: 758 tests, 696 pass, none fail. 62 skip themselves: 36 need the image, 14 are about what root can read or write anyway, 4 need wacli, 4 `mke2fs`, 2 run `scooter bridge` as a process, 1 `systemd-analyze`, and 1 Docker. `setup`'s root test runs, and passes |
| The new tests against the code of `main` | The three of `delivery` fail against `main`'s `outbox.mjs`, and that of `whatsapp` against its `whatsapp.mjs`. Those of `doctor`, `setup` and the sandbox need functions `main` hasn't |

**The checks of the plan on the Linux machine**, with rootless Docker, from the working tree at `462daa1`, with dummy env files (an owner's number, and a well-formed key OpenRouter doesn't know):

| Check | What was run | What happened |
|---|---|---|
| `docker compose build` succeeds | `docker compose build` | 28 seconds the first time, wacli's stage 12; 775 MB. restic's checksum `OK`. QEMU 10.0.13 |
| The VM image | `docker compose run --rm build-image` | 14 seconds, 527 MB, pi 1.5.2, into `/data/runner/image`. As root in the runner's container: refused (13.2); as `scooter-runner`: exit code 2, saying to use `build-image`'s container |
| Both services start | `docker compose up -d` | Both up. The runner opened the sandbox under emulation (`kvm: ENOENT`), wrote `status.json`, and sent the emulation notice, which the bridge took from the outbox, `scooter-runner`'s, and held for the pairing. The bridge waited for `pair`, with no `whatsapp.catchup_failed` ([Catch-up](architecture/whatsapp.md#catch-up)) |
| `doctor` reports emulation, and why | `docker compose run --rm runner doctor` | Exit code 0: `warn accelerator: emulation, since KVM can't be used`, with the fix naming `compose.kvm.yaml` and `compose.kvm-rootless.yaml`; `VM boot: a VM booted in 4.3 seconds, with emulation`; the folders, the env files (none, the settings in the environment), OpenRouter and its 6 endpoints that keep no data. With `--user root`: exit code 2, saying to run it as `scooter-runner` |
| wacli and the email reader run as their users | `docker compose run -d --rm bridge pair`, then `docker top`; the bridge as a one-off with email on, towards an address that never answers, then `docker top` | `wacli auth` ran as uid 10001, and showed a QR code, which nobody scanned; the reader, `node --disable-sigusr1 /app/src/mail/reader.mjs run`, as uid 10003 |
| …and can't read the other folders | Node, as `scooter-wacli` and as `scooter-mail` in the bridge's container, reading `datastore`, `agents`, `agents/lifelog/state.json`, `exchange`, `exchange/outbox`, `runner`, `runner/status.json`, `bridge`, `bridge/state.json`, and the other's folder | `EACCES` for every one; each reads its own. As `scooter-runner`: the datastore read, `bridge/`, its state, `wacli/` and `mail/` refused |
| The runner with its read-only root file system | A message stored with the bridge's store, then the runner's log | The runner ran pi in a VM, booted in 4.4 seconds under emulation; pi's request reached `openrouter.ai/api/v1/messages`, which answered 401; the run was a setup error, runs paused, no attempt counted, and the notice went to the outbox. The network log had its three lines. `/app` and `/etc` refused a write; `/tmp` took one |
| pi reaches OpenRouter, and `https://example.com` is refused | `docker compose run --rm -v ./test:/app/test:ro -v ./config:/app/config:ro -e SCOOTER_TEST_IMAGE=/data/runner/image --entrypoint node runner /app/test/live/openrouter.mjs` | `all as it should be`, exit code 0: on both routes OpenRouter answered 401, the runner took it as a setup error and counted no attempt, and `curl https://example.com/` in a VM was refused by the policy |
| The mounts with the data under `/data` ([Mounts](architecture/sandbox.md#mounts)) | With the runner stopped, `docker compose run --rm -v ./test:/app/test:ro --entrypoint node runner /app/test/live/data-mounts.mjs` | Every line ok: in the VM `/data` held `agents` and `datastore` alone, and wasn't a mount; `runner`, `exchange`, `bridge`, `wacli`, `mail` and `/config` weren't there; `sessions/` wasn't there and couldn't be made; the datastore and the agent's folder were read-only; `run/session/` took a write |
| Backups in Docker (D223) | A local restic repository mounted into the bridge's container by a Compose file of the check's own; `backup-init`; `docker compose kill -s SIGUSR1 bridge`; `snapshots`; `restore` with the services up, then stopped, without and with `--force` | The signal reached the bridge through tini: it stopped WhatsApp, backed up (`backup` and `forget`, exit codes 0), started it again, snapshot `5950bedf`, made by `root@scooter`. `restore` refused while the bridge ran, naming its socket, and a folder that wasn't empty, both with 2; `--force` restored the snapshot, `runner/log/` with it, its file `scooter-runner`'s, and removed a file made since. From the bridge's container, `runner/runner.sock` answered while the runner ran |

**Gate G3**, in a throwaway Ubuntu 24.04 VM on the Linux machine: the official cloud image, checked against its `SHA256SUMS`, on a fresh 40 GB disk, with KVM, `-cpu host` (an Intel Core Ultra 7 155H, nested virtualization on), 4 processors and 8 GB, user-mode networking, SSH on `127.0.0.1` only; SSH answered 10 seconds after the start. Docker 29.10.0 and Compose 5.8.0 from Docker's own repository, with its rootless extras. The code was cloned from the pull request's branch at `462daa1`, and built there.

| Case | What was run | What happened |
|---|---|---|
| Rootful Docker: `devices`, `user` and `group_add` | `.env` with `COMPOSE_FILE=compose.yaml:compose.kvm.yaml` and `KVM_GID=993`; `sudo docker compose build` (39 seconds); `sudo docker compose run --rm build-image` (16 seconds); `up -d`; `doctor`; a message stored | The runner, uid 10002 with the group 993, opened the sandbox with KVM. `doctor`: every check ok, `KVM`, `a VM booted in 2.1 seconds, with KVM`, exit code 0. The run: its VM up in 2.35 seconds with KVM, pi's request answered 401, a setup error. QEMU ran as uid 10002. Killing a runner's container while its VM booted left no QEMU |
| Rootless Docker, with the udev rule | A user of its own with rootless Docker, `COMPOSE_FILE=compose.yaml:compose.kvm-rootless.yaml`, `AGENT_ACCEL=kvm`; `docker compose build` (31 seconds); the uid by the command of `compose.kvm-rootless.yaml`, 175537; the rule, `udevadm trigger`; `build-image` (17 seconds); `up -d`; `doctor`; a message stored | `getfacl /dev/kvm` listed `user:175537:rw-`. The runner, `scooter-runner` with no other group, opened the sandbox with KVM. `doctor`: every check ok, `a VM booted in 2.0 seconds, with KVM`, exit code 0. The run: its VM up in 2.46 seconds with KVM, 401, a setup error; the outbox was `scooter-runner`'s, and the bridge took the notice. The ACL stayed through every VM. With it removed, `doctor` failed the forced KVM, with the fix of D224, and `udevadm trigger` put it back. Killing a runner's container while its VM booted left no QEMU |

The 3-second mark isn't a pass mark there (section 6 of the plan): nested, the boots took 2.0 to 2.5 seconds, under 3 anyway. Under emulation in the root VM, `doctor`'s boot took 4.3 seconds. The VM was then shut down and its disk deleted; no QEMU of `agentw` was left.

The tests the plan asks of this milestone, and where they are:

| Required | Where |
|---|---|
| The checks of the milestone, on the Linux machine | By hand, above; the Docker files themselves in `docker.test.mjs`, which reads them against `setup.mjs`, 8.3 and 0.2, and has `docker compose config` read each combination |
| The mounts with the data under `/data` ([Mounts](architecture/sandbox.md#mounts)) | `test/live/data-mounts.mjs`, run in the runner's container |
| Gate G3 | Above |

Beyond those: the review's points, in `delivery`, `doctor`, `setup` and `whatsapp`; the boot check and `q35`, in `sandbox`; `build-image` in the runner's container, in `image`.

Not verified:
- **arm64** (D228), and Docker Desktop, OrbStack and Colima, deferred with macOS.
- **The moment `uaccess` leaves** on a desktop (D217): a VM starting while another VM's event resets the ACLs. The Linux machine has a seat session, but no root to install the rule; the root VM has none.
- **A real WhatsApp pairing and a real bucket** in the containers (gate G4): `pair` showed a QR code that nobody scanned; the backup went to a repository in a folder.
- **The install on the machine Scooter will live on**, which stays with the owner (section 6 of the plan).

## Milestone 14: docs and final check

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Three choices the plan's rules for this milestone listed as the owner's were put to the owner after milestone 13 was merged, and answered before this milestone started; each answer is beside the rule it settled: [Catch-up](architecture/whatsapp.md#catch-up) and [Restarts](architecture/runner.md#restarts), two gaps closed here, and [Failures](architecture/run.md#failures), where a request the agent sends itself stays as it is. Everything else was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. [The owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) are unchanged. DESIGN.md changed in 5.1, 5.2 and 5.4, now [the WhatsApp channel](architecture/whatsapp.md) and [/status](architecture/bridge.md#status), in what [the runner](architecture/runner.md) now holds, and in 8.3, 8.4, 8.5, 8.6 and sections 10 and 14 (14.4). The milestone settled the five smaller points of the review of milestone 13, and the points earlier reviews had left (14.3), and made the final check of the plan (14.5).

What the milestone left in the repository:

| Path | What |
|---|---|
| `README.md` | Installing and running Scooter, natively and in Docker, and "Check on the first real run" (D230) |
| `bridge.env.example`, `runner.env.example` | Final: an example number, the app password, the key's guardrail as [Zero data retention](architecture/network-policy.md#zero-data-retention) gives it |
| `src/runner/restarts.mjs`, `main.mjs`, `status.mjs`; `src/common/runnerstatus.mjs`; `src/bridge/status.mjs`; `src/cli.mjs`; `deploy/systemd/scooter-runner.service` | The runner's own waits between starts, where its service manager doesn't wait, and `/status` saying so ([Restarts](architecture/runner.md#restarts)) |
| `src/runner/sandbox/gondolin.mjs`, `src/ops/doctor.mjs` | `doctor` closes its VM when it is stopped, and boots in `/tmp` when `TMPDIR` is too long a path (D231) |
| `Dockerfile` | The app readable by every user, whatever the checkout's modes (D232) |
| `src/bridge/outbox.mjs`, `src/common/limits.mjs`, `src/cli.mjs`, `test/live/data-mounts.mjs` | The review's three small things, and a stale line of `scooter help` (D233) |
| `test/whatsapp.test.mjs`, `intake`, `status`, `runner`, `runnerfiles`, `units`, `doctor`, `sandbox`, `delivery`, `docker`, `limits`, `paths` | The cases of catch-up ([Catch-up](architecture/whatsapp.md#catch-up)), of the runner's waits ([Restarts](architecture/runner.md#restarts)), and the review's points |

### 14.2 Decisions

**D230. The README.**
*Choice:* `README.md` covers what the design's development plan listed for it and the plan's rules for this milestone give it, for Linux, in the order an owner meets them: how the parts fit; what is needed; the native install, from the prerequisites, with restic's and wacli's checksums (0.2; 13.1), to `doctor`; the Docker install; KVM in each case, with the udev rule for rootless Docker and the command that finds the uid; the bot number, the mailbox and its app password, the OpenRouter key and its guardrail, and the bucket; the env files; daily use, the commands, and copying the views out; the agent's instructions, adding a skill, and what an upgrade does to them; backups and restore; rebuilds and backfills; what to do when something goes wrong, `doctor`, its warning about emulation, and the runner's restarts; the security model, with what internet access means; the network log; the known limits; upgrading; development; and "Check on the first real run", gate G4's items as checkboxes.
*Reason:* the plan. Each rule of the plan's milestone 14 for the README is in it; 14.5 ticks them off. Where it gives a command no milestone ran, it was run here: `docker compose cp` out of the data volume (with `docker cp`, which it wraps), `git reset` in the runner's container as `scooter-runner`, and `docker compose run -d`, whose container Docker doesn't restart (14.6).
*Not verified:* the native install's steps as a whole on a fresh machine: G1 and G2 ran them in milestone 12, from the plan rather than from this text.

**D231. `doctor`'s VM, when `doctor` is stopped, and a long `TMPDIR`** (the review of milestone 13, smaller points 2 and 3).
*Choice:*
- `doctor` takes `SIGTERM`, `SIGINT` and `SIGHUP` while it runs, and gives the boot check a signal, which closes the VM it started ([The boot check](architecture/sandbox.md#the-boot-check)); the checks after it are left, and `doctor` says what stopped it and exits with 1. The same signal ends its wait for OpenRouter's answer, up to `DOCTOR_TIMEOUT`, which its handlers had left to run out (the review of milestone 14, smaller point 6).
- Where the boot check makes its folder, and why: [The boot check](architecture/sandbox.md#the-boot-check).
*Reason:* the review's first way for each. A native `doctor` killed during the boot left a QEMU running; nothing else stops it ([Supervision](architecture/sandbox.md#supervision)).
*Tests:* in `doctor`, the signal given to the boot check, and no check after it, and a stop while OpenRouter hasn't answered; in `sandbox`, with the image, a boot check stopped during the boot leaves no QEMU and no folder, and one with a `TMPDIR` of over 100 characters boots.

**D232. The image's app is readable by every user, whatever the checkout's modes** (the review of milestone 13, smaller point 4).
*Choice:* after the copies, `RUN chmod -R a+rX,go-w /app`: readable by every user, folders passable, and writable by root alone.
*Reason:* the review's way, without `COPY --chmod`, whose symbolic modes need a newer Dockerfile syntax than an octal one, which would make every file executable. `go-w` also covers a checkout made under umask 000, whose files every user could otherwise change in the image. *Cost:* one layer holding `/app` again, about 20 MB. *Test* in `docker`.

**D233. A note on tini, and a stale line** (the review of milestone 13, smaller point 5).
*Choice:*
- `test/live/data-mounts.mjs` says that a check in the runner's container that kills a QEMU needs tini first, `--entrypoint tini` with `node …` as the command, and the README's development section says so. `docker run --entrypoint tini scooter:local -- node …` was run: Node's parent was tini, pid 1.
- `scooter help` said `build-image` runs "in Docker, the runner container", which D220 changed: it now names its own container.

**D234. 8.6 lists every constant of `limits.mjs`.**
*Question:* found in the final check (14.5). `limits.mjs` had eight constants that 8.6 didn't list, each recorded here with its milestone: `WEBHOOK_PORT`, `WACLI_CALL_TIMEOUT`, `MEDIA_DOWNLOAD_RETRY_WAIT`, `ATTACHMENT_EXT_MAX_CHARS`, `MEMORY_MAX_BYTES`, `GIT_CALL_TIMEOUT`, `CONFIG_RANGES` and `SETTING_RANGES`.
*Choice:* 8.6 lists them, with their values and what they do, and the two of this milestone, `RUNNER_RESTART_WAITS` and `LOGGED_NAME_MAX_CHARS`.
*Reason:* 8.6 says every fixed number lives in `limits.mjs`, and the table is where the owner looks for them. Nothing changes in the code.

### 14.3 The reviews of the pull requests merged before this one

Pull request 14, milestone 13, was approved by its review with five smaller points. All five are settled:

| # | Point | What became of it |
|---|---|---|
| 2 | Natively, the VM `doctor` boots is left running if `doctor` is killed during the boot | Settled (D231), the review's first way: `doctor` closes it on `SIGTERM`, `SIGINT` and `SIGHUP`. Tests in `doctor`, and in `sandbox` with the image, which fails on `main` |
| 3 | With a long `TMPDIR`, `doctor`'s boot check fails and blames the wrong thing | Settled (D231), the review's first way: `/tmp` when `TMPDIR` is too long a path. Test in `sandbox` |
| 4 | An image built from a checkout made under umask 077 can't be read by the runner or the email reader | Settled (D232), the review's second way: a `chmod` after the copies. Test in `docker` |
| 5 | Three small things: a number not in `limits.mjs`; `outbox.runner_outbox_taken` logged while the outbox isn't there; the live checks run with `--entrypoint node` | Settled (D233): `LOGGED_NAME_MAX_CHARS`; logged only once it is taken from, test in `delivery`, which fails on `main`; a note in the live check and the README |

### 14.4 Changes to DESIGN.md

None changes [the owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices), or what Scooter does beyond what the owner's answers and the review asked:
- 8.3: the runner's restarts in Docker ([Restarts](architecture/runner.md#restarts)); the app's modes in the image (D232).
- 8.4: `doctor` closes the VM it booted when it is stopped (D231).
- 8.5: the runner's unit tells the runner that systemd keeps the waits ([Restarts](architecture/runner.md#restarts)).
- 8.6: `RUNNER_RESTART_WAITS` and `LOGGED_NAME_MAX_CHARS`, and the eight constants of `limits.mjs` the table didn't list (D234).
- Section 10: the required tests of intake: catch-up, as this milestone tests it.
- After the review (14.7): the README's first real run, how wacli stores and lists the owner's chat after downtime.

### 14.5 The final check: DESIGN.md, section by section

The plan's final check, step 1: DESIGN.md read again, section by section, each requirement against what was built, with the milestone or decision that built it. What isn't done is listed after the table.

| DESIGN.md | What was built, and where |
|---|---|
| 6.1 | Milestones 3 and 11 |
| 8.2 Environment | Every variable is one `settings.mjs` knows, on its side, and each example explains it (a test); `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY` too, which [backups' settings](architecture/backups.md#settings) name in a row |
| 8.3 Docker | Milestone 13; the other architecture not built (below) |
| 8.4 CLI | Every command, as `scooter help` lists them; `build-image`'s line corrected (D233) |
| 8.5 Running natively | Milestone 12; the unit's restarts (D207, [Restarts](architecture/runner.md#restarts)) |
| 8.6 Constants | Every number in `limits.mjs`, which a test holds to its values, and now every one of them in the table (D234) |
| 10. Testing | Each required test, as each milestone's "what was run" lists it; this milestone's are in 14.6 |
| 14. Not verified yet | In the README as "Check on the first real run", gate G4's items |

Not done, or not verified:
- **Gate G4**, the first real run, with the owner's phone, accounts and keys: every item of section 14 not marked checked, in the README's "Check on the first real run". The install on the machine Scooter will live on stays with the owner too.
- **arm64**, and building the image for the other architecture with `docker buildx`, which the design's development plan asked for where Docker can: the plan's machine has no arm64 emulation (D228). macOS, Docker Desktop, OrbStack and Colima are deferred ([Deferred and out of scope](ARCHITECTURE.md#deferred-and-out-of-scope)).
- **The moment `uaccess` leaves** on a desktop with rootless Docker's udev rule (D217): unverified, and in the README.
- **The README's native install as a whole**, as text, on a fresh machine: its steps were run at G1 and G2 in milestone 12.

### 14.6 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, restic 0.19.1, Docker 29.7.1 rootless with Compose 5.3.1. `25766da` holds all the code and tests, `c753450` the documents; the commit after it records this section and nothing else.

| Command | Result |
|---|---|
| `npm ci && npm test`, on a clean clone of the branch from GitHub at `c753450` | 774 tests: 725 pass, none fail. 49 skip themselves: 37 need the image, 8 need root, and 4 need root and `SCOOTER_ROOT_TESTS=1` |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'`, on the same clone | 776 tests: 764 pass, none fail, in 117 seconds. The 12 that need root skip themselves. Boots with KVM: 2.1 to 2.2 seconds, and 1.6 for `doctor`'s boot check. No QEMU left |
| The root-test command of section 3 of the plan, on a second clean clone at `c753450`, with `~/.local/bin/restic` mounted at `/usr/local/bin/restic` | Node 24.22.3: 774 tests, 711 pass, none fail. 63 skip themselves: 37 need the image, 14 are about what root can read or write anyway, 4 need wacli, 4 `mke2fs`, 2 run `scooter bridge` as a process, 1 `systemd-analyze`, and 1 Docker. This milestone's tests all run there, and pass |

Also by hand in Docker: `docker run --entrypoint tini scooter:local -- node …` gives Node tini as its parent (D233); `docker cp` copies a folder out of a named volume, from a container stopped; `docker compose run -d` makes a container with no restart policy; and `git reset --hard <tag>`, run as `scooter-runner` in a runner's container with `--entrypoint git`, resets the agent's repository in the volume (D230).

The tests the plan asks of this milestone, and where they are:

| Required | Where |
|---|---|
| The final check | 14.5, and the runs above |

Beyond those: the review's points in `doctor`, `sandbox`, `docker` and `delivery`; the constants in `limits`, the path in `paths`.

Not verified:
- **Gate G4**, with the owner's phone, accounts and keys, and the install on the machine Scooter will live on (14.5).
- **arm64** (D228), and macOS, deferred.
- **The README's native install as a whole**, on a fresh machine: its steps ran at G1 and G2 (12.5). No root VM was started for this milestone: none of its work is a gate of G1 to G3.

### 14.7 The review of this milestone

The review of the pull request, at `c7d3722`, found the milestone's checks and runs as described, asked for one change, and noted eight smaller points. Each is below, with what became of it.

| # | Point | What became of it |
|---|---|---|
| Must 1 | The README's native upgrade fails as written, and leaves the pinned pi stale: `build-image` ran while the runner was up, which it refuses, and before the merge of `config/`, so natively it built from the owner's old `image/build.json` | Fixed in the README, the review's way. The native block stops the runner first; shows what the upgrade changed in `config/` (`git diff ORIG_HEAD HEAD -- config/`); says to merge it into `/etc/scooter/config` before `build-image`, `image/build.json` above all, which the runner and `build-image` read there, and that copying it is the merge for an owner who never changed it; then `setup`, `build-image`, and both services. The paragraph on upgrades in "The agent's instructions" says the pin is in the owner's copy natively. Of the two times to build, after each upgrade or when `build.json` changed, the README now says after each upgrade, natively and in Docker, as DESIGN.md 8.3 and the Docker install already did: the image holds Gondolin's own programs for the VM too (`sandboxd`, `sandboxfs`), which an upgrade of Gondolin changes while `build.json` stays as it was |
| 5 | `setfacl` needs the `acl` package, which the README didn't say | Said beside the udev rule, as `compose.kvm-rootless.yaml` says it |
| 6 | `doctor` ignores Ctrl-C after the boot check, and waits up to `DOCTOR_TIMEOUT` for OpenRouter | Fixed (D231): the signal that closes the boot check's VM also ends the wait for OpenRouter's answer, and no check of OpenRouter is made then. Test in `doctor`, which hangs on `c7d3722` |
| 7 | D234 says nine constants and names eight | Eight, by a script over `main`'s `limits.mjs` and 8.6: corrected in D234, 14.4 and the pull request's description |

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, restic 0.19.1, Docker 29.7.1 rootless. `bab810c` holds all the changes; the commit after it changes only this section.

| Command | Result |
|---|---|
| `npm ci && npm test`, on a clean clone of the branch from GitHub at `bab810c` | 775 tests: 726 pass, none fail. 49 skip themselves, as in 14.6 |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'`, on the same clone | 777 tests: 765 pass, none fail, in 114 seconds. The 12 that need root skip themselves. No QEMU left |
| The two new tests against `c7d3722`'s `main.mjs` and `doctor.mjs` | The test in `restarts` fails on `restart` still in `status.json`; the test in `doctor` waits on OpenRouter's answer, and the file's tests after it are cancelled |
| `git diff ORIG_HEAD HEAD -- config/` in a scratch repository, after a `git pull` that brought a change to `config/`, then after one that brought nothing | The change, then nothing: a pull with nothing new leaves no older diff behind |

Not verified:
- **The README's native upgrade**, as a whole, and `sudo RESTORE_TARGET=… scooter restore`: no root on the machine, and no root VM was started for this, as none of it is a gate of G1 to G3. That `sudo` takes a variable after it, and drops one before, is how `sudoers` treats the environment, with Ubuntu's default rule, which allows any command.
- **The root tests** weren't run again: no change here touches what only root does.
