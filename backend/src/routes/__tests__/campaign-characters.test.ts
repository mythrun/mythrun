// backend/src/routes/__tests__/campaign-characters.test.ts
//
// MYT-53 T12 / T13 / T14. Integration tests for the three owner-only
// state-mutating routes that live in the `campaignCharactersPlugin`:
//
//   - POST /api/campaigns/:campaignId/starting-situation
//   - POST /api/campaigns/:campaignId/start-character-creation
//   - POST /api/campaigns/:campaignId/archive
//
// Pattern mirrors campaigns-details.test.ts: real Postgres (so the
// FK + CHECK constraints fire genuinely), bypass auth plugin +
// requireOnboarded so `request.dbUser` is populated for the
// access-control middleware, raw-INSERT fixtures keyed off TestScope
// so parallel test files don't collide.
//
// The character-creation queue is a `vi.fn()` spy whose default
// resolves; T13 tests override the spy's behavior per-test to drive
// the rollback / partial-enqueue paths.

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

// Seed a (world, campaign, owner-membership) triple. World status default
// `'complete'` so the T12 happy path runs without extra mutation; tests
// that need 'generating' explicitly downgrade the world via raw UPDATE.
async function seedCampaignOwnedBy(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
  worldStatus: 'generating' | 'complete' | 'failed' = 'complete',
  campaignStatus: 'setup' | 'active' | 'archived' = 'setup',
): Promise<SeededCampaign> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'A long enough concept for the test', $4)`,
    [worldId, owner.userId, scope.worldName(index), worldStatus],
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

// Add a non-owner member to an existing campaign.
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

// Insert a character_concepts row directly. Status defaults to 'submitted'
// so T13 happy-path fixtures don't need to specify it; T12 lock tests
// override status to 'processing'.
async function insertConcept(
  pool: Pool,
  campaignId: string,
  userId: string,
  status: 'submitted' | 'processing' | 'completed' | 'failed' = 'submitted',
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

describe('campaignCharactersPlugin (MYT-53 T12/T13/T14)', () => {
  let pool: Pool
  let app: FastifyInstance
  let queueSpy: QueueSpy
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    // Short label so the username variant fits in the 28-char .slice() —
    // longer labels truncate the trailing `uN` index and collide all users.
    scope = makeTestScope('cc-routes')
  })

  afterAll(async () => {
    // Same FK ordering as beforeEach — `characters` first, then scope.
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
    // T17 inserts `characters` rows owned by scope users. Those rows
    // survive the campaign CASCADE (characters decoupled from campaigns
    // in migration 009), so cleanupTestScope's users-delete pass would
    // hit the characters_user_id_fkey RESTRICT FK. Wipe the scope's
    // characters first; the join table (campaign_characters) goes via
    // the campaigns CASCADE that cleanupTestScope already runs.
    await pool.query(
      `DELETE FROM characters
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
      [`${scope.id}%`],
    )
    await cleanupTestScope(pool, scope)
    queueSpy = createQueueSpy()
    app = await buildTestApp(pool, queueSpy.queue)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  // ======================================================================
  // T12: POST /api/campaigns/:campaignId/starting-situation
  // ======================================================================
  describe('POST /starting-situation (T12)', () => {
    it('200 — owner picks an index; campaigns row is updated', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { index: 1 },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ index: 1 })

      const row = await pool.query<{ starting_situation_index: number | null }>(
        `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
        [seed.campaignId],
      )
      expect(row.rows[0]?.starting_situation_index).toBe(1)
    })

    it('403 — non-member', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': stranger.devSub },
        payload: { index: 0 },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })

    it('403 — non-owner member (player role)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, seed.campaignId, player, 'player')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': player.devSub },
        payload: { index: 0 },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')
    })

    it("409 world_not_complete when worlds.status != 'complete'", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0, 'generating')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { index: 0 },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('world_not_complete')
    })

    it('409 situation_locked — at least one concept is processing/completed', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await insertConcept(pool, seed.campaignId, owner.userId, 'processing')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { index: 2 },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('situation_locked')
    })

    it('400 bad_body — index=3 (out of range)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { index: 3 },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('bad_body')
    })

    it('400 bad_body — index=-1', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { index: -1 },
      })
      expect(res.statusCode).toBe(400)
    })

    it('400 bad_body — missing index', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/starting-situation`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(400)
    })
  })

  // ======================================================================
  // T13: POST /api/campaigns/:campaignId/start-character-creation
  // ======================================================================
  describe('POST /start-character-creation (T13)', () => {
    it('200 — fans out 3 submitters: queue called 3x, all flipped to processing', async () => {
      const owner = await seedUser(pool, scope, 0)
      const p1 = await seedUser(pool, scope, 1)
      const p2 = await seedUser(pool, scope, 2)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await addMember(pool, seed.campaignId, p1, 'player')
      await addMember(pool, seed.campaignId, p2, 'player')
      // Owner has picked the starting situation.
      await pool.query(
        `UPDATE campaigns SET starting_situation_index = 1 WHERE id = $1`,
        [seed.campaignId],
      )
      await insertConcept(pool, seed.campaignId, owner.userId)
      await insertConcept(pool, seed.campaignId, p1.userId)
      await insertConcept(pool, seed.campaignId, p2.userId)

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/start-character-creation`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ enqueued: { userId: string; jobId: string }[] }>()
      expect(body.enqueued).toHaveLength(3)
      const enqueuedUserIds = body.enqueued.map((e) => e.userId).sort()
      expect(enqueuedUserIds).toEqual([owner.userId, p1.userId, p2.userId].sort())
      // jobId shape: cc-<campaignId>-<userId>
      for (const e of body.enqueued) {
        expect(e.jobId).toBe(`cc-${seed.campaignId}-${e.userId}`)
      }

      // Queue was called 3x with the right shape.
      expect(queueSpy.add).toHaveBeenCalledTimes(3)
      for (const call of queueSpy.add.mock.calls) {
        const [name, data, opts] = call as [
          string,
          { campaignId: string; userId: string },
          { jobId: string },
        ]
        expect(name).toBe('character-creation')
        expect(data.campaignId).toBe(seed.campaignId)
        expect(opts.jobId).toBe(`cc-${seed.campaignId}-${data.userId}`)
      }

      // All 3 concept rows are now 'processing'.
      const rows = await pool.query<{ status: string }>(
        `SELECT status FROM character_concepts WHERE campaign_id = $1`,
        [seed.campaignId],
      )
      expect(rows.rows).toHaveLength(3)
      for (const r of rows.rows) expect(r.status).toBe('processing')
    })

    it('503 queue_not_ready when characterCreationQueue is undefined', async () => {
      // Replace the test app with one that has no queue.
      await app.close()
      app = await buildTestApp(pool, undefined)
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await pool.query(
        `UPDATE campaigns SET starting_situation_index = 0 WHERE id = $1`,
        [seed.campaignId],
      )
      await insertConcept(pool, seed.campaignId, owner.userId)

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/start-character-creation`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(503)
      expect(res.json<{ code: string }>().code).toBe('queue_not_ready')
    })

    it('409 starting_situation_not_chosen when starting_situation_index is NULL', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await insertConcept(pool, seed.campaignId, owner.userId)

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/start-character-creation`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('starting_situation_not_chosen')
    })

    it("409 no_submitters when no rows are in 'submitted' state", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await pool.query(
        `UPDATE campaigns SET starting_situation_index = 0 WHERE id = $1`,
        [seed.campaignId],
      )
      // No concept rows at all — flipAll returns []
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/start-character-creation`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('no_submitters')
      // Queue not touched.
      expect(queueSpy.add).not.toHaveBeenCalled()
    })

    it('rollback on enqueue throw — second .add() throws, ALL rows remain submitted', async () => {
      const owner = await seedUser(pool, scope, 0)
      const p1 = await seedUser(pool, scope, 1)
      const p2 = await seedUser(pool, scope, 2)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await addMember(pool, seed.campaignId, p1, 'player')
      await addMember(pool, seed.campaignId, p2, 'player')
      await pool.query(
        `UPDATE campaigns SET starting_situation_index = 0 WHERE id = $1`,
        [seed.campaignId],
      )
      await insertConcept(pool, seed.campaignId, owner.userId)
      await insertConcept(pool, seed.campaignId, p1.userId)
      await insertConcept(pool, seed.campaignId, p2.userId)

      // Throw on the 2nd call only.
      let callCount = 0
      queueSpy.add.mockImplementation(() => {
        callCount += 1
        if (callCount === 2) return Promise.reject(new Error('queue exploded'))
        return Promise.resolve({ id: 'stub' })
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/start-character-creation`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(500)

      // All 3 rows are back to 'submitted' (transaction rolled back).
      const rows = await pool.query<{ status: string }>(
        `SELECT status FROM character_concepts WHERE campaign_id = $1`,
        [seed.campaignId],
      )
      expect(rows.rows).toHaveLength(3)
      for (const r of rows.rows) expect(r.status).toBe('submitted')
    })

    it('idempotent re-call: first run enqueues 2, then a 3rd submitter shows up; second run enqueues only that one', async () => {
      const owner = await seedUser(pool, scope, 0)
      const p1 = await seedUser(pool, scope, 1)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await addMember(pool, seed.campaignId, p1, 'player')
      await pool.query(
        `UPDATE campaigns SET starting_situation_index = 0 WHERE id = $1`,
        [seed.campaignId],
      )
      await insertConcept(pool, seed.campaignId, owner.userId)
      await insertConcept(pool, seed.campaignId, p1.userId)

      const res1 = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/start-character-creation`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res1.statusCode).toBe(200)
      expect(res1.json<{ enqueued: unknown[] }>().enqueued).toHaveLength(2)
      expect(queueSpy.add).toHaveBeenCalledTimes(2)

      // A late-joiner submits.
      const p2 = await seedUser(pool, scope, 2)
      await addMember(pool, seed.campaignId, p2, 'player')
      await insertConcept(pool, seed.campaignId, p2.userId)

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/start-character-creation`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res2.statusCode).toBe(200)
      const body2 = res2.json<{ enqueued: { userId: string }[] }>()
      expect(body2.enqueued).toHaveLength(1)
      expect(body2.enqueued[0]?.userId).toBe(p2.userId)
      expect(queueSpy.add).toHaveBeenCalledTimes(3)
    })
  })

  // ======================================================================
  // T14: POST /api/campaigns/:campaignId/archive
  // ======================================================================
  describe('POST /archive (T14)', () => {
    it("200 — archives a 'setup' campaign", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0, 'complete', 'setup')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/archive`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'archived' })

      const row = await pool.query<{ status: string }>(
        `SELECT status FROM campaigns WHERE id = $1`,
        [seed.campaignId],
      )
      expect(row.rows[0]?.status).toBe('archived')
    })

    it("200 — archives an 'active' campaign", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0, 'complete', 'active')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/archive`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'archived' })
    })

    it('409 cannot_archive — already archived', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0, 'complete', 'archived')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/archive`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('cannot_archive')
    })

    it('403 not_campaign_owner — non-owner member', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, seed.campaignId, player, 'player')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/archive`,
        headers: { 'x-mythrun-dev-sub': player.devSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')
    })
  })

  // ======================================================================
  // T15: POST /api/campaigns/:campaignId/characters
  //
  // Any member (owner OR player) can submit. Route guards:
  //   400 bad_body                       — Zod parse fail
  //   400 concept_or_guided_required     — neither field non-empty
  //   404 campaign_not_found             — no campaigns row
  //   409 world_not_complete             — worlds.status != 'complete'
  //   409 starting_situation_not_chosen  — campaigns.starting_situation_index NULL
  //   409 concept_locked                 — existing row in 'processing'/'completed'
  //   200 { conceptId, status }          — UPSERT
  // ======================================================================
  describe('POST /characters (T15)', () => {
    // Seed a campaign with the starting situation already chosen so happy-path
    // tests don't have to do it inline. Returns the standard SeededCampaign.
    async function seedCampaignWithSituation(
      owner: SeededUser,
      index = 0,
      situationIndex = 1,
    ): Promise<SeededCampaign> {
      const seed = await seedCampaignOwnedBy(pool, scope, owner, index)
      await pool.query(
        `UPDATE campaigns SET starting_situation_index = $2 WHERE id = $1`,
        [seed.campaignId, situationIndex],
      )
      return seed
    }

    const longConcept = 'a road-weary cleric who lost their faith long ago'
    const longGrounding = 'arrived at the tavern seeking word of an old companion'

    it('200 — owner submits with both texts; returns conceptId + status=submitted', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignWithSituation(owner)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {
          conceptText: longConcept,
          situationGroundingText: longGrounding,
        },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ conceptId: string; status: string }>()
      expect(body.status).toBe('submitted')
      expect(body.conceptId).toMatch(/^[0-9a-f-]{36}$/i)

      const row = await pool.query<{ id: string; concept_text: string; status: string }>(
        `SELECT id, concept_text, status FROM character_concepts
         WHERE campaign_id = $1 AND user_id = $2`,
        [seed.campaignId, owner.userId],
      )
      expect(row.rows[0]?.id).toBe(body.conceptId)
      expect(row.rows[0]?.concept_text).toBe(longConcept)
      expect(row.rows[0]?.status).toBe('submitted')
    })

    it('200 — player (non-owner) submits successfully', async () => {
      const owner = await seedUser(pool, scope, 0)
      const player = await seedUser(pool, scope, 1)
      const seed = await seedCampaignWithSituation(owner)
      await addMember(pool, seed.campaignId, player, 'player')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': player.devSub },
        payload: {
          conceptText: longConcept,
          situationGroundingText: longGrounding,
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ status: string }>().status).toBe('submitted')
    })

    it("200 — re-POST while status='submitted' UPSERTs the row (same conceptId, refreshed text)", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignWithSituation(owner)
      const first = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: longConcept, situationGroundingText: longGrounding },
      })
      expect(first.statusCode).toBe(200)
      const firstId = first.json<{ conceptId: string }>().conceptId

      const newConcept = 'a curious tinker with too many keys on their belt loop'
      const second = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: newConcept, situationGroundingText: longGrounding },
      })
      expect(second.statusCode).toBe(200)
      expect(second.json<{ conceptId: string; status: string }>()).toEqual({
        conceptId: firstId,
        status: 'submitted',
      })

      const row = await pool.query<{ concept_text: string }>(
        `SELECT concept_text FROM character_concepts WHERE id = $1`,
        [firstId],
      )
      expect(row.rows[0]?.concept_text).toBe(newConcept)
    })

    it("200 — re-POST after status='failed' resets row to 'submitted'", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignWithSituation(owner)
      await insertConcept(pool, seed.campaignId, owner.userId, 'failed')

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: longConcept, situationGroundingText: longGrounding },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ status: string }>().status).toBe('submitted')
    })

    it("409 concept_locked when existing status='processing'", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignWithSituation(owner)
      await insertConcept(pool, seed.campaignId, owner.userId, 'processing')

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: longConcept, situationGroundingText: longGrounding },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('concept_locked')
    })

    it("409 concept_locked when existing status='completed'", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignWithSituation(owner)
      await insertConcept(pool, seed.campaignId, owner.userId, 'completed')

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: longConcept, situationGroundingText: longGrounding },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('concept_locked')
    })

    it('409 starting_situation_not_chosen when index is NULL', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: longConcept, situationGroundingText: longGrounding },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('starting_situation_not_chosen')
    })

    it("409 world_not_complete when worlds.status != 'complete'", async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0, 'generating')
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: longConcept, situationGroundingText: longGrounding },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('world_not_complete')
    })

    it('400 bad_body when conceptText is missing (Zod required-field violation)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignWithSituation(owner)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { situationGroundingText: longGrounding },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('bad_body')
    })

    it('400 bad_body when situationGroundingText is < 20 chars', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignWithSituation(owner)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { conceptText: longConcept, situationGroundingText: 'too short' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('bad_body')
    })

    it('403 not_campaign_member — stranger', async () => {
      const owner = await seedUser(pool, scope, 0)
      const stranger = await seedUser(pool, scope, 1)
      const seed = await seedCampaignWithSituation(owner)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': stranger.devSub },
        payload: { conceptText: longConcept, situationGroundingText: longGrounding },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })
  })

  // ======================================================================
  // T16: GET /api/campaigns/:campaignId/starting-situations
  // ======================================================================
  describe('GET /starting-situations (T16)', () => {
    const sampleEntries = [
      { index: 0, locationEntityId: '00000000-0000-0000-0000-000000000001', prose: 'A rainy port.' },
      { index: 1, locationEntityId: '00000000-0000-0000-0000-000000000002', prose: 'A dusty crossroads.' },
      { index: 2, locationEntityId: '00000000-0000-0000-0000-000000000003', prose: 'An abandoned shrine.' },
    ]

    it('200 — 3 entries + chosenIndex (when set)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await pool.query(
        `UPDATE worlds SET starting_situation_entries = $2::jsonb WHERE id = $1`,
        [seed.worldId, JSON.stringify(sampleEntries)],
      )
      await pool.query(
        `UPDATE campaigns SET starting_situation_index = 2 WHERE id = $1`,
        [seed.campaignId],
      )

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/starting-situations`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ situations: sampleEntries, chosenIndex: 2 })
    })

    it('200 — 3 entries + chosenIndex=null when not yet picked', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await pool.query(
        `UPDATE worlds SET starting_situation_entries = $2::jsonb WHERE id = $1`,
        [seed.worldId, JSON.stringify(sampleEntries)],
      )

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/starting-situations`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ situations: sampleEntries, chosenIndex: null })
    })

    it('404 world_not_ready when entries array is empty', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      // Default starting_situation_entries is '[]'::jsonb — no UPDATE needed.

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/starting-situations`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json<{ code: string }>().code).toBe('world_not_ready')
    })

    it('403 not_campaign_member — stranger', async () => {
      const owner = await seedUser(pool, scope, 0)
      const stranger = await seedUser(pool, scope, 1)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await pool.query(
        `UPDATE worlds SET starting_situation_entries = $2::jsonb WHERE id = $1`,
        [seed.worldId, JSON.stringify(sampleEntries)],
      )
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/starting-situations`,
        headers: { 'x-mythrun-dev-sub': stranger.devSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })
  })

  // ======================================================================
  // T17: GET /api/campaigns/:campaignId/characters (roster)
  // ======================================================================
  describe('GET /characters roster (T17)', () => {
    // Insert a `characters` row + `campaign_characters` join for a given user.
    // Used by the "one member completed" branch of the happy-path test.
    async function attachCharacter(
      campaignId: string,
      userId: string,
      name: string,
    ): Promise<string> {
      const characterId = uuidv7()
      await pool.query(
        `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         ) VALUES ($1, $2, $3, 1, 'Cleric', 'Human', 'Sage',
                   10, 10, 10, 10, 10, 10, 10, 10, 10, 2)`,
        [characterId, userId, name],
      )
      await pool.query(
        `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), campaignId, characterId, userId],
      )
      return characterId
    }

    it('200 — 3-member campaign: completed+characterId / submitted / no-concept', async () => {
      const owner = await seedUser(pool, scope, 0)
      const p1 = await seedUser(pool, scope, 1)
      const p2 = await seedUser(pool, scope, 2)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      await addMember(pool, seed.campaignId, p1, 'player')
      await addMember(pool, seed.campaignId, p2, 'player')

      // owner: completed concept + persisted character
      await insertConcept(pool, seed.campaignId, owner.userId, 'completed')
      const ownerCharId = await attachCharacter(seed.campaignId, owner.userId, 'Brother Anselm')
      // p1: submitted concept, no character yet
      await insertConcept(pool, seed.campaignId, p1.userId, 'submitted')
      // p2: no concept row at all

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        members: {
          userId: string
          displayName: string
          conceptStatus: string
          characterId?: string
        }[]
      }>()
      expect(body.members).toHaveLength(3)
      // Order is by campaign_members.joined_at — owner joined first.
      const byUser = Object.fromEntries(body.members.map((m) => [m.userId, m]))

      expect(byUser[owner.userId]).toEqual({
        userId: owner.userId,
        displayName: scope.displayName(0),
        conceptStatus: 'completed',
        characterId: ownerCharId,
      })
      expect(byUser[p1.userId]).toEqual({
        userId: p1.userId,
        displayName: scope.displayName(1),
        conceptStatus: 'submitted',
      })
      expect(byUser[p2.userId]).toEqual({
        userId: p2.userId,
        displayName: scope.displayName(2),
        conceptStatus: 'none',
      })
      // characterId is OMITTED when null, not present-as-null.
      expect('characterId' in (byUser[p1.userId] ?? {})).toBe(false)
      expect('characterId' in (byUser[p2.userId] ?? {})).toBe(false)
    })

    it('403 not_campaign_member — stranger', async () => {
      const owner = await seedUser(pool, scope, 0)
      const stranger = await seedUser(pool, scope, 1)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/characters`,
        headers: { 'x-mythrun-dev-sub': stranger.devSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })
  })

  // ======================================================================
  // T18: GET /api/campaigns/:campaignId/characters/:charId
  //
  // Member-only character read. Returns the characters row plus the four
  // child tables (skills/features/equipment/spells) projected to their
  // meaningful columns. 404 character_not_in_campaign when the join row
  // is missing — protects against fishing for characters across campaigns.
  // ======================================================================
  describe('GET /characters/:charId (T18)', () => {
    // Insert a `characters` row plus join + a populated sub-table row per
    // child table (skills/features/equipment/spells). Returns the new id.
    async function attachFullCharacter(
      campaignId: string,
      userId: string,
      name: string,
    ): Promise<string> {
      const characterId = uuidv7()
      await pool.query(
        `INSERT INTO characters (
           id, user_id, name, level, class, species, background,
           str, dex, con, int, wis, cha,
           hit_points, max_hit_points, armor_class, proficiency_bonus
         ) VALUES ($1, $2, $3, 3, 'Wizard', 'Half-Elf', 'Sage',
                   10, 12, 11, 16, 13, 10, 18, 18, 12, 2)`,
        [characterId, userId, name],
      )
      await pool.query(
        `INSERT INTO campaign_characters (id, campaign_id, character_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [uuidv7(), campaignId, characterId, userId],
      )
      await pool.query(
        `INSERT INTO character_skills (id, character_id, skill_name, proficiency_level)
         VALUES ($1, $2, 'Arcana', 'proficient'),
                ($3, $2, 'History', 'expertise')`,
        [uuidv7(), characterId, uuidv7()],
      )
      await pool.query(
        `INSERT INTO character_features
           (id, character_id, feature_name, feature_source, description)
         VALUES ($1, $2, 'Arcane Recovery', 'Wizard', 'Recover spell slots on short rest.')`,
        [uuidv7(), characterId],
      )
      await pool.query(
        `INSERT INTO character_equipment (id, character_id, item_name, quantity, equipped)
         VALUES ($1, $2, 'Quarterstaff', 1, true),
                ($3, $2, 'Component Pouch', 1, false)`,
        [uuidv7(), characterId, uuidv7()],
      )
      await pool.query(
        `INSERT INTO character_spells (id, character_id, spell_name, spell_level, prepared)
         VALUES ($1, $2, 'Magic Missile', 1, true)`,
        [uuidv7(), characterId],
      )
      return characterId
    }

    it('200 — returns character + populated sub-tables (skills/features/equipment/spells)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const charId = await attachFullCharacter(seed.campaignId, owner.userId, 'Eladrin Sage')

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/characters/${charId}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        character: { id: string; name: string; class: string; level: number }
        skills: { skill_name: string; proficiency_level: string }[]
        features: { feature_name: string; feature_source: string; description: string }[]
        equipment: { item_name: string; quantity: number; equipped: boolean }[]
        spells: { spell_name: string; spell_level: number; prepared: boolean }[]
      }>()
      expect(body.character.id).toBe(charId)
      expect(body.character.name).toBe('Eladrin Sage')
      expect(body.character.class).toBe('Wizard')
      expect(body.character.level).toBe(3)
      expect(body.skills).toHaveLength(2)
      expect(body.skills.map((s) => s.skill_name).sort()).toEqual(['Arcana', 'History'])
      expect(body.features).toHaveLength(1)
      expect(body.features[0]?.feature_name).toBe('Arcane Recovery')
      expect(body.equipment).toHaveLength(2)
      expect(body.equipment.map((e) => e.item_name).sort()).toEqual([
        'Component Pouch',
        'Quarterstaff',
      ])
      expect(body.spells).toHaveLength(1)
      expect(body.spells[0]?.spell_name).toBe('Magic Missile')
      // Sub-table responses project only the meaningful columns — no id.
      expect('id' in (body.skills[0] ?? {})).toBe(false)
      expect('id' in (body.features[0] ?? {})).toBe(false)
      expect('id' in (body.equipment[0] ?? {})).toBe(false)
      expect('id' in (body.spells[0] ?? {})).toBe(false)
    })

    it('404 character_not_in_campaign — charId is unknown (or not joined to this campaign)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const unknownCharId = uuidv7()
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/characters/${unknownCharId}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json<{ code: string }>().code).toBe('character_not_in_campaign')
    })

    it('403 not_campaign_member — stranger', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const charId = await attachFullCharacter(seed.campaignId, owner.userId, 'Eladrin Sage')
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/characters/${charId}`,
        headers: { 'x-mythrun-dev-sub': stranger.devSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })
  })

  // ======================================================================
  // T19a: GET /api/campaigns/:campaignId/hierarchy
  //
  // Member-only. Returns the world's entity_hierarchy rows verbatim
  // (camelCase via entityHierarchy.listForWorld's mapper). No tier
  // filtering in v1 — flagged as a follow-up.
  // ======================================================================
  describe('GET /hierarchy (T19)', () => {
    // Insert a parent entity + a child entity + the hierarchy row.
    // Both entities live in the given world; entity_hierarchy itself has
    // no world_id column — the listForWorld query joins through the
    // parent entity.
    async function seedHierarchyPair(
      worldId: string,
      parentName: string,
      childName: string,
    ): Promise<{ parentId: string; childId: string; hierarchyId: string }> {
      const parentId = uuidv7()
      const childId = uuidv7()
      const hierarchyId = uuidv7()
      await pool.query(
        `INSERT INTO entities (id, world_id, entity_type, name)
         VALUES ($1, $2, 'location', $3), ($4, $2, 'location', $5)`,
        [parentId, worldId, parentName, childId, childName],
      )
      await pool.query(
        `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id)
         VALUES ($1, $2, $3)`,
        [hierarchyId, parentId, childId],
      )
      return { parentId, childId, hierarchyId }
    }

    it('200 — returns 2 parent-child rows for the world', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const pair1 = await seedHierarchyPair(seed.worldId, 'Kingdom', 'Capital City')
      const pair2 = await seedHierarchyPair(seed.worldId, 'Capital City', 'Royal Palace')

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/hierarchy`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        hierarchy: { id: string; parentEntityId: string; childEntityId: string }[]
      }>()
      expect(body.hierarchy).toHaveLength(2)
      const byId = Object.fromEntries(body.hierarchy.map((r) => [r.id, r]))
      expect(byId[pair1.hierarchyId]).toEqual({
        id: pair1.hierarchyId,
        parentEntityId: pair1.parentId,
        childEntityId: pair1.childId,
      })
      expect(byId[pair2.hierarchyId]).toEqual({
        id: pair2.hierarchyId,
        parentEntityId: pair2.parentId,
        childEntityId: pair2.childId,
      })
    })

    it('200 — empty hierarchy returns []', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/hierarchy`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ hierarchy: [] })
    })

    it('403 not_campaign_member — stranger', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/hierarchy`,
        headers: { 'x-mythrun-dev-sub': stranger.devSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })
  })

  // ======================================================================
  // T19b: GET /api/campaigns/:campaignId/random-tables
  //
  // Member-only. Returns the world's random_tables joined to their
  // random_table_entries in a nested shape: each table carries an
  // `entries: [{rollMin, rollMax, content}]` array.
  // ======================================================================
  describe('GET /random-tables (T19)', () => {
    // Insert one random_table + N entries. Returns the table id.
    async function seedRandomTable(
      worldId: string,
      name: string,
      category: string,
      entries: { rollMin: number; rollMax: number; content: string }[],
    ): Promise<string> {
      const tableId = uuidv7()
      await pool.query(
        `INSERT INTO random_tables (id, world_id, name, category)
         VALUES ($1, $2, $3, $4)`,
        [tableId, worldId, name, category],
      )
      for (const e of entries) {
        await pool.query(
          `INSERT INTO random_table_entries (id, table_id, roll_min, roll_max, content)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), tableId, e.rollMin, e.rollMax, e.content],
        )
      }
      return tableId
    }

    it('200 — 1 table with 3 entries, nested shape', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const tableId = await seedRandomTable(seed.worldId, 'Tavern Patrons', 'social', [
        { rollMin: 1, rollMax: 3, content: 'a hooded courier nursing ale' },
        { rollMin: 4, rollMax: 6, content: 'two off-duty city guards' },
        { rollMin: 7, rollMax: 10, content: 'a merchant counting coins' },
      ])

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/random-tables`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        tables: {
          id: string
          name: string
          category: string
          entries: { rollMin: number; rollMax: number; content: string }[]
        }[]
      }>()
      expect(body.tables).toHaveLength(1)
      const t = body.tables[0]
      expect(t?.id).toBe(tableId)
      expect(t?.name).toBe('Tavern Patrons')
      expect(t?.category).toBe('social')
      expect(t?.entries).toHaveLength(3)
      // Sorted by roll_min.
      expect(t?.entries[0]).toEqual({
        rollMin: 1,
        rollMax: 3,
        content: 'a hooded courier nursing ale',
      })
      expect(t?.entries[2]).toEqual({
        rollMin: 7,
        rollMax: 10,
        content: 'a merchant counting coins',
      })
    })

    it('200 — empty list returns { tables: [] }', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/random-tables`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ tables: [] })
    })

    it('200 — table with no random_table_entries returns entries: []', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      // Seed a random_table with NO entries. Exercises the
      // `entriesByTable.get(t.id) ?? []` fallback in the handler.
      await pool.query(
        `INSERT INTO random_tables (id, world_id, name, category)
         VALUES ($1, $2, 'Empty Table', 'misc')`,
        [uuidv7(), seed.worldId],
      )
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/random-tables`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ tables: { name: string; entries: unknown[] }[] }>()
      expect(body.tables).toHaveLength(1)
      expect(body.tables[0]?.name).toBe('Empty Table')
      expect(body.tables[0]?.entries).toEqual([])
    })

    it('403 not_campaign_member — stranger', async () => {
      const owner = await seedUser(pool, scope, 0)
      const seed = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${seed.campaignId}/random-tables`,
        headers: { 'x-mythrun-dev-sub': stranger.devSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })
  })
})
