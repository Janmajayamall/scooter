// The network policy (6.13 of DESIGN.md; ARCHITECTURE.md 2.8): what pi's VM may send, checked and
// logged in the runner before anything goes out.
//
// pi's VM has no network of its own. Gondolin's host side, in the runner's process, answers its DNS
// with made-up addresses, refuses UDP, raw TCP and private addresses, and hands each HTTP(S)
// request to this policy's `onRequest` hook, after terminating the VM's TLS (13.4). The hook:
//
// - **Hosts.** Lets out only `openrouter.ai` over HTTPS, and, with `AGENT_INTERNET=on`, any other
//   host over HTTPS but OpenRouter's others. Plain HTTP is refused. Gondolin then refuses a host
//   that resolves to a private address, however it was named.
// - **OpenRouter.** Lets out only `POST /api/v1/chat/completions` and `POST /api/v1/messages`
//   (with pi's `?beta=true`), and gives 403 to anything else on `openrouter.ai`. It reads the whole
//   body, up to `MODEL_REQUEST_MAX_BYTES`, and answers 400 unless the request is shaped like the
//   pinned pi's (`checkModelRequest`): the agent's model; only the top-level fields and
//   `anthropic-beta` values pi sends; only tools pi runs itself; no `plugins` or `mcp_servers`;
//   images and documents only inline. Then it forwards its own encoding of the body it checked, so
//   a duplicated key can't show the check one value and OpenRouter another.
// - **Zero data retention.** With `OPENROUTER_ZDR=on`, sets `provider.zdr` and
//   `provider.data_collection` in every body it forwards, on the routes `ZDR_ROUTES` names.
// - **The key.** pi sees a placeholder in `OPENROUTER_API_KEY`, which Gondolin swaps for the key on
//   requests to `openrouter.ai` only, after this hook. So the hook lets the placeholder go only to
//   `openrouter.ai`, and only in the header pi sends it in, `x-api-key` on the messages route and
//   `Authorization: Bearer` on the other; a request there with a key of its own is refused, as a
//   request elsewhere with the placeholder, or the key, in any header is.
// - **The log.** Writes a `request` line before a request goes out, and a `refused` line for one it
//   refuses, with the reason but never the body (`netlog.mjs`). One run may make
//   `RUN_REQUESTS_MAX` requests that go out; refusals past `RUN_REFUSALS_LOGGED_MAX` are counted,
//   and the count written when the run's network closes.
//
// Refusals answer the VM with an error in OpenRouter's shape, so pi prints the policy's reason.
//
// The allowlists are what the pinned pi sends for any model in its catalog, on each route, as
// milestone 0 captured them (`test/fixtures/pi-requests/`; `docs/DECISIONS.md`, 0.4, pi 6). A test
// compares them with the fixtures, which are captured again with every new pi.

import { createIds } from '../../common/files.mjs'
import { limits } from '../../common/limits.mjs'
import { errorFields } from '../../common/log.mjs'
import { isoSeconds } from '../../common/time.mjs'
import { OPENROUTER_HOST } from './index.mjs'
import { MARKER_HEADER, createNetworkLog, followRequests, hostForLog, methodForLog, pathForLog, quoteForLog, reasonForLog } from './netlog.mjs'

// OpenRouter's two chat routes (13.2): the path, the query strings pi uses, and the header pi sends
// the key in, with how the key is written there.
export const ROUTES = {
  messages: { path: '/api/v1/messages', queries: ['', '?beta=true'], keyHeader: 'x-api-key', keyValue: key => key },
  chat: { path: '/api/v1/chat/completions', queries: [''], keyHeader: 'authorization', keyValue: key => `Bearer ${key}` },
}
const KEY_HEADERS = Object.values(ROUTES).map(route => route.keyHeader)

// The top-level fields of the body pi sends on each route, for any model of its catalog.
export const PI_FIELDS = {
  messages: ['max_tokens', 'messages', 'model', 'output_config', 'stream', 'system', 'thinking', 'tools'],
  chat: ['max_completion_tokens', 'messages', 'model', 'reasoning', 'store', 'stream', 'stream_options', 'tools'],
}

// The `anthropic-beta` values pi sends on each route, for any model of its catalog.
export const PI_BETAS = {
  messages: ['interleaved-thinking-2025-05-14', 'mid-conversation-output-config-2026-07-01', 'thinking-binding-controls-2026-08-01'],
  chat: [],
}

