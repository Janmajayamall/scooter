# Scooter v2: design and development plan

This document is the specification for Scooter v2, written for the agent that will build it. Build everything from scratch on the `main` branch, following this document.

An earlier prototype has been removed from the repository. Whatever it taught us about the tools is already in section 13.

When this document doesn't settle a question, pick the simplest option that keeps [the principles](ARCHITECTURE.md#what-scooter-does), and record the choice in `docs/DECISIONS.md`. Don't change anything among [the owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices) without asking the owner.

Two documents go with this one. `docs/ARCHITECTURE.md` maps the components, their boundaries and the decisions behind them; its section 8 lists the changes made to this document on 2026-11-15, while planning, with the reason for each. Changes made since, while building, are recorded in `docs/DECISIONS.md`. The implementation plan, under `docs/plans/`, sets the order of work.

Sections 1 to 5, 6.2 to 6.13, 7, 8.1, 9, 11 and 12, and the parts of the others about the bridge's side and the runner's, have moved: what belongs to no single component to [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), and each component's rules to its document, as [the map](ARCHITECTURE.md#the-map) lists them. What is left here are the rules of the components whose documents aren't written yet, configuration and the CLI, and install. The sections keep their numbers.

## 6. The runner

### 6.1 Config

The runner validates `/config/agents.yaml` at startup. Any error stops it with a message that names the field.

```yaml
agents:
  lifelog:
    model: anthropic/claude-sonnet-5.5   # OpenRouter model ID; it must accept images
    thinking: low                        # optional: off, minimal, low, medium, high, xhigh, max
    prompt: prompts/lifelog.md           # paths are relative to /config
    skills:
      - skills/expenses
      - skills/runs
      - skills/meals
      - skills/travel
      - skills/people
      - skills/day-pages
    reads: [whatsapp, email]             # the sources this agent works on
    session: daily                       # daily or none
    reply_mode: quiet                    # quiet or confirm
    ack_reaction: "✅"                   # reaction on handled messages in quiet mode; "" for none
    can_message: true                    # false: the agent never sends anything
    timeout_minutes: 10
    run:
      - on: new-messages                 # every batch of new messages
      - at: "21:30"                      # daily in SCOOTER_TZ; "Sun 18:00" for weekly
        task: >-
          Evening check-in. List in a few lines what you filed today,
          mention anything that looks missing, and list the open questions.
      # - once: poems                    # runs once; the ID is remembered
      #   task: Write poems for my earlier images captioned "poem".
      # - backfill: people-1             # fills a newly added view from the whole datastore (6.11)
      #   skill: people
      #   writes: [views/people.csv]     # what it may change, besides the day pages
```

Validation:
- There is exactly one agent (in v2), and its name matches `[a-z][a-z0-9-]*`.
- The prompt and skill paths exist inside `/config`, and each skill folder has a `SKILL.md` whose frontmatter gives the folder's name as `name` and a `description`, as pi takes them: a name of at most 64 lowercase letters, digits and single hyphens between them, and a description of at most 1,024 characters, and doesn't set `disable-model-invocation: true`. pi leaves out a skill without a description, or one with that setting, and the runner names a skill by its folder (`docs/DECISIONS.md`, D197, D208).
- Enum fields use the values shown.
- `reads` holds `whatsapp`, `email` or both.
- `at` is `HH:MM`, or a weekday from `Mon` to `Sun` followed by `HH:MM`.
- `once` and `backfill` IDs are unique. A `backfill` names one of the agent's skills other than `day-pages`, and its `writes` are files, or folders ending in `/`, inside `views/` and outside `views/days/`.

## 8. Configuration and files

