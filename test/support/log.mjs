// A log that keeps its entries, so a test can look at what was logged.

import { createLog } from '../../src/common/log.mjs'

// Returns `{ log, entries }`. `entries` is the list of logged objects, in order.
export function createTestLog({ component = 'test', clock } = {}) {
  const entries = []
  const log = createLog({ component, clock, write: line => entries.push(JSON.parse(line)) })
  return { log, entries, events: () => entries.map(entry => entry.event) }
}
