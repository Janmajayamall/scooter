// A stand-in for wacli 0.26.0, for the tests (section 10 of DESIGN.md).
//
// It is run through the wrapper that `createWacliStub` in `wacli.mjs` writes and puts first on
// `PATH`. Its control folder is `../stub/` from the wrapper. There it:
// - records every call as a line of `calls.jsonl`: the arguments, the whole environment, the user
//   and group it runs as, and its pid;
// - answers from `fixtures.json`, read afresh at every call:
//     paired     whether `auth status` says it is authenticated; `sync` refuses to run without it
//     store      whether its store exists, which `messages list` needs (default: as paired)
//     messages   the rows `messages list` returns, those of `--chat` after `--after`, by time
//     ignoreAfter  when true, `messages list` leaves `--after` out of it, as a broken wacli might
//     leftDir    by message ID, `media download` leaves a folder where the file should be
//     media      by message ID, what `media download` does: `{ content, failures, as }`, where it
//                fails `failures` times first, and `as` is `file` (the default), `symlink` to
//                `target`, `elsewhere` (saved at another path), or `hang`
//     syncExit   when set, `sync` exits at once with this code
//     sendFailures  how many sends, `send text` and `send react` together, fail before they work
//     sendNoId   when true, a send succeeds with no `id` in its answer
//     authExit   the exit code of `auth`, which `scooter pair` runs (default 0)
//   A send that works answers `{sent: true, to, id}`, with the IDs `SENT1`, `SENT2`… in the order
//   of the sends, failed ones included.
// - as `sync --follow`, posts each file that appears in `webhooks/` to its webhook, signed with the
//   secret on its command line, and writes the answer's status beside it.
//
// It answers the way 13.1 and docs/DECISIONS.md (0.6) describe wacli: JSON on stdout, errors as
// JSON on stderr with exit code 1, and `null` for an empty list.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const control = path.join(path.dirname(process.argv[1]), '..', 'stub')
const args = process.argv.slice(2)
const fixtures = JSON.parse(fs.readFileSync(path.join(control, 'fixtures.json'), 'utf8'))
const callsFile = path.join(control, 'calls.jsonl')
const earlier = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
fs.appendFileSync(callsFile, `${JSON.stringify({ args, env: process.env, uid: process.getuid(), gid: process.getgid(), pid: process.pid })}\n`)

const FLAGS = new Set(['--json', '--read-only', '--follow', '--asc', '--webhook-allow-private', '--no-preview'])
const words = []
const options = {}
for (let i = 0; i < args.length; i++) {
  if (FLAGS.has(args[i])) options[args[i].slice(2)] = true
  else if (args[i].startsWith('--')) options[args[i].slice(2)] = args[++i]
  else words.push(args[i])
}
const command = words.join(' ')

function ok(data) {
  process.stdout.write(`${JSON.stringify({ success: true, data, error: null })}\n`)
  process.exitCode = 0
}
function fail(error) {
  process.stderr.write(`${JSON.stringify({ success: false, data: null, error })}\n`)
  process.exitCode = 1
}
const seconds = time => Math.floor(Date.parse(time) / 1000)

