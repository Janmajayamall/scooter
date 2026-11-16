// Time (section 10 of DESIGN.md, "Time", for storage and conversion): stored times are UTC, the
// owner's time zone is applied explicitly, and schedules come due at the right local time across
// daylight-saving changes.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  fromLocal,
  isTimeZone,
  isoSeconds,
  localDate,
  nextLocalTime,
  parseIsoSeconds,
  parseLocalTime,
  systemClock,
  toLocal,
  utcDate,
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

test('time: which names are time zones', () => {
  for (const zone of ['Asia/Kolkata', 'America/New_York', 'UTC', 'Europe/London']) assert.equal(isTimeZone(zone), true, zone)
  for (const zone of ['Mars/Olympus', 'IST ', '', null, undefined, 330]) assert.equal(isTimeZone(zone), false, String(zone))
})

test('time: nothing depends on the time zone of the process', () => {
  // The services run with TZ=UTC, but the code must not rely on it (8.2). The same questions,
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
