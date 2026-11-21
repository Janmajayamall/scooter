// The runner's view of the datastore.
//
// The runner only reads the datastore. It follows it by polling once a second, and keeps the same
// index the bridge does (`src/common/datastore/index.mjs`): every line by `seq`, and what each
// message says now. It also notes when it last saw an incoming line arrive, which is when the
// owner was last heard from: a batch waits until they have been quiet for `BATCH_SECONDS`.
//
// That time is when the runner saw the line, not the line's own `at`. `at` is when the message was
// sent, by the channel's clock: a message caught up after downtime has an old one, and an email's
// comes from its `Date` header, which can lie in the future. Either would make the quiet period
// mean nothing, or never end.

import { createIndex } from '../common/datastore/index.mjs'
import { DatastoreError } from '../common/datastore/line.mjs'
import { createReader } from '../common/datastore/reader.mjs'
import { systemClock } from '../common/time.mjs'

// Returns the view. `poll()` reads the lines that are new, adds them to `index`, and returns how
// many there were. It throws a `DatastoreError` that names the file and the line if the datastore
// is damaged. The view is no use after that, and the runner must start again once the datastore is
// repaired.
export function openDatastore({ paths, clock = systemClock }) {
  const index = createIndex()
  const reader = createReader(paths)
  let incomingSeenAt = null

  function poll() {
    const fresh = reader.poll()
    for (const { line, day, number } of fresh) {
      try {
        index.add(line, day)
      } catch (error) {
        throw new DatastoreError(`${paths.dayLog(day)}, line ${number}: ${error.message}`)
      }
    }
    if (fresh.some(({ line }) => line.dir === 'in')) incomingSeenAt = clock.now()
    return fresh.length
  }

  return {
    index,
    poll,
    // When the runner last saw an incoming line arrive, in milliseconds, or null before it has
    // seen one. Lines already there when it starts count as seen then.
    get incomingSeenAt() {
      return incomingSeenAt
    },
  }
}
