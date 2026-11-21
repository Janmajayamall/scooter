// A fake mailbox, behind the same functions as the IMAP one (`src/mail/imap.mjs`), for the email
// reader's tests.
//
// It holds messages by UID, as an IMAP server's `INBOX` does, answers `n:*` as IMAP does (the
// newest message, when none has a UID of `n` or more), and records what was asked of it, so a test
// can see that headers come first and whole messages only for the owner. It can lose the
// connection, refuse to connect, and renumber its messages, as a server that changes its
// `UIDVALIDITY` does.

const header = raw => {
  const text = raw.toString('latin1')
  const end = text.search(/\r?\n\r?\n/)
  if (end === -1) return Buffer.from(raw)
  const blank = /\r?\n\r?\n/.exec(text.slice(end))[0]
  return Buffer.from(raw.subarray(0, end + blank.length))
}

// `uidValidity` and `uidNext` to start from; `clock`, for when a message arrives when no time is
// given.
export function createFakeMailbox({ uidValidity = 1700000001, uidNext = 1, clock = { now: () => Date.now() } } = {}) {
  let validity = uidValidity
  let nextUid = uidNext
  let messages = []
  let connections = []
  let failures = []
  const calls = []

  // A failure the test asked for, for this kind of call, or nothing.
  function failure(op) {
    const index = failures.findIndex(item => item.op === op)
    if (index === -1) return null
    const [item] = failures.splice(index, 1)
    return Object.assign(new Error(`the fake mailbox fails ${op}`), { code: item.code })
  }

  const listed = ({ uid, size, arrivedAt }) => ({ uid, size, arrivedAt })

  function connection() {
    let lost = null
    let arrived = false
    let waiters = []
    let opened = false
    const state = {
      onArrival() {
        arrived = true
        const waiting = waiters
        waiters = []
        for (const waiter of waiting) waiter.resolve()
      },
      lose(error) {
        lost ??= error
        const waiting = waiters
        waiters = []
        for (const waiter of waiting) waiter.reject(lost)
      },
    }
    const guard = op => {
      calls.push(op)
      if (lost) throw lost
      const failed = failure(op.op)
      if (failed) throw failed
    }
    const mailbox = {
      async open() {
        guard({ op: 'open' })
        opened = true
        return { uidValidity: validity, uidNext: nextUid }
      },
      async list(from) {
        guard({ op: 'list', from })
        if (messages.length === 0) return []
        const top = messages.at(-1).uid
        // `from:*` is the range from `from` to the largest UID, either way round.
        const [low, high] = from <= top ? [from, top] : [top, from]
        return messages.filter(message => message.uid >= low && message.uid <= high).map(listed)
      },
      async header(uid) {
        guard({ op: 'header', uid })
        const found = messages.find(message => message.uid === uid)
        return found ? header(found.raw) : null
      },
      async source(uid) {
        guard({ op: 'source', uid })
        const found = messages.find(message => message.uid === uid)
        return found ? Buffer.from(found.raw) : null
      },
      async search({ since }) {
        guard({ op: 'search', since: since.toISOString() })
        return messages.filter(message => Date.parse(message.arrivedAt) >= since.getTime()).map(message => message.uid)
      },
      async newest(count) {
        guard({ op: 'newest', count })
        return messages.slice(-count).map(listed)
      },
      news({ signal } = {}) {
        if (lost) return Promise.reject(lost)
        if (arrived) {
          arrived = false
          return Promise.resolve()
        }
        return new Promise((resolve, reject) => {
          const waiter = {
            resolve: () => {
              arrived = false
              signal?.removeEventListener('abort', onAbort)
              resolve()
            },
            reject: error => {
              signal?.removeEventListener('abort', onAbort)
              reject(error)
            },
          }
          const onAbort = () => {
            waiters = waiters.filter(other => other !== waiter)
            reject(signal.reason ?? new Error('aborted'))
          }
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
          waiters.push(waiter)
        })
      },
      async close() {
        calls.push({ op: 'close' })
        connections = connections.filter(other => other !== state)
      },
    }
    state.opened = () => opened
    return { state, mailbox }
  }

  return {
    // What the reader is given as `openMailbox`. Rejects when the test asked `connect` to fail.
    async openMailbox() {
      calls.push({ op: 'connect' })
      const failed = failure('connect')
      if (failed) throw failed
      const { state, mailbox } = connection()
      connections.push(state)
      return mailbox
    },

    // A message arrives: `raw` is the whole message, as a Buffer or text. With `notify`, the
    // server says so to every connection in IDLE; without, as IDLE sometimes misses one, only a
    // look finds it. Returns its UID.
    deliver(raw, { arrivedAt = new Date(Math.floor(clock.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'), notify = true } = {}) {
      const buffer = Buffer.from(raw)
      const uid = nextUid++
      messages.push({ uid, raw: buffer, size: buffer.length, arrivedAt })
      if (notify) for (const state of connections) state.onArrival()
      return uid
    },

    // A message whose size the server gives as `size`, as for one too large to fetch.
    setSize(uid, size) {
      messages.find(message => message.uid === uid).size = size
    },

    // The server renumbers the mailbox: a new `UIDVALIDITY`, and the same messages with new UIDs
    // from `from` on.
    renumber({ from = 1 } = {}) {
      validity += 1
      nextUid = from
      messages = messages.map(message => ({ ...message, uid: nextUid++ }))
      return validity
    },

    // The connection is lost, as when the network or the server goes away.
    drop(code = 'ECLOSED') {
      for (const state of connections) state.lose(Object.assign(new Error('the fake mailbox dropped the connection'), { code }))
      connections = []
    },

    // The next call of the kind `op` fails, with the code given: `connect`, `open`, `list`,
    // `header`, `source` or `search`.
    failNext(op, code = 'EFAKE') {
      failures.push({ op, code })
    },

    // Every call so far, as `{ op, … }`.
    calls,
    // The calls of one kind, by the UID or range each asked for.
    callsOf: op => calls.filter(call => call.op === op),
    get uidValidity() {
      return validity
    },
    get messages() {
      return messages.map(listed)
    },
    // How many connections are open.
    get connected() {
      return connections.length
    },
  }
}
