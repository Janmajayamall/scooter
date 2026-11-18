// The real sandbox in tests (`src/runner/sandbox/gondolin.mjs`): a data folder whose
// `runner/image/` is the test image, and the scripted fake model as its network.
//
// These tests need QEMU and `SCOOTER_TEST_IMAGE`, as the VM checks of milestone 0 do
// (`vm.mjs`), and `debugfs`, which reads the image's record out of it. They skip themselves
// without any of them.

import fs from 'node:fs'
import path from 'node:path'
import { createProc } from '../../src/common/proc.mjs'
import { openGondolinSandbox } from '../../src/runner/sandbox/gondolin.mjs'
import { IMAGE_RECORD, debugfsProgram, recordImage } from '../../src/runner/sandbox/image.mjs'
import { OPENROUTER_HOST } from './fake-model.mjs'
import { createTestLog } from './log.mjs'
import { atEnd } from './tmp.mjs'
// Loaded first, so that Gondolin keeps its list of running VMs in this process's own folder, which
// is removed when the process exits (D53), and not in the first test's.
import { vmSkipReason } from './vm.mjs'

export function sandboxSkipReason() {
  return vmSkipReason() || (debugfsProgram() === null ? 'debugfs is not installed' : false)
}

// The test image's record, read once for the process.
let recorded = null

// Makes `paths.runnerImage` the test image: a folder of links to its files, with its record, as
// `build-image` would leave it.
export async function linkTestImage(paths) {
  const source = process.env.SCOOTER_TEST_IMAGE
  fs.mkdirSync(paths.runnerImage, { recursive: true })
  for (const name of fs.readdirSync(source)) {
    const link = path.join(paths.runnerImage, name)
    if (name !== IMAGE_RECORD && !fs.existsSync(link)) fs.symlinkSync(path.join(source, name), link)
  }
  recorded ??= (await recordImage(source, { proc: createProc({ log: createTestLog().log }) })).record
  fs.writeFileSync(path.join(paths.runnerImage, IMAGE_RECORD), JSON.stringify(recorded))
}

// Puts back, when the test ends, what the sandbox changes in the process's environment: its home,
// its temporary folder, its cache folder and Gondolin's list of VMs (row 16). Register it after `makeTestDir`.
export function keepEnvironment(t) {
  const before = Object.fromEntries(['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'GONDOLIN_SESSIONS_DIR'].map(name => [name, process.env[name]]))
  atEnd(t, () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

// The network for a run with the fake model: requests to OpenRouter reach the model, which
// answers them in the runner's process, and every other request is refused there. Nothing leaves
// the machine.
export function fakeModelNetwork(model, refused = []) {
  return () => ({
    allowedHosts: [OPENROUTER_HOST],
    onRequest: async request => {
      const host = new URL(request.url).hostname
      if (host === OPENROUTER_HOST) return model.handle(request)
      refused.push(host)
      return new Response('refused by the test network\n', { status: 403 })
    },
  })
}

// Opens the real sandbox on the test's data folder, with the test image.
export async function openTestSandbox(t, { paths, settings, clock, log, network }) {
  await linkTestImage(paths)
  keepEnvironment(t)
  fs.mkdirSync(path.dirname(paths.imageBuild), { recursive: true })
  if (!fs.existsSync(paths.imageBuild)) fs.copyFileSync(new URL('../../config/image/build.json', import.meta.url), paths.imageBuild)
  return openGondolinSandbox({ paths, settings, log, clock, ...(network ? { network } : {}) })
}
