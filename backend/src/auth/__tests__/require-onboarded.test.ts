import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'

// Mock the users repo so the plugin doesn't reach for a real DB.
const getByCognitoSubWithTimeout = vi.fn()
vi.mock('../../repo/users.js', () => ({
  createUsersRepo: () => ({ getByCognitoSubWithTimeout }),
}))

import { requireOnboarded } from '../require-onboarded.js'

// A minimal stand-in for the upstream JWT plugin: declares the plugin
// name 'mythrun-auth-jwt' so requireOnboarded's `dependencies` check
// passes, and (per-test) attaches request.user when desired.
function fakeJwtPlugin(attachUser: { sub: string } | undefined) {
  return fp(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (app) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      app.addHook('preHandler', async (request) => {
        if (attachUser) {
          ;(request as unknown as { user?: { sub: string; cognitoUsername: string; scopes: readonly string[] } }).user = {
            sub: attachUser.sub,
            cognitoUsername: 'fake',
            scopes: [],
          }
        }
      })
    },
    { fastify: '5.x', name: 'mythrun-auth-jwt' },
  )
}

const fakePool = {} as Pool

describe('requireOnboarded plugin', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    getByCognitoSubWithTimeout.mockReset()
  })
  afterEach(async () => {
    if (app) await app.close()
    app = undefined
  })

  it('public route → hook skips, never queries DB', async () => {
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin(undefined))
    await app.register(requireOnboarded, { pool: fakePool })
    app.get('/health', { config: { auth: 'public' } }, () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(getByCognitoSubWithTimeout).not.toHaveBeenCalled()
  })

  it('jwt-no-db route → hook skips DB lookup', async () => {
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin({ sub: 'u-1' }))
    await app.register(requireOnboarded, { pool: fakePool })
    app.post('/api/users/register', { config: { auth: 'jwt-no-db' } }, () => ({ ok: true }))
    const res = await app.inject({ method: 'POST', url: '/api/users/register' })
    expect(res.statusCode).toBe(200)
    expect(getByCognitoSubWithTimeout).not.toHaveBeenCalled()
  })

  it('404 fall-through → hook skips (routeOptions.url undefined)', async () => {
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin({ sub: 'u-1' }))
    await app.register(requireOnboarded, { pool: fakePool })
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(getByCognitoSubWithTimeout).not.toHaveBeenCalled()
  })

  it('no request.user → 401 unauthenticated', async () => {
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin(undefined))
    await app.register(requireOnboarded, { pool: fakePool })
    app.get('/api/me', () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ code: 'unauthenticated' })
    expect(getByCognitoSubWithTimeout).not.toHaveBeenCalled()
  })

  it('user row missing → 403 username_required', async () => {
    getByCognitoSubWithTimeout.mockResolvedValue(null)
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin({ sub: 'u-1' }))
    await app.register(requireOnboarded, { pool: fakePool })
    app.get('/api/me', () => ({ ok: true }))
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'username_required' })
    expect(getByCognitoSubWithTimeout).toHaveBeenCalledWith('u-1', 200)
  })

  it('user row present → next handler runs', async () => {
    getByCognitoSubWithTimeout.mockResolvedValue({ id: 'user-row', cognitoSub: 'u-1' })
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin({ sub: 'u-1' }))
    await app.register(requireOnboarded, { pool: fakePool })
    app.get('/api/me', () => ({ hit: true }))
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ hit: true })
  })

  it('boot succeeds when only allowlisted routes use jwt-no-db', async () => {
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin(undefined))
    await app.register(requireOnboarded, { pool: fakePool })
    app.post('/api/users/register', { config: { auth: 'jwt-no-db' } }, () => ({ ok: true }))
    app.get('/api/users/check-username', { config: { auth: 'jwt-no-db' } }, () => ({ ok: true }))
    await expect(app.ready()).resolves.toBeDefined()
  })

  it('boot throws when an unallowed route uses jwt-no-db', async () => {
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin(undefined))
    await app.register(requireOnboarded, { pool: fakePool })
    app.delete('/api/users/me', { config: { auth: 'jwt-no-db' } }, () => ({ ok: true }))
    await expect(app.ready()).rejects.toThrow(/jwt-no-db opt-out used on non-allowlisted routes/)
  })
})
