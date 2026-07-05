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
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:campaigns-details-${String(Date.now())}:`

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
    frontendBaseUrl: 'http://localhost:5173',
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
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('camp-details')
  })

  afterAll(async () => {
    // T20 test inserts a `characters` row owned by a scope user. Characters
    // survived the campaigns CASCADE after migration 009 decoupled them
    // from campaigns, so cleanupTestScope's users-delete pass hits the
    // characters_user_id_fkey RESTRICT FK. Wipe scope characters first;
    // the join table (campaign_characters) is taken out by the campaigns
    // CASCADE that cleanupTestScope already runs.
    await pool.query(
      `DELETE FROM characters
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [`${scope.id}%`],
    )
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    // myth-5jdo: scoped cleanup replaces blanket DELETEs. Same characters-
    // first ordering as afterAll for the T20-introduced characters rows.
    await pool.query(
      `DELETE FROM characters
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [`${scope.id}%`],
    )
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

  // ------------------------------------------------------------------
  // myth-4lhr: PATCH /api/campaigns/:campaignId/name
  // ------------------------------------------------------------------

  it('PATCH /name — 200 owner can rename their campaign', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const newName = `${scope.id}-renamed`
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${seed.campaignId}/name`,
      headers: { 'x-mythrun-dev-sub': owner.devSub, 'content-type': 'application/json' },
      payload: { name: newName },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ campaignId: seed.campaignId, name: newName })

    // DB row reflects the rename.
    const row = await pool.query<{ name: string }>(
      `SELECT name FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.name).toBe(newName)
  })

  it('PATCH /name — 400 invalid_body on missing name', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${seed.campaignId}/name`,
      headers: { 'x-mythrun-dev-sub': owner.devSub, 'content-type': 'application/json' },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('invalid_body')
  })

  it('PATCH /name — 400 invalid_body on empty name (min(1) violation)', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${seed.campaignId}/name`,
      headers: { 'x-mythrun-dev-sub': owner.devSub, 'content-type': 'application/json' },
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH /name — 403 not_campaign_owner when a player attempts the rename', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const player = await seedUser(pool, scope, 1)
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), seed.campaignId, player.userId],
    )
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${seed.campaignId}/name`,
      headers: { 'x-mythrun-dev-sub': player.devSub, 'content-type': 'application/json' },
      payload: { name: `${scope.id}-attempted-rename` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')

    // DB row is unchanged.
    const row = await pool.query<{ name: string }>(
      `SELECT name FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.name).toBe(seed.campaignName)
  })

  it('PATCH /name — 403 not_campaign_member for a stranger', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const stranger = await seedUser(pool, scope, 2)
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${seed.campaignId}/name`,
      headers: { 'x-mythrun-dev-sub': stranger.devSub, 'content-type': 'application/json' },
      payload: { name: `${scope.id}-stranger-rename` },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
  })

  // ------------------------------------------------------------------
  // MYT-53 T20: GET /api/campaigns/:campaignId now returns a
  // `characters[]` field listing each completed concept's persisted PC.
  // The field is always present (empty array when no concepts have
  // finished). Joins character_concepts.status='completed' to
  // campaign_characters to characters and projects userId / characterId
  // / name / class / level.
  // ------------------------------------------------------------------

  it('GET /:campaignId — characters: [] when no completed concepts', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      characters: { userId: string; characterId: string; name: string; class: string; level: number }[]
    }>()
    expect(body.characters).toEqual([])
  })

  it('GET /:campaignId — characters[] surfaces a completed concept + its persisted PC', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)

    // Concept + persisted character for the owner.
    const characterId = uuidv7()
    await pool.query(
      `INSERT INTO characters (
         id, user_id, name, level, class, species, background,
         str, dex, con, int, wis, cha,
         hit_points, max_hit_points, armor_class, proficiency_bonus
       ) VALUES ($1, $2, $3, 4, 'Rogue', 'Halfling', 'Urchin',
                 10, 16, 12, 12, 12, 10, 22, 22, 14, 2)`,
      [characterId, owner.userId, `${scope.id}-Mira`],
    )
    await pool.query(
      `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
       VALUES ($1, $2, $3, $4)`,
      [uuidv7(), seed.campaignId, characterId, owner.userId],
    )
    await pool.query(
      `INSERT INTO character_concepts (
         id, campaign_id, user_id, concept_text,
         situation_grounding_text, guided_choices, status
       ) VALUES ($1, $2, $3, 'a sharp-tongued thief running from a past life',
                 'arrived at the tavern chasing a rumor of a fence',
                 '{}'::jsonb, 'completed')`,
      [uuidv7(), seed.campaignId, owner.userId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      characters: { userId: string; characterId: string; name: string; class: string; level: number }[]
    }>()
    expect(body.characters).toHaveLength(1)
    expect(body.characters[0]).toEqual({
      userId: owner.userId,
      characterId,
      name: `${scope.id}-Mira`,
      class: 'Rogue',
      level: 4,
    })
  })

  it("GET /:campaignId — characters[] surfaces an 'integrated' concept (MYT-54 T14)", async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    const characterId = uuidv7()
    await pool.query(
      `INSERT INTO characters (
         id, user_id, name, level, class, species, background,
         str, dex, con, int, wis, cha,
         hit_points, max_hit_points, armor_class, proficiency_bonus
       ) VALUES ($1, $2, $3, 4, 'Wizard', 'Elf', 'Sage',
                 10, 14, 12, 18, 14, 10, 18, 18, 13, 2)`,
      [characterId, owner.userId, `${scope.id}-Eladrin`],
    )
    await pool.query(
      `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
       VALUES ($1, $2, $3, $4)`,
      [uuidv7(), seed.campaignId, characterId, owner.userId],
    )
    // status='integrated' — the MYT-54 terminal state after cross-PC integration.
    await pool.query(
      `INSERT INTO character_concepts (
         id, campaign_id, user_id, concept_text,
         situation_grounding_text, guided_choices, status
       ) VALUES ($1, $2, $3, 'a scholar of forgotten magics with a tense bond to the high council',
                 'summoned to the tavern by a sealed letter',
                 '{}'::jsonb, 'integrated')`,
      [uuidv7(), seed.campaignId, owner.userId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      characters: { userId: string; characterId: string; name: string }[]
    }>()
    expect(body.characters).toHaveLength(1)
    expect(body.characters[0]?.userId).toBe(owner.userId)
    expect(body.characters[0]?.name).toBe(`${scope.id}-Eladrin`)
  })
})
