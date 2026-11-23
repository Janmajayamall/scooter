// What the agent is told in a run: the prompt, which is pi's user message. pi's system prompt is
// pi's own, with the agent's prompt of the config folder appended, the run's copy of it
// (`prepareRun` in `agentdir.mjs`).
//
// The prompt shows each item as it is now, with times in the owner's time zone:
//
//   [scooter] Now: Monday 9 November 2026, 21:20 (Asia/Kolkata). Home currency: INR. Reply mode: quiet. Internet: off.
//   Your folder: /data/agents/lifelog. Attachments are in /data/datastore (read-only).
//
//   New messages:
//   #1050 21:13 photo /data/datastore/2026/11/09/1050.jpg (image/jpeg), caption: "lunch with sam"
//   #1053 21:20 text: "work"
//         ↳ reply to #1043, which you sent: "Blue Tokai, ₹450 at 12:40: work or personal?"
//
//   Retrying (not handled yet):
//   #1047 20:02 text: "ran 5k in 28 min" (attempt 2 of 4)
//
//   For context only (no action, nothing to mark):
//   #1049 21:05 you sent: "Logged ₹340 Uber."
//   #1048 21:04 the owner reacted 👍 to #1046
//
// Every text the owner or the agent wrote is shown as a JSON string, so a line break or a quote in
// it can't pass for the prompt's own structure. The prompt is one command-line argument, so
// `batch.mjs` keeps it within `PROMPT_MAX_BYTES`, and a text too long for that is shown cut,
// followed by where the whole of it is.

import path from 'node:path'
import { dataFlag, dataText } from '../common/datastore/line.mjs'
import { limits } from '../common/limits.mjs'
import { parseIsoSeconds, shortLocalTime, toLocal } from '../common/time.mjs'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = number => String(number).padStart(2, '0')

export const SECTIONS = {
  new: 'New messages:',
  retrying: 'Retrying (not handled yet):',
  context: 'For context only (no action, nothing to mark):',
  task: 'Scheduled task (from your configuration, not a message from the owner):',
}

// How far an item's further lines are indented, under its `#seq`.
const INDENT = '      '

// ---------------------------------------------------------------------------------------------
// Times, in the owner's time zone

// `Monday 9 November 2026, 21:20`.
export function longTime(ms, timeZone) {
  const t = toLocal(ms, timeZone)
  return `${WEEKDAYS[t.weekday - 1]} ${t.day} ${MONTHS[t.month - 1]} ${t.year}, ${pad(t.hour)}:${pad(t.minute)}`
}

// An item's time: `21:13` on the owner's day of `now`, `Sun 8 Nov 20:02` on another day of the
// same year, and `Sat 8 Nov 2025 20:02` in another year (`shortLocalTime`).
export const itemTime = shortLocalTime

// The two lines every prompt starts with.
export function promptHeader({ now, timeZone, homeCurrency, replyMode, internet, agentDir, datastoreDir }) {
  return (
    `[scooter] Now: ${longTime(now, timeZone)} (${timeZone}). Home currency: ${homeCurrency}. ` +
    `Reply mode: ${replyMode}. Internet: ${internet ? 'on' : 'off'}.\n` +
    `Your folder: ${agentDir}. Attachments are in ${datastoreDir} (read-only).`
  )
}

// ---------------------------------------------------------------------------------------------
// Texts

// A word from a channel, such as a MIME type or an emoji, as it is when it is one plain word, and
// as a JSON string otherwise.
function token(value) {
  return /^[^\s\p{C}"\\]+$/u.test(value) ? value : JSON.stringify(value)
}

// A short phrase from Scooter's own code, such as why media wasn't stored: as it is, unless it
// holds a control character such as a line break.
function phrase(value) {
  return /^[^\p{C}]*$/u.test(value) ? value : JSON.stringify(value)
}

// The longest beginning of `text` that is at most `bytes` long in UTF-8, without splitting a
// character.
export function cutText(text, bytes) {
  let used = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (used + size > bytes) break
    used += size
    end += char.length
  }
  return text.slice(0, end)
}

// A text as a JSON string. Longer than `cap` bytes, it is cut there and followed by `where`, which
// says where the whole of it is.
function quoteText(text, cap, where) {
  if (Buffer.byteLength(text) <= cap) return JSON.stringify(text)
  return `${JSON.stringify(cutText(text, cap))} (cut; ${where})`
}

