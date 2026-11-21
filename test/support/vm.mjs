// Real VMs for the tests that need one.
//
// These tests boot a Gondolin VM from a built image and run the real pi in it, with the scripted
// fake model in place of OpenRouter. They need QEMU and `SCOOTER_TEST_IMAGE`, a folder holding an
// image built from `config/image/build.json` (see `build-test-image.mjs`), and skip themselves
// without either. They use no network and no key.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPENROUTER_HOST } from './fake-model.mjs'
import { atEnd } from './tmp.mjs'

// Gondolin fixes the folder for its session files when its module loads, and keeps its certificate
// authority beside it. Both go under the cache folder, so this process gets a cache folder of its
// own before Gondolin is loaded, and the tests leave the home folder alone.
const cacheHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scooter-vm-'))
process.env.XDG_CACHE_HOME = cacheHome
process.on('exit', () => fs.rmSync(cacheHome, { recursive: true, force: true }))
const { VM, RealFSProvider, ReadonlyProvider, ShadowProvider, createHttpHooks, createShadowPathPredicate } = await import(
  '@earendil-works/gondolin'
)

// Where Gondolin lists the VMs that are running.
export const SESSIONS_DIR = path.join(cacheHome, 'gondolin', 'sessions')

// Where the image keeps pi and `env`. Commands in the VM are run by their full path.
export const PI = '/usr/local/bin/pi'
export const ENV = '/usr/bin/env'

// pi and its tools start node, bash, git, rg and fd by name.
export const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// Gondolin puts its own file system at `/data` in the VM unless told otherwise, which is where
// Scooter's folders are in Docker. The tests move it here.
export const FUSE_MOUNT = '/run/gondolin-vfs'

// Scooter's default model. pi sends it to the messages route.
export const MESSAGES_MODEL = 'anthropic/claude-sonnet-5.5'
// A model that pi sends to the chat completions route.
export const CHAT_MODEL = 'google/gemini-2.5-flash'

// A stand-in for the OpenRouter key. The VM only ever sees Gondolin's placeholder for it.
const FAKE_KEY = `sk-or-v1-${'0'.repeat(64)}`
const placeholders = new WeakMap()

// What a VM made by `startVm` gives pi in place of the key: random text, new for every VM.
export function placeholderOf(vm) {
  return placeholders.get(vm) ?? ''
}

// Returns false when VM tests can run here, or the reason they can't.
export function vmSkipReason() {
  const image = process.env.SCOOTER_TEST_IMAGE
  if (!image) return 'SCOOTER_TEST_IMAGE is not set'
  if (!fs.existsSync(path.join(image, 'manifest.json'))) return `SCOOTER_TEST_IMAGE (${image}) holds no built image`
  const qemu = process.arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64'
  for (const program of [qemu, 'qemu-img']) {
    if (!onPath(program)) return `${program} is not installed`
  }
  return false
}

