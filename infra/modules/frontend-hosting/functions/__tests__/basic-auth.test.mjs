import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Imports the REAL deployed source (../basic-auth.js); the registered loader
// hook virtualizes its `cloudfront` import and appends `export { handler }`.
const { handler } = await import('../basic-auth.js');

const EXPECTED = 'Basic bXl0aHJ1bjpzM2NyZXQ='; // base64('mythrun:s3cret'); test-only

beforeEach(() => {
  globalThis.__CF_KVS_STATE__ = { 'staging-basic-auth': EXPECTED };
});

const reqWith = (auth) => ({
  request: { headers: auth ? { authorization: { value: auth } } : {} },
});

test('missing Authorization header -> 401 fail-closed', async () => {
  const r = await handler(reqWith(undefined));
  assert.equal(r.statusCode, 401);
  assert.equal(r.statusDescription, 'Unauthorized');
  assert.equal(r.headers['www-authenticate'].value, 'Basic realm="Mythrun staging"');
});

test('mismatched credential -> 401', async () => {
  const r = await handler(reqWith('Basic d3Jvbmc='));
  assert.equal(r.statusCode, 401);
});

test('KVS read throws -> 401 fail-closed', async () => {
  globalThis.__CF_KVS_STATE__ = { throw: true };
  const r = await handler(reqWith(EXPECTED));
  assert.equal(r.statusCode, 401);
});

test('key unset -> 401 fail-closed', async () => {
  globalThis.__CF_KVS_STATE__ = {};
  const r = await handler(reqWith(EXPECTED));
  assert.equal(r.statusCode, 401);
});

test('exact match -> pass through (returns the request object)', async () => {
  const ev = reqWith(EXPECTED);
  const r = await handler(ev);
  assert.equal(r, ev.request);
});
