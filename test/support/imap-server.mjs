// A small IMAP server, for the test of the mailbox adapter over imapflow (`src/mail/imap.mjs`):
// just enough of IMAP4rev1 (RFC 3501) for imapflow to log in, EXAMINE `INBOX`, FETCH by UID and by
// sequence number, SEARCH, IDLE and LOGOUT. It listens on a Unix socket in the test's folder, so
// the test reaches no network, and imapflow reaches it through its `transport` option, without TLS.
//
// It records every command it is sent, so the test can see that nothing changes the mailbox.

import net from 'node:net'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = number => String(number).padStart(2, '0')
const internalDate = iso => {
  const d = new Date(iso)
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
}
const headerOf = raw => {
  const end = raw.indexOf('\r\n\r\n')
  return end === -1 ? raw : raw.subarray(0, end + 4)
}

// The messages a sequence set names, by UID or by sequence number, as IMAP reads `a:b`, `a:*` and
// lists of them: `*` is the largest, and a range may be given either way round.
function select(messages, set, byUid) {
  const key = (message, n) => (byUid ? message.uid : n + 1)
  const largest = messages.length === 0 ? 0 : key(messages.at(-1), messages.length - 1)
  const value = text => (text === '*' ? largest : Number(text))
  const ranges = set.split(',').map(part => {
    const [from, to = from] = part.split(':').map(value)
    return [Math.min(from, to), Math.max(from, to)]
  })
  return messages.map((message, n) => ({ message, seq: n + 1, key: key(message, n) })).filter(({ key: k }) => ranges.some(([low, high]) => k >= low && k <= high))
}

export async function startImapServer(socketPath, { user, password, uidValidity = 3857529045, uidNext = 1 } = {}) {
  const messages = []
  let nextUid = uidNext
  const commands = []
  const idling = new Set()
  const sockets = new Set()

  function handle(socket, line, write) {
    const match = /^(\S+) (?:(UID) )?(\S+)(?: (.*))?$/.exec(line)
    if (!match) return write('* BAD what?')
    const [, tag, uid, name, rest = ''] = match
    const command = `${uid ? 'UID ' : ''}${name.toUpperCase()}`
    commands.push({ command, rest: command === 'LOGIN' ? '(withheld)' : rest })
    const ok = text => write(`${tag} OK ${text}`)
    switch (command) {
      case 'CAPABILITY':
        write('* CAPABILITY IMAP4rev1 IDLE')
        return ok('CAPABILITY completed')
      case 'LOGIN': {
        const [given, secret] = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(found => (found[1] ?? found[2]).replace(/\\(.)/g, '$1'))
        if (given === user && secret === password) return ok('[CAPABILITY IMAP4rev1 IDLE] logged in')
        return write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`)
      }
      case 'LIST':
      case 'LSUB':
        if (/""\s*""/.test(rest)) write('* LIST (\\Noselect) "/" ""')
        else write('* LIST (\\HasNoChildren) "/" INBOX')
        return ok('LIST completed')
      case 'NOOP':
        return ok('NOOP completed')
      case 'EXAMINE':
        write(`* ${messages.length} EXISTS`)
        write('* 0 RECENT')
        write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)')
        write('* OK [PERMANENTFLAGS ()] No permanent flags permitted')
        write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid`)
        write(`* OK [UIDNEXT ${nextUid}] Predicted next UID`)
        return ok('[READ-ONLY] EXAMINE completed')
      case 'FETCH':
      case 'UID FETCH': {
        const [, set, items] = /^(\S+) \((.*)\)$/.exec(rest) ?? /^(\S+) (.*)$/.exec(rest)
        for (const { message, seq } of select(messages, set, command === 'UID FETCH')) {
          const parts = [`UID ${message.uid}`]
          if (/RFC822\.SIZE/i.test(items)) parts.push(`RFC822.SIZE ${message.size ?? message.raw.length}`)
          if (/INTERNALDATE/i.test(items)) parts.push(`INTERNALDATE "${internalDate(message.arrivedAt)}"`)
          const literals = []
          if (/BODY\.PEEK\[HEADER\]/i.test(items)) literals.push(['BODY[HEADER]', headerOf(message.raw)])
          if (/BODY\.PEEK\[\]/i.test(items)) literals.push(['BODY[]', message.raw])
          let head = `* ${seq} FETCH (${parts.join(' ')}`
          for (const [label, bytes] of literals) {
            write(`${head} ${label} {${bytes.length}}`)
            socket.write(bytes)
            head = ''
          }
          write(`${head})`)
        }
        return ok('FETCH completed')
      }
      case 'UID SEARCH':
      case 'SEARCH': {
        const since = /SINCE "?(\d{1,2})-(\w{3})-(\d{4})"?/i.exec(rest)
        const from = since ? Date.UTC(Number(since[3]), MONTHS.indexOf(since[2]), Number(since[1])) : -Infinity
        const found = messages.filter(message => Date.parse(message.arrivedAt) >= from)
        write(`* SEARCH${found.map((message, n) => ` ${command === 'UID SEARCH' ? message.uid : n + 1}`).join('')}`)
        return ok('SEARCH completed')
      }
      case 'IDLE':
        idling.add(socket)
        socket.idleTag = tag
        return write('+ idling')
      case 'LOGOUT':
        write('* BYE logging out')
        ok('LOGOUT completed')
        return socket.end()
      default:
        return write(`${tag} BAD unknown command`)
    }
  }

  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      idling.delete(socket)
    })
    socket.on('error', () => {})
    const write = text => socket.write(`${text}\r\n`)
    write('* OK [CAPABILITY IMAP4rev1 IDLE] Fake IMAP ready')
    let buffer = Buffer.alloc(0)
    let pending = ''
    let literal = 0
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (literal > 0) {
          if (buffer.length < literal) return
          pending += buffer.subarray(0, literal).toString('latin1')
          buffer = buffer.subarray(literal)
          literal = 0
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end === -1) return
        const line = pending + buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 2)
        const size = /\{(\d+)(\+?)\}$/.exec(line)
        if (size) {
          pending = line
          literal = Number(size[1])
          if (!size[2]) write('+ Ready for literal')
          continue
        }
        pending = ''
        if (idling.has(socket)) {
          if (line.toUpperCase() === 'DONE') {
            idling.delete(socket)
            commands.push({ command: 'DONE', rest: '' })
            write(`${socket.idleTag} OK IDLE terminated`)
          }
          continue
        }
        handle(socket, line, write)
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  return {
    // What imapflow is given as its `transport`: a connection to the socket, in place of TLS.
    transport: { connect: (options, onConnect) => net.connect(socketPath, onConnect) },
    // Every command, as `{ command, rest }`, `UID FETCH` and `UID SEARCH` named so.
    commands,
    // A message arrives; a client in IDLE is told.
    deliver(raw, { arrivedAt = '2026-11-09T16:12:40Z', size = null } = {}) {
      const message = { uid: nextUid++, raw: Buffer.from(raw), arrivedAt, size }
      messages.push(message)
      for (const socket of idling) socket.write(`* ${messages.length} EXISTS\r\n`)
      return message.uid
    },
    // Every connection is cut, as when the server goes away.
    drop() {
      for (const socket of sockets) socket.destroy()
    },
    get connections() {
      return sockets.size
    },
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      }),
  }
}
