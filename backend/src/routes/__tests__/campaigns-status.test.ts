// backend/src/routes/__tests__/campaigns-status.test.ts
//
// Integration tests for the campaigns status + SSE stream routes.
// Boots `buildApp` against the real local Postgres + Redis (mirrors
// `rate-limit-per-sub.test.ts`) so the full auth + access-control +
// rate-limit + onboarded chain exercises end-to-end. The bypass-auth
// plugin's `x-mythrun-dev-sub` header lets each test pin its own user
// without collapsing onto the default bypass:dev-1.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface.md
// Plan: docs/superpowers/plans/2026-05-12-myt-50-pipeline-status-surface.md §Task 6 step 1
//
// SSE assertions use `payloadAsStream: true` so app.inject returns a
// readable response stream. The 4th test publishes via a separate
// ioredis client (not the buildApp realtime client — that one is in
// PSUBSCRIBE mode via the dedicated subscriber duplicate, but publishing
// from the same connection would still race with subscriber readiness
// in CI). A separate client is also closer to the production layout
// where workers publish from their own connections.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { buildApp } from '../../app.js'
import { createPgPool } from '../../db/postgres.js'
import { createRedisClient } from '../../redis/client.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createRepo } from '../../repo/index.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import type { AppDeps } from '../../app-deps.js'
import { makeStubEnv } from '../../__tests__/helpers/stub-env.js'
import { noopWorldGenQueue } from '../../__tests__/helpers/stub-deps.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')
const FRONTEND_BASE_URL = 'http://localhost:5173'

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

const REDIS_KEY_PREFIX = `test:campaigns-status-${String(Date.now())}:`

interface SeededCampaign {
  campaignId: string
  userId: string
  devSub: string
}

