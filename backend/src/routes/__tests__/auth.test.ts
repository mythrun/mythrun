// backend/src/routes/__tests__/auth.test.ts
//
// Integration tests for routes/auth.ts against a MOCKED CognitoOAuthClient. These
// routes touch NO database rows, so — per CONVENTIONS.md (scoped fixtures are for
// tests that create rows) — this file uses neither createTestPool nor a TestScope.
// The mocked client lets us assert the cookie set/rotate/clear, the 415 invariant,
// the allowlist boot, the rate limit, and CORS credentials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { registerPublicRouteAllowlistHook } from '../../auth/public-route-allowlist.js'
import { authRoutes } from '../auth.js'

const FRONTEND = 'https://staging.mythrun.com'

// Property-style stub (NOT the method-signature CognitoOAuthClient interface):
// `expect(mock.method)` on a method-signature type trips @typescript-eslint/
// unbound-method. Declaring the spies as PROPERTIES (the PoolStub idiom in
// boot/__tests__/process-error-handlers.test.ts) keeps the call assertions clean.
// Mock<(...args) => any> is structurally assignable to the real client.
interface CognitoMock {
  exchangeCode: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  revoke: ReturnType<typeof vi.fn>
}

function makeIdToken(payload: Record<string, unknown>): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none' })}.${seg(payload)}.sig`
}

function setCookieHeader(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  return Array.isArray(raw) ? raw.join('\n') : String(raw)
}

function makeCognitoMock(): CognitoMock {
  return {
    exchangeCode: vi
      .fn()
      .mockResolvedValue({ accessToken: 'access-1', expiresIn: 3600, idToken: makeIdToken({ name: 'Ada' }), refreshToken: 'refresh-1' }),
    refresh: vi.fn().mockResolvedValue({ accessToken: 'access-2', expiresIn: 3600, refreshToken: 'refresh-rotated' }),
    revoke: vi.fn().mockResolvedValue(undefined),
  }
}

async function buildApp(cognito: CognitoMock): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: 1 })
  registerPublicRouteAllowlistHook(app)
  await app.register(cors, {
    origin: [FRONTEND],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-mythrun-dev-sub'],
    credentials: true,
  })
  await app.register(cookie)
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(authRoutes, { cognito, frontendBaseUrl: FRONTEND })
  await app.ready()
  return app
}

