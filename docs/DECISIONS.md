# Decisions

This file records what was decided while building Scooter v2, where `docs/DESIGN.md` and `docs/ARCHITECTURE.md` left something open, and what each check of the tools found. It also records the changes made to DESIGN.md while building, each with the question put to the owner and the answer. Each entry gives the question, the choice and the reason. Numbers in parentheses, such as (6.6), are sections of DESIGN.md. "Row 8" is row 8 of the table in section 8 of ARCHITECTURE.md. "The plan" is `docs/plans/active/v2-linux-implementation.md`.

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

### 0.6 The checks: wacli

The tests are in `test/tools/wacli.test.mjs`. They run wacli with the environment of 5.1 and nothing else, not even `PATH`.

**wacli 1. Whether `sync` can take the webhook secret from its environment.**
*Ran:* `wacli sync --help`. A search of the program for the names of environment variables. `sync` with the secret in `WACLI_WEBHOOK_SECRET`, `WACLI_SYNC_WEBHOOK_SECRET` and `WEBHOOK_SECRET`. The source of the flag at the release's tag, `cmd/wacli/sync.go`.
*Found:* it can't. `--webhook-secret` is a plain flag. The program reads nine variables of its own, among them `WACLI_STORE_DIR` and `WACLI_READONLY`, and none is about webhooks. Its `config.yaml` holds accounts only.
*So:* the secret stays on wacli's command line, the one exception 3.2 and 5.1 allow, with the risk section 9 already accepts.

**wacli 2. `auth status` when not paired.**
*Ran:* `wacli --json --read-only auth status` against a store that doesn't exist.
*Found:* exit code 0, nothing on stderr, and `{"success":true,"data":{"authenticated":false},"error":null}` on stdout. With `--read-only` it doesn't create the store. Commands that need the session, `sync` among them, fail at once with exit code 1 and `{"success":false,"data":null,"error":"not authenticated; run \`wacli auth\`"}` on stderr.
*So:* the pairing check of 5.1 reads `data.authenticated`. The exit code doesn't tell paired from unpaired.

**wacli 3. The commands and flags of 13.1.**
*Ran:* `--help` for `sync`, `auth`, `auth status`, `messages list`, `media download`, `send text`, `send file` and `send react`, and `messages list` against an empty store. After the owner's answer (0.8): the two send commands of 5.3 as the bridge will run them, `--no-preview` included, against a store that isn't paired.
*Found:* every command and flag of 13.1 exists as written, with the defaults it gives. Three more things matter to later milestones:
- **`send text` fetches the first URL in the text,** to send a link preview with it, unless `--no-preview` is given. wacli's `docs/send.md` says so, its source does it (`fetchLinkPreview` in `cmd/wacli/send.go`), and the flag is in the help. See 0.8, question 1. More from the same documentation and source, at the release's tag:
  - It takes the first `http://` or `https://` URL, fetches that page, and then the image the page names. It refuses private and local addresses, follows up to 3 redirects, and gives up after 10 seconds. When the fetch fails, the text goes out without a preview, and wacli prints a line on stderr that starts `warning: link preview skipped for`.
  - While `sync --follow` runs, a send is handed to the sync process, and that process does the fetching. The flag goes with the send: the request has a `no_preview` field (`cmd/wacli/send_ipc.go`), and the installed program holds that field's name.
  - With the flag, `fetchLinkPreview` returns before it looks for a URL.
  - None of this was run: sending needs a paired number. Not paired, `send text` with `--no-preview`, with and without `--reply-to`, and `send react` each stop at `not authenticated`, so wacli took every flag of 5.3. A flag it doesn't know stops it before that, with `unknown flag`. A text that begins with `--` is taken as the text.
- `messages list --json` answers `{"messages": …, "page": {"has_more": …, "next_cursor": …}, …}` inside `data`, and `messages` is `null`, not an empty list, when there are none. With `--read-only` it fails when the store doesn't exist yet.
- By its source, wacli prints a warning on stderr when two sends are less than 5 seconds apart, and still succeeds. `SEND_INTERVAL` was 1.5 seconds when this was found, so the bridge would have seen that warning often. The owner has since raised it to 5 seconds (see "Between milestones 1 and 2: the send interval"). This wasn't run: sending needs a paired number.

*So:* milestones 2 and 5 can use the commands of 13.1 as they stand, with `--no-preview` on every `send text` (0.8, question 1), and must treat a `null` list as empty.

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
- **wacli when paired.** Sending, receiving, and the shape of a list row need the bot number (gate G4). That goes for `--no-preview` too: that wacli fetches nothing when given the flag is read from its documentation and source, not seen (0.6, 0.8).
- **A native image build as root** (gate G2). Only the container build was run.

### 0.8 Questions for the owner, and the answers

Two outcomes didn't fit DESIGN.md as it stood. Neither stopped milestones 1 to 4. Both went to the owner on 2026-11-16, each with a proposal, through the milestone workflow (`docs/plans/active/milestone-loop.workflow.js`). The owner was asked "Accept both proposals for milestone 0's two questions?" and answered "Yes, both", having been told that DESIGN.md would then be changed to match.

**1. wacli's link previews (5.3; before milestone 5).**
*The question, as asked:*
> DESIGN.md sends replies with `wacli send text --to <owner chat> --message <chunk>`. By wacli 0.26.0's documentation (`docs/send.md`) and source (`fetchLinkPreview` in `cmd/wacli/send.go`), that command fetches the first URL in the text, from any public host, to build a link preview, unless `--no-preview` is given. The text is the agent's. So a misled agent could make the bridge's side fetch a URL of its choosing, with data in it, while internet access is off, and the request would be in no log. That goes against 3.1 (the bridge's only outbound connections) and principles 2 and 4. Proposed: the bridge always passes `--no-preview`, so links arrive as plain text. Do you agree?

*The answer:* yes. The bridge always passes `--no-preview` to `wacli send text`.
*What follows:*
- DESIGN.md gives the command with the flag, and the reason, in 5.3. It says the same in 3.1, the table of section 5, the controls of section 9, the delivery tests of section 10 and wacli's facts in 13.1. ARCHITECTURE.md says it in 2.2, 3.4 and 5.3, and the plan in a rule of milestone 5.
- Milestone 5 builds it. Its delivery tests check that the flag is on every text's command line (section 10).
- Not verified: that a paired wacli, given the flag, fetches nothing (0.6). That is now an item of section 14 of DESIGN.md, and gate G4 checks it. A way to tell, there: send a text with a link to a name that can't resolve, such as `https://scooter-check.invalid/`. Without the flag, wacli should print its `link preview skipped` warning. With the flag it should print none, and the message should arrive without a preview.
- Nothing else Scooter sends through wacli carries the agent's words. A reaction carries the emoji from the config, and v2 sends no files.

