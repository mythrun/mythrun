// backend/src/routes/__tests__/campaigns-snapshot.test.ts
//
// myth-exac T20: integration tests for GET
// /api/campaigns/:campaignId/world-snapshot.
//
// Owner-only. 409 until stage 4 (entity_relationships) completes. Bypass
// requires BOTH world.dev_bypass_access_filter=true AND the requester
// being in bypass-auth (defense in depth) — a prod-auth user requesting
// a dev-tool-created world still sees the known-tier projection only.
//
// Real Postgres so the snapshot composer's 7 queries (T19) run against
// the actual schema; the auth surface is the bypass plugin in NODE_ENV=test
// (mirroring campaigns-details.test.ts's harness shape). The defense-in-
// depth case uses a tiny test-only auth plugin that sets request.user
// with scopes=[] — simulating a jwt-mode user without spinning up the
// real jwtPlugin (which needs JWKS plumbing this suite doesn't have).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyPlugin from 'fastify-plugin'
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
import { REGISTERED_DECORATOR } from '../../auth/constants.js'
import type { AuthUser } from '../../auth/types.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:campaigns-snapshot-${String(Date.now())}:`

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

// Test-only auth plugin that simulates a jwt-mode user: same shape as
// bypassPlugin's request.user, but scopes=[] (no 'bypass'). Used to drive
// the defense-in-depth path where world.devBypassAccessFilter=true is
// still narrowed to known-tier because the requester lacks the scope.
// FastifyPluginAsync's signature is async, but this plugin has no inner
// awaits — silence the lint per the same pattern used in campaigns.ts.
function noBypassScopeAuthImpl(
  app: FastifyInstance,
  opts: { readonly sub: string },
): Promise<void> {
  if (app.hasDecorator(REGISTERED_DECORATOR)) {
    throw new Error('noBypassScopeAuth: auth already registered')
  }
  app.decorate(REGISTERED_DECORATOR, 'test-no-bypass' as const)
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.url === undefined) return
    if (request.routeOptions.config.auth === 'public') return
    const user: AuthUser = {
      sub: opts.sub,
      cognitoUsername: 'test_no_bypass',
      scopes: Object.freeze([]),
    }
    request.user = Object.freeze(user)
  })
  return Promise.resolve()
}
const noBypassScopeAuth = fastifyPlugin(noBypassScopeAuthImpl, {
  fastify: '5.x',
  name: 'mythrun-test-no-bypass-scope',
})

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
  readonly devBypassAccessFilter?: boolean
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

