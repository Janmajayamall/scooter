# Install, native and Docker

Scooter runs on Linux in one of two ways, at the owner's choice ([The owner's fixed choices](../ARCHITECTURE.md#the-owners-fixed-choices)): natively, as two systemd services, or with Docker Compose, one image and two services. Neither publishes a port. The code also runs as an ordinary user, for development. This document covers what each way sets up: the native `setup` and the systemd units, the image and the Compose files, `doctor`, which checks either, and the facts about systemd, Docker and the releases they rely on. The operator's steps are the README's: [Install natively](../../README.md#install-natively), [Install with Docker](../../README.md#install-with-docker), [KVM](../../README.md#kvm) and [Upgrading](../../README.md#upgrading).

## Files

- `src/ops/setup.mjs`: `scooter setup`, a native install: its checks, the users, the folders, the env files, `/usr/local/bin/scooter` and the units; and `dataFolders`, the folders of the data folder with their owners and modes, which `doctor` and the image follow too.
- `src/ops/doctor.mjs`: `scooter doctor`.
- `deploy/systemd/scooter-bridge.service`: the bridge's unit.
- `deploy/systemd/scooter-runner.service`: the runner's unit.
- `Dockerfile`: the image.
- `.dockerignore`: what goes into the image's build.
- `compose.yaml`: the two services, the data volume, and the `build-image` container.
- `compose.kvm.yaml`: KVM under rootful Docker.
- `compose.kvm-rootless.yaml`: KVM under rootless Docker.

## Three ways to run it

| | Native | Docker Compose | Development |
|---|---|---|---|
| Set up by | `sudo scooter setup` ([setup](#setup)) | `docker compose build`; the image's `/data` makes the data volume's folders ([The image](#the-image)) | nothing |
| Services | `scooter-bridge.service` as root, `scooter-runner.service` as `scooter-runner` ([The units](#the-units)) | `bridge` and `runner`, from one image ([compose.yaml](#composeyaml)) | two processes, run by hand |
| Users | [Processes and users](../ARCHITECTURE.md#processes-and-users) | the same, at fixed uids | the developer's own ([Running programs](shared-code.md#running-programs)) |
| Data and settings | `/var/lib/scooter`, and `/etc/scooter` | one volume for the data folder; `./config` bind-mounted; an env file for each service | `DATA_DIR` and `CONFIG_DIR` |
| KVM | the `kvm` group, through `SupplementaryGroups` | `/dev/kvm` passed in: by group under rootful Docker, by a udev rule for the runner's host uid under rootless, each a Compose file of its own ([KVM](#kvm)) | the developer's `kvm` group |

The installed services run with `TZ=UTC`, which the units and the image set; code never depends on it ([Time](shared-code.md#time)).

## What it needs

- **Node 22.19 or later** runs everything, because Gondolin and pi need it ([Facts about Gondolin 0.14.0](sandbox.md#facts-about-gondolin-0140), [Facts about pi 1.5.2](agent.md#facts-about-pi-152)). `package.json` says so, and `setup` checks it.
- **Natively,** besides Node: git; restic 0.19.1 and wacli 0.26.0, each a release checked against its checksum, and wacli otherwise built from source ([Facts about wacli's and restic's releases](#facts-about-waclis-and-restics-releases)); QEMU for the machine's architecture; and what `build-image` needs ([build-image](sandbox.md#build-image)). The README installs them ([Install natively](../../README.md#install-natively)). In Docker the image holds them all, and the CLI commands run in its containers, so the host needs only Docker, with Compose, and git.
- **The libraries** are the four of [The code's layers](../ARCHITECTURE.md#the-codes-layers), in `package.json` and `package-lock.json`, pinned as [Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way) says.
- **No install script of a dependency runs.** `.npmrc` sets `ignore-scripts=true` for everyone who installs from the repository, and production installs with `npm ci --omit=dev --ignore-scripts`, natively and in the image. *Why:* two of Gondolin's dependencies, `ssh2` and `cpu-features`, compile native add-ons in their install scripts. A plain install on a machine that has a compiler builds both, and a production install has neither; with the setting, development runs what production runs.

## setup

`scooter setup [--no-services]` sets up a native install, as root, from the code's own folder and with the Node the services will run. It keeps the data in `/var/lib/scooter`, the env files in `/etc/scooter`, the config in `/etc/scooter/config`, `scooter` in `/usr/local/bin` and the units in `/etc/systemd/system`. The first time it runs as `sudo node /opt/scooter/src/cli.mjs setup`, or `sudo /opt/scooter/src/cli.mjs setup`, since it is what writes `/usr/local/bin/scooter`. Its steps, in order, each safe to repeat:

1. **The checks**, before it makes anything. It refuses, listing every problem, unless:
   - it runs as root, and systemd runs the machine (`/run/systemd/system`), unless `--no-services`;
   - the Node running it, which `/usr/local/bin/scooter` will run, is 22.19 or later; every folder above its real path can be passed through by every user; it can be run by every user; and it and those folders are root's and writable by root alone, a sticky folder such as `/tmp` allowed above;
   - the code, the folder that holds `src/cli.mjs`, is the same: every folder above it as Node's, and every folder and file in it, `.git` aside, readable by every user, root's, and writable by root alone; and the dependencies of its `package.json` are installed in its `node_modules`;
   - an env file that is there already reads as the loader reads it, and names the folders `setup` uses, `DATA_DIR=/var/lib/scooter` and `CONFIG_DIR=/etc/scooter/config`; otherwise it says to set them or remove the file.

   *Why:* the service users must run Node and read the code, which they can't inside someone's home folder: the code lives in a folder of root's that every user can read, such as `/opt/scooter`, with Node installed for the whole system. And the bridge runs both as root, so a user who could change either could run code as root. An env file copied by hand from an example names neither folder, and the service would then use `/data` and `/config`. *Cost:* a file of the code someone made writable by its group stops `setup` with its name; up to ten such are listed.
2. **The users** `scooter-wacli`, `scooter-runner` and `scooter-mail`, each added when it is missing, with `useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment Scooter -- <name>`, the shell `/sbin/nologin` or `/bin/false` where that isn't there. The names are `USERS`, and the root test gives names of its own. *Why no home:* wacli's is given by the bridge, the email reader's by the bridge, and the runner's set by the runner ([Running wacli](whatsapp.md#running-wacli), [The email reader](email.md#the-email-reader), [The runner's own folders](sandbox.md#the-runners-own-folders)); `/nonexistent` is Debian's way.
3. **The `kvm` group:** `scooter-runner` is added to it, with `usermod --append --groups`, when it isn't in it. On a machine with no `kvm` group, such as a container, `setup` with services first makes one, a system group. Without services it makes none, and says that pi's VMs will run under emulation, that `doctor` says how to enable KVM, and that running `setup` again adds the runner to the group. *Why:* the runner's unit names the group (`SupplementaryGroups=kvm`), and systemd refuses to start a unit whose group isn't there (216/GROUP). With the group and no `/dev/kvm` the runner starts, and falls back to emulation, which `doctor` explains. Without services nothing names the group, and one made where the kernel offers no KVM would change nothing.
4. **The folders:** the data folder and the folders of [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners) in it (`dataFolders`), each made when it is missing. The data folder, and the folders directly in it, are given their owners and modes again, and one that isn't a folder is refused; the data folder may be a link the owner made, to another disk. A folder in a folder another user owns, such as `wacli/store`, is made when it is missing, as [Folders other users control](../ARCHITECTURE.md#folders-other-users-control) says, and otherwise left alone, as that user's. `/etc/scooter` is root's, 0755. *Why:* owners and modes put right by a second run are what a restore or a slip of the hand can change, and the folders directly in the data folder can be set safely, since only root can write the data folder. *Not done:* a data folder elsewhere. `setup` refuses env files that name another, and moving one is the owner's, by hand.
5. **The config:** the code's `config/` is copied to `/etc/scooter/config` only when that isn't there, through a temporary folder renamed into place, with the owner and modes of [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners). A link in it is refused. From then on it is the owner's, and an upgrade doesn't change it ([Upgrading](../../README.md#upgrading)).
6. **The env files:** `bridge.env`, root's, and `runner.env`, the runner's, both mode 0600, written from the examples only when they are missing, with the examples' `# DATA_DIR=` and `# CONFIG_DIR=` lines made settings of the folders `setup` uses and nothing else changed. Each is written to a temporary file and linked into place, so one that appears meanwhile isn't written over. One that is there is given its owner and mode again, its text left alone, and refused when it is a link or not a file.
7. **`/usr/local/bin/scooter`:** a shell script, root's, mode 0755, that `exec`s the real path of the Node that ran `setup` with the code's `src/cli.mjs`, both in single quotes; a path that holds a single quote is refused. *Why `exec`:* Node is then the service's main process, which `systemctl kill --kill-whom=main -s USR1 scooter-bridge` reaches ([When backups run](backups.md#when-backups-run)).
8. **The units** of `deploy/systemd/`, written to `/etc/systemd/system`, then `systemctl daemon-reload` and `systemctl enable`, so the two services start with the machine. Neither is started. `--no-services` leaves this step out, and doesn't need systemd.

`/usr/local/bin/scooter` and the units are written again at every run, so a moved Node or a changed unit is taken up. `setup` then prints what it did and what to do next, and starts nothing. It exits with 2 when a check fails, when a step refuses what it finds, or when it is called with anything but `--no-services`, and with 1 when a step fails otherwise.

## The units

`scooter-bridge.service` runs `/usr/local/bin/scooter bridge` as root. `scooter-runner.service` runs `/usr/local/bin/scooter runner` as `scooter-runner`, with its group and `SupplementaryGroups=kvm`. Both have:

- `Type=exec`, so a start fails when the program of `ExecStart` can't be run;
- `Environment=TZ=UTC`, and no `EnvironmentFile`: each service reads its own env file ([The env files](configuration.md#the-env-files));
- `KillMode=control-group`: stopping the unit, or its main process dying, stops every process in it, wacli and the email reader with the bridge, and a run's QEMU with the runner ([Supervision](sandbox.md#supervision));
- `Restart=on-failure` ([Restarts](#restarts)), after `network-online.target`, and wanted by `multi-user.target`.

The runner's home and temporary folder aren't set in its unit: the runner sets them itself, so that one place says where they are ([The runner's own folders](sandbox.md#the-runners-own-folders)).

## Restarts

- **The bridge's unit** restarts it after 5 seconds, doubling up to 5 minutes (`RestartSec=5s`, `RestartSteps=6`, `RestartMaxDelaySec=5min`), as the bridge restarts wacli and the email reader (`RESTART_BACKOFF`).
- **The runner's unit** keeps the runner's waits between starts ([Restarts](runner.md#restarts)), with `RestartSec=1min`, `RestartSteps=2` and `RestartMaxDelaySec=30min`, and tells the runner so with `Environment=SCOOTER_RESTART_WAITS=systemd`. *Why systemd's own limit isn't enough:* each of the runner's starts waits out the quiet period first ([When the agent runs](runner.md#when-the-agent-runs)), so systemd's start limit, 5 starts in 10 seconds, never stops a runner that keeps failing after pi has run.
- *Cost of systemd's waits:* systemd counts the restarts until the unit is started by hand or the machine starts again, not after a run that lasted ([Facts about systemd 255](#facts-about-systemd-255)), so from a third crash since then the runner comes back only after the longest wait. Messages wait meanwhile, and none is lost. `RestartSteps` needs systemd 254: Ubuntu 24.04 has 255, and an older systemd warns of the two settings and restarts every minute.
- **In Docker,** `restart: unless-stopped` starts a container again after a wait that doubles from 100 milliseconds up to a minute, and from 100 milliseconds again once the container has run 10 seconds, by Docker's documentation: a container that ended with an error after 12 seconds was started again 0.2 seconds later, every time. A runner that ran pi has always run longer, so the runner keeps its own waits there ([Restarts](runner.md#restarts)).

## doctor

`scooter doctor` checks what the runner needs, and changes nothing. It runs with the runner's settings, as the runner's user: where `scooter-runner` is a user of the machine, it refuses to run as another, before it reads those settings ([The CLI](configuration.md#the-cli)), with exit code 2, and says how to run it, `sudo -u scooter-runner scooter doctor`, or in Docker `docker compose run --rm runner doctor`, which runs as that user. Without that user, as in development, it runs as whoever runs it. *Why:* it checks what the runner's user can reach, the accelerator, the folders and the env files, and another user, root above all, sees those otherwise: as root it reported a fault that wasn't one. *Why before the settings:* natively `runner.env` is the runner's user's alone, mode 0600 ([setup](#setup)), so another user, root apart, can't read it, and was told that, and not how to run `doctor`; review 2 of pull request #38 found it so, as it found it for `scooter backfill`, and the owner decided on 2026-11-23 that both be put right in that pull request.

It reports each check, in this order, as `ok`, `warn` or `fail`, with a fix for each that isn't `ok`:

1. `agents.yaml`, as the runner checks it ([agents.yaml](configuration.md#agentsyaml)).
2. The zone rules that ship with the runner, as the runner checks them at its start, and refuses to start without them ([The zone rules](agent.md#the-zone-rules)); the fix puts the code's `src/runner/vm/icu-tz/` back as the repository has it. *Why:* a damaged copy stops the runner at its start, which the log says, and `doctor` is where the owner looks first.
3. The accelerator ([Acceleration](sandbox.md#acceleration)). Emulation under `AGENT_ACCEL=auto` is a warning: the runner runs. A forced accelerator that can't be used is a failure, and so is `hvf`.
4. QEMU: the system emulator for the machine, and `qemu-img`.
5. The VM image, as the runner checks it ([The VM image](sandbox.md#the-vm-image)), with the pi the build file pins.
6. That a VM boots from the image, when nothing above has failed but `agents.yaml` or the zone rules, which a boot doesn't use, and how long the boot took; or that none booted, with the fix: nested virtualization for a machine that is itself a VM, or `AGENT_ACCEL=emulation`, or building the image again. The runner's own code boots it ([The boot check](sandbox.md#the-boot-check)). *Why:* `/dev/kvm` can open where no VM boots, as in a VM without nested virtualization ([Acceleration](sandbox.md#acceleration)). *Cost:* `doctor` takes a VM's boot longer, a second or two with KVM and several under emulation ([A VM for each run](sandbox.md#a-vm-for-each-run)).
7. The folders of [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners), against `setup`'s own list, those the runner's user can look at; or that Scooter's users aren't there.
8. The env files: the runner's its own and 0600, and the bridge's out of its reach; neither is there in Docker, where the settings come from the environment.
9. Whether `openrouter.ai` answers, and, with ZDR on, which of the configured model's endpoints are in OpenRouter's public list of the endpoints that keep no data, `GET /api/v1/endpoints/zdr`, those with safety retention marked. A model with none is a failure, since OpenRouter would refuse every run ([Zero data retention](network-policy.md#zero-data-retention)).

- **What it sends:** OpenRouter gets no key and nothing of the owner's. `doctor` reads at most `DOCTOR_RESPONSE_MAX_BYTES` of the list, within `DOCTOR_TIMEOUT`.
- **Its fixes** say what to do where it runs. Natively they name `sudo scooter setup` and `sudo scooter build-image`; in Docker (`inDocker`, [Running programs](shared-code.md#running-programs)) what would do it there: the KVM files ([KVM](#kvm)), `docker compose run --rm build-image`, and a shell command that sets a folder's owner and mode in a container of the bridge's. How to enable KVM: natively, the `kvm` group, through `setup` and the unit; in Docker, the device and `group_add` under rootful Docker, or the README's udev rule under rootless; and the firmware, or nested virtualization, where there is no `/dev/kvm`.
- **A stop:** while it runs, it takes `SIGTERM`, `SIGINT` and `SIGHUP`, and gives the boot check a signal, which closes the VM it started; the wait for OpenRouter's answer ends too, the checks after are left, and `doctor` says what stopped it and exits with 1. *Why:* a native `doctor` killed during the boot left a QEMU running, which nothing else stops ([Supervision](sandbox.md#supervision)), and a stop while it waited for OpenRouter had to wait up to `DOCTOR_TIMEOUT`.
- **It exits** with 1 when a check failed, and 0 otherwise.
- **How it reaches the runner's checks:** the checks of the config, the zone rules, the image, the accelerator and a VM's boot are the runner's own code, which `src/cli.mjs` hands to `doctor`, so `src/ops` still imports only `src/common` ([The code's layers](../ARCHITECTURE.md#the-codes-layers)).

## The image

The `Dockerfile` builds one image for both services, for the machine's own architecture, in two stages:

- **`golang:1.27-trixie`** builds wacli 0.26.0 from source, with the build command of [Facts about wacli's and restic's releases](#facts-about-waclis-and-restics-releases), so that it always matches the architecture.
- **`node:24-trixie-slim`** is the runtime. It installs, without their recommendations, `ca-certificates curl bzip2 git tini tzdata cpio lz4 e2fsprogs`, QEMU for the architecture (`qemu-system-x86` or `qemu-system-arm`), and `qemu-utils`, for `qemu-img`, which Gondolin runs and `doctor` checks. Then:
  - restic 0.19.1, from its GitHub release, checked against the checksum the release's `SHA256SUMS` gives, which the Dockerfile holds for each architecture. *Why held there:* a `SHA256SUMS` fetched beside the file would only say that the two came from the same place;
  - wacli, from the first stage;
  - Scooter's three users, made as `setup` makes them, at the uids of [Processes and users](../ARCHITECTURE.md#processes-and-users);
  - the data folder, `/data`, with the folders, owners and modes `setup` gives a native one (`dataFolders`), for the data volume to start from ([Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners)), and `/config`, the config folder's mount point;
  - the app, in `/app`, root's, with its dependencies installed by `npm ci --omit=dev --ignore-scripts`, then `chmod -R a+rX,go-w /app` after everything is copied in: readable by every user, folders passable, and writable by root alone, whatever modes the checkout gave it. *Why:* an image built from a checkout made under umask 077 left the runner and the email reader unable to read it, and one made under umask 000 would let every user change it. `COPY --chmod` would need a newer Dockerfile syntax for symbolic modes, and an octal mode would make every file executable. *Cost:* one more layer holding `/app`, about 20 MB.
- **`TZ=UTC`, and the entry point `tini -- node /app/src/cli.mjs`,** with `help` when no CLI command is given. *Why tini:* it passes a signal on to Node, the service's main process, so `docker compose kill -s SIGUSR1 bridge` starts a backup ([When backups run](backups.md#when-backups-run)); and as the container's first process it takes every process of the container with it when it ends, so the runner's QEMU doesn't outlive the runner's container ([Supervision](sandbox.md#supervision)).
- **pi isn't in it:** it lives in the VM image ([The VM image](sandbox.md#the-vm-image)).
- **`.dockerignore`** lets only `package.json`, `package-lock.json` and `src/` into the build, so no env file or data folder is copied in.

`test/docker.test.mjs` holds the image's users and data folder to `setup.mjs`, and restic's checksums to those milestone 0 took from the release's `SHA256SUMS`.

**Both architectures.** The image builds for the machine's architecture, by `TARGETARCH`: QEMU's package, restic's file and checksum, whose files are named `linux_amd64` and `linux_arm64`, and wacli from source. An architecture other than amd64 or arm64 stops the build, saying so. Docker builds for the host's architecture by default, so an arm64 host builds `arm64`. The code chooses by Node's `process.arch` (`machineArch`, `qemuProgram`, `machineType`), and the VM image's build file names no architecture ([The VM image](sandbox.md#the-vm-image)). Only amd64 has been built ([Known limits](../../README.md#known-limits)): whether the arm64 image holds everything Gondolin's `virt` machine needs, without the packages' recommendations, is unknown until then.

## compose.yaml

`compose.yaml`, whose project is named `scooter`, runs the two services from the image it builds, `scooter:local`. Each has:

- `restart: unless-stopped` ([Restarts](#restarts)), `no-new-privileges`, `stop_grace_period: 30s`, and log rotation of 10 MB × 3 in Docker's `json-file` driver;
- `DATA_DIR=/data` and `CONFIG_DIR=/config`, and its own env file, `bridge.env` or `runner.env` beside `compose.yaml`, which no other service gets;
- the one named volume, `data`, so `scooter_data`, at `/data` ([Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners));
- no added capabilities, `privileged` or seccomp changes ([Facts about Docker](#facts-about-docker)), and no `ports:`.

The services:

- **`bridge`:** `command: [bridge]`, as root, as natively, with `hostname: scooter`, which `docker compose run` gives its one-off containers too, so restic's locks and snapshots name the same host in every one of them.
- **`runner`:** `command: [runner]`, with `user: scooter-runner` ([Processes and users](../ARCHITECTURE.md#processes-and-users)); `read_only: true`, a read-only root file system, with a `tmpfs` at `/tmp`; and `./config` read-only at `/config`. Alone, `compose.yaml` runs pi's VMs under emulation.
- **`build-image`,** a third, which only `docker compose run` starts ([The build-image container](#the-build-image-container)).

`restore`, in a one-off container of the bridge's ([The CLI](configuration.md#the-cli)), gives each file its owner by name ([Restore](backups.md#restore)), which the image's users make the same uid in every container.

*Cost of the one volume:* a bind mount of a host folder in its place starts empty, not as a copy of the image's `/data`, and the runner can't make its folders in a `/data` of root's, so the README says to keep the named volume ([Install with Docker](../../README.md#install-with-docker)).

## The build-image container

In Docker, `docker compose run --rm build-image` builds the VM image ([build-image](sandbox.md#build-image)), with the runner stopped. The service, from the same image, runs only when `docker compose run` starts it (its profile), with `user: root`, `privileged: true`, the data volume, `./config` read-only, and no env file: it reads only `DATA_DIR` and `CONFIG_DIR`, which `compose.yaml` sets. It builds natively, as root, as `sudo scooter build-image` does, in the one volume.

- *Why:* the build doesn't work in the runner's container. As `scooter-runner` it needs root, or a container runtime, which that container doesn't have; as root there, Gondolin's native builder can't make its cache under the read-only root file system, and the mount of `/proc` its chroot needs is refused without `CAP_SYS_ADMIN` ([Facts about Docker](#facts-about-docker)). So the privileges Gondolin's own container build takes, `--privileged`, go to a container that runs only the build, only when the owner starts it, and is removed afterwards; the runner's service keeps none of them. Fewer, such as `CAP_SYS_ADMIN` with Docker's masks of `/proc` and AppArmor's profile lifted, weren't tried: they differ between rootful and rootless Docker, for a container that runs nothing else.
- *Cost:* under rootful Docker a privileged container is root on the host, with its devices, so the build runs what a native build as root runs ([build-image](sandbox.md#build-image)). Under rootless Docker it is the user that runs Docker, with no root on the host.

## KVM

pi's VMs run fast only when the runner can open the host's `/dev/kvm` ([Acceleration](sandbox.md#acceleration)).

- **Natively,** through the `kvm` group: `setup` puts the runner in it, and its unit gives it with `SupplementaryGroups=kvm`. Ubuntu's device rules leave the group's access alone ([Facts about Docker](#facts-about-docker)).
- **In Docker,** `compose.yaml` alone is the case without KVM. Each of the other two is a file added to it, named in `COMPOSE_FILE` in a `.env` file beside it, which every `docker compose` command there reads, and which git ignores, as it does the env files. *Why files of their own:* the owner chooses one without editing a file git tracks, which an upgrade's `git pull` would otherwise meet as a conflict, and a test reads each. `doctor`, run in the runner's container, says which case applies ([doctor](#doctor)).
  - **Rootful Docker,** the usual install, `compose.kvm.yaml`: it gives the runner `devices: ["/dev/kvm:/dev/kvm"]`, and `group_add` with the host's `kvm` group id, `KVM_GID` in `.env`, and stops, saying so, when that isn't set. Access goes through the group, as natively.
  - **Rootless Docker,** `compose.kvm-rootless.yaml`: it gives the runner `devices: ["/dev/kvm:/dev/kvm"]`. The host's `kvm` group never reaches a rootless container, and rootless Docker gives `scooter-runner` a uid of its own on the host, from the range `/etc/subuid` gives the user that runs Docker ([Facts about Docker](#facts-about-docker)). A udev rule gives that uid read and write on `/dev/kvm` with an ACL, set again at each of the device's events, and the uid comes from Docker's own map, asked as the user that runs Docker. The README gives the rule and the shell command that finds the uid ([KVM](../../README.md#kvm)), and `compose.kvm-rootless.yaml` holds both.
    - *Why the runner isn't the container's root there:* the runner is its own unprivileged user everywhere ([Why it is built this way](../ARCHITECTURE.md#why-it-is-built-this-way)), and the bridge's checks hold as they are, with no setting and no second case: it takes the runner's entries only while the outbox is `scooter-runner`'s, by that name ([Folders other users control](../ARCHITECTURE.md#folders-other-users-control)). The container's root would be, on the host, the user that runs Docker and its daemon; it would make the runner's files root's, which a later switch to another case would leave the runner unable to write; and it would make one volume for the whole data folder unsafe, since the container's root reads every folder in it.
    - *Why a rule:* a one-off `setfacl` doesn't last, because Ubuntu's device rules reset per-user ACLs whenever a VM starts or stops. An ACL for one host uid is the narrowest grant there is.
    - *Cost:* the owner works out the uid and writes it in the rule, and a change of the Docker user's range needs the rule again. While someone is logged in at a seat, as on a desktop, systemd's `uaccess` sets the users' ACLs afresh at the device's events, and the rule's `setfacl` then puts this one back, so a VM starting in that moment, milliseconds after another VM of the machine started or stopped, could fail to start: a setup error, which pauses runs ([Failures](run.md#failures)). A server has nobody logged in at a seat, and in a root VM the ACL stayed through every VM. `MODE="0666"` on `/dev/kvm`, systemd's own default, would leave no such moment, and would give every user of the machine KVM, which Ubuntu chose not to; the owner may choose it.
- **A host without KVM, or a container that can't open it:** pi's VMs run under emulation, much slower, as `AGENT_ACCEL=auto` falls back to it ([Acceleration](sandbox.md#acceleration)).

## Facts about systemd 255

Found on Ubuntu 24.04, with units of a user's own manager, and in a root VM:

- **The restart counter.** With `RestartSteps` and `RestartMaxDelaySec` the waits grow from `RestartSec` to `RestartMaxDelaySec` in that many steps: 1, 2, 4 and 8 seconds for 1 second, 3 steps and 8 seconds. The counter doesn't go back after a run that lasted, here one of 8 seconds: the waits stayed at their longest. It goes back when the unit is started by hand.
- **`KillMode=control-group`.** The runner's main process killed alone, with `SIGKILL`, took the rest of the unit with it, its QEMU among them, within 3 seconds; the unit restarted a minute later.
- **`systemd-analyze verify`** exits with 0 when a unit has a setting it doesn't know, or a value it can't take, and says so on stderr; it fails when the unit's program isn't there. So `test/units.test.mjs` gives each unit a stand-in command, and wants nothing on either stream.

## Facts about Docker

Found on Ubuntu 24.04, under rootless Docker on the machine Scooter was built on and under rootful and rootless Docker in a root VM, from 2026-11-15 to 2026-11-18.

- **User namespaces:** Docker's default seccomp profile blocks creating them, so sandboxes like bubblewrap don't work inside containers. Gondolin's VMs don't need them: a container with no added capabilities, no `--privileged` and no seccomp changes ran VMs, under emulation, and reached OpenRouter.
- **Rootless Docker** resets each container's supplementary groups, so the host's `kvm` group never reaches a container. It gives each uid of a container a uid of its own on the host, from the range `/etc/subuid` gives the user that runs Docker: container uid 10002 was host uid 175537 where that range starts at 165536. `/dev/kvm` in a container is the host's device, shown as `65534:65534`, and opens by the host's permissions for that uid.
- **Ubuntu's udev rules** (the `uaccess` tag) reset per-user ACLs on `/dev/kvm` whenever any VM is created or destroyed: a per-user ACL that let a rootless container's root, which is the host user, open it was gone as soon as a VM started. Access through the `kvm` group isn't affected by those resets.
- **The two KVM files work:** in a root VM with nested virtualization, the runner, uid 10002 with the `kvm` group under rootful Docker, and `scooter-runner` with the udev rule's ACL under rootless Docker, opened the sandbox with KVM, and a VM booted in 2.0 to 2.5 seconds.
- **A new named volume** mounted at `/data` starts as a copy of the image's `/data`, owners and modes kept, under rootless Docker too.
- **tini:** killing the runner's container while its VM booted left no QEMU, under rootful and rootless Docker.
- **`docker compose run`** gives a one-off container of a service its `hostname`, and `docker compose run -d` makes one with no restart policy. `docker cp`, which `docker compose cp` wraps, copies a folder out of a named volume from a container that is stopped. `git reset --hard <tag>`, run as `scooter-runner` in a container of the runner's with `--entrypoint git`, resets the agent's repository in the volume.
- **Gondolin's native build in the runner's container,** as root: under the read-only root file system it can't make its cache, `ENOENT: … mkdir '/root/.cache/gondolin/sandbox-helpers'`, and `mount -t proc` there is refused, `permission denied`. As root in a privileged container, under rootless and rootful Docker, it builds.
- **Ubuntu 24.04** restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns = 1`), so rootless Docker there needs an AppArmor profile for `rootlesskit`, which Docker's documentation gives.

## Facts about wacli's and restic's releases

- **wacli 0.26.0** builds with `CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" go install -tags sqlite_fts5 -trimpath -ldflags="-s -w" github.com/openclaw/wacli/cmd/wacli@v0.26.0` on `golang:1.27-trixie`; its `go.mod` asks for Go 1.27.0 with toolchain go1.27.3. Its prebuilt Linux releases, `wacli_0.26.0_linux_amd64.tar.gz` and `wacli_0.26.0_linux_arm64.tar.gz`, are CGO builds too, and the amd64 one is linked against glibc. Each is checked against the release's `checksums.txt`, whose checksums the README's native install gives ([Install natively](../../README.md#install-natively)). The rest of what is known of wacli is in [Facts about wacli 0.26.0](whatsapp.md#facts-about-wacli-0260).
- **restic 0.19.1** comes as `restic_0.19.1_linux_amd64.bz2` or `restic_0.19.1_linux_arm64.bz2` from `https://github.com/restic/restic/releases/download/v0.19.1/`, checked against the release's `SHA256SUMS`, whose checksums the Dockerfile and the README's native install hold. Unpacking it needs `bzip2`, which Ubuntu 24.04's cloud image doesn't have. The rest of what is known of restic is in [Facts about restic 0.19.1](backups.md#facts-about-restic-0191).
