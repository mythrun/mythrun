// backend/src/routes/__tests__/campaigns-wiki.test.ts
//
// MYT-74c T10: integration tests for GET /api/campaigns/:campaignId/wiki.
//
// Member-readable (every party member, not owner-only). 409 until stage 4
// (entity_relationships) completes. Always the narrow known-tier projection
// — players NEVER get discoverable/secret content, so there is no bypass
// path (unlike the owner-only world-snapshot route). The body's `world`
// summary has NO `concept`, and there are NO proseKernels / statBlocks.
//
// Real Postgres so the campaign-wiki composer's queries run against the
// actual schema; the auth surface is the bypass plugin in NODE_ENV=test
// (mirroring campaigns-snapshot.test.ts's harness shape).

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
import { campaignsRoutes } from '../campaigns.js'
import type { PipelineSubscriber } from '../../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../../sse/connection-counter.js'
import type { WorldGenQueueLike } from '../campaigns.js'
import { entities } from '../../repo/entities.js'
import { facts } from '../../repo/facts.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:campaigns-wiki-${String(Date.now())}:`

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

interface SeedOpts {
  readonly entityRelationshipsStatus?: 'pending' | 'running' | 'completed' | 'failed' | null
}

interface SeededCampaign {
  readonly userId: string
  readonly devSub: string
  readonly worldId: string
  readonly campaignId: string
  readonly known1: string
  readonly known2: string
  readonly secret: string
}

async function seedCampaignWithWiki(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
  opts: SeedOpts = {},
): Promise<SeededCampaign> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const known1 = uuidv7()
  const known2 = uuidv7()
  const secret = uuidv7()

  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, tone, themes, status,
                          era, key_tensions, political_summary,
                          starting_situations, follow_up_questions)
     VALUES ($1, $2, $3, 'A concept long enough for the gate', 't', 'th',
             'generating', 'an era', 'key tensions', 'political secrets',
             'unrevealed starting situation', 'q?')`,
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

  // Entities: two known + one secret.
  await entities.insert(pool, {
    id: known1, worldId, entityType: 'location',
    name: `${scope.id}-k1-${String(index)}`, accessLevel: 'known', createdIn: 'stage:test',
  })
  await entities.insert(pool, {
    id: known2, worldId, entityType: 'faction',
    name: `${scope.id}-k2-${String(index)}`, accessLevel: 'known', createdIn: 'stage:test',
  })
  await entities.insert(pool, {
    id: secret, worldId, entityType: 'npc',
    name: `${scope.id}-sec-${String(index)}`, accessLevel: 'secret', createdIn: 'stage:test',
  })

  // Facts: one known on known1, one secret on the secret entity.
  await facts.insertMany(pool, [
    { entityId: known1, topic: 'a', accessLevel: 'known', content: 'k1-public' },
    { entityId: secret, topic: 'b', accessLevel: 'secret', content: 'secret-hidden' },
  ])

  // Relationship between the two known entities (DB-filterable by listAmong).
  await pool.query(
    `INSERT INTO relationships
       (id, source_entity_id, target_entity_id, relationship_type, description)
     VALUES ($1, $2, $3, 'controls', 'k1 controls k2')`,
    [uuidv7(), known1, known2],
  )

  // Pipeline run for entity_relationships, world-scoped (user_id IS NULL).
  const status = opts.entityRelationshipsStatus
  if (status !== null && status !== undefined) {
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
       VALUES ($1, $2, 'entity_relationships', $3, now(), NULL)`,
      [uuidv7(), worldId, status],
    )
  }

  return { userId: owner.userId, devSub: owner.devSub, worldId, campaignId, known1, known2, secret }
}

async function buildApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
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

describe('GET /api/campaigns/:campaignId/wiki (MYT-74c T10)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('camp-wiki')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    await cleanupTestScope(pool, scope)
    app = await buildApp(pool, redis)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('200 known-tier wiki for a non-owner member; no concept/kernels/statblocks/secrets', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithWiki(pool, scope, owner, 0, {
      entityRelationshipsStatus: 'completed',
    })
    // A non-owner player member with invite accepted reads the wiki.
    const player = await seedUser(pool, scope, 1)
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), seed.campaignId, player.userId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/wiki`,
      headers: { 'x-mythrun-dev-sub': player.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      world: Record<string, unknown>
      entities: { id: string; entityType: string }[]
      facts: { content: string }[]
      relationships: { sourceEntityId: string; targetEntityId: string }[]
      proseKernels?: unknown
      statBlocks?: unknown
    }>()

    // The player wiki's world summary carries NO `concept` (owner-only column).
    expect(body.world.id).toBe(seed.worldId)
    expect(Object.keys(body.world)).not.toContain('concept')

    // No owner-snapshot content leaks onto the player wiki.
    expect(body).not.toHaveProperty('proseKernels')
    expect(body).not.toHaveProperty('statBlocks')

    // Only the two known-tier entities surface; the secret npc is absent.
    expect(body.entities).toHaveLength(2)
    expect(body.entities.map((e) => e.id).sort()).toEqual([seed.known1, seed.known2].sort())
    expect(body.entities.map((e) => e.id)).not.toContain(seed.secret)

    // Only the known-tier fact surfaces; the secret fact is filtered out.
    expect(body.facts).toHaveLength(1)
    expect(body.facts[0]?.content).toBe('k1-public')

    // Known→known relationship surfaces.
    expect(body.relationships).toHaveLength(1)
    expect(body.relationships[0]?.sourceEntityId).toBe(seed.known1)
    expect(body.relationships[0]?.targetEntityId).toBe(seed.known2)
  })

  it('403 not_campaign_member for a non-member', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithWiki(pool, scope, owner, 0, {
      entityRelationshipsStatus: 'completed',
    })
    const stranger = await seedUser(pool, scope, 2)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/wiki`,
      headers: { 'x-mythrun-dev-sub': stranger.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('409 wiki_not_ready when stage 4 (entity_relationships) is not completed', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithWiki(pool, scope, owner, 0, {
      entityRelationshipsStatus: 'pending',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/wiki`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'wiki_not_ready' })
  })
})