### 8.2 Environment

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `SCOOTER_TZ` | `Asia/Kolkata` | both | The owner's IANA time zone, used only for what the owner sees or sets ([the owner's fixed choices](ARCHITECTURE.md#the-owners-fixed-choices)) |
| `DATA_DIR`, `CONFIG_DIR` | `/data`, `/config` in Docker; natively set by `setup` (8.5) | both | Roots for all paths; tests override them |

The other settings are in the documents of the components that read them: [WhatsApp](architecture/whatsapp.md#settings), [email](architecture/email.md#settings), [delivery](architecture/delivery.md#settings), [backups](architecture/backups.md#settings), [the runner](architecture/runner.md#settings), [the network policy](architecture/network-policy.md#settings) and [the sandbox](architecture/sandbox.md#settings).

- **Two files, one per service**, as [Secrets](ARCHITECTURE.md#secrets) says. Natively they're in `/etc/scooter/`, owned by root and by `scooter-runner` respectively, mode 0600; in Docker, `compose.yaml` gives each service its own file. Values already in the environment win over the file.
- What pi gets is in [Environment](architecture/sandbox.md#environment); what the bridge's programs get, in [Secrets](ARCHITECTURE.md#secrets).
- The services run with `TZ=UTC`, and code never depends on it ([Time](architecture/shared-code.md#time)). pi's own is in [Environment](architecture/sandbox.md#environment).
- `bridge.env.example` and `runner.env.example` explain every variable and note that values containing `$` need single quotes.

### 8.3 Running in Docker (optional)

Docker is one of two ways to run Scooter; the other is natively (8.5). The owner picks.

- **`Dockerfile`**, with two stages:
  - `golang:1.27-trixie` builds wacli from source (13.1).
  - `node:24-trixie-slim` is the runtime. It installs `ca-certificates curl bzip2 git tini tzdata cpio lz4 e2fsprogs`, QEMU for the image's architecture (`qemu-system-x86` or `qemu-system-arm`) and `qemu-utils`, for `qemu-img`, plus:
    - restic 0.19.1 from its GitHub release, checked against the checksum the release's `SHA256SUMS` gives, which the Dockerfile holds (`docs/DECISIONS.md`, 0.2);
    - the users of [Processes and users](ARCHITECTURE.md#processes-and-users), with their uids;
    - the data folder, `/data`, with the folders of [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners) and their owners and modes: a new volume mounted there starts as a copy of it;
    - the app and its dependencies, with `npm ci --omit=dev --ignore-scripts`, readable by every user and writable by root alone, whatever modes the checkout gave it.

    The entrypoint is `tini -- node /app/src/cli.mjs`. pi isn't installed here; it lives in the VM image ([The VM image](architecture/sandbox.md#the-vm-image)). `docs/DECISIONS.md`, D221, has the rest.
- **`compose.yaml`**, with two services:
  - `bridge`: `command: ["bridge"]`, `hostname: scooter`, `env_file: bridge.env`.
  - `runner`: `command: ["runner"]`, `user: scooter-runner`, `env_file: runner.env`, `read_only: true` (a read-only root filesystem) with a `tmpfs` at `/tmp`, `./config` read-only at `/config`, and the KVM settings below.

  Both have one volume for the whole data folder at `/data` ([Folders and their owners](ARCHITECTURE.md#folders-and-their-owners); `docs/DECISIONS.md`, D219), `restart: unless-stopped`, `security_opt: [no-new-privileges:true]`, `stop_grace_period: 30s`, and log rotation (10 MB × 3). Neither needs added capabilities, `privileged` or seccomp changes (13.4). There are no `ports:`. A third service, `build-image`, runs only when asked (below).
- **Restarts:** Docker starts a container that ran longer than 10 seconds again at once, which a runner that ran pi always has, so the runner keeps its own waits between starts ([Restarts](architecture/runner.md#restarts)).
- **The VM image:** build it after installing and after each upgrade ([The VM image](architecture/sandbox.md#the-vm-image)), with `docker compose run --rm build-image`, with the runner stopped. It runs `build-image` in a container of its own, from the same image, as root and `privileged`: Gondolin's builder makes a chroot with `/proc` and `/dev` mounted in it, which neither the runner's container nor its root can do. Under rootful Docker that container is root on the host, as a native build is ([build-image](architecture/sandbox.md#build-image)). It builds as [build-image](architecture/sandbox.md#build-image) says, in the one volume (`docs/DECISIONS.md`, D220).
- **Both architectures:** the image must build for `linux/amd64` and `linux/arm64`. Docker builds for the host's architecture by default, so an arm64 host builds `arm64`. Use `TARGETARCH` for downloads (restic's assets are named `linux_amd64` and `linux_arm64`), and keep building wacli from source inside the image so it always matches. Only amd64 has been built (`docs/DECISIONS.md`, D228).
- **Commands** (`pair`, `backup-init`, `restore`, `rebuild`…) run through `docker compose run`, so the host needs nothing but Docker and git. `restore` writes into the data folder with both services stopped: `docker compose stop`, then `docker compose run --rm bridge restore` ([Restore](architecture/backups.md#restore); `docs/DECISIONS.md`, D223).

**KVM in Docker.** pi's VMs only run fast if the runner container can open the host's `/dev/kvm`. The runner's user is the same in each case ([Processes and users](ARCHITECTURE.md#processes-and-users)). `compose.yaml` alone is the third case below; each of the other two is a file added to it, named in `COMPOSE_FILE` in a `.env` file beside it (`docs/DECISIONS.md`, D222). `doctor`, run in the runner container, says which case applies (8.4).
- **Rootful Docker on Linux**, the usual install, `compose.kvm.yaml`: it gives the runner `devices: ["/dev/kvm:/dev/kvm"]`, and `group_add` with the host's `kvm` group id (`getent group kvm`), `KVM_GID` in `.env`. Access goes through the group, which Ubuntu's device rules leave alone (13.4).
- **Rootless Docker on Linux**, `compose.kvm-rootless.yaml`: the host's `kvm` group never reaches a rootless container (13.4), and rootless Docker gives `scooter-runner` a uid of its own on the host, from the range `/etc/subuid` gives the user that runs Docker. That uid needs access of its own. A one-off `setfacl` doesn't last, because Ubuntu's device rules reset it whenever a VM starts or stops; the README gives the udev rule that keeps it, which `compose.kvm-rootless.yaml` holds, with the command that finds the uid. Then the runner gets `devices: ["/dev/kvm:/dev/kvm"]` (`docs/DECISIONS.md`, D217).
- **A host without KVM, or a container that can't open it:** pi's VMs run under emulation: about 11 seconds more per run, and pi and its tools about ten times slower ([Facts about Gondolin 0.14.0](architecture/sandbox.md#facts-about-gondolin-0140)). `AGENT_ACCEL=auto` falls back to it ([Acceleration](architecture/sandbox.md#acceleration)).

### 8.4 CLI

| Command | Where | What it does |
|---|---|---|
| `bridge` | bridge | Runs the bridge (the service's default command) |
| `runner` | runner | Runs the runner (the service's default command) |
| `setup [--no-services]` | the host, as root | Natively: checks that the service users can run Node and read the code, which only root may change (8.5), creates the users and folders of [Processes and users](ARCHITECTURE.md#processes-and-users) and [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners), adds `scooter-runner` to the `kvm` group, copies the code's `config/` to `/etc/scooter/config` if it isn't there, writes `bridge.env` and `runner.env` from the examples if they don't exist, writes `/usr/local/bin/scooter`, and installs and enables the two services (8.5), without starting them. `--no-services` leaves the services out, where systemd doesn't run. Safe to repeat (`docs/DECISIONS.md`, milestone 12). |
| `doctor` | runner | Checks what the runner needs, and changes nothing: which accelerator it can use and, if none, how to enable one in this setup (8.3, 8.5); QEMU; the VM image and its pi version; that a VM boots from it with that accelerator, and how long it took, closing that VM if `doctor` is stopped meanwhile; `agents.yaml`; folder owners and modes, and the env files'; whether `openrouter.ai` is reachable; and, with ZDR on, which of the configured model's endpoints qualify. It reports each with its fix, and exits with 1 when something must be fixed. It runs as `scooter-runner` alone where that user is there, and exits with 2 otherwise (`docs/DECISIONS.md`, D224). |
| `build-image` | the host, as root; in Docker, a container of its own: `docker compose run --rm build-image` | Builds the VM image ([build-image](architecture/sandbox.md#build-image)) |
| `pair [--phone +91…]` | bridge | [Pairing](architecture/whatsapp.md#pairing) |
| `email-check` | bridge | [email-check](architecture/email.md#email-check) |
| `backup-init`, `snapshots`, `check`, `restore [snapshot] [--force]` | bridge | [The CLI commands](architecture/backups.md#the-cli-commands), [Restore](architecture/backups.md#restore) |
| `rebuild <agent>` | runner, with its service stopped | [Rebuild](architecture/rebuild-and-backfill.md#rebuild) |

Natively, run a command as its service's user: `sudo scooter pair`, or `sudo -u scooter-runner scooter doctor`. `setup` and `build-image` run as root. In Docker, run a command with `docker compose run --rm <service> <command>`, and build the VM image with `docker compose run --rm build-image`.

### 8.5 Running natively

Scooter runs natively on Linux, on amd64 and arm64:

- **Prerequisites:** Node ≥ 22.19, git, restic 0.19.1, QEMU for the host's architecture, and `cpio`, `lz4` and `e2fsprogs` for `build-image`. wacli: a prebuilt release checked against its sha256 (13.1), or built from source.
- **The code:** in a folder owned by root that every service user can read, such as `/opt/scooter`, with Node installed system-wide. The service users must be able to run Node and read the code, which they can't inside someone's home folder. `setup` checks both.
- **Install:** `sudo scooter setup` (8.4), the first time as `sudo node /opt/scooter/src/cli.mjs setup`, since it writes `/usr/local/bin/scooter`. It keeps the data in `/var/lib/scooter` (`DATA_DIR`), the settings and `config/` in `/etc/scooter/`, and installs two systemd services that start at boot and restart on failure, both with `KillMode=control-group` and `TZ=UTC` (`deploy/systemd/`):
  - `scooter-bridge.service`, as root, restarted after waits that grow from 5 seconds to 5 minutes;
  - `scooter-runner.service`, as `scooter-runner`, with `SupplementaryGroups=kvm`, and with its home and temporary folder under the data folder's `runner/`, which the runner sets itself ([The runner's own folders](architecture/sandbox.md#the-runners-own-folders)). It is restarted after the waits of [Restarts](architecture/runner.md#restarts), which it tells the runner it keeps, with `SCOOTER_RESTART_WAITS=systemd` (`docs/DECISIONS.md`, D207).

  `/usr/local/bin/scooter` `exec`s Node, so Node is each service's main process. Then build the VM image with `sudo scooter build-image` ([build-image](architecture/sandbox.md#build-image)), and check everything with `sudo -u scooter-runner scooter doctor`.
- **KVM:** the runner needs read-write access to `/dev/kvm`. `setup` gives it through the `kvm` group, which Ubuntu's device rules leave alone (13.4). On a machine without the group, `setup` makes it when it installs the services, since the runner's unit names it (`docs/DECISIONS.md`, D225).
- **Development:** the code and its tests run natively without `setup`, as an ordinary user (section 10).

### 8.6 Constants

Every fixed number that tunes how Scooter behaves lives in one module, `src/common/limits.mjs`. Each has a name, a comment saying what it protects, and the section that uses it. Code never repeats these numbers inline, and tests override them through the module.

They aren't settings. A value becomes a setting (8.2) only when the owner has a reason to change it, and then it gets a valid range and a test. That way a bad value can't, for example, make Scooter retry in a tight loop or flood WhatsApp.

| Name | Value | Used in | What it does |
|---|---|---|---|
| `CONFIG_RANGES`, `SETTING_RANGES` | `timeout_minutes` 1 to 120; `BATCH_SECONDS` 1 to 600, `SESSION_ROLLOVER_HOUR` 0 to 23, `EMAIL_IMAP_PORT` 1 to 65535, `EMAIL_CHECK_SECONDS` 10 to 3600, `RESTIC_KEEP_DAILY` 1 to 3650, `RESTIC_KEEP_WEEKLY` 0 to 520, `RESTIC_KEEP_MONTHLY` 0 to 1200 | 6.1, 8.2 | The values a number in `agents.yaml`, or a numeric setting, may take; one outside stops the service at startup |
| `DOCTOR_TIMEOUT`, `DOCTOR_RESPONSE_MAX_BYTES` | 30 seconds; 32 MB | 8.4 | The longest `doctor` waits for OpenRouter's list of the endpoints that keep no data, and the most of it it reads; the list was 1.2 MB on 2026-11-18 |

The constants of the bridge's side and the runner's are described in `src/common/limits.mjs`, beside their values, and named in the rules that use them, in the documents of [the map](ARCHITECTURE.md#the-map).

## 10. Testing

- `npm test` runs everything with `node --test`. Tests use no real credentials and no network. Each test works in its own temporary folder and sets `TMPDIR` inside it, which restic needs.
- **Stubs and fakes:**
  - Small Node scripts stand in for `wacli` and `pi`, and for `restic` in the backup coordination tests, behind shell wrappers placed first on `PATH`. They record their arguments and environment to a file and answer from fixtures.
  - The bridge's side of email is tested by placing folders in the spool; the email reader's tests use a fake mailbox ([The email reader](architecture/email.md#the-email-reader)).
- Run the bridge and the runner as real processes, or in-process with an injectable clock and paths, against temporary folders that stand in for the data folders. Behavior that needs root (users, folder modes) or a hypervisor was checked by hand, natively and in Docker (`docs/DECISIONS.md`, milestones 12 and 13); unit tests cover the decisions, such as which mounts and settings are used.

**Where the tests run:** the code and the tests must run natively on Linux (Node ≥ 22.19).
- Without `setup`, the processes usually run as an ordinary user, and switching users and changing ownership are skipped ([Running programs](architecture/shared-code.md#running-programs)). Tests cover both paths where they can.
- Run the whole suite as an ordinary user, and also as root, in Docker: `docker run --rm -e SCOOTER_ROOT_TESTS=1 -v "$PWD":/src -w /src node:24-trixie sh -c 'npm ci && npm test'`. That exercises the root-only paths. The tests that create users run only with `SCOOTER_ROOT_TESTS=1`, so running the suite as root on a real machine creates none. The restic round trip skips itself when restic isn't installed, and the sandbox tests skip themselves when QEMU isn't.

**Keeping macOS cheap to add** ([Deferred and out of scope](ARCHITECTURE.md#deferred-and-out-of-scope)). These rules cost nothing now, so keep them:
- Don't depend on Linux-only features: no `/proc`, no `fs.watch` (poll instead), and no GNU-only command flags such as `sed -i`, `date -d`, `stat -c` or `readlink -f`.
- macOS file systems are usually case-insensitive, so never create two files whose names differ only in case.

Passing the suite on a Mac isn't required until macOS is.

Required tests of the runner's side, at least:
- **Least privilege:** the folders Scooter creates get the owners and modes of [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners), and `setup` makes the users and folders, as root, without services, and the kvm group with them where there is none; the Docker image's users, data folder and Compose files are those [The boundaries](ARCHITECTURE.md#the-boundaries) and 8.3 give; wacli and the email reader, run as their users, can't read `datastore`, `agents`, `exchange`, `runner` or `bridge`; each service reads only its own env file; wacli and the email reader get only their own settings; and no password or key appears on a command line.
- **Config:** each validation error names the field, a skill whose `SKILL.md` doesn't give its folder's name and a description is one, and `doctor` reports each missing piece (no accelerator, no QEMU, no image, a VM that doesn't boot, wrong folder modes) with its fix, and runs only as the runner's user where that user is there.

## 13. Verified facts about the tools

### 13.1 wacli v0.26.0 (github.com/openclaw/wacli)

- **Build:** `CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" go install -tags sqlite_fts5 -trimpath -ldflags="-s -w" github.com/openclaw/wacli/cmd/wacli@v0.26.0` on `golang:1.27-trixie`. Its `go.mod` asks for Go 1.27.0 with toolchain go1.27.3.
- **Prebuilt Linux releases** also exist; both are CGO builds:
  - `wacli_0.26.0_linux_amd64.tar.gz`, sha256 `2c28f65e2f9aaf32585288229db1f916c6c5fb5db9513715017d528513604b44`
  - `wacli_0.26.0_linux_arm64.tar.gz`, sha256 `777a5dccece12421b7ee4af001b074e5ebc1c7a63f732cf642c3e7b3c4d7c7b9`
- The rest of what is known of wacli 0.26.0 is in [Facts about wacli 0.26.0](architecture/whatsapp.md#facts-about-wacli-0260) and [wacli's formats](architecture/whatsapp.md#waclis-formats).

### 13.3 Other

- **restic 0.19.1:** download `restic_0.19.1_linux_<arch>.bz2` (`amd64` or `arm64`) from `https://github.com/restic/restic/releases/download/v0.19.1/` and check it against `SHA256SUMS`. The repository's form for R2 and B2 is in [Settings](architecture/backups.md#settings).
- **Docker:** its default seccomp profile blocks creating user namespaces, so sandboxes like bubblewrap don't work inside containers. Gondolin's VMs don't need them (13.4). Docker Desktop on macOS gives containers no KVM.

### 13.4 Gondolin 0.14.0 (`@earendil-works/gondolin`)

Checked in a prototype on an Ubuntu 24.04 server on 2026-11-15. The rest of what is known of it is in [Facts about Gondolin 0.14.0](architecture/sandbox.md#facts-about-gondolin-0140) and [Facts about Gondolin's network](architecture/network-policy.md#facts-about-gondolins-network).

- **Docker:** a container with no added capabilities, no `--privileged` and no seccomp changes ran VMs, under emulation, and reached OpenRouter. On Linux:
  - in rootless Docker, the container runtime resets each container's supplementary groups, so the host's `kvm` group never reaches the container;
  - a per-user ACL on `/dev/kvm` let a rootless container's root, which is the host user, open it. But Ubuntu's udev rules (the `uaccess` tag) reset per-user ACLs on `/dev/kvm` whenever any VM is created or destroyed, so the ACL was gone as soon as a VM started;
  - access through the `kvm` group isn't affected by those resets.

  Rootful Docker with `devices` and `group_add` wasn't tried in the prototype. Milestone 13 tried it, and rootless Docker with the udev rule, at gate G3 (`docs/DECISIONS.md`, 13.5).

## 14. Not verified yet

Check these during implementation where you can, and put the rest in the README as "Check on the first real run". Those of the bridge's side are there already, in [Check on the first real run](../README.md#check-on-the-first-real-run).

Those of the runner's side are there too, or were checked, and what pi and Gondolin were found to do is in [Facts about pi 1.5.2](architecture/agent.md#facts-about-pi-152) and [Facts about Gondolin 0.14.0](architecture/sandbox.md#facts-about-gondolin-0140). Milestones 12 and 13 checked the native and the Docker installs, marked so below.

- KVM inside a container: rootful Docker with `devices` and `group_add`, and rootless Docker with the udev rule (8.3). *Checked at gate G3, in a VM: both reach KVM, and a VM boots in the runner's container in about 2 seconds (`docs/DECISIONS.md`, 13.5).*
- Building the VM image natively, as root ([build-image](architecture/sandbox.md#build-image)), and in the runner container, where the build may need more privileges than the service has (8.3). *`scooter build-image` with Gondolin's container build, under rootless Docker, was run in milestone 7; natively as root at gate G2 (`docs/DECISIONS.md`, 12.5); and in Docker, in a privileged container of its own, under rootless and rootful Docker, in milestone 13 (D220).*
- The runner container with a read-only root filesystem (8.3). *Checked in milestone 13: it runs pi in its VMs (`docs/DECISIONS.md`, 13.5).*
- `docker compose build`, and the Docker image on both `amd64` and `arm64`. *Checked on amd64, under rootless and rootful Docker, in milestone 13; arm64 can't be checked on the plan's machine (`docs/DECISIONS.md`, D228).*

With macOS, later ([Deferred and out of scope](ARCHITECTURE.md#deferred-and-out-of-scope)): Gondolin natively on a Mac with Apple's hypervisor; the launchd services; building the VM image on a Mac; and the stack under Docker Desktop, OrbStack and Colima, including the `./config` bind mount.
