// The network policy: its hook, given requests
// shaped like the pinned pi's from the fixtures of milestone 0, with Gondolin's own handling of the
// key around it, and a fake upstream on this machine in OpenRouter's place. And the network log it
// writes, following each request it lets out to its answer. No VM, and no network.

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { limits, overrideLimits } from '../src/common/limits.mjs'
import { MARKER_HEADER } from '../src/runner/sandbox/netlog.mjs'
import { PI_BETAS, PI_FIELDS, ROUTES, ZDR_PROVIDER, ZDR_ROUTES, checkModelRequest } from '../src/runner/sandbox/policy.mjs'
import { loadFixture } from './support/pi-requests.mjs'
import { PLACEHOLDER, gondolinFetch, modelOf, openPolicy, piRequest } from './support/policy.mjs'
import { KEY } from './support/test-runner.mjs'
import { atEnd } from './support/tmp.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isRefusal = value => value instanceof Response

async function waitFor(condition, what) {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

// The lines of the log of one event.
const linesOf = (policy, event) => policy.lines().filter(line => line.event === event)

// ---------------------------------------------------------------------------------------------
// What passes

test("policy: a request shaped like the pinned pi's passes on each route, and goes out with the real key in place of the placeholder", async t => {
  for (const route of ['messages', 'chat']) {
    for (const which of ['first', 'last']) {
      await t.test(`${route}, ${which} of the session`, async t => {
        const policy = await openPolicy(t, { model: modelOf(route) })
        const sent = piRequest(route, which)
        const original = await sent.clone().json()
        const out = await policy.send(sent)
        assert.ok(!isRefusal(out), `refused: ${isRefusal(out) ? await out.text() : ''}`)

        // The key, where pi put the placeholder, and the placeholder nowhere.
        const headers = Object.fromEntries(out.headers)
        assert.equal(route === 'messages' ? headers['x-api-key'] : headers.authorization, route === 'messages' ? KEY : `Bearer ${KEY}`)
        assert.ok(!JSON.stringify(headers).includes(PLACEHOLDER))
        // The hook's own encoding of the body it checked, asking for zero data retention.
        const text = await out.clone().text()
        assert.equal(text, JSON.stringify({ ...original, provider: ZDR_PROVIDER }))

        // The request line, before anything went out: the host and the path, not the query string.
        const [request] = policy.lines()
        assert.deepEqual({ ...request, id: undefined }, { id: undefined, at: '2026-11-09T15:50:00Z', event: 'request', host: 'openrouter.ai', method: 'POST', path: ROUTES[route].path })
        assert.equal(headers[MARKER_HEADER], request.id)

        // To the upstream, which gets the key and the body, and not the policy's header; then the
        // status, and the end of the answer, under the request's ID.
        const answer = await policy.forward(out)
        assert.equal(answer.status, 200)
        assert.equal(await answer.text(), '{"ok":true}')
        await waitFor(() => linesOf(policy, 'end').length === 1, 'the end line')
        const [got] = policy.received
        assert.equal(got.headers[MARKER_HEADER], undefined)
        assert.equal(route === 'messages' ? got.headers['x-api-key'] : got.headers.authorization, route === 'messages' ? KEY : `Bearer ${KEY}`)
        assert.equal(got.url, `${ROUTES[route].path}${new URL(sent.url).search}`)
        assert.deepEqual(JSON.parse(got.body), { ...original, provider: ZDR_PROVIDER })
        const [, response, end] = policy.lines()
        assert.deepEqual(response, { id: request.id, at: '2026-11-09T15:50:00Z', event: 'response', status: 200, ms: 0 })
        assert.equal(end.id, request.id)
        assert.equal(end.event, 'end')
        assert.ok(end.sent > Buffer.byteLength(text), `sent ${end.sent}`)
        assert.ok(end.received > 11, `received ${end.received}`)
      })
    }
  }
})

test("policy: the allowlists are what the pinned pi sends, for every model of its catalog", () => {
  const catalog = loadFixture('catalog')
  for (const [route, { path, queries }] of Object.entries(ROUTES)) {
    const shapes = catalog.shapes.filter(shape => shape.path === path)
    assert.ok(shapes.length > 0)
    assert.deepEqual([...PI_FIELDS[route]].sort(), [...new Set(shapes.flatMap(shape => shape.fields))].sort(), route)
    assert.deepEqual([...PI_BETAS[route]].sort(), [...new Set(shapes.flatMap(shape => shape.beta))].sort(), route)
    for (const shape of shapes) assert.ok(queries.includes(shape.query), `${route} ${shape.query}`)
  }
  // Both routes ask for zero data retention, until OpenRouter says one can't.
  assert.deepEqual(ZDR_ROUTES, { messages: true, chat: true })
})

// ---------------------------------------------------------------------------------------------
// What is refused

const withTool = tool => body => body.tools.push(tool)
const userContent = content => body => body.messages.push({ role: 'user', content })

test('policy: each refusal answers 400 or 403, writes its reason in the log, and lets nothing out', async t => {
  const messages = modelOf('messages')
  const chat = modelOf('chat')
  const cases = [
    // The model.
    ['another model', () => piRequest('messages', 'first', body => (body.model = 'anthropic/claude-opus-5.5')), 400, "the model isn't the agent's"],
    ['an :online model', () => piRequest('chat', 'first', body => (body.model = `${chat}:online`)), 400, "the model isn't the agent's", { model: chat }],
    // Tools pi doesn't run itself.
    ['a tool on the chat route that is not a function', () => piRequest('chat', 'first', withTool({ type: 'openrouter:web_search' })), 400, 'a tool pi doesn\'t run itself: "openrouter:web_search"', { model: chat }],
    ['a server tool on the messages route', () => piRequest('messages', 'first', withTool({ type: 'web_search_20250305', name: 'web_search' })), 400, 'a tool pi doesn\'t run itself: "web_search_20250305"'],
    ["OpenRouter's fetch tool on the messages route", () => piRequest('messages', 'first', withTool({ type: 'openrouter:web_fetch' })), 400, 'a tool pi doesn\'t run itself: "openrouter:web_fetch"'],
    // Fields.
    ['plugins', () => piRequest('chat', 'first', body => (body.plugins = [{ id: 'web' }])), 400, 'plugins are not allowed', { model: chat }],
    ['mcp_servers', () => piRequest('messages', 'first', body => (body.mcp_servers = [{ type: 'url', url: 'https://example.com/mcp' }])), 400, 'mcp_servers is not allowed'],
    ['an unknown top-level field', () => piRequest('chat', 'first', body => (body.web_search_options = {})), 400, 'a field the pinned pi doesn\'t send: "web_search_options"', { model: chat }],
    ["a provider of pi's own", () => piRequest('messages', 'first', body => (body.provider = { zdr: false })), 400, 'a field the pinned pi doesn\'t send: "provider"'],
    // anthropic-beta.
    ['an unknown anthropic-beta value', () => piRequest('messages', 'first', (_body, headers) => (headers['anthropic-beta'] += ',web-fetch-2025-09-10')), 400, 'an anthropic-beta value the pinned pi doesn\'t send: "web-fetch-2025-09-10"'],
    ['an anthropic-beta value on the chat route', () => piRequest('chat', 'first', (_body, headers) => (headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14')), 400, 'an anthropic-beta value the pinned pi doesn\'t send: "interleaved-thinking-2025-05-14"', { model: chat }],
    // Media by URL.
    ['an image by URL on the chat route', () => piRequest('chat', 'first', userContent([{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }])), 400, 'an image given by URL', { model: chat }],
    ['an image by URL on the messages route', () => piRequest('messages', 'first', userContent([{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }])), 400, 'an image given by URL, or another way than inline'],
    [
      'an image by URL in a tool result',
      () => piRequest('messages', 'first', userContent([{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }])),
      400,
      'an image given by URL, or another way than inline',
    ],
    ['a document by URL on the messages route', () => piRequest('messages', 'first', userContent([{ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }])), 400, 'a document given by URL, or another way than inline'],
    ['a document by URL on the chat route', () => piRequest('chat', 'first', userContent([{ type: 'file', file: { filename: 'a.pdf', file_data: 'https://example.com/a.pdf' } }])), 400, 'a document given by URL, or another way than inline', { model: chat }],
    ['a kind of content pi doesn\'t send', () => piRequest('chat', 'first', userContent([{ type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } }])), 400, 'a kind of content pi doesn\'t send: "video_url"', { model: chat }],
    // The body.
    ['a body that is not JSON', () => new Request('https://openrouter.ai/api/v1/messages?beta=true', { method: 'POST', headers: { 'x-api-key': PLACEHOLDER }, body: '{"model":' }), 400, "the body isn't JSON"],
    ['a compressed body', () => piRequest('messages', 'first', (_body, headers) => (headers['content-encoding'] = 'gzip')), 400, "a compressed body, which the policy can't check"],
    // Other paths and methods on openrouter.ai.
    ['another path on openrouter.ai', () => new Request('https://openrouter.ai/api/v1/models/user', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }), 403, "not one of OpenRouter's two chat routes"],
    ['another method on a chat route', () => new Request('https://openrouter.ai/api/v1/chat/completions', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }), 403, "not one of OpenRouter's two chat routes"],
    ['another query string', () => new Request('https://openrouter.ai/api/v1/messages?beta=false', { method: 'POST', headers: { 'x-api-key': PLACEHOLDER }, body: '{}' }), 403, "not one of OpenRouter's two chat routes"],
    ['another port', () => new Request('https://openrouter.ai:8443/api/v1/chat/completions', { method: 'POST', body: '{}' }), 403, "not one of OpenRouter's two chat routes"],
    // Other hosts.
    ['another host with internet access off', () => new Request('https://example.com/'), 403, 'host not allowed'],
    ['plain HTTP with internet access on', () => new Request('http://example.com/'), 403, "plain HTTP isn't allowed", { internet: true }],
    ['plain HTTP to openrouter.ai', () => new Request('http://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }), 403, "plain HTTP isn't allowed"],
    ["another of OpenRouter's hosts, with internet access on", () => new Request('https://api.openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }), 403, 'host not allowed', { internet: true }],
    ["OpenRouter's name with a dot at the end, with internet access on", () => new Request('https://openrouter.ai./api/v1/chat/completions', { method: 'POST', body: '{}' }), 403, 'host not allowed', { internet: true }],
    ['a method HTTP has no capitals for', () => new Request('https://example.com/', { method: 'frob' }), 403, 'method not allowed', { internet: true }],
  ]
  for (const [name, make, status, reason, options = {}] of cases) {
    await t.test(name, async t => {
      const policy = await openPolicy(t, { model: messages, ...options })
      const request = make()
      const out = await policy.send(request)
      assert.ok(isRefusal(out), `${name} was let out`)
      assert.equal(out.status, status)
      // pi prints the policy's reason, in OpenRouter's shape.
      assert.deepEqual(await out.json(), { error: { message: `Scooter's network policy refused this request: ${reason}`, code: status } })
      const url = new URL(request.url)
      const lines = policy.lines()
      assert.equal(lines.length, 1, JSON.stringify(lines))
      const method = /^[A-Z]+$/.test(request.method) ? { method: request.method } : {}
      assert.deepEqual(lines[0], { at: '2026-11-09T15:50:00Z', event: 'refused', host: url.hostname, ...method, path: url.pathname, reason })
      assert.deepEqual(policy.received, [])
    })
  }
})

test('policy: a body over what the policy reads is refused', async t => {
  atEnd(t, overrideLimits({ MODEL_REQUEST_MAX_BYTES: 1000 }))
  const policy = await openPolicy(t)
  const out = await policy.send(piRequest('messages'))
  assert.equal(out.status, 400)
  assert.equal(policy.lines()[0].reason, 'the body is longer than the policy reads')
})

test("policy: the key goes only where pi sends it: a key of pi's own, the placeholder in another header or to another host, and the key itself, are refused", async t => {
  const own = `sk-or-v1-${'9'.repeat(64)}`
  const cases = [
    ["a key of pi's own on the messages route", () => piRequest('messages', 'first', (_body, headers) => (headers['x-api-key'] = own)), "the key isn't the placeholder, in the header pi sends it in"],
    ["a key of pi's own beside the placeholder", () => piRequest('messages', 'first', (_body, headers) => (headers.authorization = `Bearer ${own}`)), "the key is in a header pi doesn't send it in"],
    ['the placeholder in the other route\'s header', () => piRequest('chat', 'first', (_body, headers) => {
      delete headers.authorization
      headers['x-api-key'] = PLACEHOLDER
    }), "the key isn't the placeholder, in the header pi sends it in", { model: modelOf('chat') }],
    ['the placeholder in another header too', () => piRequest('messages', 'first', (_body, headers) => (headers['x-title'] = `Scooter ${PLACEHOLDER}`)), "the key's placeholder is in another header"],
    // As a redirect from OpenRouter would carry it, once Gondolin had put it in.
    ['the key itself, in another header', () => piRequest('messages', 'first', (_body, headers) => (headers['x-forwarded-key'] = KEY)), 'the request already holds a key'],
    ['the placeholder to another host', () => new Request('https://example.com/', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }), 'the key, and its placeholder, go only to openrouter.ai', { internet: true }],
    ['the key to another host', () => new Request('https://example.com/', { headers: { 'x-api-key': KEY } }), 'the key, and its placeholder, go only to openrouter.ai', { internet: true }],
  ]
  for (const [name, make, reason, options = {}] of cases) {
    await t.test(name, async t => {
      const policy = await openPolicy(t, options)
      const out = await policy.send(make())
      assert.ok(isRefusal(out), `${name} was let out`)
      assert.equal(out.status, 403)
      assert.equal(policy.lines()[0].reason, reason)
      assert.equal(policy.lines().length, 1)
    })
  }

  // Without the placeholder, a request to another host goes as it was, with no key.
  await t.test('another host, with internet access on', async t => {
    const policy = await openPolicy(t, { internet: true })
    const out = await policy.send(new Request('https://example.com/search?q=receipt', { headers: { accept: 'text/html' } }))
    assert.ok(!isRefusal(out))
    assert.equal(out.url, 'https://example.com/search?q=receipt')
    assert.ok(!JSON.stringify(Object.fromEntries(out.headers)).includes(KEY))
    assert.deepEqual({ ...policy.lines()[0], id: undefined }, { id: undefined, at: '2026-11-09T15:50:00Z', event: 'request', host: 'example.com', method: 'GET', path: '/search' })
  })
})

test("policy: a body with a duplicated key goes out only as the hook's own encoding", async t => {
  const policy = await openPolicy(t)
  const model = modelOf('messages')
  const body = JSON.stringify(loadFixture('messages').first.body)
  const request = text =>
    new Request('https://openrouter.ai/api/v1/messages?beta=true', {
      method: 'POST',
      headers: { 'x-api-key': PLACEHOLDER, 'anthropic-beta': PI_BETAS.messages[1], 'content-type': 'application/json' },
      body: text,
    })
  // JSON takes the last of two values. The check saw this one, and so does OpenRouter.
  const sneaky = `{"model":"anthropic/claude-opus-5.5",${body.slice(1)}`
  const out = await policy.send(request(sneaky))
  assert.ok(!isRefusal(out))
  const sent = await out.text()
  assert.notEqual(sent, sneaky)
  assert.ok(!sent.includes('claude-opus-5.5'))
  assert.equal(JSON.parse(sent).model, model)
  assert.equal(sent.match(/"model":/g).length, 1)
  // The other way round, the check sees the other model.
  const refused = await policy.send(request(`${body.slice(0, -1)},"model":"anthropic/claude-opus-5.5"}`))
  assert.equal(refused.status, 400)
})

test('policy: with OPENROUTER_ZDR on, every body forwarded asks for zero data retention, on both routes; with it off, routing is left alone', async t => {
  for (const zdr of [true, false]) {
    for (const route of ['messages', 'chat']) {
      await t.test(`${zdr ? 'on' : 'off'}, ${route}`, async t => {
        const policy = await openPolicy(t, { model: modelOf(route), zdr })
        const request = piRequest(route, 'last')
        const original = await request.clone().json()
        const out = await policy.send(request)
        const body = await out.json()
        if (zdr) assert.deepEqual(body, { ...original, provider: { zdr: true, data_collection: 'deny' } })
        else assert.deepEqual(body, original)
      })
    }
  }
})

test('policy: checking a body alone', () => {
  const model = modelOf('messages')
  const body = loadFixture('messages').last.body
  assert.equal(checkModelRequest({ route: 'messages', body, model }), null)
  assert.equal(checkModelRequest({ route: 'messages', body: [], model }), "the body isn't a JSON object")
  assert.equal(checkModelRequest({ route: 'messages', body: { ...body, messages: {} }, model }), 'messages is not a list')
  assert.equal(checkModelRequest({ route: 'messages', body: { ...body, tools: {} }, model }), 'tools is not a list')
  assert.equal(checkModelRequest({ route: 'messages', body: { ...body, system: [{ type: 'image', source: { type: 'url' } }] }, model }), 'an image given by URL, or another way than inline')
  // An inline image or document passes.
  const inline = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } },
  ]
  assert.equal(checkModelRequest({ route: 'messages', body: { ...body, messages: [...body.messages, { role: 'user', content: inline }] }, model }), null)
  const chat = loadFixture('chat').last.body
  const parts = [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AAAA' } },
    { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
  ]
  assert.equal(checkModelRequest({ route: 'chat', body: { ...chat, messages: [...chat.messages, { role: 'user', content: parts }] }, model: chat.model }), null)
  // A file with an ID of OpenRouter's, not inline.
  const byId = { type: 'file', file: { file_id: 'file-1', file_data: 'data:application/pdf;base64,AAAA' } }
  assert.equal(checkModelRequest({ route: 'chat', body: { ...chat, messages: [{ role: 'user', content: [byId] }] }, model: chat.model }), 'a document given by URL, or another way than inline')
})

// ---------------------------------------------------------------------------------------------
// The log

test('policy: the request line is written before the request goes out, and a streamed answer is not held back', async t => {
  let finish
  const finished = new Promise(resolve => (finish = resolve))
  const policy = await openPolicy(t, {
    async answer(_request, response) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: message_start\ndata: {}\n\n')
      await finished
      response.end('event: message_stop\ndata: {}\n\n')
    },
  })
  // No response hook: in Gondolin 0.14.0 one would hold back the whole answer.
  assert.equal(policy.options.onResponse, undefined)

  const out = await policy.send(piRequest('messages'))
  const answer = await policy.forward(out)
  // The upstream found the request's line already in the log when the request reached it.
  const [arrived] = policy.received
  assert.deepEqual(
    arrived.logged.map(line => line.event),
    ['request'],
  )
  // The status is in the log, and the first event reached the client, while the answer goes on.
  const reader = answer.body.getReader()
  const first = Buffer.from((await reader.read()).value).toString('utf8')
  assert.match(first, /message_start/)
  await waitFor(() => linesOf(policy, 'response').length === 1, 'the response line')
  assert.equal(linesOf(policy, 'response')[0].status, 200)
  assert.deepEqual(linesOf(policy, 'end'), [])
  finish()
  for (;;) if ((await reader.read()).done) break
  await waitFor(() => linesOf(policy, 'end').length === 1, 'the end line')
  assert.equal(linesOf(policy, 'end')[0].reason, undefined)
})

