// Settings: one env file per service, read and checked (8.2 of DESIGN.md).
//
// The bridge reads `bridge.env` and the runner `runner.env`, each with only what its service
// needs, so neither holds the other's secrets. A variable already in the environment wins over
// the file. `loadSettings` returns the checked values and never changes the environment, so a
// program the service starts gets only what it is handed.
//
// The env file format is the part that Scooter's loader, systemd's `EnvironmentFile` and Compose's
// `env_file` all read the same way:
//
//   # a comment, on a line of its own
//   KEY=value
//   KEY='a value with $, \, # or a quote in it'
//
// No variable expansion, no double quotes, no `export`, no value over several lines. A line the
// three would read differently is an error, not a guess. A value can't contain a single quote.

import fs from 'node:fs'
import path from 'node:path'
import { SOURCES } from './datastore/line.mjs'
import { limits } from './limits.mjs'
import { isTimeZone, parseLocalTime } from './time.mjs'

// Where the env files are, unless `SCOOTER_ENV_DIR` says otherwise.
export const DEFAULT_ENV_DIR = '/etc/scooter'
export const ENV_DIR_VARIABLE = 'SCOOTER_ENV_DIR'

// Every variable of each service (8.2). A variable in an env file that isn't in its service's
// list is an error: a misspelled name would otherwise be ignored without a word, and a key in
// the wrong file would sit where the other service can read it.
const VARIABLES = {
  bridge: [
    'OWNER_NUMBER',
    'OWNER_JIDS',
    'DEFAULT_CHANNEL',
    'EMAIL_IMAP_HOST',
    'EMAIL_IMAP_PORT',
    'EMAIL_USER',
    'EMAIL_PASSWORD',
    'EMAIL_OWNER_ADDRESSES',
    'EMAIL_AUTHSERV_ID',
    'EMAIL_CHECK_SECONDS',
    'SCOOTER_TZ',
    'BACKUP_TIME',
    'RESTIC_REPOSITORY',
    'RESTIC_PASSWORD',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_DEFAULT_REGION',
    'B2_ACCOUNT_ID',
    'B2_ACCOUNT_KEY',
    'RESTIC_KEEP_DAILY',
    'RESTIC_KEEP_WEEKLY',
    'RESTIC_KEEP_MONTHLY',
    'DATA_DIR',
    'CONFIG_DIR',
  ],
  runner: [
    'OPENROUTER_API_KEY',
    'OPENROUTER_ZDR',
    'SCOOTER_TZ',
    'HOME_CURRENCY',
    'BATCH_SECONDS',
    'SESSION_ROLLOVER_HOUR',
    'AGENT_INTERNET',
    'AGENT_ACCEL',
    'DATA_DIR',
    'CONFIG_DIR',
  ],
}

export const SIDES = Object.keys(VARIABLES)

// The names of a service's variables.
export function variablesOf(side) {
  if (!Object.hasOwn(VARIABLES, side)) throw new Error(`no such side: ${side}`)
  return [...VARIABLES[side]]
}

// What is wrong with a service's settings. `problems` lists every fault found, each as
// `{ variable, message }`, where the message names the variable. No message repeats a value,
// because a value may be a secret.
export class SettingsError extends Error {
  constructor(problems) {
    super(problems.map(problem => problem.message).join('\n'))
    this.name = 'SettingsError'
    this.problems = problems
  }
}

// ---------------------------------------------------------------------------------------------
// The env file

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const QUOTED = /^'([^']*)'[ \t]*$/
const NEEDS_QUOTES = /[$\\'"#]/

// Reads the text of an env file. Returns `{ values, problems }`: a Map from name to value, and
// what's wrong, each as `{ line, variable, message }`. `variable` is null when the line names none.
export function parseEnvFile(text) {
  const values = new Map()
  const problems = []
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, '')
    const fault = (variable, message) => problems.push({ line: n + 1, variable, message })
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    const assignment = ASSIGNMENT.exec(line)
    if (!assignment) {
      fault(null, 'expected KEY=value, with nothing before the name and no space around the "="')
      continue
    }
    const [, name, raw] = assignment
    let value
    if (raw.startsWith("'")) {
      const quoted = QUOTED.exec(raw)
      if (!quoted) {
        fault(name, `${name}: a quoted value starts and ends with a single quote, on one line, and can't contain one`)
        continue
      }
      value = quoted[1]
    } else {
      value = raw.trim()
      if (NEEDS_QUOTES.test(value)) {
        fault(name, `${name}: a value with $, \\, # or a quote in it must be inside single quotes`)
        continue
      }
    }
    if (values.has(name)) {
      fault(name, `${name} is set twice`)
      continue
    }
    values.set(name, value)
  }
  return { values, problems }
}

