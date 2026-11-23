#!/usr/bin/env node
// `mark done <seq>…` and `mark failed <seq> <reason>…`: says what became of the lines the agent was
// given, for the agent in its VM.
//
// It ships with the runner. Each run gets a copy as `run/bin/mark`, which the VM finds on the `PATH`
// the runner gives pi (`prepareRun` in `agentdir.mjs`, `piEnv` in `run.mjs`):
//
//   $ mark done 1050 1051 1052
//   mark: 1050, 1051 and 1052 marked done
//   $ mark failed 1053 "the PDF needs a password"
//   mark: 1053 marked failed
//
// - It appends a line for each `seq` to `run/marks.txt`, beside `bin/`, the one file of `run/` the
//   run may write, which the runner reads once the run has passed (`report.mjs`): `done <seq>`, or
//   `failed <seq> <reason>`. A run that fails settles nothing it marked.
// - A `seq` is a whole number, as `show` and the index file write it; `#1051` and `01051` are taken
//   as 1051. A reason is the words after the number, joined by spaces, on one line: its line breaks
//   and other spaces become one space each. A reason is needed.
// - Nothing is written unless every number is one.
//
// Exit codes: 0 once the marks are written; 1 when they couldn't be; 2 when it was called without
// `done` or `failed`, a number, or a reason for `failed`, or with a word that isn't a number.
//
// It runs in the VM with nothing of Scooter's but itself and what is in `run/`, so it imports only
// Node's own modules (`show.mjs` says how Node runs it).

import fs from 'node:fs'
import path from 'node:path'

const USAGE = `usage: mark done <seq>…
       mark failed <seq> "<reason>"
Says that you handled these lines, or that you can't handle this one, and why.
`

// A line's number as `show` and the index file write it, from `1051`, `#1051` or `01051`; null for
// anything else, a number of more than 15 digits among them, which the runner's reader of the marks
// takes for no number (`report.mjs`), and which no line's `seq` comes near.
function seqOf(text) {
  const digits = /^#?0*([1-9][0-9]{0,14})$/.exec(text)?.[1]
  return digits === undefined ? null : Number(digits)
}

// `a`, `a and b`, `a, b and c`.
const listed = items => (items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

function main() {
  const fail = (code, message) => {
    process.stderr.write(`mark: ${message}\n`)
    process.exitCode = code
  }
  const [how, ...rest] = process.argv.slice(2)
  if (how === '-h' || how === '--help') {
    process.stdout.write(USAGE)
    return
  }
  if (how !== 'done' && how !== 'failed') return fail(2, `say done or failed first\n${USAGE.trimEnd()}`)
  if (rest.length === 0) return fail(2, `name the line's number\n${USAGE.trimEnd()}`)

  let lines
  let seqs
  if (how === 'done') {
    const bad = rest.filter(arg => seqOf(arg) === null)
    if (bad.length > 0) return fail(2, `${bad.map(arg => JSON.stringify(arg)).join(', ')} ${bad.length === 1 ? "isn't a line's number" : "aren't lines' numbers"}; nothing was marked`)
    seqs = [...new Set(rest.map(seqOf))]
    lines = seqs.map(seq => `done ${seq}\n`)
  } else {
    const [number, ...words] = rest
    const seq = seqOf(number)
    if (seq === null) return fail(2, `${JSON.stringify(number)} isn't a line's number; nothing was marked`)
    const reason = words.join(' ').replace(/\s+/gu, ' ').trim()
    if (reason === '') return fail(2, `say why ${seq} failed, as: mark failed ${seq} "the PDF needs a password"`)
    seqs = [seq]
    lines = [`failed ${seq} ${reason}\n`]
  }

  // `run/marks.txt`, beside the folder this program is in, written with one call.
  const file = path.join(path.dirname(path.resolve(process.argv[1])), '..', 'marks.txt')
  try {
    fs.appendFileSync(file, lines.join(''))
  } catch (error) {
    return fail(1, `couldn't write the marks (${error.code ?? error.name}); nothing was marked`)
  }
  process.stdout.write(`mark: ${listed(seqs.map(String))} marked ${how}\n`)
}

main()