test('policy: what came of each request: an upstream that refuses the connection, one never sent, and one the end of the run cut short', async t => {
  let release
  const policy = await openPolicy(t, {
    internet: true,
    async answer(_request, response) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('part')
      await new Promise(resolve => (release = resolve))
      response.end()
    },
  })
  atEnd(t, () => release?.())

  // The upstream refuses the connection: no answer.
  const port = await closedPort()
  const one = await policy.send(new Request('https://example.com/one'))
  await assert.rejects(fetch(`http://127.0.0.1:${port}/one`, { headers: one.headers }))
  await waitFor(() => linesOf(policy, 'error').length === 1, 'the error line')
  const [request] = linesOf(policy, 'request')
  assert.deepEqual(linesOf(policy, 'error'), [{ id: request.id, at: '2026-11-09T15:50:00Z', event: 'error', reason: 'ECONNREFUSED', ms: 0 }])

  // Let out, and never made: Gondolin couldn't resolve its host, say.
  await policy.send(new Request('https://example.com/two'))
  // Its answer begun, and the run over before its end.
  const answer = await policy.forward(await policy.send(new Request('https://example.com/three')))
  assert.equal(answer.status, 200)
  await waitFor(() => linesOf(policy, 'response').length === 1, 'the response line')

  policy.close()
  const [, two, three] = linesOf(policy, 'request')
  assert.deepEqual(
    policy.lines().filter(line => line.id === two.id).map(line => line.event === 'error' && line.reason),
    [false, 'not_sent'],
  )
  const ended = linesOf(policy, 'end').find(line => line.id === three.id)
  assert.equal(ended.reason, 'run_ended')
  // Nothing is written for a run's network once it is closed.
  release()
  await answer.text().catch(() => {})
  await sleep(50)
  assert.equal(policy.lines().filter(line => line.id === three.id).length, 3)
})

