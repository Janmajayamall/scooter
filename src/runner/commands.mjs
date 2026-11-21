// The commands the runner handles: `/new`, and passing over the
// bridge's.
//
// Before it builds a batch, the runner handles the command lines newer than `commandSeq`: it works
// out the new state and the replies (`applyCommands`), writes the replies to the outbox, and saves
// the state at once. Going by the cursor instead would handle a command again after a run cut
// short by a crash or a stop, which leaves the cursor where it was; a run that finishes, failed or
// not, moves it. A crash between the two writes can send a
// reply twice, and never loses one.

import { writeOutboxEntry } from '../common/outbox.mjs'
import { applyCommands, saveState } from './state.mjs'

// Handles `lines`, the commands `nextAction` returned, and returns the new state.
// - `state`: the agent's state now; `stateFile`: where it is saved.
// - `paths`, `ids`: for the outbox (`writeOutboxEntry`).
// - `now`, `timeZone`, `rolloverHour`: for the session's day.
export async function handleCommands({ agent, state, lines, stateFile, paths, ids, log, now, timeZone, rolloverHour }) {
  const { state: next, replies } = applyCommands(state, lines, { now, timeZone, rolloverHour })
  for (const reply of replies) {
    const id = await writeOutboxEntry({ paths, ids, entry: reply })
    log.info('runner.replied', { agent: agent.name, about: reply.about, entry: id })
  }
  saveState(stateFile, next)
  for (const line of lines) log.info('runner.command', { agent: agent.name, seq: line.seq, command: line.text })
  return next
}
