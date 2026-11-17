// Delivery: the bridge's side of the outbox (5.3 of DESIGN.md; ARCHITECTURE.md 5.3).
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
//   with the channel as `source` and the ID the channel gave it as `sourceId` (4.2). The entry is
//   deleted once all of it has gone.
// - **Crash safety** (row 3). Before the first message goes, `entry.json` becomes `sending.json`,
//   which holds the entry and how many of its messages have gone out, and is written again after
//   each one, once its `out` line is in the datastore. After a crash the entry is sent again from
//   the first message it doesn't record as sent, a reaction included. So a crash can send one
//   message twice, and never loses one. `sending.json` is also written just before each message
//   goes, with the count it already has: if that fails, as on a full disk, nothing is sent, since
//   what was sent couldn't be recorded, and a bridge that restarted for it would send the same
//   message again at every start. A message whose `out` line the store refuses is counted as sent
//   all the same, for the same reason, and the bridge stops (D29).
// - **Failures.** While the entry's channel isn't ready, such as wacli waiting to be paired, the
//   entry waits, and so do the ones after it. A send that fails is tried again after a wait that
//   doubles, from `SEND_RETRY_BACKOFF.first` to its `max`; from the middle try on, a text goes
//   without its quote, in case the quoted message is what the channel can't find. After
//   `SEND_ATTEMPTS` failed tries made while the channel was ready, the entry is given up on and
//   logged, so that one which can never go out doesn't hold back every reply after it. A look at
//   the outbox that fails for another reason, such as a full disk, is tried again after the same
//   waits.
// - **Pausing.** `pause()` stops it between two messages, for a backup (5.5), and `resume()`
//   starts it again.
//
// The runner's user writes the entries. The bridge, as root, reads each file without following a
// link, and checks it (`checkOutboxEntry`); an entry that isn't one is logged and removed. Logs
// name entries by their ID and never hold their text.

import fs from 'node:fs'
import path from 'node:path'
import { listHandOffs, readUntrustedFile, writeFileAtomic } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { ENTRY_FILE, SENDING_FILE, checkOutboxEntry, checkSendingFile, orderedEntry } from '../common/outbox.mjs'
import { isoSeconds, systemClock } from '../common/time.mjs'

// ---------------------------------------------------------------------------------------------
// Chunking (5.3)

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
// Routing (5.3)

// The message a line is, or changes: a message or a command is itself, and an edit or a deletion
// is the message it changes. Null for anything else.
function messageOf(index, seq) {
  const line = index.get(seq)?.line
  if (!line) return null
  if (line.kind === 'message' || line.kind === 'command') return line
  if (line.kind !== 'edit' && line.kind !== 'delete') return null
  const target = index.get(line.target)?.line
  return target && (target.kind === 'message' || target.kind === 'command') ? target : null
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
    const subject = (message.subject ?? '').replace(/\s+/g, ' ').trim() || '(no subject)'
    return { action: 'text', channel: fallback, text: `${entry.emoji} Email: ${subject}`, quote: null }
  }
  const channel = channels.get(message.source)
  if (!channel?.canReact || message.sourceId === undefined) return { action: 'drop', reason: "its channel can't react" }
  return { action: 'react', channel, target: message.seq, id: message.sourceId, emoji: entry.emoji }
}

// ---------------------------------------------------------------------------------------------
// The processor

