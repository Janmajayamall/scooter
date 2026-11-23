// A live check (the plan's milestone 13): what a run's VM sees, with the data folder where
// Docker has it, at /data, which is also where Gondolin 0.14.0 puts its own file system unless told
// otherwise. It is run by hand, in the runner's container, with the runner stopped, from a checkout
// of this repository mounted at /app/test:
//
//   docker compose stop runner
//   docker compose run --rm -v ./test:/app/test:ro --entrypoint node runner /app/test/live/data-mounts.mjs
//
// `--entrypoint node` makes Node the container's first process in place of tini, the image's entry
// point, which is fine for this check: it closes its one VM itself. Something that kills a QEMU
// and waits for it to go, as the sandbox tests' check of a stopped process group does, needs tini
// first, to reap it: `--entrypoint tini`, with `node …` as the command.
//
// It holds runner/runner.sock, as the runner does, so it refuses while a runner runs. It opens the
// sandbox as the runner does, on the runner's own settings, data folder and `agents.yaml`, and runs
// a shell in a VM with what a run of `lifelog` sees and may change (`piFiles`). What the VM sees is
// checked, with the default `reads` and `writes`: the agent's folder and the datastore at their
// paths under /data, read-only but for views/, memory/ and run/session/; sessions/ not there;
// nothing else of the data folder or the config; and Gondolin's own file system at
// /run/gondolin-vfs, not at /data.
// It writes one file, in run/session/, which every run empties, and removes it. It prints what it
// found, and exits with 1 if anything wasn't so.

import { loadSettings } from '../../src/common/settings.mjs'
import { makePaths } from '../../src/common/paths.mjs'
import { createLog } from '../../src/common/log.mjs'
import { holdRunnerFolder } from '../../src/runner/main.mjs'
import { loadConfig } from '../../src/runner/config.mjs'
import { piFiles } from '../../src/runner/run.mjs'
import { openGondolinSandbox } from '../../src/runner/sandbox/gondolin.mjs'
import { GUEST_PATH } from '../../src/runner/sandbox/index.mjs'

const settings = loadSettings('runner')
const paths = makePaths(settings)
const agent = paths.agentDir('lifelog')

// Each line the VM prints: `<what> <answer>`.
const SCRIPT = `
cd ${agent}
echo "data-folder $(ls /data | tr '\\n' ' ')"
for name in runner exchange bridge wacli mail; do test -e /data/$name && echo "$name there" || echo "$name absent"; done
test -e /config && echo "config there" || echo "config absent"
test -e sessions && echo "sessions there" || echo "sessions absent"
mkdir sessions 2>/dev/null && echo "sessions made" || echo "sessions refused"
test -d views && echo "views there" || echo "views absent"
ls ${paths.datastore} >/dev/null 2>&1 && echo "datastore readable" || echo "datastore unreadable"
touch ${paths.datastore}/x 2>/dev/null && echo "datastore writable" || echo "datastore read-only"
touch ${agent}/x 2>/dev/null && echo "agent writable" || echo "agent read-only"
echo check > run/session/mount-check && echo "run/session writable" || echo "run/session read-only"
rm -f run/session/mount-check
grep -q " /run/gondolin-vfs " /proc/mounts && echo "gondolin-vfs at-run" || echo "gondolin-vfs elsewhere"
`

const WANT = {
  'data-folder': 'agents datastore',
  runner: 'absent',
  exchange: 'absent',
  bridge: 'absent',
  wacli: 'absent',
  mail: 'absent',
  config: 'absent',
  sessions: ['absent', 'refused'],
  views: 'there',
  datastore: ['readable', 'read-only'],
  agent: 'read-only',
  'run/session': 'writable',
  'gondolin-vfs': 'at-run',
}

const instance = await holdRunnerFolder(paths)
let failures = 0
try {
  const log = createLog({ component: 'check' })
  const sandbox = await openGondolinSandbox({ paths, settings, log })
  const result = await sandbox.run({
    argv: ['/bin/sh', '-c', SCRIPT],
    cwd: '/',
    env: { PATH: GUEST_PATH },
    files: piFiles(paths, loadConfig({ paths, settings }).agents.find(each => each.name === 'lifelog')),
    timeoutMs: 5 * 60_000,
    policy: { model: 'none', internet: false, zdr: true, secrets: {} },
  })
  const found = {}
  for (const line of result.stdout.trim().split('\n')) {
    const [what, ...answer] = line.split(' ')
    ;(found[what] ??= []).push(answer.join(' ').trim())
  }
  console.log(`VMs with ${sandbox.accel}; the VM's command exited with ${result.code}`)
  for (const [what, want] of Object.entries(WANT)) {
    const wanted = [want].flat()
    const got = found[what] ?? []
    const ok = got.length === wanted.length && got.every((answer, n) => answer === wanted[n])
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got.join(', ')}`)
    if (!ok) failures += 1
  }
} finally {
  await instance.close()
}
process.exitCode = failures > 0 ? 1 : 0
