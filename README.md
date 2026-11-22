# Scooter

Scooter keeps a log of your life from what you send it. You send receipts, run screenshots, food photos, tickets and short notes to a second WhatsApp number, the bot, or email them to a mailbox of Scooter's own. Scooter keeps every message for good. An AI agent turns them into spreadsheets, and asks you when it's unsure. Everything is backed up every night, encrypted.

This README is for installing and running it on Linux, natively or with Docker. `docs/ARCHITECTURE.md` maps the parts, with a document for each in `docs/architecture/`, and `AGENTS.md` says how to work on the code.

- [How it fits together](#how-it-fits-together)
- [What you need](#what-you-need)
- [Install natively](#install-natively)
- [Install with Docker](#install-with-docker)
- [KVM](#kvm)
- [The accounts and keys](#the-accounts-and-keys)
- [The env files](#the-env-files)
- [Daily use](#daily-use)
- [The agent's instructions](#the-agents-instructions)
- [Backups and restore](#backups-and-restore)
- [Rebuilds and backfills](#rebuilds-and-backfills)
- [When something goes wrong](#when-something-goes-wrong)
- [The security model](#the-security-model)
- [Reading the network log](#reading-the-network-log)
- [Known limits](#known-limits)
- [Upgrading](#upgrading)
- [Development](#development)
- [Check on the first real run](#check-on-the-first-real-run)

## How it fits together

```
you (WhatsApp, email) ──▶ bridge ──▶ datastore ──▶ runner ──▶ pi, in a VM ──▶ views, memory
         ▲                  │                        │
         └───── replies ────┘◀────── outbox ─────────┘
```

- **The bridge** runs as root. It runs [wacli](https://github.com/openclaw/wacli), a WhatsApp client linked to the bot's number, as the user `scooter-wacli`, and the email reader as `scooter-mail`. It writes every message from you to the **datastore**, a log that is only ever appended to. It sends the replies, and makes the backups.
- **The runner** runs as `scooter-runner`. It holds the OpenRouter key. When you have been quiet for 8 seconds it gives your new messages to the agent, [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), which runs in a fresh virtual machine for every batch, with no secrets and no network of its own. Everything pi sends goes through the runner's network policy, which allows OpenRouter's two chat endpoints and nothing else, and logs every request. pi writes the **views** (CSV files) and its **memory**; the runner checks what it wrote, commits it to git, and writes the replies to the outbox.

The two services share folders and never talk over the network. Nothing listens for connections from outside.

## What you need

- **A Linux machine**, amd64 or arm64, that stays on. Only amd64 has been tested. With KVM, pi's VMs boot in about 2 seconds; without it they run under emulation, about ten times slower (see [KVM](#kvm)). Each VM takes 2 GB of memory while it runs, and one runs at a time.
- **A second phone number for the bot**, registered in WhatsApp Business on a phone you open at least every two weeks, or WhatsApp logs the linked device out.
- **An OpenRouter account**, and a key of Scooter's own with a guardrail (see [below](#openrouter)).
- Optional: **a mailbox used only by Scooter**, at a provider that allows IMAP with an app password, such as Gmail, iCloud or Fastmail. Never your own mailbox.
- Optional, but you want it: **an S3-compatible bucket** for backups, at Cloudflare R2 or Backblaze B2.

## Install natively

Two systemd services, `scooter-bridge` and `scooter-runner`. Everything below runs as root, or with `sudo`.

**1. Prerequisites.** Node ≥ 22.19 installed system-wide (not under someone's home folder, which the service users can't reach), git, QEMU for the machine's architecture, and the tools `build-image` needs:

```sh
sudo apt install git bzip2 lz4 cpio e2fsprogs qemu-system-x86 qemu-utils   # qemu-system-arm on arm64
```

restic 0.19.1 and wacli 0.26.0 go in `/usr/local/bin`, each checked against its checksum. For amd64:

```sh
cd /tmp
curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2
echo 'f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c  restic_0.19.1_linux_amd64.bz2' | sha256sum -c -
bunzip2 restic_0.19.1_linux_amd64.bz2 && sudo install -m 0755 restic_0.19.1_linux_amd64 /usr/local/bin/restic

curl -fsSLO https://github.com/openclaw/wacli/releases/download/v0.26.0/wacli_0.26.0_linux_amd64.tar.gz
echo '2c28f65e2f9aaf32585288229db1f916c6c5fb5db9513715017d528513604b44  wacli_0.26.0_linux_amd64.tar.gz' | sha256sum -c -
mkdir wacli && tar -xzf wacli_0.26.0_linux_amd64.tar.gz -C wacli ./wacli && sudo install -m 0755 wacli/wacli /usr/local/bin/wacli
```

On arm64 the files end in `linux_arm64`, with the checksums `a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465` for restic and `777a5dccece12421b7ee4af001b074e5ebc1c7a63f732cf642c3e7b3c4d7c7b9` for wacli.

**2. The code**, in a folder that is root's and that every user can read:

```sh
sudo git clone <this repository> /opt/scooter
cd /opt/scooter && sudo npm ci --omit=dev --ignore-scripts
```

**3. Setup.** The first time, run it with Node, since it is what writes the `scooter` command:

```sh
sudo node /opt/scooter/src/cli.mjs setup
```

It checks first, and stops, listing every problem, unless Node and the code are root's, writable by root alone, and readable by every user, since the bridge runs both as root. Then it makes the three users, puts `scooter-runner` in the `kvm` group (making the group if the machine has none), makes the data folder `/var/lib/scooter` with the owners and modes of [Folders and their owners](docs/ARCHITECTURE.md#folders-and-their-owners), copies the repository's `config/` to `/etc/scooter/config`, writes `/etc/scooter/bridge.env` and `runner.env` from the examples, writes `/usr/local/bin/scooter`, and installs and enables the two services without starting them. It is safe to run again: it never overwrites an env file or the config, and puts owners and modes right. An env file you copied there by hand must set `DATA_DIR=/var/lib/scooter` and `CONFIG_DIR=/etc/scooter/config`, as `setup` does, or it refuses it.

**4. Fill in the env files**, `/etc/scooter/bridge.env` and `/etc/scooter/runner.env` (see [The env files](#the-env-files) and [The accounts and keys](#the-accounts-and-keys)).

**5. Build the VM image** pi runs in, into `/var/lib/scooter/runner/image`. It runs as root, in a folder only root can write; about 15 seconds and 530 MB:

```sh
sudo scooter build-image
```

**6. Link WhatsApp** to the bot's number, then start the services and check:

```sh
sudo scooter pair                      # shows a QR code to scan in WhatsApp Business: Linked devices
sudo systemctl start scooter-bridge scooter-runner
sudo -u scooter-runner scooter doctor
```

`scooter pair --phone +919812345678` gives a code to type into the phone instead of a QR code. `pair` does nothing while wacli is linked: to link it again, unlink it first on the phone. `doctor` runs as `scooter-runner` only, since it checks what the runner can reach (see [When something goes wrong](#when-something-goes-wrong)).

Commands run as their service's user: `sudo scooter <command>` for the bridge's (`pair`, `email-check`, `status`, `backup-init`, `snapshots`, `check`, `restore`), `sudo -u scooter-runner scooter <command>` for the runner's (`doctor`, `rebuild`). `scooter help` lists them. The logs are in the journal: `journalctl -u scooter-bridge -u scooter-runner`.

Where things are: the data in `/var/lib/scooter`, the settings in `/etc/scooter`, the agent's instructions in `/etc/scooter/config`.

## Install with Docker

One image, two services, `bridge` and `runner`, in `compose.yaml`. The host needs Docker with Compose, and git; nothing else.

```sh
git clone <this repository> scooter && cd scooter
cp bridge.env.example bridge.env && cp runner.env.example runner.env    # then fill them in
docker compose build
docker compose run --rm build-image
docker compose up -d
docker compose run --rm runner doctor
docker compose run --rm bridge pair
```

- **`build-image`** builds the VM image into the data volume. Run it after installing and after each upgrade, with the runner stopped. It runs in a container of its own, as root and privileged, because Gondolin's builder makes a chroot with `/proc` and `/dev` mounted in it: under rootful Docker that container is root on the host, as a native build is.
- **The data** is one named volume, `scooter_data`, mounted at `/data` in every container. A new volume starts as a copy of the image's `/data`, whose folders have the right owners and modes, which keep each service out of the others' folders. Keep the named volume: a bind mount of a host folder in its place starts empty, and then its folders must first be made with their owners, as the `Dockerfile` makes them.
- **The config** is the repository's `./config`, mounted read-only into the runner. Its files must be readable by other users of the host, as git leaves them under the usual umask.
- **Commands** run with `docker compose run --rm <service> <command>`: `bridge` for `pair`, `email-check`, `status`, `backup-init`, `snapshots`, `check` and `restore`, `runner` for `doctor` and `rebuild`. Logs: `docker compose logs bridge runner`.
- **Without KVM** pi's VMs run under emulation. To use KVM, see the next section.
- **Ubuntu 24.04 with rootless Docker** needs Docker's AppArmor profile for `rootlesskit`, which Docker's documentation on rootless mode gives, because Ubuntu restricts unprivileged user namespaces.

## KVM

pi's VMs run fast only if the runner can open `/dev/kvm`. `doctor` says which case applies, and what to do.

**Natively**, `setup` puts `scooter-runner` in the `kvm` group, and the runner's service has `SupplementaryGroups=kvm`. Without `/dev/kvm` at all, turn on virtualization in the firmware, or nested virtualization if the machine is itself a VM, such as a cloud server.

**Docker** takes a second Compose file, named in a `.env` file beside `compose.yaml`, which every `docker compose` command there reads:

- *Rootful Docker*, the usual install:
  ```sh
  echo "COMPOSE_FILE=compose.yaml:compose.kvm.yaml" >> .env
  echo "KVM_GID=$(getent group kvm | cut -d: -f3)" >> .env
  ```
  The runner gets `/dev/kvm` and the host's `kvm` group.
- *Rootless Docker*: the host's `kvm` group never reaches a rootless container, and Docker gives `scooter-runner` a uid of its own on the host, which needs access of its own. A udev rule gives it, and gives it back each time Ubuntu's device rules take it away:
  ```sh
  echo "COMPOSE_FILE=compose.yaml:compose.kvm-rootless.yaml" >> .env
  # As the user that runs Docker: the host uid of scooter-runner.
  docker run --rm --entrypoint awk scooter:local '$1 <= 10002 && 10002 < $1 + $3 { print $2 + 10002 - $1 }' /proc/self/uid_map
  # As root, with that number in place of <uid>; setfacl and getfacl come with the acl package (apt install acl):
  echo 'SUBSYSTEM=="misc", KERNEL=="kvm", RUN+="/usr/bin/setfacl -m u:<uid>:rw $devnode"' > /etc/udev/rules.d/99-scooter-kvm.rules
  udevadm control --reload && udevadm trigger --action=change --name-match=kvm
  getfacl /dev/kvm     # lists user:<uid>:rw-
  ```
  On a desktop with a logged-in seat, systemd resets the ACLs on `/dev/kvm` whenever any VM of the machine starts or stops, and the rule puts this one back: a VM of Scooter's that starts in that very moment could fail to start, which pauses runs for 30 minutes. `MODE="0666"` on `/dev/kvm` would avoid that, and give every user of the machine KVM, which Ubuntu chose not to; that choice is yours. A server has no seat session.

Then `docker compose up -d`, and `docker compose run --rm runner doctor` reports KVM.

**Emulation**, where KVM isn't there, works everywhere: about 11 seconds more per run, and pi and its tools about ten times slower. With `AGENT_ACCEL=auto`, the default, the runner falls back to it and tells you once; `doctor` gives a warning, with the fix for your case.

## The accounts and keys

### The bot number

Register the bot's number in WhatsApp Business on a phone, link wacli to it with `scooter pair`, and open WhatsApp Business on that phone at least every two weeks. Put your own number in `OWNER_NUMBER` in `bridge.env`, in international format. Scooter takes messages from that number alone. WhatsApp sometimes delivers your messages from an ID such as `123456789012345@lid`: the bridge then logs that it dropped a message from it, with the hint to add it to `OWNER_JIDS`.

wacli is unofficial, so WhatsApp could ban the bot's number.

### The mailbox

Optional. Make a mailbox only Scooter uses, turn on IMAP and two-step verification, and make an app password. In `bridge.env`: `EMAIL_IMAP_HOST` (such as `imap.gmail.com`), `EMAIL_USER`, `EMAIL_PASSWORD` (the app password), and `EMAIL_OWNER_ADDRESSES`, your own addresses. Scooter keeps only mail from those addresses that passes DMARC, so your domain must publish a DMARC record (Gmail's and iCloud's do).

Then send an email to the mailbox from your own address, and run `scooter email-check` (`docker compose run --rm bridge email-check`). It lists the newest 5 messages, with the server named in the topmost `Authentication-Results` header of each and whether it would be kept. Put that server's name in `EMAIL_AUTHSERV_ID`, such as `mx.google.com`: the bridge doesn't start with email on and without it.

Email only comes in. Replies about an email arrive on WhatsApp.

### OpenRouter

Make an OpenRouter key for Scooter alone, and give it a guardrail that:
- enforces zero data retention for every model group, and excludes Safety Retention ("ZDR only");
- allows only the configured model, `anthropic/claude-sonnet-5.5` by default;
- caps spending.

Keep the account's own prompt logging off. Put the key in `OPENROUTER_API_KEY` in `runner.env`. The runner also asks OpenRouter for zero data retention on every request (`OPENROUTER_ZDR=on`, the default), so a request can reach only endpoints that keep no prompts or responses; with the guardrail, even a request without it can't. `doctor` lists the model's endpoints that qualify. If none does, OpenRouter refuses every request, runs pause, and you get one notice with OpenRouter's reason.

### The backup bucket

Make a bucket at Cloudflare R2 or Backblaze B2, and a key for it. In `bridge.env`:

```sh
# R2:
RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>/scooter
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
# Or B2:
# RESTIC_REPOSITORY=b2:<bucket>:scooter
# B2_ACCOUNT_ID=...
# B2_ACCOUNT_KEY=...
# Either way:
RESTIC_PASSWORD='a long random password'
```

Keep `RESTIC_PASSWORD` in a password manager too: the env files aren't backed up, and without the password no backup can be read. Then, once: `sudo scooter backup-init` (`docker compose run --rm bridge backup-init`).

## The env files

Each service reads its own file, so neither sees the other's secrets: the bridge `bridge.env`, the runner `runner.env`. Natively they are in `/etc/scooter/`, mode 0600, the first root's and the second `scooter-runner`'s; in Docker, beside `compose.yaml`. `bridge.env.example` and `runner.env.example` explain every variable.

- One `KEY=value` a line, no space before the `=`, comments on lines of their own.
- A value with `$`, `\`, `#` or a double quote in it goes in single quotes, the first right after the `=`: `RESTIC_PASSWORD='pa$$word'`. Nothing is expanded. A value can't hold a single quote.
- A variable left out takes its default. One already in the service's environment wins over the file.
- A name the service doesn't know is an error, so a misspelled one doesn't go unnoticed.

The ones you set: `OWNER_NUMBER` (bridge) and `OPENROUTER_API_KEY` (runner), always; the mailbox and the bucket, if you use them; `SCOOTER_TZ`, your time zone, the same in both (default `Asia/Kolkata`); and `HOME_CURRENCY` (default `INR`). The others have defaults you can leave: `AGENT_INTERNET=off`, `AGENT_ACCEL=auto`, `BACKUP_TIME=03:30`, `BATCH_SECONDS=8`, `SESSION_ROLLOVER_HOUR=4`, the backups' retention. Restart a service after changing its file.

## Daily use

Send the bot what you want kept: a receipt photo, a screenshot of a run, a note such as "an hour with Sam, planning the Goa trip", a ticket, a voice note's announcement. Forward bookings and files to the mailbox. Scooter is quiet by default: it reacts ✅ to each message it has handled, and writes only when it has a question or you asked something. With `reply_mode: confirm` in `agents.yaml` it writes one short line per batch instead. A message that fits none of the views, such as a note about the day, or that holds nothing to keep, such as "thanks", is kept in the datastore as every message is, and filed in no view; in quiet mode it gets its ✅ all the same. A view for such notes is a skill you add ([The agent's instructions](#the-agents-instructions)). You can reply to its questions; edit or delete a message, and it changes or removes what it filed from it. Standing instructions ("start tracking coffee") go into its memory, `memory/preferences.md`, and apply from then on. The agent keeps one conversation a day, which ends at `SESSION_ROLLOVER_HOUR`, 04:00 by default.

Everything you send is a message to file: Scooter takes no commands on WhatsApp. **How it is doing** is on the machine:

```sh
sudo scooter status                        # natively
docker compose run --rm bridge status      # Docker
```

It prints the bridge, when it started and when it last wrote its status, or when it stopped; the channels; the newest message; when the runner started, and whether it waits after stopping on an error; the agent's last run, whether runs are paused and why, and the messages pending, retrying and failed; the VMs' accelerator, the image's age, zero data retention, internet access, the network log's last 24 hours, and the backups. It reads only files, so it works with the bridge stopped, and changes nothing. Nothing tells you on WhatsApp that the runner is down, and `scooter status` doesn't say so either: it shows when the runner last started, the agent's last run and the messages pending, which only get older and more while it is down. The logs say whether it runs ([When something goes wrong](#when-something-goes-wrong)).

**The views** are in the agent's folder, `agents/lifelog/` in the data folder: `views/expenses.csv`, `runs.csv`, `meals.csv`, `travel.csv` and `people.csv`. The folder is a git repository, with a commit for each batch. To copy the views out:

```sh
sudo cp -r /var/lib/scooter/agents/lifelog/views ~/scooter-views && sudo chown -R "$USER" ~/scooter-views   # natively
docker compose cp runner:/data/agents/lifelog/views ./scooter-views                                          # Docker
sudo -u scooter-runner git -C /var/lib/scooter/agents/lifelog log --stat                                      # what changed when
```

A guess is marked ❓ at the start of a row's `note`, and the open questions are in `memory/needs-review.md`.

**When a run fails** you get one notice ("⚠️ I couldn't process your last messages (…). I'll try again."), and nothing more until a run gets through. A message the agent couldn't handle after 4 attempts gets a notice too; send it again, or edit it, to bring it back. If OpenRouter refuses the key, has no credit, or has no endpoint that meets zero data retention, runs pause, and the notice says so: fix it, and the next try, every 30 minutes, or restarting the runner, goes on. Nothing is lost meanwhile: messages wait, and are handled once runs go again.

## The agent's instructions

They are your files, in the config folder (`/etc/scooter/config` natively, `./config` in Docker): `agents.yaml`, the prompt `prompts/lifelog.md`, and a folder for each skill under `skills/`, each with a `SKILL.md`. The agent can't change them. Restart the runner after a change; it checks the files at its start, and refuses to start, naming the field, when something is wrong.

- **The default `agents.yaml`** sends an evening check-in at 21:30 (`- at: "21:30"`). Remove that entry for a quieter bot.
- **What the agent sees, changes and sends** is in `agents.yaml` too, as paths of the data folder, a folder ending in `/`: `reads`, by default the datastore and the agent's own folder; `writes`, by default `agents/lifelog/views/` and `agents/lifelog/memory/`, which is what the agent's git repository keeps; and `sends`, the channels its messages may go out on, by default `[whatsapp]`. The trigger `on: new-messages` names the `channels` whose messages it works on, by default `[whatsapp, email]`. The agent's VM can't change anything `writes` doesn't name. Nothing limits what they may name but what a file system can't take, a name longer than 255 bytes or a path longer than 4,095 bytes, the data folder's included, and, in `writes`, the runner's own files, in the agent's folder and in `agents/.discarded/` beside it, where a clean-up sets aside what it throws away: a path of the datastore, the outbox or the runner's folder in `writes` is yours to choose, with what it gives the agent. A path of `writes` outside the agent's folder isn't in git, a failed run's changes there aren't undone, and it is in a backup only when it lies in a folder a backup holds ([Backups and restore](#backups-and-restore)).
- **To add a skill**, for a new view:
  1. Make a folder `skills/<name>/` with a `SKILL.md` whose frontmatter gives the folder's name as `name` and a `description` that says when to use it, then the instructions:
     ```markdown
     ---
     name: books
     description: Books read or started. Use when the owner mentions a book, a chapter or reading.
     ---
     Keep views/books.csv with the header date,title,author,status,note,source …
     ```
     The name is lowercase letters, digits and single hyphens, and not `scooter`, which is the runner's own skill's. Without a matching name and a description the runner refuses to start.
  2. Add `skills/<name>` to the agent's `skills` in `agents.yaml`.
  3. Add a line for its view to the list in `prompts/lifelog.md`: `- books.csv: books read or started (skill: books)`.
  4. To file the messages from before the skill was added, add a `backfill` entry (see [Backfills](#backfills)).
- **Upgrades:** the protocol the agent follows ships with the runner, and so do the runner's own skill, `scooter`, which says how to read the datastore, `show`, the command the agent reads a message with, and the time zone rules the agent's VM converts times with; they change with an upgrade. The prompt and skills don't. Natively, `setup` copies `config/` to `/etc/scooter/config` only when it isn't there, so instructions a later version improves are yours to copy or merge by hand from `/opt/scooter/config`. So is `image/build.json`, which pins pi's version: natively the runner and `build-image` read your copy of it, so an upgrade that moves the pin needs it merged before the image is built again (see [Upgrading](#upgrading)). In Docker, `./config` is the repository's own files: the `git pull` of an upgrade changes them, or meets your edits as a conflict to merge.

## Backups and restore

**Backups** run every night at `BACKUP_TIME`, in `SCOOTER_TZ`, encrypted by restic before they leave the machine. A backup holds the datastore, the agent's folder, wacli's session, the bridge's folder, the mail reader's folder, the network log and the runner's outbox; not the env files, and not the VM image, which `build-image` makes again. The bridge's folder holds its state, its own notices waiting to go out (`bridge/outbox/`), and its record of the runner's entries it is sending (`bridge/sending/`); not its status (`bridge/status/`), which says how the bridge is doing. While restic reads, a backup stops WhatsApp, email and the replies, and waits for a run of the agent to finish first; what arrives meanwhile is collected when the channels start again. The first backup, of everything, can take hours, up to 6 hours a step (`RESTIC_TIMEOUT`); what it uploaded is used again by the next. `restic check` runs on Sundays.

A failed backup sends you a notice, which says when the next one is; `scooter status` shows the last one and the next. To back up now:

```sh
sudo systemctl kill --kill-whom=main -s USR1 scooter-bridge   # natively
docker compose kill -s SIGUSR1 bridge                          # Docker
```

`scooter snapshots` lists the backups, `scooter check` checks the repository.

**A restore** puts a backup back into the data folder. On a new machine, install first (natively `setup`, which makes the users the files get as their owners), then:

```sh
# Natively:
sudo systemctl stop scooter-bridge scooter-runner
sudo scooter snapshots                     # choose one, or take the latest
sudo scooter restore [snapshot] [--force]
sudo scooter build-image                   # on a new machine
sudo systemctl start scooter-bridge scooter-runner

# Docker:
docker compose stop
docker compose run --rm bridge snapshots
docker compose run --rm bridge restore [snapshot] [--force]
docker compose run --rm build-image        # on a new machine
docker compose up -d
```

`restore` refuses while either service runs, and refuses a data folder that isn't empty unless given `--force`. With `--force`, each folder the backup holds becomes the backup's: restic deletes what the backup doesn't hold inside those folders, and nothing outside them. After a restore, look at the last commit of the agent's folder (see [Rebuilds](#rebuilds)).

To look at a backup without touching the data, restore it somewhere else, with `RESTORE_TARGET`; the services can keep running:

```sh
# Natively, into /tmp/look/var/lib/scooter/…; sudo takes the variable only after it:
sudo RESTORE_TARGET=/tmp/look scooter restore [snapshot]

# Docker, into the container's own /tmp, then copied out to ./look, as your files:
docker compose run --name scooter-look -e RESTORE_TARGET=/tmp/look bridge restore [snapshot]
docker cp scooter-look:/tmp/look/data ./look && docker rm scooter-look
```

## Rebuilds and backfills

### Rebuilds

`rebuild` throws away what `writes` names in the agent's folder, the views and memory by default, and files your whole history again, one of your days at a time, as it was then: rules you sent as messages are learned again where you sent them. Use it after changing the instructions in a way the old views should follow. It sends nothing to you while it works, and it spends on OpenRouter for every message ever sent.

1. **Stop the runner** first; the bridge may keep running, and stores what arrives. `rebuild` refuses while a runner runs.
2. **Start the rebuild right after**: it stops at the newest message when it starts, so a message that waited for the stopped runner is filed with no reply or ✅.
3. **Run it where closing a terminal doesn't stop it.** A rebuild isn't resumed: cut short, by a stop, a closed terminal or a crash, it starts from the beginning when run again, and spends again what it had spent.

```sh
# Natively, in tmux or screen:
sudo systemctl stop scooter-runner
sudo -u scooter-runner scooter rebuild lifelog
sudo systemctl start scooter-runner

# Docker:
docker compose stop runner
docker compose run -d --name scooter-rebuild runner rebuild lifelog
docker logs -f scooter-rebuild             # until it ends; then: docker rm scooter-rebuild
docker compose start runner
```

- It tags the last commit before it `before-rebuild-<UTC time>`, such as `before-rebuild-20261118T101500Z`. To go back to it, with the runner stopped: `sudo -u scooter-runner git -C /var/lib/scooter/agents/lifelog reset --hard before-rebuild-20261118T101500Z` (in Docker, `docker compose run --rm --entrypoint git runner -C /data/agents/lifelog reset --hard …`). The runner's state stays as the rebuild left it.
- It throws away uncommitted changes in what `writes` names in the agent's folder, `views/` and `memory/` by default, as a start of the runner does, and empties it.
- A rebuild that finished commits as `lifelog: rebuild`. One that didn't leaves the last commit's message as `lifelog: rebuild #…`, and nothing else says so: look at it after a crash, a reboot or a restore (`git log -1`), and run the rebuild again if it reads so.

### Backfills

A backfill files the messages from before a skill was added, for that skill alone, without touching the other views and without stopping live work. Add a `backfill` entry under the agent's `run` in `agents.yaml`, and restart the runner:

```yaml
      - backfill: books-1           # an ID of your choosing, used once
        skill: books
        writes: [agents/lifelog/views/books.csv]   # what it may change, in the agent's writes
```

It works only while nothing live is waiting, and its VM can change only what its `writes` names. It sends one message when it is done, with the rows it filed and those marked ❓. `scooter status` shows how far it has got.

## When something goes wrong

**`doctor`** checks what the runner needs, and changes nothing: the config, the accelerator, QEMU, the VM image, that a VM boots from it and how long it took, the folders' owners and modes, the env files, that OpenRouter answers, and the model's endpoints that keep no data. It gives each problem with its fix, and exits with 1 when something must be fixed.

```sh
sudo -u scooter-runner scooter doctor      # natively
docker compose run --rm runner doctor      # Docker
```

- *`warn accelerator: emulation, since KVM can't be used`*: the runner runs, slowly. The fix says how to enable KVM in your case: the `kvm` group natively; the KVM Compose file in Docker; the firmware, or nested virtualization, when there is no `/dev/kvm`. See [KVM](#kvm).
- *`fail VM boot`*: KVM can open and still not boot a VM, as on a machine that is itself a VM without nested virtualization: enable it, or set `AGENT_ACCEL=emulation`. Otherwise build the image again.
- *`fail VM image`*: missing, or built for another pi version than `config/image/build.json` pins: run `build-image`.

**The runner's restarts.** The runner stops when something outside pi goes wrong, such as a damaged datastore or a full disk, and its service manager starts it again. So that a fault that stays can't run the agent, and spend on OpenRouter, every few seconds, the starts wait 1 minute after the first stop in a row, about 5½ after the second, then 30 minutes after each:

- Natively systemd keeps these waits, and counts the restarts until the service is started by hand or the machine starts again. After you have fixed the cause, `sudo systemctl restart scooter-runner` brings it back at once.
- In Docker the runner keeps them itself, since Docker would start it again at once. The first wait sends you a notice ("⚠️ I stopped on an error (ENOSPC), so I wait until …"), and `scooter status` says until when and why. `docker compose restart runner` ends the wait.
- A start that stops before it gets that far, such as on a mistake in `agents.yaml`, a missing VM image or a damaged datastore, runs nothing of pi's, and keeps no wait and sends no notice. Natively systemd waits as after any stop. In Docker, Docker starts it again by its own restart policy, whose waits are a minute at most, and `docker compose ps` shows the runner restarting.

The logs say what went wrong: `journalctl -u scooter-runner` natively, `docker compose logs runner` in Docker. They hold IDs, kinds, sizes and timings, never the text of your messages.

**The bridge** restarts wacli and the email reader after 5 seconds, doubling up to 5 minutes, and natively its own service restarts the same way. While wacli isn't linked the bridge logs that you should run `pair`, and replies wait.

## The security model

What each part can reach, and what protects what ([The boundaries](docs/ARCHITECTURE.md#the-boundaries), [the sandbox](docs/architecture/sandbox.md) and [the network policy](docs/architecture/network-policy.md)):

- **Strangers** can't reach the agent: the bridge keeps WhatsApp messages only from your number and IDs, never from groups, and email only from your addresses when it passes DMARC. Replies have no recipient field: they always go to you.
- **The agent is sandboxed.** pi runs in a fresh VM for every batch, with no secrets: it sees a placeholder where the OpenRouter key would be, which the runner swaps for the key on the way out, and only on requests to OpenRouter. It sees what `reads` names, by default the datastore and its own folder, read-only, and can write only what `writes` names, by default its views and its memory, and its copy of the current session; it never sees the other sessions. Nothing it does inside the VM survives it. A run may write at most 1 GB and make at most 100,000 files, or it is stopped, so it can't fill the disk.
- **The network policy** lets pi's VM reach only OpenRouter's two chat endpoints, with the configured model. It refuses anything that would make OpenRouter fetch from the web for the agent: its web plugin and server tools, `:online` models, and images given by URL. DNS is answered inside the runner, and private addresses, UDP and raw TCP are refused. Every request is logged (see below). A request whose log line can't be written doesn't go out.
- **Internet access**, `AGENT_INTERNET=on` in `runner.env`, also lets pi reach public HTTPS websites, which the agent may use to look something up for a filing. A misled agent could then send your data to any public website, and even an ordinary lookup tells a website what was looked up. The log shows when, which host and path, and how much, never what. It is off by default.
- **Third-party code that faces the outside**, wacli and the email reader, runs as its own user, with only its own settings and folder. Neither can read the key, the datastore, the agent's folder, the exchange or the bridge's state.
- **The record:** the datastore is only ever appended to, and only the bridge writes it. What the agent changes is in git, where you can see and revert it. Backups are encrypted before they leave the machine.
- **Accepted risks:** OpenRouter and the model's provider see your messages while they process them, and keep nothing afterwards with zero data retention, except what OpenRouter's screening for child sexual abuse material flags. A malicious document can still mislead the agent into misfiling something, or telling you something wrong; git history shows what changed. A flaw in QEMU could let pi out of its VM and into the runner, which holds the OpenRouter key but none of the bridge's secrets. Natively the bridge runs as root, and so does `build-image`; in Docker `build-image` is privileged, which under rootful Docker is root on the host too.

## Reading the network log

Every request pi's VM makes is a line in `runner/log/<UTC date>.jsonl` in the data folder, written by the runner:

```sh
sudo cat /var/lib/scooter/runner/log/2026-11-18.jsonl                 # natively
docker compose exec runner cat /data/runner/log/2026-11-18.jsonl      # Docker
```

```jsonl
{"id":"20261109T155012041-0001","at":"2026-11-09T15:50:12Z","event":"request","host":"openrouter.ai","method":"POST","path":"/api/v1/messages"}
{"id":"20261109T155012041-0001","at":"2026-11-09T15:50:13Z","event":"response","status":200,"ms":812}
{"id":"20261109T155012041-0001","at":"2026-11-09T15:50:19Z","event":"end","sent":48211,"received":5340,"ms":7012}
{"at":"2026-11-09T15:51:02Z","event":"refused","host":"example.com","method":"GET","path":"/","reason":"host not allowed"}
```

| `event` | Means |
|---|---|
| `request` | A request the policy let out, written before it goes: when, which host, method and path, without its query string |
| `response` | Its status, when it arrived, and how long it took |
| `end` | The response is over: the bytes each way, headers included, and a `reason` when it was cut short |
| `error` | It got no answer: the host couldn't be reached, the connection broke, or the run ended first |
| `refused` | A request the policy refused, and why |
| `unlogged` | Refusals past the first 100 of a run, counted in one line |

Lines of one request share its `id`. No line holds a header, a body or a query string. `scooter status` counts the last 24 hours. With `jq`, the hosts of a day: `jq -r 'select(.event=="request") | .host' <file> | sort | uniq -c`. With internet access off, every `request` line names `openrouter.ai`.

## Known limits

- **A request the agent sends itself can decide why a run failed.** The policy lets out any request shaped like pi's that carries the key's placeholder, whoever sends it, and the VM's environment holds the placeholder. So a message that misleads the agent into sending one, with `curl`, can make a failed run look like an OpenRouter outage or setup error: its batch is then tried every 30 minutes, without using its attempts, for as long as that message is in it, and `scooter status` shows runs paused or retried. Deleting the message on WhatsApp takes its text out of what the agent is shown, which shows only that it was deleted; an email can't be deleted so. You accepted this on 2026-11-18 ([Failures](docs/architecture/run.md#failures)).
- **A WhatsApp message that reaches wacli long after messages sent later**, more than 2 minutes, and whose webhook to the bridge was also lost, may never be stored. Catch-up lists wacli's store by the messages' own times, from where it had got to, less 2 minutes; your messages normally reach wacli in their order. It stays in WhatsApp and in wacli's own store ([Catch-up](docs/architecture/whatsapp.md#catch-up)).
- **The image on arm64**, Docker Desktop, OrbStack, Colima and macOS have never been run.
- **The native install and upgrade, as written here,** have never been run whole: the install's steps ran in a throwaway VM, as the plan the code was built by worded them, and the upgrade's one at a time. `sudo RESTORE_TARGET=… scooter restore` has never been run.
- **A native bridge runs as root**, so that it can start wacli and the email reader as their own users: a flaw in it would expose the whole machine, not one container. Running it as its own user, with systemd starting the other two, is a possible later change.

## Upgrading

```sh
# Natively:
sudo systemctl stop scooter-runner
cd /opt/scooter && sudo git pull && sudo npm ci --omit=dev --ignore-scripts
sudo git diff ORIG_HEAD HEAD -- config/    # what the upgrade changed in config/: merge it into /etc/scooter/config (below)
sudo scooter setup                         # takes up a changed unit or command; your files stay
sudo scooter build-image                   # from /etc/scooter/config/image/build.json, once merged
sudo systemctl restart scooter-bridge scooter-runner

# Docker:
git pull                                   # changes ./config, or meets your edits there as a conflict to merge
docker compose build
docker compose stop runner && docker compose run --rm build-image
docker compose up -d
```

- **Natively, merge before `build-image`.** The runner and `build-image` read your copy of the config, `/etc/scooter/config`, which `git pull` doesn't change. So merge into it what the upgrade changed in the repository's `config/`, and `image/build.json` above all: it pins pi's version, and the new version's network policy and protocol are written for that pi. An image of an older pi can have its requests refused, which pauses runs as a setup error ([Failures](docs/architecture/run.md#failures)). If you never changed your `build.json`, copying it is the merge: `sudo cp /opt/scooter/config/image/build.json /etc/scooter/config/image/build.json`, which keeps your copy's owner and mode. The prompt and skills are yours to merge as you see fit (see [The agent's instructions](#the-agents-instructions)).
- **`build-image` after each upgrade**, with the runner stopped, natively and in Docker: the image holds pi at its pinned version and Gondolin's own programs for the VM, and an upgrade can change either.

## Development

The code and its tests run as an ordinary user, without `setup`: Node ≥ 22.19, git and `npm ci`. Switching users and setting owners is then skipped, with one warning. The runner commits with git, and its tests fail without it, rather than skip. The tests of `show` give Node the zone rules that ship with the runner through `ICU_TIMEZONE_FILES_DIR`, which Node's own builds take (`test/tools/icu-tz.test.mjs`). `DATA_DIR` and `CONFIG_DIR` point the services at folders of your own. How the code and its tests are written, and what "done" means, is in [AGENTS.md](AGENTS.md).

**The suite** runs three ways. With wacli and restic installed, restic in the container too, every test runs in at least one of them, so only the three together check a change whole. A test that can't run where it is skips itself, and says why. Run one copy at a time: the test that runs `scooter bridge` as a process takes port 8787, and skips itself when the port is taken. The counts below were taken on 2026-11-22, on a machine with KVM, rootless Docker, and neither wacli nor restic installed.

- **Plain**, as an ordinary user:
  ```sh
  npm ci && npm test
  ```
  It needs nothing more, but the tests of real programs need them on the `PATH`: wacli, restic, `mke2fs`, `systemd-analyze` and Docker. It skips the tests that need the VM image, root, or root with `SCOOTER_ROOT_TESTS=1`, and those of a program that isn't installed. Counted: 847 tests, 788 passed, 59 skipped: 41 for the image, 8 for root, 4 for root with `SCOOTER_ROOT_TESTS=1`, 4 for wacli and 2 for restic.
- **With the VM image and KVM**, for the tests that boot VMs and run pi in them. They need QEMU, with `qemu-img`, `debugfs`, and an image built from `config/image/build.json`, which the first command builds with Docker or Podman, from the network. `sg kvm` gives the run the `kvm` group, so the VMs use KVM:
  ```sh
  node test/support/build-test-image.mjs ~/scooter-test-image
  SCOOTER_TEST_IMAGE=~/scooter-test-image sg kvm -c 'npm test'
  ```
  It skips what the plain run skips but the image. Counted, with `GONDOLIN_CPU` as below: 849 tests, 831 passed, 18 skipped, the 8, 4, 4 and 2 above, in about 3½ minutes. Without `sg kvm` the VMs run under emulation, many times slower.

  Where QEMU aborts as it starts a VM under KVM, with `PC_MACHINE: Object … is not an instance of type generic-pc-machine`, also set `GONDOLIN_CPU=max,sgx=off`:
  ```sh
  SCOOTER_TEST_IMAGE=~/scooter-test-image GONDOLIN_CPU=max,sgx=off sg kvm -c 'npm test'
  ```
  Ubuntu 24.04's QEMU 8.2.2 aborts so on a processor with SGX, such as an Intel i7-8665U, when it starts a `microvm` machine with `-cpu host` under KVM. That is what Gondolin 0.14.0 starts by default, and what the tests in `test/tools/vm.test.mjs` and `test/tools/pi.test.mjs` get: without the variable, all 21 of them fail. Gondolin takes QEMU's `-cpu` from `GONDOLIN_CPU`, and `max,sgx=off` starts under KVM and under emulation alike, where `host,sgx=off` fails the test that forces emulation. Scooter's own sandbox uses the `q35` machine ([The machine](docs/architecture/sandbox.md#the-machine)), and its tests passed with KVM without the variable.
- **As root, in a container**, for what only root does: giving files away and running programs as other users, and, with `SCOOTER_ROOT_TESTS=1`, making users, as `setup`'s own test does. It needs Docker:
  ```sh
  docker run --rm -e SCOOTER_ROOT_TESTS=1 -v "$PWD":/src -w /src node:24-trixie sh -c 'npm ci && npm test'
  ```
  It skips the tests that need the image, those of what a user can't read or write, which root can anyway, and those of programs the container doesn't have. Counted, under rootless Docker: 847 tests, 776 passed, 71 skipped: 41 for the image, 15 for what root can do anyway, 4 for wacli, 4 for `mke2fs`, 3 for restic, 2 for the users `setup` makes, which `scooter bridge` run as a process needs as root, 1 for `systemd-analyze` and 1 for Docker.

**The zone rules** the agent's VM converts times with ship in `src/runner/vm/icu-tz/`, for one release of the tz database, which `release.txt` names. To update them to a newer one, replace the four files and `release.txt` as [Updating them](docs/architecture/agent.md#updating-them) says, and run the suite.

**The live checks** in `test/live/` are run by hand. `openrouter.mjs`, with the network, runs pi in a VM, through the runner and its policy, against the real OpenRouter with a dummy key, which must answer 401, while `https://example.com` is refused. `data-mounts.mjs`, in the runner's container, checks what a run sees and may change with the data under `/data`. Each file says how to run it. A test run in the runner's container that kills a QEMU needs tini as the container's first process, the image's entry point: `--entrypoint tini`, with `node …` as the command.

## Check on the first real run

Some things can only be checked with your phone, your accounts and your keys. Set up the bot's number with `scooter pair`, Scooter's own OpenRouter key with its guardrail, the mailbox with `scooter email-check`, and the bucket with `scooter backup-init`. Then check, and tell the code where reality differs:

- [ ] A receipt photo ends up in `expenses.csv`: the model reads photos through pi's `read` tool.
- [ ] A note that fits no view, such as "a slow Sunday at home", gets its ✅, and no view changes: the prompt has the agent file nothing for it.
- [ ] A real batch runs end to end in the sandbox, with your key.
- [ ] OpenRouter's messages route accepts the `provider` fields Scooter adds for zero data retention; ZDR-only routing works for the model, and how much latency it adds.
- [ ] wacli: that its webhooks reach the bridge, signed, and a photo downloads while sync runs; how an edit and a deletion of yours arrive, `FromMe` and `Chat` included ([wacli's formats](docs/architecture/whatsapp.md#waclis-formats)); `send react --sender` in a one-to-one chat; that you are recognized when your messages come from an `@lid` ID; that a text with a link, sent with `--no-preview`, arrives without a preview and wacli fetches nothing for it (to tell, send a text with a link to a name that can't resolve, such as `https://scooter-check.invalid/`: without the flag wacli prints its `link preview skipped` warning, and with it none); how `send text` and `send react` fail while wacli can't reach WhatsApp, and whether 8 attempts, and dropping the quote from the fifth, fit those failures; and what the two return as `id`.
- [ ] WhatsApp after downtime: stop the bridge for a few minutes, send messages meanwhile, start it again, and check that each is stored once, in its order, and handled. This is catch-up with the real wacli ([Catch-up](docs/architecture/whatsapp.md#catch-up)): how wacli stores and lists your chat after downtime; that the bot's own rows carry the time they were sent; and, if your messages come from an `@lid` ID, that each chat is listed from its own place. Look at `wacli messages changes` then too, which could close the case catch-up leaves (see [Known limits](#known-limits)).
- [ ] Email: IDLE with the app password, over TLS; the `Authentication-Results` header and its `dmarc=` result, as `email-check` shows them; your own mail passes DMARC; a forwarded booking and an audio attachment are parsed.
- [ ] A backup to the real bucket, and a restore of it into an empty folder; and that the restore has no `bridge/status/`, which `--exclude` leaves out.
- [ ] `sudo scooter status` on the installed machine, with the bridge running and with it stopped.
