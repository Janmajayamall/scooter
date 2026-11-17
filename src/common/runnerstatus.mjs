// The runner's `status.json` (6.3 of DESIGN.md; row 6): what `/status` needs to know about the
// runner's settings, which the bridge can't read for itself, since it reads neither `config/` nor
// `runner.env` (5.4).
//
//   {
//     "startedAt": "2026-11-09T15:00:02Z",
//     "accel": "kvm",
//     "zdr": true,
//     "internet": false,
//     "imageBuiltAt": "2026-11-09T12:31:40Z",
//     "agents": {
//       "lifelog": {"model": "anthropic/claude-sonnet-5.5", "timeoutMinutes": 10, "reads": ["whatsapp", "email"]}
//     }
//   }
//
// - `startedAt`: when the runner that wrote it started.
// - `accel`: how pi's VMs run, `kvm` or `emulation` (6.6).
// - `zdr`, `internet`: whether `OPENROUTER_ZDR` and `AGENT_INTERNET` are on.
// - `imageBuiltAt`: when the VM image was built (6.12), or null when that isn't known.
// - `agents`: each agent's model, `timeout_minutes` and `reads`.
//
// The runner writes it atomically at startup. The bridge reads it for `/status`, which is why its
// format is here.

import { SOURCES } from './datastore/line.mjs'
import { readJsonFile } from './files.mjs'
import { parseIsoSeconds } from './time.mjs'

export const ACCELERATORS = ['kvm', 'emulation']

const FIELDS = ['startedAt', 'accel', 'zdr', 'internet', 'imageBuiltAt', 'agents']
const AGENT_FIELDS = ['model', 'timeoutMinutes', 'reads']

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = value => parseIsoSeconds(value) !== null
// An agent's name, as `agents.yaml` allows it (6.1). The bridge makes paths of it, for `/status`.
const AGENT_NAME = /^[a-z][a-z0-9-]*$/

// What is wrong with a status, as a list of statements that name fields. An empty list means it is
// well formed.
export function checkRunnerStatus(status) {
  if (!isObject(status)) return ['the status must be an object']
  const problems = []
  for (const name of Object.keys(status)) {
    if (!FIELDS.includes(name)) problems.push(`${name} is not a field of the status`)
  }
  for (const name of FIELDS) {
    if (status[name] === undefined) problems.push(`${name} is missing`)
  }
  if (status.startedAt !== undefined && !isTime(status.startedAt)) problems.push('startedAt must be a UTC time to the second')
  if (status.accel !== undefined && !ACCELERATORS.includes(status.accel)) problems.push(`accel must be one of ${ACCELERATORS.join(', ')}`)
  for (const name of ['zdr', 'internet']) {
    if (status[name] !== undefined && typeof status[name] !== 'boolean') problems.push(`${name} must be true or false`)
  }
  if (status.imageBuiltAt !== undefined && status.imageBuiltAt !== null && !isTime(status.imageBuiltAt)) {
    problems.push('imageBuiltAt must be a UTC time to the second, or null')
  }
  if (status.agents !== undefined) {
    if (!isObject(status.agents)) problems.push('agents must be an object')
    else {
      for (const [name, agent] of Object.entries(status.agents)) {
        const field = `agents.${name}`
        if (!AGENT_NAME.test(name)) {
          problems.push('agents must be named as agents.yaml names them, such as lifelog')
          continue
        }
        if (!isObject(agent)) {
          problems.push(`${field} must be an object`)
          continue
        }
        for (const key of Object.keys(agent)) {
          if (!AGENT_FIELDS.includes(key)) problems.push(`${field}.${key} is not a field of the status`)
        }
        if (typeof agent.model !== 'string' || agent.model === '') problems.push(`${field}.model must be a model ID`)
        if (!Number.isSafeInteger(agent.timeoutMinutes) || agent.timeoutMinutes < 1) problems.push(`${field}.timeoutMinutes must be a whole number of minutes`)
        if (!Array.isArray(agent.reads) || !agent.reads.every(source => SOURCES.includes(source))) {
          problems.push(`${field}.reads must list sources such as ${SOURCES.join(' and ')}`)
        }
      }
    }
  }
  return problems
}

// Something is wrong with a `status.json`. The message names the file and the fields.
export class RunnerStatusError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RunnerStatusError'
  }
}

// Reads a `status.json`. Returns null when there is none, which is so until the runner first
// starts, and throws a `RunnerStatusError` that names the file when it isn't a status.
export function readRunnerStatus(file) {
  let status
  try {
    status = readJsonFile(file)
  } catch (error) {
    if (error instanceof SyntaxError) throw new RunnerStatusError(`${file} is not JSON`)
    throw error
  }
  if (status === undefined) return null
  const problems = checkRunnerStatus(status)
  if (problems.length > 0) throw new RunnerStatusError(`${file}: ${problems.join('; ')}`)
  return status
}
