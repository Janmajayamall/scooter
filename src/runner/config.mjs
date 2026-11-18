// The agents' configuration, `agents.yaml` (6.1 of DESIGN.md).
//
// The runner reads it at startup and refuses to start on any fault. Every fault is reported at once,
// each naming the field and the line it is on. This is the only module that imports `yaml`.
//
//   agents:
//     lifelog:
//       model: anthropic/claude-sonnet-5.5
//       thinking: low                        # optional
//       prompt: prompts/lifelog.md           # paths are relative to the config folder
//       skills: [skills/expenses, skills/day-pages]
//       reads: [whatsapp, email]
//       session: daily                       # daily or none
//       reply_mode: quiet                    # quiet or confirm
//       ack_reaction: "✅"                   # "" for none
//       can_message: true
//       timeout_minutes: 10
//       run:
//         - on: new-messages
//         - at: "21:30"                      # or "Sun 18:00"
//           task: Evening check-in.
//         - once: poems
//           task: Write poems for my earlier images captioned "poem".
//         - backfill: people-1
//           skill: people
//           writes: [views/people.csv]
//
// Every field is required except `thinking`. A key the format doesn't have is a fault, so that a
// misspelled one isn't ignored without a word.

import fs from 'node:fs'
import path from 'node:path'
import { LineCounter, parseDocument } from 'yaml'
import { SOURCES } from '../common/datastore/line.mjs'
import { limits } from '../common/limits.mjs'
import { parseLocalTime } from '../common/time.mjs'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
export const SESSIONS = ['daily', 'none']
export const REPLY_MODES = ['quiet', 'confirm']
export const TRIGGER_KINDS = ['on', 'at', 'once', 'backfill']
// The skill that writes the day pages. A backfill always may change them, so it can't be one.
export const DAY_PAGES_SKILL = 'day-pages'

const AGENT_NAME = /^[a-z][a-z0-9-]*$/
// The IDs of `once` tasks and backfills go into session names, commit messages and the state.
const TASK_ID = /^[a-z0-9][a-z0-9-]*$/
// An OpenRouter model ID, such as `anthropic/claude-sonnet-5.5`, `~anthropic/claude-sonnet-latest`
// or `google/gemma-3-4b-it:free`. Every model in pi's catalog has this form (milestone 0, pi 6).
const MODEL_ID = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/

const AGENT_KEYS = ['model', 'thinking', 'prompt', 'skills', 'reads', 'session', 'reply_mode', 'ack_reaction', 'can_message', 'timeout_minutes', 'run']
const TRIGGER_KEYS = { on: ['on'], at: ['at', 'task'], once: ['once', 'task'], backfill: ['backfill', 'skill', 'writes'] }

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value)

