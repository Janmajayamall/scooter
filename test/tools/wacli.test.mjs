// What the pinned wacli does, which the WhatsApp module will rely on.
//
// These are the wacli checks of milestone 0 in docs/plans/completed/v2-linux-implementation/v2-linux-implementation.md, and
// docs/DECISIONS.md says what each one settled. They run the real wacli against an empty store,
// which needs no pairing and no network, and skip themselves when wacli isn't installed.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { makeTestDir } from '../support/tmp.mjs'

// Section 2 of DESIGN.md pins this version.
const WACLI_VERSION = '0.26.0'

function findOnPath(program) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, program)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not in this folder
    }
  }
  return null
}

const WACLI = findOnPath('wacli')
const options = { skip: WACLI ? false : 'wacli is not installed' }

// Runs wacli the way section 5.1 says: its own folders, UTC, and nothing else in its environment.
function wacli(dir, args, extraEnv = {}) {
  const home = path.join(dir, 'wacli')
  const env = {
    HOME: home,
    WACLI_STORE_DIR: path.join(home, 'store'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    TZ: 'UTC',
    ...extraEnv,
  }
  return new Promise(resolve => {
    execFile(WACLI, args, { env, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? (error.code ?? 1) : 0, stdout, stderr })
    })
  })
}

// The flags a command's help lists, without the global ones.
async function flagsOf(dir, command) {
  const result = await wacli(dir, [...command, '--help'])
  assert.equal(result.exitCode, 0, `wacli ${command.join(' ')} --help: ${result.stderr}`)
  const own = result.stdout.split('\nGlobal Flags:')[0]
  return { help: own, flags: [...own.matchAll(/^\s+(?:-\w, )?--([a-z-]+)/gm)].map(match => match[1]) }
}

test('wacli: the installed version is the pinned one', options, async t => {
  const dir = makeTestDir(t)
  const result = await wacli(dir, ['--version'])
  assert.equal(result.stdout, `wacli ${WACLI_VERSION}\n`)
})

test('wacli 1: sync takes the webhook secret from its command line only', options, async t => {
  const dir = makeTestDir(t)

  // The flag is there, and its help names no variable, where other flags of sync name theirs.
  const { help, flags } = await flagsOf(dir, ['sync'])
  assert.ok(flags.includes('webhook-secret'))
  assert.match(help, /--webhook-secret string\s+HMAC-SHA256 secret for X-Wacli-Signature header\n/)
  assert.match(help, /--max-messages int .*WACLI_SYNC_MAX_MESSAGES/)

  // The program holds no variable name about webhooks at all.
  const names = new Set(fs.readFileSync(WACLI, 'latin1').match(/WACLI_[A-Z_]{3,}/g))
  assert.ok(names.has('WACLI_STORE_DIR'), 'the scan should find the variables wacli does read')
  assert.deepEqual([...names].filter(name => name.includes('WEBHOOK')), [])

  // And it acts that way. Given on the command line without a webhook, the secret is an error.
  // Given in the environment under the likely names, it is not noticed.
  const flag = await wacli(dir, ['--json', 'sync', '--webhook-secret', 'not-a-real-secret'])
  assert.equal(flag.exitCode, 1)
  assert.equal(JSON.parse(flag.stderr).error, '--webhook-secret requires --webhook')
  const variables = { WACLI_WEBHOOK_SECRET: 'x', WACLI_SYNC_WEBHOOK_SECRET: 'x', WEBHOOK_SECRET: 'x' }
  const env = await wacli(dir, ['--json', 'sync'], variables)
  assert.equal(JSON.parse(env.stderr).error, 'not authenticated; run `wacli auth`')
})

test('wacli 2: auth status when not paired', options, async t => {
  const dir = makeTestDir(t)
  const status = await wacli(dir, ['--json', '--read-only', 'auth', 'status'])
  const notPaired = '{"success":true,"data":{"authenticated":false},"error":null}\n'
  assert.deepEqual(status, { exitCode: 0, stdout: notPaired, stderr: '' })
  // With --read-only it doesn't even create its store.
  assert.equal(fs.existsSync(path.join(dir, 'wacli')), false)

  // Without --json it is a sentence, still with exit code 0.
  const plain = await wacli(dir, ['--read-only', 'auth', 'status'])
  assert.deepEqual(plain, { exitCode: 0, stdout: 'Not authenticated. Run `wacli auth`.\n', stderr: '' })

  // Commands that need the session fail at once, with the error as JSON on stderr and exit code 1.
  const webhook = ['--webhook', 'http://127.0.0.1:8787/wacli', '--webhook-secret', 'not-a-real-secret', '--webhook-allow-private']
  const sync = await wacli(dir, ['--json', 'sync', '--follow', ...webhook])
  const refusal = '{"success":false,"data":null,"error":"not authenticated; run `wacli auth`"}\n'
  assert.deepEqual(sync, { exitCode: 1, stdout: '', stderr: refusal })
})

