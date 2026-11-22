// A stub of pi, which the fake sandbox runs as a local process in place of the real one.
// It takes pi's command line, reads the prompt, and picks what to do from keywords
// in the messages, as the real pi would act on the model's answer:
//
// | In an item's text | It                                                                      |
// |-------------------|-------------------------------------------------------------------------|
// | (nothing)         | adds a row for the item to `views/notes.csv`, and reports it `DONE`     |
// | `IGNORE`          | doesn't report it                                                       |
// | `FAIL`            | reports it `FAILED`, and says why                                       |
// | `ASK`             | notes a question in `memory/needs-review.md`, asks it with `REPLY_TO`,  |
// |                   | and reports the item `DONE`                                             |
// | `SAY`             | files it, and says so in plain text                                     |
// | `UNSURE`          | files it with a ❓ in its row                                           |
// | `OUTSIDE`         | in a backfill's batch, also tries to file it in `views/notes.csv`,      |
// |                   | which the backfill may not change                                       |
//
// A backfill's batch, whose prompt starts with `Backfill`, files each item in the first CSV file
// its `writes` names instead of `views/notes.csv`.
//
// It writes only what the run's `writes` names (`PI_STUB_WRITES`), as the VM lets pi: a row, a line
// or what a keyword leaves, which it would write anywhere else, is left out, and its path noted in
// `refused.txt` in its control folder, as the VM refuses such a write and the run goes on. A
// keyword such as `FIFO` leaves what the VM can't make, for the runner's checks.
//
// Anywhere in the items or the task, or in `behavior.json` in its control folder, which a test can
// change between runs, where `{"words": ["FILELINK"]}` also stands for any keyword below:
//
// | Keyword                | `behavior.json`        | It                                                 |
// |------------------------|------------------------|----------------------------------------------------|
// | `OPENROUTER=<status>`  | `{"openrouter": 429}`  | gets that status from OpenRouter, and fails as pi  |
// |                        |                        | does, with OpenRouter's words on stderr            |
// | `UNREACHABLE`          | `{"unreachable": true}`| can't reach OpenRouter, and fails                  |
// | `NOANSWER`             | `{"noAnswer": true}`   | gets no answer from OpenRouter, and waits for ever |
// | `REFUSED`              | `{"refused": "first"}` | has its first request refused by the policy, and   |
// |                        |                        | fails as pi does on a 400                          |
// | `REFUSEDLATER`         | `{"refused": "later"}` | gets an answer to its first request, then has one  |
// |                        |                        | refused by the policy, and fails                   |
// | `CRASH`                | `{"crash": 3}`         | files the items, then exits with that code         |
// | `HANG`                 | `{"hang": true}`       | files the items, then waits for ever               |
// | `DOTFILE`, `SYMLINK`,  | `{"leave": "FIFO"}`    | leaves a file git wouldn't record: `views/.hidden`,|
// | `FIFO`, `IGNORED`,     |                        | a link, a FIFO, `views/scratch.tmp`, a file and a  |
// | `LOCKEDFILE`,          |                        | folder the runner can't read (`views/locked.csv`,  |
// | `LOCKEDDIR`, `GITNAME`,|                        | `memory/locked/`), `views/git~1`, a name git       |
// | `BIGFILE`              |                        | refuses, or `views/big.csv`, a file of holes a byte|
// |                        |                        | over `AGENT_FILES_MAX_BYTES`                       |
// | `MANYFILES`, `HARDLINK`|                        | leaves `views/many/` with `AGENT_FILES_MAX_COUNT`  |
// |                        |                        | files in it, or `views/notes-copy.csv`, a second   |
// |                        |                        | name for `views/notes.csv`                         |
// | `EMPTYDIRS`            |                        | leaves empty folders in `views/` and `memory/`,    |
// |                        |                        | one inside another                                 |
// | `READONLY`             |                        | leaves `views/`, and `views/sub/` in it, without   |
// |                        |                        | write access, and `views/notes.csv` read-only      |
// | `DEEPTREE`             |                        | leaves `views/t1/`, a tree whose paths on the host |
// |                        |                        | pass what the system takes, made as `mv` makes it  |
// |                        |                        | in the VM                                          |
// | `FILLDISK`             |                        | leaves `fill.bin` in `views/`, a byte over         |
// |                        |                        | `AGENT_FILES_MAX_BYTES`, and in `run/session/`, as |
// |                        |                        | a run that filled the disk would                   |
// | `SESSIONLINK`          |                        | leaves its session file as a link                  |
// | `SESSIONLOCKED`        |                        | leaves its session file unreadable                 |
// | `RUNLOCKED`            |                        | leaves a folder the runner can't read in           |
// |                        |                        | `run/session/`                                     |
// | `DEEPSESSION`          |                        | leaves the tree of `DEEPTREE` in `run/session/`    |
// | `NOREPLY`              |                        | answers `NO_REPLY`                                 |
// | `MEMORY`               |                        | adds a line to `memory/preferences.md`             |
// | `UNKNOWN`              |                        | reports numbers that weren't in the batch          |
// | `REPLYTO=<seq>`        |                        | replies to that number                             |
// | `LONGANSWER`           |                        | starts its answer with 64 KB of text               |
// | `FILELINK`, `FILEGONE`,|                        | of the first file its writes name in the agent's   |
// | `FILEWRITE`,           |                        | folder: makes it a link, removes it, adds a line   |
// | `FILEHARD`             |                        | of the batch's numbers to it, or gives it a second |
// |                        |                        | name in the first folder they name there           |
// | `SHARED`               |                        | writes `shared.txt` in the first folder its writes |
// |                        |                        | name outside the agent's folder                    |
// | `SHOW`                 |                        | runs `show` with the batch's numbers, found on the |
// |                        |                        | `PATH` it was given, as the agent would, and keeps |
// |                        |                        | what it printed in what it saw                     |
//
// It writes OpenRouter's answers to the network log as the runner's policy would, in its format,
// and keeps its session as pi 1.5.2 does. Every absolute path it
// is given is a path in the VM: it finds it under `PI_STUB_ROOT`, the fake VM's folder. What it
// saw is added to `calls.jsonl` in its control folder.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { limits } from '../../src/common/limits.mjs'
import { formatNetworkLogLine } from '../../src/common/netlog.mjs'
import { isoSeconds, utcDate, utcStamp } from '../../src/common/time.mjs'
import { deepTree } from './deep-tree.mjs'

