// The bridge's service, `scooter bridge` (section 5 of DESIGN.md; ARCHITECTURE.md 4.4).
//
// It opens the datastore and the bridge's state, starts the channels, and connects each to intake,
// which writes through the store. Then it runs until it is told to stop.
//
// At startup, in order:
// 1. It looks up its users: wacli runs as `scooter-wacli`, and the datastore belongs to root with
//    the group `scooter-runner` (3.2). Not root, it is neither, and switching is skipped (10).
// 2. It makes sure it is the only bridge on this data folder (`holdInstance`). Two would each
//    give out the same `seq`, and the datastore would need repairing by hand (D29).
// 3. It reads the datastore, removing part of a line a crash left, and rebuilds the index.
// 4. It starts the channels.
//
// Later milestones add to this: sending what is left in the outbox (5), the email channel (6),
// and removing a leftover `backup.lock` (10).

import fs from 'node:fs'
import net from 'node:net'
import { ensureDir } from '../common/files.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc } from '../common/proc.mjs'
import { systemClock } from '../common/time.mjs'
import { createWhatsApp } from './channels/whatsapp.mjs'
import { createIntake } from './intake.mjs'
import { openBridgeState } from './state.mjs'
import { openStore } from './store.mjs'

// Makes sure only one bridge runs on a data folder: it listens on a Unix socket in the bridge's
// folder. A second bridge finds the socket answering and refuses to start. A socket left by a
// bridge that was killed doesn't answer, and is replaced. Unlike a lock file holding a pid, this
// can't mistake an unrelated process that was given the same pid for a bridge, and it works across
// containers that share the folder. Returns `{ close }`.
export async function holdInstance(file) {
  const server = net.createServer(socket => socket.destroy())
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(file, () => {
        server.off('error', reject)
        resolve()
      })
    })
  const answers = () =>
    new Promise(resolve => {
      const socket = net.connect(file)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })

  try {
    await listen()
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    if (await answers()) throw new Error(`another bridge is running on this data folder: ${file} answers`)
    fs.rmSync(file, { force: true })
    await listen()
  }
  // Node removes the socket when it stops listening.
  return { close: () => new Promise(resolve => server.close(() => resolve())) }
}

// Starts the bridge. Returns `{ paths, store, state, intake, channels, fatal, stop }`, where
// `fatal` resolves with an error if the bridge can't go on, and `stop()` stops it. `proc` is what
// `createProc` returns; tests give one with a clock of their own.
export async function startBridge({ settings, clock = systemClock, log = createLog({ component: 'bridge', clock }), proc = createProc({ log, clock }) }) {
  const paths = makePaths(settings)
  const wacliUser = await proc.lookupUser('scooter-wacli')
  const runnerUser = await proc.lookupUser('scooter-runner')
  // Root's, with the runner's group, so the runner can read it and only root can write it (3.2).
  const storeOwner = runnerUser ? { uid: 0, gid: runnerUser.gid } : null

  // The data folder holds only the folders of 3.2, each with its owner and mode, and every service
  // user passes through it to reach its own. `setup` makes it natively (8.4); this is for
  // development.
  ensureDir(paths.dataDir, { mode: 0o755 })
  ensureDir(paths.bridge, { mode: 0o700 })
  const instance = await holdInstance(paths.bridgeSocket)
  try {
    // Attachments that waited for the store when the bridge last stopped. Their messages weren't
    // stored, and catch-up or the mail spool hands them over again.
    fs.rmSync(paths.bridgeIncoming, { recursive: true, force: true })
    const store = openStore({ paths, clock, log, owner: storeOwner })
    const state = openBridgeState({ paths, clock, log })

    let reportFatal
    const fatal = new Promise(resolve => (reportFatal = resolve))
    const channels = new Map()
    const intake = createIntake({ store, channels, paths, log, clock, onFatal: reportFatal })
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
    const take = record => intake.take(record)
    for (const channel of channels.values()) await channel.start(take)
    log.info('bridge.started', { lines: store.index.lastSeq, channels: [...channels.keys()] })

    let stopping = null
    return {
      paths,
      store,
      state,
      intake,
      channels,
      fatal,
      // Stops the channels, waits for what they handed over to be stored, and lets go of the data
      // folder.
      stop: () =>
        (stopping ??= (async () => {
          for (const channel of channels.values()) await channel.stop()
          await intake.idle()
          await instance.close()
          log.info('bridge.stopped')
        })()),
    }
  } catch (error) {
    await instance.close()
    throw error
  }
}

// `scooter bridge`: runs the bridge until SIGTERM or SIGINT. Exits with 1 if it can't start or
// can't go on.
export async function runBridge({ settings, stderr }) {
  const log = createLog({ component: 'bridge' })
  let bridge
  try {
    bridge = await startBridge({ settings, log })
  } catch (error) {
    log.error('bridge.start_failed', errorFields(error))
    // For the person starting it. What can fail here says where, and quotes no content: a
    // DatastoreError names the file and the line (D29), the others a path or a user.
    stderr.write(`scooter bridge: ${error.message}\n`)
    return 1
  }
  const outcome = await new Promise(resolve => {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => resolve(signal))
    bridge.fatal.then(() => resolve('fatal'))
  })
  log.info('bridge.stopping', { reason: outcome })
  await bridge.stop()
  return outcome === 'fatal' ? 1 : 0
}
