# Which model and effort level for which task

This file says which model, at which effort level, runs each kind of task while Scooter v2 is built by the milestone loop (`docs/plans/active/milestone-loop.workflow.js`), and what evidence each choice rests on. Read it before you start an agent for this plan. It is updated as milestones finish, and section 7 says how.

Where the plan stands: milestones 0 to 14 are merged, the last on 2026-11-18. Gate G4, the first real run, is left, and it is the owner's.

Two terms:

- **Effort level**, also called the thinking level: Claude Code's setting for how much a model thinks, calls tools and checks its own work. The levels are `low`, `medium`, `high`, `xhigh` and `max`.
- **Cost** is always at Anthropic's API list prices. The owner pays through a plan with usage limits, not by the token. List prices are what can be measured for each agent. Section 5 says how the plan's meters counted them, which for Opus 5.5 was at less than half.

## 1. What to run

| Task | Model | Effort | Since | Decided |
|---|---|---|---|---|
| Implement a milestone, or fix it after a review | Opus 5.5 | `xhigh` | Milestone 2 | By the owner, 2026-11-16 |
| Review a pull request | Fable 5.2 | `high` | Milestone 0 | By the owner, 2026-11-16 |
| Merge an approved pull request, or list the merged ones | Fable 5.2 | `low` | Milestone 0 | In the loop's script |

As the loop's arguments, that is `coder: { model: 'opus', effort: 'xhigh' }` and no `reviewer`. The reviewing agents take the model and effort of the session that runs the loop, so that session stays on Fable 5.2 at `high`.

For a task that isn't in the table:

- Long coding work, of more than about half an hour: Opus 5.5 at `xhigh`.
- Work whose job is to find what is wrong, such as a review or a security check: Fable 5.2 at `high`.
- A step of one or two commands with nothing to decide: `low`.
- Not `max`, unless a measurement on this project shows that it gains something.

Measure the first run of a new kind of task, and add it to section 3.

## 2. Why

**The implementer: Opus 5.5 at `xhigh`.**

- The implementer is where the cost is: 71%, 68% and 63% of milestones 1, 2 and 3, and 64% to 72% of the six later milestones that were approved on their first review (section 3).
- The tightest limit is the weekly allowance for Fable (section 5). Milestone 1, all on Fable 5.2, took $26 of it. With the implementer on Opus 5.5, a milestone that was approved on its first review took $6 to $11 of it, for the review and the merge.
- On the two meters that Opus 5.5 shares with Fable 5.2, its use counted for less than half its list price (section 5).
- It built thirteen milestones, 2 to 14. Eight of its pull requests were approved on the first review, four on the second (milestones 6, 7, 10 and 14), and one on the fifth (milestone 4). The approving reviews left 3 to 8 smaller points each. The two pull requests from Fable 5.2 were approved on the first review, with 7 and 8.
- Milestone 4 took five reviews. Each of the first four found new cases of one kind of problem: something that pi, the agent Scooter runs, leaves in its folders stops the runner. The implementer fixed every case it was shown, as the next review confirmed each time. In its first run it built to the cases, not to the kind of problem, and three reviews weren't enough.
- Then the owner told it to close the whole kind of problem, by four rules, and it rebuilt that part. The next review still found two cases, both against one of the rules. After one more fix, the reviewer went through every step that reads what pi leaves, found no further case, and approved. So the instruction made it converge, though not at the first attempt (section 6).
- In milestones 6, 7, 10 and 14 the first review found six problems. One round fixed them, as the second review confirmed each time:
  - 6: as root, the bridge deleted whole folders through a link that the email reader's user could put in the spool's place. On a full disk an email lost its files. And two tests failed now and then.
  - 7: as root, `build-image` worked inside the runner's folder, where a link swapped in during the build gave the runner's user a folder of its choosing.
  - 10: when a backup stopped WhatsApp, a message could be lost for good.
  - 14: the README's steps for a native upgrade failed as written, and would have left the old pi in place.
