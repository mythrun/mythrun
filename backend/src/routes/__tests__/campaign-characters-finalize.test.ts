// backend/src/routes/__tests__/campaign-characters-finalize.test.ts
//
// MYT-54 T13. Integration tests for the owner-only fan-in trigger:
//
//   POST /api/campaigns/:campaignId/finalize-character-creation
//
// Body: { pre_integration_notes: string | null } (optional, ≤ 4000).
// 202 on success — flips campaigns.pre_integration_notes, enqueues a
// singleton `ci-${campaignId}` BullMQ job on `campaign-setup` with name
// 'character-integration'. The T11 processor (campaign-scoped) picks
// it up and runs the T10 handler.
//
// Pattern mirrors campaign-characters.test.ts (T13's sibling
// /start-character-creation). The character-creation queue is a
// `vi.fn()` spy whose default resolves; queue undefined exercises the
// 503 'queue_not_ready' gate.
//
// Test scopes are isolated via `makeTestScope('cc-final')` so this file
// can run in parallel with campaign-characters.test.ts /
// campaign-characters-progress.test.ts without cross-pollination on
// shared users/campaigns rows.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import {
  campaignCharactersPlugin,
  type CharacterCreationJobData,
  type CharacterCreationQueueLike,
} from '../campaign-characters.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

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
}

// Seed (world, campaign, owner-membership). campaignStatus defaults to
// 'setup' so the happy path runs without extra mutation; the
// not_in_setup test passes 'active' explicitly.
async function seedCampaignOwnedBy(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
  campaignStatus: 'setup' | 'active' | 'archived' = 'setup',
): Promise<SeededCampaign> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'A long enough concept for the test', 'complete')`,
    [worldId, owner.userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [campaignId, worldId, owner.userId, scope.campaignName(index), campaignStatus],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return { userId: owner.userId, devSub: owner.devSub, worldId, campaignId }
}

async function addMember(
  pool: Pool,
  campaignId: string,
  user: SeededUser,
  role: 'owner' | 'player' = 'player',
): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, $4, true)`,
    [uuidv7(), campaignId, user.userId, role],
  )
}

// Insert a character_concepts row with explicit status. The finalize
// guard requires at least one 'completed' row; the no_completed_concepts
// test seeds 'submitted' / 'processing' to verify the guard fires.
async function insertConcept(
  pool: Pool,
  campaignId: string,
  userId: string,
  status: 'submitted' | 'processing' | 'completed' | 'failed' | 'integrated' = 'completed',
): Promise<string> {
  const id = uuidv7()
  await pool.query(
    `INSERT INTO character_concepts (
       id, campaign_id, user_id, concept_text,
       situation_grounding_text, guided_choices, status
     )
     VALUES ($1, $2, $3, 'a road-weary cleric who lost their faith',
             'arrived seeking word of an old companion',
             '{}'::jsonb, $4)`,
    [id, campaignId, userId, status],
  )
  return id
}

interface QueueSpy {
  readonly queue: CharacterCreationQueueLike
  readonly add: ReturnType<typeof vi.fn>
}

function createQueueSpy(): QueueSpy {
  const add = vi.fn().mockResolvedValue({ id: 'stub-job' })
  const queue: CharacterCreationQueueLike = {
    add: (
      name: 'character-creation' | 'character-integration',
      data: CharacterCreationJobData,
      opts?: { jobId?: string },
    ): Promise<unknown> => add(name, data, opts) as Promise<unknown>,
  }
  return { queue, add }
}

async function buildTestApp(
  pool: Pool,
  queue?: CharacterCreationQueueLike,
): Promise<FastifyInstance> {
  // bypassPlugin probes the ECS metadata endpoint and requires it to FAIL —
  // replace fetch with a guaranteed-reject stub.
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(campaignCharactersPlugin, {
    pool,
    characterCreationQueue: queue,
  })
  await app.ready()
  return app
}

