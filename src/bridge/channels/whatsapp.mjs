// The WhatsApp channel (5.1 and 5.2 of DESIGN.md; ARCHITECTURE.md 2.2).
//
// This is the only module that runs wacli. It:
// - runs every wacli call as `scooter-wacli`, with the environment of 5.1 and nothing else;
// - checks that wacli is paired, and keeps `wacli sync --follow` running while it is;
// - serves the webhook that sync posts each message to, on loopback, signed with a secret that is
//   new on every start;
// - catches up at startup and every 10 minutes by listing the owner's chat, since the webhook is
//   best-effort;
// - turns what wacli says into a normalized message, and drops everything that isn't the owner's
//   one-to-one chat before it reaches the core;
// - downloads media into wacli's staging folder, and copies it out with care;
// - sends texts, always with link previews off, and reactions, to the owner's chat (5.3).
//
// wacli is third-party code that talks to the outside world, so everything it says is input to
// check. Its formats are read in two functions only, `fromWebhook` and `fromListRow`. How it
// reports edits, deletions and `@lid` senders is known from its source, not yet from a paired
// number (gate G4), and a correction should touch nothing else.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { checkOwnFolder, copyUntrustedFile, createIds, ensureDir, startsWithId } from '../../common/files.mjs'
import { limits } from '../../common/limits.mjs'
import { createLog, errorFields } from '../../common/log.mjs'
import { makePaths } from '../../common/paths.mjs'
import { createProc } from '../../common/proc.mjs'
import { isoSeconds, parseIsoSeconds, systemClock } from '../../common/time.mjs'

const WACLI = 'wacli'
export const WEBHOOK_PATH = '/wacli'
export const SIGNATURE_HEADER = 'x-wacli-signature'

// The kinds of media that are a file to download. A location has none, and a sticker is dropped.
const FILE_MEDIA = ['image', 'video', 'gif', 'audio', 'document']
export const NOT_A_FILE = 'not a file, so not stored'

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringOf = value => (typeof value === 'string' ? value : '')

// ---------------------------------------------------------------------------------------------
// wacli's environment (5.1)

// Everything wacli is given: its own folders, UTC, and nothing else. Not even `PATH`: wacli is
// found on the bridge's own (D25).
export function wacliEnv(paths) {
  return {
    HOME: paths.wacli,
    WACLI_STORE_DIR: paths.wacliStore,
    XDG_CONFIG_HOME: paths.wacliConfig,
    XDG_STATE_HOME: paths.wacliState,
    XDG_CACHE_HOME: paths.wacliCache,
    TZ: 'UTC',
  }
}

// ---------------------------------------------------------------------------------------------
// The signature (5.2 step 1)

