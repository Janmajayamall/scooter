// `show`, the program that ships with the runner for the VM, and the index file and the offsets
// file it reads: what the runner writes into `run/` (`prepareRun`, `indexFileText`,
// `offsetsFileText`), and what `show` prints from them, run as the VM runs it, as a program of its
// own, without `TZ`, which it doesn't read. That it runs by its name in the VM, from the `PATH` the
// runner gives and from pi's bash tool, and prints there what it prints here, are `VM 7` and
// `VM 8` in `test/tools/vm.test.mjs`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makePaths } from '../src/common/paths.mjs'
import { toLocal, utcOffsetText } from '../src/common/time.mjs'
import { indexFileText, offsetsFileText, prepareRun } from '../src/runner/agentdir.mjs'
import { openDatastore } from '../src/runner/datastore.mjs'
import { fillerLines, handWrittenLines, line, writeDatastore } from './support/runner.mjs'
import { makeTestDir } from './support/tmp.mjs'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = number => String(number).padStart(2, '0')

// A time as `show`'s header gives it, by the runner's own time code: the zone's clock, and its
// offset from UTC then.
function headerTime(at, zone) {
  const t = toLocal(Date.parse(at), zone)
  return `${DAYS[t.weekday - 1]} ${t.day} ${MONTHS[t.month - 1]} ${t.year} ${pad(t.hour)}:${pad(t.minute)} ${utcOffsetText(Math.round(t.offsetMinutes * 60) * 1000)}`
}

// A data folder with the datastore's `lines`, written as the bridge writes them (or as given, with
// `check: false`), and `run/` made for a run as the runner makes it, for the owner's zone `zone`,
// with the index of the lines it has read. `show(args)` runs the run's copy of `show`, as the VM's
// `env` would, with Node, and with no `TZ` unless given one.
function setup(t, lines, { check = true, dataDir, zone = 'Asia/Kolkata' } = {}) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: dataDir ?? path.join(root, 'data'), configDir: path.join(root, 'config') })
  fs.mkdirSync(paths.datastore, { recursive: true })
  writeDatastore(paths, lines, { check })
  const prompt = path.join(paths.configDir, 'prompts', 'lifelog.md')
  fs.mkdirSync(path.dirname(prompt), { recursive: true })
  fs.writeFileSync(prompt, 'You are lifelog.\n')
  fs.mkdirSync(paths.agentDir('lifelog'), { recursive: true })
  const agent = { name: 'lifelog', prompt: { path: 'prompts/lifelog.md', file: prompt }, skills: [] }
  const prepare = (timeZone = zone) => {
    const datastore = openDatastore({ paths })
    datastore.poll()
    prepareRun({ paths, agent, protocol: '', index: datastore.index, timeZone })
    return datastore.index
  }
  const index = prepare()
  const program = path.join(paths.agentRunBin('lifelog'), 'show')
  const show = (args, { env = {}, encoding = 'utf8' } = {}) => {
    const result = spawnSync(process.execPath, [program, ...args], { env, encoding })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  // The line with this `seq` as the log holds it, and where.
  const stored = seq => {
    const { day, number } = index.get(seq)
    return { text: fs.readFileSync(paths.dayLog(day), 'utf8').split('\n')[number - 1], where: `${paths.dayLog(day)}:${number}`, day }
  }
  return { root, paths, index, prepare, program, show, stored }
}

