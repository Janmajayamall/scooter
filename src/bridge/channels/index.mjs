// The channels: what the bridge's core asks of each one, and the record each one hands it (5 of
// DESIGN.md; ARCHITECTURE.md 2.1).
//
// A channel is one module in this folder, and only that module deals with its service: only
// `whatsapp.mjs` runs wacli, and only `email.mjs` runs the email reader. The core (the store,
// intake, delivery, commands and backups) calls every channel through the same object:
//
//   name              `whatsapp` or `email`: the `source` of the lines its records become
//   takesCommands     whether a text from it can be a command (5.4). WhatsApp's can; an email never
//   start(onRecord)   starts receiving, and calls `onRecord(record)` for each message from the
//                     owner, awaiting what it returns. The channel drops everything else itself.
//   stop()            stops receiving, for backups and shutdown
//   download(record, n, path)
//                     saves the record's `n`th attachment, counting from 1, at `path`, a file name
//                     in a folder only the bridge can write. Rejects if it can't; an error with the
//                     code `EFBIG` means the attachment is too large to store, and isn't retried.
//   status()          one line for `/status`
//
// And for delivery (5.3):
//
//   canSend           whether it can send text. WhatsApp can; email can't, since Scooter never
//                     sends email
//   canReact          whether it can react to a message
//   ready()           whether it can send now. WhatsApp can't while wacli isn't paired, or while
//                     sync is starting again; entries for it wait meanwhile
//   sendText(text, quoteId, { signal })
//                     sends `text`, quoting the message whose channel ID is `quoteId` when it isn't
//                     null, and resolves with the new message's channel ID, or null if the channel
//                     didn't say. Rejects if it couldn't send. `signal` stops it, for shutdown
//   react(id, emoji, { signal })
//                     reacts with `emoji` to the owner's message whose channel ID is `id`, and
//                     resolves with the reaction's channel ID, or null, as `sendText` does
//
// A record is the message as the channel received it, in a form that is the same for every
// channel: the normalized message of 5.2 step 3, without what only the channel needs (for
// WhatsApp, the chat, the sender and whether the bot sent it), plus `subject` for email.
//
//   source           the channel's name
//   id               the channel's own ID for it, which becomes `sourceId`. For an edit or a
//                    deletion it is the ID of the message changed (13.1)
//   at               when it was sent, as a UTC time to the second, or null if the channel doesn't
//                    know, in which case it arrived now
//   text             its text, or a media caption: "" if none
//   subject          an email's subject, "" if none. Only on email
//   attachments      what it carries, each `{ type, mime, name, bytes, error }`: the kind of media
//                    (`image`, `document`…), the MIME type, the original file name and the size if
//                    the channel knows them (else null), and `error` when the core must not try to
//                    download it, saying why (else null)
//   replyToId        the ID of the message it quotes, or null
//   replyToPreview   the channel's short text of the quoted message, or null
//   reactionToId     for a reaction, the ID of the message reacted to; else null
//   reactionEmoji    for a reaction, the emoji, "" when the reaction was removed; else null
//   edited           true when it is an edit of the message `id`
//   revoked          true when it deletes the message `id`
//   forwarded        true when it was forwarded: someone else's words

import { SOURCES } from '../../common/datastore/line.mjs'
import { parseIsoSeconds } from '../../common/time.mjs'

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = value => typeof value === 'string'
const isText = value => isString(value) && value !== ''
const orNull = check => value => value === null || check(value)

function checkAttachment(attachment) {
  if (!isObject(attachment)) return false
  const { type, mime, name, bytes, error, ...rest } = attachment
  return (
    Object.keys(rest).length === 0 &&
    isText(type) &&
    orNull(isText)(mime) &&
    orNull(isText)(name) &&
    orNull(value => Number.isSafeInteger(value) && value >= 0)(bytes) &&
    orNull(isText)(error)
  )
}

// Why the channel named `name` can't be `DEFAULT_CHANNEL` (5.3), or null when it can: it must be
// one of `channels`, and one that can send. In v2 that leaves only `whatsapp`, and the bridge
// refuses to start with anything else.
export function defaultChannelProblem(channels, name) {
  const channel = channels.get(name)
  if (channel?.canSend) return null
  const able = [...channels.values()].filter(other => other.canSend).map(other => other.name)
  const which = channel ? `${name}, which can't send` : `${name}, which isn't running`
  return `DEFAULT_CHANNEL is ${which}; it must be a channel that can send: ${able.join(' or ') || 'none is running'}`
}

// What is wrong with a record, as short statements that name fields and never repeat their values.
// An empty list means it is well formed. A record that isn't is a bug in its channel.
export function checkRecord(record) {
  if (!isObject(record)) return ['not an object']
  const problems = []
  const check = (field, ok, what) => {
    if (!ok(record[field])) problems.push(`${field} must be ${what}`)
  }
  const known = [
    'source',
    'id',
    'at',
    'text',
    'subject',
    'attachments',
    'replyToId',
    'replyToPreview',
    'reactionToId',
    'reactionEmoji',
    'edited',
    'revoked',
    'forwarded',
  ]
  for (const field of Object.keys(record)) {
    if (!known.includes(field)) problems.push(`unknown field ${field}`)
  }
  check('source', value => SOURCES.includes(value), `one of ${SOURCES.join(', ')}`)
  check('id', isText, 'a string that isn\'t empty')
  check('at', orNull(value => parseIsoSeconds(value) !== null), 'a UTC time to the second, or null')
  check('text', isString, 'a string')
  if (record.source === 'email') check('subject', isString, 'a string')
  else check('subject', value => value === undefined, 'left out, except on an email')
  check('attachments', value => Array.isArray(value) && value.every(checkAttachment), 'a list of attachments')
  check('replyToId', orNull(isText), 'an ID or null')
  check('replyToPreview', orNull(isString), 'a string or null')
  check('reactionToId', orNull(isText), 'an ID or null')
  check('reactionEmoji', orNull(isString), 'a string or null')
  for (const flag of ['edited', 'revoked', 'forwarded']) check(flag, value => typeof value === 'boolean', 'true or false')
  if ((record.reactionToId === null) !== (record.reactionEmoji === null)) {
    problems.push('reactionToId and reactionEmoji go together')
  }
  return problems
}