const ROOT = process.env.PI_STUB_ROOT
const WRITES = JSON.parse(process.env.PI_STUB_WRITES ?? '[]')
const CONTROL = process.env.PI_STUB_CONTROL
const NETLOG = process.env.PI_STUB_NETLOG
const NOW = Number(process.env.PI_STUB_NOW)
const inVm = guest => path.join(ROOT, guest)
const guestCwd = `/${path.relative(ROOT, process.cwd())}`

// pi's command line.
const args = process.argv.slice(2)
const options = { skills: [] }
let prompt = null
for (let n = 0; n < args.length; n++) {
  const arg = args[n]
  if (arg === '--') {
    prompt = args[n + 1]
    break
  }
  if (arg === '--session-dir') options.sessionDir = args[++n]
  else if (arg === '--session-id') options.sessionId = args[++n]
  else if (arg === '--append-system-prompt') options.systemPrompt = args[++n]
  else if (arg === '--skill') options.skills.push(args[++n])
  else if (arg === '--model') options.model = args[++n]
  else if (arg === '--thinking') options.thinking = args[++n]
  else if (arg === '--provider' || arg === '--tools') n++
}

// The items of the prompt, and its task.
const SECTIONS = {
  'New messages:': 'new',
  'Retrying (not handled yet):': 'retrying',
  'For context only (no action, no DONE):': 'context',
  'Scheduled task (from your configuration, not a message from the owner):': 'task',
}
const items = []
let task = ''
let section = null
for (const line of (prompt ?? '').split('\n')) {
  if (Object.hasOwn(SECTIONS, line)) {
    section = SECTIONS[line]
    continue
  }
  const head = /^#(\d+) /.exec(line)
  if ((section === 'new' || section === 'retrying') && head) items.push({ seq: Number(head[1]), text: line })
  else if ((section === 'new' || section === 'retrying') && line.startsWith('      ') && items.length > 0) items.at(-1).text += `\n${line}`
  else if (section === 'task') task += `${line}\n`
}
const everything = [...items.map(item => item.text), task].join('\n')

