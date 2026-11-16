export const meta = {
  name: 'scooter-milestone-loop',
  description: 'Build Scooter v2 one milestone at a time: implement, open a pull request, review, fix, merge',
  whenToUse: 'Run from a checkout of this repository on the Linux machine, with gh signed in. Covers milestones 0 to 13 of docs/plans/active/v2-linux-implementation.md.',
  phases: [
    { title: 'Progress' },
    { title: 'Milestone 0: check the tools' },
    { title: 'Milestone 1: foundations and the datastore' },
    { title: 'Milestone 2: bridge intake, WhatsApp' },
    { title: 'Milestone 3: runner, planning' },
    { title: 'Milestone 4: runner, running' },
    { title: 'Milestone 5: delivery and commands' },
    { title: 'Milestone 6: email' },
    { title: 'Milestone 7: sandbox and VM image' },
    { title: 'Milestone 8: network policy and log' },
    { title: 'Milestone 9: rebuild and backfill' },
    { title: 'Milestone 10: backups' },
    { title: "Milestone 11: the agent's instructions" },
    { title: 'Milestone 12: native install' },
    { title: 'Milestone 13: Docker' },
  ],
}

// The loop, for each milestone in order:
//   1. an implementing agent builds it on the branch `milestone-<n>` and opens a pull request against `main`;
//   2. a reviewing agent checks the pull request and posts its review as a comment on it;
//   3. if the review asks for changes, the implementing side fixes them and the review runs again,
//      for at most `maxRounds` reviews;
//   4. once approved, the pull request is merged into `main`, and the next milestone starts from there.
//
// A review can approve and still note smaller points. So that they aren't lost, each implementing
// agent reads the reviews on the pull requests merged before its own, settles the points that are
// still open, and records in docs/DECISIONS.md which it settled and which it left.
//
// The loop stops, and returns why, when an agent has a question for the owner, when a step needs the
// owner (the plan's gates), when a pull request isn't approved within `maxRounds` reviews, or when a
// merge fails. To go on, run it again: it skips the milestones whose pull request is already merged.
// Pass the question it stopped on as `question` and the owner's reply as `answer`. Both go to the
// implementing agent of the milestone that stopped. Every agent is new and remembers nothing, so
// each one picks the work up from the branch, the pull request's description and its reviews.
//
// Args, all optional:
//   from, to    first and last milestone to run (default 0 and 13; 14 needs the owner, so it isn't run)
//   maxRounds   reviews per milestone before the loop stops and asks (default 3)
//   merge       false leaves approved pull requests for the owner to merge (default true)
//   question    the question that stopped the last run, as the loop returned it
//   answer      the owner's reply to it
//   coder       options for the implementing agents, such as { model: 'opus' } or { agentType: '...' }
//   reviewer    the same, for the reviewing agents
//   dryRun      true starts no agent: it returns the milestones it would run and the prompts it would send
//
// Which model and effort level to pass as coder and reviewer, and the evidence for the choice, are in
// docs/plans/active/v2-linux-implementation/model-and-effort.md.
//
// It lives here, and not under .claude/workflows/, because this repository's .gitignore leaves .claude/ out.

const NAMES = [
  'check the tools',
  'foundations and the datastore',
  'bridge intake, WhatsApp',
  'runner, planning',
  'runner, running',
  'delivery and commands',
  'email',
  'sandbox and VM image',
  'network policy and log',
  'rebuild and backfill',
  'backups',
  "the agent's instructions",
  'native install',
  'Docker',
]
const LAST = NAMES.length - 1
const title = n => `Milestone ${n}: ${NAMES[n]}`

const cfg = Object.assign(
  { from: 0, to: LAST, maxRounds: 3, merge: true, question: '', answer: '', coder: {}, reviewer: {}, dryRun: false },
  args || {},
)
if (!Number.isInteger(cfg.from) || !Number.isInteger(cfg.to) || cfg.from < 0 || cfg.from > cfg.to) {
  throw new Error('from and to must be whole numbers, with 0 <= from <= to')
}
if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1) {
  throw new Error('maxRounds must be a whole number, 1 or more')
}
if (cfg.to > LAST) {
  log(`Milestones after ${LAST} need the owner. Stopping at ${LAST}.`)
  cfg.to = LAST
}