test('policy: what one run adds to the log is bounded: requests past RUN_REQUESTS_MAX are refused, and refusals past RUN_REFUSALS_LOGGED_MAX counted', async t => {
  atEnd(t, overrideLimits({ RUN_REQUESTS_MAX: 2, RUN_REFUSALS_LOGGED_MAX: 3 }))
  const policy = await openPolicy(t, { internet: true })
  for (const n of [1, 2]) assert.ok(!isRefusal(await policy.send(new Request(`https://example.com/${n}`))))
  const third = await policy.send(new Request('https://example.com/3'))
  assert.equal(third.status, 403)
  for (let n = 0; n < 5; n++) assert.equal((await policy.send(new Request(`http://example.com/${n}`))).status, 403)
  assert.deepEqual(
    policy.lines().map(line => line.event),
    ['request', 'request', 'refused', 'refused', 'refused'],
  )
  assert.equal(linesOf(policy, 'refused')[0].reason, 'this run has made all the requests a run may')
  policy.close()
  assert.deepEqual(policy.lines().at(-1), { at: '2026-11-09T15:50:00Z', event: 'unlogged', refused: 3 })
})

test('policy: requests read at the same time count against RUN_REQUESTS_MAX as they come, and one refused gives its place back', async t => {
  atEnd(t, overrideLimits({ RUN_REQUESTS_MAX: 2 }))
  const policy = await openPolicy(t)
  // A request the policy refuses for its body takes no place.
  assert.equal((await policy.send(piRequest('messages', 'first', body => (body.plugins = [])))).status, 400)
  // Eight sent at once, each with a body to read: two go out.
  const results = await Promise.all(Array.from({ length: 8 }, () => policy.send(piRequest('messages'))))
  assert.equal(results.filter(result => !isRefusal(result)).length, 2)
  assert.deepEqual(
    results.filter(isRefusal).map(result => result.status),
    Array(6).fill(403),
  )
  assert.equal(linesOf(policy, 'request').length, 2)
  assert.deepEqual(
    linesOf(policy, 'refused').map(line => line.reason),
    ['plugins are not allowed', ...Array(6).fill('this run has made all the requests a run may')],
  )
})