// Whether `header` is wacli's signature of `body` with `secret`: `sha256=` and the lowercase hex
// HMAC-SHA256 of the raw body (13.1), compared in constant time.
export function verifySignature(secret, body, header) {
  if (typeof header !== 'string') return false
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`)
  const given = Buffer.from(header)
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

// ---------------------------------------------------------------------------------------------
// wacli's two formats (13.1)
//
// Both become the normalized message of 5.2 step 3:
//   { chat, id, sender, at, fromMe, text, media, replyToId, replyToPreview, reactionToId,
//     reactionEmoji, edited, revoked, forwarded }
// where `media` is null or `{ type, caption, filename, mime, size }`, `at` is a UTC time to the
// second or null, the IDs are null when absent, and `reactionEmoji` is "" when there's none.

// A time as wacli writes one, RFC 3339, to the second. Null for anything else, including Go's zero
// time, `0001-01-01T00:00:00Z`.
function timeOf(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 ? isoSeconds(Math.floor(ms / 1000) * 1000) : null
}

const idOf = value => stringOf(value).trim() || null

// The text of a message. For media it is the caption: wacli puts a caption in `Text` too, but also
// a placeholder of its own, `[Audio]`, for audio without one.
const textOf = (text, media) => (media ? media.caption : stringOf(text))

// A webhook payload: the fields of wacli's `ParsedMessage`, by their Go names, with `Media` in
// place of its own (`{Type, Caption, Filename, MimeType, FileLength}`) and `ChatName`.
//
// By wacli's source at v0.26.0 (`internal/wa/messages.go`), an edit comes with `Edited: true`, the
// ID of the message it changes and the new text, and a deletion with `Revoked: true` and the ID of
// the message deleted. Returns null for a payload that isn't a message with an ID.
//
// Not yet seen on a paired number (gate G4): the same source takes `Chat` and `FromMe` of an edit
// or a deletion from the key the sender's phone wrote, from the sender's side. So the owner's own
// deletion may well arrive with `FromMe: true` and the bot's JID as `Chat`, and be dropped as the
// bot's. If G4 finds it so, the correction is here: for an edit or a deletion from the owner, take
// the chat and `fromMe` from the sender (docs/DECISIONS.md, 3.3, point 1).
export function fromWebhook(payload) {
  if (!isObject(payload)) return null
  const id = idOf(payload.ID)
  if (id === null) return null
  const raw = payload.Media
  const media = isObject(raw)
    ? {
        type: stringOf(raw.Type),
        caption: stringOf(raw.Caption),
        filename: stringOf(raw.Filename),
        mime: stringOf(raw.MimeType),
        size: Number.isSafeInteger(raw.FileLength) && raw.FileLength > 0 ? raw.FileLength : null,
      }
    : null
  return {
    chat: stringOf(payload.Chat),
    id,
    sender: stringOf(payload.SenderJID),
    at: timeOf(payload.Timestamp),
    fromMe: payload.FromMe === true,
    text: textOf(payload.Text, media),
    media,
    replyToId: idOf(payload.ReplyToID),
    replyToPreview: stringOf(payload.ReplyToDisplay) || null,
    reactionToId: idOf(payload.ReactionToID),
    reactionEmoji: stringOf(payload.ReactionEmoji),
    edited: payload.Edited === true,
    revoked: payload.Revoked === true,
    forwarded: payload.IsForwarded === true,
  }
}

// A row of `messages list --json`: wacli's stored message, `ChatJID`, `MsgID`, `SenderJID`,
// `Timestamp`, `FromMe`, `Text`, `quoted_msg_id`, `ReactionToID`, `ReactionEmoji`, `MediaType`,
// `MediaCaption`, `Filename`, `MimeType`, `IsForwarded`, `Edited`, `Revoked` and more. A row has
// no preview of what it quotes, and no size for its media.
//
// A row is the message as it is now. By wacli's source, an edit updates the stored message's text
// and sets `Edited`, so an edited row stands for two things: the message, and its edit. It is
// returned as both, in that order. If the message isn't stored yet it is stored with the text it
// has now, and the edit then changes nothing and is skipped; if it is, the message is a duplicate
// and the edit is stored. A deleted row is a deletion, and is skipped if its message isn't stored.
//
// Returns a list: empty for a row that isn't a message with an ID.
export function fromListRow(row) {
  if (!isObject(row)) return []
  const id = idOf(row.MsgID)
  if (id === null) return []
  const type = stringOf(row.MediaType)
  const media = type
    ? { type, caption: stringOf(row.MediaCaption), filename: stringOf(row.Filename), mime: stringOf(row.MimeType), size: null }
    : null
  const message = {
    chat: stringOf(row.ChatJID),
    id,
    sender: stringOf(row.SenderJID),
    at: timeOf(row.Timestamp),
    fromMe: row.FromMe === true,
    text: textOf(row.Text, media),
    media,
    replyToId: idOf(row.quoted_msg_id),
    replyToPreview: null,
    reactionToId: idOf(row.ReactionToID),
    reactionEmoji: stringOf(row.ReactionEmoji),
    edited: false,
    revoked: row.Revoked === true,
    forwarded: row.IsForwarded === true,
  }
  if (row.Edited === true && !message.revoked) return [message, { ...message, edited: true }]
  return [message]
}

// ---------------------------------------------------------------------------------------------
// The owner, and what is dropped (5.2 steps 4 and 5)

// A JID as Scooter compares it: lowercase, without the `:device` suffix, nor the `.agent` part that
// whatsmeow writes before it (`919812345678.0:12@s.whatsapp.net`).
export function canonicalJid(jid) {
  const text = stringOf(jid).trim().toLowerCase()
  const at = text.lastIndexOf('@')
  if (at < 0) return text
  return `${text.slice(0, at).replace(/(?:\.\d+)?(?::\d+)?$/, '')}${text.slice(at)}`
}

// The owner's IDs: `<number>@s.whatsapp.net`, `<number>@c.us`, and every ID in `OWNER_JIDS`.
export function ownerIds({ ownerNumber, ownerJids = [] }) {
  return new Set([`${ownerNumber}@s.whatsapp.net`, `${ownerNumber}@c.us`, ...ownerJids.map(canonicalJid)])
}

// Why a normalized message is dropped before it reaches the core, or null when it is the owner's:
// the bot's own, a group, broadcast or channel, someone other than the owner, a sticker, or
// nothing at all (5.2 step 4, 4.4).
export function dropReason(message, owners) {
  if (message.fromMe) return 'from the bot'
  if (/@(?:g\.us|broadcast|newsletter)$/.test(canonicalJid(message.chat))) return 'not a one-to-one chat'
  if (!owners.has(canonicalJid(message.sender))) return 'not the owner'
  if (message.media?.type === 'sticker') return 'a sticker'
  const empty = message.text.trim() === '' && !message.media && !message.reactionToId && !message.edited && !message.revoked
  if (empty) return 'empty'
  return null
}

// The record the core takes (`./index.mjs`): the message without its chat, sender and `fromMe`.
export function toRecord(message) {
  const isMessage = !message.edited && !message.revoked && message.reactionToId === null
  const attachments = []
  if (isMessage && message.media) {
    attachments.push({
      type: message.media.type,
      mime: message.media.mime || null,
      name: message.media.filename || null,
      bytes: message.media.size,
      error: FILE_MEDIA.includes(message.media.type) ? null : NOT_A_FILE,
    })
  }
  return {
    source: 'whatsapp',
    id: message.id,
    at: message.at,
    text: message.text,
    attachments,
    replyToId: message.replyToId,
    replyToPreview: message.replyToPreview,
    reactionToId: message.reactionToId,
    reactionEmoji: message.reactionToId === null ? null : message.reactionEmoji,
    edited: message.edited,
    revoked: message.revoked,
    forwarded: message.forwarded,
  }
}

// ---------------------------------------------------------------------------------------------
// The channel

// Returns the WhatsApp channel. Options:
// - `settings`: the bridge's settings; `ownerNumber` and `ownerJids` are used here.
// - `paths`: what `makePaths` returns.
// - `proc`: what `createProc` returns. Every wacli call goes through it.
// - `state`: the bridge's state (`../state.mjs`), for the owner's chat and the first start.
// - `user`: `{ uid, gid }` of `scooter-wacli`, or null when the bridge isn't root (section 10).
// - `newestIncomingAt()`: the `at` of the newest incoming WhatsApp line in the datastore, or null.
export function createWhatsApp({ settings, paths, proc, log, clock = systemClock, state, user = null, newestIncomingAt = () => null }) {
  const owners = ownerIds(settings)
  const env = wacliEnv(paths)
  const ids = createIds(clock)
  // The chat of each record handed over, for its download. A record carries no chat (5).
  const chats = new WeakMap()
  // `stopped`, `checking` (is wacli paired?), `unpaired`, `linked` (sync is running) or
  // `restarting` (sync exited and waits to start again).
  let link = 'stopped'
  let running = null

  // Runs wacli with `--json` and returns the `data` part of its answer (13.1). Rejects when it
  // fails, without repeating what it said: its errors can name chats and files. `signal` stops it,
  // and a call it stopped rejects with the code `ESTOPPED`. One that ended well as the signal came
  // is a success: a send that went out isn't sent again.
  async function wacli(args, { signal = null } = {}) {
    const result = await proc.run(WACLI, ['--json', ...args], { env, user, timeout: limits.WACLI_CALL_TIMEOUT, signal })
    const what = args.filter(arg => /^[a-z]+$/.test(arg)).slice(0, 2).join(' ')
    // The log shows the exit code and whether it timed out (`errorFields`), and nothing wacli wrote.
    const failure = (reason, code = 'EWACLI') => Object.assign(new Error(`wacli ${what}: ${reason}`), { code, exitCode: result.code, timedOut: result.timedOut })
    if (result.timedOut) throw failure('timed out')
    if (result.code !== 0) throw signal?.aborted ? failure('stopped', 'ESTOPPED') : failure(`exit code ${result.code}`)
    let answer
    try {
      answer = JSON.parse(result.stdout)
    } catch {
      throw failure('the answer is not JSON')
    }
    if (!isObject(answer) || answer.success !== true) throw failure('the answer is not a success')
    return answer.data
  }

  // Whether wacli has a session: `data.authenticated`. Its exit code is 0 either way (0.6).
  async function isPaired(signal) {
    const data = await wacli(['--read-only', 'auth', 'status'], { signal })
    return isObject(data) && data.authenticated === true
  }

  // Before each start of sync: waits until wacli is paired, checking every `AUTH_CHECK_INTERVAL`.
  // `signal` is the supervisor's, which a stop aborts, the check in progress with it.
  async function waitUntilPaired({ signal }) {
    if (link !== 'unpaired') link = 'checking'
    for (;;) {
      let paired = false
      try {
        paired = await isPaired(signal)
      } catch (error) {
        if (signal.aborted) return
        log.warn('whatsapp.auth_check_failed', errorFields(error))
      }
      if (paired) {
        if (link === 'unpaired') log.info('whatsapp.paired')
        link = 'linked'
        return
      }
      if (link !== 'unpaired') log.warn('whatsapp.not_paired', { hint: 'run `scooter pair` to link the bot\'s number' })
      link = 'unpaired'
      await clock.sleep(limits.AUTH_CHECK_INTERVAL, { signal })
    }
  }

  // The chat replies go to: that of the owner's newest message, or their number's before they
  // have written (5.2 step 5).
  function ownerChat() {
    return state.get().ownerChat?.jid ?? `${settings.ownerNumber}@s.whatsapp.net`
  }

  function rememberChat(message) {
    const jid = canonicalJid(message.chat)
    const at = message.at ?? isoSeconds(clock.now())
    const known = state.get().ownerChat
    if (known && (at < known.at || (at === known.at && jid === known.jid))) return
    try {
      state.update({ ownerChat: { jid, at } })
    } catch (error) {
      // The message matters more. Replies go to the chat known before, which is the owner's too.
      log.error('whatsapp.state_not_saved', errorFields(error))
    }
  }

  // Hands a normalized message to the core, unless it is dropped. Resolves when the core is done
  // with it. Returns what happened: `delivered`, or why it was dropped.
  async function deliver(message, onRecord, via) {
    const reason = dropReason(message, owners)
    if (reason === 'not the owner') {
      log.warn('whatsapp.not_owner', { sender: canonicalJid(message.sender), hint: 'add it to OWNER_JIDS if this is you' })
      return reason
    }
    if (reason) {
      // Catch-up lists the bot's own replies again each time; only the webhook's drops are news.
      if (via === 'webhook') log.info('whatsapp.dropped', { id: message.id, reason })
      return reason
    }
    rememberChat(message)
    const record = toRecord(message)
    chats.set(record, message.chat)
    await onRecord(record)
    return 'delivered'
  }

  // A webhook body, after its signature has been checked.
  function received(body, onRecord) {
    let payload
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      log.warn('whatsapp.webhook_unreadable', { bytes: body.length })
      return
    }
    // Receipts and presence carry an `EventType`; messages don't (5.2 step 2).
    if (isObject(payload) && Object.hasOwn(payload, 'EventType')) return
    const message = fromWebhook(payload)
    if (message === null) {
      log.warn('whatsapp.webhook_unreadable', { bytes: body.length })
      return
    }
    deliver(message, onRecord, 'webhook').catch(error => log.error('whatsapp.deliver_failed', errorFields(error)))
  }

  // The webhook server (5.2 step 1): `POST /wacli` on loopback, at most `WEBHOOK_MAX_BYTES`, with a
  // valid signature. It answers at once and handles the message afterwards, because wacli waits at
  // most 5 seconds and never retries.
  function listen(secret, onRecord) {
    const server = http.createServer((request, response) => {
      request.on('error', () => {})
      const answer = (status, close = false) => {
        response.writeHead(status, { 'content-length': '0', ...(close ? { connection: 'close' } : {}) })
        response.end()
      }
      if (request.url !== WEBHOOK_PATH) {
        request.resume()
        return answer(404)
      }
      if (request.method !== 'POST') {
        request.resume()
        return answer(405)
      }
      const tooLarge = () => {
        log.warn('whatsapp.webhook_refused', { reason: 'too large' })
        answer(413, true)
      }
      if (Number(request.headers['content-length']) > limits.WEBHOOK_MAX_BYTES) return tooLarge()
      const chunks = []
      let size = 0
      let refused = false
      request.on('data', chunk => {
        if (refused) return
        size += chunk.length
        if (size > limits.WEBHOOK_MAX_BYTES) {
          refused = true
          chunks.length = 0
          tooLarge()
        } else {
          chunks.push(chunk)
        }
      })
      request.on('end', () => {
        if (refused) return
        const body = Buffer.concat(chunks)
        if (!verifySignature(secret, body, request.headers[SIGNATURE_HEADER])) {
          log.warn('whatsapp.webhook_refused', { reason: 'signature' })
          return answer(401)
        }
        answer(200)
        setImmediate(() => received(body, onRecord))
      })
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(limits.WEBHOOK_PORT, '127.0.0.1', () => {
        server.off('error', reject)
        resolve(server)
      })
    })
  }

  // Catch-up (5.2 step 7): lists the owner's chat from 2 minutes before the newest incoming
  // WhatsApp line, or from the bridge's first start before there is one, and passes every row
  // through the same steps as a webhook.
  async function catchUp(onRecord, signal) {
    const newest = newestIncomingAt()
    let after = newest !== null ? parseIsoSeconds(newest) - limits.CATCHUP_OVERLAP : parseIsoSeconds(state.get().firstStart)
    const counts = { rows: 0, delivered: 0, dropped: 0 }
    const chat = ownerChat()
    for (;;) {
      const args = ['--read-only', 'messages', 'list', '--chat', chat, '--after', isoSeconds(after), '--asc']
      const data = await wacli([...args, '--limit', String(limits.CATCHUP_LIMIT)], { signal })
      // wacli answers `null`, not an empty list, when there is nothing (0.6).
      const rows = isObject(data) ? (data.messages ?? []) : null
      if (!Array.isArray(rows)) throw Object.assign(new Error('wacli messages list: the answer has no list'), { code: 'EWACLI' })
      for (const row of rows) {
        if (signal.aborted) return
        for (const message of fromListRow(row)) {
          if ((await deliver(message, onRecord, 'catch-up')) === 'delivered') counts.delivered += 1
          else counts.dropped += 1
        }
      }
      counts.rows += rows.length
      if (rows.length < limits.CATCHUP_LIMIT) break
      // A full page: go on from the last row's time. `--after` is strict, to the second, so the
      // next page starts a second earlier and the rest of that second is listed too; the rows
      // listed twice are duplicates. A page that is all one second moves past it instead.
      const last = parseIsoSeconds(fromListRow(rows.at(-1))[0]?.at ?? null)
      if (last === null) break
      // A page that ends no later than what was asked for would be asked for again, for ever, or
      // further back each time. The real wacli filters in SQL; one that doesn't is stopped here.
      if (last <= after) {
        log.warn('whatsapp.catchup_stopped', { reason: 'a full page that ends before the time asked for' })
        break
      }
      after = last - 1000 > after ? last - 1000 : last
    }
    log.info('whatsapp.caught_up', counts)
  }

  async function catchUpLoop(onRecord, signal) {
    for (;;) {
      // Not paired, there is nothing to list, and the store wacli would read may not exist.
      if (link !== 'unpaired') {
        try {
          await catchUp(onRecord, signal)
        } catch (error) {
          if (signal.aborted) return
          log.warn('whatsapp.catchup_failed', errorFields(error))
        }
      }
      try {
        await clock.sleep(limits.CATCHUP_INTERVAL, { signal })
      } catch {
        return
      }
    }
  }

  // The ID wacli gives a message it sent, in `data.id` (13.1), or null when it gives none.
  const sentId = data => (isObject(data) ? idOf(data.id) : null)

  // Removes a download the bridge asked for from wacli's staging folder, by unlinking it, which
  // neither follows a link nor removes a folder. A folder wacli made in its place is wacli's own,
  // and stays. Returns whether it is gone.
  function unstage(file) {
    try {
      fs.unlinkSync(file)
    } catch (error) {
      if (error.code !== 'ENOENT') return false
    }
    return true
  }

  // What a bridge stopped in the middle of a download left in staging. Its message wasn't stored,
  // and catch-up hands it over again. wacli owns the folder above staging, and could put a link in
  // its place, or swap one in later: so nothing is removed unless staging is its folder and not a
  // link, and only names the bridge gives its downloads (`startsWithId`), by unlinking them. Only
  // outbox entries have such names besides, and they are folders, which unlinking refuses. Anything
  // else there is wacli's, and stays.
  function clearStaging() {
    try {
      checkOwnFolder(paths.wacliStaging, user)
      let kept = 0
      for (const name of fs.readdirSync(paths.wacliStaging)) {
        if (!startsWithId(name) || !unstage(path.join(paths.wacliStaging, name))) kept += 1
      }
      if (kept > 0) log.warn('whatsapp.staging_kept', { names: kept })
    } catch (error) {
      log.warn('whatsapp.staging_not_cleared', errorFields(error))
    }
  }

  return {
    name: 'whatsapp',
    takesCommands: true,
    canSend: true,
    canReact: true,

    // Starts the webhook server, then sync once wacli is paired, then catch-up.
    async start(onRecord) {
      if (running) throw new Error('the WhatsApp channel is already started')
      // wacli reads and writes only its own folder (3.2). A native install makes these folders in
      // `setup`; here they are made if they're missing, as in development.
      ensureWacliFolders(paths, user)
      clearStaging()
      const secret = crypto.randomBytes(32).toString('hex')
      const server = await listen(secret, onRecord)
      const url = `http://127.0.0.1:${server.address().port}${WEBHOOK_PATH}`
      // wacli takes the secret only on its command line (0.6, wacli 1).
      const args = ['sync', '--follow', '--webhook', url, '--webhook-secret', secret, '--webhook-allow-private']
      const supervisor = proc.supervise(WACLI, args, {
        env,
        user,
        before: waitUntilPaired,
        onExit: () => {
          link = 'restarting'
        },
      })
      const stopping = new AbortController()
      const catchingUp = catchUpLoop(onRecord, stopping.signal)
      running = { server, supervisor, stopping, catchingUp }
      log.info('whatsapp.started', { address: server.address().address, port: server.address().port })
    },

    // Stops sync, the webhook server and catch-up, and wacli's calls in progress: a list, a check
    // of the pairing, a download. Resolves once they have stopped and the messages they were
    // handing over have been taken. A download it stops, or one asked for once it has stopped,
    // fails with `ESTOPPED`, and intake leaves its message, and the ones after it, for catch-up,
    // which lists them again when the channel starts (D179). A stop takes at most `STOP_GRACE` for
    // each call, rather than up to `WACLI_CALL_TIMEOUT` for each try of a download.
    async stop() {
      if (!running) return
      const { server, supervisor, stopping, catchingUp } = running
      running = null
      stopping.abort()
      await supervisor.stop()
      await new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })
      await catchingUp
      link = 'stopped'
      log.info('whatsapp.stopped')
    },

    // Saves the record's attachment at `target`: `wacli media download` into wacli's staging
    // folder, then a copy out of it, which `copyUntrustedFile` makes with care, since wacli owns
    // that folder. A WhatsApp message has one attachment.
    async download(record, n, target) {
      const chat = chats.get(record)
      if (chat === undefined || n !== 1 || record.attachments.length !== 1) throw new Error('no such attachment')
      if (!running) throw Object.assign(new Error('wacli media download: the channel is stopped'), { code: 'ESTOPPED' })
      const { signal } = running.stopping
      const staged = path.join(paths.wacliStaging, ids.next())
      try {
        const data = await wacli(['media', 'download', '--chat', chat, '--id', record.id, '--output', staged], { signal })
        if (!isObject(data) || data.path !== staged) throw Object.assign(new Error('wacli media download: saved elsewhere'), { code: 'EWACLI' })
        await copyUntrustedFile(staged, target, { owner: user, maxBytes: limits.ATTACHMENT_MAX_BYTES })
      } finally {
        if (!unstage(staged)) log.warn('whatsapp.staging_kept', { names: 1 })
      }
    },

    // Whether a send can go out now: wacli is paired and sync is running, and sends are handed to
    // it (0.6). Otherwise the outbox waits, and its entries with it.
    ready: () => link === 'linked',

    // Sends a text to the owner's chat (5.3): `wacli send text --to <owner chat> --message <text>
    // --no-preview`, with `--reply-to <quoteId>` to quote a message. Link previews are always off:
    // without `--no-preview` wacli fetches the first link in the text, which the agent wrote, to
    // build a preview, and nothing would log that request (0.8). Resolves with the ID of the
    // message sent, or null if wacli gave none. wacli's warning about sends less than 5 seconds
    // apart is on stderr, with exit code 0, and isn't a failure.
    async sendText(text, quoteId = null, { signal = null } = {}) {
      const args = ['send', 'text', '--to', ownerChat(), '--message', text, '--no-preview']
      if (quoteId !== null) args.push('--reply-to', quoteId)
      return sentId(await wacli(args, { signal }))
    },

    // Reacts to the owner's message `id` in the owner's chat: `wacli send react --to <owner chat>
    // --id <id> --sender <owner> --reaction <emoji>`. In a one-to-one chat the owner's JID is the
    // chat's. Resolves with the reaction's ID, or null.
    async react(id, emoji, { signal = null } = {}) {
      const chat = ownerChat()
      return sentId(await wacli(['send', 'react', '--to', chat, '--id', id, '--sender', chat, '--reaction', emoji], { signal }))
    },

    // One line for `/status`: the link state.
    status() {
      const lines = {
        stopped: 'WhatsApp: stopped',
        checking: 'WhatsApp: starting',
        unpaired: 'WhatsApp: not linked; run `scooter pair`',
        linked: 'WhatsApp: linked',
        restarting: 'WhatsApp: wacli stopped, and starts again shortly',
      }
      return lines[link]
    },

    ownerChat,
  }
}

