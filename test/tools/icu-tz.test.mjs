// ICU's zone rules that ship with the runner for the VM's Node (`src/runner/vm/icu-tz/`), and what a
// Node does with them: what `show` and the agent's whole VM rely on, which the VM's own Node, the
// image's, shows in `VM 7` and `VM 8` of `test/tools/vm.test.mjs`. Run it again after updating the
// files (`docs/architecture/agent.md`, "The zone rules").

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { icuTzRelease } from '../../src/runner/agentdir.mjs'
import { SHIPPED_ICU_TZ, headerTimes } from '../support/icu-tz.mjs'
import { makeTestDir } from '../support/tmp.mjs'

const FILES = ['zoneinfo64.res', 'metaZones.res', 'timezoneTypes.res', 'windowsZones.res']

// What this Node's `process.versions.tz` is, given `env`.
function tzOf(env) {
  const result = spawnSync(process.execPath, ['-p', 'process.versions.tz'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('ICU zone rules: the files that ship are ICU\'s four, each the one release.txt lists, with the licence of where they come from', () => {
  const release = icuTzRelease()
  assert.match(release, /^\d{4}[a-z]+$/)
  const listed = fs.readFileSync(path.join(SHIPPED_ICU_TZ, 'release.txt'), 'utf8')
  assert.equal(
    listed,
    `${release}\n${FILES.map(name => `${createHash('sha256').update(fs.readFileSync(path.join(SHIPPED_ICU_TZ, name))).digest('hex')}  ${name}\n`).join('')}`,
  )
  assert.deepEqual(fs.readdirSync(SHIPPED_ICU_TZ).sort(), ['LICENSE', 'README.md', 'metaZones.res', 'release.txt', 'timezoneTypes.res', 'windowsZones.res', 'zoneinfo64.res'])
  // Each is ICU's resource format, little-endian: its header's magic, then `ResB`.
  for (const name of FILES) {
    const head = fs.readFileSync(path.join(SHIPPED_ICU_TZ, name)).subarray(0, 16)
    assert.deepEqual([head[2], head[3]], [0xda, 0x27], name)
    assert.equal(head[8], 0, `${name} is little-endian`)
    assert.equal(head.subarray(12, 16).toString('latin1'), 'ResB', name)
  }
  assert.match(fs.readFileSync(path.join(SHIPPED_ICU_TZ, 'LICENSE'), 'utf8'), /^UNICODE LICENSE V3\n\nCOPYRIGHT AND PERMISSION NOTICE\n/)
})

test('ICU zone rules: a Node given ICU_TIMEZONE_FILES_DIR converts with the files there, and without it with its own', t => {
  const release = icuTzRelease()
  const own = tzOf({})
  t.diagnostic(`this Node: ${process.version}, ICU ${process.versions.icu}, its own zone rules tz ${own}; the shipped ones tz ${release}`)
  assert.equal(tzOf({ ICU_TIMEZONE_FILES_DIR: SHIPPED_ICU_TZ }), release)
  // A folder without them, or without `zoneinfo64.res`: its own again.
  const dir = makeTestDir(t)
  assert.equal(tzOf({ ICU_TIMEZONE_FILES_DIR: dir }), own)
  for (const name of FILES.slice(1)) fs.copyFileSync(path.join(SHIPPED_ICU_TZ, name), path.join(dir, name))
  assert.equal(tzOf({ ICU_TIMEZONE_FILES_DIR: dir }), own)
  // The times the image's own rules, tz 2024b, got wrong or had none for, as the shipped rules give
  // them, by the runner's own time code in a Node given them.
  assert.deepEqual(
    [
      headerTimes('America/Vancouver', ['2026-11-01T12:30:00Z']),
      headerTimes('America/Coyhaique', ['2026-11-01T12:30:00Z']),
      headerTimes('America/Asuncion', ['2026-04-01T00:30:00Z']),
      headerTimes('Africa/Casablanca', ['2026-10-01T00:30:00Z']),
    ].flat(),
    ['Sun 1 Nov 2026 05:30 -07:00', 'Sun 1 Nov 2026 09:30 -03:00', 'Tue 31 Mar 2026 21:30 -03:00', 'Thu 1 Oct 2026 00:30 +00:00'],
  )
})
