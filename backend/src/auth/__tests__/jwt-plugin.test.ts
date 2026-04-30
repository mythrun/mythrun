import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock aws-jwt-verify with a controllable stub. The stub's verify/hydrate
// are configured per-test via getters on the mock module.
const mockVerify = vi.fn()
const mockHydrate = vi.fn()
vi.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: () => ({
      verify: mockVerify,
      hydrate: mockHydrate,
    }),
  },
}))

import { jwtPlugin } from '../jwt-plugin.js'

const VALID_PAYLOAD = {
  sub: 'a1b2c3-d4e5-6789',
  username: 'Google_117992928105490108417',
  scope: 'openid email profile',
  token_use: 'access',
}

const OPTS = {
  userPoolId: 'us-east-1_TestPool',
  appClientId: 'testclient123',
}

describe('jwtPlugin', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    app = undefined
    mockVerify.mockReset()
    mockHydrate.mockReset()
    mockHydrate.mockResolvedValue(undefined)
  })
  afterEach(async () => {
    // Defensive: restore real timers in case a test using fake timers
    // failed before reaching its `vi.useRealTimers()` call. Without this
    // guard, fake timers leak forward and the next test's plugin-level
    // 0-1s jitter setTimeout never resolves, hanging the suite.
    vi.useRealTimers()
    if (app) await app.close()
  })

  it('hydrates JWKS at registration', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    expect(mockHydrate).toHaveBeenCalledOnce()
  })

  it('throws on hydrate failure → boot fails loudly', async () => {
    mockHydrate.mockRejectedValue(new Error('JWKS unreachable'))
    app = Fastify({ logger: false })
    await expect(app.register(jwtPlugin, OPTS)).rejects.toThrow(/JWKS unreachable/)
  })

  it('throws on hydrate timeout', async () => {
    vi.useFakeTimers()
    mockHydrate.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves — simulates JWKS endpoint hang */
        }),
    )
    // pluginTimeout > 10s so Fastify's own plugin-load timeout doesn't
    // win the race against the internal 10s timeout under test. Jitter
    // (0-1s) + 10s internal timeout = up to 11s; pluginTimeout: 30_000
    // gives generous headroom and still bounds against the never-resolving
    // hydrate impl.
    app = Fastify({ logger: false, pluginTimeout: 30_000 })
    // app.register() returns the Fastify instance (a thenable, not a real
    // Promise — no .catch). Wrap into a real Promise so we can both attach
    // a defensive no-op rejection handler (avoiding unhandled-rejection
    // races during the timer advances) and consume the rejection below.
    const registerPromise = Promise.resolve(app.register(jwtPlugin, OPTS))
    registerPromise.catch(() => {
      /* defensive: rejection consumed below via expect.rejects */
    })
    // Two-phase advance: phase 1 drains the 0-1s jitter setTimeout AND the
    // microtasks that queue the 10s timeout setTimeout *after* the jitter
    // resolves. Phase 2 advances past the 10s timeout. Without phase 1
    // first, vi.advanceTimersByTimeAsync(11_000) only drains the timers
    // that exist at advance start (the jitter), and the 10s timeout —
    // scheduled inside the post-jitter microtask — never fires.
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(registerPromise).rejects.toThrow(/timed out after 10s/)
    vi.useRealTimers()
  })

  it('rejects double registration', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    await expect(app.register(jwtPlugin, OPTS)).rejects.toThrow(/already registered/)
  })

  it('attaches request.user on valid token', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    let attachedUser: unknown
    app.get('/protected', (request) => {
      attachedUser = request.user
      return { ok: true }
    })

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer valid-token' },
    })
    expect(res.statusCode).toBe(200)
    expect(attachedUser).toEqual({
      sub: VALID_PAYLOAD.sub,
      cognitoUsername: VALID_PAYLOAD.username,
      scopes: ['openid', 'email', 'profile'],
    })
  })

  it('encapsulation contract: hook applies to PARENT-scope routes (fastify-plugin wrapper test)', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    // Register a NEW route on the parent app AFTER plugin registration —
    // without the fastify-plugin wrapper, this route would NOT be gated.
    app.get('/parent-route', () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/parent-route' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Missing Bearer token' })
  })

  it('returns 401 with "Missing Bearer token" on no Authorization header', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Missing Bearer token' })
  })

  it('returns 401 on Bearer with empty token', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer    ' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Empty Bearer token' })
  })

  it('returns 401 on lowercase scheme', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'bearer xyz' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 on JwtExpiredError', async () => {
    class JwtExpiredError extends Error {}
    mockVerify.mockRejectedValue(new JwtExpiredError('expired'))
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer expired-token' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Invalid token' })
  })

  it('returns 401 on missing sub claim', async () => {
    mockVerify.mockResolvedValue({ ...VALID_PAYLOAD, sub: '' })
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer t' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 on missing username claim', async () => {
    mockVerify.mockResolvedValue({ ...VALID_PAYLOAD, username: '' })
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/protected', () => ({ ok: true }))
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer t' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('public route bypasses validation entirely', async () => {
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' }))
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('jwt-no-db route requires valid token (identical to default in MYT-37)', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    app.post('/api/users/register', { config: { auth: 'jwt-no-db' } }, () => ({ ok: true }))
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/register',
      headers: { authorization: 'Bearer valid' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('decorates app.jwtVerifier with verify method', async () => {
    mockVerify.mockResolvedValue(VALID_PAYLOAD)
    app = Fastify({ logger: false })
    await app.register(jwtPlugin, OPTS)
    const decoratedVerifier = app.jwtVerifier
    expect(typeof decoratedVerifier?.verify).toBe('function')
    if (!decoratedVerifier) throw new Error('jwtVerifier not decorated')
    const result = await decoratedVerifier.verify('token')
    expect(result).toEqual(VALID_PAYLOAD)
  })
})