// Where the policy asks for zero data retention when `OPENROUTER_ZDR=on`. OpenRouter's reference
// shows a `provider` object on the messages route only with `allow_fallbacks` (14): if that route
// turns out to refuse these fields, it is set false here, and the key's guardrail enforces ZDR on
// that route alone (the plan's rule for milestone 8).
export const ZDR_ROUTES = { messages: true, chat: true }
export const ZDR_PROVIDER = { zdr: true, data_collection: 'deny' }

// The kinds of content a message may hold, on each route: what pi sends, and the other inline media
// OpenRouter takes. Anything else is refused, so a kind that could have OpenRouter fetch something
// fails closed.
const MESSAGE_BLOCKS = new Set(['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'])
const TOOL_RESULT_BLOCKS = new Set(['text', 'image', 'document'])
const CHAT_PARTS = new Set(['text', 'image_url', 'file', 'input_audio'])

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isDataUrl = value => typeof value === 'string' && /^data:/i.test(value)

// What is wrong with a block of content on the messages route, or null. An image or a document is
// inline only with a `base64` source; any other source has OpenRouter, or the model's provider,
// fetch it or look it up.
function checkBlock(block, allowed) {
  if (!isObject(block)) return 'a block of content that is not an object'
  if (!allowed.has(block.type)) return `a kind of content pi doesn't send: ${quoteForLog(block.type)}`
  if ((block.type === 'image' || block.type === 'document') && block.source?.type !== 'base64') return `${block.type === 'image' ? 'an image' : 'a document'} given by URL, or another way than inline`
  if (block.type === 'tool_result' && block.content !== undefined && typeof block.content !== 'string') {
    if (!Array.isArray(block.content)) return 'a tool result whose content is not a list'
    for (const inner of block.content) {
      const problem = checkBlock(inner, TOOL_RESULT_BLOCKS)
      if (problem !== null) return problem
    }
  }
  return null
}

// What is wrong with a part of a message on the chat route, or null. An image, or a file such as a
// PDF, is inline only as a `data:` URL.
function checkPart(part) {
  if (!isObject(part)) return 'a part of a message that is not an object'
  if (!CHAT_PARTS.has(part.type)) return `a kind of content pi doesn't send: ${quoteForLog(part.type)}`
  if (part.type === 'image_url' && !isDataUrl(typeof part.image_url === 'string' ? part.image_url : part.image_url?.url)) return 'an image given by URL'
  if (part.type === 'file' && (!isObject(part.file) || !isDataUrl(part.file.file_data) || Object.keys(part.file).some(name => name !== 'filename' && name !== 'file_data'))) {
    return 'a document given by URL, or another way than inline'
  }
  return null
}

// What is wrong with the content of a body's messages, and its system prompt, or null.
function checkContent(route, body) {
  if (!Array.isArray(body.messages)) return 'messages is not a list'
  const contents = body.messages.map(message => (isObject(message) ? message.content : undefined))
  if (route === 'messages' && body.system !== undefined) contents.push(body.system)
  for (const content of contents) {
    if (content === undefined || content === null || typeof content === 'string') continue
    if (!Array.isArray(content)) return 'content that is neither text nor a list'
    for (const item of content) {
      const problem = route === 'messages' ? checkBlock(item, MESSAGE_BLOCKS) : checkPart(item)
      if (problem !== null) return problem
    }
  }
  return null
}

// What is wrong with a request's body on OpenRouter's `route`, for an agent whose model is `model`,
// as a short reason, or null when it is shaped like the pinned pi's (6.13).
export function checkModelRequest({ route, body, model }) {
  if (!isObject(body)) return "the body isn't a JSON object"
  if (body.model !== model) return "the model isn't the agent's"
  if (Object.hasOwn(body, 'plugins')) return 'plugins are not allowed'
  if (Object.hasOwn(body, 'mcp_servers')) return 'mcp_servers is not allowed'
  for (const name of Object.keys(body)) {
    if (!PI_FIELDS[route].includes(name)) return `a field the pinned pi doesn't send: ${quoteForLog(name)}`
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return 'tools is not a list'
    for (const tool of body.tools) {
      if (!isObject(tool)) return 'a tool that is not an object'
      // A client tool, which pi runs itself: a function on the chat route, and one without a type on
      // the messages route, where a type names a tool the server runs, such as web search.
      if (route === 'chat' ? tool.type !== 'function' : tool.type !== undefined) return `a tool pi doesn't run itself: ${quoteForLog(tool.type)}`
    }
  }
  return checkContent(route, body)
}