test('wacli 3: the commands and flags of section 13.1 exist as written', options, async t => {
  const dir = makeTestDir(t)

  const top = await wacli(dir, ['--help'])
  assert.equal(top.exitCode, 0)
  for (const flag of ['--json', '--read-only', '--store']) {
    assert.ok(top.stdout.includes(`      ${flag} `), `global flag ${flag}`)
  }
  assert.match(top.stdout, /--store string\s+store directory \(default: \$WACLI_STORE_DIR/)

  const expected = [
    [['sync'], ['follow', 'webhook', 'webhook-secret', 'webhook-allow-private', 'webhook-events', 'max-reconnect']],
    [['auth'], ['phone']],
    [['auth', 'status'], []],
    [['messages', 'list'], ['chat', 'after', 'asc', 'limit']],
    [['media', 'download'], ['chat', 'id', 'output']],
    [['send', 'text'], ['to', 'message', 'reply-to', 'reply-to-sender', 'no-preview']],
    [['send', 'file'], ['to', 'file', 'caption', 'reply-to']],
    [['send', 'react'], ['to', 'id', 'reaction', 'sender']],
  ]
  for (const [command, wanted] of expected) {
    const { flags } = await flagsOf(dir, command)
    for (const flag of wanted) assert.ok(flags.includes(flag), `wacli ${command.join(' ')} should have --${flag}`)
  }

  // The defaults section 13.1 gives.
  const sync = await flagsOf(dir, ['sync'])
  assert.match(sync.help, /--max-reconnect duration .*\(default 5m0s\)/)
  assert.match(sync.help, /--webhook-events string .*message, receipt, chat_presence \(default "message"\)/)

  // Unless told otherwise, `send text` fetches the first URL in the text to build a link preview.
  // The bridge passes this flag with every text, so that it never does (section 5.3).
  const text = await flagsOf(dir, ['send', 'text'])
  assert.match(text.help, /--no-preview\s+disable automatic link previews for the first URL in text/)

  // Listing shows the envelope the rows come in. It needs a store: read-only commands don't make
  // one, and `auth status` does when it is allowed to write.
  const filters = ['--chat', '911234567890@s.whatsapp.net', '--after', '2026-11-09T00:00:00Z', '--asc', '--limit', '500']
  const listing = ['--json', '--read-only', 'messages', 'list', ...filters]
  const noStore = await wacli(dir, listing)
  assert.equal(noStore.exitCode, 1)
  assert.match(JSON.parse(noStore.stderr).error, /wacli\.db: no such file or directory$/)
  assert.equal((await wacli(dir, ['--json', 'auth', 'status'])).exitCode, 0)
  const list = await wacli(dir, listing)
  assert.equal(list.exitCode, 0, list.stderr)
  const answer = JSON.parse(list.stdout)
  assert.equal(answer.success, true)
  assert.equal(answer.data.messages, null)
  assert.deepEqual(answer.data.page, { has_more: false, next_cursor: null })

  // The send commands of section 5.3, as the bridge will run them. Unpaired, each one gets as far
  // as the check for a session, so wacli took every flag. A flag it doesn't know stops it before
  // that, and a text that looks like a flag is taken as the text.
  const chat = '911234567890@s.whatsapp.net'
  const id = '3EB0A1B2C3D4E5F6A7B8'
  const unpaired = 'not authenticated; run `wacli auth`'
  for (const [args, error] of [
    [['send', 'text', '--to', chat, '--message', 'see https://example.invalid/a?b=c', '--no-preview'], unpaired],
    [['send', 'text', '--to', chat, '--message', 'a reply', '--no-preview', '--reply-to', id], unpaired],
    [['send', 'text', '--to', chat, '--message', '--no-such-flag', '--no-preview'], unpaired],
    [['send', 'react', '--to', chat, '--id', id, '--sender', chat, '--reaction', '✅'], unpaired],
    [['send', 'text', '--to', chat, '--message', 'a reply', '--no-such-flag'], 'unknown flag: --no-such-flag'],
  ]) {
    const sent = await wacli(dir, ['--json', ...args])
    assert.equal(sent.exitCode, 1, args.join(' '))
    assert.equal(sent.stdout, '', args.join(' '))
    assert.equal(JSON.parse(sent.stderr).error, error, args.join(' '))
  }

  // While sync runs, wacli hands a send to it, and it is the sync process that would fetch the
  // link. The request it hands over has a field for the flag.
  assert.ok(fs.readFileSync(WACLI, 'latin1').includes('json:"no_preview,omitempty"'))
})
