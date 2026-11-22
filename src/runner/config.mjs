// The agents' configuration, `agents.yaml`.
//
// The runner reads it at startup and refuses to start on any fault. Every fault is reported at once,
// each naming the field and the line it is on. This is the only module that imports `yaml`.
//
//   agents:
//     lifelog:
//       model: anthropic/claude-sonnet-5.5
//       thinking: low                        # optional
//       prompt: prompts/lifelog.md           # relative to the config folder
//       skills: [skills/expenses, skills/people]
//       reads: [datastore/, agents/lifelog/] # optional; relative to the data folder
//       writes: [agents/lifelog/views/, agents/lifelog/memory/]
//       sends: [whatsapp]
//       session: daily                       # daily or none
//       reply_mode: quiet                    # quiet or confirm
//       ack_reaction: "✅"                   # "" for none
//       timeout_minutes: 10
//       run:
//         - on: new-messages
//           channels: [whatsapp, email]
//         - at: "21:30"                      # or "Sun 18:00"
//           task: Evening check-in.
//         - backfill: people-1
//           skill: people
//           writes: [agents/lifelog/views/people.csv]
//
// Every field is required except `thinking` and `reads`. A key the format doesn't have is a fault,
// so that a misspelled one isn't ignored without a word.

import fs from 'node:fs'
import path from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import { SOURCES } from '../common/datastore/line.mjs'
import { limits } from '../common/limits.mjs'
import { OWN_AUTHORS } from '../common/outbox.mjs'
import { parseLocalTime } from '../common/time.mjs'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const SESSIONS = ['daily', 'none']
export const REPLY_MODES = ['quiet', 'confirm']
export const TRIGGER_KINDS = ['on', 'at', 'backfill']

// The names in an agent's folder that the runner keeps for itself, besides the names that start
// with a dot, `.git` and `.gitignore` among them: its state, the sessions and `run/`. `writes`
// can't name them, or hold the folder: a run that could change them could stop the runner, or
// rewrite its record, and the clean-up and the commit work on what `writes` names in the folder,
// which can't be the folder that holds them.
export const RUNNER_NAMES = ['state.json', 'sessions', 'run']

// Where a clean-up sets aside what it throws away, beside the agents' folders
// (`paths.agentDiscarded`): the runner's own, which `writes` can't name either.
const DISCARDED = 'agents/.discarded'

// Linux's limits on a name and on a path, in bytes, not tuning numbers: a path of `reads` or
// `writes` with a longer name names nothing, and the runner, which makes the folders of `writes`,
// couldn't make one.
const NAME_MAX_BYTES = 255
const PATH_MAX_BYTES = 4095

const AGENT_NAME = /^[a-z][a-z0-9-]*$/
// A backfill's ID goes into session names, commit messages and the state.
const BACKFILL_ID = /^[a-z0-9][a-z0-9-]*$/
// An OpenRouter model ID, such as `anthropic/claude-sonnet-5.5`, `~anthropic/claude-sonnet-latest`
// or `google/gemma-3-4b-it:free`. Every model in pi's catalog has this form (milestone 0, pi 6).
const MODEL_ID = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/

const AGENT_KEYS = ['model', 'thinking', 'prompt', 'skills', 'reads', 'writes', 'sends', 'session', 'reply_mode', 'ack_reaction', 'timeout_minutes', 'run']
const OPTIONAL_KEYS = ['thinking', 'reads']
const TRIGGER_KEYS = { on: ['on', 'channels'], at: ['at', 'task'], backfill: ['backfill', 'skill', 'writes'] }

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value)

