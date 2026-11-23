// One service per data folder.
//
// Two bridges on one datastore would each give out the same `seq`.
// Two runners would run the same batch twice, write `state.json` against
// each other, and each remove the other's `run.lock` when it starts. So each service listens
// on a Unix socket in its own folder while it runs.

import fs from 'node:fs'
import net from 'node:net'

// What holds the runner's socket, `runner/runner.sock`, so that only one of them works on a data
// folder at a time: the runner and `build-image`. A second runner would run the same batches, and
// `build-image` replaces the VM image the runner's VMs boot from.
export const RUNNER_SOCKET_HOLDERS = 'runner or build-image'

// Whether something listens on the Unix socket `file`. A connection is made into the socket's
// queue by the system, so a holder whose own work keeps it from taking connections still answers,
// while the queue has room: Node makes it 511 long, and each check leaves a connection in it until
// the holder takes it. So a holder that takes none for 512 checks, which the bridge makes once a
// second while a run is past its time, is taken for gone.
function connects(file) {
  return new Promise(resolve => {
    const socket = net.connect(file)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// Makes sure only one `name` (`bridge` or `runner`) runs on a data folder: it listens on the Unix
// socket `file`. A second one finds the socket answering and refuses to start. A socket left by one
// that was killed doesn't answer, and is replaced. Unlike a lock file holding a pid, this can't
// mistake an unrelated process that was given the same pid for the service, and it works across
// containers that share the folder. Returns `{ close }`. When another holds the socket, throws an
// error with the code `EINSTANCE`.
export async function holdInstance(file, name = 'bridge') {
  const server = net.createServer(socket => socket.destroy())
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(file, () => {
        server.off('error', reject)
        resolve()
      })
    })

  try {
    await listen()
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    if (await connects(file)) throw Object.assign(new Error(`another ${name} is running on this data folder: ${file} answers`), { code: 'EINSTANCE' })
    fs.rmSync(file, { force: true })
    await listen()
  }
  // Node removes the socket when it stops listening.
  return { close: () => new Promise(resolve => server.close(() => resolve())) }
}

// Whether a service holds the socket `file`, as `holdInstance` holds it, without taking it: the
// bridge asks it of `runner/runner.sock` to tell a runner still at work after its run's time from
// one that is gone, and `restore` of both sockets before it writes over the data folder.
// Only a socket counts, not a link to one: the runner's user controls the runner's folder.
export async function instanceAnswers(file) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    return false
  }
  return stat.isSocket() && connects(file)
}
