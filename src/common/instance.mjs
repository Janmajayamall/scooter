// One service per data folder.
//
// Two bridges on one datastore would each give out the same `seq` (D29 and D48 of
// `docs/DECISIONS.md`). Two runners would run the same batch twice, write `state.json` against
// each other, and each remove the other's `run.lock` when it starts (6.4). So each service listens
// on a Unix socket in its own folder while it runs.

import fs from 'node:fs'
import net from 'node:net'

// Makes sure only one `name` (`bridge` or `runner`) runs on a data folder: it listens on the Unix
// socket `file`. A second one finds the socket answering and refuses to start. A socket left by one
// that was killed doesn't answer, and is replaced. Unlike a lock file holding a pid, this can't
// mistake an unrelated process that was given the same pid for the service, and it works across
// containers that share the folder. Returns `{ close }`.
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
    if (await answers()) throw new Error(`another ${name} is running on this data folder: ${file} answers`)
    fs.rmSync(file, { force: true })
    await listen()
  }
  // Node removes the socket when it stops listening.
  return { close: () => new Promise(resolve => server.close(() => resolve())) }
}
