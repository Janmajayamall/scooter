// A scripted fake model.
//
// It stands in for the model behind OpenRouter in tests that run the real pi. A test gives it a
// script, one step for each request pi will make, and calls `handle` from the VM's request hook.
// The fake answers there, inside the test's own process, so nothing leaves the machine: pi runs a
// whole session, tool calls included, with no key and no network.
//
// It knows nothing about Gondolin or the network policy. It takes a standard `Request` and returns
// a standard `Response`, so it can also serve as the upstream in the policy's tests.
//
// A step is one of:
//   { tool: 'write', args: { path: 'views/a.csv', content: 'x' } }   the model calls one of pi's tools
//   { text: 'Filed it.' }                                            the model's last message, which ends the run
//   { status: 401, message: 'User not found.' }                      OpenRouter refuses the request
// A tool step may also carry `text`, which the model says before the call. A tool or text step may
// carry `thinking: '…'`, sent ahead of everything else, the way a reasoning model does.
// A step can be a function of the recorded request, returning one of the above.
//
// When pi makes more requests than the script has steps, the last step is repeated. End a script
// with a text step, so a run that goes further than expected still stops.

export const OPENROUTER_HOST = 'openrouter.ai'
export const MESSAGES_PATH = '/api/v1/messages'
export const CHAT_PATH = '/api/v1/chat/completions'

const ROUTES = { [MESSAGES_PATH]: 'messages', [CHAT_PATH]: 'chat' }

// The fake stamps its answers with this instead of the clock, so they are the same on every run.
const CREATED = 1_800_000_000

export function createFakeModel(script) {
  if (!Array.isArray(script) || script.length === 0) {
    throw new Error('the fake model needs a script with at least one step')
  }

  // Every request that reached the fake, in order, whatever its host or path.
  const requests = []
  let turn = 0

  async function handle(request) {
    const url = new URL(request.url)
    const text = await request.text()
    const recorded = {
      method: request.method,
      host: url.hostname,
      path: url.pathname,
      query: url.search,
      headers: Object.fromEntries(request.headers),
      body: parseJson(text),
      route: null,
    }
    requests.push(recorded)

    const route = url.hostname === OPENROUTER_HOST && request.method === 'POST' ? ROUTES[url.pathname] : undefined
    if (!route) {
      const message = `fake model: no route for ${request.method} ${url.hostname}${url.pathname}`
      return json(404, { error: { message, code: 404 } })
    }
    recorded.route = route
    if (recorded.body === undefined || typeof recorded.body !== 'object' || recorded.body === null) {
      return json(400, { error: { message: 'fake model: the body is not a JSON object', code: 400 } })
    }
    if (recorded.body.stream !== true) {
      return json(400, { error: { message: 'fake model: only streamed requests are scripted', code: 400 } })
    }

    const index = turn++
    let step = script[Math.min(index, script.length - 1)]
    if (typeof step === 'function') step = step(recorded, index)

    if (step.status) return refusal(route, step)
    if (route === 'messages') return messagesAnswer(recorded.body.model, index, step)
    return chatAnswer(recorded.body.model, index, step)
  }

  return {
    handle,
    requests,
    // The requests on the two model routes only.
    get modelRequests() {
      return requests.filter(request => request.route)
    },
  }
}

function parseJson(text) {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// OpenRouter's error bodies, in the shape each route uses. The two for 401 are what OpenRouter
// answered a well-formed key it didn't know on 2026-11-16. For other statuses only the outline is
// OpenRouter's.
function refusal(route, step) {
  const message = step.message ?? `fake model: status ${step.status}`
  if (route === 'messages') {
    const unknownKey = { type: 'authentication_error', message, error_type: 'authentication' }
    const error = step.status === 401 ? unknownKey : { type: 'api_error', message }
    return json(step.status, { type: 'error', error, request_id: null })
  }
  return json(step.status, { error: { message, code: step.status } })
}

function eventStream(text) {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

// POST /api/v1/messages: Anthropic's streaming events.
function messagesAnswer(model, index, step) {
  const events = []
  const add = (type, data) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  let block = 0

  add('message_start', {
    message: {
      id: `msg_fake_${index}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  })
  if (step.thinking) {
    add('content_block_start', { index: block, content_block: { type: 'thinking', thinking: '', signature: '' } })
    add('content_block_delta', { index: block, delta: { type: 'thinking_delta', thinking: step.thinking } })
    add('content_block_delta', { index: block, delta: { type: 'signature_delta', signature: fakeSignature(index) } })
    add('content_block_stop', { index: block })
    block++
  }
  if (step.tool) {
    if (step.text) {
      add('content_block_start', { index: block, content_block: { type: 'text', text: '' } })
      add('content_block_delta', { index: block, delta: { type: 'text_delta', text: step.text } })
      add('content_block_stop', { index: block })
      block++
    }
    add('content_block_start', {
      index: block,
      content_block: { type: 'tool_use', id: `toolu_fake_${index}`, name: step.tool, input: {} },
    })
    const input = JSON.stringify(step.args ?? {})
    add('content_block_delta', { index: block, delta: { type: 'input_json_delta', partial_json: input } })
    add('content_block_stop', { index: block })
    add('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
  } else {
    add('content_block_start', { index: block, content_block: { type: 'text', text: '' } })
    add('content_block_delta', { index: block, delta: { type: 'text_delta', text: step.text ?? '' } })
    add('content_block_stop', { index: block })
    add('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
  }
  add('message_stop', {})
  return eventStream(events.join(''))
}

// POST /api/v1/chat/completions: OpenAI's streaming chunks, as OpenRouter sends them.
function chatAnswer(model, index, step) {
  const base = { id: `gen-fake-${index}`, object: 'chat.completion.chunk', created: CREATED, model, provider: 'fake' }
  const chunks = []
  const add = (delta, finish = null) => chunks.push({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })

  if (step.thinking) add({ role: 'assistant', content: '', reasoning: step.thinking })
  if (step.tool) {
    add({
      role: 'assistant',
      content: step.text ?? '',
      tool_calls: [
        {
          index: 0,
          id: `call_fake_${index}`,
          type: 'function',
          function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) },
        },
      ],
    })
    add({}, 'tool_calls')
  } else {
    add({ role: 'assistant', content: step.text ?? '' })
    add({}, 'stop')
  }
  chunks.push({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })

  return eventStream(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
}

// Anthropic signs its thinking blocks. pi sends the signature back untouched, so any text will do.
function fakeSignature(index) {
  return Buffer.from(`fake-signature-${index}`).toString('base64')
}
