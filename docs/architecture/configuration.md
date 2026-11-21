# Configuration and the CLI

How the owner configures Scooter, and how each of its CLI commands starts. The configuration is of three kinds, each with its own readers and one writer:

| What | Where | Read by | Changed by |
|---|---|---|---|
| The agents, their prompt and skills, and the VM image's build file | the config folder, `CONFIG_DIR` | the runner's side only: the runner, `doctor`, `rebuild` and `build-image` | the owner |
| Settings and secrets | `bridge.env` and `runner.env` | each service its own ([Secrets](../ARCHITECTURE.md#secrets)) | the owner |
| Tuning constants | `src/common/limits.mjs` | the code | a change to the code |

This document covers the format of each and how it is checked. What a setting or a field does is in the document of the component that uses it, and where an install keeps the files, with their owners and modes, is in [install](install.md).

## Files

- `src/cli.mjs`: the one entry point, `scooter <command>`: each CLI command, its side, and its exit codes.
- `src/common/settings.mjs`: the env files, read and checked for one side: `loadSettings`, `parseEnvFile` and `loadFolders`.
- `src/common/limits.mjs`: the tuning constants, and `overrideLimits`, for the tests.
- `src/runner/config.mjs`: `agents.yaml`, read and checked, with each skill's `SKILL.md`: `loadConfig`, `parseConfig` and `skillFileProblem`.
- `config/agents.yaml`: the default `agents.yaml`, which `setup` copies and Docker mounts.
- `bridge.env.example`: every variable of the bridge, explained, from which `setup` writes `bridge.env`.
- `runner.env.example`: every variable of the runner, explained, from which `setup` writes `runner.env`.

## The CLI

`src/cli.mjs` is the one entry point. Each CLI command belongs to one side and loads only that side: its settings, from its own env file, and its code, which is imported only when the CLI command runs. So the bridge's CLI commands never hold the runner's key, and the runner's never hold the bridge's secrets: the other side's env file is never opened. The two that root runs on the machine itself load neither side's settings here, and read only what they need.

| CLI command | Side | Described in |
|---|---|---|
| `bridge` | bridge | [Starting up](bridge.md#starting-up) |
| `runner` | runner | [Starting up](runner.md#starting-up) |
| `setup [--no-services]` | the host, as root | [setup](install.md#setup) |
| `doctor` | runner | [doctor](install.md#doctor) |
| `build-image` | the host, as root; in Docker, a container of its own | [build-image](sandbox.md#build-image), [The build-image container](install.md#the-build-image-container) |
| `pair [--phone +91…]` | bridge | [Pairing](whatsapp.md#pairing) |
| `email-check` | bridge | [email-check](email.md#email-check) |
| `backup-init`, `snapshots`, `check`, `restore [snapshot] [--force]` | bridge; `restore` with both services stopped | [The CLI commands](backups.md#the-cli-commands), [Restore](backups.md#restore) |
| `rebuild <agent>` | runner, with its service stopped | [Rebuild](rebuild-and-backfill.md#rebuild) |

- **Who runs one.** Natively, a CLI command runs as its side's service user, the bridge's as root and the runner's as `scooter-runner`, and `setup` and `build-image` run as root. In Docker it runs in a one-off container of its service, `docker compose run --rm <service> <command>`, which is that user too, and `build-image` in a container of its own. The README shows how, for each ([Install natively](../../README.md#install-natively), [Install with Docker](../../README.md#install-with-docker)).
- **Exit codes:** 0 when the CLI command did its work; 1 when it failed; 2 when it couldn't start because of how it was called or how Scooter is configured. A fault in the side's settings is a 2, printed before the CLI command's code is loaded ([The env files](#the-env-files)); so are no CLI command and an unknown one, each with the list of CLI commands on stderr. What else is a 2 is in each one's document.
- **`scooter help`**, or `--help` or `-h`, prints every CLI command, with its arguments, what it does and where it runs, and exits with 0. The image runs it when it is given no CLI command ([The image](install.md#the-image)).

## The env files

Each service reads its own env file, as [Secrets](../ARCHITECTURE.md#secrets) says, and looks for it in `/etc/scooter`, or in the folder that `SCOOTER_ENV_DIR` names, which is read from the environment alone. Where each install keeps them is in [setup](install.md#setup) and [compose.yaml](install.md#composeyaml).

- **A variable in the environment wins over the file.** A file that isn't there is no fault, and the environment alone is then enough, as in Docker, where Compose hands each service its file's values as its environment.
- **An empty value means the variable isn't set:** empty, or only spaces, takes the default, and for a required variable is the same as leaving it out. A variable set but empty in the environment still wins over the file. *Why:* Compose passes `KEY=` on as an empty variable, and the example files have such lines.
- **Loading** returns the checked values and never changes the environment, so a program a service starts gets only what it is handed ([Running programs](shared-code.md#running-programs)).
- **Every fault is reported at once,** each naming its variable, and the file and its line when the fault is in the file. No message repeats a value, because a value may be a secret.
- **A variable in a file that isn't one of its service's** is a fault that names it, and says which file it belongs in when it is the other service's. Unknown variables in the environment itself are ignored, as they have to be. *Why:* a misspelled name would otherwise be ignored without a word: `EMAIL_IMAP_HOTS` would leave email off. And the runner's key in `bridge.env` would sit where the bridge can read it. *Cost:* the env files hold Scooter's settings and nothing else. Under Compose there is no file to read, only the environment, so this check does nothing there.
- **The examples**, `bridge.env.example` and `runner.env.example`, explain every variable of their service, each default given as a comment, `# NAME=default`, and say that a value holding `$` goes in single quotes. `test/settings.test.mjs` holds them to the loader: every variable explained, in its format, with the loader's defaults.

**The format** is the part that Scooter's loader, systemd's `EnvironmentFile` and Compose's `env_file` all read the same way. Every other line is a fault that names the file, the line and the variable:

- a comment is a line of its own, starting with `#`, indented or not; blank lines are passed over;
- a setting is `NAME=value`: a name of letters, digits and `_`, not starting with a digit, with nothing before it and no space between it and the `=`;
- an unquoted value is trimmed, so a space after the `=` is no part of it, and it may not contain `$`, `\`, `#`, `'` or `"`;
- a quoted value is inside single quotes, on one line, and is taken exactly as written, so a value can't contain a single quote at all;
- a name may be set once.

*Why:* a line the three read differently would give the service one value under systemd and another under Compose ([Facts about systemd's and Compose's env files](#facts-about-systemds-and-composes-env-files)). The loader is stricter than it has to be in four places, where the three happen to agree: `#` without a space before it, a lone `'`, plain double quotes, and spaces around the `=`. One short rule, "anything unusual goes in single quotes", is easier to follow than the exact edge of each.

**The settings both services read:**

| Variable | Default | Meaning |
|---|---|---|
| `SCOOTER_TZ` | `Asia/Kolkata` | The owner's IANA time zone, written as the tz database writes it ([Time](shared-code.md#time)), used where [The owner's fixed choices](../ARCHITECTURE.md#the-owners-fixed-choices) say. Each service reads its own, so the owner keeps the two the same |
| `DATA_DIR`, `CONFIG_DIR` | `/data`, `/config` | The data folder and the config folder, the roots of every path ([Paths](shared-code.md#paths)), each an absolute path. Docker uses the defaults, a native install sets its own in both files ([setup](install.md#setup)), and development and the tests give their own |

The other settings are in the documents of the components that read them: [WhatsApp](whatsapp.md#settings), [email](email.md#settings), [delivery](delivery.md#settings), [backups](backups.md#settings), [the runner](runner.md#settings), [the network policy](network-policy.md#settings) and [the sandbox](sandbox.md#settings). Those of email and of backups say when each is on, and what it then needs.

**A numeric setting** must be a whole number within its range, which `SETTING_RANGES` gives; one outside it is a fault, and the message gives the range. Its default is in `settings.mjs`, with its check. *Why:* the low ends are what protects: a batch can't start on every poll, the mailbox isn't asked without a pause between looks, and at least one daily backup is kept. The high ends only catch slips of the hand. A range is a fixed number that protects behaviour, so it is a constant ([Constants](#constants)); a default is the setting's own value, so it stays with the setting's check.

## Constants

The tuning numbers are in `src/common/limits.mjs` ([The code's layers](../ARCHITECTURE.md#the-codes-layers)), each with a comment beside it that says what it protects. A number's value is there only, and a rule that depends on one names the constant.

- **Constants aren't settings.** A value becomes a setting only when the owner has a reason to change it, and then it gets a valid range and a test. *Why:* a bad value can't then, for example, make Scooter retry in a tight loop or flood WhatsApp.
- **How code reads them:** as `limits.NAME`, at the moment it needs one, never repeating the number. Durations are in milliseconds and sizes in bytes. The object is sealed, so a misspelled name fails rather than reading `undefined`.
- **How tests change them:** `overrideLimits` changes some and returns the function that puts them back, and refuses a name that isn't there. `test/limits.test.mjs` holds each constant to its value.
- **Not tuning numbers:** a limit of an outside program stays beside the code that relies on it, such as pi's on a skill's name and description ([agents.yaml](#agentsyaml)) and Gondolin's on a socket's path ([The runner's own folders](sandbox.md#the-runners-own-folders)), and so does a number that follows from what the system takes ([Files another program controls](shared-code.md#files-another-program-controls)).

## agents.yaml

`agents.yaml`, in the config folder, says which agent the runner runs, and when. The runner reads it at its start ([Starting up](runner.md#starting-up)), and `doctor` and `rebuild` read it as the runner does.

- **Every fault is reported at once,** each as `agents.yaml, line 14: agents.lifelog.run[1].at must be …`: the file, the line, and the field's path, with lists counted from 0.
- **Every field is required but `thinking`,** and a key the format doesn't have, at any level, is a fault that names it, as an unknown variable in an env file is. *Why:* the format has no defaults, and a default the owner didn't write is a setting they can't see. A misspelled `reply_mod` would otherwise leave the default in force without a word.
- **It is read as YAML 1.2, with the core schema,** so `on:` is a key and not `true`, and `21:30` unquoted is a time and not 1,290 minutes, as YAML 1.1 would have them ([Facts about yaml 2.9.1](#facts-about-yaml-291)). Duplicate keys, and the parser's warnings, such as a tag it doesn't know, are faults too.

**The default,** `config/agents.yaml`, is the format's example and the file the owner edits, with comments that say what each field takes: one agent, `lifelog`, with its six skills, quiet replies and a daily session, run on every batch of new messages and for an evening check-in at 21:30, with a `once` task and a backfill shown as comments. Its comment on the paths says "relative to this config folder", the folder's name being `/config` only in Docker. *Why the check-in is on:* it is the example the owner starts from. It is a message the bot sends on its own every evening, where the bot is otherwise quiet (principle 6 of [What Scooter does](../ARCHITECTURE.md#what-scooter-does)), so the README says how to remove it ([The agent's instructions](../../README.md#the-agents-instructions)).

**The fields:**

| Field | Takes | What it does |
|---|---|---|
| `agents` | a map of agents by name, which holds exactly one ([The owner's fixed choices](../ARCHITECTURE.md#the-owners-fixed-choices)); a name is lowercase letters, digits and hyphens, starting with a letter | Each agent's fields, which follow |
| `model` | an OpenRouter model ID, below | The agent's model, which must accept images ([How pi is run](agent.md#how-pi-is-run)) |
| `thinking` | optional: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` | The model's thinking level ([How pi is run](agent.md#how-pi-is-run)) |
| `prompt` | a file in the config folder, below | The agent's prompt ([The prompt](agent.md#the-prompt)) |
| `skills` | a list of skill folders in the config folder, below | The agent's skills ([Skills](agent.md#skills)) |
| `reads` | `whatsapp`, `email` or both, once each | The sources the agent works on ([State](runner.md#state)) |
| `session` | `daily` or `none` | [Sessions](runner.md#sessions) |
| `reply_mode` | `quiet` or `confirm` | The reply mode ([The protocol](agent.md#the-protocol), [Reading the answer](run.md#reading-the-answer)) |
| `ack_reaction` | one emoji, such as `"✅"`, or `""` for none, below | The reaction of quiet mode ([Reading the answer](run.md#reading-the-answer)) |
| `can_message` | `true` or `false` | Whether what the agent says is sent ([Reading the answer](run.md#reading-the-answer)) |
| `timeout_minutes` | a whole number of minutes, within `CONFIG_RANGES` | How long a run may take ([A run](run.md#a-run)) |
| `run` | a list of triggers, when the agent runs, which may be empty, below | [When the agent runs](runner.md#when-the-agent-runs) |

**`model`** matches `~?provider/name[:variant]`, in lowercase letters, digits, `.`, `_`, `-` and `:`, as all 403 models of pi's catalog do ([What pi sends](network-policy.md#what-pi-sends)). One that ends in `:online` is refused, with the reason. *Why:* the network policy refuses such a model ([Requests to OpenRouter](network-policy.md#requests-to-openrouter)), so every run would fail, and saying so at the start is cheaper.

**Paths.** `prompt` and each skill are relative to the config folder, cleaned, so `./`, `//` and a trailing `/` don't matter, and must name something inside the folder, other than the folder itself, after links are followed. A link out of it is a fault. The prompt is a file, and each skill a folder.

**Skills.**
- **A skill's name is its folder's name,** and two skills can't share one: a backfill names its skill that way, and the skill's copy for a run, in `run/config/`, is a folder of that name.
- **A skill's folder holds only files and folders,** and a `SKILL.md` that is a file. A link inside one is a fault at the start; what a run does with one that appears later is in [A run](run.md#a-run).
- **No skill lies inside another's folder, and the prompt in none:** either way round it is a fault that names the field. *Why:* each is copied into `run/config/` at its own path, so the copies would overlap, and every run would fail.
- **Its `SKILL.md`** must give the folder's name and a description. The check reads its frontmatter as pi does, a first line `---` and YAML up to the next line that starts `---`, a byte-order mark and Windows line breaks allowed, and refuses, naming the skill's field (`agents.lifelog.skills[1] names skills/runs, whose SKILL.md has no description, …`):
  - a `SKILL.md` that can't be read;
  - no frontmatter, or frontmatter that isn't YAML or isn't a map;
  - no `name`, or one other than the folder's. A name YAML reads as a number, such as `42` for a folder named `42`, is taken as written, as pi does;
  - a name pi doesn't take: at most 64 lowercase letters, digits and single hyphens between them;
  - no `description`, or an empty one, and one longer than 1,024 characters, past what the Agent Skills format allows, which pi warns of;
  - `disable-model-invocation: true`, which keeps pi from offering the skill to the model. `false` is accepted.

  Other keys, such as `license`, are left alone. *Why:* pi 1.5.2 reads the frontmatter as YAML and offers the model each skill by its name and description, with the path of its file. It leaves out a skill whose description is missing or empty, whose frontmatter isn't YAML, or that sets `disable-model-invocation: true`, and it takes the name from the frontmatter, only warning when it isn't the folder's or isn't of the format's form (`dist/core/skills.js` in pi's package). The runner, the prompt's list of views and a backfill name a skill by its folder. So without the check, an owner who adds a skill and forgets its description would have a runner that starts and an agent that never sees the skill, and nothing would say so; and a name other than the folder's would have pi offer the model `expense-tracking` where the prompt says `(skill: expenses)`. The two numbers are pi's, not tuning numbers, so they stay beside the check in `config.mjs`. *Cost:* a skill folder named as pi only warns about, such as `Receipts` or `receipts_old`, is refused.

**`ack_reaction`** is one grapheme that holds a pictograph, such as `✅`, `👍🏽` or `❤️`, a flag's two regional indicators, or a keycap, such as `1️⃣`, with no space or control character in it; or `""`. So `k` is refused. *Why:* a WhatsApp reaction is one emoji, and a word would fail on every quiet run.

**`timeout_minutes`** gets its range from `CONFIG_RANGES`, as the numeric settings get theirs from `SETTING_RANGES`. *Why:* the low end keeps a run from being cut off before pi starts; the high end is a slip of the hand, and also how long a backup can wait ([The locks](exchange.md#the-locks)).

**`run`.**
- Each trigger in it has exactly one of `on`, `at`, `once` and `backfill`, and only the keys that go with it: `at` and `once` a `task`, a text, and `backfill` a `skill` and `writes`.
- `on: new-messages` is the only `on`: the agent runs on every batch of new messages. It is given at most once.
- `at` is `HH:MM`, daily, or a weekday from `Mon` to `Sun` and `HH:MM`, weekly, such as `"Sun 18:00"`, in `SCOOTER_TZ`. The values are unique: they are the keys of `scheduled` in the state ([State](runner.md#state)).
- A `once` task runs once, and its ID is remembered.
- `once` and `backfill` IDs are lowercase letters, digits and hyphens, unique within their kind. They go into session names, commit messages and the state ([rebuild and backfill](rebuild-and-backfill.md)).
- `run` may be empty: an agent that runs on nothing is the owner's to configure.

**A backfill** fills a newly added view from the whole datastore ([Backfill](rebuild-and-backfill.md#backfill)). Its `skill` is one of the agent's skills, by name, other than `day-pages`: a backfill fills one other view, and may change the day pages anyway. Its `writes` is what it may change besides the day pages: a list of at least one path, none twice, each `views/<…>` with at least one part after `views/`, a file, or a folder ending in `/`. Refused: `views/` itself, `views/days` and anything in it, `..`, `.`, empty parts, and names starting with a dot, which the file check would refuse anyway ([After a successful run](run.md#after-a-successful-run)).

## Facts about yaml 2.9.1

`yaml` is pinned in `package.json`, and only `config.mjs` imports it ([The code's layers](../ARCHITECTURE.md#the-codes-layers)). With `version: '1.2'` and `schema: 'core'` it reads `09:05` as a string, `on` as a key, and `010` as 10. A duplicate key is an error, and a tag it doesn't know a warning, which the check turns into a fault.

## Facts about systemd's and Compose's env files

Checked by hand on 2026-11-16, with systemd 255 (`systemd-run --user -p EnvironmentFile=…`) and Docker Compose v5.3.1 (`env_file:`), each running a script that prints its environment.

A file in the format above came out the same from both, and the same as from `parseEnvFile`: comments, indented ones too; an empty value; a value with spaces inside; spaces around a value, which both trim; a URL; and single-quoted values holding `$$`, `${HOME}`, `\`, `#`, double quotes and spaces at the ends, all kept as written.

Lines outside the format, each of which the loader refuses, the last row's too:

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
