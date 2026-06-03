// backend/src/routes/__tests__/prep-prose.test.ts
//
// MYT-62 Task 5. Tests for the dev-only SSE route
// GET /api/dev/campaigns/:campaignId/prep-prose, which streams `prep-delta`
// prose events off the SEPARATE `prep:campaign:{id}` Redis channel.
//
// The route is the STRUCTURAL enforced-ignorance control: it is registered
// ONLY inside the `if (config.env.authMode === 'bypass')` block in app.ts,
// so a production boot (authMode='real') never serves sd_playbook prose at
// all. Two cases pin both halves of that contract:
//
//   1. Bypass mode — the route exists, attaches a prose subscriber to the
//      `prep:campaign:{id}` channel, and forwards a published prep-delta
//      frame (incl. a `sd_playbook` field — the prose channel has NO
//      type-tripwire; it forwards verbatim).
//   2. Real mode (negative) — built via buildApp with env.authMode='real'.
//      app.printRoutes() carries NO `/api/dev/` path AND an inject of the
//      prose URL returns 404. This is the proof that prod has no prose route.
//
// The real-mode negative mirrors app.test.ts's "skips devCreditsRoutes when
// authMode !== 'bypass'" test: RegisterAuthOptions stays `mode: 'bypass'`
// (so the bypass auth plugin registers without a Cognito JWKS hydrate — a
// real-mode buildApp would block on a 10s network fetch), while
// env.authMode='real' drives the registration gate this route lives behind.
// The gate is `config.env.authMode`, not the auth-plugin mode, so this is a
// faithful test of the production-absence invariant.
//
// Spec: docs/superpowers/specs/2026-05-?-myt-62-session-prep-pipeline (T5).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import IoredisMock from 'ioredis-mock'
import { buildApp } from '../../app.js'
import { devPrepProseRoutes } from '../dev-prep-prose.js'
import { createRedisClient } from '../../redis/client.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createRepo } from '../../repo/index.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import type { AppDeps } from '../../app-deps.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'
import { makeStubEnv } from '../../__tests__/helpers/stub-env.js'
import { noopWorldGenQueue, noopSessionPrepQueue } from '../../__tests__/helpers/stub-deps.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const FRONTEND_BASE_URL = 'http://localhost:5173'
const REDIS_KEY_PREFIX = `test:prep-prose-${String(Date.now())}:`

