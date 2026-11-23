// Backups: nightly, encrypted, with restic, and the commands that look after
// the repository and restore from it.
//
// This is the only module that runs restic. It runs it directly, with the
// arguments as a list and the settings in its environment, never through a shell, and never with
// the password on its command line. restic's environment holds the repository, the password, the
// bucket's credentials, a temporary folder and `TZ`, and nothing else of the bridge's.
//
// The operations, which the CLI commands and the bridge call:
// - `init` (`scooter backup-init`): makes the repository, unless `restic cat config` finds it there.
// - `run`: the nightly backup, `restic backup` of the folders `backupSources` gives, then `restic forget --prune`
//   with the retention of `RESTIC_KEEP_*`, then `restic check` on Sundays or with `FORCE_CHECK=1`.
// - `snapshots`, `check`: restic's own, for the owner at a terminal.
// - `restore [snapshot] [--force]`: a snapshot back into `RESTORE_TARGET`, `/` by default, which
//   puts every file back at the path it was backed up from.
//
// The bridge's side (`createBackups`): the schedule and `SIGUSR1`; the consistency steps that keep
// a backup from seeing half a run or half a message; the result in the bridge's state; and the
// notice when a backup fails.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkOwnFolder, ensureDir, readUntrustedFile } from '../common/files.mjs'
import { instanceAnswers } from '../common/instance.mjs'
import { limits } from '../common/limits.mjs'
import { releaseLock, takeLock } from '../common/locks.mjs'
import { createLog, errorFields } from '../common/log.mjs'
import { writeOutboxEntry } from '../common/outbox.mjs'
import { makePaths } from '../common/paths.mjs'
import { createProc } from '../common/proc.mjs'
import { isoSeconds, nextLocalTime, parseIsoSeconds, parseLocalTime, shortLocalTime, systemClock, toLocal } from '../common/time.mjs'

const RESTIC = 'restic'

// Every snapshot Scooter makes has this host and this tag, and the snapshots it lists, forgets
// and restores are only those. In Docker the bridge's container is called `scooter` too.
const HOST = 'scooter'
const TAG = 'scooter'
// They are one group, whatever folders each holds. restic groups by host and paths unless told,
// and the folders change when one first appears, such as `runner/log/` after the first run or
// `mail/` when email is turned on: `forget` would then keep the last snapshot of the old
// folders for good, and `backup` would find no parent, and read every file again.
const GROUP = ['--group-by', 'host,tags']

// What a backup holds, and what it leaves out: wacli's cache; what the runner's clean-up set aside
// and is removing; and the bridge's status, which says how the bridge that wrote it is doing, and
// is written while a backup runs. The status is left out as its folder, `bridge/status/`, so that
// the temporary file each write makes beside it is left out too. The cache restic keeps in the
// bridge's folder marks itself as one, and `--exclude-caches` leaves it out. `exchange/locks/`
// isn't held: a lock restored would keep the runner, or the backups, waiting for a run or a backup
// that isn't there.
export function backupSources(paths) {
  return {
    include: [paths.datastore, paths.agents, paths.wacli, paths.bridge, paths.mail, paths.networkLogDir, paths.outbox],
    exclude: [paths.wacliCache, paths.agentsDiscarded, paths.bridgeStatusDir],
  }
}

// The folders a backup holds, from the data folder: `datastore`, …, `runner/log`, `exchange/outbox`.
// A snapshot is restored only when its paths are these, under one folder (`snapshotBase`).
const HELD = backupSources(makePaths({ dataDir: '/', configDir: '/' })).include.map(folder => folder.slice(1))

// What restic's exit codes 10 to 12 mean (restic 0.19.1's own list), for the owner.
const RESTIC_CODES = {
  10: "the backup repository doesn't exist yet: run `scooter backup-init`",
  11: 'the backup repository is locked by another restic, such as a check that is running',
  12: "RESTIC_PASSWORD doesn't open the backup repository",
}

// What the status and the CLI commands say while backups are off.
export const BACKUPS_OFF = "RESTIC_REPOSITORY isn't set in bridge.env"

const cut = text => {
  const chars = [...text.replace(/\s+/g, ' ').trim().replace(/\.$/, '')]
  return chars.length <= limits.REASON_MAX_CHARS ? chars.join('') : `${chars.slice(0, limits.REASON_MAX_CHARS - 1).join('')}…`
}