// ---------------------------------------------------------------------------------------------
// Pairing (8.4)

// wacli's folders, made if they are missing, as the channel makes them when it starts.
function ensureWacliFolders(paths, user) {
  for (const dir of [paths.wacli, paths.wacliStore, paths.wacliStaging, paths.wacliConfig, paths.wacliState, paths.wacliCache]) {
    ensureDir(dir, { mode: 0o700, owner: user })
  }
}

// The phone number `--phone` gives, as wacli takes it: its digits, in international format, as
// `OWNER_NUMBER` is read (`settings.mjs`). Null when it isn't one.
export function pairingPhone(given) {
  const digits = given.replace(/[\s()-]/g, '').replace(/^\+/, '')
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : null
}

// `scooter pair [--phone +91…]`: links wacli to the bot's number, with a QR code to scan, or with
// `--phone`, the bot's number, a code to type into WhatsApp. It runs `wacli auth` as
// `scooter-wacli`, with wacli's environment and nothing else (5.1), and the terminal attached.
// When wacli is linked already, it says so and does nothing. A bridge that is running finds the
// link at its next pairing check, within a minute, and starts sync. Exits with 2 for wrong
// arguments, and with 1 when wacli fails.
export async function runPair({ args = [], settings, stdout = process.stdout, stderr = process.stderr, clock = systemClock, log = createLog({ component: 'bridge', clock }), proc = createProc({ log, clock }) }) {
  let phone = null
  const rest = [...args]
  if (rest[0] === '--phone' && rest.length === 2) phone = rest[1]
  else if (rest.length === 1 && rest[0].startsWith('--phone=')) phone = rest[0].slice('--phone='.length)
  else if (rest.length > 0) {
    stderr.write('scooter pair: it takes nothing, or --phone and the bot\'s number, such as --phone +919812345678\n')
    return 2
  }
  if (phone !== null) {
    phone = pairingPhone(phone)
    if (phone === null) {
      stderr.write('scooter pair: --phone takes the bot\'s number in international format, such as +919812345678\n')
      return 2
    }
  }
  const paths = makePaths(settings)
  const user = await proc.lookupUser('scooter-wacli')
  ensureWacliFolders(paths, user)
  const env = wacliEnv(paths)

  const status = await proc.run(WACLI, ['--json', '--read-only', 'auth', 'status'], { env, user, timeout: limits.WACLI_CALL_TIMEOUT })
  let data = null
  try {
    data = JSON.parse(status.stdout).data
  } catch {
    // not an answer
  }
  if (status.code === 0 && isObject(data) && data.authenticated === true) {
    stdout.write('wacli is linked already. To link it to another number, unlink this one first, in WhatsApp on the bot\'s phone: Linked devices.\n')
    return 0
  }
  const result = await proc.run(WACLI, ['auth', ...(phone === null ? [] : ['--phone', phone])], { env, user, output: 'inherit' })
  if (result.code !== 0) {
    stderr.write(`scooter pair: wacli auth ended with ${result.signal ?? `exit code ${result.code}`}\n`)
    return 1
  }
  stdout.write('Linked. A running bridge starts receiving within a minute.\n')
  return 0
}
