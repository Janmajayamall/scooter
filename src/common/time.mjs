// Time: UTC for everything Scooter stores or compares, and the owner's time zone at the edges
// (section 2 of DESIGN.md).
//
// Instants are milliseconds since the epoch, as `Date.now()` gives them. Nothing here reads the
// process's own time zone: UTC parts come from the `getUTC…` methods, and a local time is always
// worked out for a named IANA zone.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// ---------------------------------------------------------------------------------------------
// The clock

function abortReason(signal) {
  return signal.reason ?? new Error('aborted')
}

// The clock everything takes as a parameter, so tests can pass a fake one.
// `sleep` resolves after `ms`, or rejects with the signal's reason when it is aborted first.
export const systemClock = {
  now: () => Date.now(),
  sleep(ms, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal))
      const onAbort = () => {
        clearTimeout(timer)
        reject(abortReason(signal))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  },
}

// ---------------------------------------------------------------------------------------------
// UTC

const pad = (number, width = 2) => String(number).padStart(width, '0')

// `2026-11-09T15:43:02Z`: how the datastore, the state and the logs write a time, to the second.
export function isoSeconds(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) throw new RangeError('not a time')
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  )
}

const ISO_SECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/

// The instant a stored time names, or null when the text isn't a time as `isoSeconds` writes it.
export function parseIsoSeconds(text) {
  const match = typeof text === 'string' ? ISO_SECONDS.exec(text) : null
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  // `Date.UTC` rolls 31 February over into March. A stored time never needs that.
  return isoSeconds(ms) === text ? ms : null
}

// `2026-11-09`: the UTC date of an instant.
export function utcDate(ms) {
  return isoSeconds(ms).slice(0, 10)
}

