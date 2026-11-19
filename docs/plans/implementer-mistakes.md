# Mistakes an implementing model makes, and how a plan prevents them

## What this document is for, and how to update it

This document lists the kinds of mistake that an implementation agent is likely to make, for each model that has implemented work here, and what a plan can say to prevent each one. Read it before you write a plan that such an agent will build.

Each mistake has three parts:

- what the mistake is;
- what to put in the plan to prevent it;
- a few examples, each of which can be understood without any other document.

To update it:

- Add a mistake when a review, or real use, finds a problem that the plan could have prevented, and it is a kind of mistake, not a single slip.
- List it under the model that made it. It says nothing about another model until that model is seen to make it.
- Write each example so that it stands alone: what the work was, what the agent did, and what went wrong. Leave out pull request numbers, plan names and dates.
- Under "In the plan", say which steps have been seen to work and which haven't been tried.
- When a step fails to prevent a mistake, or a model stops making one, change the entry.

## Opus 5.5, at the `xhigh` effort level

### It designs for the cases it is given, not for the kind of problem

Given a case, by the plan or by a review, it handles that case well. It doesn't go from the case to the kind of problem behind it, and design so that no case of the kind can happen. It doesn't raise a kind of problem that nobody named, even when a rule for it was written down during earlier work.

Told to rule out a kind of problem, with the kind stated well, it does. It then goes through the kind and finds cases that nobody had named.

**In the plan.** All of these have been seen to work:

- Say what must never happen, as a rule in the part of the plan for that piece of work. For example: "Nothing the sandboxed agent does may stop the service that runs it."
- Name the cases you know, and say to look for every other. Ask for a list of the cases found, and of any that couldn't be closed.
- Don't give a list of cases without the rule. Only those cases get closed.
- Repeat the rule in every piece of work it applies to. A rule recorded in an earlier decision isn't carried over to new work.
- Have the review try to break the rule. Even with the rule stated, a review found one or two more cases.
- If reviews keep finding new cases of one kind, stop sending cases back. State the rule, and have that part designed again.

Kinds of problem that have needed such a rule:

- what a less trusted part can leave behind or send, such as the files of a sandboxed agent;
- a part with more rights acting on a path that a part with fewer rights controls;
- a resource running out: a full disk, a path too long, too many files;
- a stop, a crash or a lost delivery between two steps that belong together.

**Examples.**

1. A service ran a sandboxed agent, and then read the files the agent had left. A review showed that a file the agent had made unreadable stopped the service, and the implementer handled unreadable files. The next review showed that a file too large to commit in time stopped it too. Then it was too many file names, then a folder nested past the system's longest path, then a full disk. Each fix was right, and each review found the next case. Then the implementer was told to rule out the whole kind. One more review found two cases. The review after it went through every step that reads the agent's files and found none.
2. A process running as root emptied a folder that a less trusted user owned. A link put in the folder's place made it delete whatever the link led to. The fix was right, and the rule was written down: root removes nothing in a folder that another user controls, except by the names it knows. In the next piece of work the implementer had root build a disk image inside a folder that the same user controlled. A link swapped in during the build gave that user a folder of its choosing.
3. A plan listed three ways a misled agent could have the same work tried again for ever. The implementer closed all three. The review found a fourth, which the plan hadn't listed.
4. A plan said that catching up after downtime must never pass over a message that the messaging client holds and the store doesn't. It named two ways that could happen, and said to look for every other. The implementer closed both, found and closed three more, and reported one that it couldn't close.

### It states things it didn't check

Its account of its own work says more than it verified. It describes tests as reliable that fail now and then, documents commands that it never ran, and takes for granted how another program behaves.

**In the plan.**

- Asking for a list of what was run, with the results, isn't enough by itself. Every example below happened under a plan that asked for it.
- Have the review repeat what the description claims: run the tests many times and several at once, and run every documented command. Seen to work: this is how each example below was found.
- Where the work leans on how another program behaves, add a step that tries the program first and records what it did, before the code that depends on it. Seen to work: the examples below were all about behaviour that no such step had covered.
- For tests that involve timing or several processes, say how often to run them, and how many at once. Not tried yet.
- For documentation, ask that every command in it is run as written, and that a step which can't be run, such as one that needs root, says so. Not tried yet.

**Examples.**

1. A description said that the new tests had run 32 times without a failure. The reviewer ran the suite 33 times, and 3 runs failed. Two of the tests depended on timing.
2. An installation guide told the reader to rebuild an image at a point where a service was still running. The code refuses to build while that service runs, so the step failed as written.
3. Instructions for an agent said that `pdftoppm` names its page images `page-1.png`, `page-2.png` and so on. For a document of ten pages or more it writes `page-01.png`.
4. Backup code removed old snapshots with restic's `forget`, taking it to count all snapshots together. restic groups them by the set of folders backed up, so when that set changed, the old snapshots were kept for good. The reviewer found this by running restic.
