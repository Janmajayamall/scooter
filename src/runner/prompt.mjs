// What the agent is told (6.5 of DESIGN.md): the prompt, which is pi's user message, and
// `run/system.md`, which is appended to pi's system prompt.
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
//   For context only (no action, no DONE):
//   #1049 21:05 you sent: "Logged ₹340 Uber."
//   #1048 21:04 the owner reacted 👍 to #1046
//
// Every text the owner or the agent wrote is shown as a JSON string, so a line break or a quote in
// it can't pass for the prompt's own structure. The prompt is one command-line argument (6.6), so
// `batch.mjs` keeps it within `PROMPT_MAX_BYTES`, and a text too long for that is shown cut,
// followed by where the whole of it is.

import fs from 'node:fs'
import path from 'node:path'
import { limits } from '../common/limits.mjs'
import { localDate, parseIsoSeconds, toLocal } from '../common/time.mjs'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const pad = number => String(number).padStart(2, '0')

export const SECTIONS = {
  new: 'New messages:',
  retrying: 'Retrying (not handled yet):',
  context: 'For context only (no action, no DONE):',
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
// same year, and `Sat 8 Nov 2025 20:02` in another year.
export function itemTime(ms, now, timeZone) {
  const t = toLocal(ms, timeZone)
  const clock = `${pad(t.hour)}:${pad(t.minute)}`
  if (t.date === localDate(now, timeZone)) return clock
  const year = t.year === toLocal(now, timeZone).year ? '' : ` ${t.year}`
  return `${WEEKDAYS[t.weekday - 1].slice(0, 3)} ${t.day} ${MONTHS[t.month - 1].slice(0, 3)}${year} ${clock}`
}

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
function quote(text, cap, where) {
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
function describer({ index, paths, agentName, now, timeZone }, cap) {
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
    const forwarded = line.forwarded ? 'forwarded ' : ''
    const extra = []
    const files = line.files ?? []
    let head
    if (isEmail) {
      head = `${forwarded}email ${quote(line.subject ?? '', textCap, where)}: ${text}`
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

  // The line under a reply: what it quotes, and who sent that (6.5).
  function replyLine(line) {
    if (line.replyTo !== undefined) {
      const target = index.get(line.replyTo)
      if (!target || index.current(line.replyTo) === undefined) return `↳ reply to #${line.replyTo}`
      return `↳ reply to #${line.replyTo}, which ${who(target.line)} sent: ${message(target, { bare: true }).head}`
    }
    if (line.quoted !== undefined) return `↳ reply to an earlier message: ${quote(line.quoted, cap, `the whole text is ${lineRef(line.seq)}`)}`
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
      if (line.emoji === '') return `${start} removed ${line.dir === 'in' ? 'their' : 'your'} reaction to #${line.target}`
      return `${start} reacted ${token(line.emoji)} to #${line.target}`
    }
    const inReply = line.replyTo !== undefined ? `, in reply to #${line.replyTo}` : ''
    const { head, extra } = message(entry, { bare: true, textCap: Infinity })
    return [`${start} sent${inReply}: ${head}`, ...extra.map(text => `${INDENT}${text}`)].join('\n')
  }

  return { item, context }
}

// ---------------------------------------------------------------------------------------------
// The prompts

// The prompt of a batch (6.5). `batch` is what `assembleBatch` returns. `view` is `{ index, paths,
// agentName, header, now, timeZone }`, with `header` from `promptHeader`. Options, which
// `batch.mjs` uses to fit the prompt within its limit:
// - `itemCap`: the most bytes of each text an item shows, whole by default;
// - `contextKeep`: how many lines of context to show, newest first, all by default.
export function renderBatchPrompt(batch, view, { itemCap = Infinity, contextKeep = Infinity } = {}) {
  const describe = describer(view, itemCap)
  const sections = [view.header]
  const fresh = batch.items.filter(item => item.origin === 'new')
  const retrying = batch.items.filter(item => item.origin !== 'new')
  if (fresh.length > 0) sections.push([SECTIONS.new, ...fresh.map(item => describe.item(item.seq))].join('\n'))
  if (retrying.length > 0) {
    const lines = retrying.map(item => describe.item(item.seq, ` (attempt ${item.attempt} of ${limits.MAX_ATTEMPTS})`))
    sections.push([SECTIONS.retrying, ...lines].join('\n'))
  }
  // Newest first, as 6.5 shows them. When the prompt is too long, the oldest are left out first.
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

// The prompt of a scheduled or `once` task: the task instead of messages (6.5).
export function renderTaskPrompt(task, { header }) {
  return fitToLimit(`${header}\n\n${SECTIONS.task}\n${task.trim()}`)
}

// ---------------------------------------------------------------------------------------------
// The system prompt, `run/system.md`

// The protocol (7.1), which ships with the runner because the runner parses what it describes.
export function loadProtocol() {
  return fs.readFileSync(new URL('./protocol.md', import.meta.url), 'utf8')
}

// Reads a memory file for the system prompt. Returns null when there is none, and otherwise
// `{ text, cut }`, with at most `MEMORY_MAX_BYTES` of it.
//
// pi writes the memory folder. A run that leaves a link or anything but a file there fails, and is
// cleaned up (6.8), but a runner stopped before the clean-up would find it at its next run. So the
// file is opened without following a link, and must be a regular file: otherwise a link to the
// runner's env file would put the OpenRouter key into the prompt.
export function readMemoryFile(file) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  let fd
  try {
    fd = fs.openSync(file, flags)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code === 'ELOOP' || error.code === 'EMLINK') return { text: '(not a regular file, so not read)', cut: false }
    throw error
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { text: '(not a regular file, so not read)', cut: false }
    const max = limits.MEMORY_MAX_BYTES
    const buffer = Buffer.alloc(max + 1)
    let filled = 0
    while (filled < buffer.length) {
      const count = fs.readSync(fd, buffer, filled, buffer.length - filled, null)
      if (count === 0) break
      filled += count
    }
    const cut = filled > max
    // A character split by the cut decodes as U+FFFD, which is dropped.
    const text = buffer.subarray(0, Math.min(filled, max)).toString('utf8')
    return { text: cut ? text.replace(/\uFFFD+$/, '') : text, cut }
  } finally {
    fs.closeSync(fd)
  }
}

// `run/system.md` (6.5): the protocol, then the agent's prompt, then a `# Your memory` section with
// the current contents of `memory/preferences.md` and `memory/needs-review.md`, or "(empty)".
// `preferences` and `needsReview` are what `readMemoryFile` returns.
export function renderSystemPrompt({ protocol, prompt, preferences, needsReview }) {
  const memory = (name, read) => {
    const heading = `## memory/${name}`
    if (read === null || read.text.trim() === '') return `${heading}\n\n(empty)`
    const note = read.cut ? `\n\n(The file is longer than ${limits.MEMORY_MAX_BYTES} bytes, and only its beginning is shown. Shorten it.)` : ''
    return `${heading}\n\n${read.text.trimEnd()}${note}`
  }
  return [
    protocol.trimEnd(),
    prompt.trimEnd(),
    '# Your memory',
    memory('preferences.md', preferences),
    memory('needs-review.md', needsReview),
  ].join('\n\n') + '\n'
}