// A step of restic that failed. `reason` is for the owner: restic's own words when it gave any,
// with the secrets hidden (`createRestic`), in the notice and the bridge's state, and never in the
// log, which has the step and the exit code, as the runner does with OpenRouter's. `snapshot` is
// the one saved before it failed. `result` is what the `restic` of `createRestic` resolved with.
export class ResticError extends Error {
  constructor(step, result, { snapshot = null, reason = null } = {}) {
    super(`restic ${step} failed`)
    this.name = 'ResticError'
    this.step = step
    this.exitCode = result?.code ?? null
    this.timedOut = result?.timedOut ?? false
    this.snapshot = snapshot
    this.reason = cut(reason ?? reasonOf(step, result))
  }
}

// restic's error on stderr: its last line that starts with `Fatal:`, or else its last line. *Why
// not the last line alone:* restic 0.19.1 ends an error opening the repository with the
// repository's location on a line of its own, after the `Fatal:` line that says why.
function lastLine(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.findLast(line => line.startsWith('Fatal:')) ?? lines.at(-1) ?? ''
}

// `6 hours`, `10 minutes`.
function duration(ms) {
  const minutes = Math.round(ms / 60_000)
  return minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`
}

function reasonOf(step, result) {
  if (result.timedOut) return `restic ${step} took longer than ${duration(limits.RESTIC_TIMEOUT)}, and was stopped`
  if (Object.hasOwn(RESTIC_CODES, result.code)) return RESTIC_CODES[result.code]
  const said = lastLine(result.hide(result.stderr))
  return said === '' ? `restic ${step} exited with code ${result.code}` : `restic ${step}: ${said}`
}

// Returns `restic(args, options)`, which runs restic with the backup settings, `{ repository,
// password, env }`, and resolves with what `proc.run` does, and `hide` beside it. Options: `cache`,
// true to keep restic's cache in the bridge's folder, as the nightly backup does, and false for
// none, as the commands run at a terminal do; `timeZone`, restic's `TZ`, UTC but where the owner
// reads the times; and `timeout` and `signal`, as for `proc.run`.
//
// restic needs a cache folder or none: without a home, it fails before it does anything.
//
// `stdout` and `stderr` are as restic printed them, since the code reads them: the snapshot's ID
// in what `backup` prints, and the list `snapshots --json` gives. `hide(text)` returns `text` with
// every secret of the backup settings in it, the password and the bucket's keys
// (`SECRET_SETTINGS`), replaced by `…`, and is used on all of restic's words that are kept or
// shown: the reason a step failed (`ResticError`), which the bridge's state, its status and the
// notice hold, and what the CLI commands print. *Why not hide them before anything reads them:* a
// secret can be part of what restic ordinarily prints, such as a password that is a word of the
// data folder's path or a few digits of a snapshot's ID, and the code would then act on what was
// cut: a backup would fail for want of its ID, and a restore go to another folder.
export function createRestic({ backup, paths, proc }) {
  const secrets = [backup.password, ...SECRET_SETTINGS.map(name => backup.env[name])].filter(value => typeof value === 'string' && value !== '')
  // The longest first, so that one secret inside another is hidden whole.
  secrets.sort((a, b) => b.length - a.length)
  const hide = text => secrets.reduce((hidden, secret) => hidden.replaceAll(secret, '…'), text)
  return async (args, { cache = false, timeZone = 'UTC', timeout = null, signal = null } = {}) => {
    const env = { RESTIC_REPOSITORY: backup.repository, RESTIC_PASSWORD: backup.password, ...backup.env, TMPDIR: os.tmpdir(), TZ: timeZone }
    const where = cache ? ['--cache-dir', paths.backupCache] : ['--no-cache']
    const result = await proc.run(RESTIC, [...where, ...args], { env, timeout, signal })
    return { ...result, hide }
  }
}

// The settings of restic's environment that are secrets, besides the password: the bucket's keys,
// as the frame's table of secrets has them.
const SECRET_SETTINGS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY']

// ---------------------------------------------------------------------------------------------
// The operations

// `init`: makes the repository, unless it is there. Resolves with `{ created, said }`, `said` being
// what `restic init` printed, with the secrets hidden, and throws a `ResticError` when restic
// fails. `restic cat config` answers 10 for a repository that isn't there.
export async function initRepository({ backup, paths, proc }) {
  const restic = createRestic({ backup, paths, proc })
  const config = await restic(['cat', 'config'])
  if (config.code === 0) return { created: false, said: '' }
  if (config.code !== 10) throw new ResticError('cat config', config)
  const made = await restic(['init'])
  if (made.code !== 0) throw new ResticError('init', made)
  return { created: true, said: made.hide(made.stdout) }
}

// `run`, restic's part of the nightly backup: `restic backup` of the folders of `backupSources` that exist,
// `restic forget --prune` with the retention, and `restic check` on `RESTIC_CHECK_WEEKDAY` in the
// owner's time zone, or with `FORCE_CHECK=1`. Each step may take `RESTIC_TIMEOUT`, and `signal`
// stops it. Resolves with `{ snapshot, checked }`, the ID restic printed in its line `snapshot <id>
// saved`. Throws a `ResticError` for the first step that fails, with the snapshot if one was saved:
// restic exits with 3 when it saved one without some file it couldn't read.
export async function backUp({ settings, paths, proc, log, clock = systemClock, signal = null }) {
  const { backup } = settings
  const restic = createRestic({ backup, paths, proc })
  const startedAt = clock.now()
  const step = async (name, args) => {
    const began = clock.now()
    const result = await restic(args, { cache: true, timeout: limits.RESTIC_TIMEOUT, signal })
    log.info('backup.step', { step: name, exitCode: result.code, timedOut: result.timedOut, ms: clock.now() - began })
    if (signal?.aborted) throw Object.assign(new Error('the backup was stopped'), { code: 'ESTOPPED' })
    return result
  }

  const { include, exclude } = backupSources(paths)
  // A folder that isn't there, such as `mail/` with email off, is no part of the backup. restic
  // would say so, and exit with 3, as for a file it couldn't read.
  const folders = include.filter(folder => fs.existsSync(folder))
  const saved = await step('backup', ['backup', ...folders, '--host', HOST, '--tag', TAG, ...GROUP, ...exclude.flatMap(folder => ['--exclude', folder]), '--exclude-caches'])
  const snapshot = /^snapshot ([0-9a-f]+) saved$/m.exec(saved.stdout)?.[1] ?? null
  if (saved.code === 3 && snapshot !== null) {
    throw new ResticError('backup', saved, { snapshot, reason: "restic couldn't read some files, so the snapshot is incomplete" })
  }
  if (saved.code !== 0) throw new ResticError('backup', saved, { snapshot })
  if (snapshot === null) throw new ResticError('backup', saved, { reason: "restic backup didn't say which snapshot it saved" })

  const keep = ['--keep-daily', String(backup.keepDaily), '--keep-weekly', String(backup.keepWeekly), '--keep-monthly', String(backup.keepMonthly)]
  const forgot = await step('forget', ['forget', '--host', HOST, '--tag', TAG, ...GROUP, ...keep, '--prune'])
  if (forgot.code !== 0) throw new ResticError('forget', forgot, { snapshot })

  const checked = backup.forceCheck || toLocal(startedAt, settings.timeZone).weekday === limits.RESTIC_CHECK_WEEKDAY
  if (checked) {
    const check = await step('check', ['check'])
    if (check.code !== 0) throw new ResticError('check', check, { snapshot })
  }
  return { snapshot, checked }
}

// Where a snapshot's folders were: the data folder they were in, when every path it holds is one of
// the folders a backup holds, under that one folder. Null for a snapshot that isn't one of Scooter's
// backups, which `restore` doesn't touch: with `--force` it deletes what the snapshot doesn't hold.
export function snapshotBase(snapshotPaths) {
  if (!Array.isArray(snapshotPaths) || snapshotPaths.length === 0) return null
  let base = null
  const seen = new Set()
  for (const given of snapshotPaths) {
    if (typeof given !== 'string' || !path.isAbsolute(given) || path.normalize(given) !== given) return null
    const held = HELD.find(folder => given === `/${folder}` || given.endsWith(`/${folder}`))
    if (held === undefined || seen.has(held)) return null
    seen.add(held)
    const folder = given.slice(0, given.length - held.length - 1) || '/'
    if (base !== null && base !== folder) return null
    base = folder
  }
  return { base, folders: [...seen] }
}

const isWithin = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)

// Whether something is at `target`: a folder with anything in it, or anything that isn't a folder.
function occupied(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  return !stat.isDirectory() || fs.readdirSync(target).length > 0
}

// A restore that can't start for how it was called or how things stand. `scooter restore` exits
// with 2.
export class RestoreRefused extends Error {
  constructor(message) {
    super(message)
    this.name = 'RestoreRefused'
  }
}

// Scooter's users, which `setup` makes, and whose names a backup's files have as owners.
const USERS = ['scooter-wacli', 'scooter-runner', 'scooter-mail']

// `restore`: the snapshot `snapshot`, or the latest of Scooter's, into `RESTORE_TARGET`. Each folder
// the snapshot holds goes to the target joined with the path it was backed up from, so with `/`
// back where it was. Refuses (`RestoreRefused`), as root, while Scooter's users aren't all there;
// a snapshot that isn't one of Scooter's backups; while a bridge or a runner works on the data
// folder it would write into; and, without `force`, a folder it would write into that isn't empty.
// Restored, each folder is the snapshot's and nothing else: restic deletes what the snapshot doesn't
// hold, inside those folders only, and gives every file its owner by name, so a machine whose users
// have other numbers gets them right. It is one restore of the data folder the snapshot was made
// from, limited to the folders it holds, so the folders between, `runner/` and `exchange/`, get the
// owners and modes they had then too: a restore of each folder on its own would make each new one
// root's, 0700, which the runner can't enter. Resolves with `{ id, time, root, said }`, `root` being
// where the data folder's folders went, and `said` what `restic restore` printed, with the secrets
// hidden.
export async function restoreSnapshot({ backup, paths, proc, snapshot = 'latest', force = false }) {
  // restic gives a file whose owner's name isn't a user here to root, and says nothing: the runner
  // couldn't then read the agent's folder, nor wacli its own. That is a restore before `setup` on
  // a new machine, so it comes after. Not root, files stay the restoring user's anyway.
  for (const name of USERS) {
    try {
      await proc.lookupUser(name)
    } catch (error) {
      throw new RestoreRefused(`${error.message}: run \`scooter setup\` first, which makes Scooter's users, so each file restored gets its owner`)
    }
  }
  const restic = createRestic({ backup, paths, proc })
  const listed = await restic(['snapshots', '--json', '--host', HOST, '--tag', TAG, snapshot])
  if (listed.code !== 0) throw new ResticError('snapshots', listed)
  let found = null
  try {
    found = JSON.parse(listed.stdout)
  } catch {
    // below
  }
  if (!Array.isArray(found)) throw new ResticError('snapshots', listed, { reason: "restic snapshots didn't answer with a list" })
  if (found.length === 0) throw new RestoreRefused(snapshot === 'latest' ? 'there is no backup to restore yet' : `there is no snapshot ${snapshot}`)
  const [shot] = found
  const held = snapshotBase(shot?.paths)
  if (typeof shot?.id !== 'string' || !/^[0-9a-f]{64}$/.test(shot.id) || held === null) {
    throw new RestoreRefused(`snapshot ${snapshot} isn't one of Scooter's backups: its folders aren't those of a data folder`)
  }

  const root = path.join(backup.restoreTarget, held.base)
  const targets = held.folders.map(folder => path.join(root, folder))
  if (isWithin(root, paths.dataDir) || isWithin(paths.dataDir, root)) {
    for (const [service, socket] of [['bridge', paths.bridgeSocket], ['runner', paths.runnerSocket]]) {
      if (await instanceAnswers(socket)) throw new RestoreRefused(`the ${service} is running on ${paths.dataDir} (${socket} answers): stop the bridge and the runner first`)
    }
  }
  if (!force) {
    const full = targets.filter(occupied)
    if (full.length > 0) {
      throw new RestoreRefused(`${full.join(', ')} ${full.length === 1 ? "isn't" : "aren't"} empty: restore into an empty folder, or add --force to replace what is there with the snapshot`)
    }
  }
  // restic replaces a link at a folder it restores, or inside one, but follows one at a folder
  // between, `runner/` or `exchange/`, and writes, and with `--force` deletes, where it leads. A
  // native data folder is root's, so no other user can put one there, but `restore` doesn't
  // rest on that.
  for (const between of new Set(held.folders.filter(folder => folder.includes('/')).map(folder => path.posix.dirname(folder)))) {
    const at = path.join(root, between)
    let stat = null
    try {
      stat = fs.lstatSync(at)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (stat?.isSymbolicLink()) {
      throw new RestoreRefused(`${at} is a link: restic would write where it leads, and with --force delete there. Remove the link, or restore into another RESTORE_TARGET`)
    }
    if (stat !== null && !stat.isDirectory()) throw new RestoreRefused(`${at} isn't a folder: remove it, or restore into another RESTORE_TARGET`)
  }
  // Every service user passes through the data folder to reach its own.
  ensureDir(root, { mode: 0o755 })
  const args = ['restore', `${shot.id}:${held.base}`, '--target', root, ...held.folders.flatMap(folder => ['--include', `/${folder}`]), '--delete', '--ownership-by-name']
  const restored = await restic(args)
  if (restored.code !== 0) throw new ResticError('restore', restored)
  // restic writes the time with nanoseconds and the zone it ran in.
  const time = Date.parse(shot.time)
  return { id: shot.id.slice(0, 8), time: Number.isFinite(time) ? time : null, root, said: restored.hide(restored.stdout) }
}

// ---------------------------------------------------------------------------------------------
// The bridge's backups: schedule, requests, consistency, results

// The wait after the `n`th failure in a row to write a notice.
function backoff(n) {
  const { first, factor, max } = limits.SEND_RETRY_BACKOFF
  return Math.min(first * factor ** Math.max(0, n - 1), max)
}

// Returns the bridge's backups. Options:
// - `settings`: the bridge's; `backup` null means backups are off.
// - `paths`, `proc`, `log`, `clock`; `ids`, the bridge's one generator, for outbox entries.
// - `state`: the bridge's state (`state.mjs`), which keeps the last backup.
// - `runnerUser`: `{ uid, gid }` of `scooter-runner`, who owns the exchange, or null when the
//   bridge isn't root.
// - `quiesce()`: stops whatever writes what a backup holds: delivery, then the channels, then
//   what intake was storing. `resume()` starts them again. A `resume()` that fails is fatal.
// - `onFatal(error)`: the bridge can't go on.
//
// `start()` starts the schedule. `request(trigger)` starts a backup, or joins the one in progress,
// and resolves with its result once its notice, if any, is written; `trigger` is `scheduled` or
// `signal`. `stop()` stops the schedule and any backup in progress, and waits for their notices to
// be written. `statusLine(now)` is the line of `scooter status`.
export function createBackups({ settings, paths, proc, log, clock = systemClock, ids, state, runnerUser = null, quiesce, resume, onFatal = () => {} }) {
  const stopping = new AbortController()
  // The backup in progress, which a request joins, if any.
  let current = null
  // Every backup not yet told: the one in progress, and those whose result is being kept and
  // whose notice is being written, which a request no longer joins.
  const jobs = new Set()
  let loop = null
  // While a backup has the writers stopped, a promise that resolves once they start again, or the
  // backup ends without starting them; null otherwise. A notice of an earlier backup, being tried
  // again, waits for it, so that nothing is written in `bridge/outbox/` while restic reads.
  let quietPeriod = null

  // `exchange/locks/` is the runner's, and the bridge writes its lock there as root, so it
  // uses the folder only while it is the runner's and not a link.
  function takeBackupLock() {
    ensureDir(paths.locks, { mode: 0o700, owner: runnerUser })
    checkOwnFolder(paths.locks, runnerUser)
    if (!takeLock(paths.backupLock, { clock })) throw new Error(`${paths.backupLock} is there already`)
  }

  function releaseBackupLock() {
    try {
      checkOwnFolder(paths.locks, runnerUser)
      releaseLock(paths.backupLock)
    } catch (error) {
      log.error('backup.lock_not_released', errorFields(error))
    }
  }

  // `run.lock`, as the bridge reads a file of the runner's: without following a link, without
  // waiting on a FIFO, and only a regular file of a bounded size. Null when there is none, and
  // otherwise `{ deadline }`, null when it doesn't say, as when it can't be read.
  function readRunLock() {
    let text
    try {
      text = readUntrustedFile(paths.runLock, { maxBytes: limits.STATUS_FILE_MAX_BYTES })
    } catch (error) {
      if (error.code === 'ENOENT') return null
      return { deadline: null }
    }
    let lock = null
    try {
      lock = JSON.parse(text)
    } catch {
      // a lock with no time
    }
    return { deadline: parseIsoSeconds(lock?.deadline) }
  }

  // Step 2 of a backup: waits for `run.lock` to go. Until `BACKUP_LOCK_EXTRA` past the time it holds,
  // its run may still be going. Past that, a runner that still holds `runner/runner.sock` is still
  // at work, packing its repository or freeing what pi wrote, neither of which has a time limit,
  // and the backup waits on; when none does, the runner that took the lock is gone, and
  // the backup goes ahead. A lock with no time it can read is past its time. Resolves with false
  // when the bridge stops first.
  async function waitForRun(job) {
    let said = null
    for (;;) {
      const lock = readRunLock()
      if (lock === null) break
      const overdue = lock.deadline === null || clock.now() >= lock.deadline + limits.BACKUP_LOCK_EXTRA
      if (!overdue) {
        if (said === null) log.info('backup.waiting', { for: 'run', deadline: isoSeconds(lock.deadline) })
        said ??= 'waiting'
      } else if (await instanceAnswers(paths.runnerSocket)) {
        if (said !== 'overdue') log.warn('backup.run_overdue', { deadline: lock.deadline === null ? null : isoSeconds(lock.deadline) })
        said = 'overdue'
      } else {
        log.warn('backup.run_lock_left', { deadline: lock.deadline === null ? null : isoSeconds(lock.deadline) })
        break
      }
      job.waiting = true
      try {
        await clock.sleep(limits.POLL_INTERVAL, { signal: stopping.signal })
      } catch {
        return false
      }
    }
    job.waiting = false
    return true
  }

  // One backup, in five steps. Resolves with `{ ok, snapshot, checked }`, `{ ok: false,
  // reason, snapshot }`, or `{ stopped: true }` when the bridge stopped first. Never rejects.
  async function perform(job) {
    let locked = false
    let quiet = false
    let endQuiet = () => {}
    try {
      // 1. Its own lock first, then the other's.
      takeBackupLock()
      locked = true
      // 2.
      if (!(await waitForRun(job))) return { stopped: true }
      // 3. Nothing writes what the backup holds meanwhile.
      quiet = true
      quietPeriod = new Promise(resolve => (endQuiet = resolve))
      await quiesce()
      log.info('backup.writers_stopped')
      // 4.
      const { snapshot, checked } = await backUp({ settings, paths, proc, log, clock, signal: stopping.signal })
      return { ok: true, snapshot, checked }
    } catch (error) {
      if (stopping.signal.aborted) return { stopped: true }
      if (error instanceof ResticError) {
        log.warn('backup.failed', { step: error.step, exitCode: error.exitCode, timedOut: error.timedOut, snapshot: error.snapshot })
        return { ok: false, reason: error.reason, snapshot: error.snapshot }
      }
      log.error('backup.failed', errorFields(error))
      return { ok: false, reason: cut(`the bridge couldn't back up (${error.code ?? error.name}: ${error.message})`), snapshot: null }
    } finally {
      // 5. A bridge that is stopping starts nothing again.
      if (quiet && !stopping.signal.aborted) {
        try {
          await resume()
        } catch (error) {
          log.error('backup.resume_failed', errorFields(error))
          onFatal(error)
        }
      }
      quietPeriod = null
      endQuiet()
      if (locked) releaseBackupLock()
    }
  }

  // Writes an outbox entry of the bridge's, into its own outbox, trying again after a wait
  // that doubles when it can't, until the bridge stops. A try waits while a later backup has the
  // writers stopped.
  async function send(entry) {
    for (let failures = 1; ; failures++) {
      while (quietPeriod !== null) await quietPeriod
      try {
        const id = await writeOutboxEntry({ paths, ids, entry, outbox: paths.bridgeOutbox })
        log.info('backup.told', { entry: id })
        return
      } catch (error) {
        log.error('backup.not_told', { failures, ...errorFields(error) })
        try {
          await clock.sleep(backoff(failures), { signal: stopping.signal })
        } catch {
          return
        }
      }
    }
  }

  function nextTime(now) {
    if (settings.backupTime === null) return null
    return nextLocalTime(parseLocalTime(settings.backupTime), settings.timeZone, now)
  }

  // The notice of a backup that failed, which says when the next one is.
  function noticeText(result) {
    const failed = result.snapshot === null ? '⚠️ The backup failed' : `⚠️ The backup saved snapshot ${result.snapshot}, but didn't finish`
    const next = nextTime(clock.now())
    const when = next === null ? ' None is scheduled: BACKUP_TIME is off.' : ` The next one is at ${shortLocalTime(next, clock.now(), settings.timeZone)}.`
    return `${failed}: ${result.reason}.${when}`
  }

  async function settle(job, result) {
    if (!result.stopped) {
      const lastBackup = { at: isoSeconds(job.since), ok: result.ok === true, snapshot: result.snapshot ?? null, reason: result.ok ? null : result.reason }
      try {
        state.update({ lastBackup })
      } catch (error) {
        log.error('backup.state_not_saved', errorFields(error))
      }
      log.info('backup.finished', { trigger: job.trigger, ok: lastBackup.ok, snapshot: lastBackup.snapshot, checked: result.checked ?? false, ms: clock.now() - job.since })
    } else {
      log.info('backup.stopped', { trigger: job.trigger })
    }
    // A backup says something only when it fails.
    if (result.ok === false) await send({ type: 'text', by: 'bridge', text: noticeText(result) })
  }

  function request(trigger) {
    if (current) return current.done
    const job = { trigger, since: clock.now(), waiting: false }
    current = job
    log.info('backup.started', { trigger })
    job.done = (async () => {
      const result = stopping.signal.aborted ? { stopped: true } : await perform(job)
      // A new request from here on starts a backup of its own.
      current = null
      await settle(job, result)
      return result
    })()
    // Until it is told, a stop waits for it too.
    jobs.add(job.done)
    const forget = () => jobs.delete(job.done)
    job.done.then(forget, forget)
    return job.done
  }

  // Resolves once every backup asked for so far is over and told.
  async function told() {
    while (jobs.size > 0) await Promise.all(jobs)
  }

  async function schedule() {
    const due = () => nextTime(clock.now())
    for (;;) {
      const at = due()
      try {
        // A clock set back meanwhile is waited out.
        while (clock.now() < at) await clock.sleep(at - clock.now(), { signal: stopping.signal })
      } catch {
        return
      }
      await request('scheduled')
      if (stopping.signal.aborted) return
    }
  }

  return {
    start() {
      if (!settings.backup) {
        log.warn('backup.off', { reason: BACKUPS_OFF })
        return
      }
      if (settings.backupTime === null) {
        log.info('backup.unscheduled', { reason: 'BACKUP_TIME is off' })
        return
      }
      log.info('backup.scheduled', { next: isoSeconds(nextTime(clock.now())) })
      loop = schedule()
    },

    request(trigger) {
      if (!settings.backup) {
        log.warn('backup.off', { reason: BACKUPS_OFF, trigger })
        return Promise.resolve({ off: true })
      }
      return request(trigger)
    },

    // A backup that ended as the stop came is told too: its notice is written before this resolves.
    async stop() {
      stopping.abort()
      await loop
      await told()
    },

    // Resolves when every backup asked for so far is over and told. For tests.
    idle: told,

    statusLine(now) {
      if (!settings.backup) return `Backups: off, because ${BACKUPS_OFF}.`
      const at = time => shortLocalTime(time, now, settings.timeZone)
      const parts = []
      if (current) parts.push(`one in progress since ${at(current.since)}${current.waiting ? ", waiting for the agent's run to end" : ''}`)
      const last = state.get().lastBackup
      if (last === null) parts.push('none yet')
      else if (last.ok) parts.push(`last ${at(parseIsoSeconds(last.at))}, snapshot ${last.snapshot}`)
      else parts.push(`the last, ${at(parseIsoSeconds(last.at))}, failed (${last.reason})`)
      const next = nextTime(now)
      return `Backups: ${parts.join('; ')}. ${next === null ? 'None is scheduled: BACKUP_TIME is off.' : `Next ${at(next)}.`}`
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The commands: `backup-init`, `snapshots`, `check`, `restore`

// What every command checks first. Returns the exit code to stop with, or null to go on.
function refuseWithout(name, settings, args, stderr, usage = null) {
  if (usage !== null && !usage(args)) return 2
  if (!settings.backup) {
    stderr.write(`scooter ${name}: ${BACKUPS_OFF}, so there is no backup repository to use\n`)
    return 2
  }
  return null
}

const noArgs = name => (args, stderr) => {
  if (args.length === 0) return true
  stderr.write(`scooter ${name}: it takes no arguments\n`)
  return false
}

function commandContext({ settings, clock, log, proc }) {
  log ??= createLog({ component: 'backup', clock })
  return { paths: makePaths(settings), log, proc: proc ?? createProc({ log, clock }) }
}

function failed(name, error, stderr) {
  if (error instanceof ResticError) {
    stderr.write(`scooter ${name}: ${error.reason}\n`)
    return 1
  }
  if (error instanceof RestoreRefused) {
    stderr.write(`scooter ${name}: ${error.message}\n`)
    return 2
  }
  throw error
}

// `scooter backup-init`: makes the repository, and does nothing if it is there.
export async function runBackupInit({ args = [], settings, stdout, stderr, clock = systemClock, log, proc }) {
  const stop = refuseWithout('backup-init', settings, args, stderr, given => noArgs('backup-init')(given, stderr))
  if (stop !== null) return stop
  const context = commandContext({ settings, clock, log, proc })
  try {
    const { created, said } = await initRepository({ backup: settings.backup, ...context })
    stdout.write(created ? said : 'The backup repository is there already, and nothing was changed.\n')
    return 0
  } catch (error) {
    return failed('backup-init', error, stderr)
  }
}

// `scooter snapshots`: Scooter's snapshots, as restic lists them, with times in `SCOOTER_TZ`.
export async function runSnapshots({ args = [], settings, stdout, stderr, clock = systemClock, log, proc }) {
  const stop = refuseWithout('snapshots', settings, args, stderr, given => noArgs('snapshots')(given, stderr))
  if (stop !== null) return stop
  const { paths, proc: run } = commandContext({ settings, clock, log, proc })
  const result = await createRestic({ backup: settings.backup, paths, proc: run })(['snapshots', '--host', HOST, '--tag', TAG], { timeZone: settings.timeZone })
  stdout.write(result.hide(result.stdout))
  stderr.write(result.hide(result.stderr))
  return result.code === 0 ? 0 : failed('snapshots', new ResticError('snapshots', result), stderr)
}

// `scooter check`: restic's check of the repository.
export async function runCheck({ args = [], settings, stdout, stderr, clock = systemClock, log, proc }) {
  const stop = refuseWithout('check', settings, args, stderr, given => noArgs('check')(given, stderr))
  if (stop !== null) return stop
  const { paths, proc: run } = commandContext({ settings, clock, log, proc })
  const result = await createRestic({ backup: settings.backup, paths, proc: run })(['check'])
  stdout.write(result.hide(result.stdout))
  stderr.write(result.hide(result.stderr))
  return result.code === 0 ? 0 : failed('check', new ResticError('check', result), stderr)
}

// The arguments of `restore`: at most a snapshot's ID, or `latest`, and `--force`. Null for others.
export function restoreArgs(args) {
  let snapshot = null
  let force = false
  for (const arg of args) {
    if (arg === '--force' && !force) force = true
    else if (snapshot === null && (arg === 'latest' || /^[0-9a-f]{8,64}$/.test(arg))) snapshot = arg
    else return null
  }
  return { snapshot: snapshot ?? 'latest', force }
}

// `scooter restore [snapshot] [--force]`: see `restoreSnapshot`.
export async function runRestore({ args = [], settings, stdout, stderr, clock = systemClock, log, proc }) {
  const parsed = restoreArgs(args)
  const stop = refuseWithout('restore', settings, args, stderr, () => {
    if (parsed !== null) return true
    stderr.write('scooter restore: give at most a snapshot ID, or latest, and --force, as in: scooter restore 1a2b3c4d --force\n')
    return false
  })
  if (stop !== null) return stop
  const context = commandContext({ settings, clock, log, proc })
  try {
    const restored = await restoreSnapshot({ backup: settings.backup, ...context, ...parsed })
    stdout.write(restored.said)
    const when = restored.time === null ? '' : `, made ${shortLocalTime(restored.time, clock.now(), settings.timeZone)},`
    stdout.write(`Restored snapshot ${restored.id}${when} into ${restored.root}.\n`)
    return 0
  } catch (error) {
    return failed('restore', error, stderr)
  }
}
