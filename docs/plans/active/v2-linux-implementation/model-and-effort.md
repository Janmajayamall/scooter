# Which model and effort level for which task

This file says which model, at which effort level, runs each kind of task while Scooter v2 is built by the milestone loop (`docs/plans/active/milestone-loop.workflow.js`), and what evidence each choice rests on. Read it before you start an agent for this plan. It is updated as milestones finish, and section 7 says how.

Two terms:

- **Effort level**, also called the thinking level: Claude Code's setting for how much a model thinks, calls tools and checks its own work. The levels are `low`, `medium`, `high`, `xhigh` and `max`.
- **Cost** is always at Anthropic's API list prices. The owner pays through a plan with usage limits, not by the token, but list prices are the one measure that compares models and levels. Section 5 ties them to the plan's limits.

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

- The implementer is where the cost is: 71% of milestone 1 (section 3).
- The tightest limit is the weekly allowance for Fable (section 5). On Fable 5.2 a milestone took about $26 of it. With the implementer on Opus 5.5 it should take about $7.50, for the review and the merge.
- By Anthropic's figures (section 4), Opus 5.5 at `xhigh` is level with Fable 5.2 at `high` on one coding benchmark and 2.4 points under it on the other, for 54% to 76% of the cost of a task.
- Why not `high`: there it is 0.8 and 5.1 points under Fable 5.2 at `high`. It costs about a quarter as much, but a weak implementation costs more than its own price. Each extra review takes about $7 of the Fable allowance, and a defect that passes review is built on by the next milestone.
- Why not `max`: Anthropic publishes no comparison for Opus 5.5 at `max`. Its guidance for Fable 5.2 says that `max` costs more and runs slower than `xhigh`, often for a small gain. The one `max` run here, milestone 0's implementer on Fable 5.2, spent the most per hour.
- Not yet known: how Opus 5.5 does on this project. Milestone 2 is its first run.

**The reviewer: Fable 5.2 at `high`.**

- The review is the only check of the code before it is merged.
- Fable 5.2 at `high` finds the most planted defects in Anthropic's test: it scores 0.909, against 0.850 for Opus 5.5 at `high`, and its range of scores lies above every other configuration's.
- A review costs $7 to $8 here, about a quarter of a milestone.
- Both reviews so far approved, with 7 and 8 smaller points. One of those points led the owner to change the send interval (`docs/DECISIONS.md`).
- Not tried: a cheaper reviewer. Fable 5.2 at `medium` scores 0.877 in that test for about a third less. It is worth trying only if the Fable allowance runs short.

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

- Milestone 1 as a whole: $26.00 in 51 minutes, about $31 an hour.
- Milestone 0's implementer at `max` spent about $41 an hour in its first run. The two milestones are different work, so this doesn't compare the two levels cleanly.
- By the ratios in section 4, an Opus 5.5 implementer would cost about $4 to $5 for a milestone like milestone 1 at `high`, and $10 to $14 at `xhigh`. That is an estimate until milestone 2 is measured.

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
- Anthropic's own advice is to measure the effort levels on your own work. Section 3 is that measurement.

## 5. The limits these choices work within

The owner's plan has three usage meters, and the app shows them only as percentages. On 2026-11-16, about $50 of use at list prices, all of it on Fable 5.2, moved them by 52, 18 and 9 points. So, roughly:

| Meter | The whole of it, at list prices |
|---|---|
| A 5-hour window | $100 |
| A week, Fable only | $300 |
| A week, all models | $600 |

- A 5-hour window sustains about $20 an hour.
- The weekly meters reset on Tuesdays at 19:00 UTC.
- Twelve milestones at $26 each on Fable 5.2 would take more than a week of the Fable allowance, which the owner's own sessions also use.
- Not yet checked: that Opus 5.5 stays off the Fable meter, and how the plan counts its tokens. Read the meters before and after milestone 2.

## 6. What would change a choice

A change to section 1 is the owner's decision. Put the evidence to the owner, and record the answer here with its date.

- **Step the implementer down to `high`** if at `xhigh` it costs more than Fable 5.2 at `high` did for work of the same size (about $19 for milestone 1), or takes much longer, and the reviews are no better for it.
- **Reconsider Opus 5.5 for the implementer** if its pull requests need a second review more often than not. Both pull requests from Fable 5.2 were approved on the first review.
- **Open:** whether milestones 7 and 8, the sandbox and the network policy, need more than the rest. A defect there is a hole in the security boundary. Decide from what the reviews of milestones 2 to 6 find.

## 7. Keeping this file up to date

When a milestone is merged, add a row to section 3 for each of its agents, and say what the review found. Change sections 2 and 6 where the new rows change the argument.

How the rows are measured:

- Each agent of the loop leaves a transcript on the machine that runs it, at `~/.claude/projects/<the checkout's path, with every / written as ->/<session ID>/subagents/workflows/<run ID>/agent-<ID>.jsonl`. The `journal.jsonl` beside it says which agent had which label.
- Time runs from the agent's first request to its last response.
- Cost is the sum, over the agent's responses, of the tokens in `message.usage`, at the prices below per million tokens. Several records can share one message ID: count each response once.

| Model | Input | Output | Cache read | Cache write, 5 minutes | Cache write, 1 hour |
|---|---|---|---|---|---|
| Fable 5.2 | $8 | $40 | $0.20 | $10 | $16 |
| Opus 5.5 | $4 | $20 | $0.20 | $5 | $8 |
