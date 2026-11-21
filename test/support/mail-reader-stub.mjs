// A stand-in for the email reader's program, for the bridge's tests.
//
// The email channel runs it as it runs `src/mail/reader.mjs`: through the wrapper that
// `createMailReaderStub` in `mail-reader.mjs` writes, with `run` or `newest`. It runs the real
// reader (`main` in `src/mail/reader.mjs`) against a fake mailbox (`fake-mailbox.mjs`) instead of
// a server, so what reaches the spool is what the real reader writes. Its control folder is
// `../stub-mail/` from the wrapper. There it:
// - records every start as a line of `calls.jsonl`: the arguments, the whole environment, the user
//   and group it runs as, and its pid;
// - builds the mailbox from `mailbox.json`, `{ uidValidity, uidNext, messages, connectFails }`,
//   each message `{ file, arrivedAt }`, and delivers the messages added to it later while it runs,
//   so their UIDs are the same at every start;
// - writes the reader's log lines to `log.jsonl`, not to stderr, which the bridge passes on.

import fs from 'node:fs'
import path from 'node:path'
import { createLog } from '../../src/common/log.mjs'
import { main } from '../../src/mail/reader.mjs'
import { createFakeMailbox } from './fake-mailbox.mjs'

const control = path.join(path.dirname(process.argv[1]), '..', 'stub-mail')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(control, 'calls.jsonl'), `${JSON.stringify({ args, env: process.env, uid: process.getuid(), gid: process.getgid(), pid: process.pid })}\n`)

const read = () => JSON.parse(fs.readFileSync(path.join(control, 'mailbox.json'), 'utf8'))
const settings = read()
const mailbox = createFakeMailbox({ uidValidity: settings.uidValidity, uidNext: settings.uidNext })
let delivered = 0
function deliverNew(notify) {
  const { messages } = read()
  for (; delivered < messages.length; delivered++) {
    const { file, arrivedAt } = messages[delivered]
    mailbox.deliver(fs.readFileSync(path.join(control, file)), { arrivedAt, notify })
  }
}
deliverNew(false)
const watching = setInterval(() => deliverNew(true), 20)
if (settings.connectFails) mailbox.failNext('connect', 'ECONNREFUSED')

const log = createLog({ component: 'mail', write: line => fs.appendFileSync(path.join(control, 'log.jsonl'), line) })
const code = await main(args, { openMailbox: () => mailbox.openMailbox(), log })
clearInterval(watching)
process.exit(code)