- What a rule in the plan names, it closes. Milestone 7's plan had the rule that nothing pi does may stop the runner, and the review's probes of the sandbox found no way through. Milestone 8's plan had three such rules, and its pull request was approved on the first review.
- Told to close a kind of problem and not a case, it goes through the kind. Milestone 14's rule for WhatsApp's catch-up named two ways a message could stay out of the datastore, and said to look for every other. It closed both and three more that it found, and listed the one it couldn't close as a known limit (D179). The first review found nothing to fix there. The second found one further case, which delays a message and doesn't lose it, and left it for the first real run.
- It doesn't carry a kind of problem over to new work by itself. Milestone 6's fix recorded the rule for root and a folder that another user controls (`docs/DECISIONS.md`, D136), which every later implementer is told to read. Milestone 7's implementer still had root build the image inside such a folder. Section 6 says what follows.
- While fixing, it did look for more cases of what a review showed. It found one that the reviews had missed in milestone 6, which milestone 12 then closed (D205), and one in milestone 10, which is left for the owner (D179).
- At list prices it was no cheaper than Fable 5.2 at `high`: $20.35 for milestone 2, against $18.59 for milestone 1, which was different work. The two wrote about as much, 234,000 output tokens against 228,000. But Opus 5.5 at `xhigh` made 143 requests where Fable 5.2 made 66, and each request reads the context so far from the cache: 52.8 million tokens against 19.2 million. Cache reads cost the same on both models, and they were 52% of its bill. The implementers of milestones 3 and 4 cost $17.65 and $20.15, and those of milestones 5 to 13 cost $11 to $32, $24 on average.
- Why not `high`: by Anthropic's figures (section 4), Opus 5.5 at `high` is 0.8 and 5.1 points under Fable 5.2 at `high` on the two coding benchmarks. At `xhigh` it is level on one and 2.4 under on the other. `high` should cost 34% to 40% of `xhigh`, but the saving would fall on the meters that have room. A weak implementation costs a round of a fix and a review, $13 to $34 here with $7 to $12 of it from the Fable allowance, and a defect that passes review is built on by the next milestone. `high` hasn't been tried here.
- Why not `max`: Anthropic publishes no comparison for Opus 5.5 at `max`. Its guidance for Fable 5.2 says that `max` costs more and runs slower than `xhigh`, often for a small gain. The one `max` run here, milestone 0's implementer on Fable 5.2, spent the most per hour.

**The reviewer: Fable 5.2 at `high`.**

- The review is the only check of the code before it is merged.
- Fable 5.2 at `high` finds the most planted defects in Anthropic's test: it scores 0.909, against 0.850 for Opus 5.5 at `high`, and its range of scores lies above every other configuration's.
- A review costs $6 to $12 here, $9 on average, which is a quarter to a third of a milestone that is approved on its first review. With the implementer on Opus 5.5, it is nearly all that a milestone takes from the Fable allowance.
- Twenty-three reviews are in. Fifteen approved, with 3 to 8 smaller points each. Eight asked for changes: four on milestone 4, and one each on milestones 6, 7, 10 and 14. What they found mattered:
  - One smaller point led the owner to change the send interval (`docs/DECISIONS.md`).
  - The review of milestone 2 read wacli's source, and found that a deletion by the owner would probably be dropped as the bot's own. Tests against a stub can't show that.
  - It also ran the new tests 64 times and saw one fail twice, where the implementer had run them 16 times and seen no failure.
  - The reviews of milestone 4 started VMs, timed git and filled disks, and found seven problems that a misled agent could cause, among them a runner that can't start again. Each was reproduced before it was reported.
  - The five problems in milestones 6, 7 and 10 were reproduced too, for example as root in a container, with a link placed as the less trusted user could place it. On each of those pull requests the suite had passed when the review first ran it.
  - It checks what a description claims. Milestone 6's said that its tests had run 32 times without a failure. The review ran the suite 33 times, and 3 runs failed.
  - It reads the documentation against the code. In milestone 14 it followed the README's steps for a native upgrade, and found that `build-image` refuses to run at the step where the README had it.
  - It also reports what holds. In milestone 7 it made a 3 GB file under a 1 MB limit, printed 300 MB, and looked for the key inside the VM. The sandbox held each time.
  - A review can be wrong too. The second review of milestone 4 took a path longer than the system allows to be out of pi's reach, because `mkdir` refuses to make one. The fourth review made one with `mv`.