describe('POST /api/campaigns/:campaignId/finalize-character-creation (MYT-54 T13)', () => {
  let pool: Pool
  let app: FastifyInstance
  let queueSpy: QueueSpy
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    // Short label so the username variant fits in the 28-char .slice() —
    // longer labels truncate the trailing `uN` index and collide all users.
    scope = makeTestScope('cc-final')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    await cleanupTestScope(pool, scope)
    queueSpy = createQueueSpy()
    app = await buildTestApp(pool, queueSpy.queue)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('202 — owner POSTs with notes; jobId=ci-<id>, column set, queue.add called once', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const notes = 'Player A and Player B are siblings.'
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: { pre_integration_notes: notes },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({
      campaignId: seed.campaignId,
      jobId: `ci-${seed.campaignId}`,
    })

    const row = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.pre_integration_notes).toBe(notes)

    expect(queueSpy.add).toHaveBeenCalledTimes(1)
    const [name, data, jobOpts] = queueSpy.add.mock.calls[0] as [
      string,
      { campaignId: string; ownerUserId: string },
      { jobId: string },
    ]
    expect(name).toBe('character-integration')
    expect(data).toEqual({ campaignId: seed.campaignId, ownerUserId: owner.userId })
    expect(jobOpts.jobId).toBe(`ci-${seed.campaignId}`)
  })

  it('202 — empty string in body normalizes pre_integration_notes to NULL', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: { pre_integration_notes: '' },
    })
    expect(res.statusCode).toBe(202)

    const row = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.pre_integration_notes).toBeNull()
  })

  it('202 — missing pre_integration_notes (empty body) normalizes to NULL', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: {},
    })
    expect(res.statusCode).toBe(202)
    expect(queueSpy.add).toHaveBeenCalledTimes(1)

    const row = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.pre_integration_notes).toBeNull()
  })

  it('202 — explicit null in body persists NULL', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: { pre_integration_notes: null },
    })
    expect(res.statusCode).toBe(202)

    const row = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.pre_integration_notes).toBeNull()
  })

  it('403 not_campaign_member — stranger (not a member at all)', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')
    const stranger = await seedUser(pool, scope, 1)

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': stranger.devSub },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    expect(queueSpy.add).not.toHaveBeenCalled()
  })

  it('403 not_campaign_owner — non-owner member (player role)', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')
    const player = await seedUser(pool, scope, 1)
    await addMember(pool, seed.campaignId, player, 'player')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': player.devSub },
      payload: {},
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')
    expect(queueSpy.add).not.toHaveBeenCalled()
  })

  it("409 not_in_setup — campaign already at status='active'", async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0, 'active')
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('not_in_setup')
    expect(queueSpy.add).not.toHaveBeenCalled()

    // pre_integration_notes was NOT written (transaction rolled back).
    const row = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.pre_integration_notes).toBeNull()
  })

  it("409 not_in_setup — campaign at status='archived'", async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0, 'archived')
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('not_in_setup')
  })

  it('409 no_completed_concepts — zero completed concepts (only submitted/processing)', async () => {
    const owner = await seedUser(pool, scope, 0)
    const p1 = await seedUser(pool, scope, 1)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await addMember(pool, seed.campaignId, p1, 'player')
    await insertConcept(pool, seed.campaignId, owner.userId, 'submitted')
    await insertConcept(pool, seed.campaignId, p1.userId, 'processing')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: { pre_integration_notes: 'should be discarded by rollback' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('no_completed_concepts')
    expect(queueSpy.add).not.toHaveBeenCalled()

    // pre_integration_notes was rolled back too — must NOT persist on the 409.
    const row = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.pre_integration_notes).toBeNull()
  })

  it('409 no_completed_concepts — campaign has zero character_concepts rows', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    // No concepts seeded at all.

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('no_completed_concepts')
  })

  it('400 bad_body — pre_integration_notes exceeds 4000 chars', async () => {
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const tooLong = 'x'.repeat(4001)
    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: { pre_integration_notes: tooLong },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ code: string }>().code).toBe('bad_body')
    expect(queueSpy.add).not.toHaveBeenCalled()
  })

  it('503 queue_not_ready — when characterCreationQueue is undefined', async () => {
    // Rebuild the app without a queue.
    await app.close()
    app = await buildTestApp(pool, undefined)
    const owner = await seedUser(pool, scope, 0)
    const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
    await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

    const res = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${seed.campaignId}/finalize-character-creation`,
      headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
      payload: {},
    })
    expect(res.statusCode).toBe(503)
    expect(res.json<{ code: string }>().code).toBe('queue_not_ready')

    // No write happened either — queue gate is before the transaction
    // for this route (no rollback needed).
    const row = await pool.query<{ pre_integration_notes: string | null }>(
      `SELECT pre_integration_notes FROM campaigns WHERE id = $1`,
      [seed.campaignId],
    )
    expect(row.rows[0]?.pre_integration_notes).toBeNull()
  })
})