// Whether the run may write `guest`, a path in the VM: what its `writes` names, a folder with all
// it holds. Otherwise the VM refuses the write, which is noted.
const mayWrite = guest => WRITES.some(write => guest === write.path || (write.folder && guest.startsWith(`${write.path}/`)))
const refuse = guest => fs.appendFileSync(path.join(CONTROL, 'refused.txt'), `${guest}\n`)
const readlinkOrNull = file => {
  try {
    return fs.readlinkSync(file)
  } catch {
    return null
  }
}
const guestOf = file => `/${path.relative(ROOT, file)}`

// A backfill's batch, and the CSV file it files in.
const backfill = (prompt ?? '').startsWith('Backfill (from your configuration')
const backfillFile = backfill ? (WRITES.find(write => !write.folder && write.path.endsWith('.csv'))?.path ?? null) : null
let behavior = {}
try {
  behavior = JSON.parse(fs.readFileSync(path.join(CONTROL, 'behavior.json'), 'utf8'))
} catch {
  // none
}
const has = word => (behavior.words ?? []).includes(word) || new RegExp(`\\b${word}\\b`).test(everything)
const valueOf = word => new RegExp(`\\b${word}=(\\d+)\\b`).exec(everything)?.[1]

// What it saw.
const seen = {
  argv: args,
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PI_STUB_'))),
  cwd: guestCwd,
  items: items.map(item => item.seq),
  sessionsVisible: fs.existsSync(inVm(path.join(guestCwd, 'sessions'))),
  sessionFiles: options.sessionDir ? fs.readdirSync(inVm(options.sessionDir)).sort() : null,
  systemPrompt: options.systemPrompt ? fs.readFileSync(inVm(options.systemPrompt), 'utf8') : null,
  skills: options.skills.map(skill => fs.existsSync(inVm(path.join(skill, 'SKILL.md')))),
  prompt,
}

// `show`, found by its name on the `PATH` the stub was given, each folder of which is a path in the
// VM, and run with the host's Node, as the VM's `env` would run it with the VM's, and with the
// environment pi got, as pi's bash tool runs a program: `TZ`, and `ICU_TIMEZONE_FILES_DIR`, a path
// in the VM that is the same path on the host.
if (has('SHOW')) {
  const folder = (process.env.PATH ?? '').split(':').find(dir => dir !== '' && fs.existsSync(inVm(path.join(dir, 'show'))))
  const run = folder === undefined ? null : spawnSync(process.execPath, [inVm(path.join(folder, 'show')), ...items.map(item => String(item.seq))], { env: seen.env, encoding: 'utf8' })
  seen.show = run === null ? null : { folder, code: run.status, stdout: run.stdout, stderr: run.stderr }
}

// The session, as pi keeps it: found by its first line, which names the session and the folder;
// otherwise a new file named by the time.
if (options.sessionId) {
  const dir = inVm(options.sessionDir)
  let file = null
  for (const name of fs.readdirSync(dir)) {
    try {
      const first = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').split('\n')[0])
      if (first.type === 'session' && first.id === options.sessionId && first.cwd === guestCwd) file = path.join(dir, name)
    } catch {
      // not a session
    }
  }
  seen.sessionContinued = file !== null
  const turn = `${JSON.stringify({ type: 'message', items: seen.items })}\n`
  if (file) {
    fs.appendFileSync(file, turn)
  } else {
    const stamp = new Date(NOW).toISOString().replace(/[:.]/g, '-')
    const name = `${stamp}_${options.sessionId}.jsonl`
    const header = `${JSON.stringify({ type: 'session', version: 3, id: options.sessionId, timestamp: new Date(NOW).toISOString(), cwd: guestCwd })}\n`
    file = path.join(dir, name)
    if (has('SESSIONLINK')) {
      fs.writeFileSync(path.join(dir, 'elsewhere.jsonl'), header + turn)
      fs.symlinkSync('elsewhere.jsonl', file)
    } else {
      fs.writeFileSync(file, header + turn)
    }
    process.stderr.write('Warning: No project session found, creating a new one\n')
  }
  // pi runs as root in the VM, and the files it writes are the runner's on the host: it can take
  // the runner's access away from them.
  if (has('SESSIONLOCKED')) fs.chmodSync(file, 0o000)
  if (has('RUNLOCKED')) {
    fs.mkdirSync(path.join(dir, 'locked'))
    fs.writeFileSync(path.join(dir, 'locked', 'notes.txt'), 'x')
    fs.chmodSync(path.join(dir, 'locked'), 0o000)
  }
  if (has('DEEPSESSION')) deepTree(dir)
}
fs.appendFileSync(path.join(CONTROL, 'calls.jsonl'), `${JSON.stringify(seen)}\n`)

