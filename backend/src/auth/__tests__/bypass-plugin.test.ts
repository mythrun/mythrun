import os from 'node:os'
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

// SAFE_DEV_ENV establishes the dev-mode baseline. setup-env.ts pins
// MYTHRUN_BYPASS_SUB = 'bypass:dev-1' for the whole suite (so the ~10 files
// that hardcode that sub keep passing across machines), so the default
// attach path here asserts that pinned override value. The hostname-
// derivation tests below explicitly delete MYTHRUN_BYPASS_SUB to exercise
// the os.hostname() path. afterEach restores the os.hostname spy via
// vi.restoreAllMocks.
const SAFE_DEV_ENV = (): void => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('COGNITO_USER_POOL_ID', '')
  vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
  vi.stubEnv('COGNITO_ISSUER_URL', '')
  vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
  // Default Layer 2b probe: simulate "not on ECS" — connection refused.
  mockFetchImpl = () => Promise.reject(new Error('ECONNREFUSED'))
}

// The suite-wide pinned bypass sub (setup-env.ts). The default-path tests
// assert this; the hostname-derivation tests delete the env var to reach the
// os.hostname() branch instead.
const PINNED_SUB = 'bypass:dev-1'

describe('bypassPlugin', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    app = undefined
  })
  afterEach(async () => {
    if (app) await app.close()
    // Restore os.hostname spy (SAFE_DEV_ENV installs it) so it doesn't
    // leak to sibling tests sharing this fork. vi.unstubAllEnvs is handled
    // globally in setup-env.ts; vi.spyOn is not, so we restore here.
    vi.restoreAllMocks()
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
      sub: PINNED_SUB,
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
    expect(attached).toMatchObject({ sub: PINNED_SUB })
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
    expect(attached.sub).toBe(PINNED_SUB)
  })

  const attachDefaultSub = async (): Promise<string> => {
    const instance = Fastify({ logger: false })
    app = instance
    await instance.register(bypassPlugin, {})
    let sub = ''
    instance.get('/protected', (request) => {
      sub = (request.user as { sub: string }).sub
      return { ok: true }
    })
    const res = await instance.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(200)
    return sub
  }

  // --- myth-yetw: MYTHRUN_BYPASS_SUB full-sub override (test/CI determinism) ---

  it('MYTHRUN_BYPASS_SUB overrides hostname derivation verbatim', async () => {
    SAFE_DEV_ENV()
    // Override wins even with a hostname spy that would derive a different sub.
    vi.spyOn(os, 'hostname').mockReturnValue('some-other-host')
    vi.stubEnv('MYTHRUN_BYPASS_SUB', 'bypass:override-verbatim')
    const sub = await attachDefaultSub()
    expect(sub).toBe('bypass:override-verbatim')
  })

  // --- myth-yetw: hostname-derived bypass sub ---
  // With MYTHRUN_BYPASS_SUB deleted, the bypass sub is derived from
  // os.hostname() so that multiple devs sharing a dev DB (or staging) don't
  // collide on a single users row. The `bypass:` prefix MUST be preserved —
  // it's keyed on by dev-credits, the rejection-storm per-sub counters, and
  // the sibling cognito_sub `NOT LIKE 'bypass:%'` CHECK work (myth-sea4).
  //
  // setup-env.ts pins MYTHRUN_BYPASS_SUB for the whole suite, so these tests
  // delete it (via vi.stubEnv(..., undefined); vi.unstubAllEnvs in the global
  // afterEach restores it) to reach the os.hostname() branch.
  const clearBypassSubOverride = (): void => {
    vi.stubEnv('MYTHRUN_BYPASS_SUB', undefined)
  }

  it('derives the default sub from os.hostname() and keeps the bypass: prefix', async () => {
    SAFE_DEV_ENV()
    clearBypassSubOverride()
    vi.spyOn(os, 'hostname').mockReturnValue('Alices-MacBook-Pro.local')
    const sub = await attachDefaultSub()
    expect(sub.startsWith('bypass:')).toBe(true)
    expect(sub).toBe('bypass:alices-macbook-pro-local')
  })

  it('produces distinct subs for distinct hostnames', async () => {
    SAFE_DEV_ENV()
    clearBypassSubOverride()
    vi.spyOn(os, 'hostname').mockReturnValue('host-one')
    const subOne = await attachDefaultSub()
    await app?.close()

    vi.spyOn(os, 'hostname').mockReturnValue('host-two')
    const subTwo = await attachDefaultSub()

    expect(subOne).not.toBe(subTwo)
    expect(subOne.startsWith('bypass:')).toBe(true)
    expect(subTwo.startsWith('bypass:')).toBe(true)
  })

  it('produces a stable sub for a given hostname (deterministic)', async () => {
    SAFE_DEV_ENV()
    clearBypassSubOverride()
    vi.spyOn(os, 'hostname').mockReturnValue('Stable-Host.local')
    const first = await attachDefaultSub()
    await app?.close()

    vi.spyOn(os, 'hostname').mockReturnValue('Stable-Host.local')
    const second = await attachDefaultSub()

    expect(first).toBe(second)
    expect(first).toBe('bypass:stable-host-local')
  })

  it('sanitizes hostnames with unsafe characters, collapses runs, and trims dashes', async () => {
    SAFE_DEV_ENV()
    clearBypassSubOverride()
    // Mixed case, dots, underscores, spaces, and a trailing unsafe run.
    vi.spyOn(os, 'hostname').mockReturnValue('  Böb_Dev Box!! .local  ')
    const sub = await attachDefaultSub()
    expect(sub.startsWith('bypass:')).toBe(true)
    // Everything after the prefix is a clean [a-z0-9-] slug with no
    // leading/trailing dashes and no repeated dashes.
    const slug = sub.slice('bypass:'.length)
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })

  it('bounds the derived sub length for pathologically long hostnames', async () => {
    SAFE_DEV_ENV()
    clearBypassSubOverride()
    vi.spyOn(os, 'hostname').mockReturnValue('a'.repeat(500))
    const sub = await attachDefaultSub()
    expect(sub.startsWith('bypass:')).toBe(true)
    // The slug is bounded; assert it didn't pass through the full 500 chars.
    expect(sub.length).toBeLessThanOrEqual('bypass:'.length + 64)
  })

  it('falls back to a stable slug when the hostname sanitizes to empty', async () => {
    SAFE_DEV_ENV()
    clearBypassSubOverride()
    // A hostname made entirely of unsafe characters sanitizes to '' — the
    // derivation must still yield a valid, prefixed, non-empty sub.
    vi.spyOn(os, 'hostname').mockReturnValue('!!!@@@###')
    const sub = await attachDefaultSub()
    expect(sub.startsWith('bypass:')).toBe(true)
    expect(sub.length).toBeGreaterThan('bypass:'.length)
    expect(sub.slice('bypass:'.length)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  })
})
