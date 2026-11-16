# Decisions

This file records what was decided while building Scooter v2, where `docs/DESIGN.md` and `docs/ARCHITECTURE.md` left something open, and what each check of the tools found. Each entry gives the question, the choice and the reason. Numbers in parentheses, such as (6.6), are sections of DESIGN.md. "Row 8" is row 8 of the table in section 8 of ARCHITECTURE.md. "The plan" is `docs/plans/active/v2-linux-implementation.md`.

## Milestone 0: check the tools

Done on 2026-11-16, on the Linux machine of section 3 of the plan. No product code was written. What the milestone left in the repository:

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
- The fixtures of pi 6 are written by a script, run by hand: `SCOOTER_TEST_IMAGE=… node test/tools/capture-pi-requests.mjs`. Running it again changed nothing in them.
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
*Ran:* the mounts of 6.6 at the paths the folders have on the host, with Gondolin's mount point moved to `/run/gondolin-vfs`: the agent's folder read-only, `views/`, `memory/` and `run/session/` writable, the datastore read-only. Then the same with the folders under `/data`, as in Docker. Then under `/data` with Gondolin's default mount point. Then with `sessions/` hidden by Gondolin's `ShadowProvider`.
*Found:*
- Reading works everywhere under the two mounts. Every change to the agent's folder or the datastore fails with "Read-only file system": creating, overwriting, appending, deleting, `mkdir`, `chmod`.
- The three writable folders take files, and the host sees them at once. `run/session/`, two levels down inside the read-only `run/`, works like the other two.
- Nothing else from the host is in the VM. The folders above the mounts hold only what leads to them.
- Gondolin shows every mount a second time under its own mount point, with the same protection.
- With the default mount point, `/data`, and mounts under `/data`, the VM doesn't start. `start()` fails after Gondolin's 2-minute limit.
- The whole agent's folder is readable in the VM, `sessions/`, `state.json` and `.git` included.
- `ShadowProvider` hides a path inside a mount. With `/sessions` hidden, the folder isn't there for the VM, under Gondolin's own mount point either, and can't be made anew.

*So:*
- 6.6 and row 14 stand: the runner always moves Gondolin's mount point. `/run/gondolin-vfs` works. `/run` is a temporary file system that Gondolin's own boot sets up.
- 6.6 also says pi never sees `sessions/`. With the mounts as 6.6 lists them, pi can read it. See 0.8, question 2.

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
*Ran:* `--help` for `sync`, `auth`, `auth status`, `messages list`, `media download`, `send text`, `send file` and `send react`, and `messages list` against an empty store.
*Found:* every command and flag of 13.1 exists as written, with the defaults it gives. Three more things matter to later milestones:
- **`send text` fetches the first URL in the text,** to send a link preview with it, unless `--no-preview` is given. wacli's `docs/send.md` says so, its source does it (`fetchLinkPreview` in `cmd/wacli/send.go`), and the flag is in the help. This wasn't run: sending needs a paired number. See 0.8, question 1.
- `messages list --json` answers `{"messages": …, "page": {"has_more": …, "next_cursor": …}, …}` inside `data`, and `messages` is `null`, not an empty list, when there are none. With `--read-only` it fails when the store doesn't exist yet.
- By its source, wacli prints a warning on stderr when two sends are less than 5 seconds apart, and still succeeds. `SEND_INTERVAL` is 1.5 seconds, so the bridge will see that warning often. This wasn't run: sending needs a paired number.

*So:* milestones 2 and 5 can use the commands of 13.1 as they stand, with `--no-preview` if the owner agrees (0.8), and must treat a `null` list as empty.

### 0.7 What was run to verify the milestone, and what wasn't verified

Run on 2026-11-16, from a clean checkout of the branch after `npm ci`:

| Command | Result |
|---|---|
| `npm test`, with no image | 14 tests pass: the fake model, the fixtures and the wacli checks. The 18 pi and VM tests skip themselves |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image sg kvm -c 'npm test'` | All 32 pass, with KVM, in about a minute and a half |
| `SCOOTER_TEST_IMAGE=~/ww/scooter-scratch/image npm test` | All 32 pass, under emulation, in about seven minutes |
| The root-test command of section 3 of the plan: as root, in `node:24-trixie` | The 10 tests that need neither a VM nor wacli pass, on Node 24.22.3. The container has no QEMU and no wacli, so the other 22 skip themselves |

Not verified:
- **arm64.** The machine can't run it. The build file names no architecture, and the helpers take the machine's own.
- **The real OpenRouter.** The tests send it nothing. Two requests were made by hand on 2026-11-16, with a dummy key, to see its 401 answers, and the fake model's 401 answers are copies of those. The fake's answers to other statuses, and the streams it sends, follow the formats pi accepts, not a recording.
- **wacli when paired.** Sending, receiving, and the shape of a list row need the bot number (gate G4).
- **A native image build as root** (gate G2). Only the container build was run.

### 0.8 Questions for the owner

Two outcomes don't fit DESIGN.md as it stands. Neither stops milestones 1 to 4.

**1. wacli's link previews (5.3; before milestone 5).** DESIGN.md gives the send command as `wacli send text --to <owner chat> --message <chunk>`. By wacli's documentation and its source (0.6), run like that it fetches the first URL in the text, from any public host, to build a link preview. The text is the agent's. So a misled agent could make the bridge's side fetch a URL of its choosing, with data in it, while internet access is off, and the request would be in no log. That goes against 3.1, which lists the bridge's only outbound connections, and against principles 2 and 4.
*Proposed:* the bridge always passes `--no-preview`. The owner then sees links as plain text.

**2. Whether pi may read `sessions/` (6.6; before milestone 7).** 6.6 says "pi never sees `sessions/`", and 6.2 that pi only gets a copy of the current session. The mounts 6.6 lists make the whole agent's folder readable in the VM, `sessions/` included. pi can't change it either way.
*Proposed:* hide `sessions/` from the VM with Gondolin's `ShadowProvider`, which works (VM 1). The other choice is to leave it readable and correct the sentence: the old sessions hold nothing the datastore and the views don't.
