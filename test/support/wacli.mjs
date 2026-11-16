// The wacli stub, for the tests (section 10 of DESIGN.md), and wacli's two formats, as samples.
//
// `createWacliStub` puts a wrapper named `wacli` first on `PATH`, which runs `wacli-stub.mjs`. The
// wrapper is a Node file with this Node's own path in its `#!` line, not a shell script: wacli's
// environment has no `PATH` to find `node` on (5.1), and a shell would add `PWD` to the
// environment that the stub records.

import fs from 'node:fs'
import path from 'node:path'
import { atEnd } from './tmp.mjs'

const STUB = new URL('./wacli-stub.mjs', import.meta.url)

// Waits, in real time, until `check()` is true.
export async function waitFor(check, what, ms = 10_000) {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Sets up the stub in `dir` for the test `t`, and puts it first on PATH until the test ends.
export function createWacliStub(t, dir) {
  const bin = path.join(dir, 'bin')
  const control = path.join(dir, 'stub')
  const outbox = path.join(control, 'webhooks')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(outbox, { recursive: true })
  const wrapper = path.join(bin, 'wacli')
  fs.writeFileSync(wrapper, `#!${process.execPath}\nimport(${JSON.stringify(STUB.href)})\n`, { mode: 0o755 })

  let fixtures = {}
  const writeFixtures = () => {
    fs.writeFileSync(path.join(control, 'fixtures.json.tmp'), JSON.stringify(fixtures))
    fs.renameSync(path.join(control, 'fixtures.json.tmp'), path.join(control, 'fixtures.json'))
  }
  writeFixtures()

  const before = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${before}`
  atEnd(t, () => {
    process.env.PATH = before
  })

  let posted = 0
  const stub = {
    bin,
    control,
    wrapper,

    // Changes some fixtures. What isn't named stays as it was.
    fixtures(changes) {
      fixtures = { ...fixtures, ...changes }
      writeFixtures()
    },

    // Every call so far, in order, as `{ args, env, uid, gid, pid, command }`, where `command` is
    // the words of the command line, such as `media download`.
    calls() {
      const file = path.join(control, 'calls.jsonl')
      if (!fs.existsSync(file)) return []
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .map(call => ({ ...call, command: commandOf(call.args) }))
    },

    callsOf: command => stub.calls().filter(call => call.command === command),

    // Has the running `sync` post `body` to its webhook: signed with its secret by default, with
    // no signature for `signature: null`, or with the header given. Resolves with the status of
    // the answer, 0 if there was none.
    async postWebhook(body, { signature } = {}) {
      const name = `${String(++posted).padStart(4, '0')}.json`
      const file = path.join(outbox, name)
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ body, signature }))
      fs.renameSync(`${file}.tmp`, file)
      await waitFor(() => fs.existsSync(`${file}.status`), `the stub to post ${name}`)
      return Number(fs.readFileSync(`${file}.status`, 'utf8'))
    },
  }
  return stub
}

// The words of a wacli command line, without its flags and their values.
const FLAGS = new Set(['--json', '--read-only', '--follow', '--asc', '--webhook-allow-private', '--no-preview'])
function commandOf(args) {
  const words = []
  for (let i = 0; i < args.length; i++) {
    if (FLAGS.has(args[i])) continue
    if (args[i].startsWith('--')) i += 1
    else words.push(args[i])
  }
  return words.join(' ')
}

// ---------------------------------------------------------------------------------------------
// Samples of wacli's two formats, shaped as its source at v0.26.0 writes them (13.1)

export const OWNER_NUMBER = '919812345678'
export const OWNER = `${OWNER_NUMBER}@s.whatsapp.net`

// A message webhook payload: wacli's `ParsedMessage` with Go's field names, every field there with
// its zero value as Go writes it, `Media` as wacli's own short form, and `ChatName`.
export function webhookPayload(fields = {}) {
  return {
    Chat: OWNER,
    ID: '3EB0A1B2C3D4E5F6A7B8',
    SenderJID: OWNER,
    Timestamp: '2026-11-09T15:43:02Z',
    FromMe: false,
    Text: '',
    Buttons: null,
    Location: null,
    Poll: null,
    PollVote: null,
    PollAdd: null,
    PushName: 'Owner',
    ReplyToID: '',
    ReplyToSenderJID: '',
    ReplyToDisplay: '',
    ReactionToID: '',
    ReactionEmoji: '',
    IsForwarded: false,
    ForwardingScore: 0,
    StarredKnown: false,
    Starred: false,
    Edited: false,
    Revoked: false,
    Call: null,
    UnhandledPayload: '',
    Media: null,
    ChatName: 'Owner',
    ...fields,
  }
}

// A row of `messages list --json`: wacli's stored message.
export function listRow(fields = {}) {
  return {
    ChatJID: OWNER,
    ChatName: 'Owner',
    MsgID: '3EB0A1B2C3D4E5F6A7B8',
    SenderJID: OWNER,
    SenderName: 'Owner',
    Timestamp: '2026-11-09T15:43:02Z',
    FromMe: false,
    Text: '',
    DisplayText: '',
    IsForwarded: false,
    ForwardingScore: 0,
    ReactionToID: '',
    ReactionEmoji: '',
    MediaType: '',
    MediaCaption: '',
    Filename: '',
    MimeType: '',
    DirectPath: '',
    LocalPath: '',
    DownloadedAt: '0001-01-01T00:00:00Z',
    Starred: false,
    StarredAt: '0001-01-01T00:00:00Z',
    Edited: false,
    Revoked: false,
    DeletedForMe: false,
    DeliveredTo: 0,
    ReadBy: 0,
    Snippet: '',
    ...fields,
  }
}
