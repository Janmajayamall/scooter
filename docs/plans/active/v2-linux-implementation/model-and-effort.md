# Which model and effort level for which task

This file says which model, at which effort level, runs each kind of task while Scooter v2 is built by the milestone loop (`docs/plans/active/milestone-loop.workflow.js`), and what evidence each choice rests on. Read it before you start an agent for this plan. It is updated as milestones finish, and section 7 says how.

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

- The implementer is where the cost is: 71%, 68% and 63% of milestones 1, 2 and 3 (section 3).
- The tightest limit is the weekly allowance for Fable (section 5). Milestone 1, all on Fable 5.2, took $26 of it. Milestones 2 and 3, with the implementer on Opus 5.5, took $9.46 and $10.41, for the review and the merge.
- On the two meters that Opus 5.5 shares with Fable 5.2, its use counted for less than half its list price (section 5).
- Two of its three pull requests were approved on the first review, with 7 smaller points each. The two from Fable 5.2 had 7 and 8.
- The third, for milestone 4, took five reviews. Each of the first four found new cases of one kind of problem: something that pi, the agent Scooter runs, leaves in its folders stops the runner. The implementer fixed every case it was shown, as the next review confirmed each time. In its first run it built to the cases, not to the kind of problem, and three reviews weren't enough.
- Then the owner told it to close the whole kind of problem, by four rules, and it rebuilt that part. The next review still found two cases, both against one of the rules. After one more fix, the reviewer went through every step that reads what pi leaves, found no further case, and approved. So the instruction made it converge, though not at the first attempt (section 6).
- At list prices it was no cheaper than Fable 5.2 at `high`: $20.35 for milestone 2, against $18.59 for milestone 1, which was different work. The two wrote about as much, 234,000 output tokens against 228,000. But Opus 5.5 at `xhigh` made 143 requests where Fable 5.2 made 66, and each request reads the context so far from the cache: 52.8 million tokens against 19.2 million. Cache reads cost the same on both models, and they were 52% of its bill. The implementers of milestones 3 and 4 cost $17.65 and $20.15.
- Why not `high`: by Anthropic's figures (section 4), Opus 5.5 at `high` is 0.8 and 5.1 points under Fable 5.2 at `high` on the two coding benchmarks. At `xhigh` it is level on one and 2.4 under on the other. `high` should cost 34% to 40% of `xhigh`, but the saving would fall on the meters that have room. A weak implementation costs a second review, about $9 of the Fable allowance, and a defect that passes review is built on by the next milestone. `high` hasn't been tried here.
- Why not `max`: Anthropic publishes no comparison for Opus 5.5 at `max`. Its guidance for Fable 5.2 says that `max` costs more and runs slower than `xhigh`, often for a small gain. The one `max` run here, milestone 0's implementer on Fable 5.2, spent the most per hour.

**The reviewer: Fable 5.2 at `high`.**

- The review is the only check of the code before it is merged.
- Fable 5.2 at `high` finds the most planted defects in Anthropic's test: it scores 0.909, against 0.850 for Opus 5.5 at `high`, and its range of scores lies above every other configuration's.
- A review costs $7 to $10 here, a quarter to a third of a milestone that is approved on its first review. With the implementer on Opus 5.5, it is nearly all that a milestone takes from the Fable allowance.
- Nine reviews are in. Five approved, with 7, 8, 7, 7 and 3 smaller points. Four asked for changes, all on milestone 4. What they found mattered:
  - One smaller point led the owner to change the send interval (`docs/DECISIONS.md`).
  - The review of milestone 2 read wacli's source, and found that a deletion by the owner would probably be dropped as the bot's own. Tests against a stub can't show that.
  - It also ran the new tests 64 times and saw one fail twice, where the implementer had run them 16 times and seen no failure.
  - The reviews of milestone 4 started VMs, timed git and filled disks, and found seven problems that a misled agent could cause, among them a runner that can't start again. Each was reproduced before it was reported.
  - A review can be wrong too. The second review of milestone 4 took a path longer than the system allows to be out of pi's reach, because `mkdir` refuses to make one. The fourth review made one with `mv`.
