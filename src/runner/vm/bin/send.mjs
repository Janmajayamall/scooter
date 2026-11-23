#!/usr/bin/env node
// `send [--reply-to <seq>] [<text>…]`: asks the runner to send the owner a message, for the agent
// in its VM.
//
// It ships with the runner. Each run gets a copy as `run/bin/send`, which the VM finds on the `PATH`
// the runner gives pi (`prepareRun` in `agentdir.mjs`, `piEnv` in `run.mjs`):
//
//   $ send --reply-to 1052 "Is this ticket for you alone, or for Sam too?"
//   send: queued; it goes to the owner once this run has passed
//
// - It sends nothing itself: pi's VM reaches no channel. It writes an entry into `run/send/`,
//   beside `bin/`, the one folder of `run/` the run may write it in, and the runner reads it once
//   the run has passed, and hands it to the outbox (`report.mjs`). A run that fails sends none of
//   what it queued.
// - The text is the words after the options, joined by spaces, or, with none, what standard input
//   holds, as from a here-document or a pipe, read to its end. Its ends are trimmed, and one that
//   holds nothing else is refused.
// - `--reply-to` names the line it answers by its `seq`, which the owner sees it quote.
// - An entry is `<n>.json`, n the next number after the highest there, made only if it isn't there:
//   `{"text": "…", "replyTo": 1052}`, `replyTo` left out when not given. The runner takes them in
//   the order of their numbers.
//
// Exit codes: 0 once the message is queued; 1 when it couldn't be written; 2 when it was called
// without a text, or with an option or a number it doesn't take.
//
// It runs in the VM with nothing of Scooter's but itself and what is in `run/`, so it imports only
// Node's own modules (`show.mjs` says how Node runs it).

import fs from 'node:fs'
import path from 'node:path'
import { isatty } from 'node:tty'

const USAGE = `usage: send [--reply-to <seq>] "<text>"
       send [--reply-to <seq>] <<'END'
       <text>
       END
Queues a message to the owner, which goes out once this run has passed, as a reply to <seq> when given.
`

// An entry's name, and its number.
const ENTRY = /^([1-9][0-9]*)\.json$/

// A word that looks like an option, such as `-r` or `--to=1052`.
const OPTION = /^--?[A-Za-z][A-Za-z0-9-]*(=.*)?$/s

// A line's number as `show` and the index file write it, from `1051`, `#1051` or `01051`; null for
// anything else, a number past what a line's `seq` can be among them.
function seqOf(text) {
  const digits = /^#?([0-9]+)$/.exec(text)?.[1]
  if (digits === undefined) return null
  const seq = Number(digits)
  return Number.isSafeInteger(seq) && seq >= 1 ? seq : null
}

function main() {
  const fail = (code, message) => {
    process.stderr.write(`send: ${message}\n`)
    process.exitCode = code
  }
  const args = process.argv.slice(2)
  let replyTo = null
  const words = []
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]
    if (arg === '--') {
      words.push(...args.slice(n + 1))
      break
    }
    if (arg === '--reply-to' || arg.startsWith('--reply-to=')) {
      const value = arg === '--reply-to' ? args[++n] : arg.slice('--reply-to='.length)
      replyTo = value === undefined ? null : seqOf(value)
      if (replyTo === null) return fail(2, `--reply-to takes the number of the line the message answers, such as --reply-to 1052${value === undefined ? '' : `, not ${JSON.stringify(value)}`}`)
      continue
    }
    if (words.length === 0 && (arg === '-h' || arg === '--help')) {
      process.stdout.write(USAGE)
      return
    }
    // A word that looks like an option, before the text: a text can start with `- `, a list.
    if (words.length === 0 && OPTION.test(arg)) return fail(2, `it takes no option ${JSON.stringify(arg)}\n${USAGE.trimEnd()}`)
    words.push(arg)
  }

  // Standard input, when no text was given, read to its end, as `cat` reads it: from a pipe, it
  // waits for the command writing it to finish. It is never looked at through `process.stdin`,
  // which would open it as a stream, and make a pipe non-blocking: the read would then fail with
  // `EAGAIN` whenever the pipe is empty before its writer has finished. pi's bash tool gives a
  // command `/dev/null` there, so `send` with neither reads nothing, and says so.
  let text = words.join(' ')
  if (words.length === 0 && !isatty(0)) {
    try {
      text = fs.readFileSync(0, 'utf8')
    } catch (error) {
      return fail(2, `couldn't read the text from standard input (${error.code ?? error.name})`)
    }
  }
  text = text.trim()
  if (text === '') return fail(2, `nothing to send: give the text as an argument, or on standard input\n${USAGE.trimEnd()}`)

  // `run/send/`, beside the folder this program is in.
  const dir = path.join(path.dirname(path.resolve(process.argv[1])), '..', 'send')
  const body = `${JSON.stringify(replyTo === null ? { text } : { text, replyTo })}\n`
  try {
    fs.mkdirSync(dir, { recursive: true })
    let next = 1
    for (const name of fs.readdirSync(dir)) {
      const number = ENTRY.exec(name)?.[1]
      if (number !== undefined && Number(number) >= next) next = Number(number) + 1
    }
    // Another `send` at the same moment takes the next number.
    for (;;) {
      try {
        fs.writeFileSync(path.join(dir, `${next}.json`), body, { flag: 'wx' })
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        next += 1
      }
    }
  } catch (error) {
    return fail(1, `couldn't queue the message (${error.code ?? error.name})`)
  }
  process.stdout.write('send: queued; it goes to the owner once this run has passed\n')
}

main()
