// What a run leaves for the runner besides its files: `send` and `mark`, the programs that ship
// with the runner for the VM, run as the VM runs them, as programs of their own; what they write in
// `run/send/` and `run/marks.txt`; and how the runner reads it (`report.mjs`), with everything pi
// could leave there in their place, which must never stop the runner. The outbox entries and the
// reactions made of it are here too. That they run by their names in the VM, from pi's bash tool,
// and write only where they may, is `VM 9` in `test/tools/vm.test.mjs`; the order of what follows a
// run is in `test/run.test.mjs`.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createIndex } from '../src/common/datastore/index.mjs'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { makePaths } from '../src/common/paths.mjs'
import { clearRunWrites, prepareRun } from '../src/runner/agentdir.mjs'
import { NO_REASON, ackEntries, marksOf, readMarks, readSends, replyTarget, sendEntries, shortReason } from '../src/runner/report.mjs'
import { deepTree } from './support/deep-tree.mjs'
import { createTestLog } from './support/log.mjs'
import { skipIfRoot } from './support/root.mjs'
import { indexOf, line } from './support/runner.mjs'
import { atEnd, makeTestDir } from './support/tmp.mjs'

// `run/` made for a run as the runner makes it, and `send` and `mark` run from its `bin/` as the VM
// runs a program, with Node, and with standard input empty, as `/dev/null` is in pi's bash tool,
// unless `input` is given.
function setup(t) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  const prompt = path.join(paths.configDir, 'prompts', 'lifelog.md')
  fs.mkdirSync(path.dirname(prompt), { recursive: true })
  fs.writeFileSync(prompt, 'You are lifelog.\n')
  fs.mkdirSync(paths.agentDir('lifelog'), { recursive: true })
  prepareRun({ paths, agent: { name: 'lifelog', prompt: { path: 'prompts/lifelog.md', file: prompt }, skills: [] }, index: createIndex() })
  const run = (program, args, input = '') => {
    const result = spawnSync(process.execPath, [path.join(paths.agentRunBin('lifelog'), program), ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH } })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  return {
    paths,
    send: (args, input) => run('send', args, input),
    mark: (args, input) => run('mark', args, input),
    sendDir: paths.agentRunSend('lifelog'),
    marksFile: paths.agentRunMarks('lifelog'),
    sends: () => readSends(paths.agentRunSend('lifelog')),
    marks: () => readMarks(paths.agentRunMarks('lifelog')),
  }
}

const QUEUED = 'send: queued; it goes to the owner once this run has passed\n'

// ---------------------------------------------------------------------------------------------
// send

test('send: a text as words or on standard input, with quotes, line breaks and $ as they are, and --reply-to, each an entry the runner reads in order', t => {
  const { send, sendDir, sends } = setup(t)
  assert.deepEqual(send(['Filed the coffee.']), { code: 0, stdout: QUEUED, stderr: '' })
  assert.deepEqual(send(['--reply-to', '1052', 'Is this ticket for you alone,', 'or for Sam too?']), { code: 0, stdout: QUEUED, stderr: '' })
  // As a here-document gives it: quotes, a `$`, line breaks and a backslash, kept, its ends trimmed.
  const text = 'He said "₹450, not $45".\n\n- *one*\n- _two_ \\ three'
  assert.equal(send(['--reply-to=#1053'], `\n${text}\n`).code, 0)
  // `--reply-to` after the text, a text that starts as a list does, and one after `--`.
  assert.equal(send(['- a list', '--reply-to', '01054']).code, 0)
  assert.equal(send(['--', '--reply-to']).code, 0)
  assert.deepEqual(fs.readdirSync(sendDir).sort(), ['1.json', '2.json', '3.json', '4.json', '5.json'])
  assert.equal(fs.readFileSync(path.join(sendDir, '2.json'), 'utf8'), '{"text":"Is this ticket for you alone, or for Sam too?","replyTo":1052}\n')
  assert.deepEqual(sends(), {
    messages: [
      { text: 'Filed the coffee.', replyTo: null },
      { text: 'Is this ticket for you alone, or for Sam too?', replyTo: 1052 },
      { text, replyTo: 1053 },
      { text: '- a list', replyTo: 1054 },
      { text: '--reply-to', replyTo: null },
    ],
    refused: 0,
    past: 0,
    error: null,
  })
})