describe('routes/auth', () => {
  let cognito: CognitoMock
  let app: FastifyInstance

  beforeEach(async () => {
    cognito = makeCognitoMock()
    app = await buildApp(cognito)
  })
  afterEach(async () => {
    await app.close()
  })

  describe('POST /api/auth/session', () => {
    it('200: exchanges code (derived redirect_uri), sets the refresh cookie, returns access token + name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ accessToken: 'access-1', expiresIn: 3600, name: 'Ada' })
      expect(cognito.exchangeCode).toHaveBeenCalledWith({
        code: 'CODE',
        codeVerifier: 'VER',
        redirectUri: 'https://staging.mythrun.com/auth/callback',
      })
      const sc = setCookieHeader(res)
      expect(sc).toContain('mythrun_refresh=refresh-1')
      expect(sc).toContain('HttpOnly')
      expect(sc).toContain('Secure')
      expect(sc).toContain('SameSite=Lax')
      expect(sc).toContain('Path=/api/auth')
      expect(sc).toContain('Max-Age=2592000')
      expect(sc).not.toContain('Domain')
    })

    it('415 on a text/plain content type (login-CSRF invariant: no form-body parser)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'text/plain' },
        payload: 'code=CODE&codeVerifier=VER',
      })
      expect(res.statusCode).toBe(415)
    })

    it('415 on application/x-www-form-urlencoded (no parser registered)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'code=CODE&codeVerifier=VER',
      })
      expect(res.statusCode).toBe(415)
    })

    it('400 on a JSON body missing code/codeVerifier', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('401 when the code exchange fails', async () => {
      vi.mocked(cognito.exchangeCode).mockRejectedValueOnce(new Error('invalid_grant'))
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'BAD', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ code: 'code_exchange_failed' })
    })

    it('502 when Cognito returns no refresh_token', async () => {
      vi.mocked(cognito.exchangeCode).mockResolvedValueOnce({ accessToken: 'a', expiresIn: 3600 })
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(502)
    })

    it('400 on a JSON `null` body (parseSessionBody body===null guard, auth.ts:33)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: 'null',
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'invalid_request' })
      expect(cognito.exchangeCode).not.toHaveBeenCalled()
    })

    it('400 on an empty `code` string (parseSessionBody length guard, auth.ts:36)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: '', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ code: 'invalid_request' })
      expect(cognito.exchangeCode).not.toHaveBeenCalled()
    })

    it('415 when NO content-type header is present (isJsonRequest `?? \'\'` fallback, auth.ts:42)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/session' })
      expect(res.statusCode).toBe(415)
      expect(res.json()).toEqual({ code: 'unsupported_media_type' })
    })

    it('401 with errorClass Unknown when exchangeCode rejects a NON-Error (errClass :Unknown, auth.ts:47)', async () => {
      vi.mocked(cognito.exchangeCode).mockRejectedValueOnce('plain string failure')
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ code: 'code_exchange_failed' })
    })

    it('200 with name:null when Cognito returns a token set with no id_token (auth.ts:77)', async () => {
      vi.mocked(cognito.exchangeCode).mockResolvedValueOnce({
        accessToken: 'access-no-id',
        expiresIn: 3600,
        refreshToken: 'refresh-no-id',
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ accessToken: 'access-no-id', expiresIn: 3600, name: null })
      expect(setCookieHeader(res)).toContain('mythrun_refresh=refresh-no-id')
    })
  })

  describe('POST /api/auth/refresh', () => {
    it('200: refreshes and RE-SETS the rotated cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ accessToken: 'access-2', expiresIn: 3600 })
      expect(cognito.refresh).toHaveBeenCalledWith({ refreshToken: 'refresh-1' })
      expect(setCookieHeader(res)).toContain('mythrun_refresh=refresh-rotated')
    })

    it('401 + clears the cookie when no refresh cookie is present', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' })
      expect(res.statusCode).toBe(401)
      const sc = setCookieHeader(res)
      expect(sc).toContain('mythrun_refresh=')
      expect(sc).toContain('Path=/api/auth')
      expect(sc).toMatch(/Max-Age=0|Expires=/)
    })

    it('401 + clears the cookie when the refresh grant fails', async () => {
      vi.mocked(cognito.refresh).mockRejectedValueOnce(new Error('expired'))
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: 'mythrun_refresh=dead' },
      })
      expect(res.statusCode).toBe(401)
      expect(setCookieHeader(res)).toMatch(/Max-Age=0|Expires=/)
    })

    it('does NOT re-set a cookie when the grant returns no rotated token', async () => {
      vi.mocked(cognito.refresh).mockResolvedValueOnce({ accessToken: 'access-2', expiresIn: 3600 })
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['set-cookie']).toBeUndefined()
    })
  })

  describe('POST /api/auth/logout', () => {
    it('204: revokes the token and clears the cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(204)
      expect(cognito.revoke).toHaveBeenCalledWith({ token: 'refresh-1' })
      expect(setCookieHeader(res)).toMatch(/Max-Age=0|Expires=/)
    })

    it('204 + clears the cookie even with no cookie present (revoke not called)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' })
      expect(res.statusCode).toBe(204)
      expect(cognito.revoke).not.toHaveBeenCalled()
    })

    it('204 + clears even if revoke throws (best-effort revoke)', async () => {
      vi.mocked(cognito.revoke).mockRejectedValueOnce(new Error('revoke down'))
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: 'mythrun_refresh=refresh-1' },
      })
      expect(res.statusCode).toBe(204)
      expect(setCookieHeader(res)).toMatch(/Max-Age=0|Expires=/)
    })
  })

  it('CORS: a credentialed preflight echoes the origin + allow-credentials', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/session',
      headers: {
        origin: FRONTEND,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('rate limit: the per-IP cap returns 429 once exceeded', async () => {
    let last = 0
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'CODE', codeVerifier: 'VER' },
      })
      last = res.statusCode
    }
    expect(last).toBe(429)
  })

  it('boots clean: the three public auth routes are allowlisted (app.ready did not throw)', () => {
    // buildApp() already called app.ready() in beforeEach without throwing — a
    // public route NOT in PUBLIC_ROUTE_ALLOWLIST would have failed there.
    expect(app.hasRoute({ method: 'POST', url: '/api/auth/session' })).toBe(true)
  })
})