// Returns the processor. Options:
// - `paths`: what `makePaths` returns; the entries are in `paths.outbox`.
// - `store`: the open store (`store.mjs`), which logs the `out` lines and whose index routing reads.
// - `channels`: a Map from each channel's name to the channel; `defaultChannel`, a name in it.
// - `onFatal(error)`: called once if the store stops taking lines (D29). Delivery stops with it.
//
// `start()` starts the loop, `stop()` stops it, cutting short a send in progress, which is then
// sent again at the next start. `pause()` resolves once no message is going out, and none will
// until `resume()`.
export function createOutbox({ paths, store, channels, defaultChannel, log, clock = systemClock, onFatal = () => {} }) {
  let lastSend = -Infinity
  let paused = false
  let broken = false
  // When the next try may be made, after a failed send or a failed look.
  let retryAt = -Infinity
  let lookFailures = 0
  // The failed tries of the message in flight: `{ id, part, failures }`.
  let trouble = null
  // The channel whose entries are waiting until it is ready, so that is logged once.
  let waitingFor = null
  let round = Promise.resolve()
  let running = null

  // Reads an entry folder: `{ entry, sent }`, or `{ refused }`, why it isn't one. An `entry.json`
  // becomes a `sending.json` here, before anything of it goes out.
  function load(dir) {
    let stat
    try {
      stat = fs.lstatSync(dir)
    } catch (error) {
      return { refused: `the entry can't be opened (${error.code})` }
    }
    if (!stat.isDirectory()) return { refused: 'the entry is not a folder' }
    for (const file of [SENDING_FILE, ENTRY_FILE]) {
      let text
      try {
        text = readUntrustedFile(path.join(dir, file), { maxBytes: limits.OUTBOX_ENTRY_MAX_BYTES })
      } catch (error) {
        if (error.code === 'ENOENT') continue
        return { refused: `${file} can't be read (${error.code ?? error.name})` }
      }
      let value
      try {
        value = JSON.parse(text)
      } catch {
        return { refused: `${file} is not JSON` }
      }
      const problems = file === SENDING_FILE ? checkSendingFile(value) : checkOutboxEntry(value)
      if (problems.length > 0) return { refused: `${file}: ${problems.join('; ')}` }
      if (file === SENDING_FILE) return { entry: value.entry, sent: value.sent }
      writeSending(dir, value, 0)
      fs.rmSync(path.join(dir, ENTRY_FILE), { force: true })
      return { entry: value, sent: 0 }
    }
    return { refused: `there is neither ${ENTRY_FILE} nor ${SENDING_FILE}` }
  }

  function writeSending(dir, entry, sent) {
    writeFileAtomic(path.join(dir, SENDING_FILE), `${JSON.stringify({ entry: orderedEntry(entry), sent })}\n`, { mode: 0o600 })
  }

  // The runner's user owns the outbox and writes the entries; the bridge removes what it has
  // read, without following links.
  const remove = dir => fs.rmSync(dir, { recursive: true, force: true })

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
  // use up the entry's tries, and gives the entry up after `SEND_ATTEMPTS`. Returns `wait`, or
  // `next` once it has been given up on.
  function failed({ id, dir, entry, route, part, parts, error }) {
    if (trouble?.id !== id || trouble.part !== part) trouble = { id, part, failures: 0 }
    if (route.channel.ready()) trouble.failures += 1
    const fields = { entry: id, type: entry.type, part, parts: parts.length, channel: route.channel.name, failures: trouble.failures }
    log.warn('outbox.send_failed', { ...fields, ...errorFields(error) })
    if (trouble.failures >= limits.SEND_ATTEMPTS) {
      log.error('outbox.given_up', { ...fields, by: entry.by })
      remove(dir)
      trouble = null
      return 'next'
    }
    retryAt = clock.now() + backoff(trouble.failures)
    return 'wait'
  }

  // The wait after the `n`th failure in a row.
  function backoff(n) {
    const { first, factor, max } = limits.SEND_RETRY_BACKOFF
    return Math.min(first * factor ** Math.max(0, n - 1), max)
  }

  // Sends one entry, or what is left of it. Returns `next` when it is done with, and `wait` when it
  // must wait: for its channel, for a try after a failed send, or for a pause or a stop.
  async function deliver(id, signal) {
    const dir = path.join(paths.outbox, id)
    const loaded = load(dir)
    if (loaded.refused) {
      log.warn('outbox.refused', { entry: id, reason: loaded.refused })
      remove(dir)
      return 'next'
    }
    const { entry } = loaded
    let { sent } = loaded
    const route = routeEntry(entry, { index: store.index, channels, defaultChannel })
    if (route.action === 'drop') {
      log.warn('outbox.dropped', { entry: id, type: entry.type, target: entry.target, reason: route.reason })
      remove(dir)
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
      writeSending(dir, entry, sent)
      const part = sent + 1
      // From the middle try on, a text goes without its quote.
      const tries = trouble?.id === id && trouble.part === part ? trouble.failures : 0
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
        return failed({ id, dir, entry, route, part, parts, error })
      }
      trouble = null
      if (sourceId === null) log.warn('outbox.no_id', { entry: id, channel: route.channel.name })

      let result = null
      let storeError = null
      try {
        result = await store.append(outLine(route, entry, parts, part, sourceId, quoted))
      } catch (error) {
        storeError = error
      }
      sent = part
      if (storeError !== null) {
        // The store takes no more lines (D29), and the bridge restarts. The message went out, and
        // counts as sent, so the restart doesn't send it again; its `out` line is missing.
        broken = true
        log.error('outbox.store_failed', { entry: id, part, ...errorFields(storeError) })
        onFatal(storeError)
      }
      if (sent < parts.length) writeSending(dir, entry, sent)
      else remove(dir)
      if (storeError !== null) return 'wait'
      log.info('outbox.sent', { entry: id, type: entry.type, by: entry.by, part, parts: parts.length, channel: route.channel.name, seq: result.seq, quoted })
      if (paused) return 'wait'
    }
    // Also an entry a crash cut short after its last message was recorded.
    remove(dir)
    return 'next'
  }

  // One look at the outbox: the entries in order, until one has to wait.
  async function look(signal) {
    if (paused || broken || clock.now() < retryAt) return
    for (const id of listHandOffs(paths.outbox)) {
      if (paused || broken || signal.aborted) break
      if ((await deliver(id, signal)) === 'wait') break
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