// A reply to a photo the agent asked about, an edit in a later day of a message in an earlier one,
// a deletion and a reaction, an email with two attachments, and messages Scooter sent.
function everyKind() {
  return [
    ...fillerLines(3),
    line.text(4, '2026-11-08T07:12:00Z', '', { files: [{ path: '4.jpg', mime: 'image/jpeg', bytes: 10 }] }),
    line.sent(5, '2026-11-08T07:13:00Z', 'Blue Tokai, ₹450 at 12:40: work or personal?', { replyTo: 4 }),
    line.text(6, '2026-11-08T15:44:00Z', 'coffee 120'),
    line.text(7, '2026-11-09T15:50:00Z', 'work', { replyTo: 5, data: { quoted: 'Blue Tokai, ₹450 at 12:40: work or personal?' } }),
    line.edit(8, '2026-11-09T15:52:00Z', 6, 'coffee 150'),
    line.delete(9, '2026-11-09T15:53:00Z', 7),
    line.reaction(10, '2026-11-09T15:54:00Z', 4, '👍'),
    line.email(11, '2026-11-09T16:12:40Z', 'Call with Sam', 'Recording from today\'s call.', {
      files: [
        { path: '11.eml', mime: 'message/rfc822', bytes: 100 },
        { path: '11-2.m4a', mime: 'audio/mp4', name: 'Call with Sam.m4a', bytes: 50 },
        { path: '11-3.pdf', mime: 'application/pdf', name: 'notes 9 Nov.pdf', bytes: 20 },
      ],
    }),
    { ...line.sent(12, '2026-11-09T16:13:00Z', '⚠️ I couldn\'t process your last messages.'), by: 'runner' },
  ].map(fixture => JSON.parse(JSON.stringify(fixture)))
}

