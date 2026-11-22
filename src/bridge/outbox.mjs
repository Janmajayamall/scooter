// Delivery: the bridge's side of the outbox.
//
// The runner, and the bridge itself, ask for messages to be sent by writing entries to
// `exchange/outbox/` (`src/common/outbox.mjs`). This module sends them:
//
// - **Order.** It looks at the folder every `POLL_INTERVAL` and takes the entries in the order of
//   their IDs, which is the order they were made. An entry that can't go out yet holds back the
//   ones after it.
// - **Routing.** It finds the channel from the line the entry points at (`routeEntry`): a reply
//   goes to its line's channel if that channel can send, quoting the line when the entry has
//   `replyTo`; everything else goes to `DEFAULT_CHANNEL`. A reaction to an email becomes a text.
// - **Chunking.** A text goes out as messages of at most `CHUNK_CHARS` characters, cut at a
//   paragraph or line break where there is one (`splitText`). Only the first quotes.
// - **Pacing.** At most one message every `SEND_INTERVAL`, reactions included, whatever channel.
// - **Recording.** After each message that goes out, an `out` line is appended to the datastore,
//   with the channel as `source` and the ID the channel gave it as `sourceId`. The entry is
//   deleted once all of it has gone.
// - **Two outboxes.** The runner writes its entries to `exchange/outbox/`, and the bridge its own,
//   its backup notices, to `bridge/outbox/`, in the same form. The entries of both are
//   taken together, in the order of their IDs.
// - **Crash safety**. Before the first message goes, the bridge records the entry and how
//   many of its messages have gone out, and writes the record again after each one, once its `out`
//   line is in the datastore. After a crash the entry is sent again from the first message the
//   record doesn't count as sent, a reaction included. So a crash can send one message twice, and
//   never loses one. The record is also written just before each message goes, with the count it
//   already has: if that fails, as on a full disk, nothing is sent, since what was sent couldn't be
//   recorded, and a bridge that restarted for it would send the same message again at every start.
//   A message whose `out` line the store refuses is counted as sent all the same, for the same
//   reason, and the bridge stops.
// - **Where the record is**. The bridge, as root, writes nothing in the runner's outbox,
//   whose user could put a link in an entry's place, or the outbox's, between the bridge's look and
//   its write, and so steer the write anywhere. It keeps the record of a runner's entry in its own
//   folder, as `bridge/sending/<id>.json`, which wins over what the entry's folder holds from then
//   on, and goes once the entry's folder has. The record of one of its own entries is
//   `sending.json` in the entry's folder in `bridge/outbox/`, which only root can write.
// - **Failures.** While the entry's channel isn't ready, such as wacli waiting to be paired, the
//   entry waits, and so do the ones after it. A send that fails is tried again after a wait that
//   doubles, from `SEND_RETRY_BACKOFF.first` to its `max`; from the middle try on, a text goes
//   without its quote, in case the quoted message is what the channel can't find. An entry that
//   has failed `SEND_ATTEMPTS` times while the channel was ready no longer holds back the ones after
//   it: it is still tried first, at every look, but when it fails the look goes on to the next. It
//   is given up on, and logged, only when a message of a later entry has gone out since, which
//   shows that the channel works, and its own try after that fails too; a message going out past
//   it starts the look over, so that try comes next. Before an entry behind ones passed over is
//   tried, they are tried again, in order, whatever their own waits. So an outage, during which
//   nothing goes out, gives up on nothing, and the entries then go in order: the channel says it
//   is ready while wacli reconnects, and only a send shows that it isn't. An entry with nothing
//   behind it holds nothing back, and is tried again after the longest wait. A look at the outbox
//   that fails for another reason, such as a full disk, is tried again after the same waits.
// - **Pausing.** `pause()` stops it between two messages, for a backup, and `resume()`
//   starts it again.
//
// The runner's user owns its outbox and writes the entries. The bridge, as root, takes them only
// while the outbox is the runner's folder and not a link, reads each file without following a link,
// and checks it (`checkOutboxEntry`); an entry that isn't one is logged and removed. It takes only
// folders named as `createIds` names them, since it names its record after the entry, and leaves
// any other name, logged once. It removes an entry only by the names one holds, which in the
// runner's outbox is `entry.json` alone, and leaves what isn't a folder, logged once. While the
// runner's outbox isn't one to take from, the bridge's own entries still go. Logs name entries by
// their ID and never hold their text.

