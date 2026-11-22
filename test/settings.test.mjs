// Settings: one env file per service, the format the file has, and the checks
// on every variable. Errors name the variable.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { overrideLimits } from '../src/common/limits.mjs'
import { SettingsError, loadSettings, parseEnvFile, variablesOf } from '../src/common/settings.mjs'
import { isRoot } from './support/root.mjs'
import { makeTestDir } from './support/tmp.mjs'

// Writes the two env files of a test and returns the environment that points at them.
function envFiles(t, files) {
  const dir = makeTestDir(t)
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
  return { SCOOTER_ENV_DIR: dir }
}

// The faults `loadSettings` finds, as `{ variable: message }`.
function faults(side, env) {
  try {
    loadSettings(side, { env })
  } catch (error) {
    assert.ok(error instanceof SettingsError, error.stack)
    for (const problem of error.problems) {
      if (problem.variable !== null) assert.ok(problem.message.includes(problem.variable), problem.message)
    }
    return Object.fromEntries(error.problems.map(problem => [problem.variable, problem.message]))
  }
  return {}
}

const BRIDGE = { SCOOTER_ENV_DIR: '/nonexistent', OWNER_NUMBER: '+91 98123 45678' }
const RUNNER = { SCOOTER_ENV_DIR: '/nonexistent', OPENROUTER_API_KEY: 'sk-or-v1-test' }
const EMAIL = {
  EMAIL_IMAP_HOST: 'imap.gmail.com',
  EMAIL_USER: 'scooter@example.com',
  EMAIL_PASSWORD: 'app password',
  EMAIL_OWNER_ADDRESSES: 'Me@Example.com, me@work.example',
  EMAIL_AUTHSERV_ID: 'mx.google.com',
}

// ---------------------------------------------------------------------------------------------
// The env file format

