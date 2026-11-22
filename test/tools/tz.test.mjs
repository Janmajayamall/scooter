// What the tz database holds, which the offsets a run's `show` is given rely on (`offsetsOverDays`
// in `src/common/time.mjs`): that no zone changes its offset from UTC twice within `OFFSET_STEP`.
//
// The runner's Node compiles its zone data from the tz database, as the system's zone files are,
// and the two are of one release here, tz 2026e. Node has no call that lists a zone's changes, so
// this reads the system's files, `/usr/share/zoneinfo`, in their own format, TZif (RFC 8536): each
// file's changes, and the rule its footer gives for the years after them, over a whole 400-year
// cycle of the calendar. It skips itself where there are no zone files.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { OFFSET_STEP } from '../../src/common/time.mjs'

const ZONEINFO = '/usr/share/zoneinfo'
const HOUR = 3600
const DAY = 24 * HOUR

// The zone files under `root`, by their names, but those of `posix/` and `right/`, which are the
// same zones again, and links, which name a file listed already.
function zoneFiles(root, folder = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const name = path.join(folder, entry.name)
    if (entry.isDirectory() && folder === '' && (entry.name === 'posix' || entry.name === 'right')) continue
    if (entry.isDirectory()) files.push(...zoneFiles(root, name))
    else if (entry.isFile()) files.push(name)
  }
  return files
}

// A TZif file's version 2 data: its changes of offset, `[{ at, offset }]` in seconds, in order,
// from its first offset; and its footer, the POSIX TZ string for the times after its last change.
// Null for a file that isn't TZif of version 2 or later.
function readTzif(bytes) {
  if (bytes.subarray(0, 4).toString('latin1') !== 'TZif' || bytes[4] < 0x32) return null
  const counts = at => [0, 1, 2, 3, 4, 5].map(n => bytes.readUInt32BE(at + 20 + 4 * n))
  const [isut1, isstd1, leap1, time1, type1, char1] = counts(0)
  const second = 44 + time1 * 5 + type1 * 6 + char1 + leap1 * 8 + isstd1 + isut1
  const [isut, isstd, leap, time, type, char] = counts(second)
  let at = second + 44
  const times = Array.from({ length: time }, (_, n) => Number(bytes.readBigInt64BE(at + 8 * n)))
  at += 8 * time
  const kinds = [...bytes.subarray(at, at + time)]
  at += time
  const offsets = Array.from({ length: type }, (_, n) => bytes.readInt32BE(at + 6 * n))
  at += 6 * type + char + leap * 12 + isstd + isut
  const footer = bytes.subarray(at).toString('latin1').trim()
  // Before its first change a zone is at its first type's offset.
  const changes = []
  let last = offsets[0]
  times.forEach((when, n) => {
    if (offsets[kinds[n]] !== last) changes.push({ at: when, offset: offsets[kinds[n]] })
    last = offsets[kinds[n]]
  })
  return { first: offsets[0], changes, footer }
}

// A POSIX offset or time, `[+-]hh[:mm[:ss]]`, in seconds.
function seconds(text) {
  const [, sign, hours, minutes = '0', secs = '0'] = /^([+-]?)(\d+)(?::(\d+))?(?::(\d+))?$/.exec(text)
  return (sign === '-' ? -1 : 1) * (Number(hours) * HOUR + Number(minutes) * 60 + Number(secs))
}

// The day of a POSIX rule's date in `year`, as days since the epoch: `Mm.w.d`, the d'th weekday
// (0 is Sunday) of the w'th week of month m, 5 being its last; `Jn`, day n of 365, 29 February
// never counted; `n`, day n from 0, counting it.
function ruleDay(rule, year) {
  const epochDay = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / (DAY * 1000))
  let match = /^M(\d+)\.(\d)\.(\d)$/.exec(rule)
  if (match) {
    const [month, week, weekday] = match.slice(1).map(Number)
    const first = epochDay(year, month, 1)
    let day = first + ((weekday - new Date(first * DAY * 1000).getUTCDay() + 7) % 7) + 7 * (week - 1)
    while (day >= epochDay(year, month + 1, 1)) day -= 7
    return day
  }
  match = /^J(\d+)$/.exec(rule)
  if (match) {
    const n = Number(match[1])
    const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1
    return epochDay(year, 1, 1) + n - 1 + (leap && n >= 60 ? 1 : 0)
  }
  return epochDay(year, 1, 1) + Number(rule)
}

// The changes a footer's rule makes in the years `from` to `to`, `[{ at, offset }]` in seconds, in
// order; none for a zone without daylight time.
function footerChanges(footer, from, to) {
  const name = '(?:<[^>]+>|[A-Za-z]+)'
  const offset = '([+-]?\\d+(?::\\d+){0,2})'
  const match = new RegExp(`^${name}${offset}(?:${name}${offset}?,([^,/]+)(?:/([^,]+))?,([^,/]+)(?:/([^,]+))?)?$`).exec(footer)
  assert.ok(match, `a footer this test reads: ${footer}`)
  const [, stdText, dstText, startRule, startTime = '2', endRule, endTime = '2'] = match
  if (startRule === undefined) return []
  // POSIX writes how far UTC is ahead of the zone.
  const standard = 0 - seconds(stdText)
  const daylight = dstText === undefined ? standard + HOUR : 0 - seconds(dstText)
  const changes = []
  for (let year = from; year <= to; year++) {
    // Each at its local time: the start in standard time, the end in daylight time.
    changes.push({ at: ruleDay(startRule, year) * DAY + seconds(startTime) - standard, offset: daylight })
    changes.push({ at: ruleDay(endRule, year) * DAY + seconds(endTime) - daylight, offset: standard })
  }
  return changes.sort((a, b) => a.at - b.at)
}

