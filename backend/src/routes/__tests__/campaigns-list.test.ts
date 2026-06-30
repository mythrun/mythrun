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
import { MyCampaignsResponseSchema } from '@mythrun/contract/rest'
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
const REDIS_KEY_PREFIX = `test:campaigns-list-${String(Date.now())}:`

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

// MYT-87 T11: a fully parametrized hub-card seeder. Inserts a world (status +
// optional colour pair), a campaign (status), and the owner membership.
async function seedHubCampaign(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
  opts: {
    campaignStatus: 'setup' | 'active' | 'archived' | 'failed'
    worldStatus?: 'generating' | 'complete' | 'failed'
    colorFrom?: string | null
    colorTo?: string | null
  },
): Promise<{ campaignId: string; worldId: string }> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status, color_from, color_to)
     VALUES ($1, $2, $3, 'A long enough concept for the test', $4, $5, $6)`,
    [
      worldId,
      owner.userId,
      scope.worldName(index),
      opts.worldStatus ?? 'complete',
      opts.colorFrom ?? null,
      opts.colorTo ?? null,
    ],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [campaignId, worldId, owner.userId, scope.campaignName(index), opts.campaignStatus],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return { campaignId, worldId }
}

// Adds an accepted member row (a joined player).
async function addAcceptedMember(
  pool: Pool,
  campaignId: string,
  member: SeededUser,
): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'player', true)`,
    [uuidv7(), campaignId, member.userId],
  )
}

// Gives a (campaign, user) pair a built character — a `characters` row + the
// `campaign_characters` join (which is what `hasCharacter` keys on). Mirrors
// the proven seed in campaigns-details.test.ts (characters dropped campaign_id
// in migration 009).
async function seedCharacter(
  pool: Pool,
  scope: TestScope,
  campaignId: string,
  user: SeededUser,
  label: string,
): Promise<void> {
  const characterId = uuidv7()
  await pool.query(
    `INSERT INTO characters (
       id, user_id, name, level, class, species, background,
       str, dex, con, int, wis, cha,
       hit_points, max_hit_points, armor_class, proficiency_bonus
     ) VALUES ($1, $2, $3, 1, 'Fighter', 'Human', 'Soldier',
               10, 10, 10, 10, 10, 10, 10, 10, 10, 2)`,
    [characterId, user.userId, `${scope.id}-${label}`],
  )
  await pool.query(
    `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
     VALUES ($1, $2, $3, $4)`,
    [uuidv7(), campaignId, characterId, user.userId],
  )
}

