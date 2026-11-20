# Backups

The bridge backs Scooter up with restic to an S3-compatible bucket, Cloudflare R2 or Backblaze B2, encrypted before it leaves the machine: nightly at `BACKUP_TIME`, on `/backup`, and on `SIGUSR1`. It also restores. The backup logic is a module of [the bridge](bridge.md), and restic is the only program it runs. That backups are restic, nightly and encrypted, and that consistency comes from stopping the writers, not from snapshots, is [the owner's fixed choice](../ARCHITECTURE.md#the-owners-fixed-choices).

*The owner's answer*, 2026-11-15: the backups are a Node module in the bridge that runs restic directly, in place of a shell script, with the same CLI commands and behavior, so there is one language and one test framework.

## Files

- `src/bridge/backup.mjs`: the backup module, the only code that runs restic: its operations, `init`, `run`, `snapshots`, `check` and `restore`; the bridge's backups, with their schedule, locks, results, replies and notices; and the CLI commands `backup-init`, `snapshots`, `check` and `restore`.

## Settings

In `bridge.env`. Without `RESTIC_REPOSITORY` backups are off; the backup settings are read only with backups on.

| Variable | Default | Meaning |
|---|---|---|
| `RESTIC_REPOSITORY`, `RESTIC_PASSWORD` | required for backups | The restic repository and its password. R2: `s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>/scooter`; B2: `b2:<bucket>:scooter` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` | `AWS_DEFAULT_REGION=auto` | R2's credentials; or `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY` for B2 |
| `BACKUP_TIME` | `03:30` | `HH:MM` in `SCOOTER_TZ`, or `off` |
| `RESTIC_KEEP_DAILY`, `RESTIC_KEEP_WEEKLY`, `RESTIC_KEEP_MONTHLY` | `7`, `4`, `12` | The snapshots kept |
| `FORCE_CHECK` | `0` | `0` or `1`. `1` runs `restic check` after every backup, not only on Sundays |
| `RESTORE_TARGET` | `/` | Where `restore` puts what it restores, an absolute path: each folder at this folder joined with the path it was backed up from, so `/` puts it back |

`FORCE_CHECK` and `RESTORE_TARGET` are settings like any other, so the environment wins over the file: `RESTORE_TARGET=/tmp/look scooter restore` works for one restore. `bridge.env` and `runner.env` aren't backed up; the owner keeps `RESTIC_PASSWORD` in a password manager, since without it no backup can be read.

## Running restic

- restic runs directly, with its arguments as a list, never through a shell, as the bridge's user, root in an install, found on Scooter's own `PATH` ([Running programs](shared-code.md#running-programs)).
- **Its environment** is `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, the bucket's credentials (`AWS_*` or `B2_*`), `TMPDIR`, the bridge's own temporary folder, and `TZ`, and nothing else. `TZ` is UTC, so restic writes a snapshot's time in UTC, except for `snapshots`, whose list the owner reads, which gets `SCOOTER_TZ`.
- **Its cache.** The nightly backup keeps restic's cache in `bridge/backup-cache/`, which restic marks with a `CACHEDIR.TAG`, so `--exclude-caches` leaves it out of the backup. The CLI commands use `--no-cache`. *Why:* without a home or a cache folder restic stops before it does anything, and a cache saves the nightly backup reading the repository's index from the bucket; `restore` mustn't keep one, since it can delete inside `bridge/`, where the cache is.
- **Each CLI command** exits with 2, saying so, when `RESTIC_REPOSITORY` isn't set; without `RESTIC_PASSWORD` the settings stop it with 2 already.

## What a backup holds

`run` is:

```
restic backup <data>/datastore <data>/agents <data>/wacli <data>/bridge <data>/mail <data>/runner/log <data>/exchange/outbox \
  --host scooter --tag scooter --group-by host,tags \
  --exclude <data>/wacli/cache --exclude <data>/agents/.discarded --exclude-caches
restic forget --host scooter --tag scooter --group-by host,tags \
  --keep-daily <RESTIC_KEEP_DAILY> --keep-weekly <RESTIC_KEEP_WEEKLY> --keep-monthly <RESTIC_KEEP_MONTHLY> --prune
```

and `restic check` when the backup starts on a Sunday, the ISO weekday `RESTIC_CHECK_WEEKDAY`, in `SCOOTER_TZ`, or after every backup with `FORCE_CHECK=1`. "Sunday" is the owner's day, as `BACKUP_TIME` is the owner's time.

- **In:** the datastore, the agents' folders, wacli's folder without its cache, the bridge's folder (its state, its own outbox and its sending files), the email reader's folder, the network log, and the runner's outbox.
- **Out:** the env files, the VM image, which `build-image` makes again, the locks, caches, and `agents/.discarded/`, which holds what the runner's clean-up is removing ([The clean-up](run.md#the-clean-up)). `exchange/locks/` isn't held: a lock restored would hold runs or backups back.
- **A folder that isn't there**, such as `mail/` with email off or `runner/log/` before the first run, is left out of restic's command line. *Why:* restic exits with 3 for a folder that isn't there, and every night would be a failure.
- **One group.** Scooter's snapshots all have the host and the tag `scooter`, and `--group-by host,tags` makes them one group, whatever folders each holds. *Why:* restic groups by host and paths unless told, and `forget` applies the retention to each group, so when a folder first appears, or email is turned on or off, the last snapshot of the old folders would stay for good, the newest of its group; and `backup` picks its parent the same way, and without one reads every file again.

## Consistency

A backup stops the writers for as long as restic reads:

1. Take `backup.lock`, then wait for `run.lock` to go, or for the runner that holds it to be gone ([The locks](exchange.md#the-locks)).
2. Stop delivery, between two messages; then the channels, wacli's calls in progress and the email reader among them ([Downloads](whatsapp.md#downloads), [The email reader](email.md#the-email-reader)); then wait until intake has stored what it was handed (`intake.idle()`). What a stop does to a download in progress is in [Intake](bridge.md#intake).
3. Run the backup.
4. Start the channels again, telling intake each one starts, then delivery, and release the lock. Catch-up then collects what arrived meanwhile ([Catch-up](whatsapp.md#catch-up)).

*Cost:* while a backup lasts, WhatsApp, email and the replies stop, and the runner waits.

## Results

- **The steps run in order, and the first that fails ends the backup.** *Why:* a forget or a check after a backup that failed would prune or check without a new snapshot.
- **The snapshot ID** is read from restic's `snapshot <id> saved` line. A backup that exits with 0 without that line fails. restic's exit code 3 saves a snapshot without the files it couldn't read: the backup fails, with that snapshot.
- **A step that takes longer than `RESTIC_TIMEOUT`** is stopped, and the backup fails. *Why:* the channels are stopped and the runner waits for as long as a backup lasts, so a restic that hung would stop Scooter for good. A first backup of years of photos over a slow uplink can take hours, and what it uploaded is used again by the next.
- **The reason** is said in words for restic's exit codes 10, 11 and 12; otherwise it is restic's last line on stderr, `Fatal: …`, cut to `REASON_MAX_CHARS`. It goes into the reply or the notice and the bridge's state, never into the log, which has the step, the exit code and the snapshot's ID: restic's words can quote what it was reading.
- **Who is told.** A backup the owner asked for with `/backup` always replies, with the snapshot ID or the error, also when the bridge stops it. A backup the owner didn't ask for by message, scheduled or by `SIGUSR1`, says nothing when it works, and when it fails sends the owner a notice, unless a `/backup` that joined it got the reply. Replies and notices are the bridge's own entries ([The bridge's own entries](delivery.md#the-bridges-own-entries)); one that can't be written is tried again after the waits of a command's reply ([Commands](bridge.md#commands)). *Cost:* a restic that fails at every try, as a bucket that refuses it would make, is a notice a night.
- **A bridge that stops during a backup** stops restic, starts nothing again, releases `backup.lock`, and tells each `/backup` that it was stopped; such a backup isn't recorded as one that failed. The backups' stop is over only once every backup asked for is told: one that ended as the stop came keeps its result and writes its replies first, though a new request no longer joins it.

## When backups run

- **Nightly** at `BACKUP_TIME`: the next backup is `nextLocalTime` of `BACKUP_TIME` in `SCOOTER_TZ` ([Time](shared-code.md#time)), worked out at the start and after each backup. So a bridge started after the day's time backs up the next day, a time that comes twice when the clocks go back comes due once, and a skipped one at the jump. The bridge sleeps until that instant, and sleeps again if the clock was set back meanwhile. *Cost:* a machine that sleeps through the time backs up when it wakes, late.
- **`/backup` and `SIGUSR1`** start one at any time, `BACKUP_TIME=off` or not, and a request during a backup joins it, whatever started it.
- **Backups off.** Without `RESTIC_REPOSITORY`, backups are off, with a warning at startup (`backup.off`) instead of failing every night; `/backup` says they are off, and `SIGUSR1` is logged and does nothing.
- **`SIGUSR1` is for the bridge alone.** The bridge listens for it from its start, since without a listener Node answers it by opening its debugger; it can't take `--disable-sigusr1`, with which its own listener isn't called. The email reader ignores it ([The email reader](email.md#the-email-reader)). How to send it, natively and in Docker, is in the README's [Backups and restore](../../README.md#backups-and-restore).

## Asking for a backup

`/backup` starts a backup, or joins the one in progress, and counts as handled at once; its reply, `about` the command, is written when the backup is over. *Why:* the bridge answers commands one at a time ([Commands](bridge.md#commands)), and a `/backup` that waited for its backup, which waits for a run, would hold back a `/status` sent after it, the one that says a backup is in progress. *Cost:* a bridge that crashes during a backup doesn't answer the `/backup` that started it; keeping the request in the bridge's state, to answer it after a crash, would have a crash that a backup causes start one at every start.

## What the bridge keeps of a backup

`lastBackup` in the bridge's state is `{ at, ok, snapshot, reason }`: the backup's start, whether it worked, the snapshot, and why it failed, in restic's words where it gave any, which no log holds. `/status` says, for example, `Backups: last 03:30, snapshot 1a2b3c4d. Next Tue 10 Nov 03:30.`, or that the last failed and why, `none yet`, that one is in progress and since when, and whether it waits for the agent's run to end, that none is scheduled because `BACKUP_TIME` is `off`, or that backups are off, and why.

## The CLI commands

- **`backup-init`**, `snapshots` and `check` take no arguments; `restore` at most a snapshot's ID, eight to 64 hexadecimal digits, or `latest`, and `--force`, once each. Each passes restic's own output on, and ends a failure with a line that says why, in words for restic's exit codes 10 to 12.
- **`backup-init`** is safe to repeat: it runs `restic cat config` first, and says nothing was changed when the repository is there.

## Restore

`restore [snapshot] [--force]` restores the latest snapshot, the newest with the host and the tag `scooter`, unless one is named.

- **Only a snapshot whose folders are those of one data folder** is restored, whatever its tags say. It is one call, `restic restore <id>:<that folder> --target <RESTORE_TARGET>/<that folder>`, limited to the snapshot's folders by `--include`, with `--delete` and `--ownership-by-name`, and without a cache.
- **The destination** is each folder the snapshot holds, at `RESTORE_TARGET` joined with the path it was backed up from; one that isn't there, or is an empty folder, is empty. A destination that isn't empty is refused without `--force`.
- **With `--force`, each folder the snapshot holds becomes the snapshot's:** restic deletes what the snapshot doesn't hold inside those folders, and nothing outside them, such as `runner/image/`. *Why:* a datastore restored over a later one would otherwise keep the later days' logs after a shortened one, a gap in `seq` that stops the bridge ([Starting up](datastore.md#starting-up)). restic's `--delete` with a target of `/` would delete everything in `/` the snapshot doesn't hold; limited to the folders included, it deletes nothing else.
- **Owners and modes.** The folders between, `runner/` and `exchange/`, get the owners and modes they had, and every file its owner by name, so a machine whose users `setup` made with other numbers gets them right. *Why:* restoring each folder on its own, `<id>:<folder>`, would make a new one root's, 0700, which the runner couldn't enter. The data folder, if restore makes it, gets its mode of [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners).
- **It refuses**, with exit code 2, and asks nothing of restic but the listing of snapshots:
  - to write into the data folder of `DATA_DIR` while the bridge or a runner holds its socket ([One service per data folder](shared-code.md#one-service-per-data-folder)). Restoring elsewhere, with `RESTORE_TARGET`, the services may run;
  - as root, while any of Scooter's three users isn't there, whatever the target, and says to run `setup` first. *Why:* restic gives a file whose owner's name isn't a user there to root, and says nothing, so a restore before `setup` on a new machine, the case a restore is for, would leave the runner unable to enter the agent's folder, and wacli its own. Not root, no file gets another owner, and it goes on;
  - while `runner/` or `exchange/` in the destination is a link, or isn't a folder, looked at without following a link. *Why:* restic replaces a link at a folder it restores, or inside one, but follows one at a folder between, writing and deleting where it leads. One that isn't there is fine: restic makes it. The data folder itself, and the folders above it, may be links: where the data lives is the owner's choice, as `RESTORE_TARGET` is.
- It exits with 0 once restored, and 1 when restic fails.
- *Cost:* a snapshot made with another `DATA_DIR` is restored at that one, under `RESTORE_TARGET`; moving it is the owner's. Nothing keeps a service from starting during a restore: the README says to stop both. A restore as root only to look at a backup elsewhere needs the users too, so on a machine without Scooter it also comes after `setup`.


## Facts about restic 0.19.1

Found by hand on the Linux machine, and in the tests' round trip:

- **Exit codes:** 0; 1 for an error; 3 for a backup that saved a snapshot without some files, a source folder that isn't there among them; 10 for a repository that isn't there, `cat config` too; 11 for one locked; 12 for a wrong password. `check` takes an exclusive lock, and a temporary cache.
- Without `HOME`, `XDG_CACHE_HOME` or a cache option, every restic command stops with 1, "unable to locate cache directory". The cache folder holds a `CACHEDIR.TAG`, and `--exclude-caches` leaves it out of a backup.
- Without `TZ` it writes a snapshot's time in the machine's zone.
- `snapshots --json` answers `[]` and 0 for an ID it doesn't find, and for `latest` with no snapshot.
- `restore <id>:<folder>` makes its target 0700, whatever the folder was. Restoring a folder above, with `--include` for each folder wanted and `--delete`, restores those with their own modes, gives the folders between the snapshot's modes, and deletes inside the included folders only. `--ownership-by-name` as an ordinary user gives no error; as root it gives a file its owner by name, also when the user's number has changed since the backup, and gives a file whose owner's name isn't a user there to root, exiting with 0.
- It groups snapshots by host and paths unless given `--group-by`, in `forget` and in `backup`'s choice of a parent. `forget` also keeps a group's oldest snapshot while the group holds fewer days than `--keep-daily` asks for, so of two snapshots on one day, `--keep-daily 7` keeps both, and `--keep-daily 1` the newer.

What hasn't been run for real, a backup to a real bucket and a restore of it, is in the README's [Check on the first real run](../../README.md#check-on-the-first-real-run).