- Not tried: a cheaper reviewer, or one off the Fable meter. Fable 5.2 at `medium` scores 0.877 in that test for about a third less. Opus 5.5 at `high` scores 0.850, and takes nothing from the Fable allowance. Either is worth trying only if the Fable allowance runs short.

**Merging and listing: `low`.** One or two commands, and nothing to decide. Each costs about $0.47, nearly all of it the agent's starting context of 42,000 tokens.

## 3. What was measured on this project

| Milestone | Task | Model, effort | Time | Cost | What came of it |
|---|---|---|---|---|---|
| 0: check the tools | Implement, first run | Fable 5.2, `max` | 81 min | $54.83 | Stopped with two questions for the owner |
| 0 | Implement, second run | Fable 5.2, `max` | 35 min | $18.22 | Finished pull request 1: 6,637 lines added in 26 files |
| 0 | Review | Fable 5.2, `high` | 20 min | $7.88 | Approved. Nothing to fix, 7 smaller points |
| 0 | Merge | Fable 5.2, `low` | Under 1 min | $0.46 | Merged |
| 1: foundations and the datastore | Implement | Fable 5.2, `high` | 39 min | $18.59 | Pull request 2: 6,101 lines added in 33 files |
| 1 | Review | Fable 5.2, `high` | 12 min | $6.96 | Approved. Nothing to fix, 8 smaller points |
| 1 | Merge | Fable 5.2, `low` | Under 1 min | $0.45 | Denied by auto mode's safety check, then merged by hand |
| 2: bridge intake, WhatsApp | Implement | Opus 5.5, `xhigh` | 46 min | $20.35 | Pull request 3: 3,422 lines added in 35 files. It also settled the smaller points of the first two reviews, and left 2 open with reasons |
| 2 | Review | Fable 5.2, `high` | 18 min | $8.99 | Approved. Nothing to fix, 7 smaller points |
| 2 | Merge | Fable 5.2, `low` | Under 1 min | $0.47 | Merged. It wasn't denied, with the owner's permission rule in place and the command run by itself |
| 3: runner, planning | Implement | Opus 5.5, `xhigh` | 41 min | $17.65 | Pull request 4: 3,785 lines added in 35 files |
| 3 | Review | Fable 5.2, `high` | 17 min | $9.95 | Approved. Nothing to fix, 7 smaller points |
| 3 | Merge | Fable 5.2, `low` | Under 1 min | $0.46 | Merged |
| 4: runner, running | Implement | Opus 5.5, `xhigh` | 38 min | $20.15 | Pull request 5 |
| 4 | Review 1 | Fable 5.2, `high` | 12 min | $7.05 | Changes requested: 1 problem to fix |
| 4 | Fix 1 | Opus 5.5, `xhigh` | 21 min | $8.14 | Fixed, as review 2 confirmed |
| 4 | Review 2 | Fable 5.2, `high` | 11 min | $6.82 | Changes requested: 2 new problems |
| 4 | Fix 2 | Opus 5.5, `xhigh` | 17 min | $7.17 | Fixed, as review 3 confirmed |
| 4 | Review 3, first run | Fable 5.2, `high` | 20 min | $10.25 | Lost. The 5-hour limit stopped it before it posted anything |
| 4 | Review 3, run again | Fable 5.2, `high` | 32 min | $10.35 | Changes requested: 2 new problems. The loop stopped, at its limit of 3 reviews |
| 4 | Implement, second run | Opus 5.5, `xhigh` | 37 min | $14.29 | Started on 2026-11-17 with the owner's answer (section 6). Fixed the third review's points and applied the four rules |
| 4 | Review 4 | Fable 5.2, `high` | 15 min | $7.66 | Changes requested: 2 new problems, both in the clean-up |
| 4 | Fix 3 | Opus 5.5, `xhigh` | 34 min | $13.99 | Fixed, as review 5 confirmed |
| 4 | Review 5 | Fable 5.2, `high` | 18 min | $10.04 | Approved. Nothing to fix, 3 smaller points |
| 4 | Merge | Fable 5.2, `low` | Under 1 min | $0.47 | Merged. Pull request 5: 5,577 lines added in 48 files |
| 5: delivery and commands | Implement | Opus 5.5, `xhigh` | 38 min | $20.07 | Pull request 6: 2,566 lines added in 42 files |
| 5 | Review | Fable 5.2, `high` | 15 min | $7.40 | Approved. Nothing to fix, 7 smaller points |
| 5 | Merge | Fable 5.2, `low` | Under 1 min | $0.48 | Merged |
| 6: email | Implement | Opus 5.5, `xhigh` | 63 min | $32.07 | Pull request 7 |
| 6 | Review 1 | Fable 5.2, `high` | 22 min | $9.48 | Changes requested: 3 problems to fix, 8 smaller points |
| 6 | Fix 1 | Opus 5.5, `xhigh` | 64 min | $21.82 | Fixed all 11, as review 2 confirmed |
| 6 | Review 2 | Fable 5.2, `high` | 28 min | $11.69 | Approved. Nothing to fix, 8 smaller points |
| 6 | Merge | Fable 5.2, `low` | Under 1 min | $0.46 | Merged. Pull request 7: 5,255 lines added in 45 files |
| 7: sandbox and VM image | Implement | Opus 5.5, `xhigh` | 52 min | $27.33 | Pull request 8 |
| 7 | Review 1 | Fable 5.2, `high` | 24 min | $10.68 | Changes requested: 1 problem to fix, 7 smaller points |
| 7 | Fix 1 | Opus 5.5, `xhigh` | 24 min | $9.67 | Fixed, as review 2 confirmed |
| 7 | Review 2 | Fable 5.2, `high` | 16 min | $7.50 | Approved. Nothing to fix, 4 smaller points |
| 7 | Merge | Fable 5.2, `low` | Under 1 min | $0.46 | Merged. Pull request 8: 2,687 lines added in 34 files |
| 8: network policy and log | Implement | Opus 5.5, `xhigh` | 49 min | $23.54 | Pull request 9: 1,858 lines added in 25 files |
| 8 | Review | Fable 5.2, `high` | 17 min | $10.23 | Approved. Nothing to fix, 6 smaller points |
| 8 | Merge | Fable 5.2, `low` | Under 1 min | $0.47 | Merged |
| 9: rebuild and backfill | Implement | Opus 5.5, `xhigh` | 38 min | $22.09 | Pull request 10: 2,027 lines added in 25 files |
| 9 | Review | Fable 5.2, `high` | 16 min | $9.48 | Approved. Nothing to fix, 5 smaller points |
| 9 | Merge | Fable 5.2, `low` | Under 1 min | $0.46 | Merged |
| 10: backups | Implement | Opus 5.5, `xhigh` | 59 min | $25.43 | Pull request 11 |
| 10 | Review 1 | Fable 5.2, `high` | 15 min | $8.14 | Changes requested: 1 problem to fix, 7 smaller points |
| 10 | Fix 1 | Opus 5.5, `xhigh` | 29 min | $9.92 | Fixed, as review 2 confirmed |
| 10 | Review 2 | Fable 5.2, `high` | 13 min | $7.48 | Approved. Nothing to fix, 3 smaller points |
| 10 | Merge | Fable 5.2, `low` | Under 1 min | $0.48 | Merged. Pull request 11: 2,802 lines added in 33 files |
| 11: the agent's instructions | Implement | Opus 5.5, `xhigh` | 27 min | $11.21 | Pull request 12: 933 lines added in 21 files |
| 11 | Review | Fable 5.2, `high` | 12 min | $5.84 | Approved. Nothing to fix, 8 smaller points |
| 11 | Merge | Fable 5.2, `low` | Under 1 min | $0.47 | Merged |
| 12: native install | Implement | Opus 5.5, `xhigh` | 59 min | $26.96 | Pull request 13: 2,321 lines added in 34 files. It ran gates G1 and G2 in a throwaway VM |
| 12 | Review | Fable 5.2, `high` | 26 min | $11.03 | Approved. Nothing to fix, 7 smaller points |
| 12 | Merge | Fable 5.2, `low` | Under 1 min | $0.46 | Merged |
| 13: Docker | Implement | Opus 5.5, `xhigh` | 46 min | $23.40 | Pull request 14: 1,082 lines added in 27 files. It ran gate G3 in a throwaway VM |
| 13 | Review | Fable 5.2, `high` | 31 min | $10.46 | Approved. Nothing to fix, 5 smaller points |
| 13 | Merge | Fable 5.2, `low` | Under 1 min | $0.48 | Merged |
| 14: docs and final check | Implement | Opus 5.5, `xhigh` | 47 min | $25.65 | Pull request 15. Besides the README and the final check, it closed the two cases the owner asked to have closed (section 6) |
| 14 | Review 1 | Fable 5.2, `high` | 11 min | $7.50 | Changes requested: 1 problem to fix, in the README, and 8 smaller points |
| 14 | Fix 1 | Opus 5.5, `xhigh` | 13 min | $5.95 | Fixed, as review 2 confirmed |
| 14 | Review 2 | Fable 5.2, `high` | 10 min | $6.60 | Approved. Nothing to fix, 3 smaller points |
| 14 | Merge | Fable 5.2, `low` | Under 1 min | $0.46 | Merged. Pull request 15: 1,837 lines added in 36 files |

