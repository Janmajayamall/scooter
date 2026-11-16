// Starts a VM, prints the process ID of its QEMU, and waits to be killed.
//
// The test of what a killed runner leaves behind runs this as a process of its own, in its own
// process group, the way a service manager would run the runner.

import { VM, createHttpHooks } from '@earendil-works/gondolin'

const vm = await VM.create({
  sandbox: { imagePath: process.env.SCOOTER_TEST_IMAGE },
  allowWebSockets: false,
  httpHooks: createHttpHooks({ allowedHosts: [] }).httpHooks,
})
await vm.start()
process.stdout.write(`${vm.getHostPid()}\n`)
setInterval(() => {}, 60_000)