export function onPath(program) {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => {
    try {
      fs.accessSync(path.join(dir, program), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

// Boots a VM and returns it, started. It is closed when the test ends.
//
// `mounts` maps a path in the VM to `{ host, writable, hide }`: a folder on the host, read-only
// unless `writable` is true, without the paths listed in `hide`, which are given from the mount's
// own root, such as `/sessions`. `model` is a fake model that answers pi's requests; without one
// the VM can reach no host at all. `fuseMount` is Gondolin's own mount point; pass null for its
// default. `startTimeoutMs` is how long to wait for the VM to boot.
export async function startVm(t, { mounts = {}, model, fuseMount = FUSE_MOUNT, startTimeoutMs } = {}) {
  const hooks = createHttpHooks({
    allowedHosts: model ? [OPENROUTER_HOST] : [],
    secrets: model ? { OPENROUTER_API_KEY: { hosts: [OPENROUTER_HOST], value: FAKE_KEY } } : {},
    onRequest: model ? request => model.handle(request) : undefined,
  })
  const providers = {}
  for (const [guestPath, { host, writable = false, hide = [] }] of Object.entries(mounts)) {
    let provider = new RealFSProvider(host)
    if (hide.length > 0) provider = new ShadowProvider(provider, { shouldShadow: createShadowPathPredicate(hide) })
    providers[guestPath] = writable ? provider : new ReadonlyProvider(provider)
  }

  const vm = await VM.create({
    sandbox: { imagePath: process.env.SCOOTER_TEST_IMAGE },
    memory: '2G',
    cpus: 2,
    allowWebSockets: false,
    httpHooks: hooks.httpHooks,
    vfs: { mounts: providers, ...(fuseMount ? { fuseMount } : {}) },
    ...(startTimeoutMs ? { startTimeoutMs } : {}),
  })
  placeholders.set(vm, hooks.env.OPENROUTER_API_KEY ?? '')
  atEnd(t, () => vm.close())
  await vm.start()
  return vm
}

// A skill's file.
const SKILL = `---
name: expenses
description: How to file an expense in views/expenses.csv. Use it for receipts and amounts.
---

Add one row for each expense.
`

// A datastore line.
const MESSAGE = {
  seq: 1050,
  kind: 'message',
  dir: 'in',
  at: '2026-11-09T15:43:02Z',
  source: 'whatsapp',
  sourceId: '3EB0A1B2C3D4E5F6A7B8',
  trust: 'owner',
  text: 'coffee 150',
}

// An agent's folder and a datastore under `dir`, laid out as sections 4.1 and 6.2 of DESIGN.md
// give them, with one message, one skill and the system prompt file. Returns the paths.
export function makeDataDir(dir) {
  const agent = path.join(dir, 'data', 'agents', 'lifelog')
  const datastore = path.join(dir, 'data', 'datastore')
  const day = path.join(datastore, '2026', '11', '09')
  const skill = path.join(agent, 'run', 'config', 'skills', 'expenses')
  for (const folder of ['views', 'memory', 'sessions', 'run/session', 'run/config/prompts']) {
    fs.mkdirSync(path.join(agent, folder), { recursive: true })
  }
  fs.mkdirSync(skill, { recursive: true })
  fs.mkdirSync(day, { recursive: true })
  fs.writeFileSync(path.join(agent, 'state.json'), '{"cursor":1049}\n')
  fs.writeFileSync(path.join(agent, 'memory', 'preferences.md'), '- 2026-11-09 (#1040): Track coffee.\n')
  fs.writeFileSync(path.join(agent, 'run', 'system.md'), '# Protocol\n\nEnd every answer with DONE lines.\n')
  fs.writeFileSync(path.join(skill, 'SKILL.md'), SKILL)
  fs.writeFileSync(path.join(day, 'log.jsonl'), `${JSON.stringify(MESSAGE)}\n`)
  return {
    agent,
    datastore,
    day,
    skill,
    session: path.join(agent, 'run', 'session'),
    systemPrompt: path.join(agent, 'run', 'system.md'),
  }
}

// The mounts of section 6.6: the agent's folder read-only, except `views/`, `memory/` and
// `run/session/`, which are writable, and `sessions/`, which is hidden; and the datastore
// read-only. `guest` gives the paths in the VM when they differ from the host's.
export function designMounts(data, guest = data) {
  return {
    [guest.agent]: { host: data.agent, hide: ['/sessions'] },
    [`${guest.agent}/views`]: { host: path.join(data.agent, 'views'), writable: true },
    [`${guest.agent}/memory`]: { host: path.join(data.agent, 'memory'), writable: true },
    [`${guest.agent}/run/session`]: { host: path.join(data.agent, 'run', 'session'), writable: true },
    [guest.datastore]: { host: data.datastore },
  }
}

// pi's environment, as section 6.6 lists it.
export function piEnv(vm, { tz = 'Asia/Kolkata' } = {}) {
  return {
    PATH: GUEST_PATH,
    HOME: '/root',
    LANG: 'C.UTF-8',
    TZ: tz,
    PI_SKIP_VERSION_CHECK: '1',
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    OPENROUTER_API_KEY: placeholderOf(vm),
  }
}

// pi's arguments, as section 6.6 gives the command. `session` is `{ dir, id }`; without one the
// run keeps no session. `without` names flags to leave out, for the tests that show what a flag
// does.
export function piArgs({ prompt, model = MESSAGES_MODEL, thinking, session, systemPrompt, skills = [], without = [] }) {
  const flags = [
    '--no-approve',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-mcp',
    '--offline',
  ]
  return [
    '-p',
    ...flags.filter(flag => !without.includes(flag)),
    '--provider',
    'openrouter',
    '--model',
    model,
    ...(thinking ? ['--thinking', thinking] : []),
    '--tools',
    'read,bash,edit,write,grep,find,ls',
    ...(session ? ['--session-dir', session.dir, '--session-id', session.id] : ['--no-session']),
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
    ...skills.flatMap(skill => ['--skill', skill]),
    '--',
    prompt,
  ]
}

// Runs a program in the VM from an argument list, with exactly the environment given: `env -i`
// drops the variables the VM adds by itself. No shell reads any argument.
export function runIn(vm, argv, { cwd, env = {} } = {}) {
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${value}`)
  return vm.exec([ENV, '-i', ...assignments, ...argv], { cwd })
}

// Runs pi in the VM as the runner will: from an argument list, in `cwd`, with the environment of
// 6.6 and nothing else.
export function runPi(vm, options, { cwd, env = piEnv(vm) } = {}) {
  return runIn(vm, [PI, ...piArgs(options)], { cwd, env })
}

// Runs a shell command in the VM. For looking around from a test, never for pi's prompt.
export async function sh(vm, command, options = {}) {
  const result = await vm.exec(['/bin/sh', '-c', command], options)
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

// The tool results in a recorded request, in order, as { text, isError, images }.
export function toolResults(body) {
  const results = []
  for (const message of body.messages) {
    if (message.role === 'tool') {
      // The chat route: one message for each result, and images follow in a user message.
      results.push({ text: textOf(message.content), isError: undefined, images: [] })
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== 'tool_result') continue
        const parts = Array.isArray(block.content) ? block.content : []
        results.push({
          text: textOf(block.content),
          isError: block.is_error === true,
          images: parts.filter(part => part.type === 'image').map(part => part.source),
        })
      }
    }
  }
  return results
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}