describe('GET /api/dev/campaigns/:campaignId/prep-prose (MYT-62 T5)', () => {
  // -------------------------------------------------------------------------
  // Bypass mode — route exists + forwards a prep-delta frame.
  // -------------------------------------------------------------------------
  describe('bypass mode', () => {
    let pool: Pool
    let redis: Redis
    let publisher: Redis
    let app: Awaited<ReturnType<typeof buildApp>>
    let scope: TestScope
    let devSub: string

    beforeAll(async () => {
      await guardTestDatabase(databaseUrl)
      pool = createTestPool(databaseUrl)
      scope = makeTestScope('prep-prose')

      const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
      redis = createRedisClient(redisUrl)
      publisher = createRedisClient(redisUrl)
      await redis.connect()
      await publisher.connect()

      const repo = createRepo(pool)
      const deps: AppDeps = {
        pg: pool,
        redisRealtime: redis,
        redisBatch: redis,
        redisKeyPrefix: REDIS_KEY_PREFIX,
        repo,
        worldGenQueue: noopWorldGenQueue(),
        sessionPrepQueue: noopSessionPrepQueue(),
      }
      app = await buildApp(
        deps,
        { mode: 'bypass' },
        {
          frontendBaseUrl: FRONTEND_BASE_URL,
          env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL, redisKeyPrefix: REDIS_KEY_PREFIX }),
        },
      )

      // The route runs through the full auth → requireOnboarded chain, so the
      // dev sub must resolve to a real users row (the dev tool self-bootstraps
      // bypass:dev-1 the same way). Seed one and pin it via x-mythrun-dev-sub.
      devSub = scope.userSub(0)
      await cleanupTestScope(pool, scope)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [uuidv7(), devSub, scope.displayName(0), scope.username(0)],
      )
    })

    afterAll(async () => {
      // The prose subscriber owns a dedicated PSUBSCRIBE client; close it (and
      // the pipeline subscriber) so the duplicate ioredis clients don't pin
      // the event loop past teardown and hang vitest.
      app.mythrunStopPeriodicLog()
      await app.mythrunSubscriber.close()
      if (app.mythrunProseSubscriber) await app.mythrunProseSubscriber.close()
      await app.close()
      await publisher.quit()
      await cleanupTestScope(pool, scope)
      await redis.quit()
      await pool.end()
    })

    it('returns text/event-stream and forwards a published prep-delta (incl. sd_playbook)', async () => {
      const campaignId = uuidv7()
      const res = await app.inject({
        method: 'GET',
        url: `/api/dev/campaigns/${campaignId}/prep-prose`,
        headers: { 'x-mythrun-dev-sub': devSub },
        payloadAsStream: true,
      })
      expect(res.statusCode).toBe(200)
      const contentType = res.headers['content-type']
      expect(typeof contentType).toBe('string')
      expect(contentType).toContain('text/event-stream')

      const stream = res.stream()
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
      }
      stream.on('data', onData)

      // Publish a prose delta on the SEPARATE prep:campaign: channel — the
      // prose subscriber PSUBSCRIBEs `${prefix}prep:campaign:*`. Use a
      // sd_playbook field to prove the prose channel forwards secret-bearing
      // prose verbatim (no type-tripwire; that gate is pipeline-channel only).
      // Retry the publish a few times: app.inject hijacks the response before
      // the sink is attached, but PSUBSCRIBE registration on the dedicated
      // duplicate client can lag the first publish under CI load.
      const published = await new Promise<boolean>((resolveDone) => {
        const tryPublish = async (attempt: number): Promise<void> => {
          if (buf.includes('SECRET-PLAYBOOK')) {
            resolveDone(true)
            return
          }
          if (attempt > 20) {
            resolveDone(buf.includes('SECRET-PLAYBOOK'))
            return
          }
          await publisher.publish(
            `${REDIS_KEY_PREFIX}prep:campaign:${campaignId}`,
            JSON.stringify({ type: 'prep-delta', field: 'sd_playbook', text: 'SECRET-PLAYBOOK' }),
          )
          setTimeout(() => void tryPublish(attempt + 1), 100)
        }
        void tryPublish(0)
      })

      expect(published).toBe(true)
      expect(buf).toContain('SECRET-PLAYBOOK')
      expect(buf).toContain('prep-delta')
      stream.off('data', onData)
      stream.destroy()
    })
  })

  // -------------------------------------------------------------------------
  // Real mode (negative) — the structural enforced-ignorance assertion.
  //
  // No DB / Redis network: the registration gate short-circuits before any
  // route or subscriber is built for the dev block, and the rest of buildApp
  // only registers routes (we never serve a request that touches the DB).
  // -------------------------------------------------------------------------
  describe('real mode (production-absence invariant)', () => {
    let app: Awaited<ReturnType<typeof buildApp>>

    beforeEach(() => {
      // The bypass auth plugin's Layer 2b probes the ECS task-metadata
      // endpoint and requires it to FAIL; reject fetch so registration
      // proceeds deterministically (mirrors app.test.ts).
      globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
    })

    afterEach(async () => {
      app.mythrunStopPeriodicLog()
      await app.mythrunSubscriber.close()
      // mythrunProseSubscriber must be ABSENT in this configuration (the
      // dev block that constructs it is gated on authMode==='bypass').
      await app.close()
    })

    it('registers NO /api/dev/ route and 404s the prep-prose URL', async () => {
      app = await buildApp(
        makeStubDepsForRealMode(),
        // RegisterAuthOptions stays bypass so the bypass plugin registers
        // without a Cognito JWKS hydrate; env.authMode='real' is what drives
        // the dev-block registration gate this route lives behind.
        { mode: 'bypass' },
        {
          frontendBaseUrl: FRONTEND_BASE_URL,
          env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL, authMode: 'real' }),
        },
      )
      await app.ready()

      // 1. No dev route in the registered tree at all.
      const printed = app.printRoutes({ commonPrefix: false })
      expect(printed).not.toContain('/api/dev/')

      // 2. The prose subscriber was never constructed (dev block skipped).
      expect(app.mythrunProseSubscriber).toBeUndefined()

      // 3. The prose URL 404s — proving prod has no prose route.
      const res = await app.inject({
        method: 'GET',
        url: '/api/dev/campaigns/x/prep-prose',
      })
      expect(res.statusCode).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  // Plugin-level gate (defense in depth). The plugin self-gates on
  // process.env.AUTH_MODE so a future caller forgetting the app.ts wiring
  // gate still can't register the prose route in production. Register it
  // DIRECTLY (no app.ts wiring) with AUTH_MODE='real' and assert it 404s —
  // mirrors dev-credits.ts's "does NOT register when AUTH_MODE!=bypass" test.
  // -------------------------------------------------------------------------
  describe('plugin-level AUTH_MODE gate', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('registers NO route when AUTH_MODE !== "bypass"', async () => {
      vi.stubEnv('AUTH_MODE', 'real')
      const app = Fastify({ logger: false })
      await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
      // The plugin returns before touching subscriber/counter when the gate
      // fails, so shape-only stubs that throw if called are sufficient + prove
      // the early return doesn't reach the SSE wiring.
      const subscriber = {
        attach: () => () => {
          throw new Error('attach must not be called when AUTH_MODE !== bypass')
        },
      } as unknown as PipelineSubscriber
      const counter = {
        increment: () => {
          throw new Error('increment must not be called when AUTH_MODE !== bypass')
        },
      } as unknown as ConnectionCounter
      await app.register(devPrepProseRoutes, { subscriber, counter })
      await app.ready()
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/dev/campaigns/x/prep-prose',
        })
        expect(res.statusCode).toBe(404)
      } finally {
        await app.close()
      }
    })
  })
})

// Shape-only stub deps for the real-mode negative. Uses ioredis-mock (no
// network) so the rate-limit plugin's defineCommand registers; the route is
// never served, so the pg stub never runs a query.
function makeStubDepsForRealMode(): AppDeps {
  const mockPool = {} as Pool
  return {
    pg: mockPool,
    redisRealtime: new IoredisMock(),
    redisBatch: new IoredisMock(),
    redisKeyPrefix: 'test:use1:',
    repo: createRepo(mockPool),
    worldGenQueue: noopWorldGenQueue(),
    sessionPrepQueue: noopSessionPrepQueue(),
  }
}