test("policy: once the hook lets a request out, Gondolin connects only to a public address for it, whatever the name resolves to", async t => {
  const at = (hostname, ip) => ({ hostname, ip, family: ip.includes(':') ? 6 : 4, port: 443, protocol: 'https' })
  const PRIVATE = ['127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']
  const on = await openPolicy(t, { internet: true })
  for (const ip of PRIVATE) {
    assert.equal(await on.isIpAllowed(at('example.com', ip)), false, ip)
    assert.equal(await on.isIpAllowed(at('openrouter.ai', ip)), false, ip)
  }
  assert.equal(await on.isIpAllowed(at('example.com', '93.184.215.14')), true)
  assert.equal(await on.isIpAllowed(at('openrouter.ai', '104.18.2.115')), true)
  // With internet access off, no host but openrouter.ai, at any address.
  const off = await openPolicy(t)
  assert.equal(await off.isIpAllowed(at('example.com', '93.184.215.14')), false)
  assert.equal(await off.isIpAllowed(at('openrouter.ai', '104.18.2.115')), true)
  assert.equal(await off.isIpAllowed(at('openrouter.ai', '10.0.0.5')), false)
})

test('policy: a line keeps a bounded path, and a host and a reason a reader takes, whatever the VM sent', async t => {
  const policy = await openPolicy(t, { internet: true })
  const long = `/${'a'.repeat(5000)}/b`
  await policy.send(new Request(`https://example.com${long}?token=secret`))
  await policy.send(new Request('https://a!b_c.example.com/x'))
  const field = `odd\u200B${'f'.repeat(1000)}`
  await policy.send(piRequest('messages', 'first', body => (body[field] = 1)))
  const [request, odd, refused] = policy.lines()
  assert.equal(request.path, `/${'a'.repeat(limits.NETLOG_PATH_MAX_CHARS - 1)}…`)
  assert.equal(odd.host, 'a%21b_c.example.com')
  assert.equal([...refused.reason].length, limits.REASON_MAX_CHARS)
  assert.ok(refused.reason.startsWith('a field the pinned pi doesn\'t send: "odd?fff'))
  assert.doesNotMatch(refused.reason, /\p{C}/u)
  for (const line of policy.lines()) assert.ok(Buffer.byteLength(JSON.stringify(line)) < limits.NETLOG_LINE_MAX_BYTES)
  assert.doesNotMatch(JSON.stringify(policy.lines()), /secret|token/)
})

