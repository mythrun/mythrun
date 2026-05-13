// Integration tests for DELETE /api/campaigns/:campaignId.
//
// The endpoint exists for the dev tool's hard-delete flow + future
// production "abandon campaign" UX. Confirms (a) the CASCADE FK chain
// (worlds → campaigns → pipeline_runs / campaign_members / campaign_invites)
// actually removes every descendant in one DELETE on worlds, (b) the
// owner-only gate, (c) the world_gen_in_progress refusal so we don't
// orphan an in-flight LLM call's cost.
//
// Harness mirrors campaigns-create.test.ts (bypassPlugin + requireOnboarded
// + campaignsRoutes) — real Postgres so CASCADE genuinely fires.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { campaignsRoutes, type WorldGenQueueLike } from '../campaigns.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')
const REDIS_KEY_PREFIX = `test:campaigns-delete-${String(Date.now())}:`

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

function noopSubscriber(): PipelineSubscriber {
  return {
    attach: () => () => {
      /* no-op */
    },
    close: () => Promise.resolve(),
  } as unknown as PipelineSubscriber
}
function noopCounter(): ConnectionCounter {
  return {
    increment: () => {
      /* no-op */
    },
    decrement: () => {
      /* no-op */
    },
    startPeriodicLog: () => () => {
      /* no-op */
    },
  } as unknown as ConnectionCounter
}
function noopQueue(): WorldGenQueueLike {
  return {
    add: vi.fn().mockResolvedValue({ id: 'stub-job' }),
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0 }),
  } as unknown as WorldGenQueueLike
}

interface SeededCampaign {
  readonly ownerSub: string
  readonly ownerId: string
  readonly campaignId: string
  readonly worldId: string
}

async function seedOwnerCampaign(
  pool: Pool,
  worldStatus: 'complete' | 'generating' | 'failed' = 'complete',
): Promise<SeededCampaign> {
  const ownerId = uuidv7()
  const ownerSub = `bypass:delete-${ownerId.slice(-6)}`
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [ownerId, ownerSub, 'DelTest', `dt${ownerId.slice(-6)}`],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, $4, $5)`,
    [worldId, ownerId, 'Test World', 'A test concept.', worldStatus],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, ownerId, 'Test Campaign'],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, ownerId],
  )
  await pool.query(
    `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at,
                                cost_usd, input_tokens, output_tokens, user_id)
     VALUES ($1, $2, 'concept_intake', 'completed', now(), now(), 0.01, 100, 100, NULL)`,
    [uuidv7(), worldId],
  )
  return { ownerSub, ownerId, campaignId, worldId }
}

async function buildTestApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignsRoutes, {
    pool,
    subscriber: noopSubscriber(),
    counter: noopCounter(),
    redis,
    redisKeyPrefix: REDIS_KEY_PREFIX,
    worldGenQueue: noopQueue(),
  })
  await app.ready()
  return app
}

describe('DELETE /api/campaigns/:campaignId', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 4 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    // Children-first; worlds last because campaigns FK at it.
    await pool.query('DELETE FROM pipeline_runs')
    await pool.query('DELETE FROM campaign_members')
    await pool.query('DELETE FROM campaign_invites')
    await pool.query('DELETE FROM campaigns')
    await pool.query('DELETE FROM worlds')
    await pool.query("DELETE FROM users WHERE cognito_sub != 'system:mythrun'")
    app = await buildTestApp(pool, redis)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('204 hard-deletes campaign + world + pipeline_runs via CASCADE', async () => {
    const { ownerSub, campaignId, worldId } = await seedOwnerCampaign(pool, 'complete')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/campaigns/${campaignId}`,
      headers: { 'x-mythrun-dev-sub': ownerSub },
    })
    expect(res.statusCode).toBe(204)
    // Empty body — Fastify serializes 204 as no body.
    expect(res.payload).toBe('')

    const counts = await pool.query<{
      worlds: string
      campaigns: string
      runs: string
      members: string
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM worlds WHERE id = $1) AS worlds,
         (SELECT COUNT(*)::text FROM campaigns WHERE id = $2) AS campaigns,
         (SELECT COUNT(*)::text FROM pipeline_runs WHERE world_id = $1) AS runs,
         (SELECT COUNT(*)::text FROM campaign_members WHERE campaign_id = $2) AS members`,
      [worldId, campaignId],
    )
    const row = counts.rows[0]
    if (!row) throw new Error('counts missing')
    expect(row.worlds).toBe('0')
    expect(row.campaigns).toBe('0')
    expect(row.runs).toBe('0')
    expect(row.members).toBe('0')
  })

  it('409 world_gen_in_progress when the world is mid-generation', async () => {
    const { ownerSub, campaignId, worldId } = await seedOwnerCampaign(pool, 'generating')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/campaigns/${campaignId}`,
      headers: { 'x-mythrun-dev-sub': ownerSub },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'world_gen_in_progress' })
    expect(res.headers['retry-after']).toBe('30')

    // Nothing deleted.
    const w = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(w.rows[0]?.count).toBe('1')
  })

  it('403 not_campaign_member when caller has no membership row', async () => {
    const { campaignId } = await seedOwnerCampaign(pool, 'complete')
    // Seed an unrelated user as the caller.
    const strangerId = uuidv7()
    const strangerSub = `bypass:stranger-${strangerId.slice(-6)}`
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [strangerId, strangerSub, 'Stranger', `s${strangerId.slice(-6)}`],
    )
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/campaigns/${campaignId}`,
      headers: { 'x-mythrun-dev-sub': strangerSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('403 not_campaign_owner when caller is a player, not the owner', async () => {
    const { campaignId } = await seedOwnerCampaign(pool, 'complete')
    const playerId = uuidv7()
    const playerSub = `bypass:player-${playerId.slice(-6)}`
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [playerId, playerSub, 'Player', `p${playerId.slice(-6)}`],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), campaignId, playerId],
    )
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/campaigns/${campaignId}`,
      headers: { 'x-mythrun-dev-sub': playerSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_owner' })
  })

  it('403 not_campaign_member when the campaignId does not exist (no membership row)', async () => {
    // requireCampaignMember 403s before the handler's own 404 branch fires.
    // That 404 branch exists as a safety net for a race where the membership
    // check passes but the campaign disappears between hook + handler.
    const ownerId = uuidv7()
    const ownerSub = `bypass:owner-${ownerId.slice(-6)}`
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [ownerId, ownerSub, 'Owner', `o${ownerId.slice(-6)}`],
    )
    const ghostCampaignId = uuidv7()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/campaigns/${ghostCampaignId}`,
      headers: { 'x-mythrun-dev-sub': ownerSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })
})