function sync() {
  if (!fixtures.paired) return fail('not authenticated; run `wacli auth`')
  if (fixtures.syncExit !== undefined) {
    process.exitCode = fixtures.syncExit
    return
  }
  const url = new URL(options.webhook)
  const secret = options['webhook-secret']
  const outbox = path.join(control, 'webhooks')
  let busy = false
  process.on('SIGTERM', () => process.exit(0))
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      for (const name of fs.readdirSync(outbox).filter(name => name.endsWith('.json')).sort()) {
        const file = path.join(outbox, name)
        const { body, signature } = JSON.parse(fs.readFileSync(file, 'utf8'))
        const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
        const headers = { 'content-type': 'application/json', 'content-length': raw.length }
        if (signature === undefined) headers['x-wacli-signature'] = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`
        else if (signature !== null) headers['x-wacli-signature'] = signature
        const status = await new Promise(resolve => {
          const request = http.request(url, { method: 'POST', headers }, response => {
            response.resume()
            resolve(response.statusCode)
          })
          request.on('error', () => resolve(0))
          request.end(raw)
        })
        // Written whole and renamed, so the helper that waits for it never reads it half written.
        fs.writeFileSync(`${file}.status.tmp`, String(status))
        fs.renameSync(`${file}.status.tmp`, `${file}.status`)
        fs.rmSync(file)
      }
    } finally {
      busy = false
    }
  }, 10)
}

function list() {
  if (!(fixtures.store ?? fixtures.paired)) return fail('open /data/wacli/store/wacli.db: no such file or directory')
  const after = options.after === undefined ? -Infinity : seconds(options.after)
  const rows = (fixtures.messages ?? [])
    .filter(row => row.ChatJID === options.chat && (fixtures.ignoreAfter || seconds(row.Timestamp) > after))
    .sort((a, b) => seconds(a.Timestamp) - seconds(b.Timestamp))
  const limit = Number(options.limit ?? 50)
  const page = rows.slice(0, limit)
  ok({ messages: page.length > 0 ? page : null, page: { has_more: rows.length > limit, next_cursor: null } })
}

function download() {
  const plan = fixtures.media?.[options.id]
  if (fixtures.leftDir?.includes(options.id)) {
    fs.mkdirSync(path.join(options.output, 'inside'), { recursive: true })
    return fail('download media: interrupted')
  }
  if (!plan) return fail('message has no downloadable media metadata (run `wacli sync` first)')
  const before = earlier.filter(call => call.args.includes('download') && call.args.includes(options.id)).length
  if (before < (plan.failures ?? 0)) return fail('download media: 404 Not Found')
  let saved = options.output
  if (plan.as === 'hang') {
    setInterval(() => {}, 1000)
    return
  } else if (plan.as === 'symlink') {
    fs.symlinkSync(plan.target, saved)
  } else if (plan.as === 'elsewhere') {
    saved = `${options.output}-elsewhere`
    fs.writeFileSync(saved, plan.content)
  } else {
    fs.writeFileSync(saved, plan.content)
  }
  ok({ chat: options.chat, id: options.id, path: saved, bytes: Buffer.byteLength(plan.content ?? ''), media_type: 'image', mime_type: 'image/jpeg', downloaded: true, source: 'server', recorded: true })
}

function send(kind) {
  if (!fixtures.paired) return fail('not authenticated; run `wacli auth`')
  const before = earlier.filter(call => commandOf(call.args).startsWith('send ')).length
  if (before < (fixtures.sendFailures ?? 0)) return fail('send: connection lost')
  if (kind === 'react') process.stderr.write('warning: sends less than 5s apart may trigger WhatsApp rate limits\n')
  ok({ sent: true, to: options.to, ...(fixtures.sendNoId ? {} : { id: `SENT${before + 1}` }) })
}

function commandOf(callArgs) {
  const parts = []
  for (let i = 0; i < callArgs.length; i++) {
    if (FLAGS.has(callArgs[i])) continue
    if (callArgs[i].startsWith('--')) i += 1
    else parts.push(callArgs[i])
  }
  return parts.join(' ')
}

switch (command) {
  case 'send text':
    send('text')
    break
  case 'send react':
    send('react')
    break
  case 'auth':
    // `scooter pair`: wacli would show a QR code on the terminal, and wait to be linked.
    process.exitCode = fixtures.authExit ?? 0
    break
  case 'auth status':
    ok(fixtures.paired ? { authenticated: true, linked_jid: '15550100000:3@s.whatsapp.net', phone: '15550100000' } : { authenticated: false })
    break
  case 'sync':
    sync()
    break
  case 'messages list':
    list()
    break
  case 'media download':
    download()
    break
  default:
    fail(`the stub doesn't know: ${command}`)
}
