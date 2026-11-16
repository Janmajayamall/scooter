// Running other programs: wacli, the email reader, restic, git and the rest.
//
// - A program is started from an argument list, never through a shell.
// - Its environment is exactly what the caller gives. Nothing is inherited, so a secret reaches
//   only the program it is meant for (3.2 of DESIGN.md).
// - It can run as another user. That needs root. A process that isn't root skips the switch and
//   logs one warning, which is how Scooter runs in development and in most tests (section 10).
// - It is stopped with SIGTERM, then SIGKILL after `STOP_GRACE`.
// - Logs name the program, never its arguments or its environment: wacli's command line carries
//   the webhook secret (5.1).
//
// This is the only module that imports `node:child_process`.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { limits } from './limits.mjs'
import { errorFields } from './log.mjs'
import { systemClock } from './time.mjs'

// Where a program is: itself if it's given as a path, else the first executable file of that name
// in the folders of `searchPath`. Returns null when there is none.
//
// Programs are found on Scooter's own `PATH`, because the environment a program is given may have
// no `PATH` at all.
export function findProgram(program, searchPath = process.env.PATH ?? '') {
  if (program.includes('/')) return program
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, program)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not in this folder
    }
  }
  return null
}

const USER_NAME = /^[a-z_][a-z0-9_-]*$/

