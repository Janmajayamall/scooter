// The bridge's service, `scooter bridge` (section 5 of DESIGN.md; ARCHITECTURE.md 4.4).
//
// It opens the datastore and the bridge's state, starts the channels, and connects each to intake,
// which writes through the store. Then it runs until it is told to stop.
//
// At startup, in order:
// 1. It looks up its users: wacli runs as `scooter-wacli`, and the datastore belongs to root with
//    the group `scooter-runner` (3.2). Not root, it is neither, and switching is skipped (10).
// 2. It makes sure it is the only bridge on this data folder (`holdInstance`). Two would each give
//    out the same `seq`, and the datastore would need repairing by hand (D29).
// 3. It reads the datastore, removing part of a line a crash left, and rebuilds the index.
// 4. It makes its channels: WhatsApp, and email when `EMAIL_IMAP_HOST` is set (5.6). It checks
//    `DEFAULT_CHANNEL`: a channel that can send, which in v2 is only WhatsApp (5.3).
// 5. It starts the channels.
// 6. It answers the commands it hadn't answered, and starts delivery, which first sends what was
//    left in the outbox, from where a crash cut it short (5.3).
//
// Milestone 10 adds removing a leftover `backup.lock`.

import fs from 'node:fs'
import { createIds, ensureDir } from '../common/files.mjs'
import { holdInstance } from '../common/instance.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc } from '../common/proc.mjs'
import { systemClock } from '../common/time.mjs'
import { createEmail } from './channels/email.mjs'
import { defaultChannelProblem } from './channels/index.mjs'
import { createWhatsApp } from './channels/whatsapp.mjs'
import { createCommands } from './commands.mjs'
import { createIntake } from './intake.mjs'
import { createOutbox } from './outbox.mjs'
import { openBridgeState } from './state.mjs'
import { statusText } from './status.mjs'
import { openStore } from './store.mjs'

// What `/status` says about backups until milestone 10 of the plan builds them.
export const BACKUPS_NOT_BUILT = "Backups: none yet. This version of Scooter doesn't make them."

// The bridge can't start because of how it is configured. `scooter bridge` exits with 2 (D30).
export class BridgeConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeConfigError'
  }
}

