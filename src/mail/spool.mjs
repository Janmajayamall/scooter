// The email reader's folder (5.6 of DESIGN.md): the spool it hands emails over through, and its
// position in the mailbox.
//
// The folder is the reader's home, `/data/mail`, which only `scooter-mail` and root can read
// (3.2). The bridge takes the spool's folders in order, and reads `state.json` for `/status`. The
// names here are a contract with `src/bridge/channels/email.mjs`, which can't import this module
// (ARCHITECTURE.md 4.2): the bridge treats what is here as untrusted, and checks it.
//
// A spool folder, `spool/<id>/`, written as `spool/.tmp-<id>/` and renamed once complete, with IDs
// that sort in the order the emails were handed over (`handOff` in `src/common/files.mjs`):
//
//   message.eml   the raw message, or only its header block when it wasn't fetched whole
//   parsed.json   what the reader made of it (below)
//   part-1 …      the attachments, in the order `parsed.json` lists them
//
//   {"uid":1042,"uidValidity":3857529045,"arrivedAt":"2026-11-09T16:12:40Z","size":19262388,
//    "fetched":"whole","parsed":true,"subject":"Call with Sam","text":"Recording from today's call.",
//    "attachments":[{"name":"Call with Sam.m4a","mime":"audio/mp4","bytes":14206977}]}
//
// - `uid` and `uidValidity` name the message in the mailbox; `arrivedAt` is when the mailbox got
//   it (its INTERNALDATE), and `size` its size there.
// - `fetched` is `whole`, or `headers` for a message that isn't from one of the owner's addresses
//   or is over `ATTACHMENT_MAX_BYTES`: the bridge then has its headers, to log and count it.
// - `parsed` is false when postal-mime couldn't parse it; `message.eml` is then the raw message,
//   and the subject, text and attachments are empty.
// - `subject` and `text` are at most one character longer than where the bridge cuts them, so the
//   bridge can tell that a cut is due.
//
// `state.json`, the reader's position:
//
//   {"uidValidity":3857529045,"next":1043,"newest":"2026-11-09T16:12:40Z","parsing":null,
//    "connected":true,"checkedAt":"2026-11-09T16:13:00Z"}
//
// - `next` is the UID after the last message handed over; `newest` is when the newest message
//   handed over arrived, from which a renumbered mailbox is read again.
// - `parsing` is the UID of the message being parsed, null otherwise. A reader that finds it set at
//   a start ended while parsing that message, and hands it over unparsed.
// - `connected` and `checkedAt` are for `/status`: whether the reader has the mailbox open, and when
//   it last looked for new mail.

import fs from 'node:fs'
import path from 'node:path'
import { TMP_PREFIX, ensureDir, handOff, writeFileAtomic } from '../common/files.mjs'

export const SPOOL_FOLDER = 'spool'
export const STATE_FILE = 'state.json'
export const MESSAGE_FILE = 'message.eml'
export const PARSED_FILE = 'parsed.json'
export const PART_PREFIX = 'part-'

// The spool, made 0700 if it is missing, with what a reader that stopped while handing an email
// over left in it removed: a folder counts only once it is renamed, and the email is handed over
// again, since `next` moves only after the rename.
export function openSpool(home) {
  const spool = path.join(home, SPOOL_FOLDER)
  ensureDir(spool, { mode: 0o700 })
  for (const name of fs.readdirSync(spool)) {
    if (name.startsWith(TMP_PREFIX)) fs.rmSync(path.join(spool, name), { recursive: true, force: true })
  }
  return spool
}

// Hands an email over: `raw`, the message or its header block, as a Buffer; `description`, what
// goes into `parsed.json`; and `parts`, the attachments' contents, in order. Returns the folder's ID.
export function writeSpoolFolder(spool, ids, { raw, description, parts }) {
  return handOff(spool, ids, dir => {
    const write = (name, data) => fs.writeFileSync(path.join(dir, name), data, { mode: 0o600, flag: 'wx' })
    write(MESSAGE_FILE, raw)
    parts.forEach((content, n) => write(`${PART_PREFIX}${n + 1}`, content))
    write(PARSED_FILE, `${JSON.stringify(description)}\n`)
  })
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

// The position: `{ position, damaged }`. `position` is null when there is none yet, the first time
// email is on, and also when the file isn't a position, which only something other than the reader
// can make, since it is written atomically; `damaged` says which. Either way the reader starts from
// the mailbox's `UIDNEXT` (5.6).
export function readPosition(home) {
  let value
  try {
    value = JSON.parse(fs.readFileSync(path.join(home, STATE_FILE), 'utf8'))
  } catch (error) {
    return { position: null, damaged: error.code !== 'ENOENT' }
  }
  const uid = number => Number.isSafeInteger(number) && number > 0
  // The reader writes `connected` and `checkedAt` before it first opens the mailbox, so a position
  // without a mailbox yet is one with no `uidValidity`.
  if (isObject(value) && value.uidValidity === null && value.next === null) return { position: null, damaged: false }
  if (!isObject(value) || !uid(value.uidValidity) || !uid(value.next)) return { position: null, damaged: true }
  const position = {
    uidValidity: value.uidValidity,
    next: value.next,
    newest: typeof value.newest === 'string' ? value.newest : null,
    parsing: uid(value.parsing) ? value.parsing : null,
    connected: false,
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
  }
  return { position, damaged: false }
}

export function writePosition(home, position) {
  writeFileAtomic(path.join(home, STATE_FILE), `${JSON.stringify(position)}\n`, { mode: 0o600 })
}
