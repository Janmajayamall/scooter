// Rewrites the fixtures in test/fixtures/pi-requests/ from the pinned pi.
//
// Run it by hand after changing pi's version in config/image/build.json and building the image
// again, then look at what `git diff` shows: that is what the network policy has to follow.
//
//   SCOOTER_TEST_IMAGE=<folder with the image> node test/tools/capture-pi-requests.mjs [sessions|catalog]
//
// With no argument it writes both the two sessions and the catalog. The catalog makes about 1,200
// requests in one VM, which takes some 7 minutes with KVM. Nothing leaves the machine: the fake
// model answers every request.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pinnedPiVersion } from '../support/image.mjs'
import { captureCatalog, captureSession, sessionFixture } from '../support/pi-capture.mjs'
import { saveFixture } from '../support/pi-requests.mjs'
import { vmSkipReason } from '../support/vm.mjs'

const what = process.argv[2] ?? 'all'
if (!['all', 'sessions', 'catalog'].includes(what)) {
  console.error('usage: node test/tools/capture-pi-requests.mjs [sessions|catalog]')
  process.exit(2)
}
const reason = vmSkipReason()
if (reason) {
  console.error(`can't capture: ${reason}`)
  process.exit(2)
}

// The helpers register their clean-up with a test. Here this object stands in for one.
const cleanups = []
const t = { after: cleanup => cleanups.push(cleanup) }

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scooter-'))
process.env.TMPDIR = path.join(dir, 'tmp')
fs.mkdirSync(process.env.TMPDIR)

try {
  const piVersion = pinnedPiVersion()
  if (what !== 'catalog') {
    for (const route of ['messages', 'chat']) {
      const requests = await captureSession(t, dir, route)
      saveFixture(route, sessionFixture(route, piVersion, requests))
      console.log(`${route}: ${requests.length} requests`)
    }
  }
  if (what !== 'sessions') {
    const catalog = await captureCatalog(t, dir, piVersion, line => console.log(`catalog: ${line}`))
    saveFixture('catalog', catalog)
    console.log(`catalog: ${catalog.models} models, ${catalog.shapes.length} shapes`)
  }
} finally {
  for (const cleanup of cleanups) await cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
}
