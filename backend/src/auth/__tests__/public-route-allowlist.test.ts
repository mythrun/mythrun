import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import {
  registerPublicRouteAllowlistHook,
  PUBLIC_ROUTE_ALLOWLIST,
} from '../public-route-allowlist.js'

describe('public-route allowlist', () => {
  it('contains the expected 5 entries', () => {
    expect(PUBLIC_ROUTE_ALLOWLIST.size).toBe(5)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('GET /health')).toBe(true)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('POST /webhooks/stripe')).toBe(true)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('GET /api/billing/skus')).toBe(true)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('GET /api/invites/:inviteCode/preview')).toBe(true)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('GET /health/ready')).toBe(true)
  })

  it('allowlisted public route registers cleanly', async () => {
    const app = Fastify()
    registerPublicRouteAllowlistHook(app)
    // Routes in production are always registered inside app.register() plugins;
    // only plugin-wrapped registrations defer onRoute errors to app.ready().
    // eslint-disable-next-line @typescript-eslint/require-await
    app.register(async (child) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      child.get('/health', { config: { auth: 'public' } }, async () => ({ ok: true }))
    })
    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })

  it('non-allowlisted public route causes app.ready() to reject', async () => {
    const app = Fastify()
    registerPublicRouteAllowlistHook(app)
    // eslint-disable-next-line @typescript-eslint/require-await
    app.register(async (child) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      child.get('/secret', { config: { auth: 'public' } }, async () => ({ ok: true }))
    })
    await expect(app.ready()).rejects.toThrow(/non-allowlisted route/)
    await app.close()
  })

  it('JWT-default route (no config.auth) is silently skipped', async () => {
    const app = Fastify()
    registerPublicRouteAllowlistHook(app)
    // eslint-disable-next-line @typescript-eslint/require-await
    app.register(async (child) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      child.get('/api/something', async () => ({ ok: true }))
    })
    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })
})