function list(names) {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

// Paths of `reads` and `writes`, as the config keeps them: relative to the data folder, cleaned,
// a folder ending in `/`, such as `agents/lifelog/views/`.
export const isFolder = entry => entry.endsWith('/')
const bare = entry => entry.replace(/\/$/, '')

// Whether the entry `inner` is in the entry `outer`: the same, or, for a folder, in it.
export function isWithin(inner, outer) {
  const [p, folder] = [bare(inner), bare(outer)]
  return inner === outer || (isFolder(outer) && p.startsWith(`${folder}/`))
}

// A path of `reads` or `writes` as written, cleaned: relative to the data folder, with no `.`,
// `..` or empty part and no `\`, a folder ending in `/`. Null when it isn't one.
function dataPath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return null
  const folder = value.endsWith('/')
  const parts = value.split('/').slice(0, folder ? -1 : undefined)
  if (parts.length === 0 || parts.some(part => part === '' || part === '.' || part === '..')) return null
  return `${parts.join('/')}${folder ? '/' : ''}`
}

// What the agent's repository keeps: the entries of `writes` in the agent's own folder, as paths
// from it, a folder ending in `/`, in their order, without an entry that lies in another.
export function repositoryPaths(agentName, writes) {
  const own = `agents/${agentName}/`
  const inside = writes.filter(write => write.startsWith(own) && write !== own).map(write => write.slice(own.length))
  return inside.filter(entry => !inside.some(other => other !== entry && isWithin(entry, other)))
}

// What is wrong with `agents.yaml`. `problems` lists every fault, each as `{ field, line, message }`,
// where `field` is the path to it, such as `agents.lifelog.run[1].at` (lists count from 0), `line`
// its line in the file or null, and `message` says both.
export class ConfigError extends Error {
  constructor(problems) {
    super(problems.map(problem => problem.message).join('\n'))
    this.name = 'ConfigError'
    this.problems = problems
  }
}

function fieldName(parts) {
  return parts.reduce((name, part) => (typeof part === 'number' ? `${name}[${part}]` : name ? `${name}.${part}` : part), '')
}

// Whether a file or folder is inside a folder, or is that folder.
function isInside(dir, target) {
  return target === dir || target.startsWith(`${dir}${path.sep}`)
}

