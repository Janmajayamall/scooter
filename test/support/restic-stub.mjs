// A stand-in for restic 0.19.1, for the backup coordination tests.
//
// It is run through the wrapper that `createResticStub` in `restic.mjs` writes and puts first on
// `PATH`. Its control folder is `../restic-stub/` from the wrapper. There it:
// - records every call as a line of `calls.jsonl`: the arguments, the whole environment, the user
//   and group it runs as, and its pid;
// - answers from `fixtures.json`, read afresh at every call:
//     exit        by command (`backup`, `forget`, `check`, `cat`, `init`, `snapshots`, `restore`),
//                 the exit code; 0 when not given
//     stderr      by command, what it writes on stderr
//     snapshot    the ID `backup` says it saved, `snapshot <id> saved`; `none` for no such line
//     repository  whether `cat config` finds the repository, 10 when it doesn't; `init` makes it
//     snapshots   what `snapshots --json` answers, a list
//     hold        commands that wait, once started, until the test releases them
// - for a command it holds, writes `holding-<command>` and waits until `release-<command>` is
//   there, then reads the fixtures again and answers. SIGTERM ends it with 130, as restic's own
//   handling of the signal does, and it writes `stopped-<command>`.
//
// Its output follows restic's as the plan's Linux machine showed it in milestone 10:
// `snapshot 1a2b3c4d saved` at the end of a backup, and `Fatal: …` on stderr.

import fs from 'node:fs'
import path from 'node:path'

const control = path.join(path.dirname(process.argv[1]), '..', 'restic-stub')
const args = process.argv.slice(2)
const readFixtures = () => JSON.parse(fs.readFileSync(path.join(control, 'fixtures.json'), 'utf8'))
let fixtures = readFixtures()
fs.appendFileSync(path.join(control, 'calls.jsonl'), `${JSON.stringify({ args, env: process.env, uid: process.getuid(), gid: process.getgid(), pid: process.pid })}\n`)

// The command: the first word after the global options this code gives.
let rest = args
while (rest[0] === '--no-cache' || rest[0] === '--cache-dir') rest = rest.slice(rest[0] === '--cache-dir' ? 2 : 1)
const command = rest[0]

function finish() {
  if (fixtures.stderr?.[command]) process.stderr.write(fixtures.stderr[command])
  process.exitCode = fixtures.exit?.[command] ?? 0
}

function answer() {
  switch (command) {
    case 'cat': {
      const made = fixtures.repository !== false || fs.existsSync(path.join(control, 'made'))
      if (!made) {
        process.stderr.write('Fatal: repository does not exist: unable to open config file\n')
        process.exitCode = 10
        return
      }
      process.stdout.write('{"version":2,"id":"stub"}\n')
      return finish()
    }
    case 'init':
      fs.writeFileSync(path.join(control, 'made'), '')
      process.stdout.write('created restic repository 0123456789 at the stub\n')
      return finish()
    case 'backup': {
      process.stdout.write('Files:           2 new,     0 changed,     0 unmodified\n')
      const id = fixtures.snapshot ?? 'abcd1234'
      // restic saves a snapshot when it ends with 0, or with 3 for files it couldn't read.
      if (id !== 'none' && [0, 3].includes(fixtures.exit?.backup ?? 0)) process.stdout.write(`processed 2 files, 14 B in 0:00\nsnapshot ${id} saved\n`)
      return finish()
    }
    case 'snapshots':
      if (rest.includes('--json')) process.stdout.write(`${JSON.stringify(fixtures.snapshots ?? [])}\n`)
      else process.stdout.write('ID        Time                 Host        Tags\nabcd1234  2026-11-09 03:30:00  scooter     scooter\n1 snapshots\n')
      return finish()
    case 'check':
      process.stdout.write('no errors were found\n')
      return finish()
    case 'forget':
    case 'restore':
      process.stdout.write(`${command} done\n`)
      return finish()
    default:
      process.stderr.write(`Fatal: the stub doesn't know: ${command}\n`)
      process.exitCode = 1
  }
}

if ((fixtures.hold ?? []).includes(command)) {
  // Ready for the signal before it says it holds, which is when a test may send it.
  process.on('SIGTERM', () => {
    fs.writeFileSync(path.join(control, `stopped-${command}`), '')
    process.exit(130)
  })
  fs.writeFileSync(path.join(control, `holding-${command}`), String(process.pid))
  const wait = setInterval(() => {
    if (!fs.existsSync(path.join(control, `release-${command}`))) return
    clearInterval(wait)
    fixtures = readFixtures()
    answer()
  }, 10)
} else {
  answer()
}