const skip = fs.existsSync(path.join(ZONEINFO, 'Europe', 'London')) ? false : `no zone files in ${ZONEINFO}`

test('tz database: no zone changes its offset from UTC twice within a few days, so not within OFFSET_STEP either', { skip }, t => {
  const version = /^# version (\S+)/.exec(fs.existsSync(path.join(ZONEINFO, 'tzdata.zi')) ? fs.readFileSync(path.join(ZONEINFO, 'tzdata.zi'), 'utf8') : '')?.[1]
  t.diagnostic(`the system's zone files: tz ${version ?? 'of an unknown release'}; the runner's Node: tz ${process.versions.tz}`)
  let shortest = { gap: Infinity }
  let zones = 0
  for (const name of zoneFiles(ZONEINFO)) {
    const tzif = readTzif(fs.readFileSync(path.join(ZONEINFO, name)))
    if (tzif === null) continue
    zones += 1
    // What the footer's rule makes after the last change listed, over a whole cycle of the
    // calendar, kept only where it changes the offset.
    const lastYear = tzif.changes.length === 0 ? 1970 : new Date(tzif.changes.at(-1).at * 1000).getUTCFullYear()
    const changes = [...tzif.changes]
    let offset = changes.at(-1)?.offset ?? tzif.first
    for (const change of footerChanges(tzif.footer, lastYear + 1, lastYear + 400)) {
      if (change.offset !== offset) changes.push(change)
      offset = change.offset
    }
    for (let n = 1; n < changes.length; n++) {
      const gap = changes[n].at - changes[n - 1].at
      if (gap < shortest.gap) shortest = { gap, name, at: new Date(changes[n - 1].at * 1000).toISOString() }
    }
  }
  t.diagnostic(`${zones} zones; the shortest time between two changes: ${(shortest.gap / HOUR).toFixed(2)} hours, ${shortest.name}, from ${shortest.at}`)
  assert.ok(zones > 300, `${zones} zones`)
  // Found on 2026-11-22, in tz 2026e: 95 hours 40 minutes, Africa/Freetown's from 1 September 1939.
  assert.ok(shortest.gap > 3 * DAY, `${shortest.name}: ${shortest.gap / HOUR} hours from ${shortest.at}`)
  assert.ok(OFFSET_STEP / 1000 < shortest.gap)
})

test('tz database: this test reads a zone\'s changes, and its footer\'s rule, as they are', { skip }, () => {
  // London: GMT and BST, from the last Sunday of March at 01:00 UTC to the last Sunday of October
  // at 01:00 UTC.
  const london = readTzif(fs.readFileSync(path.join(ZONEINFO, 'Europe', 'London')))
  assert.equal(london.footer, 'GMT0BST,M3.5.0/1,M10.5.0')
  assert.deepEqual(footerChanges(london.footer, 2026, 2026), [
    { at: Date.UTC(2026, 2, 29, 1) / 1000, offset: HOUR },
    { at: Date.UTC(2026, 9, 25, 1) / 1000, offset: 0 },
  ])
  // The changes listed for 2026 are the same.
  const in2026 = london.changes.filter(change => change.at >= Date.UTC(2026, 0, 1) / 1000 && change.at < Date.UTC(2027, 0, 1) / 1000)
  assert.deepEqual(in2026, footerChanges(london.footer, 2026, 2026))
  // Lord Howe's half hour, south of the equator, and a rule whose time is past 24 hours.
  assert.deepEqual(footerChanges('<+1030>-10:30<+11>-11,M10.1.0,M4.1.0', 2026, 2026), [
    { at: Date.UTC(2026, 3, 4, 15) / 1000, offset: 10.5 * HOUR },
    { at: Date.UTC(2026, 9, 3, 15, 30) / 1000, offset: 11 * HOUR },
  ])
  assert.deepEqual(footerChanges('EET-2EEST,M3.4.4/50,M10.4.4/50', 2026, 2026), [
    { at: Date.UTC(2026, 2, 28, 0) / 1000, offset: 3 * HOUR },
    { at: Date.UTC(2026, 9, 23, 23) / 1000, offset: 2 * HOUR },
  ])
  assert.deepEqual(footerChanges('<+0530>-5:30', 2026, 2026), [])
  // Kolkata: its local mean time first, then each change of its offset.
  const kolkata = readTzif(fs.readFileSync(path.join(ZONEINFO, 'Asia', 'Kolkata')))
  assert.equal(kolkata.first, 5 * HOUR + 53 * 60 + 28)
  assert.deepEqual(kolkata.changes[0], { at: Date.UTC(1854, 5, 27, 18, 6, 32) / 1000, offset: 5 * HOUR + 53 * 60 + 20 })
  assert.equal(kolkata.changes.at(-1).offset, 5.5 * HOUR)
})
