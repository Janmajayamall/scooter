// pi's answer (6.7 of DESIGN.md): what the runner reads in pi's final answer, and what it sends.
//
// The answer is pi's stdout, read line by line. These lines, after trimming, are instructions:
//
//   DONE: <seq> [<seq> …]      these items are handled; a `#` before a number is allowed
//   FAILED: <seq> <reason>     the agent can't handle this item
//   REPLY_TO: <seq>            the text after this line, up to the next REPLY_TO or the end, is
//                              one message, sent as a reply to <seq>
//   NO_REPLY                   send no text
//
// Every other line is message text. Text before the first `REPLY_TO` is a plain message. The
// protocol the agent follows, `protocol.md`, describes the same lines.

import { limits } from '../common/limits.mjs'

const DONE = /^DONE:(.*)$/
const FAILED = /^FAILED:\s*#?(\d+)(?:\s+(.*))?$/
const REPLY_TO = /^REPLY_TO:\s*#?(\d+)$/
const SEQ = /^#?(\d+)$/

// The reason an item is given when the agent wrote none.
export const NO_REASON = 'no reason given'

// Cuts a reason from outside the runner's code to one line of at most `REASON_MAX_CHARS`.
export function shortReason(text) {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  if (chars.length <= limits.REASON_MAX_CHARS) return line
  return `${chars.slice(0, limits.REASON_MAX_CHARS - 1).join('')}…`
}

// Parses an answer. Returns:
//
//   {
//     done: [seq],                       in the order given, each once
//     failed: [{ seq, reason }],         each once, the first reason given
//     messages: [{ replyTo, text }],     `replyTo` is null for plain text; empty texts are dropped
//     noReply,                           whether a NO_REPLY line was there
//     unreadable,                        how many instruction lines, or parts of them, weren't read
//   }
//
// An instruction that can't be read, such as `DONE: soon` or `FAILED:` without a number, is never
// sent as text: its line starts with the instruction's word, so it was meant as one.
export function parseAnswer(stdout) {
  const done = []
  const failed = []
  const messages = []
  let current = { replyTo: null, lines: [] }
  let noReply = false
  let unreadable = 0

  const close = () => {
    const text = current.lines.join('\n').trim()
    if (text !== '') messages.push({ replyTo: current.replyTo, text })
  }

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    let match
    if ((match = DONE.exec(line))) {
      for (const token of match[1].split(/[\s,]+/).filter(Boolean)) {
        const seq = SEQ.exec(token)
        if (!seq) unreadable += 1
        else if (!done.includes(Number(seq[1]))) done.push(Number(seq[1]))
      }
    } else if ((match = FAILED.exec(line))) {
      const seq = Number(match[1])
      if (!failed.some(entry => entry.seq === seq)) failed.push({ seq, reason: shortReason(match[2] ?? '') || NO_REASON })
    } else if ((match = REPLY_TO.exec(line))) {
      close()
      current = { replyTo: Number(match[1]), lines: [] }
    } else if (line === 'NO_REPLY') {
      noReply = true
    } else if (/^(DONE|FAILED|REPLY_TO):/.test(line)) {
      unreadable += 1
      // The text after it was meant as a message of its own, to a message it doesn't name.
      if (line.startsWith('REPLY_TO:')) {
        close()
        current = { replyTo: null, lines: [] }
      }
    } else {
      current.lines.push(raw.replace(/\r$/, ''))
    }
  }
  close()
  return { done, failed, messages, noReply, unreadable }
}

// What an answer does to the items of a batch: `{ done, failed, unknown }`. `done` is the set of
// items reported `DONE`, `failed` maps items reported `FAILED` to their reason, and `unknown` lists
// the numbers reported that weren't in the batch, which are ignored (6.7). An item reported both
// ways counts as failed: the agent said it couldn't handle it.
export function reportsOf(answer, batchSeqs) {
  const inBatch = new Set(batchSeqs)
  const unknown = []
  const failed = new Map()
  for (const { seq, reason } of answer.failed) {
    if (inBatch.has(seq)) failed.set(seq, reason)
    else unknown.push(seq)
  }
  const done = new Set()
  for (const seq of answer.done) {
    if (!inBatch.has(seq)) unknown.push(seq)
    else if (!failed.has(seq)) done.add(seq)
  }
  return { done, failed, unknown: [...new Set(unknown)].sort((a, b) => a - b) }
}

// The message a `REPLY_TO` quotes: the line `seq` names when it is a message; the message an edit
// or a deletion changes; and null for anything else, or a `seq` that doesn't exist, which is then
// sent without a quote (6.7).
export function replyTarget(index, seq) {
  const entry = index.get(seq)
  if (!entry) return null
  const { line } = entry
  if (line.kind === 'message') return seq
  if ((line.kind === 'edit' || line.kind === 'delete') && index.get(line.target)?.line.kind === 'message') return line.target
  return null
}

// The outbox entries an answer asks for (6.8 step 4), in order: its texts, then, in quiet mode, a
// reaction for each message reported `DONE` that no `REPLY_TO` answered.
//
// - `agent`: its `name`, `canMessage`, `replyMode` and `ackReaction`. With `can_message: false`
//   nothing is sent.
// - `about`: what a plain text answers: the batch's newest item, or null for a scheduled task,
//   whose text Scooter says on its own (5.3).
// - `done`: the items reported `DONE`, from `reportsOf`; none for a task.
//
// A `REPLY_TO` whose message doesn't exist is sent as plain text. A reaction goes only to a message
// that is still there: the owner has deleted one that isn't. Only the first `ANSWER_MAX_TEXTS`
// texts are sent (`droppedTexts` counts the rest), and a message whose reply was dropped gets its
// reaction.
export function answerEntries({ answer, agent, index, about = null, done = new Set() }) {
  if (!agent.canMessage) return []
  const entries = []
  const answered = new Set()
  if (!answer.noReply) {
    for (const message of answer.messages.slice(0, limits.ANSWER_MAX_TEXTS)) {
      const target = message.replyTo === null ? null : replyTarget(index, message.replyTo)
      const entry = { type: 'text', by: agent.name, text: message.text }
      if (target !== null) {
        entry.replyTo = target
        answered.add(target)
        answered.add(message.replyTo)
      } else if (about !== null) {
        entry.about = about
      }
      entries.push(entry)
    }
  }
  if (agent.replyMode === 'quiet' && agent.ackReaction !== '') {
    for (const seq of [...done].sort((a, b) => a - b)) {
      if (answered.has(seq) || index.get(seq)?.line.kind !== 'message' || index.current(seq)?.deletedIn !== null) continue
      entries.push({ type: 'react', by: agent.name, target: seq, emoji: agent.ackReaction })
    }
  }
  return entries
}

// How many of an answer's texts `answerEntries` leaves out for `ANSWER_MAX_TEXTS`.
export function droppedTexts(answer, agent) {
  if (!agent.canMessage || answer.noReply) return 0
  return Math.max(0, answer.messages.length - limits.ANSWER_MAX_TEXTS)
}
