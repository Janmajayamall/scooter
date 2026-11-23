// Records what the pinned pi sends to OpenRouter, by running it in a VM against the fake model.
// `pi-requests.mjs` describes the fixtures this is for.

import fs from 'node:fs'
import path from 'node:path'
import { createFakeModel } from './fake-model.mjs'
import { betaValues, shapeOf } from './pi-requests.mjs'
import { samplePng } from './samples.mjs'
import {
  CHAT_MODEL,
  MESSAGES_MODEL,
  PI,
  designFiles,
  makeDataDir,
  piEnv,
  placeholderOf,
  runIn,
  runPi,
  startVm,
} from './vm.mjs'

// The sessions run with the paths of a Docker install, so the fixtures show Scooter's own
// paths and don't change from one machine to the next.
const GUEST = { agent: '/data/agents/lifelog', datastore: '/data/datastore' }
const DAY = `${GUEST.datastore}/2026/11/09`

const SESSION_MODELS = { messages: MESSAGES_MODEL, chat: CHAT_MODEL }
const ROUTE_NAMES = { messages: 'messages', chat: 'chat completions' }
const WRITTEN_BY = 'Written by test/tools/capture-pi-requests.mjs.'

// The default config asks for this level.
const SESSION_THINKING = 'low'

// A prompt as the runner writes it: the default prompt for new messages, filled in.
const PROMPT = `Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.
Your folder: ${GUEST.agent}
The datastore: ${GUEST.datastore}
This run may change: ${GUEST.agent}/views/ ${GUEST.agent}/memory/
Given before: none
New: 1050 1051
`

// One batch, start to finish: the model reads a message and a photo, changes a view and the
// memory, runs a command and reports. It thinks before its first and its last step, and says
// something before its first tool call, as real models do.
const SESSION_SCRIPT = [
  {
    thinking: 'The log has the message.',
    text: 'Let me look at the message.',
    tool: 'read',
    args: { path: `${DAY}/log.jsonl` },
  },
  { tool: 'read', args: { path: `${DAY}/1051.png` } },
  {
    tool: 'write',
    args: { path: `${GUEST.agent}/views/expenses.csv`, content: 'date,amount,source\n2026-11-09,150,#1050 #1051\n' },
  },
  {
    tool: 'edit',
    args: {
      path: `${GUEST.agent}/memory/preferences.md`,
      edits: [{ oldText: 'Track coffee.', newText: 'Track coffee and tea.' }],
    },
  },
  { tool: 'bash', args: { command: 'echo filed' } },
  { thinking: 'Everything is filed.', text: 'Filed both.' },
]

// Runs the session on one route, in a folder of its own under `dir`, and returns every request
// pi made, in order.
export async function captureSession(t, dir, route) {
  const data = makeDataDir(path.join(dir, route))
  fs.writeFileSync(path.join(data.day, '1051.png'), samplePng(8))
  const model = createFakeModel(SESSION_SCRIPT)
  const vm = await startVm(t, { model, files: designFiles(data), at: '/data' })
  const result = await runPi(
    vm,
    {
      prompt: PROMPT,
      model: SESSION_MODELS[route],
      thinking: SESSION_THINKING,
      session: { dir: `${GUEST.agent}/run/session`, id: 'lifelog-2026-11-09' },
      systemPrompt: `${GUEST.agent}/run/config/prompts/lifelog.md`,
      skills: [`${GUEST.agent}/run/config/skills/expenses`],
    },
    { cwd: GUEST.agent },
  )
  const placeholder = placeholderOf(vm)
  await vm.close()
  if (result.exitCode !== 0) throw new Error(`pi ended with ${result.exitCode}: ${result.stderr}`)
  return model.requests.map(request => withoutPlaceholder(request, placeholder))
}

// The fixtures say which header carries the placeholder, not what it was that time.
function withoutPlaceholder(request, placeholder) {
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) headers[name] = value.replaceAll(placeholder, '<placeholder>')
  return { ...request, headers }
}

// The session fixture for one route: the shape of every request, and the first and the last
// request whole. The last one carries the entire conversation.
export function sessionFixture(route, piVersion, requests) {
  return {
    about: `What pi sends to OpenRouter's ${ROUTE_NAMES[route]} route during one batch. ${WRITTEN_BY}`,
    pi: piVersion,
    model: SESSION_MODELS[route],
    thinking: SESSION_THINKING,
    shapes: requests.map(shapeOf),
    first: requests[0],
    last: requests.at(-1),
  }
}

// The thinking levels the catalog is asked at. The shape of a request depends on whether the model
// reasons, not on how hard.
const CATALOG_THINKING = ['unset', 'off', 'high']

// Asks pi for the OpenRouter models it knows, then makes one request with each of them at each
// level, in a single VM. Returns the catalog fixture. `progress` is called with a line of text now
// and then: with some 400 models this takes minutes.
export async function captureCatalog(t, dir, piVersion, progress = () => {}) {
  const data = makeDataDir(path.join(dir, 'catalog'))
  const model = createFakeModel([{ text: 'ok' }])
  const vm = await startVm(t, { model, files: designFiles(data) })

  const listed = await runIn(vm, [PI, '--offline', '--list-models'], { cwd: data.agent, env: piEnv(vm) })
  if (listed.exitCode !== 0) throw new Error(`pi --list-models ended with ${listed.exitCode}: ${listed.stderr}`)
  const models = listed.stdout
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(columns => columns[0] === 'openrouter')
    .map(columns => columns[1])
    .sort()

  // shape -> thinking level -> models
  const shapes = new Map()
  let runs = 0
  for (const id of models) {
    for (const thinking of CATALOG_THINKING) {
      const before = model.requests.length
      const level = thinking === 'unset' ? undefined : thinking
      const result = await runPi(vm, { prompt: 'hello', model: id, thinking: level }, { cwd: data.agent })
      const made = model.requests.slice(before)
      if (result.exitCode !== 0 || made.length !== 1) {
        const ending = `pi ended with ${result.exitCode} after ${made.length} requests`
        throw new Error(`${id} at thinking ${thinking}: ${ending}: ${result.stderr}`)
      }
      const [request] = made
      const key = JSON.stringify({
        method: request.method,
        host: request.host,
        path: request.path,
        query: request.query,
        fields: Object.keys(request.body).sort(),
        beta: betaValues(request),
      })
      const byLevel = shapes.get(key) ?? {}
      shapes.set(key, byLevel)
      ;(byLevel[thinking] ??= []).push(id)
      if (++runs % 100 === 0) progress(`${runs} of ${models.length * CATALOG_THINKING.length} requests`)
    }
  }
  await vm.close()

  return {
    about:
      'One request for every OpenRouter model in the catalog of the pinned pi, at three thinking levels: ' +
      `which path, which top-level fields and which anthropic-beta values each one is sent with. ${WRITTEN_BY}`,
    pi: piVersion,
    models: models.length,
    thinking: CATALOG_THINKING,
    shapes: [...shapes]
      .map(([key, byLevel]) => ({ ...JSON.parse(key), models: byLevel }))
      .sort((a, b) => a.path.localeCompare(b.path) || JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }
}