Each milestone as a whole:

| Milestone | Reviews | Cost | Of it on Fable 5.2 | Agent time |
|---|---|---|---|---|
| 0 | 1 | $81.39 | $81.39 | 2 h 16 min |
| 1 | 1 | $26.00 | $26.00 | 51 min |
| 2 | 1 | $29.81 | $9.46 | 1 h 4 min |
| 3 | 1 | $28.06 | $10.41 | 58 min |
| 4 | 5, and 1 lost | $116.38 | $52.64 | 4 h 15 min |
| 5 | 1 | $27.95 | $7.88 | 53 min |
| 6 | 2 | $75.52 | $21.63 | 2 h 57 min |
| 7 | 2 | $55.64 | $18.64 | 1 h 56 min |
| 8 | 1 | $34.24 | $10.70 | 1 h 6 min |
| 9 | 1 | $32.03 | $9.94 | 55 min |
| 10 | 2 | $51.45 | $16.10 | 1 h 57 min |
| 11 | 1 | $17.52 | $6.31 | 39 min |
| 12 | 1 | $38.45 | $11.49 | 1 h 26 min |
| 13 | 1 | $34.34 | $10.94 | 1 h 17 min |
| 14 | 2 | $46.16 | $14.56 | 1 h 21 min |
| 0 to 14 | 23, and 1 lost | $694.94 | $308.09 | About 23 h 50 min |