import fs from 'node:fs'
import path from 'node:path'
import { TMP_PREFIX, checkOwnFolder, ensureDir, isId, listHandOffs, readUntrustedFile, removeHandOff, writeFileAtomic } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { ENTRY_FILE, SENDING_FILE, checkOutboxEntry, checkSendingFile, cutText, orderedEntry } from '../common/outbox.mjs'
import { isoSeconds, systemClock } from '../common/time.mjs'

// ---------------------------------------------------------------------------------------------
// Chunking

const isSpace = char => char === ' ' || char === '\t' || char === '\n' || char === '\r'

// The messages a text goes out as: pieces of at most `max` characters, a character being a Unicode
// code point, as `TEXT_MAX_CHARS` counts them. A piece that would be too long is cut at the last
// paragraph break in its second half, or else the last line break there, or else the last space,
// or else where the limit falls; looking only in the second half keeps every piece but the last at
// least half full. The breaks where it is cut, and blank lines at the start of a piece, are left
// out, and so is a piece with nothing but spaces in it.
export function splitText(text, max = limits.CHUNK_CHARS) {
  const chars = [...text]
  const pieces = []
  const keep = (from, to) => {
    const piece = chars.slice(from, to).join('').replace(/^[\r\n]+/, '').trimEnd()
    if (piece.trim() !== '') pieces.push(piece)
  }
  const breaks = [
    i => chars[i - 1] === '\n' && (chars[i - 2] === '\n' || (chars[i - 2] === '\r' && chars[i - 3] === '\n')),
    i => chars[i - 1] === '\n',
    i => isSpace(chars[i - 1]),
  ]
  let start = 0
  while (start < chars.length) {
    if (chars.length - start <= max) {
      keep(start, chars.length)
      break
    }
    const end = start + max
    const half = start + Math.floor(max / 2)
    let cut = end
    search: for (const isBreak of breaks) {
      for (let i = end; i > half; i--) {
        if (isBreak(i)) {
          cut = i
          break search
        }
      }
    }
    keep(start, cut)
    start = cut
  }
  return pieces
}

// ---------------------------------------------------------------------------------------------
// Routing

// The message a line is, or changes: a message is itself, and an edit or a deletion is the message
// it changes. Null for anything else.
function messageOf(index, seq) {
  const line = index.get(seq)?.line
  if (!line) return null
  if (line.kind === 'message') return line
  if (line.kind !== 'edit' && line.kind !== 'delete') return null
  const target = index.get(line.target)?.line
  return target?.kind === 'message' ? target : null
}

