// The bridge's own state, `bridge/state.json` (5.1 of DESIGN.md).
//
//   {"firstStart":"2026-11-09T15:43:02Z","ownerChat":{"jid":"919812345678@s.whatsapp.net","at":"2026-11-09T15:50:11Z"},"lastBackup":null,"commandSeq":1038}
//
// - `firstStart`: when the bridge first started. WhatsApp's catch-up never reaches back before it,
//   so the chat's earlier history is never imported (5.2 step 7).
// - `ownerChat`: the chat of the owner's newest message, and that message's time. Replies go to it
//   (5.2 step 5). Null before the owner has written.
// - `lastBackup`: the last backup that ran to its end (5.5): `{ at, ok, snapshot, reason }`, when it
//   started, whether it worked, the snapshot it saved or null, and, when it failed, why, in words
//   for the owner, restic's among them, which no log holds. Null before the first.
// - `commandSeq`: the `seq` of the newest command line the bridge has handled (5.4), as the runner
//   keeps its own in `state.json` (6.3). A state written before the bridge handled commands has
//   none, and gets the newest line's, so commands sent before that are never answered.
// - `catchUp`: where WhatsApp's catch-up has got to in each of the owner's chats (5.2 step 7;
//   D179): `{ "<chat JID>": "<UTC time>" }`, the time of the newest of the owner's rows it has
//   listed there with every row before it handled. The next catch-up of that chat starts
//   `CATCHUP_OVERLAP` before it. A state an older bridge wrote has none until the channel first
//   saves one.
//
// Only the bridge reads and writes it. It is written atomically, mode 0600, in the bridge's own
// folder, which only root can read (3.2).

import { readJsonFile, writeFileAtomic } from '../common/files.mjs'
import { isoSeconds, parseIsoSeconds, systemClock } from '../common/time.mjs'

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

// What is wrong with the contents of the state file, or nothing.
function problemsOf(state) {
  if (!isObject(state)) return 'not an object'
  if (parseIsoSeconds(state.firstStart) === null) return 'firstStart must be a UTC time to the second'
  const chat = state.ownerChat
  if (chat !== null && !(isObject(chat) && typeof chat.jid === 'string' && chat.jid !== '' && parseIsoSeconds(chat.at) !== null)) {
    return 'ownerChat must be null or { jid, at }'
  }
  const backup = state.lastBackup
  const orNull = (value, check) => value === null || check(value)
  if (
    backup !== null &&
    !(
      isObject(backup) &&
      Object.keys(backup).length === 4 &&
      parseIsoSeconds(backup.at) !== null &&
      typeof backup.ok === 'boolean' &&
      orNull(backup.snapshot, value => typeof value === 'string' && /^[0-9a-f]{8,64}$/.test(value)) &&
      orNull(backup.reason, value => typeof value === 'string')
    )
  ) {
    return 'lastBackup must be null or { at, ok, snapshot, reason }'
  }
  if (!Number.isSafeInteger(state.commandSeq) || state.commandSeq < 0) return 'commandSeq must be a whole number, 0 or more'
  const points = state.catchUp
  if (points !== undefined && !(isObject(points) && Object.entries(points).every(([chat, at]) => chat !== '' && parseIsoSeconds(at) !== null))) {
    return 'catchUp must be { "<chat>": "<UTC time>" }'
  }
  return null
}

// Opens the state, creating it on the very first start. Throws if the file is there and isn't a
// state: it is written atomically, so that is not something a crash leaves. `newestSeq` is the
// datastore's newest `seq`, which a state without `commandSeq` starts from.
export function openBridgeState({ paths, clock = systemClock, log, newestSeq = 0 }) {
  const file = paths.bridgeState
  let state
  try {
    state = readJsonFile(file)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new Error(`${file} is not JSON`)
  }
  if (state === undefined) {
    state = { firstStart: isoSeconds(clock.now()), ownerChat: null, lastBackup: null, commandSeq: newestSeq }
    writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    log.info('bridge.first_start', { firstStart: state.firstStart })
  } else if (isObject(state) && state.commandSeq === undefined) {
    state = { ...state, commandSeq: newestSeq }
    if (problemsOf(state) === null) writeFileAtomic(file, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  }
  const problem = problemsOf(state)
  if (problem) throw new Error(`${file}: ${problem}`)

  return {
    // A copy of the state.
    get: () => structuredClone(state),

    // Changes some fields and writes the file.
    update(changes) {
      const next = { ...state, ...changes }
      const problem = problemsOf(next)
      if (problem) throw new Error(`not a bridge state: ${problem}`)
      writeFileAtomic(file, `${JSON.stringify(next)}\n`, { mode: 0o600 })
      state = next
    },
  }
}