// `20261109T155015123`: the UTC time to the millisecond, for IDs that sort by time.
export function utcStamp(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) throw new RangeError('not a time')
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`
  )
}

// ---------------------------------------------------------------------------------------------
// The owner's time zone

const formatters = new Map()

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

// How the tz database writes its zones' names: parts separated by `/`, each beginning with a
// capital letter, such as `Asia/Kolkata`, `America/Port-au-Prince` or `Etc/GMT+5`.
const ZONE_NAME = /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)*$/

// Whether `timeZone` is the name of an IANA zone, written as the tz database writes it, that this
// Node knows, such as `Asia/Kolkata`.
//
// Node also takes a name in any case, and an offset such as `+05:30`. pi doesn't get the zone from
// Node: its `TZ` (6.6) is looked up as a file in the VM's tz database, where names are case
// sensitive and offsets aren't names. There, `asia/kolkata` would quietly mean UTC.
export function isTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !ZONE_NAME.test(timeZone)) return false
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

// The zone's wall clock at an instant, as if it were UTC: the instant plus the zone's offset.
// Whole seconds; the milliseconds are dropped.
function wallOf(ms, timeZone) {
  const fields = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) fields[part.type] = part.value
  const year = fields.era === 'BC' ? 1 - Number(fields.year) : Number(fields.year)
  const wall = new Date(0)
  wall.setUTCFullYear(year, Number(fields.month) - 1, Number(fields.day))
  wall.setUTCHours(Number(fields.hour), Number(fields.minute), Number(fields.second), 0)
  return wall.getTime()
}

function offsetAt(ms, timeZone) {
  const whole = Math.floor(ms / SECOND) * SECOND
  return wallOf(whole, timeZone) - whole
}

// 1 is Monday and 7 is Sunday, as in ISO 8601.
function isoWeekday(wall) {
  return new Date(wall).getUTCDay() || 7
}

function partsOfWall(wall) {
  const d = new Date(wall)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return {
    year,
    month,
    day,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: isoWeekday(wall),
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
  }
}

// What the zone's clock and calendar show at an instant: `year`, `month` (1 to 12), `day`,
// `hour`, `minute`, `second`, `weekday` (1 is Monday, 7 is Sunday), `date` (`2026-11-09`) and
// `offsetMinutes`, the zone's distance from UTC at that instant.
export function toLocal(ms, timeZone) {
  const whole = Math.floor(ms / SECOND) * SECOND
  const wall = wallOf(whole, timeZone)
  return { ...partsOfWall(wall), offsetMinutes: (wall - whole) / MINUTE }
}

// The local date of an instant: `2026-11-09`.
export function localDate(ms, timeZone) {
  return toLocal(ms, timeZone).date
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A time as the owner reads it in a short line, in their zone: `21:13` on the zone's date of `now`,
// `Sun 8 Nov 20:02` on another date of the same year, and `Sat 8 Nov 2025 20:02` in another year.
// The agent's prompt shows its items this way (6.5), and `/status` its times (5.4).
export function shortLocalTime(ms, now, timeZone) {
  const t = toLocal(ms, timeZone)
  const clock = `${pad(t.hour)}:${pad(t.minute)}`
  if (t.date === localDate(now, timeZone)) return clock
  const year = t.year === toLocal(now, timeZone).year ? '' : ` ${t.year}`
  return `${DAY_NAMES[t.weekday - 1]} ${t.day} ${MONTH_NAMES[t.month - 1]}${year} ${clock}`
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// Whether `text` is a calendar date written as `2026-11-09`, one that exists.
export function isDate(text) {
  const match = typeof text === 'string' ? DATE.exec(text) : null
  if (!match) return false
  const [year, month, day] = match.slice(1).map(Number)
  return partsOfWall(wallFromParts({ year, month, day })).date === text
}

// The date `days` after a date, or before it when `days` is negative: `shiftDate('2026-11-01',
// -1)` is `2026-10-31`. Calendar arithmetic, with no time zone involved.
export function shiftDate(date, days) {
  if (!isDate(date)) throw new RangeError('not a date')
  const [year, month, day] = date.split('-').map(Number)
  return partsOfWall(wallFromParts({ year, month, day: day + days })).date
}

function wallFromParts({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  const wall = new Date(0)
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour, minute, second, 0)
  return wall.getTime()
}

// The instant at which the zone's clock shows the given local time.
//
// Daylight saving makes two local times awkward, and the rule for both is the same: the result is
// the earliest instant at which the zone's clock shows that time or a later one.
// - A time that comes twice, when clocks go back, means its first occurrence.
// - A time that is skipped, when clocks go forward, means the instant of the jump. On a day when
//   02:00 becomes 03:00, 02:30 means 03:00.
export function fromLocal(parts, timeZone) {
  const wall = wallFromParts(parts)
  // The instant is `wall` minus the zone's offset at that instant. Offsets on either side of
  // `wall` cover a change of offset anywhere near it.
  const offsets = [...new Set([offsetAt(wall - 26 * HOUR, timeZone), offsetAt(wall, timeZone), offsetAt(wall + 26 * HOUR, timeZone)])]
  const exact = offsets.map(offset => wall - offset).filter(instant => wallOf(instant, timeZone) === wall)
  if (exact.length > 0) return Math.min(...exact)

  // The time is skipped. Before the jump the clock shows less than `wall`, and from the jump on
  // it shows more, so the jump is the first second at which it shows `wall` or later.
  let low = wall - Math.max(...offsets)
  let high = wall - Math.min(...offsets)
  while (high - low > SECOND) {
    const middle = low + Math.floor((high - low) / (2 * SECOND)) * SECOND
    if (wallOf(middle, timeZone) >= wall) high = middle
    else low = middle
  }
  return high
}

// ---------------------------------------------------------------------------------------------
// Schedules: `HH:MM` daily, or `Sun 18:00` weekly, in the owner's time zone

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const LOCAL_TIME = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?([01]\d|2[0-3]):([0-5]\d)$/

// `21:30` or `Sun 18:00` as `{ weekday, hour, minute }`, where `weekday` is 1 (Monday) to 7
// (Sunday), or null for every day. Returns null when the text is neither.
export function parseLocalTime(text) {
  const match = typeof text === 'string' ? LOCAL_TIME.exec(text) : null
  if (!match) return null
  return {
    weekday: match[1] ? WEEKDAYS.indexOf(match[1]) + 1 : null,
    hour: Number(match[2]),
    minute: Number(match[3]),
  }
}

// The first instant after `after` at which a schedule comes due in the zone.
//
// `schedule` is what `parseLocalTime` returns. Each local date gives the schedule one instant, by
// the rule of `fromLocal`. So a time that comes twice on the day clocks go back comes due once,
// and a time skipped on the day they go forward comes due at the jump.
export function nextLocalTime(schedule, timeZone, after) {
  const { weekday, hour, minute } = schedule
  const start = toLocal(after, timeZone)
  const firstDay = wallFromParts({ year: start.year, month: start.month, day: start.day })
  // One day back, because a zone's date can run ahead of the instant asked about; and far enough
  // forward to reach the same weekday again past a date the zone's calendar skips.
  for (let n = -1; n <= 15; n++) {
    const day = partsOfWall(firstDay + n * DAY)
    if (weekday !== null && day.weekday !== weekday) continue
    const instant = fromLocal({ year: day.year, month: day.month, day: day.day, hour, minute }, timeZone)
    if (instant <= after) continue
    // A zone that moves across the date line skips a date altogether. Nothing comes due on it.
    if (localDate(instant, timeZone) !== day.date) continue
    return instant
  }
  throw new Error(`no next time found for the schedule in ${timeZone}`)
}

// The last instant at or before `atOrBefore` at which a schedule came due in the zone, by the same
// rule as `nextLocalTime`: one instant for each local date, and none on a date the zone skips.
export function previousLocalTime(schedule, timeZone, atOrBefore) {
  const { weekday, hour, minute } = schedule
  const start = toLocal(atOrBefore, timeZone)
  const firstDay = wallFromParts({ year: start.year, month: start.month, day: start.day })
  // A schedule's instants go up with their dates, so the first one found going back is the last.
  // One day ahead, because the zone's date can run behind the instant's, and far enough back to
  // reach the same weekday again past a date the zone's calendar skips.
  for (let n = 1; n >= -15; n--) {
    const day = partsOfWall(firstDay + n * DAY)
    if (weekday !== null && day.weekday !== weekday) continue
    const instant = fromLocal({ year: day.year, month: day.month, day: day.day, hour, minute }, timeZone)
    if (instant > atOrBefore) continue
    if (localDate(instant, timeZone) !== day.date) continue
    return instant
  }
  throw new Error(`no earlier time found for the schedule in ${timeZone}`)
}
