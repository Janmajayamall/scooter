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

// A channel the test drives. Options: its `name`, and whether it `takesCommands`, `canSend` and
// `canReact`. Its sends are recorded with the fake clock's time, when one is given, and answer
// with IDs `<NAME>-OUT-1`, `-2`…; the test can make it not ready, or make sends fail.
export function createFakeChannel({ name = 'whatsapp', takesCommands = true, canSend = true, canReact = true, clock = null } = {}) {
  let onRecord = null
  const plans = new Map()
  const downloads = []
  const sends = []
  let ready = true
  let failures = []
  let failingAll = null
  let withoutId = 0
  let givenIds = []
  let sent = 0
  async function send(call) {
    if (!ready) throw Object.assign(new Error('not ready'), { code: 'ENOTREADY' })
    call.at = clock?.now() ?? null
    const failure = failures.length > 0 ? failures.shift() : failingAll
    if (failure) {
      sends.push({ ...call, failed: true })
      if (failure.unready) ready = false
      throw Object.assign(new Error('send failed'), { code: failure.code ?? 'EWACLI' })
    }
    sends.push(call)
    if (withoutId > 0) {
      withoutId -= 1
      return null
    }
    if (givenIds.length > 0) return givenIds.shift()
    return `${name.toUpperCase()}-OUT-${++sent}`
  }
  return {
    name,
    takesCommands,
    canSend,
    canReact,
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
    ready: () => ready,
    sendText: (text, quoteId, { signal } = {}) => send({ type: 'text', text, quoteId, aborted: signal?.aborted ?? false }),
    react: (id, emoji, { signal } = {}) => send({ type: 'react', id, emoji, aborted: signal?.aborted ?? false }),

    // Every send asked for, in order: `{ type, text, quoteId }` or `{ type, id, emoji }`, with the
    // fake clock's `at`, and `failed` for one that failed.
    sends,
    // Whether it can send now.
    setReady(value) {
      ready = value
    },
    // What the next sends do, one for each item: null works, and `{ code }` fails, with `unready`
    // to stop being ready too.
    failNext(...items) {
      failures = items
    },
    // Every send fails, with `{ code }`, until it is given null, as during an outage.
    failAll(failure) {
      failingAll = failure
    },
    // The next sends work, and give these IDs, one each.
    idsNext(...ids) {
      givenIds = ids
    },
    // The next `count` sends work, and give no ID.
    noIdNext(count = 1) {
      withoutId = count
    },
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
