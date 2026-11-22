// Time: stored times are UTC, the
// owner's time zone is applied explicitly, and schedules come due at the right local time across
// daylight-saving changes.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  OFFSET_STEP,
  fromLocal,
  isDate,
  isTimeZone,
  isoSeconds,
  localDate,
  nextLocalTime,
  offsetsOverDays,
  parseIsoSeconds,
  parseLocalTime,
  previousLocalTime,
  shiftDate,
  systemClock,
  toLocal,
  utcDate,
  utcOffsetText,
  utcStamp,
} from '../src/common/time.mjs'
import { createFakeClock } from './support/clock.mjs'

const at = text => Date.parse(text)
const HOUR = 3600 * 1000

test('time: a stored time is UTC, to the second', () => {
  const instant = Date.UTC(2026, 10, 9, 15, 43, 2, 987)
  assert.equal(isoSeconds(instant), '2026-11-09T15:43:02Z')
  assert.equal(parseIsoSeconds('2026-11-09T15:43:02Z'), Date.UTC(2026, 10, 9, 15, 43, 2))
  assert.equal(utcDate(instant), '2026-11-09')
  assert.equal(utcStamp(instant), '20261109T154302987')
  assert.throws(() => isoSeconds(NaN), RangeError)
})

test('time: only a UTC time to the second is read back', () => {
  for (const text of [
    '2026-11-09T15:43:02',
    '2026-11-09T15:43:02+05:30',
    '2026-11-09T15:43:02.000Z',
    '2026-11-09 15:43:02Z',
    '2026-02-31T00:00:00Z',
    '2026-11-09T24:00:00Z',
    '',
    null,
    1762703000,
  ]) {
    assert.equal(parseIsoSeconds(text), null, String(text))
  }
})

test('time: an instant in the owner\'s time zone', () => {
  // 15:43 UTC is 21:13 in India, which is five and a half hours ahead all year.
  const local = toLocal(at('2026-11-09T15:43:02Z'), 'Asia/Kolkata')
  assert.deepEqual(local, {
    year: 2026,
    month: 11,
    day: 9,
    hour: 21,
    minute: 13,
    second: 2,
    weekday: 1,
    date: '2026-11-09',
    offsetMinutes: 330,
  })
  // The local date can be the day after the UTC date, or the day before.
  assert.equal(localDate(at('2026-11-09T20:00:00Z'), 'Asia/Kolkata'), '2026-11-10')
  assert.equal(localDate(at('2026-11-09T03:00:00Z'), 'America/Los_Angeles'), '2026-11-08')
  assert.equal(toLocal(at('2026-11-08T12:00:00Z'), 'UTC').weekday, 7)
  // Zones with unusual offsets.
  assert.equal(toLocal(at('2026-01-01T00:00:00Z'), 'Asia/Kathmandu').offsetMinutes, 345)
  assert.equal(toLocal(at('2026-01-01T00:00:00Z'), 'Pacific/Kiritimati').offsetMinutes, 840)
  assert.equal(toLocal(at('2026-01-01T00:00:00Z'), 'America/New_York').offsetMinutes, -300)
  assert.equal(toLocal(at('2026-07-01T00:00:00Z'), 'America/New_York').offsetMinutes, -240)
})

// The offset a table of `offsetsOverDays` gives an instant: that of the last row from at or before
// it, or null.
function offsetIn(rows, ms) {
  let found
  for (const row of rows) if (row.from <= ms) found = row
  return found === undefined ? null : found.offset
}

// The runner's own conversion's offset at an instant, in milliseconds.
const offsetOf = (ms, zone) => Math.round(toLocal(ms, zone).offsetMinutes * 60) * 1000

