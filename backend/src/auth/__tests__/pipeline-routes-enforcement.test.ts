// backend/src/auth/__tests__/pipeline-routes-enforcement.test.ts
//
// Boot-time enforcement of the PIPELINE_ROUTES contract per MYT-51 D12
// (revised). The hook installed in buildApp guards two directions:
//
//   FORWARD  (onRoute, synchronous at register time):
//     A route registered with `config.pipelineRoute = true` whose
//     `${METHOD} ${URL}` key is NOT in PIPELINE_ROUTES throws — caught
//     by the surrounding `await app.ready()` since the route is
//     registered inside an `app.register(...)` plugin scope.
//
//   REVERSE  (onReady):
//     An entry in PIPELINE_ROUTES that no route ever registered with
//     the marker throws — caught at app.ready().
//
// A clean buildApp boot exercises both checks happily (every pipeline
// route in routes/campaigns.ts is marked; every marker has an entry).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { buildApp } from '../../app.js'
import { PIPELINE_ROUTES } from '../../contract/pipeline-routes.js'
import { makeStubDeps } from '../../__tests__/helpers/stub-deps.js'
import { makeStubEnv } from '../../__tests__/helpers/stub-env.js'

// The pipeline-routes hook lives inside buildApp; we extract the exact
// onRoute + onReady wiring into a sibling fixture to drive the two
// failure modes in isolation. Mirrors the test pattern used by
// public-route-allowlist.test.ts (a side Fastify instance + the same
// hook shape used by production wiring).
function installPipelineRoutesHook(app: FastifyInstance): void {
  const APPROVED_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  const registered = new Set<string>()
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.config?.pipelineRoute !== true) return
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
    for (const m of methods) {
      if (!APPROVED_VERBS.has(m)) continue
      const key = `${m} ${routeOptions.url}`
      registered.add(key)
      if (!PIPELINE_ROUTES.includes(key)) {
        throw new Error(
          `pipeline-routes: ${key} is registered with config.pipelineRoute=true but is not ` +
            `declared in contract/pipeline-routes.ts. Add it to PIPELINE_ROUTES or remove ` +
            `the marker.`,
        )
      }
    }
  })
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onReady', async () => {
    const missing = PIPELINE_ROUTES.filter((k) => !registered.has(k))
    if (missing.length > 0) {
      throw new Error(
        `pipeline-routes: declared in contract/pipeline-routes.ts but no route ever registered ` +
          `with config.pipelineRoute=true matching: ${missing.join(', ')}. Either register the ` +
          `route with the marker or remove the entry from PIPELINE_ROUTES.`,
      )
    }
  })
}

describe('pipeline-routes contract enforcement (MYT-51 T12)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    // Force the bypass plugin's Layer 2b ECS task-metadata probe to fail
    // (i.e. "we are not on ECS"), so registration proceeds.
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('forward check: a marked route NOT in PIPELINE_ROUTES fails app.ready()', async () => {
    const app = Fastify({ logger: false })
    installPipelineRoutesHook(app)
    // Register the offending plugin WITHOUT `await` — Fastify's register
    // call queues the plugin synchronously; the onRoute hook throw fires
    // during avvio's deferred plugin-load phase, so the error surfaces
    // through `app.ready()` rather than the synchronous register call.
    // eslint-disable-next-line @typescript-eslint/require-await
    app.register(async (child) => {
      child.get(
        '/api/campaigns/unauthorized-route',
        {
          config: { pipelineRoute: true },
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => ({ ok: true }),
      )
    })
    await expect(app.ready()).rejects.toThrow(
      /GET \/api\/campaigns\/unauthorized-route is registered with config\.pipelineRoute=true but is not declared/,
    )
    await app.close()
  })

  it('reverse check: an entry in PIPELINE_ROUTES that no route registers fails app.ready()', async () => {
    // Side Fastify instance: install the hook, register ONLY the status
    // route from PIPELINE_ROUTES — the other 5 entries become "declared
    // but not registered" and onReady throws naming them.
    const app = Fastify({ logger: false })
    installPipelineRoutesHook(app)
    // eslint-disable-next-line @typescript-eslint/require-await
    app.register(async (child) => {
      child.get(
        '/api/campaigns/:campaignId/status',
        { config: { pipelineRoute: true } },
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => ({ ok: true }),
      )
    })
    // onReady runs after all plugin registrations complete; the
    // remaining 5 PIPELINE_ROUTES entries are unmounted, so it throws.
    await expect(app.ready()).rejects.toThrow(
      /pipeline-routes: declared in contract\/pipeline-routes\.ts but no route ever registered/,
    )
    await app.close()
  })

  it('clean buildApp boots without throwing — every PIPELINE_ROUTES entry has a marked registration', async () => {
    const app = await buildApp(
      makeStubDeps(),
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
    // buildApp returns a ready app (the await above resolves only after
    // app.ready() — which is what runs the onReady hook). Reaching this
    // line means both the forward and reverse checks accepted the
    // production wiring.
    expect(app).toBeDefined()
    await app.close()
  })
})
