// Opens the real sandbox on a data folder and starts a run that never ends, the way the runner
// would, then waits to be killed. The test of what a killed runner leaves behind runs this as a
// process of its own, in its own process group, as a service manager runs the runner.
//
//   node test/support/sandbox-holder.mjs <data folder> <config folder>
//
// It prints the QEMU process's ID on stdout once the VM has started.

import { makePaths } from '../../src/common/paths.mjs'
import { createLog } from '../../src/common/log.mjs'
import { openGondolinSandbox } from '../../src/runner/sandbox/gondolin.mjs'
import { GUEST_HOME, GUEST_PATH } from '../../src/runner/sandbox/index.mjs'

const [dataDir, configDir] = process.argv.slice(2)
const paths = makePaths({ dataDir, configDir })
const log = createLog({
  component: 'holder',
  write: line => {
    const entry = JSON.parse(line)
    if (entry.event === 'sandbox.vm_started') process.stdout.write(`${entry.qemu}\n`)
  },
})
const sandbox = await openGondolinSandbox({ paths, settings: { timeZone: 'Asia/Kolkata', agentAccel: 'auto' }, log })
await sandbox.run({
  argv: ['/bin/sleep', '600'],
  cwd: '/',
  env: { PATH: GUEST_PATH, HOME: GUEST_HOME },
  files: { root: paths.dataDir, reads: [paths.datastore], writes: [], hide: [] },
  timeoutMs: 600_000,
  policy: { model: 'anthropic/claude-sonnet-5.5', internet: false, zdr: true, secrets: {} },
})