// The last resort, for a prompt that is still too long after everything else (`batch.mjs`): it is
// cut at the limit, and says so.
export function fitToLimit(prompt) {
  const max = limits.PROMPT_MAX_BYTES
  if (Buffer.byteLength(prompt) <= max) return prompt
  const note = '\n(The rest of this prompt was cut: it was too long.)'
  return `${cutText(prompt, max - Buffer.byteLength(note))}${note}`
}

// ---------------------------------------------------------------------------------------------
// Lines of the datastore

// What a file's MIME type makes it, in a word.
function fileKind(mime) {
  if (mime.startsWith('image/')) return 'photo'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}

// What media that couldn't be stored was, in a word: WhatsApp's media types, with `image` as photo.
function mediaKind(type) {
  return type === 'image' ? 'photo' : token(type)
}

// Returns the functions that describe lines of the datastore, for one prompt.
// - `view`: `{ index, paths, agentName, now, timeZone }`.
// - `cap`: the most bytes of each text the items show.
// - `onCapped(bytes)`: called with the length of each text `cap` applies to.
function describer({ index, paths, agentName, now, timeZone }, cap, onCapped = () => {}) {
  // A text as `quote` shows it, and its length told to `onCapped` when a cap applies to it.
  const quote = (text, textCap, where) => {
    if (textCap !== Infinity) onCapped(Buffer.byteLength(text))
    return quoteText(text, textCap, where)
  }
  const filePath = (entry, file) => path.join(paths.dayDir(entry.day), file.path)
  const fileText = (entry, file) => `${file.name ? `${JSON.stringify(file.name)} ` : ''}${filePath(entry, file)} (${token(file.mime)})`
  const lineRef = seq => {
    const entry = index.get(seq)
    return `line ${entry.number} of ${paths.dayLog(entry.day)}`
  }
  const timeOf = entry => itemTime(parseIsoSeconds(entry.line.at), now, timeZone)
  const who = line => (line.dir === 'in' ? 'the owner' : line.by === agentName ? 'you' : 'Scooter')

  // A message as it is now. Returns `{ head, extra }`: what follows its time on its first line, and
  // its further lines. With `bare`, a plain text is only its text, as a quoted message is shown.
  function message(entry, { bare = false, textCap = cap } = {}) {
    const { line } = entry
    const current = index.current(line.seq)
    if (current.deletedIn !== null) return { head: `(deleted in #${current.deletedIn})`, extra: [] }
    const isEmail = line.source === 'email'
    const where = isEmail && line.files ? `the whole email is ${filePath(entry, line.files[0])}` : `the whole text is ${lineRef(current.editedIn ?? line.seq)}`
    const text = quote(current.text, textCap, where)
    const edited = current.editedIn !== null ? ` (edited in #${current.editedIn})` : ''
    const forwarded = dataFlag(line, 'forwarded') ? 'forwarded ' : ''
    const extra = []
    const files = line.files ?? []
    let head
    if (isEmail) {
      head = `${forwarded}email ${quote(dataText(line, 'subject') ?? '', textCap, where)}: ${text}`
      for (const file of files.slice(1)) extra.push(`attachment ${fileText(entry, file)}`)
      if (files.length > 0) extra.push(`whole email ${filePath(entry, files[0])}`)
    } else if (files.length > 0) {
      head = `${forwarded}${fileKind(files[0].mime)} ${fileText(entry, files[0])}${current.text === '' ? '' : `, caption: ${text}`}`
      for (const file of files.slice(1)) extra.push(`attachment ${fileText(entry, file)}`)
    } else if (line.media) {
      head = `${forwarded}${mediaKind(line.media.type)}, not stored (${phrase(line.media.error)})${current.text === '' ? '' : `, caption: ${text}`}`
    } else {
      head = bare && !forwarded ? text : `${forwarded}text: ${text}`
    }
    if (line.media && (isEmail || files.length > 0)) extra.push(`${mediaKind(line.media.type)} not stored (${phrase(line.media.error)})`)
    return { head: `${head}${edited}`, extra }
  }

  // The line under a reply: what it quotes, and who sent that. A reply to a line the index can't
  // show as a message, a line of a kind or a channel this version doesn't know, shows the channel's
  // preview, `quoted` in the line's `data`, if there is one.
  function replyLine(line) {
    const quoted = dataText(line, 'quoted')
    const preview = () => quote(quoted, cap, `the whole text is ${lineRef(line.seq)}`)
    if (line.replyTo !== undefined) {
      const target = index.get(line.replyTo)
      if (!target || index.current(line.replyTo) === undefined) {
        return quoted === undefined ? `↳ reply to #${line.replyTo}` : `↳ reply to #${line.replyTo}: ${preview()}`
      }
      return `↳ reply to #${line.replyTo}, which ${who(target.line)} sent: ${message(target, { bare: true }).head}`
    }
    if (quoted !== undefined) return `↳ reply to an earlier message: ${preview()}`
    return null
  }

  // An item of the batch: `#seq time what`, then its further lines.
  function item(seq, suffix = '') {
    const entry = index.get(seq)
    const { line } = entry
    let head
    let extra = []
    if (line.kind === 'edit') head = `edit of #${line.target}, now: ${quote(line.text, cap, `the whole text is ${lineRef(seq)}`)}`
    else if (line.kind === 'delete') head = `deletion of #${line.target}`
    else ({ head, extra } = message(entry))
    const reply = line.kind === 'message' ? replyLine(line) : null
    const lines = [`#${seq} ${timeOf(entry)} ${head}${suffix}`, ...extra.map(text => `${INDENT}${text}`)]
    if (reply) lines.push(`${INDENT}${reply}`)
    return lines.join('\n')
  }

  // A line of context: something sent, or a reaction. Its texts are shown whole.
  function context(seq) {
    const entry = index.get(seq)
    const { line } = entry
    const start = `#${seq} ${timeOf(entry)} ${who(line)}`
    if (line.kind === 'reaction') {
      // The emoji is in the line's `data`, "" for a reaction removed; without one, it isn't shown.
      const emoji = dataText(line, 'emoji')
      if (emoji === '') return `${start} removed ${line.dir === 'in' ? 'their' : 'your'} reaction to #${line.target}`
      return `${start} reacted ${emoji === undefined ? '' : `${token(emoji)} `}to #${line.target}`
    }
    const inReply = line.replyTo !== undefined ? `, in reply to #${line.replyTo}` : ''
    const { head, extra } = message(entry, { bare: true, textCap: Infinity })
    return [`${start} sent${inReply}: ${head}`, ...extra.map(text => `${INDENT}${text}`)].join('\n')
  }

  return { item, context }
}

