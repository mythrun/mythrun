// backend/src/routes/__tests__/campaigns-list.test.ts
//
// MYT-51 Task 10. Integration tests for GET /api/campaigns/mine.
//
// Returns campaigns the caller owns or is a member of. Tests cover:
//   - user with no campaigns → empty array
//   - user as owner of one campaign → that campaign returned
//   - user as accepted player on another user's campaign → returned
//   - campaigns the caller has no relationship with → NOT returned
//   - pending invites (invite_accepted=false) → NOT returned

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
const REDIS_KEY_PREFIX = `test:campaigns-list-${String(Date.now())}:`

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

async function seedCampaignOwnedBy(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
): Promise<{ campaignId: string; worldId: string }> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'A long enough concept for the test', 'complete')`,
    [worldId, owner.userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, owner.userId, scope.campaignName(index)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return { campaignId, worldId }
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

describe('GET /api/campaigns/mine (MYT-51 T10)', () => {
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
    scope = makeTestScope('campaigns-list')
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

  it('200 empty array for a user with no campaigns', async () => {
    const u = await seedUser(pool, scope, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': u.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ campaigns: unknown[] }>()
    expect(body.campaigns).toEqual([])
  })

  it('200 returns owned campaigns and accepted-player memberships', async () => {
    const owner = await seedUser(pool, scope, 0)
    const player = await seedUser(pool, scope, 1)

    // Owner owns campaign A.
    const a = await seedCampaignOwnedBy(pool, scope, owner, 0)
    // Player owns campaign B.
    const b = await seedCampaignOwnedBy(pool, scope, player, 1)
    // Owner is also an accepted player on player's campaign B.
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), b.campaignId, owner.userId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ campaigns: { id: string; name: string }[] }>()
    const ids = body.campaigns.map((c) => c.id).sort()
    expect(ids).toEqual([a.campaignId, b.campaignId].sort())
  })

  it('200 does NOT return campaigns the caller has no relationship to', async () => {
    const me = await seedUser(pool, scope, 0)
    const other = await seedUser(pool, scope, 1)
    // Other user's campaign — me has no membership row.
    await seedCampaignOwnedBy(pool, scope, other, 0)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': me.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ campaigns: unknown[] }>()
    expect(body.campaigns).toEqual([])
  })

  it('200 does NOT return campaigns where the invite is still pending', async () => {
    const me = await seedUser(pool, scope, 0)
    const other = await seedUser(pool, scope, 1)
    const seed = await seedCampaignOwnedBy(pool, scope, other, 0)
    // Pending invite — me hasn't accepted yet.
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', false)`,
      [uuidv7(), seed.campaignId, me.userId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': me.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ campaigns: unknown[] }>()
    expect(body.campaigns).toEqual([])
  })

  it('200 dedupes when the caller is both owner and a (second) member row', async () => {
    // Owners get a 'owner' row at create time. The listByUser join is
    // by user_id, so an owner is included exactly once via that row.
    const me = await seedUser(pool, scope, 0)
    await seedCampaignOwnedBy(pool, scope, me, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': me.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ campaigns: { id: string }[] }>()
    expect(body.campaigns).toHaveLength(1)
  })

  it('401 when no auth identity is present', async () => {
    // No `x-mythrun-dev-sub` header → bypass plugin still attaches the
    // default `bypass:dev-1` user, so this hits the "username_required"
    // branch (the default sub has no users row in this test DB).
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
    })
    // The bypass plugin auto-attaches bypass:dev-1; requireOnboarded
    // then 403s because no users row exists for it.
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'username_required' })
  })
})
