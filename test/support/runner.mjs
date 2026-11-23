// Fixtures for the runner's planning: a datastore written from lines, a config folder with
// `agents.yaml`, its prompt and skills, and the example prompt of the runner's document as data.

import fs from 'node:fs'
import path from 'node:path'
import { checkLine } from '../../src/common/datastore/line.mjs'
import { createIndex } from '../../src/common/datastore/index.mjs'
import { dayOfDate } from '../../src/common/paths.mjs'

// Writes datastore lines into their day folders, as the bridge would have. A line's day folder is
// its `day` (`2026/11/09`), or else the UTC date of its `at`. Lines must be complete and in order,
// and pass the store's own check, but with `check: false`, for a datastore written by hand.
export function writeDatastore(paths, lines, { check = true } = {}) {
  for (const { day, ...line } of lines) {
    const problems = check ? checkLine(line) : []
    if (problems.length > 0) throw new Error(`fixture line ${line.seq}: ${problems.join('; ')}`)
    const folder = day ?? dayOfDate(line.at.slice(0, 10))
    fs.mkdirSync(paths.dayDir(folder), { recursive: true })
    fs.appendFileSync(paths.dayLog(folder), `${JSON.stringify(line)}\n`)
  }
}

// A datastore written by hand, as no version of the store writes it, among ordinary lines: one of a
// kind this version doesn't know (`command`, which an earlier version wrote), one of a channel that
// is gone, one with top-level fields this version doesn't know (the four that moved into `data`
// among them), a message without its text, and `data` of several wrong kinds. All on 9 November,
// before the runner's start in its tests. `writeDatastore` with `check: false` writes them.
export function handWrittenLines() {
  const at = minute => `2026-11-09T15:${String(minute).padStart(2, '0')}:00Z`
  const base = { dir: 'in', trust: 'owner' }
  return [
    { seq: 1, kind: 'message', ...base, at: at(30), source: 'whatsapp', sourceId: 'W1', text: 'coffee 150' },
    { seq: 2, kind: 'command', ...base, at: at(31), source: 'whatsapp', sourceId: 'C2', text: '/status' },
    { seq: 3, kind: 'message', ...base, at: at(32), source: 'telegram', sourceId: 'T3', text: 'hi' },
    { seq: 4, kind: 'message', ...base, at: at(33), source: 'whatsapp', sourceId: 'W4', note: 'later', quoted: 'top', forwarded: true, subject: 'x', emoji: '👍', text: 'lunch 300' },
    { seq: 5, kind: 'message', ...base, at: at(34), source: 'whatsapp', sourceId: 'W5' },
    { seq: 6, kind: 'message', ...base, at: at(35), source: 'email', sourceId: 'E6@mail.example', text: 'receipt', data: [] },
    { seq: 7, kind: 'message', ...base, at: at(36), source: 'email', sourceId: 'E7@mail.example', text: 'ticket', data: { subject: 7 } },
    { seq: 8, kind: 'message', ...base, at: at(37), source: 'whatsapp', sourceId: 'W8', text: 'tea', data: 'a string' },
    { seq: 9, kind: 'reaction', ...base, at: at(38), source: 'whatsapp', sourceId: 'R9', target: 1, data: null },
  ]
}

// An index of the lines, without files: for tests of pure functions.
export function indexOf(lines) {
  const index = createIndex()
  for (const { day, ...line } of lines) index.add(line, day ?? dayOfDate(line.at.slice(0, 10)))
  return index
}

// Lines 1 to `count`, the owner's messages on 8 November, to stand before a fixture's own.
export function fillerLines(count, { day = '2026/11/08' } = {}) {
  return Array.from({ length: count }, (_, n) => ({
    seq: n + 1,
    kind: 'message',
    dir: 'in',
    at: '2026-11-08T10:00:00Z',
    source: 'whatsapp',
    sourceId: `FILLER${n + 1}`,
    trust: 'owner',
    text: `filler ${n + 1}`,
    day,
  }))
}

