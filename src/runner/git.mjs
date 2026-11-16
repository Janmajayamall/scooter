// Git, as the runner uses it on an agent's folder (6.2, 6.8 of DESIGN.md).
//
// The runner is the only committer. Every git command runs through `proc.mjs`, from an argument
// list, with an environment of its own: no system or user git config, so nothing on the machine
// changes what git does here; no hooks; no signing; and the author and the time from the runner,
// as `Scooter <scooter@localhost>`.

import { limits } from '../common/limits.mjs'
import { systemClock } from '../common/time.mjs'

export const AUTHOR = { name: 'Scooter', email: 'scooter@localhost' }

// Settings given on every command line, ahead of the command.
const CONFIG = ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null']

// Returns git for the repository in `dir`. `proc` is what `createProc` returns.
export function createGit({ proc, dir, clock = systemClock }) {
  function env() {
    const date = `@${Math.floor(clock.now() / 1000)} +0000`
    return {
      // Git finds its own helpers, and the runner's `PATH` is the one it was started with.
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
      GIT_COMMITTER_DATE: date,
      LC_ALL: 'C',
      TZ: 'UTC',
    }
  }

  // Runs `git <args>` and returns `{ code, stdout }`. Rejects when it exits with another code than
  // those in `codes`, or times out. The error names the command, not what git printed, which can
  // name the agent's files.
  async function run(args, { codes = [0] } = {}) {
    const result = await proc.run('git', [...CONFIG, ...args], { env: env(), cwd: dir, timeout: limits.GIT_CALL_TIMEOUT })
    if (result.timedOut || !codes.includes(result.code)) {
      const reason = result.timedOut ? 'timed out' : `exit code ${result.code}`
      throw Object.assign(new Error(`git ${args[0]}: ${reason}`), { code: 'EGIT', exitCode: result.code, timedOut: result.timedOut })
    }
    return { code: result.code, stdout: result.stdout }
  }

  return {
    run,

    // Whether the repository has a commit yet.
    async hasCommit() {
      return (await run(['rev-parse', '--verify', '--quiet', 'HEAD'], { codes: [0, 1] })).code === 0
    },

    // Commits what is staged, with `message`.
    async commit(message) {
      await run(['commit', '--quiet', '--no-verify', '-m', message])
    },
  }
}
