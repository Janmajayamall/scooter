// The commands the bridge answers (5.4 of DESIGN.md): `/status`, `/help` and `/backup`. `/new` is
// the runner's, and the bridge passes over it.
//
// Commands reach the bridge as command lines in the datastore, written by intake like any other
// line. The bridge handles those newer than `commandSeq`, in its state, as the runner does with its
// own (6.4): it writes the reply to the outbox, then records the command as handled. So a command
// is answered once, also across a restart; a crash between the two can answer it twice, and never
// leaves it unanswered. The reply is `by: "bridge"`, with `about` set to the command, so it goes
// back where the command was sent (5.3).
//
// It runs when intake has stored a command, and once at startup for any the bridge didn't get to.

import { errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'

export const HELP_TEXT = [
  'Commands:',
  '/status: how Scooter is doing, and when it last ran',
  '/new: start a fresh conversation with the agent for the rest of the day',
  '/backup: back up now',
  '/help: this list',
  '',
  'Anything else you send is filed.',
].join('\n')

// The reply to `/backup` until backups are built (milestone 10 of the plan).
export const BACKUP_NOT_BUILT = "Backups aren't built into this version of Scooter yet, so nothing was backed up."

// Returns the commands' handler. Options:
// - `store`: the open store, whose index holds the command lines.
// - `state`: the bridge's state (`state.mjs`), which keeps `commandSeq`.
// - `paths`, `ids`: for the outbox (`writeOutboxEntry`); `ids` is the bridge's one generator.
// - `status()`: the reply to `/status` (`status.mjs`).
// - `backup()`: the reply to `/backup`.
export function createCommands({ store, state, paths, ids, log, status, backup = async () => BACKUP_NOT_BUILT }) {
  let queue = Promise.resolve()

  async function reply(command) {
    if (command === '/status') return status()
    if (command === '/help') return HELP_TEXT
    if (command === '/backup') return backup()
    // `/new` is the runner's.
    return null
  }

  async function handlePending() {
    for (const seq of store.index.commandsAfter(state.get().commandSeq)) {
      const command = store.index.get(seq).line.text
      const text = await reply(command)
      if (text !== null) {
        const entry = await writeOutboxEntry({ paths, ids, entry: { type: 'text', by: 'bridge', text, about: seq } })
        log.info('bridge.replied', { command, seq, entry })
      }
      state.update({ commandSeq: seq })
    }
  }

  return {
    // Handles the commands not handled yet, after what is already under way. Never rejects: a
    // failure is logged, and the next call tries the same commands again.
    handle() {
      queue = queue.then(handlePending).catch(error => log.error('bridge.command_failed', errorFields(error)))
      return queue
    },

    // Resolves when what was asked for so far is done.
    idle: () => queue,
  }
}
