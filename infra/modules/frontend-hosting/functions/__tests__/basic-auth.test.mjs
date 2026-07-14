import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Imports the REAL deployed source (../basic-auth.js); the registered loader
// hook virtualizes its `cloudfront` import and appends `export { handler }`.
const { handler } = await import('../basic-auth.js')

const EXPECTED = 'Basic bXl0aHJ1bjpzM2NyZXQ=' // base64('mythrun:s3cret'); test-only

beforeEach(() => {
  globalThis.__CF_KVS_STATE__ = { 'staging-basic-auth': EXPECTED }
})

// Every real CloudFront event carries a uri; the pass-through path reads it
// for SPA deep-link routing, so the fixture must too (the test went stale
// when basic-auth.js absorbed the SPA-routing rewrite).
const reqWith = (auth, uri = '/') => ({
  request: { uri, headers: auth ? { authorization: { value: auth } } : {} },
})

test('missing Authorization header -> 401 fail-closed', async () => {
  const r = await handler(reqWith(undefined))
  assert.equal(r.statusCode, 401)
  assert.equal(r.statusDescription, 'Unauthorized')
  assert.equal(r.headers['www-authenticate'].value, 'Basic realm="Mythrun staging"')
})

test('mismatched credential -> 401', async () => {
  const r = await handler(reqWith('Basic d3Jvbmc='))
  assert.equal(r.statusCode, 401)
})

test('KVS read throws -> 401 fail-closed', async () => {
  globalThis.__CF_KVS_STATE__ = { throw: true }
  const r = await handler(reqWith(EXPECTED))
  assert.equal(r.statusCode, 401)
})

test('key unset -> 401 fail-closed', async () => {
  globalThis.__CF_KVS_STATE__ = {}
  const r = await handler(reqWith(EXPECTED))
  assert.equal(r.statusCode, 401)
})

test('exact match -> pass through (returns the request object)', async () => {
  const ev = reqWith(EXPECTED, '/assets/app.js')
  const r = await handler(ev)
  assert.equal(r, ev.request)
})

test('exact match + extensionless path -> SPA shell rewrite', async () => {
  const ev = reqWith(EXPECTED, '/campaigns/some-id')
  const r = await handler(ev)
  assert.equal(r, ev.request)
  assert.equal(r.uri, '/index.html')
})

test('exact match + asset path (has extension) -> uri untouched', async () => {
  const ev = reqWith(EXPECTED, '/assets/app.js')
  const r = await handler(ev)
  assert.equal(r.uri, '/assets/app.js')
})

test('exact match + root -> SPA shell rewrite', async () => {
  const ev = reqWith(EXPECTED, '/')
  const r = await handler(ev)
  assert.equal(r.uri, '/index.html')
})
