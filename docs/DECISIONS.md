# Decisions

This file records what was decided while building Scooter v2, where `docs/DESIGN.md` and `docs/ARCHITECTURE.md` left something open, and what each check of the tools found. It also records the changes made to DESIGN.md while building, each with the question put to the owner and the answer. Each entry gives the question, the choice and the reason. Numbers in parentheses, such as (6.6), are sections of DESIGN.md. "Row 8" is row 8 of the table in section 8 of ARCHITECTURE.md. "The plan" is `docs/plans/completed/v2-linux-implementation/v2-linux-implementation.md`.

## Milestone 0: check the tools

Done on 2026-11-16, on the Linux machine of section 3 of the plan. No product code was written. Two outcomes went to the owner as questions, and 0.8 has the answers. What the milestone left in the repository:

| Path | What |
|---|---|
| `config/image/build.json` | The first build file for the VM image |
| `package.json`, `package-lock.json`, `.npmrc` | Gondolin 0.14.0, pinned, and `npm test` |
| `test/support/` | The scripted fake model, the helpers that boot a VM and run pi in it, sample attachments, and the script that builds the test image |
| `test/tools/` | The checks, as tests |
| `test/fixtures/pi-requests/` | What the pinned pi sends to OpenRouter, for milestone 8 |

### 0.1 How the checks were run

Every check below is a test in `test/tools/`. To run them:

```
npm ci
node test/support/build-test-image.mjs ~/ww/scooter-scratch/image
SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image npm test
```

- The pi and VM checks boot real VMs from an image built from `config/image/build.json`, and run the real pi in them with the command line and the environment of 6.6. The scripted fake model in `test/support/fake-model.mjs` answers pi's requests from inside Gondolin's request hook, so the tests use no network and no key. Without QEMU or `SCOOTER_TEST_IMAGE` they skip themselves.
- The wacli checks run the installed wacli against an empty store, and skip themselves when wacli isn't installed.
- The fixtures of pi 6 are written by a script, run by hand: `SCOOTER_TEST_IMAGE=… node test/tools/capture-pi-requests.mjs`. Running it again changed nothing in them, and neither did running it with `sessions/` hidden (D11).
- **KVM on this machine.** `agentw` is in the `kvm` group, but processes started from a session that began before the group was added don't have it, and for them `/dev/kvm` can't be opened. `sg kvm -c 'npm test'` runs the suite with the group. Without it Gondolin falls back to emulation and the same tests pass, more slowly. The results were the same both ways (0.7).
- The versions under test: Gondolin 0.14.0, QEMU 8.2.2, Node 22.23.2 on the host; in the image, Alpine 3.23.8 with kernel 6.18.63, Node 24.22.3, pi 1.5.2, git 2.52.1, ripgrep 15.1.0, fd 10.2.0, poppler 25.12.0, libheif 1.23.0, curl 8.23.0 and bash 5.3.3. wacli is 0.26.0 and restic 0.19.1.

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

**The image** builds with Gondolin's container build under rootless Docker, as `agentw`, with no root: about 15 seconds, 528 MB. It boots in about 1.8 seconds with KVM.

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
*Reason:* 8.3 and gate G1 install with `--ignore-scripts`. Two of Gondolin's dependencies, `ssh2` and `cpu-features`, compile native add-ons in their install scripts. A plain install on this machine, which has a compiler, built both, and a production install has neither. With the setting, development runs what production runs. All the checks below passed on an install made this way.

**D4. The checks are tests, kept in `test/tools/`.**
*Question:* where the milestone's checks live once they have been run.
*Choice:* as `node:test` tests that assert what was found, and skip themselves where they can't run.
*Reason:* the plan's risk table makes them the suite to run again after upgrading Gondolin or pi. A test that states the outcome fails when the outcome changes. A note in this file would not.

**D5. `config/image/build.json` says what is in the image, not how it is built.**
*Question:* Gondolin's build config also takes the architecture and a switch for its container build.
*Choice:* the file leaves both out. Whoever builds fills them in: the architecture is the machine's own, and the container build is used when the builder isn't root (row 8). `test/support/build-test-image.mjs` does this for the tests, and `build-image` will in milestone 7.
*Reason:* the plan asks for architecture-neutral code, and row 8 chooses between a native and a container build at build time. *Cost:* the file isn't a complete Gondolin config, so `gondolin build --config` doesn't take it as it is.

**D6. Alpine 3.23.8.**
*Question:* which Alpine release to pin.
*Choice:* 3.23.8, the newest fix release of the 3.23 branch.
*Reason:* 3.23 is the branch Gondolin 0.14.0 builds from by default, at 3.23.7, and the one the prototype of 13.4 used. Packages come from the branch's current index whatever the pin says, so the newest fix release is the one whose base matches them. 3.24 is the newer branch, and nothing here was tried on it.

**D7. Two packages beyond the list in 6.12: `tzdata` and `curl`.**
*Question:* 6.12 lists Node, pi, poppler, libheif, git, ripgrep and fd.
*Choice:* the image also has `tzdata` and `curl`. The rest of the list is `npm`, which installs pi, and the base packages of Gondolin's own default list: `linux-virt`, `rng-tools`, `bash`, `ca-certificates`, `ca-certificates-bundle`, `e2fsprogs` and `e2fsprogs-extra`.
*Reason:* pi runs with `TZ` set to the owner's time zone, because it writes what the owner reads (6.6). Without the zone files, Alpine's C library falls back to UTC and says nothing: `date` printed UTC under `TZ=Asia/Kolkata`, while Node, which carries its own zone data, printed the local time. With `tzdata` both agree. `curl` is what the protocol tells the agent to use when internet access is on (7.1).

**D8. The build's commands.**
*Choice:* three, in this order: `npm install --global --ignore-scripts --omit=dev --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.2`, then `npm cache clean --force`, then `git config --system --add safe.directory '*'`.
*Reason:* row 8 and 6.12. None of them runs pi or anything else npm installed. pi's version is in the install command, where the runner will read it. The image's own record of the version is `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json`.

**D9. restic and wacli were installed by hand.**
*Question:* whether to add an install script.
*Choice:* no script. The commands are in 0.2.
*Reason:* nothing else needs one yet. Gate G1 and the Dockerfile install the two in their own ways.

**D10. The fixtures cover every OpenRouter model pi knows, not only the default.**
*Question:* the policy allows only the fields and `anthropic-beta` values the pinned pi sends (6.13), and what pi sends depends on the model.
*Choice:* besides one whole session on each route, `test/fixtures/pi-requests/catalog.json` records one request for each of the 403 OpenRouter models in pi's catalog, at three thinking levels.
*Reason:* the model is the owner's to change (6.1). With the whole catalog recorded, milestone 8 can decide between allowing what the configured model sends and allowing what any model sends, and can test either.

**D11. The checks run with the mounts as 6.6 lists them now.**
*Question:* since the owner's answer (0.8, question 2), 6.6 lists `sessions/` as hidden. The checks had run with the mounts as 6.6 first listed them.
*Choice:* `designMounts` in `test/support/vm.mjs` hides `sessions/`, so every pi and VM check runs that way. One test also mounts the agent's folder without the hiding, to show what the hiding is for.
*Reason:* the checks are there to show that the tools do what the design relies on, and the design now relies on this. Milestones 7 and 8 use the same helper.

**D12. Changes to DESIGN.md made while building are recorded in this file.**
*Question:* section 8 of ARCHITECTURE.md is the record of the changes made to DESIGN.md while planning, and the plan refers to its rows by number. The owner's two answers (0.8) changed DESIGN.md again.
*Choice:* the record of such a change is its entry here, with the question and the answer. The table in ARCHITECTURE.md keeps its 17 rows, and a paragraph below it points here. So does the top of DESIGN.md.
*Reason:* rule 3 of section 2 of the plan puts what is decided while building in this file. The table's own introduction says its rows are the changes of 2026-11-15, made while planning.

### 0.4 The checks: pi

Each entry says what was run, what happened and what follows. The tests are in `test/tools/pi.test.mjs`, named as here.

**pi 1. Skills given with `--skill` load when `--no-skills` is set.**
*Ran:* the command of 6.6 with one `--skill`, in a VM whose home folder had a skill planted in each of pi's two discovery folders, `~/.agents/skills/` and `~/.pi/agent/skills/`. Then the same without `--no-skills`.
*Found:* with `--no-skills`, the system prompt offers the model exactly the one skill named on the command line, with the path of its `SKILL.md`, and the `read` tool returns that file. Without the flag, the two planted skills are offered as well.
*So:* `--no-skills` stays (6.6). It turns discovery off and leaves `--skill` alone.

**pi 2. Sessions.**
*Ran:* two runs with the same `--session-dir` and `--session-id`, each in a fresh VM, with a different system prompt file and different skills. Then a third after renaming the file, and a fourth from another working folder.
*Found:*
- pi writes one file into the session folder and nothing else: `<UTC time>_<session ID>.jsonl`, for example `2026-11-16T00-03-41-509Z_lifelog-2026-11-09.jsonl`. Its first line names the session and the working folder: `{"type":"session","version":3,"id":"lifelog-2026-11-09","timestamp":"…","cwd":"/data/agents/lifelog"}`.
- A new ID prints the warning that 6.6 says to ignore. A second run with the same ID prints nothing, sends the earlier conversation again, and appends to the same file.
- pi finds the session by that first line, not by the file's name. Renamed to `lifelog-2026-11-09.jsonl`, the file was found and continued.
- The working folder is part of the match. The same ID from another folder started a new session, in a second file.
- The system prompt is not taken from the session. A continued session is sent with the system prompt file and the skills of the current run.
- pi sends the session ID to OpenRouter in an `x-session-id` header.

*So:*
- The runner copies one file in and one file out (6.6). It may keep each session as `sessions/<session ID>.jsonl` and copy it into `run/session/` under that name. After the first run of a session, the file to take is the one pi named itself, ending in `_<session ID>.jsonl`.
- The memory section of the system prompt (6.5) is current on every run of a day's session.
- A session only continues while the agent's folder keeps its path. After a restore to another data folder, the day's session starts afresh and pi leaves a second file with the same ID. The runner must take the file pi wrote, not the one it copied in.

**pi 3. `edit` and `write` leave nothing beside the files they change.**
*Ran:* a session that writes a new file, overwrites one, writes one three folders down, and edits two, in `views/` and `memory/`.
*Found:* afterwards the two folders hold exactly the files written, as regular files, and the folders made for them. No temporary files, no dotfiles, no locks. The session folder holds the session file alone.
*So:* the file check in 6.8 will not fail ordinary runs.

**pi 4. `--no-mcp` works together with `-p`.**
*Ran:* the command of 6.6 in a VM whose home folder had an MCP server in `~/.pi/agent/mcp.json` that leaves a mark when started. Then the same without `--no-mcp` and `--no-extensions`, and with each of the two alone.
*Found:* the designed command runs to its end and never starts the server. With neither flag, pi starts the server, in `-p` mode too. Either flag alone keeps it from starting: pi ships MCP as a built-in extension.
*So:* row 13 stands, and the command keeps both flags.

**pi 5. What stdout holds, and the exit code.**
*Ran:* a normal run in which the model thinks, and speaks before its tool calls, on both routes. A 401 on both routes. A 500. Closing the VM in the middle of a run is VM 3.
*Found:*
- **A normal run:** exit code 0. stdout holds the text of the model's last message, exactly as written, leading and trailing blanks included, followed by one line break. What the model thought, and what it said before tool calls, is not printed. stderr is empty, apart from the session warning.
- **A 401:** exit code 1 after one request. stdout is empty. stderr holds the status and OpenRouter's answer on one line: `401 {"type":"error","error":{…,"message":"User not found.",…},"request_id":null}` on the messages route, and `401: {"message":"User not found.","code":401}` on the chat route. 402, 403 and 404 behave the same.
- **A 500:** pi makes three more tries, 2, 4 and 8 seconds apart, then ends as for a 401. An outage therefore costs a run about 15 seconds. A 429, tried once by hand, went the same way.
- **The VM is closed:** there is no exit code. The promise for the command is rejected (VM 3).

*So:*
- The answer to parse (6.7) is stdout as it is. Trimming each line, as 6.7 does, takes care of the line break pi adds.
- Any exit code but 0, and a rejected run, is a failure (6.9).
- The network log holds statuses only. OpenRouter's own words, which the first-failure notice quotes (6.9), are in the last line of pi's stderr and nowhere else the runner can read. That line is text from outside: it belongs in the notice to the owner, and not in Scooter's logs.

**pi 6. Every request pi makes with `--offline`, on both routes.**
*Ran:* one whole batch on each route, with thinking, an image read, tool calls and a session: `anthropic/claude-sonnet-5.5` and `google/gemini-2.5-flash`, at thinking level `low`. Then one request for each of the 403 OpenRouter models in pi's catalog, at thinking unset, `off` and `high`: 1,209 requests in one VM. `test/tools/capture-pi-requests.mjs` does both and writes the fixtures. The test runs the two sessions again and compares.
*Found:*
- pi asks for nothing but the model's answers. It made no request to any other path or host, `GET /api/v1/models/user` included.
- **Messages route:** `POST /api/v1/messages?beta=true`, with the key in `x-api-key`. pi uses it for 20 models: the 16 named `anthropic/claude-…` and the 4 aliases named `~anthropic/claude-…-latest`. The 16 `anthropic/…:batch` models go to the chat route.
- **Chat route:** `POST /api/v1/chat/completions`, no query string, with the key in `Authorization: Bearer`. The other 383 models.
- **The default model,** `anthropic/claude-sonnet-5.5`, sends the same 8 top-level fields on every turn, `model`, `messages`, `max_tokens`, `stream`, `system`, `tools`, `thinking` and `output_config`, and the two `anthropic-beta` values `mid-conversation-output-config-2026-07-01` and `thinking-binding-controls-2026-08-01`. This is what 13.2 found.
- **Across the catalog,** messages route: those 8 fields, or the same without `output_config`. The `anthropic-beta` header is one of three things: those two values, `interleaved-thinking-2025-05-14` alone, or absent.
- **Across the catalog,** chat route: `model`, `messages`, `stream`, `stream_options`, `store`, `max_completion_tokens` and `tools`, and `reasoning` for the 309 models that reason.
- **Tools:** the seven of 6.6 and no other. On the chat route each has `type: "function"`. On the messages route none has a `type`.
- **Images** go inline: a `base64` source inside the tool result on the messages route, and a `data:` URL in a user message that follows the tool result on the chat route.
- **Messages:** on the messages route pi adds a message with `role: "system"`, empty content and an `output_config` after each user turn. On the chat route the system prompt is the first message, and an assistant message carries the model's reasoning back in a `reasoning` field.
- Without `--thinking`, pi asks for its own default level, `medium`.

*So:*
- The policy's allowlists (6.13) can be taken from `test/fixtures/pi-requests/`: `messages.json` and `chat.json` hold the shape of every request of a batch and the first and last request whole, and `catalog.json` holds the fields and `anthropic-beta` values of every model.
- The policy must accept `?beta=true` on the messages route.
- An allowlist made from the default model alone refuses some other models: `anthropic/claude-sonnet-4.5`, for one, sends `interleaved-thinking-2025-05-14`. Milestone 8 chooses (D10).
- `test/tools/fixtures.test.mjs` fails, with no VM needed, when pi's version in the build file changes and the fixtures aren't captured again.

**pi 7. A 100 KB prompt argument works, and one over 128 KB fails.**
*Ran:* pi with prompts of 100,000, 131,071 and 131,072 bytes, each as one argument.
*Found:* the first two arrive whole at the model. The third doesn't start: exit code 127, `exec failed` on stderr, and no request. The limit in the VM is the same as on the host: a single argument can be 128 KB less one byte. Thirty arguments of 100 KB each were accepted together, so only the single argument matters.
*So:* row 12 stands, and `PROMPT_MAX_BYTES` at 96 KB leaves room. A prompt over the limit would look like a crash of pi, which is why the batch must stop growing first.

**pi 8. pi and its tools work when installed with `--ignore-scripts`.**
*Ran:* a session in the image built that way, calling all seven tools: `ls`, `find`, `grep`, `read` on a text file and on a PNG, `write`, `edit`, and `bash` running `pdftotext` and `heif-convert`, then `read` on the JPEG that came out.
*Found:* every tool returned its result, and both images reached the model inline. A `write` outside the writable folders came back to the model as an error, `EROFS: read-only file system`, and the run went on.
*So:* row 8 stands. pi doesn't need its install scripts, and there is nothing to ask the owner before milestone 7.

