// The prompt: the message pi is given for a run. It is the `prompt` of the trigger that starts the
// run, as the owner wrote it in `agents.yaml`, with its variables filled in, and nothing else:
//
//   prompt: |
//     Now: $now$ ($user.timezone$). Reply mode: $reply_mode$.
//     New: $seq.unread$
//     Given before: $seq.retry$
//
// becomes
//
//   Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Reply mode: quiet.
//   New: 1050 1051 1053
//   Given before: 1047 (attempt 2 of 4)
//
// A variable is `$`, a name of letters, dots and underscores that starts with a letter, and `$`.
// Any other `$` is the owner's own text, as in "$5". One the runner doesn't know is a fault of
// `agents.yaml` (`config.mjs`), which also holds every prompt, filled in with the longest values its
// variables can take, within `PROMPT_MAX_BYTES`: the prompt is one command-line argument, which
// Linux refuses at 128 KB. The values are the owner's settings, Scooter's own paths, a time and
// numbers: nothing a channel delivered, no text, name or path from a message, goes into a prompt.
//
// pi's system prompt is pi's own, with the agent's prompt of the config folder appended, the run's
// copy of it (`prepareRun` in `agentdir.mjs`).

import path from 'node:path'
import { limits } from '../common/limits.mjs'
import { toLocal } from '../common/time.mjs'

// The variables a prompt may hold, by name, in the order the documents give them.
export const VARIABLES = ['now', 'user.timezone', 'user.currency', 'reply_mode', 'internet', 'agent.dir', 'datastore.dir', 'seq.unread', 'seq.retry', 'run.writes']

// A variable in a prompt. A `$` that doesn't start one is text.
const VARIABLE = /\$([A-Za-z][A-Za-z_.]*)\$/g

// What a list with nothing in it reads.
export const NONE = 'none'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = number => String(number).padStart(2, '0')

// `Monday 9 November 2026, 21:20`: `$now$`.
export function longTime(ms, timeZone) {
  const t = toLocal(ms, timeZone)
  return `${WEEKDAYS[t.weekday - 1]} ${t.day} ${MONTHS[t.month - 1]} ${t.year}, ${pad(t.hour)}:${pad(t.minute)}`
}

// The names of the variables `template` holds, in order, each as often as it is there.
export function variablesIn(template) {
  return [...template.matchAll(VARIABLE)].map(match => match[1])
}

// `template` with each variable replaced by its value in `values`, by name. Each is replaced once,
// as it is: a value is never read for variables again, and nothing in it is read as a pattern of
// `String.replace`, such as `$&`. A name `values` doesn't have, which the check of `agents.yaml`
// rules out, stays as it is.
export function renderPrompt(template, values) {
  return template.replace(VARIABLE, (whole, name) => (Object.hasOwn(values, name) ? values[name] : whole))
}

// A path in a list of paths: as it is, or as a JSON string when it holds a space, a quote or a
// control character, which would make the list read another way. A path as it is starts with `/`,
// so the two can't be taken for each other.
function listedPath(file) {
  return /[\s\p{C}"]/u.test(file) ? JSON.stringify(file) : file
}

// What `writes` names, as the VM has it, each path in the data folder, a folder ending in `/`.
function writesList(paths, writes) {
  return writes.length === 0 ? NONE : writes.map(entry => listedPath(path.join(paths.dataDir, entry))).join(' ')
}

// `$seq.unread$`: the new lines, `1051 1054 1060`.
function unreadList(items) {
  const seqs = items.filter(item => item.origin === 'new').map(item => item.seq)
  return seqs.length === 0 ? NONE : seqs.join(' ')
}

// `$seq.retry$`: the lines given before and not finished, each with its attempt,
// `1047 (attempt 2 of 4), 1048 (attempt 1 of 4)`.
function retryList(items) {
  const retried = items.filter(item => item.origin !== 'new').map(item => `${item.seq} (attempt ${item.attempt} of ${limits.MAX_ATTEMPTS})`)
  return retried.length === 0 ? NONE : retried.join(', ')
}

// The value of each variable for a run of `agent`:
// - `now`: the run's time, in milliseconds; a replayed batch gives its own (`replay.mjs`);
// - `items`: the batch's items, `{ seq, origin, attempt }` (`batch.mjs`), none for a scheduled run;
// - `writes`: what the run may change, the agent's `writes` or a backfill's;
// - `settings`: the runner's, for `SCOOTER_TZ`, `HOME_CURRENCY` and `AGENT_INTERNET`;
// - `paths`: what `makePaths` returns; a path in the data folder is the same inside the VM.
export function promptValues({ agent, paths, settings, now, items = [], writes = agent.writes }) {
  return {
    now: longTime(now, settings.timeZone),
    'user.timezone': settings.timeZone,
    'user.currency': settings.homeCurrency,
    reply_mode: agent.replyMode,
    internet: settings.agentInternet ? 'on' : 'off',
    'agent.dir': paths.agentDir(agent.name),
    'datastore.dir': paths.datastore,
    'seq.unread': unreadList(items),
    'seq.retry': retryList(items),
    'run.writes': writesList(paths, writes),
  }
}

// ---------------------------------------------------------------------------------------------
// How long a prompt can be

const bytes = text => Buffer.byteLength(text)

// The most digits a `seq` or an attempt can have: they are safe integers.
const NUMBER_MAX_BYTES = String(Number.MAX_SAFE_INTEGER).length

// The longest `$now$`: the longest weekday and month, and a year of a sign and five digits.
const NOW_MAX_BYTES = Math.max(...WEEKDAYS.map(bytes)) + Math.max(...MONTHS.map(bytes)) + bytes(' 30  -99999, 23:59')

// The most items a batch can have of each origin. New ones are among at most `BATCH_MAX_ITEMS`
// candidates; those given before are the due retries among them, and the messages their edits
// bring in, at most one an edit (`assembleBatch` in `batch.mjs`).
const longestList = (count, each, separator) => (count === 0 ? bytes(NONE) : Math.max(bytes(NONE), count * each + (count - 1) * bytes(separator)))

// The longest value each variable can take in a run of `agent`, in bytes, for prompts of runs
// whose `writes` is one of `writesLists`: the agent's own, or a backfill's.
export function longestValues({ agent, paths, settings, writesLists = [agent.writes] }) {
  const known = promptValues({ agent, paths, settings, now: 0 })
  const retryEach = bytes(`${'9'.repeat(NUMBER_MAX_BYTES)} (attempt ${'9'.repeat(NUMBER_MAX_BYTES)} of ${limits.MAX_ATTEMPTS})`)
  return {
    ...Object.fromEntries(Object.entries(known).map(([name, value]) => [name, bytes(value)])),
    now: NOW_MAX_BYTES,
    'seq.unread': longestList(limits.BATCH_MAX_ITEMS, NUMBER_MAX_BYTES, ' '),
    'seq.retry': longestList(2 * limits.BATCH_MAX_ITEMS, retryEach, ', '),
    'run.writes': Math.max(...writesLists.map(writes => bytes(writesList(paths, writes)))),
  }
}

// The most bytes `template` can make, filled in with values no longer than `longest` gives. Each
// piece of its own text is counted apart: half of a pair of UTF-16 surrogates on either side of a
// variable takes three bytes, and two together four.
export function longestPrompt(template, longest) {
  let total = 0
  let from = 0
  for (const match of template.matchAll(VARIABLE)) {
    total += bytes(template.slice(from, match.index)) + longest[match[1]]
    from = match.index + match[0].length
  }
  return total + bytes(template.slice(from))
}