// The `anthropic-beta` values of a request's headers.
export function betaValues(headers) {
  return (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

// The route a request to `openrouter.ai` is on, or null when it is on none of the two.
function routeOf(url, method) {
  if (method !== 'POST' || url.port !== '') return null
  for (const [name, route] of Object.entries(ROUTES)) {
    if (url.pathname === route.path && route.queries.includes(url.search)) return name
  }
  return null
}

// Whether any of a request's headers, apart from `except`, holds one of `values`.
function headersHold(headers, values, except = null) {
  for (const [name, value] of headers) {
    if (name !== except && values.some(secret => secret !== '' && value.includes(secret))) return true
  }
  return false
}

// Reads a request's body, up to `max` bytes. Returns null when it is longer.
async function readBody(request, max) {
  if (request.body === null) return Buffer.alloc(0)
  const chunks = []
  let size = 0
  for await (const chunk of request.body) {
    size += chunk.byteLength
    if (size > max) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

// The answer to a request the policy refuses, in OpenRouter's shape, which pi prints (0.4, pi 5).
function refusal(status, reason) {
  const body = { error: { message: `Scooter's network policy refused this request: ${reason}`, code: status } }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Checks a request to `openrouter.ai`. Returns `{ request }`, the request to let out, with the body
// the hook encoded, or `{ status, reason }` when it is refused.
async function checkOpenRouter({ request, url, policy, placeholders, keys }) {
  const route = routeOf(url, request.method)
  if (route === null) return { status: 403, reason: "not one of OpenRouter's two chat routes" }
  const { keyHeader, keyValue } = ROUTES[route]
  const { headers } = request

  // The key: the placeholder, in the header pi sends it in, and nowhere else (the plan's rule for
  // milestone 8, "A key of pi's own").
  const placeholder = placeholders.OPENROUTER_API_KEY
  if (placeholder === undefined || headers.get(keyHeader) !== keyValue(placeholder)) return { status: 403, reason: "the key isn't the placeholder, in the header pi sends it in" }
  if (KEY_HEADERS.some(name => name !== keyHeader && headers.has(name))) return { status: 403, reason: "the key is in a header pi doesn't send it in" }
  if (headersHold(headers, Object.values(placeholders), keyHeader)) return { status: 403, reason: "the key's placeholder is in another header" }
  if (headersHold(headers, keys)) return { status: 403, reason: 'the request already holds a key' }

  for (const value of betaValues(headers)) {
    if (!PI_BETAS[route].includes(value)) return { status: 400, reason: `an anthropic-beta value the pinned pi doesn't send: ${quoteForLog(value)}` }
  }
  const encoding = headers.get('content-encoding')
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') return { status: 400, reason: "a compressed body, which the policy can't check" }

  const bytes = await readBody(request, limits.MODEL_REQUEST_MAX_BYTES)
  if (bytes === null) return { status: 400, reason: 'the body is longer than the policy reads' }
  let body
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { status: 400, reason: "the body isn't JSON" }
  }
  const problem = checkModelRequest({ route, body, model: policy.model })
  if (problem !== null) return { status: 400, reason: problem }

  if (policy.zdr && ZDR_ROUTES[route]) body.provider = { ...ZDR_PROVIDER }
  const forwarded = new Headers(headers)
  for (const name of ['content-length', 'content-encoding']) forwarded.delete(name)
  return { request: new Request(request.url, { method: 'POST', headers: forwarded, body: JSON.stringify(body) }) }
}

// The network policy for the runner's sandbox: `network(policy, { placeholders })`, which gives,
// for one run, the options of Gondolin's `createHttpHooks` apart from the secrets, and `close()`,
// which the sandbox calls once the run's VM has closed. `policy` is the run spec's (`index.mjs`),
// and `placeholders` maps each secret's variable to the placeholder the VM sees in its place.
export function policyNetwork({ paths, clock, log }) {
  const netlog = createNetworkLog({ paths })
  const ids = createIds(clock)
  return (policy, { placeholders = {} } = {}) => runNetwork({ policy, placeholders, netlog, ids, clock, log })
}

function runNetwork({ policy, placeholders, netlog, ids, clock, log }) {
  const keys = Object.values(policy.secrets).map(secret => secret.value)
  const follow = followRequests({ netlog, clock, log })
  let letOut = 0
  let refusals = 0
  let unlogged = 0
  let closed = false

  const refuse = (status, reason, where) => {
    refusals += 1
    if (refusals > limits.RUN_REFUSALS_LOGGED_MAX) {
      unlogged += 1
    } else {
      try {
        netlog.write({ at: isoSeconds(clock.now()), event: 'refused', ...where, reason: reasonForLog(reason) })
      } catch (error) {
        log.error('netlog.write_failed', { line: 'refused', ...errorFields(error) })
      }
    }
    return refusal(status, reason)
  }

  async function check(request) {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return refuse(400, 'not a URL', { host: 'unknown' })
    }
    const method = methodForLog(request.method)
    const where = { host: hostForLog(url.hostname), method, path: pathForLog(url.pathname) }
    if (url.protocol !== 'https:') return refuse(403, "plain HTTP isn't allowed", where)
    // OpenRouter is reached only as `openrouter.ai`, by its two routes: not by another of its
    // hosts, nor by its name with a dot at the end, which Gondolin could take for the same host.
    const bare = url.hostname.replace(/\.+$/, '')
    const toOpenRouter = url.hostname === OPENROUTER_HOST
    const ofOpenRouter = bare === OPENROUTER_HOST || bare.endsWith(`.${OPENROUTER_HOST}`)
    if (!toOpenRouter && (!policy.internet || ofOpenRouter)) return refuse(403, 'host not allowed', where)
    if (method === undefined) return refuse(403, 'method not allowed', where)
    if (letOut >= limits.RUN_REQUESTS_MAX) return refuse(403, 'this run has made all the requests a run may', where)

    // The request is counted before its body is read, which waits on the VM, and given back if it
    // doesn't go out: counted after, requests read at the same time would each pass the check
    // above, and a run could make up to as many more as Gondolin handles at once (the review of
    // milestone 8, smaller point 2).
    letOut += 1
    let sent = false
    try {
      let outgoing = request
      if (toOpenRouter) {
        const checked = await checkOpenRouter({ request, url, policy, placeholders, keys })
        if (checked.request === undefined) return refuse(checked.status, checked.reason, where)
        outgoing = checked.request
      } else if (headersHold(request.headers, [...Object.values(placeholders), ...keys])) {
        // Gondolin would refuse it too, after this hook, with no line in the log.
        return refuse(403, 'the key, and its placeholder, go only to openrouter.ai', where)
      }

      // The line before the request goes out: a request that can't have one doesn't go.
      const id = ids.next()
      try {
        netlog.write({ id, at: isoSeconds(clock.now()), event: 'request', ...where })
      } catch (error) {
        log.error('netlog.write_failed', { line: 'request', ...errorFields(error) })
        return refusal(503, "the network log can't be written")
      }
      outgoing.headers.set(MARKER_HEADER, id)
      follow.expect(id)
      sent = true
      return outgoing
    } finally {
      if (!sent) letOut -= 1
    }
  }

  // Nothing goes out on an error of the policy's own.
  async function onRequest(request) {
    try {
      return await check(request)
    } catch (error) {
      log.error('sandbox.policy_failed', errorFields(error))
      return refusal(500, 'the policy failed')
    }
  }

  return {
    // Gondolin checks a host against these, as well as against private addresses, once the hook
    // has let a request out.
    allowedHosts: policy.internet ? ['*'] : [OPENROUTER_HOST],
    onRequest,
    close() {
      if (closed) return
      closed = true
      follow.close()
      if (unlogged > 0) {
        try {
          netlog.write({ at: isoSeconds(clock.now()), event: 'unlogged', refused: unlogged })
        } catch (error) {
          log.error('netlog.write_failed', { line: 'unlogged', ...errorFields(error) })
        }
      }
      if (refusals > 0 || letOut > 0) log.info('sandbox.network', { requests: letOut, refused: refusals })
    },
  }
}
