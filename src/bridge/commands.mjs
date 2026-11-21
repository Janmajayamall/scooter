// The commands the bridge answers: `/status`, `/help` and `/backup`. `/new` is
// the runner's, and the bridge passes over it.
//
// Commands reach the bridge as command lines in the datastore, written by intake like any other
// line. The bridge handles those newer than `commandSeq`, in its state, as the runner does with its
// own: it writes the reply to its outbox, then records the command as handled. So a command
// is answered once, also across a restart; a crash between the two can answer it twice, and never
// leaves it unanswered. The reply is `by: "bridge"`, with `about` set to the command, so it goes
// back where the command was sent.
//
// It runs when intake has stored a command, and once at startup for any the bridge didn't get to.
// A reply that can't be written, as on a full disk, is tried again after a wait that doubles,
// as a failed look at the outbox is (`SEND_RETRY_BACKOFF`), without waiting for another command.
//
// `/backup` starts a backup, or joins the one in progress, and its reply comes when the backup is
// over (`backup.mjs`), which may be minutes later, after a run has finished. Commands are answered
// one at a time, so waiting for it here would hold back a `/status` sent after it. The command
// counts as handled once the backup has started: a bridge that crashes during the backup doesn't
// answer it (docs/DECISIONS.md, milestone 10).

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

// Returns the commands' handler. Options:
// - `store`: the open store, whose index holds the command lines.
// - `state`: the bridge's state (`state.mjs`), which keeps `commandSeq`.
// - `paths`, `ids`: for the bridge's own outbox (`writeOutboxEntry`, D205); `ids` is the bridge's
//   one generator.
// - `status()`: the reply to `/status` (`status.mjs`).
// - `backup(seq)`: what `/backup`, the command line `seq`, does (`createBackups().ask`): the reply
//   to give now, or null when the backup gives it once it is over.
export function createCommands({ store, state, paths, ids, log, clock = systemClock, status, backup = () => null }) {
  let queue = Promise.resolve()
  let failures = 0
  // The wait before the next try, after a failure, which `stop()` cuts short.
  let retrying = null
  let stopped = false

  async function reply(command, seq) {
    if (command === '/status') return status()
    if (command === '/help') return HELP_TEXT
    if (command === '/backup') return backup(seq)
    // `/new` is the runner's.
    return null
  }

  async function handlePending() {
    for (const seq of store.index.commandsAfter(state.get().commandSeq)) {
      const command = store.index.get(seq).line.text
      const text = await reply(command, seq)
      if (text !== null) {
        const entry = await writeOutboxEntry({ paths, ids, entry: { type: 'text', by: 'bridge', text, about: seq }, outbox: paths.bridgeOutbox })
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