test('time: the zone\'s offsets through some days are the runner\'s own conversion, to the second, with a row for each change and for each gap', () => {
  const rows = (days, zone) => offsetsOverDays(days, zone).map(({ from, offset }) => `${isoSeconds(from)} ${offset === null ? '-' : utcOffsetText(offset)}`)
  // London's clocks go back at 01:00 UTC on 25 October 2026; the days are given in any order, and
  // twice; a day without one of them is a gap.
  assert.deepEqual(rows(['2026-11-09', '2026-10-25', '2026-10-24', '2026-10-26', '2026-10-25'], 'Europe/London'), [
    '2026-10-24T00:00:00Z +01:00',
    '2026-10-25T01:00:00Z +00:00',
    '2026-10-27T00:00:00Z -',
    '2026-11-09T00:00:00Z +00:00',
    '2026-11-10T00:00:00Z -',
  ])
  // Lord Howe's half hour, a change at a time that isn't a whole hour, and a zone that skipped a
  // day: Samoa's 30 December 2011.
  assert.deepEqual(rows(['2026-04-04'], 'Australia/Lord_Howe'), ['2026-04-04T00:00:00Z +11:00', '2026-04-04T15:00:00Z +10:30', '2026-04-05T00:00:00Z -'])
  assert.deepEqual(rows(['2011-12-29', '2011-12-30', '2011-12-31'], 'Pacific/Apia'), ['2011-12-29T00:00:00Z -10:00', '2011-12-30T10:00:00Z +14:00', '2012-01-01T00:00:00Z -'])
  // An offset that isn't a whole number of minutes, and a change between two such, to the second.
  assert.deepEqual(rows(['1854-06-27'], 'Asia/Kolkata'), ['1854-06-27T00:00:00Z +05:53:28', '1854-06-27T18:06:32Z +05:53:20', '1854-06-28T00:00:00Z -'])
  assert.deepEqual(rows(['1972-01-07'], 'Africa/Monrovia'), ['1972-01-07T00:00:00Z -00:44:30', '1972-01-07T00:44:30Z +00:00', '1972-01-08T00:00:00Z -'])
  // The first and last days a line can have, and none.
  assert.deepEqual(rows(['9999-12-31', '0100-01-01'], 'UTC'), ['0100-01-01T00:00:00Z +00:00', '0100-01-02T00:00:00Z -', '9999-12-31T00:00:00Z +00:00', '10000-01-01T00:00:00Z -'])
  assert.deepEqual(offsetsOverDays([], 'Asia/Kolkata'), [])
  for (const day of ['2026-02-30', '2026-11-9', '', '2026-11-09T00:00:00Z']) assert.throws(() => offsetsOverDays([day], 'UTC'), RangeError, day)

  // Every 15 minutes through days of changes, in zones whose changes are at odd times, are many,
  // or go both ways: each instant has the offset the runner's own conversion gives it.
  const cases = [
    ['America/Vancouver', ['2026-03-08', '2026-11-01', '2025-11-02']],
    ['America/Coyhaique', ['2025-04-05', '2025-04-06', '2026-11-01']],
    ['Africa/Casablanca', ['2026-02-15', '2026-03-22', '2026-10-01']],
    ['America/Asuncion', ['2024-10-06', '2025-03-23', '2026-04-01']],
    ['Australia/Lord_Howe', ['2026-04-04', '2026-10-03']],
    ['Africa/Freetown', ['1939-05-31', '1939-06-01', '1939-09-01']],
    ['Asia/Kolkata', ['1854-06-27', '1941-09-30', '1942-05-15']],
  ]
  for (const [zone, days] of cases) {
    const table = offsetsOverDays(days, zone)
    for (const day of days) {
      for (let ms = at(`${day}T00:00:00Z`); ms < at(`${day}T00:00:00Z`) + 24 * HOUR; ms += 15 * 60 * 1000) {
        assert.equal(offsetIn(table, ms), offsetOf(ms, zone), `${zone} ${isoSeconds(ms)}`)
      }
    }
    // Each change at the second the runner's own conversion makes it.
    for (const { from, offset } of table) {
      if (offset === null || days.includes(isoSeconds(from).slice(0, 10)) === false) continue
      assert.equal(offsetOf(from, zone), offset, `${zone} ${isoSeconds(from)}`)
      if (isoSeconds(from).slice(11) !== '00:00:00Z') assert.notEqual(offsetOf(from - 1000, zone), offset, `${zone} ${isoSeconds(from)}`)
    }
  }
})

