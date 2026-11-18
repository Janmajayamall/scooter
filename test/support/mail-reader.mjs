// The email reader's stub, for the bridge's tests: `createMailReaderStub` puts a wrapper in the
// test's folder that runs `mail-reader-stub.mjs`, and returns what the email channel is given as
// its `reader`, with ways to fill the stub's mailbox and see how it was run.
//
// The wrapper is a Node file with this Node's own path in its `#!` line, as the wacli stub's is
// (`wacli.mjs`): the reader's environment names a `PATH` of the system's, not this Node's.

import fs from 'node:fs'
import path from 'node:path'

const STUB = new URL('./mail-reader-stub.mjs', import.meta.url)

export function createMailReaderStub(dir, { uidValidity = 3857529045, uidNext = 1 } = {}) {
  const bin = path.join(dir, 'bin')
  const control = path.join(dir, 'stub-mail')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(control, { recursive: true })
  const wrapper = path.join(bin, 'mail-reader')
  fs.writeFileSync(wrapper, `#!${process.execPath}\nimport(${JSON.stringify(STUB.href)})\n`, { mode: 0o755 })

  let mailbox = { uidValidity, uidNext, messages: [], connectFails: false }
  const write = () => {
    fs.writeFileSync(path.join(control, 'mailbox.json.tmp'), JSON.stringify(mailbox))
    fs.renameSync(path.join(control, 'mailbox.json.tmp'), path.join(control, 'mailbox.json'))
  }
  write()
  const lines = name => {
    const file = path.join(control, name)
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  }

  return {
    bin,
    control,
    // What the email channel, and `email-check`, are given as the reader.
    reader: { program: wrapper, args: [] },

    // A message arrives in the mailbox: `raw`, at `arrivedAt`.
    deliver(raw, { arrivedAt = '2026-11-09T16:12:40Z' } = {}) {
      const file = `message-${mailbox.messages.length + 1}.eml`
      fs.writeFileSync(path.join(control, file), raw)
      mailbox = { ...mailbox, messages: [...mailbox.messages, { file, arrivedAt }] }
      write()
    },

    // Changes the mailbox's other settings: `connectFails`.
    set(changes) {
      mailbox = { ...mailbox, ...changes }
      write()
    },

    // Every start of the reader, as `{ args, env, uid, gid, pid }`.
    calls: () => lines('calls.jsonl'),
    // The reader's log lines.
    log: () => lines('log.jsonl'),
  }
}