- From milestone 1 on, a milestone that was approved on its first review cost $18 to $38. The six of them among milestones 5 to 13 cost $31 on average.
- Milestone 4 cost about four times that, over two runs of the loop. $10.25 of it was lost to the limit.
- A round of one fix and the review after it cost $13 to $24 in milestones 4, 7, 10 and 14. In milestone 6 it cost $34: the fix took as long as the implementation had.
- The loop spends $26 to $35 for an hour of agent time.
- The run of 2026-11-17 and 18 took milestones 4 to 13 through 39 agents in 14 hours 50 minutes, with no stop: $414.
- Not in the tables: the session that runs the loop, which used about $5 in that run and again in milestone 14's, and the agent that lists the merged pull requests when a run starts, $0.44.
- Milestone 0's implementer at `max` spent about $41 an hour in its first run. The milestones are different work, so none of this compares two levels or two models cleanly.
- Before milestone 2, the ratios in section 4 gave an estimate of $10 to $14 for its implementer. It cost $20.35, and section 2 says where the cost went. Don't estimate this project's costs from those ratios.

## 4. What Anthropic publishes

From "Optimizing for cost and intelligence" (platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence) and "Effort" (platform.claude.com/docs/en/build-with-claude/effort) in Anthropic's documentation, read on 2026-11-16.

