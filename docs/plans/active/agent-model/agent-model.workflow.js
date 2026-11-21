export const meta = {
  name: 'scooter-agent-model',
  description: "Build Scooter's simpler agent model in nine pieces, each a pull request: implement, review, fix, merge",
  whenToUse:
    "Run from the owner's Linux machine, with the checkout at ~/scooter and gh signed in. Covers pieces 1 to 9 of docs/plans/active/agent-model/agent-model.md.",
  phases: [
    { title: 'Progress' },
    { title: 'Piece 1: day pages and once go' },
    { title: 'Piece 2: the commands go, and scooter status comes' },
    { title: 'Piece 3: the datastore: two checks, and data' },
    { title: 'Piece 4: what an agent may read, write and send' },
    { title: 'Piece 5: the index file and show' },
    { title: 'Piece 6: send and mark, in place of the answer' },
    { title: 'Piece 7: prompts in agents.yaml, and what a run is given' },
    { title: 'Piece 8: scooter backfill, in place of the trigger and rebuild' },
    { title: 'Piece 9: the frame, the README, and a last check' },
  ],
}

// The loop, for each piece in order:
//   1. an implementing agent builds it on the branch `agent-model-<n>` and opens a pull request against `main`;
//   2. a reviewing agent checks the pull request and posts its review as a comment on it;
//   3. if the review asks for changes, a fixing agent fixes them and the review runs once more:
//      there are at most `maxRounds` reviews, two unless the args say otherwise;
//   4. once approved, the pull request is merged into `main`, and the next piece starts from there.
//
// The prompts give only the role, the piece's number, the pull request's number and the plan's path.
// Everything else is in the plan, docs/plans/active/agent-model/agent-model.md, which every agent
// reads whole: what each piece covers, what each role does, and how to run things on this machine.
//
// The loop stops, and returns why, when an agent has a question for the owner, when an agent returns
// nothing, which is how a usage limit shows, when a pull request isn't approved within `maxRounds`
// reviews, or when a merge fails. After a usage limit, resume the same run with resumeFromRunId and
// the same args. To go on after a question, run it again: it skips the pieces whose pull request is
// already merged. Pass the question it stopped on as `question` and the owner's reply as `answer`.
// Both go to the implementing agent of the piece that stopped. Every agent is new and remembers
// nothing, so each picks the work up from the plan, the branch, the pull request's description and
// its comments.
//
// Args, all optional:
//   from, to    first and last piece to run (default 1 and 9)
//   maxRounds   reviews per piece before the loop stops and asks (default 2)
//   merge       false leaves approved pull requests for the owner to merge (default true)
//   question    the question that stopped the last run, as the loop returned it
//   answer      the owner's reply to it
//   dryRun      true starts no agent: it returns the pieces it would run, the agents' models and
//               the prompts it would send
//
// The owner's brief of 2026-11-21 sets the models and the limit: implementing and fixing run on
// Opus 5.5 (model 'opus'), reviewing on Fable 5.2 (model 'fable'), each at effort 'xhigh'; and a piece
// gets at most two reviews, where the earlier loops allowed three. Listing and merging, a command or
// two each, run on Opus 5.5 at 'low'. What the implementing model gets wrong, and what a plan can say
// to prevent it, is in docs/plans/implementer-mistakes.md.
//
// It is modelled on docs/plans/completed/docs-restructure/docs-restructure.workflow.js and keeps what
// that loop and the one before it learned: the merge command runs by itself; a first agent lists what
// is merged, so that a run started again skips it; an agent that returns nothing stops the loop.

const NAMES = {
  1: 'day pages and once go',
  2: 'the commands go, and scooter status comes',
  3: 'the datastore: two checks, and data',
  4: 'what an agent may read, write and send',
  5: 'the index file and show',
  6: 'send and mark, in place of the answer',
  7: 'prompts in agents.yaml, and what a run is given',
  8: 'scooter backfill, in place of the trigger and rebuild',
  9: 'the frame, the README, and a last check',
}
const FIRST = 1
const LAST = 9
const title = n => `Piece ${n}: ${NAMES[n]}`
const branchOf = n => `agent-model-${n}`

const cfg = Object.assign(
  { from: FIRST, to: LAST, maxRounds: 2, merge: true, question: '', answer: '', dryRun: false },
  args || {},
)
if (!Number.isInteger(cfg.from) || !Number.isInteger(cfg.to) || cfg.from < FIRST || cfg.from > cfg.to) {
  throw new Error(`from and to must be whole numbers, with ${FIRST} <= from <= to`)
}
if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1) {
  throw new Error('maxRounds must be a whole number, 1 or more')
}
if (cfg.to > LAST) {
  log(`The plan ends at piece ${LAST}. Stopping there.`)
  cfg.to = LAST
}

const BASE = 'main'
const PLAN = 'docs/plans/active/agent-model/agent-model.md'
const CODER = { model: 'opus', effort: 'xhigh' }
const REVIEWER = { model: 'fable', effort: 'xhigh' }
const STEP = { model: 'opus', effort: 'low' }
const READ = `Read \`${PLAN}\`, in the checkout at \`~/scooter\`, whole, and do what it says for your role and this piece.`

const progressPrompt = `List the pull requests already merged into \`${BASE}\` of the repository in \`~/scooter\` whose branch is named \`agent-model-<number>\`: run \`gh pr list --state merged --base ${BASE} --limit 100 --json number,headRefName\` by itself, in that folder. Return the piece numbers. Change nothing.`

