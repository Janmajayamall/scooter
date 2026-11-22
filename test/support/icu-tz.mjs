// The times `show`'s header gives, as the zone rules that ship with the runner have them.
//
// `show` converts in the VM with ICU's zone rules that ship with the runner, `src/runner/vm/icu-tz/`,
// which pi's environment points the VM's Node at. This Node's own rules can be of another release
// (2026e here, where the runner ships 2026f), and where two releases differ, `show` follows the
// shipped one. So the times are worked out by the runner's own time code (`toLocal`) in a Node given
// the same `ICU_TIMEZONE_FILES_DIR`: this file, run as a program, reads `{ zone, ats }` on stdin
// and writes `{ tz, times }`.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toLocal } from '../../src/common/time.mjs'

// The zone rules as they ship with the runner.
export const SHIPPED_ICU_TZ = fileURLToPath(new URL('../../src/runner/vm/icu-tz', import.meta.url))

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = number => String(number).padStart(2, '0')

// An offset from UTC, in seconds, as the header ends with it: `+05:30`, `+00:00`, `+05:53:28`.
export function offsetText(offset) {
  const size = Math.abs(offset)
  const text = `${offset < 0 ? '-' : '+'}${pad(Math.floor(size / 3600))}:${pad(Math.floor(size / 60) % 60)}`
  return size % 60 === 0 ? text : `${text}:${pad(size % 60)}`
}

// `at` in `zone` as the header gives it, `Mon 9 Nov 2026 21:22 +05:30`, by this Node's rules.
function headerTimeHere(at, zone) {
  const t = toLocal(Date.parse(at), zone)
  return `${DAYS[t.weekday - 1]} ${t.day} ${MONTHS[t.month - 1]} ${t.year} ${pad(t.hour)}:${pad(t.minute)} ${offsetText(Math.round(t.offsetMinutes * 60))}`
}

const known = new Map()

// The header's time of each of `ats` in `zone`, by the shipped rules, in one Node for all those not
// worked out before. `tz` is the release that Node gave, which the caller holds to the shipped one.
export function headerTimes(zone, ats) {
  const missing = [...new Set(ats.filter(at => !known.has(`${zone} ${at}`)))]
  if (missing.length > 0) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ICU_TIMEZONE_FILES_DIR: SHIPPED_ICU_TZ },
      input: JSON.stringify({ zone, ats: missing }),
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`working out the header's times failed: ${result.stderr}`)
    const { tz, times } = JSON.parse(result.stdout)
    const release = fs.readFileSync(`${SHIPPED_ICU_TZ}/release.txt`, 'utf8').split('\n')[0]
    if (tz !== release) throw new Error(`a Node given ICU_TIMEZONE_FILES_DIR converts with tz ${tz}, not the shipped ${release}`)
    missing.forEach((at, n) => known.set(`${zone} ${at}`, times[n]))
  }
  return ats.map(at => known.get(`${zone} ${at}`))
}

export const headerTime = (at, zone = 'Asia/Kolkata') => headerTimes(zone, [at])[0]

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { zone, ats } = JSON.parse(fs.readFileSync(0, 'utf8'))
  process.stdout.write(JSON.stringify({ tz: process.versions.tz, times: ats.map(at => headerTimeHere(at, zone)) }))
}