// Where an entry goes, and what goes there. `index` is the datastore's, `channels` a Map from each
// channel's name to the channel, and `defaultChannel` the name of `DEFAULT_CHANNEL`, which the
// bridge checked at startup can send. Returns one of:
//
//   { action: 'text', channel, text, quote }   `quote` is `{ seq, id }`, the line it quotes and
//                                              that line's channel ID, or null
//   { action: 'react', channel, target, id, emoji }
//   { action: 'drop', reason }
//
// - A `text` goes to the channel of the line `replyTo` or `about` names, if that channel is running
//   and can send, quoting the line when it is `replyTo`. An edit or a deletion is quoted as the
//   message it changes, and a line with no channel ID isn't quoted. Otherwise, for an email, a line
//   that doesn't exist, or a text with neither, it goes to `DEFAULT_CHANNEL`, unquoted.
// - A `react` goes to its target's channel, if it can react: the message the target is or changes,
//   by its channel ID. A reaction to an email becomes a text on `DEFAULT_CHANNEL`, such as
//   `✅ Email: Call with Sam`, so the owner knows it arrived. Scooter reacts only to the owner's
//   messages, so a reaction to a line it sent itself, to a reaction, or to a line that doesn't
//   exist is dropped, and so is one whose channel can't react.
export function routeEntry(entry, { index, channels, defaultChannel }) {
  const fallback = channels.get(defaultChannel)
  if (entry.type === 'text') {
    const pointer = entry.replyTo ?? entry.about
    const line = pointer === undefined ? null : (index.get(pointer)?.line ?? null)
    const channel = line === null ? null : channels.get(line.source)
    if (!channel?.canSend) return { action: 'text', channel: fallback, text: entry.text, quote: null }
    let quote = null
    if (entry.replyTo !== undefined) {
      const message = messageOf(index, entry.replyTo)
      if (message?.sourceId !== undefined && message.source === line.source) quote = { seq: message.seq, id: message.sourceId }
    }
    return { action: 'text', channel, text: entry.text, quote }
  }

  const line = index.get(entry.target)?.line
  if (!line) return { action: 'drop', reason: 'unknown target' }
  const message = messageOf(index, entry.target)
  if (message === null || message.dir !== 'in') return { action: 'drop', reason: "not one of the owner's messages" }
  if (message.source === 'email') {
    // Made here, after the entry was written, from a subject the datastore holds: cut as an entry's
    // text is. Intake already cuts a subject at `EMAIL_SUBJECT_MAX_CHARS`.
    const subject = (message.subject ?? '').replace(/\s+/g, ' ').trim() || '(no subject)'
    return { action: 'text', channel: fallback, text: cutText(`${entry.emoji} Email: ${subject}`), quote: null }
  }
  const channel = channels.get(message.source)
  if (!channel?.canReact || message.sourceId === undefined) return { action: 'drop', reason: "its channel can't react" }
  return { action: 'react', channel, target: message.seq, id: message.sourceId, emoji: entry.emoji }
}

// ---------------------------------------------------------------------------------------------
// The processor

// The names an entry folder holds, the only names the bridge removes in one: in the runner's
// outbox, its `entry.json` alone, since the bridge writes nothing there; in the
// bridge's own, also the `sending.json` the bridge makes of it, and what a write of that one cut
// short leaves (`writeFileAtomic`).
const isRunnerEntryFile = name => name === ENTRY_FILE
const isOwnEntryFile = name => name === ENTRY_FILE || name === SENDING_FILE || name.startsWith(`${TMP_PREFIX}${SENDING_FILE}-`)

// The IDs of the entries whose record is in `bridge/sending/`, as `<id>.json`. Unfinished writes
// start with a dot, and aren't listed.
const RECORD_SUFFIX = '.json'
function listRecords(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return names.filter(name => !name.startsWith('.') && name.endsWith(RECORD_SUFFIX)).map(name => name.slice(0, -RECORD_SUFFIX.length))
}