test('send: nothing to send, a --reply-to that is no number, or an option it doesn\'t take, queues nothing', t => {
  const { send, sendDir } = setup(t)
  for (const [args, input, said] of [
    [[], '', /nothing to send/],
    [[], ' \n\t\n', /nothing to send/],
    [['   '], '', /nothing to send/],
    [['--reply-to'], '', /--reply-to takes the number/],
    [['--reply-to', 'soon', 'Hi'], '', /not "soon"/],
    [['--reply-to', '0', 'Hi'], '', /--reply-to takes the number/],
    [['--reply-to', '1050-1053', 'Hi'], '', /--reply-to takes the number/],
    [['--reply-to', '9'.repeat(20), 'Hi'], '', /--reply-to takes the number/],
    [['-r', '1050', 'Hi'], '', /takes no option "-r"/],
    [['--to=1050', 'Hi'], '', /takes no option "--to=1050"/],
  ]) {
    const result = send(args, input)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, said, args.join(' '))
    assert.equal(result.stdout, '', args.join(' '))
  }
  assert.deepEqual(fs.readdirSync(sendDir), [])
  assert.match(send(['--help']).stdout, /^usage: send \[--reply-to <seq>\]/)
  assert.equal(send(['--help']).code, 0)
})

test('send: each takes the number after the highest there, and two at once take two', t => {
  const { send, sendDir, sends } = setup(t)
  fs.writeFileSync(path.join(sendDir, '7.json'), '{"text":"seven"}\n')
  fs.writeFileSync(path.join(sendDir, 'notes.txt'), 'not an entry\n')
  assert.equal(send(['eight']).code, 0)
  assert.equal(fs.readFileSync(path.join(sendDir, '8.json'), 'utf8'), '{"text":"eight"}\n')
  // Two at once, from a shell, as an agent can start them.
  execFileSync('sh', ['-c', `"$0" "$1" one & "$0" "$1" two & wait`, process.execPath, path.join(path.dirname(sendDir), 'bin', 'send')])
  const messages = sends().messages.map(message => message.text)
  assert.deepEqual(messages.slice(0, 2), ['seven', 'eight'])
  assert.deepEqual(messages.slice(2).sort(), ['one', 'two'])
})

test('send: without its folder it makes it; with it unwritable it says so, and fails', { skip: skipIfRoot }, t => {
  const { send, sendDir } = setup(t)
  fs.rmdirSync(sendDir)
  assert.equal(send(['made']).code, 0)
  assert.deepEqual(fs.readdirSync(sendDir), ['1.json'])
  fs.chmodSync(sendDir, 0o500)
  atEnd(t, () => fs.chmodSync(sendDir, 0o700))
  assert.deepEqual(send(['refused']), { code: 1, stdout: '', stderr: "send: couldn't queue the message (EACCES)\n" })
})

// ---------------------------------------------------------------------------------------------
// mark

test('mark: done and failed, each a line of the marks file, which the runner reads', t => {
  const { mark, marksFile, marks } = setup(t)
  assert.deepEqual(mark(['done', '1050', '#1051', '01052', '1050']), { code: 0, stdout: 'mark: 1050, 1051 and 1052 marked done\n', stderr: '' })
  assert.deepEqual(mark(['failed', '1053', 'the PDF needs a password']), { code: 0, stdout: 'mark: 1053 marked failed\n', stderr: '' })
  // A reason in several words, and with line breaks: one line, its spaces one each.
  assert.equal(mark(['failed', '#1054', 'blurry', ' photo\n\nof a receipt ']).code, 0)
  assert.equal(mark(['done', '1055']).stdout, 'mark: 1055 marked done\n')
  assert.equal(fs.readFileSync(marksFile, 'utf8'), 'done 1050\ndone 1051\ndone 1052\nfailed 1053 the PDF needs a password\nfailed 1054 blurry photo of a receipt\ndone 1055\n')
  assert.deepEqual(marks(), {
    done: [1050, 1051, 1052, 1055],
    failed: [
      { seq: 1053, reason: 'the PDF needs a password' },
      { seq: 1054, reason: 'blurry photo of a receipt' },
    ],
    unreadable: 0,
    refused: null,
  })
})