- Not tried: a cheaper reviewer, or one off the Fable meter. Fable 5.2 at `medium` scores 0.877 in that test for about a third less. Opus 5.5 at `high` scores 0.850, and takes nothing from the Fable allowance. Either is worth trying only if the Fable allowance runs short.

**Merging and listing: `low`.** One or two commands, and nothing to decide. Each costs about $0.45, nearly all of it the agent's starting context of 42,000 tokens.

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

- Milestone 1 as a whole: $26.00 in 51 minutes, about $31 an hour, all on Fable 5.2.
- Milestone 2 as a whole: $29.81 in 64 minutes, about $28 an hour. $9.46 of it was on Fable 5.2.
- Milestone 3 as a whole: $28.06 in 58 minutes, about $29 an hour. $10.41 of it was on Fable 5.2.
- Milestone 4 as a whole: $116.38 in 4 hours 15 minutes of agent time, over two runs of the loop. That is about four times a milestone that is approved on its first review. $52.64 of it was on Fable 5.2, and $10.25 of that was lost to the limit.
- A round of one fix and the review after it cost between $15 and $24 in milestone 4, more with each round as the pull request grew.
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

How Opus 5.5 counts, from three pairs of meter readings on 2026-11-16 and 2026-11-17:

| Between the readings | Fable 5.2 use | Opus 5.5 use | 5-hour window | Fable week | All-models week |
|---|---|---|---|---|---|
| Milestone 2 | $14 | $18 | 23 points | 5 points | 4 points |
| Milestones 3 and 4, up to the limit | $42 | $53 | 65 points | 16 points | 11 points |
| Milestone 4's second run, and the first 35 minutes of milestone 5 | $26 | $46 | 47 points | 10 points | 8 points |

The weekly meters of the second row were read 19 minutes after the limit, when the Fable use had reached $48.

- Opus 5.5 doesn't count on the Fable meter. All three times, the Fable use alone accounts for that meter's points, to within about a point.
- On the other two meters, the Opus use counted for a quarter to a half of its list price: about $8 of $18 the first time, $13 to $20 of $53 the second, and about $21 of $46 the third.
- The meters don't follow list prices exactly, even for Fable 5.2 alone. A third reading, of $16 of Fable use, moved the 5-hour window 13 points where the first calibration predicts 17. Take every figure here as rough.

What follows:

- A milestone approved on its first review, like milestones 2 and 3, takes about 20 points of a 5-hour window, 3.6 of the Fable week and 3.4 of the all-models week. Milestone 1, all on Fable 5.2, took about 27, 9.4 and 4.7.
- Each further round of a fix and a review takes 10 to 16 points of a 5-hour window and 2.5 to 3.5 of the Fable week.
- A 5-hour window sustains about 20 points an hour, and the loop uses 19 to 21. So a long run reaches a limit sooner or later. On 2026-11-16 the window ran out during milestone 4's third review, and that review's $10.25 was lost. On 2026-11-17 the loop used 47 points in 2 hours 20 minutes, the same rate.
- When an agent dies on a limit, resume the run: the Workflow tool's `resumeFromRunId`, with the same `from`. The agents that finished return from the run's records, and only the one that died runs again. A plain rerun starts a new implementer and counts the reviews from 1.
- Milestone 4's second run took about 6 points of the Fable week. The nine milestones from 5 to 13 would take about 32 points if each were approved on its first review, and about 60 if each needed one more round. The owner's own sessions use the same allowance.
- The weekly meters reset on Tuesdays at 19:00 UTC.

## 6. What would change a choice

A change to section 1 is the owner's decision. Put the evidence to the owner, and record the answer here with its date.

