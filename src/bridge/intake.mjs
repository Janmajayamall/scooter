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
//   copy that failed.
// - Duplicates, which the webhook and catch-up both deliver (4.4), are the store's to skip. A
//   message already stored is recognized before its attachments are downloaded again.

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

  // The `at` of the newest incoming line from each channel, by `seq`. WhatsApp's catch-up starts
  // from it (5.2 step 7).
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
        log.warn('intake.download_failed', { source: record.source, n, attempt, ...errorFields(error) })
        if (error.code === 'EFBIG') return { error: MEDIA_ERRORS.tooLarge }
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
        // up no `seq` (D29), and the message is kept without its files.
        log.warn('intake.attachment_not_stored', { source: record.source, ...errorFields(error) })
        return await append({ ...fields, media: media ?? mediaOf(downloaded[0].attachment, MEDIA_ERRORS.notStored) })
      }
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
    if (failed) return { stored: false, reason: 'the store stopped' }
    try {
      return await handle(record)
    } catch (error) {
      if (error instanceof DatastoreError || store.broken) {
        if (!failed) {
          failed = error
          log.error('intake.store_failed', errorFields(error))
          onFatal(error)
        }
        return { stored: false, reason: 'the store stopped' }
      }
      // A bug, or the disk. The record is lost to this delivery, and catch-up brings a WhatsApp
      // message back within `CATCHUP_INTERVAL`.
      log.error('intake.failed', { source: record?.source, ...errorFields(error) })
      return { stored: false, reason: 'failed' }
    }
  }

  ensureDir(paths.bridgeIncoming, { mode: 0o700 })

  return {
    // Takes a record. Resolves, once it has been handled, with what the store said: `{ stored:
    // true, seq, line }`, or `{ stored: false, reason }`. Never rejects.
    take(record) {
      const result = queue.then(() => take(record))
      queue = result
      return result
    },

    // Resolves when every record taken so far has been handled.
    idle: () => queue,

    // The `at` of the newest incoming line from a channel, or null when there is none.
    newestIncomingAt: source => newestIn.get(source) ?? null,
  }
}