describe('campaigns status routes', () => {
  let pool: Pool
  let redis: Redis
  let publisher: Redis
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    // Sibling repo tests share the same DB; reset to a clean slate so
    // foreign-key chains line up with the fresh migration baseline.
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })

    const redisUrl = process.env.REDIS_REALTIME_URL ?? 'redis://127.0.0.1:6379'
    redis = createRedisClient(redisUrl)
    publisher = createRedisClient(redisUrl)
    await redis.connect()
    await publisher.connect()

    const repo = createRepo(pool)
    const deps: AppDeps = {
      pg: pool,
      redisRealtime: redis,
      // batch is unused by the routes under test; reuse the realtime
      // client so we don't open a third connection.
      redisBatch: redis,
      redisKeyPrefix: REDIS_KEY_PREFIX,
      repo,
      worldGenQueue: noopWorldGenQueue(),
    }
    app = await buildApp(
      deps,
      { mode: 'bypass' },
      {
        frontendBaseUrl: FRONTEND_BASE_URL,
        env: makeStubEnv({ frontendBaseUrl: FRONTEND_BASE_URL, redisKeyPrefix: REDIS_KEY_PREFIX }),
      },
    )
  })

  afterAll(async () => {
    // app.close stops HTTP; the subscriber's dedicated PSUBSCRIBE client
    // is closed via app.mythrunSubscriber.close() — without that, the
    // duplicate ioredis client keeps the event loop alive past test
    // teardown and vitest hangs.
    app.mythrunStopPeriodicLog()
    await app.mythrunSubscriber.close()
    await app.close()
    await publisher.quit()
    await redis.quit()
    await pool.end()
  })

  beforeEach(async () => {
    // Order matters: delete child rows before parents. campaign_members
    // / pipeline_runs reference campaigns + users; campaigns references
    // worlds + users; worlds references users. campaign_invites also
    // references campaigns.
    await pool.query('DELETE FROM pipeline_runs')
    await pool.query('DELETE FROM campaign_members')
    await pool.query('DELETE FROM campaign_invites')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query('DELETE FROM users')
  })

  async function seedCampaignWithMember(): Promise<SeededCampaign> {
    const userId = uuidv7()
    // The bypass-plugin reads `x-mythrun-dev-sub` and sets request.user.sub
    // to that value; requireOnboarded then looks up users by cognito_sub.
    // Putting the same string in the users row + the request header is what
    // makes this user "known" to the auth chain.
    const devSub = `bypass:test-${userId.slice(-6)}`
    const worldId = uuidv7()
    const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, devSub, 'Test', `t${userId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, 'W', 'C')`,
      [worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name) VALUES ($1, $2, $3, 'C')`,
      [campaignId, worldId, userId],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
    return { campaignId, userId, devSub }
  }

  it('GET /api/campaigns/:campaignId/status returns 200 with snapshot for a member', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status`,
      headers: { 'x-mythrun-dev-sub': devSub },
    })
    expect(res.statusCode).toBe(200)
    const body: {
      phase: string
      stages: readonly unknown[]
      cumulativeCostUsd: number
    } = res.json()
    expect(body.phase).toBe('not_started')
    expect(body.stages).toEqual([])
    expect(body.cumulativeCostUsd).toBe(0)
  })

  it('GET /api/campaigns/:campaignId/status returns 403 for non-members', async () => {
    const { campaignId } = await seedCampaignWithMember()
    const otherUserId = uuidv7()
    const otherSub = `bypass:other-${otherUserId.slice(-6)}`
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [otherUserId, otherSub, 'O', `o${otherUserId.slice(-6)}`],
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status`,
      headers: { 'x-mythrun-dev-sub': otherSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('GET /api/campaigns/:campaignId/status/stream returns text/event-stream + initial snapshot frame', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const contentType = res.headers['content-type']
    expect(typeof contentType).toBe('string')
    expect(contentType).toContain('text/event-stream')

    // Drain until we see the snapshot frame, with a 2s wall-clock safety
    // net so a never-arriving frame fails the test loudly rather than
    // hanging vitest. The keepalive interval is 15s, so the only thing
    // that can arrive in <2s is the snapshot frame the handler writes
    // right after attaching the sink.
    const stream = res.stream()
    const collected = await new Promise<string>((resolveCollected) => {
      let buf = ''
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8')
        if (buf.includes('event: snapshot')) {
          stream.off('data', onData)
          resolveCollected(buf)
        }
      }
      stream.on('data', onData)
      setTimeout(() => {
        stream.off('data', onData)
        resolveCollected(buf)
      }, 2000)
    })
    expect(collected).toContain('event: snapshot')
    expect(collected).toContain('"phase":"not_started"')
    stream.destroy()
  })

  it('SSE stream forwards a published phase event', async () => {
    const { campaignId, devSub } = await seedCampaignWithMember()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/status/stream`,
      headers: { 'x-mythrun-dev-sub': devSub },
      payloadAsStream: true,
    })
    expect(res.statusCode).toBe(200)
    const stream = res.stream()

    // Two-phase drain: collect everything; resolve once the snapshot
    // frame arrives (sink is attached at that point); publish; resolve
    // again once the live event arrives. Single listener keeps buffer
    // ordering deterministic and prevents data-loss between phases.
    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
    }
    stream.on('data', onData)

    await new Promise<void>((resolveSnapshot) => {
      const check = (): void => {
        if (buf.includes('event: snapshot')) resolveSnapshot()
      }
      stream.on('data', check)
      // Safety: if the snapshot never arrives, fail downstream rather
      // than hang. The keepalive interval is 15s so there's nothing
      // else that can show up in <2s.
      setTimeout(resolveSnapshot, 2000)
    })

    await publisher.publish(
      `${REDIS_KEY_PREFIX}pipeline:campaign:${campaignId}`,
      JSON.stringify({ type: 'phase', phase: 'world_gen' }),
    )

    await new Promise<void>((resolveEvent) => {
      const check = (): void => {
        if (buf.includes('"phase":"world_gen"')) resolveEvent()
      }
      stream.on('data', check)
      // Bump to 3s because the publish round-trip + PSUBSCRIBE dispatch
      // is observably ~50ms locally but can spike under load.
      setTimeout(resolveEvent, 3000)
    })

    expect(buf).toContain('"phase":"world_gen"')
    stream.off('data', onData)
    stream.destroy()
  })
})
