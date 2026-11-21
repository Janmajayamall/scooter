# Scooter's documents: one place for each fact

Status: completed. Written 2026-11-20 from the owner's brief. Pieces 1 to 4 were merged by 2026-11-21, as pull requests 19 to 22, and the plan moved to this folder on 2026-11-21. The workflow [`docs-restructure.workflow.js`](docs-restructure.workflow.js), beside this plan, ran it.

Every agent of this work is new, remembers nothing, and starts here. Read this plan whole. Your prompt gives your role, implementer, reviewer or fixer, and a piece's number. [How the work runs](#how-the-work-runs) says what each role does, the piece's own heading says what the piece covers, and [This machine](#this-machine) says how to run things here.

## Why

Scooter was built in 15 milestones by implementing and reviewing agents. A study of their transcripts found that the documents are the heaviest load on anyone starting work:

- The four documents every agent was told to read come to 843,000 characters, more than the whole source tree at 721,000. `docs/DECISIONS.md` alone is 538,000, of which the reasons for decisions are about 59,000.
- A fresh agent that read them for a real task needed about 10% of what it read.
- `docs/ARCHITECTURE.md` and `docs/DESIGN.md` describe the same components at two levels of detail, and `docs/DECISIONS.md` states most rules a third time. 14 of the 15 pull requests drew a review point about a line that no longer matched the code.

## The layout to build

Made for a new hire who must get oriented fast. Each fact is stated in one place.

- `AGENTS.md`: the entry point. About 8,000 characters. Written in piece 3.
- `docs/ARCHITECTURE.md`: what belongs to no single component. About 50,000 characters at most, so that it can be read whole. Written in piece 1, and completed by pieces 2 and 3.
  - What Scooter does, and the path of one message from WhatsApp to a filed view and a reply.
  - The map: each component, the link to its document, and its files. Every file under `src/` belongs to one component.
  - The boundaries: trust, the processes and the users they run as, the folders and their owners, the network, the secrets.
  - The contracts between components, each with the one module that defines it.
  - A glossary of the project's own names, each used one way.
  - A table, "To change X, look here": the common kinds of change, each with the modules, tests and documents it touches.
  - The owner's fixed choices (section 2 of `docs/DESIGN.md` today), marked as not to be changed without asking the owner.
  - What is deferred or out of scope, and the reasons for how the system is structured.
- `docs/architecture/<component>.md`: one for each component. What it is responsible for, its files, its exact rules, the reason beside each rule that needs one, and the facts about outside tools that it relies on.
- `README.md`: stays the operator's guide. It keeps the one list of known limits and of what was never run for real.
- `docs/DESIGN.md` and `docs/DECISIONS.md` are removed once their content has moved, in piece 3.

The new documents have no section numbers and no decision numbers. Headings have names, and one document refers to another by a Markdown link to the file and the heading. The glossary's names are used one way in every new document.

### Components

Follow section 2 of today's `docs/ARCHITECTURE.md`. The starting list, by the piece that writes each document:

| Piece | Components |
|---|---|
| 1 | the datastore, the bridge, the WhatsApp channel, the email channel, delivery, backups |
| 2 | the runner, rebuild and backfill, the sandbox and the VM image, the network policy, the agent and its instructions |
| 3 | configuration and the CLI, install (native and Docker) |

Merge two small ones, or split one over about 40,000 characters, where that reads better, and say so in the pull request.

Section 2 of today's `docs/ARCHITECTURE.md` also has the exchange, the agent's folder and shared code (`src/common/`), which the starting list doesn't name. Piece 1 gives each a home, as part of a component or as a component of its own in the piece of the component it is closest to, and says which in its pull request. Piece 1 also chooses the file name of every component's document, and the map lists them all. From then on the map decides which piece moves what: pieces 2 and 3 follow it, and a piece that changes it says why in its pull request.

In the map, each file is listed by its path from the repository's root, in backticks, so that the check by script can find it. A component's document lists the same files as the map.

A link to the document of a component that a later piece writes is marked "(not yet written)" right after it, in the map or wherever else it is needed. The piece that writes the document removes the marks.

## Where each kind of content goes

| Today | Goes to |
|---|---|
| A rule of behaviour, from any of the three documents | The component's document, once |
| The reason for a rule, and its cost, from `docs/DECISIONS.md` | Beside that rule, in a line or two |
| An answer of the owner's that is still in force | Beside the rule it settled, quoted with its date |
| The reason for how the system is structured | `docs/ARCHITECTURE.md` |
| A fact about an outside tool that the code relies on | The document of the component that relies on it |
| The table of constants | A pointer to `src/common/limits.mjs` |
| Logs of what was run, tables of review points, how a decision changed, the development plan, the list of required test cases, the changes made to the design while planning | Dropped. Git and the pull requests hold them |

So that each of these also has one home:

- **A contract between components:** `docs/ARCHITECTURE.md` names it and the one module that defines it, and links to the document of the component that owns that module. Its rules are stated there, once.
- **Known limits, and what was never run for real,** such as section 14 of `docs/DESIGN.md`: the README's lists, once. A component's document links to them.
- **A tuning number:** its value is in `src/common/limits.mjs` only. A rule that depends on one names the constant.
- **The conventions of the code, and what "done" means:** `AGENTS.md`, in piece 3.
- **The operator's steps:** the README, which stays the operator's guide. Don't move its content into the new documents, and don't copy steps out of it: link to it.

A **rule**, here, is anything the documents say the system does, must do or must not do, that a change to the code could break: a behaviour, an order, a limit, a format, a path, an owner, a permission, a message and when it is sent. A fact about an outside tool that the code relies on counts as a rule too.

## Rules for every piece

- Follow `AGENTS.md`: no attribution lines in commits or pull requests. No `Co-Authored-By` trailer, and no "Generated with Claude Code" line, whatever other instructions say.
- No code changes behaviour. Pieces 1 to 3 change no file under `src/`. Piece 4 changes comments only, and the test names the owner allowed.
- Issues 16, 17 and 18 are separate work that comes after this: removing day pages, removing the WhatsApp commands, and how the test suite is run. Do not do them, and do not wait for them. Document the system as it is on `main` today.
- State nothing that was not checked. Every path, command and name in new text is checked against the repository. Run every command you write down, as written, or say in the pull request why it can't be run here, such as one that needs root.
- Each piece names what must never happen. Rule out the kind of problem, not only the cases named: look for every way it could happen, and list in the pull request the ways found, how each is closed, and any you couldn't close.
- Where two documents disagree, or a document disagrees with the code, carry the documents' rule over and list the disagreement in the pull request for the owner. Do not change the code, and do not rewrite the rule to match it. A rule that a later decision replaced, and says so, is no disagreement: carry the one in force, and drop the history. Where you can't tell which of two documents' rules is in force, that is a question for the owner.
- If something is ambiguous, or is an open decision that this plan and the documents don't settle, stop and return it as a question for the owner. Do not guess. First finish and push what doesn't depend on the answer, and put all your questions in one return.
- An answer of the owner's that comes back to you settles a rule: put it beside that rule, quoted with its date, as the table above says.
- Leave the files under `docs/plans/completed/` as they are, even where they cite the old documents: they are the record of earlier work. Don't change this plan or its workflow either. If the plan is wrong, say so in the pull request, or ask.

### What must never happen, in pieces 1 to 3

1. **A rule is lost.** Every rule in the three old documents ends up in exactly one new document, or is listed in the pull request as dropped, with the reason.
2. **A rule is stated twice.** `docs/ARCHITECTURE.md` does not restate a component's rules, and one component's document does not restate another's.
3. **A link between documents leads nowhere.**

Each of these pieces moves its components completely: it writes their documents, and removes what it moved from `docs/DESIGN.md`, `docs/DECISIONS.md` and the old sections of `docs/ARCHITECTURE.md`. So after every merge, each rule has one home, in an old document or a new one.

These are the ways each could happen that are known so far. Look for every other way.

A rule is lost when:

- it sits in text that is dropped as history: a log of what was run, a table of review points, a milestone's list of decisions, a question and the owner's answer, a note of facts found;
- an earlier version is carried over and the one in force isn't, because a later decision, a change to `docs/DESIGN.md` or an answer of the owner's replaced it;
- only half of it is carried: one document states it, and another adds a condition, an exception or a limit;
- it is in a table, a list of environment variables, a code block or a note, rather than in prose;
- a section or a decision covers components of more than one piece, and this piece removes all of it while moving only its own part;
- it is about the boundary between two components, and each document leaves it to the other;
- it is cut while shortening a reason to a line or two, because the reason carried a condition.

A rule is stated twice when:

- its old text stays after it has moved;
- the path of a message, the boundaries, the contracts, the glossary or the table of changes in `docs/ARCHITECTURE.md` say it again, instead of linking to it;
- two components share a mechanism and each document describes it, such as a send, between delivery and the WhatsApp channel, or a lock, between backups and the runner;
- one reason, or one answer of the owner's, is written out beside two rules.

A link leads nowhere when:

- it names a heading that was renamed, or whose anchor GitHub builds differently from what was written: backticks, punctuation, apostrophes, a heading that appears twice;
- it leads to the document of a later piece without the mark "(not yet written)";
- text left in an old document cites by number, such as "(6.9)" or "D42", a part this piece moved. Change it into a link to the new home;
- the README, `AGENTS.md` or another document mentions a part that moved;
- a relative path is written as if from another folder, such as a link in `docs/architecture/` to `ARCHITECTURE.md` without `../`.

## The checks by script

Run by the implementer and repeated by the reviewer. They are reported in the pull request, and not added to the test suite. Put each script in the pull request's description, in a collapsed block, so that the reviewer and the later pieces can run it as it is. A later piece may improve a script, and says how.

- **Links.** Every Markdown link in `README.md`, `AGENTS.md` and `docs/`, outside `docs/plans/`, to a file of the repository leads to a file that exists and, where it names a heading, to a heading of that file, by the anchor GitHub makes for it: lower case, every character other than a letter, a digit, a space, `-` or `_` removed, spaces turned into `-`, and `-1`, `-2` and so on added to a heading that appears again. The links marked "(not yet written)" are listed apart. After piece 3 there are none.
- **The map.** Every file under `src/` (`git ls-files src`) is listed under exactly one component in the map of `docs/ARCHITECTURE.md`; every file the map lists exists; and each component document that exists lists the same files as the map. From piece 1 on.
- **Characters.** For each old and each new document: its characters on `main` and on the branch (`wc -m`, in a UTF-8 locale), and the characters in the lines the diff removes and adds. Then the totals removed from the old documents and added to the new ones. `docs/ARCHITECTURE.md` is both: give both figures for it.

## Piece 1: the frame, and the bridge's side

Branch `docs-piece-1`. Pull request title: "Docs piece 1: the frame, and the bridge's side".

- The new `docs/ARCHITECTURE.md`, as [laid out above](#the-layout-to-build), in place of the old one. Its map lists every component from the start, with a link to its document, marked "(not yet written)" where the document comes in a later piece. Its table of changes covers every common kind of change, with the same marks where needed.
- The documents for the datastore, the bridge, the WhatsApp channel, the email channel, delivery and backups, and for whatever else piece 1 gives to this piece.
- The text of the old `docs/ARCHITECTURE.md` that belongs to the components of pieces 2 and 3 stays at the end of the file, under the heading "Old text, still to be moved", unchanged except for references that would otherwise lead nowhere.

What must never happen: [the three rules of pieces 1 to 3](#what-must-never-happen-in-pieces-1-to-3). A rule is lost, a rule is stated twice, a link leads nowhere. In this piece, look hard at the frame: `docs/ARCHITECTURE.md` is where a component's rule is most easily said a second time.

The review checks: for at least 40 rules spread over the components moved and the frame, picked from the old documents on `main` (from all three, and including owner's answers and facts about outside tools in `docs/DECISIONS.md`), find each in the new documents, and confirm that the new document says all of it, once, and that its old text is gone. The list of what was dropped. The scripts. Then try to break each of the three rules beyond the sample.

## Piece 2: the runner's side

Branch `docs-piece-2`. Pull request title: "Docs piece 2: the runner's side".

- The documents for the runner, rebuild and backfill, the sandbox and the VM image, the network policy, and the agent and its instructions, and for whatever else the map gives to this piece.
- Their links lose the mark "(not yet written)", and what this piece moves leaves the old documents.

What must never happen: [the three rules of pieces 1 to 3](#what-must-never-happen-in-pieces-1-to-3). A rule is lost, a rule is stated twice, a link leads nowhere.

The review checks: as in piece 1, for at least 40 rules spread over this piece's components.

## Piece 3: the rest, and the entry point

Branch `docs-piece-3`. Pull request title: "Docs piece 3: the rest, and the entry point".

- The documents for configuration and the CLI, and for install, native and Docker, and for whatever else the map gives to this piece.
- Whatever is left in `docs/DESIGN.md` and `docs/DECISIONS.md` goes to its place by [the table above](#where-each-kind-of-content-goes), and so does the old text left in `docs/ARCHITECTURE.md`. Then both files are deleted, and `docs/ARCHITECTURE.md` is within about 50,000 characters.
- A test that reads a document being removed is changed so that it checks the code against the code, or is removed if the document was all it checked. List each one in the pull request. Known today: `test/instructions.test.mjs` reads `docs/DESIGN.md`, and `test/docker.test.mjs` reads `docs/DECISIONS.md`. Look for others.
- `AGENTS.md`, keeping its two rules on commits and pull requests word for word:
  - what Scooter is, in a few sentences;
  - the documents and the reading order: read this file and `docs/ARCHITECTURE.md`, then the document of the component you change;
  - how to run it and check a change, as a pointer to the README's Development section;
  - the conventions of the code and what "done" means. Today these are in section 2 of `docs/plans/completed/v2-linux-implementation/v2-linux-implementation.md`. Move them here, worded for the new layout: with no `docs/DECISIONS.md`, a new choice goes beside its rule, in the component's document. The completed plan stays as it is;
  - when to stop and ask the owner;
  - a pointer to `docs/plans/implementer-mistakes.md`, for whoever writes a plan.
- The README's Development section: for each of the three ways the suite is run, say what it needs and why tests skip in it. Issue 18 has today's numbers, from the development machine; this machine's differ, as [This machine](#this-machine) says. What the run with the image needs includes `GONDOLIN_CPU=max,sgx=off` where QEMU aborts as it does on this machine, for the reason given there. Update every mention of the removed documents in the README.

What must never happen: [the three rules of pieces 1 to 3](#what-must-never-happen-in-pieces-1-to-3), and a fourth:

4. **Something in `AGENTS.md` or `docs/ARCHITECTURE.md` is false or was not checked.** Every path, command and name in them exists as written, every command runs as written or says why it can't here, and what they say the code does, it does. Known ways: a name spelled differently from the code; a command never run; a count that was right once; a description carried from the old documents that the code no longer matches, which is listed as a disagreement, as the rules say.

The review checks: as in piece 1, for at least 40 rules spread over this piece's components and what was left. And every path, command and name in `AGENTS.md` and `docs/ARCHITECTURE.md`, against the repository, with every command that can run here run as written, and those of the README's Development section too.

## Piece 4: no numbers in the comments

Branch `docs-piece-4`. Pull request title: "Docs piece 4: no numbers in the comments".

Remove from the comments in `src/` and `test/` every citation of a section number, such as "(6.9)" or "5.2 step 7", and every decision number, such as "D136", along with mentions of the removed documents. About 575 comment lines cite a section and about 170 cite a decision. The same goes for every other way the old documents are cited by number, such as "row 15", "decision 43" of the old `ARCHITECTURE.md`, "section 12" or "13.4 of DESIGN.md". Mentions of the completed plan's milestones may stay.

The owner settled three more on 2026-11-20:

- "Yes, in piece 4": the comments in the `Dockerfile`, `compose.yaml`, `compose.kvm.yaml`, `compose.kvm-rootless.yaml`, `config/agents.yaml` and the two units in `deploy/systemd/` are cleaned the same way. 32 of their comment lines cited the old documents that day.
- "Test names too": the test names in `test/` that cite a number, such as "… (D229)", lose the number, which changes nothing a test checks. 22 were counted that day.
- The two messages in `src/` that cite a section stay as they are, and the pull request lists them: in `src/runner/config.mjs`, "(6.13)", and in `src/ops/setup.mjs`, "(8.5)".

How to write the comments:

- A comment must still read as a sentence afterwards. Where a comment was only a citation, either say in a few words what the code is doing there, or remove it.
- Where a comment restates a rule at length, shorten it to what the code needs said. The rule is in the component's document.

Must never happen: **the behaviour of the code changes.** Show it two ways:

1. The difference in every changed file touches comment lines only, and the test names above. A script checks it: it strips the comments, compares what is left with `main`, and lists each test name that changed, before and after. For JavaScript it uses a real parser, such as acorn installed in a scratch folder and never added to `package.json`, and compares the tokens or the syntax trees, not text with the comments cut out by a regular expression. For the YAML files, the `Dockerfile` and the systemd units, it compares the lines that aren't comments. Every other file is unchanged.
2. The whole suite passes, both runs in [This machine](#this-machine): the plain run, and the run with the VM image.

Known ways it could happen: an edit to code on a line that also holds a comment; text that looks like a comment but is inside a string, a template literal or a regular expression, such as a URL or a message; a comment that something reads, such as a test that reads a source file, or the first line of a script, `#!`; a comment removed from between two tokens where a line break matters to JavaScript, such as after `return`; a file that isn't code, such as `src/runner/protocol.md`, which is given to the agent, and so is behaviour; a message string in `src/`. Look for every other way.

The review checks: the script, run by the reviewer, and read to see that it checks what it claims. The suite, both runs. Fifty changed comments, spread over the files, read for sense.

## How the work runs

The workflow runs a piece through implement, review, fix and review again, for at most three reviews. An approved pull request is then merged into `main`, and the next piece starts from the new `main`. The workflow stops and returns to the owner on a question, on a pull request not approved after three reviews, on a merge that fails, and when an agent returns nothing. Every agent runs on Opus 5.5.

### The implementer

- Work on the piece's branch, cut from the latest `origin/main`, in the checkout at `~/scooter`. If the branch or its pull request exists already, read the pull request's description and comments and the branch's commits, and continue from there.
- Read the reviews on the pull requests already merged for this work, from the branches `docs-piece-1` to `docs-piece-4`. Settle the smaller points in them that are still open, and say in your pull request which you settled and which you left.
- Commit and push as you go, a component at a time, so that the work survives if you stop.
- Run the checks by script, and the suite, both runs. Then open the pull request against `main`, with the piece's title and [the description below](#the-pull-requests-description).
- If your prompt carries a question and the owner's answer, put both in the pull request's description, and go on from the answer.
- Keep your working notes in a scratch folder, not in the repository.

### The reviewer

- Check the pull request out exactly as pushed, in a clean clone in a scratch folder, and remove the clone afterwards. Change nothing: no commits, no pushes, no edits to the description.
- Do the piece's review checks. Repeat what the description claims: run its scripts and commands again, and recount its numbers.
- If the pull request already has reviews, check that each point in them was fixed, or answered with a good reason.
- Post the review as one comment on the pull request. List each problem that must be fixed before merging, with its file and line and what would settle it. Note smaller points separately. End with a line that reads `Verdict: approve` or `Verdict: changes requested`. Approve only when nothing must be fixed.

### The fixer

- Read the pull request's description and its comments. Fix what is right. Where you disagree, reply on the pull request with your reason, instead of changing it.
- Run again the checks and the runs that your changes touch, and bring the description up to date with them.
- Push to the same branch, and add a comment that lists what you changed.

### The pull request's description

- What the piece moved: its components, their documents, and any merge or split of components, with the reason.
- A table from each part of the old documents that the piece moved or dropped, to the document and heading it went to, or to "dropped" with the reason. A part is a section of `docs/DESIGN.md` or of the old `docs/ARCHITECTURE.md`, or a decision, a fact or an answer of the owner's in `docs/DECISIONS.md`. If the table doesn't fit, post the rest as comments, and link them.
- What was dropped, with the reason for each.
- For each rule of what must never happen: the ways found, how each is closed, and any not closed.
- Every disagreement found between two documents, or between a document and the code, for the owner.
- The checks by script, with their output, and the scripts.
- What was run, with the results: the suite, both runs, with the counts of tests, passes, failures and skips.
- What could not be verified.
- The smaller points of earlier reviews: which were settled, and which were left.
- Any question, and the owner's answer.

## This machine

- The owner's Linux machine, as the user `agentw`, in the checkout at `~/scooter`. Agents work one at a time. Never use `sudo`, and install nothing outside the home folder.
- Scratch clones and tools go in `~/scooter-scratch/<name>`, outside the repository, and are removed afterwards, from outside them: never from a shell working inside the folder.
- Node 26.13.1 is installed with fnm, in the home folder. A shell that doesn't find `node` needs this first: `export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"`.
- `gh` is signed in with the owner's account, and git commits carry the owner's name.
- The VM image is at `~/scooter-test-image`, built on 2026-11-20 from `main` at `ed645d8` with `node test/support/build-test-image.mjs ~/scooter-test-image`, under rootless Docker for `agentw`.
- The suite, in a checkout where `npm ci` has run:
  - **Plain:** `npm test`. On `main` at `ed645d8` it ran 775 tests: 720 passed, 0 failed and 55 skipped, in about a minute. 37 skipped for the VM image, 8 for root, 4 for root and `SCOOTER_ROOT_TESTS=1`, 4 for wacli and 2 for restic, which aren't installed here.
  - **With the VM image and KVM:** `SCOOTER_TEST_IMAGE="$HOME/scooter-test-image" GONDOLIN_CPU=max,sgx=off sg kvm -c 'npm test'`. `sg kvm` gives the run the `kvm` group, so that the VMs use KVM. On `main` at `ed645d8` it ran 777 tests: 759 passed, 0 failed and 18 skipped, the 8, 4, 4 and 2 above, in about 3 minutes.
- Why `GONDOLIN_CPU=max,sgx=off`: this machine's processor, an Intel i7-8665U, has SGX, and Ubuntu's QEMU 8.2.2 aborts (`PC_MACHINE: Object … is not an instance of type generic-pc-machine`) when it starts a `microvm` machine with `-cpu host` under KVM. That is what Gondolin 0.14.0 starts by default, and what the tests in `test/tools/vm.test.mjs` and `test/tools/pi.test.mjs` get: without the variable, 18 of them fail. Gondolin takes QEMU's `-cpu` from `GONDOLIN_CPU`, and `max,sgx=off` starts under KVM and under emulation alike, where `host,sgx=off` fails the test that forces emulation. Scooter's own sandbox uses the `q35` machine, and its tests passed with KVM without the variable. Without `sg kvm` the VMs run under emulation, and the same run passed in about 19 minutes.
- Never run two copies of the suite at once: the test that runs `scooter bridge` as a process takes port 8787, and skips itself when the port is taken (issue 18). When a test fails, run it again alone, and on `main`, before taking it for the change's fault. Report it either way, and leave flaky tests to issue 18.