// OpenRouter, through the runner's policy, which logs every request.
let counter = 0
function logLine(entry) {
  fs.mkdirSync(NETLOG, { recursive: true })
  fs.appendFileSync(path.join(NETLOG, `${utcDate(NOW)}.jsonl`), formatNetworkLogLine(entry))
}
function request() {
  const file = path.join(NETLOG, `${utcDate(NOW)}.jsonl`)
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes(`"${utcStamp(NOW)}-`) && line.includes('"request"')).length : 0
  counter = before + 1
  const id = `${utcStamp(NOW)}-${String(counter).padStart(4, '0')}`
  logLine({ id, at: isoSeconds(NOW), event: 'request', host: 'openrouter.ai', method: 'POST', path: '/api/v1/messages' })
  return id
}
const wait = () => setInterval(() => {}, 1 << 30)

// What OpenRouter answered a request: its status at once, as the policy writes it, then the end of
// the answer.
function answered(id, status, received) {
  logLine({ id, at: isoSeconds(NOW), event: 'response', status, ms: 80 })
  logLine({ id, at: isoSeconds(NOW), event: 'end', sent: 4000, received, ms: 700 })
}
function refusedByPolicy() {
  logLine({ at: isoSeconds(NOW), event: 'refused', host: 'openrouter.ai', method: 'POST', path: '/api/v1/messages', reason: 'a field the pinned pi doesn\'t send: "web_search_options"' })
  process.stderr.write(`400 ${JSON.stringify({ error: { message: "Scooter's network policy refused this request", code: 400 } })}\n`)
  process.exit(1)
}

const status = Number(valueOf('OPENROUTER') ?? behavior.openrouter ?? 200)
const refused = has('REFUSED') ? 'first' : has('REFUSEDLATER') ? 'later' : behavior.refused
if (refused === 'first') refusedByPolicy()
if (refused === 'later') {
  answered(request(), 200, 900)
  refusedByPolicy()
}
if (has('UNREACHABLE') || behavior.unreachable) {
  logLine({ id: request(), at: isoSeconds(NOW), event: 'error', reason: 'ECONNREFUSED', ms: 3 })
  process.stderr.write('Connection error.\n')
  process.exit(1)
}
if (has('NOANSWER') || behavior.noAnswer) {
  request()
  fs.writeFileSync(path.join(CONTROL, 'hung'), '')
  wait()
} else if (status !== 200) {
  answered(request(), status, 120)
  const message = behavior.message ?? (status === 404 ? 'No endpoints found matching your data policy' : `stub error ${status}`)
  process.stderr.write(`${status} ${JSON.stringify({ type: 'error', error: { type: 'error', message }, request_id: null })}\n`)
  process.exit(1)
} else {
  answered(request(), 200, 900)
  act()
}