test("policy: Gondolin's own HTTP client says what came of a request, and takes the policy's header out before it goes", async t => {
  const policy = await openPolicy(t, { internet: true })
  const out = await policy.send(new Request('https://example.com/page', { method: 'POST', body: 'x'.repeat(1000) }))
  // A header of the VM's own with the policy's name is replaced, not passed on.
  assert.ok(!isRefusal(out))
  const answer = await policy.forward(out, { fetch: gondolinFetch })
  assert.equal(await answer.text(), '{"ok":true}')
  await waitFor(() => linesOf(policy, 'end').length === 1, 'the end line')
  assert.equal(policy.received[0].headers[MARKER_HEADER], undefined)
  assert.equal(policy.received[0].body.length, 1000)
  const [request, response, end] = policy.lines()
  assert.deepEqual([response.id, end.id], [request.id, request.id])
  assert.equal(response.status, 200)
  assert.ok(end.sent > 1000 && end.received > 0, JSON.stringify(end))
})

test("policy: a header with the policy's name, sent by the VM, doesn't name another request", async t => {
  const policy = await openPolicy(t, { internet: true })
  const first = await policy.send(new Request('https://example.com/1'))
  const forged = await policy.send(new Request('https://example.com/2', { headers: { [MARKER_HEADER]: first.headers.get(MARKER_HEADER) } }))
  assert.notEqual(forged.headers.get(MARKER_HEADER), first.headers.get(MARKER_HEADER))
  const [one, two] = linesOf(policy, 'request')
  assert.equal(forged.headers.get(MARKER_HEADER), two.id)
  assert.notEqual(one.id, two.id)
})

// A port nothing listens on.
function closedPort() {
  return new Promise(resolve => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}
