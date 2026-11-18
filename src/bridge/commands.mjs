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
// A reply that can't be written, as on a full disk, is tried again after a wait that doubles,
// as a failed look at the outbox is (`SEND_RETRY_BACKOFF`), without waiting for another command.

import { limits } from '../common/limits.mjs'
import { errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { systemClock } from '../common/time.mjs'

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
export function createCommands({ store, state, paths, ids, log, clock = systemClock, status, backup = async () => BACKUP_NOT_BUILT }) {
  let queue = Promise.resolve()
  let failures = 0
  // The wait before the next try, after a failure, which `stop()` cuts short.
  let retrying = null
  let stopped = false

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

  // The wait after the `n`th failure in a row.
  function backoff(n) {
    const { first, factor, max } = limits.SEND_RETRY_BACKOFF
    return Math.min(first * factor ** Math.max(0, n - 1), max)
  }

  function handle() {
    if (stopped) return queue
    queue = queue
      .then(handlePending)
      .then(() => {
        failures = 0
      })
      .catch(error => {
        failures += 1
        log.error('bridge.command_failed', { failures, ...errorFields(error) })
        if (retrying) return
        const wait = new AbortController()
        retrying = wait
        clock.sleep(backoff(failures), { signal: wait.signal }).then(
          () => {
            retrying = null
            handle()
          },
          () => {},
        )
      })
    return queue
  }

  return {
    // Handles the commands not handled yet, after what is already under way. Never rejects: a
    // failure is logged, and the same commands are tried again after a wait, or at the next call.
    handle,

    // Resolves when what was asked for so far is done.
    idle: () => queue,

    // Tries nothing more, and resolves when what is under way is done.
    async stop() {
      stopped = true
      retrying?.abort()
      retrying = null
      await queue
    },
  }
}