| Model, effort | SWE-bench Pro subset: tasks solved, cost per solved task | Agentic-coding benchmark: attempts solved, cost per attempt | Defect search: score, cost per run |
|---|---|---|---|
| Opus 5.5, `medium` | 93.1%, $0.22 | 86.6%, $0.84 | 0.827, $200 |
| Opus 5.5, `high` | 95.5%, $0.30 | 88.4%, $1.38 | 0.850, $236 |
| Opus 5.5, `xhigh` | 96.5%, $0.75 | 91.1%, $4.11 | Not published |
| Fable 5.2, `low` | 94.6%, $0.39 | 88.9%, $1.05 | 0.866, $357 |
| Fable 5.2, `medium` | Not published | 88.9%, $1.34 | 0.877, $378 |
| Fable 5.2, `high` | 96.3%, $1.39 | 93.5%, $5.39 | 0.909, $563 |

- The three benchmarks: 463 problems of SWE-bench Pro; 370 repository tasks graded by the repositories' own tests; and 130 defects planted in about 22 million tokens of Python, scored by F1. The last two are Anthropic's own.
- The `xhigh` figures are single runs, and so are Fable 5.2's on the first two benchmarks. On the agentic-coding benchmark, Anthropic calls a difference of 1.7 points between runs of five attempts a task the edge of run-to-run noise.
- Nothing is published for either model at `max` on these benchmarks. The `max` results in the Opus 5.5 system card use other problem sets.
- The coding tasks are small, a few dollars each at most. A milestone's implementer costs about $20, over half of it for reading a long context from the cache, so the cost ratios between the two models didn't carry over to this project (section 3).
- Anthropic's own advice is to measure the effort levels on your own work. Section 3 is that measurement.

## 5. The limits these choices work within

The owner's plan has three usage meters, and the app shows them only as whole percentages. On 2026-11-16, about $50 of use at list prices, all of it on Fable 5.2, moved them by 52, 18 and 9 points. So, roughly:

| Meter | The whole of it, in Fable 5.2 use at list prices |
|---|---|
| A 5-hour window | $100 |
| A week, Fable only | $300 |
| A week, all models | $600 |

A second check, on 2026-11-18: $12 of Fable 5.2 use with nothing else running moved them by 11, 4 and 2 points, which fits.

How Opus 5.5 counts, from five pairs of meter readings between 2026-11-16 and 2026-11-18:

| Between the readings | Fable 5.2 use | Opus 5.5 use | 5-hour window | Fable week | All-models week |
|---|---|---|---|---|---|
| Milestone 2 | $14 | $18 | 23 points | 5 points | 4 points |
| Milestones 3 and 4, up to the limit | $42 | $53 | 65 points | 16 points | 11 points |
| Milestone 4's second run, and the first 35 minutes of milestone 5 | $26 | $46 | 47 points | 10 points | 8 points |
| The rest of milestone 5, and milestones 6 to 13 | $122 | $235 | It reset three times | 42 points | 38 points |
| Milestone 14 | $28 | $32 | It reset once | 8 points | 6 points |

The weekly meters of the second row were read 19 minutes after the limit, when the Fable use had reached $48.

- Opus 5.5 doesn't count on the Fable meter. All five times, the Fable use alone accounts for that meter's points, to within a point or two.
- On the other two meters, the Opus use counted for a quarter to a half of its list price: about $8 of $18 the first time, $13 to $20 of $53 the second, about $21 of $46 the third, about $106 of $235 the fourth, and about $8 of $32 the fifth. The fourth is by far the largest sample, and it says 45%.
- The meters don't follow list prices exactly, even for Fable 5.2 alone. A third reading, of $16 of Fable use, moved the 5-hour window 13 points where the first calibration predicts 17. Take every figure here as rough.

