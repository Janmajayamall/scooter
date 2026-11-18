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
// 3. It removes a leftover `backup.lock`, which would otherwise keep the agent from running for
//    good (5.5): only the bridge takes it, and this is the only bridge.
// 4. It reads the datastore, removing part of a line a crash left, and rebuilds the index.
// 5. It makes its channels: WhatsApp, and email when `EMAIL_IMAP_HOST` is set (5.6). It checks
//    `DEFAULT_CHANNEL`: a channel that can send, which in v2 is only WhatsApp (5.3).
// 6. It starts the channels.
// 7. It answers the commands it hadn't answered, starts delivery, which first sends what was left
//    in the outbox, from where a crash cut it short (5.3), and starts the backups' schedule.

import fs from 'node:fs'
import { checkOwnFolder, createIds, ensureDir } from '../common/files.mjs'
import { holdInstance } from '../common/instance.mjs'
import { lockExists, releaseLock } from '../common/locks.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc } from '../common/proc.mjs'
import { systemClock } from '../common/time.mjs'
import { createBackups } from './backup.mjs'
import { createEmail } from './channels/email.mjs'
import { defaultChannelProblem } from './channels/index.mjs'
import { createWhatsApp } from './channels/whatsapp.mjs'
import { createCommands } from './commands.mjs'
import { createIntake } from './intake.mjs'
import { createOutbox } from './outbox.mjs'
import { openBridgeState } from './state.mjs'
import { statusText } from './status.mjs'
import { openStore } from './store.mjs'

// The bridge can't start because of how it is configured. `scooter bridge` exits with 2 (D30).
export class BridgeConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BridgeConfigError'
  }
}

// Starts the bridge. Returns `{ paths, store, state, intake, channels, outbox, commands, backups,
// fatal, stop }`, where `fatal` resolves with an error if the bridge can't go on, and `stop()`
// stops it.
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
  // there, and its `backup.lock` into `locks/`. Made here, if they are missing, with the runner's
  // owner, so that a bridge that writes there first doesn't leave the runner a folder it can't
  // write.
  for (const folder of [paths.exchange, paths.outbox, paths.locks]) ensureDir(folder, { mode: 0o700, owner: runnerUser })
  const instance = await holdInstance(paths.bridgeSocket, 'bridge')
  try {
    // A backup the bridge was making when it last stopped is over. The folder is the runner's,
    // and is used only while it is the runner's and not a link (D136).
    try {
      checkOwnFolder(paths.locks, runnerUser)
      if (lockExists(paths.backupLock)) {
        releaseLock(paths.backupLock)
        log.warn('bridge.lock_removed', { lock: 'backup.lock' })
      }
    } catch (error) {
      log.error('bridge.lock_not_removed', { lock: 'backup.lock', ...errorFields(error) })
    }
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
    // `backups` is made below, before any channel starts, so before any command can come.
    const status = async () => statusText({ now: clock.now(), settings, paths, channels, index: store.index, backups: backups.statusLine(clock.now()) })
    const commands = createCommands({ store, state, paths, ids, log, clock, status, backup: seq => backups.ask(seq) })
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
    const outbox = createOutbox({ paths, store, channels, defaultChannel: settings.defaultChannel, log, clock, owner: runnerUser, onFatal: reportFatal })
    // What a backup stops while restic reads (5.5, step 3): delivery, between two messages; then
    // the channels, which stop wacli's calls in progress, so a download a stop cut short leaves
    // its message for catch-up, and intake the messages after it (D179); then what intake was
    // storing. Started again, a channel's messages are stored again.
    const stopped = []
    const backups = createBackups({
      settings,
      paths,
      proc,
      log,
      clock,
      ids,
      state,
      runnerUser,
      quiesce: async () => {
        await outbox.pause()
        for (const channel of channels.values()) {
          stopped.push(channel)
          await channel.stop()
        }
        await intake.idle()
      },
      resume: async () => {
        for (const channel of stopped.splice(0)) {
          intake.started(channel.name)
          await channel.start(take)
        }
        outbox.resume()
      },
      onFatal: reportFatal,
    })
    for (const channel of channels.values()) await channel.start(take)
    commands.handle()
    outbox.start()
    backups.start()
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
      backups,
      fatal,
      // Stops the backups, cutting short one in progress, which then starts nothing again; then
      // delivery, cutting short a send in progress, which goes out again at the next start; then
      // the channels; waits for what they handed over to be stored and answered; and lets go of
      // the data folder.
      stop: () =>
        (stopping ??= (async () => {
          await backups.stop()
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

// `scooter bridge`: runs the bridge until SIGTERM or SIGINT. `SIGUSR1` starts a backup now (8.4).
// Exits with 2 if `DEFAULT_CHANNEL` can't send, and with 1 if it can't start for another reason or
// can't go on.
export async function runBridge({ settings, stderr }) {
  const log = createLog({ component: 'bridge' })
  let bridge = null
  // Taken first: without a listener, Node answers SIGUSR1 by opening its debugger.
  const backupNow = () => {
    if (bridge === null) log.warn('bridge.backup_signal_ignored', { reason: 'the bridge is still starting' })
    else bridge.backups.request('signal')
  }
  process.on('SIGUSR1', backupNow)
  try {
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
  } finally {
    process.off('SIGUSR1', backupNow)
  }
}
