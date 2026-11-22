// What a run leaves for the runner besides its files: the messages `send` queued and the marks
// `mark` wrote (`vm/bin/send.mjs`, `vm/bin/mark.mjs`), in the two places of `run/` the run may
// write besides its session:
//
//   run/send/1.json   {"text":"Is this ticket for you alone, or for Sam too?","replyTo":1052}
//   run/send/2.json   {"text":"Filed the coffee and the lunch."}
//   run/marks.txt     done 1050
//                     done 1051
//                     failed 1053 the PDF needs a password
//
// The runner reads them once a run has passed, and only then (`performRun` in `run.mjs`): what a
// run that failed queued goes nowhere, and what it marked settles nothing. Nothing in pi's output
// is read.
//
// pi wrote both, as root in its VM, so nothing in them may stop the runner, or hold it up: each
// file is read as one another program controls (`readUntrustedFile`), without following a link,
// only if it is a regular file with one name, and up to a limit; the folder is read as a stream, and
// only the first `RUN_MAX_SENDS` entries by their numbers are read at all; and anything that isn't
// what `send` or `mark` writes is passed over and counted, never thrown.

import fs from 'node:fs'
import path from 'node:path'
import { readUntrustedFile } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'

// The reason a line marked failed is given when the agent gave none.
export const NO_REASON = 'no reason given'

// Cuts a reason from outside the runner's code to one line of at most `REASON_MAX_CHARS`.
export function shortReason(text) {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  if (chars.length <= limits.REASON_MAX_CHARS) return line
  return `${chars.slice(0, limits.REASON_MAX_CHARS - 1).join('')}…`
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

// A `seq` as `mark` and `send` write it: a whole number from 1, without a leading zero, that is a
// safe integer. A number of 16 digits or more is none.
const SEQ = /^[1-9][0-9]{0,14}$/

// ---------------------------------------------------------------------------------------------
// The marks

// One line of the marks file, without its line break: `done <seq>` or `failed <seq> <reason>`.
// `s`, so `.` takes a carriage return or U+2028 in a reason.
const MARK = /^(done|failed) ([0-9]+)(?: (.*))?$/s

// Reads the marks file. Returns `{ done, failed, unreadable, refused }`: the numbers marked done,
// in order, each once; `{ seq, reason }` for each marked failed, the first reason given; how many
// lines aren't marks `mark` writes, half a line at the end among them; and, when the file isn't one
// to read, why, such as `EUNTRUSTED` for a link, a FIFO, a folder or a file with two names, `EFBIG`
// for one over `MARKS_MAX_BYTES`, or `EACCES`, and then no marks. No file is no marks.
export function readMarks(file) {
  const marks = { done: [], failed: [], unreadable: 0, refused: null }
  let text
  try {
    text = readUntrustedFile(file, { maxBytes: limits.MARKS_MAX_BYTES })
  } catch (error) {
    if (error.code !== 'ENOENT') marks.refused = error.code ?? error.name
    return marks
  }
  const done = new Set()
  const failed = new Set()
  const lines = text.split('\n')
  // What follows the last line break is half a line, which `mark` never leaves.
  if (lines.pop() !== '') marks.unreadable += 1
  for (const line of lines) {
    const match = MARK.exec(line)
    if (!match || !SEQ.test(match[2]) || (match[1] === 'done' && match[3] !== undefined)) {
      marks.unreadable += 1
      continue
    }
    const seq = Number(match[2])
    if (match[1] === 'done') done.add(seq)
    else if (!failed.has(seq)) {
      failed.add(seq)
      marks.failed.push({ seq, reason: match[3] ?? '' })
    }
  }
  marks.done = [...done]
  return marks
}

// What the marks do to the lines a run was given, `seqs`: `{ done, failed, unknown }`. `done` is the
// set of lines marked done, `failed` maps those marked failed to their reason, cut to one line of
// `REASON_MAX_CHARS`, and `unknown` lists the numbers marked that the run wasn't given, which are
// ignored. A line marked both ways is failed: the agent said it couldn't handle it.
export function marksOf(marks, seqs) {
  const given = new Set(seqs)
  const unknown = new Set()
  const failed = new Map()
  for (const { seq, reason } of marks.failed) {
    if (given.has(seq)) failed.set(seq, shortReason(reason) || NO_REASON)
    else unknown.add(seq)
  }
  const done = new Set()
  for (const seq of marks.done) {
    if (!given.has(seq)) unknown.add(seq)
    else if (!failed.has(seq)) done.add(seq)
  }
  return { done, failed, unknown: [...unknown].sort((a, b) => a - b) }
}

// ---------------------------------------------------------------------------------------------
// The messages to send

// An entry's name, as `send` gives it: its number, then `.json`.
const ENTRY = /^([1-9][0-9]{0,14})\.json$/

// Reads the messages `send` queued in the folder `dir`. Returns `{ messages, refused, past, error }`:
// `{ text, replyTo }` for each, `replyTo` null when it answers no line, in the order of their
// numbers; how many names or entries aren't what `send` writes; how many entries come after the
// first `RUN_MAX_SENDS`, which aren't read; and, when the folder can't be read at all, why, and
// then no messages. No folder is no messages.
//
// The folder is read as a stream, so a million names cost time and no memory, and only the first
// `RUN_MAX_SENDS` entries by their numbers are opened. Of those, one that isn't a regular file of
// at most `SEND_ENTRY_MAX_BYTES` holding what `send` writes, `{"text", "replyTo"}`, with a text
// that isn't blank and a `replyTo` that is a `seq`, is refused, and its place isn't taken by one
// after it. A text is made well formed: half of a pair of UTF-16 surrogates, which JSON can give
// and no channel can send, becomes U+FFFD.
export function readSends(dir) {
  const sends = { messages: [], refused: 0, past: 0, error: null }
  const kept = []
  try {
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory()) {
      sends.error = 'ENOTDIR'
      return sends
    }
    const folder = fs.opendirSync(dir, { encoding: 'buffer' })
    try {
      for (let entry; (entry = folder.readSync()) !== null; ) {
        const number = ENTRY.exec(entry.name.toString('latin1'))?.[1]
        if (number === undefined) {
          sends.refused += 1
          continue
        }
        // The first `RUN_MAX_SENDS` by their numbers, kept in order; the rest are counted.
        const found = { number: Number(number), name: entry.name.toString('latin1') }
        if (kept.length >= limits.RUN_MAX_SENDS && (kept.length === 0 || found.number > kept.at(-1).number)) {
          sends.past += 1
          continue
        }
        kept.splice(kept.findLastIndex(other => other.number < found.number) + 1, 0, found)
        if (kept.length > limits.RUN_MAX_SENDS) {
          kept.pop()
          sends.past += 1
        }
      }
    } finally {
      folder.closeSync()
    }
  } catch (error) {
    if (error.code === 'ENOENT') return sends
    sends.error = error.code ?? error.name
    return sends
  }
  for (const { name } of kept) {
    const message = readSend(path.join(dir, name))
    if (message === null) sends.refused += 1
    else sends.messages.push(message)
  }
  return sends
}