function list(names) {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
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
// to, and `file` names the file in messages. Returns the configuration:
//
//   { agents: [agent] }
//
// where each agent is
//
//   { name, model, thinking, prompt: { path, file }, skills: [{ name, path, dir }], reads,
//     session, replyMode, ackReaction, canMessage, timeoutMinutes,
//     run: { newMessages, scheduled: [{ at, schedule, task }], once: [{ id, task }],
//            backfill: [{ id, skill, writes }] } }
//
// `thinking` is null when it isn't given. A path is kept as written, cleaned (`path`), and as the
// file or folder it names (`file`, `dir`). A skill's `name` is its folder's name. `schedule` is
// what `parseLocalTime` returns. Throws a `ConfigError` that lists every fault.
export function parseConfig(text, { configDir, file = 'agents.yaml' }) {
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
  // run, and pi sees nothing else of the config (8.5). Returns whether it does.
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
      // As a fault that names the field, with the others (the review of milestone 11, point 4).
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
      if (key !== 'thinking' && raw[key] === undefined) fault(at(key), 'is missing')
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

    // Each is copied into `run/config/` at its own path (8.5), so none may lie inside a skill's
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

    if (raw.reads !== undefined) {
      const valid =
        Array.isArray(raw.reads) && raw.reads.length > 0 && raw.reads.every(source => SOURCES.includes(source)) && new Set(raw.reads).size === raw.reads.length
      if (!valid) fault(at('reads'), `must list ${list(SOURCES)}, or both, once each`)
      agent.reads = valid ? [...raw.reads] : []
    }
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
    if (raw.can_message !== undefined) {
      if (typeof raw.can_message !== 'boolean') fault(at('can_message'), 'must be true or false')
      agent.canMessage = raw.can_message
    }
    if (raw.timeout_minutes !== undefined) {
      const [lowest, highest] = limits.CONFIG_RANGES.timeout_minutes
      const value = raw.timeout_minutes
      if (!Number.isSafeInteger(value) || value < lowest || value > highest) {
        fault(at('timeout_minutes'), `must be a whole number of minutes from ${lowest} to ${highest}`)
      }
      agent.timeoutMinutes = value
    }

    agent.run = { newMessages: false, scheduled: [], once: [], backfill: [] }
    if (raw.run !== undefined) {
      if (!Array.isArray(raw.run)) fault(at('run'), 'must be a list of when the agent runs, such as [{on: new-messages}]')
      else raw.run.forEach((entry, n) => triggerOf(agent, at('run', n), entry))
    }
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
      if (run.newMessages) return fault([...parts, 'on'], 'is given twice')
      run.newMessages = true
      return
    }

    const task = kind === 'at' || kind === 'once' ? nonEmptyString([...parts, 'task'], entry.task, 'the task, as text') : null

    if (kind === 'at') {
      const schedule = typeof entry.at === 'string' ? parseLocalTime(entry.at) : null
      if (!schedule) return fault([...parts, 'at'], 'must be a time as "HH:MM", or a weekday and a time as "Sun 18:00"')
      // The `at` values are the keys of the state's `scheduled`.
      if (run.scheduled.some(other => other.at === entry.at)) return fault([...parts, 'at'], `is ${entry.at}, which another entry has too`)
      if (task !== null) run.scheduled.push({ at: entry.at, schedule, task })
      return
    }

    const id = entry[kind]
    if (typeof id !== 'string' || !TASK_ID.test(id)) {
      return fault([...parts, kind], 'must be an ID of lowercase letters, digits and hyphens, such as people-1')
    }
    if (kind === 'once') {
      if (run.once.some(other => other.id === id)) return fault([...parts, 'once'], `is ${id}, which another once entry has too`)
      if (task !== null) run.once.push({ id, task })
      return
    }

    // A backfill (6.11).
    if (run.backfill.some(other => other.id === id)) return fault([...parts, 'backfill'], `is ${id}, which another backfill entry has too`)
    let ok = true
    if (entry.skill === DAY_PAGES_SKILL) {
      fault([...parts, 'skill'], `can't be ${DAY_PAGES_SKILL}: a backfill fills one other view, and may change the day pages anyway`)
      ok = false
    } else if (entry.skill !== undefined && !agent.skills.some(skill => skill.name === entry.skill)) {
      fault([...parts, 'skill'], "must name one of the agent's skills, by its folder's name, such as people")
      ok = false
    }
    const writes = []
    if (entry.writes !== undefined) {
      if (!Array.isArray(entry.writes) || entry.writes.length === 0) {
        fault([...parts, 'writes'], 'must be a list of what the backfill may change, such as [views/people.csv]')
        ok = false
      } else {
        entry.writes.forEach((value, n) => {
          const write = viewPath(value)
          if (write === null) {
            fault([...parts, 'writes', n], 'must be a file, or a folder ending in /, inside views/ and outside views/days/')
            ok = false
          } else if (writes.includes(write)) {
            fault([...parts, 'writes', n], `is ${write}, which is listed twice`)
            ok = false
          } else {
            writes.push(write)
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
      const agent = agentOf(name, top.agents[name])
      if (agent) agents.push(agent)
    }
  }
  if (problems.length > 0) throw new ConfigError(problems)
  return { agents }
}

// A path a backfill may change: a file, or a folder ending in `/`, inside `views/` and outside
// `views/days/` (6.1). Returns it cleaned, or null when it isn't one.
function viewPath(value) {
  if (typeof value !== 'string' || value.includes('\\')) return null
  const folder = value.endsWith('/')
  const parts = value.split('/').slice(0, folder ? -1 : undefined)
  if (parts.length < 2 || parts[0] !== 'views' || parts[1] === 'days') return null
  // No `.`, `..` or empty parts, and no name the file check would refuse (6.8).
  if (parts.some(part => part === '' || part.startsWith('.'))) return null
  return `${parts.join('/')}${folder ? '/' : ''}`
}

// What pi 1.5.2 takes as a skill's `name` and `description`: the limits of the Agent Skills format,
// which pi checks, and warns of. They are pi's, not Scooter's tuning numbers.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_NAME_MAX_CHARS = 64
const SKILL_DESCRIPTION_MAX_CHARS = 1024

// What is wrong with a skill's `SKILL.md`, as words that follow "whose SKILL.md", or null. Its
// frontmatter, read as pi reads it (`---`, YAML, then a line starting `---`), must give `name`, the
// skill folder's own name, and a `description` (7.3). pi offers the model a skill by its name and
// description, and leaves out one whose description is missing or whose frontmatter isn't YAML;
// and the runner, the prompt and a backfill name a skill by its folder (D197). pi also leaves out of
// what it offers the model a skill with `disable-model-invocation: true` (D208).
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
  // takes it as written (D208).
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
  return parseConfig(text, { configDir: paths.configDir, file: paths.agentsYaml })
}