test('time: the zone\'s offsets are the runner\'s own conversion in every zone Node knows, on the days and at the times the review of show tried', () => {
  // 00:30 and 12:30 UTC on the 1st and the 15th of each month of 2026 and 2027, in every zone the
  // runner's Node knows, and the backward names the review found the image's Node wrong in.
  const instants = []
  for (const year of [2026, 2027]) {
    for (let month = 0; month < 12; month++) for (const day of [1, 15]) for (const hour of [0, 12]) instants.push(Date.UTC(year, month, day, hour, 30))
  }
  const days = instants.map(ms => utcDate(ms))
  const zones = [...Intl.supportedValuesOf('timeZone'), 'America/Coyhaique', 'Canada/Central', 'Canada/Mountain', 'Canada/Pacific', 'America/Rainy_River', 'America/Yellowknife', 'UTC']
  for (const zone of zones) {
    const table = offsetsOverDays(days, zone)
    for (const ms of instants) assert.equal(offsetIn(table, ms), offsetOf(ms, zone), `${zone} ${isoSeconds(ms)}`)
    assert.equal(table.at(-1).offset, null)
  }
  // The step is a quarter of a day, so that a day is looked up four times.
  assert.equal(OFFSET_STEP, 6 * HOUR)
})

test('time: an offset as show\'s header ends with it', () => {
  assert.equal(utcOffsetText(5.5 * HOUR), '+05:30')
  assert.equal(utcOffsetText(-7 * HOUR), '-07:00')
  assert.equal(utcOffsetText(0), '+00:00')
  assert.equal(utcOffsetText(-0), '+00:00')
  assert.equal(utcOffsetText(14 * HOUR), '+14:00')
  assert.equal(utcOffsetText(-(9 * HOUR + 30 * 60 * 1000)), '-09:30')
  assert.equal(utcOffsetText((5 * 3600 + 53 * 60 + 28) * 1000), '+05:53:28')
  assert.equal(utcOffsetText(-(44 * 60 + 30) * 1000), '-00:44:30')
})

test('time: a local time back to its instant', () => {
  assert.equal(fromLocal({ year: 2026, month: 11, day: 9, hour: 21, minute: 13, second: 2 }, 'Asia/Kolkata'), at('2026-11-09T15:43:02Z'))
  assert.equal(fromLocal({ year: 2026, month: 11, day: 9 }, 'Asia/Kolkata'), at('2026-11-08T18:30:00Z'))
  assert.equal(fromLocal({ year: 2026, month: 7, day: 1, hour: 12 }, 'America/New_York'), at('2026-07-01T16:00:00Z'))
  assert.equal(fromLocal({ year: 2026, month: 1, day: 1, hour: 12 }, 'America/New_York'), at('2026-01-01T17:00:00Z'))
  // Every hour of a year goes there and back, in zones with and without daylight saving.
  for (const zone of ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Auckland', 'UTC']) {
    for (let instant = at('2026-01-01T00:00:00Z'); instant < at('2027-01-01T00:00:00Z'); instant += 7 * HOUR) {
      const local = toLocal(instant, zone)
      const back = fromLocal(local, zone)
      // A local time that comes twice goes back to its first occurrence, the same time on the clock.
      assert.deepEqual({ ...toLocal(back, zone), offsetMinutes: 0 }, { ...local, offsetMinutes: 0 }, `${zone} ${isoSeconds(instant)}`)
      assert.ok(back <= instant)
    }
  }
})