**Also found about pi 1.5.2:**
- pi refuses a flag it doesn't know: it prints `Error: Unknown option: …` and ends with exit code 1, before any request. So every run with the command of 6.6 shows that all its flags still exist, and a later pi that drops one fails at once instead of running without it.
- `--no-context-files` keeps an `AGENTS.md` out of the system prompt. Without the flag, pi loads the one in its config folder and the one in the working folder.
- `pi --help` also lists `--no-themes`, which 6.6 doesn't use. By pi's documentation, themes are colors for its interactive screen and its HTML exports.
- pi gives the commands its tools run a few variables of its own: `PI_MODEL`, `PI_PROVIDER`, `PI_REASONING_LEVEL`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_CODING_AGENT` and `AI_AGENT`. It also puts `/root/.pi/agent/bin` first on their `PATH`.

### 0.5 The checks: the VM

The tests are in `test/tools/vm.test.mjs`.

**VM 1. Mounts at the host's own paths.**
*Ran:* the mounts as 6.6 first listed them, at the paths the folders have on the host, with Gondolin's mount point moved to `/run/gondolin-vfs`: the agent's folder read-only, `views/`, `memory/` and `run/session/` writable, the datastore read-only. Then the same with the folders under `/data`, as in Docker. Then under `/data` with Gondolin's default mount point. Then with `sessions/` hidden by Gondolin's `ShadowProvider`. Since the owner's answer (0.8), that last one is how 6.6 lists the mounts, and how every check runs (D11).
*Found:*
- Reading works under the two mounts, at the same paths as on the host. Every change to the agent's folder or the datastore fails with "Read-only file system": creating, overwriting, appending, deleting, `mkdir`, `chmod`.
- The three writable folders take files, and the host sees them at once. `run/session/`, two levels down inside the read-only `run/`, works like the other two.
- Nothing else from the host is in the VM. The folders above the mounts hold only what leads to them.
- Gondolin shows every mount a second time under its own mount point, with the same protection.
- With the default mount point, `/data`, and mounts under `/data`, the VM doesn't start. `start()` fails after Gondolin's 2-minute limit.
- Mounted read-only and nothing more, the whole agent's folder is readable in the VM, `sessions/`, `state.json` and `.git` included.
- `ShadowProvider` hides a path inside a mount. With `/sessions` hidden, the folder isn't there for the VM, under Gondolin's own mount point either. It can't be made anew, and nothing can be written into it.
- No way round the hiding was found. The VM follows links itself, inside its own file system. So a link made in `views/`, `memory/` or `run/session/` that names `sessions/`, from beside it or by its full path, ends at the same missing path, and a link to a file of the host outside the mounts finds nothing. A hard link to a hidden file fails too.
- With `sessions/` hidden, pi and git work as before. pi's `ls` tool lists the agent's folder without it (pi 8), and `git status` and `git log` run (VM 5).

*So:*
- 6.6 and row 14 stand: the runner always moves Gondolin's mount point. `/run/gondolin-vfs` works. `/run` is a temporary file system that Gondolin's own boot sets up.
- 6.6 said pi never sees `sessions/`, while the mounts it listed let pi read it. The owner decided to hide the folder (0.8, question 2), and 6.6 now lists it as hidden.
- For milestone 7: the mount of the agent's folder is `new ReadonlyProvider(new ShadowProvider(new RealFSProvider(<the agent's folder>), { shouldShadow: createShadowPathPredicate(['/sessions']) }))`. The hidden path is given from the mount's own root. `startVm` in `test/support/vm.mjs` builds it this way.

**VM 2. Running a command from an argument list.**
*Ran:* `vm.exec([program, ...arguments], { cwd, env })` with fourteen awkward arguments: empty, with spaces, quotes, line breaks, `$(…)`, backticks, a leading dash, and non-ASCII text.
*Found:*
- The arguments arrive byte for byte, in the folder given, and no shell reads them.
- A command gets the variables the VM's own boot sets: `PATH`, `HOME`, `TMPDIR`, `TERM`, `PWD`, `SHLVL`, and five about certificates, which point programs at Gondolin's certificate authority. None comes from the host. That `PATH` leaves out `/usr/local/bin`, where pi is.
- Variables passed with the command are added to those, not put in their place.
- Run through `/usr/bin/env -i NAME=value … program …`, the command gets exactly the variables given. pi works that way with the list of 6.6 and nothing more: Alpine's Node trusts the system's certificates, to which the VM's boot adds Gondolin's authority.
- A missing folder and a missing program both end with exit code 127.

*So:* the runner starts pi as `/usr/local/bin/pi` with an argument list and `cwd`. To give pi only the variables of 6.6, it goes through `env -i`. Every check in 0.4 ran that way.

**VM 3. Closing the VM while pi runs.**
*Ran:* pi in the middle of a `bash` tool call that sleeps for ten minutes, then `vm.close()`.
*Found:* `close()` returned at once, in 36 ms with KVM. The promise for the command was rejected, with "server is shutting down". QEMU was gone. The temporary folder, which had held the disk overlay and five sockets, was empty, and so was Gondolin's list of running VMs. The session file pi had begun was still in `run/session/`.
*So:* a timeout closes the VM, as 6.6 says, and that is enough. The run then has no exit code, only a rejection.

**VM 4. Killing the starting process.**
*Ran:* a process in a group of its own starts a VM. It is killed alone, or with its group, with SIGKILL and with SIGTERM.
*Found:* killed alone, it leaves QEMU running, with nothing left to talk to. Killed with its group, QEMU goes too. Gondolin starts QEMU in the group of the process that started it. Either way the disk overlay, the sockets and the VM's entry in Gondolin's list stay behind.
*So:* supervision is as 6.6 says: the runner runs under something that stops its whole group. What a killed runner leaves is in its temporary folder and under its cache folder, for the next start to sweep.

**VM 5. `git log` on the read-only agent folder.**
*Ran:* a repository made as the runner will make it, mounted read-only, with `git log`, `git status` and `git commit` run inside the VM.
*Found:* `git log` and `git status` work. `git commit` fails and leaves the repository as it was. With the system's git config ignored, `git log` refuses the repository as being of "dubious ownership": the files belong to the runner's user and the VM runs as root.
*So:* the `safe.directory` line in the build file is needed, and it is enough (6.2, 6.12).

**Also found about Gondolin 0.14.0,** for milestone 7:
- `VM.create()` returns before the VM has booted. `vm.start()` waits for it.
- The folder for Gondolin's list of running VMs is fixed when its module loads: `GONDOLIN_SESSIONS_DIR`, or else `gondolin/sessions` under `XDG_CACHE_HOME` or `~/.cache`. Setting the home folder later in the same process has no effect on it. The certificate authority's folder is looked up when a VM is made, and `sandbox.mitmCertDir` sets it.
- Gondolin puts five Unix sockets in the temporary folder, with names up to 37 bytes long. A socket's path can be 107 bytes at most, so the runner's temporary folder must have a path of 69 bytes or less.
- It needs `qemu-img` as well as `qemu-system-x86_64`.
- It works when installed with `--ignore-scripts` (D3).
- Its builder unpacks Alpine's packages without recording them, so `apk info` in the image lists only the 16 packages of Alpine's base. `packages.txt` (6.12) can't come from there.
- The image's `manifest.json` holds the build config, pi's install command included, and the build time.
- With an `onRequest` hook that answers requests itself, requests to hosts outside `allowedHosts` still reach the hook: `curl` in the VM to `https://example.com`, `https://github.com` and `http://example.org` each reached the scripted fake model and got its 404. That is what makes "no request to any other path or host" in pi 6 a checked statement, and milestone 8's hook must refuse other hosts itself. A hook that passes such a request on wasn't tried. This was found by the review of milestone 0's pull request, and recorded in milestone 2 (2.2).
- In the VM, `/root` and `/tmp` are temporary file systems made at boot, each up to half the VM's memory. The root disk has about 96 MB free.

### 0.7 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-16, from a clean checkout of the branch after `npm ci`. Run again the same day after the owner's answers (0.8), with `sessions/` hidden in the checks' mounts (D11), and the results were the same:

| Command | Result |
|---|---|
| `npm test`, with no image | 14 tests pass: the fake model, the fixtures and the wacli checks. The 18 pi and VM tests skip themselves |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | All 32 pass, with KVM, in about a minute and a half |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image npm test` | All 32 pass, under emulation, in about seven minutes |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie` | The 10 tests that need neither a VM nor wacli pass, on Node 24.22.3. The container has no QEMU and no wacli, so the other 22 skip themselves |

Not verified:
- **arm64.** The machine can't run it. The build file names no architecture, and the helpers take the machine's own.
- **The real OpenRouter.** The tests send it nothing. Two requests were made by hand on 2026-11-16, with a dummy key, to see its 401 answers, and the fake model's 401 answers are copies of those. The fake's answers to other statuses, and the streams it sends, follow the formats pi accepts, not a recording.
- **A native image build as root** (gate G2). Only the container build was run.

### 0.8 Questions for the owner, and the answers

Two outcomes didn't fit DESIGN.md as it stood. Neither stopped milestones 1 to 4. The first, about wacli's link previews, is now beside its rule, in [Sending](architecture/whatsapp.md#sending). Both went to the owner on 2026-11-16, each with a proposal, through the milestone workflow (`docs/plans/completed/v2-linux-implementation/milestone-loop.workflow.js`). The owner was asked "Accept both proposals for milestone 0's two questions?" and answered "Yes, both", having been told that DESIGN.md would then be changed to match.

**2. Whether pi may read `sessions/` (6.6; before milestone 7).**
*The question, as asked:*
> 6.6 says "pi never sees `sessions/`", but the mounts 6.6 lists make the whole agent folder readable in the VM, `sessions/` included (a test shows it; pi can't change it either way). Proposed: milestone 7 hides `sessions/` from the VM with Gondolin's ShadowProvider, which a test shows to work. The other choice is to leave it readable and correct that sentence in DESIGN.md. Which do you want?

*The answer:* hide it from the VM with Gondolin's `ShadowProvider`, in milestone 7. pi does not see `sessions/`.
*What follows:*
- DESIGN.md lists `sessions/` as hidden in the mounts of 6.6. It says the same in 6.2, the controls of section 9, the runner and sandbox tests of section 10 and Gondolin's facts in 13.4. ARCHITECTURE.md says it in 2.7, 2.9, 2.10, [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners) and decision 30, and the plan in a rule of milestone 7.
- Milestone 7 builds it, the way VM 1 shows. What is hidden is part of the list of mounts. So the sandbox interface of milestone 4 carries it, a runner test checks that the sandbox is given it (section 10), and the fake sandbox leaves `sessions/` out of its folder, as the VM does.
- This milestone's checks now run with the folder hidden (D11), and all of them pass (0.7). pi doesn't need the folder.
- Only `sessions/` is hidden. `state.json` and `.git` stay in the VM, readable and not changeable, as 6.2 and section 9 have them. The protocol tells the agent it can read history with `git log` (7.1).

## Milestone 1: foundations and the datastore

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. DESIGN.md and ARCHITECTURE.md are unchanged.

What the milestone left in the repository:

| Path | What |
|---|---|
| `package.json`, `package-lock.json` | `bin`, and the four libraries pinned |
| `src/cli.mjs` | The command table of 8.4. No command is built yet |
| `src/common/` | `limits`, `settings`, `paths`, `time`, `log`, `files`, `proc`, `locks`, and `datastore/` with the line format, the reader and the index |
| `src/bridge/store.mjs` | The datastore's single writer |
| `bridge.env.example`, `runner.env.example` | Every variable of 8.2, explained |
| `test/support/` | The fake clock, a log that keeps its entries, the switches for root tests, and the checker for the import rules |
| `test/*.test.mjs` | One file for each module, and `imports.test.mjs` |

### 1.1 Decisions

**D13. The four libraries, at the versions the documents give.**
*Question:* section 4.3 of ARCHITECTURE.md says to pin a newer fix release where there is one.
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
*Reason:* Compose passes `KEY=` on as an empty variable, and the example files have such lines. 8.2 already says that an empty `EMAIL_IMAP_HOST` turns email off.

**D17. Each numeric setting has a range. The ranges are in `limits.mjs`, and the defaults are in `settings.mjs`.**
*Question:* 8.6 says a value becomes a setting only with a valid range and a test, and gives no ranges.
*Choice:*

| Setting | Range | Default |
|---|---|---|
| `BATCH_SECONDS` | 1 to 600 | 8 |
| `SESSION_ROLLOVER_HOUR` | 0 to 23 | 4 |
| `EMAIL_IMAP_PORT` | 1 to 65535 | 993 |
| `EMAIL_CHECK_SECONDS` | 10 to 3600 | 60 |
| `RESTIC_KEEP_DAILY` | 1 to 3650 | 7 |
| `RESTIC_KEEP_WEEKLY` | 0 to 520 | 4 |
| `RESTIC_KEEP_MONTHLY` | 0 to 1200 | 12 |

*Reason:* the low ends are what protects: a batch can't start on every poll, the mailbox isn't asked more than every 10 seconds, and at least one daily backup is kept. The high ends only catch slips of the hand. A range is a fixed number that protects behavior, so it is a constant (`SETTING_RANGES`). A default is the setting's own value, from the table in 8.2, so it stays with the setting's check.

**D18. `DEFAULT_CHANNEL` must name a channel. Whether the channel can send is checked later.**
*Choice:* the settings accept `whatsapp` or `email`, the two sources a line can have. The bridge's startup check, in milestone 5, refuses a channel that can't send, which leaves `whatsapp` ([Choosing the channel](architecture/delivery.md#choosing-the-channel)).
*Reason:* the core is channel-neutral, and "can send" is something a channel module knows. Milestone 5 lists that check and its test.

**D19. Other settings rules.**
- Loading returns an object and never changes the environment. A program the service starts gets only what it is handed ([Secrets](ARCHITECTURE.md#secrets)).
- Every fault is reported at once, each naming its variable. No message repeats a value, because a value may be a secret.
- Email is on when `EMAIL_IMAP_HOST` is set, and then the user, the password, the owner's addresses and the server name are required. Off, the other mailbox variables aren't looked at. Backups are the same with `RESTIC_REPOSITORY` and `RESTIC_PASSWORD`.
- `OWNER_NUMBER` may be written with `+`, spaces, hyphens and brackets, and is kept as digits. The owner's email addresses are kept in lower case, since they are compared without regard to case.
- `DATA_DIR` and `CONFIG_DIR` default to `/data` and `/config` and must be absolute paths.
- `AGENT_ACCEL=hvf` passes the settings. The runner refuses it when it picks the accelerator (6.6), in milestone 7.
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

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md and ARCHITECTURE.md changed only where they still listed as open what milestone 0 had settled.

It also settled the smaller points of the reviews of milestones 0 and 1, in code, tests and documents (2.2).

### 2.1 Decisions

**D52. The wacli stub.**
*Choice:* the wrapper first on `PATH` is a Node file whose `#!` line names this Node's own path, and it imports `test/support/wacli-stub.mjs`. Its control folder is beside it. The stub records every call (arguments, environment, user, group, pid), answers from fixtures read afresh at each call, and, running as `sync --follow`, posts the files the test puts in its `webhooks/` folder, signed with the secret on its command line.
*Reason:* 10 says shell wrappers. wacli's environment has no `PATH` to find `node` on, and `dash` adds `PWD` to the environment the stub would record, so the least-privilege test couldn't check that wacli gets exactly its six variables.
*Also:* the tests run the bridge in-process with a fake clock, and once as a real process, `scooter bridge` on the real port, which skips itself when the port is in use. As root, the tests give no users, so wacli runs as root, except one test that runs it as made-up IDs and checks the owners and modes (D32). The tests move the clock ten minutes at a time, so they give wacli calls a timeout far beyond that, except the test of the timeout.

**D53. Where the VM tests keep Gondolin's cache folder.**
*Question:* `test/support/vm.mjs` makes Gondolin's cache folder in the real temporary folder when the module loads, in every process that imports it, whether or not a VM test runs (the review of milestone 0, point 5).
*Choice:* kept as milestone 0 made it. Gondolin fixes the folder for its list of running VMs when its module loads (0.5), before any test has a folder of its own, and the folder is removed when the process exits.
*Cost:* a process that is killed leaves `scooter-vm-*` in the temporary folder. Rule 4 of section 2 of the plan has each test work in its own folder; this is one folder per test process instead.

### 2.2 The reviews of milestones 0 and 1

Both pull requests were approved with smaller points listed. Those of milestone 0 are below, with what became of each; those of milestone 1 were settled in the code of the bridge's side and the datastore, whose documents hold the rules.

The review of milestone 0 (pull request 1):

| # | Point | What became of it |
|---|---|---|
| 1 | DESIGN.md still lists as open what milestone 0 settled, and says `anthropic/*` models go to the messages route | Settled. 5.1, now [Running wacli](architecture/whatsapp.md#running-wacli), 6.6, 6.12, 6.13, 13.2 and 14 of DESIGN.md, and [Secrets](ARCHITECTURE.md#secrets), now say what milestone 0 found |
| 2 | The image's contents leave out `tzdata` and `curl` | Settled. Both documents list them, with the reason (D7) |
| 3 | wacli warns about sends closer than 5 seconds | Settled by the owner before this milestone ("Between milestones 1 and 2"). The related fact: `send text` and `send react` have `--post-send-wait`, default 2 seconds, which keeps wacli's connection open after a send, seen in the installed binary's help on 2026-11-16. Milestone 5's pacing will meet it; not run, since sending needs a paired number |
| 4 | A fact about Gondolin that pi 6 rests on isn't written down | Settled. In 0.5, "Also found about Gondolin 0.14.0", as the review found it. Not run again |
| 5 | `test/support/vm.mjs` makes a folder outside the test's own | Settled by recording the choice (D53) |
| 6 | Three findings seen by hand and held by no test | Two settled: pi 5 asserts a 429, and VM 4 that a killed VM's entry in Gondolin's list stays behind. Both pass with KVM. Left: the 2-minute default start limit, which would add 2 minutes to every run of the VM tests |
| 7 | Milestone 4 doesn't say the sandbox's mounts carry what is hidden | Settled. A rule under milestone 4 in the plan |

## Milestone 3: runner, planning

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in one sentence of 6.3, where it contradicted 5.4, now [Commands](architecture/bridge.md#commands), and 6.5 (D65).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/runner/config.mjs` | `agents.yaml` and its validation; the only module that imports `yaml` |
| `src/runner/agentdir.mjs`, `src/runner/git.mjs` | The agent's folder, git, the `.gitignore` and the first commit; `run/` before each run |
| `src/runner/state.mjs` | Reading and writing `state.json`; sessions; `/new`; what the runner does to the state when it starts |
| `src/runner/datastore.mjs` | The runner's view of the datastore: the index, and when it last saw the owner |
| `src/runner/triggers.mjs` | What the agent does next |
| `src/runner/batch.mjs`, `src/runner/prompt.mjs` | The batch, its context and its prompt; `run/system.md` |
| `src/runner/commands.mjs` | Handling the commands: the reply to the outbox, then the state |
| `src/runner/protocol.md` | The protocol of 7.1 |
| `src/common/agentstate.mjs` | The format of `state.json`, its check and its reader, for the runner and for `/status` |
| `src/common/outbox.mjs` | The format of an outbox entry, and writing one |
| `src/common/time.mjs`, `src/common/datastore/index.mjs`, `src/common/limits.mjs` | `previousLocalTime`, `isDate`, `shiftDate`; each line's number in its log, and the commands; three constants |
| `test/support/runner.mjs` | Fixtures: a datastore written from lines, a config folder, and the example of 6.5 as data |
| `test/config.test.mjs`, `agentstate`, `triggers`, `batch`, `agentdir`, `outbox`, `planning` | The tests of this milestone |


### 3.1 Decisions

**D54. `agents.yaml`: every field is required except `thinking`, and a key the format doesn't have is a fault.**
*Question:* 6.1 marks `thinking` as optional and says nothing of the others, nor of keys it doesn't list.
*Choice:* the others are required. An unknown key, at any level, is a fault that names it, as an unknown variable in an env file is (D15). The file is read as YAML 1.2 with the core schema, so `on:` is a key and not `true`, and `21:30` unquoted is a time and not 1,290 minutes, as YAML 1.1 would have them. Duplicate keys, and the warnings of the parser, such as a tag it doesn't know, are faults too. Every fault is reported at once, each as `agents.yaml, line 14: agents.lifelog.run[1].at must be …`: the file, the line, and the field's path, with lists counted from 0.
*Reason:* 6.1 lists no defaults, and a default the owner didn't write is a setting they can't see. A misspelled `reply_mod` would otherwise leave the default in force without a word.

**D55. A model is an OpenRouter ID, and not an `:online` one.**
*Choice:* `model` matches `~?provider/name[:variant]` in lowercase letters, digits, `.`, `_`, `-` and `:`, which all 403 models of pi's catalog do (pi 6). One that ends in `:online` is refused at startup, with the reason.
*Reason:* the network policy refuses such a model (6.13, section 10), so every run would fail. Saying so at startup is cheaper.

**D56. Paths in the config, and what a skill is.**
- A path is relative to the config folder, cleaned (`./`, `//` and a trailing `/` don't matter), and must name something inside the folder after links are followed. A link out of it is a fault.
- A skill's name is its folder's name, and two skills can't share one: a backfill names its skill that way, and the name is a folder in `run/config/`.
- A skill's folder holds only files and folders, and a `SKILL.md`. A link inside one is a fault at startup, and if one appears later, `prepareRun` refuses to copy it. pi sees only `run/config/` (8.5), and a copy that followed the link would show it whatever the link leads to.

**D57. `ack_reaction` is one emoji, or "".**
*Choice:* one grapheme, such as `✅`, `👍🏽` or `❤️`, with no space or control character in it.
*Reason:* a WhatsApp reaction is one emoji. A word would fail on every quiet run.

**D58. `timeout_minutes` from 1 to 120.**
*Choice:* a new constant, `CONFIG_RANGES`, as `SETTING_RANGES` is for the env files (D17).
*Reason:* 8.6 wants a range for a number the owner sets. The low end keeps a run from being cut off before pi starts; the high end is a slip of the hand, and also how long a backup can wait ([The locks](architecture/exchange.md#the-locks)).

**D59. The entries of `run`.**
- Each entry has exactly one of `on`, `at`, `once` and `backfill`, and only the keys that go with it.
- `on: new-messages` is the only `on`, and is given at most once. Without it, messages wait.
- `at` values are unique, as the plan's rule says: they are the keys of `scheduled`.
- `once` and `backfill` IDs are lowercase letters, digits and hyphens, and unique within their kind. They go into session names and commit messages (6.10, 6.11).
- `run` may be empty: an agent that runs on nothing is the owner's to configure.

**D60. What a backfill may change.**
*Choice:* `writes` is a list of at least one path, each `views/<…>` with at least one part after `views/`: a file, or a folder ending in `/`. Refused: `views/` itself, `views/days` and anything in it, `..`, `.`, empty parts, and names starting with a dot. A backfill's `skill` is one of the agent's skills, by name, other than `day-pages`.
*Reason:* 6.1 and 6.11, and names the file check would refuse anyway (6.8).

**D61. `state.json`'s format is in `src/common/agentstate.mjs` now.**
*Question:* the plan puts the formats the bridge reads in `src/common/` in milestone 4.
*Choice:* this milestone needs the format, so it is there from the start. The check is strict: every field 6.3 lists, of its type, and no other. Its additions to 6.3:
- An agent that has never run has `cursor` and `commandSeq` 0, empty lists, `scheduled` `{}`, and `session` and `lastRun` null.
- `paused` is `{ since, cause, reason, next, tries }`. `cause` is `setup` or `outage`, and `tries` counts the failed tries in a row, which the outage waits of 6.9 need. Milestone 4 fills it in.
- `retry` entries may have 0 `attempts`: after a setup error or an outage, a new item waits in `retry` with its count unchanged (6.9).
- The file is indented, for the owner who reads it, and written atomically with mode 0600.

**D62. Sessions.**
- The session's day is the owner's local date, or the day before while the local clock is before `SESSION_ROLLOVER_HOUR`. It goes by the clock, not by hours since midnight, so on a day the clocks change it still changes at 04:00.
- `session` holds the day of the newest `/new` and how many there were that day. On another day there were none. The ID is `<agent>-<day>`, and `-<n>` after the nth `/new`.
- The reply to `/new` is `by: "runner"`, `about` the command, and is sent also with `can_message: false`: the agent says nothing then, but the reply is the runner's.

**D63. Commands are handled as soon as they are seen.**
*Question:* 6.4 says commands are handled before a batch is built, and still work while paused.
*Choice:* commands newer than `commandSeq` come before anything else, on every poll, also while paused and without waiting for the quiet period. The runner writes the replies, then saves the state (row 11). The index keeps the `seq` of each command, so they are found without reading every line again.
*Reason:* a lone `/new` would otherwise wait for the next message. And handled at once, `/new` applies to all work not yet given to the agent wherever it sits among the waiting messages, as 6.4 asks.

**D64. The quiet period counts from when the runner saw the newest incoming line.**
*Question:* 6.4 says the batch waits until "the newest incoming line is at least `BATCH_SECONDS` old".
*Choice:* old since the runner saw it arrive, not since its `at`. Any `in` line counts, of any kind and any source. Lines already there when the runner starts count as seen then, so a start waits `BATCH_SECONDS`.
*Reason:* `at` is when the message was sent, by the channel's clock. A message caught up after downtime has an old one, and a batch would start while catch-up is still storing lines. An email's comes from its `Date` header, which can lie in the future, and the batch would wait until then.

**D65. Commands are never shown to the agent.**
*Question:* 6.3 said commands are context that "the agent is shown"; 5.4, now [Commands](architecture/bridge.md#commands), says commands are "never given to the agent", and 6.5's context is the `out` lines and reactions.
*Choice:* 5.4 and 6.5. The cursor moves past a command, and the prompt never shows one. 6.3 of DESIGN.md now says so.

**D66. What comes first.**
*Choice:* commands; then nothing while paused; then `once` tasks; then new messages, once the owner is quiet; then a due scheduled task; then a backfill batch. A scheduled task waits for messages that are ready, and doesn't wait for messages still in their quiet period.
*Reason:* 6.4 runs `once` tasks at startup. Messages first, because the evening check-in reports what was filed. The backfill comes last by 6.11.

**D67. Scheduled tasks.**
*Choice:* `scheduled[at]` is the owner's date of the last occurrence that has been dealt with.
- **At startup**, every occurrence up to now counts as dealt with: `scheduled[at]` becomes the date of the last one, worked out in the zone the runner starts with. So a runner that starts after the time waits until the next day (6.4), and a changed `SCOOTER_TZ` takes effect at once. Entries for `at` values no longer in the config are dropped.
- **While running**, a task is due when its last occurrence has a later date than `scheduled[at]`. One that comes due during a run or a pause is still due afterwards, and several that passed during a long pause run once.
- The runner records the date once the task has run (milestone 4). A task that fails on a setup error or an outage keeps its old date, so it stays due (the plan's rule for milestone 4). A start during a pause keeps every date as it is, so that task stays due across the start too (D83).
- `previousLocalTime` in `time.mjs` finds the last occurrence, by the same rule as `nextLocalTime` ([Time](architecture/shared-code.md#time)): a time skipped by the clocks comes due at the jump, and a time that comes twice at its first.
*Reason:* a date per task is what 6.3 stores, and comparing dates of the owner's day keeps one run a day across clock changes. Overwriting at startup instead of keeping the larger date lets a changed zone start from where it is: a date from a zone far ahead would otherwise hold the task back for up to two days. *Cost:* on the day the zone changes, a task can run twice or not at all.

**D68. `once` tasks.**
*Choice:* the runner keeps in memory which `once` tasks it has tried since it started, and `nextAction` takes that set. A task is offered when it is in neither `onceDone` nor that set. Milestone 4 adds a task to `onceDone` after it succeeds, and leaves it out of the set after a setup error or an outage, so it is the next try.

**D69. Backfills at startup, and when one is done.**
*Choice:* a new backfill starts with `until` the live cursor, its own cursor at 0, and empty lists (6.11). One whose entry left the config is dropped at startup. `nextAction` offers a backfill batch when it has work items in `(cursor, until]` or due retries and nothing live waits; and says `backfill-finished` when it has neither work up to `until` nor retries. Building a backfill's batch, and finishing it, are milestone 9's.

**D70. The batch.**
- **Covered:** a batch covers the lines up to the first work item it leaves for later, or up to the newest line. When the run succeeds the cursor moves there (6.8), past the context, the commands and the lines of sources the agent doesn't read in that stretch. So it does when the run fails, with the batch's items in `retry` (D78, milestone 4).
- **Context:** the `out` lines and reactions from the oldest item to the end of what the batch covers. A context line is shown with the message it replies to, as `you sent, in reply to #1047: "…"`.
- **Newest first:** context lines are listed newest first, as the example of 6.5 shows them, and when the prompt is too long the oldest are left out first.
- **Who sent it:** `you` for the agent's own lines, `the owner` for the owner's, and `Scooter` for the runner's and the bridge's, such as notices and replies to `/status`. The protocol explains the last.
- A retry entry whose line isn't a work item of the agent, which only a changed `reads` or a damaged state gives, is never due, and starts no batch.
- `newest`, the item an answer's plain text is `about` (6.7), is the item with the highest `seq`.

**D71. How the prompt shows a line.**
- Every text the owner or the agent wrote is a JSON string, so a line break or a quote in it can't pass for the prompt's own lines. The example of 6.5 reads the same either way.
- A file's kind comes from its MIME type: `photo`, `video`, `audio` or `document`. Further files of a message are `attachment` lines under it.
- An edit is `edit of #1051, now: "<its own text>"`, and a deletion `deletion of #1051`. A deleted message is `(deleted in #1055)` in place of its content.
- A time is `HH:MM` on the owner's day of `now`, `Sun 8 Nov 20:02` on another day, and `Sat 8 Nov 2025 20:02` in another year.
- A reply to a message Scooter doesn't have is `↳ reply to an earlier message: "<the quoted preview>"`. One to a photo shows the photo's path.
- Media that couldn't be stored is `photo, not stored (download failed)`, with the caption if there is one.
- An email is as 6.5 shows it; one that couldn't be read adds the line `email not stored (could not be parsed)`, from its `media`.

**D72. Keeping the prompt within `PROMPT_MAX_BYTES`.**
*Choice:* the batch grows one item at a time, with what each brings in, and stops before the prompt would pass the limit. When even the first item is too long:
1. if it fits on its own, the oldest context lines are left out, and a line says how many;
2. otherwise its texts are cut, as little as will do, keeping all the context if that then fits, and none if not. A cut text is followed by `(cut; the whole text is line 3 of /data/datastore/2026/11/09/log.jsonl)`, the line its current text is in, or `(cut; the whole email is …/1071.eml)`;
3. if even that is too long, as an email with hundreds of attachments could be, the prompt is cut at the limit, and says so.
*Reason:* 6.5 and row 12. The context's texts are never cut, since each is a sent chunk or a reaction; the item's are, and so are the quoted messages under it. The index now keeps each line's number in its day's log, so the prompt can say where the whole text is.

**D73. The memory in the system prompt.**
*Choice:* `memory/preferences.md` and `memory/needs-review.md` are opened without following a link, and only a regular file is read, at most `MEMORY_MAX_BYTES` (64 KB) of each, a new constant. Otherwise the section says the file wasn't read, or was cut and should be shortened.
*Reason:* pi writes the memory folder. A run that leaves a link there fails and is cleaned up (6.8), but a runner stopped before the clean-up would read the link at its next run, and a link to `runner.env` would put the OpenRouter key into the prompt. A file that grew without bound would make every request too large, and no run could then shorten it.

**D74. `run/`.**
*Choice:* `prepareRun` empties `run/` and makes `config/` (the prompt and the skills, each at its path in the config folder, so `skills/expenses` is `run/config/skills/expenses` as 6.6 has it), `session/`, and `system.md`. A file that can be run keeps that. The session is kept as `sessions/<session ID>.jsonl` and copied in under that name, if it is a regular file (pi 2). A backfill passes only its skills. Copying the session back is milestone 4's.

**D75. The agent's folder and git.**
- Each step is safe to repeat, and a start finishes what a crash left: the folders, `git init`, the `.gitignore`, and the first commit, `lifelog: initial commit`, holding the `.gitignore` alone, on the branch `main`.
- Git runs from an argument list with an environment of its own: no system or user config, no hooks, no signing, `Scooter <scooter@localhost>` as author and committer, and the time from the runner's clock. A new constant, `GIT_CALL_TIMEOUT`, one minute, bounds each command.

**D77. The protocol says a little more than 7.1.**
*Choice:* besides each point of 7.1, `protocol.md` says how the prompt shows things (the three sections, `(edited in …)`, `(deleted in …)`, JSON strings, cut texts, who `Scooter` is), that a scheduled task has no items to report on, and that the agent writes no links and no dotfiles. Milestone 11 checks it against the parser.

### 3.2 Facts found

- **YAML.** `yaml` 2.9.1 with `version: '1.2'` and `schema: 'core'` reads `09:05` as a string, `on` as a key, and `010` as 10. A duplicate key is an error, and an unknown tag a warning that the config turns into a fault.
- **A schedule's last occurrence** agrees with the next: for six zones (Kolkata, New York, London, Lord Howe, Apia and St John's), six schedules and 20 days around each of three dates with clock changes, nothing comes due between `previousLocalTime(now)` and `now`. A test holds it.

### 3.4 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-16, on the Linux machine, from clean clones of the branch:

| Command | Result |
|---|---|
| `npm ci && npm test`, Node 22.23.2 | 277 tests: 252 pass, none fail. 25 skip themselves: the 18 that need the image and the 7 that need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 270 pass, none fail, in 111 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie`, with `SCOOTER_ROOT_TESTS=1`, on a second clone | Node 24.22.3: 253 pass, none fail. All 7 root tests run. 24 skip themselves: 18 need the image, 4 need wacli, 1 is about a file root can read anyway, and `scooter bridge` as a process, which as root needs the users `setup` makes |
| This milestone's tests, with `time` and `datastore`, 32 times, 8 at once | No failure |

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Where |
|---|---|
| Runner: batching after the quiet period | `triggers.test.mjs`; `planning.test.mjs`, from files |
| Runner: the batch's two limits, 20 items and the prompt's size, with an over-long item shown cut | `batch.test.mjs`: 20 items with retries first; six of ten 15 KB messages; one item cut, pointing at its line or its `.eml`; the oldest context left out; 40 random batches within a small limit; the last resort |
| Runner: context lines and reply labels | `batch.test.mjs`: you, the owner and Scooter; a reply to a photo, to a deleted message, and to a message Scooter doesn't have; forwarded; reactions and a removed one; commands not shown |
| Runner: emails in the prompt | `batch.test.mjs`: the email of [the line format](architecture/datastore.md#the-line-format) as 6.5 shows it, one that couldn't be read |
| Runner: an edit or deletion bringing in its message from `retry` or `failed`, shown as last edited | `batch.test.mjs`, also past 20 items |
| Runner: `/new`, handled once | `agentstate.test.mjs`; `planning.test.mjs`, with the reply in the outbox and the state saved before the batch. That it stays handled when the batch after it fails is milestone 4's to show, with a run |
| Runner: scheduled and `once` tasks | `triggers.test.mjs`; `planning.test.mjs` |
| Time: scheduled tasks at the right local time across a daylight-saving change | `triggers.test.mjs`: New York in autumn, London in spring and autumn, a weekly task; `time.test.mjs` for `previousLocalTime` |
| Time: a changed `SCOOTER_TZ` between restarts | `triggers.test.mjs`: Kolkata to New York, back, and a date from a zone far ahead |
| Config: each validation error names the field | `config.test.mjs`: over 50 faults, each with its field and line |
| The prompt of 6.5 as the first expected output | `batch.test.mjs` and `planning.test.mjs`, byte for byte |

Not verified:
- **pi reading these prompts.** Nothing runs pi in this milestone. The prompt and the protocol are text the model hasn't seen yet: milestone 4 runs a stub of pi, and milestones 7 and 11 the real one.
- **The runner as a service.** There is no `scooter runner` yet; milestone 4 builds its loop. This milestone's parts are tested as functions, and end to end from files.
- **arm64 and macOS.** Nothing here knows the architecture. `O_NOFOLLOW`, `mkfifo` and git's `-c` options exist on macOS.

## Milestone 4: runner, running

Done on 2026-11-17, and after the owner's answer and the fourth review on 2026-11-18, on the Linux machine of section 3 of the plan. One question went to the owner, after the pull request's third review: whether to fix only that review's two points, or the whole kind of problem they belong to. 4.7 has the question, the answer and what was done. Every other open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in three sentences of 6.4 and 6.9, for two points of the review of milestone 3, and in 6.2, 6.6 to 6.9, 8.6, section 9 and section 10, for the reviews of this milestone and the owner's answer (4.4).

The pull request's first review asked for one change: a file or folder pi makes unreadable stopped the runner. Its second asked for two: a file too large for git to add in time stopped the runner, and an empty folder stayed outside git after a successful run. Its third asked for two: enough names in a folder with nothing committed made the clean-up's `git rm` time out, so the runner stopped and couldn't start again; and the modes pi set stayed after a successful run, so later runs couldn't write. Each was a new case of one kind of problem: something pi leaves in `views/`, `memory/` or `run/` stops the runner, or makes it run the same batch again without counting an attempt. Its fourth found two more cases of it, both in the clean-up, which the owner's answer had asked to make unstoppable: a tree nested past the longest path the system takes, which pi makes by moving a folder into another, couldn't be removed, so with one in `run/session/` no run started again; and on a disk pi filled, the clean-up made folders before it freed anything, so the failed run wasn't recorded and the runner couldn't start again. Those, and the smaller points of all four, are in 4.6; what the owner decided about the kind of problem, in 4.7.

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/runner/run.mjs` | One run: the locks; pi's command, mounts, environment and network policy; then 6.8 after a success or 6.9 after a failure |
| `src/runner/answer.mjs` | Reading pi's answer (6.7), and the replies and reactions it asks for |
| `src/runner/failures.mjs` | The cause, from the network log; pauses; attempts; the state after a run; the notices |
| `src/runner/git.mjs` | Git named outright as the agent's repository; the unexpected-file check, the commit, and the clean-up |
| `src/runner/agentdir.mjs` | `git init` whenever there is no commit; `keepSession`, the session copied back |
| `src/runner/status.mjs` | `status.json` at startup, and the emulation notice |
| `src/runner/main.mjs` | Startup and the loop: `openRunner`, `startRunner` and `runRunner` |
| `src/runner/sandbox/index.mjs` | The sandbox interface, and the check of a run's spec |
| `src/common/netlog.mjs`, `src/common/runnerstatus.mjs` | The network log's format and reader; `status.json`'s format and reader |
| `src/common/instance.mjs` | `holdInstance`, moved from the bridge, for both services |
| `src/common/limits.mjs`, `src/common/paths.mjs` | Six constants; `runner/runner.sock` and `agents/.discarded/` |
| `src/common/files.mjs` | `removeTree` and `emptyFolder`, which remove what pi wrote whatever it holds and however deep it goes, and make nothing new |
| `test/support/` | The fake sandbox, the pi stub, a runner for tests, trees deeper than a path can name, and a full disk |
| `test/answer`, `failures`, `run`, `runner`, `runnerfiles` | The tests of this milestone, with additions to `agentdir`, `agentstate`, `batch`, `config`, `triggers` and others |

It also settled the smaller points of the review of milestone 3 (4.3).

### 4.1 Decisions

**D78. A run moves the cursor past its batch whether it succeeds or fails.**
*Question:* 6.8 moves the cursor after a success. 6.4 said a failed batch leaves the cursor where it was, and 6.9 puts the batch's items in `retry`. The planner takes every work item after the cursor as new, so an item waiting in `retry` after the cursor would be given again at once, as attempt 1 (the review of milestone 3, point 1).
*Choice:* after every run that finishes, the cursor moves to the batch's `covered` (D70), and the items it didn't handle wait in `retry`, which comes first in the next batch (6.5). Only a run cut short, by a crash or by stopping the runner, leaves the cursor and the state as they were. `checkAgentState` refuses a `retry` entry after its lane's cursor, the backfill's included. DESIGN.md 6.4 and 6.9 say so, and D70 points here.
*Reason:* it is what 6.5 and 6.9 describe ("due retries first, then work items after the cursor"; "those items come first"), and it keeps one meaning for "new".

**D79. The sandbox interface.**
`src/runner/sandbox/index.mjs` says what a sandbox is: `{ accel, imageBuiltAt, run(spec, { signal }) }`. A spec is `{ argv, cwd, env, mounts, timeoutMs, policy }`:
- `argv` starts with the program's name, `pi`. Where the image keeps it, and running it through `env -i` (0.5, VM 2), are the sandbox's business.
- `mounts` lists `{ path, writable, hide }`, each at the host's own path. `hide` names paths inside the mount, from its root: the agent's folder hides `sessions`. A mount inside another takes its place there.
- `policy` is `{ model, internet, zdr, secrets }`. `secrets` maps `OPENROUTER_API_KEY` to the key and the hosts it may go to, and the sandbox sets the variable to its placeholder. So `env` holds everything 6.6 lists but the key, and `checkRunSpec` refuses a spec whose `env` sets a secret's variable.
- `run` resolves with `{ code, signal, stdout, stderr, timedOut }`, `code` being null when pi didn't exit by itself: a timeout, an abort, or a VM that was lost. It rejects only when it couldn't run the command at all.

The runner opens its sandbox at startup with `openSandbox({ paths, settings, log, clock })`, after it has read the config and taken the data folder (D90), because milestone 7's sandbox checks the image, picks the accelerator and sweeps `runner/tmp` there.
*Reason:* the plan's list (an argument list, a folder, an environment, mounts, a timeout and a policy), with the hidden paths of its rule, as data that both sandboxes check the same way.

**D80. The fake sandbox and the pi stub.**
For each run the fake sandbox makes a folder that stands for the VM's root, and puts each mount at its path there: a link to the host's folder, or, for a mount that hides names, a folder of links to everything but those. So `sessions/` isn't there at all, as in the VM. It doesn't make read-only mounts read-only; milestone 7's tests show that on the VM. It runs `test/support/pi-stub.mjs` with Node, through `proc.run` and the test's clock, with the spec's environment, a placeholder for each secret, and `PI_STUB_*` variables of its own, which the stub leaves out of what it records.

The stub takes pi's command line, finds every path it is given inside the VM's folder, keeps its session as pi 1.5.2 does (0.4, pi 2), writes OpenRouter's answers to the network log in its format, and prints its answer, or fails, as pi does (pi 5). It acts on keywords in each item (`IGNORE`, `FAIL`, `ASK`, `SAY`), and anywhere in the batch or the task (`OPENROUTER=<status>`, `UNREACHABLE`, `NOANSWER`, `CRASH`, `HANG`, `DOTFILE`, `SYMLINK`, `FIFO`, `IGNORED`, `SESSIONLINK`, `NOREPLY`, `MEMORY`, `UNKNOWN`, `REPLYTO=<seq>`). A test can also set the batch-wide ones in `behavior.json`, in the stub's control folder.
*Reason:* section 10 and the plan have the stub pick its behavior from keywords in the messages. A failure that must stop so that the next try succeeds, such as a key being fixed, can't come from the message, which the next try shows again.

**D81. The network log's format is in `src/common/netlog.mjs` now, with an `error` line.**
*Question:* the plan writes the format and its reader in milestone 8, and this milestone's failure handling reads the log. 6.13 shows `request`, `response` and `refused` lines, and none for a request that got no answer, which 6.9 counts as an outage ("couldn't be reached").
*Choice:* the format and the reader are here now, as D61 did for `state.json`. A fourth event, `error`, has the request's `id`, `at`, `ms`, and a `reason` that is a short code from Scooter's own code, such as `ECONNREFUSED`. A `refused` line may also name `method` and `path`. Each line is checked strictly. The reader takes the lines whose `at` falls in a time window, counting its first second whole, across the UTC days the window spans. It skips part of a line at the end of a file and lines that aren't lines of the log, and counts them, so one bad line doesn't hide the rest. Milestone 8 writes the log, and may add to the format; the plan's milestone 8 now says so.

**D82. The cause of a failure.**
*Choice:* the runner reads the log from the run's start to its end, takes the last `request` to `openrouter.ai`, and looks for what came of it after it:
- a `response` with 401, 402, 403 or 404: a setup error;
- a `response` with 408, 429 or a 5xx, an `error` line, or nothing at all, because the run ended while it waited: an outage;
- another status, or no request at all: a failure of pi's own.

An unexpected file after a run that exited with 0 is pi's own failure, whatever the log says (6.9), and so is an error in checking or committing what it left (D88). A sandbox that couldn't run pi at all, such as a VM that doesn't boot, counts as a setup error, with the reason "the VM couldn't start": it is the machine's fault, and spending every message's four attempts on it wouldn't help.

*The short reason* is OpenRouter's error whenever its last answer was one, a status of 400 or more, whatever the cause: also a 400 or a 413, for a prompt or an image too large, which is pi's own failure (the review of this milestone, 4.6). It is OpenRouter's own words when the last line pi printed on stderr is its error for the same status (`401 {…}` or `401: {…}`, pi 5), as `OpenRouter: No endpoints found matching your data policy`, and otherwise `OpenRouter answered 429`. Without an error from OpenRouter it is `OpenRouter didn't answer`, `timed out`, `pi exited with code 3`, `pi was stopped`, or `unexpected file views/.gitignore`. OpenRouter's words go into the notice and the state, cut to `REASON_MAX_CHARS`, and never into Scooter's logs, which carry the cause and the status.

*Cost:* a run that times out while the model is still streaming its answer counts as an outage if milestone 8 writes the `response` line at the end of the stream. It is then tried every 30 minutes and never ends in `failed`. Writing the line when the status arrives avoids that; milestone 8 chooses. *Settled in milestone 8* (D158, D160): the `response` line is written when the status arrives, and a request the policy refused at OpenRouter is read too.
*Reason:* 6.9, with what milestone 0 found. The window can't take in another run's lines, because runs are at least `POLL_INTERVAL` apart (D93), so no second holds lines of two runs.

**D83. Pauses.**
`paused` is `{ since, cause, reason, next, tries }` (D61). A try that fails for the same cause continues the pause: one try more, `since` kept, and the wait that goes with it, `SETUP_RETRY_WAIT` after a setup error, and `OUTAGE_RETRY_WAITS` by the number of tries during an outage, the last repeating. Another cause starts a new pause. Any run that gets through ends it: a success, or a failure of pi's own, which means OpenRouter was answering. A paused batch's items wait in `retry` due at once, their attempts unchanged: the pause holds every run back until its next try, which a restart brings forward to the start (D67), after the usual quiet period (D64). A task that fails this way stays due (the plan's rule; D68).

A start during a pause keeps the scheduled tasks' dates as they are, instead of counting every occurrence up to now as dealt with (D67). So a scheduled task that a setup error or an outage holds back is still due after a restart, and is the try the restart brings forward; one that came due during the pause, the runner down or not, runs once the pause is over. A task new in the config starts from now, as at any start.
*Reason:* due at once needs no second date to keep in step with `paused.next` when a restart brings the try forward. Keeping the dates follows the plan's rules: a failed task "stays due, and is the next try", and one that "comes due during a run or a pause waits, and runs afterwards". Otherwise a pause that only a task held would be left with nothing to try, `next` in the past, until a message came (the review of this milestone, 4.6). *Cost:* a `SCOOTER_TZ` changed during a pause takes effect for the dates only at the first start after it.

**D84. What a run does to its items.**
- `FAILED` wins over `DONE` for the same item: the agent said it couldn't handle it. Its reason is the agent's, cut to one line of `REASON_MAX_CHARS`, or "no reason given".
- An item not reported, or in a batch that failed for pi's own reasons, has used the attempt this run was. Its `reason` in `retry` is "not reported", or the failure's short reason. After `MAX_ATTEMPTS` it goes to `failed` with "not handled after 4 attempts".
- `failed` keeps the newest `FAILED_KEEP`, in the order they were added.
- `lastRun` is `{ at, ok, seqs, durationMs }`, with `at` the run's start. A scheduled or `once` task is a live run too, with no `seqs`, so a failing task can be the first failure of a row, and one that gets through ends the row.
- A scheduled task that ran, or failed for pi's own reasons, has its date recorded; one that met a setup error or an outage doesn't.

**D85. Reading the answer.**
- Instruction words are matched exactly: in capitals, with the colon, after trimming. `DONE:` takes numbers separated by spaces or commas, each with or without `#`.
- A line that begins with an instruction's word but can't be read, such as `DONE: soon` or `FAILED:` with no number, is counted and logged, and never sent: it was meant as an instruction. A `REPLY_TO:` with no number starts a message of its own, sent without a quote.
- `NO_REPLY` anywhere means no text is sent, `REPLY_TO` texts included: 6.7 has it "send no text". Reactions still go.
- `REPLY_TO` quotes a message. One that names an edit or a deletion quotes the message it changes. One that names a reaction, a command, or a number that doesn't exist sends its text without a quote, `about` the batch's newest item, like plain text.
- The texts go to the outbox first, in order, then the reactions, by `seq`. A reaction goes to an item reported `DONE` that is a message, still there, and not answered by a `REPLY_TO`. Reacting to a message the owner has deleted would say nothing.
- In a scheduled or `once` task, `DONE` and `FAILED` are ignored and logged, and the texts have no `about`, so they go to `DEFAULT_CHANNEL` ([Choosing the channel](architecture/delivery.md#choosing-the-channel)).
- One answer sends at most `ANSWER_MAX_TEXTS` texts, 25: the first ones, which is more than a full batch needs, a question about each of its 20 items and a few lines besides. The rest are dropped, and their number logged as `runner.answer_texts_dropped`. A message whose `REPLY_TO` was dropped gets its reaction instead. An answer of 2,000 `REPLY_TO` lines became 2,000 outbox entries, nearly 3 hours of sending at one every 5 seconds (the third review, 4.6). How long one text may be is milestone 5's, which chunks it.

**D86. Notices.**
- The first failure of a row: "⚠️ I couldn't process your last messages (<reason>). I'll try again." A setup error's says instead "Runs are paused until this is fixed. I'll try again every 30 minutes." A task's names it ("run the scheduled task 21:30", "run the task poems") and says when it runs again.
- Items given up on: "⚠️ I gave up on #1051 ("coffee 120") and #1052 (a photo) after 4 attempts. Send them again if they matter." Each item is named by its text as it is now, cut to `NOTICE_QUOTE_CHARS`, or by what it holds.
- Notices are the runner's, `by: "runner"`, and go out also with `can_message: false`, as the reply to `/new` does (D62): that setting is about what the agent sends.

**D87. Sessions after a run.**
After the commit (D88), `keepSession` takes, from `run/session/`, the newest file pi named itself (`…_<session ID>.jsonl`), or else the copy under the session's ID, which pi continued (pi 2), and copies it to `sessions/<session ID>.jsonl` with `copyUntrustedFile`: without following a link, and refusing anything but a regular file with one name, and anything over `SESSION_MAX_BYTES`. It reads the folder as a stream, so a folder of millions of names costs time, not memory. Any error is a refusal: a file it can't open, such as one pi made unreadable, a name that isn't UTF-8, a socket, a `run/session/` it can't list, or a full disk. A refusal is logged as `runner.session_refused`, with the error's code, the run still counts as a success, and the session kept before stays. Then `run/session/` is emptied (`clearRunSession`), and after a failed run it is emptied first, before the clean-up (D88): either way before the run is recorded, because pi could have filled the disk there (4.7), and the folder itself stays, so emptying it makes nothing (the fourth review, 4.6). An error in emptying it is logged, and `prepareRun` tries again: it removes `run/` with `removeTree` (D88) before every run, so nothing pi leaves in `run/session/` can stop the next run, however deep it goes. A start empties `run/session/` too, before it makes any folder (D89). A scheduled or `once` task runs in the day's session too, so the evening check-in knows what the day's runs filed.

*The session after the commit.* 6.8 copied the session back before the commit. Once an error in the commit fails the run (D88), a session kept before it would remember a run that was then thrown away, which 6.6 forbids; a crash between the two did the same. Kept after it, a crash between the two leaves the views committed and the session without the run, so the next try sees the rows it filed, which is what 6.8's order is for. 6.8, and ARCHITECTURE.md 5.1 and decision 26, say so now.

**D88. The file check, the commit and the clean-up.**
pi runs as root in its VM, and what it writes in the writable folders belongs to the runner on the host, so it chooses every name, every mode, every size, how deep the folders go and the number of files there. Nothing it leaves may stop the runner, at the end of the run or at the next start, or make it run the same batch again without counting an attempt (the reviews of this milestone, 4.6, and the owner's answer, 4.7). So what the runner accepts is limited before git reads anything; what git doesn't record is put back once the check has passed; an error in checking or committing fails the run; and the clean-up can't be slowed down or stopped by what pi left.
- *Check:* `views/` and `memory/` are walked in name order, by the bytes of their names, which reaches a name that isn't UTF-8 as it is on disk, without following links. The first dot name, the first thing that isn't a regular file or a folder, the first file the runner can't read or that has more than one name, the first folder it can't read and search, the first path longer than the system takes (*Depth*, below), the name at which the files and folders so far pass `AGENT_FILES_MAX_COUNT`, or the file at which their sizes pass `AGENT_FILES_MAX_BYTES`, is the unexpected file. Then `git status --ignored=matching` names any file git ignores. Last comes staging (below), and a path git refused, such as `git~1`, or a file it couldn't read, is left unstaged and named by `git status` (4.2). Staging is part of the check because only git knows every name it refuses. The reason is `unexpected file <path>`. The path is logged cut as the reason is, to `REASON_MAX_CHARS`: it is a name pi chose, which could hold a message's words (the third review, 4.6).
- *Size:* git reads every byte of a file to add it, holes included, and a file of holes costs pi nothing: in the VM, `truncate -s 40G` took 9 ms (the second review, 4.6). git adds a file of holes at about 250 MB a second (4.2), so one past about 15 GB ran `git add` past `GIT_CALL_TIMEOUT`. So the walk adds up the sizes of the files, as the file system gives them, and the file at which `views/` and `memory/` pass `AGENT_FILES_MAX_BYTES` together, 100 MB, is unexpected. The limit is on the two folders together, not on each file, because many files each under a limit would take git as long as one large one. git adds 100 MB in about 2 seconds, and a year of views takes about 1 MB.
- *Count:* some of git's work grows faster than the number of names: `git rm --cached` of the names staged in a folder took 7.6 seconds for 300,000 and ran past `GIT_CALL_TIMEOUT` for 900,000 (4.2), and a guest makes about 1,360 files a second, so 800,000 in a default run (the third review, 4.6). The number of files had been left unlimited, on the ground that `git add` handles millions; it was the clean-up that couldn't. So the walk counts the names, files and folders, and the one at which `views/` and `memory/` pass `AGENT_FILES_MAX_COUNT` together, 20,000, is unexpected. Each folder is read as a stream, only up to that name, so a folder of a million names costs the check no more than the limit: 22 ms for 900,000 (4.5). A year of views makes about 380 names, a day page and now and then a month's folder, and git adds 20,000 small files in about a tenth of a second (4.2). The name named is the one at which the limit passed, in the order the folder gives them, not in name order.
- *Cost of both limits:* a last commit past either, which only a commit by hand or a lower limit could make, or about 50 years of day pages, fails every run until it is smaller. The clean-up's own check leaves both out: what it leaves is the last commit, and it can't make that smaller.
- *Depth:* `mkdir` in the VM stops where the host's path would pass what the system takes, 4,095 bytes on Linux, but moving a folder into another doesn't, and each move adds as much again (the fourth review, 4.6; 4.2). Every call on a longer path fails with `ENAMETOOLONG`. The check names the first path past the limit as the unexpected file, rather than failing the run with `couldn't commit the run's files (ENAMETOOLONG: …)`. Within the limit a tree is at most about 2,000 folders deep, which the check's walk, one call deeper for each folder, and git handle. The removal can't stop at the limit, because it is what frees the disk: below.
- *Two names:* a hard link, which pi can make within one writable folder (across two it fails, the third review found), is something git doesn't record: git would commit two files, and a later write through one name would change the other. No ordinary run makes one, so it fails the run.
- *Modes:* git records of a mode only whether a file's owner may run it. pi chose the rest: a folder left without write access, or a file left read-only, made every later run fail to write there, and nothing in git said why (the third review, 4.6). So once the check has passed, staging gives every folder 0700, and every file 0600, or 0700 when its owner may run it, setting only a mode that differs, so git's record of the file doesn't change. A mode that keeps the runner from reading still fails the run: the check has to read what it checks. *Not put back:* the files' times. No later run's access depends on them, and they hold nothing a later run couldn't read for itself.
- *Empty folders:* git doesn't record a folder with no file in it, so one pi left stayed outside git after a successful run, and later runs saw it, with a name of pi's choosing (the second review). Staging removes every empty folder in `views/` and `memory/`, the deepest first, so a folder that held only empty folders goes too, after it has put back the modes, so a folder pi left without write access can't hold one back. The run doesn't fail for it: an ordinary run can leave one, such as a month's folder once its only day page is gone (7.2), and failing that run would cost its items an attempt. So after a successful run `views/` and `memory/` hold nothing the commit doesn't, with the runner's modes, apart from the files' times.
- *Commit:* after the check, and before the session is kept (D87), a commit only if the index differs from the last commit: `lifelog: #1050 #1051 #1053` (every item of the batch), `lifelog: scheduled task 21:30`, or `lifelog: once task poems`. No git command starts `git gc` on its own (D96).
- *Errors:* everything from the walk to the commit reads what pi left. An error there, such as a git command stopped at `GIT_CALL_TIMEOUT`, fails the run as pi's own failure, with the reason `couldn't commit the run's files (<error>)`, counts an attempt, and is logged as `runner.files_failed` with the error's code (4.7). Before, it stopped the runner, which then ran pi on the same batch again at every start, without counting one. *Cost:* a git that fails for a reason of its own, such as a damaged repository or a full disk, now uses the items' attempts, four runs each, and the owner is told; a stopped runner ran pi again at every start, for good.
- *Clean-up:* in five steps, none of which what pi left can slow down or stop (4.7). `run/session/` has been emptied just before (D87). Everything pi wrote is freed before anything new is made: pi may have filled the disk, and on ext4 a new folder needs a block of its own, which a full disk doesn't have (the fourth review, 4.6; 4.2).
  1. `views/` and `memory/` are set aside: each is renamed into `agents/.discarded/<agent>/`, under a name nothing there has, such as `views-1`. A rename takes the same time whatever the folder holds, and needs no room. It needs write access to the folder itself (4.2), which pi could have taken away, so the folder is given it first. `agents/.discarded/` is beside the agent's folder, on the same file system, so nothing is copied, and outside the VM's mounts and git (6.2). A start makes `agents/.discarded/<agent>/` and keeps it (D89), so the clean-up doesn't make it.
  2. Everything in `agents/.discarded/<agent>/` is removed, with whatever an earlier clean-up couldn't remove, by `emptyFolder` in `src/common/files.mjs`: without git and with no time limit, giving each folder back the runner's access before it reads it, reading it as a stream and removing each entry as it comes. 900,000 files take about 6 seconds and 105 MB (4.5). Each entry is reached by its path, so a folder whose path would pass 767 bytes is first moved to the top of what is being emptied, under a short name (`moved-<n>`), and emptied from there. That leaves every path within what Linux takes, and what macOS takes, 1,023 bytes, since a name is at most 255. The folders being read are kept in a list, not one call inside another, so a chain of 100,000 folders takes 3 seconds and at most about 380 open folders (4.5). An entry it can't remove is passed over, so the rest still goes, and the first error is thrown at the end. If that happens, `agent.discarded_left` is logged and the next clean-up, or the next start, tries again; what is left is out of pi's sight and git's.
  3. `views/` and `memory/` are made again, empty, as the VM's mount points.
  4. The index is the last commit's again: `git read-tree HEAD`, in one step, whatever was staged. With 300,000 names staged it took 2 ms (4.2).
  5. The last commit's files in those folders are written back: `git restore --source=HEAD --staged --worktree`.

  Then the folders are checked, without the limits. If anything is still there, or a step of git failed, the clean-up throws. After a failed run, the run is recorded first, with its attempt and its notice, and then the runner stops (D93); at a start, the runner doesn't start. Both say what is wrong. The clean-up comes before the run is recorded, so what pi left takes no room the state needs. Before the fourth review it made `agents/.discarded/<agent>/`, which the clean-up before it had removed, a folder in it, and `views/` and `memory/` again, all before it removed anything: on ext4 filled through `views/` the failed run then wasn't recorded, and no start got past making `views/` again (4.5).

  The folders are set aside every time, not only when a clean-up done with git runs out of time, as the owner's answer put it: one way instead of two, and its only step that depends on what pi left is the removal, which needs neither git nor a time limit. *Cost:* each clean-up writes back every committed file of the two folders, at most 20,000 and 100 MB, where `git restore` wrote only the changed ones; and `git read-tree HEAD` unstages anything staged outside the two folders, which only someone working in the repository by hand would have staged. This takes the place of the clean-up before: `git restore`, `git rm --cached` and `git clean`, after the runner took back its access and removed by hand what git couldn't see.
- *`run/`:* `prepareRun` removes `run/` with `removeTree` before every run, however deep it goes, and `run/session/` is emptied once a run is over, before it is recorded, and at a start (D87).
- *Root* reads every file, so as root an unreadable file passes the check and is committed; the tests of it skip themselves as root.
- *The loop sleeps `POLL_INTERVAL` after every round*, a run included, so runs are at least that far apart.

**D89. Startup.**
In order: the config; the runner's folders, which `setup` makes in an install; one runner per data folder (D90); what pi wrote that may still take room, removed before any folder is made: what an earlier clean-up set aside and couldn't remove, and `run/session/`; the agent's folder, with `agents/.discarded/<agent>/`, which is kept from then on (D88); the clean-up of D88, which throws away what a run cut short by a crash or a stop left uncommitted; the sandbox; a leftover `run.lock`, removed and logged; `status.json` and the emulation notice (D91, D92); the state (D67, D69); the datastore; the protocol.
*What pi left, first* (the fourth review, 4.6): after a run that filled the disk, a crash can leave the clean-up cut short, `views/` set aside and not made again, or `run/session/` full. Making `views/` again needs a block (4.2), so a start that made its folders first couldn't start at all. The sandbox opens after the clean-up for the same reason: milestone 7's sweeps `runner/tmp` and may make folders there. Before, it opened first, so that a missing image stopped the start before the agent's folder was touched; nothing depends on that order.
*Git's lock files:* a git killed while it holds the index or a branch, by a power cut or a `SIGKILL`, leaves `index.lock`, `HEAD.lock` or `refs/heads/main.lock` in `.git`, and git then refuses to add, restore, remove or commit until it is gone (4.2), so the runner couldn't start again (the second review, 4.6). With the agent's folder, the runner removes and logs every `*.lock` file at the top of `.git` and under `.git/refs/`, before it uses git. It holds `runner/runner.sock` (D90), and no git of its own goes on in the background (D96), so no git of its own can be running then. A `rebuild` that uses git needs the same socket (the plan's milestone 9).
*Cost:* changes the owner makes by hand in `views/` or `memory/` and leaves uncommitted are thrown away at the next start. The README (milestone 14) should say to commit them.

**D90. One runner per data folder.**
*Question:* a second runner would run the same batches, write `state.json` against the first, and remove the first one's `run.lock` when it starts (6.4), so a backup could start during a run.
*Choice:* the runner holds `runner/runner.sock`, as the bridge holds its socket ([One service per data folder](architecture/shared-code.md#one-service-per-data-folder)). `holdInstance` moved to `src/common/instance.mjs`, and names the service in its error.

**D91. `status.json`.**
`{ startedAt, accel, zdr, internet, imageBuiltAt, agents: { <name>: { model, timeoutMinutes, reads } } }`, written atomically, mode 0600, at every start. `accel` is `kvm` or `emulation`. `imageBuiltAt` is null when the sandbox doesn't know it. The model is each agent's, as `agents.yaml` has it. A `status.json` that can't be read is logged and counts as none.

**D92. The emulation notice.**
It goes out at startup when `AGENT_ACCEL=auto`, the sandbox runs under emulation, and the `status.json` of the last start doesn't say `emulation`. A first start counts as a change. `AGENT_ACCEL=emulation` sends none: nothing fell back. The notice is written before `status.json`, so a crash between the two sends it twice rather than never. It says: "⚠️ My VMs run under emulation now, because KVM isn't available, so each batch takes much longer. Run `scooter doctor` on the runner to see how to enable KVM."

**D93. The loop.**
- One thing at a time: a round reads the new lines, asks `nextAction`, does what it says, and sleeps `POLL_INTERVAL`, after a run too. Runs never overlap, and are at least that far apart, which D82 relies on.
- An error in a round, such as a damaged datastore, stops the runner with exit code 1, so its service manager starts it again with its own backoff, and the start says what is wrong. A run cut short that way changes nothing, and its batch runs again. Two exceptions, so that nothing pi left can make the runner run a batch again without counting an attempt (D88, 4.7): an error in checking or committing what pi left fails the run instead; and a clean-up that can't finish stops the runner only once the failed run is recorded.
- Waiting for `backup.lock`, or for a `run.lock` that isn't the runner's own, as a `rebuild` holds it, is logged when it starts, not every second. Commands don't take `run.lock`: they write only an outbox entry and the state.
- Stopping, on SIGTERM or SIGINT, aborts a run in progress: the sandbox closes the VM, the run's changes are thrown away as after a crash, the state stays as it was, and the lock is let go of.
- A backfill batch, and finishing a backfill, are milestone 9's. Until then a backfill waits where it is.

**D94. `scooter runner` stays unbuilt in the CLI until milestone 7.**
*Question:* the plan builds `main.mjs` here, and the VM sandbox in milestone 7.
*Choice:* `runRunner` exists. It takes `openSandbox`, and exits with 2 for a bad `agents.yaml` and with 1 for any other failure to start or to go on. `src/cli.mjs` keeps `runner` unbuilt until milestone 7 gives it the Gondolin sandbox, and the plan's milestone 7 now says so.
*Reason:* a command that started and then always stopped for want of a sandbox would be a placeholder in production code.

**D95. Six constants.**
`SESSION_MAX_BYTES`, 100 MB (D87); `REASON_MAX_CHARS`, 200 (D82, D84); `NOTICE_QUOTE_CHARS`, 40 (D86); `AGENT_FILES_MAX_BYTES`, 100 MB, and `AGENT_FILES_MAX_COUNT`, 20,000 (D88); and `ANSWER_MAX_TEXTS`, 25 (D85). 8.6 of DESIGN.md lists them (the fourth review, 4.6). The length at which `emptyFolder` moves a folder up, 767 bytes (D88), isn't one: it follows from what the system takes, not from a choice of how Scooter behaves, so it is in `src/common/files.mjs`, with how it is worked out.

**D96. Packing the agent's repository.**
*Question:* `git commit` starts `git gc --auto` once the repository has enough loose objects, about 6,700, which some hundreds of commits make, and by default that goes on in the background after the commit has returned. It then works outside `run.lock`: a backup can read `.git` while packs are written and loose objects removed, and D89's ground for removing git's lock files at a start, that no git of the runner's is running, no longer holds (the third review, 4.6).
*Choice:* no git command of the runner's starts maintenance on its own (`maintenance.auto=false`). After a run that committed, once the state is saved, the runner runs `git gc --auto` itself, in the foreground (`gc.autoDetach=false`, and `maintenance.autoDetach=false` for a later git), while it still holds `run.lock`, and with no time limit. A failure is logged as `agent.pack_failed`, and changes nothing else.
*Reason:* turning it off alone (`gc.auto=0`) would leave every object loose for good, each version of a view a whole compressed file of its own, where a pack keeps the differences. Packing inside the commit would let a slow pack fail a run that had committed (D88). It has no time limit because git stopped part-way would leave the programs it started, `repack` and `pack-objects`, writing on their own outside `run.lock`: `proc.mjs` signals the program alone ([Running programs](architecture/shared-code.md#running-programs)). It packs only what is loose, a few thousand objects, and, once there are 50 packs, all of them again. *Cost:* the next round of the loop waits for it, as for a run. And `run.lock` holds a time, the run's start and its timeout, past which a backup goes ahead anyway, `BACKUP_LOCK_EXTRA` later ([The locks](architecture/exchange.md#the-locks)), so that a lock a crashed runner left can't hold backups up for good. Packing has no time limit, nor has the clean-up's removal (D88), so after a run that used most of its time a backup could read `.git` during a repack (the fourth review, 4.6). How a backup tells a runner still at work from one that is gone is milestone 10's, and the plan's milestone 10 now says so.

### 4.2 Facts found

- **git 2.43.0:** `git restore` has no `--ignore-unmatch`, and fails on a path with no committed file. `git add -A -- views memory` works on empty folders, and fails on a missing one. `git clean -fdx -- views` removes the folder `views` itself when nothing in it is committed. `git status` and `git clean` don't see FIFOs. `git clean` leaves a nested repository unless given `-f` twice. `git rev-parse` on an empty `.git` exits with 128, and without `GIT_DIR` git looks for a repository in the folders above.
- **More of git 2.43.0** (the review of this milestone): `git add -A` exits with 128 and stages nothing for a file it can't read, and for a file or folder named `git~1` in any case (`core.protectNTFS` is on by default, on Linux too). For a folder it can't read it only warns, and passes over what is inside. With `--ignore-errors` it stages the rest, exits with 1, and leaves those paths unstaged, where `git status` names them. It adds a name that isn't UTF-8 as it is.
- **And more** (the second review of this milestone), on the Linux machine: `git add` reads every byte of a file, holes included. It took 0.4 seconds for a file of 100 MB of holes, 4.0 seconds for 1 GB of holes, and 1.85 seconds for 100 MB of random bytes; the review measured 32 seconds for 8 GB of zeros. `truncate -s 40G` makes a file of 0 blocks at once. A leftover `index.lock` makes `git add`, `git restore`, `git rm` and `git commit` exit with 128, and a leftover `HEAD.lock` or `refs/heads/main.lock` makes `git commit` do so; `git status`, `git clean`, `git diff --cached` and `git ls-tree` work with any of them. `git status` says nothing of an empty folder, and `git add -A` doesn't record one.
- **Node 22:** `readdir` gives a name that isn't UTF-8 with `�` in place of its bytes, and that string names nothing on disk (`ENOENT`). With `encoding: 'buffer'` it gives the bytes, which every `fs` call takes as a path. `fs.rmSync` with `recursive` can't remove a folder whose mode is 000.
- **And more** (the third review of this milestone, and the owner's answer), on the Linux machine, git 2.43.0 and Node 22.23.2:
  - `git rm -r --cached` of the names staged in a folder takes time that grows faster than their number: 7.6 seconds for 300,000, and stopped at `GIT_CALL_TIMEOUT` after 63.6 seconds for 900,000, as the review measured (52 to 57 seconds for 800,000). `git read-tree HEAD` on the same index of 300,000 took 2 ms, and puts the index back to the last commit whatever it held. `git add -A` of 300,000 empty files took 1.1 seconds, and of about 19,500 small files, a day page each, 0.1 seconds.
  - `git commit` with `maintenance.auto=false` starts no `git gc`, however many objects are loose. `git gc --auto` with `gc.autoDetach=false` packs in the foreground, and leaves no `gc.pid`. It counts loose objects by those in `.git/objects/17/`.
  - Linux renames a folder into another folder only if the folder itself can be written, since its `..` changes: `EACCES` otherwise.
  - `fs.opendirSync` with `encoding: 'buffer'` reads a folder as a stream and gives names as bytes. `fs.rmSync` with `recursive` reads each folder whole into memory first. Removing each entry as it comes, while the folder is read, works on ext4 and on tmpfs: 300,000 files in 2.1 seconds with 74 MB of memory, and 900,000 in about 7 seconds with 105 MB.
- **And more** (the fourth review of this milestone), on the Linux machine and in a VM from the test image, Gondolin 0.14.0:
  - In the VM, `mkdir -p` fails once the host's path would pass 4,095 bytes, but `mv` of a folder into one near the limit succeeds, and leaves paths on the host past it; each move adds as much again. Linux refuses any call on a longer path with `ENAMETOOLONG`, `lstat` and `access` included.
  - On ext4 a new folder needs a block of its own, so on a full disk `mkdir` fails with `ENOSPC`; a rename into a folder that is there needs none. The test image's VM has `/` on ext4, with 99 MB free, and `/root`, `/tmp` and `/var/tmp` on tmpfs.
  - Node 22.23.2's `fs.rmSync` with `recursive` overflows the call stack on a tree about 1,980 folders deep, which a path within the limit can hold. The runner's check, staging, commit and clean-up go through the same tree.
  - Moving a folder to the top before its path passes 767 bytes, and keeping the folders being read in a list, removes a chain of 20,000 folders in 0.6 seconds and one of 100,000 in 2.8 seconds; 300,000 files in 1.9 seconds with 82 MB, and 900,000 in 6.0 seconds with 105 MB.

### 4.3 The review of milestone 3

The pull request was approved with seven smaller points. Each is below, with what became of it. The points earlier milestones left stay as they were: the 2-minute start limit of the VM tests (milestone 0, point 6), zone names wrong in their later letters (milestone 1, point 3, for milestone 7), and what stopping the channels does to wacli's calls in progress (milestone 2, point 3, for milestone 10).

| # | Point | What became of it |
|---|---|---|
| 1 | The planner takes it that no `retry` item is after the cursor, and nothing says or checks so | Settled (D78). The cursor moves after a failed run too, `checkAgentState` refuses a retry after its lane's cursor, and DESIGN.md 6.4 and 6.9 say so. Tests in `agentstate`, `failures` and `run` |
| 2 | A prompt or skill inside another skill's folder makes every run fail | Settled: a fault at startup that names the field, either way round. Test in `config` |
| 3 | Git isn't tied to the agent's folder | Settled: `GIT_DIR` and `GIT_WORK_TREE` on every git command, and `git init` whenever there is no commit. Tests in `agentdir`, with an empty `.git`, and with the data folder inside another repository |
| 4 | A reply to a command shows the command; a reply to a line the index can't show has no preview | Settled: `↳ reply to a command`, and `↳ reply to #N: "<quoted>"`. Test in `batch` |
| 5 | 6.4 says "at least `BATCH_SECONDS` old" | Settled: 6.4 of DESIGN.md and 5.1 of ARCHITECTURE.md say the time counts from when the runner saw the line (D64) |
| 6 | A backfill never runs when the agent has no `on: new-messages` and a message waits | Settled: messages count as live work only with `on: new-messages`. Test in `triggers` |
| 7 | Smaller still | Two settled, one left. `ack_reaction: k` is refused: the grapheme must hold a pictograph, a flag or a keycap. A `/new` counts for the session of the day it was sent, or of now if its time is later. Both with tests. Left: the search for the largest cut in D72 can cut a text a little more than it needs to, when a text fits whole at the boundary. The prompt always fits, and it happens only to a single item too long for the prompt on its own |

### 4.4 Changes to DESIGN.md

For the review of milestone 3, none changes what Scooter does beyond D78, which 6.5 and 6.9 already implied:
- 6.4, `on: new-messages`: the quiet period counts from when the runner saw the newest incoming line (D64).
- 6.4, commands: `commandSeq` is there for a run cut short by a crash, which leaves the cursor where it was; a failed batch moves the cursor (D78).
- 6.9: after every run that finishes, the cursor moves past the batch; only a run cut short leaves it.

For the review of this milestone (4.6, D88):
- 6.8, step 1: a file the runner can't read, a folder it can't open, and a path `git add` refuses, such as `git~1`, are unexpected files too. Staging is the check's last step, so step 3 commits what was staged.
- 6.9: the clean-up gives the runner back its access to everything in `views/` and `memory/` first.
- Section 10, Runner: the unexpected files to test include a file or folder the runner can't read, and a name git refuses.

For the second review of this milestone (4.6, D88):
- 6.8, step 1: the file that takes what `views/` and `memory/` hold past 100 MB in all is an unexpected file too, and the runner removes the empty folders there just before staging, without failing the run.
- Section 10, Runner: a file past the size limit fails the run; an empty folder doesn't, and is removed, so after a successful run the two folders hold nothing the commit doesn't.

For the third review of this milestone and the owner's answer (4.6, 4.7; D85, D87, D88):
- 6.2: `agents/.discarded/<agent>/`, where the clean-up sets aside what it then removes.
- 6.6: the session is copied back after the commit, and `run/session/` emptied.
- 6.7: one answer sends at most 25 texts.
- 6.8, step 1: a file with two names, and the name that takes the two folders past 20,000 files and folders, are unexpected; the runner puts back the modes before staging. Steps 2 and 3 change places: the commit, then the session. An error in steps 1 or 2 fails the run, as an unexpected file does.
- 6.9: the clean-up sets the folders aside, takes the last commit's back (`git read-tree`, `git restore`) and removes what it set aside; it comes before the run is recorded, and one that can't finish stops the runner only after. Files that couldn't be checked or committed are a failure of pi's own. A sandbox that can't run pi at all is a setup error, as D82 has it (the third review's point 5).
- Section 9: the modes git doesn't record are put back.
- Section 10, Runner: the new limit, a file with two names, the modes, an error in checking or committing, the clean-up of a large index, and the most texts an answer sends.

ARCHITECTURE.md 5.1, 5.2 and decision 26 have the new order after a run, and the clean-up. The plan's milestone 7 has the two ways left for the sandbox to close (4.7), milestone 8 the third review's point 3, and milestone 10 a word about `agents/.discarded/`.

For the fourth review of this milestone (4.6; D87, D88, D89, D95, D96):
- 6.2: the runner makes `agents/.discarded/lifelog/` at a start and keeps it.
- 6.8, step 1: a path longer than the system takes is an unexpected file.
- 6.9: the clean-up empties `run/session/` first, sets the folders aside, removes what it set aside however deep it goes, and only then makes the folders again; what it can't remove doesn't keep it from removing the rest. A start removes what an earlier clean-up left and empties `run/session/` before it makes any folder.
- 8.6: the six constants of D95.
- Section 10, Runner: a tree whose paths pass what the system takes, and a disk pi filled.

ARCHITECTURE.md 4.4 has the runner's new start order, and 5.2 the clean-up's. The plan's milestone 7 says the runner frees what pi wrote before it opens the sandbox, and milestone 10 has the fourth review's point about work past `run.lock`'s time.

ARCHITECTURE.md 5.1 has the quiet period the same way. The plan's milestones 7 and 8 note what this milestone did for them (D81, D94), and its milestones 8, 9 and 12 what the reviews of this milestone left for them (4.6). `runner.env.example` says that `AGENT_ACCEL=auto` tells the owner once when it falls back.

### 4.5 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-17, on the Linux machine, from clean clones of the branch:

| Command | Result |
|---|---|
| `npm ci && npm test`, Node 22.23.2 | 347 tests: 322 pass, none fail. 25 skip themselves: the 18 that need the image and the 7 that need root |
| `npm test` at each of the milestone's two earlier commits | 279 and 282 tests, none fail |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 340 pass, none fail, in 110 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie`, with `SCOOTER_ROOT_TESTS=1`, on a second clone | Node 24.22.3: 323 pass, none fail. 24 skip themselves: 18 need the image, 4 need wacli, 1 is about a file root can read anyway, and `scooter bridge` as a process, which as root needs the users `setup` makes |
| This milestone's tests (`run`, `runner`, `agentdir`, `failures`, `answer`), 32 times, 8 at once | No failure |

After the fixes for the review of this milestone (4.6), at `4d02a8a`, on 2026-11-17, from clean clones of the branch:

| Command | Result |
|---|---|
| The new tests, before the fixes, at `bd6622d` | All 12 fail as the review says: `EACCES` from the check and the clean-up, `EGIT` from `git add`, and the scheduled task not due after a restart. The folder whose name isn't UTF-8 fails with `ENOENT` |
| `npm ci && npm test`, Node 22.23.2 | 357 tests: 332 pass, none fail. 25 skip themselves: 18 need the image and 7 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 350 pass, none fail, in 109 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan, on a second clone | Node 24.22.3: 328 pass, none fail. 29 skip themselves: 18 need the image, 4 need wacli, `scooter bridge` as a process, and 6 are about a file root can read anyway, the 5 new ones among them. The test of `git~1` runs as root, and passes |
| `run`, `runner`, `agentdir`, `failures`, `answer` and `agentstate` tests, 32 times, 8 at once | No failure, and no test folder left behind |

After the fixes for the second review (4.6), at `6022b96`, on 2026-11-17, from clean clones of the branch:

| Command | Result |
|---|---|
| The new tests, against the code of `9992813` | All fail as the review says. With only the new constant added, the run that leaves a file of holes a byte over the limit gets through and commits it, and the check names nothing for 40 GB of holes |
| `npm ci && npm test`, Node 22.23.2 | 363 tests: 338 pass, none fail. 25 skip themselves: 18 need the image and 7 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 356 pass, none fail, in 111 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan, on a second clone | Node 24.22.3: 333 pass, none fail. 30 skip themselves: 18 need the image, 4 need wacli, `scooter bridge` as a process, and 7 are about a file or folder root can read or write anyway, the empty folder the runner can't remove among them. The file of holes and the empty folders run as root, and pass |
| `run`, `runner`, `agentdir`, `failures`, `answer` and `agentstate` tests, 32 times, 8 at once | No failure, and no test folder left behind |

Not verified: a file of holes or an empty folder made by pi in a real VM against this code. The review's Gondolin 0.14.0 checks showed that both reach the host as they are, and the fake sandbox makes them the same way, with the same user.

After the owner's answer (4.7) and the fixes for the third review (4.6), at `7a28f9f`, on 2026-11-18, from clean clones of the branch:

| Command | Result |
|---|---|
| The new tests, against the code of `564b86a` | Each fails, as the third review and the owner's question say: the run that leaves 20,000 more names, or a file with two names, gets through and commits them; the modes pi left stay 0500; `git add` timing out stops the runner, with nothing recorded; and the new tests of `agentdir` fail on the modes, the count, the hard link, the clean-up and the packing |
| The third review's first case, by a script against the code of `564b86a` and of `7a28f9f`: `views/` committed, `memory/` with nothing committed and 900,000 names staged in it, then the clean-up, with the real clock for git | Before: `git rm: timed out` after 63.6 seconds. After: done in 6.7 seconds, `memory/` empty and the index holding the last commit |
| The same script, with the 900,000 names and `memory/git~1` left in the folder, not staged | The check names a name in `memory/many/` in 22 ms, and the clean-up takes 6.7 seconds, with 105 MB of memory |
| `npm ci && npm test`, Node 22.23.2 | 373 tests: 348 pass, none fail. 25 skip themselves: 18 need the image and 7 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 366 pass, none fail, in 110 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan, on a second clone | Node 24.22.3: 344 pass, none fail. 29 skip themselves: 18 need the image, 4 need wacli, `scooter bridge` as a process, and 6 are about a file or folder root can read anyway. The new tests run as root, and pass: the modes are put back as root too |
| `run`, `runner`, `agentdir`, `failures`, `answer` and `agentstate` tests, 32 times, 8 at once | No failure, and no test folder left behind |

Not verified: what pi leaves made by pi in a real VM against this code: many names, a hard link, modes, a disk filled. The reviews' Gondolin 0.14.0 checks showed that what pi makes in the writable folders reaches the host as it is, as the runner's user, and the fake sandbox makes it the same way. Nor `git gc --auto` on a repository of years: the test packs a few thousand loose objects.

After the fixes for the fourth review (4.6), at `10fd9b6`, on 2026-11-18, from clean clones of the branch:

| Command | Result |
|---|---|
| The new tests, against the code of `dc85a21` | Each fails: a tree past the path limit in `views/` fails the check with `ENAMETOOLONG` and stays in `agents/.discarded/`; one in `run/session/` can't be emptied, and the next `prepareRun` would stop the runner; those left at a start stay where they are; a disk filled before a start keeps the runner from starting (`ENOSPC`, `mkdir …/views`); on a disk filled during the run, the round throws `ENOSPC` (`mkdir …/exchange/outbox`) before the run is recorded; and `files.test.mjs` finds no `emptyFolder`. The cases of the earlier reviews fail there only on the changed assertion that `agents/.discarded/lifelog/` is kept. A failing test there leaves its folder behind, since the old removal can't remove the trees either; those were removed afterwards |
| The fourth review's own script, in a VM from the test image under KVM, with the runner's data folder on the VM's ext4 root, 99 MB free, and a sandbox that fills the disk through `views/` with `dd`. Five cases: `session: none`, pi exiting 1 and 0; `session: daily` with a session file of 4 KB, exiting 1 and 0; and of 300 KB, exiting 1 | With this code, each: the run is recorded with its attempt and its notice, the disk is back to 79% used, the runner starts again, and the next try commits. At `dc85a21`, three of them: the round throws `ENOSPC` (`mkdir …/exchange/outbox`, a write, `mkdir …/.discarded/lifelog`); in the first two nothing is recorded and no start gets past `mkdir …/views` or `…/memory`, as the review found |
| The fourth review's own scripts on the Linux machine: a tree past the path limit, with 8 MB in it, left in `run/session/` with pi exiting 0, or in `views/` with pi exiting 0 or 1, then two more starts; and a 20 MB file at a 4,090-byte path, committed, then four clean-ups | In `run/session/`: the run succeeds, the next runs start. In `views/`: the run fails with `unexpected file views/t1/ddd…` or `pi exited with code 1`, counts one attempt, and the next try commits. `agents/.discarded/` holds only its two empty folders throughout. The committed file is put back by each clean-up, and nothing of it is left set aside |
| A tree 1,974 folders deep in `views/`, as deep as a path within the limit allows, with a folder of mode 500: the check, staging, the commit, and a clean-up after a change | 385 ms, 756 ms, 167 ms and 820 ms; nothing left set aside |
| `npm ci && npm test`, Node 22.23.2 | 383 tests: 358 pass, none fail. 25 skip themselves: 18 need the image and 7 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 376 pass, none fail, in 112 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan, on a second clone | Node 24.22.3: 354 pass, none fail. 29 skip themselves, the same 29 as before. The new tests run as root, and pass |
| `run`, `runner`, `agentdir`, `failures`, `answer`, `agentstate` and `files` tests, 32 times, 8 at once | No failure, and no test folder left behind |

Not verified: a tree past the path limit made by pi itself in a VM against this code. The fourth review made one with `mv` in a VM, Gondolin 0.14.0, and the stub and the tests make the same tree on the host with renames. The full disk was filled by the sandbox's script on the VM's own disk, not by pi through a mount; the hermetic tests simulate it by having `fs` refuse to make anything while what pi wrote is there (`test/support/full-disk.mjs`).

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Where |
|---|---|
| Cursor, retry and failed transitions with an injected clock: a minute between attempts, 4 attempts | `failures.test.mjs`, as functions; `run.test.mjs`, an item not reported, run four times a minute apart and given up on |
| `FAILED` | `answer.test.mjs`; `failures.test.mjs`; `run.test.mjs`, with the agent's own text and no notice |
| A pi failure discards uncommitted changes and sends one notice, and counts one attempt unless OpenRouter caused it | `runner.test.mjs`: a crash after a commit, the second failure in a row, and the next row; a timeout; items given up on in failing runs |
| A 401, 402, 403 or 404 pauses runs, with a try every 30 minutes and on restart | `runner.test.mjs`, a 404 with OpenRouter's words, commands while paused, and a restart, and a scheduled task held back across a restart; `failures.test.mjs`, each status; `agentstate.test.mjs`, the dates kept at a start during a pause |
| A 408, 429, 5xx or no answer is retried after 1, 5 and 30 minutes, then every 30 | `runner.test.mjs`: a 429, a 503, an unreachable OpenRouter, and a run that timed out waiting; `failures.test.mjs`, each status |
| Neither counts attempts, and messages that arrive meanwhile are handled once a run gets through | `runner.test.mjs`, in both of the above |
| `about` on an answer's plain text, the batch's newest item, but not on a scheduled task's | `answer.test.mjs`; `run.test.mjs`; `runner.test.mjs`, the evening check-in |
| An edit of a message waiting in `retry` or in `failed` brings it into the same batch | `batch.test.mjs` (milestone 3); `run.test.mjs`, which takes it out of `failed` |
| Sessions: only the current one is copied in, and only it is copied back: never a link, and nothing after a failed run | `run.test.mjs`, with a session file and a folder in `run/session/` the runner can't read, and a tree in it past the path limit; `agentdir.test.mjs`, with a hard link, a file too large, and a file and a folder the runner can't read |
| A link, a FIFO, a dot name, a file git ignores, a file or folder the runner can't read, a file with two names, a name git refuses, or what takes the two folders past their limits on size or count, in `views/` or `memory/`, fails the run; the clean-up removes it; the session isn't copied back. An empty folder doesn't fail the run, and is removed, and the modes are put back | `run.test.mjs`, each through the stub, and the next try after the last seven, among them a file of holes a byte over the size limit and 20,000 names past the count; empty folders, one inside another, after which the two folders hold only what the commit does; a folder, a folder in it and a file without write access, after which the next run writes; `agentdir.test.mjs`, the clean-up after a commit, with a nested repository and a staged file, every mode that hides a file or a folder, names that aren't UTF-8, both limits exactly and one past, a 40 GB file of holes, a hard link, a month's folder emptied by a run, the modes put back, and the clean-up of 30,000 names staged in a folder with nothing committed and of `views/` turned into a link; `runner.test.mjs`, a folder of mode 000 and git's lock files at startup |
| An error in checking or committing what pi left fails the run and counts an attempt; a clean-up that can't finish stops the runner only once the run is recorded | `runner.test.mjs`, with `git add` timing out and `git commit` failing, then the next try; and with `git read-tree` failing, a restart, and the next attempt counted |
| A tree whose paths pass what the system takes fails the run in `views/` or `memory/`, and is removed wherever pi left it, also at a start; on a disk pi filled, the clean-up and a start free what pi wrote before they make anything | `run.test.mjs`: `DEEPTREE` among the cases tried again, `DEEPSESSION`, and `FILLDISK` with `session: daily` and `none`, each through the stub; `runner.test.mjs`: the trees in `views/`, `run/session/` and `agents/.discarded/`, and a disk filled with the clean-up cut short, at a start; `agentdir.test.mjs`: the check naming the path, and a committed file at a 4,090-byte path put back with nothing left set aside; `files.test.mjs`: a chain 20,000 folders deep, a folder without access past the limit, and an entry that can't be removed. The full disk is `fs` refusing to make anything while what pi wrote is there (`test/support/full-disk.mjs`) |
| One answer sends at most 25 texts | `answer.test.mjs` |
| The sandbox gets the mounts of 6.6, with `sessions/` hidden, and the network policy for the internet mode; the prompt shows the mode | `run.test.mjs`: the spec, the environment pi got, what the stub could see, internet on and off; `runnerfiles.test.mjs`, the spec's check |
| Scheduled and `once` tasks, and `/new`, handled once even when the batch after it fails | `runner.test.mjs` |
| No run while a backup holds its lock; when both appear at once, the runner gives way; `run.lock` records when its run must be over | `runner.test.mjs` |
| `status.json` holds what `/status` shows of the runner's settings; the emulation notice goes out when the accelerator changes to emulation, and not again at the next start | `runner.test.mjs`; `runnerfiles.test.mjs`, the format |
| The commit message, and `can_message: false` | `run.test.mjs` |
| Answer parsing: every instruction line, text segments, and unknown `seq` numbers | `answer.test.mjs` |

The milestone's "done when", the pi stub taking a message from the datastore to a committed view and a correct `state.json`, is the first test in `run.test.mjs`. The rest of `run.test.mjs` and `runner.test.mjs` take it through retries and failures.

Not verified:
- **pi in a VM.** Milestone 7 builds the sandbox. The stub acts as pi 1.5.2 did in milestone 0's checks (its output, exit codes, sessions and errors), but it isn't pi, and the prompt and protocol haven't been read by a model.
- **The network log as the policy writes it.** Milestone 8 writes it. The cause is read from lines the stub writes in the format of D81, and D82's cost depends on when milestone 8 writes a `response` line.
- **Read-only mounts.** The fake sandbox doesn't enforce them; milestone 7's tests check them on the VM.
- **`scooter runner` as a process,** under systemd or Docker: the command isn't built (D94). The runner runs in-process in the tests, its loop and its stop included.
- **arm64 and macOS.** Nothing here knows the architecture. Unix sockets, `O_NOFOLLOW`, `mkfifo` and the git commands used exist on macOS.

### 4.6 The reviews of this milestone

The first review of the pull request, at `bd6622d`, asked for one change and noted six smaller points. Each is below, with what became of it.

| # | Point | What became of it |
|---|---|---|
| Must | A file or folder pi makes unreadable stops the runner. In `views/` or `memory/`: at the check, the commit or the clean-up, and a folder again at every start; a file restarts the runner on the same batch without end, with no attempt counted. In `run/session/`: every later run. A session file pi made unreadable: the same as a file | Fixed (D87, D88). The check names a file the runner can't read and a folder it can't read and search, and ends by staging, so a name git refuses, such as `git~1`, fails the run too, before the session is kept. The clean-up and `prepareRun` take back the runner's access first. A session file the runner can't open is refused, as is a `run/session/` it can't list. The walks go by the bytes of names, because a folder whose name isn't UTF-8 stopped the runner the same way (4.2). Tests in `run`, `agentdir` and `runner`; those that need a file root can't read skip themselves as root |
| 1 | A pause can be left with nothing to try: a scheduled task that failed on a setup error isn't due after a restart, and `paused` stays with `next` in the past | Fixed (D83, D67): a start during a pause keeps the tasks' dates, so the task is the try the restart brings forward. Tests in `agentstate` and `runner` |
| 2 | A run that ends on a 400 or a 413 tells the owner "pi exited with code 1", though pi printed OpenRouter's reason | Fixed (D82): OpenRouter's error is the reason for any status of 400 or more. Tests in `failures` |
| 3 | A comment in `commands.mjs` says a failed batch leaves the cursor where it was | Fixed |
| 4 | For milestone 12: D93 leans on the service manager's backoff, and systemd's default start limit never applies to a runner that waits out the quiet period at every start | Left for milestone 12. The plan's milestone 12 now says the unit needs a `RestartSec`, or growing steps, chosen with that in mind |
| 5 | For milestone 9: a runner started during a `rebuild` removes its `run.lock` and throws away its uncommitted changes | Left for milestone 9. The plan's milestone 9 now says so, with the review's way out: `rebuild` holds `runner/runner.sock` (D90) |
| 6 | For milestone 8: a request the policy refuses on `openrouter.ai` has a `refused` line and no `request` line, so a run that ends on one reads as pi's own failure | Left for milestone 8. The plan's milestone 8 now says so, with D82's cost |

The second review, at `9992813`, found every point of the first settled, asked for two changes, and noted one smaller point. Each is below, with what became of it.

| # | Point | What became of it |
|---|---|---|
| Must 1 | A file too large for `git add` to finish within `GIT_CALL_TIMEOUT` stops the runner, and every restart runs pi on the same batch again, with no attempt counted. pi can make one at no cost, a file of holes, and nothing limits a smaller one | Fixed (D88, D95). The check weighs the files in its walk, before git reads any, and the file at which `views/` and `memory/` pass `AGENT_FILES_MAX_BYTES` together, 100 MB, is unexpected: the run fails, counts an attempt, sends the notice, keeps no session, and the clean-up removes the file. The limit is on the two folders together rather than on each file, so that many files under it can't add up to the same wait. The number of files isn't limited (D88). Tests in `run`, through the stub, with a file of holes a byte over the limit, and the next try; and in `agentdir`, with 40 GB of holes |
| Must 2 | An empty folder stays in `views/` or `memory/` after a successful run, outside git, and later runs see it | Fixed (D88), the second way the review gave: staging first removes the empty folders, the deepest first, and the run doesn't fail for them. An empty folder the runner can't remove is named like a path git refuses. Tests in `run`, through the stub, with an empty folder and empty folders inside each other, after which the two folders hold only what the commit does; and in `agentdir`, with a month's folder a run emptied, and an empty folder in a folder of mode 500 |
| 1 | A leftover `.git/index.lock` keeps the runner from starting | Fixed (D89): at startup, with the agent's folder, the runner removes and logs every lock file at the top of `.git` and under `.git/refs/`, since a leftover `HEAD.lock` or `refs/heads/main.lock` would stop every commit the same way (4.2). Tests in `agentdir`, and in `runner`, a start over `index.lock` and `refs/heads/main.lock` followed by a run that commits. The plan's milestone 9 now says a runner started during a rebuild removes these too |

The third review, at `564b86a`, found every point of the second settled, asked for two changes, and noted five smaller points. Each was a new case of the kind of problem the first two reviews' changes had each closed one case of; the pull request went to the owner, whose answer is in 4.7. Each point is below, with what became of it.

| # | Point | What became of it |
|---|---|---|
| Must 1 | Enough names in a folder with nothing committed stop the runner, and it can't start again: the clean-up's `git rm --cached` takes time that grows with the square of what is staged, and ran past `GIT_CALL_TIMEOUT` with 900,000 names, at the failed run and at every start after. A run that leaves a name git refuses beside them is enough | Fixed, with the whole kind of problem (4.7; D88, D95). The check counts files and folders before git reads anything, and the name that takes the two folders past `AGENT_FILES_MAX_COUNT`, 20,000, fails the run; it reads a folder only that far. The clean-up sets the folders aside, puts the index back with `git read-tree HEAD`, and removes what it set aside without git. The review's case: the check takes 22 ms and the clean-up about 7 seconds, where the clean-up before stopped at 63.6 seconds (4.5). Tests in `run` (`MANYFILES`, through the stub), and `agentdir` (the limit exactly and one more; 30,000 names staged in a folder with nothing committed, `views/` turned into a link, and what an earlier clean-up left) |
| Must 2 | After a successful run, the modes pi set stay, and the next run can't write its folders; with pi answering `FAILED`, the owner's messages end in `failed` | Fixed (D88): once the check has passed, staging gives folders 0700 and files 0600, or 0700 when they can be run, which is all git records. Tests in `run` (`READONLY`: `views/`, a folder in it and a file, and the next run writes) and `agentdir` (folders of mode 500 and 555, files of 400, 666 and 4755) |
| 1 | `git commit` starts a repack in the background, outside `run.lock` | Fixed (D96): no command starts maintenance on its own, and the runner runs `git gc --auto` in the foreground after a commit, under `run.lock`. Test in `agentdir`: a commit leaves the loose objects as they are, and `pack` packs them, with no `gc.pid` left |
| 2 | One answer can ask for any number of messages | Fixed (D85, D95): at most `ANSWER_MAX_TEXTS`, 25, the rest dropped and counted in the log. Test in `answer` |
| 3 | For milestone 8: a request to `openrouter.ai` with a key of pi's own would read as a setup error | Left for milestone 8. The plan's milestone 8 now says to refuse one whose key header isn't the placeholder |
| 4 | The unexpected file's path is logged whole, up to 4 KB of pi's choosing | Fixed (D88): cut to `REASON_MAX_CHARS`, as the reason is |
| 5 | 6.9 doesn't say that a VM that can't start counts as a setup error | Fixed: 6.9 says it, as D82 has it |

The fourth review, at `dc85a21`, found every point of the third settled, asked for two changes, and noted three smaller points. Both changes were further cases of the kind of problem the owner asked to have closed (4.7), in the clean-up, whose rule the answer already gave: make it unstoppable. So they were fixed without a new question. Each point is below, with what became of it.

| # | Point | What became of it |
|---|---|---|
| Must 1 | A folder nested past the host's path limit stops every later run, and the clean-up can never remove it. `mkdir` in the VM stops at the limit, but `mv` doesn't, and `removeTree` reached every entry by its whole path. In `run/session/`, no run started again; in `views/`, what pi wrote stayed in `agents/.discarded/` for good; and a committed file at a 4,090-byte path was left there again by every clean-up | Fixed (D87, D88, D89). `emptyFolder` moves a folder whose path would pass 767 bytes to the top of what it empties, under a short name, keeps the folders it reads in a list, and goes on past what it can't remove (the review's smaller point 1); `removeTree` uses it. The check names a path past the limit as the unexpected file. The review's three cases, by its own scripts, now each end with nothing left (4.5). Tests in `run` (`DEEPTREE`, `DEEPSESSION`), `runner` (at a start), `agentdir` (the check, and the 4,090-byte path) and `files` (20,000 folders deep) |
| Must 2 | On a disk pi filled through `views/`, the clean-up can't begin, the run isn't recorded, and the runner can't start again: it made `agents/.discarded/<agent>/`, a folder in it, and `views/` and `memory/` before it removed anything, and a start made folders before its clean-up too | Fixed (D87, D88, D89). A start makes `agents/.discarded/<agent>/` and keeps it. A failed run empties `run/session/` first, keeping the folder; the clean-up renames `views/` and `memory/` straight into the kept folder, removes them, and only then makes them again. A start removes what an earlier clean-up left and empties `run/session/` before it makes any folder, and opens the sandbox after its clean-up. The review's script on ext4 in a VM, in five cases, now records the run and starts again each time (4.5). Tests in `run` (`FILLDISK`, both session settings) and `runner` (at a start), with `fs` refusing to make anything while what pi wrote is there |
| 1 | `removeTree` stops at the first entry it can't remove, so what comes after it is never tried | Fixed with Must 1: it goes on, and throws the first error at the end. Test in `files` |
| 2 | Packing and the removal have no time limit, and `run.lock` has one, past which a backup goes ahead: a long `git gc --auto` after a run that used most of its time could be read by a backup | Left for milestone 10, as a cost in D96. The plan's milestone 10 now says so: settle how a backup tells a runner still at work from one that is gone |
| 3 | 8.6 of DESIGN.md doesn't list the six constants of D95 | Fixed: 8.6 lists them |

### 4.7 The question for the owner, and the answer

After the third review, the pull request wasn't approved, and the milestone stopped on a question for the owner, through the milestone workflow (`docs/plans/completed/v2-linux-implementation/milestone-loop.workflow.js`), on 2026-11-18.

*The question, as asked:*
> Pull request 5 was not approved after three reviews. Each review found a new case of one kind of problem: something pi leaves in `views/`, `memory/` or `run/` stops the runner, or makes it run the same batch again without counting an attempt. The points of the first and the second review were fixed. The third review's two points are open: enough names in a folder with nothing committed make the clean-up's `git rm` time out, and the modes pi sets stay after a successful run. Should the next fix cover only those two points, or the whole kind of problem?

*The answer:* "yes", to this proposal, quoted as it was put to the owner. In it, "the agent" means pi.
> Fix the two points, and tell the implementer to close the whole class, not just the next case.
> - Limit what is accepted. Before git reads anything, check the number of files and their total size.
> - Put back what git doesn't record. Reset the permissions once the check has passed.
> - Fail the run, don't stop the runner. Any error that the agent's leftovers cause after it exits counts as a failed attempt.
> - Make the clean-up unstoppable. If it can't finish in time, set the folders aside and restore them from the last commit.

*What follows,* rule by rule (D87, D88, D93):
- **Limit what is accepted.** The check counts the files and folders as well as weighing them, before git reads anything: 20,000 names and 100 MB in all (`AGENT_FILES_MAX_COUNT`, `AGENT_FILES_MAX_BYTES`). It reads a folder as a stream, only up to the limit. A file with two names is refused too, being something else git doesn't record.
- **Put back what git doesn't record.** Once the check has passed, staging sets the modes, 0700 on folders and 0600 on files, or 0700 on a file that can be run, and removes the empty folders, as before. What git records of a mode, whether its owner may run the file, is kept. The files' times are left: nothing depends on them.
- **Fail the run, don't stop the runner.** Everything from the check to the commit reads what pi left, and any error there fails the run as pi's own failure, with an attempt counted. Keeping the session refuses on any error instead of throwing, and comes after the commit, so a commit that fails keeps no session. `run/session/` is emptied before a run is recorded, and on a failure `views/` and `memory/` are cleaned up first, so that a disk pi filled can't keep the state from being saved.
- **Make the clean-up unstoppable.** The clean-up sets `views/` and `memory/` aside every time, in `agents/.discarded/`, takes the index and the files back from the last commit (`git read-tree HEAD`, `git restore`), and removes what it set aside without git or a time limit. Doing it every time, and not only once a clean-up with git has run out of time, is one way instead of two; its only step that depends on what pi left is the removal. If the clean-up still can't finish, for a reason that isn't pi's, the failed run is recorded first, with its attempt, and then the runner stops. The fourth review found two ways pi could still stop it, both closed since (4.6): a tree nested past the longest path the system takes, which the removal now reaches however deep it goes; and a disk pi filled, on which the clean-up, and a start, now free what pi wrote before they make anything.

*The whole kind of problem.* Each step that reads what pi left after it exits, or before the next run, was gone through for what pi could leave there and what it would do. These are all the cases found, the reviews' among them:

| Where | What pi can leave | Before | Now |
|---|---|---|---|
| The check | A folder of hundreds of thousands of names | Read whole into memory, then given to git: `git add` and `git status` grow with it | Read up to the 20,000th name, before git |
| The check | A file with two names | Committed as two files | Fails the run |
| The check | A path longer than the system takes, made by moving a folder into another (the fourth review) | Failed the run as an error, `couldn't commit the run's files (ENAMETOOLONG: …)` | Named as the unexpected file |
| Staging | A folder without write access, a file read-only | Committed; later runs couldn't write | Modes put back |
| Staging | An empty folder in a folder without write access | Failed the run | Modes put back first, so it is removed |
| Staging, the commit | Anything that makes git fail or run out of time | Stopped the runner; the batch ran again at every start with no attempt counted | Fails the run, and counts an attempt |
| The session | A `run/session/` of millions of names; a copy that fails other than by the known codes | Read whole; stopped the runner after the commit | Read as a stream; refused |
| Recording the run | A disk filled through `run/session/` or the two folders | The state couldn't be saved, the runner stopped, and the next start ran the batch again with no attempt counted | Emptied and cleaned up before the run is recorded. Until the fourth review, the clean-up made folders before it freed anything, so on ext4 the run still wasn't recorded; now it frees first |
| The clean-up | Many names staged, many files, folders without access, links, FIFOs, nested repositories, the folder itself replaced | `git rm --cached` past its time; `git clean` past its time for some millions of files; folders read whole | Set aside; index from the last commit in one step; removed as a stream without git |
| The clean-up, `prepareRun`, emptying `run/session/` | A tree nested past the path limit (the fourth review) | Couldn't be removed: in `run/session/` no run started again; in `views/` it stayed set aside for good | A folder whose path would be too long moved up under a short name; the folders read kept in a list; whatever can't be removed passed over |
| The clean-up | A disk filled (the fourth review) | Made the place it set things aside in, and the folders again, before it removed anything | Frees everything pi wrote before it makes anything |
| The clean-up | Anything else that keeps it from finishing | The runner stopped before the run was recorded | The run is recorded first |
| `prepareRun` | Anything in `run/session/` a stopped runner left | Folders read whole by `fs.rmSync` | Removed as a stream, however deep |
| A start | Any of the above, left by a run a crash or a stop cut short | The clean-up above, with its problems: the runner couldn't start | The clean-up above |
| A start | A disk filled, with `views/` set aside and not made again, or `run/session/` full (the fourth review) | Made the agent's folders before it freed anything: the runner couldn't start | Frees what was set aside and `run/session/` before it makes any folder, and opens the sandbox after the clean-up |

*Left, for the sandbox* (the plan's milestone 7 now says so): what pi prints, which the sandbox collects, and which nothing in the interface limits, though with `-p` pi prints only its answer; and a disk pi fills while it runs, which the runner frees after the run, while the bridge's writes in the meantime could fail. Neither is something pi leaves in its folders after it exits.

*Not verified:* a VM making these against this code. The reviews' Gondolin 0.14.0 checks showed that what pi makes in the writable folders reaches the host as it is, as the runner's user, and the fake sandbox makes it the same way.

## Milestone 5: delivery and commands

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 5, 5.1, 5.3, 8.6 and section 10, to say what this milestone settled; those sections are now the documents of the bridge's side, in [the map](ARCHITECTURE.md#the-map).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/bridge/outbox.mjs` | Delivery: routing, chunking, pacing, `sending.json`, `out` lines, waiting, failed sends, pausing |
| `src/bridge/commands.mjs`, `src/bridge/status.mjs` | `/status`, `/help` and `/backup`, and the text of `/status` |
| `src/bridge/channels/whatsapp.mjs`, `channels/index.mjs` | `sendText`, `react` and `ready`; the check of `DEFAULT_CHANNEL` |
| `src/bridge/main.mjs`, `state.mjs`, `intake.mjs`, `store.mjs` | Delivery and the commands started with the bridge; `commandSeq` in the bridge's state |
| `src/common/outbox.mjs`, `files.mjs` | The longest text and its cut, `sending.json`'s format; `readUntrustedFile` |
| `src/common/netlog.mjs` | The network log read as a stream |
| `src/common/limits.mjs`, `time.mjs`, `runnerstatus.mjs` | Five constants; `shortLocalTime`; agents' names checked in `status.json` |
| `src/runner/answer.mjs`, `batch.mjs`, `prompt.mjs`, `failures.mjs`, `git.mjs` | The smaller points of the reviews of milestones 3 and 4 (5.2) |
| `test/delivery`, `routing`, `status` | This milestone's tests, with additions to `bridge`, `whatsapp`, `outbox`, `files`, and the runner's tests for the reviews' points |
| `test/support/fake-channel.mjs`, `wacli-stub.mjs` | Sends: the fake channel records them and fails as told; the stub answers `send text` and `send react` |

### 5.1 Decisions

**D110. The network log is read as a stream, and a log that can't be read doesn't keep a failed run from being recorded** (the fifth review of milestone 4, point 1).
*Choice:* `scanNetworkLog` reads each day's file 64 KB at a time and calls back for each line in the window, taking a line only up to `NETLOG_LINE_MAX_BYTES`, 16 KB; a longer one is skipped and counted, as a line that isn't one is. The runner's failure handling keeps only the last request to OpenRouter and what came of it. An error in reading the log counts as no answer from OpenRouter, so the run is pi's own failure: recorded, its attempt counted, and logged as `runner.netlog_unreadable`. `/status` uses the same reader. The plan's milestone 8 now says to bound what one request, and one run, add to the log, since a `request` line a reader skips is one the failure handling doesn't see.
*Reason:* the review's case, a day of 540 MB, stopped the round with `ERR_STRING_TOO_LONG` before the run was recorded, at every failed run until the day ended, and each start ran the batch again without counting an attempt. That is the kind of problem 4.7 closed. Now the same file takes 750 ms and 57 MB.

**D111. Reading pi's answer takes time in step with its length** (the fifth review of milestone 4, point 2).
*Choice:* the patterns for `DONE` and `FAILED` take every character (the `s` flag), so a carriage return or U+2028 after a long run of spaces can't make `FAILED` try every split of the spaces; and the items reported are kept in sets.
*Reason:* the review's line of 78 KB took 6.1 seconds and one of 1 MB about 17 minutes, during which the runner did nothing else and couldn't be stopped. Milestone 7's limit on what the sandbox collects is then about memory, as the plan now says.

**D112. The clean-up removes what staging copied into the repository** (the fifth review of milestone 4, point 3).
*Choice:* once the clean-up has put back the last commit, it runs `git prune --expire=now`, which removes every object nothing refers to: what `git add` copied into `.git/objects` for the run that failed. Only the runner uses the repository, and no git of its own runs then. A failure is logged as `agent.prune_failed` and changes nothing else; the next clean-up tries again.
*Reason:* each failed attempt left what it staged, up to `AGENT_FILES_MAX_BYTES`, for good: `git gc --auto` acts only once thousands of objects are loose, and then removes only what is two weeks old. The review's case, 90 MB staged beside `git~1` four times, left 360 MB; now nothing. *Cost:* every clean-up walks what the repository holds, which takes milliseconds for years of views. Objects someone staged by hand and left uncommitted go too, as their staging did already (D89).

**D113. An item too long on its own is cut as little as will do** (the review of milestone 3, point 7).
*Choice:* the search for the cap on the item's texts (D72) goes a stretch at a time, between the lengths of the texts the cap applies to, which the prompt reports, from the highest down. Within a stretch the prompt grows with the cap, so the search holds there; at a text's whole length the prompt is shorter than just below, since the text is then shown without its note.
*Reason:* the search assumed the prompt grows with the cap everywhere, and so could cut a text more than it needed. A test compares it with trying every cap; the search before failed it.

### 5.2 The reviews of the pull requests merged before this one

Pull request 5, milestone 4, was approved by its fifth review with three smaller points. All three are settled:

| # | Point | What became of it |
|---|---|---|
| 1 | A day's network log too large to read keeps a failed run from being recorded; `/status` reads the same files | Settled (D110): read as a stream, and an error counts as no answer. The review's case, by its numbers, on `main` and on this branch. Tests in `failures` (a line too long, across pieces of the file; a log that can't be read) and `runner` (a failed run recorded with the log unreadable). The plan's milestone 8 says to bound what a request and a run add |
| 2 | Reading an answer takes time that grows with the square of a line's length | Settled (D111). Test in `answer`: a megabyte of spaces with a carriage return and U+2028, and 160,000 numbers |
| 3 | What a run staged stays in `.git/objects` when the run then fails | Settled (D112). Test in `agentdir`: a staged file is gone after the clean-up, and `git fsck --unreachable` finds nothing |

The points the reviews of milestones 0 to 4 left, as each milestone's entry recorded them:

| From | Point | What became of it |
|---|---|---|
| Milestone 3, point 7 | The search for the largest cut in D72 can cut a text a little more than it needs to | Settled (D113), with a test that fails on the search before |
| Milestone 0, point 6 | The VM tests' 2-minute start limit | Left, for milestone 7, whose sandbox sets how long a VM may take to start |
| Milestone 1, point 3 | A zone name wrong in its later letters, such as `Asia/KOLKATA`, passes | Left, for milestone 7, which can look the zone up in the VM's image |
| Milestone 4, first review, points 4, 5 and 6 | `RestartSec` for the runner's unit; a runner started during `rebuild`; a refused request that reads as pi's own failure | Left, for milestones 12, 9 and 8, as the plan says |
| Milestone 4, fourth review, point 2 | Work past `run.lock`'s time, packing and the clean-up's removal | Left, for milestone 10, as the plan says. D112 adds `git prune` to the clean-up, under `run.lock`, which takes milliseconds |

## Milestone 7: sandbox and VM image

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 6.6, 6.9, 6.12, 8.6, and sections 9, 10 and 14, to say what this milestone settled (7.4 here). The review of the pull request asked for one change and noted seven smaller points; 7.6 says what became of each (D151, D152).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/runner/sandbox/gondolin.mjs` | The real sandbox: the runner's home and temporary folder, the image and the accelerator checked at its start, one VM per run with the mounts and environment of 6.6, closed on every path, and the limits on what a run may take |
| `src/runner/sandbox/accel.mjs` | `AGENT_ACCEL` |
| `src/runner/sandbox/image.mjs` | The build file and its pin of pi, the image's record and the runner's check of it, `packages.txt`, and `scooter build-image`, which builds in `.image-build/` beside the runner's folder (D151) |
| `src/runner/sandbox/index.mjs` | `SandboxSetupError`, and `createOutput`, the output both sandboxes keep |
| `src/cli.mjs`, `src/runner/main.mjs` | `scooter runner` with the Gondolin sandbox, and `scooter build-image`; a sandbox that can't run as it is set up exits with 2 |
| `src/runner/run.mjs`, `src/runner/failures.mjs` | A cut answer, or a run that wrote too much, fails as pi's own failure |
| `src/common/settings.mjs`, `limits.mjs`, `paths.mjs` | `loadFolders`, for `build-image`; eight constants; `imageStaging` |
| `test/support/` | The sandbox with the test image and the fake model's network, a process that holds a VM for the test of a killed runner, and a small image as Gondolin writes one, for `build-image`'s tests, with a stand-in for its file system for those that need no e2fsprogs |
| `test/sandbox`, `image`, `accel` | This milestone's tests, with additions to `run`, `failures`, `limits`, `email` and `whatsapp` |

### 7.1 Decisions

**D139. One VM per run, and how it ends.**
*Choice:* `openGondolinSandbox` is the runner's `openSandbox`. Its `run(spec)` makes a VM from `runner/image/` with the spec's mounts, boots it within `VM_START_TIMEOUT`, and runs `env -i <the spec's environment> <argv>` in the spec's folder (0.5, VM 2). `env` finds a program named without a path, such as `pi`, on the spec's `PATH`, so the image's layout stays the sandbox's business (D79). The VM is closed when the program exits, at the timeout, when the runner stops (its `signal`), and when the run writes too much (D146), and in every case before `run` returns. A VM that doesn't boot in time makes `run` reject, which the runner counts as a setup error, "the VM couldn't start" (D82). A run ended by a limit has `code: null`, even when the program ended at the same moment.
*Reason:* the plan's list for this file, with what milestone 0 found: closing the VM is what stops the program, since aborting the command doesn't (13.4; 0.5, VM 3).
*Also:* Gondolin's `autoStart: false` makes `start()` fail at once with "sandbox is stopped" in 0.14.0 (7.2), so the VM is made with the default, which begins booting at once, and `start()` waits for it.
*When a run ends* (the review of this milestone, smaller point 2): Gondolin's command settles once the program has exited and its output has closed, not when it exits. A process the program leaves running with its stdout or stderr open holds the run until that process ends, or until the timeout, which then fails the run as timed out and counts an attempt: `sh -c 'sleep 15 & echo done'` took 16.9 seconds in the review. pi's tools run their commands with pipes of pi's own, by the review's reading, so what a tool leaves running doesn't hold pi's output, and pi itself exits with its answer.
*The log* (the review, smaller point 1): `sandbox.vm_closed` says how the VM ended, in `ended`: `timeout`, `stopped` or `writes` when the sandbox ended it; `exited` when the program did; `lost` when the command failed under the program, as when its QEMU was killed, which is also logged as `sandbox.vm_lost` with the error's name and code (`errorFields`: Gondolin's message can quote the guest's output, so it isn't logged); and `not_started` when it never booted. A lost VM's run has `code: null`, as the sandbox interface says, and the runner records it as "pi was stopped", pi's own failure.

**D140. The runner sets its own home and temporary folder, and Gondolin's list of VMs goes in the temporary folder.**
*Question:* row 16 puts the runner's home and temporary folder under `runner/`; who sets them, and where Gondolin's files go.
*Choice:* the sandbox, when it opens, sets `HOME` to `runner/home`, `TMPDIR` to `runner/tmp` and `XDG_CACHE_HOME` to `runner/home/.cache` in the runner's own environment, and `GONDOLIN_SESSIONS_DIR` to `runner/tmp/sessions`, then loads Gondolin. The certificate authority stays in the home folder, given to each VM as `mitmCertDir`, so it lasts from one start to the next. The temporary folder is emptied at every open, before any VM. The sandbox refuses to open when a socket's path there would pass 107 bytes, and says the data folder needs a shorter path.
*Reason:* the runner then works the same however it was started, as a service, by hand, or in a container, and the folder it empties is the one Gondolin uses. Gondolin reads the temporary folder at each VM, and fixes its list of running VMs when it loads, so the module loads only after. The list holds a socket for each VM, named by a UUID: under `home/.cache/gondolin/sessions` its path passed 107 bytes with a data folder of 33 bytes, such as one under a home folder on the Linux machine, which `scooter runner` met at its first start; under `tmp/` it has 51 bytes more room than that and is emptied with the rest. The runner's programs get environments of their own ([Running programs](architecture/shared-code.md#running-programs)), so they see none of these.

**D141. Until milestone 8, the VMs reach nothing.**
*Question:* the network policy is milestone 8's, and this milestone builds `scooter runner`.
*Choice:* the sandbox takes the network as `network(policy)`, which gives the options of Gondolin's `createHttpHooks` apart from the secrets. Its default, `refuseNetwork`, allows no host: every request is refused before it goes out, DNS is answered inside the runner with made-up addresses, and the key, registered as the policy's secret, is swapped in nowhere. The tests give the scripted fake model as the network (`fakeModelNetwork`). Milestone 8 makes the policy the default.
*Reason:* the simplest option that keeps principles 2 and 4 and the zero data retention of section 2: a runner with no policy sends nothing. *Cost:* until milestone 8, `scooter runner` runs pi, which exits with 1 at once when OpenRouter can't be reached, and with no network log the run is pi's own failure: every message's attempts are used up and it ends in `failed`. So it isn't to be run on real messages before milestone 8. It was run once by hand, on a dummy message (7.5).
*Since milestone 8* the policy is the default (D153), and `refuseNetwork` is gone.

**D142. `AGENT_ACCEL`, by opening `/dev/kvm`.**
*Choice:* KVM can be used when the runner can open `/dev/kvm` for reading and writing and it is a character device. `auto` takes it, or else emulation, and logs `sandbox.emulation` with the reason; `kvm` and `emulation` are taken as they are; a forced KVM that can't be used, and `hvf`, stop the runner with an error that says how to enable it, natively and in Docker, and points at `doctor`. Gondolin is always told which (`accel`), so it never chooses by itself.
*Reason:* 6.6 and ARCHITECTURE.md decision 43. Opening the device is what QEMU does: an ACL or Ubuntu's device rules, which reset per-user ACLs (13.4), can let a permission check pass where the open fails. *Not covered:* a device that opens where the hypervisor itself doesn't work, as in a VM without nested virtualization; then every VM fails to start, runs pause as setup errors (D82), and the log says why.

**D143. The image's record, and the runner's check at startup.**
*Choice:* beside Gondolin's files, `scooter-image.json` holds `builtAt` (the manifest's build time, to the second), `pi` (from pi's `package.json` in the image), `alpine`, `arch`, and `zones`, every file under the image's `/usr/share/zoneinfo`. At startup the sandbox reads the build file's pin (D144) and refuses to open, before anything of Gondolin runs, when the image is missing, isn't whole, has no record, holds another pi, was built for another architecture, or doesn't know `SCOOTER_TZ`. Each error says what to do. A `SandboxSetupError` makes `scooter runner` exit with 2, as a bad `agents.yaml` does (D30).
*Reason:* 6.12. The zone settles a point the review of milestone 1 left for this milestone (7.3): `SCOOTER_TZ` is checked against the image's own zone files, case and all, which is what pi's C library looks up, so `Asia/KOLKATA` stops the runner where it used to pass. The record is written at build time, so the runner needs neither `debugfs` nor a VM to check it.

**D144. pi's pin, read strictly.**
*Choice:* the build file's `postBuild.commands` must name `@earendil-works/pi-coding-agent` exactly once, counting every mention with or without a version, a path among them, and that once as `@earendil-works/pi-coding-agent@<x.y.z>`, with an exact version, in a command that begins `npm install` and has `--ignore-scripts`, and no other word about scripts, such as `--ignore-scripts=false` or `--no-ignore-scripts`, which npm would take last. That command is plain words, letters, digits and `@/._=:+,-` apart by spaces, so the shell reads it as that one command: no `;`, `&` or `|`, newline, quote, `$`, backquote or redirection. Otherwise `build-image` and the runner refuse, naming the command. The build file must not name `arch` or `container`, which `build-image` chooses (D5).
*Reason:* the plan's rule: the runner reads the version from there, strictly. A range or `latest` would let two builds hold different pis under one pin; a command without `--ignore-scripts` would run pi's packages' code as root in a native build (row 8). Counting only mentions with a version, and looking only for the word `--ignore-scripts`, let pass a second install of pi without either, `… ; echo --ignore-scripts`, and `… && node /usr/local/bin/pi --version`, each of which runs pi's code as root in a native build (the review of this milestone, smaller point 4). The build file is the owner's, so this guards against a slip, not an attacker: the other commands are still the owner's to choose.
*Since milestone 8* (the second review of this milestone, smaller point 1): "no other word about scripts" still let pass `--ignore-scripts false`, `--no-ignore-s` and `--ignore-s=false`, each of which npm 10.9.8 reads as turning the scripts back on: it takes a word after a switch as its value, and a switch by the start of its name. So the install command is now `npm install`, pi's package with its version, and switches from a short list, the build file's own and `-g` (`--global`, `-g`, `--ignore-scripts`, `--omit=dev`, `--no-audit`, `--no-fund`), `--ignore-scripts` among them, and no other word.

**D145. `scooter build-image`.**
*Choice:*
- **Method.** As root, Gondolin's native build; otherwise its container build with Docker, else Podman; otherwise it stops, saying it needs root, or Docker or Podman (row 8). The build file goes to Gondolin as it is, with the machine's architecture and the method added.
- **What it reads.** Only `DATA_DIR` and `CONFIG_DIR`, from `runner.env` or the environment (`loadFolders`), checked as the runner's settings are. It runs as root natively, and needs no key or other setting.
- **One at a time.** It holds `runner/runner.sock` while it builds (D90), so it refuses while a runner runs, and no runner starts during it. As root it refuses when `runner/` doesn't exist, rather than make the runner's folder as root; `setup` makes it.
- **Beside the runner's folder.** It builds into `.image-build/image/` in the data folder, records the image (D143) and its packages (D147) there, checks that the pi in it is the pinned one, gives it to `scooter-runner` when root, and then renames it in place of `runner/image/`, which it first renames out into `.image-build/old` and removes there. Leftovers of a build cut short are removed at the next. Until the review of this milestone it built in `runner/image.new/`, in the runner's own folder (D151).
- **Reading the image.** pi's `package.json`, the zone files, Alpine's repositories and its record of the base packages are read out of `rootfs.ext4` with `debugfs`, from e2fsprogs, which 8.3 and 8.5 already need for the build: no mount, no root, and nothing in the image runs. `debugfs` is looked for in `/usr/sbin` and `/sbin` too, which a user's `PATH` may lack.
- **Exit codes.** 2 for a fault in how it is set up or called (the build file, no method, no `debugfs`, a runner running, a folder it may not write), 1 for a build that fails. Since milestone 8 (the second review of this milestone, smaller point 3), a user who may not write the data folder or the runner's, which since D151 is every user but root on a native install, `scooter-runner` among them, is told that it runs as root there, with 2, where it got Node's `EACCES` and 1.

*Reason:* 6.12, row 8 and the plan's rules for this milestone. Holding the socket keeps a running runner from booting an image it didn't check at its start.

**D146. What a run may write.**
*Question:* the plan: pi can fill the disk while it runs, through `views/`, `memory/` or `run/session/`, and the bridge's writes could fail meanwhile; if Gondolin can cap what a writable mount takes, use it.
*Choice:* Gondolin 0.14.0 has no quota, but every write, open, folder and hard link made through a mount passes its file system hooks, and the sandbox uses them. Each writable mount counts, for the run, the bytes written and the names made (files, folders, symbolic and hard links) against `RUN_WRITE_MAX_BYTES`, 1 GB, and `RUN_NAMES_MAX_COUNT`, 100,000. A symbolic link passes the hooks by, so the provider counts it itself. The write or name that passes either is refused with ENOSPC, as is everything after, and the VM is closed; the result says `wroteTooMuch`, and the run fails as pi's own failure, "pi wrote more than a run may", whatever the network log says, since the VM was closed in the middle of whatever pi was doing. The clean-up then frees what it wrote (D88).
*Reason:* bytes written and names made bound the blocks and the inodes a run can take, whatever it removes again; counting the space a file takes would let a run rewrite a file without end. The limits leave room for what a run legitimately leaves several times over: at most 100 MB and 20,000 names in `views/` and `memory/` (D88) and a session of 100 MB (D87). The rest of what a VM writes isn't on the host's disk: `/tmp` and `/root` are in its memory, and its own disk is a copy-on-write overlay that can't grow past the image's size. *Cost:* a run that rewrites a large view many times could reach the limit; a year of views is about 1 MB. The hooks see writes in pieces of at most 60 KB, so what passes the limit is at most that much.

**D147. `packages.txt`.**
*Question:* 6.12 has `build-image` write the installed versions, and Gondolin's builder unpacks Alpine's packages without recording them (0.5).
*Choice:* the base system's packages are those `/lib/apk/db/installed` records in the image. The others are resolved, right after the build, against the APKINDEX of each repository the image's `/etc/apk/repositories` lists, the way Gondolin 0.14.0's builder resolves them: the first repository's record of a name wins, names are also found through what packages provide, dependencies are followed with their version constraints dropped, and a conflict (`!name`) is taken as a dependency, as Gondolin takes it. A version so resolved replaces the base system's. The file says which index it used, and when.
*Reason:* no other source records the versions; reading what the image has can't. Each index is fetched within `APK_INDEX_TIMEOUT`, 1 minute, its body included, or the build fails (the review of this milestone, smaller point 7): `build-image` holds `runner.sock` meanwhile, so no runner can start, and the index, a couple of megabytes, comes in seconds. A build that fails there is built again from the start; what it built is left in `.image-build/`, and removed by the next. *Cost:* the index is fetched again about a second after Gondolin fetched it in the build, and Alpine updates it a few times a week, so a package updated in between would be listed at its new version. The native build keeps Gondolin's index for up to a day in root's cache, which could make that gap longer there. The resolution reimplements Gondolin's, about 25 lines, which an upgrade of Gondolin must be checked against (the plan's risk table).

**D148. What the sandboxes keep of pi's output.**
*Choice:* `createOutput` keeps the first `SANDBOX_STDOUT_MAX_BYTES`, 1 MB, of stdout and the last `SANDBOX_STDERR_MAX_BYTES`, 64 KB, of stderr, as they arrive, and says `stdoutCut`. Both sandboxes use it; the fake one on what its process printed. A run whose answer was cut fails as pi's own failure, "pi's answer was too long", when pi exited with 0; a run that failed otherwise keeps its own cause.
*Reason:* the plan's rule for this milestone. With `-p` pi prints its answer alone, a few kilobytes; 25 texts of 14,000 characters (D85; [Outbox entries](architecture/exchange.md#outbox-entries)) are under 1.4 MB at the very most, and an answer near the limit is already one the runner wouldn't send whole. stderr's end holds OpenRouter's error, which the notice quotes (D82).

**D149. The VMs' size, and how long one may take to boot.**
*Choice:* `VM_MEMORY_BYTES`, 2 GB, and `VM_CPUS`, 2, which milestone 0's checks used, pi 8 with images included; `VM_START_TIMEOUT`, 1 minute, or the run's own timeout when that is shorter. A run whose own time ends before its VM has booted is one whose VM couldn't start too, since milestone 8 (the second review of this milestone, smaller point 2): with `timeout_minutes: 1`, the lowest `agents.yaml` takes, the two limits are equal, the run's timer is set first, and such a run was recorded as timed out, pi's own failure with an attempt counted, where 6.9 makes it a setup error.
*Reason:* Gondolin's default start limit is 2 minutes (0.5), which a VM that never starts would spend at every try, and which the review of milestone 0 noted held no test (7.3). A VM boots in about 2 seconds with KVM and 6 under emulation (13.4), so a minute leaves room for a loaded machine and a VM inside a VM (G3).

**D150. Eight constants.**
`VM_MEMORY_BYTES`, `VM_CPUS` and `VM_START_TIMEOUT` (D149); `SANDBOX_STDOUT_MAX_BYTES` and `SANDBOX_STDERR_MAX_BYTES` (D148); `RUN_WRITE_MAX_BYTES` and `RUN_NAMES_MAX_COUNT` (D146); and, after the review of this milestone, `APK_INDEX_TIMEOUT` (D147). 8.6 of DESIGN.md lists them. The longest socket path, 107 bytes, isn't one: it is a fact of Linux, as the path lengths of D95 are.

**D151. As root, `build-image` changes the runner's folder only by two renames** (the review of this milestone, must-fix).
*Question:* `runner/` belongs to `scooter-runner`, which can put a link anywhere in it at any moment. `build-image`, as root, built in `runner/image.new/`, wrote the image's record and `packages.txt` there, gave that folder and every name in it to `scooter-runner`, set its mode, and removed the old image by its path. The review renamed `image.new` aside during a build, as root in a container with the tests' fake builder, and put a link to another folder in its place: root wrote into that folder, gave it to the runner's user with every name in it, a file of root's with mode 0600 among them, and set its mode to 0700. With `/etc/scooter` as the folder, `bridge.env` becomes the runner's user's; with `/etc`, so does the machine. Gondolin's native builder writes into `image.new` as root for the whole build too, by its path. Section 9 says an escape from pi's VM reaches the runner's user and not the bridge's secrets, and [Folders other users control](ARCHITECTURE.md#folders-other-users-control) holds the bridge to that; this broke it on a native install at every rebuild. It takes code running as `scooter-runner` outside the service, which `KillMode=control-group` would end, such as from that user's crontab, while the owner runs `sudo scooter build-image`.
*Choice:*
- It builds the image, reads it, records it and gives it to `scooter-runner` in `.image-build/` in the data folder (`paths.imageStaging`): beside `runner/`, so on the same file system, and made 0700 by the user who builds. Natively the data folder is root's, so nobody but root reaches it. As root it refuses a data folder that isn't root's or that another user can write, and a `.image-build` that isn't a folder of root's.
- In `runner/` it then makes two renames and nothing else: whatever is at `runner/image`, a link included, out to `.image-build/old`, and the new image in. A rename follows no link at either end, and puts a folder only where nothing is or an empty folder is; anything else in the way fails the build, with the new image left in `.image-build/` for the next build to remove. It also holds `runner/runner.sock`, as before: binding the socket and removing it reach only that name, in a folder whose user could remove it anyway.
- The old image is removed in `.image-build/` as a handed-over folder is ([Folders other users control](ARCHITECTURE.md#folders-other-users-control)): a link or a file in the image's place is unlinked; a folder has each of its names unlinked, which follows no link and removes no folder, and is then removed, which happens only once that empties it. A process of the runner's user that was inside the old image, as its working folder, can still change what it holds after the rename, though no path leads it there any more, and nobody but root can rename it. Gondolin's image is a flat folder. What can't be removed is logged (`image.old_left`) and stays where only root reaches it, and the next build refuses, saying to look at it and remove it.
- Without root, in development and for the container build, it builds the same way, with no other user to guard against.
*Reason:* the review's way. Node has no calls relative to a folder it has open, so a check before each step would leave the gap [Folders other users control](ARCHITECTURE.md#folders-other-users-control) records; building where the runner's user can't reach leaves it no step to turn. A root test with the fake builder is the review's case: during the build, the runner's user renames the old image aside and puts links to a folder of root's at `runner/image`, `image.new` and `image.old`. The folder is left as it was, the image is in place, the runner's user's and 0700, and what that user left is as it left it. On the code before, the image's files were written into that folder.
*Cost:* in Docker, the data folder may not be one file system with `runner/`, and is read-only in the runner's service; the plan's milestone 13 now says to settle it. The tests that build without e2fsprogs read the image through a stand-in (`readFakeImage`), so the root test, which the plan's root container can run, doesn't read the image with `debugfs`; the tests that do still need e2fsprogs.

**D152. A writable mount hides nothing** (the review of this milestone, smaller point 3).
*Choice:* `checkRunSpec` refuses a writable mount with paths in `hide`, for both sandboxes. The real sandbox shadows paths only in a read-only mount, and through a writable one the VM could make a hidden path again. `piMounts` never asks for it.
*Reason:* the review's first way, the smaller one: a line, where shadowing in a writable mount would need tests of its own for what the VM can make there.

### 7.2 Facts found

On the Linux machine, with Gondolin 0.14.0, QEMU 8.2.2 and the test image of 0.2:
- `VM.create({ autoStart: false })` and then `start()` fails at once with "sandbox is stopped". With the default, `create` begins the boot and `start()` waits for it.
- `touch` on a file of a read-only mount succeeds in the guest and changes nothing on the host: its time stays as it was. Writing, appending, removing and `chmod` are refused, as 0.5 found.
- A symbolic link made through a mount passes Gondolin's file system hooks by (`SandboxVfsProvider.symlink`); writes, opens, folders and hard links pass them. A guest's write reaches the host in pieces of at most 60 KB (`MAX_RPC_DATA`), and `copy_file_range` and `fallocate` go through the same writes, or make holes.
- With every request refused, pi 1.5.2 exits with 1 after about a second, and makes no further try.
- `scooter build-image`, with Gondolin's container build under rootless Docker, built the image in 18 seconds: 527 MB, with the versions milestone 0 recorded (0.1), and 100 Alpine packages in `packages.txt`, a file of 102 lines with its two lines of comment (corrected after the review of this milestone, smaller point 6). The image's zone folder holds 603 files.
- Killing a VM's QEMU while a command runs makes Gondolin's command reject at once, with a plain `Error`, which has no code (after the review, smaller point 1).
- A VM booted from it in 1.8 to 2.3 seconds with KVM, in the sandbox tests, and in 1.9 seconds under `scooter runner`.

### 7.3 The reviews of the pull requests merged before this one

The points the reviews of milestones 0 to 5 left:

| From | Point | What became of it |
|---|---|---|
| Milestone 0, point 6 | The VM tests' 2-minute start limit, Gondolin's default, held by no test | Settled (D149): the sandbox sets its own limit, `VM_START_TIMEOUT`, and a sandbox test shows a VM that doesn't boot within it failing the run, and leaving nothing |
| Milestone 1, point 3 | A zone name wrong in its later letters, such as `Asia/KOLKATA`, passes | Settled (D143): the runner refuses a `SCOOTER_TZ` that isn't one of the image's zone files. Test in `image` |
| Milestone 4, first review, points 4, 5 and 6 | `RestartSec`; a runner started during `rebuild`; a refused request that reads as pi's own failure | Left, for milestones 12, 9 and 8 |
| Milestone 4, fourth review, point 2 | Work past `run.lock`'s time | Left, for milestone 10 |

### 7.4 Changes to DESIGN.md

None changes what Scooter does beyond what 6.6 and 6.12 left open:
- 6.6: the VM's start limit; what a run may take from the runner, its output and what it writes (D146, D148); the runner sets its own home and temporary folder, and Gondolin's list of VMs is in `tmp/sessions/` (D140).
- 6.9: a cut answer, and a run that wrote too much, are pi's own failures.
- 6.12: the build file says what is in the image, not how it is built; `packages.txt` and how its versions are known (D147); `scooter-image.json` (D143); `build-image` reads only the two folders and holds `runner.sock` (D145); the runner also refuses an image for another architecture or one that doesn't know `SCOOTER_TZ`, and exits with 2.
- 8.6: the seven constants of D150.
- Section 9: filling the disk, as a control.
- Section 10, Sandbox: a VM that doesn't boot in time, the limits on writes and output, and an unknown zone.
- Section 14: the container build by `build-image` was run.

After the review of this milestone (7.6):
- 6.12: `build-image` builds in `.image-build/` beside `runner/`, and as root changes the runner's folder only by two renames (D151).
- 8.6: `APK_INDEX_TIMEOUT`, the eighth constant of D150.
- Section 9: the accepted risk of a native build says it builds where only root can write, so a link the runner's user puts in its folder leads it nowhere (D151).
- Section 10, Sandbox: the root test of D151.

ARCHITECTURE.md 2.7 says the same. The plan's milestones 8, 12 and 13 have what this milestone leaves for them, and milestone 13 the second review of milestone 6's point 3, the outbox's owner under rootless Docker. `runner.env.example` says how `SCOOTER_TZ` is checked and what `build-image` reads.

### 7.5 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, from clean clones of the branch at `63c93b7`, the last commit that changes code or tests:

| Command | Result |
|---|---|
| `npm ci && npm test` | 573 tests: 534 pass, none fail. 39 skip themselves: 18 of milestone 0 and 12 of this milestone need the image, and 9 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 575 tests: 566 pass, none fail, in 114 seconds. The 9 root tests skip themselves. The fastest of three boots: 1.9 seconds. No QEMU left |
| `test/sandbox.test.mjs` with KVM, three more times | 14 pass each time; the fastest boots 1.8 to 1.9 seconds |
| `test/sandbox.test.mjs` without the `kvm` group, so under emulation, at `3790c3e` | 13 of 14 pass, in 3 minutes 24 seconds; boots of 5.7 to 6.6 seconds. The end-to-end test expected only the ✅ in the outbox, where under emulation the runner's first start also sends the emulation notice (D92). `63c93b7` expects it there, and the test then passes under emulation |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie`, with `SCOOTER_ROOT_TESTS=1`, on a second clone at `3790c3e` | Node 24.22.3: 523 pass, none fail. 50 skip themselves: 30 need the image, 4 wacli, 4 `mke2fs`, which that image lacks, 2 run `scooter bridge` as a process, and 10 are about a file root can read anyway. `63c93b7` changes one assertion of a test that skips there |
| The `email`, `whatsapp`, `intake`, `run`, `failures`, `image`, `accel`, `limits`, `cli` and `imports` tests, 16 times, 8 at once | No failure, and no test folder left behind |
| `scooter build-image`, as `agentw`, with `DATA_DIR` in a scratch folder | Gondolin's container build under rootless Docker: 18 seconds, 527 MB, `scooter-image.json` with pi 1.5.2 and 603 zones, and `packages.txt` with 100 packages at the versions of 0.1. `runner/runner.sock` gone afterwards. The sandbox tests' `pi --version` and end to end pass on that image |
| `scooter runner`, with that image and the `kvm` group, started and stopped with SIGTERM | `sandbox.opened` with KVM, `status.json` written, and a clean stop. With a message in the datastore it ran two batches a minute apart, each VM up in 1.8 to 2.1 seconds and closed a second later: pi exited with 1, every request refused (D141). No QEMU left |

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Where |
|---|---|
| A VM boots from the built image and runs `pi --version` | `sandbox.test.mjs`, with the boot time under 3 seconds with KVM |
| The mounts: read-only except `views/`, `memory/` and `run/session/`; `sessions/` isn't there, and a link made in a writable folder doesn't lead to it; at the host's paths | `sandbox.test.mjs`: writing, appending, removing and `chmod` refused; `sessions/` not there, not makeable, not through a link from beside it or by its full path, nor under Gondolin's mount point; `/data`, the runner's and the exchange's folders and the config not there. With the data folder at `/data`, by the review's hand, not a test: below |
| Nothing survives between runs: files outside the mounts, background processes | `sandbox.test.mjs`: `/root`, `/tmp`, `/var/tmp`, `/etc`, and a `setsid sleep` |
| From inside the VM: another host, DNS to an outside resolver, UDP and private addresses refused; the environment holds only the placeholder | `sandbox.test.mjs`, with the default network and with the fake model's: HTTPS and HTTP to another host, the metadata address, the host's loopback, a LAN address and a private one, against a server of the test's on every address of the host, which nothing reaches; DNS through `8.8.8.8` answered with a made-up address; UDP to the host, which receives nothing; the environment exactly the spec's and the placeholder |
| `AGENT_ACCEL`: `auto` picks the fastest and says which; a forced one that isn't there stops the runner | `accel.test.mjs`, with the device given; `sandbox.test.mjs`, `auto` and `emulation` |
| A timeout closes the VM; stopping the runner's process group leaves no QEMU | `sandbox.test.mjs`: the timeout and a stop, with QEMU gone and `runner/tmp` empty; a process holding a VM, killed with its group |
| A missing image, or one built for another pi version, stops the runner | `image.test.mjs`: `scooter runner`'s exit code and message for each, and the check's other cases |
| Beyond section 10 | `sandbox.test.mjs`: the limits on writes and names, the output kept, a VM that doesn't boot in time, `runner/tmp` emptied at start; `image.test.mjs`: the pin, `build-image` with a fake builder, `packages.txt`; `run.test.mjs`, `failures.test.mjs`: a cut answer and a run that wrote too much |

The milestone's "done when":
- *The sandbox tests pass, and a VM boots in under 3 seconds*: all of `sandbox.test.mjs`, with KVM, whose first test asserts the fastest of three boots under 3 seconds: 1.8 to 2.0 seconds.
- *One batch end to end through the real sandbox with the scripted fake model*: the last test of `sandbox.test.mjs`. The runner, with the Gondolin sandbox, runs pi on a message; the fake model has pi `read` the message's line in the datastore, which the next request shows by its WhatsApp ID, and `write` `views/expenses.csv`; the runner commits it as `lifelog: #1`, with the ✅, the state and the session.

Not verified:
- **The data folder at `/data`** (row 14), by a test: the sandbox mounts at the host's paths, and this machine has no root to put the data there. Milestone 0's VM 1 showed mounts under `/data` working once Gondolin's mount point is moved, which the sandbox always does, and the mounts test shows `/data` isn't mounted. The review of this milestone ran it by hand (smaller point 5): the sandbox in a rootless Docker container without a network, with the data folder at `/data` and the image `build-image` made, booted in 4.6 seconds under emulation. The mounts sat at `/data/agents/lifelog` and `/data/datastore`, read-only but for the three folders; `sessions/` wasn't there, through a link or under `/run/gondolin-vfs` either; `/data` held only `agents` and `datastore`, and wasn't itself a mount; and `/data/runner`, `/data/exchange` and `/config` weren't there. So row 14 holds. The plan's milestone 13 checks it again in its containers.
- **The network policy and OpenRouter:** milestone 8. Nothing leaves a VM here.
- **A native build as root** (gate G2), and `build-image` in the runner container (milestone 13).
- **`packages.txt` against the files Gondolin unpacked**, one by one. Its versions agree with what milestone 0 found in the image.
- **KVM in Docker** (gate G3), **arm64** and **macOS**. The architecture is named in `machineArch` and `qemuProgram` alone.

### 7.6 The review of this milestone

The review of the pull request, at `17d6b7b`, found the milestone's "done when" met, asked for one change, and noted seven smaller points. Each is below, with what became of it.

| # | Point | What became of it |
|---|---|---|
| Must 1 | As root, `build-image` worked inside `runner/`, which `scooter-runner` owns: a link put in `image.new`'s place during the build made root write into the folder it led to, give it and every name in it to the runner's user, and set its mode. With `/etc/scooter`, `bridge.env` becomes that user's, which section 9 says an escape from pi's VM can't reach | Fixed (D151), the review's way. The image is built, read, recorded and given to `scooter-runner` in `.image-build/`, beside `runner/` in the data folder, and in `runner/` root only holds its socket and renames the old image out and the new one in. The old image is removed in `.image-build/` by its names, a link in its place as a link. As root, a data folder another user can write is refused. DESIGN.md 6.12, sections 9 and 10, ARCHITECTURE.md 2.7 and [Folders other users control](ARCHITECTURE.md#folders-other-users-control), and the plan's milestones 12 and 13 say so. Root test in `image`, with the fake builder and a stand-in for the image's file system, so it runs in the plan's root container, which has no e2fsprogs: during the build the runner's user renames the old image aside and puts links to a folder of root's at `runner/image`, `image.new` and `image.old`. The folder is left as it was, and the image is in place, the runner's user's, 0700. Against the build code of `17d6b7b`, with only the stand-in's reading put in, the test fails: the image's files were written into that folder |
| 1 | A VM that is lost is logged as one whose program exited, and its error is dropped; one that never started too | Fixed (D139): `sandbox.vm_closed` says `lost` or `not_started` in `ended`, and a lost VM also logs `sandbox.vm_lost`, with the error's name and code, but not its message, which can quote the guest's output (`errorFields`). Gondolin's error then is a plain `Error` (7.2). Sandbox tests: QEMU killed a second into a run, with KVM and under emulation; and the test of a VM that doesn't boot in time looks for `not_started` |
| 2 | A run ends when the program's output closes, not when it exits | A line in D139, as the review said |
| 3 | `hide` on a writable mount is accepted and ignored | Fixed (D152), the review's first way: `checkRunSpec` refuses it. Case in `runnerfiles` |
| 4 | The pin isn't as strict as D144 says: a second install of pi without a version, `… ; echo --ignore-scripts`, and `… && node /usr/local/bin/pi --version` pass | Fixed (D144), the review's way and a little further: every mention of the package counts, with or without a version, a path among them; the install command must be plain words, which also refuses a newline, `$(…)`, a backquote, a quote and a redirection; and no other word about scripts, such as `--ignore-scripts=false` or `--no-ignore-scripts`. Each is a case in `image`, the review's three among them |
| 5 | Section 10's "also when the data folder is `/data`" has no test; the review ran it by hand, and row 14 holds | Said in 7.5, with what the review saw. The plan's milestone 13 checks it again in its containers |
| 6 | `packages.txt` holds 100 packages, not 102 | Corrected in 7.2, 7.5 and the pull request's description: 102 lines, two of them comments. The build after these changes listed 100 again |
| 7 | The fetch of Alpine's index has no time limit, and a failure there throws away a finished build | Fixed: each index is fetched within `APK_INDEX_TIMEOUT`, 1 minute, body included (D147, D150; DESIGN.md 8.6). A build that fails there still fails, since `packages.txt` is part of a build (6.12): it is built again from the start, and what it built is removed by the next. Test in `image`, with an index that never comes |

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, from clean clones of the branch at `a54859f`, which changes the code; the commit after it changes only this section:

| Command | Result |
|---|---|
| `npm ci && npm test` | 577 tests: 536 pass, none fail. 41 skip themselves: 31 need the image (18 of milestone 0, 13 of this milestone) and 10 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 579 tests: 569 pass, none fail, in 112 seconds. The 10 root tests skip themselves. Boots of 1.9 to 2.5 seconds. No QEMU left |
| The root-test command of section 3 of the plan, on a second clone | Node 24.22.3: 526 pass, none fail. 51 skip themselves: 31 need the image, 10 are about what root can read or write anyway, 4 need wacli, 4 `mke2fs`, and 2 run `scooter bridge` as a process. The three new tests of `build-image` run there, the root test among them |
| The new root test against the build code of `17d6b7b`, in the same container | Fails: the image's six files were written into the folder of root's the links led to |
| The `image`, `runnerfiles`, `paths`, `limits`, `run`, `failures`, `cli` and `imports` tests, 16 times, 8 at once | No failure |
| The two changed sandbox tests without the `kvm` group, so under emulation | Both pass; the VM was lost 7.7 seconds after it was made |
| `scooter build-image`, as `agentw`, with `DATA_DIR` in a scratch folder | Gondolin's container build under rootless Docker, now into `.image-build/image`: 16.5 seconds, 527 MB, pi 1.5.2, and 100 packages in `packages.txt`. Afterwards the data folder held only `runner/image/`. The sandbox tests' `pi --version` and end to end pass on that image, with boots of 1.8 to 2.1 seconds |

Not verified, besides what 7.5 lists: a native build as root with Gondolin's real builder (gate G2), which the root test stands in for with the fake builder. The test swaps its links in at one moment of the build, from inside the builder, and as root, not as the runner's user; what D151 leaves to a swap doesn't depend on the moment, since root takes no step in `runner/` but the two renames.

## Milestone 8: network policy and log

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 6.6, 6.9, 6.13, 8.6, and sections 10 and 14, to say what this milestone settled (8.4 here). It also settled the four smaller points of the second review of milestone 7, and the points earlier reviews had left for it (8.3).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/runner/sandbox/policy.mjs` | The network policy: hosts, the key, OpenRouter's two routes and their checks, the hook's own encoding of the body, ZDR, the internet switch, and the bounds on what a run sends |
| `src/runner/sandbox/netlog.mjs` | Writing the log, and following each request the policy lets out to its answer, from undici's diagnostics channels |
| `src/common/netlog.mjs` | The format, with `response` at the status, and two new events, `end` and `unlogged` |
| `src/runner/sandbox/gondolin.mjs` | The policy as the sandbox's network, a placeholder for the key new at each run, the request body's limit, and a VM that doesn't boot within the run's time |
| `src/runner/failures.mjs`, `src/bridge/status.mjs` | A refusal at OpenRouter in the cause of a failure; refusals a run only counted in `/status` |
| `src/runner/sandbox/image.mjs` | The pin of pi, stricter; `build-image` where it can't write |
| `src/common/limits.mjs` | Three constants |
| `test/policy.test.mjs`, `test/support/policy.mjs` | The policy's tests, with Gondolin's handling of the key around the hook and a fake upstream on this machine |
| `test/live/openrouter.mjs` | The live check: pi in a VM, through the runner and the policy, against the real OpenRouter with a dummy key |
| `test/support/sandbox.mjs`, `pi-stub.mjs` | The fake model behind the policy for the sandbox's tests; the stub writes the new format, and policy refusals |

### 8.1 Decisions

**D153. The policy is the sandbox's network.**
*Choice:* `openGondolinSandbox` takes `policyNetwork({ paths, clock, log })` as its network unless a test gives another, and `refuseNetwork` (D141) is gone. For each run it makes a new placeholder for each secret, `scooter-openrouter-api-key-placeholder-<48 hex digits>`, gives it to Gondolin as the secret's `placeholder` and to the network as `placeholders`, so the hook knows what the VM sees; and calls the network's `close()` once the VM has closed, on every path. The VM's `maxHttpBodyBytes` is `MODEL_REQUEST_MAX_BYTES`: Gondolin refuses a longer body with 413 before the hook sees the request, which leaves no line, and nothing goes out. Since milestone 9, 6.13 of DESIGN.md says so too (the review of milestone 8, smaller point 3).
*Reason:* the plan's list for this milestone. Gondolin's own placeholder could only be read back once the hooks were made; giving one is plainer, and Gondolin checks it as its own.

**D154. Hosts.**
*Choice:* `openrouter.ai`, exactly, over HTTPS, by its two routes (D155). With `AGENT_INTERNET=on`, any other host over HTTPS, on any port, and Gondolin then refuses a private address, whether named or resolved, with `allowedHosts: ['*']`; off, `allowedHosts` is `openrouter.ai`. Refused whatever the switch: plain HTTP; OpenRouter's other hosts, `*.openrouter.ai`; and `openrouter.ai.`, with a dot at the end, which Gondolin's host patterns could take for `openrouter.ai`, and send the key to. A method that isn't all capitals is refused: every method a tool uses is, and the log keeps no other.
*Reason:* 6.13, which reaches OpenRouter only by its two checked routes. Without OpenRouter's other names refused, a request with internet access on could reach OpenRouter past the checks.

**D155. What a request to OpenRouter may be.**
*Choice:*
- **Routes:** `POST /api/v1/messages`, with no query string or `?beta=true`, and `POST /api/v1/chat/completions`, with none, on port 443. Anything else on `openrouter.ai` gets 403.
- **Allowlists:** the top-level fields and `anthropic-beta` values the pinned pi sends on each route for any model of its catalog, at the three thinking levels milestone 0 asked (`catalog.json`), which is the choice D10 left: messages, `max_tokens`, `messages`, `model`, `output_config`, `stream`, `system`, `thinking` and `tools`, with three `anthropic-beta` values; chat, `max_completion_tokens`, `messages`, `model`, `reasoning`, `store`, `stream`, `stream_options` and `tools`, with none. A test compares them with the catalog.
- **Tools:** each a function on the chat route, and without a `type` on the messages route, where a type names a server tool.
- **Content:** each block of a message, or of a tool result, or of the system prompt, is a kind pi sends, or another inline medium: on the messages route `text`, `image`, `document`, `tool_use`, `tool_result`, `thinking` and `redacted_thinking`, an image or document only with a `base64` source; on the chat route `text`, `image_url` with a `data:` URL, `file` with nothing but `filename` and a `data:` URL in `file_data`, and `input_audio`. Anything else, such as `video_url` or a `search_result`, is refused.
- `plugins` and `mcp_servers` are refused by name, so the log says so, though the allowlist would refuse them too.

*Reason:* an allowlist from one model would refuse others a configured model could need, such as `interleaved-thinking-2025-05-14`, which `anthropic/claude-sonnet-4.5` sends; every value in the union is one pi sends, and none has OpenRouter fetch anything. Kinds of content are allowlisted so that a new one that could make OpenRouter, or the model's provider, fetch a URL fails closed. Message fields and roles aren't checked: 6.13 doesn't ask it, and none fetches. *Cost:* a thinking level milestone 0 didn't ask, or a model added to OpenRouter after pi 1.5.2, could send a field outside the union. Its first request is then refused, and runs pause with the policy's reason (D160).
*Headers* (since milestone 9, for the review of milestone 8, smaller point 6): the headers other than the key's and `anthropic-beta` aren't allowlisted, and go to OpenRouter as the VM sent them. 6.13 asks no more, and none is known to make OpenRouter fetch anything: the ones it reads of an app's, `HTTP-Referer` and `X-Title`, only name the app on its dashboard, and neither can hold the key or its placeholder (D156). `Host` is written by the HTTP client from the URL the hook checked, whatever the VM sent, as the review saw with Node's undici and Gondolin's. An allowlist of pi's headers would have to be captured again with every pi, as the body's fields are, for nothing it is known to stop.

**D156. The key goes only where pi sends it.**
*Choice:* on `openrouter.ai`, the key's header for the route, `x-api-key` on the messages route and `authorization` on the chat route, must be exactly the placeholder, `Bearer <placeholder>` on the chat route; the other header must be absent; no other header may hold the placeholder, nor any the key itself. To any other host, no header may hold the placeholder or the key. Each is refused with 403 and its own reason.
*Reason:* the plan's rule, "A key of pi's own" (the third review of milestone 4, point 3): a request with a key a misled agent found would get 401 from OpenRouter, which is a setup error. Gondolin swaps the placeholder wherever it is in a header of a request to `openrouter.ai`, so one in, say, `X-Title`, which OpenRouter shows as the app's name, would put the key there. The key itself in a header is what a redirect from OpenRouter would carry to its next hop, which Gondolin hands to the hook again (8.2). Gondolin refuses the placeholder to another host too, but after the hook, with no line in the log.

**D157. The body that goes out.**
*Choice:* the body is read whole, up to `MODEL_REQUEST_MAX_BYTES`, decoded as UTF-8 that must be valid, parsed, checked, and sent as `JSON.stringify` of what was checked, with `content-length` and `content-encoding` dropped; a body with a `content-encoding` but `identity` is refused, since it can't be read. With `OPENROUTER_ZDR=on`, `provider` is `{ zdr: true, data_collection: 'deny' }` on the routes `ZDR_ROUTES` names, both for now. pi sends no `provider`, so a body with one is refused as a field pi doesn't send, and "whatever pi sent" (6.13) holds by refusing, not by overriding.
*Reason:* 6.13, and the plan's per-route switch. Refusing a `provider` of the request's own is the simpler of the two, and leaves nothing of the agent's choosing in the routing.

**D158. The log's format, as the policy writes it.**
*Choice:* D81's format, changed where milestone 4 left it to this milestone:
- `response` is written when the status arrives, with `ms` to the status, and no byte counts;
- `end`, new, when the answer is over: `sent` and `received`, the bytes of the request and the answer on the connection, heads included, and `ms` from the request line, with a `reason` when the answer was cut short (the client's error code, or `run_ended`);
- `error` also says `not_sent`, for a request the policy let out that never reached the client, as when Gondolin couldn't resolve its host, and `run_ended`, for one with no status when the run ended;
- `unlogged`, new: `{ at, event, refused }`, the refusals of a run past `RUN_REFUSALS_LOGGED_MAX`;
- a host is written in lower case, with any character but letters, digits and `._:[]-` as a URL writes a byte, so the reader's test now takes `_` and `%` too; it is cut at 253 characters, DNS's longest name.

*Reason:* D82's cost: with the status written at the end of the stream, a run that timed out while the model streamed would read as an outage, and be tried every 30 minutes for good. The bytes come from the connection, since undici says nothing of a body's size as it passes, and on a connection a request has to itself, as undici's are, they are the request's own. *Cost:* no product had written the log before, so no reader of an older format is kept.

**D159. Following a request to its answer.**
*Question:* the hook writes the `request` line. What comes of the request is undici's, inside Gondolin, which the hook doesn't see, and the design logs it from undici's diagnostics events (13.4). The two must be told apart.
*Choice:* the hook sets a header of its own, `x-scooter-request`, holding the request's ID, on every request it lets out, in place of any the VM sent. The runner subscribes to `undici:request:create`, which undici publishes as it makes a request, before it has a connection, takes the header out of the request's list of headers, which undici writes only once it has a connection, and follows that request by undici's own object: `undici:client:sendHeaders` for the connection's byte counts, `undici:request:headers` for the `response` line, and `undici:request:trailers` or `undici:request:error` for the `end` or `error` line. When the run's network closes, what is left is written: `not_sent` for what never reached undici, `run_ended` for what was still waiting.
*Reason:* matching undici's requests to the hook's by method and URL fails two ways: a request Gondolin let out and then didn't send, which happens when a host doesn't resolve, as when the machine is offline and pi tries again, takes the next request's answer; and two requests to one URL at once can swap. Both lead the failure handling to the wrong status. A hook of Gondolin's that makes the request itself, its `fetch` option, would lose the guarded connection Gondolin makes only with its own client, which keeps a name that resolved to a public address from connecting to a private one. *Cost:* taking the header out reaches into undici's request, whose headers are a list of names and values in undici 6.28.0 (Node 22.23.2), 6.29.1 (Gondolin's) and 7.30.2 (Node 24.22.3), each checked by a test or a run (8.2). If a later undici keeps them otherwise, the header goes out as it is, an ID of no use to anyone, and the request has no answer in the log; the policy's tests would fail first.

**D160. A refusal at OpenRouter, in the cause of a failure.**
*Question:* the plan's rule: a request the policy refuses on `openrouter.ai` has a `refused` line and no `request` line, so a run that ends on one read as pi's own failure; when the refused request is the pinned pi's own, that is nearer a setup error (the first review of milestone 4, point 6).
*Choice:* the failure handling reads the last request to OpenRouter, or the last the policy refused there, whichever came later. A refusal before any request had gone to OpenRouter in the run is a setup error, "the network policy refused pi's request: <reason>"; a later one is pi's own failure, "the network policy refused a request: <reason>". What pi left, an answer cut short and a run that wrote too much still come first, as before.
*Reason:* nothing the agent does can run before the model's first answer, which needs a request that went out, so a refusal before one is pi's own. pi asks the same way all run long (0.4, pi 6), so the policy refusing pi shows at its first request, and no try of the batch can mend it: pausing, with the reason in the notice, holds the messages without using their attempts. A later refusal may be the agent's, from a command it ran, and reading that as a setup error would pause runs for as long as the message that misled it is in the batch, as D156 is there to prevent. *Cost:* a pi whose later requests differ in shape from its first, which pi 1.5.2's don't, would use the items' attempts.
*A request the agent makes itself* (since milestone 9, for the review of milestone 8, smaller point 1): the policy lets out any request shaped like pi's that carries the placeholder, whoever sends it, and the VM's environment holds the placeholder. So a misled agent can send one with `curl`, and the failure handling reads what came of it as OpenRouter's answer to pi: a request still waiting when pi is killed reads as an outage, and so would a 429 or a 402 that OpenRouter gave it. The batch is then tried every 30 minutes, or held as a setup error, for as long as the message that misled the agent is in it: the kind of case D156 and this decision close for a key of the agent's own and for a refusal, reached another way. Nothing tells pi's requests from the agent's, which both come from the VM with the placeholder. A fix is a choice for the owner, such as a limit on how many tries in a row one batch may end as an outage or a setup error, which a long outage would then make spend the messages' attempts, where 6.9 says it never does. Left as a cost: the plan's milestone 14 lists it among what isn't done, for the owner. The review gave it with a dummy key, as lines given to the failure handling, not in a VM.
*The owner's answer* (2026-11-18, before milestone 14; 14.1): accepted as it is, "this is ok". Nothing changes. The README lists it among the known limits, with what takes a WhatsApp message's text out of what the agent is shown, its deletion (6.5); DESIGN.md section 9 has it among the accepted risks.

**D161. What one request, and one run, add to the log.**
*Choice:* a path is cut at `NETLOG_PATH_MAX_CHARS`, 1,000 characters, a host at 253, a reason at `REASON_MAX_CHARS`, with what the VM chose, such as a field's name, at its end; a line the writer would make longer than `NETLOG_LINE_MAX_BYTES` is an error, and no request goes out without its line. One run may make `RUN_REQUESTS_MAX`, 1,000, requests that go out; past them the policy refuses. It writes its first `RUN_REFUSALS_LOGGED_MAX`, 100, refusals one by one, and counts the rest in one `unlogged` line when the run's network closes.
*Reason:* the plan's rule, from the fifth review of milestone 4: a line a reader skips is a request the failure handling doesn't see. A request that goes out has a line before it goes, so requests can't be counted instead of written; they are bounded instead. A run makes a request a turn: a few hundred in the longest run `agents.yaml` allows. So a run adds at most about a megabyte, where a misled one could have added hundreds. *Cost:* a run past 1,000 requests fails as pi's own failure.
*Since milestone 9* (the review of milestone 8, smaller point 2): a request is counted when it passes the check, before its body is read, and given back if it is then refused. Counted once it went out, requests whose bodies were read at the same time each passed the check: with the limit at 2, eight sent at once all went out, and Gondolin handles up to 128 at once. Now the limit is exact.

**D162. Three constants.** `NETLOG_PATH_MAX_CHARS`, `RUN_REQUESTS_MAX` and `RUN_REFUSALS_LOGGED_MAX` (D161). 8.6 of DESIGN.md lists them. The longest DNS name, 253, isn't one: it is a fact of DNS, as the socket path of D150 is of Linux.

**D163. What a refusal answers.**
*Choice:* an error in OpenRouter's shape, `{"error":{"message":"Scooter's network policy refused this request: <reason>","code":<status>}}`: 403 for a host, a path, a method or the key; 400 for what the body or its headers hold; 500 when the policy itself fails, and 503 when the request's line can't be written, neither of which lets anything out.
*Reason:* pi prints an error it gets on stderr (0.4, pi 5), where the owner and the logs can see why a run failed; 6.13 gives the two statuses.

### 8.2 Facts found

On the Linux machine, with Gondolin 0.14.0, Node 22.23.2 and, in the plan's root container, Node 24.22.3:
- undici publishes `undici:request:create` in the request's constructor, with its headers as a list of names and values, which it writes when the request has a connection: taking a header out there keeps it off the wire, with Node's own undici 6.28.0 and 7.30.2 and with Gondolin's 6.29.1. A connection refused gives `undici:request:error` with `ECONNREFUSED`; a body cancelled after the status gives it with an `AbortError`, whose code is a number. `fetch` refuses a port on the Fetch standard's list of bad ones, such as 1 or 9, before it makes a request at all.
- By Gondolin's source: with an `onRequest` hook of the caller's, every HTTP(S) request reaches the hook before any lookup or check of an address, and Gondolin follows a redirect itself, handing each hop to the hook again, with the headers of the hop before, the key among them. It refuses a request whose body is longer than `maxHttpBodyBytes` before the hook, and substitutes a placeholder anywhere in any header of a request to the secret's hosts, after the hook. An answer the hook gives itself is read whole before the VM gets it.
- HTTPS from the VM to a private address given as a number, `10.0.0.1`, `169.254.169.254` or the host's own on the LAN, is refused by Gondolin before the hook sees anything of it.
- OpenRouter answered pi's first request on each route, with a well-formed key it doesn't know and the `provider` fields of ZDR, with 401 "User not found." in 70 to 440 ms, over three runs. It decides that before the body, so the run doesn't show the messages route takes the fields (section 14). pi's first request was about 15.8 KB on the connection, the answer 1.2 KB.
- pi 1.5.2's real requests pass the policy, on the messages route, in the sandbox's end-to-end test, and on both routes in the live check.

### 8.3 The reviews of the pull requests merged before this one

Pull request 8, milestone 7, was approved by its second review with four smaller points:

| # | Point | What became of it |
|---|---|---|
| 1 | The pin still passes `--ignore-scripts false`, `--no-ignore-s` and `--ignore-s=false`, which npm reads as turning the scripts back on | Settled, the review's first way: the install command is `npm install`, pi, and switches from a short list, the build file's own and `-g`, `--ignore-scripts` among them (D144). Cases in `image`, the review's three among them |
| 2 | With `timeout_minutes: 1`, a VM that never boots is a run that timed out, not one the sandbox couldn't run | Settled, the review's first way: a run whose time ends before its VM has booted rejects as "the VM couldn't start" (D149; DESIGN.md 6.6, 6.9, section 10). Sandbox test, with the run's time at 200 ms and the start limit at ten minutes |
| 3 | Without root, in a data folder it can't write, `build-image` fails with Node's own error and 1 | Settled: it says it runs as root on a native install, with 2, for the data folder and for the runner's (D145). Test in `image`, which skips itself as root |
| 4 | `test/paths.test.mjs` lost the space after a colon | Settled |

Its first review's seven smaller points and must-fix were settled in milestone 7 (7.6), and the second review found them so. Pull request 7's second review's eight points were settled or left with a reason in milestone 7 (7.3).

The points the reviews of milestones 0 to 6 left, as 7.3 has them:

| From | Point | What became of it |
|---|---|---|
| Milestone 4, first review, point 6 | A request the policy refuses on `openrouter.ai` reads as pi's own failure | Settled (D160): pi's first, refused, is a setup error; a later one pi's own. Tests in `failures` and `runner` |
| Milestone 4, third review, point 3 | A request to `openrouter.ai` with a key of pi's own would read as a setup error | Settled (D156): refused, with every other place the key or its placeholder could go. Tests in `policy` |
| Milestone 4, fifth review, point 1, as the plan carried it | Bound what one request, and one run, add to the log | Settled (D161). Tests in `policy` and `limits` |
| D82's cost, as the plan carried it | A run that times out while the model streams would be an outage | Settled (D158): the `response` line is written at the status. Tests in `policy` and `failures` |
| Milestone 4, first review, points 4 and 5 | `RestartSec`; a runner started during `rebuild` | Left, for milestones 12 and 9 |
| Milestone 4, fourth review, point 2 | Work past `run.lock`'s time | Left, for milestone 10 |

### 8.4 Changes to DESIGN.md

None changes what Scooter does beyond what 6.13 and the plan left open:
- 6.6: a VM that doesn't boot within the run's own time is one that couldn't start (D149).
- 6.9: a refusal at OpenRouter in the cause of a failure (D160); the VM that doesn't start within the run's time.
- 6.13: OpenRouter's other hosts and its name with a dot at the end (D154); the key's header (D156); the allowlists for any model of pi's catalog, and the kinds of content (D155); what a refusal answers (D163); `provider` and the per-route switch (D157); the log's format, its bounds, and how the runner follows a request (D158, D159, D161).
- 8.6: the three constants of D162.
- Section 10, Network policy: the key's other places, the `response` line at the status, the bounds, and a refusal in the cause; Sandbox: the run's own time.
- Section 14: the live check sent the ZDR fields on the messages route and got 401, which doesn't settle the item.

ARCHITECTURE.md 2.8 says the same in a few words. `runner.env.example` says what `AGENT_INTERNET` leaves refused either way, and where the log is.

### 8.5 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, from clean clones of the branch at `92b014a`, which holds all the code and tests; the commit after it changes only this section:

| Command | Result |
|---|---|
| `npm ci && npm test` | 644 tests: 601 pass, none fail. 43 skip themselves: 33 need the image (18 of milestone 0, 15 of the sandbox) and 10 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 646 tests: 636 pass, none fail, in 114 seconds. The 10 root tests skip themselves. Boots of 1.9 to 2.7 seconds. No QEMU left |
| `test/sandbox.test.mjs` with KVM, twice more | All pass each time; the fastest boots 1.8 seconds |
| The changed sandbox tests without the `kvm` group, so under emulation | All 5 pass, the network's two cases among them, in 71 seconds |
| The root-test command of section 3 of the plan, on a second clone | Node 24.22.3: 590 pass, none fail. 54 skip themselves: 33 need the image, 11 are about what root can read or write anyway, 4 need wacli, 4 `mke2fs`, and 2 run `scooter bridge` as a process. The policy's tests run there, with Node 24's undici 7.30.2 |
| The `policy`, `failures`, `status`, `runner`, `image`, `limits`, `run` and `imports` tests, 16 times, 8 at once | No failure |
| The `policy`, `runner` and `failures` tests under `strace -f -e trace=connect,sendto,sendmsg` | They connect to `127.0.0.1` and a Unix socket of their own, and to nothing else |
| `SCOOTER_TEST_IMAGE=… sg kvm -c 'node test/live/openrouter.mjs'`, the live check, three times, the last from the clean clone | Both routes, each time: pi's first request passed the policy and reached the real OpenRouter, which answered 401 "User not found." in 70 to 440 ms; the log has its request, its status and its end; the runner took it as a setup error, paused runs, counted no attempt, and its reason is "OpenRouter: User not found."; `curl https://example.com/` in a VM of the same sandbox was refused by the policy, its only line. No QEMU left |

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Where |
|---|---|
| A request shaped like the pinned pi's passes on each endpoint, and goes out with the real key in place of the placeholder | `policy.test.mjs`: the first and last request of each fixture session, through the hook and Gondolin's own handling of the key, to a fake upstream that gets the key, the body with ZDR and not the policy's header. `sandbox.test.mjs`: pi's real requests in a VM, through the policy, to the fake model |
| Each refusal: another model, `:online`, a tool not `function` or a server tool, `plugins`, `mcp_servers`, an unknown field or `anthropic-beta` value, media by URL, another path or method on `openrouter.ai`, another host with internet off, plain HTTP with it on | `policy.test.mjs`, 29 cases, each with its status, its reason in the log, and nothing let out; `sandbox.test.mjs`, from inside a VM |
| A body with a duplicated key goes out only as the hook's own encoding | `policy.test.mjs`, both orders |
| The placeholder is replaced only on requests to `openrouter.ai` | `policy.test.mjs`: seven cases of the key or its placeholder where pi doesn't send it, and a request elsewhere that goes as it was, with no key |
| ZDR on and off, on both routes; a refusal for no ZDR endpoint pauses runs with that reason | `policy.test.mjs`; `runner.test.mjs` (milestone 4) |
| The `request` line before the request goes out; streamed responses not held back; `/status`'s counts | `policy.test.mjs`: the upstream finds the line already there, and the status is in the log and the first event at the client while the answer goes on; `status.test.mjs`, with an `unlogged` line |
| Beyond section 10 | `policy.test.mjs`: the allowlists against the catalog, what came of a request with no answer, never sent or cut by the end of the run, the bounds, a header of the VM's own with the policy's name, and Gondolin's own undici; `failures.test.mjs` and `runner.test.mjs`: a refusal at OpenRouter, first and later; `sandbox.test.mjs`: internet on, a VM that doesn't boot within the run's time, and a 401 through the real sandbox taken as a setup error; `image.test.mjs`: the pin, and `build-image` where it can't write |

The milestone's "done when": the policy tests pass, and on the Linux machine pi in a VM reached OpenRouter's chat endpoints with a dummy key, on both routes, while `https://example.com` was refused; OpenRouter answered 401, and the runner treated it as a setup error (the live check, above).

Not verified:
- **Whether the messages route takes the ZDR fields,** and ZDR-only routing for the model: OpenRouter answers a key it doesn't know before it reads the body. Gate G4, with the owner's key (section 14).
- **A redirect from OpenRouter,** which Gondolin would follow and hand to the hook again: by Gondolin's source, and a hook test with the key in a header as the next hop would carry it, not seen.
- **A name that resolves to a private address,** which Gondolin refuses after the hook, leaving a `request` line and a `not_sent` one: by Gondolin's source and the hook's test, not seen in a VM, which would need a name that resolves so, and a lookup outside the machine.
- **The bytes of a TLS connection** as undici counts them for `sent` and `received`, against a packet count. The live check's figures are of the right size for pi's request and OpenRouter's answer.
- **arm64 and macOS.** Nothing here knows the architecture; `node:diagnostics_channel` and undici's channels are the same on macOS.

## Milestone 9: rebuild and backfill

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 6.10, 6.11, 6.13, 8.4 and section 10, to say what this milestone settled (9.3 here). It also settled the six smaller points of the review of milestone 8, and the point earlier reviews had left for this milestone (9.2).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/runner/replay.mjs` | Replayed batches, which a rebuild and a backfill share: one of the owner's days each, `Now:` the batch's own time, a session for each day, and removing a replay's sessions |
| `src/runner/rebuild.mjs` | `scooter rebuild <agent>`: the tag, the reset, the replay with its own lane in memory, the one commit, and what it says on its output |
| `src/runner/backfill.mjs` | A backfill's batch, the prompt's line, its skills, what it may change, its lane settled, and its summary |
| `src/runner/batch.mjs` | Batches drawn from a lane, up to a `seq`; `fitBatch`, shared with replays |
| `src/runner/run.mjs` | Replayed batches as runs: their sessions, skills and commit messages, silent, and a backfill's check of what it changed |
| `src/runner/failures.mjs` | `settleLane`, for the live lane and a backfill's; `pauseAfterRun`; a change a backfill may not make, in the cause |
| `src/runner/main.mjs` | A backfill's batches and its finishing in the loop; `holdRunnerFolder` and `readyAgentFolder`, shared with the rebuild |
| `src/runner/git.mjs` | The staged changes, the last commit, a tag, and folding commits into one |
| `src/common/instance.mjs`, `src/runner/sandbox/image.mjs` | Who holds `runner.sock`, named in the error, which has a code |
| `src/runner/sandbox/policy.mjs` | `RUN_REQUESTS_MAX` exact for requests read at the same time (9.2) |
| `src/cli.mjs` | `scooter rebuild` |
| `test/replay`, `rebuild`, `backfill` | This milestone's tests, with a sandbox test of a rebuild's batch in a VM, and additions to `policy` for the review |
| `test/support/pi-stub.mjs` | A backfill's batch: the file it may change and the day page; `UNSURE` and `OUTSIDE` |

### 9.1 Decisions

**D164. A replayed batch is of one of the owner's days: the local date of each item's `at`.**
*Question:* 6.10 has a replayed batch's items "come from one of the owner's days (in `SCOOTER_TZ`)". Which day is a message's: the date of its `at` in the owner's zone, or the session's day, which changes at `SESSION_ROLLOVER_HOUR` (6.6)? And where does a retry, or a message an edit brings in, stand?
*Choice:* a batch is drawn as a live one is (6.5): due retries first, then work items after its lane's cursor, at most `BATCH_MAX_ITEMS` and within `PROMPT_MAX_BYTES`, up to the `seq` the replay stops at. Every item it takes was sent on the local date of the first item's `at`, and it stops at the first sent on another date. So a batch is a run of items one after another, and a message caught up late, whose `at` is on an earlier day than those around it, is a batch of its own. A message that an edit or a deletion in the batch brings in, from the lane's retries or from what it gave up on, joins whatever its day, as it may take a batch past 20 (6.5), and is shown with its date.
*Reason:* `Now:` is the batch's own time (D165), so that "today" in an old message means what it meant then. With the local date, every item a batch takes was sent "today" by its `Now:`. With the session's day, a message at 00:10 would share a batch with one at 23:50, and one of the two would be read against the other's date. A message brought in is the 6.5 rule against handling an edit before the message it changes, which would file the old text later; it is shown with its date, so "today" in it isn't misread.
*Cost:* a message sent just after midnight is in the next day's session, where a live run would have had it in the day before's until `SESSION_ROLLOVER_HOUR`. A session is the agent's conversation, not where anything is filed.

**D165. `Now:` is the time of the batch's newest item, by `at`.**
*Choice:* the latest `at` among the batch's items. The header shows it; item times are shown against it, so the batch's items show only their time, and one brought in from another day its date too.
*Reason:* 6.10. The latest, so that `Now:` is never before an item it shows.

**D166. A replay's sessions.**
*Choice:* each of the owner's days gets `<agent>-rebuild-<day>`, or `<agent>-backfill-<id>-<day>`, the day as D164 has it. With `session: none`, a replay runs without a session, as live runs do. A replay's sessions are removed when it is over: a rebuild's when it has finished, a backfill's when it finishes or a start drops it. Only names of the form `<prefix><date>.jsonl` go, so the backfill `people-1-2` keeps its own when `people-1`'s go.
*Reason:* they serve the replay alone: no live run uses them. A rebuild of a year makes about 365, up to `SESSION_MAX_BYTES` each, and `agents/` is backed up ([What a backup holds](architecture/backups.md#what-a-backup-holds)).

**D167. A rebuild holds `runner/runner.sock`, and refuses while `run.lock` is there.**
*Question:* the plan's rules: `rebuild` refuses to start while `run.lock` exists, and can't tell whether an idle runner is up; a runner started during a rebuild removes the rebuild's `run.lock` and git's lock files, and throws away its uncommitted changes (D89); if `rebuild` holds `runner.sock` (D90), a runner can't start during it, and `rebuild` can tell whether a runner is up (the first review of milestone 4, point 5).
*Choice:* it holds the socket, as a runner and `build-image` do, so none of the three starts while another runs. Then it refuses while `run.lock` is there, as the plan says. Holding the socket, it knows no runner is running, so such a lock was left by one stopped by force: it says so, and to remove it. `holdInstance` names who holds the runner's socket, "runner, rebuild or build-image", and gives its error the code `EINSTANCE`, which the rebuild turns into a refusal that says to stop the runner first; `build-image`'s says the same.
*Reason:* the plan's way, which settles the review's point. The lock's refusal stays, though only a leftover can meet it now: removing it would be a second way to do what a runner's start does, for a case that needs a runner killed with `SIGKILL` and not started again. *Cost:* after such a kill, the owner removes `run.lock` by hand, or starts and stops the runner, before a rebuild.

**D168. A rebuild keeps its progress in memory, and sets `cursor` to its `seq` at the start.**
*Question:* 6.10 resets `state.json` in step 3, and sets `cursor` to the `seq` the rebuild stops at in step 5, after the replay. Where is the replay's progress meanwhile, and what does a runner do that starts after a rebuild was cut short?
*Choice:* step 3 resets the state with `cursor` and `commandSeq` both the rebuild's `seq`. The replay works in a state it keeps in memory, the live lane's fields of a state that is never saved, with its cursor from 0, and `performRun` settles that as it settles a live batch's (`stateFile` null). Once done, the state is written again with what the rebuild gave up on in `failed` (D170).
*Reason:* with the cursor at 0 on disk, a runner started after a rebuild cut short, by a stop, a crash or a closed terminal, would give the agent all of history as new messages, with replies and ✅s to every old one. With it at the rebuild's `seq`, that runner goes on after it, and only the views are incomplete until the rebuild is run again. Keeping the progress on disk instead, to resume, would need a field of the state that `/status` and the runner know, and a runner that refuses to start until the rebuild is finished: more than 6.10 asks.
*Cost:* a rebuild isn't resumed. Cut short, it starts from the beginning when run again, and spends again on OpenRouter what it had done. The plan's milestone 14 now has the README say to run it where closing a terminal doesn't stop it.
*Two more costs* (added in milestone 10, for the review of this milestone, smaller point 4):
- Messages that wait when a rebuild starts get no reply. The rebuild stops at the newest `seq` (6.10), so a message that arrived after the runner was stopped is replayed silently: no question about it reaches the owner, and no ✅. A rebuild run again after one cut short takes a new `seq`, so everything that arrived during the first try is filed so too.
- A rebuild that didn't finish leaves no mark. After a stop, the person at the terminal is told; after a crash or a reboot, the runner's service starts again and goes on from `cursor`, with the views rebuilt in part, and neither its start nor `/status` says so. A backup taken during a rebuild holds the same. Only the last commit's message shows it: `lifelog: rebuild #…`, where a finished rebuild leaves `lifelog: rebuild`.

The plan's milestone 14 has the README say both: start the rebuild right after stopping the runner, and look at the last commit's message after a crash, a reboot or a restore. A warning at the runner's start when the last commit is a rebuild's batch would be cheap, but it is a choice of what the runner says, and is left (milestone 10, 10.2).

**D169. A rebuild's commits: one per batch while it runs, folded into one `lifelog: rebuild`.**
*Question:* 6.10 commits once, at the end, as `lifelog: rebuild`. A failed batch's clean-up puts back the last commit (6.9), which would then be the views before the rebuild.
*Choice:* the emptied folders are committed first, `lifelog: rebuild, from empty views and memory`, and each batch as it succeeds, `lifelog: rebuild #1-#20`, the lowest and the highest `seq` of its items, so a failed batch's clean-up comes back to the last good one. At the end, the branch is set back to the tagged commit with the index and the files as they are (`git reset --soft`), and one commit is made, `lifelog: rebuild`.
*Reason:* the clean-up needs a commit to come back to after each batch, and 6.10's history is one commit on the tagged one, whose difference from the tag is what the rebuild changed. *Cost:* the commits folded away stay in the repository until git's reflog lets them go, by default after 90 days: some megabytes for years of views. A rebuild cut short leaves its commits on the branch, the next rebuild's tag among them.

**D170. A rebuild's failures, and what it says.**
*Choice:* as the runner's (6.8, 6.9): an item not reported, or in a batch that failed for pi's own reasons, is tried again a minute later, and given up on after `MAX_ATTEMPTS`; one reported `FAILED` is given up on; a setup error or an outage pauses the rebuild until the next try (`pauseAfter`), and the items wait with their attempts as they were. A sandbox that can't run pi pauses it too (D82). It gives way to `backup.lock` before each batch and tries again every `POLL_INTERVAL`. Nothing goes to the outbox, no notice either; it says on its output what each batch did, why it paused and until when, and what it gave up on. What it gave up on goes into `failed` (the newest `FAILED_KEEP`), where an edit of the message brings it back into a live batch (6.5). `lastRun` is null afterwards, as a reset leaves it.
*Reason:* 6.10 replays "silently: nothing goes to the outbox", and the person running it is at the terminal. Waiting out a setup error, rather than stopping, lets the owner mend the key without losing what the rebuild had done (D168).

**D171. A rebuild counts every backfill of the config as done.**
*Choice:* the reset's `backfillDone` holds the old list, the backfill in progress, which 6.10 drops, and every `backfill` entry of the config.
*Reason:* 6.10 drops a backfill in progress "because the rebuild covers its view". Dropped without being counted done, the next start would begin it again from the start of the datastore (6.4), and an entry not started yet would begin too: each would run the whole history through a skill the rebuild already ran it through.

**D172. The tag, and the rebuild's command.**
*Choice:*
- The tag is `before-rebuild-` and the start's UTC time to the second, written without `-` and `:`, which git refuses in a name: `before-rebuild-20261118T101500Z`. A name taken, which only two rebuilds in one second could make, fails the rebuild before it changes anything.
- `scooter rebuild <agent>` takes one argument, the agent's name. It reads `runner.env`, as the runner does, since its batches need the key. It opens the Gondolin sandbox as the runner does, and readies the agent's folder as a start does (D89), so uncommitted changes there are thrown away. It stops on `SIGTERM` or `SIGINT`: the batch in progress is thrown away, as at a runner's stop.
- Exit codes: 0 once it has rebuilt; 2 for a call or a configuration it can't start with (no such agent, `agents.yaml`, a runner running, `run.lock`, a sandbox that can't run as it is set up); 1 when it fails or is stopped.
*Reason:* 8.4 and the exit codes of D30.

**D173. A replayed message is shown as it is now.**
*Question:* 6.5 shows every message as it is now, with its latest edit. In a replay, "now" could also be the batch's own time.
*Choice:* as it is now: with its latest edit, even one sent on a later day, `(edited in #N)`, or `(deleted in #N)`. A rebuild reads the datastore once, when it starts, so for it "now" is then; a backfill's index is the runner's.
*Reason:* the index holds a message as it is now, and an index as of each batch's time would be a second one to keep. The rebuilt views come out the same: the agent files the latest text, and the later edit, when its batch comes, changes nothing; a message deleted since is never filed. *Cost:* a replayed batch can show an edit or a deletion the owner made later than its `Now:`.

**D174. A rebuild's prompt has no line of its own.**
*Choice:* a rebuild's batch has the prompt of a live batch, with `Now:` the batch's time (D165). The agent answers as for a live batch; its texts and reactions go nowhere.
*Reason:* 6.10 gives it none, where 6.11 gives a backfill's. The questions the agent asks again are followed, in the replay, by the owner's answers to the questions it asked the first time, which are in the datastore, so `memory/needs-review.md` comes out as a live run would have left it. Milestone 11's pass over `protocol.md` can add one if the model needs it.

**D175. A backfill's lane, like the live one.**
*Choice:* `settleLane`, in `failures.mjs`, is what a batch's outcome does to a lane's items, for the live lane and a backfill's alike: `{ cursor, retry, failed }`, with a backfill's `skipped` in the place of `failed`. So a backfill's item not reported is tried again a minute later; one reported `FAILED`, or given up on after `MAX_ATTEMPTS`, goes to `skipped`; an edit or deletion in a later batch brings a message back from its retries or `skipped`, starting again at attempt 1 from `skipped`. A setup error or an outage pauses every run, as after a live run (`pauseAfterRun`), and a batch that gets through ends a pause. A backfill's batch sends nothing, no notice either, and leaves `lastRun` alone, so a live failure after it is still the first of its row and sends its notice. The next backfill of the config starts at the next start, as 6.4 has it.
*Reason:* 6.11's "handles them like the live ones (6.8, 6.9)", and the plan's rule that backfill batches don't change `lastRun`.

**D176. What a backfill's batch may change.**
*Choice:* once the check of 6.8 has passed, staging included, the runner lists what the batch staged against the last commit (`git diff --cached --name-only --no-renames HEAD -- views memory`), so a file added, changed, removed or moved. Each must be a file `writes` names, in a folder it names, or in `views/days/`, the day pages. The first that isn't fails the batch as pi's own failure, `changed views/expenses.csv, which the backfill may not change`, and the clean-up throws the batch away. The path is logged cut, as an unexpected file's is (D88).
*Reason:* 6.11. Only git knows every change, so the check reads the staged changes, after the check of 6.8 has limited what git reads.

**D177. A backfill's prompt and skills.**
*Choice:* the prompt's first line is 6.11's, before the header every prompt has, with the backfill's skill and every path of `writes`: `Change only views/people.csv, views/people/ and the day pages.` pi gets the backfill's skill, and `day-pages` when the agent has it, in the agent's order, and the system prompt of live runs.
*Reason:* 6.11 says the prompt starts with it.

**D178. A backfill's summary.**
*Choice:* one text, by `runner`, to `DEFAULT_CHANNEL`, also with `can_message: false`, as notices are (D86): `Backfill people-1 finished: people.csv has 143 rows, 12 marked ❓. Skipped: #1031, #1207.` It names each CSV file of `writes` by its path from `views/`, a folder's at any depth, in order; a write that isn't a CSV gives none; a CSV that isn't there says so; and a folder with none says so. A row is a record after the header, blank ones left out, read as CSV, so a field in quotes may hold a line break; a row with ❓ anywhere in it is marked. The file is read with the care of `readUntrustedFile`, up to `AGENT_FILES_MAX_BYTES`. Then the ID goes to `backfillDone`, and its sessions go. The summary is written before the state is saved, so a crash between the two sends it twice and never loses it.
*Reason:* 6.11. A file is what the last commit holds then, which the check of 6.8 let through, but it is a file pi wrote.

### 9.2 The reviews of the pull requests merged before this one

Pull request 9, milestone 8, was approved by its review with six smaller points. Five are settled, and one is recorded as a cost:

| # | Point | What became of it |
|---|---|---|
| 1 | A request the agent makes itself, with the placeholder, still decides the cause of a failure | Left, recorded as a cost under D160, as the review proposed, and in the plan's milestone 14, for the owner: nothing tells pi's requests from the agent's, and a limit on tries would have a long outage spend the messages' attempts, which 6.9 forbids |
| 2 | `RUN_REQUESTS_MAX` isn't exact for requests read at the same time | Settled, the review's first way: counted before the body is read, and given back on a refusal (D161). Test in `policy`: eight at once with the limit at 2 let out two; on the code before, all eight |
| 3 | A body over `MODEL_REQUEST_MAX_BYTES` gets 413 from Gondolin and leaves no line, which 6.13 doesn't say | Settled: a clause in 6.13 (D153) |
| 4 | Section 10 says the ZDR fields override what pi sent | Settled: section 10 says a body with a `provider` of its own is refused, as 6.13 and D157 have it |
| 5 | The sandbox test with internet access on shows less than its name says | Settled, the review's way: a test in `policy` asks Gondolin's `isIpAllowed`, built from the policy's options, about private and public addresses with internet access on and off; the sandbox test's name and comment say what it shows |
| 6 | Headers other than the key's and `anthropic-beta` go out as the VM sent them | Settled: a line under D155 says they aren't allowlisted, and why |

The points the reviews of milestones 0 to 7 left, as 8.3 has them:

| From | Point | What became of it |
|---|---|---|
| Milestone 4, first review, point 5 | A runner started during `rebuild` | Settled (D167): the rebuild holds `runner.sock`. Test in `rebuild`: a runner can't start during a rebuild's batch, and the rebuild's lock and commits are as they were |
| Milestone 4, first review, point 4 | `RestartSec` for the runner's unit | Left, for milestone 12 |
| Milestone 4, fourth review, point 2 | Work past `run.lock`'s time | Left, for milestone 10 |

### 9.3 Changes to DESIGN.md

None changes what Scooter does beyond what 6.10, 6.11 and the review of milestone 8 left open:
- 6.10: the rebuild holds `runner.sock` and refuses while `run.lock` is there (D167); the tag's form (D172); `cursor` set at the reset, and every backfill counted done (D168, D171); the replay's failures and its output (D170); one commit, with the batches' folded into it, and `failed` (D169); a rebuild cut short is run again from the start; the owner's day of a batch, a message brought in, the sessions with `session: none` and their removal, and a message shown as it is now (D164, D166, D173).
- 6.11: the next backfill starts at the next start, and one dropped isn't counted done; `skipped` and the messages it gives back, the pause, and `lastRun` (D175); the commit message's range; the summary's folders, and that it goes also with `can_message: false` (D178).
- 6.13: a body longer than `MODEL_REQUEST_MAX_BYTES` gets 413 from Gondolin and leaves no line (9.2, point 3).
- 8.4: `rebuild` runs with the runner's service stopped.
- Section 10, Network policy: a body with a `provider` of its own is refused (9.2, point 4).

ARCHITECTURE.md 5.5 says where the two live. The plan's milestone 14 has what this milestone leaves for the README (D167, D168), and the review's first point.

### 9.4 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, from clean clones of the branch at `44e270d`; the root tests and the repeated runs at `3be1461`, which `44e270d` changes only in one line the rebuild prints when it is stopped, and its test:

| Command | Result |
|---|---|
| `npm ci && npm test` | 668 tests: 624 pass, none fail. 44 skip themselves: 34 need the image (18 of milestone 0, 16 of the sandbox) and 10 need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 670 tests: 660 pass, none fail, in 113 seconds. The 10 root tests skip themselves. The fastest of three boots: 2.0 seconds. No QEMU left. The new sandbox test, a rebuild's batch in a VM, passes |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie`, with `SCOOTER_ROOT_TESTS=1`, on a second clone | Node 24.22.3: 613 pass, none fail. 55 skip themselves: 34 need the image, 11 are about what root can read or write anyway, 4 need wacli, 4 `mke2fs`, and 2 run `scooter bridge` as a process. The 21 tests of `rebuild`, `backfill` and `replay` run there, and pass |
| The `rebuild`, `backfill`, `replay`, `policy`, `run`, `runner`, `failures`, `batch`, `image`, `cli`, `imports`, `planning` and `triggers` tests, 16 times, 8 at once | No failure, and no test folder left behind |
| The new test of `RUN_REQUESTS_MAX`, against the policy of `d8595dd` | Fails: eight requests at once with the limit at 2 all go out, as the review found |
| `scooter rebuild lifelog` as a process, by a script run by hand, with the Gondolin sandbox, the test image and KVM, the real network policy and the real OpenRouter, with a dummy key, on a datastore of two messages on two days | The rebuild tagged the commit and said so; pi's request from the VM passed the policy and reached OpenRouter, which answered 401; the rebuild paused as a setup error, "2026-11-07 #1: paused (OpenRouter: User not found.) until 11:51"; `SIGINT` stopped it in 4 seconds with exit code 1. The state had `cursor` and `commandSeq` at #2, nothing was in the outbox, `run.lock` was gone, and no QEMU was left |

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Where |
|---|---|
| Rebuilds: a rebuild stops at the `seq` that was newest when it started, so later messages get normal replies | `rebuild.test.mjs`, the first test: a message the bridge stores during the rebuild's first batch is in no batch, and the runner started afterwards answers it with a reply; no old command is answered again |
| Rebuilds: `Now:` is each batch's own time, and batches don't cross the owner's days | `replay.test.mjs`: three days in Kolkata, two of them on one UTC day, and the same messages in New York; a retry of another day a batch of its own; 20 a batch; `until`; a message brought in from another day. `rebuild.test.mjs`, through the stub. `sandbox.test.mjs`, a rebuild's batch in a VM with the real pi |
| Backfills: `until` is the live cursor when the backfill starts, and every message up to it is covered once | `backfill.test.mjs`, the first test; `agentstate.test.mjs` (milestone 3), `until` at a start |
| Backfills: its batches run only when nothing live is waiting, and a message that arrives during one is handled right after it | `backfill.test.mjs`, the second test; `triggers.test.mjs` (milestone 3) |
| Backfills: a batch that changes anything outside its `writes` and the day pages, `memory/` included, fails and is discarded | `backfill.test.mjs`: `views/notes.csv`, then four attempts and `skipped`; `memory/preferences.md` |
| Backfills: it sends nothing until its summary, its progress survives a restart, and removing its entry drops it | `backfill.test.mjs`: the first test, and "its progress survives a restart" |

Beyond section 10: the rebuild's exclusion of a runner and `run.lock`, its failures, pauses and wait for a backup, its stop, and `scooter rebuild`'s arguments, in `rebuild.test.mjs`; a backfill's setup error and the live notice after it, its lane, its summary's parts, and what it may change, in `backfill.test.mjs`; a replay's sessions, in `replay.test.mjs`.

The milestone's "done when", those tests passing with the fake sandbox: all of `rebuild.test.mjs`, `backfill.test.mjs` and `replay.test.mjs`.

Not verified:
- **A replay read by a real model.** The stub stands in for pi in the tests, and the scripted fake model in the sandbox test; whether a model files old messages well against `Now:` in the past, and keeps a backfill's batch to its view, waits for a real key (gate G4) and milestone 11's prompt and skills.
- **A backfill's batch in a VM.** A rebuild's batch ran in one; a backfill's differs in the prompt's first line, the skills it gets, and the check after it, which run on the host.
- **A rebuild of a datastore of months:** how long it takes and what it costs; and how much git's reflog keeps of the commits folded away (D169).
- **`scooter rebuild` in Docker,** as `docker compose run --rm runner rebuild lifelog` (milestone 13), and natively as `scooter-runner` (milestone 12).
- **arm64 and macOS.** Nothing here knows the architecture.

## Milestone 10: backups

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 5, 5.4, 5.5, 6.10, 8.2, 8.4, 8.6 and section 10, to say what this milestone settled. What it settled of the bridge's side is in [backups](architecture/backups.md), [the WhatsApp channel](architecture/whatsapp.md) and [the exchange](architecture/exchange.md). It also settled the five smaller points of the review of milestone 9, leaving one choice that review offered, and the two points earlier reviews had left for this milestone (10.2).

### 10.1 Decisions

**D181. A rebuild's own steps take `run.lock`** (the review of milestone 9, point 1).
*Question:* only a rebuild's batches took `run.lock`. Its tag, the emptying of `views/`, `memory/` and `sessions/`, the first commit and the reset state, and at the end `git reset --soft`, the commit `lifelog: rebuild`, `git gc --auto` and the removal of its sessions, changed the agent's folder outside it, also while a backup held `backup.lock`. A backup could then read a branch naming a commit it hadn't read.
*Choice:* steps 1 to 3, and 5, run holding `run.lock`, taken as a batch takes it, giving way to `backup.lock` and trying again every `POLL_INTERVAL`, and saying "Waiting for a backup to finish." once. Stopped while it waits before step 1, the rebuild has changed nothing, and says so.
*Not changed:* a runner's start, which throws away what a run cut short left (D88, D89) without `run.lock`. It commits nothing: it puts the index and the files of `views/` and `memory/` back from the last commit, and `git prune` removes only what no commit names. A backup taken during it holds a repository whose commits are whole, and at worst views in part, which the next start puts back from the last commit. Taking `run.lock` there would make a file before what pi wrote is freed, on a disk pi may have filled (D89).

**D182. A rebuild waits for an item to be tried again before the items after it** (the review of milestone 9, point 2).
*Question:* an item not reported is due again a minute later, and the rebuild went on to the following days meanwhile, so the batches of three days, the first not reported, were `[1] [3] [5] [1] [1] [1]`. A rule the owner sent that needed a second try was learned after the days that follow it were filed, where 6.10 has rules "learned again at the point they were sent"; and the retry's context ran from it to the lane's cursor, days ahead, so its prompt showed what the agent had sent on later days.
*Choice:* while the rebuild's lane has an item waiting to be tried again, it waits until the first is due, as it waits for a pause, and takes nothing after it meanwhile. The batches are then `[1] [1] [1] [1] [3] [5]`, and the lane's cursor never passes the day of an item waiting: a retry's context is its own day's, as is every batch's, but for a message an edit brings in from another day (6.5).
*Reason:* the review's first way; nobody waits on a rebuild. *Cost:* at most three minutes for each item not reported, and four attempts each. A backfill isn't changed: it files one view, its rules are the config's, and it runs inside the live runner, where it waits for nothing.

**D193. A rebuild stops on `SIGHUP`** (the review of milestone 9, point 3).
*Choice:* `scooter rebuild` stops on `SIGHUP`, which a closed terminal sends, as on `SIGTERM` and `SIGINT`: the batch in progress is thrown away and `run.lock` let go of. Writing to a terminal that is gone fails, and the rebuild ignores that. A leftover `run.lock` is now said to be "left by a runner or a rebuild stopped by force".
*Reason:* the review's way. A closed terminal is the likeliest way a rebuild is cut short, and killed by the signal it left `run.lock`, which the next rebuild refused.

### 10.2 Facts found, and the reviews of the pull requests merged before this one

Pull request 10, milestone 9, was approved by its review with five smaller points. All five are settled, the fourth by recording its two costs; the warning it offered as a choice is left:

| # | Point | What became of it |
|---|---|---|
| 1 | The rebuild's own steps change the views and `.git` outside `run.lock`, also while a backup holds `backup.lock` | Settled (D181), the review's first way. Test in `rebuild`: a backup that holds its lock at the start, and takes it during the last batch, finds nothing tagged or emptied before step 1, and nothing folded before step 5. It fails on the code before |
| 2 | A replay handles a retried item out of order, and shows it later days' lines | Settled (D182), the review's first way, which also keeps a retry's context to its day. Test in `rebuild`, the review's probe: three days, the first not reported, and no prompt of it showing a later day's reply. It and the changed order of the outage test fail on the code before |
| 3 | A closed terminal leaves `run.lock`, and the next rebuild refuses, blaming a runner | Settled (D193). Test in `rebuild`, with `SIGHUP`; it fails on the code before |
| 4 | Two costs of D168 aren't recorded | Settled by recording both under D168, and in the plan's milestone 14 rule for the README. Left: a warning at the runner's start when the last commit is a rebuild's batch, which the review called a choice; the README is where the owner learns it |
| 5 | Small gaps: the summary with `can_message: false`, a rebuild with `session: none`, and `protocol.md` on a backfill's first line | Settled: a test in `backfill` and one in `rebuild`, which pass on the code before as the review's probes did; `protocol.md` says a backfill's line comes before the time |

The points the reviews of milestones 0 to 8 left, as 9.2 has them:

| From | Point | What became of it |
|---|---|---|
| Milestone 4, first review, point 4 | `RestartSec` for the runner's unit | Left, for milestone 12 |
| Milestone 8, point 1 | A request the agent makes itself decides the cause of a failure | Left, recorded as a cost under D160, for the owner in the plan's milestone 14 |

## Milestone 11: the agent's instructions

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 5.5, now [Restore](architecture/backups.md#restore), 6.1, 7.1, 7.2, 7.3 and section 10, to say what this milestone settled (11.3 here). It also settled the three smaller points of the second review of milestone 10, which are in [backups](architecture/backups.md) and [the exchange](architecture/exchange.md), and the point milestone 9 left for this one (11.2).

What the milestone left in the repository:

| Path | What |
|---|---|
| `config/agents.yaml` | The default config: the example of 6.1 (D199) |
| `config/prompts/lifelog.md` | The agent's prompt (7.2), with the CSV rules and the memory files (D200) |
| `config/skills/*/SKILL.md` | The six skills of 7.3: `expenses`, `runs`, `meals`, `travel`, `people` and `day-pages` (D201) |
| `config/image/build.json` | Unchanged: it was final (D203) |
| `src/runner/protocol.md` | The last pass against the parser (D202) |
| `src/runner/config.mjs` | A skill's `SKILL.md` checked at startup (D197) |
| `test/instructions.test.mjs` | This milestone's tests, which read the files against DESIGN.md and the protocol against the parser |
| `test/config.test.mjs`, `backup.test.mjs`, `sandbox.test.mjs` | A skill's `SKILL.md`; the link at `runner/` or `exchange/`; one batch through the real sandbox with the files of `config/` |
| `test/live/openrouter.mjs` | The live check, now with the files of `config/` |

### 11.1 Decisions

**D197. A skill's `SKILL.md` gives its folder's name and a description, and the runner checks both at startup.**
*Question:* 6.1 checks only that each skill's folder has a `SKILL.md`, and 7.3 says it starts with frontmatter that has `name` and `description`. pi 1.5.2 reads the frontmatter as YAML and offers the model each skill by its name and description, with the path of its file (pi 1). It leaves out a skill whose description is missing or empty, or whose frontmatter isn't YAML, and takes the name from the frontmatter, only warning when it isn't the folder's or isn't of the Agent Skills format's form (`dist/core/skills.js` in pi's package). The runner, the prompt's list of views and a backfill's `skill` name a skill by its folder.
*Choice:* the runner's validation reads each skill's frontmatter as pi does, a first line `---` and YAML up to the next line that starts `---`, a byte-order mark and Windows line breaks allowed, and refuses, naming the skill's field (`agents.lifelog.skills[1] names skills/runs, whose SKILL.md has no description, …`): no frontmatter; frontmatter that isn't YAML, or isn't a map; no `name`, or one other than the folder's; a name pi doesn't take, which is at most 64 lowercase letters, digits and single hyphens between them; no `description`, or an empty one; and one longer than 1,024 characters. Other keys, such as `license`, are left alone.
*Reason:* an owner who adds a skill and forgets its description would otherwise have a runner that starts and an agent that never sees the skill, and nothing would say so; a name other than the folder's would have pi offer the model `expense-tracking` where the prompt says `(skill: expenses)`. 6.1's rule is that any error stops the runner with a message that names the field. The two numbers are pi's, not tuning numbers, so they stay beside the check in `config.mjs`, as Gondolin's socket limits stay in `gondolin.mjs`.
*Cost:* a skill folder named as pi only warns about, such as `Receipts` or `receipts_old`, is refused.

**D199. The default `config/agents.yaml` is the example of 6.1.**
*Choice:* 6.1's example as it stands, with its comments, the commented `once` and `backfill` entries among them, under a two-line comment that says what the file is. So the evening check-in at 21:30 is on. One comment says the paths are "relative to this config folder", where 6.1 says `/config`, which is the folder's name in Docker only.
*Reason:* 6.1 specifies the file, and the owner edits it. The check-in is a message the bot sends on its own every evening, where the bot is quiet by default (principle 6), but 6.1 has it, so it stays, and the plan's milestone 14 has the README say how to remove it.

**D200. What the prompt adds to 7.2.**
*Question:* 7.2 gives the list of views and the rules for every view. It leaves open how the five CSV files are written, where a guess's ❓ goes in a row, and where a note that fits no view goes.
*Choice:* `config/prompts/lifelog.md` has 7.2's list and rules word for word, and adds:
- a paragraph: read a view's skill before changing the view; a view that isn't there yet starts with its skill's header; what is filed goes on its day's page too; what fits no view goes under Notes on its day's page; a message with nothing to keep is reported done;
- the CSV rules, for every view: the skill's header exactly; dates `YYYY-MM-DD` and times `HH:MM` on a 24-hour clock; plain numbers, with a `.` and no signs, units or separators; quoting as RFC 4180 has it; rows sorted by date and time, a row without a time after the others of its date; names written the same way every time;
- a guess is marked in the row's `note`, which starts with ❓ and says what was guessed;
- for a scanned PDF, `pdftoppm` to make the page images 7.2 says to read;
- the two memory files and their lines (7.4), shown at the end of the system prompt (6.5).
*Reason:* every CSV of 7.3 has a `note` column, so a guess can be marked without making a number unreadable to whoever adds up a column, and the backfill's summary (D178) counts a row with ❓ anywhere in it. `pdftoppm` is in the image, with `pdftotext` (D203). The rest is what a model would otherwise choose differently from one run to the next, in files that people read, and that a later assistant will read ([Deferred and out of scope](ARCHITECTURE.md#deferred-and-out-of-scope)).

**D201. What the skills settle that 7.3 leaves open.**
*Choice:* each skill holds what 7.3 gives it word for word, its view, its header, the categories and the day page's template, then a line for each column, and how to file what the owner sends. Inside that, choices of their own:
- `expenses`: `amount` is the grand total as shown, a refund negative; `currency` an ISO code; `payment` never more of a card's number than its last four digits. A split: `amount` the whole bill and `split` who shared it and the owner's part (`with Sam, half`), or, when someone else paid, `amount` the owner's part and `payment` `owed to Sam`; settling up changes the row it settles. `Transport` is getting around where the owner is, `Travel` a trip's tickets and stays.
- `runs`: kilometres, miles converted and said so in `note`; `duration` as `MM:SS` or `H:MM:SS`, the moving time when both are shown; pace as `M:SS` per kilometre; whole beats per minute and metres.
- `meals`: five kinds, `breakfast`, `lunch`, `dinner`, `snack` and `drink`; `est_kcal` rounded to tens, written with `~` on the page; a number the owner gives is used, and its source noted; a person mentioned with a meal stays in its `note`.
- `travel`: times as the ticket prints them, local where each leg departs and arrives; a stay is a row with `mode` `stay`, check-in as `date`, the place as `carrier` and check-out as `arrive`; a cab across town is only an expense; a change updates the row, and a cancellation keeps it, with `cancelled` in `note`.
- `people`: 7.3's rules, and a missing length is a row with `minutes` empty, marked ❓.
- `day-pages`: the page follows the views, and one left empty is removed; the totals one per currency, the home currency first and the others after it in brackets, each with a `+`; a sign for each kind of travel, and a "Booked:" line on the day of booking; ❓ after the part guessed; the links' form, with an example the test checks against the paths.
*Reason:* 7.3 says what each skill contains, and these are the choices within it. Each keeps a row readable by a person, and each column one kind of value.
*Not verified:* how a real model follows them (11.4).

**D202. The last pass over `protocol.md` against the parser.**
*Question:* the plan asks for a last pass over `protocol.md` against the parser (`answer.mjs`), and D174 left it to this milestone to give a rebuild's prompt a line of its own if the model needs one.
*Found:* the protocol said what each line means, and not five things pi and the parser do:
1. pi prints only the model's last message (0.4, pi 5), so what the model writes before or between tool calls, report lines included, reaches no one.
2. An instruction is read only at the start of a line, after trimming, in capitals with its colon. `**DONE: 1050**`, `- DONE: 1050`, `done: 1050` and `DONE 1050` are text, sent to the owner.
3. A range, `DONE: 1050-1053`, isn't read, and a `REPLY_TO` line with anything after its number is dropped, the text after it then going out as a plain message.
4. A `NO_REPLY` line anywhere drops all the answer's text.
5. One answer sends at most `ANSWER_MAX_TEXTS` texts, and in quiet mode a message a `REPLY_TO` answers gets no reaction.

*Choice:* the protocol says all five, with an example answer, and two more things: the time after `Now:` is the one to count "today" from, not the machine's clock; and what the agent makes for itself, such as a converted photo, goes in `$HOME` or `/tmp`, since everything left in `views/` and `memory/` is committed. A test parses the example and checks each claim against `parseAnswer` and `answerEntries`, the number against `ANSWER_MAX_TEXTS`, and the prompt's section names against `prompt.mjs`. 7.1 has the first and the `Now:` rule.
*Reason:* left unsaid, each of the five can make a well-meant answer send the owner its own report lines, or send nothing. A rebuild's batch differs from a live one only in that `Now:` is in the past (D165, D174), while the VM's clock gives the real time, so the line about `Now:` is what a rebuild needs, and it holds for live runs too. So a rebuild's prompt gets no line of its own.
*Not verified:* that a real model follows the protocol (11.4).

**D203. `config/image/build.json` is final as it was.**
*Question:* the plan asks for the final build file.
*Checked:* against 6.12, and against what the prompt and the protocol tell the agent to run. The image has Node, pi 1.5.2, poppler's `pdftotext` and `pdftoppm`, libheif's `heif-convert`, git, ripgrep, fd, `tzdata`, `curl`, and busybox's `sort`, `awk` and `sed`, read out of the test image's file system with `debugfs`; the sandbox test runs `command -v` in a VM for the six programs the instructions name (11.4). Alpine 3.23.8 was still the newest release of 3.23 on 2026-11-18, by Alpine's `latest-releases.yaml`, so D6's reason holds. pi stays at 1.5.2, whose requests the policy's allowlists are (D155).
*Choice:* no change.
*Reason:* nothing the instructions use is missing, and a change would mean building and checking a new image for nothing.

**D204. The instructions' tests read DESIGN.md.**
*Choice:* `test/instructions.test.mjs` takes what the files must hold word for word from `docs/DESIGN.md` itself: 6.1's example, line for line; 7.2's list of views; and 7.3's table of skills, its five headers and ten categories, and the day page's template.
*Reason:* "each CSV header matches 7.3" is then checked against 7.3, not against a copy in the test that could drift from both. *Cost:* a change of wording in those parts of DESIGN.md fails the test until the files follow, which is the point.

### 11.2 The reviews of the pull requests merged before this one

The points earlier reviews and milestones left, as 10.2 has them:

| From | Point | What became of it |
|---|---|---|
| Milestone 9, D174 | A line of its own for a rebuild's prompt, if the model needs one | Settled (D202): none; the protocol's line about `Now:` |
| Milestone 4, first review, point 4 | `RestartSec` for the runner's unit | Left, for milestone 12 |
| Milestone 8, point 1 | A request the agent makes itself decides the cause of a failure | Left, recorded as a cost under D160, for the owner in the plan's milestone 14 |
| Milestone 9, point 4 | A warning at the runner's start when the last commit is a rebuild's batch | Left, as before: a choice of what the runner says, which the README covers (milestone 14) |

### 11.3 Changes to DESIGN.md

None changes what Scooter does beyond what section 7 and the review left open:
- 6.1: a skill's `SKILL.md` gives its folder's name and a description, as pi takes them (D197); 7.3's first sentence and section 10's Config say so.
- 7.1: only the last message is read, the instruction lines at the start of their own lines, and `Now:` is "today" (D202).
- 7.2: the CSV files, and where a guess's ❓ goes (D200).

The plan's milestone 14 has what this milestone leaves for the README, and the review's third point.

### 11.4 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, restic 0.19.1, from clean clones of the branch at `0d19ccd`, which holds all the files and code. `949f30b` changes one sentence of the protocol's example answer, so that the item it reports `FAILED` is told why rather than asked about; `npm ci && npm test` and the run with the image and KVM were run again from a clean clone there, with the same counts:

| Command | Result |
|---|---|
| `npm ci && npm test` | 719 tests: 673 pass, none fail. 46 skip themselves: 35 need the image (18 of milestone 0, 17 of the sandbox), 8 need root, and 3 need root and `SCOOTER_ROOT_TESTS=1` (corrected in milestone 12, for the review of this milestone, smaller point 8: it said 10 and 1) |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 721 tests: 710 pass, none fail, in 114 seconds. The 11 that need root skip themselves. No QEMU left. The new sandbox test passes: pi in a VM, run by the runner with the files of `config/`, is given the protocol, the prompt and the memory in that order, is offered the six skills at their copies in `run/config/` with their descriptions, reads `expenses/SKILL.md` there, finds the six programs the instructions name, writes `expenses.csv` and a day page, and the runner commits both and reacts ✅ |
| The root-test command of section 3 of the plan, on a second clone, with `~/.local/bin/restic` mounted at `/usr/local/bin/restic` | Node 24.22.3: 719 tests, 663 pass, none fail. 56 skip themselves: 35 need the image, 11 are about what root can read or write anyway, 4 need wacli, 4 `mke2fs`, and 2 run `scooter bridge` as a process. This milestone's tests all run there, and pass |
| The `instructions`, `config`, `backup`, `agentdir`, `answer`, `planning`, `runner` and `backfill` tests, 16 times, 8 at once | No failure |
| The new tests against the code of `main` | The test of D197 fails against `config.mjs` of `main`, and that of `restore`'s refusal of a link against its `backup.mjs`. The tests of the files need `config/`, which `main` doesn't have |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'node test/live/openrouter.mjs'`, with the network | The plan's "done when". On each route the runner, with the files of `config/` and a dummy key, ran the pinned pi in a VM through the real policy. pi's request, 23,934 bytes on the messages route and 23,872 on the chat route, reached OpenRouter, which answered 401; the runner took it as a setup error, paused runs and counted no attempt; and `curl https://example.com/` in a VM of the same sandbox was refused. Exit code 0, no QEMU left |
| By hand: `debugfs` on the test image, which `config/image/build.json` built | `pdftotext`, `pdftoppm`, `heif-convert`, `curl`, `git`, `rg`, `fd`, `node`, and busybox's `sort`, `awk` and `sed` are there (D203) |

The tests the plan asks of this milestone, and where they are:

| Required | Where |
|---|---|
| Every skill folder has a `SKILL.md` with `name` and `description` | `instructions.test.mjs`, the second test, for the files of `config/`; `config.test.mjs`, the test of D197, for the runner's check of any skill |
| The default config validates | `instructions.test.mjs`, the first test: it validates, and is 6.1's example, which it holds line for line |
| Each view in the prompt names a skill that exists | `instructions.test.mjs`, the third test, with 7.2's list taken from DESIGN.md |
| Each CSV header matches 7.3 | `instructions.test.mjs`, the fourth test, with the headers and the categories taken from 7.3 |

Beyond those: the day page's template and its links, checked against the paths of a native and a Docker data folder; a run's system prompt and its copy of the skills; and the protocol against the parser, its example answer and each thing it says of a line, in `instructions.test.mjs`. Section 10's Config, each validation error naming the field, covers D197's faults in `config.test.mjs`.

Not verified:
- **A real model with these instructions** (gate G4). Whether it reads a skill when it should, files a receipt, a run's screenshot, a ticket and an email as the skills say, keeps the CSV rules and the day pages, asks as the protocol says, and ends its answers with lines the parser reads. The sandbox test's model follows a script, and with a dummy key OpenRouter answers 401 before any model sees the prompt. The same holds for whether a rebuild's prompt needs a line of its own (D202).
- **What the instructions cost.** pi's first request with them is about 24 KB, its system prompt, its tools and the prompt, and every request of a run sends it again. Prompt caching, which ZDR allows (13.3), would make most of it cheap; how much, the first real runs will show.
- **arm64 and macOS.** Nothing here knows the architecture.

## Milestone 12: native install

Done on 2026-11-18, on the Linux machine of section 3 of the plan, with gates G1 and G2 in a throwaway root VM on it (section 6 of the plan). Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 5.3, now [delivery](architecture/delivery.md), 6.1, 7.3, 8.4, 8.5, 8.6 and sections 9 and 10, to say what this milestone settled (12.4 here). It also settled the eight smaller points of the review of milestone 11, and the point the first review of milestone 4 left for this one (12.3).

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
| `config/prompts/lifelog.md`, `config/skills/day-pages/SKILL.md` | The review of milestone 11, points 1, 2 and 7 (D216) |
| `test/setup.test.mjs`, `doctor.test.mjs`, `units.test.mjs` | This milestone's tests, the root test among them |
| `test/delivery.test.mjs`, `files.test.mjs`, `whatsapp.test.mjs`, `config.test.mjs` | The record in `bridge/`, and the link swapped in once an entry is taken; `settleFolder`; `pair`; the skill checks |

### 12.1 Decisions

**D207. The two units, and how they restart** (the first review of milestone 4, point 4; the plan's rule for this milestone).
*Choice:* `deploy/systemd/scooter-bridge.service` runs `/usr/local/bin/scooter bridge` as root; `scooter-runner.service` runs `/usr/local/bin/scooter runner` as `scooter-runner`, with its group and `SupplementaryGroups=kvm`. Both: `Type=exec`, `Environment=TZ=UTC`, `KillMode=control-group`, `Restart=on-failure`, after `network-online.target`, wanted by `multi-user.target`, and no `EnvironmentFile`: each service reads its own env file (8.2). The restarts:
- the runner's after 1 minute, then about 5½, then 30 minutes, and every 30 after (`RestartSec=1min`, `RestartSteps=2`, `RestartMaxDelaySec=30min`): OpenRouter's outage waits (6.9);
- the bridge's after 5 seconds, doubling to 5 minutes (`RestartSec=5s`, `RestartSteps=6`, `RestartMaxDelaySec=5min`): `RESTART_BACKOFF`, as the bridge restarts wacli and the email reader.

The runner's home and temporary folder aren't set in its unit: the runner sets both under `runner/` when it opens the sandbox, from `DATA_DIR` (D140), which the plan's rule allows, and one place says where they are.
*Reason:* the runner stops on an error and leans on its service manager (D93). A fault that stays after pi has run, such as a disk too full to record the run, runs pi again at every start, and each start waits out the quiet period first, so systemd's start limit, 5 starts in 10 seconds, never stops it. A minute's wait would run pi, and spend on OpenRouter, up to sixty times an hour; these waits spend at most twice an hour, as an outage does, with a first try a minute after the crash. `Type=exec` makes a start fail when the command can't be run.
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
- the folders of 3.2 in the data folder are made when missing, and those directly in it given their owners and modes again; a folder in another user's folder, such as `wacli/store`, is made when missing, through `settleFolder` ([Atomic files and hand-offs](architecture/shared-code.md#atomic-files-and-hand-offs)), and otherwise left alone, as that user's; the data folder itself may be a link the owner made to another disk;
- the config is copied, through a temporary folder renamed into place, only when `/etc/scooter/config` isn't there, root's with the runner's group, folders 0750 and files 0640: it is the owner's from then on;
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
*Reason:* [Processes and users](ARCHITECTURE.md#processes-and-users). No home: wacli's is given by the bridge, the runner's set by the runner, and the email reader's by the bridge ([Running wacli](architecture/whatsapp.md#running-wacli), [The email reader](architecture/email.md#the-email-reader), 6.6); `/nonexistent` is Debian's way. Creating a `kvm` group where the kernel offers no KVM would change nothing.

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

**D216. The day page's travel line, and two sentences of the prompt** (the review of milestone 11, points 1, 2 and 7).
*Choice:*
- The template of 7.3, and of the `day-pages` skill, has the "Booked:" line, on the page of the day of booking, with the flight's date as a Saturday: `- Booked: ✈ 6E 2135 BLR → DEL, Sat 14 Nov 06:10, seat 12A, PNR ABC123`. The skill gives the line of the day of departure too: `- ✈ 6E 2135 BLR → DEL 06:10, seat 12A, PNR ABC123`.
- The prompt says `pdftoppm` writes one image a page, and to list `$HOME` for their names: it pads the number to the last page's width.
- A newer line of `preferences.md` overrides older lines, and the prompt's rules for the views and the files, never the protocol before them.
*Reason:* the review's ways. The test holds the skill's template to 7.3's, so both changed.

### 12.2 Facts found

- **systemd's restart counter** (systemd 255, on the Linux machine, with a unit of the user's own manager that failed at once, then after running 8 seconds): with `RestartSteps` and `RestartMaxDelaySec` the waits grow as D207 has them, 1, 2, 4 and 8 seconds for 1 second, 3 steps and 8 seconds; and the counter doesn't go back after a run that lasted: the waits stayed at their longest. It goes back when the unit is started by hand.
- **`systemd-analyze verify`** exits with 0 when a unit has a setting it doesn't know, or a value it can't take, and says so on stderr; it fails when the command isn't there. So the test gives each unit a stand-in command, and wants nothing on either stream.
- **A link opened with `O_DIRECTORY | O_NOFOLLOW`** fails with `ENOTDIR` on Linux, not `ELOOP` ([Atomic files and hand-offs](architecture/shared-code.md#atomic-files-and-hand-offs)).
- **Scooter's VMs don't boot inside the root VM.** Under nested KVM, in the Ubuntu 24.04 VM of gate G2 (QEMU 8.2.2 on the machine, `-cpu host`, 4 processors), QEMU's `microvm` machine, as Gondolin 0.14.0 starts it with KVM and `VM_CPUS` 2, hangs in the guest kernel's APIC setup, after `ACPI: Core revision`: every run there failed as "the VM couldn't start", a setup error, and runs paused, as 6.9 says. Booted by hand, the image's kernel boots with 1 processor, or with the machine's ACPI off (`acpi=off`), and not with other CPU models, kernel switches or a `q35` machine around it. Gondolin's `machineType: "q35"` booted a VM there in 2.1 seconds, and ran a command in it. On the machine itself, `microvm` boots in about 2 seconds (milestone 7). Nothing in G2 needs a VM to boot; G3 does: the plan's milestone 13 has it.
- **A native image build as root**, in the root VM: 16 seconds, 527 MB, and `.image-build/` gone afterwards (D151).
- Ubuntu 24.04's cloud image has no `bzip2`, which restic's release needs to be unpacked; G1 installs it with the rest.

### 12.3 The reviews of the pull requests merged before this one

Pull request 12, milestone 11, was approved by its review with eight smaller points. All eight are settled:

| # | Point | What became of it |
|---|---|---|
| 1 | The page images' names are wrong for a PDF of ten pages or more | Settled (D216): the prompt says to list `$HOME` for their names |
| 2 | The day page's template and the skill's "Booked:" line disagree; 14 November 2026 is a Saturday | Settled (D216): the template's line is the "Booked:" one, on a Saturday, in 7.3 and the skill; the skill gives the departure day's line too |
| 3 | A skill with `disable-model-invocation: true` passes the check, and the model never sees it | Settled (D208): refused. Test in `config` |
| 4 | An unreadable `SKILL.md`, a name of digits, and the words about 1,024 characters | Settled (D208): a fault that names the field; the name taken as written; the format's limit. Tests in `config` |
| 5 | The byte-order mark written as the character | Settled (D208): `﻿` in both |
| 6 | The plan's note for the README holds natively only | Settled: the plan's milestone 14 says what an upgrade does to `./config` in Docker |
| 7 | "These instructions" could take in the protocol | Settled (D216): the prompt's rules for the views and the files, never the protocol |
| 8 | 11.4's count of the skips is off by two | Settled: 8 and 3, corrected in 11.4 |

The points earlier reviews and milestones left, as 11.2 has them:

| From | Point | What became of it |
|---|---|---|
| Milestone 4, first review, point 4 | `RestartSec` for the runner's unit | Settled (D207) |
| Milestone 8, point 1 | A request the agent makes itself decides the cause of a failure | Left, recorded as a cost under D160, for the owner in the plan's milestone 14 |
| Milestone 9, point 4 | A warning at the runner's start when the last commit is a rebuild's batch | Left, as before: a choice of what the runner says, which the README covers (milestone 14) |
| Milestone 10, 10.4 | A native restore | Run at G2 (12.5) |

### 12.4 Changes to DESIGN.md

None changes what Scooter does beyond what this milestone settled:
- 6.1: a skill doesn't set `disable-model-invocation: true` (D208).
- 7.3: the template's travel line is the "Booked:" one, on a Saturday (D216).
- 8.4: `setup`'s steps and `--no-services`; what `doctor` checks, and its exit code (D209, D214).
- 8.5: the first `setup`, the units' restarts, and the command's `exec` (D207, D213).
- 8.6: `DOCTOR_TIMEOUT` and `DOCTOR_RESPONSE_MAX_BYTES`.
- Section 10: Least privilege, with `setup`'s root test; Delivery, with the link swapped in once an entry is taken.

The plan's milestone 13 has what 12.2 found of Scooter's VMs in the root VM, and its milestone 14 what this milestone leaves for the README.

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
- **A pi run in the root VM.** No VM of Scooter's booted there (12.2); runs failed as setup errors, as 6.9 says. Runs through the real sandbox were verified on the machine itself, with KVM (the run above), as in milestones 7 to 11.
- **`pair` against WhatsApp**, and the bridge with a paired wacli (gate G4). The tests run the wacli stub; in G2 wacli was unpaired.
- **The units on another systemd.** `RestartSteps` needs 254; on an older one the runner restarts every minute (D207).
- **The install on the machine Scooter will live on**, which stays with the owner (section 6 of the plan), and **arm64**.

## Milestone 13: Docker

Done on 2026-11-18, on the Linux machine of section 3 of the plan, which has rootless Docker, with gate G3 in a throwaway root VM on it (section 6 of the plan). Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 3.2, now [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners), 4.3, now [Writing](architecture/datastore.md#writing), 6.6, 6.12, 8.3, 8.4, 8.5, 13.4 and sections 9, 10 and 14, to say what this milestone settled (13.4 here). It also settled the seven smaller points of the review of milestone 12, and the point the second review of milestone 6 left for this one (13.3).

What the milestone left in the repository:

| Path | What |
|---|---|
| `Dockerfile`, `.dockerignore` | The image (D221) |
| `compose.yaml` | The two services, the one data volume, and `build-image`'s container (D219, D220, D222) |
| `compose.kvm.yaml`, `compose.kvm-rootless.yaml` | KVM under rootful and under rootless Docker; `compose.yaml` alone is the third case, without KVM (D217, D222) |
| `src/runner/sandbox/gondolin.mjs` | QEMU's `q35` machine (D218), and `bootCheck`, for `doctor` (D224) |
| `src/runner/sandbox/image.mjs` | `build-image` in the runner's container says which container builds (D220) |
| `src/ops/doctor.mjs`, `src/cli.mjs` | A VM's boot, the runner's user, and the fixes in Docker (D224) |
| `src/ops/setup.mjs` | The kvm group, with services (D225) |
| `src/common/proc.mjs`, `src/bridge/main.mjs` | `inDocker`, which `doctor` and `build-image` ask; a comment (13.3) |
| `test/docker.test.mjs` | This milestone's tests: the Dockerfile and the Compose files against `setup.mjs`, 8.3 and 0.2, and `docker compose config` where Docker is installed |
| `test/live/data-mounts.mjs` | A live check, run by hand in the runner's container: a run's mounts with the data folder at `/data` (row 14) |
| `test/delivery.test.mjs`, `doctor`, `setup`, `image`, `sandbox`, `whatsapp` | The review's points, the boot check and the machine |

### 13.1 Decisions

**D217. The runner runs as `scooter-runner` in every Docker setup, rootless Docker included** (the plan's rule for this milestone, the outbox's owner in rootless Docker; the second review of milestone 6, smaller point 3).
*Question:* 8.3 ran the runner as the container's root under rootless Docker, with no `user:`, because only the user that runs Docker could be given `/dev/kvm`. The runner then makes its folders, the outbox among them, as uid 0, and the bridge, which takes the runner's entries only while the outbox is `scooter-runner`'s ([Folders other users control](ARCHITECTURE.md#folders-other-users-control)), looks that user up as 10002 and refuses the outbox for good. Which user owns the runner's folders there, and how does the bridge know?
*Choice:* the runner runs as `scooter-runner` under rootless Docker too, as [Processes and users](ARCHITECTURE.md#processes-and-users) has it; the bridge knows it as it always has, by its name. Rootless Docker gives each uid of a container a uid of its own on the host, from the range `/etc/subuid` gives the user that runs Docker: 10002 is that range's start plus 10001, 175537 on the Linux machine, whose range starts at 165536. The udev rule `compose.kvm-rootless.yaml` gives, and the README will, lets that uid read and write `/dev/kvm` with an ACL, set again at each of the device's events: `SUBSYSTEM=="misc", KERNEL=="kvm", RUN+="/usr/bin/setfacl -m u:<uid>:rw $devnode"`. The uid comes from Docker's own map, as the user that runs Docker: `docker run --rm --entrypoint awk scooter:local '$1 <= 10002 && 10002 < $1 + $3 { print $2 + 10002 - $1 }' /proc/self/uid_map`.
*Reason:* the runner is its own unprivileged user everywhere ([Processes and users](ARCHITECTURE.md#processes-and-users); [Why it is built this way](ARCHITECTURE.md#why-it-is-built-this-way)), and the bridge's checks hold as they are, with no setting and no second case: nothing in the code changes. The runner as the container's root would be, on the host, the user that runs Docker and its daemon; it would make its files root's, which a later switch to another variant would leave the runner unable to write; and it would make one volume for the whole data folder (D219) unsafe, since the container's root reads every folder in it. An ACL for one host uid is the narrowest grant there is.
*Cost:* the owner works out a uid with the command above and writes it in the rule; a change of the Docker user's range needs the rule again. systemd's `uaccess`, which Ubuntu gives `/dev/kvm`, sets the users' ACLs afresh at the device's events while a seat has an active session, as on a desktop, which is what 13.4 saw on the Linux machine; the rule's `setfacl` then puts this one back, so a VM starting in that moment, milliseconds after another VM of the machine started or stopped, could fail to start, a setup error that pauses runs for 30 minutes. A server has no seat session, and in the root VM the ACL stayed through every VM (13.5). `MODE="0666"` on `/dev/kvm`, systemd's own default, would leave no such moment, and would give every user of the machine KVM, which Ubuntu chose not to; the owner may choose it. DESIGN.md 8.3 now runs the rootless runner as `scooter-runner`, and gives that uid, not the Docker user, the access of its own.

**D218. pi's VMs run on QEMU's `q35` machine on x86_64** (the plan's rule for this milestone, Scooter's VMs inside the root VM; 12.2).
*Question:* at gate G2 no VM of Scooter's booted in the root VM: under nested KVM, QEMU's `microvm`, which Gondolin 0.14.0 gives x86_64 with KVM, hangs in the guest kernel's APIC setup with 2 processors. Gate G3 needs a VM to boot in a container in that VM, and the owner may run Scooter in a VM of their own, such as a cloud server.
*Choice:* the sandbox gives Gondolin `machineType: "q35"` on x86_64, with KVM as under emulation, where Gondolin already chose it; on arm64 Gondolin's own `virt` stands (`machineType()` in `gondolin.mjs`).
*Reason:* the simplest of the plan's three ways: one option, no probe of which machine boots, and nothing asked of the machine Scooter runs on. On the Linux machine itself `q35` boots sooner than `microvm` with KVM: 1.0 to 1.35 seconds, the fastest of three boots in three runs of the sandbox test, against 1.8 to 2.2 for `microvm` in two runs just before. In the root VM, nested, it booted in 2.0 to 2.5 seconds in the runner's container, under rootful and rootless Docker (13.5). The sandbox tests ran again on the machine with it, all passing.
*Cost:* `q35` has firmware and a PCI bus that `microvm` hasn't: QEMU needs SeaBIOS and iPXE's ROMs, which Debian's `qemu-system-x86` brought into the image without its recommendations, and Ubuntu's into the native install.

**D219. In Docker, one volume holds the whole data folder** (the plan's rules for this milestone: `build-image` in Docker, and `restore` in Docker).
*Question:* DESIGN 3.2 gave each folder a volume of its own, mounted read-only where a service only reads it. `build-image` builds in `/data/.image-build/` and renames the image into `/data/runner/image/`, which must be one file system, and, as root, refuses a `/data` another user can write (D151); with a volume for each folder, `/data` is the container's own file system, read-only in the runner's. And `restore` writes `runner/log/`, which the bridge's container couldn't.
*Choice:* one named volume, `data`, at `/data` in the bridge's container, the runner's and `build-image`'s, as the plan's example has it. What it is for, how the owners and modes keep the services apart in it, and what it costs, is in [Folders and their owners](ARCHITECTURE.md#folders-and-their-owners). The image's `/data` holds the folders with the owners and modes `setup` gives a native install (`dataFolders`), and a new named volume starts as a copy of it. A Docker install is then the native install's layout, which `setup`'s and `doctor`'s checks, `setup`'s root test and G2 have checked.
*Cost:* a bind mount of a host folder in the volume's place starts empty, not as a copy of the image's `/data`, and the runner can't make its folders in a `/data` of root's: the README should say to keep the named volume, or to make the folders with their owners first.

**D220. In Docker, `build-image` runs in a container of its own: `docker compose run --rm build-image`, as root and privileged** (the plan's rule for this milestone; 8.3 left the command to when it was first tried).
*Question:* as root in the runner's container if the builder's chroot works there, otherwise as a one-off with the privileges it needs (row 8).
*Found:* it doesn't work in the runner's container. As `scooter-runner` the build needs root, or a container runtime, which the container doesn't have. As root (`docker compose run --rm --user root runner build-image`), Gondolin's native builder can't make its cache under the read-only root file system, and the mount of `/proc` its chroot needs is refused there without `CAP_SYS_ADMIN` (13.2).
*Choice:* a service of its own in `compose.yaml`, `build-image`, from the same image, which only `docker compose run` starts (its profile): `user: root`, `privileged: true`, the data volume and `./config` read-only, and no env file: it reads only `DATA_DIR` and `CONFIG_DIR`, which `compose.yaml` sets. It builds natively, as root, as `sudo scooter build-image` does: in `/data/.image-build/`, given to `scooter-runner`, then renamed into `/data/runner/image/` (D151). In the runner's container `build-image` now says to use it, with exit code 2.
*Reason:* the privileges Gondolin's own container build takes, `--privileged`, on a container that runs only the build, only when the owner starts it, and is removed afterwards; the runner's service keeps none of them. Fewer, such as `CAP_SYS_ADMIN` with Docker's masks of `/proc` and AppArmor's profile lifted, weren't tried: they differ between rootful and rootless Docker, for a container that runs nothing else.
*Cost:* under rootful Docker a privileged container is root on the host, with its devices: the build runs Gondolin's builder, then Alpine's shell, npm and git in a chroot, which is what row 8 accepts of a native build as root, and section 9 says so of Docker too. Under rootless Docker it is the user that runs Docker, with no root on the host. The build took 14 to 17 seconds, and the image was 527 MB (13.5).

**D221. The image.**
*Choice:* 8.3's two stages. `golang:1.27-trixie` builds wacli 0.26.0 with 13.1's command. `node:24-trixie-slim` installs 8.3's packages without their recommendations, QEMU for `TARGETARCH` (`qemu-system-x86` or `qemu-system-arm`), and `qemu-utils`, for `qemu-img`, which Gondolin runs and `doctor` checks. restic 0.19.1 is checked against the checksums milestone 0 took from the release's `SHA256SUMS` (0.2), written in the Dockerfile for each architecture, rather than against a `SHA256SUMS` fetched beside it, which would only say that the two came from the same place. The users are made as `setup` makes them (D212), at 10001 to 10003; the data folder as D219 says; the app is root's, installed with `npm ci --omit=dev --ignore-scripts`; `TZ=UTC`; and the entry point is `tini -- node /app/src/cli.mjs`, with `help` when no command is given. `.dockerignore` lets only `package.json`, the lock file and `src/` into the build, so no env file or data folder is copied in. A test holds the users, the folders and restic's checksums to `setup.mjs` and this file.
*Reason:* 8.3. tini passes a signal on to Node, the service's main process, so `docker compose kill -s SIGUSR1 bridge` starts a backup ([When backups run](architecture/backups.md#when-backups-run)); as the container's first process it takes every process of the container with it when it ends, so the runner's QEMU doesn't outlive the runner's container (6.6; 13.5).
*Found:* the image is 775 MB, with QEMU 10.0.13 and Node 24.22.3. It built in 28 seconds on the Linux machine, wacli's stage in 12.

**D222. `compose.yaml`, and the KVM cases as files of their own.**
*Choice:* `compose.yaml` has 8.3's two services, from the image it builds, `scooter:local`, each with `restart: unless-stopped`, `no-new-privileges`, `stop_grace_period: 30s`, log rotation of 10 MB × 3 in Docker's `json-file` driver, `DATA_DIR=/data` and `CONFIG_DIR=/config`, its own env file, and no port. The bridge has `hostname: scooter`; the runner `user: scooter-runner`, `read_only: true` with a `tmpfs` at `/tmp`, and `./config` read-only. Alone, it runs pi's VMs under emulation, the third case. The other two are added by naming them in `COMPOSE_FILE` in a `.env` file beside it, which every `docker compose` command there reads: `compose.kvm.yaml`, for rootful Docker, gives the runner `/dev/kvm` and the host's kvm group by its id, `KVM_GID` in `.env`, and stops with a message saying so when that isn't set; `compose.kvm-rootless.yaml`, for rootless Docker, gives it `/dev/kvm`, and holds D217's udev rule. The project is named `scooter`, so the volume is `scooter_data`.
*Reason:* the plan asks for the three cases as documented variants. Files of their own let the owner choose one without editing a file git tracks, which an upgrade's `git pull` would otherwise meet as a conflict, and a test reads each. git ignores `.env`, as it does the env files.
*Not changed:* how Docker restarts the runner (D229).

**D223. Backups and restore in Docker** (the plan's rule for this milestone).
*Choice, and what was found:*
- The bridge tells a runner at work from one that is gone by connecting to `runner/runner.sock` ([The locks](architecture/exchange.md#the-locks)). In the one volume (D219), from the bridge's container to the runner's, the socket answers, and `restore`, in a container of its own, found the bridge's (13.5).
- `restore` runs as natively, in a container of the bridge's: `docker compose stop`, then `docker compose run --rm bridge restore [snapshot] [--force]`. It refuses while either service runs, by their sockets, and writes `runner/log/` with the rest, each file to its owner by name ([Restore](architecture/backups.md#restore)), which the image's users make the same uids in every container.
- The bridge's `hostname: scooter` holds in the containers `docker compose run` makes of it too, so restic's locks and its snapshots name the host `scooter` in every one ([What a backup holds](architecture/backups.md#what-a-backup-holds)).
- `docker compose kill -s SIGUSR1 bridge` reaches the bridge through tini, and starts a backup ([When backups run](architecture/backups.md#when-backups-run)).
*Reason:* the plan's rules. One volume makes Docker's restore the native one.

**D224. `doctor` boots a VM, and runs as the runner's user** (the review of milestone 12, smaller points 2 and 7).
*Choice:*
- After the image's check, when QEMU and the image are there and the accelerator can be used, `doctor` boots one VM from the image as a run does, with the accelerator the runner would use, runs `true` in it, and reports how long the boot took; or that it didn't boot, with the fix: nested virtualization for a machine that is itself a VM, or `AGENT_ACCEL=emulation`, or building the image again. The runner's own code does it (`bootCheck` in `gondolin.mjs`), which `src/cli.mjs` hands to `doctor`. Gondolin's home and temporary folder, and the network log, are then a folder of its own in the system's temporary folder, removed afterwards: nothing in the data folder changes, and a runner at work keeps its own folders. The VM sees an empty folder, and reaches no host.
- Where `scooter-runner` is a user of the machine, `doctor` refuses to run as another, with exit code 2, and says how to run it: `sudo -u scooter-runner scooter doctor`, or in Docker `docker compose run --rm runner doctor`, which runs as that user. Without that user, as in development, it runs as whoever runs it.
- Its fixes in Docker name the KVM files (D222), `docker compose run --rm build-image` (D220), and the command that sets a folder's owner and mode in a container of the bridge's.
*Reason:* the review's ways. Opening `/dev/kvm`, which is what 8.4 asks, said "KVM" in the root VM of G2, where no VM booted (D142's "not covered"); and as root, `doctor` reported a fault that wasn't one, and every check saw what root sees.
*Cost:* `doctor` takes a VM's boot longer: 1 to 2 seconds with KVM, 4 to 5 under emulation (13.5).

**D225. With services, `setup` makes the kvm group when there is none** (the review of milestone 12, smaller point 1).
*Choice:* `setup`, when it installs the services, makes a system group `kvm` on a machine that has none, then puts `scooter-runner` in it. Without services it makes none, and says pi's VMs will run under emulation, as before (D212).
*Reason:* the runner's unit names the group (`SupplementaryGroups=kvm`), and systemd refuses to start a unit whose group isn't there (216/GROUP, the review's probe). With the group and no `/dev/kvm`, the runner starts, and falls back to emulation, which `doctor` explains.

**D228. arm64 isn't verified** (the plan's rule for this milestone).
*Choice:* the image builds for the machine's architecture by `TARGETARCH`: QEMU's package, restic's file and checksum, and wacli from source; an architecture other than amd64 or arm64 stops the build, saying so. `machineArch`, `qemuProgram` and `machineType` choose by Node's `process.arch`, and the VM image's build file names no architecture (D5).
*Not verified:* nothing has built or run the image on arm64. The Linux machine has no arm64 emulation for Docker or for QEMU (section 3 of the plan), nor has the root VM. Whether the arm64 image holds everything Gondolin's `virt` machine needs, without the packages' recommendations, is unknown until then. restic's arm64 checksum is the release's (0.2), and wacli's source builds for both (13.1).

**D229. Not changed: how Docker restarts the runner** (found while settling D222).
*Question:* the runner stops on an error and leans on its service manager to start it again (D93). D207 gave the native unit restarts after 1 minute, then about 5½, then 30, so that a fault that stays after pi has run, such as a disk too full to record the run, spends on OpenRouter at most twice an hour. Compose's `restart: unless-stopped` (8.3) restarts a container after a wait that doubles from 100 milliseconds up to a minute, and starts again from 100 milliseconds once the container has run 10 seconds, by Docker's documentation; this wasn't measured here. A runner that runs pi before it stops has run longer.
*Found, and left:* such a fault would run pi again every 10 to 20 seconds in Docker. Compose's restart policy has no wait to set. What would settle it: the runner keeps its own waits between starts, in `runner/`, applied where its service manager doesn't wait; or the owner's choice of `restart: on-failure:<n>`, which stops after `n` failures. The plan's milestone 14 has it, among what isn't done, for the owner.
*Measured* by the review of milestone 13, smaller point 1: under `restart: unless-stopped`, a container that ended with an error after 12 seconds was started again 0.2 seconds later, every time.
*Closed in milestone 14* (the owner's answer, "ok", 14.1): the first of the two ways (`src/runner/restarts.mjs`).
*Choice:*
- **The waits** are the native unit's, as systemd works them out from `RestartSec=1min`, `RestartSteps=2` and `RestartMaxDelaySec=30min`: 1 minute after the first stop in a row, 1 minute × √30, 5 minutes 29 seconds, after the second, and 30 minutes after each from the third (`RUNNER_RESTART_WAITS`; a test holds them to the unit). They count from the stop, as systemd's do, or from the start before it when the stop couldn't be recorded, such as after a kill or a lost power.
- **The record**, `runner/restarts.json`, the runner's own, mode 0600: how many starts in a row have ended other than by a stop the runner was asked for, when the latest started and stopped, and why. A start reads it, and, when it follows a stop on an error, waits until then, after the steps of a start that run nothing of pi's and before its loop; then it writes itself down as the next stop in a row, and runs nothing if it can't. So a start that ends in a crash, a kill or a lost power counts, though it could write nothing then; and on a disk too full to write the record, the runner stops before pi, so nothing is spent, and Docker's own backoff, up to a minute for a container that ran less than 10 seconds, paces its starts.
- **What ends the waiting:** a stop the runner is asked for, by `SIGTERM` or `SIGINT`, makes the count 0: `docker compose restart runner`, `docker compose stop` then `up`, Docker restarting its daemon, and the machine's shutdown, as a start by hand or the machine's start does for systemd (D207). A run recorded since the start makes the next stop the first in a row: only a run that got through can, so a fault that stops every run, after pi and before the run is recorded, keeps counting.
- **It never gives up:** the runner waits and runs again, every 30 minutes at most, as an outage does (4.7).
- **The owner sees it:** the first wait in a row writes one notice, "⚠️ I stopped on an error (ENOSPC), so I wait until 21:31 before I go on, and longer if it happens again. Restarting the runner ends the wait.", and `status.json` gets `restart`, the stops, until when and why, which `/status` shows while the wait lasts. A stop during the wait writes `status.json` again without it, so a runner stopped then, and not started again, isn't said to wait (the review of milestone 14, smaller point 8). The reason is the error's code or name (`errorFields`), never its message, which can quote what was being read.
- **Natively it keeps none:** the runner's unit sets `SCOOTER_RESTART_WAITS=systemd`, and the runner then keeps no record and no waits, so that `sudo systemctl restart scooter-runner` brings it back at once (D207). Anywhere else it keeps them, unless its environment says so.
*Reason:* the plan's rules, from the owner's answer. The runner keeps them by default, and the unit turns them off, rather than the runner looking for `/.dockerenv`: "however the runner is started again" a fault that stays must not run pi more often, and the unit is Scooter's own file, which says so where systemd's waits are set. It isn't a setting of `runner.env`, which refuses it: it isn't the owner's to choose (8.6).
*Cost:* in Docker a runner that stopped on an error waits at least a minute, also when a restart alone would have mended it; restarting it ends that. In development, a runner that stopped on an error waits at its next start, and Ctrl-C ends that wait too. A start that stops before its wait, in the steps that run nothing of pi's, such as on a bad `agents.yaml`, a missing VM image or a datastore found damaged at the start, records nothing and waits for nothing: no pi runs on that path, so the plan's rule holds, but in Docker it is Docker's own restarts that pace it, with waits of a minute at most, and it sends no notice, as natively, where systemd waits as after any stop. Recording such a start too would pace nothing, since its next start would stop in the same steps before it came to the wait; this text said otherwise until the review of milestone 14 (smaller point 1). One more file in `runner/`, which backups don't hold.
*Tests* in `restarts`: Docker played by starting the runner again at once after each stop, with a fault after pi, the outbox made a file: pi runs 1 minute after the first stop, about 5½ after the second, then every 30, with one notice and `status.json` saying so; a stop asked for during a wait ends it, and takes `restart` out of `status.json`; a run recorded makes the next stop the first in a row again; with `SCOOTER_RESTART_WAITS=systemd` nothing is kept; a record that can't be written runs nothing. In `units`, the unit's setting, and the waits against the unit's. In `status`, the line of `/status`.

### 13.2 Facts found

- **Gondolin's native build in the runner's container**, as root: under the read-only root file system it can't make its cache, `ENOENT: … mkdir '/root/.cache/gondolin/sandbox-helpers'`, and `mount -t proc` there is refused, `permission denied`. As root in a privileged container, under rootless and rootful Docker, it builds (D220).
- **`q35` boots sooner than `microvm`** with KVM on the Linux machine, and boots under nested KVM, where `microvm` hangs (D218).
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
| 7 | For milestone 13: `doctor` says KVM where no VM boots; catch-up fails while wacli is unpaired | Settled: `doctor` boots a VM (D224), and `q35` boots under nested KVM (D218); catch-up waits for the pairing's first check ([Catch-up](architecture/whatsapp.md#catch-up)). Tests in `doctor`, `sandbox` and `whatsapp`; the last fails on `main` |

The points earlier reviews and milestones left, as 12.3 has them:

| From | Point | What became of it |
|---|---|---|
| Milestone 6, second review, point 3 | The outbox's owner in rootless Docker | Settled (D217): the runner runs as `scooter-runner` there too |
| Milestone 8, point 1 | A request the agent makes itself decides the cause of a failure | Left, recorded as a cost under D160, for the owner in the plan's milestone 14 |
| Milestone 9, point 4 | A warning at the runner's start when the last commit is a rebuild's batch | Left, as before: a choice of what the runner says, which the README covers (milestone 14) |
| Milestone 10, 10.4 | Backups in Docker: the socket across containers, and `restore` | Run (D223; 13.5) |

### 13.4 Changes to DESIGN.md

None changes what Scooter does beyond what 8.3 left open and the review asked:
- 6.6: pi's VMs run on `q35` on x86_64 (D218).
- 6.12: in Docker, `build-image` runs in a container of its own, privileged (D220).
- 8.3: the image (D221); one volume, the runner's user, `build-image`'s container, and the KVM files, with the udev rule for scooter-runner's uid under rootless Docker (D217, D219, D220, D222); `restore` in Docker (D223).
- 8.4: `build-image` in Docker; `doctor` boots a VM and runs as the runner's user (D224).
- 8.5: `setup` makes the kvm group when it installs the services (D225).
- 13.4: rootful Docker with `devices` and `group_add` was tried at G3.
- Section 9: `build-image`'s container under rootful Docker is root on the host, as a native build is; in Docker, the folders are kept apart by their owners and modes (D219, D220).
- Section 10: Least privilege, Delivery and Config, as this milestone tests them; the Docker files' test.
- Section 14: KVM in a container, building the image in Docker and natively, the read-only root file system and `docker compose build` were checked; arm64 wasn't (D228).

ARCHITECTURE.md 6 says the same of Docker. The plan's milestone 14 has what this milestone leaves for the README, and D229 among what isn't done.

### 13.5 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, restic 0.19.1, Docker 29.7.1 rootless with Compose 5.3.1. `462daa1` holds all the code and tests; the commits after it change the documents only.

| Command | Result |
|---|---|
| `npm ci && npm test`, on a clean clone of the branch from GitHub at `462daa1` | 758 tests: 710 pass, none fail. 48 skip themselves: 36 need the image, 8 need root, and 4 need root and `SCOOTER_ROOT_TESTS=1`. `docker compose config` reads each combination of the Compose files |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 760 tests: 748 pass, none fail, in 116 seconds. The 12 that need root skip themselves. Boots with KVM on `q35`: 1.4 to 1.9 seconds under the suite's load. No QEMU left |
| The sandbox test's boot, `microvm` then `q35`, with KVM | `microvm`: 1.8 to 2.2 seconds in two runs; `q35`: 1.0 to 1.35 in three (D218) |
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
| The mounts with the data under `/data` (row 14) | With the runner stopped, `docker compose run --rm -v ./test:/app/test:ro --entrypoint node runner /app/test/live/data-mounts.mjs` | Every line ok: in the VM `/data` held `agents` and `datastore` alone, and wasn't a mount; `runner`, `exchange`, `bridge`, `wacli`, `mail` and `/config` weren't there; `sessions/` wasn't there and couldn't be made; the datastore and the agent's folder were read-only; `run/session/` took a write |
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
| The mounts with the data under `/data` (row 14) | `test/live/data-mounts.mjs`, run in the runner's container |
| Gate G3 | Above |

Beyond those: the review's points, in `delivery`, `doctor`, `setup` and `whatsapp`; the boot check and `q35`, in `sandbox`; `build-image` in the runner's container, in `image`.

Not verified:
- **arm64** (D228), and Docker Desktop, OrbStack and Colima, deferred with macOS.
- **Docker's restart waits** for a runner that keeps stopping (D229): from Docker's documentation, not measured.
- **The moment `uaccess` leaves** on a desktop (D217): a VM starting while another VM's event resets the ACLs. The Linux machine has a seat session, but no root to install the rule; the root VM has none.
- **A real WhatsApp pairing and a real bucket** in the containers (gate G4): `pair` showed a QR code that nobody scanned; the backup went to a repository in a folder.
- **The install on the machine Scooter will live on**, which stays with the owner (section 6 of the plan).

## Milestone 14: docs and final check

Done on 2026-11-18, on the Linux machine of section 3 of the plan. Three choices the plan's rules for this milestone listed as the owner's were put to the owner after milestone 13 was merged, and answered before this milestone started (14.1): two gaps are closed here, catch-up's ([Catch-up](architecture/whatsapp.md#catch-up)) and D229's, and D160 stays as it is. Everything else was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in 5.1, 5.2 and 5.4, now [the WhatsApp channel](architecture/whatsapp.md) and [/status](architecture/bridge.md#status), and in 6.3, 6.9, 8.3, 8.4, 8.5, 8.6 and sections 9, 10 and 14 (14.4). The milestone settled the five smaller points of the review of milestone 13, and the points earlier reviews had left (14.3), and made the final check of the plan (14.5).

What the milestone left in the repository:

| Path | What |
|---|---|
| `README.md` | Installing and running Scooter, natively and in Docker, and "Check on the first real run" (D230) |
| `bridge.env.example`, `runner.env.example` | Final: an example number, the app password, the key's guardrail as 6.13 gives it |
| `src/runner/restarts.mjs`, `main.mjs`, `status.mjs`; `src/common/runnerstatus.mjs`; `src/bridge/status.mjs`; `src/cli.mjs`; `deploy/systemd/scooter-runner.service` | The runner's own waits between starts, where its service manager doesn't wait, and `/status` saying so (D229) |
| `src/runner/sandbox/gondolin.mjs`, `src/ops/doctor.mjs` | `doctor` closes its VM when it is stopped, and boots in `/tmp` when `TMPDIR` is too long a path (D231) |
| `Dockerfile` | The app readable by every user, whatever the checkout's modes (D232) |
| `src/bridge/outbox.mjs`, `src/common/limits.mjs`, `src/cli.mjs`, `test/live/data-mounts.mjs` | The review's three small things, and a stale line of `scooter help` (D233) |
| `test/restarts.test.mjs` | This milestone's test of D229 |
| `test/whatsapp.test.mjs`, `intake`, `status`, `runner`, `runnerfiles`, `units`, `doctor`, `sandbox`, `delivery`, `docker`, `limits`, `paths` | The cases of catch-up ([Catch-up](architecture/whatsapp.md#catch-up)), D229 and the review's points |

### 14.1 The questions for the owner, and the answers

The plan's rules for this milestone listed three choices as the owner's; the first two are here. They were put to the owner on 2026-11-18, after milestone 13 was merged and before this milestone started, by the session that coordinates the milestone loop. The milestone didn't stop on them; they are recorded here, as the task asked.

*The questions, as put to the owner:*
1. Docker restarts (D229): "if a fault persists after pi has run, Docker restarts the runner at once and pi runs again each time, spending on OpenRouter. The reviewer measured 12 seconds from one start to the next. Natively, systemd waits up to 30 minutes. I would close this one before using Docker for real."
2. A request the agent sends itself (D160): "a misled agent can make a failed run look like an OpenRouter outage, and the batch is then tried again every 30 minutes for as long as that message is in it."

Then: "Run milestone 14 through the loop, with the fixes in it?"

*The owner's answers, in the owner's words:*
1. Docker restarts: "ok"
2. A request the agent sends itself: "this is ok"

To running milestone 14 through the loop with the fixes in it: "Yes, both fixes".

*What follows:* D229 is closed in this milestone, as the plan's rules for it say, written from these answers by the session that coordinates the loop; only the quoted words above are the owner's. D160 stays as it is, and the README lists it among the known limits. Each decision records what was done: D229 and D160 in their own entries above. The third question, a catch-up cut short, and its answer are beside the rule they settled, in [Catch-up](architecture/whatsapp.md#catch-up).

### 14.2 Decisions

**D230. The README.**
*Choice:* `README.md` covers what 11.7 lists and the plan's rules for this milestone give it, for Linux, in the order an owner meets them: how the parts fit; what is needed; the native install, from the prerequisites, with restic's and wacli's checksums (0.2; 13.1), to `doctor`; the Docker install; KVM in each case, with the udev rule for rootless Docker and the command that finds the uid; the bot number, the mailbox and its app password, the OpenRouter key and its guardrail, and the bucket; the env files; daily use, the commands, and copying the views out; the agent's instructions, adding a skill, and what an upgrade does to them; backups and restore; rebuilds and backfills; what to do when something goes wrong, `doctor`, its warning about emulation, and the runner's restarts; the security model, with what internet access means; the network log; the known limits; upgrading; development; and "Check on the first real run", gate G4's items as checkboxes.
*Reason:* the plan. Each rule of the plan's milestone 14 for the README is in it; 14.5 ticks them off. Where it gives a command no milestone ran, it was run here: `docker compose cp` out of the data volume (with `docker cp`, which it wraps), `git reset` in the runner's container as `scooter-runner`, and `docker compose run -d`, whose container Docker doesn't restart (14.6).
*Not verified:* the native install's steps as a whole on a fresh machine: G1 and G2 ran them in milestone 12, from the plan rather than from this text.

**D231. `doctor`'s VM, when `doctor` is stopped, and a long `TMPDIR`** (the review of milestone 13, smaller points 2 and 3).
*Choice:*
- `doctor` takes `SIGTERM`, `SIGINT` and `SIGHUP` while it runs, and gives the boot check a signal, which closes the VM it started, as the runner's stop does a run's; the checks after it are left, and `doctor` says what stopped it and exits with 1. The same signal ends its wait for OpenRouter's answer, up to `DOCTOR_TIMEOUT`, which its handlers had left to run out (the review of milestone 14, smaller point 6).
- The boot check makes its folder in the system's temporary folder, or in `/tmp` when a `TMPDIR` is too long a path for Gondolin's sockets there (`socketsFit`).
*Reason:* the review's first way for each. A native `doctor` killed during the boot left a QEMU running; nothing else stops it (6.6). And the misleading fix came from a folder the owner's `TMPDIR` placed, which `/tmp` avoids, rather than a message that names it.
*Tests:* in `doctor`, the signal given to the boot check, and no check after it, and a stop while OpenRouter hasn't answered; in `sandbox`, with the image, a boot check stopped during the boot leaves no QEMU and no folder, and one with a `TMPDIR` of over 100 characters boots.

**D232. The image's app is readable by every user, whatever the checkout's modes** (the review of milestone 13, smaller point 4).
*Choice:* after the copies, `RUN chmod -R a+rX,go-w /app`: readable by every user, folders passable, and writable by root alone.
*Reason:* the review's way, without `COPY --chmod`, whose symbolic modes need a newer Dockerfile syntax than an octal one, which would make every file executable. `go-w` also covers a checkout made under umask 000, whose files every user could otherwise change in the image. *Cost:* one layer holding `/app` again, about 20 MB. *Test* in `docker`.

**D233. Three small things, and a stale line** (the review of milestone 13, smaller point 5).
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
| 1 | How Docker restarts the runner (D229), measured: 12 seconds from one start to the next; to be put to the owner as a question | Put to the owner (14.1), who chose to close it: closed (D229), the runner keeping its own waits. Tests in `restarts`, `units` and `status` |
| 2 | Natively, the VM `doctor` boots is left running if `doctor` is killed during the boot | Settled (D231), the review's first way: `doctor` closes it on `SIGTERM`, `SIGINT` and `SIGHUP`. Tests in `doctor`, and in `sandbox` with the image, which fails on `main` |
| 3 | With a long `TMPDIR`, `doctor`'s boot check fails and blames the wrong thing | Settled (D231), the review's first way: `/tmp` when `TMPDIR` is too long a path. Test in `sandbox` |
| 4 | An image built from a checkout made under umask 077 can't be read by the runner or the email reader | Settled (D232), the review's second way: a `chmod` after the copies. Test in `docker` |
| 5 | Three small things: a number not in `limits.mjs`; `outbox.runner_outbox_taken` logged while the outbox isn't there; the live checks run with `--entrypoint node` | Settled (D233): `LOGGED_NAME_MAX_CHARS`; logged only once it is taken from, test in `delivery`, which fails on `main`; a note in the live check and the README |

The points earlier reviews and milestones left, as 13.3 has them:

| From | Point | What became of it |
|---|---|---|
| Milestone 8, point 1 | A request the agent makes itself decides the cause of a failure | Put to the owner (14.1), who accepted it, "this is ok": recorded under D160, in the README's known limits, and among section 9's accepted risks |
| Milestone 9, point 4 | A warning at the runner's start when the last commit is a rebuild's batch | Left, as the review allowed, a choice of what the runner says: the README says to look at the last commit after a crash, a reboot or a restore, and to run the rebuild again when it reads `lifelog: rebuild #…`, as the plan's rule for the README asks |

### 14.4 Changes to DESIGN.md

None changes section 2, or what Scooter does beyond what the owner's answers and the review asked:
- `/status`, 6.3, 6.9: the runner's own waits between starts where its service manager doesn't wait, its notice, and `/status` and `status.json` saying so (D229).
- 8.3: the runner's restarts in Docker; the app's modes in the image (D229, D232).
- 8.4: `doctor` closes the VM it booted when it is stopped (D231).
- 8.5: the runner's unit tells the runner that systemd keeps the waits (D229).
- 8.6: `RUNNER_RESTART_WAITS` and `LOGGED_NAME_MAX_CHARS`, and the eight constants of `limits.mjs` the table didn't list (D234).
- Section 9: a request the agent sends itself, among the accepted risks (D160).
- Section 10: Intake's catch-up and the Runner's restart waits, as this milestone tests them.
- After the review (14.7): 6.3, a stop during the wait takes `restart` out of `status.json`; 6.9, a start that stops before its wait waits for nothing; and the README's first real run, how wacli stores and lists the owner's chat after downtime.

ARCHITECTURE.md 5.2 and 6 say the same of the runner's restarts.

### 14.5 The final check: DESIGN.md, section by section

The plan's final check, step 1: DESIGN.md read again, section by section, each requirement against what was built, with the milestone or decision that built it. What isn't done is listed after the table.

| DESIGN.md | What was built, and where |
|---|---|
| 6.1 to 6.5 | Milestones 3 and 11 |
| 6.6 Running pi | Milestones 4 and 7; `q35` (D218). "Ignore the stderr line 'Warning: No project session found…'": nothing reads pi's stderr but its last line, for OpenRouter's error (`openRouterMessage`), and a run's outcome is its exit code |
| 6.7, 6.8 | Milestone 4 |
| 6.9 Failures | Milestones 4 and 8; the runner's restart waits (D229) |
| 6.10, 6.11 | Milestone 9 |
| 6.12 The VM image | Milestone 7; natively at G2, in Docker in milestone 13 (D220) |
| 6.13 The network policy | Milestone 8 |
| 7. The agent's instructions | Milestone 11 |
| 8.2 Environment | Every variable is one `settings.mjs` knows, on its side, and each example explains it (a test); `B2_ACCOUNT_ID` and `B2_ACCOUNT_KEY` too, which 8.2 names in a row |
| 8.3 Docker | Milestone 13; the other architecture not built (below) |
| 8.4 CLI | Every command, as `scooter help` lists them; `build-image`'s line corrected (D233) |
| 8.5 Running natively | Milestone 12; the unit's restarts (D207, D229) |
| 8.6 Constants | Every number in `limits.mjs`, which a test holds to its values, and now every one of them in the table (D234) |
| 9. Security | Each control is built, and tested where 10 asks; the accepted risks, with D160 |
| 10. Testing | Each required test, as each milestone's "what was run" lists it; this milestone's are in 14.6 |
| 14. Not verified yet | In the README as "Check on the first real run", gate G4's items |

Not done, or not verified:
- **Gate G4**, the first real run, with the owner's phone, accounts and keys: every item of section 14 not marked checked, in the README's "Check on the first real run". The install on the machine Scooter will live on stays with the owner too.
- **arm64**, and building the image for the other architecture with `docker buildx`, which 11.5 asks where Docker can: the plan's machine has no arm64 emulation (D228). macOS, Docker Desktop, OrbStack and Colima are deferred ([Deferred and out of scope](ARCHITECTURE.md#deferred-and-out-of-scope)).
- **A request the agent sends itself** can decide the cause of a failure: accepted by the owner (D160).
- **The moment `uaccess` leaves** on a desktop with rootless Docker's udev rule (D217): unverified, and in the README.
- **The README's native install as a whole**, as text, on a fresh machine: its steps were run at G1 and G2 in milestone 12.

### 14.6 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-18, on the Linux machine, Node 22.23.2, QEMU 8.2.2, restic 0.19.1, Docker 29.7.1 rootless with Compose 5.3.1. `25766da` holds all the code and tests, `c753450` the documents; the commit after it records this section and nothing else.

| Command | Result |
|---|---|
| `npm ci && npm test`, on a clean clone of the branch from GitHub at `c753450` | 774 tests: 725 pass, none fail. 49 skip themselves: 37 need the image, 8 need root, and 4 need root and `SCOOTER_ROOT_TESTS=1` |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'`, on the same clone | 776 tests: 764 pass, none fail, in 117 seconds. The 12 that need root skip themselves. Boots with KVM: 2.1 to 2.2 seconds, and 1.6 for `doctor`'s boot check. No QEMU left |
| The root-test command of section 3 of the plan, on a second clean clone at `c753450`, with `~/.local/bin/restic` mounted at `/usr/local/bin/restic` | Node 24.22.3: 774 tests, 711 pass, none fail. 63 skip themselves: 37 need the image, 14 are about what root can read or write anyway, 4 need wacli, 4 `mke2fs`, 2 run `scooter bridge` as a process, 1 `systemd-analyze`, and 1 Docker. This milestone's tests all run there, and pass |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'node test/live/openrouter.mjs'`, with the network, from the working tree at `25766da`'s code | "all as it should be", exit code 0: on each route pi's request, about 24 KB, went through the policy to OpenRouter, which answered 401; the runner took it as a setup error, paused runs and counted no attempt; `curl https://example.com/` in a VM was refused. No QEMU left |
| The new tests of `restarts`, 3 times | No failure |

**D229 in Docker**, by hand, on the Linux machine's rootless Docker, from the working tree at `25766da`'s code: `docker compose -p scooter14 build`, then `run --rm build-image` (14 seconds, 527 MB); `runner.env` with a well-formed key OpenRouter doesn't know and `AGENT_ACCEL=emulation`; a message stored with the bridge's store; and, as the fault that stays after pi has run, the volume's `exchange/outbox` made a file, so the notice of the run's setup error can't be written and the runner stops before the run is recorded. Then `up -d runner`:

| When (UTC) | What the runner's log said |
|---|---|
| 14:52:41 | Started. The VM booted at 14:52:53, pi's request got 401, and at 14:53:03 `runner.failed` with `ENOTDIR` |
| 14:53:04 | Docker started it again at once; `runner.restart_waiting`, 1 stop, until 14:54:03. Its notice couldn't be written either, and that was logged |
| 14:54:07 | The VM booted after the wait; at 14:54:23 the same stop |
| 14:54:23 | Started again at once; waiting, 2 stops, until 14:59:51, 5 minutes 28 seconds after the stop. `status.json` held `restart: {"stops": 2, "until": "2026-11-18T14:59:51Z", "reason": "ENOTDIR"}`, and `runner/restarts.json` was `scooter-runner`'s, 0600 |
| 14:54:31 | `docker compose -p scooter14 restart runner`: `runner.stopping` on `SIGTERM`, during the wait. The next start didn't wait: the VM booted at 14:54:45, and at 14:54:55 the same stop, the first in a row again, waiting until 14:55:55 |

Then `down -v`; no QEMU of `agentw` was left. Also by hand in Docker: `docker run --entrypoint tini scooter:local -- node …` gives Node tini as its parent (D233); `docker cp` copies a folder out of a named volume, from a container stopped; `docker compose run -d` makes a container with no restart policy; and `git reset --hard <tag>`, run as `scooter-runner` in a runner's container with `--entrypoint git`, resets the agent's repository in the volume (D230).

The tests the plan asks of this milestone, and where they are:

| Required | Where |
|---|---|
| D229: the choice, with a test | `restarts.test.mjs`; `units.test.mjs`, the unit's setting and the waits against systemd's; `status.test.mjs` and `runnerfiles.test.mjs`, `/status` and `status.json` |
| The final check | 14.5, and the runs above |

Beyond those: the review's points in `doctor`, `sandbox`, `docker` and `delivery`; the constants in `limits`, the path in `paths`.

Not verified:
- **Gate G4**, with the owner's phone, accounts and keys, and the install on the machine Scooter will live on (14.5).
- **arm64** (D228), and macOS, deferred.
- **The restart notice in Docker**: the check's fault was an outbox that can't be written, so the notice couldn't be; the test shows it in the runner's own outbox.
- **The README's native install as a whole**, on a fresh machine: its steps ran at G1 and G2 (12.5). No root VM was started for this milestone: none of its work is a gate of G1 to G3.

### 14.7 The review of this milestone

The review of the pull request, at `c7d3722`, found the milestone's checks and runs as described, asked for one change, and noted eight smaller points. Each is below, with what became of it.

| # | Point | What became of it |
|---|---|---|
| Must 1 | The README's native upgrade fails as written, and leaves the pinned pi stale: `build-image` ran while the runner was up, which it refuses, and before the merge of `config/`, so natively it built from the owner's old `image/build.json` | Fixed in the README, the review's way. The native block stops the runner first; shows what the upgrade changed in `config/` (`git diff ORIG_HEAD HEAD -- config/`); says to merge it into `/etc/scooter/config` before `build-image`, `image/build.json` above all, which the runner and `build-image` read there, and that copying it is the merge for an owner who never changed it; then `setup`, `build-image`, and both services. The paragraph on upgrades in "The agent's instructions" says the pin is in the owner's copy natively. Of the two times to build, after each upgrade or when `build.json` changed, the README now says after each upgrade, natively and in Docker, as DESIGN.md 8.3 and the Docker install already did: the image holds Gondolin's own programs for the VM too (`sandboxd`, `sandboxfs`), which an upgrade of Gondolin changes while `build.json` stays as it was |
| 1 | A start that fails before its wait isn't recorded, and the next start doesn't wait, where D229, 6.9 and the README said it waits too | The text corrected, not the code: D229's cost, DESIGN.md 6.9, and the README's restarts. Such a start runs nothing of pi's, so the plan's rule holds, and recording it would pace nothing: the next start stops in the same steps before it comes to the wait. Waiting before those steps would put the wait before the checks that say what is wrong, and before `status.json`, which needs the sandbox opened, and `/status` would then not say that the runner waits. Docker's own restarts pace such a start, with waits of a minute at most, and natively systemd waits as after any stop |
| 5 | `setfacl` needs the `acl` package, which the README didn't say | Said beside the udev rule, as `compose.kvm-rootless.yaml` says it |
| 6 | `doctor` ignores Ctrl-C after the boot check, and waits up to `DOCTOR_TIMEOUT` for OpenRouter | Fixed (D231): the signal that closes the boot check's VM also ends the wait for OpenRouter's answer, and no check of OpenRouter is made then. Test in `doctor`, which hangs on `c7d3722` |
| 7 | D234 says nine constants and names eight | Eight, by a script over `main`'s `limits.mjs` and 8.6: corrected in D234, 14.4 and the pull request's description |
| 8 | `/status` goes on saying the runner waits when it was stopped during the wait and not started again | Fixed (D229): a stop during the wait writes `status.json` again without `restart`, as best it can. DESIGN.md 6.3 says so. Test in `restarts`, which fails on `c7d3722` |

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
