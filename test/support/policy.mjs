// The network policy in tests (`src/runner/sandbox/policy.mjs`), without a VM: its hook, with
// Gondolin's own handling of the key around it, as the sandbox puts the two together for a run, and
// a fake upstream in OpenRouter's place, on this machine.
//
// What the hook lets out is forwarded to the fake upstream with an HTTP client of undici's, as
// Gondolin forwards it to OpenRouter with its own, so the log follows it to its answer the way it
// does in a run. Node's `fetch` is undici's; `gondolinFetch` is the copy Gondolin itself uses.

import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { readNetworkLog } from '../../src/common/netlog.mjs'
import { makePaths } from '../../src/common/paths.mjs'
import { policyNetwork } from '../../src/runner/sandbox/policy.mjs'
import { createFakeClock } from './clock.mjs'
import { createTestLog } from './log.mjs'
import { loadFixture } from './pi-requests.mjs'
import { KEY } from './test-runner.mjs'
import { atEnd, makeTestDir } from './tmp.mjs'
// Loaded first, so that Gondolin keeps its files in this process's own folder (`vm.mjs`).
import './vm.mjs'

const { createHttpHooks } = await import('@earendil-works/gondolin')

// The HTTP client Gondolin makes its requests with: undici, as Gondolin's package finds it.
export const gondolinFetch = createRequire(import.meta.resolve('@earendil-works/gondolin'))('undici').fetch

// What the VM sees in place of the key in these tests.
export const PLACEHOLDER = 'scooter-openrouter-api-key-placeholder-0123456789abcdef'

// A request as the pinned pi sent it, from the fixtures: `which` is `first` or `last` of the
// session on `route`, `messages` or `chat`. `change(body, headers)` may alter a copy of it first.
export function piRequest(route, which = 'first', change = () => {}) {
  const fixture = loadFixture(route)
  const recorded = fixture[which]
  const body = structuredClone(recorded.body)
  const headers = {}
  for (const [name, value] of Object.entries(recorded.headers)) {
    if (name === 'content-length' || name === 'host') continue
    headers[name] = value.replaceAll('<placeholder>', PLACEHOLDER)
  }
  change(body, headers)
  return new Request(`https://openrouter.ai${recorded.path}${recorded.query}`, { method: recorded.method, headers, body: JSON.stringify(body) })
}

export function modelOf(route) {
  return loadFixture(route).model
}

// A policy for one run, on a data folder of the test's, and a fake upstream. Options: `model`, the
// agent's; `internet`; `zdr`; `answer(request, response, record)`, how the upstream answers, by
// default a short JSON body.
//
// Returns:
// - `send(request)`: what the policy and Gondolin's handling of the key make of a request the VM
//   sent: a `Response` when the policy refused it, or the `Request` Gondolin would forward;
// - `forward(request, { fetch })`: sends what `send` let out to the fake upstream, at its path, as
//   Gondolin would send it to its host, and returns the answer;
// - `received`: what reached the upstream, each `{ method, url, headers, body, logged }`, where
//   `logged` is the network log as it stood when the request arrived;
// - `lines()`: the network log; `close()`: ends the run's network, as the sandbox does once the
//   VM has closed; `paths`, `clock`, `log`, `entries`, `options` (the hook's options).
export async function openPolicy(t, { model = modelOf('messages'), internet = false, zdr = true, answer } = {}) {
  const root = makeTestDir(t)
  const paths = makePaths({ dataDir: path.join(root, 'data'), configDir: path.join(root, 'config') })
  fs.mkdirSync(paths.runner, { recursive: true })
  const clock = createFakeClock('2026-11-09T15:50:00Z')
  const { log, entries } = createTestLog({ clock })
  const lines = () => readNetworkLog(paths, { from: Date.parse('2026-11-09T00:00:00Z'), to: Date.parse('2026-11-10T00:00:00Z') }).entries

  const received = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const record = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8'), logged: lines() }
    received.push(record)
    if (answer) return answer(request, response, record)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  atEnd(t, () => {
    for (const socket of sockets) socket.destroy()
    return new Promise(resolve => server.close(resolve))
  })
  const upstream = `http://127.0.0.1:${server.address().port}`

  const network = policyNetwork({ paths, clock, log })
  const policy = { model, internet, zdr, secrets: { OPENROUTER_API_KEY: { hosts: ['openrouter.ai'], value: KEY } } }
  const { close, ...options } = network(policy, { placeholders: { OPENROUTER_API_KEY: PLACEHOLDER } })
  atEnd(t, close)
  const hooks = createHttpHooks({ ...options, secrets: { OPENROUTER_API_KEY: { hosts: ['openrouter.ai'], value: KEY, placeholder: PLACEHOLDER } } })

  return {
    paths,
    clock,
    log,
    entries,
    options,
    received,
    upstream,
    lines,
    close,
    send: request => hooks.httpHooks.onRequest(request),
    async forward(request, { fetch = globalThis.fetch } = {}) {
      const url = new URL(request.url)
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer())
      return fetch(`${upstream}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, redirect: 'manual' })
    },
  }
}
