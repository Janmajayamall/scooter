// The datastore's single writer.
//
// Every line, incoming and outgoing, is appended here, through one queue, so `seq` order is the
// order of the lines in the files. This is the only module that writes to the datastore: nothing
// else appends a line, stores an attachment, or truncates.
//
// - At startup it reads every line, as a reader does, removes part of a line left at the very end
//   by a crash, and rebuilds the index.
// - It writes only what passes the strict check of a line (`checkLine`), whatever it can read.
// - For each line it takes the next `seq`, copies the attachments into the day folder, and then
//   appends the line with one `write` call and an `fsync`.
// - It never rewrites or deletes a line.

import fs from 'node:fs'
import path from 'node:path'
import { createIndex } from '../common/datastore/index.mjs'
import { DatastoreError, checkLine, encodeLine } from '../common/datastore/line.mjs'
import { createReader, listDays } from '../common/datastore/reader.mjs'
import { TMP_PREFIX, ensureDir, setOwner } from '../common/files.mjs'
import { limits } from '../common/limits.mjs'
import { dayOfDate } from '../common/paths.mjs'
import { systemClock, utcDate } from '../common/time.mjs'

// Folders 0750 and files 0640, owned by root with the runner's group, so only root and the runner
// can read the datastore.
const DIR_MODE = 0o750
const FILE_MODE = 0o640

// The extension for a MIME type, when the original file name gives none.
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/calendar': 'ics',
  'text/vcard': 'vcf',
  'message/rfc822': 'eml',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

const UNKNOWN_MIME = 'application/octet-stream'

// An attachment's stored name, `<seq>.<ext>` or `<seq>-<n>.<ext>`, with the `seq` it holds.
const ATTACHMENT = /^(\d+)(?:-\d+)?\.[a-z0-9]+$/

// The extension of an attachment's stored name: from the original file name if there is one,
// else from the MIME type, else `bin`. Only letters and digits, in lower case, so the
// stored name is always plain, whatever the original was called.
function extensionOf({ name, mime }) {
  if (typeof name === 'string') {
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 ? name.slice(dot + 1) : ''
    if (/^[A-Za-z0-9]+$/.test(extension) && extension.length <= limits.ATTACHMENT_EXT_MAX_CHARS) {
      return extension.toLowerCase()
    }
  }
  if (typeof mime === 'string') {
    const type = mime.split(';')[0].trim().toLowerCase()
    if (Object.hasOwn(EXTENSIONS, type)) return EXTENSIONS[type]
  }
  return 'bin'
}

// The stored name of a message's `n`th attachment, counting from 1: `<seq>.<ext>` for the first,
// then `<seq>-2.<ext>`, `<seq>-3.<ext>` and so on.
export function attachmentName(seq, n, attachment) {
  return `${seq}${n === 1 ? '' : `-${n}`}.${extensionOf(attachment)}`
}