const BASE = 'main'
const PLAN = 'docs/plans/active/v2-linux-implementation.md'
const READ = `Read \`docs/DESIGN.md\`, \`docs/ARCHITECTURE.md\`, \`${PLAN}\`, and \`docs/DECISIONS.md\` if it exists.`
const DONE = '"Every milestone is done when" in section 2 of the plan'
const ASK =
  'If anything is ambiguous, or is an open-ended decision you cannot settle by reasoning from the plan and the other documents, stop and return it as a question. Do not guess.'

const implementPrompt = (n, question, answer) =>
  [
    `Implement milestone ${n} (${NAMES[n]}) of \`${PLAN}\`.`,
    `${READ} Then build what the milestone lists, until it meets ${DONE}.`,
    `Also read the reviews on the pull requests already merged into \`${BASE}\`. Settle the smaller points in them that are still open, and record in \`docs/DECISIONS.md\` which you settled and which you left.`,
    `Work on the branch \`milestone-${n}\`, cut from the latest \`origin/${BASE}\`, and open a pull request against \`${BASE}\` titled "${title(n)}". If the branch or the pull request already exists, read the pull request's description and its reviews, and continue from there.`,
    "In the pull request's description, also say what you decided and why, for the agent that works on it after you.",
    `${ASK} Where the plan says a step needs the owner, finish what doesn't depend on it, push, and return what you need as a question.`,
    answer
      ? [
          'This milestone stopped earlier on a question for the owner. Record the question and the answer in `docs/DECISIONS.md`, and go on from the answer.',
          question ? `The question:\n${question}` : '',
          `The owner's answer:\n${answer}`,
        ]
          .filter(Boolean)
          .join('\n\n')
      : '',
    'Return the pull request number, and in two or three sentences what you did and what you could not verify.',
  ]
    .filter(Boolean)
    .join('\n\n')

const reviewPrompt = (n, pr) =>
  [
    `Review pull request #${pr}, which implements milestone ${n} (${NAMES[n]}) of \`${PLAN}\`.`,
    `${READ} Check the pull request out exactly as pushed, in a clean checkout that you remove afterwards. Run what the milestone says to run, and judge the work against the milestone and ${DONE}. Do not change the code.`,
    'If the pull request already has reviews, check that each point in them was fixed, or answered with a good reason.',
    'Post the review as one comment on the pull request. List each problem that must be fixed before merging, with its file and line and what would settle it. Note smaller points separately. End with a line that reads `Verdict: approve` or `Verdict: changes requested`. Approve only when nothing must be fixed.',
    ASK,
  ].join('\n\n')

const fixPrompt = (n, pr) =>
  [
    `Pull request #${pr} implements milestone ${n} (${NAMES[n]}) of \`${PLAN}\`. Its latest review asks for changes.`,
    `${READ} Read the pull request's description and its reviews. Fix what is right. Where you disagree, reply on the pull request with your reason instead of changing the code. Push to the same branch, \`milestone-${n}\`, and add a comment that lists what you changed.`,
    ASK,
    'Return in two or three sentences what you changed and what you left.',
  ].join('\n\n')

// The merge command runs by itself. In auto mode the safety check can deny a merge that a workflow
// agent runs. A permission rule that allows `gh pr merge`, in the checkout's
// .claude/settings.local.json, lets it through, but a rule covers a chained command only when
// every part of the chain is allowed.
const mergePrompt = pr =>
  `Merge pull request #${pr} into \`${BASE}\` with a merge commit (\`gh pr merge ${pr} --merge\`). Run that command by itself, with nothing chained to it. Then bring the local \`${BASE}\` up to date with \`origin/${BASE}\`. Do nothing else. Return whether it merged, and the error if it did not.`

