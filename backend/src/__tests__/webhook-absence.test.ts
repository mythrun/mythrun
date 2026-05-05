import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { buildApp } from '../app.js'
import { makeStubDeps } from './helpers/stub-deps.js'

// Per MYT-41 spec §5a: STRIPE_WEBHOOK_SECRET = 'PLACEHOLDER' is fail-closed
// only because no code path consumes it. The /webhooks/stripe route MUST
// NOT exist until MYT-42 lands the verifying handler. This test fails
// loudly if any future PR registers the route prematurely (e.g., a
// logging stub, a smoke handler, a permissive catch-all that shadows
// /webhooks/stripe).
//
// MYT-42 deletes this test as part of landing the real handler.

describe('webhook route absence (MYT-41 → MYT-42 invariant)', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    vi.unstubAllEnvs()
  })

  it('POST /webhooks/stripe returns 404 (no route registered, no catch-all swallows it)', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, { frontendBaseUrl: 'http://localhost:5173' })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
  })
})