function fsyncPath(target) {
  const fd = fs.openSync(target, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// Opens the datastore for writing, and returns the store.
//
// - `paths` is what `makePaths` returns (`src/common/paths.mjs`).
// - `owner` is `{ uid, gid }` for everything the store creates: root and the runner's group. Leave
//   it out when not running as root, and owners are left alone. Modes are set either way.
// - It throws a `DatastoreError` if the datastore's contents are damaged: a complete line that
//   isn't JSON or fails a reader's check, or `seq` numbers out of order. A line of a kind, a
//   channel or a field this version doesn't know is no damage: it is read, and passed over.
export function openStore({ paths, clock = systemClock, log, owner = null }) {
  const dir = paths.datastore
  ensureDir(dir, { mode: DIR_MODE, owner })

  const index = createIndex()
  const reader = createReader(paths)
  for (const { line, day, number } of reader.poll()) {
    try {
      index.add(line, day)
    } catch (error) {
      throw new DatastoreError(`${paths.dayLog(day)}, line ${number}: ${error.message}`)
    }
  }

  // Part of a line at the very end is what a crash in the middle of a write leaves. The line was
  // never complete, so its `seq` was never given out, and the part goes. This is the only place
  // anything is ever removed from a log, and it happens only here, at startup.
  const part = reader.pending()
  if (part) {
    fs.truncateSync(part.file, part.offset)
    fsyncPath(part.file)
    log.warn('store.truncated', { day: part.day, bytes: part.bytes })
  }

  // The newest day folder there is, with or without a log in it: folder dates never go backwards.
  let newestDay = listDays(dir).at(-1) ?? null
  if (newestDay !== null) {
    // What a crash can leave in the folder it was writing to: copies of attachments that were
    // never finished, and attachments whose line was never written. The second kind would sit
    // under the number of the next line, which may have no attachment of its own, where pi could
    // read it. Attachments are only ever written to the newest day folder.
    let removed = 0
    for (const name of fs.readdirSync(paths.dayDir(newestDay))) {
      const seq = Number(ATTACHMENT.exec(name)?.[1])
      if (name.startsWith(TMP_PREFIX) || seq > index.lastSeq) {
        fs.rmSync(path.join(paths.dayDir(newestDay), name), { force: true })
        removed += 1
      }
    }
    if (removed > 0) log.warn('store.leftovers_removed', { day: newestDay, files: removed })
  }
  log.info('store.opened', { lines: index.lastSeq, newestDay })

  let broken = false
  let warnedClock = false
  let queue = Promise.resolve()

  // The day folder for a line written now: today's UTC date, or the newest folder if the clock
  // reads earlier than that.
  function dayForNow() {
    const today = dayOfDate(utcDate(clock.now()))
    if (newestDay === null || today >= newestDay) return today
    if (!warnedClock) {
      warnedClock = true
      log.warn('store.clock_behind', { today, newestDay })
    }
    return newestDay
  }

  // Whether the datastore already holds this line.
  function isDuplicate(line) {
    switch (line.kind) {
      case 'message':
      case 'reaction':
        // The webhook and catch-up can both deliver the same message or reaction.
        return line.sourceId !== undefined && index.seqOf(line.source, line.sourceId) !== undefined
      case 'edit':
        // An edit carries its message's ID, so it's told apart by what it changes.
        return index.current(line.target)?.text === line.text
      case 'delete':
        return (index.current(line.target)?.deletedIn ?? null) !== null
      default:
        return false
    }
  }

  // Copies one attachment into the day folder under a temporary name, then renames it. The source
  // is on another volume, wacli's staging folder or the mail spool, so it can't simply be moved.
  async function storeAttachment(dayDir, name, attachment) {
    const tmp = path.join(dayDir, `${TMP_PREFIX}${name}`)
    const target = path.join(dayDir, name)
    try {
      await fs.promises.copyFile(attachment.path, tmp)
      fs.chmodSync(tmp, FILE_MODE)
      setOwner(tmp, owner)
      fsyncPath(tmp)
      const bytes = fs.statSync(tmp).size
      // A file of this name can only be left over from a crash: its `seq` has no line.
      fs.renameSync(tmp, target)
      const file = { path: name, mime: attachment.mime || UNKNOWN_MIME }
      if (typeof attachment.name === 'string' && attachment.name !== '') file.name = attachment.name
      file.bytes = bytes
      return file
    } catch (error) {
      fs.rmSync(tmp, { force: true })
      throw error
    }
  }

  async function write(fields, attachments) {
    if (broken) throw new DatastoreError('the store stopped after a write failed; the bridge must be restarted')
    if (fields.seq !== undefined || fields.files !== undefined) {
      throw new DatastoreError('seq and files are set by the store')
    }
    const seq = index.lastSeq + 1
    const draft = { ...fields, seq }
    const problems = checkLine(draft)
    if (problems.length > 0) throw new DatastoreError(`not a datastore line: ${problems.join('; ')}`)
    if (attachments.length > 0 && draft.kind !== 'message') {
      throw new DatastoreError('only a message has attachments')
    }
    // An edit, a deletion or a reaction refers to a message, one this version knows. Intake skips
    // the ones whose target it doesn't know, and delivery drops them, so one that reaches the store
    // pointing anywhere else is a bug in its writer.
    if (['edit', 'delete', 'reaction'].includes(draft.kind) && index.current(draft.target) === undefined) {
      throw new DatastoreError(`a ${draft.kind} must point at a message, and seq ${draft.target} isn't one`)
    }
    if (isDuplicate(draft)) return { stored: false, reason: 'duplicate' }

    const day = dayForNow()
    const dayDir = paths.dayDir(day)
    ensureDir(dayDir, { mode: DIR_MODE, owner })
    newestDay = day

    const files = []
    try {
      for (const attachment of attachments) {
        const name = attachmentName(seq, files.length + 1, attachment)
        files.push(await storeAttachment(dayDir, name, attachment))
      }
      // The attachments are on disk before the line that names them.
      if (files.length > 0) fsyncPath(dayDir)
    } catch (error) {
      // No line was written, so the `seq` isn't used up, and the next line takes it.
      for (const file of files) fs.rmSync(path.join(dayDir, file.path), { force: true })
      throw error
    }

    const line = files.length > 0 ? { ...draft, files } : draft
    const bytes = Buffer.from(encodeLine(line))
    const file = paths.dayLog(day)
    const isNew = !fs.existsSync(file)
    const fd = fs.openSync(file, 'a', FILE_MODE)
    try {
      if (isNew) {
        fs.fchmodSync(fd, FILE_MODE)
        if (owner) fs.fchownSync(fd, owner.uid, owner.gid)
      }
      // One `write` call for the whole line, so a crash leaves all of it, or a part that has no
      // line break and is removed at the next start.
      const written = fs.writeSync(fd, bytes)
      if (written !== bytes.length) throw new DatastoreError('only part of a line was written')
      fs.fsyncSync(fd)
    } catch (error) {
      // The log may now end in part of a line. Only a start removes that, so nothing more is
      // written until then.
      broken = true
      log.error('store.write_failed', { seq, day })
      throw error
    } finally {
      fs.closeSync(fd)
    }
    if (isNew) fsyncPath(dayDir)

    index.add(line, day)
    log.info('store.appended', { seq, kind: line.kind, dir: line.dir, source: line.source, day, attachments: files.length, bytes: bytes.length })
    return { stored: true, seq, line, day }
  }

  return {
    // Appends a line. `fields` is the line without `seq` and `files`, which the store sets.
    // `attachments` lists the files to store with a message, each as `{ path, mime, name }`:
    // where the file is now, its MIME type, and its original name if the source gave one. The
    // store copies them and leaves the originals where they are.
    //
    // Resolves with `{ stored: true, seq, line, day }`, or with `{ stored: false, reason:
    // 'duplicate' }` when the datastore already holds the line. Rejects, without using up a
    // `seq`, when the line isn't well formed or an attachment can't be copied.
    append(fields, attachments = []) {
      const result = queue.then(() => write(fields, attachments))
      queue = result.catch(() => {})
      return result
    },

    // Resolves when every append asked for so far has finished.
    idle: () => queue,

    // True once a write has failed. The store then takes no more lines until it is opened again.
    get broken() {
      return broken
    },

    // The index, for looking things up. Only the store adds to it.
    index: {
      get: seq => index.get(seq),
      seqOf: (source, sourceId) => index.seqOf(source, sourceId),
      current: seq => index.current(seq),
      entries: () => index.entries(),
      get lastSeq() {
        return index.lastSeq
      },
    },
  }
}