// Starts the bridge. Returns `{ paths, store, state, intake, channels, outbox, commands, fatal,
// stop }`, where `fatal` resolves with an error if the bridge can't go on, and `stop()` stops it.
// `proc` is what `createProc` returns; tests give one with a clock of their own, and `emailReader`
// a stub of the email reader. Throws a `BridgeConfigError` when `DEFAULT_CHANNEL` can't send, or
// email is on without `EMAIL_AUTHSERV_ID`.
export async function startBridge({ settings, clock = systemClock, log = createLog({ component: 'bridge', clock }), proc = createProc({ log, clock }), emailReader }) {
  // `email-check` runs without it, so the owner can find it there (8.4); the sender check can't.
  if (settings.email && !settings.email.authservId) {
    throw new BridgeConfigError('EMAIL_AUTHSERV_ID is required when EMAIL_IMAP_HOST is set; `scooter email-check` shows what to set it to')
  }
  const paths = makePaths(settings)
  const wacliUser = await proc.lookupUser('scooter-wacli')
  const runnerUser = await proc.lookupUser('scooter-runner')
  const mailUser = settings.email ? await proc.lookupUser('scooter-mail') : null
  // Root's, with the runner's group, so the runner can read it and only root can write it (3.2).
  const storeOwner = runnerUser ? { uid: 0, gid: runnerUser.gid } : null

  // The data folder holds only the folders of 3.2, each with its owner and mode, and every service
  // user passes through it to reach its own. `setup` makes it natively (8.4); this is for
  // development.
  ensureDir(paths.dataDir, { mode: 0o755 })
  ensureDir(paths.bridge, { mode: 0o700 })
  // The exchange is the runner's (3.2), and the bridge writes its own replies into the outbox
  // there. Made here, if it is missing, with the runner's owner, so that a bridge that writes the
  // first entry doesn't leave the runner a folder it can't write.
  for (const folder of [paths.exchange, paths.outbox]) ensureDir(folder, { mode: 0o700, owner: runnerUser })
  const instance = await holdInstance(paths.bridgeSocket, 'bridge')
  try {
    // Attachments that waited for the store when the bridge last stopped. Their messages weren't
    // stored, and catch-up or the mail spool, whose folders stay until they are, hands them over
    // again.
    fs.rmSync(paths.bridgeIncoming, { recursive: true, force: true })
    const store = openStore({ paths, clock, log, owner: storeOwner })
    const state = openBridgeState({ paths, clock, log, newestSeq: store.index.lastSeq })

    let reportFatal
    const fatal = new Promise(resolve => (reportFatal = resolve))
    const channels = new Map()
    const ids = createIds(clock)
    const status = async () => statusText({ now: clock.now(), settings, paths, channels, index: store.index, backups: BACKUPS_NOT_BUILT })
    const commands = createCommands({ store, state, paths, ids, log, clock, status })
    const intake = createIntake({ store, channels, paths, log, clock, onFatal: reportFatal, onCommand: () => commands.handle() })
    const whatsapp = createWhatsApp({
      settings,
      paths,
      proc,
      log,
      clock,
      state,
      user: wacliUser,
      newestIncomingAt: () => intake.newestIncomingAt('whatsapp'),
    })
    channels.set(whatsapp.name, whatsapp)
    if (settings.email) {
      const email = createEmail({ settings, paths, proc, log, clock, user: mailUser, ...(emailReader ? { reader: emailReader } : {}) })
      channels.set(email.name, email)
    }
    const problem = defaultChannelProblem(channels, settings.defaultChannel)
    if (problem !== null) throw new BridgeConfigError(problem)

    const take = record => intake.take(record)
    for (const channel of channels.values()) await channel.start(take)
    commands.handle()
    const outbox = createOutbox({ paths, store, channels, defaultChannel: settings.defaultChannel, log, clock, owner: runnerUser, onFatal: reportFatal })
    outbox.start()
    log.info('bridge.started', { lines: store.index.lastSeq, channels: [...channels.keys()], defaultChannel: settings.defaultChannel })

    let stopping = null
    return {
      paths,
      store,
      state,
      intake,
      channels,
      outbox,
      commands,
      fatal,
      // Stops delivery, cutting short a send in progress, which goes out again at the next start;
      // then the channels; waits for what they handed over to be stored and answered; and lets go
      // of the data folder.
      stop: () =>
        (stopping ??= (async () => {
          await outbox.stop()
          for (const channel of channels.values()) await channel.stop()
          await intake.idle()
          await commands.stop()
          await instance.close()
          log.info('bridge.stopped')
        })()),
    }
  } catch (error) {
    await instance.close()
    throw error
  }
}

// `scooter bridge`: runs the bridge until SIGTERM or SIGINT. Exits with 2 if `DEFAULT_CHANNEL`
// can't send, and with 1 if it can't start for another reason or can't go on.
export async function runBridge({ settings, stderr }) {
  const log = createLog({ component: 'bridge' })
  let bridge
  try {
    bridge = await startBridge({ settings, log })
  } catch (error) {
    log.error('bridge.start_failed', errorFields(error))
    // For the person starting it. What can fail here says where, and quotes no content: a
    // DatastoreError names the file and the line (D29), the others a path, a user or a setting.
    stderr.write(`scooter bridge: ${error.message}\n`)
    return error instanceof BridgeConfigError ? 2 : 1
  }
  const outcome = await new Promise(resolve => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => resolve(signal))
    bridge.fatal.then(() => resolve('fatal'))
  })
  log.info('bridge.stopping', { reason: outcome })
  await bridge.stop()
  return outcome === 'fatal' ? 1 : 0
}