// Builders of lines. `seq` and `at` are given; the rest has defaults.
let nextId = 0
const sourceId = () => `ID${++nextId}`
export const line = {
  text: (seq, at, text, extra = {}) => ({ seq, kind: 'message', dir: 'in', at, source: 'whatsapp', sourceId: sourceId(), trust: 'owner', text, ...extra }),
  sent: (seq, at, text, extra = {}) => ({ seq, kind: 'message', dir: 'out', at, source: 'whatsapp', sourceId: sourceId(), by: 'lifelog', text, ...extra }),
  edit: (seq, at, target, text) => ({ seq, kind: 'edit', dir: 'in', at, source: 'whatsapp', sourceId: sourceId(), trust: 'owner', target, text }),
  delete: (seq, at, target) => ({ seq, kind: 'delete', dir: 'in', at, source: 'whatsapp', sourceId: sourceId(), trust: 'owner', target }),
  reaction: (seq, at, target, emoji, extra = {}) => ({ seq, kind: 'reaction', dir: 'in', at, source: 'whatsapp', sourceId: sourceId(), trust: 'owner', target, data: { emoji }, ...extra }),
  email: (seq, at, subject, text, extra = {}) => ({ seq, kind: 'message', dir: 'in', at, source: 'email', sourceId: `${sourceId()}@mail.example`, trust: 'owner', text, data: { subject }, ...extra }),
}

// The skills of the default config.
export const SKILLS = ['expenses', 'runs', 'meals', 'travel', 'people']

// The prompt of the example's trigger for new messages, as `agents.yaml` gives it.
export const NEW_MESSAGES_PROMPT = `Now: $now$ ($user.timezone$). Home currency: $user.currency$. Reply mode: $reply_mode$. Internet: $internet$.
Your folder: $agent.dir$
The datastore: $datastore.dir$
This run may change: $run.writes$
New: $seq.unread$
Given before: $seq.retry$
`

// The prompt of the example's evening check-in, as YAML folds it.
export const CHECK_IN_PROMPT =
  'Now: $now$ ($user.timezone$). Reply mode: $reply_mode$. Evening check-in, a scheduled task from your configuration, not a message from the owner: send the owner, in a few lines, what you filed today, anything that looks missing, and the open questions.'

// The example `agents.yaml`, with the backfill entry when `backfill` is true.
export function exampleYaml({ backfill = false } = {}) {
  return `agents:
  lifelog:
    model: anthropic/claude-sonnet-5.5   # OpenRouter model ID; it must accept images
    thinking: low                        # optional: off, minimal, low, medium, high, xhigh, max
    prompt: prompts/lifelog.md           # paths are relative to /config
    skills:
      - skills/expenses
      - skills/runs
      - skills/meals
      - skills/travel
      - skills/people
    # What the agent's VM sees, and what it may change: paths relative to the data folder, a
    # folder ending in /. reads is optional, and is this when left out.
    reads: [datastore/, agents/lifelog/]
    writes: [agents/lifelog/views/, agents/lifelog/memory/]
    sends: [whatsapp]                    # the channels its messages may go out on; [] for none
    session: daily                       # daily or none
    reply_mode: quiet                    # quiet or confirm
    ack_reaction: "✅"                   # reaction on handled messages in quiet mode; "" for none
    timeout_minutes: 10
    # When the agent runs, and the message pi is given for each run, its prompt. The runner fills
    # in each $variable$ of a prompt: $now$, $user.timezone$, $user.currency$, $reply_mode$,
    # $internet$, $agent.dir$, $datastore.dir$, $seq.unread$, $seq.retry$ and $run.writes$.
    run:
      - on: new-messages                 # every batch of new messages
        channels: [whatsapp, email]      # from these channels
        prompt: |
${NEW_MESSAGES_PROMPT.trimEnd()
  .split('\n')
  .map(text => `          ${text}`)
  .join('\n')}
      - at: "21:30"                      # daily in SCOOTER_TZ; "Sun 18:00" for weekly
        tag: check-in                    # names the task in the log and in a notice of its failure
        prompt: >-
          Now: $now$ ($user.timezone$). Reply mode: $reply_mode$. Evening check-in, a scheduled
          task from your configuration, not a message from the owner: send the owner, in a few
          lines, what you filed today, anything that looks missing, and the open questions.
${backfill ? '      - backfill: people-1\n        skill: people\n        writes: [agents/lifelog/views/people.csv]\n' : ''}`
}