const implementPrompt = (n, question, answer) =>
  [
    `You are the implementer of piece ${n} of \`${PLAN}\`, on the branch \`${branchOf(n)}\`. ${READ}`,
    answer
      ? [
          "This piece stopped earlier on a question for the owner. Put the question and the owner's answer in the pull request's description, and go on from the answer.",
          question ? `The question:\n${question}` : '',
          `The owner's answer:\n${answer}`,
        ]
          .filter(Boolean)
          .join('\n\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')

const reviewPrompt = (n, pr, round, rounds) =>
  `You are the reviewer of pull request #${pr}, piece ${n} of \`${PLAN}\`. This is review ${round} of at most ${rounds}. ${READ}`

const fixPrompt = (n, pr) =>
  `You are the fixer of pull request #${pr}, piece ${n} of \`${PLAN}\`, on the branch \`${branchOf(n)}\`. Its latest review asks for changes. ${READ}`

// The merge command runs by itself. In auto mode the safety check can deny a merge that a workflow
// agent runs. A permission rule that allows `gh pr merge`, in the settings the session reads, lets
// it through, but a rule covers a chained command only when every part of the chain is allowed. A
// merge that is denied stops the loop: nothing works around it.
const mergePrompt = pr =>
  `Merge pull request #${pr} into \`${BASE}\` with a merge commit: in \`~/scooter\`, run \`gh pr merge ${pr} --merge\` by itself, with nothing chained to it. If it is denied or fails, don't try another way: return the error. If it merged, bring the local \`${BASE}\` of the checkout at \`~/scooter\` up to date with \`origin/${BASE}\`. Do nothing else. Return whether it merged, and the error if it did not.`

const PROGRESS = {
  type: 'object',
  properties: {
    merged: {
      type: 'array',
      items: { type: 'integer' },
      description: 'The numbers of the pieces whose pull request is merged',
    },
  },
  required: ['merged'],
}
const WORK = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['ready', 'question'],
      description: "'ready' when your work is pushed and the pull request is ready for review; 'question' when you stopped on a question for the owner",
    },
    pr: { type: 'integer', description: 'The pull request number, once it exists' },
    summary: { type: 'string', description: 'Two or three sentences: what you did, and what you could not verify' },
    question: {
      type: 'string',
      description: 'For the owner, when status is question: every question, each with what you found and the choices you see',
    },
  },
  required: ['status', 'summary'],
}
const REVIEW = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['approve', 'changes', 'question'],
      description: "'approve' or 'changes', as the comment you posted ends; 'question' when the owner must decide something first",
    },
    summary: { type: 'string', description: 'Two or three sentences: what you checked, and what must be fixed' },
    question: { type: 'string', description: 'For the owner, when the verdict is question' },
  },
  required: ['verdict', 'summary'],
}
const MERGE = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    detail: { type: 'string', description: 'The error, if it did not merge' },
  },
  required: ['merged'],
}

if (cfg.dryRun) {
  log('Dry run: no agent is started')
  const pieces = []
  for (let n = cfg.from; n <= cfg.to; n++) pieces.push(title(n))
  return {
    status: 'dry run',
    pieces,
    maxRounds: cfg.maxRounds,
    merge: cfg.merge,
    agents: { progress: STEP, implement: CODER, review: REVIEWER, fix: CODER, merge: STEP },
    prompts: {
      progress: progressPrompt,
      implement: implementPrompt(cfg.from, cfg.question, cfg.answer),
      review: reviewPrompt(cfg.from, 0, 1, cfg.maxRounds),
      fix: fixPrompt(cfg.from, 0),
      merge: mergePrompt(0),
    },
  }
}

phase('Progress')
const progress = await agent(progressPrompt, { ...STEP, label: 'progress', schema: PROGRESS })
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
    return Object.assign({ status: 'stopped', piece: n, stage, reason }, more || {}, { finished })
  }

  const work = await agent(implementPrompt(n, question, answer), { ...CODER, label: `p${n} implement`, schema: WORK })
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
  let lastReview = ''
  while (reviews < cfg.maxRounds) {
    reviews++
    const review = await agent(reviewPrompt(n, pr, reviews, cfg.maxRounds), { ...REVIEWER, label: `p${n} review ${reviews}`, schema: REVIEW })
    if (!review) return stop('review', 'the agent returned nothing', { pr, reviews })
    lastReview = review.summary
    if (review.verdict === 'question') {
      return stop('review', 'question for the owner', { question: review.question || review.summary, pr, reviews })
    }
    if (review.verdict === 'approve') {
      approved = true
      break
    }
    log(`${title(n)}: review ${reviews} asks for changes`)
    if (reviews === cfg.maxRounds) break

    const fix = await agent(fixPrompt(n, pr), { ...CODER, label: `p${n} fix ${reviews}`, schema: WORK })
    if (!fix) return stop('fix', 'the agent returned nothing', { pr, reviews })
    if (fix.status === 'question') {
      return stop('fix', 'question for the owner', { question: fix.question || fix.summary, pr, reviews })
    }
  }
  if (!approved) {
    return stop('review', `not approved after ${cfg.maxRounds} reviews`, { pr, reviews, lastReview })
  }
  if (!cfg.merge) {
    return stop('merge', 'approved; merging is turned off, so merge it and run again', { pr, reviews })
  }

  const result = await agent(mergePrompt(pr), { ...STEP, label: `p${n} merge`, schema: MERGE })
  if (!result || !result.merged) {
    return stop('merge', 'the merge did not go through', { pr, reviews, detail: result ? result.detail : '' })
  }
  finished.push({ piece: n, pr, reviews })
  log(`${title(n)}: merged as #${pr} after ${reviews} review${reviews === 1 ? '' : 's'}`)
}

return { status: 'done', finished }
