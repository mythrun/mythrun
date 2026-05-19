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
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import {
  campaignCharactersPlugin,
  type CharacterCreationQueueLike,
} from '../campaign-characters.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
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
      name: string,
      data: { campaignId: string; userId: string },
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
  // Spread the queue conditionally so `exactOptionalPropertyTypes` doesn't
  // reject an explicit `characterCreationQueue: undefined`.
  await app.register(
    campaignCharactersPlugin,
    queue ? { pool, characterCreationQueue: queue } : { pool },
  )
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
    pool = createPgPool(databaseUrl, { max: 4 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
    // Short label so the username variant fits in the 28-char .slice() —
    // longer labels truncate the trailing `uN` index and collide all users.
    scope = makeTestScope('cc-routes')
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
})
