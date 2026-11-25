# The roles in planned work, and what each does

## What this document is for, and how to update it

Work that runs from a plan has five roles. The planner writes the plan. The implementer builds one piece of it. The reviewer checks what was built. The fixer settles what a review found. The orchestrator runs the loop between them, and brings the owner what the owner must decide.

This document holds the rules for each role that are true of every plan. A plan holds what belongs to its own pieces, and its models, its number of reviews and its machine.

Read [For every role](#for-every-role), and then the section of your own role.

To update it:

- Add a rule when a review, or real use, finds a kind of mistake that a rule here could have prevented, and it is a kind, not a single slip.
- Put it under the role that acts on it, as a sentence or two that say what to do.
- Give it a short example where one helps. An example can be understood without any other document: it has no pull request numbers, plan names or dates.
- Change or remove a rule that failed to prevent its mistake, or that is no longer needed.

## For every role

- **State only what you ran.** Run every command a document gives, as written. Run every sentence that says what the code does or what the owner sees, as you would a command, also when the sentence comes from the plan. Say what you couldn't run. *Example: a README said that a status command shows when a service has stopped. Run once, it printed the same for a stopped service as for a running one.*
- **Write a change into the documents as the rule it settles,** and adjust the text around it so that it reads as one piece ([What "done" means](../../AGENTS.md#what-done-means)). Who decided something, and when, go in the pull request or the issue, not in the documents.
- **Stop and ask the owner** where [`AGENTS.md`](../../AGENTS.md#when-to-stop-and-ask-the-owner) says to. One of those is when closing a kind of fault at its root is a large change, or one the plan doesn't name.

## The planner

- **For each piece, state what must never happen, as a rule.** Name the ways you know, and ask for every other, with a list of the ways found and of any that couldn't be closed. A list of cases without the rule gets only those cases closed. *Example: "Nothing the sandboxed agent leaves may stop the service that runs it."* Kinds of problem that have needed such a rule:
  - what a less trusted part can leave behind or send;
  - a part with more rights acting on a path that a part with fewer rights controls;
  - a resource running out: a full disk, a path too long, too many files;
  - a stop, a crash or a lost delivery between two steps that belong together.
- **Repeat in each piece every general rule that applies to it.** *Example: a plan said once, for all its pieces, how root may act in a folder that another user controls. The one piece whose own list left the rule out added a command that, run as root, made folders there.*
- **State a rule along what can vary:** a setting that changes between runs, a second folder of the same sort, a second way into the same code. *Example: a rule about what an agent can leave in its folders was closed for one configuration. A change of the setting that names those folders, over what an earlier run had left, stopped the service.*
- **For a fact about an outside program, say which copy of the program is meant, and over which values to try it.** *Example: a program's time zones were tried for two zones of 597. Its own copy of the zone data was two years old, and twelve zones were an hour off.*
- **Don't ask for quotes, names or dates in the documents.** An answer of the owner's is written as the rule it settles.

## The implementer

- **Close the kind of problem, not the cases named.** In the pull request, list the ways you found, how each is closed, and any you couldn't close.
- **For each rule you add, break it in the code and see a test fail.** A test that still passes holds nothing. *Example: a confirmation was moved to after a save, and a test was named for the new order. With the old order put back, every test passed.*
- **Try an outside program before you build on it, with the hard input and not only the easy one.** *Example: a program read its input from a pipe only when all of it had arrived before the program started.*
- **Run a test that depends on timing, or on more than one process, 20 times alone,** and give the count and the failures. *Example: a description said that the new tests had run 32 times without a failure. Run 33 times, 3 runs failed.*
- **Search for what you removed by its meaning and by counts, not only by its name.** *Example: a change removed three tests, and the README still gave the old number of tests.*

## The reviewer

### The first review, of the whole piece

- **Repeat what the description claims:** its commands, its repeated runs and its counts.
- **Try to break each rule the piece names,** in one more way than the plan and the description list.
- **Say of each fault whether it is one of a kind.** Two faults of one shape are a kind, and so is a fault against a rule that says "nothing", "never" or "always". For a kind, name the place in the code that every member passes through, and ask for the fix there, with a test that runs over the members. *Example: a file on the way to a folder stopped a service. "Handle the error a file gives" closes one member. "Judge each name on the way before using it" closes the kind: a link there, and a locked folder, were the next two members.*
- **For each fault, say how its fix will be checked,** at the place where the promise is made. *Example: for "the command refuses the wrong user", run the command as that user. A test that called the function behind it passed, while the command itself failed earlier, on a file it couldn't read.*
- **Don't ask for quotes, names or dates in the documents.**

### A review of fixes

- **Read only the fixes,** and what they changed in the description.
- **Run each fix at the place where the promise is made,** and undo it to see its test fail.
- **Where a fault was one of a kind, try other members.**
- **Say in the verdict when you found a new member of a kind that an earlier review found.** The loop stops on it.

## The fixer

What holds for the implementer holds for you.

- **Fix at the place the review names.** Where the fault is one of a kind, go through the kind, and say what else you found and what you couldn't close.
- **Stop and ask when a fix needs new machinery.** *Example: a program used stale data. The first fix added a new file, with a writer and a reader, and had two faults of its own. Replacing the data was enough.*
- **Fix where the promise is made,** with a test that goes in the same way.
- **Before you hand back,** run every sentence you wrote; search by meaning for the other places that say what you changed, in the documents, the comments, the tests and the description; and break each new behaviour to see a test fail. *Example: a fix widened a check from "a file" to "a file or a link". Another document still said "a file".*

## The orchestrator

- **When a review of fixes finds a new member of a kind that an earlier review found, stop.** Send no fixer. Ask the owner whether to fix at the root or to write the cases down as costs. *Example: reviews found a file, then a link, then an ignore file on the same way, each after the fix of the one before. The root was one level up, and a change of the design.*
- **At a stop, show the owner each point:** the text or the code at fault, what would settle it, and the choices.
- **Reviews after the first read only the fixes,** and can run on a cheaper model than the first. A first review finds the faults of the piece, and a later one the faults of the fixes.
- **Record the owner's decisions in the pull request or the issue,** with their dates. The documents get the rule.