// Returns `run`, `supervise` and `lookupUser`, which share one log, one clock, and the one warning
// about not being root.
export function createProc({ log, clock = systemClock, isRoot = () => process.getuid?.() === 0 }) {
  let warned = false

  function warnNotRoot() {
    if (warned) return
    warned = true
    log.warn('proc.not_root', { note: 'not running as root: programs run as this user, and file owners are left alone' })
  }

  // The spawn options that switch to `user` (`{ uid, gid }`), or none when there's no switching.
  // Node drops root's other groups along with the uid and gid.
  function identity(user) {
    if (!user) return {}
    if (isRoot()) return { uid: user.uid, gid: user.gid }
    warnNotRoot()
    return {}
  }

  function start(program, args, { env = {}, cwd, user = null, stdio }) {
    const file = findProgram(program)
    if (file === null) {
      throw Object.assign(new Error(`program not found: ${program}`), { code: 'ENOENT' })
    }
    return spawn(file, args, { env, cwd, stdio, shell: false, ...identity(user) })
  }

  // Two promises about a child. `exited` resolves when the program itself has ended. `closed`
  // resolves with `{ code, signal }` when it has ended and its output is closed too. Both resolve
  // with `{ error }` when it couldn't be started.
  //
  // The two differ when the program leaves a process of its own running that holds its output
  // open, such as a shell wrapper that starts a program without `exec`.
  function ending(child) {
    const failed = new Promise(resolve => child.once('error', error => resolve({ code: null, signal: null, error })))
    const exited = Promise.race([failed, new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))])
    const closed = Promise.race([failed, new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))])
    return { exited, closed }
  }

  // SIGTERM now, and SIGKILL if the child is still there after `STOP_GRACE`. Resolves once it's
  // gone. `ended` is the child's `ending`.
  //
  // The signals go to the program alone (D25). Once it has exited, its pipes are closed from this
  // side: whatever it left running may hold them open for as long as it likes, and a program that
  // was stopped isn't owed the rest of its output. So a stop takes at most `STOP_GRACE`.
  async function terminate(child, ended) {
    const gone = new AbortController()
    ended.exited.then(() => gone.abort())
    child.kill('SIGTERM')
    try {
      await clock.sleep(limits.STOP_GRACE, { signal: gone.signal })
      child.kill('SIGKILL')
    } catch {
      // it exited within the grace period
    }
    await ended.exited
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy()
    await ended.closed
  }

  // Runs a program to its end and returns `{ code, signal, stdout, stderr, timedOut }`. A non-zero
  // exit code is a result, not an error. It rejects only when the program can't be started.
  //
  // - `env`: the program's whole environment. Empty by default.
  // - `cwd`: its working folder.
  // - `user`: `{ uid, gid }` to run as.
  // - `timeout`: milliseconds after which the program is stopped; `timedOut` is then true.
  // - `signal`: an AbortSignal that stops the program the same way.
  // - `input`: text for its stdin, which is otherwise closed.
  // - `output`: `capture`, the default, collects stdout and stderr as text. `inherit` connects all
  //   three streams to this process's own, for a program that talks to the terminal. `ignore`
  //   throws both away, for a long-running program whose output would only pile up.
  //
  // A program that ends by itself is waited for until its output is closed, so all of it is
  // collected. One that is stopped is waited for only until it has exited (`terminate`).
  async function run(program, args = [], options = {}) {
    const { timeout = null, signal = null, input = null, output = 'capture' } = options
    const stdio = output === 'capture' ? [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] : output
    const child = start(program, args, { ...options, stdio })
    const ended = ending(child)

    let stdout = ''
    let stderr = ''
    if (output === 'capture') {
      child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk))
      if (input !== null) {
        // A program that exits without reading its input closes the pipe. Its exit is the result.
        child.stdin.on('error', () => {})
        child.stdin.end(input)
      }
    }

    let timedOut = false
    let stopping = null
    const stop = () => (stopping ??= terminate(child, ended))
    const done = new AbortController()
    if (timeout !== null) {
      clock.sleep(timeout, { signal: done.signal }).then(
        () => {
          timedOut = true
          stop()
        },
        () => {},
      )
    }
    if (signal?.aborted) stop()
    signal?.addEventListener('abort', stop, { once: true })

    const result = await ended.closed
    done.abort()
    signal?.removeEventListener('abort', stop)
    await stopping
    if (result.error) throw result.error
    return { code: result.code, signal: result.signal, stdout, stderr, timedOut }
  }

  // Keeps a long-running program running: starts it, and starts it again whenever it exits, after
  // a wait from `RESTART_BACKOFF` (5 seconds, doubling up to 5 minutes). A run that lasted at
  // least the longest wait puts the wait back to the first.
  //
  // Options: `env`, `cwd` and `user` as for `run`; `stdio`, as Node's `spawn` takes it, `ignore`
  // by default; `onStart({ pid })`; and `onExit({ code, signal, ms, restartIn })` after each exit
  // that will be followed by a restart.
  //
  // `before({ signal })`, if given, is awaited before each start, the first included. It may take
  // as long as it needs, such as waiting until wacli is paired, and `signal` aborts when the
  // supervisor is stopped. If it rejects for another reason, that counts as a start that failed.
  //
  // Returns `{ stop, done }`. `stop()` ends the program with SIGTERM, then SIGKILL, starts it no
  // more, and resolves when it's gone. `done` resolves when the supervisor has finished.
  function supervise(program, args = [], options = {}) {
    const { stdio = 'ignore', onStart, onExit, before } = options
    const name = path.basename(program)
    const stopped = new AbortController()
    let current = null

    const done = (async () => {
      let wait = limits.RESTART_BACKOFF.first
      while (!stopped.signal.aborted) {
        let startedAt = clock.now()
        let outcome
        try {
          if (before) {
            await before({ signal: stopped.signal })
            if (stopped.signal.aborted) break
            startedAt = clock.now()
          }
          const child = start(program, args, { ...options, stdio })
          const ended = ending(child)
          current = { child, ended }
          if (child.pid !== undefined) {
            log.info('proc.started', { program: name, pid: child.pid })
            onStart?.({ pid: child.pid })
          }
          outcome = await ended.closed
        } catch (error) {
          outcome = { code: null, signal: null, error }
        }
        current = null
        if (stopped.signal.aborted) break

        const ms = clock.now() - startedAt
        if (ms >= limits.RESTART_BACKOFF.max) wait = limits.RESTART_BACKOFF.first
        log.warn('proc.exited', {
          program: name,
          exitCode: outcome.code,
          signal: outcome.signal,
          ms,
          restartIn: wait,
          ...(outcome.error ? errorFields(outcome.error) : {}),
        })
        onExit?.({ code: outcome.code, signal: outcome.signal, ms, restartIn: wait })
        try {
          await clock.sleep(wait, { signal: stopped.signal })
        } catch {
          break
        }
        wait = Math.min(wait * limits.RESTART_BACKOFF.factor, limits.RESTART_BACKOFF.max)
      }
      log.info('proc.stopped', { program: name })
    })()

    async function stop() {
      stopped.abort()
      if (current) await terminate(current.child, current.ended)
      await done
    }

    return { stop, done }
  }

  // The uid and gid of a user of this machine, by name, such as `scooter-wacli`. When this process
  // isn't root it returns null, with the one warning: there's no switching to do, and whoever
  // asked skips it.
  async function lookupUser(name) {
    if (!isRoot()) {
      warnNotRoot()
      return null
    }
    if (!USER_NAME.test(name)) throw new Error(`not a user name: ${name}`)
    const ids = []
    for (const flag of ['-u', '-g']) {
      const result = await run('id', [flag, '--', name])
      if (result.code !== 0 || !/^\d+\n?$/.test(result.stdout)) {
        throw new Error(`there is no user ${name} on this machine`)
      }
      ids.push(Number(result.stdout))
    }
    return { uid: ids[0], gid: ids[1] }
  }

  return { run, supervise, lookupUser }
}