test('show: each line as stored, under its seq, its time in the owner\'s zone and where it is, with its files and the one line it points at', t => {
  const { show, stored, paths } = setup(t, everyKind())
  const day8 = paths.dayDir('2026/11/08')
  const day9 = paths.dayDir('2026/11/09')
  const block = (seq, at, { indent = '', lead = '', files = [] } = {}) => {
    const { text, where } = stored(seq)
    return [`${indent}${lead}${seq}  ${headerTime(at, 'Asia/Kolkata')}  ${where}`, `${indent}${text}`, ...files.map(file => `${indent}  file ${file}`)]
  }

  // An edit, in a later day's log, points at the message it changes, in an earlier one.
  let result = show(['8'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, [...block(8, '2026-11-09T15:52:00Z'), ...block(6, '2026-11-08T15:44:00Z', { indent: '  ', lead: 'points at ' }), ''].join('\n'))
  assert.equal(result.stderr, '')

  // A reply points at what it replies to, and only that: one hop, so not at the photo the bot's
  // question was about, and nothing that points back at it, such as its deletion.
  result = show(['7'])
  assert.equal(result.stdout, [...block(7, '2026-11-09T15:50:00Z'), ...block(5, '2026-11-08T07:13:00Z', { indent: '  ', lead: 'points at ' }), ''].join('\n'))
  // The bot's question shows the photo, with its file.
  result = show(['5'])
  assert.equal(result.stdout, [...block(5, '2026-11-08T07:13:00Z'), ...block(4, '2026-11-08T07:12:00Z', { indent: '  ', lead: 'points at ', files: [`${day8}/4.jpg`] }), ''].join('\n'))
  // A message that points at nothing shows none of what points at it: not its reaction, nor
  // Scooter's question about it.
  result = show(['4'])
  assert.equal(result.stdout, [...block(4, '2026-11-08T07:12:00Z', { files: [`${day8}/4.jpg`] }), ''].join('\n'))
  // A deletion and a reaction point at their message.
  assert.match(show(['9']).stdout, /^ {2}points at 7 {2}/m)
  assert.match(show(['10']).stdout, /^ {2}points at 4 {2}/m)
  // An email: the whole email, then its attachments, a name with spaces among them, each by its
  // full path.
  result = show(['11'])
  assert.equal(result.stdout, [...block(11, '2026-11-09T16:12:40Z', { files: [`${day9}/11.eml`, `${day9}/11-2.m4a`, `${day9}/11-3.pdf`] }), ''].join('\n'))
  // What Scooter sent on its own.
  assert.equal(show(['12']).stdout, [...block(12, '2026-11-09T16:13:00Z'), ''].join('\n'))

  // Several numbers, one after another, each after an empty line; `#8` and a leading zero are the
  // same numbers.
  result = show(['8', '#4', '0006'])
  assert.equal(result.code, 0)
  assert.equal(
    result.stdout,
    [
      ...block(8, '2026-11-09T15:52:00Z'),
      ...block(6, '2026-11-08T15:44:00Z', { indent: '  ', lead: 'points at ' }),
      '',
      ...block(4, '2026-11-08T07:12:00Z', { files: [`${day8}/4.jpg`] }),
      '',
      ...block(6, '2026-11-08T15:44:00Z'),
      '',
    ].join('\n'),
  )
})

test('show: a number that isn\'t in the run\'s index file prints "no such line", and the command fails', t => {
  const { show, stored } = setup(t, everyKind())
  for (const args of [['13'], ['0'], ['99999999999999999999'], ['abc'], ['-1'], ['1e3'], ['12.0'], ['--'], ['']]) {
    const result = show(args)
    assert.equal(result.code, 1, args[0])
    assert.equal(result.stdout, `${args[0] === '' ? '""' : args[0] === '99999999999999999999' ? '99999999999999999999' : args[0]}  no such line\n`, args[0])
  }
  // Among others, which are printed: the command still fails.
  const result = show(['13', '6'])
  assert.equal(result.code, 1)
  assert.equal(result.stdout, `13  no such line\n\n6  ${headerTime('2026-11-08T15:44:00Z', 'Asia/Kolkata')}  ${stored(6).where}\n${stored(6).text}\n`)
  // A word that could break a line is shown as a JSON string.
  assert.equal(show(['1\n2']).stdout, '"1\\n2"  no such line\n')
  // Called with no number, it says how it is used.
  const usage = show([])
  assert.equal(usage.code, 2)
  assert.match(usage.stdout, /^usage: show <seq>…\n/)
  assert.equal(show(['--help']).code, 0)
})

test('show: a line that arrives during the run, or a log that ends in part of a line, is no line of the index, and changes no line that is', t => {
  const { show, paths, prepare, stored } = setup(t, [...fillerLines(3), line.text(4, '2026-11-09T15:50:00Z', 'coffee 120')])
  const before = show(['4']).stdout
  // Lines arrive during the run, in the same log and a new day's; the newest ends in part of one.
  writeDatastore(paths, [line.edit(5, '2026-11-09T15:52:00Z', 4, 'coffee 150'), line.text(6, '2026-11-10T01:00:00Z', 'tea')])
  fs.appendFileSync(paths.dayLog('2026/11/10'), '{"seq":7,"kind":"message"')
  assert.equal(show(['4']).stdout, before)
  for (const seq of ['5', '6', '7']) assert.equal(show([seq]).stdout, `${seq}  no such line\n`)

  // The next run's index is written from what the runner has read, which is only whole lines: the
  // part of a line at the end isn't in it, and the lines before it are shown whole.
  prepare()
  assert.equal(show(['7']).stdout, '7  no such line\n')
  assert.equal(show(['4']).stdout, before)
  const day10 = paths.dayLog('2026/11/10')
  assert.equal(show(['6']).stdout, `6  ${headerTime('2026-11-10T01:00:00Z', 'Asia/Kolkata')}  ${day10}:1\n${fs.readFileSync(day10, 'utf8').split('\n')[0]}\n`)
  assert.equal(stored(4).text, before.split('\n')[1])
})

test('show: a line of any length, and bytes that aren\'t UTF-8, are printed as stored, byte for byte', t => {
  // A text of 300 KB, past show's buffer, one whose line crosses the buffer's edge, and a text with
  // line breaks and quotes, which the line holds escaped.
  const long = 'x'.repeat(300_000)
  const lines = [...fillerLines(1), line.text(2, '2026-11-09T15:50:00Z', 'y'.repeat(65_000)), line.text(3, '2026-11-09T15:51:00Z', long), line.text(4, '2026-11-09T15:52:00Z', 'line one\nline two "quoted" \\ ₹450 ✅')]
  const { show, stored, paths, prepare } = setup(t, lines)
  for (const seq of [2, 3, 4]) {
    const result = show([String(seq)])
    assert.equal(result.code, 0)
    assert.equal(result.stdout.split('\n')[1], stored(seq).text)
    assert.equal(result.stdout.split('\n').length, 3)
  }
  assert.equal(JSON.parse(show(['3']).stdout.split('\n')[1]).text, long)

  // A line written by hand whose text holds bytes that aren't UTF-8, which the runner reads as U+FFFD
  // and keeps: show prints the bytes the log holds.
  const raw = Buffer.concat([Buffer.from('{"seq":5,"kind":"message","dir":"in","at":"2026-11-09T15:53:00Z","source":"whatsapp","sourceId":"RAW","trust":"owner","text":"caf'), Buffer.from([0xe9, 0xff]), Buffer.from('"}\n')])
  fs.appendFileSync(paths.dayLog('2026/11/09'), raw)
  prepare()
  const result = show(['5'], { encoding: 'buffer' })
  assert.equal(result.code, 0)
  assert.deepEqual(result.stdout.subarray(result.stdout.indexOf(0x0a) + 1), raw)
})

test('show: the time is the owner\'s, with the zone\'s offset from UTC, across midnight, the clocks\' changes and a new year, in every zone, as the runner\'s own time code gives it', t => {
  // Every 15 minutes around the changes of the clocks in 2026 in Europe and North America, Lord
  // Howe's half hour, and the new year.
  const windows = [
    ['2026-03-07T22:00:00Z', '2026-03-08T12:00:00Z'],
    ['2026-03-28T22:00:00Z', '2026-03-29T04:00:00Z'],
    ['2026-10-03T13:00:00Z', '2026-10-03T18:00:00Z'],
    ['2026-10-24T22:00:00Z', '2026-10-25T04:00:00Z'],
    ['2026-10-31T22:00:00Z', '2026-11-01T10:00:00Z'],
    ['2026-12-31T08:00:00Z', '2027-01-01T08:00:00Z'],
  ]
  const ats = []
  for (const [from, to] of windows) {
    for (let ms = Date.parse(from); ms <= Date.parse(to); ms += 15 * 60 * 1000) ats.push(new Date(ms).toISOString().replace('.000Z', 'Z'))
  }
  // A minute either side of each zone's midnight on 9 November.
  for (const at of ['2026-11-08T18:29:00Z', '2026-11-08T18:30:00Z', '2026-11-08T23:59:00Z', '2026-11-09T00:00:00Z', '2026-11-09T04:59:00Z', '2026-11-09T05:00:00Z', '2026-11-09T11:14:00Z', '2026-11-09T11:15:00Z']) ats.push(at)
  // 00:30 and 12:30 on the 1st and the 15th of every month of 2026 and 2027, the times at which the
  // image's Node was found an hour off in twelve zones, and the first and last times a line can
  // have.
  for (const year of [2026, 2027]) {
    for (let month = 1; month <= 12; month++) {
      for (const day of ['01', '15']) for (const time of ['00:30', '12:30']) ats.push(`${year}-${pad(month)}-${day}T${time}:00Z`)
    }
  }
  // Times when zones' offsets weren't whole minutes: Kolkata's local mean time, its change to
  // Madras's, and Monrovia's -00:44:30 until 1972; and a line can be anywhere from year 100 to 9999.
  ats.push('1850-01-01T00:00:00Z', '1854-06-27T18:06:31Z', '1854-06-27T18:06:32Z', '1960-01-01T12:00:00Z', '0100-01-01T00:00:00Z', '9999-12-31T23:59:59Z')
  ats.sort()
  const { show, prepare } = setup(t, ats.map((at, n) => line.text(n + 1, at, 'x')))
  const seqs = ats.map((_, n) => String(n + 1))
  const zones = [
    ['Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/St_Johns', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'Pacific/Kiritimati', 'UTC'],
    // The thirteen zones for which the image's Node gave another time, or none.
    ['America/Coyhaique', 'Africa/Casablanca', 'Africa/El_Aaiun', 'America/Asuncion', 'America/Edmonton', 'America/Inuvik', 'America/Rainy_River', 'America/Vancouver'],
    ['America/Winnipeg', 'America/Yellowknife', 'Canada/Central', 'Canada/Mountain', 'Canada/Pacific', 'Africa/Monrovia'],
  ].flat()
  for (const zone of zones) {
    prepare(zone)
    const result = show(seqs)
    assert.equal(result.code, 0, `${zone}: ${result.stderr}`)
    const headers = result.stdout.split('\n').filter(text => /^\d+ {2}/.test(text))
    assert.deepEqual(
      headers.map(text => text.split('  ')[1]),
      ats.map(at => headerTime(at, zone)),
      zone,
    )
  }
  // What the review found, as the runner gives it.
  const header = (zone, at) => {
    prepare(zone)
    return show([String(ats.indexOf(at) + 1)]).stdout.split('\n')[0].split('  ')[1]
  }
  assert.equal(header('America/Vancouver', '2026-11-01T12:30:00Z'), 'Sun 1 Nov 2026 05:30 -07:00')
  assert.equal(header('America/Coyhaique', '2026-11-01T12:30:00Z'), 'Sun 1 Nov 2026 09:30 -03:00')
  assert.equal(header('America/Asuncion', '2026-04-01T00:30:00Z'), 'Tue 31 Mar 2026 21:30 -03:00')
  assert.equal(header('Africa/Casablanca', '2026-10-01T00:30:00Z'), 'Thu 1 Oct 2026 00:30 +00:00')
  // UTC is +00:00, and an offset that isn't whole minutes has its seconds.
  assert.equal(header('UTC', '9999-12-31T23:59:59Z'), 'Fri 31 Dec 9999 23:59 +00:00')
  assert.equal(header('Asia/Kolkata', '1850-01-01T00:00:00Z'), 'Tue 1 Jan 1850 05:53 +05:53:28')
  assert.equal(header('Asia/Kolkata', '1854-06-27T18:06:31Z'), 'Tue 27 Jun 1854 23:59 +05:53:28')
  assert.equal(header('Asia/Kolkata', '1854-06-27T18:06:32Z'), 'Tue 27 Jun 1854 23:59 +05:53:20')
  assert.equal(header('Africa/Monrovia', '1960-01-01T12:00:00Z'), 'Fri 1 Jan 1960 11:15 -00:44:30')
  assert.equal(header('Pacific/Kiritimati', '0100-01-01T00:00:00Z'), 'Thu 31 Dec 99 13:30 -10:29:20')
})

test('show: it reads no TZ: the time is the same with TZ unset, empty, another zone or one Node doesn\'t know', t => {
  // Vancouver's clocks went forward on 8 March 2026, and stay there: British Columbia keeps
  // daylight time all year from then on, which the image's Node didn't know.
  const { show } = setup(t, [line.text(1, '2026-01-15T12:30:00Z', 'x'), line.text(2, '2026-11-01T12:30:00Z', 'y')], { zone: 'America/Vancouver' })
  const expected = show(['1', '2'])
  assert.equal(expected.code, 0, expected.stderr)
  assert.match(expected.stdout, /^1 {2}Thu 15 Jan 2026 04:30 -08:00 {2}/m)
  assert.match(expected.stdout, /^2 {2}Sun 1 Nov 2026 05:30 -07:00 {2}/m)
  for (const env of [{ TZ: '' }, { TZ: 'Asia/Kolkata' }, { TZ: 'America/Vancouver' }, { TZ: 'Mars/Olympus' }, { TZ: ':Asia/Kolkata' }, { TZ: 'UTC' }]) {
    assert.deepEqual(show(['1', '2'], { env }), expected, JSON.stringify(env))
  }
})

test('show: without the offsets file, or with one that is damaged or doesn\'t cover a line\'s time, it prints no time it can\'t stand behind', t => {
  const { show, paths, stored, prepare } = setup(t, [...fillerLines(1), line.text(2, '2026-11-09T15:50:00Z', 'x'), line.text(3, '2026-11-10T01:00:00Z', 'y')])
  const offsets = paths.agentRunOffsets('lifelog')
  const good = fs.readFileSync(offsets, 'utf8')
  // As the runner writes it: the days of the lines, 8 to 10 November, in Kolkata.
  assert.equal(good, '2026-11-08T00:00:00Z +05:30\n2026-11-11T00:00:00Z -\n')
  const stops = (text, why) => {
    if (text !== undefined) fs.writeFileSync(offsets, text)
    const result = show(['2'])
    assert.equal(result.code, 2, JSON.stringify(text))
    assert.equal(result.stdout, '', JSON.stringify(text))
    assert.equal(result.stderr, `show: can't read the offsets file ${offsets} (${why})\n`, JSON.stringify(text))
  }
  // Missing, or not a file.
  fs.rmSync(offsets)
  stops(undefined, 'ENOENT')
  fs.mkdirSync(offsets)
  stops(undefined, 'EISDIR')
  fs.rmdirSync(offsets)
  // Damaged: cut short, before or after a line break, or within a row; a row that can't be read,
  // with a time that doesn't exist or an offset out of range; rows out of order, or doubled.
  for (const [text, line] of [
    ['2026-11-08T00:00:00Z +05:30\n', 1],
    ['2026-11-08T00:00:00Z +05:30\n2026-11-11T00:00:00Z -', 2],
    ['2026-11-08T00:00:00Z +05:30\n2026-11-11T00:00:00Z', 2],
    ['2026-11-08T00:00:00Z +05:3\n2026-11-11T00:00:00Z -\n', 1],
    ['2026-11-08T00:00:00Z +5:30\n2026-11-11T00:00:00Z -\n', 1],
    ['2026-11-08T00:00:00Z +24:00\n2026-11-11T00:00:00Z -\n', 1],
    ['2026-11-08T00:00:00Z +05:60\n2026-11-11T00:00:00Z -\n', 1],
    ['2026-11-08T00:00:00Z  +05:30\n2026-11-11T00:00:00Z -\n', 1],
    ['2026-02-30T00:00:00Z +05:30\n2026-11-11T00:00:00Z -\n', 1],
    ['2026-11-08T00:00:00 +05:30\n2026-11-11T00:00:00Z -\n', 1],
    ['2026-11-11T00:00:00Z -\n2026-11-08T00:00:00Z +05:30\n2026-11-11T00:00:00Z -\n', 2],
    ['2026-11-08T00:00:00Z +05:30\n2026-11-08T00:00:00Z +05:30\n2026-11-11T00:00:00Z -\n', 2],
    ['2026-11-08T00:00:00Z +05:30\r\n2026-11-11T00:00:00Z -\r\n', 1],
    ['\n', 1],
  ]) {
    stops(text, `damaged at line ${line}`)
  }

  // A file that covers no line's time, as for a log changed under the run, or covers some: the
  // line is printed, with `no time`, and nothing else changes.
  for (const text of ['', '2026-11-10T00:00:00Z +05:30\n2026-11-11T00:00:00Z -\n', '2026-11-08T00:00:00Z +05:30\n2026-11-09T15:50:00Z -\n2026-11-09T15:50:01Z +05:30\n2026-11-11T00:00:00Z -\n']) {
    fs.writeFileSync(offsets, text)
    const result = show(['2', '3'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, `2  no time  ${stored(2).where}\n${stored(2).text}\n\n3  ${text === '' ? 'no time' : headerTime('2026-11-10T01:00:00Z', 'Asia/Kolkata')}  ${stored(3).where}\n${stored(3).text}\n`, JSON.stringify(text))
  }
  // What a run gives it is whole again.
  prepare()
  assert.equal(fs.readFileSync(offsets, 'utf8'), good)
  assert.match(show(['2']).stdout, /^2 {2}Mon 9 Nov 2026 21:20 \+05:30 {2}/)
})

test('show: a line of a kind, a channel or a field this version doesn\'t know is printed as stored, and the index gives its kind', t => {
  const lines = [...handWrittenLines(), { seq: 10, kind: 'note-v9', dir: 'in', at: '2026-11-09T15:39:00Z', source: 'whatsapp', trust: 'owner', target: 1, replyTo: 2, files: [{ path: '10.png', mime: 'image/png' }] }]
  const { show, stored, paths } = setup(t, lines, { check: false })
  const index = fs.readFileSync(paths.agentRunIndex('lifelog'), 'utf8').split('\n')
  assert.equal(index[1], `2 ${paths.dayLog('2026/11/09')}:2 command`)
  assert.equal(index[2], `3 ${paths.dayLog('2026/11/09')}:3 message`)
  // A kind this version doesn't know may have both: the index, and show, take its target.
  assert.equal(index[9], `10 ${paths.dayLog('2026/11/09')}:10 note-v9 1`)
  for (const seq of [2, 3, 4, 5, 6, 7, 8, 9]) {
    const result = show([String(seq)])
    assert.equal(result.code, 0, `${seq}: ${result.stdout}`)
    assert.equal(result.stdout.split('\n')[1], stored(seq).text)
  }
  const result = show(['10'])
  assert.equal(result.stdout.split('\n')[1], stored(10).text)
  assert.match(result.stdout, /\n {2}file .*\/2026\/11\/09\/10\.png\n {2}points at 1 {2}/)
})

test('show: a path that could break its line is printed as a JSON string, and a data folder with spaces in its path is read', t => {
  const dataDir = path.join(makeTestDir(t), 'my data', 'scooter folder')
  const lines = [...fillerLines(1), line.text(2, '2026-11-09T15:50:00Z', 'x', { files: [{ path: 'a b.jpg', mime: 'image/jpeg', bytes: 1 }, { path: 'c\nd.jpg', mime: 'image/jpeg', bytes: 1 }, { path: 'e f.jpg', mime: 'image/jpeg', bytes: 1 }] })]
  const { show, paths, stored } = setup(t, lines, { dataDir })
  const result = show(['2'])
  assert.equal(result.code, 0, result.stderr)
  const day = paths.dayDir('2026/11/09')
  assert.equal(
    result.stdout,
    [
      `2  ${headerTime('2026-11-09T15:50:00Z', 'Asia/Kolkata')}  ${stored(2).where}`,
      stored(2).text,
      `  file ${day}/a b.jpg`,
      `  file ${JSON.stringify(`${day}/c\nd.jpg`)}`,
      `  file ${JSON.stringify(`${day}/e f.jpg`)}`,
      '',
    ].join('\n'),
  )
})

test('show: a line that isn\'t where the index says, or holds another seq, can\'t be read, and the index file it reads is beside its own folder', t => {
  const { show, paths, program, root } = setup(t, [...fillerLines(3)])
  // The log replaced under the run, as a restore by hand would: the line there is another seq.
  const log = paths.dayLog('2026/11/08')
  const text = fs.readFileSync(log, 'utf8').split('\n')
  fs.writeFileSync(log, [text[1], text[0], ''].join('\n'))
  assert.equal(show(['1']).stdout, `1  can't be read at ${log}:1\n`)
  assert.equal(show(['3']).stdout, `3  can't be read at ${log}:3\n`)
  assert.equal(show(['3']).code, 1)
  fs.rmSync(log)
  assert.equal(show(['2']).stdout, `2  can't be read at ${log}:2\n`)

  // A copy elsewhere finds no index beside it, and says so.
  const copy = path.join(root, 'elsewhere', 'bin', 'show')
  fs.mkdirSync(path.dirname(copy), { recursive: true })
  fs.copyFileSync(program, copy)
  const result = spawnSync(process.execPath, [copy, '1'], { env: { TZ: 'UTC' }, encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stderr, `show: can't read the index file ${path.join(root, 'elsewhere', 'index.txt')} (ENOENT)\n`)

  // The run's copy runs by itself, as the VM runs it, by its first line.
  const direct = spawnSync(program, ['2'], { env: { TZ: 'UTC', PATH: process.env.PATH }, encoding: 'utf8' })
  assert.equal(direct.status, 1, direct.stderr)
  assert.equal(direct.stdout, `2  can't be read at ${log}:2\n`)
})

test('index file: one line for each seq, in order, each naming its own line of the log, its kind and what it points at, for a datastore of several days', t => {
  // Thirty lines on 7 November, then `everyKind` from its fourth line on, numbered after them.
  const after = number => (number === undefined ? undefined : number + 27)
  const lines = [
    ...fillerLines(30, { day: '2026/11/07' }),
    ...everyKind()
      .slice(3)
      .map(fixture => ({ ...fixture, seq: after(fixture.seq), target: after(fixture.target), replyTo: after(fixture.replyTo) })),
  ].map(fixture => JSON.parse(JSON.stringify(fixture)))
  const { paths, index } = setup(t, lines)
  const text = fs.readFileSync(paths.agentRunIndex('lifelog'), 'utf8')
  assert.equal(text, indexFileText(index, paths))
  const rows = text.split('\n')
  assert.equal(rows.pop(), '')
  assert.equal(rows.length, 39)
  const logs = new Map()
  rows.forEach((row, n) => {
    const [, seq, log, number, kind, points] = /^(\d+) (.+):(\d+) ([a-z-]+)(?: (\d+))?$/.exec(row)
    assert.equal(Number(seq), n + 1)
    if (!logs.has(log)) logs.set(log, fs.readFileSync(log, 'utf8').split('\n'))
    const stored = JSON.parse(logs.get(log)[Number(number) - 1])
    assert.equal(stored.seq, n + 1, row)
    assert.equal(stored.kind, kind, row)
    assert.equal(points === undefined ? undefined : Number(points), stored.target ?? stored.replyTo, row)
  })
  assert.deepEqual([...logs.keys()], ['2026/11/07', '2026/11/08', '2026/11/09'].map(day => paths.dayLog(day)))
})

test('offsets file: the owner\'s zone\'s offsets through the days of the index\'s lines, as the runner\'s own time code gives them, with a row for each change and each gap', t => {
  // London's clocks go back on 25 October 2026; no line on the days between the 26th and the 9th.
  const lines = [line.text(1, '2026-10-24T22:00:00Z', 'a'), line.text(2, '2026-10-25T00:59:59Z', 'b'), line.text(3, '2026-10-25T01:00:00Z', 'c'), line.text(4, '2026-10-26T12:00:00Z', 'd'), line.text(5, '2026-11-09T15:50:00Z', 'e')]
  const { paths, index, show } = setup(t, lines, { zone: 'Europe/London' })
  const text = fs.readFileSync(paths.agentRunOffsets('lifelog'), 'utf8')
  assert.equal(text, offsetsFileText(index, 'Europe/London'))
  assert.equal(text, ['2026-10-24T00:00:00Z +01:00', '2026-10-25T01:00:00Z +00:00', '2026-10-27T00:00:00Z -', '2026-11-09T00:00:00Z +00:00', '2026-11-10T00:00:00Z -', ''].join('\n'))
  assert.deepEqual(
    show(['1', '2', '3', '4', '5'])
      .stdout.split('\n')
      .filter(row => /^\d {2}/.test(row))
      .map(row => row.split('  ')[1]),
    ['Sat 24 Oct 2026 23:00 +01:00', 'Sun 25 Oct 2026 01:59 +01:00', 'Sun 25 Oct 2026 01:00 +00:00', 'Mon 26 Oct 2026 12:00 +00:00', 'Mon 9 Nov 2026 15:50 +00:00'],
  )
  // A line of a kind this version doesn't know has its day covered too, as every line of the index.
  const unknown = setup(t, [...fillerLines(1), { seq: 2, kind: 'note-v9', dir: 'in', at: '2026-11-12T10:00:00Z', source: 'whatsapp', trust: 'owner' }], { check: false })
  assert.equal(fs.readFileSync(unknown.paths.agentRunOffsets('lifelog'), 'utf8'), '2026-11-08T00:00:00Z +05:30\n2026-11-09T00:00:00Z -\n2026-11-12T00:00:00Z +05:30\n2026-11-13T00:00:00Z -\n')
  assert.match(unknown.show(['2']).stdout, /^2 {2}Thu 12 Nov 2026 15:30 \+05:30 {2}/)
  // An empty datastore has an empty file.
  const empty = setup(t, [])
  assert.equal(fs.readFileSync(empty.paths.agentRunOffsets('lifelog'), 'utf8'), '')
})
