# Notes for coding agents

## What Scooter is

Scooter keeps a log of its owner's life from what they send it: receipts, run screenshots, food photos, tickets and short notes, sent on WhatsApp to a number of its own, the bot, or emailed to a mailbox of its own. Two services share a data folder on one Linux machine. The bridge talks to WhatsApp and the mailbox, keeps every message in an append-only datastore, sends the replies and makes the backups. The runner gives new messages to an AI agent, pi, by their numbers, in a fresh VM for every batch, which can see and change only what the agent's configuration names. The agent reads each message with `show`, files it in spreadsheets, and says what became of it with `mark` and what to tell the owner with `send`; once the run has passed, the runner commits the spreadsheets and acts on the marks and the messages. It is written in Node.js, as ES modules in `.mjs` files.

## The documents, and the order to read them

1. This file.
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), whole: what Scooter does, the map of its components with their documents and files, the boundaries, the contracts, the glossary, and what to look at for each kind of change.
3. The document of the component you change, in `docs/architecture/`, which the map names, and that of any component whose contract you touch.

[`README.md`](README.md) is the operator's guide: installing, running, the known limits, and what was never run for real. `docs/plans/active/` holds the plans of work in progress; `docs/plans/completed/` is the record of earlier work, left as it was.

## Running it, and checking a change

The README's [Development](README.md#development) section says how to run the code and its tests as an ordinary user, the three ways the suite runs, what each needs, and why tests skip in each.

## The conventions of the code

The rules of [The code's layers](docs/ARCHITECTURE.md#the-codes-layers), [Running programs](docs/architecture/shared-code.md#running-programs), [Logging](docs/architecture/shared-code.md#logging), [Time](docs/architecture/shared-code.md#time) and [Constants](docs/architecture/configuration.md#constants) hold for every change, in every component. Besides them:

- **Keep macOS cheap to add** ([Deferred and out of scope](docs/ARCHITECTURE.md#deferred-and-out-of-scope)). Don't depend on what only Linux has: no `/proc`, no `fs.watch` (poll instead), and no GNU-only flags of a program, such as `sed -i`, `date -d`, `stat -c` or `readlink -f`. Never make two files whose names differ only in case, which macOS's file systems usually don't tell apart. The suite needn't pass on a Mac until macOS is built.
- **An invisible character,** such as the byte-order mark, is written in code as its escape, `\uFEFF`, never as itself.
- **Tests** use `node:test`, in files named `*.test.mjs`, which are all `npm test` runs. So the helpers in `test/support/`, the capture script in `test/tools/` and the live checks in `test/live/`, which are run by hand, never run with the suite.
  - A test uses no real credentials and no network. It works in a folder of its own, with `TMPDIR` inside it, which restic needs (`makeTestDir`, in `test/support/tmp.mjs`).
  - Time comes from the clock that code is given, which a test fakes ([Time](docs/architecture/shared-code.md#time)), and a test changes a constant only through `overrideLimits` ([Constants](docs/architecture/configuration.md#constants)).
  - The services run in the tests in-process, with the fake clock and paths of their own, or as real processes, against folders that stand for the data folder and the config folder.
  - Outside programs are stood in for by stubs and fakes, each described with its component: wacli's ([Running wacli](docs/architecture/whatsapp.md#running-wacli)), restic's ([Running restic](docs/architecture/backups.md#running-restic)), the fake sandbox and pi's, which marks and sends through the run's own `mark` and `send` as the agent does, and the fake model, which stands in for the model behind OpenRouter where the real pi runs ([The sandbox interface](docs/architecture/sandbox.md#the-sandbox-interface)), and the fake mailbox ([The email reader](docs/architecture/email.md#the-email-reader)).
  - A test that needs root, to give files away or to run a program as another user, runs whenever the suite runs as root, with made-up numeric IDs, which need no user to exist. A test that creates users runs only with `SCOOTER_ROOT_TESTS=1` as well, so running the suite as root on a real machine creates none. Without root, switching users and setting owners are skipped ([Running programs](docs/architecture/shared-code.md#running-programs)), and tests cover both paths where they can.
  - What needs root or a hypervisor is tested as decisions, such as which users, modes, mounts and settings are used, in the plain run, and for real in the runs as root and with the VM image.
  - A test that can't run where it is, for want of root, the VM image, QEMU or an outside program, skips itself and says why. The runner's tests that use git don't: the suite needs git wherever it runs, as it needs Node ([Development](README.md#development)).
  - A fact about an outside tool that the code relies on is a test in `test/tools/` where it can be: it asserts what was found, and skips itself where it can't run, so that it fails when the fact changes. Run those again after upgrading the tool.

## What "done" means

A change is done when:

- `npm test` passes from a clean checkout, after `npm ci`, and so do the run with the VM image and the run as root wherever the change reaches what only they run ([Development](README.md#development));
- its tests exist, and cover its cases, the failures among them;
- the documents say what the code now does. Each rule it adds or changes is in its component's document, once, with the reason beside it where it needs one. A choice the documents didn't settle goes beside the rule it settles, with its reason. A decision of the owner's is written as the rule it settles, with its reason where it needs one, so that the text around it stays coherent: the documents don't say that the owner decided it, or when. Those two facts go in the pull request or the issue, in its description or a comment. A contract changed is changed on both sides, and in the frame's table of contracts. The README follows what the owner sees and does. No link leads nowhere;
- its description says what was run to verify it, with the results, and what wasn't verified.

## When to stop and ask the owner

When the documents don't settle a question, pick the simplest option that keeps [the principles](docs/ARCHITECTURE.md#what-scooter-does). Stop and ask the owner instead:

- before changing anything among [the owner's fixed choices](docs/ARCHITECTURE.md#the-owners-fixed-choices);
- when a question is ambiguous, or is an open decision that the documents and the principles don't settle;
- when two documents disagree, or a document disagrees with the code, and you can't tell which is in force;
- where a document says to, such as when a fact a rule rests on turns out not to hold;
- when a check needs root on the owner's machine, the owner's phone, accounts or keys: don't work around it. The README's [Check on the first real run](README.md#check-on-the-first-real-run) lists what waits for the owner.
- when a fault is one of a kind, and closing the kind at its root is a large change, or one the plan doesn't name. Ask whether to fix it at the root, or to write the cases down as costs.
- when a review finds that everything to fix before merging is documentation, in a document or in the pull request's description, and nothing in the code or its tests. The reviewer posts its review, and then stops and shows the owner each point, with the text at fault and the text that would settle it, instead of sending the pull request back to be fixed. Whoever runs the work does the same when such a review comes back.

## For work that runs from a plan

Read [`docs/plans/roles.md`](docs/plans/roles.md) first: the rules for the planner, the implementer, the reviewer, the fixer and the orchestrator. Read its part for every role, and then your own.

## Commits and pull requests

- Don't add a `Co-Authored-By: Claude …` trailer to commit messages.
- Don't add a "Generated with Claude Code" line to pull request descriptions.
