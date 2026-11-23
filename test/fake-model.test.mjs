// The scripted fake model answers the way OpenRouter does on both routes. This test needs no VM:
// it reads the fake's answers the way a client would.

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_PATH, MESSAGES_PATH, OPENROUTER_HOST, createFakeModel } from './support/fake-model.mjs'

function post(path, body, headers = {}) {
  return new Request(`https://${OPENROUTER_HOST}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

// The events of a streamed answer, as [event name, data] pairs. The chat route names no events.
async function eventsOf(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  return (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map(event => {
      const lines = event.split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)])
      const fields = Object.fromEntries(lines)
      return [fields.event, fields.data === '[DONE]' ? '[DONE]' : JSON.parse(fields.data)]
    })
}

test('fake model: a tool call and an answer on the messages route', async () => {
  const model = createFakeModel([{ thinking: 'hm', text: 'Looking.', tool: 'read', args: { path: '/a' } }, { text: 'Filed it.' }])
  const body = { model: 'anthropic/claude-sonnet-5.5', stream: true, messages: [] }

  const first = await eventsOf(await model.handle(post(`${MESSAGES_PATH}?beta=true`, body, { 'x-api-key': 'placeholder' })))
  assert.deepEqual(
    first.map(([name]) => name),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  const blocks = first.filter(([name]) => name === 'content_block_start').map(([, data]) => data.content_block.type)
  assert.deepEqual(blocks, ['thinking', 'text', 'tool_use'])
  const call = first.find(([, data]) => data.delta?.type === 'input_json_delta')[1]
  assert.deepEqual(JSON.parse(call.delta.partial_json), { path: '/a' })
  assert.equal(first.find(([name]) => name === 'message_delta')[1].delta.stop_reason, 'tool_use')
  assert.equal(first[0][1].message.model, body.model)

  const second = await eventsOf(await model.handle(post(MESSAGES_PATH, body)))
  assert.equal(second.find(([, data]) => data.delta?.type === 'text_delta')[1].delta.text, 'Filed it.')
  assert.equal(second.find(([name]) => name === 'message_delta')[1].delta.stop_reason, 'end_turn')

  // Every request is kept for the test to look at, with its headers and its parsed body.
  assert.equal(model.requests.length, 2)
  assert.deepEqual(
    model.requests.map(request => [request.method, request.host, request.path, request.query, request.route]),
    [
      ['POST', OPENROUTER_HOST, MESSAGES_PATH, '?beta=true', 'messages'],
      ['POST', OPENROUTER_HOST, MESSAGES_PATH, '', 'messages'],
    ],
  )
  assert.equal(model.requests[0].headers['x-api-key'], 'placeholder')
  assert.deepEqual(model.requests[0].body, body)
})

test('fake model: a tool call and an answer on the chat completions route', async () => {
  const model = createFakeModel([{ thinking: 'hm', tool: 'bash', args: { command: 'ls' } }, { text: 'Filed it.' }])
  const body = { model: 'google/gemini-2.5-flash', stream: true, messages: [] }

  const first = await eventsOf(await model.handle(post(CHAT_PATH, body)))
  assert.equal(first.at(-1)[1], '[DONE]')
  const deltas = first.slice(0, -1).map(([, chunk]) => chunk.choices[0])
  assert.equal(deltas[0].delta.reasoning, 'hm')
  assert.deepEqual(deltas[1].delta.tool_calls[0].function, { name: 'bash', arguments: '{"command":"ls"}' })
  assert.equal(deltas[2].finish_reason, 'tool_calls')
  assert.deepEqual(first.at(-2)[1].choices, [])
  assert.ok(first.at(-2)[1].usage)

  const second = await eventsOf(await model.handle(post(CHAT_PATH, body)))
  assert.equal(second[0][1].choices[0].delta.content, 'Filed it.')
  assert.equal(second[1][1].choices[0].finish_reason, 'stop')
})

test("fake model: a refusal has OpenRouter's status and error body", async () => {
  const model = createFakeModel([{ status: 401, message: 'User not found.' }])
  const body = { model: 'm', stream: true, messages: [] }

  const messages = await model.handle(post(MESSAGES_PATH, body))
  assert.equal(messages.status, 401)
  assert.deepEqual(await messages.json(), {
    type: 'error',
    error: { type: 'authentication_error', message: 'User not found.', error_type: 'authentication' },
    request_id: null,
  })

  const chat = await model.handle(post(CHAT_PATH, body))
  assert.equal(chat.status, 401)
  assert.deepEqual(await chat.json(), { error: { message: 'User not found.', code: 401 } })
})

test('fake model: the last step repeats, and a step can be a function of the request', async () => {
  const model = createFakeModel([{ tool: 'ls', args: {} }, (request, index) => ({ text: `request ${index} for ${request.body.model}` })])
  const body = { model: 'm', stream: true, messages: [] }
  await model.handle(post(CHAT_PATH, body))
  for (const index of [1, 2]) {
    const events = await eventsOf(await model.handle(post(CHAT_PATH, body)))
    assert.equal(events[0][1].choices[0].delta.content, `request ${index} for m`)
  }
})

test('fake model: anything but a model request gets a 404, and is still recorded', async () => {
  const model = createFakeModel([{ text: 'Filed it.' }])
  const elsewhere = [
    new Request(`https://${OPENROUTER_HOST}/api/v1/models/user`),
    new Request(`https://${OPENROUTER_HOST}${CHAT_PATH}`),
    new Request(`https://example.com${CHAT_PATH}`, { method: 'POST', body: '{}' }),
  ]
  for (const request of elsewhere) assert.equal((await model.handle(request)).status, 404)
  assert.equal(model.requests.length, 3)
  assert.deepEqual(model.modelRequests, [])
  assert.deepEqual(
    model.requests.map(request => `${request.method} ${request.host}${request.path}`),
    [`GET ${OPENROUTER_HOST}/api/v1/models/user`, `GET ${OPENROUTER_HOST}${CHAT_PATH}`, `POST example.com${CHAT_PATH}`],
  )

  // The script is for streamed requests, which is all pi makes.
  const plain = await model.handle(post(CHAT_PATH, { model: 'm', messages: [] }))
  assert.equal(plain.status, 400)
})

test('fake model: a script needs at least one step', () => {
  assert.throws(() => createFakeModel([]), /at least one step/)
})
