// A channel for tests of the bridge's core (section 5 of DESIGN.md): the test hands it records,
// and its downloads come from contents the test gives, or fail as the test says.

import fs from 'node:fs'

// A record as a channel hands it over (`src/bridge/channels/index.mjs`), with everything not given
// left empty.
let nextId = 0
export function makeRecord(fields = {}) {
  return {
    source: 'whatsapp',
    id: `MSG-${++nextId}`,
    at: '2026-11-09T15:43:02Z',
    text: '',
    attachments: [],
    replyToId: null,
    replyToPreview: null,
    reactionToId: null,
    reactionEmoji: null,
    edited: false,
    revoked: false,
    forwarded: false,
    ...fields,
  }
}

// An attachment of a record, with everything not given unknown.
export function makeAttachment(fields = {}) {
  return { type: 'image', mime: 'image/jpeg', name: null, bytes: null, error: null, ...fields }
}

export function createFakeChannel({ name = 'whatsapp', takesCommands = true } = {}) {
  let onRecord = null
  const plans = new Map()
  const downloads = []
  return {
    name,
    takesCommands,
    async start(handler) {
      onRecord = handler
    },
    async stop() {
      onRecord = null
    },
    async download(record, n, target) {
      downloads.push({ id: record.id, n, target })
      const plan = plans.get(`${record.id}/${n}`)
      if (!plan) throw new Error('no such attachment')
      if (plan.failures > 0) {
        plan.failures -= 1
        throw Object.assign(new Error('download failed'), { code: plan.code })
      }
      fs.writeFileSync(target, plan.contents)
    },
    status: () => `${name}: fake`,

    // For the test: hands a record to the core, as if it had just arrived.
    deliver: record => onRecord(record),
    // The record's `n`th attachment downloads as `contents`, after failing `failures` times with
    // an error of code `code`.
    willDownload(record, n, contents, { failures = 0, code = 'EIO' } = {}) {
      plans.set(`${record.id}/${n}`, { contents, failures, code })
    },
    // Every download asked for, as `{ id, n, target }`.
    downloads,
  }
}
