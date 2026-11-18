// Intake: records from the channels become datastore lines (5.2 step 6 of DESIGN.md).
//
// This is the core's half of receiving, the same for every channel. A channel hands over a record
// for each message from the owner; intake decides which kind of line it is, finds the lines it
// refers to, downloads its attachments through the channel, and appends the line through the
// store. Records are taken one at a time, in the order they come, so the webhook and catch-up
// never race each other to the store.
//
// - A deletion becomes a `delete`, an edit an `edit`, and a reaction a `reaction`, each with the
//   `seq` of the message it refers to as `target`. One whose message isn't in the datastore is
//   skipped: there is nothing for it to change.
// - A text that is one of the four commands, from a channel that takes commands, becomes a
//   `command`, trimmed. An email is never a command.
// - Anything else becomes a `message`. A reply gets `replyTo`, the `seq` of the message it quotes
//   when that is in the datastore, and `quoted`, the channel's preview of it.
// - Each attachment is downloaded, with `MEDIA_DOWNLOAD_RETRIES` more tries if that fails, and
//   handed to the store, which copies it into the day folder. An attachment that can't be stored
//   leaves a `media` object on the line saying why: too large, not a file, a failed download, or a
//   copy that failed. A channel that keeps a message until it is stored, as email's spool does
//   (5.6), is the exception: when a copy fails on the bridge's side, such as on a full disk,
//   nothing of the message is stored, and the channel hands it over again later, files and all.
// - Duplicates, which the webhook and catch-up both deliver (4.4), are the store's to skip. A
//   message already stored is recognized before its attachments are downloaded again.
// - A download that its channel's stop cut short, for a backup or a shutdown, leaves the message
//   unstored, rather than stored as `download failed`, and every record of that channel after it
//   too, until the channel starts again: the channel hands them over again when it starts, as
//   WhatsApp's catch-up does, from where it had got to (D179). So they are stored in their order.
// - A record intake didn't store, and that its channel must hand over again, is said so with
//   `again: true`: one a stop left, one that failed for a reason of the bridge's, such as a bug,
//   and one the store stopped for. WhatsApp's catch-up never goes on past such a row (D179).

import fs from 'node:fs'
import path from 'node:path'
import { COMMANDS, DatastoreError } from '../common/datastore/line.mjs'
import { createIds, ensureDir } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { isoSeconds, systemClock } from '../common/time.mjs'
import { checkRecord } from './channels/index.mjs'

// What a line's `media` object says when an attachment couldn't be stored (4.2).
export const MEDIA_ERRORS = {
  tooLarge: 'too large, not downloaded',
  downloadFailed: 'download failed',
  notStored: 'could not be stored',
  // An email the reader couldn't parse, stored with its `.eml` (5.6).
  notParsed: 'could not be parsed',
}