**2. Whether pi may read `sessions/` (6.6; before milestone 7).**
*The question, as asked:*
> 6.6 says "pi never sees `sessions/`", but the mounts 6.6 lists make the whole agent folder readable in the VM, `sessions/` included (a test shows it; pi can't change it either way). Proposed: milestone 7 hides `sessions/` from the VM with Gondolin's ShadowProvider, which a test shows to work. The other choice is to leave it readable and correct that sentence in DESIGN.md. Which do you want?

*The answer:* hide it from the VM with Gondolin's `ShadowProvider`, in milestone 7. pi does not see `sessions/`.
*What follows:*
- DESIGN.md lists `sessions/` as hidden in the mounts of 6.6. It says the same in 6.2, the controls of section 9, the runner and sandbox tests of section 10 and Gondolin's facts in 13.4. ARCHITECTURE.md says it in 2.7, 2.9, 2.10, 3.3 and decision 30, and the plan in a rule of milestone 7.
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
*Reason:* a misspelled name would otherwise be ignored without a word: `EMAIL_IMAP_HOTS` would leave email off. And the runner's key in `bridge.env` would sit where the bridge can read it, against 3.2. *Cost:* the env files hold Scooter's settings and nothing else. Under Compose there is no file to read, only the environment, so this check does nothing there.

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
*Choice:* the settings accept `whatsapp` or `email`, the two sources a line can have. The bridge's startup check, in milestone 5, refuses a channel that can't send, which leaves `whatsapp` (5.3).
*Reason:* the core is channel-neutral, and "can send" is something a channel module knows. Milestone 5 lists that check and its test.

**D19. Other settings rules.**
- Loading returns an object and never changes the environment. A program the service starts gets only what it is handed (3.2).
- Every fault is reported at once, each naming its variable. No message repeats a value, because a value may be a secret.
- Email is on when `EMAIL_IMAP_HOST` is set, and then the user, the password, the owner's addresses and the server name are required. Off, the other mailbox variables aren't looked at. Backups are the same with `RESTIC_REPOSITORY` and `RESTIC_PASSWORD`.
- `OWNER_NUMBER` may be written with `+`, spaces, hyphens and brackets, and is kept as digits. The owner's email addresses are kept in lower case, since they are compared without regard to case.
- `DATA_DIR` and `CONFIG_DIR` default to `/data` and `/config` and must be absolute paths.
- `AGENT_ACCEL=hvf` passes the settings. The runner refuses it when it picks the accelerator (6.6), in milestone 7.
- `SCOOTER_ENV_DIR` is read from the environment alone.

**D20. Constants: units, how tests change them, and two additions.**
*Choice:* durations are in milliseconds and sizes in bytes, under the names 8.6 gives. `limits` is one object that code reads at the moment of use, and `overrideLimits` changes values for a test and returns the function that puts them back. Besides `WEBHOOK_PORT`, which the plan adds, there are two more: `SETTING_RANGES` (D17) and `ATTACHMENT_EXT_MAX_CHARS`, 10, the longest extension an attachment's stored name takes from its original name.
*Reason:* 8.6 wants every tuning number in the module and tests overriding them through it.

**D21. Daylight saving: a local time means the earliest instant at which the zone's clock shows that time or a later one.**
*Question:* the plan asks for the next instant of a local `HH:MM`, correct across daylight-saving changes. Two local times are awkward: one that comes twice when clocks go back, and one that is skipped when they go forward.
*Choice:* one rule for both. A time that comes twice means its first occurrence. A skipped time means the instant of the jump: on a day when 02:00 becomes 03:00, 02:30 comes due at 03:00. Each local date gives a schedule one instant, so a daily task runs once on either kind of day. A date that a zone skips altogether has nothing due on it.
*Reason:* a daily backup or check-in must neither be skipped nor run twice. Running at the jump is what cron does with a skipped time. The code uses Node's own time zone data, through `Intl.DateTimeFormat`, and no library.

**D22. The clock is two functions.**
*Choice:* `now()`, in milliseconds, and `sleep(ms, { signal })`, which rejects when the signal aborts. Everything that waits or reads the time takes a clock. `test/support/clock.mjs` is the fake: `advance` wakes sleepers in order, `set` moves the time either way, and `whenSleeping` waits for code under test to reach its next sleep.
*Reason:* polling loops, backoff and timeouts are all "wait, then look again". One function covers them, and a test can then run through hours in milliseconds.

**D23. Logs go to stderr, and three small things keep content out of them.**
*Choice:* a line is `at`, `level`, `component`, `event` and the caller's fields. Then:
- a field named `text`, `subject` or `quoted`, the content fields of a datastore line, is written as `[withheld]`;
- a field's value is a string, a number, a boolean, null, or a list of those. Anything nested is written as `[object]` or `[array]`;
- `errorFields(error)` gives an error's name, code and system call, without its message.

*Reason:* stderr leaves stdout to the commands that print results. The rule that logs carry no message text (section 9) is the caller's to keep, and these three make the common slips harmless: logging a whole line, and logging the message of a parsing error, which quotes what was being parsed.

**D24. Sortable IDs, and the folder hand-off.**
*Choice:* an ID is the UTC time to the millisecond and a four-digit counter that starts at 1 with each millisecond, as in 5.3. IDs from one generator always go up, even when the clock goes back. `handOff` makes `.tmp-<id>`, fills it, syncs it and renames it. If the name is taken, at either step, it takes the next ID. `listHandOffs` gives the finished folders in order.
*Reason:* the outbox and the mail spool share this (ARCHITECTURE.md, decision 9). The rule about a taken name is milestone 5's, and it lives here because two processes write outbox entries with the same code.

**D25. Running programs.**
- **Found on Scooter's own `PATH`.** A program's environment is exactly what the caller gives, empty by default, and wacli's has no `PATH` (5.1). So a bare name is looked up on the `PATH` of the process that starts it.
- **Stopped as a process, not a group.** SIGTERM, then SIGKILL after `STOP_GRACE`, go to the program itself. It stays in Scooter's process group, so whatever stops the service's group stops it too (6.6).
- **The restart wait goes back to 5 seconds after a run of 5 minutes or more.** 5.1 gives the waits and not when they start again. A program that ran as long as the longest wait was working.
- **A program that can't be started** is tried again with the same waits.
- **Users by name.** `lookupUser` asks `id -u` and `id -g`, which every Unix has. Node has no call for it.
- **Not root.** Switching users is skipped, `lookupUser` returns null, and one warning is logged for the life of the process (section 10). Whoever gets null leaves file owners alone.
- **Logs name the program,** never its arguments or environment: wacli's command line carries the webhook secret (5.1).
- `proc.mjs` is the only module that imports `node:child_process`, and it never uses a shell. The import test holds everything else to that.

**D26. Lock files.**
*Choice:* a lock is one line of JSON: `pid`, `at` and `deadline`, the last two as UTC times to the second, and `deadline` null when there is none. It is written under a temporary name and hard-linked into place.
*Reason:* a link fails if the name exists, which makes taking the lock exclusive, and the name appears with its contents complete, so the bridge never reads half a `run.lock`. A lock that can't be read still counts as held. How the two locks work together is for milestones 4 and 10 (row 7).

**D27. The line format is checked in both directions.**
*Question:* 4.2 gives the fields and when each is present. It doesn't say what a reader does with a line that breaks the table.
*Choice:* `checkLine` is the table as code, and both the store and the reader use it. A field the table doesn't have is refused. So is a field on a kind of line the table doesn't give it to: `text` only on messages, edits and commands; `target` only on edits, deletions and reactions; `emoji` only on reactions; `subject` only on emails; `files`, `media`, `replyTo`, `quoted` and `forwarded` only on messages; `trust` only on `in` lines and `by` only on `out` lines. `replyTo` and `target` must be lower than the line's own `seq`. Lines are written with their fields in one order, the order of the examples in 4.2.
*Reason:* the datastore is the record, and the line is a contract between the bridge, the runner and pi (ARCHITECTURE.md 3.6). A field in the wrong place is a bug in the writer, and it is cheaper to catch it at the one place lines are written. *Cost:* adding a field means changing `line.mjs` first.

**D28. What the index knows a line by.**
*Question:* 4.3 has the index map `(source, sourceId)` to `seq`, and an edit carries the ID of the message it changes (13.1).
*Choice:* messages, commands and reactions are known by their own ID, and the first line with an ID keeps it. Edits and deletions are never looked up by ID. A command whose ID is stored is a duplicate, like a message: 4.4 names messages, edits, deletions and reactions, and a command reaches the bridge the same two ways. The index keeps the current text, the latest edit and the deletion for messages and for commands.
*Reason:* an edit that took over its message's ID would send replies and reactions to the edit. The bridge and the runner each build the same index from the same lines (`src/common/datastore/index.mjs`).

**D29. The store.**
- **A damaged datastore stops it.** At startup a complete line that isn't a line, a `seq` that isn't one more than the last, or part of a line in a day that isn't the newest, is an error that names the file and the line and quotes nothing. The store changes nothing in that case. Only part of a line at the very end of the newest log is removed (4.3).
- **A failed write stops it too.** If a line's `write` or `fsync` fails, the log may end in part of a line. Only a start removes that (the plan's rule for milestone 1), so the store refuses every later append until the bridge restarts.
- **`seq` and `files` are the store's to set.** The caller gives the line without them, and the attachments as files already downloaded: `{ path, mime, name }`. The store copies them and leaves the originals, which belong to whoever staged them (5.2).
- **An attachment that can't be copied** stores nothing and uses up no `seq`. Intake then stores the message with a `media` object (5.2), in milestone 2.
- **Attachment names** (4.4): the extension is the original name's, if it is letters and digits and no longer than `ATTACHMENT_EXT_MAX_CHARS`, in lower case. Otherwise it comes from a table of MIME types in `store.mjs`, and otherwise it is `bin`. A file with no MIME type is recorded as `application/octet-stream`.
- **Unfinished copies** (`.tmp-…`) in the newest day folder are removed at startup.
- **What the store leaves to intake:** the 100 MB limit, which applies before a download, and the list of what isn't stored (4.4). Both need to know the channel.
- **Owners and modes** (3.2): folders 0750 and files 0640, set explicitly, so the umask doesn't matter. The owner is given by whoever opens the store, as `{ uid, gid }`, and is left alone without one.
- **The store is never told the owner's time zone.** Day folders are UTC dates of its clock.