// ---------------------------------------------------------------------------------------------
// The prompts

// The prompt of a batch. `batch` is what `assembleBatch` returns. `view` is `{ index, paths,
// agentName, header, now, timeZone }`, with `header` from `promptHeader`. Options, which
// `batch.mjs` uses to fit the prompt within its limit:
// - `itemCap`: the most bytes of each text an item shows, whole by default;
// - `contextKeep`: how many lines of context to show, newest first, all by default;
// - `onCapped(bytes)`: called with the length of each text `itemCap` applies to.
export function renderBatchPrompt(batch, view, { itemCap = Infinity, contextKeep = Infinity, onCapped } = {}) {
  const describe = describer(view, itemCap, onCapped)
  const sections = [view.header]
  const fresh = batch.items.filter(item => item.origin === 'new')
  const retrying = batch.items.filter(item => item.origin !== 'new')
  if (fresh.length > 0) sections.push([SECTIONS.new, ...fresh.map(item => describe.item(item.seq))].join('\n'))
  if (retrying.length > 0) {
    const lines = retrying.map(item => describe.item(item.seq, ` (attempt ${item.attempt} of ${limits.MAX_ATTEMPTS})`))
    sections.push([SECTIONS.retrying, ...lines].join('\n'))
  }
  // Newest first. When the prompt is too long, the oldest are left out first.
  const newestFirst = [...batch.context].reverse()
  const shown = newestFirst.slice(0, contextKeep)
  if (newestFirst.length > 0) {
    const lines = shown.map(seq => describe.context(seq))
    const left = newestFirst.length - shown.length
    if (left > 0) lines.push(`(${left} older ${left === 1 ? 'line' : 'lines'} left out: the prompt would have been too long)`)
    sections.push([SECTIONS.context, ...lines].join('\n'))
  }
  return sections.join('\n\n')
}

// The prompt of a scheduled task: the task instead of messages.
export function renderTaskPrompt(task, { header }) {
  return fitToLimit(`${header}\n\n${SECTIONS.task}\n${task.trim()}`)
}