// Returns intake. Options:
// - `store`: the open store (`src/bridge/store.mjs`).
// - `channels`: a Map from each channel's name to the channel.
// - `paths`: what `makePaths` returns. Attachments wait in `bridgeIncoming` between their channel
//   and the store.
// - `onFatal(error)`: called once if the store stops taking lines (D29). The bridge can't go on
//   without a restart then.
// - `onCommand(seq)`: called after a command line has been stored, for the bridge to answer it.
export function createIntake({ store, channels, paths, log, clock = systemClock, onFatal = () => {}, onCommand = () => {} }) {
  const ids = createIds(clock)
  let queue = Promise.resolve()
  let failed = null
  // The channels whose stop cut a download short, leaving its message for them to hand over again,
  // until they start again: nothing of theirs is stored meanwhile (D179).
  const left = new Set()

  // The `at` of the newest incoming line from each channel, by `seq`. WhatsApp's catch-up starts
  // from it only for a bridge state an older bridge wrote, which doesn't say where catch-up had
  // got to (D179).
  const newestIn = new Map()
  for (const { line } of store.index.entries()) {
    if (line.dir === 'in') newestIn.set(line.source, line.at)
  }

  // The message, or command, a line from this channel refers to by its channel ID: its `seq`, or
  // undefined. A reaction, an edit or a deletion can't be referred to (4.2).
  function targetOf(source, id) {
    const seq = store.index.seqOf(source, id)
    return seq !== undefined && store.index.current(seq) !== undefined ? seq : undefined
  }

  async function append(fields, files = []) {
    const result = await store.append(fields, files)
    if (result.stored) {
      newestIn.set(fields.source, fields.at)
      log.info('intake.stored', { source: fields.source, kind: fields.kind, seq: result.seq })
      if (fields.kind === 'command') onCommand(result.seq)
    } else {
      log.info('intake.skipped', { source: fields.source, kind: fields.kind, reason: result.reason })
    }
    return result
  }

  function skip(record, kind, reason) {
    log.info('intake.skipped', { source: record.source, kind, reason })
    return { stored: false, reason }
  }

  // Not stored, for its channel to hand over again.
  function leave(record, kind, reason) {
    return { ...skip(record, kind, reason), again: true }
  }

  const mediaOf = (attachment, error) => ({ type: attachment.type, ...(attachment.mime ? { mime: attachment.mime } : {}), error })

  // Downloads one attachment into the incoming folder. Returns `{ file }`, or `{ error }` with
  // what the line's `media` object should say.
  async function download(channel, record, n) {
    const attachment = record.attachments[n - 1]
    for (let attempt = 1; attempt <= 1 + limits.MEDIA_DOWNLOAD_RETRIES; attempt++) {
      if (attempt > 1) await clock.sleep(limits.MEDIA_DOWNLOAD_RETRY_WAIT)
      const file = path.join(paths.bridgeIncoming, `${ids.next()}-${n}`)
      try {
        await channel.download(record, n, file)
        const bytes = fs.statSync(file).size
        if (bytes > limits.ATTACHMENT_MAX_BYTES) {
          fs.rmSync(file, { force: true })
          return { error: MEDIA_ERRORS.tooLarge }
        }
        return { file, attachment }
      } catch (error) {
        fs.rmSync(file, { force: true })
        // The channel is stopping: the message is left for it to hand over again.
        if (error.code === 'ESTOPPED') throw error
        log.warn('intake.download_failed', { source: record.source, n, attempt, ...errorFields(error) })
        if (error.code === 'EFBIG') return { error: MEDIA_ERRORS.tooLarge }
        // A copy that failed on the bridge's side, such as on a full disk, from a channel that
        // keeps the message until it is stored: nothing of it is stored now, and the channel hands
        // it over again, with its files (5.6).
        if (error.bridgeSide && channel.keepsUntilStored) throw error
        // From such a channel any other failure is the message's own, such as a file missing from
        // the mail spool, which the reader wrote whole before it handed the folder over: another
        // try would find the same, and hold up every message behind it meanwhile.
        if (channel.keepsUntilStored) return { error: MEDIA_ERRORS.downloadFailed }
      }
    }
    return { error: MEDIA_ERRORS.downloadFailed }
  }

  async function message(record, base) {
    const channel = channels.get(record.source)
    const fields = { ...base, kind: 'message', sourceId: record.id }
    if (record.replyToId !== null) {
      const replyTo = store.index.seqOf(record.source, record.replyToId)
      if (replyTo !== undefined) fields.replyTo = replyTo
      if (record.replyToPreview) fields.quoted = record.replyToPreview
    }
    if (record.forwarded) fields.forwarded = true
    if (record.source === 'email') fields.subject = record.subject
    fields.text = record.text

    // Catch-up lists the last two minutes again every time, so this is common, and the
    // attachments of a message already stored aren't downloaded again.
    if (store.index.seqOf(record.source, record.id) !== undefined) return skip(record, 'message', 'duplicate')

    const downloaded = []
    let media = null
    try {
      for (let n = 1; n <= record.attachments.length; n++) {
        const attachment = record.attachments[n - 1]
        let result
        if (attachment.error !== null) result = { error: attachment.error }
        else if (attachment.bytes !== null && attachment.bytes > limits.ATTACHMENT_MAX_BYTES) result = { error: MEDIA_ERRORS.tooLarge }
        else result = await download(channel, record, n)
        if (result.file) downloaded.push({ ...result, n })
        // The line has room for one `media` object: the first attachment that couldn't be stored.
        else media ??= mediaOf(attachment, result.error)
      }
      // An email's files start with the whole message, `<seq>.eml` (5.6), which the agent's prompt
      // names as the whole email. Without it the files would be numbered from its first part, so
      // none is kept, and `media` says why.
      if (record.source === 'email' && downloaded.length > 0 && downloaded[0].n !== 1) {
        log.warn('intake.email_parts_dropped', { files: downloaded.length })
        for (const { file } of downloaded.splice(0)) fs.rmSync(file, { force: true })
      }
      const files = downloaded.map(({ file, attachment }) => ({ path: file, mime: attachment.mime, name: attachment.name }))
      try {
        return await append(media ? { ...fields, media } : fields, files)
      } catch (error) {
        if (error instanceof DatastoreError || files.length === 0) throw error
        // An attachment couldn't be copied into the day folder. The store wrote nothing and used
        // up no `seq` (D29). A channel that keeps the message until it is stored hands it over
        // again (5.6); otherwise the message is kept without its files.
        if (channel.keepsUntilStored) throw error
        log.warn('intake.attachment_not_stored', { source: record.source, ...errorFields(error) })
        return await append({ ...fields, media: media ?? mediaOf(downloaded[0].attachment, MEDIA_ERRORS.notStored) })
      }
    } catch (error) {
      if (error.code !== 'ESTOPPED') throw error
      left.add(record.source)
      return leave(record, 'message', 'its channel stopped during a download')
    } finally {
      for (const { file } of downloaded) fs.rmSync(file, { force: true })
    }
  }

  async function handle(record) {
    const problems = checkRecord(record)
    if (problems.length > 0) {
      log.error('intake.bad_record', { source: record?.source, problems })
      return { stored: false, reason: 'not a record' }
    }
    const channel = channels.get(record.source)
    if (!channel) return skip(record, null, 'no such channel')
    if (left.has(record.source)) return leave(record, null, 'its channel stopped during a download before it')
    const base = { dir: 'in', at: record.at ?? isoSeconds(clock.now()), source: record.source, trust: 'owner' }

    if (record.revoked) {
      const target = targetOf(record.source, record.id)
      if (target === undefined) return skip(record, 'delete', 'unknown target')
      return append({ ...base, kind: 'delete', sourceId: record.id, target })
    }
    if (record.reactionToId !== null) {
      const target = targetOf(record.source, record.reactionToId)
      if (target === undefined) return skip(record, 'reaction', 'unknown target')
      return append({ ...base, kind: 'reaction', sourceId: record.id, target, emoji: record.reactionEmoji })
    }
    if (record.edited) {
      const target = targetOf(record.source, record.id)
      if (target === undefined) return skip(record, 'edit', 'unknown target')
      return append({ ...base, kind: 'edit', sourceId: record.id, target, text: record.text })
    }
    const command = record.text.trim()
    if (channel.takesCommands && record.attachments.length === 0 && COMMANDS.includes(command)) {
      return append({ ...base, kind: 'command', sourceId: record.id, text: command })
    }
    return message(record, base)
  }

  async function take(record) {
    if (failed) return { stored: false, reason: 'the store stopped', again: true }
    try {
      return await handle(record)
    } catch (error) {
      if (error instanceof DatastoreError || store.broken) {
        if (!failed) {
          failed = error
          log.error('intake.store_failed', errorFields(error))
          onFatal(error)
        }
        return { stored: false, reason: 'the store stopped', again: true }
      }
      // A bug, or the disk. The record is lost to this delivery: WhatsApp's catch-up lists it
      // again within `CATCHUP_INTERVAL`, since it never goes on past a record left so (D179), and
      // an email stays in the spool.
      log.error('intake.failed', { source: record?.source, ...errorFields(error) })
      return { stored: false, reason: 'failed', again: true }
    }
  }

  ensureDir(paths.bridgeIncoming, { mode: 0o700 })

  return {
    // Takes a record. Resolves, once it has been handled, with what the store said: `{ stored:
    // true, seq, line }`, or `{ stored: false, reason }`, with `again: true` when the channel must
    // hand the record over again. Never rejects.
    take(record) {
      const result = queue.then(() => take(record))
      queue = result
      return result
    },

    // Resolves when every record taken so far has been handled.
    idle: () => queue,

    // Says that the channel `source` starts again: what it hands over from here on is stored again,
    // after its stop left a message (D179). It takes its turn after the records taken before it,
    // which are still left. The bridge calls it before it starts a channel it stopped.
    started(source) {
      queue = queue.then(() => left.delete(source))
      return queue
    },

    // The `at` of the newest incoming line from a channel, or null when there is none.
    newestIncomingAt: source => newestIn.get(source) ?? null,
  }
}