test('settings: the env file format', () => {
  const { values, problems } = parseEnvFile(
    [
      '# a comment',
      '   # an indented comment',
      '',
      'OWNER_NUMBER=+919812345678',
      'OWNER_JIDS=123@lid, 456@lid',
      "EMAIL_PASSWORD='pa$$ w\\ord #1 \"quoted\"'",
      'EMAIL_IMAP_HOST=',
      "EMAIL_USER=''",
      'BACKUP_TIME=  03:30  ',
      "RESTIC_PASSWORD=' kept as it is '  ",
      'RESTIC_REPOSITORY=s3:https://account.r2.cloudflarestorage.com/bucket/scooter',
      'CRLF=yes\r',
    ].join('\n'),
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(Object.fromEntries(values), {
    OWNER_NUMBER: '+919812345678',
    OWNER_JIDS: '123@lid, 456@lid',
    // Inside single quotes nothing is special and nothing is expanded.
    EMAIL_PASSWORD: 'pa$$ w\\ord #1 "quoted"',
    EMAIL_IMAP_HOST: '',
    EMAIL_USER: '',
    BACKUP_TIME: '03:30',
    RESTIC_PASSWORD: ' kept as it is ',
    RESTIC_REPOSITORY: 's3:https://account.r2.cloudflarestorage.com/bucket/scooter',
    CRLF: 'yes',
  })
})

test('settings: a line that systemd, Compose and Scooter would read differently is refused', () => {
  const refused = {
    // Compose expands `$`; systemd doesn't.
    'A=pa$$word': 'A',
    'A=${HOME}/data': 'A',
    // systemd takes a backslash as an escape.
    'A=back\\slash': 'A',
    // Compose takes " #" as the start of a comment.
    'A=value # comment': 'A',
    'A=value#1': 'A',
    // Double quotes mean escapes to one and expansion to the other.
    'A="value"': 'A',
    'A=it\'s': 'A',
    "A='it's'": 'A',
    "A='unfinished": 'A',
    "A='two' words": 'A',
    // A quote after a space: how systemd and Compose read one was never checked.
    "A= 'two words'": 'A',
    // Compose reads a bare name as "take it from my environment"; systemd ignores the line.
    A: null,
    'export A=1': null,
    'A = 1': null,
    ' A=1': null,
    '; a comment, to systemd only': null,
    '1A=1': null,
    'A-B=1': null,
  }
  for (const [line, variable] of Object.entries(refused)) {
    const { values, problems } = parseEnvFile(`OK=1\n${line}\n`)
    assert.equal(problems.length, 1, line)
    assert.equal(problems[0].line, 2, line)
    assert.equal(problems[0].variable, variable, line)
    assert.deepEqual(Object.fromEntries(values), { OK: '1' }, line)
  }
  const twice = parseEnvFile('A=1\nB=2\nA=3\n')
  assert.deepEqual(twice.problems.map(problem => [problem.line, problem.variable]), [[3, 'A']])
  assert.match(twice.problems[0].message, /A is set twice/)
  assert.match(parseEnvFile("A= 'two words'\n").problems[0].message, /a quoted value starts right after the "="/)
  assert.match(parseEnvFile('A =1\n').problems[0].message, /no space before the "="/)
})

// ---------------------------------------------------------------------------------------------
// Where the values come from

test('settings: each service reads only its own env file', t => {
  const env = envFiles(t, {
    'bridge.env': 'OWNER_NUMBER=+919812345678\nDATA_DIR=/srv/bridge-data\n',
    'runner.env': 'OPENROUTER_API_KEY=sk-or-v1-runner\nDATA_DIR=/srv/runner-data\n',
  })
  const bridge = loadSettings('bridge', { env })
  const runner = loadSettings('runner', { env })
  assert.equal(bridge.ownerNumber, '919812345678')
  assert.equal(bridge.dataDir, '/srv/bridge-data')
  assert.equal(runner.openrouterApiKey, 'sk-or-v1-runner')
  assert.equal(runner.dataDir, '/srv/runner-data')
  // Neither holds anything of the other's.
  assert.ok(!JSON.stringify(bridge).includes('sk-or-v1-runner'))
  assert.ok(!JSON.stringify(runner).includes('919812345678'))

  // The other side's file can be missing, or unreadable nonsense: it is never opened.
  fs.writeFileSync(path.join(env.SCOOTER_ENV_DIR, 'runner.env'), 'this is = not an env file\n"')
  assert.equal(loadSettings('bridge', { env }).ownerNumber, '919812345678')
  fs.rmSync(path.join(env.SCOOTER_ENV_DIR, 'bridge.env'))
  fs.writeFileSync(path.join(env.SCOOTER_ENV_DIR, 'runner.env'), 'OPENROUTER_API_KEY=sk-or-v1-runner\n')
  assert.equal(loadSettings('runner', { env }).openrouterApiKey, 'sk-or-v1-runner')
})

test('settings: a variable in the environment wins over the file', t => {
  const env = envFiles(t, {
    'runner.env': 'OPENROUTER_API_KEY=from-file\nAGENT_ACCEL=kvm\nBATCH_SECONDS=20\nHOME_CURRENCY=EUR\n',
  })
  const settings = loadSettings('runner', { env: { ...env, AGENT_ACCEL: 'emulation', BATCH_SECONDS: '' } })
  assert.equal(settings.openrouterApiKey, 'from-file')
  assert.equal(settings.agentAccel, 'emulation')
  assert.equal(settings.homeCurrency, 'EUR')
  // Set but empty in the environment still wins, and empty means the default.
  assert.equal(settings.batchSeconds, 8)
})

test('settings: without an env file, the environment alone is enough', () => {
  // In Docker, Compose puts the file's variables in the environment and there is no file to read.
  assert.equal(loadSettings('bridge', { env: BRIDGE }).ownerNumber, '919812345678')
  assert.equal(loadSettings('runner', { env: RUNNER }).openrouterApiKey, 'sk-or-v1-test')
})

test('settings: loading changes nothing in the environment', t => {
  const env = envFiles(t, { 'bridge.env': "OWNER_NUMBER=+919812345678\nEMAIL_PASSWORD='secret'\n" })
  const before = { ...env }
  const processBefore = { ...process.env }
  loadSettings('bridge', { env })
  assert.deepEqual(env, before)
  assert.deepEqual({ ...process.env }, processBefore)
})

test('settings: a fault in the env file names the file, the line and the variable', t => {
  const env = envFiles(t, {
    'bridge.env': ['OWNER_NUMBER=+919812345678', 'EMAIL_PASSWORD=pa$$word', 'not a setting', 'OWNER_NUMBR=+91', 'OPENROUTER_API_KEY=sk-or-v1-x'].join('\n'),
  })
  const file = path.join(env.SCOOTER_ENV_DIR, 'bridge.env')
  let error
  try {
    loadSettings('bridge', { env })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof SettingsError)
  assert.deepEqual(
    error.problems.map(problem => problem.variable),
    ['EMAIL_PASSWORD', null, 'OWNER_NUMBR', 'OPENROUTER_API_KEY'],
  )
  const [quoting, shape, unknown, misplaced] = error.problems.map(problem => problem.message)
  assert.match(quoting, new RegExp(`^${file}, line 2: EMAIL_PASSWORD: .*single quotes`))
  assert.match(shape, new RegExp(`^${file}, line 3: expected KEY=value`))
  assert.match(unknown, /OWNER_NUMBR isn't one of the bridge's settings$/)
  // The runner's key in the bridge's file is in the wrong place, where the bridge could read it.
  assert.match(misplaced, /OPENROUTER_API_KEY isn't one of the bridge's settings; it belongs in runner.env$/)
  // No message repeats a value: a value may be a secret.
  assert.ok(!error.message.includes('pa$$word') && !error.message.includes('sk-or-v1-x'))
})

test('settings: an env file that can\'t be read is an error', { skip: isRoot ? 'root reads every file' : false }, t => {
  const env = envFiles(t, { 'runner.env': 'OPENROUTER_API_KEY=sk-or-v1-x\n' })
  fs.chmodSync(path.join(env.SCOOTER_ENV_DIR, 'runner.env'), 0o000)
  const found = faults('runner', env)
  assert.match(found.null, /runner\.env can't be read \(EACCES\)/)
})

// ---------------------------------------------------------------------------------------------
// The bridge's settings

test('settings: the bridge\'s defaults', () => {
  assert.deepEqual(loadSettings('bridge', { env: BRIDGE }), {
    side: 'bridge',
    dataDir: '/data',
    configDir: '/config',
    timeZone: 'Asia/Kolkata',
    ownerNumber: '919812345678',
    ownerJids: [],
    defaultChannel: 'whatsapp',
    email: null,
    backupTime: '03:30',
    backup: null,
  })
})

test('settings: everything the bridge can be given', () => {
  const settings = loadSettings('bridge', {
    env: {
      ...BRIDGE,
      ...EMAIL,
      OWNER_NUMBER: '+1 (415) 555-0100',
      OWNER_JIDS: '123456789012345@lid,  98765@lid ,',
      EMAIL_IMAP_PORT: '1993',
      EMAIL_CHECK_SECONDS: '30',
      SCOOTER_TZ: 'America/New_York',
      BACKUP_TIME: 'off',
      RESTIC_REPOSITORY: 's3:https://account.r2.cloudflarestorage.com/bucket/scooter',
      RESTIC_PASSWORD: ' a passphrase ',
      AWS_ACCESS_KEY_ID: 'key-id',
      AWS_SECRET_ACCESS_KEY: 'key-secret',
      RESTIC_KEEP_DAILY: '14',
      RESTIC_KEEP_WEEKLY: '0',
      RESTIC_KEEP_MONTHLY: '24',
      FORCE_CHECK: '1',
      RESTORE_TARGET: '/tmp/restored/',
      DATA_DIR: '/var/lib/scooter/',
      CONFIG_DIR: '/etc/scooter/config',
    },
  })
  assert.deepEqual(settings, {
    side: 'bridge',
    dataDir: '/var/lib/scooter',
    configDir: '/etc/scooter/config',
    timeZone: 'America/New_York',
    ownerNumber: '14155550100',
    ownerJids: ['123456789012345@lid', '98765@lid'],
    defaultChannel: 'whatsapp',
    email: {
      host: 'imap.gmail.com',
      port: 1993,
      user: 'scooter@example.com',
      password: 'app password',
      // Addresses are compared without regard to case, so they're kept in lower case.
      ownerAddresses: ['me@example.com', 'me@work.example'],
      authservId: 'mx.google.com',
      checkSeconds: 30,
    },
    backupTime: null,
    backup: {
      repository: 's3:https://account.r2.cloudflarestorage.com/bucket/scooter',
      // A password is kept exactly as given.
      password: ' a passphrase ',
      keepDaily: 14,
      keepWeekly: 0,
      keepMonthly: 24,
      forceCheck: true,
      restoreTarget: '/tmp/restored',
      env: { AWS_DEFAULT_REGION: 'auto', AWS_ACCESS_KEY_ID: 'key-id', AWS_SECRET_ACCESS_KEY: 'key-secret' },
    },
  })

  const b2 = loadSettings('bridge', {
    env: { ...BRIDGE, RESTIC_REPOSITORY: 'b2:bucket:scooter', RESTIC_PASSWORD: 'x', B2_ACCOUNT_ID: 'id', B2_ACCOUNT_KEY: 'key', AWS_DEFAULT_REGION: 'eu' },
  })
  assert.deepEqual(b2.backup.env, { AWS_DEFAULT_REGION: 'eu', B2_ACCOUNT_ID: 'id', B2_ACCOUNT_KEY: 'key' })
  assert.deepEqual([b2.backup.keepDaily, b2.backup.keepWeekly, b2.backup.keepMonthly], [7, 4, 12])
  // A check on Sundays only, and a restore back where each file was backed up from.
  assert.deepEqual([b2.backup.forceCheck, b2.backup.restoreTarget], [false, '/'])
})

test('settings: each fault in the bridge\'s settings names its variable', () => {
  assert.deepEqual(faults('bridge', { SCOOTER_ENV_DIR: '/nonexistent' }), { OWNER_NUMBER: 'OWNER_NUMBER is required' })
  assert.deepEqual(faults('bridge', { ...BRIDGE, OWNER_NUMBER: '   ' }), { OWNER_NUMBER: 'OWNER_NUMBER is required' })

  const bad = {
    OWNER_NUMBER: ['55501', '0917700900123', 'my number', '+91 77009 00123 90123 456'],
    OWNER_JIDS: ['5550100', 'a@b@c', '77@lid; 88@lid'],
    DEFAULT_CHANNEL: ['telegram', 'WhatsApp', 'sms'],
    SCOOTER_TZ: ['India', 'IST+5:30', 'Asia/Calcutta ', 'asia/kolkata', '+05:30'],
    BACKUP_TIME: ['7:15', '25:00', 'Sun 04:45', 'never', 'OFF'],
    DATA_DIR: ['data', './data', '~/scooter'],
    CONFIG_DIR: ['config'],
  }
  for (const [variable, values] of Object.entries(bad)) {
    for (const value of values) {
      const found = faults('bridge', { ...BRIDGE, [variable]: value })
      assert.deepEqual(Object.keys(found), [variable], `${variable}=${value}`)
      assert.ok(!found[variable].includes(value), `the message repeats the value of ${variable}`)
    }
  }
})

test('settings: email is off without EMAIL_IMAP_HOST, and complete with it', () => {
  // Off: the other mailbox settings aren't looked at.
  const off = loadSettings('bridge', { env: { ...BRIDGE, EMAIL_USER: 'someone', EMAIL_IMAP_PORT: 'imap', EMAIL_CHECK_SECONDS: '1' } })
  assert.equal(off.email, null)

  // On: everything email needs must be there. `EMAIL_AUTHSERV_ID` may wait: `email-check` shows
  // what it should be, and the bridge refuses to start without it (test/email.test.mjs).
  assert.deepEqual(Object.keys(faults('bridge', { ...BRIDGE, EMAIL_IMAP_HOST: 'imap.gmail.com' })).sort(), [
    'EMAIL_OWNER_ADDRESSES',
    'EMAIL_PASSWORD',
    'EMAIL_USER',
  ])
  assert.match(faults('bridge', { ...BRIDGE, EMAIL_IMAP_HOST: 'imap.gmail.com' }).EMAIL_USER, /EMAIL_USER is required when EMAIL_IMAP_HOST is set/)
  const { EMAIL_AUTHSERV_ID: _, ...withoutAuthserv } = EMAIL
  assert.equal(loadSettings('bridge', { env: { ...BRIDGE, ...withoutAuthserv } }).email.authservId, null)

  const bad = {
    EMAIL_IMAP_HOST: ['imap gmail com', 'imaps://imap.gmail.com', 'imap.gmail.com:993'],
    EMAIL_IMAP_PORT: ['0', '65536', 'imaps', '99.3', '-1'],
    EMAIL_OWNER_ADDRESSES: ['me', 'me@example', 'Me <me@example.com>', 'me@example.com; other@example.com'],
    EMAIL_AUTHSERV_ID: ['mx google com', 'mx.google.com; dmarc=pass'],
    EMAIL_CHECK_SECONDS: ['9', '3601', 'often', '1e2'],
  }
  for (const [variable, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.deepEqual(Object.keys(faults('bridge', { ...BRIDGE, ...EMAIL, [variable]: value })), [variable], `${variable}=${value}`)
    }
  }
  // The password never appears in a message, whatever else is wrong.
  const found = faults('bridge', { ...BRIDGE, ...EMAIL, EMAIL_PASSWORD: 'hunter2', EMAIL_IMAP_PORT: 'x' })
  assert.ok(!JSON.stringify(found).includes('hunter2'))
})

test('settings: backups are off without RESTIC_REPOSITORY, and need the password with it', () => {
  const off = loadSettings('bridge', { env: { ...BRIDGE, RESTIC_PASSWORD: 'x', RESTIC_KEEP_DAILY: 'many' } })
  assert.equal(off.backup, null)

  const on = { ...BRIDGE, RESTIC_REPOSITORY: 'b2:bucket:scooter' }
  assert.deepEqual(faults('bridge', on), { RESTIC_PASSWORD: 'RESTIC_PASSWORD is required when RESTIC_REPOSITORY is set' })
  const bad = {
    RESTIC_KEEP_DAILY: ['0', '3651', 'x'],
    RESTIC_KEEP_WEEKLY: ['521', '-1'],
    RESTIC_KEEP_MONTHLY: ['1201', '1.5'],
    FORCE_CHECK: ['yes', 'on', '2', 'true'],
    RESTORE_TARGET: ['restored', './restored'],
  }
  for (const [variable, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.deepEqual(Object.keys(faults('bridge', { ...on, RESTIC_PASSWORD: 'x', [variable]: value })), [variable], `${variable}=${value}`)
    }
  }
})

// ---------------------------------------------------------------------------------------------
// The runner's settings

test('settings: the runner\'s defaults', () => {
  assert.deepEqual(loadSettings('runner', { env: RUNNER }), {
    side: 'runner',
    dataDir: '/data',
    configDir: '/config',
    timeZone: 'Asia/Kolkata',
    openrouterApiKey: 'sk-or-v1-test',
    zdr: true,
    homeCurrency: 'INR',
    batchSeconds: 8,
    sessionRolloverHour: 4,
    agentInternet: false,
    agentAccel: 'auto',
  })
})

test('settings: everything the runner can be given', () => {
  const settings = loadSettings('runner', {
    env: {
      ...RUNNER,
      OPENROUTER_ZDR: 'off',
      SCOOTER_TZ: 'Europe/London',
      HOME_CURRENCY: 'GBP',
      BATCH_SECONDS: '30',
      SESSION_ROLLOVER_HOUR: '0',
      AGENT_INTERNET: 'on',
      AGENT_ACCEL: 'kvm',
      DATA_DIR: '/var/lib/scooter',
      CONFIG_DIR: '/etc/scooter/config',
    },
  })
  assert.deepEqual(settings, {
    side: 'runner',
    dataDir: '/var/lib/scooter',
    configDir: '/etc/scooter/config',
    timeZone: 'Europe/London',
    openrouterApiKey: 'sk-or-v1-test',
    zdr: false,
    homeCurrency: 'GBP',
    batchSeconds: 30,
    sessionRolloverHour: 0,
    agentInternet: true,
    agentAccel: 'kvm',
  })
  // `hvf` is a known value, kept for macOS. Whether it can be used is decided when the runner
  // picks its accelerator.
  for (const accel of ['auto', 'kvm', 'emulation', 'hvf']) {
    assert.equal(loadSettings('runner', { env: { ...RUNNER, AGENT_ACCEL: accel } }).agentAccel, accel)
  }
})

test('settings: each fault in the runner\'s settings names its variable', () => {
  assert.deepEqual(faults('runner', { SCOOTER_ENV_DIR: '/nonexistent' }), { OPENROUTER_API_KEY: 'OPENROUTER_API_KEY is required' })
  const bad = {
    OPENROUTER_API_KEY: ['sk-or v1'],
    OPENROUTER_ZDR: ['yes', 'true', 'ON', '1'],
    AGENT_INTERNET: ['yes', 'true', '0'],
    AGENT_ACCEL: ['fast', 'KVM', 'tcg', 'krun'],
    HOME_CURRENCY: ['inr', 'rupees', '₹', 'IN'],
    BATCH_SECONDS: ['0', '601', '8s', '2.5', '-8'],
    SESSION_ROLLOVER_HOUR: ['24', '4am', '-1'],
    SCOOTER_TZ: ['Nowhere/Land'],
    // A `:` would split the VMs' PATH, and a line break the lines of a run's index file.
    DATA_DIR: ['relative/path', '/var/lib/scoo:ter', '/data\nmore', '/data\rmore', '/data\tmore', '/data\u0085more'],
  }
  for (const [variable, values] of Object.entries(bad)) {
    for (const value of values) {
      const found = faults('runner', { ...RUNNER, [variable]: value })
      assert.deepEqual(Object.keys(found), [variable], `${variable}=${value}`)
    }
  }
  assert.ok(!faults('runner', { ...RUNNER, OPENROUTER_API_KEY: 'sk-or v1' }).OPENROUTER_API_KEY.includes('sk-or'))
  assert.match(faults('runner', { ...RUNNER, DATA_DIR: '/a:b' }).DATA_DIR, /^DATA_DIR can't hold a : or a control character, such as a line break: the runner puts a folder of it on its VMs' PATH/)
  // Spaces and other characters are a path's own; the bridge, whose programs take no PATH from it,
  // takes a `:` as it did.
  assert.equal(loadSettings('runner', { env: { ...RUNNER, DATA_DIR: '/my data/scooter ₹' } }).dataDir, '/my data/scooter ₹')
  assert.equal(loadSettings('bridge', { env: { ...BRIDGE, DATA_DIR: '/var/lib/scoo:ter' } }).dataDir, '/var/lib/scoo:ter')
})

test('settings: every fault is reported at once', () => {
  const found = faults('runner', { SCOOTER_ENV_DIR: '/nonexistent', AGENT_ACCEL: 'fast', BATCH_SECONDS: '0', SCOOTER_TZ: 'x' })
  assert.deepEqual(Object.keys(found).sort(), ['AGENT_ACCEL', 'BATCH_SECONDS', 'OPENROUTER_API_KEY', 'SCOOTER_TZ'])
})

test('settings: a setting\'s range is a limit, and the message gives it', t => {
  // A value becomes a setting only with a valid range, so a bad one can't, for example,
  // make the runner start a batch on every poll.
  assert.match(faults('runner', { ...RUNNER, BATCH_SECONDS: '0' }).BATCH_SECONDS, /BATCH_SECONDS must be a whole number from 1 to 600/)
  t.after(overrideLimits({ SETTING_RANGES: { BATCH_SECONDS: [0, 5], SESSION_ROLLOVER_HOUR: [0, 23] } }))
  assert.equal(loadSettings('runner', { env: { ...RUNNER, BATCH_SECONDS: '0' } }).batchSeconds, 0)
  assert.match(faults('runner', { ...RUNNER, BATCH_SECONDS: '6' }).BATCH_SECONDS, /from 0 to 5/)
})

// ---------------------------------------------------------------------------------------------
// The example files

for (const side of ['bridge', 'runner']) {
  test(`settings: ${side}.env.example explains every variable, in the format the loader reads`, t => {
    const example = new URL(`../${side}.env.example`, import.meta.url)
    const text = fs.readFileSync(example, 'utf8')
    const variables = variablesOf(side)

    // Every variable of this side is there, set or commented out, and nothing else is.
    const named = [...text.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map(match => match[1])
    assert.deepEqual([...named].sort(), [...variables].sort())
    // The file says that a value with `$` needs single quotes.
    assert.match(text, /\$.*single quotes/)

    // As it stands, the file is read without a format fault, and asks only for what's required.
    const dir = makeTestDir(t)
    fs.copyFileSync(example, path.join(dir, `${side}.env`))
    const required = side === 'bridge' ? 'OWNER_NUMBER' : 'OPENROUTER_API_KEY'
    assert.deepEqual(faults(side, { SCOOTER_ENV_DIR: dir }), { [required]: `${required} is required` })

    // With every commented variable switched on, at the value the file shows, the format still
    // holds: the defaults the file shows are values the loader takes.
    const switchedOn = text.replace(/^# ([A-Z][A-Z0-9_]*=)/gm, '$1')
    assert.deepEqual(parseEnvFile(switchedOn).problems, [])
    fs.writeFileSync(path.join(dir, `${side}.env`), switchedOn)
    const found = faults(side, { SCOOTER_ENV_DIR: dir })
    assert.deepEqual(Object.keys(found), [required])
  })
}

test('settings: the examples\' defaults are the loader\'s defaults', () => {
  const shown = side =>
    Object.fromEntries(
      [...fs.readFileSync(new URL(`../${side}.env.example`, import.meta.url), 'utf8').matchAll(/^# ([A-Z][A-Z0-9_]*)=(.+)$/gm)].map(match => [match[1], match[2]]),
    )
  assert.deepEqual(shown('bridge'), {
    DEFAULT_CHANNEL: 'whatsapp',
    EMAIL_IMAP_PORT: '993',
    EMAIL_CHECK_SECONDS: '60',
    SCOOTER_TZ: 'Asia/Kolkata',
    BACKUP_TIME: '03:30',
    AWS_DEFAULT_REGION: 'auto',
    RESTIC_KEEP_DAILY: '7',
    RESTIC_KEEP_WEEKLY: '4',
    RESTIC_KEEP_MONTHLY: '12',
    FORCE_CHECK: '0',
    RESTORE_TARGET: '/',
    DATA_DIR: '/data',
    CONFIG_DIR: '/config',
  })
  assert.deepEqual(shown('runner'), {
    OPENROUTER_ZDR: 'on',
    AGENT_INTERNET: 'off',
    AGENT_ACCEL: 'auto',
    BATCH_SECONDS: '8',
    SESSION_ROLLOVER_HOUR: '4',
    HOME_CURRENCY: 'INR',
    SCOOTER_TZ: 'Asia/Kolkata',
    DATA_DIR: '/data',
    CONFIG_DIR: '/config',
  })
})
