// MYT-74d T4: integration tests for GET /api/campaigns/:campaignId/transcript/search.
// Member-readable FTS lookback over the prose-bearing transcript. Real Postgres;
// bypass auth in NODE_ENV=test.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { campaignsRoutes, type WorldGenQueueLike } from '../campaigns.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'
import {
  cleanupTestScope, makeTestScope, type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:transcript-search-${String(Date.now())}:`

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

interface SeededUser { userId: string; devSub: string }
async function seedUser(pool: Pool, scope: TestScope, i: number): Promise<SeededUser> {
  const userId = uuidv7()
  const devSub = scope.userSub(i)
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(i), scope.username(i)],
  )
  return { userId, devSub }
}

async function seedCampaign(pool: Pool, scope: TestScope, owner: SeededUser, i: number) {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const sessionId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
    [worldId, owner.userId, scope.worldName(i)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, owner.userId, scope.campaignName(i)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status) VALUES ($1, $2, 1, 'ended')`,
    [sessionId, campaignId],
  )
  return { worldId, campaignId, sessionId }
}

async function seedCharacter(
  pool: Pool, campaignId: string, userId: string, name: string,
): Promise<void> {
  const characterId = uuidv7()
  await pool.query(
    `INSERT INTO characters (id, user_id, name, level, class, species, background,
        str, dex, con, int, wis, cha, hit_points, max_hit_points, armor_class, proficiency_bonus)
     VALUES ($1, $2, $3, 1, 'Fighter', 'Human', 'Soldier',
        10, 10, 10, 10, 10, 10, 10, 10, 10, 2)`,
    [characterId, userId, name],
  )
  await pool.query(
    `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
     VALUES ($1, $2, $3, $4)`,
    [uuidv7(), campaignId, characterId, userId],
  )
}

async function insertRow(
  pool: Pool, sessionId: string, seq: number, messageType: string, content: string, userId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO session_messages (id, session_id, seq, user_id, message_type, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv7(), sessionId, seq, userId, messageType, content],
  )
}

async function buildApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignsRoutes, {
    pool, subscriber: noopSubscriber(), counter: noopCounter(),
    redis, redisKeyPrefix: REDIS_KEY_PREFIX, worldGenQueue: noopQueue(),
  })
  await app.ready()
  return app
}

describe('GET /api/campaigns/:campaignId/transcript/search (MYT-74d)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('tsroute')
  })
  afterAll(async () => {
    await cleanupScope()
    await pool.end()
  })
  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    await cleanupScope()
    app = await buildApp(pool, redis)
  })

  // `characters` decoupled from campaigns in migration 009 (no campaign_id),
  // and characters.user_id → users has no ON DELETE CASCADE. So a seeded
  // character survives the campaign CASCADE and would block cleanupTestScope's
  // users delete on characters_user_id_fkey. Wipe the scope's characters first
  // (the campaign_characters join goes via the campaigns CASCADE). Same pattern
  // as campaign-characters.test.ts.
  async function cleanupScope(): Promise<void> {
    await pool.query(
      `DELETE FROM characters
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [`${scope.id}%`],
    )
    await cleanupTestScope(pool, scope)
  }
  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('200 ranked hits with speaker attribution for a member', async () => {
    const owner = await seedUser(pool, scope, 0)
    const c = await seedCampaign(pool, scope, owner, 0)
    await seedCharacter(pool, c.campaignId, owner.userId, 'Bram Ironhide')
    await insertRow(pool, c.sessionId, 0, 'dm_text', 'The harbourmaster guards the ledger.', null)
    await insertRow(pool, c.sessionId, 1, 'player_message', 'I confront the harbourmaster.', owner.userId)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=harbourmaster`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      hits: { messageType: string; speaker: string; snippet: string; sessionNumber: number; seq: number }[]
      query: string
    }>()
    expect(body.query).toBe('harbourmaster')
    expect(body.hits).toHaveLength(2)
    const dm = body.hits.find((h) => h.messageType === 'dm_text')
    const player = body.hits.find((h) => h.messageType === 'player_message')
    expect(dm?.speaker).toBe('DM')
    expect(player?.speaker).toBe('Bram Ironhide')
    expect(body.hits.every((h) => h.snippet.includes('<mark>'))).toBe(true)
  })

  it('attributes a departed author to "Former player", not DM', async () => {
    const owner = await seedUser(pool, scope, 0)
    const departed = await seedUser(pool, scope, 1)
    const c = await seedCampaign(pool, scope, owner, 0)
    await insertRow(pool, c.sessionId, 0, 'player_message', 'I distrust the harbourmaster.', departed.userId)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=harbourmaster`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ hits: { speaker: string }[] }>()
    expect(body.hits[0]?.speaker).toBe('Former player')
  })

  it('400 invalid_query for an empty q', async () => {
    const owner = await seedUser(pool, scope, 0)
    const c = await seedCampaign(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=%20`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('invalid_query')
  })

  it('403 not_campaign_member for a non-member', async () => {
    const owner = await seedUser(pool, scope, 0)
    const stranger = await seedUser(pool, scope, 2)
    const c = await seedCampaign(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${c.campaignId}/transcript/search?q=anything`,
      headers: { 'x-mythrun-dev-sub': stranger.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('200 { hits: [] } for a fresh campaign with no sessions', async () => {
    const owner = await seedUser(pool, scope, 0)
    const worldId = uuidv7(); const campaignId = uuidv7()
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'generating')`,
      [worldId, owner.userId, scope.worldName(5)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, owner.userId, scope.campaignName(5)],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, owner.userId],
    )
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/transcript/search?q=anything`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ hits: unknown[] }>().hits).toEqual([])
  })
})