What follows:

- A milestone approved on its first review takes about 20 points of a 5-hour window, from 11 to 24, and 2 to 4 points of each weekly meter. Milestone 1, all on Fable 5.2, took about 27 of the window, 9.4 of the Fable week and 4.7 of the all-models week.
- Each further round of a fix and a review takes 10 to 21 points of a 5-hour window and 2.5 to 4 of the Fable week.
- A 5-hour window sustains about 20 points an hour. The loop alone uses 17 to 20, so it runs close to the limit, and other sessions in the same window can take it over.
  - On 2026-11-16 the window ran out during milestone 4's third review, and that review's $10.25 was lost.
  - On 2026-11-18 the loop ran through two whole windows without a stop. Each carried about $45 of Fable use and $91 to $95 of Opus use, which is about 86 points by the figures above.
- When an agent dies on a limit, resume the run: the Workflow tool's `resumeFromRunId`, with the same `from`. The agents that finished return from the run's records, and only the one that died runs again. A plain rerun starts a new implementer and counts the reviews from 1.
- The nine milestones from 5 to 13 took about 39 points of the Fable week and about 38 of the all-models week. Three of them needed a second review. The estimate before the run was 32 points of the Fable week if none did, and 60 if all did. Milestone 14, with its second review, took about 5 points of the Fable week and 4 of the all-models week.
- The session that coordinates the loop uses the Fable allowance too. On 2026-11-18 it took about 7 points of the Fable week, for reading the reviews, measuring the agents and keeping this file. That is as much as two reviews.
- The weekly meters reset on Tuesdays at 19:00 UTC. On 2026-11-18 at 15:33 UTC, after milestone 14, they stood at 66% for Fable and 55% for all models. The owner's own sessions use the same allowance.

## 6. What would change a choice

A change to section 1 is the owner's decision. Put the evidence to the owner, and record the answer here with its date.

- **Step the implementer down to `high`** if the 5-hour window or the all-models week, and not the Fable week, is what stops the loop, or if milestones take too long. By Anthropic's figures, `high` should take 60% to 66% less of both. It changes nothing on the Fable meter. Neither limit stopped the run of milestones 4 to 13.
  - Until milestone 2, this entry said: step down if `xhigh` costs more than Fable 5.2 at `high` did, about $19 for milestone 1. Milestone 2's implementer cost $20.35, for different work, so by the letter that was met. It was put to the owner on 2026-11-16, with the advice to stay at `xhigh`, because the plan doesn't count Opus 5.5 at its list price (section 5). The choice in section 1 stands unless the owner changes it.
