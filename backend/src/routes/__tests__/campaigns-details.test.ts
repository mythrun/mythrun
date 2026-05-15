// backend/src/routes/__tests__/campaigns-details.test.ts
//
// MYT-51 Task 10. Integration tests for GET /api/campaigns/:campaignId.
//
// Member-only campaign-detail surface. Tests cover the happy path
// (member sees campaign + world + member list), 404 for unknown ids,
// and 403 for non-members. Uses the same standalone Fastify harness as
// campaigns-create.test.ts so the dependency surface stays tight.

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
import { campaignsRoutes } from '../campaigns.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'
import type { WorldGenQueueLike } from '../campaigns.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')
const REDIS_KEY_PREFIX = `test:campaigns-details-${String(Date.now())}:`

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
    add: () => Promise.resolve({ id: 'stub' }),
    getJobCounts: () => Promise.resolve({ waiting: 0, active: 0, delayed: 0 }),
    getJob: () => Promise.resolve(null),
  }
}

interface SeededUser {
  readonly userId: string
  readonly devSub: string
}

async function seedUser(pool: Pool, scope: TestScope, index: number): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = scope.userSub(index)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(index), scope.username(index)],
  )
  return { userId, devSub }
}

interface SeededCampaign {
  readonly userId: string
  readonly devSub: string
  readonly worldId: string
  readonly campaignId: string
  readonly campaignName: string
}

async function seedCampaignOwnedBy(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
): Promise<SeededCampaign> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const campaignName = scope.campaignName(index)
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'A long enough concept for the test', 'complete')`,
    [worldId, owner.userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, owner.userId, campaignName],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return { userId: owner.userId, devSub: owner.devSub, worldId, campaignId, campaignName }
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

describe('GET /api/campaigns/:campaignId (MYT-51 T10)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 4 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    scope = makeTestScope('camp-details')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    // myth-5jdo: scoped cleanup replaces blanket DELETEs.
    await cleanupTestScope(pool, scope)
    app = await buildTestApp(pool, redis)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('200 returns campaign + world + member list for the owner', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    // Add a second member to verify the listMembers join works for >1 row.
    const player = await seedUser(pool, scope, 1)
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), seed.campaignId, player.userId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      campaign: { id: string; name: string; worldId: string; status: string }
      world: { id: string; status: string; concept: string }
      members: { userId: string; role: string; username: string }[]
    }>()
    expect(body.campaign.id).toBe(seed.campaignId)
    expect(body.campaign.name).toBe(seed.campaignName)
    expect(body.campaign.worldId).toBe(seed.worldId)
    expect(body.world.id).toBe(seed.worldId)
    expect(body.world.status).toBe('complete')
    expect(body.members).toHaveLength(2)
    const roles = body.members.map((m) => m.role).sort()
    expect(roles).toEqual(['owner', 'player'])
  })

  it('200 also works for a non-owner member', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const player = await seedUser(pool, scope, 1)
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), seed.campaignId, player.userId],
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}`,
      headers: { 'x-mythrun-dev-sub': player.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ campaign: { id: string } }>()
    expect(body.campaign.id).toBe(seed.campaignId)
  })

  it('403 for a user with no membership', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const stranger = await seedUser(pool, scope, 1)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}`,
      headers: { 'x-mythrun-dev-sub': stranger.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('403 for an unknown campaign id (access-control short-circuit)', async () => {
    // requireCampaignMember runs BEFORE the handler, so a missing
    // membership row (which is what an unknown id produces) 403s rather
    // than 404. This mirrors the status route's behavior on unknown ids.
    const owner = await seedUser(pool, scope, 0)
    const unknownId = uuidv7()
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${unknownId}`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })
})