async function seedCampaignWithSnapshot(
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
  const bypass = opts.devBypassAccessFilter ?? false

  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, tone, themes, status,
                          dev_bypass_access_filter, era, key_tensions,
                          political_summary, starting_situations,
                          follow_up_questions)
     VALUES ($1, $2, $3, 'A concept long enough for the gate', 't', 'th',
             'generating', $4, 'an era', 'key tensions', 'political secrets',
             'unrevealed starting situation', 'q?')`,
    [worldId, owner.userId, scope.worldName(index), bypass],
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
  // access_level='known' is explicit — migration 031 defaults to 'secret', and
  // the A5 tier filter would otherwise hide this edge from the known reveal.
  await pool.query(
    `INSERT INTO relationships
       (id, source_entity_id, target_entity_id, relationship_type, description, access_level)
     VALUES ($1, $2, $3, 'controls', 'k1 controls k2', 'known')`,
    [uuidv7(), known1, known2],
  )

  // Pipeline run for entity_relationships, world-scoped (user_id IS NULL).
  // status === null means: don't seed the row at all (covers the "no row"
  // case alongside pending / in_progress / failed).
  const status = opts.entityRelationshipsStatus
  if (status !== null && status !== undefined) {
    // Map external test labels to the actual DB enum.
    const dbStatus = status === 'running' ? 'running' : status
    await pool.query(
      `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, user_id)
       VALUES ($1, $2, 'entity_relationships', $3, now(), NULL)`,
      [uuidv7(), worldId, dbStatus],
    )
  }

  return { userId: owner.userId, devSub: owner.devSub, worldId, campaignId, known1, known2, secret }
}

async function buildBypassApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
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

async function buildNoBypassScopeApp(
  pool: Pool,
  redis: Redis,
  sub: string,
): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(noBypassScopeAuth, { sub })
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

describe('GET /api/campaigns/:campaignId/world-snapshot (myth-exac T20)', () => {
  let pool: Pool
  let redis: Redis
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('camp-snapshot')
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
    app = await buildBypassApp(pool, redis)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  // Stage 4 hasn't committed → 409. Covers the four non-completed states:
  // no row at all, pending (seeded but not started), running (in flight),
  // failed (worker errored). All must keep the snapshot endpoint closed.
  it.each<{ label: string; status: 'pending' | 'running' | 'failed' | null }>([
    { label: 'no entity_relationships row exists', status: null },
    { label: 'entity_relationships is pending', status: 'pending' },
    { label: 'entity_relationships is running (in progress)', status: 'running' },
    { label: 'entity_relationships is failed', status: 'failed' },
  ])('409 snapshot_not_ready when $label', async ({ status }) => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithSnapshot(pool, scope, owner, 0, {
      entityRelationshipsStatus: status,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/world-snapshot`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'snapshot_not_ready' })
  })

  it('200 returns the known-tier projection when stage 4 is completed', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithSnapshot(pool, scope, owner, 0, {
      entityRelationshipsStatus: 'completed',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/world-snapshot`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      world: { id: string; name: string }
      entities: { id: string; accessLevel: string }[]
      facts: { content: string }[]
      relationships: { sourceEntityId: string; targetEntityId: string }[]
    }>()

    // WorldSummary allowlist: plot columns must NOT appear on the wire.
    expect(body.world.id).toBe(seed.worldId)
    expect(Object.keys(body.world).sort()).toEqual(
      ['concept', 'era', 'id', 'name', 'themes', 'tone', 'vocabularyRegistry'].sort(),
    )

    // Only the two known-tier entities surface.
    expect(body.entities).toHaveLength(2)
    expect(body.entities.map((e) => e.id).sort()).toEqual([seed.known1, seed.known2].sort())
    expect(body.entities.every((e) => e.accessLevel === 'known')).toBe(true)

    // The secret-tier fact is filtered out (entity isn't in the set).
    expect(body.facts).toHaveLength(1)
    expect(body.facts[0]?.content).toBe('k1-public')

    // Known→known relationship surfaces.
    expect(body.relationships).toHaveLength(1)
    expect(body.relationships[0]?.sourceEntityId).toBe(seed.known1)
    expect(body.relationships[0]?.targetEntityId).toBe(seed.known2)
  })

  it('403 not_campaign_owner for a non-owner member', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithSnapshot(pool, scope, owner, 0, {
      entityRelationshipsStatus: 'completed',
    })
    const player = await seedUser(pool, scope, 1)
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'player', true)`,
      [uuidv7(), seed.campaignId, player.userId],
    )

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/world-snapshot`,
      headers: { 'x-mythrun-dev-sub': player.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_owner' })
  })

  it('403 not_campaign_member for a stranger', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithSnapshot(pool, scope, owner, 0, {
      entityRelationshipsStatus: 'completed',
    })
    const stranger = await seedUser(pool, scope, 2)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/world-snapshot`,
      headers: { 'x-mythrun-dev-sub': stranger.devSub },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'not_campaign_member' })
  })

  it('dev-mode bypass: secret-tier entity + fact surface when bypass-auth + world flag align', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithSnapshot(pool, scope, owner, 0, {
      devBypassAccessFilter: true,
      entityRelationshipsStatus: 'completed',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/world-snapshot`,
      headers: { 'x-mythrun-dev-sub': owner.devSub },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      entities: { id: string; accessLevel: string }[]
      facts: { content: string; accessLevel: string }[]
    }>()

    // All three entities (two known + one secret) surface under bypass.
    expect(body.entities).toHaveLength(3)
    expect(body.entities.map((e) => e.id).sort()).toEqual(
      [seed.known1, seed.known2, seed.secret].sort(),
    )

    // Both facts (known on known1 + secret on the secret entity) surface.
    expect(body.facts).toHaveLength(2)
    const contents = body.facts.map((f) => f.content).sort()
    expect(contents).toEqual(['k1-public', 'secret-hidden'].sort())
  })

  it('defense-in-depth: world flag true but requester lacks bypass scope → known-tier only', async () => {
    // Build a separate app whose auth plugin attaches scopes=[] for the
    // requester. The world still has dev_bypass_access_filter=true.
    await app.close()
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignWithSnapshot(pool, scope, owner, 0, {
      devBypassAccessFilter: true,
      entityRelationshipsStatus: 'completed',
    })
    app = await buildNoBypassScopeApp(pool, redis, owner.devSub)

    const res = await app.inject({
      method: 'GET',
      url: `/api/campaigns/${seed.campaignId}/world-snapshot`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      entities: { id: string; accessLevel: string }[]
      facts: { content: string }[]
    }>()

    // The world flag DOES say "widen access" — but the requester lacks
    // the bypass scope, so we DON'T widen. Only known-tier entities/facts
    // surface; the secret entity + secret fact stay hidden.
    expect(body.entities).toHaveLength(2)
    expect(body.entities.map((e) => e.id).sort()).toEqual([seed.known1, seed.known2].sort())
    expect(body.entities.every((e) => e.accessLevel === 'known')).toBe(true)
    expect(body.facts).toHaveLength(1)
    expect(body.facts[0]?.content).toBe('k1-public')
  })
})