const PROGRESS = {
  type: 'object',
  properties: { merged: { type: 'array', items: { type: 'integer' } } },
  required: ['merged'],
}
const WORK = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'question'] },
    pr: { type: 'integer' },
    summary: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['status', 'summary'],
}
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes', 'question'] },
    summary: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['verdict', 'summary'],
}
const MERGE = {
  type: 'object',
  properties: { merged: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['merged'],
}

if (cfg.dryRun) {
  log('Dry run: no agent is started')
  const milestones = []
  for (let n = cfg.from; n <= cfg.to; n++) milestones.push(title(n))
  return {
    status: 'dry run',
    milestones,
    maxRounds: cfg.maxRounds,
    merge: cfg.merge,
    prompts: {
      implement: implementPrompt(cfg.from, cfg.question, cfg.answer),
      review: reviewPrompt(cfg.from, 0),
      fix: fixPrompt(cfg.from, 0),
      merge: mergePrompt(0),
    },
  }
}

phase('Progress')
const progress = await agent(
  `List the pull requests already merged into \`${BASE}\` whose branch is named \`milestone-<number>\` (\`gh pr list --state merged --base ${BASE} --limit 100 --json headRefName\`). Return the numbers. Change nothing.`,
  { label: 'progress', effort: 'low', schema: PROGRESS },
)
if (!progress) {
  return { status: 'stopped', stage: 'progress', reason: 'could not read the merged pull requests', finished: [] }
}
const merged = new Set(progress.merged)

const finished = []
let question = cfg.question
let answer = cfg.answer

for (let n = cfg.from; n <= cfg.to; n++) {
  if (merged.has(n)) {
    log(`${title(n)}: already merged, skipped`)
    continue
  }
  phase(title(n))
  const stop = (stage, reason, more) => {
    log(`${title(n)}: stopped at ${stage} (${reason})`)
    return Object.assign({ status: 'stopped', milestone: n, stage, reason }, more || {}, { finished })
  }

  const work = await agent(implementPrompt(n, question, answer), {
    ...cfg.coder,
    label: `m${n} implement`,
    schema: WORK,
  })
  question = ''
  answer = ''
  if (!work) return stop('implement', 'the agent returned nothing')
  if (work.status === 'question') {
    return stop('implement', 'question for the owner', { question: work.question || work.summary, pr: work.pr })
  }
  if (!Number.isInteger(work.pr)) {
    return stop('implement', 'no pull request number came back', { summary: work.summary })
  }
  const pr = work.pr

  let approved = false
  let reviews = 0
  while (reviews < cfg.maxRounds) {
    reviews++
    const review = await agent(reviewPrompt(n, pr), {
      ...cfg.reviewer,
      label: `m${n} review ${reviews}`,
      schema: REVIEW,
    })
    if (!review) return stop('review', 'the agent returned nothing', { pr })
    if (review.verdict === 'question') {
      return stop('review', 'question for the owner', { question: review.question || review.summary, pr })
    }
    if (review.verdict === 'approve') {
      approved = true
      break
    }
    log(`${title(n)}: review ${reviews} asks for changes`)
    if (reviews === cfg.maxRounds) break

    const fix = await agent(fixPrompt(n, pr), {
      ...cfg.coder,
      label: `m${n} fix ${reviews}`,
      schema: WORK,
    })
    if (!fix) return stop('fix', 'the agent returned nothing', { pr })
    if (fix.status === 'question') {
      return stop('fix', 'question for the owner', { question: fix.question || fix.summary, pr })
    }
  }
  if (!approved) {
    return stop('review', `not approved after ${cfg.maxRounds} reviews`, { pr })
  }
  if (!cfg.merge) {
    return stop('merge', 'approved; merging is turned off, so merge it and run again', { pr })
  }

  const result = await agent(mergePrompt(pr), { label: `m${n} merge`, effort: 'low', schema: MERGE })
  if (!result || !result.merged) {
    return stop('merge', 'the merge did not go through', { pr, detail: result ? result.detail : '' })
  }
  finished.push({ milestone: n, pr, reviews })
  log(`${title(n)}: merged as #${pr} after ${reviews} review${reviews === 1 ? '' : 's'}`)
}

return { status: 'done', finished }