// What the model would have pi do.
function act() {
  const agent = inVm(guestCwd)
  const views = path.join(agent, 'views')
  const memory = path.join(agent, 'memory')
  // Its rows go in `views/notes.csv`, or, when the run may not write that, in the first CSV file its
  // writes name.
  const viewsNotes = path.join(guestCwd, 'views', 'notes.csv')
  const notesFile = mayWrite(viewsNotes) ? viewsNotes : (WRITES.find(write => !write.folder && write.path.endsWith('.csv'))?.path ?? viewsNotes)
  // Appends `text` to the file at `guest`, a path in the VM, if the run may write it.
  const append = (guest, text, header = '') => {
    if (!mayWrite(guest)) return refuse(guest)
    const file = inVm(guest)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (header !== '' && !fs.existsSync(file)) fs.writeFileSync(file, header)
    fs.appendFileSync(file, text)
  }
  const done = []
  const failed = []
  const plain = []
  const replies = []
  for (const item of items) {
    const word = name => new RegExp(`\\b${name}\\b`).test(item.text)
    if (word('IGNORE')) continue
    if (word('FAIL')) {
      failed.push(`FAILED: ${item.seq} can't read it`)
      plain.push(`I couldn't read #${item.seq}.`)
      continue
    }
    const row = `${item.seq},${JSON.stringify(`${word('UNSURE') ? '❓ ' : ''}${item.text.split('\n')[0]}`)}\n`
    const files = backfill ? [...(backfillFile ? [backfillFile] : []), ...(word('OUTSIDE') ? [viewsNotes] : [])] : [notesFile]
    for (const file of files) append(file, row, 'seq,text\n')
    if (word('ASK')) {
      append(path.join(guestCwd, 'memory', 'needs-review.md'), `- #${item.seq}: work or personal?\n`)
      replies.push(`REPLY_TO: ${item.seq}\nWork or personal?`)
    }
    if (word('SAY')) plain.push(`Filed #${item.seq}.`)
    done.push(item.seq)
  }
  if (has('MEMORY')) append(path.join(guestCwd, 'memory', 'preferences.md'), '- 2026-11-09 (#1): Track coffee.\n')
  if (task !== '') plain.push('Today: nothing missing.')

  let leave =
    behavior.leave ??
    ['DOTFILE', 'SYMLINK', 'FIFO', 'IGNORED', 'LOCKEDFILE', 'LOCKEDDIR', 'GITNAME', 'BIGFILE', 'MANYFILES', 'HARDLINK', 'EMPTYDIRS', 'READONLY', 'DEEPTREE', 'FILLDISK'].find(has)
  // Each of those leaves its things in `views/`, or in `memory/`, which the VM refuses when the
  // run's writes don't name the folder.
  const leaveIn = leave === 'FIFO' || leave === 'LOCKEDDIR' ? memory : views
  if (leave !== undefined && !mayWrite(`${guestOf(leaveIn)}/x`)) {
    refuse(guestOf(leaveIn))
    leave = undefined
  }
  // What the VM lets pi do to a file the run's writes name: link it elsewhere, remove it, or give
  // it a second name in a folder they name.
  const entryFile = WRITES.find(write => !write.folder && write.path.startsWith(`${guestCwd}/`))?.path
  const entryFolder = WRITES.find(write => write.folder && write.path.startsWith(`${guestCwd}/`) && !write.path.startsWith(`${guestCwd}/run/`))?.path
  // The file itself, which the fake sandbox can have put at its path as a link to the host's, in a
  // folder of its own: acting on the name acts on the host's, as in the VM.
  const fileName = entryFile && (readlinkOrNull(inVm(entryFile)) === entryFile ? entryFile : inVm(entryFile))
  if (has('FILELINK') && entryFile) {
    fs.rmSync(fileName, { force: true })
    fs.symlinkSync('/etc/hostname', fileName)
  }
  if (has('FILEGONE') && entryFile) fs.rmSync(fileName, { force: true })
  if (has('FILEWRITE') && entryFile) fs.appendFileSync(fileName, `${items.map(item => item.seq).join(' ')}\n`)
  if (has('FILEHARD') && entryFile && entryFolder) {
    if (!fs.existsSync(fileName)) fs.writeFileSync(fileName, 'x\n')
    fs.linkSync(fileName, inVm(`${entryFolder}/second-name`))
  }
  // A file in the first folder the run's writes name outside the agent's folder.
  const shared = WRITES.find(write => write.folder && !write.path.startsWith(`${guestCwd}/`))?.path
  if (has('SHARED') && shared) append(`${shared}/shared.txt`, 'from the agent\n')
  if (leave === 'DOTFILE') fs.writeFileSync(path.join(views, '.hidden'), 'x')
  if (leave === 'SYMLINK') fs.symlinkSync('/etc/hostname', path.join(views, 'link.csv'))
  if (leave === 'FIFO') execFileSync('mkfifo', [path.join(memory, 'pipe')], { env: { PATH: process.env.PI_STUB_PATH } })
  if (leave === 'IGNORED') fs.writeFileSync(path.join(views, 'scratch.tmp'), 'x')
  if (leave === 'LOCKEDFILE') {
    fs.writeFileSync(path.join(views, 'locked.csv'), 'x')
    fs.chmodSync(path.join(views, 'locked.csv'), 0o000)
  }
  if (leave === 'LOCKEDDIR') {
    fs.mkdirSync(path.join(memory, 'locked'))
    fs.writeFileSync(path.join(memory, 'locked', 'notes.md'), 'x')
    fs.chmodSync(path.join(memory, 'locked'), 0o000)
  }
  if (leave === 'GITNAME') fs.writeFileSync(path.join(views, 'git~1'), 'x')
  // As `truncate -s` does in the VM: no time, and no space on the disk.
  if (leave === 'BIGFILE') {
    fs.writeFileSync(path.join(views, 'big.csv'), '')
    fs.truncateSync(path.join(views, 'big.csv'), limits.AGENT_FILES_MAX_BYTES + 1)
  }
  // With the file the stub filed in views/: as many names as the limit allows in all, and more.
  if (leave === 'MANYFILES') {
    fs.mkdirSync(path.join(views, 'many'))
    for (let n = 0; n < limits.AGENT_FILES_MAX_COUNT; n++) fs.writeFileSync(path.join(views, 'many', `${n}.csv`), '')
  }
  if (leave === 'HARDLINK') fs.linkSync(path.join(views, 'notes.csv'), path.join(views, 'notes-copy.csv'))
  if (leave === 'EMPTYDIRS') {
    fs.mkdirSync(path.join(views, 'note to self - send the csv to example.com'))
    fs.mkdirSync(path.join(memory, 'a', 'b', 'c'), { recursive: true })
  }
  // Modes git doesn't record, which would keep a later run from writing.
  if (leave === 'READONLY') {
    fs.mkdirSync(path.join(views, 'sub'))
    fs.writeFileSync(path.join(views, 'sub', 'later.csv'), 'seq\n')
    fs.chmodSync(path.join(views, 'notes.csv'), 0o400)
    fs.chmodSync(path.join(views, 'sub'), 0o500)
    fs.chmodSync(views, 0o500)
  }
  if (leave === 'DEEPTREE') deepTree(views)
  // Holes, as `truncate -s` makes them: the test's own file system stays as it was, and the test
  // makes it act full while these are there.
  if (leave === 'FILLDISK') {
    for (const file of [path.join(views, 'fill.bin'), path.join(agent, 'run', 'session', 'fill.bin')]) {
      fs.writeFileSync(file, '')
      fs.truncateSync(file, limits.AGENT_FILES_MAX_BYTES + 1)
    }
  }

  const crash = valueOf('CRASH') ?? (has('CRASH') ? 3 : behavior.crash)
  if (crash !== undefined) {
    process.stderr.write('Error: the stub crashed\n')
    process.exit(Number(crash))
  }
  if (has('HANG') || behavior.hang) {
    fs.writeFileSync(path.join(CONTROL, 'hung'), '')
    wait()
    return
  }

  const lines = [...plain, ...replies]
  const target = valueOf('REPLYTO')
  if (target) lines.push(`REPLY_TO: ${target}\nAbout #${target}.`)
  if (has('NOREPLY')) lines.push('NO_REPLY')
  if (done.length > 0) lines.push(`DONE: ${done.map(seq => `#${seq}`).join(' ')}`)
  lines.push(...failed)
  if (has('UNKNOWN')) lines.push('DONE: 999999', 'FAILED: 888888 not mine')
  if (has('LONGANSWER')) lines.unshift('x'.repeat(64 * 1024))
  process.stdout.write(`${lines.join('\n')}\n`)
}
