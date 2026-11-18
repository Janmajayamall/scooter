// Writing the network log (6.13 of DESIGN.md), whose format is in `src/common/netlog.mjs`, and
// following each request the policy lets out to its answer.
//
// The policy (`policy.mjs`) writes a `request` line before it lets a request out, and a `refused`
// line for one it refuses. What comes of a request it let out is the HTTP client's: Gondolin 0.14.0
// makes the request itself, with undici, in the runner's process. An `onResponse` hook would make
// Gondolin hold back the whole answer until its end (13.4), which a streamed answer can't wait
// for, so the rest of the log comes from undici's diagnostics channels, which hold nothing back:
//
//   undici:request:create       the client made the request: which of the policy's it is
//   undici:client:sendHeaders   it is about to write it on a connection: the bytes so far, each way
//   undici:request:headers      the status came: a `response` line, at once
//   undici:request:trailers     the answer is over: an `end` line, with the bytes each way
//   undici:request:error        it broke: an `error` line before the status, an `end` line after
//
// The policy tells the two apart by a header of its own, `MARKER_HEADER`, holding the request's ID
// in the log. It sets the header on every request it lets out, in place of any the VM sent, and
// takes it out of undici's request when the request is made, before anything of it is written on
// a connection: undici publishes `undici:request:create` as it makes the request, and writes the
// head from the request's list of headers only once the request has a connection. So nothing past
// the runner ever sees it, and a request's lines are its own, however many requests are in flight.
//
// A request the policy let out that never reached the client, as when Gondolin couldn't resolve its
// host, or found it private (6.13), and one still waiting for its answer when its run ends, are
// written as `error` lines when the run's network closes: every `request` line then has what came
// of it, unless the runner was killed.

import diagnostics from 'node:diagnostics_channel'
import fs from 'node:fs'
import { ensureDir } from '../../common/files.mjs'
import { limits } from '../../common/limits.mjs'
import { errorFields } from '../../common/log.mjs'
import { formatNetworkLogLine } from '../../common/netlog.mjs'
import { isoSeconds } from '../../common/time.mjs'

// The header that ties a request undici makes to the line the policy wrote for it.
export const MARKER_HEADER = 'x-scooter-request'

// The longest host name DNS has, in characters. A longer one is no host's, and is cut.
const HOST_MAX_CHARS = 253

// What a reason or a name the log quotes may hold: no control or format characters, which a VM
// could put in a field's name.
const OTHER = /\p{C}/gu

// A character as a URL writes a byte it can't hold: `%` and two hex digits for each of its bytes.
const percent = char => [...Buffer.from(char)].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')

// A host as the log writes it: in lower case, with every character but letters, digits and
// `._:[]-` written as a URL writes a byte, and cut at the longest host name DNS has. The VM chose
// it, and a URL's host may hold such characters as `!` and `_`.
export function hostForLog(hostname) {
  let out = ''
  for (const char of String(hostname).toLowerCase()) out += /[a-z0-9._:[\]-]/.test(char) ? char : percent(char)
  return out === '' ? 'unknown' : out.slice(0, HOST_MAX_CHARS)
}

// A path as the log writes it, without its query string, which the caller leaves out: cut at
// `NETLOG_PATH_MAX_CHARS`, with `…`. A URL's path is printable ASCII without a space, `?` or `#`;
// anything else is written as a URL writes a byte.
export function pathForLog(pathname) {
  let text = ''
  for (const char of String(pathname)) text += /[\x21-\x7e]/.test(char) && char !== '?' && char !== '#' ? char : percent(char)
  if (!text.startsWith('/')) text = `/${text}`
  return text.length > limits.NETLOG_PATH_MAX_CHARS ? `${text.slice(0, limits.NETLOG_PATH_MAX_CHARS)}…` : text
}

// A request's method, as the log writes it, or undefined when it isn't a method of capitals that
// HTTP knows the like of.
export function methodForLog(method) {
  return typeof method === 'string' && /^[A-Z]{1,20}$/.test(method) ? method : undefined
}

// Something a reason quotes, such as the name of a field the policy refused: in quotes, on one
// line. The VM chose it, so a reason puts it last, where `reasonForLog` cuts.
export function quoteForLog(value) {
  return JSON.stringify(String(value)).replace(OTHER, '?')
}

// A reason on one line, cut at `REASON_MAX_CHARS`.
export function reasonForLog(text) {
  const chars = [...String(text).replace(OTHER, '?').trim()]
  if (chars.length === 0) return 'unknown'
  return chars.length > limits.REASON_MAX_CHARS ? `${chars.slice(0, limits.REASON_MAX_CHARS - 1).join('')}…` : chars.join('')
}