- **Reconsider Opus 5.5 for the implementer** if its pull requests need a second review more often than not. Five of its thirteen have: milestone 4, which took five reviews, and milestones 6, 7, 10 and 14, which took two each (section 2). So this isn't met.
  - After milestone 4's third review, on 2026-11-16, this was put to the owner, with the advice to keep the implementer and tell it to close the whole kind of problem, not the next case. The proposal had four rules: limit what is accepted; put back what git doesn't record; fail the run, don't stop the runner; make the clean-up unstoppable. The owner agreed on 2026-11-17 ("yes"), and the loop gave that to milestone 4's next implementer as the owner's answer. `docs/DECISIONS.md` 4.7 quotes it.
  - What came of it: the next review found two more cases, both ways to stop the clean-up, which the fourth rule was meant to rule out. After one fix, the review after that found none, and approved. Without the instruction, three reviews weren't enough. With it, two were.
  - So when a pull request keeps failing its review on new cases of one kind, name the kind and the rules that close it, and give them to the implementer as the answer to a question (the loop's `question` and `answer` arguments). Try that before a change of model.
- **Milestones 7 and 8, the sandbox and the network policy, were built with the choices of section 1.** A defect there is a hole in the security boundary, so whether they needed a stronger implementer stayed open until milestone 4 was merged.
  - On 2026-11-17 an alternative was put to the owner: Fable 5.2 at `high` as their implementer, about $20 of Fable use for each, against fewer rounds of review if it foresees more. The owner read that as a claim that Opus 5.5 can't design a solution there that rules out edge cases as a whole. The evidence doesn't support that claim. In milestone 4's first run nobody had asked it to, and Fable 5.2 has built no work of this kind here to compare it with. The suggestion was withdrawn the same day.
  - Milestone 4's second run was the test, and its result is above. Asked to, Opus 5.5 closed the kind of problem, in two reviews and not in one. So one round of a fix and a review was allowed for in each of 7 and 8.
  - Their implementers got the instruction from the plan, which every implementer reads. Milestone 7 there had the rule "Nothing pi does may stop the runner", with the two ways that remained for the sandbox to close. Milestone 8 had three rules of the same kind.
  - What came of it: milestone 7 took that round, and milestone 8 didn't need it.
    - In 7, the one problem wasn't in what holds pi, where the review's probes found no way through. It was in how root builds the image (section 2).
    - In 8, the review found one more way for a misled agent to have its batch tried again without end: a request that the agent sends itself. The rules didn't ask for that case. It is recorded as a cost, for the owner to decide (`docs/DECISIONS.md`, D160).
- **Write the kind of problem into the plan before the implementer starts.** The evidence is from one implementer, Opus 5.5 at `xhigh`. No other was tried, so it says what worked with this one, not that another model would need it less.
  - Where the plan named a kind of problem as a rule, the first review found no case that the rule covered: pi stopping the runner, in milestones 7 and 8, and the bridge writing into the runner's outbox, in milestone 12.
  - Where only a decision recorded it, a case came back: root working in a folder that a less trusted user controls, found in milestone 6 (D136) and again in milestone 7 (D151).
  - Milestone 14 was the first whose rules were written this way on purpose, for the two cases the owner asked on 2026-11-18 to have closed: how often pi runs when the runner keeps stopping (D229), and a catch-up that passes a message (D179). Each rule named the kind of problem and the known cases, and said to look for others. The first review found nothing to fix in either. Its one problem was in the README.
  - The three kinds found so far, for work that comes after milestone 14:
    - something pi does stops the runner, or a fault has pi run again and again (`docs/DECISIONS.md` 4.7, D160, D229);
    - a part that runs as root follows a path that a less trusted user controls (D136, D151, D205);
    - a stop, a crash, or a delivery that never came leaves a message out of the datastore (D179).
  - When new work touches one of them, put a rule for it in that work's plan, and name the decisions that hold the cases.

## 7. Keeping this file up to date

When a milestone is merged, add a row to section 3 for each of its agents, and say what the review found. Change sections 2 and 6 where the new rows change the argument.

How the rows are measured:

- Each agent of the loop leaves a transcript on the machine that runs it, at `~/.claude/projects/<the checkout's path, with every / written as ->/<session ID>/subagents/workflows/<run ID>/agent-<ID>.jsonl`. The `journal.jsonl` beside it says which agent had which label.
- Time runs from the agent's first request to its last response.
- Cost is the sum, over the agent's responses, of the tokens in `message.usage`, at the prices below per million tokens. Several records can share one message ID: count each response once.
- Each response's record also names its model and effort level (`requestedModel` and `effort`). Check them, because the run's summary gives the model only.
- To see how the plan counted a run, read the meters just before and just after it, and sum what every session used between the two readings, by model.
- A run of more than five hours crosses windows that no reading catches. The app shows when the current window resets, and the windows before it are five hours apart. Sum each window's use by model to see how near the limit the run came.

| Model | Input | Output | Cache read | Cache write, 5 minutes | Cache write, 1 hour |
|---|---|---|---|---|---|
| Fable 5.2 | $8 | $40 | $0.20 | $10 | $16 |
| Opus 5.5 | $4 | $20 | $0.20 | $5 | $8 |
