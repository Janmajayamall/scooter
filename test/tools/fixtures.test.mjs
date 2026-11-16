// The saved requests in test/fixtures/pi-requests/ hang together, and belong to the pi version
// that the image's build file pins. This needs no VM, so it also fails on a machine without one
// when pi's version is changed and the requests aren't captured again.

import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_PATH, MESSAGES_PATH } from '../support/fake-model.mjs'
import { pinnedPiVersion } from '../support/image.mjs'
import { loadFixture, shapeOf } from '../support/pi-requests.mjs'

const ROUTES = { messages: MESSAGES_PATH, chat: CHAT_PATH }
const catalog = loadFixture('catalog')

test('pi requests: every fixture was captured from the pinned pi', () => {
  for (const name of ['messages', 'chat', 'catalog']) {
    const hint = `${name}.json is from another pi version: run test/tools/capture-pi-requests.mjs`
    assert.equal(loadFixture(name).pi, pinnedPiVersion(), hint)
  }
})

for (const [route, path] of Object.entries(ROUTES)) {
  test(`pi requests: the ${route} session`, () => {
    const fixture = loadFixture(route)
    assert.ok(fixture.shapes.length > 1)

    // The two requests kept whole are the first and the last of the session.
    assert.deepEqual(shapeOf(fixture.first), fixture.shapes[0])
    assert.deepEqual(shapeOf(fixture.last), fixture.shapes.at(-1))
    assert.equal(fixture.first.body.model, fixture.model)

    for (const shape of fixture.shapes) {
      assert.equal(shape.method, 'POST')
      assert.equal(shape.path, path)
      // The catalog knows this model with these fields and these anthropic-beta values.
      const known = catalog.shapes.find(
        entry =>
          entry.path === shape.path &&
          entry.query === shape.query &&
          JSON.stringify(entry.fields) === JSON.stringify(shape.fields) &&
          JSON.stringify(entry.beta) === JSON.stringify(shape.beta) &&
          Object.values(entry.models).some(models => models.includes(fixture.model)),
      )
      assert.ok(known, `the catalog has no entry for ${fixture.model} with fields ${shape.fields} and beta ${shape.beta}`)
    }

    // The key travels as Gondolin's placeholder, and the fixture names the header it is in.
    for (const request of [fixture.first, fixture.last]) {
      const carriers = Object.entries(request.headers).filter(([, value]) => value.includes('<placeholder>'))
      assert.deepEqual(
        carriers.map(([name]) => name),
        [route === 'messages' ? 'x-api-key' : 'authorization'],
      )
      assert.ok(!JSON.stringify(request).includes('sk-or-'))
    }
  })
}

test('pi requests: the catalog covers both routes and nothing else', () => {
  const routes = catalog.shapes.map(shape => `${shape.method} ${shape.host}${shape.path}${shape.query}`)
  assert.deepEqual([...new Set(routes)].sort(), [
    `POST openrouter.ai${CHAT_PATH}`,
    `POST openrouter.ai${MESSAGES_PATH}?beta=true`,
  ])
  // Every model was asked at every level, and each time made exactly one request.
  for (const thinking of catalog.thinking) {
    const asked = catalog.shapes.flatMap(shape => shape.models[thinking] ?? [])
    assert.equal(asked.length, catalog.models)
    assert.equal(new Set(asked).size, catalog.models)
  }
})
