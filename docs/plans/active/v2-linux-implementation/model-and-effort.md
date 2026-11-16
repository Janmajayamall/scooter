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

- The implementer is where the cost is: 71% of milestone 1 and 68% of milestone 2 (section 3).
- The tightest limit is the weekly allowance for Fable (section 5). Milestone 1, all on Fable 5.2, took $26 of it. Milestone 2, with the implementer on Opus 5.5, took $9.46, for the review and the merge.
- On the two meters that Opus 5.5 shares with Fable 5.2, its use counted for less than half its list price (section 5).
- Its first pull request was approved on the first review, with 7 smaller points. The two from Fable 5.2 had 7 and 8.
- At list prices it was no cheaper than Fable 5.2 at `high`: $20.35 for milestone 2, against $18.59 for milestone 1, which was different work. The two wrote about as much, 234,000 output tokens against 228,000. But Opus 5.5 at `xhigh` made 143 requests where Fable 5.2 made 66, and each request reads the context so far from the cache: 52.8 million tokens against 19.2 million. Cache reads cost the same on both models, and they were 52% of its bill.
- Why not `high`: by Anthropic's figures (section 4), Opus 5.5 at `high` is 0.8 and 5.1 points under Fable 5.2 at `high` on the two coding benchmarks. At `xhigh` it is level on one and 2.4 under on the other. `high` should cost 34% to 40% of `xhigh`, but the saving would fall on the meters that have room. A weak implementation costs a second review, about $9 of the Fable allowance, and a defect that passes review is built on by the next milestone. `high` hasn't been tried here.
- Why not `max`: Anthropic publishes no comparison for Opus 5.5 at `max`. Its guidance for Fable 5.2 says that `max` costs more and runs slower than `xhigh`, often for a small gain. The one `max` run here, milestone 0's implementer on Fable 5.2, spent the most per hour.

**The reviewer: Fable 5.2 at `high`.**

- The review is the only check of the code before it is merged.
- Fable 5.2 at `high` finds the most planted defects in Anthropic's test: it scores 0.909, against 0.850 for Opus 5.5 at `high`, and its range of scores lies above every other configuration's.
- A review costs $7 to $9 here, a quarter to a third of a milestone. With the implementer on Opus 5.5, it is nearly all that a milestone takes from the Fable allowance.
- All three reviews approved, with 7, 8 and 7 smaller points. Some of the points mattered:
  - One led the owner to change the send interval (`docs/DECISIONS.md`).
  - The review of milestone 2 read wacli's source, and found that a deletion by the owner would probably be dropped as the bot's own. Tests against a stub can't show that.
  - It also ran the new tests 64 times and saw one fail twice, where the implementer had run them 16 times and seen no failure.
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

- Milestone 1 as a whole: $26.00 in 51 minutes, about $31 an hour, all on Fable 5.2.
- Milestone 2 as a whole: $29.81 in 64 minutes, about $28 an hour. $9.46 of it was on Fable 5.2.
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

How Opus 5.5 counts, from the meters read before and after milestone 2. Between the two readings, about $14 of Fable 5.2 use and $18 of Opus 5.5 use moved the meters by 23, 5 and 4 points.

- Opus 5.5 doesn't count on the Fable meter. The Fable use alone accounts for that meter's 5 points.
- On the other two meters, the Opus use counted for about $8 of its $18. That is one reading of whole percentages, so take it as between a third and a half of the list price.

What follows:

- A milestone like milestone 2 takes about 20 points of a 5-hour window, 3.6 of the Fable week and 3.4 of the all-models week. Milestone 1, all on Fable 5.2, took about 27, 9.4 and 4.7.
- A 5-hour window sustains about 20 points an hour. The loop with an Opus 5.5 implementer uses about 19, so one window after another just carries it.
- The eleven milestones from 3 to 13 would take about 40 points of a Fable week. The owner's own sessions use the same allowance.
- The weekly meters reset on Tuesdays at 19:00 UTC.

## 6. What would change a choice

A change to section 1 is the owner's decision. Put the evidence to the owner, and record the answer here with its date.

- **Step the implementer down to `high`** if the 5-hour window or the all-models week, and not the Fable week, is what stops the loop, or if milestones take too long. By Anthropic's figures, `high` should take 60% to 66% less of both. It changes nothing on the Fable meter.
  - Until milestone 2, this entry said: step down if `xhigh` costs more than Fable 5.2 at `high` did, about $19 for milestone 1. Milestone 2's implementer cost $20.35, for different work, so by the letter that was met. It was put to the owner on 2026-11-16, with the advice to stay at `xhigh`, because the plan doesn't count Opus 5.5 at its list price (section 5). The choice in section 1 stands unless the owner changes it.
- **Reconsider Opus 5.5 for the implementer** if its pull requests need a second review more often than not. So far none has: two from Fable 5.2 and one from Opus 5.5 were approved on the first review.
- **Open:** whether milestones 7 and 8, the sandbox and the network policy, need more than the rest. A defect there is a hole in the security boundary. Decide from what the reviews of milestones 2 to 6 find.

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