// Returns the processor. Options:
// - `paths`: what `makePaths` returns; the entries are in `paths.outbox`, the runner's, and
//   `paths.bridgeOutbox`, the bridge's own, and the records of the runner's in `paths.bridgeSending`.
// - `owner`: `{ uid, gid }` of the runner's user, who owns the runner's outbox, or null when the
//   bridge isn't root.
// - `store`: the open store (`store.mjs`), which logs the `out` lines and whose index routing reads.
// - `channels`: a Map from each channel's name to the channel; `defaultChannel`, a name in it.
// - `onFatal(error)`: called once if the store stops taking lines. Delivery stops with it.
//
// `start()` starts the loop, `stop()` stops it, cutting short a send in progress, which is then
// sent again at the next start. `pause()` resolves once no message is going out, and none will
// until `resume()`.
export function createOutbox({ paths, store, channels, defaultChannel, log, clock = systemClock, owner = null, onFatal = () => {} }) {
  let lastSend = -Infinity
  let paused = false
  let broken = false
  // When the next look may be made, after a look that failed.
  let retryAt = -Infinity
  let lookFailures = 0
  // The failed tries of each entry's message in flight, by entry ID: `{ part, failures, due }`,
  // `due` being when it may be tried again.
  const troubles = new Map()
  // The entries that had failed `SEND_ATTEMPTS` times when a message of a later entry went out:
  // their next failure gives them up.
  const lastChance = new Set()
  // How many messages have gone out, so a look can tell whether an entry sent any.
  let sends = 0
  // What the bridge left in the outbox, by name, so it is logged once: what isn't a folder, or
  // couldn't be removed.
  const left = new Set()
  // The channel whose entries are waiting until it is ready, so that is logged once.
  let waitingFor = null
  // The names in the runner's outbox that aren't entries' IDs, so each is logged once; and why the
  // runner's outbox isn't taken from, so that is logged once.
  const strangers = new Set()
  let refusedRunners = null
  let round = Promise.resolve()
  let running = null

  // An entry, as the look lists it: `{ key, id, own }`, where `own` is true for one of the bridge's
  // own, in `bridge/outbox/`, and false for one of the runner's.
  const item = (id, own) => ({ key: `${own ? 'bridge' : 'runner'}/${id}`, id, own })
  // The entry's folder, and the bridge's record of it.
  const folderOf = ({ id, own }) => path.join(own ? paths.bridgeOutbox : paths.outbox, id)
  const recordOf = target => (target.own ? path.join(folderOf(target), SENDING_FILE) : path.join(paths.bridgeSending, `${target.id}${RECORD_SUFFIX}`))

  // Reads one JSON file of an entry: `{ value }`, `{ missing }`, or `{ refused }`, why it can't be
  // taken. Every file is read without following a link: the runner's user controls its outbox, and
  // the records are root's, which the same reading costs nothing.
  function readEntryFile(file, check) {
    let text
    try {
      text = readUntrustedFile(file, { maxBytes: limits.OUTBOX_ENTRY_MAX_BYTES })
    } catch (error) {
      if (error.code === 'ENOENT') return { missing: true }
      return { refused: `${path.basename(file)} can't be read (${error.code ?? error.name})` }
    }
    let value
    try {
      value = JSON.parse(text)
    } catch {
      return { refused: `${path.basename(file)} is not JSON` }
    }
    const problems = check(value)
    if (problems.length > 0) return { refused: `${path.basename(file)}: ${problems.join('; ')}` }
    return { value }
  }

  // Reads an entry: `{ entry, sent }`, or `{ refused }`, why it isn't one, with `leave` when it
  // isn't a folder, and so isn't removed. The bridge's record wins over the entry's folder: once it
  // has taken an entry, what the runner's user does to the folder changes nothing it sends. An entry
  // without a record gets one here, before anything of it goes out.
  function load(target) {
    const record = readEntryFile(recordOf(target), checkSendingFile)
    if (record.refused) return { refused: record.refused }
    if (record.value) return { entry: record.value.entry, sent: record.value.sent }
    const dir = folderOf(target)
    let stat
    try {
      stat = fs.lstatSync(dir)
    } catch (error) {
      return { refused: `the entry can't be opened (${error.code})`, leave: true }
    }
    if (!stat.isDirectory()) return { refused: 'the entry is not a folder', leave: true }
    const file = readEntryFile(path.join(dir, ENTRY_FILE), checkOutboxEntry)
    if (file.refused) return { refused: file.refused }
    if (file.missing) return { refused: `there is no ${ENTRY_FILE}` }
    writeRecord(target, file.value, 0)
    return { entry: file.value, sent: 0 }
  }

  function writeRecord(target, entry, sent) {
    if (!target.own) ensureDir(paths.bridgeSending, { mode: 0o700 })
    writeFileAtomic(recordOf(target), `${JSON.stringify({ entry: orderedEntry(entry), sent })}\n`, { mode: 0o600 })
  }

  // Removes an entry. The runner's user owns its outbox and writes the entries, and could put a
  // link in an entry's place, or the outbox's, at any moment: the bridge removes an entry only by
  // the names one holds, then the folder once it is empty (`removeHandOff`). One that holds
  // anything else, or has been made something else meanwhile, such as a link, is left, and logged
  // once. The record of a runner's entry goes once nothing is left of the entry to take again: its
  // folder is gone, or is no folder any more, or holds no `entry.json`. Before, the entry would be
  // taken again, and sent from its start.
  function remove(target) {
    if (left.has(target.key)) return
    const dir = folderOf(target)
    let taken = true
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw Object.assign(new Error('the entry is not a folder any more'), { code: 'ENOTDIR' })
      removeHandOff(dir, target.own ? isOwnEntryFile : isRunnerEntryFile)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.warn('outbox.not_removed', { entry: target.id, ...(target.own ? { own: true } : {}), ...errorFields(error) })
        left.add(target.key)
        taken = error.code === 'ENOTEMPTY' || error.code === 'ENOTDIR'
      }
    }
    if (taken && !target.own) fs.rmSync(recordOf(target), { force: true })
  }

  // Waits until a message may go out: `SEND_INTERVAL` after the last one tried.
  async function pace(signal) {
    const wait = lastSend + limits.SEND_INTERVAL - clock.now()
    if (wait > 0) await clock.sleep(wait, { signal })
  }

  // The `out` line for a message that went out.
  function outLine(route, entry, parts, part, sourceId, quoted) {
    const base = { dir: 'out', at: isoSeconds(clock.now()), source: route.channel.name, ...(sourceId !== null ? { sourceId } : {}), by: entry.by }
    if (route.action === 'react') return { ...base, kind: 'reaction', target: route.target, emoji: route.emoji }
    return { ...base, kind: 'message', ...(quoted ? { replyTo: route.quote.seq } : {}), text: parts[part - 1] }
  }

  // A send failed. Counts it when the channel is still ready, so a link that went down doesn't
  // use up the entry's tries, and gives the entry up when it was its last chance. Returns `wait`;
  // `pass` once it has failed `SEND_ATTEMPTS` times, to go on with the entries after it; or `next`
  // once it has been given up on.
  function failed({ target, entry, route, part, parts, error }) {
    const { key } = target
    let trouble = troubles.get(key)
    if (trouble?.part !== part) {
      trouble = { part, failures: 0, due: -Infinity }
      troubles.set(key, trouble)
    }
    if (route.channel.ready()) trouble.failures += 1
    const fields = { entry: target.id, type: entry.type, part, parts: parts.length, channel: route.channel.name, failures: trouble.failures }
    log.warn('outbox.send_failed', { ...fields, ...errorFields(error) })
    trouble.due = clock.now() + backoff(trouble.failures)
    if (lastChance.has(key)) {
      log.error('outbox.given_up', { ...fields, by: entry.by })
      lastChance.delete(key)
      troubles.delete(key)
      remove(target)
      return 'next'
    }
    if (trouble.failures < limits.SEND_ATTEMPTS) return 'wait'
    if (trouble.failures === limits.SEND_ATTEMPTS) log.warn('outbox.passed_over', { ...fields, by: entry.by })
    return 'pass'
  }

  // The wait after the `n`th failure in a row.
  function backoff(n) {
    const { first, factor, max } = limits.SEND_RETRY_BACKOFF
    return Math.min(first * factor ** Math.max(0, n - 1), max)
  }

  // Sends one entry, or what is left of it. Returns `next` when it is done with, `wait` when it
  // must wait: for its channel, for a try after a failed send, or for a pause or a stop; and `pass`
  // when it failed and no longer holds back the entries after it.
  async function deliver(target, signal) {
    const { id, key } = target
    const loaded = load(target)
    if (loaded.refused) {
      log.warn('outbox.refused', { entry: id, reason: loaded.refused, ...(loaded.leave ? { left: true } : {}) })
      if (loaded.leave) left.add(key)
      else remove(target)
      return 'next'
    }
    const { entry } = loaded
    let { sent } = loaded
    const route = routeEntry(entry, { index: store.index, channels, defaultChannel })
    if (route.action === 'drop') {
      log.warn('outbox.dropped', { entry: id, type: entry.type, target: entry.target, reason: route.reason })
      remove(target)
      return 'next'
    }
    const parts = route.action === 'react' ? [route.emoji] : splitText(route.text)

    while (sent < parts.length) {
      if (!route.channel.ready()) {
        if (waitingFor !== route.channel.name) log.info('outbox.waiting', { channel: route.channel.name, entry: id })
        waitingFor = route.channel.name
        return 'wait'
      }
      waitingFor = null
      await pace(signal)
      if (paused || signal.aborted) return 'wait'
      // Nothing goes out that couldn't be recorded. A failure here fails the look.
      writeRecord(target, entry, sent)
      const part = sent + 1
      // From the middle try on, a text goes without its quote.
      const trouble = troubles.get(key)
      const tries = trouble?.part === part ? trouble.failures : 0
      const quoted = route.action === 'text' && part === 1 && route.quote !== null && tries < Math.ceil(limits.SEND_ATTEMPTS / 2)
      let sourceId
      try {
        lastSend = clock.now()
        sourceId =
          route.action === 'react'
            ? await route.channel.react(route.id, route.emoji, { signal })
            : await route.channel.sendText(parts[part - 1], quoted ? route.quote.id : null, { signal })
      } catch (error) {
        if (signal.aborted) return 'wait'
        return failed({ target, entry, route, part, parts, error })
      }
      troubles.delete(key)
      lastChance.delete(key)
      sends += 1
      if (sourceId === null) log.warn('outbox.no_id', { entry: id, channel: route.channel.name })

      let result = null
      let storeError = null
      try {
        const line = outLine(route, entry, parts, part, sourceId, quoted)
        result = await store.append(line)
        // The store holds a line with that ID already: the channel gave the ID of something else,
        // such as the message reacted to. The message went out all the same, and the record keeps
        // it, without the ID, which an `out` line may leave out.
        if (!result.stored) {
          log.warn('outbox.id_taken', { entry: id, part, channel: route.channel.name, reason: result.reason })
          const { sourceId: _, ...withoutId } = line
          result = await store.append(withoutId)
        }
      } catch (error) {
        storeError = error
      }
      sent = part
      if (storeError !== null) {
        // The store takes no more lines, and the bridge restarts. The message went out, and
        // counts as sent, so the restart doesn't send it again; its `out` line is missing.
        broken = true
        log.error('outbox.store_failed', { entry: id, part, ...errorFields(storeError) })
        onFatal(storeError)
      }
      // The last message too, so that a crash while the entry is removed sends nothing again.
      writeRecord(target, entry, sent)
      if (sent === parts.length) remove(target)
      if (storeError !== null) return 'wait'
      log.info('outbox.sent', { entry: id, type: entry.type, by: entry.by, part, parts: parts.length, channel: route.channel.name, seq: result.seq, quoted })
      if (paused) return 'wait'
    }
    // Also an entry a crash cut short after its last message was recorded.
    remove(target)
    return 'next'
  }

  // The runner's entries: those in its outbox, by the names `createIds` gives, and those the bridge
  // has a record of. Each other name in the outbox is logged once and left. The runner's user owns
  // the folder above its outbox, and could put a link in its place: then none of the runner's
  // entries is taken, not even one the bridge has a record of, whose removal would reach through
  // the link, and that is logged once.
  function runnerEntries() {
    let names = []
    let there = true
    try {
      checkOwnFolder(paths.outbox, owner)
      names = listHandOffs(paths.outbox)
    } catch (error) {
      if (error.code === 'EUNTRUSTED') {
        if (refusedRunners !== error.message) log.error('outbox.runner_outbox_refused', { reason: error.message })
        refusedRunners = error.message
        return []
      }
      if (error.code !== 'ENOENT') throw error
      there = false
    }
    // Said once it is taken from again, not while it isn't there.
    if (there && refusedRunners !== null) {
      log.info('outbox.runner_outbox_taken')
      refusedRunners = null
    }
    const ids = names.filter(isId)
    const others = new Set(names.filter(name => !isId(name)))
    for (const name of strangers) if (!others.has(name)) strangers.delete(name)
    for (const name of others) {
      if (strangers.has(name)) continue
      strangers.add(name)
      log.warn('outbox.not_an_entry', { name: name.slice(0, limits.LOGGED_NAME_MAX_CHARS), bytes: Buffer.byteLength(name) })
    }
    return [...ids, ...listRecords(paths.bridgeSending)]
  }

  // The entries waiting, in the order of their IDs: the runner's, in its outbox or with a record
  // of the bridge's, and the bridge's own. Of two with the same ID, the bridge's goes first.
  function listEntries() {
    const all = new Map()
    for (const id of runnerEntries()) all.set(`runner/${id}`, item(id, false))
    for (const id of listHandOffs(paths.bridgeOutbox)) all.set(`bridge/${id}`, item(id, true))
    return [...all.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : Number(b.own) - Number(a.own)))
  }

  // One look at the outbox: the entries in order, until one has to wait.
  // - An entry passed over that isn't due waits on its own, and the look goes on; one not passed
  //   over yet that isn't due holds back the entries after it.
  // - Before an entry behind ones passed over is tried, those are tried again, in order, whatever
  //   their waits: should sends work again, they go first, and the entries keep their order.
  // - When a message goes out past entries passed over that failed again, the channel works: each
  //   of them gets one last try, and the look starts over so that it comes next.
  async function look(signal) {
    if (paused || broken || clock.now() < retryAt) return
    const entries = listEntries()
    const listed = new Set(entries.map(target => target.key))
    for (const key of troubles.keys()) if (!listed.has(key)) troubles.delete(key)
    for (const key of lastChance) if (!listed.has(key)) lastChance.delete(key)
    for (const key of left) if (!listed.has(key)) left.delete(key)
    // Passed over, and failed again in this look.
    const passed = []
    // Passed over, and not tried yet in this look.
    let waiting = []
    // Tries one entry. Returns whether the look goes on.
    async function attempt(target) {
      const before = sends
      const outcome = await deliver(target, signal)
      if (outcome === 'pass') {
        passed.push(target.key)
        return true
      }
      if (sends > before && passed.length > 0) {
        for (const other of passed) {
          lastChance.add(other)
          troubles.get(other).due = -Infinity
        }
        return false
      }
      return outcome !== 'wait'
    }
    entries: for (const target of entries) {
      if (left.has(target.key)) continue
      const trouble = troubles.get(target.key)
      if (trouble && clock.now() < trouble.due) {
        if (trouble.failures < limits.SEND_ATTEMPTS) break
        waiting.push(target)
        continue
      }
      const turn = [...waiting, target]
      waiting = []
      for (const next of turn) {
        if (paused || broken || signal.aborted || !(await attempt(next))) break entries
      }
    }
    lookFailures = 0
  }

  async function loop(signal) {
    for (;;) {
      round = look(signal).catch(error => {
        if (signal.aborted) return
        // The disk, or a bug. The entry stays, and is tried again after a wait that grows.
        lookFailures += 1
        retryAt = clock.now() + backoff(lookFailures)
        log.error('outbox.failed', { failures: lookFailures, ...errorFields(error) })
      })
      await round
      if (broken || signal.aborted) return
      try {
        await clock.sleep(limits.POLL_INTERVAL, { signal })
      } catch {
        return
      }
    }
  }

  return {
    start() {
      if (running) return
      const controller = new AbortController()
      running = { controller, done: loop(controller.signal) }
    },

    async stop() {
      if (!running) return
      const { controller, done } = running
      running = null
      controller.abort()
      await done
    },

    // Resolves once no message is going out, and none will until `resume()`.
    async pause() {
      paused = true
      await round
    },

    resume() {
      paused = false
    },

    // Resolves when the look in progress is over. For tests.
    idle: () => round,
  }
}