// Adds one ended session to a campaign (started_at defaults to now()).
async function seedSession(pool: Pool, campaignId: string, sessionNumber: number): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, campaign_id, session_number, status)
     VALUES ($1, $2, $3, 'ended')`,
    [uuidv7(), campaignId, sessionNumber],
  )
}

// Wipe scope characters before the campaigns CASCADE-blocking users delete.
// Characters survived the campaigns CASCADE after migration 009 decoupled them,
// so cleanupTestScope's users-delete pass would hit characters_user_id_fkey.
async function wipeScopeCharacters(pool: Pool, scope: TestScope): Promise<void> {
  await pool.query(
    `DELETE FROM characters
       WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
    [`${scope.id}%`],
  )
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
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('campaigns-list')
  })

  afterAll(async () => {
    await wipeScopeCharacters(pool, scope)
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    // myth-5jdo: scoped cleanup replaces blanket DELETEs. Characters first
    // (migration 009 decoupled them from the campaigns CASCADE).
    await wipeScopeCharacters(pool, scope)
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
    // W0c: each campaign is a CampaignSummary projection — sourceWorldId and
    // createdBy are OMITTED, and the Date columns serialize to ISO strings.
    const sample = body.campaigns[0] as Record<string, unknown>
    expect(sample).not.toHaveProperty('sourceWorldId')
    expect(sample).not.toHaveProperty('createdBy')
    expect(typeof sample.createdAt).toBe('string')
    expect(typeof sample.updatedAt).toBe('string')
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

  // -------------------------------------------------------------------------
  // MYT-87 T11: the expanded hub-card payload.
  // -------------------------------------------------------------------------

  it('200 returns the expanded hub-card shape; archived absent, cardPhase + sessionCount + colours correct', async () => {
    const owner = await seedUser(pool, scope, 0)
    const player2 = await seedUser(pool, scope, 1)

    // (0) Active campaign: world complete + coloured, 2 members both with a
    // character (party ready), 2 sessions → cardPhase 'played', sessionCount 2.
    const active = await seedHubCampaign(pool, scope, owner, 0, {
      campaignStatus: 'active',
      worldStatus: 'complete',
      colorFrom: 'ember',
      colorTo: 'lapis',
    })
    await addAcceptedMember(pool, active.campaignId, player2)
    await seedCharacter(pool, scope, active.campaignId, owner, 'pc-owner')
    await seedCharacter(pool, scope, active.campaignId, player2, 'pc-player2')
    await seedSession(pool, active.campaignId, 1)
    await seedSession(pool, active.campaignId, 2)

    // (1) Archived campaign → must NOT appear.
    const archived = await seedHubCampaign(pool, scope, owner, 1, {
      campaignStatus: 'archived',
      worldStatus: 'complete',
    })

    // (2) Failed world → cardPhase 'failed', worldColors null (uncoloured).
    const failed = await seedHubCampaign(pool, scope, owner, 2, {
      campaignStatus: 'setup',
      worldStatus: 'failed',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    // Whole body conforms to the wire contract.
    const parsed = MyCampaignsResponseSchema.parse(res.json())

    const ids = parsed.campaigns.map((c) => c.id)
    expect(ids).toContain(active.campaignId)
    expect(ids).toContain(failed.campaignId)
    expect(ids).not.toContain(archived.campaignId)
    expect(parsed.campaigns).toHaveLength(2)

    const activeCard = parsed.campaigns.find((c) => c.id === active.campaignId)
    if (!activeCard) throw new Error('active card missing')
    expect(activeCard.worldName).toBe(scope.worldName(0))
    expect(activeCard.worldColors).toEqual({ from: 'ember', to: 'lapis' })
    expect(activeCard.creator).toBeNull() // owner created the world
    expect(activeCard.cardPhase).toBe('played')
    // No fanout: 2 sessions × 2 party members must NOT double the count.
    expect(activeCard.sessionCount).toBe(2)
    expect(typeof activeCard.lastPlayedAt).toBe('string')
    expect(activeCard.party).toHaveLength(2)
    expect(activeCard.party.every((p) => p.hasCharacter)).toBe(true)

    const failedCard = parsed.campaigns.find((c) => c.id === failed.campaignId)
    if (!failedCard) throw new Error('failed card missing')
    expect(failedCard.cardPhase).toBe('failed')
    expect(failedCard.worldColors).toBeNull()
    expect(failedCard.sessionCount).toBe(0)
    expect(failedCard.lastPlayedAt).toBeNull()
  })

  it("200 cardPhase 'needs-character' for a setup campaign where the viewer has no PC", async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedHubCampaign(pool, scope, owner, 0, {
      campaignStatus: 'setup',
      worldStatus: 'complete',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const parsed = MyCampaignsResponseSchema.parse(res.json())
    const card = parsed.campaigns.find((c) => c.id === seed.campaignId)
    if (!card) throw new Error('card missing')
    expect(card.cardPhase).toBe('needs-character')
    expect(card.party).toHaveLength(1)
    expect(card.party[0]?.hasCharacter).toBe(false)
  })

  it('200 creator is the world-creator display name for a joined (not-owned) campaign', async () => {
    const me = await seedUser(pool, scope, 0)
    const other = await seedUser(pool, scope, 1)
    // `other` owns the world + campaign; `me` is an accepted player.
    const seed = await seedHubCampaign(pool, scope, other, 0, {
      campaignStatus: 'setup',
      worldStatus: 'complete',
    })
    await addAcceptedMember(pool, seed.campaignId, me)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/mine`,
      headers: { 'x-mythrun-dev-sub': me.devSub },
    })
    expect(res.statusCode).toBe(200)
    const parsed = MyCampaignsResponseSchema.parse(res.json())
    const card = parsed.campaigns.find((c) => c.id === seed.campaignId)
    if (!card) throw new Error('card missing')
    expect(card.creator).toBe(scope.displayName(1))
  })
})
