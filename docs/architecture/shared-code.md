# Shared code

`src/common/` holds what both services, and the email reader, need. This document covers the part of it that belongs to no other component: files, running programs, one service per data folder, logging, time and the paths of the data folder. The formats the services share are each with the component that owns them, as [the map](../ARCHITECTURE.md#the-map) lists them, and so are the settings and the constants. Nothing here holds behavior that belongs to one side.

## Files

- `src/common/files.mjs`: atomic files, sortable IDs, the folder hand-off, and reading, copying and removing in a folder another program controls.
- `src/common/proc.mjs`: running other programs, as other users, and supervising them.
- `src/common/instance.mjs`: one service per data folder, by a Unix socket.
- `src/common/log.mjs`: logging.
- `src/common/time.mjs`: the clock, UTC times, and the owner's time zone.
- `src/common/paths.mjs`: every path in the data folder and the config folder.

## Atomic files and hand-offs

Two services and several programs share Scooter's folders, so a reader must never see half of anything.

- **A file** is written under a temporary name, synced, and renamed into place (`writeFileAtomic`); state files are written so.
- **A folder handed from one program to another**, an outbox entry ([Outbox entries](exchange.md#outbox-entries)) or a mail spool folder ([The spool](email.md#the-spool)), is made as `.tmp-<id>`, filled, synced, and renamed to `<id>` once complete (`handOff`). If the name is taken, at either step, it takes the next ID: two processes write outbox entries with the same code. `listHandOffs` gives the finished folders in order. Readers pass over names that start with a dot, and `.tmp-` is the prefix of everything unfinished.
- **IDs** (`createIds`) are the UTC time to the millisecond and a four-digit counter that starts at 1 with each millisecond: `20261109T155015123-0001`. IDs from one generator always go up, even when the clock goes back. `isId` tells a name that is an ID, and `startsWithId` one that starts with one.
- **Folders.** `ensureDir` makes a folder with a mode and an owner; `settleFolder` sets a folder's mode and owner through what it opened, without following a link, as a folder (`O_DIRECTORY | O_NOFOLLOW`), and throws, changing nothing, at a link or anything that isn't a folder (Linux answers `ENOTDIR` for a link opened so, not `ELOOP`). `ensureDir` sets every folder it makes so. Without an owner, as when not root, owners are left alone.

## Files another program controls

The first five are what the bridge, as root, uses in a folder another user controls; when it uses them is in [Folders other users control](../ARCHITECTURE.md#folders-other-users-control). The last two are the runner's, for what pi wrote.

- **`copyUntrustedFile`** copies a file another program wrote into a folder of Scooter's own, and **`readUntrustedFile`** reads a small one. Each opens it without following a link at the end of its path and without waiting for a writer (`O_NOFOLLOW | O_NONBLOCK`), and takes it only if, on what was opened, it is a regular file with exactly one name, of at most the size it is given, and, when an owner is given, that user's. A link, a hard link to someone else's file, a FIFO, a device, or something huge is refused, with the code `EUNTRUSTED`, or `EFBIG` for the size. A copy is written under a temporary name beside its target, synced and renamed into place.
- **`readUntrustedStart`** reads at most the start of such a file, as the header block of an email whose file may be large.
- **A file replaced by a rename as it was opened** has no name left, and isn't a hard link to anything: it is opened again, once. Found so again, it is refused, as `a file replaced as it was opened, twice`. *Why:* the email reader writes its `state.json` so, and the runner its `status.json` and `state.json`, which `/status` reads. On ext4 a name can still lead to the old file, with no name left, for the moment the rename takes, so the second open often doesn't find the new one; on tmpfs it nearly always does. *Cost:* little: the window is microseconds, the writers replace their files about once a minute, only `/status` reads then, and a refusal is the safe side.
- **`checkOwnFolder`** checks that a folder is a folder, not a link to one, and, when an owner is given, that user's. Otherwise it throws, with `EUNTRUSTED`.
- **`removeHandOff`** removes a handed-over folder by the names its writer gives the files in one: each such name is unlinked, which neither follows a link nor removes a folder, and then the folder, which goes only once it is empty. Nothing else is removed, and a folder holding anything else is left.
- **`removeTree` and `emptyFolder`** remove what pi wrote, however deep it goes and whatever it holds, and make nothing new: `removeTree` a folder and everything under it, and `emptyFolder` everything in a folder, which it leaves. Neither follows a link, uses git or has a time limit. When the runner uses them is in [A run](run.md#a-run) and [The clean-up](run.md#the-clean-up), and the facts of Node and Linux they rely on are in [Facts about git, Node and Linux](run.md#facts-about-git-node-and-linux).
  - Each folder is given back the runner's read, write and search before it is read, since pi can take them away.
  - Each folder is read as a stream, and each entry is removed as it comes, so a folder of millions of names costs time, not memory.
  - Each entry is reached by its path, so a folder whose path would pass 767 bytes is first moved to the top of what is being emptied, under a short name (`moved-<n>`), and emptied from there. Every path then stays within what Linux takes, and what macOS takes, 1,023 bytes, since a name is at most 255. The folders being read are kept in a list, not one call inside another. 767 isn't a tuning number: it follows from what the system takes, not from a choice of how Scooter behaves, so it is in `files.mjs`, with how it is worked out.
  - An entry it can't remove is passed over, so the rest still goes, and the first error is thrown at the end.
  - *Cost:* time: 900,000 files take about 6 seconds and 105 MB, and a chain of 100,000 folders 3 seconds and at most about 380 open folders.

## Running programs

`proc.mjs` is the only module that imports `node:child_process` ([The code's layers](../ARCHITECTURE.md#the-codes-layers)).

- **A program is started from an argument list**, never through a shell.
- **Its environment is exactly what the caller gives**, empty by default. Nothing is inherited, so a secret reaches only the program it is meant for. A bare name is looked up on the `PATH` of the process that starts it (`findProgram`), since the environment a program is given may have no `PATH` at all.
- **It can run as another user**, which needs root. A process that isn't root skips the switch, finds no user (`lookupUser` returns null), and logs one warning for its life (`proc.not_root`); whoever gets null leaves file owners alone. *Why:* that is how Scooter runs in development and in most tests; an installed Scooter, native or in Docker, always has its users. `lookupUser` asks `id -u` and `id -g`, which every Unix has: Node has no call for it.
- **It is stopped as a process, not a group:** `SIGTERM`, then `SIGKILL` after `STOP_GRACE`, to the program itself. It stays in Scooter's process group, so whatever stops the service's group stops it too. A program that was stopped is waited for until it exits, and then its pipes are closed from Scooter's side, so a stop takes at most `STOP_GRACE`, whatever the program left behind. A program that ends by itself is waited for until its output closes, so all of it is collected.
- **A timeout** stops a call that runs past it.
- **Supervised** programs (`supervise`), such as wacli's sync and the email reader, are started again whenever they exit, after waits that start at `RESTART_BACKOFF`'s first and double up to its longest. The wait goes back to the first after a run as long as the longest wait: a program that ran that long was working. A program that can't be started is tried again with the same waits. A hook can be awaited before each start, restarts included.
- **Logs name the program,** never its arguments or its environment: wacli's command line carries the webhook secret.
- `inDocker` tells whether the process runs in a Docker container, by `/.dockerenv`.

## One service per data folder

`holdInstance` makes sure only one holder runs on a data folder: it listens on a Unix socket in its own folder. A second finds the socket answering and refuses to start, with the code `EINSTANCE`, naming who holds it; a socket left by one that was killed doesn't answer, and is replaced. `instanceAnswers` says whether something holds a socket, without taking it.

- The bridge holds `bridge/bridge.sock` ([Starting up](bridge.md#starting-up)).
- The runner's socket, `runner/runner.sock`, is held by the runner, a rebuild or `build-image`, so only one of them works on a data folder at a time ([Starting up](runner.md#starting-up), [Rebuild](rebuild-and-backfill.md#rebuild), [build-image](sandbox.md#build-image)). Backups and `restore` look at it ([The locks](exchange.md#the-locks), [Restore](backups.md#restore)).

*Why a socket:* a lock file holding a pid can mistake an unrelated process that got the same pid for the service, as happens in a container started afresh, and then the service never starts. A socket answers only while its holder runs, and works across containers that share the folder. A connection is queued by the system, so a holder whose own work keeps it from taking one still answers, while the queue has room. *Cost:* two holders starting at the same instant over a dead socket could both replace it; starting a service is its service manager's job, so that is accepted.

## Logging

Every log line is one JSON object on stderr: `at`, `level`, `component`, `event` and the caller's fields. stderr leaves stdout to the CLI commands that print results.

- **Logs carry no content:** IDs, kinds, sizes and timings, never message text or file contents. That rule is the caller's to keep, in every component, and three things here make the common slips harmless:
  - a field named `text`, `subject` or `quoted`, the content fields of a datastore line, is written as `[withheld]`, so logging a whole line leaks nothing;
  - a field's value is a string, a number, a boolean, null, or a list of those; anything nested is written as `[object]` or `[array]`;
  - `errorFields(error)` gives an error's name, the system's code and call, and, for a program that failed, its exit code and whether it timed out, without its message, which can quote what was being parsed.

## Time

Everything Scooter stores or compares is in UTC, and the owner's time zone is used only where the owner sees or sets a time ([The owner's fixed choices](../ARCHITECTURE.md#the-owners-fixed-choices)). Code never depends on the process's own time zone: it stores UTC, and converts to `SCOOTER_TZ` explicitly, for a named IANA zone, through `Intl.DateTimeFormat`, with Node's own zone data and no library.

- **The clock** is two functions, which everything that waits or reads the time takes: `now()`, in milliseconds, and `sleep(ms, { signal })`, which rejects when the signal aborts. *Why:* polling loops, backoff and timeouts are all "wait, then look again", and a test can then run through hours in milliseconds. The fake is `test/support/clock.mjs`: `advance` wakes sleepers in order, `set` moves the time either way, and `whenSleeping` waits for code under test to reach its next sleep.
- **A local time of a schedule**, `HH:MM`, or a weekday and `HH:MM`, means the earliest instant at which the zone's clock shows that time or a later one. A time that comes twice when clocks go back means its first occurrence; a skipped time, the instant of the jump: on a day when 02:00 becomes 03:00, 02:30 comes due at 03:00. Each local date gives a schedule one instant, so a daily task runs once on either kind of day, and a date the zone skips altogether has nothing due. *Why:* a daily backup or check-in must neither be skipped nor run twice; running at the jump is what cron does with a skipped time. `nextLocalTime` finds the next instant, and `previousLocalTime` the last, by the same rule.
- `shortLocalTime` is how a time is shown to the owner in a short line, in their zone: `21:13` on the zone's date of now, `Sun 8 Nov 20:02` on another date of the same year, and `Sat 8 Nov 2025 20:02` in another year.
- `isTimeZone` takes only an IANA zone that Node knows, written as the tz database writes it, each part beginning with a capital letter, so `asia/kolkata` and offsets such as `+05:30` are refused. *Why:* pi's `TZ` is looked up as a file in the VM's tz database, where names are case sensitive and offsets aren't names, so `asia/kolkata` would quietly mean UTC there. Node's own name for a zone isn't used instead: Node 22 turns `Asia/Kolkata` into `Asia/Calcutta`, ICU's name, which Ubuntu's zone files lack without `tzdata-legacy`, and which the owner would then see in prompts.

## Paths

`makePaths` in `paths.mjs` gives every path of the data folder and the config folder, from `DATA_DIR` and `CONFIG_DIR`, and every module takes its paths from there. The folders, and who owns each, are in [Folders and their owners](../ARCHITECTURE.md#folders-and-their-owners).
