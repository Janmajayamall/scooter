// The real sandbox in tests (`src/runner/sandbox/gondolin.mjs`): a data folder whose
// `runner/image/` is the test image, and the network policy with the scripted fake model behind it.
//
// These tests need QEMU and `SCOOTER_TEST_IMAGE`, as the VM checks of milestone 0 do
// (`vm.mjs`), and `debugfs`, which reads the image's record out of it. They skip themselves
// without any of them.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createProc } from '../../src/common/proc.mjs'
import { openGondolinSandbox } from '../../src/runner/sandbox/gondolin.mjs'
import { policyNetwork } from '../../src/runner/sandbox/policy.mjs'
import { IMAGE_RECORD, debugfsProgram, recordImage } from '../../src/runner/sandbox/image.mjs'
import { OPENROUTER_HOST } from './fake-model.mjs'
import { createTestLog } from './log.mjs'
import { atEnd } from './tmp.mjs'
// Loaded first, so that Gondolin keeps its list of running VMs in this process's own folder, which
// is removed when the process exits, and not in the first test's.
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
// its temporary folder, its cache folder and Gondolin's list of VMs. Register it after `makeTestDir`.
export function keepEnvironment(t) {
  const before = Object.fromEntries(['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'GONDOLIN_SESSIONS_DIR'].map(name => [name, process.env[name]]))
  atEnd(t, () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

// The network for a run with the fake model: the network policy, as a run has it, and, in
// OpenRouter's place, a server on this machine that the model answers from. What the policy lets
// out to OpenRouter goes to that server with Node's HTTP client, which is undici, as Gondolin's is,
// so the log follows it to its answer as it does in a run. The policy has checked it, and the key
// isn't in it yet: Gondolin puts the key in only for what the hook hands back to it to send.
// Nothing leaves the machine. Returns a `network` for `openGondolinSandbox`.
export async function fakeModelNetwork(t, model, { paths, clock, log }) {
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    const headers = Object.entries(incoming.headers).filter(([name]) => !['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name))
    const request = new Request(`https://${OPENROUTER_HOST}${incoming.url}`, { method: incoming.method, headers, body: chunks.length > 0 ? Buffer.concat(chunks) : undefined })
    const response = await model.handle(request)
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  atEnd(t, () => new Promise(resolve => server.close(resolve)))
  const upstream = `http://127.0.0.1:${server.address().port}`

  const network = policyNetwork({ paths, clock, log })
  return (policy, extras) => {
    const run = network(policy, extras)
    return {
      ...run,
      async onRequest(request) {
        const out = await run.onRequest(request)
        if (out instanceof Response || new URL(out.url).hostname !== OPENROUTER_HOST) return out
        const url = new URL(out.url)
        return fetch(`${upstream}${url.pathname}${url.search}`, { method: out.method, headers: out.headers, body: await out.arrayBuffer(), redirect: 'manual' })
      },
    }
  }
}

// Opens the real sandbox on the test's data folder, with the test image.
export async function openTestSandbox(t, { paths, settings, clock, log, network }) {
  await linkTestImage(paths)
  keepEnvironment(t)
  fs.mkdirSync(path.dirname(paths.imageBuild), { recursive: true })
  if (!fs.existsSync(paths.imageBuild)) fs.copyFileSync(new URL('../../config/image/build.json', import.meta.url), paths.imageBuild)
  return openGondolinSandbox({ paths, settings, log, clock, ...(network ? { network } : {}) })
}
