// The in-memory index of the datastore (4.3 of DESIGN.md): what the bridge and the runner each
// rebuild by reading every line at startup, and keep current as lines arrive.
//
// It answers three questions:
// - which line has this `seq`, and which day folder is it in;
// - which `seq` has this channel ID, `(source, sourceId)`;
// - what a message says now, after its edits, and whether it was deleted.

import { DatastoreError } from './line.mjs'

// The kinds of line that are known by their own channel ID. An `edit` carries the ID of the
// message it changes (13.1), so it is never looked up by it, and neither is a `delete`.
const KNOWN_BY_ID = ['message', 'command', 'reaction']

const idKey = (source, sourceId) => `${source}\n${sourceId}`

export function createIndex() {
  const entries = new Map() // seq -> { line, day, number }
  const ids = new Map() // (source, sourceId) -> seq
  const states = new Map() // seq -> { text, editedIn, deletedIn }
  const commands = [] // the seq of every command line, in order
  let lastSeq = 0
  let newestDay = null
  let lineNumber = 0

  return {
    // Adds the next line. `day` is its day folder, `YYYY/MM/DD`. Lines come in `seq` order, each
    // one more than the last, starting at 1.
    add(line, day) {
      if (line.seq !== lastSeq + 1) {
        throw new DatastoreError(`seq ${line.seq} follows seq ${lastSeq}: each line's seq must be one more than the last`)
      }
      if (newestDay !== null && day < newestDay) {
        throw new DatastoreError(`seq ${line.seq} is in day folder ${day}, which is before ${newestDay}`)
      }
      // Each day's log holds its lines in order, so a line's number in it follows from the last.
      lineNumber = day === newestDay ? lineNumber + 1 : 1
      lastSeq = line.seq
      newestDay = day
      entries.set(line.seq, { line, day, number: lineNumber })

      if (line.sourceId !== undefined && KNOWN_BY_ID.includes(line.kind)) {
        const key = idKey(line.source, line.sourceId)
        // The first line with an ID keeps it.
        if (!ids.has(key)) ids.set(key, line.seq)
      }

      if (line.kind === 'command') commands.push(line.seq)

      // What a line says now. Messages have a text that edits replace; a command has one too.
      if (line.kind === 'message' || line.kind === 'command') {
        states.set(line.seq, { text: line.text, editedIn: null, deletedIn: null })
      }
      const state = states.get(line.target)
      if (state && line.kind === 'edit') {
        state.text = line.text
        state.editedIn = line.seq
      }
      if (state && line.kind === 'delete' && state.deletedIn === null) {
        state.deletedIn = line.seq
      }
    },

    // The line with this `seq`, as `{ line, day, number }`, or undefined. `number` is its line
    // number in its day's `log.jsonl`, counting from 1.
    get: seq => entries.get(seq),

    // The `seq` of the message, command or reaction that has this channel ID, or undefined.
    seqOf: (source, sourceId) => ids.get(idKey(source, sourceId)),

    // How a message stands now: `{ text, editedIn, deletedIn }`. `text` is its latest text,
    // `editedIn` the `seq` of its latest edit, and `deletedIn` the `seq` of its deletion; the last
    // two are null when there was none. Undefined for a `seq` that isn't a message or a command.
    current(seq) {
      const state = states.get(seq)
      return state ? { ...state } : undefined
    },

    // The `seq` of every command line after `after`, in order. The runner handles commands as they
    // come (6.4), and finds them here without reading every line again.
    commandsAfter(after) {
      let start = commands.length
      while (start > 0 && commands[start - 1] > after) start -= 1
      return commands.slice(start)
    },

    // The highest `seq` there is, or 0 when the datastore is empty.
    get lastSeq() {
      return lastSeq
    },

    // The day folder of the newest line, or null.
    get newestDay() {
      return newestDay
    },

    // Every line in order, as `{ line, day, number }`.
    entries: () => entries.values(),
  }
}
