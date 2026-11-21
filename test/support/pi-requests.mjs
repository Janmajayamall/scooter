// What the pinned pi sends to OpenRouter, as fixtures.
//
// The network policy lets through only requests shaped like pi's own,
// so the shape is recorded from the real pi and kept:
//
//   test/fixtures/pi-requests/messages.json   one session on the messages route
//   test/fixtures/pi-requests/chat.json       the same session on the chat completions route
//   test/fixtures/pi-requests/catalog.json    one request for every model pi knows on OpenRouter
//
// `test/tools/capture-pi-requests.mjs` writes them, with `pi-capture.mjs`. This file reads them and
// says what the shape of a request is. It needs no VM.

import fs from 'node:fs'

export const FIXTURES = new URL('../fixtures/pi-requests/', import.meta.url)

// The parts of a request that the network policy has rules about, without its contents.
export function shapeOf(request) {
  const { body } = request
  const shape = {
    method: request.method,
    path: request.path,
    query: request.query,
    headers: Object.keys(request.headers).sort(),
    beta: betaValues(request),
    fields: Object.keys(body).sort(),
    tools: unique((body.tools ?? []).map(toolShape)),
    messages: {},
  }
  if (body.system !== undefined) shape.system = contentShape(body.system)
  for (const message of body.messages) {
    const seen = (shape.messages[message.role] ??= { fields: [], content: [] })
    seen.fields = unique([...seen.fields, ...Object.keys(message)])
    seen.content = unique([...seen.content, ...contentShape(message.content)])
  }
  return shape
}

export function betaValues(request) {
  return (request.headers['anthropic-beta'] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .sort()
}

function unique(values) {
  return [...new Set(values)].sort()
}

// A tool definition: its fields, and its type when it has one.
function toolShape(tool) {
  const fields = Object.keys(tool).sort().join(',')
  return tool.type === undefined ? fields : `${fields} (type: ${tool.type})`
}

// The kinds of content in a message: `string`, or the type of each part. An image also says how
// it is carried, and a tool result says what it holds.
function contentShape(content) {
  if (content === undefined || content === null) return []
  if (typeof content === 'string') return ['string']
  const kinds = []
  for (const part of content) {
    if (part.type === 'image' || part.type === 'document') kinds.push(`${part.type} (${part.source?.type})`)
    else if (part.type === 'image_url') kinds.push(`image_url (${isDataUrl(part.image_url?.url) ? 'data URL' : 'other URL'})`)
    else if (part.type === 'tool_result') kinds.push(...contentShape(part.content).map(kind => `tool_result: ${kind}`))
    else kinds.push(part.type)
  }
  return unique(kinds)
}

function isDataUrl(url) {
  return typeof url === 'string' && url.startsWith('data:')
}

export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))
}

export function saveFixture(name, fixture) {
  fs.mkdirSync(FIXTURES, { recursive: true })
  fs.writeFileSync(new URL(`${name}.json`, FIXTURES), `${JSON.stringify(fixture, null, 2)}\n`)
}