// One entry of `send`'s, `{ text, replyTo }`, or null when it isn't one.
function readSend(file) {
  let value
  try {
    value = JSON.parse(readUntrustedFile(file, { maxBytes: limits.SEND_ENTRY_MAX_BYTES }))
  } catch {
    return null
  }
  if (!isObject(value) || !Object.keys(value).every(field => field === 'text' || field === 'replyTo')) return null
  if (typeof value.text !== 'string' || value.text.trim() === '') return null
  if (value.replyTo !== undefined && !(Number.isSafeInteger(value.replyTo) && value.replyTo >= 1)) return null
  return { text: value.text.toWellFormed(), replyTo: value.replyTo ?? null }
}

// The message a reply quotes: the line `seq` names when it is a message, the owner's or one Scooter
// sent; the message an edit or a deletion changes; and null for anything else, such as a reaction
// or a `seq` that doesn't exist, which is then sent without a quote.
export function replyTarget(index, seq) {
  const entry = index.get(seq)
  if (!entry) return null
  const { line } = entry
  if (line.kind === 'message') return seq
  if ((line.kind === 'edit' || line.kind === 'delete') && index.get(line.target)?.line.kind === 'message') return line.target
  return null
}

// The outbox entries of the messages `send` queued, in order, each the agent's, carrying the
// channels its `sends` names, on which alone the bridge sends it. One with a `replyTo` that has a
// message to quote is a reply to it; any other is `about` the line `about` names, the batch's newest
// item, so that it follows the owner's latest message, or about nothing, for a scheduled task, and
// then goes to `DEFAULT_CHANNEL`. Returns `{ entries, answered }`: those, and the lines they reply
// to, which get no reaction.
export function sendEntries({ messages, agent, index, about = null }) {
  const channels = [...agent.sends]
  const answered = new Set()
  const entries = messages.map(({ text, replyTo }) => {
    const target = replyTo === null ? null : replyTarget(index, replyTo)
    const entry = { type: 'text', by: agent.name, text, channels }
    if (target !== null) {
      entry.replyTo = target
      answered.add(target)
      answered.add(replyTo)
    } else if (about !== null) {
      entry.about = about
    }
    return entry
  })
  return { entries, answered }
}

// In quiet mode, the reactions to the lines marked done, `done`: `ack_reaction` on each that is a
// message still there, not deleted, and not in `answered`, which got a reply instead. Reacting to a
// message the owner has deleted would say nothing. None in confirm mode, without an
// `ack_reaction`, or with `sends: []`.
export function ackEntries({ agent, index, done, answered = new Set() }) {
  if (agent.sends.length === 0 || agent.replyMode !== 'quiet' || agent.ackReaction === '') return []
  const entries = []
  for (const seq of [...done].sort((a, b) => a - b)) {
    if (answered.has(seq) || index.get(seq)?.line.kind !== 'message' || index.current(seq)?.deletedIn !== null) continue
    entries.push({ type: 'react', by: agent.name, target: seq, emoji: agent.ackReaction, channels: [...agent.sends] })
  }
  return entries
}