test('time: a local time that is skipped means the instant the clocks jump', () => {
  // New York, 8 March 2026: 02:00 becomes 03:00.
  const jump = at('2026-03-08T07:00:00Z')
  assert.equal(fromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'), jump)
  assert.equal(fromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 0 }, 'America/New_York'), jump)
  assert.equal(fromLocal({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, 'America/New_York'), jump - 60 * 1000)
  assert.equal(fromLocal({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, 'America/New_York'), jump)
  // Lord Howe Island moves its clocks by half an hour: on 4 October 2026, 02:00 becomes 02:30.
  assert.equal(fromLocal({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, 'Australia/Lord_Howe'), at('2026-10-03T15:30:00Z'))
})

test('time: a local time that comes twice means the first', () => {
  // New York, 1 November 2026: 02:00 becomes 01:00, so 01:30 comes at 05:30 and at 06:30 UTC.
  assert.equal(fromLocal({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'), at('2026-11-01T05:30:00Z'))
  // London, 25 October 2026: 02:00 becomes 01:00.
  assert.equal(fromLocal({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, 'Europe/London'), at('2026-10-25T00:30:00Z'))
})

test('time: reading HH:MM and a weekly time', () => {
  assert.deepEqual(parseLocalTime('21:30'), { weekday: null, hour: 21, minute: 30 })
  assert.deepEqual(parseLocalTime('00:00'), { weekday: null, hour: 0, minute: 0 })
  assert.deepEqual(parseLocalTime('Sun 18:00'), { weekday: 7, hour: 18, minute: 0 })
  assert.deepEqual(parseLocalTime('Mon 03:05'), { weekday: 1, hour: 3, minute: 5 })
  for (const text of ['24:00', '9:30', '21:60', '21.30', 'sun 18:00', 'Sunday 18:00', 'Sun  18:00', ' 21:30', '21:30 ', 'off', '', null, 2130]) {
    assert.equal(parseLocalTime(text), null, String(text))
  }
})

test('time: a daily time comes due at the next such local time', () => {
  const daily = parseLocalTime('21:30')
  // 21:30 in India is 16:00 UTC.
  assert.equal(nextLocalTime(daily, 'Asia/Kolkata', at('2026-11-09T15:43:02Z')), at('2026-11-09T16:00:00Z'))
  // At the time itself, and after it, the next one is tomorrow's.
  assert.equal(nextLocalTime(daily, 'Asia/Kolkata', at('2026-11-09T16:00:00Z')), at('2026-11-10T16:00:00Z'))
  assert.equal(nextLocalTime(daily, 'Asia/Kolkata', at('2026-11-09T16:00:01Z')), at('2026-11-10T16:00:00Z'))
  // A zone far ahead of UTC: 00:15 on the 10th in Kiritimati is 10:15 UTC on the 9th.
  assert.equal(nextLocalTime(parseLocalTime('00:15'), 'Pacific/Kiritimati', at('2026-11-09T09:00:00Z')), at('2026-11-09T10:15:00Z'))
  // And one far behind: 23:45 on the 8th in Niue is 10:45 UTC on the 9th.
  assert.equal(nextLocalTime(parseLocalTime('23:45'), 'Pacific/Niue', at('2026-11-09T09:00:00Z')), at('2026-11-09T10:45:00Z'))
})

test('time: a weekly time comes due on its weekday', () => {
  const weekly = parseLocalTime('Sun 18:00')
  // 9 November 2026 is a Monday. Sunday 18:00 in India is 12:30 UTC.
  assert.equal(nextLocalTime(weekly, 'Asia/Kolkata', at('2026-11-09T15:43:02Z')), at('2026-11-15T12:30:00Z'))
  assert.equal(nextLocalTime(weekly, 'Asia/Kolkata', at('2026-11-15T12:29:59Z')), at('2026-11-15T12:30:00Z'))
  assert.equal(nextLocalTime(weekly, 'Asia/Kolkata', at('2026-11-15T12:30:00Z')), at('2026-11-22T12:30:00Z'))
})

// Every instant a schedule comes due from `from` up to `until`.
function dueTimes(text, zone, from, until) {
  const times = []
  let instant = at(from)
  for (;;) {
    instant = nextLocalTime(parseLocalTime(text), zone, instant)
    if (instant >= at(until)) return times
    times.push(isoSeconds(instant))
  }
}

test('time: a daily time keeps to the local clock when the clocks go forward', () => {
  // New York leaves winter time on 8 March 2026: 09:00 moves from 14:00 UTC to 13:00 UTC.
  assert.deepEqual(dueTimes('09:00', 'America/New_York', '2026-03-06T00:00:00Z', '2026-03-10T00:00:00Z'), [
    '2026-03-06T14:00:00Z',
    '2026-03-07T14:00:00Z',
    '2026-03-08T13:00:00Z',
    '2026-03-09T13:00:00Z',
  ])
  // A time in the skipped hour comes due at the jump, once, and is back to normal the day after.
  assert.deepEqual(dueTimes('02:30', 'America/New_York', '2026-03-06T08:00:00Z', '2026-03-10T00:00:00Z'), [
    '2026-03-07T07:30:00Z',
    '2026-03-08T07:00:00Z',
    '2026-03-09T06:30:00Z',
  ])
})

test('time: a daily time comes due once on the day the clocks go back', () => {
  // New York returns to winter time on 1 November 2026, and 01:30 comes twice that night.
  assert.deepEqual(dueTimes('01:30', 'America/New_York', '2026-10-30T12:00:00Z', '2026-11-03T12:00:00Z'), [
    '2026-10-31T05:30:00Z',
    '2026-11-01T05:30:00Z',
    '2026-11-02T06:30:00Z',
    '2026-11-03T06:30:00Z',
  ])
  // Asked in the hour between the two, the next one is tomorrow's, not the second 01:30.
  assert.equal(
    nextLocalTime(parseLocalTime('01:30'), 'America/New_York', at('2026-11-01T06:00:00Z')),
    at('2026-11-02T06:30:00Z'),
  )
  // The backup's default time, in a zone whose clocks go back at 03:00 (Europe/Berlin, 25 October).
  assert.deepEqual(dueTimes('03:30', 'Europe/Berlin', '2026-10-24T00:00:00Z', '2026-10-27T00:00:00Z'), [
    '2026-10-24T01:30:00Z',
    '2026-10-25T02:30:00Z',
    '2026-10-26T02:30:00Z',
  ])
})

test('time: a weekly time across a daylight-saving change', () => {
  // Sundays at 02:30 in New York, over the Sunday that has no 02:30.
  assert.deepEqual(dueTimes('Sun 02:30', 'America/New_York', '2026-02-28T00:00:00Z', '2026-03-16T00:00:00Z'), [
    '2026-03-01T07:30:00Z',
    '2026-03-08T07:00:00Z',
    '2026-03-15T06:30:00Z',
  ])
})

test('time: a zone that skips a date has nothing due on it', () => {
  // Samoa moved across the date line at the end of 2011: 29 December was followed by the 31st.
  const due = dueTimes('10:00', 'Pacific/Apia', '2011-12-29T00:00:00Z', '2012-01-02T00:00:00Z')
  assert.deepEqual(due, ['2011-12-29T20:00:00Z', '2011-12-30T20:00:00Z', '2011-12-31T20:00:00Z', '2012-01-01T20:00:00Z'])
  assert.deepEqual(
    due.map(time => localDate(at(time), 'Pacific/Apia')),
    ['2011-12-29', '2011-12-31', '2012-01-01', '2012-01-02'],
  )
  // A weekly time on the weekday that was skipped, a Friday, waits for the next Friday.
  assert.equal(
    nextLocalTime(parseLocalTime('Fri 10:00'), 'Pacific/Apia', at('2011-12-29T00:00:00Z')),
    at('2012-01-05T20:00:00Z'),
  )
})

test('time: the last time a schedule came due is the one before its next', () => {
  const zones = ['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Apia', 'America/St_Johns']
  const schedules = ['00:00', '01:30', '02:30', '21:30', 'Sun 01:30', 'Fri 10:00'].map(parseLocalTime)
  // Every few hours across 2011 to 2012 and 2026, which hold daylight-saving changes in each zone
  // and Samoa's skipped date.
  const starts = [at('2011-12-20T00:00:00Z'), at('2026-03-01T00:00:00Z'), at('2026-10-20T00:00:00Z')]
  for (const timeZone of zones) {
    for (const schedule of schedules) {
      for (const start of starts) {
        for (let now = start; now < start + 20 * 24 * HOUR; now += 7 * HOUR + 13 * 60 * 1000) {
          const previous = previousLocalTime(schedule, timeZone, now)
          assert.ok(previous <= now)
          // Nothing comes due between the previous time and now, and the next after it is after now.
          assert.ok(nextLocalTime(schedule, timeZone, previous) > now, `${timeZone} ${JSON.stringify(schedule)} ${isoSeconds(now)}`)
        }
      }
    }
  }
  // At the instant itself, that instant.
  assert.equal(previousLocalTime(parseLocalTime('21:30'), 'Asia/Kolkata', at('2026-11-09T16:00:00Z')), at('2026-11-09T16:00:00Z'))
  assert.equal(previousLocalTime(parseLocalTime('21:30'), 'Asia/Kolkata', at('2026-11-09T15:59:59Z')), at('2026-11-08T16:00:00Z'))
})

test('time: dates, and days added to them', () => {
  assert.equal(isDate('2026-11-09'), true)
  assert.equal(isDate('2028-02-29'), true)
  for (const text of ['2026-02-29', '2026-13-01', '2026-11-9', '2026/11/09', 20261109, null]) assert.equal(isDate(text), false, String(text))
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31')
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01')
  assert.equal(shiftDate('2028-03-01', -1), '2028-02-29')
  assert.equal(shiftDate('2026-11-09', 0), '2026-11-09')
  assert.throws(() => shiftDate('2026-02-30', 1), /not a date/)
})

test('time: which names are time zones', () => {
  for (const zone of ['Asia/Kolkata', 'America/New_York', 'UTC', 'Europe/London']) assert.equal(isTimeZone(zone), true, zone)
  for (const zone of ['Mars/Olympus', 'IST ', '', null, undefined, 330]) assert.equal(isTimeZone(zone), false, String(zone))
  // Node reads these, but they aren't names in the tz database, where pi's TZ is looked up.
  for (const zone of ['asia/kolkata', 'Asia/kolkata', 'utc', '+05:30', '-08:00', 'Asia/Kolkata/']) {
    assert.equal(isTimeZone(zone), false, zone)
  }
  // Every zone Node lists is written the tz database's way, and so is every zone file of this machine.
  for (const zone of Intl.supportedValuesOf('timeZone')) assert.equal(isTimeZone(zone), true, zone)
  for (const zone of ['America/Port-au-Prince', 'Etc/GMT+5', 'Etc/GMT-14', 'America/North_Dakota/New_Salem', 'EST5EDT']) {
    assert.equal(isTimeZone(zone), true, zone)
  }
})

test('time: nothing depends on the time zone of the process', () => {
  // The services run with TZ=UTC, but the code must not rely on it. The same questions,
  // asked by a process in another zone, get the same answers.
  const script = `
    import { fromLocal, isoSeconds, nextLocalTime, parseLocalTime, toLocal, utcDate, utcStamp } from ${JSON.stringify(
      fileURLToPath(new URL('../src/common/time.mjs', import.meta.url)),
    )}
    const instant = Date.UTC(2026, 10, 9, 20, 43, 2, 5)
    console.log(JSON.stringify([
      isoSeconds(instant),
      utcDate(instant),
      utcStamp(instant),
      toLocal(instant, 'Asia/Kolkata'),
      fromLocal({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'),
      nextLocalTime(parseLocalTime('Sun 18:00'), 'Asia/Kolkata', instant),
    ]))
  `
  const answers = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata'].map(zone =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { TZ: zone }, encoding: 'utf8' }),
  )
  assert.equal(JSON.parse(answers[0])[0], '2026-11-09T20:43:02Z')
  assert.equal(JSON.parse(answers[0])[1], '2026-11-09')
  for (const answer of answers) assert.equal(answer, answers[0])
})

test('time: the real clock sleeps, and an aborted sleep rejects', async () => {
  const before = systemClock.now()
  await systemClock.sleep(20)
  assert.ok(systemClock.now() - before >= 15)

  const controller = new AbortController()
  const sleeping = systemClock.sleep(60_000, { signal: controller.signal })
  controller.abort(new Error('stop'))
  await assert.rejects(sleeping, /stop/)
  await assert.rejects(systemClock.sleep(60_000, { signal: controller.signal }), /stop/)
})

test('time: the fake clock moves only when a test moves it', async () => {
  const clock = createFakeClock('2026-11-09T15:43:02Z')
  assert.equal(isoSeconds(clock.now()), '2026-11-09T15:43:02Z')

  const woken = []
  clock.sleep(3000).then(() => woken.push(['three', clock.now() - at('2026-11-09T15:43:02Z')]))
  clock.sleep(1000).then(async () => {
    woken.push(['one', clock.now() - at('2026-11-09T15:43:02Z')])
    // A sleep begun by a sleeper that just woke is counted from the time it woke.
    await clock.sleep(1000)
    woken.push(['two', clock.now() - at('2026-11-09T15:43:02Z')])
  })
  await clock.whenSleeping(2)
  assert.deepEqual(clock.sleeping(), [1000, 3000])

  await clock.advance(500)
  assert.deepEqual(woken, [])
  await clock.advance(5000)
  assert.deepEqual(woken, [
    ['one', 1000],
    ['two', 2000],
    ['three', 3000],
  ])
  assert.equal(clock.now(), at('2026-11-09T15:43:02Z') + 5500)

  const controller = new AbortController()
  const aborted = clock.sleep(1000, { signal: controller.signal })
  controller.abort(new Error('stop'))
  await assert.rejects(aborted, /stop/)
  assert.deepEqual(clock.sleeping(), [])

  clock.set('2026-11-08T00:00:00Z')
  assert.equal(isoSeconds(clock.now()), '2026-11-08T00:00:00Z')
})