// Reads the text of `agents.yaml`. `configDir` is the config folder that its paths are relative
// to, `dataDir`, when given, the data folder, against whose path a path of `reads` and `writes` is
// measured, and `file` names the file in messages. Returns the configuration:
//
//   { agents: [agent] }
//
// where each agent is
//
//   { name, model, thinking, prompt: { path, file }, skills: [{ name, path, dir }],
//     reads, writes, repository, sends, channels, session, replyMode, ackReaction, timeoutMinutes,
//     run: { newMessages: [{ channels }], scheduled: [{ at, schedule, task }], backfill: [{ id, skill, writes }] } }
//
// `thinking` is null when it isn't given. A path of the config folder is kept as written, cleaned
// (`path`), and as the file or folder it names (`file`, `dir`). A skill's `name` is its folder's
// name. `reads` and `writes` are paths from the data folder, cleaned, a folder ending in `/`;
// `reads` is the datastore and the agent's own folder when it isn't given. `repository` is what
// the agent's repository keeps (`repositoryPaths`). `channels` is every channel the triggers for
// new messages name, in order. `schedule` is what `parseLocalTime` returns. Throws a `ConfigError`
// that lists every fault.
export function parseConfig(text, { configDir, dataDir = null, file = 'agents.yaml' }) {
  const problems = []
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, prettyErrors: true, lineCounter })

  for (const error of [...doc.errors, ...doc.warnings]) {
    const line = error.linePos?.[0]?.line ?? null
    const what = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')
    problems.push({ field: null, line, message: `${file}${line === null ? '' : `, line ${line}`}: ${what}` })
  }
  if (problems.length > 0) throw new ConfigError(problems)

  // The line of a field: that of the deepest part of its path that the file has.
  function lineOf(parts) {
    for (let n = parts.length; n >= 0; n--) {
      const node = n === 0 ? doc.contents : doc.getIn(parts.slice(0, n), true)
      if (node?.range) return lineCounter.linePos(node.range[0]).line
    }
    return null
  }
  const fault = (parts, what) => {
    const field = fieldName(parts)
    const line = lineOf(parts)
    problems.push({ field, line, message: `${file}${line === null ? '' : `, line ${line}`}: ${field} ${what}` })
  }

  const top = doc.toJS({ maxAliasCount: 100 })
  // Where each trigger for new messages is, for a fault that names it.
  const fieldOf = new Map()
  const configReal = (() => {
    try {
      return fs.realpathSync(configDir)
    } catch {
      return path.resolve(configDir)
    }
  })()

  // A path inside the config folder, as written: relative, and not leading out of it. Returns
  // `{ path, real }`, with `real` the file or folder it names, or null after a fault.
  function configPath(parts, value, example) {
    if (typeof value !== 'string' || value.trim() === '') {
      fault(parts, `must be a path inside the config folder, such as ${example}`)
      return null
    }
    if (path.isAbsolute(value)) {
      fault(parts, `must be relative to the config folder, such as ${example}`)
      return null
    }
    const clean = path.posix.normalize(value).replace(/\/+$/, '')
    if (clean === '.' || clean === '..' || clean.startsWith('../')) {
      fault(parts, `must name something inside the config folder, such as ${example}`)
      return null
    }
    let real
    try {
      real = fs.realpathSync(path.join(configDir, clean))
    } catch {
      fault(parts, `names ${clean}, which isn't in the config folder`)
      return null
    }
    if (!isInside(configReal, real) || real === configReal) {
      fault(parts, `names ${clean}, which leads outside the config folder`)
      return null
    }
    return { path: clean, real }
  }

  // A skill's folder holds only files and folders, and a `SKILL.md`. The runner copies it for each
  // run, and pi sees nothing else of the config. Returns whether it does.
  function checkSkillFolder(parts, { path: clean, real }) {
    if (!fs.statSync(real).isDirectory()) {
      fault(parts, `names ${clean}, which isn't a folder`)
      return false
    }
    const skillFile = path.join(real, 'SKILL.md')
    if (!fs.existsSync(skillFile) || !fs.lstatSync(skillFile).isFile()) {
      fault(parts, `names ${clean}, which has no SKILL.md`)
      return false
    }
    for (const entry of fs.readdirSync(real, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() || entry.isDirectory()) continue
      const inside = path.relative(real, path.join(entry.parentPath, entry.name))
      fault(parts, `names ${clean}, which holds ${inside}: a skill's folder holds only files and folders`)
      return false
    }
    let text
    try {
      text = fs.readFileSync(skillFile, 'utf8')
    } catch (error) {
      // As a fault that names the field, with the others.
      fault(parts, `names ${clean}, whose SKILL.md can't be read (${error.code ?? error.name})`)
      return false
    }
    const problem = skillFileProblem(text, path.posix.basename(clean))
    if (problem !== null) {
      fault(parts, `names ${clean}, whose SKILL.md ${problem}`)
      return false
    }
    return true
  }

  function oneOf(parts, value, options) {
    if (options.includes(value)) return value
    fault(parts, `must be ${list(options)}`)
    return null
  }

  // A list of paths in the data folder, each cleaned (`dataPath`), none twice, and none in a file
  // another names, which holds nothing. Returns the list, with null in the place of a fault.
  function dataPaths(parts, value, example) {
    if (!Array.isArray(value)) {
      fault(parts, `must be a list of paths in the data folder, such as [${example}]`)
      return []
    }
    const found = []
    value.forEach((item, n) => {
      const entry = dataPath(item)
      const twice = entry === null ? -1 : found.findIndex(other => other !== null && bare(other) === bare(entry))
      const long = entry === null ? undefined : bare(entry).split('/').find(part => Buffer.byteLength(part) > NAME_MAX_BYTES)
      const tooDeep = entry !== null && dataDir !== null && Buffer.byteLength(path.join(dataDir, entry)) > PATH_MAX_BYTES
      if (entry === null) fault([...parts, n], `must be a path in the data folder, such as ${example}: relative to it, without a ., .. or empty part, and a folder ending in /`)
      else if (twice !== -1) fault([...parts, n], `is ${entry}, which ${parts.at(-1)}[${twice}] names too`)
      else if (long !== undefined) fault([...parts, n], `has a name of ${Buffer.byteLength(long)} bytes, where a file system takes ${NAME_MAX_BYTES} at most`)
      else if (tooDeep) fault([...parts, n], `makes, in the data folder, a path of more than ${PATH_MAX_BYTES} bytes, which the system doesn't take`)
      found.push(entry === null || twice !== -1 || long !== undefined || tooDeep ? null : entry)
    })
    found.forEach((entry, n) => {
      const file = entry === null ? undefined : found.find(other => other !== null && !isFolder(other) && bare(entry).startsWith(`${other}/`))
      if (file === undefined) return
      fault([...parts, n], `is ${entry}, which lies in ${file}, a file`)
      found[n] = null
    })
    return found
  }

  // A list of channels, each once: one at least, or, with `empty`, none at all.
  function channelList(parts, value, { empty = false } = {}) {
    const valid = Array.isArray(value) && (empty || value.length > 0) && value.every(source => SOURCES.includes(source)) && new Set(value).size === value.length
    if (!valid) fault(parts, `must list ${list(SOURCES)}, or both, once each${empty ? ', or be [] for none' : ''}`)
    return valid ? [...value] : []
  }

  function nonEmptyString(parts, value, what) {
    if (typeof value === 'string' && value.trim() !== '') return value
    fault(parts, `must be ${what}`)
    return null
  }

  function agentOf(name, raw) {
    const at = (...rest) => ['agents', name, ...rest]
    if (!isObject(raw)) {
      fault(at(), 'must be a map of the agent\'s settings')
      return null
    }
    for (const key of Object.keys(raw)) {
      if (!AGENT_KEYS.includes(key)) fault(at(key), 'is not a setting of an agent')
    }
    for (const key of AGENT_KEYS) {
      if (!OPTIONAL_KEYS.includes(key) && raw[key] === undefined) fault(at(key), 'is missing')
    }

    const agent = { name }

    if (raw.model !== undefined) {
      if (typeof raw.model !== 'string' || !MODEL_ID.test(raw.model)) {
        fault(at('model'), 'must be an OpenRouter model ID, such as anthropic/claude-sonnet-5.5')
      } else if (raw.model.endsWith(':online')) {
        fault(at('model'), 'must not be an :online model, which has OpenRouter search the web; the network policy refuses it (6.13)')
      }
      agent.model = raw.model
    }
    agent.thinking = raw.thinking === undefined ? null : oneOf(at('thinking'), raw.thinking, THINKING_LEVELS)

    if (raw.prompt !== undefined) {
      const found = configPath(at('prompt'), raw.prompt, 'prompts/lifelog.md')
      if (found && !fs.statSync(found.real).isFile()) fault(at('prompt'), `names ${found.path}, which isn't a file`)
      agent.prompt = found ? { path: found.path, file: found.real } : null
    }

    agent.skills = []
    const positions = new Map()
    if (raw.skills !== undefined) {
      if (!Array.isArray(raw.skills)) fault(at('skills'), 'must be a list of skill folders, such as [skills/expenses]')
      else {
        const names = new Map()
        raw.skills.forEach((value, n) => {
          const found = configPath(at('skills', n), value, 'skills/expenses')
          if (!found || !checkSkillFolder(at('skills', n), found)) return
          const skillName = path.posix.basename(found.path)
          if (names.has(skillName)) {
            fault(at('skills', n), `names a skill called ${skillName}, as skills[${names.get(skillName)}] does: each skill's folder needs a name of its own`)
            return
          }
          names.set(skillName, n)
          agent.skills.push({ name: skillName, path: found.path, dir: found.real })
          positions.set(found.path, n)
        })
      }
    }

    // Each is copied into `run/config/` at its own path, so none may lie inside a skill's
    // folder: the copies would overlap, and every run would fail.
    const within = (folder, inner) => inner.startsWith(`${folder}/`)
    for (const skill of agent.skills) {
      const outer = agent.skills.find(other => other !== skill && within(other.path, skill.path))
      if (outer) fault(at('skills', positions.get(skill.path)), `names ${skill.path}, which is inside the skill ${outer.path}: skills can't hold each other`)
    }
    if (agent.prompt) {
      const outer = agent.skills.find(skill => within(skill.path, agent.prompt.path))
      if (outer) fault(at('prompt'), `names ${agent.prompt.path}, which is inside the skill ${outer.path}: the prompt is a file of its own`)
    }

    // What the agent's VM sees, and what it may change. No list limits what they may name: a
    // mistake there is the owner's. The owner, on 2026-11-21: "I understand that the user can
    // make mistakes and give write permission to `datastore`. But that is their problem, not
    // system's problem". What the runner keeps for itself in the agent's folder is the exception.
    agent.reads = raw.reads === undefined ? ['datastore/', `agents/${name}/`] : dataPaths(at('reads'), raw.reads, 'datastore/').filter(Boolean)
    const writes = raw.writes === undefined ? [] : dataPaths(at('writes'), raw.writes, `agents/${name}/views/`)
    const own = `agents/${name}`
    writes.forEach((write, n) => {
      if (write === null) return
      const where = at('writes', n)
      // The folder itself, or one that holds it, as a file or a folder: as a file it could still
      // be moved, with everything in it.
      if (bare(write) === own || own.startsWith(`${bare(write)}/`)) {
        fault(where, `is ${write}, which holds ${own}/, the agent's folder, where the runner keeps its state, its repository, run/ and the sessions: name what the agent may write in it, such as ${own}/views/`)
        return
      }
      if (bare(write) === DISCARDED || write.startsWith(`${DISCARDED}/`)) {
        fault(where, `is ${write}, which the agent can't write: the runner sets aside there what a clean-up throws away, and removes it`)
        return
      }
      if (!write.startsWith(`${own}/`)) return
      const parts = bare(write).slice(own.length + 1).split('/')
      if (RUNNER_NAMES.includes(parts[0]) || parts.some(part => part.startsWith('.'))) {
        fault(where, `is ${write}, which the agent can't write: in its folder the runner keeps state.json, run/, sessions/ and its repository's .git, and the commit refuses a name that starts with a dot`)
      }
    })
    agent.writes = writes.filter(Boolean)
    agent.repository = repositoryPaths(name, agent.writes)

    if (raw.sends !== undefined) agent.sends = channelList(at('sends'), raw.sends, { empty: true })
    if (raw.session !== undefined) agent.session = oneOf(at('session'), raw.session, SESSIONS)
    if (raw.reply_mode !== undefined) agent.replyMode = oneOf(at('reply_mode'), raw.reply_mode, REPLY_MODES)

    if (raw.ack_reaction !== undefined) {
      // One emoji, as WhatsApp takes a reaction, or "" for none: one grapheme, holding a pictograph
      // (`✅`, `👍🏽`, `❤️`), a flag's two regional indicators, or a keycap (`1️⃣`).
      const value = raw.ack_reaction
      const graphemes = typeof value === 'string' ? [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length : -1
      const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[#*0-9]️?⃣$/u
      if (value !== '' && (graphemes !== 1 || /[\s\p{Cc}]/u.test(value) || !emoji.test(value))) {
        fault(at('ack_reaction'), 'must be one emoji, such as "✅", or "" for none')
      }
      agent.ackReaction = value
    }
    if (raw.timeout_minutes !== undefined) {
      const [lowest, highest] = limits.CONFIG_RANGES.timeout_minutes
      const value = raw.timeout_minutes
      if (!Number.isSafeInteger(value) || value < lowest || value > highest) {
        fault(at('timeout_minutes'), `must be a whole number of minutes from ${lowest} to ${highest}`)
      }
      agent.timeoutMinutes = value
    }

    agent.run = { newMessages: [], scheduled: [], backfill: [] }
    if (raw.run !== undefined) {
      if (!Array.isArray(raw.run)) fault(at('run'), 'must be a list of when the agent runs, such as [{on: new-messages, channels: [whatsapp]}]')
      else raw.run.forEach((entry, n) => triggerOf(agent, at('run', n), entry))
    }
    agent.channels = agent.run.newMessages.flatMap(trigger => trigger.channels)
    return agent
  }

  function triggerOf(agent, parts, entry) {
    if (!isObject(entry)) return fault(parts, `must be a map with one of ${list(TRIGGER_KINDS)}`)
    const kinds = TRIGGER_KINDS.filter(kind => entry[kind] !== undefined)
    if (kinds.length !== 1) return fault(parts, `must have exactly one of ${list(TRIGGER_KINDS)}`)
    const [kind] = kinds
    for (const key of Object.keys(entry)) {
      if (!TRIGGER_KEYS[kind].includes(key)) fault([...parts, key], `doesn't belong with ${kind}`)
    }
    for (const key of TRIGGER_KEYS[kind]) {
      if (entry[key] === undefined) fault([...parts, key], 'is missing')
    }
    const { run } = agent

    if (kind === 'on') {
      if (entry.on !== 'new-messages') return fault([...parts, 'on'], 'must be new-messages')
      if (entry.channels === undefined) return
      const channels = channelList([...parts, 'channels'], entry.channels)
      // A channel starts the runs of one trigger at most, so a line pending from it says which.
      for (const channel of channels) {
        const other = run.newMessages.find(trigger => trigger.channels.includes(channel))
        if (other) return fault([...parts, 'channels'], `names ${channel}, which ${fieldName(fieldOf.get(other))}.channels names too: a channel starts the runs of one trigger at most`)
      }
      if (channels.length === 0) return
      const trigger = { channels }
      fieldOf.set(trigger, parts)
      run.newMessages.push(trigger)
      return
    }

    if (kind === 'at') {
      const task = nonEmptyString([...parts, 'task'], entry.task, 'the task, as text')
      const schedule = typeof entry.at === 'string' ? parseLocalTime(entry.at) : null
      if (!schedule) return fault([...parts, 'at'], 'must be a time as "HH:MM", or a weekday and a time as "Sun 18:00"')
      // The `at` values are the keys of the state's `scheduled`.
      if (run.scheduled.some(other => other.at === entry.at)) return fault([...parts, 'at'], `is ${entry.at}, which another entry has too`)
      if (task !== null) run.scheduled.push({ at: entry.at, schedule, task })
      return
    }

    // A backfill.
    const id = entry.backfill
    if (typeof id !== 'string' || !BACKFILL_ID.test(id)) {
      return fault([...parts, 'backfill'], 'must be an ID of lowercase letters, digits and hyphens, such as people-1')
    }
    if (run.backfill.some(other => other.id === id)) return fault([...parts, 'backfill'], `is ${id}, which another backfill entry has too`)
    let ok = true
    if (entry.skill !== undefined && !agent.skills.some(skill => skill.name === entry.skill)) {
      fault([...parts, 'skill'], "must name one of the agent's skills, by its folder's name, such as people")
      ok = false
    }
    // What the backfill may change, which narrows what the agent may: each path in the agent's own
    // `writes`, as the sandbox enforces for its runs.
    let writes = []
    if (entry.writes !== undefined) {
      const example = `agents/${agent.name}/views/people.csv`
      if (!Array.isArray(entry.writes) || entry.writes.length === 0) {
        fault([...parts, 'writes'], `must be a list of what the backfill may change, such as [${example}]`)
        ok = false
      } else {
        writes = dataPaths([...parts, 'writes'], entry.writes, example)
        writes.forEach((write, n) => {
          if (write === null) ok = false
          else if (!agent.writes.some(own => isWithin(write, own))) {
            fault([...parts, 'writes', n], `is ${write}, which isn't in the agent's writes: a backfill may change only what the agent may`)
            ok = false
          }
        })
      }
    }
    if (ok && entry.skill !== undefined && entry.writes !== undefined) run.backfill.push({ id, skill: entry.skill, writes })
  }

  if (!isObject(top)) {
    fault(['agents'], 'is missing: the file holds a map with agents in it')
    throw new ConfigError(problems)
  }
  for (const key of Object.keys(top)) {
    if (key !== 'agents') fault([key], 'is not a setting of agents.yaml')
  }
  const agents = []
  if (!isObject(top.agents)) {
    fault(['agents'], 'must be a map of agents by name, such as lifelog')
  } else {
    const names = Object.keys(top.agents)
    if (names.length !== 1) fault(['agents'], `must hold exactly one agent in this version; it holds ${names.length}`)
    for (const name of names) {
      if (!AGENT_NAME.test(name)) {
        fault(['agents', name], 'is not a name for an agent: lowercase letters, digits and hyphens, starting with a letter')
        continue
      }
      // An entry is the runner's or the bridge's own by its `by`, which goes out whatever `sends`
      // says, so an agent can't take either name.
      if (OWN_AUTHORS.includes(name)) {
        fault(['agents', name], `is not a name for an agent: ${list(OWN_AUTHORS)} is the name of Scooter's own messages`)
        continue
      }
      const agent = agentOf(name, top.agents[name])
      if (agent) agents.push(agent)
    }
  }
  if (problems.length > 0) throw new ConfigError(problems)
  return { agents }
}

// What pi 1.5.2 takes as a skill's `name` and `description`: the limits of the Agent Skills format,
// which pi checks, and warns of. They are pi's, not Scooter's tuning numbers.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX_CHARS = 64
const SKILL_DESCRIPTION_MAX_CHARS = 1024

// What is wrong with a skill's `SKILL.md`, as words that follow "whose SKILL.md", or null. Its
// frontmatter, read as pi reads it (`---`, YAML, then a line starting `---`), must give `name`, the
// skill folder's own name, and a `description`. pi offers the model a skill by its name and
// description, and leaves out one whose description is missing or whose frontmatter isn't YAML;
// and the runner, the prompt and a backfill name a skill by its folder. pi also leaves out of
// what it offers the model a skill with `disable-model-invocation: true`.
export function skillFileProblem(text, folderName) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const end = normalized.startsWith('---') ? normalized.indexOf('\n---', 3) : -1
  if (end === -1) return 'has no frontmatter: it must start with a block between two --- lines that gives the name and the description'
  const doc = parseDocument(normalized.slice(4, end), { version: '1.2', schema: 'core', uniqueKeys: true })
  const [error] = [...doc.errors, ...doc.warnings]
  if (error) return `has frontmatter that isn't YAML: ${error.message.split('\n')[0]}`
  const front = doc.toJS({ maxAliasCount: 100 })
  if (!isObject(front)) return 'has frontmatter that is no map of name and description'
  const { description } = front
  // A name of digits only is a number to YAML: pi then takes the folder's name, so the check
  // takes it as written.
  const name = typeof front.name === 'number' ? String(front.name) : front.name
  if (name === undefined) return `has no name: it must be ${folderName}, the folder's name`
  if (name !== folderName) return `gives the name ${JSON.stringify(name)}: it must be ${folderName}, the folder's name`
  if (name.length > SKILL_NAME_MAX_CHARS || !SKILL_NAME.test(name)) {
    return `gives the name ${name}, which pi doesn't take: at most ${SKILL_NAME_MAX_CHARS} lowercase letters, digits and single hyphens between them, which the folder's name must be too`
  }
  if (typeof description !== 'string' || description.trim() === '') return "has no description, which says when to use the skill: pi doesn't load a skill without one"
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    return `has a description of ${description.length} characters, where the Agent Skills format allows ${SKILL_DESCRIPTION_MAX_CHARS}, and pi warns of more`
  }
  if (front['disable-model-invocation'] === true) return "says disable-model-invocation: true, so pi wouldn't offer it to the model: remove that line"
  return null
}

// Reads and checks `agents.yaml` from the config folder. Throws a `ConfigError` that lists every
// fault, also when the file can't be read.
export function loadConfig({ paths }) {
  let text
  try {
    text = fs.readFileSync(paths.agentsYaml, 'utf8')
  } catch (error) {
    throw new ConfigError([{ field: null, line: null, message: `${paths.agentsYaml} can't be read (${error.code ?? error.name})` }])
  }
  return parseConfig(text, { configDir: paths.configDir, dataDir: paths.dataDir, file: paths.agentsYaml })
}