// The log, for writing: `write(entry)` appends one line to the day of its `at`, in the runner's
// own folder. It throws when the line can't be written, or isn't a line of the log.
export function createNetworkLog({ paths }) {
  return {
    write(entry) {
      const line = formatNetworkLogLine(entry)
      if (Buffer.byteLength(line) > limits.NETLOG_LINE_MAX_BYTES) throw new Error('a line of the network log would be longer than a reader takes')
      const file = paths.networkLog(entry.at.slice(0, 10))
      try {
        fs.appendFileSync(file, line, { mode: 0o600 })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        ensureDir(paths.networkLogDir, { mode: 0o700 })
        fs.appendFileSync(file, line, { mode: 0o600 })
      }
    },
  }
}

// What undici calls an error: its code when it has one of letters, digits and `_`, such as
// `ECONNREFUSED` or `UND_ERR_SOCKET`, or else its name, such as `AbortError`.
function errorReason(error) {
  const fields = errorFields(error)
  return typeof fields.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(fields.code) ? fields.code : reasonForLog(fields.error)
}

// The requests the policy let out and the client hasn't made yet, by ID, and those it has made,
// by undici's request. Each knows how to write its lines. They are the process's, since undici's
// channels are: one runner runs one VM at a time, but tests may open several networks at once.
const expected = new Map()
const live = new Map()

// Takes the policy's header out of undici's request, and returns its value, or null. undici keeps a
// request's headers as a list of names and values, which it writes once the request has a
// connection.
function takeMarker(request) {
  const headers = request?.headers
  if (!Array.isArray(headers)) return null
  let id = null
  for (let n = 0; n < headers.length; ) {
    if (typeof headers[n] === 'string' && headers[n].toLowerCase() === MARKER_HEADER) {
      id = String(headers[n + 1])
      headers.splice(n, 2)
    } else {
      n += 2
    }
  }
  return id
}

const CHANNELS = {
  'undici:request:create': ({ request }) => {
    const id = takeMarker(request)
    const entry = id === null ? undefined : expected.get(id)
    if (!entry) return
    expected.delete(id)
    live.set(request, entry)
  },
  'undici:client:sendHeaders': ({ request, socket }) => live.get(request)?.connected(socket),
  'undici:request:headers': ({ request, response }) => live.get(request)?.status(response.statusCode),
  'undici:request:trailers': ({ request }) => {
    const entry = live.get(request)
    live.delete(request)
    entry?.finish(null)
  },
  'undici:request:error': ({ request, error }) => {
    const entry = live.get(request)
    live.delete(request)
    entry?.finish(errorReason(error))
  },
}

let following = 0

function subscribe() {
  if (following++ === 0) for (const [name, handler] of Object.entries(CHANNELS)) diagnostics.subscribe(name, handler)
}

function unsubscribe() {
  if (--following === 0) for (const [name, handler] of Object.entries(CHANNELS)) diagnostics.unsubscribe(name, handler)
}

// Follows the requests of one run's network to their answers, and writes what came of each.
// `expect(id)` is called for each request the policy lets out, once its `request` line is written;
// `close()` when the run's VM has closed, which writes what is left. Nothing here throws into
// undici: a line that can't be written is said in the runner's log.
export function followRequests({ netlog, clock, log }) {
  const mine = new Set()
  const write = entry => {
    try {
      netlog.write(entry)
    } catch (error) {
      log.error('netlog.write_failed', { line: entry.event, ...errorFields(error) })
    }
  }
  subscribe()
  let closed = false

  return {
    expect(id) {
      const startedAt = clock.now()
      let status = null
      let socket = null
      let written = 0
      let read = 0
      const elapsed = () => Math.max(0, Math.round(clock.now() - startedAt))
      const entry = {
        connected(onto) {
          socket = onto
          written = onto.bytesWritten
          read = onto.bytesRead
        },
        status(code) {
          // An interim answer, such as `100 Continue`, isn't the request's.
          if (status !== null || !Number.isSafeInteger(code) || code < 200 || code > 599) return
          status = code
          write({ id, at: isoSeconds(clock.now()), event: 'response', status, ms: elapsed() })
        },
        finish(reason) {
          if (!mine.has(entry)) return
          mine.delete(entry)
          const at = isoSeconds(clock.now())
          if (status === null) {
            write({ id, at, event: 'error', reason: reason ?? 'no status', ms: elapsed() })
            return
          }
          const sent = socket === null ? 0 : Math.max(0, socket.bytesWritten - written)
          const received = socket === null ? 0 : Math.max(0, socket.bytesRead - read)
          write({ id, at, event: 'end', sent, received, ms: elapsed(), ...(reason === null ? {} : { reason }) })
        },
      }
      mine.add(entry)
      expected.set(id, entry)
    },

    close() {
      if (closed) return
      closed = true
      for (const [key, entry] of expected) {
        if (!mine.has(entry)) continue
        expected.delete(key)
        // Let out by the policy, and never made by the client.
        entry.finish('not_sent')
      }
      for (const [request, entry] of live) {
        if (!mine.has(entry)) continue
        live.delete(request)
        entry.finish('run_ended')
      }
      unsubscribe()
    },
  }
}