**D30. The CLI.**
*Choice:* the table has the twelve commands of 8.4, each with a side: `bridge`, `runner`, or `host` for `setup` and `build-image`, which ARCHITECTURE.md 2.13 lists as root's, on the host. A `bridge` or `runner` command gets its side's settings and the other side's env file is never opened. A `host` command gets none here: what `setup` and `build-image` read is for milestones 12 and 7 to settle. A command's code is imported only when the command runs. No command is built yet, and each says so and exits with 1. Exit codes: 0, 1 when a command fails, and 2 when it can't start because of how it was called or configured, which matches the 2 that 5.5 gives the backup commands.

**D31. What the import test checks, and how.**
*Question:* some rules of section 4.2 of ARCHITECTURE.md are about what code does, not what it imports.
*Choice:* `test/support/imports.mjs` reads every file under `src/` and checks:
- which folders import which, as the diagram of 4.2 draws it, `src/ops` included: it imports only `src/common`;
- that `src/mail` imports only `files`, `limits` and `log` from `src/common`, and doesn't reach `settings.mjs` through another module either;
- where each of the four libraries may be imported, and that nothing else is imported that isn't a `node:` module;
- that `src/cli.mjs` imports a command's code only with `import()`;
- "only the store appends to the datastore", as two things it can see: only `store.mjs` imports `encodeLine`, and nothing in `src/common/datastore/` calls a function that changes a file;
- "only one module runs each program", as: only `proc.mjs` imports `node:child_process`; in the bridge only the two channel modules and `backup.mjs` import `proc.mjs`; and the strings `'wacli'`, `'restic'` and `…mail/reader.mjs` appear only in the module that runs that program (`paths.mjs` may name wacli's folder).

It doesn't check rule 5, that every tuning number is in `limits.mjs`. No scan can tell a tuning number from any other number.
*Reason:* the plan asks for a test that enforces the rules. Where a rule can't be seen in the imports, the test holds to the nearest thing that can.

**D32. Two kinds of root test.**
*Choice:* tests that need root, to give files away or to run a program as another user, run whenever the suite runs as root, with made-up numeric IDs. Tests that create a user run only with `SCOOTER_ROOT_TESTS=1` as well.
*Reason:* section 10 keeps user creation behind that variable, so running the suite as root on a real machine creates none. A numeric owner needs no user to exist.

**D33. The reader.**
*Choice:* a reader starts at the first line of the datastore and keeps its own place: the day folder, and how many bytes of that day's log it has taken. A poll gives all of its new lines or none. When it meets a complete line that isn't a line, it throws, names the file and the line, and stays where it was before the poll. The reader and the store take every path from `paths.mjs`.
*Reason:* the datastore holds no reader's state (ARCHITECTURE.md 2.4), and both readers want every line anyway, to build the index. A reader that gave half a poll's lines and then failed would have moved past lines nobody received.

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

### 1.3 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-16, on the Linux machine, with Node 22.23.2:

| Command | Result |
|---|---|
| `npm ci && npm test`, from a clean clone of the branch | 164 tests: 140 pass, none fail. 24 skip themselves: the 18 pi and VM tests of milestone 0, which need the image, and the 6 that need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 158 pass, none fail, in about a minute and a half. The 6 root tests skip themselves |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie`, with `SCOOTER_ROOT_TESTS=1` | On Node 24.22.3: 141 pass, none fail. The 6 root tests run, the two that create a user among them. 23 skip themselves: the 18 that need the image, the 4 that need wacli, and one that only makes sense when not root |
| `npm test`, 25 times in a row, then 36 times with 12 running at once | No failure. The tests of `proc.mjs` and `locks.mjs` start real processes, and this was to see that none depends on timing |
| The env file check of 1.2 | The format reads the same in all three |

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Test file |
|---|---|
| Datastore: `seq` order across days; day folders by UTC date that never go backwards, even when the clock does; recovery from an incomplete last line; duplicates; attachment names; the index rebuilt on restart | `test/datastore.test.mjs` |
| Time, for storage and conversion: stored times are UTC; a local time and a schedule across daylight-saving changes; nothing depends on the process's time zone, and a restart in another one doesn't reorder the datastore | `test/time.test.mjs`, and one test in `test/datastore.test.mjs` |
| Settings; each service reads only its own env file | `test/settings.test.mjs`, `test/cli.test.mjs` |
| Locks | `test/locks.test.mjs` |
| Least privilege, for folder modes: the datastore's owner, group and modes | `test/datastore.test.mjs`. The modes are checked on every run, and the owner and group as root |
| The import rules | `test/imports.test.mjs` |

Not verified:
- **arm64 and macOS.** The machine runs neither. Nothing in this milestone knows the architecture, and the portability rules of section 10 are kept: no `/proc`, no `fs.watch`, and only `id -u` and `id -g` as outside commands.
- **The env file format against systemd and Compose, in the test suite.** It was compared by hand, once, with the versions in 1.2. `npm test` checks only Scooter's loader.
- **Durability.** The store syncs each line and each attachment. That a line survives a power cut can't be tested here. A crash is tested by leaving part of a line on disk and starting again.
- **The pieces at work in a service.** Supervising wacli, the two locks together, and the store under real intake belong to milestones 2, 4, 5 and 10, which test them.
- **Rule 5 of the import rules** has no test (D31).

## Between milestones 1 and 2: the send interval

One point from the review of milestone 0's pull request went to the owner on 2026-11-16, after milestone 1 was merged: how often the bridge sends (5.3, 8.6; before milestone 5). No milestone's agent made this change. It was committed straight to `main`.

*The question, as asked:*
> wacli prints a warning when two sends are less than 5 seconds apart, saying rapid automated sends may trigger WhatsApp rate limits or account restrictions. DESIGN.md sets `SEND_INTERVAL` to 1.5 seconds. […] On the send interval, I would raise it to 5 seconds: a reply in three parts then takes 10 seconds instead of 3, and replies to your own chat aren't urgent. wacli also has its own pacing option (`sync --send-spacing`, with a random gap).

*The answer:* "yes to all", to a message that held this proposal and two changes to the milestone workflow. `SEND_INTERVAL` is 5 seconds.

*What follows:*
- DESIGN.md has 5 seconds in 5.3 and 8.6, and wacli's check in 13.1. ARCHITECTURE.md has it in 5.3 and in decision 22. `src/common/limits.mjs` and `test/limits.test.mjs` have the value. Nothing reads the constant yet: milestone 5 builds the outbox processor.
- The interval is between any two sends, reactions included, as 5.3 has it. So in quiet mode the ✅ reactions to a batch of handled messages go out 5 seconds apart: a full batch of 20 takes 95 seconds, where it took about 29. The question put to the owner gave only the three-part reply as an example. This was reported to the owner with the change.
- How wacli checks, from its source at v0.26.0 (`warnRapidSendIfNeeded` in `cmd/wacli/send_helpers.go`, called from `send.go` and `send_ipc.go`):
  - Before it sends, it writes the time of the attempt to `.last-send-at` in its store folder. It warns when the next attempt comes less than 5 seconds after that time.
  - It does this for a text sent directly, and for every kind of send handed to the sync process: text, file, sticker, edit and reaction.
  - The time is taken when the send reaches the check, after wacli has resolved the recipient, not when the command starts. While `sync --follow` runs, sends are handed to the sync process (0.6), so the check runs there, and the warning is on that process's stderr, not the send command's.
  - So at exactly 5 seconds a warning can still appear now and then, when a send reaches the check sooner after its start than the one before it did. The send goes out all the same. Milestone 5 must not count the warning as a failure.
- Not used: `wacli sync --send-spacing`, which makes the sync process wait between the sends handed to it. The bridge paces its own sends (5.3), and one place is enough.
- Not verified: any of this with a paired number, and whether 5 seconds is slow enough for WhatsApp. WhatsApp doesn't publish its limits. 5 seconds is the threshold that wacli's authors chose for their warning.

## Milestone 2: bridge intake, WhatsApp

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md and ARCHITECTURE.md changed only where they still listed as open what milestone 0 had settled (2.3).

What the milestone left in the repository:

| Path | What |
|---|---|
| `src/bridge/channels/index.mjs` | What the core asks of a channel, and the record, with its check |
| `src/bridge/channels/whatsapp.mjs` | The WhatsApp channel: wacli's environment, the pairing check, sync's supervision, the webhook, wacli's two formats, the filters and owner matching, catch-up, downloads |
| `src/bridge/intake.mjs` | Records to datastore lines, with their attachments |
| `src/bridge/state.mjs` | `bridge/state.json` |
| `src/bridge/main.mjs` | `scooter bridge`: one bridge per data folder, the store, the state, the channel and intake |
| `src/common/files.mjs` | `copyUntrustedFile` |
| `test/support/` | A fake channel; the wacli stub and its helper, with samples of wacli's two formats |
| `test/intake.test.mjs`, `test/whatsapp.test.mjs`, `test/bridge.test.mjs` | The tests of this milestone |

It also settled the smaller points of the reviews of milestones 0 and 1, in code, tests and documents (2.2).

### 2.1 Decisions

**D34. A record has a list of attachments, and an attachment can say why it isn't to be downloaded.**
*Question:* 5 defines a record as the normalized message without what only WhatsApp needs, and `download(record, n, path)` takes the number of an attachment.
*Choice:* `src/bridge/channels/index.mjs` gives the fields: `source`, `id`, `at` (a UTC time to the second, or null when the channel doesn't know, and then the time of arrival), `text`, `subject` on email only, `attachments`, `replyToId`, `replyToPreview`, `reactionToId`, `reactionEmoji` ("" for a removed reaction, null when it isn't one), `edited`, `revoked` and `forwarded`. Each attachment is `{ type, mime, name, bytes, error }`; `error` says why the core mustn't try to download it, as for a location (D40). `checkRecord` is the shape in code. Intake refuses, and logs, a record that fails it.
*Reason:* email (milestone 6) has several attachments and can have an `.eml` that couldn't be parsed. One shape covers both, and the core needs no channel's details.

**D35. A download is copied out of wacli's folder with care, into one of the bridge's own.**
*Question:* 5.2 step 6 downloads into `wacli/staging/` and copies the file into the day folder. wacli owns that folder and runs third-party code; the bridge is root.
*Choice:* the core picks the `path` of `download`, in `bridge/incoming/`, which only root can write. The WhatsApp module runs `wacli media download --chat <chat> --id <id> --output <staging>/<a name of its own>`, checks that wacli says it saved the file there, and copies it to `path` with `copyUntrustedFile`, which opens it without following a link, and refuses anything but a regular file with one name, owned by `scooter-wacli`, and no larger than `ATTACHMENT_MAX_BYTES`. The staged file is removed either way. The store copies `path` into the day folder, and intake removes it. `bridge/incoming/` is emptied at startup.
*Reason:* a link, or a hard link, left in the staging folder in place of the download would make root copy a file wacli can't read, such as a key, into the datastore, where the runner and pi read it. *Cost:* each attachment is copied twice. The mail spool (milestone 6) needs the same copy, so it is in `src/common/files.mjs`.
*Also:* a record carries no chat (5), and `download` needs one. The module keeps the chat of each record it hands over in a `WeakMap` keyed by the record.

**D36. A failed download is tried again after 10 seconds, twice.**
*Choice:* a new constant, `MEDIA_DOWNLOAD_RETRY_WAIT`, 10 seconds, before each of the `MEDIA_DOWNLOAD_RETRIES`. A download refused as too large (`EFBIG`) isn't retried. An attachment whose size the channel gives as over `ATTACHMENT_MAX_BYTES` isn't downloaded, and a downloaded file over it is thrown away. Either way the line gets `media` with `too large, not downloaded`; after three failures, `download failed`; and when the store couldn't copy the file, `could not be stored`, with the message stored without its files (D29).
*Reason:* a download that fails for good leaves the message without its attachment for ever, and an immediate retry would meet the same reconnecting wacli. Records wait in one queue meanwhile, so the wait is short: 20 seconds at most for one failing attachment.

**D37. Every wacli call except sync has a timeout of 6 minutes.**
*Choice:* a new constant, `WACLI_CALL_TIMEOUT`. wacli stops its own commands after 5 minutes (its `--timeout`), and this bounds a call that doesn't, so one stuck download can't hold up every message after it.

**D38. Intake takes one record at a time, from the webhook and catch-up alike.**
*Choice:* one queue in `intake.mjs`. A message whose ID is stored is skipped before its attachments are downloaded again: catch-up lists the last two minutes again every time. A reaction, an edit or a deletion whose target isn't a message or a command is skipped as having an unknown target, and the store refuses one that gets there (2.2, the review of milestone 1, point 5). A failed store stops intake and the bridge, which exits with 1 so its service manager starts it again (D29).

**D39. A command is a text alone, trimmed.**
*Choice:* a record is a command when its channel takes commands, it has no attachments, and its trimmed text is one of the four exactly. The line's text is the trimmed command. A command that quotes a message is still a command, and its line has no `replyTo`, which only messages have (4.2). A forwarded `/new` is a command too: the plan's rule has no exception, and the owner forwarded it. `COMMANDS` is in `line.mjs`, and `checkLine` holds a command line's text to it, so the runner can match it exactly.

**D40. A location is stored as media that isn't a file.**
*Question:* wacli gives a location, and a live location, a `Media` of its own type, with the place's name as the caption and no file. 4.2 has no field for coordinates.
*Choice:* the line has the caption as its text, and `media: { type: "location", error: "not a file, so not stored" }`. Any other media type without a file is treated the same. Stickers are dropped (5.2 step 4).
*Reason:* the line format is a contract (D27), and a list row has no coordinates at all, so writing the webhook's into the text would store the same message two ways depending on which delivered it. *Cost:* the coordinates are lost. If the owner wants them, a field for them is a change to 4.2.

**D41. A media message's text is its caption.**
*Choice:* `Media.Caption`, or `MediaCaption` in a list row, not `Text`. wacli puts the caption in `Text` too, but also writes `[Audio]` there for audio without one, which the owner never wrote.

**D42. wacli's formats, as its source at v0.26.0 has them.**
Read on 2026-11-16 from GitHub at the tag, not run: sending and receiving need a paired number (gate G4). Both are in `fromWebhook` and `fromListRow` in `whatsapp.mjs`, and nowhere else (the plan's rule for this milestone).
- *A webhook payload* (`internal/app/webhook.go`) is wacli's `ParsedMessage` with Go's field names, with `Media` replaced by `{Type, Caption, Filename, MimeType, FileLength}` and `ChatName` added. The signature is `sha256=` and the lowercase hex HMAC-SHA256 of the raw body, as 13.1 says. Messages without an ID aren't posted.
- *An edit* (`extractProtocolMutation` in `internal/wa/messages.go`) carries the ID of the message it changes, `Edited: true` and the new text; a *deletion* carries the ID and `Revoked: true`, with no text and no media. The time is the edit's or the deletion's. This is what 13.1 guessed from `sync_edits.go`. The same code also sets `Chat` and `FromMe` from the key the sender's phone wrote, from the sender's side, so the owner's own deletion, and an edit that isn't encrypted, probably arrive with `FromMe: true` and the bot's JID as `Chat`, and are dropped as the bot's (added in milestone 3, 3.3, point 1).
- *A list row* (`internal/store/types.go`) is the stored message, with Go's field names except `quoted_msg_id` and `quoted_sender_jid`. It has no preview of what it quotes and no size for its media. An edit updates the stored message, so an edited row has the current text and `Edited: true`: `fromListRow` returns it as the message and then its edit. Whichever of the two is already stored is skipped. So a message missed while wacli was down and edited since is stored as it is now, and an edit missed is stored as an edit, but only while catch-up reaches the message: wacli keeps a row's time when an edit arrives, and `--after` filters on that time, so a missed edit of a message older than 2 minutes before the newest line isn't listed. A deletion moves the row's time to its own, so it is listed. An edited row listed before a newer edit came by webhook, and handled after it, puts the older text back, within the time one page takes (corrected in milestone 3, 3.3, point 6). A deleted row becomes a deletion, skipped when the message isn't stored.
- *`messages list --after`* (`ListMessages` in `internal/store/messages.go`) lists rows strictly after the time, compared in whole seconds, oldest first with `--asc`.
- *`media download --output <file>`* (`cmd/wacli/media_download.go`) saves to the file as given, and answers with its `path`.

**D43. Catch-up.**
- *Where it starts:* "the newest incoming WhatsApp line" is the one with the highest `seq`, and its `at` is used. Intake knows it: from the datastore at startup, then from each line it stores. A catch-up that stores an older message moves the start back, which only lists more.
- *A full page* goes on from a second before the last row's time, because `--after` is strict to the second and other rows may share it. If the whole page fell within one second, it goes on from that second, and the rest of it is skipped. 500 messages in one second don't come from one person.
- *The chat* is the owner's chat at the start of the catch-up, for all its pages.
- It runs at startup, at once, alongside the pairing check, and then every `CATCHUP_INTERVAL`. While wacli is known to be unpaired it doesn't run: there is nothing to list, and the store wacli would read may not exist. One that fails is logged, and the next comes at the usual time. It stops between rows when the channel stops.

**D44. Owner matching, and the owner's chat.**
- A JID is compared in lower case, without the `:device` suffix and without the `.agent` part whatsmeow writes before it. User parts are digits, so nothing else is lost.
- `bridge/state.json` keeps `ownerChat` as `{ jid, at }`: the chat of the owner's newest message, and its time. It moves only to a message at least as new, so catch-up delivering older rows doesn't move it back. If it can't be written, that is logged and the message goes on.
- `firstStart` is written on the very first start and never changed. A state file that isn't one stops the bridge, naming the file: it is written atomically, so a crash doesn't leave one.

**D45. The pairing check runs before every start of sync.**
*Choice:* `proc.supervise` takes a `before` hook, awaited before each start, restarts included. The WhatsApp module's hook asks `auth status` and, until wacli is paired, asks again every `AUTH_CHECK_INTERVAL`. "Not paired, run `scooter pair`" is logged when that becomes so, not every minute. The webhook secret is new each time the channel starts, at the bridge's start and, from milestone 10, after each backup. A restart of sync keeps it: the webhook server, which checks it, keeps running.
*Reason:* a session logged out from the phone makes sync fail at once on every restart. Checking first turns that into one log line and a check a minute.
*Also:* `status()` says `linked`, `not linked; run scooter pair`, `starting`, `stopped`, or that wacli stopped and starts again shortly.

**D46. The webhook server's answers.**
404 for any path but `/wacli`, query strings included; 405 for any method but POST; 413 when the body is over `WEBHOOK_MAX_BYTES`, by its `content-length` or by what arrives, and the connection is then closed; 401 for a missing or wrong signature; 200 for a signed body, before it is handled. A signed body that isn't JSON, or is a message without an ID, is logged by its size only. One with an `EventType` is ignored (5.2 step 2). It listens on `127.0.0.1` only. Tests set `WEBHOOK_PORT` to 0, and the URL given to sync names the port the server got.

**D47. What the WhatsApp module logs.**
Drops are logged from webhooks only, by message ID and reason: catch-up lists the bot's own replies again every ten minutes. A sender who isn't the owner is logged by JID, with the hint of 5.2 step 4. Nothing wacli writes is logged: its errors can name chats and files. Each catch-up logs how many rows it read, delivered and dropped.

**D48. One bridge per data folder.**
*Question:* two bridges on one datastore would give out the same `seq`, and then neither starts until the log is repaired by hand (the review of milestone 1, point 8).
*Choice:* the bridge listens on a Unix socket, `bridge/bridge.sock`, before it opens the store. A second bridge finds it answering and refuses to start. One left by a bridge that was killed doesn't answer, and is replaced.
*Reason:* a lock file holding a pid can mistake an unrelated process that got the same pid for a bridge, as happens in a container started afresh, and then the bridge never starts. A socket answers only while its bridge runs, and works across containers that share the folder. *Cost:* two bridges starting at the same instant over a dead socket could both replace it. Starting the bridge is the service manager's job, so that is accepted.

**D49. The bridge's startup.**
In order: it looks up `scooter-wacli` and `scooter-runner`; makes the data folder 0755 if it is missing, since every service user passes through it to reach its own, and its own folder 0700; takes the socket; empties `bridge/incoming/`; opens the store, owned by root with the runner's group (`{ uid: 0, gid: <scooter-runner's gid> }`, 3.2); opens the state; starts the channel. wacli's folders are made 0700 for `scooter-wacli` if they are missing, which in production `setup` does (milestone 12). A startup error is printed and the command exits with 1. On SIGTERM or SIGINT the channel stops, intake finishes what it was handed, and the command exits with 0. Milestones 5, 6 and 10 add the outbox, email and the leftover `backup.lock`.

**D50. `src/bridge/main.mjs` may import `proc.mjs`.**
*Question:* D31 holds that in the bridge only the two channels and `backup.mjs` import `proc.mjs`. The bridge looks up its users by name, which runs `id`.
*Choice:* `main.mjs` is allowed too: it makes the one `proc` the bridge shares, hands it to the channels, and uses its `lookupUser`. The test that names programs still holds `wacli`, `restic` and the email reader to their modules.

**D51. A stopped program is waited for until it exits.**
*Question:* the review of milestone 1 (point 1) found that a timeout didn't bound `run` when what the program started kept its output open.
*Choice:* once a program that was stopped has exited, `run` closes its pipes from its own side and returns. A program that ends by itself is still waited for until its output closes, so all of it is collected. This adds to D25: a stop takes at most `STOP_GRACE`, whatever the program left behind.

**D52. The wacli stub.**
*Choice:* the wrapper first on `PATH` is a Node file whose `#!` line names this Node's own path, and it imports `test/support/wacli-stub.mjs`. Its control folder is beside it. The stub records every call (arguments, environment, user, group, pid), answers from fixtures read afresh at each call, and, running as `sync --follow`, posts the files the test puts in its `webhooks/` folder, signed with the secret on its command line.
*Reason:* 10 says shell wrappers. wacli's environment has no `PATH` to find `node` on, and `dash` adds `PWD` to the environment the stub would record, so the least-privilege test couldn't check that wacli gets exactly its six variables.
*Also:* the tests run the bridge in-process with a fake clock, and once as a real process, `scooter bridge` on the real port, which skips itself when the port is in use. As root, the tests give no users, so wacli runs as root, except one test that runs it as made-up IDs and checks the owners and modes (D32). The tests move the clock ten minutes at a time, so they give wacli calls a timeout far beyond that, except the test of the timeout.

**D53. Where the VM tests keep Gondolin's cache folder.**
*Question:* `test/support/vm.mjs` makes Gondolin's cache folder in the real temporary folder when the module loads, in every process that imports it, whether or not a VM test runs (the review of milestone 0, point 5).
*Choice:* kept as milestone 0 made it. Gondolin fixes the folder for its list of running VMs when its module loads (0.5), before any test has a folder of its own, and the folder is removed when the process exits.
*Cost:* a process that is killed leaves `scooter-vm-*` in the temporary folder. Rule 4 of section 2 of the plan has each test work in its own folder; this is one folder per test process instead.

### 2.2 The reviews of milestones 0 and 1

Both pull requests were approved with smaller points listed. Each is below, with what became of it.

The review of milestone 0 (pull request 1):

| # | Point | What became of it |
|---|---|---|
| 1 | DESIGN.md still lists as open what milestone 0 settled, and says `anthropic/*` models go to the messages route | Settled. 5.1, 6.6, 6.12, 6.13, 13.2 and 14 of DESIGN.md, and 3.5 of ARCHITECTURE.md, now say what milestone 0 found (2.3) |
| 2 | The image's contents leave out `tzdata` and `curl` | Settled. Both documents list them, with the reason (D7) |
| 3 | wacli warns about sends closer than 5 seconds | Settled by the owner before this milestone ("Between milestones 1 and 2"). The related fact: `send text` and `send react` have `--post-send-wait`, default 2 seconds, which keeps wacli's connection open after a send, seen in the installed binary's help on 2026-11-16. Milestone 5's pacing will meet it; not run, since sending needs a paired number |
| 4 | A fact about Gondolin that pi 6 rests on isn't written down | Settled. In 0.5, "Also found about Gondolin 0.14.0", as the review found it. Not run again |
| 5 | `test/support/vm.mjs` makes a folder outside the test's own | Settled by recording the choice (D53) |
| 6 | Three findings seen by hand and held by no test | Two settled: pi 5 asserts a 429, and VM 4 that a killed VM's entry in Gondolin's list stays behind. Both pass with KVM. Left: the 2-minute default start limit, which would add 2 minutes to every run of the VM tests |
| 7 | Milestone 4 doesn't say the sandbox's mounts carry what is hidden | Settled. A rule under milestone 4 in the plan |

The review of milestone 1 (pull request 2):

| # | Point | What became of it |
|---|---|---|
| 1 | A timeout doesn't bound `run` when a descendant keeps the output open | Settled (D51), with a test |
| 2 | The advice on the store's owner is easy to follow wrongly | Settled. `main.mjs` gives the store `{ uid: 0, gid: <scooter-runner's gid> }` (D49), and this milestone's pull request says so |
| 3 | `SCOOTER_TZ` accepts names pi's VM may not resolve | Settled another way. The review's suggestion, `resolvedOptions().timeZone`, turns `Asia/Kolkata` into `Asia/Calcutta` in Node 22: ICU's own name, which Ubuntu's zone files lack without `tzdata-legacy`, and which the owner would then see in prompts. Instead a zone must be written as the tz database writes it, each part beginning with a capital letter: every zone Node lists, and every zone file on the Linux machine, passes, and lowercase slips and offsets such as `+05:30` don't. Left: a name wrong in its later letters, such as `Asia/KOLKATA`, still passes; milestone 7 can look the zone up in the VM's image |
| 4 | D29 says a `seq` out of order names the file and the line, and it didn't | Settled. The reader gives each line's number, and the store's error names the file and the line |
| 5 | An edit or deletion can point at a line that isn't a message | Settled in both places: the store refuses it, and intake skips it first (D38) |
| 6 | `subject` is optional on an email's line | Settled. `checkLine` requires it on an email's message |
| 7 | An attachment left by a crash can stay beside a line it doesn't belong to | Settled. At startup the store removes, from the newest day folder, attachments whose `seq` is past the last line's |
| 8 | Nothing stops a second writer | Settled (D48) |
| — | An empty, untracked folder named `2026-11-09T20:30:00Z` in the working copy on the Linux machine | Removed. No test makes it: fresh clones stayed clean after every run. It was made during milestone 1's work, before its commits; the name is a time from the test of the process's time zone in `datastore.test.mjs` |

### 2.3 Changes to DESIGN.md

None changes what Scooter does. Each brings a statement up to date with what milestone 0 found:
- 5.1: wacli 0.26.0 takes the webhook secret only on its command line (0.6, wacli 1).
- 6.6: the list of "things to check in the pinned pi version" is now what was found, each with its check.
- 6.12: the image's contents include `tzdata` and `curl` (D7), and pi works without its install scripts (pi 8).
- 6.13 and 13.2: pi sends Anthropic's models to the messages route, except their `:batch` variants, and the exact fields are in `test/fixtures/pi-requests/` (pi 6).
- 14: a line names the five items milestone 0 settled, and each is marked "Checked".

ARCHITECTURE.md has the same in 2.7 and 3.5, and the plan has a new rule under milestone 4.

### 2.4 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-16, on the Linux machine, from a clean clone of the branch:

| Command | Result |
|---|---|
| `npm ci && npm test`, Node 22.23.2 | 219 tests: 194 pass, none fail. 25 skip themselves: the 18 that need the image and the 7 that need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 212 pass, none fail, in 111 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie`, with `SCOOTER_ROOT_TESTS=1`, on a second fresh clone | Node 24.22.3: 195 pass, none fail. All 7 root tests run, among them the one where wacli runs as another user. 24 skip themselves: 18 need the image, 4 need wacli, 1 is about a file root can read anyway, and `scooter bridge` as a process, which as root needs the users `setup` makes |
| `intake`, `whatsapp`, `bridge` and `proc` tests, 16 times, 8 at once | No failure. The test of `scooter bridge` as a process skipped itself when another copy held the port |

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Where |
|---|---|
| Signatures accepted and rejected | `whatsapp.test.mjs`: the function, and the webhook through the stub; `bridge.test.mjs` end to end |
| Filtering of non-owners, `@lid` owners, groups, `FromMe` messages, stickers and empty messages | `whatsapp.test.mjs`: the function, and through the webhook |
| Media downloads, including failures | `intake.test.mjs` with the fake channel: retries, the size limit, media without a file, a copy that fails; `whatsapp.test.mjs` with the stub: the command, failures, a link, a file saved elsewhere, a call that hangs |
| Replies, reactions, edits and deletions mapped to `seq` numbers | `intake.test.mjs`; `bridge.test.mjs` end to end |
| The same edit, deletion or reaction delivered twice is stored once | `intake.test.mjs`; `bridge.test.mjs`; catch-up in `whatsapp.test.mjs` |
| Commands logged | `intake.test.mjs`; `bridge.test.mjs` |
| Catch-up after a gap, without duplicates, from the newest incoming WhatsApp line even when emails arrived; no history on the first start | `whatsapp.test.mjs` |
| Least privilege, for wacli's environment and command line | `whatsapp.test.mjs`: exactly six variables on every call, no setting's secret anywhere, the webhook's secret on sync's command line alone; as root, every call as wacli's user, and its folders its own |

The milestone's "done when", signed webhook posts ending up as the right lines and attachments and unsigned ones not, is the first test in `bridge.test.mjs`. It posts through the stub's running sync, and reads `log.jsonl` and the day folder.

Not verified:
- **wacli when paired** (gate G4). The tests run a stub. How a real edit, deletion, `@lid` sender and list row look is read from wacli's source (D42), and so is the likelihood, added in milestone 3, that the owner's own deletion arrives with `FromMe: true` and the bot's JID as `Chat`. So is how `media download` behaves while sync runs, and `messages list --read-only` alongside it. A correction belongs in `fromWebhook` or `fromListRow`.
- **The real wacli in this milestone's tests.** Milestone 0's checks run the installed wacli, unpaired. Nothing here does.
- **The webhook against the real wacli's HTTP client.** The stub posts with Node's.
- **arm64 and macOS.** Nothing here knows the architecture. Unix sockets, `O_NOFOLLOW` and `mkfifo` exist on macOS.
- **The bridge under systemd or Compose.** Milestones 12 and 13.

## Milestone 3: runner, planning

Done on 2026-11-16, on the Linux machine of section 3 of the plan. Nothing went to the owner: every open point below was settled by rule 3 of section 2 of the plan, the simplest option that keeps the principles. Section 2 of DESIGN.md is unchanged. DESIGN.md changed in one sentence of 6.3, where it contradicted 5.4 and 6.5 (D65).

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

It also settled the smaller points of the review of milestone 2 (3.3).

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
*Reason:* 8.6 wants a range for a number the owner sets. The low end keeps a run from being cut off before pi starts; the high end is a slip of the hand, and also how long a backup can wait (5.5).

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
*Question:* 6.3 said commands are context that "the agent is shown"; 5.4 says commands are "never given to the agent", and 6.5's context is the `out` lines and reactions.
*Choice:* 5.4 and 6.5. The cursor moves past a command, and the prompt never shows one. 6.3 of DESIGN.md now says so.

**D66. What comes first.**
*Choice:* commands; then nothing while paused; then `once` tasks; then new messages, once the owner is quiet; then a due scheduled task; then a backfill batch. A scheduled task waits for messages that are ready, and doesn't wait for messages still in their quiet period.
*Reason:* 6.4 runs `once` tasks at startup. Messages first, because the evening check-in reports what was filed. The backfill comes last by 6.11.

**D67. Scheduled tasks.**
*Choice:* `scheduled[at]` is the owner's date of the last occurrence that has been dealt with.
- **At startup**, every occurrence up to now counts as dealt with: `scheduled[at]` becomes the date of the last one, worked out in the zone the runner starts with. So a runner that starts after the time waits until the next day (6.4), and a changed `SCOOTER_TZ` takes effect at once. Entries for `at` values no longer in the config are dropped.
- **While running**, a task is due when its last occurrence has a later date than `scheduled[at]`. One that comes due during a run or a pause is still due afterwards, and several that passed during a long pause run once.
- The runner records the date once the task has run (milestone 4). A task that fails on a setup error or an outage keeps its old date, so it stays due (the plan's rule for milestone 4).
- `previousLocalTime` in `time.mjs` finds the last occurrence, by the same rule as `nextLocalTime` (D21): a time skipped by the clocks comes due at the jump, and a time that comes twice at its first.
*Reason:* a date per task is what 6.3 stores, and comparing dates of the owner's day keeps one run a day across clock changes. Overwriting at startup instead of keeping the larger date lets a changed zone start from where it is: a date from a zone far ahead would otherwise hold the task back for up to two days. *Cost:* on the day the zone changes, a task can run twice or not at all.

**D68. `once` tasks.**
*Choice:* the runner keeps in memory which `once` tasks it has tried since it started, and `nextAction` takes that set. A task is offered when it is in neither `onceDone` nor that set. Milestone 4 adds a task to `onceDone` after it succeeds, and leaves it out of the set after a setup error or an outage, so it is the next try.

**D69. Backfills at startup, and when one is done.**
*Choice:* a new backfill starts with `until` the live cursor, its own cursor at 0, and empty lists (6.11). One whose entry left the config is dropped at startup. `nextAction` offers a backfill batch when it has work items in `(cursor, until]` or due retries and nothing live waits; and says `backfill-finished` when it has neither work up to `until` nor retries. Building a backfill's batch, and finishing it, are milestone 9's.

**D70. The batch.**
- **Covered:** a batch covers the lines up to the first work item it leaves for later, or up to the newest line. When the run succeeds the cursor moves there (6.8), past the context, the commands and the lines of sources the agent doesn't read in that stretch.
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

**D76. The outbox entry's format, and its writer, are in `src/common/outbox.mjs` now.**
*Question:* the plan builds the writer in milestone 4, and this milestone's rule writes the reply to `/new` to the outbox.
*Choice:* `checkOutboxEntry` is 5.3's format as code, as `checkLine` is for lines (D27), and `writeOutboxEntry` writes one through `handOff`. The outbox folder is made 0700 when missing, as in development; `setup` makes it in an install (milestone 12).

**D77. The protocol says a little more than 7.1.**
*Choice:* besides each point of 7.1, `protocol.md` says how the prompt shows things (the three sections, `(edited in …)`, `(deleted in …)`, JSON strings, cut texts, who `Scooter` is), that a scheduled task has no items to report on, and that the agent writes no links and no dotfiles. Milestone 11 checks it against the parser.

### 3.2 Facts found

- **YAML.** `yaml` 2.9.1 with `version: '1.2'` and `schema: 'core'` reads `09:05` as a string, `on` as a key, and `010` as 10. A duplicate key is an error, and an unknown tag a warning that the config turns into a fault.
- **A schedule's last occurrence** agrees with the next: for six zones (Kolkata, New York, London, Lord Howe, Apia and St John's), six schedules and 20 days around each of three dates with clock changes, nothing comes due between `previousLocalTime(now)` and `now`. A test holds it.

### 3.3 The review of milestone 2

The pull request was approved with seven smaller points. Each is below, with what became of it. The points of the reviews of milestones 0 and 1 that milestone 2 left (2.2) stay as they were: the 2-minute start limit of the VM tests, and zone names wrong in their later letters, for milestone 7.

| # | Point | What became of it |
|---|---|---|
| 1 | By wacli's source, the owner's own deletion arrives with `FromMe: true` and the bot's JID as `Chat`, and is dropped | Settled by recording it, as the review proposed. D42 and the list of what wasn't verified (2.4) say it, gate G4 in the plan now checks `FromMe` and `Chat` on a real edit and deletion, and a comment at `fromWebhook` says where the correction goes. The code is unchanged: the behavior is read from source, and the plan leaves wacli's formats to G4 |
| 2 | The stub's helper reads a status file the stub writes in place | Settled. The stub writes it under another name and renames it |
| 3 | Stopping the bridge waits for the wacli calls in progress, up to `WACLI_CALL_TIMEOUT` for each of three tries | Left for milestone 10, recorded here. A stop waits for every wacli call in progress, and the channel's `stop()` returns while intake may still hold records. Milestone 10, which stops the channels before each backup, must await `intake.idle()` after stopping them, and should pass a stop signal to wacli's calls (`proc.run` takes one), dropping a record whose download a stop cut short so that catch-up brings it back, instead of storing it as `download failed`. It is left because it changes what a stop does to a record, which is the backup's question, and nothing stops the channels before milestone 10 but a shutdown, which systemd ends after 90 seconds and the store survives |
| 4 | Catch-up doesn't end if wacli answers a full page that isn't after `--after` | Settled. A full page whose last row isn't after the time asked for ends the catch-up, with a warning. A test has the stub answer the same page whatever it is asked |
| 5 | wacli's staging folder is never emptied, and a folder in a download's place isn't removed | Settled. The channel empties `wacli/staging/` when it starts, folders included, and removes whatever is at a download's path. A test leaves a file, a folder and a link there |
| 6 | D42 says more than catch-up can do for a missed edit | Settled. D42 now says that a missed edit is listed only while catch-up reaches its message, and that an older row handled after a newer edit puts the older text back |
| 7 | Smaller still: a test counts any connection error as a 413; a test compares the port with itself; failed wacli calls log no reason; `bridge.first_start` logs `at`, a reserved name | All settled. The test accepts a 413 or a reset connection, and checks the log's two refusals. `whatsapp.started` logs the address the server listens on, and the test checks it is `127.0.0.1`. `errorFields` adds a program's exit code and whether it timed out, so `whatsapp.catchup_failed` and `intake.download_failed` say why; a test checks one. `bridge.first_start` logs `firstStart` |

### 3.4 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-16, on the Linux machine, from clean clones of the branch:

| Command | Result |
|---|---|
| `npm ci && npm test`, Node 22.23.2 | 277 tests: 252 pass, none fail. 25 skip themselves: the 18 that need the image and the 7 that need root |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | 270 pass, none fail, in 111 seconds. The 7 root tests skip themselves. No QEMU left |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie`, with `SCOOTER_ROOT_TESTS=1`, on a second clone | Node 24.22.3: 253 pass, none fail. All 7 root tests run. 24 skip themselves: 18 need the image, 4 need wacli, 1 is about a file root can read anyway, and `scooter bridge` as a process, which as root needs the users `setup` makes |
| The `intake`, `whatsapp`, `bridge` and `proc` tests, 64 times, 8 at once | No failure. The review of milestone 2 saw one in 64 before the stub's fix (3.3, point 2) |
| This milestone's tests, with `time` and `datastore`, 32 times, 8 at once | No failure |

The tests section 10 of DESIGN.md asks of this milestone, and where they are:

| Required | Where |
|---|---|
| Runner: batching after the quiet period | `triggers.test.mjs`; `planning.test.mjs`, from files |
| Runner: the batch's two limits, 20 items and the prompt's size, with an over-long item shown cut | `batch.test.mjs`: 20 items with retries first; six of ten 15 KB messages; one item cut, pointing at its line or its `.eml`; the oldest context left out; 40 random batches within a small limit; the last resort |
| Runner: context lines and reply labels | `batch.test.mjs`: you, the owner and Scooter; a reply to a photo, to a deleted message, and to a message Scooter doesn't have; forwarded; reactions and a removed one; commands not shown |
| Runner: emails in the prompt | `batch.test.mjs`: the email of 4.2 as 6.5 shows it, one that couldn't be read |
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
- **The stop of point 3 above.** Left for milestone 10.
- **wacli when paired**, for the points of 3.3: gate G4.
- **arm64 and macOS.** Nothing here knows the architecture. `O_NOFOLLOW`, `mkfifo` and git's `-c` options exist on macOS.
