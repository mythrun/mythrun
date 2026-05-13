import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock global fetch so the Layer 2b HTTP probe is controllable per-test.
const originalFetch = globalThis.fetch
let mockFetchImpl: typeof globalThis.fetch | undefined
beforeEach(() => {
  globalThis.fetch = (...args: Parameters<typeof globalThis.fetch>) => {
    if (mockFetchImpl === undefined) {
      return Promise.reject(new Error('mockFetchImpl not configured'))
    }
    return mockFetchImpl(...args)
  }
})
afterEach(() => {
  globalThis.fetch = originalFetch
  mockFetchImpl = undefined
})

import { bypassPlugin } from '../bypass-plugin.js'

const SAFE_DEV_ENV = (): void => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('COGNITO_USER_POOL_ID', '')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
  vi.stubEnv('COGNITO_ISSUER_URL', '')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
  // Default Layer 2b probe: simulate "not on ECS" — connection refused.
  mockFetchImpl = () => Promise.reject(new Error('ECONNREFUSED'))
}

describe('bypassPlugin', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    app = undefined
  })
  afterEach(async () => {
    if (app) await app.close()
  })

  it('attaches BYPASS_USER on protected route', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: unknown
    app.get('/protected', (request) => {
      attached = request.user
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(200)
    expect(attached).toEqual({
      sub: 'bypass:dev-1',
      cognitoUsername: 'bypass_dev_1',
      scopes: ['bypass'],
    })
  })

  it('Layer 2a: throws when NODE_ENV=production at registration', async () => {
    SAFE_DEV_ENV()
    vi.stubEnv('NODE_ENV', 'production')
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(
      /NODE_ENV must be 'development' or 'test'/,
    )
  })

  it('Layer 2a: throws when NODE_ENV is unset', async () => {
    SAFE_DEV_ENV()
    vi.stubEnv('NODE_ENV', '')
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(/NODE_ENV must be/)
  })

  it('Layer 2b: throws when ECS metadata probe returns 200', async () => {
    SAFE_DEV_ENV()
    mockFetchImpl = () => Promise.resolve(new Response('{"task":"x"}', { status: 200 }))
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(
      /ECS task-metadata endpoint reachable/,
    )
  })

  it('Layer 2b: throws when ECS metadata probe returns non-200', async () => {
    SAFE_DEV_ENV()
    mockFetchImpl = () => Promise.resolve(new Response('forbidden', { status: 403 }))
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(
      /ECS task-metadata endpoint responded \(status 403\)/,
    )
  })

  it('Layer 2b: proceeds when probe times out', async () => {
    SAFE_DEV_ENV()
    mockFetchImpl = () =>
      new Promise((_resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('aborted'))
        }, 200)
        // Cleanup happens implicitly when the global fetch is restored
        ;(t as { unref?: () => void }).unref?.()
      })
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    expect(app.hasDecorator('mythAuthRegistered')).toBe(true)
  })

  it('Layer 2b: probe-internal timeout fires (>1s) → controller.abort() invoked', async () => {
    // Exercises bypass-plugin.ts:52-54 — the 1s setTimeout that fires
    // controller.abort() when the ECS metadata probe hangs longer than
    // the probe timeout. The mock fetch respects AbortSignal so the
    // signal aborts → fetch rejects → plugin's try/catch swallows.
    SAFE_DEV_ENV()
    mockFetchImpl = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          if (signal.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }
        // Never resolve on our own — only the plugin's own probeTimer
        // (1s) can abort us.
      })
    app = Fastify({ logger: false, pluginTimeout: 30_000 })
    await app.register(bypassPlugin, {})
    expect(app.hasDecorator('mythAuthRegistered')).toBe(true)
  }, 15_000)

  it('Layer 3: throws when cognitoUserPoolId opt is set', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await expect(
      app.register(bypassPlugin, { cognitoUserPoolId: 'us-east-1_xxx' }),
    ).rejects.toThrow(/Cognito config present/)
  })

  it('Layer 3: throws when COGNITO_USER_POOL_ID env is set', async () => {
    SAFE_DEV_ENV()
    vi.stubEnv('COGNITO_USER_POOL_ID', 'us-east-1_yyy')
    app = Fastify({ logger: false })
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(/Cognito config present/)
  })

  it('Layer 4: logs auth.bypass_mode_active at registration', async () => {
    SAFE_DEV_ENV()
    const logs: unknown[] = []
    app = Fastify({
      logger: {
        level: 'warn',
        stream: {
          write: (s: string) => {
            logs.push(JSON.parse(s))
            return true
          },
        },
      },
    })
    await app.register(bypassPlugin, {})
    expect(
      logs.some(
        (l) =>
          typeof l === 'object' &&
          l !== null &&
          (l as Record<string, unknown>).event === 'auth.bypass_mode_active',
      ),
    ).toBe(true)
  })

  it('rejects double registration', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    await expect(app.register(bypassPlugin, {})).rejects.toThrow(/already registered/)
  })

  it('encapsulation contract: hook applies to PARENT-scope routes', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: unknown
    app.get('/parent-route', (request) => {
      attached = request.user
      return { ok: true }
    })
    const res = await app.inject({ method: 'GET', url: '/parent-route' })
    expect(res.statusCode).toBe(200)
    expect(attached).toMatchObject({ sub: 'bypass:dev-1' })
  })

  it('public route: no user attached', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: unknown = 'sentinel'
    app.get('/health', { config: { auth: 'public' } }, (request) => {
      attached = request.user
      return { status: 'ok' }
    })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(attached).toBe(undefined)
  })

  it('per-request: throws if NODE_ENV mutated to production after registration', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    app.get('/protected', () => ({ ok: true }))
    vi.stubEnv('NODE_ENV', 'production')
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(500)
  })

  it('per-request: throws if Cognito env var appears after registration (Layer 3 re-check)', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    app.get('/protected', () => ({ ok: true }))
    // Mutate process.env AFTER registration succeeded. The per-request hook
    // re-checks at request time so a future code path that sets Cognito
    // env at runtime can't silently keep bypass alive.
    vi.stubEnv('COGNITO_APP_CLIENT_ID', 'leaked-at-runtime')
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(500)
  })

  it('per-request: x-mythrun-dev-sub header overrides sub for per-test isolation', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: { sub?: string } = {}
    app.get('/protected', (request) => {
      attached = request.user as { sub: string }
      return { ok: true }
    })
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-mythrun-dev-sub': 'bypass:custom-test-sub' },
    })
    expect(res.statusCode).toBe(200)
    expect(attached.sub).toBe('bypass:custom-test-sub')
  })

  it('404 fall-through: routeOptions.url undefined → hook returns without attaching user', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    // No routes registered → request to any URL falls through to the
    // default 404 handler. `request.routeOptions.url` is undefined in
    // that path, so the hook should early-return without throwing.
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' })
    expect(res.statusCode).toBe(404)
  })

  it('per-request: empty x-mythrun-dev-sub header falls back to default BYPASS_USER', async () => {
    SAFE_DEV_ENV()
    app = Fastify({ logger: false })
    await app.register(bypassPlugin, {})
    let attached: { sub?: string } = {}
    app.get('/protected', (request) => {
      attached = request.user as { sub: string }
      return { ok: true }
    })
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-mythrun-dev-sub': '' },
    })
    expect(res.statusCode).toBe(200)
    expect(attached.sub).toBe('bypass:dev-1')
  })
})