// Makes a config folder: `agents.yaml`, `prompts/lifelog.md`, and a folder with a `SKILL.md` for
// each skill. Returns the folder.
export function writeConfig(configDir, { yaml = exampleYaml(), skills = SKILLS, prompt = 'You are lifelog.\n' } = {}) {
  fs.mkdirSync(path.join(configDir, 'prompts'), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'prompts', 'lifelog.md'), prompt)
  for (const skill of skills) {
    fs.mkdirSync(path.join(configDir, 'skills', skill), { recursive: true })
    fs.writeFileSync(path.join(configDir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: The ${skill} view.\n---\n`)
  }
  fs.writeFileSync(path.join(configDir, 'agents.yaml'), yaml)
  return configDir
}

// ---------------------------------------------------------------------------------------------
// The example prompt

// 21:20 in Asia/Kolkata on Monday 9 November 2026.
export const EXAMPLE_NOW = '2026-11-09T15:50:30Z'

// The lines behind the example prompt, after 1,041 lines of filler. The owner's times are in
// Asia/Kolkata, UTC+5:30.
export function exampleLines() {
  return [
    ...fillerLines(1041),
    line.text(1042, '2026-11-09T07:12:00Z', '', { files: [{ path: '1042.jpg', mime: 'image/jpeg', bytes: 482113 }] }),
    line.sent(1043, '2026-11-09T07:13:00Z', 'Blue Tokai, ₹450 at 12:40: work or personal?', { replyTo: 1042 }),
    line.text(1044, '2026-11-09T08:00:00Z', 'lunch 300'),
    { ...line.reaction(1045, '2026-11-09T08:01:00Z', 1044, '✅'), dir: 'out', trust: undefined, by: 'lifelog' },
    line.text(1046, '2026-11-09T14:20:00Z', 'uber 340'),
    line.text(1047, '2026-11-09T14:32:00Z', 'ran 5k in 28 min'),
    line.reaction(1048, '2026-11-09T15:34:00Z', 1046, '👍'),
    line.sent(1049, '2026-11-09T15:35:00Z', 'Logged ₹340 Uber.'),
    line.text(1050, '2026-11-09T15:43:00Z', 'lunch with sam', { files: [{ path: '1050.jpg', mime: 'image/jpeg', bytes: 391022 }] }),
    line.text(1051, '2026-11-09T15:44:00Z', 'coffee 120'),
    line.text(1052, '2026-11-09T15:45:00Z', '', { files: [{ path: '1052.pdf', mime: 'application/pdf', name: 'ticket.pdf', bytes: 88123 }] }),
    line.text(1053, '2026-11-09T15:50:00Z', 'work', { replyTo: 1043, data: { quoted: 'Blue Tokai, ₹450 at 12:40: work or personal?' } }),
    line.edit(1054, '2026-11-09T15:52:00Z', 1051, 'coffee 150'),
  ].map(fixture => JSON.parse(JSON.stringify(fixture)))
}

// The state behind the example prompt: everything up to #1049 dealt with, and #1047 to be tried a
// second time.
export function exampleState() {
  return {
    cursor: 1049,
    retry: [{ seq: 1047, attempts: 1, due: '2026-11-09T14:33:30Z', reason: 'not marked' }],
    failed: [],
    backfillDone: [],
    scheduled: { '21:30': '2026-11-08' },
    lastRun: { at: '2026-11-09T14:32:30Z', ok: true, seqs: [1047], durationMs: 41000 },
  }
}

// The example prompt, the example's prompt for new messages filled in for the example's lines and
// state, with the data folder at `/data`, exactly as `docs/architecture/runner.md` shows it.
export const EXAMPLE_PROMPT = `Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.
Your folder: /data/agents/lifelog
The datastore: /data/datastore
This run may change: /data/agents/lifelog/views/ /data/agents/lifelog/memory/
New: 1050 1051 1052 1053 1054
Given before: 1047 (attempt 2 of 4)
`