- **Step the implementer down to `high`** if the 5-hour window or the all-models week, and not the Fable week, is what stops the loop, or if milestones take too long. By Anthropic's figures, `high` should take 60% to 66% less of both. It changes nothing on the Fable meter.
  - Until milestone 2, this entry said: step down if `xhigh` costs more than Fable 5.2 at `high` did, about $19 for milestone 1. Milestone 2's implementer cost $20.35, for different work, so by the letter that was met. It was put to the owner on 2026-11-16, with the advice to stay at `xhigh`, because the plan doesn't count Opus 5.5 at its list price (section 5). The choice in section 1 stands unless the owner changes it.
- **Reconsider Opus 5.5 for the implementer** if its pull requests need a second review more often than not. So far one of its three has: milestone 4, which took five (section 2).
  - After its third review, on 2026-11-16, this was put to the owner, with the advice to keep the implementer and tell it to close the whole kind of problem, not the next case. The proposal had four rules: limit what is accepted; put back what git doesn't record; fail the run, don't stop the runner; make the clean-up unstoppable. The owner agreed on 2026-11-17 ("yes"), and the loop gave that to milestone 4's next implementer as the owner's answer. `docs/DECISIONS.md` 4.7 quotes it.
  - What came of it: the next review found two more cases, both ways to stop the clean-up, which the fourth rule was meant to rule out. After one fix, the review after that found none, and approved. Without the instruction, three reviews weren't enough. With it, two were.
  - So when a pull request keeps failing its review on new cases of one kind, name the kind and the rules that close it, and give them to the implementer as the answer to a question (the loop's `question` and `answer` arguments). Try that before a change of model.
- **Milestones 7 and 8, the sandbox and the network policy, keep the choices of section 1.** A defect there is a hole in the security boundary, so whether they need a stronger implementer stayed open until milestone 4 was merged.
  - On 2026-11-17 an alternative was put to the owner: Fable 5.2 at `high` as their implementer, about $20 of Fable use for each, against fewer rounds of review if it foresees more. The owner read that as a claim that Opus 5.5 can't design a solution there that rules out edge cases as a whole. The evidence doesn't support that claim. In milestone 4's first run nobody had asked it to, and Fable 5.2 has built no work of this kind here to compare it with. The suggestion was withdrawn the same day.
  - Milestone 4's second run was the test, and its result is above. Asked to, Opus 5.5 closed the kind of problem, in two reviews and not in one. So allow for one round of a fix and a review in each of 7 and 8, at $15 to $24. The loop's limit of 3 reviews leaves room for it.
  - Their implementers get the instruction from the plan, which every implementer reads. Milestone 7 there has the rule "Nothing pi does may stop the runner", with the two ways that remain for the sandbox to close. Milestone 8 has the case that the third review of milestone 4 found for it. The fifth review left it one more, the size of the network log, as a smaller point for a later implementer to settle.
  - If the pull request of 7 or 8 isn't approved in three reviews, the loop stops. That is the evidence to put to the owner then.

## 7. Keeping this file up to date

When a milestone is merged, add a row to section 3 for each of its agents, and say what the review found. Change sections 2 and 6 where the new rows change the argument.

How the rows are measured:

- Each agent of the loop leaves a transcript on the machine that runs it, at `~/.claude/projects/<the checkout's path, with every / written as ->/<session ID>/subagents/workflows/<run ID>/agent-<ID>.jsonl`. The `journal.jsonl` beside it says which agent had which label.
- Time runs from the agent's first request to its last response.
- Cost is the sum, over the agent's responses, of the tokens in `message.usage`, at the prices below per million tokens. Several records can share one message ID: count each response once.
- Each response's record also names its model and effort level (`requestedModel` and `effort`). Check them, because the run's summary gives the model only.
- To see how the plan counted a run, read the meters just before and just after it, and sum what every session used between the two readings, by model.

| Model | Input | Output | Cache read | Cache write, 5 minutes | Cache write, 1 hour |
|---|---|---|---|---|---|
| Fable 5.2 | $8 | $40 | $0.20 | $10 | $16 |
| Opus 5.5 | $4 | $20 | $0.20 | $5 | $8 |