// ---------------------------------------------------------------------------------------------
// Loading and checking

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
const EMAIL_ADDRESS = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/
const JID = /^[^\s@,]+@[^\s@,]+$/

function otherSide(side) {
  return side === 'bridge' ? 'runner' : 'bridge'
}

function readEnvFile(side, envDir, problems) {
  const file = path.join(envDir, `${side}.env`)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    problems.push({ variable: null, message: `${file} can't be read (${error.code ?? error.name})` })
    return new Map()
  }
  const parsed = parseEnvFile(text)
  for (const { line, variable, message } of parsed.problems) {
    problems.push({ variable, message: `${file}, line ${line}: ${message}` })
  }
  for (const name of parsed.values.keys()) {
    if (VARIABLES[side].includes(name)) continue
    const elsewhere = VARIABLES[otherSide(side)].includes(name) ? `; it belongs in ${otherSide(side)}.env` : ''
    problems.push({ variable: name, message: `${file}: ${name} isn't one of the ${side}'s settings${elsewhere}` })
    parsed.values.delete(name)
  }
  return parsed.values
}

function list(names) {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

// Loads and checks the settings of one side, `bridge` or `runner`. `env` is the environment to
// read, the process's own by default. Throws a `SettingsError` that lists every fault.
export function loadSettings(side, { env = process.env } = {}) {
  if (!Object.hasOwn(VARIABLES, side)) throw new Error(`no such side: ${side}`)
  const problems = []
  const envDir = env[ENV_DIR_VARIABLE] || DEFAULT_ENV_DIR
  const fromFile = readEnvFile(side, envDir, problems)

  // A variable's value: the environment's if it is set there, else the file's. Empty means unset.
  // The value is taken as it is, since a password may begin or end with a space.
  const get = name => {
    const value = env[name] !== undefined ? env[name] : fromFile.get(name)
    return value === undefined || value.trim() === '' ? undefined : value
  }
  const fault = (variable, message) => {
    problems.push({ variable, message })
    return undefined
  }
  const required = (name, why = '') => get(name) ?? fault(name, `${name} is required${why}`)
  const oneOf = (name, options, fallback) => {
    const value = get(name) ?? fallback
    return options.includes(value) ? value : fault(name, `${name} must be ${list(options)}`)
  }
  const onOff = (name, fallback) => {
    const value = oneOf(name, ['on', 'off'], fallback)
    return value === undefined ? undefined : value === 'on'
  }
  const integer = (name, fallback) => {
    const [lowest, highest] = limits.SETTING_RANGES[name]
    const value = get(name)
    if (value === undefined) return fallback
    const number = /^\d+$/.test(value) ? Number(value) : NaN
    if (number >= lowest && number <= highest) return number
    return fault(name, `${name} must be a whole number from ${lowest} to ${highest}`)
  }
  const commaList = (name, pattern, what) => {
    const items = (get(name) ?? '').split(',').map(item => item.trim()).filter(Boolean)
    if (items.every(item => pattern.test(item))) return items
    return fault(name, `${name} must be ${what}, separated by commas`)
  }
  const folder = (name, fallback) => {
    const value = get(name) ?? fallback
    return path.isAbsolute(value) ? path.resolve(value) : fault(name, `${name} must be an absolute path`)
  }
  const timeZone = () => {
    const value = get('SCOOTER_TZ') ?? 'Asia/Kolkata'
    return isTimeZone(value) ? value : fault('SCOOTER_TZ', 'SCOOTER_TZ must be an IANA time zone, such as Asia/Kolkata')
  }

  const settings = {
    side,
    dataDir: folder('DATA_DIR', '/data'),
    configDir: folder('CONFIG_DIR', '/config'),
    timeZone: timeZone(),
  }

  if (side === 'bridge') {
    const number = required('OWNER_NUMBER')
    if (number !== undefined) {
      const digits = number.replace(/[\s()-]/g, '').replace(/^\+/, '')
      settings.ownerNumber = /^[1-9]\d{6,14}$/.test(digits)
        ? digits
        : fault('OWNER_NUMBER', 'OWNER_NUMBER must be a phone number in international format, such as +919812345678')
    }
    settings.ownerJids = commaList('OWNER_JIDS', JID, 'WhatsApp IDs such as 123456789@lid')
    // It must name a channel. Whether that channel can send, which in v2 only WhatsApp can, is
    // checked by the bridge when it starts, where the channels are (5.3).
    settings.defaultChannel = oneOf('DEFAULT_CHANNEL', SOURCES, 'whatsapp')

    // Email is on when EMAIL_IMAP_HOST is set (5.6). Off, the other mailbox settings aren't read.
    const host = get('EMAIL_IMAP_HOST')
    settings.email = null
    if (host !== undefined) {
      const forEmail = ' when EMAIL_IMAP_HOST is set'
      const addresses = commaList('EMAIL_OWNER_ADDRESSES', EMAIL_ADDRESS, 'email addresses')
      if (addresses?.length === 0) fault('EMAIL_OWNER_ADDRESSES', `EMAIL_OWNER_ADDRESSES is required${forEmail}`)
      const authservId = required('EMAIL_AUTHSERV_ID', forEmail)
      settings.email = {
        host: HOSTNAME.test(host) ? host : fault('EMAIL_IMAP_HOST', 'EMAIL_IMAP_HOST must be a host name, such as imap.gmail.com'),
        port: integer('EMAIL_IMAP_PORT', 993),
        user: required('EMAIL_USER', forEmail),
        password: required('EMAIL_PASSWORD', forEmail),
        ownerAddresses: addresses?.map(address => address.toLowerCase()),
        authservId:
          authservId === undefined || /^[^\s;]+$/.test(authservId)
            ? authservId
            : fault('EMAIL_AUTHSERV_ID', 'EMAIL_AUTHSERV_ID must be a server name, such as mx.google.com'),
        checkSeconds: integer('EMAIL_CHECK_SECONDS', 60),
      }
    }

    // `HH:MM` in the owner's time zone, or null for `off` (5.5).
    const backupTime = get('BACKUP_TIME') ?? '03:30'
    const parsedTime = parseLocalTime(backupTime)
    settings.backupTime =
      backupTime === 'off'
        ? null
        : parsedTime && parsedTime.weekday === null
          ? backupTime
          : fault('BACKUP_TIME', 'BACKUP_TIME must be a time as HH:MM, such as 03:30, or off')

    // Backups are on when RESTIC_REPOSITORY is set (5.5). `env` is what restic is given besides
    // the repository and the password.
    const repository = get('RESTIC_REPOSITORY')
    settings.backup = null
    if (repository !== undefined) {
      const resticEnv = { AWS_DEFAULT_REGION: get('AWS_DEFAULT_REGION') ?? 'auto' }
      for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY']) {
        if (get(name) !== undefined) resticEnv[name] = get(name)
      }
      settings.backup = {
        repository,
        password: required('RESTIC_PASSWORD', ' when RESTIC_REPOSITORY is set'),
        keepDaily: integer('RESTIC_KEEP_DAILY', 7),
        keepWeekly: integer('RESTIC_KEEP_WEEKLY', 4),
        keepMonthly: integer('RESTIC_KEEP_MONTHLY', 12),
        env: resticEnv,
      }
    }
  }

  if (side === 'runner') {
    const key = required('OPENROUTER_API_KEY')
    settings.openrouterApiKey =
      key === undefined || /^\S+$/.test(key) ? key : fault('OPENROUTER_API_KEY', "OPENROUTER_API_KEY can't contain spaces")
    settings.zdr = onOff('OPENROUTER_ZDR', 'on')
    const currency = get('HOME_CURRENCY') ?? 'INR'
    settings.homeCurrency = /^[A-Z]{3}$/.test(currency)
      ? currency
      : fault('HOME_CURRENCY', 'HOME_CURRENCY must be an ISO currency code of three capital letters, such as INR')
    settings.batchSeconds = integer('BATCH_SECONDS', 8)
    settings.sessionRolloverHour = integer('SESSION_ROLLOVER_HOUR', 4)
    settings.agentInternet = onOff('AGENT_INTERNET', 'off')
    // `hvf` is a known value, kept for macOS. On Linux the runner refuses it when it picks the
    // accelerator, as it does any forced accelerator that isn't there (6.6).
    settings.agentAccel = oneOf('AGENT_ACCEL', ['auto', 'kvm', 'emulation', 'hvf'], 'auto')
  }

  if (problems.length > 0) throw new SettingsError(problems)
  return settings
}