test("mark: without done or failed, a number, or a reason, or with a word that isn't a number, marks nothing", t => {
  const { mark, marksFile } = setup(t)
  for (const [args, said] of [
    [[], /say done or failed first/],
    [['DONE', '1050'], /say done or failed first/],
    [['done'], /name the line's number/],
    [['done', '1050', 'soon'], /"soon" isn't a line's number; nothing was marked/],
    [['done', '1050-1053'], /"1050-1053" isn't a line's number/],
    [['done', '0'], /"0" isn't a line's number/],
    [['done', '9'.repeat(20)], /isn't a line's number/],
    [['failed', '1053'], /say why 1053 failed/],
    [['failed', '1053', ' \n '], /say why 1053 failed/],
    [['failed', 'the', 'PDF'], /"the" isn't a line's number/],
  ]) {
    const result = mark(args)
    assert.equal(result.code, 2, args.join(' '))
    assert.match(result.stderr, said, args.join(' '))
  }
  assert.equal(fs.existsSync(marksFile), false)
  assert.equal(mark(['--help']).code, 0)
})

test('mark: with its file unwritable it says so, and fails', { skip: skipIfRoot }, t => {
  const { mark, marksFile } = setup(t)
  fs.writeFileSync(marksFile, '')
  fs.chmodSync(marksFile, 0o400)
  assert.deepEqual(mark(['done', '1050']), { code: 1, stdout: '', stderr: "mark: couldn't write the marks (EACCES); nothing was marked\n" })
})

// ---------------------------------------------------------------------------------------------
// Reading the marks

test('marks: a line marked both ways is failed, the first reason counts, one the run wasn\'t given is ignored, and a reason is one short line', t => {
  atEnd(t, overrideLimits({ REASON_MAX_CHARS: 10 }))
  const marks = { done: [1, 3, 77, 4, 5], failed: [{ seq: 3, reason: 'changed my mind' }, { seq: 88, reason: 'not mine' }, { seq: 4, reason: '' }, { seq: 6, reason: ' two\n lines ' }], unreadable: 0, refused: null }
  const marked = marksOf(marks, [1, 3, 4, 5, 6, 9])
  assert.deepEqual([...marked.done], [1, 5])
  assert.deepEqual([...marked.failed], [
    [3, 'changed m…'],
    [4, NO_REASON],
    [6, 'two lines'],
  ])
  assert.deepEqual(marked.unknown, [77, 88])
  // A scheduled run is given nothing: every mark is ignored.
  assert.deepEqual(marksOf(marks, []).unknown, [1, 3, 4, 5, 6, 77, 88])
})

test('marks: a reason from outside is one line, cut at REASON_MAX_CHARS', t => {
  atEnd(t, overrideLimits({ REASON_MAX_CHARS: 10 }))
  assert.equal(shortReason('  two\n lines '), 'two lines')
  assert.equal(shortReason('0123456789'), '0123456789')
  assert.equal(shortReason('0123456789ab'), '012345678…')
  assert.equal(shortReason('😀😀😀😀😀😀😀😀😀😀😀'), '😀😀😀😀😀😀😀😀😀…')
})

test("marks: a line mark doesn't write, a number of twenty digits, bytes that aren't UTF-8, and half a line at the end, are counted and passed over", t => {
  const { marksFile, marks } = setup(t)
  const lines = ['done 1050', `done ${'9'.repeat(20)}`, 'done 1051 more', 'failed', 'failed 1052', 'DONE: 1053', 'done 01054', 'done -1', 'done #1055', ' done 1056', 'done 1057\r', 'failed 1058 \u0000 a\rb', 'done 0']
  fs.writeFileSync(marksFile, Buffer.concat([Buffer.from(lines.map(text => `${text}\n`).join('')), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('done 1059')]))
  assert.deepEqual(marks(), {
    done: [1050],
    failed: [
      { seq: 1052, reason: '' },
      { seq: 1058, reason: '\u0000 a\rb' },
    ],
    unreadable: 12,
    refused: null,
  })
  // A file of nothing, and none at all, are no marks.
  fs.writeFileSync(marksFile, '')
  assert.deepEqual(marks(), { done: [], failed: [], unreadable: 0, refused: null })
  fs.rmSync(marksFile)
  assert.deepEqual(marks(), { done: [], failed: [], unreadable: 0, refused: null })
})

test('marks: a marks file that is a link, a FIFO, a folder, a file with two names or one past MARKS_MAX_BYTES is refused whole, and nothing in it is read', t => {
  const { paths, marksFile, marks } = setup(t)
  const elsewhere = path.join(paths.agentRunSession('lifelog'), 'elsewhere.txt')
  fs.writeFileSync(elsewhere, 'done 1050\n')
  const cases = [
    ['a link', () => fs.symlinkSync(elsewhere, marksFile), 'EUNTRUSTED'],
    ['a FIFO', () => execFileSync('mkfifo', [marksFile]), 'EUNTRUSTED'],
    ['a folder', () => fs.mkdirSync(marksFile), 'EUNTRUSTED'],
    ['two names', () => fs.linkSync(elsewhere, marksFile), 'EUNTRUSTED'],
    ['too large', () => fs.writeFileSync(marksFile, 'done 1050\n'.repeat(limits.MARKS_MAX_BYTES / 10 + 1)), 'EFBIG'],
    [
      'holes past the limit',
      () => {
        fs.writeFileSync(marksFile, 'done 1050\n')
        fs.truncateSync(marksFile, limits.MARKS_MAX_BYTES + 1)
      },
      'EFBIG',
    ],
  ]
  for (const [what, leave, code] of cases) {
    leave()
    assert.deepEqual(marks(), { done: [], failed: [], unreadable: 0, refused: code }, what)
    fs.rmSync(marksFile, { recursive: true })
  }
})

test('marks: a marks file the runner can\'t read is refused whole', { skip: skipIfRoot }, t => {
  const { marksFile, marks } = setup(t)
  fs.writeFileSync(marksFile, 'done 1050\n')
  fs.chmodSync(marksFile, 0o000)
  assert.deepEqual(marks(), { done: [], failed: [], unreadable: 0, refused: 'EACCES' })
})

// ---------------------------------------------------------------------------------------------
// Reading what send queued

const entry = (text, extra = {}) => `${JSON.stringify({ text, ...extra })}\n`

test('sends: in the order of their numbers, the first RUN_MAX_SENDS read, the rest counted unread', t => {
  atEnd(t, overrideLimits({ RUN_MAX_SENDS: 3 }))
  const { sendDir, sends } = setup(t)
  for (const n of [10, 2, 30, 4, 100, 9]) fs.writeFileSync(path.join(sendDir, `${n}.json`), entry(`#${n}`))
  // One past the limit that isn't an entry is never opened, so it costs nothing.
  execFileSync('mkfifo', [path.join(sendDir, '50.json')])
  assert.deepEqual(sends(), {
    messages: ['#2', '#4', '#9'].map(text => ({ text, replyTo: null })),
    refused: 0,
    past: 4,
    error: null,
  })
  atEnd(t, overrideLimits({ RUN_MAX_SENDS: 0 }))
  assert.deepEqual(sends(), { messages: [], refused: 0, past: 7, error: null })
})

test("sends: an entry that is a link, a FIFO, a folder, a file with two names or one past SEND_ENTRY_MAX_BYTES, or not what send writes, is refused, and its place isn't taken", t => {
  atEnd(t, overrideLimits({ RUN_MAX_SENDS: 30 }))
  const { paths, sendDir, sends } = setup(t)
  const put = (name, contents) => fs.writeFileSync(path.join(sendDir, name), contents)
  const elsewhere = path.join(paths.agentRunSession('lifelog'), 'elsewhere.json')
  fs.writeFileSync(elsewhere, entry('From elsewhere.'))
  fs.symlinkSync(elsewhere, path.join(sendDir, '1.json'))
  execFileSync('mkfifo', [path.join(sendDir, '2.json')])
  fs.mkdirSync(path.join(sendDir, '3.json'))
  put('3.json/1.json', entry('In a folder.'))
  fs.linkSync(elsewhere, path.join(sendDir, '4.json'))
  put('5.json', entry('x'.repeat(limits.SEND_ENTRY_MAX_BYTES)))
  const bad = ['{"text": "cut', '[]', 'null', '"text"', entry('Extra.', { channels: ['whatsapp'] }), entry(''), entry(' \n\t'), entry('Reply.', { replyTo: '1042' }), entry('Reply.', { replyTo: 0 }), entry('Reply.', { replyTo: 1.5 }), entry('Reply.', { replyTo: 2 ** 53 }), '{"replyTo": 1}\n', '{"text": 7}\n']
  bad.forEach((contents, n) => put(`${10 + n}.json`, contents))
  // Names send doesn't give.
  for (const name of ['.hidden.json', '01.json', 'x.json', '90', '90.JSON', `${'9'.repeat(20)}.json`, '9.json.tmp']) put(name, entry('Not a name send gives.'))
  fs.writeFileSync(Buffer.concat([Buffer.from(`${sendDir}/`), Buffer.from([0x39, 0x31, 0xff, 0x2e, 0x6a, 0x73, 0x6f, 0x6e])]), entry('Not UTF-8.'))
  // And one entry as send writes it, which goes.
  put('99.json', entry('Fine.', { replyTo: 1042 }))
  assert.deepEqual(sends(), { messages: [{ text: 'Fine.', replyTo: 1042 }], refused: 5 + bad.length + 8, past: 0, error: null })
})

test("sends: an entry the runner can't read is refused", { skip: skipIfRoot }, t => {
  const { sendDir, sends } = setup(t)
  fs.writeFileSync(path.join(sendDir, '1.json'), entry('Locked.'))
  fs.chmodSync(path.join(sendDir, '1.json'), 0o000)
  fs.writeFileSync(path.join(sendDir, '2.json'), entry('Open.'))
  assert.deepEqual(sends(), { messages: [{ text: 'Open.', replyTo: null }], refused: 1, past: 0, error: null })
  // A folder it can't read gives nothing, and says why.
  fs.chmodSync(sendDir, 0o000)
  atEnd(t, () => fs.chmodSync(sendDir, 0o700))
  assert.deepEqual(sends(), { messages: [], refused: 0, past: 0, error: 'EACCES' })
})

test('sends: a text of nearly a megabyte is read whole, and one with U+0000 or half a surrogate pair is made one a channel can send', t => {
  const { sendDir, sends } = setup(t)
  const long = 'long '.repeat(Math.floor((limits.SEND_ENTRY_MAX_BYTES - 100) / 5))
  fs.writeFileSync(path.join(sendDir, '1.json'), entry(long))
  fs.writeFileSync(path.join(sendDir, '2.json'), '{"text":"a\\u0000b\\ud800c\\udc00"}\n')
  const { messages } = sends()
  assert.equal(messages[0].text, long)
  // U+0000 stays for the outbox's own cut, which makes it U+FFFD (`exchange.md`).
  assert.equal(messages[1].text, 'a\u0000b�c�')
})

test('sends: no folder is no messages; a link or a file in its place gives none, and says why', t => {
  const { paths, sendDir, sends } = setup(t)
  fs.rmdirSync(sendDir)
  assert.deepEqual(sends(), { messages: [], refused: 0, past: 0, error: null })
  const elsewhere = path.join(paths.agentRunSession('lifelog'), 'folder')
  fs.mkdirSync(elsewhere)
  fs.writeFileSync(path.join(elsewhere, '1.json'), entry('Through a link.'))
  fs.symlinkSync(elsewhere, sendDir)
  assert.deepEqual(sends(), { messages: [], refused: 0, past: 0, error: 'ENOTDIR' })
  fs.rmSync(sendDir)
  fs.writeFileSync(sendDir, entry('A file.'))
  assert.deepEqual(sends(), { messages: [], refused: 0, past: 0, error: 'ENOTDIR' })
})

test('sends: more names than a run can make are read as a stream, and only the first RUN_MAX_SENDS opened', t => {
  const { sendDir, sends } = setup(t)
  // One more than the sandbox lets a run make (`RUN_NAMES_MAX_COUNT`), the last numbers first.
  const count = limits.RUN_NAMES_MAX_COUNT + 1
  for (let n = count; n >= 1; n--) fs.writeFileSync(path.join(sendDir, `${n}.json`), '')
  // Each is empty, which `send` never writes, so only the ones opened are refused.
  const started = performance.now()
  const read = sends()
  const ms = performance.now() - started
  assert.deepEqual(read, { messages: [], refused: limits.RUN_MAX_SENDS, past: count - limits.RUN_MAX_SENDS, error: null })
  t.diagnostic(`${count} names in ${Math.round(ms)} ms`)
})

// ---------------------------------------------------------------------------------------------
// Clearing what the run could write

test('clearing: run/session/, run/send/ and run/marks.txt are emptied or removed, whatever pi left, the folders kept; an error is logged and passed over', t => {
  const { paths, sendDir, marksFile } = setup(t)
  const { log, entries } = createTestLog()
  deepTree(sendDir)
  fs.writeFileSync(path.join(paths.agentRunSession('lifelog'), 'x.jsonl'), 'x')
  fs.mkdirSync(marksFile)
  fs.writeFileSync(path.join(marksFile, 'inside'), 'x')
  clearRunWrites({ paths, agent: { name: 'lifelog' }, log })
  assert.deepEqual(fs.readdirSync(sendDir), [])
  assert.deepEqual(fs.readdirSync(paths.agentRunSession('lifelog')), [])
  assert.equal(fs.existsSync(marksFile), false)
  assert.deepEqual(entries, [])

  // A file where run/send/ was, which only a hand could leave: left to the next run's prepareRun,
  // and the rest cleared.
  fs.rmdirSync(sendDir)
  fs.writeFileSync(sendDir, 'x')
  fs.writeFileSync(marksFile, 'done 1\n')
  clearRunWrites({ paths, agent: { name: 'lifelog' }, log })
  assert.equal(fs.existsSync(marksFile), false)
  assert.deepEqual(entries.map(entry => [entry.event, entry.left, entry.code]), [['runner.run_left', 'send', 'ENOTDIR']])
})

// ---------------------------------------------------------------------------------------------
// The entries made of what send queued, and the reactions

const LINES = [
  line.text(1, '2026-11-09T15:00:00Z', 'coffee 120'),
  line.sent(2, '2026-11-09T15:00:10Z', 'Which café?', { replyTo: 1 }),
  line.text(3, '2026-11-09T15:01:00Z', 'Blue Tokai', { replyTo: 2 }),
  line.edit(4, '2026-11-09T15:02:00Z', 1, 'coffee 150'),
  line.text(5, '2026-11-09T15:03:00Z', 'gone soon'),
  line.delete(6, '2026-11-09T15:04:00Z', 5),
  line.reaction(7, '2026-11-09T15:05:00Z', 2, '👍'),
  line.reaction(8, '2026-11-09T15:06:00Z', 1, '❤️'),
  line.text(9, '2026-11-09T15:07:00Z', 'lunch 300'),
]
const index = indexOf(LINES)
const AGENT = { name: 'lifelog', sends: ['whatsapp'], replyMode: 'quiet', ackReaction: '✅' }
// Each entry of the agent's carries the channels its sends names.
const SENDS = { channels: ['whatsapp'] }
const message = (text, replyTo = null) => ({ text, replyTo })

test('entries: what a reply quotes', () => {
  assert.equal(replyTarget(index, 1), 1)
  // A line Scooter sent.
  assert.equal(replyTarget(index, 2), 2)
  // An edit or a deletion: the message it changes.
  assert.equal(replyTarget(index, 4), 1)
  assert.equal(replyTarget(index, 6), 5)
  // A reaction, or a number that doesn't exist: nothing.
  assert.equal(replyTarget(index, 7), null)
  assert.equal(replyTarget(index, 8), null)
  assert.equal(replyTarget(index, 99), null)
  assert.equal(replyTarget(index, 2 ** 53 - 1), null)
})

test('entries: the messages in order, then a ✅ for each message marked done that no message replies to', () => {
  const { entries, answered } = sendEntries({ messages: [message('Logged the lunch.'), message('Blue Tokai it is.', 3), message('Which one?', 99), message('Thanks.', 7)], agent: AGENT, index, about: 9 })
  assert.deepEqual(entries, [
    { type: 'text', by: 'lifelog', text: 'Logged the lunch.', about: 9, ...SENDS },
    { type: 'text', by: 'lifelog', text: 'Blue Tokai it is.', replyTo: 3, ...SENDS },
    // #99 doesn't exist, and #7 is a reaction: no quote, and about the newest item.
    { type: 'text', by: 'lifelog', text: 'Which one?', about: 9, ...SENDS },
    { type: 'text', by: 'lifelog', text: 'Thanks.', about: 9, ...SENDS },
  ])
  // #3 got a reply instead; #4 is an edit, and #5 was deleted since.
  assert.deepEqual(ackEntries({ agent: AGENT, index, done: new Set([9, 1, 3, 4, 5]), answered }), [
    { type: 'react', by: 'lifelog', target: 1, emoji: '✅', ...SENDS },
    { type: 'react', by: 'lifelog', target: 9, emoji: '✅', ...SENDS },
  ])

  // A reply to an edit quotes its message, which then gets no reaction.
  const toEdit = sendEntries({ messages: [message('Now ₹150.', 4)], agent: AGENT, index, about: 4 })
  assert.deepEqual(toEdit.entries, [{ type: 'text', by: 'lifelog', text: 'Now ₹150.', replyTo: 1, ...SENDS }])
  assert.deepEqual(ackEntries({ agent: AGENT, index, done: new Set([1, 4]), answered: toEdit.answered }), [])

  // A scheduled task's message is Scooter's own: no `about`.
  assert.deepEqual(sendEntries({ messages: [message('Evening: all filed.')], agent: AGENT, index }).entries, [{ type: 'text', by: 'lifelog', text: 'Evening: all filed.', ...SENDS }])
})

test('entries: confirm mode reacts to nothing, "" reacts to nothing, and sends: [] sends nothing; each entry carries every channel of sends', () => {
  const done = new Set([9])
  assert.deepEqual(ackEntries({ agent: { ...AGENT, replyMode: 'confirm' }, index, done }), [])
  assert.deepEqual(ackEntries({ agent: { ...AGENT, ackReaction: '' }, index, done }), [])
  assert.deepEqual(ackEntries({ agent: { ...AGENT, sends: [] }, index, done }), [])
  const both = { ...AGENT, sends: ['email', 'whatsapp'] }
  assert.deepEqual(sendEntries({ messages: [message('Hi.')], agent: both, index, about: 9 }).entries[0].channels, ['email', 'whatsapp'])
  assert.deepEqual(ackEntries({ agent: both, index, done })[0].channels, ['email', 'whatsapp'])
})
