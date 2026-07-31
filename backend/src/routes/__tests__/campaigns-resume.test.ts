// backend/src/routes/__tests__/campaigns-resume.test.ts
//
// MYT-51 Task 10. Integration tests for POST /api/campaigns/:campaignId/resume.
//
// Real Postgres + bypassPlugin + requireOnboarded + the routes plugin.
// The world-gen queue is a hand-rolled spy (mirrors campaigns-create.test.ts):
// the resume handler only invokes .add() and .getJob() on it.
//
// Every PipelinePhase arm is exercised so a future drop of an arm from
// derivePhase (or an unintended re-route to a different code) trips a
// failing test rather than silently shipping. The not_started recovery
// branch is split into two cases (no existing job; existing live job).
//
// Spec: docs/superpowers/specs/2026-05-12-myt-51-world-gen-non-streaming-design.md §"POST /api/campaigns/:campaignId/resume flow" (lines 554–607).

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
import type {
  WorldGenQueueLike,
  WorldGenJobLike,
  CharacterCreationResumeQueueLike,
} from '../campaigns.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const REDIS_KEY_PREFIX = `test:campaigns-resume-${String(Date.now())}:`

// --- Stand-in deps --------------------------------------------------------

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

// --- Queue spy ------------------------------------------------------------

interface QueueSpy {
  readonly queue: WorldGenQueueLike
  readonly add: ReturnType<typeof vi.fn>
  readonly getJob: ReturnType<typeof vi.fn>
  /** Pre-set the JobLike value that the next .getJob() call returns. Pass
   *  `null` for "no job" (the default), or a partial JobLike for "job
   *  exists". */
  setJob(job: WorldGenJobLike | null): void
}

function createQueueSpy(): QueueSpy {
  let nextJob: WorldGenJobLike | null = null
  const add = vi.fn().mockResolvedValue({ id: 'stub-job' })
  const getJob = vi.fn<(jobId: string) => Promise<WorldGenJobLike | null>>(() => {
    return Promise.resolve(nextJob)
  })
  const getJobCounts = vi.fn<(states: readonly string[]) => Promise<Record<string, number>>>(() => {
    return Promise.resolve({ waiting: 0, active: 0, delayed: 0 })
  })
  const queue = {
    add,
    getJob,
    getJobCounts,
  } as unknown as WorldGenQueueLike
  return {
    queue,
    add,
    getJob,
    setJob: (job: WorldGenJobLike | null): void => {
      nextJob = job
    },
  }
}

// MYT-102 A3: character-creation queue spy for the resume arm — the handler
// only calls .add() on it.
interface CcQueueSpy {
  readonly queue: CharacterCreationResumeQueueLike
  readonly add: ReturnType<typeof vi.fn>
}

function createCcQueueSpy(): CcQueueSpy {
  const add = vi.fn().mockResolvedValue({ id: 'stub-cc-job' })
  return { queue: { add }, add }
}

// --- Seed helpers ---------------------------------------------------------

interface SeededCampaign {
  readonly userId: string
  readonly devSub: string
  readonly campaignId: string
  readonly worldId: string
}

async function seedCampaign(
  pool: Pool,
  scope: TestScope,
  opts: {
    worldStatus?: 'generating' | 'complete' | 'failed'
    campaignStatus?: 'setup' | 'active' | 'archived'
  } = {},
): Promise<SeededCampaign> {
  const userId = uuidv7()
  const devSub = scope.userSub(0)
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, devSub, scope.displayName(0), scope.username(0)],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'C', $4)`,
    [worldId, userId, scope.worldName(0), opts.worldStatus ?? 'generating'],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [campaignId, worldId, userId, scope.campaignName(0), opts.campaignStatus ?? 'setup'],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, userId],
  )
  return { userId, devSub, campaignId, worldId }
}

async function insertRun(
  pool: Pool,
  args: {
    worldId?: string
    campaignId?: string
    stage: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    error?: string | null
    userId?: string | null
    startedAt?: Date | null
    completedAt?: Date | null
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO pipeline_runs (id, world_id, campaign_id, stage, status, error,
                                user_id, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuidv7(),
      args.worldId ?? null,
      args.campaignId ?? null,
      args.stage,
      args.status,
      args.error ?? null,
      args.userId ?? null,
      args.startedAt ?? null,
      args.completedAt ?? null,
    ],
  )
}

// --- App harness ----------------------------------------------------------

async function buildTestApp(
  pool: Pool,
  redis: Redis,
  queueSpy: QueueSpy,
  ccQueue?: CharacterCreationResumeQueueLike,
): Promise<FastifyInstance> {
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
    worldGenQueue: queueSpy.queue,
    // exactOptionalPropertyTypes: only spread the key in when present.
    ...(ccQueue !== undefined ? { characterCreationQueue: ccQueue } : {}),
  })
  await app.ready()
  return app
}

// -------------------------------------------------------------------------

describe('POST /api/campaigns/:campaignId/resume (MYT-51 T10)', () => {
  let pool: Pool
  let redis: Redis
  let queueSpy: QueueSpy
  let ccQueueSpy: CcQueueSpy
  let app: FastifyInstance
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('camp-resume')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    vi.stubEnv('AUTH_MODE', 'bypass')
    vi.stubEnv('NODE_ENV', 'test')
    redis = new IoredisMock()
    queueSpy = createQueueSpy()
    ccQueueSpy = createCcQueueSpy()
    // myth-5jdo: scoped cleanup replaces blanket DELETEs.
    await cleanupTestScope(pool, scope)
    app = await buildTestApp(pool, redis, queueSpy, ccQueueSpy.queue)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  // -----------------------------------------------------------------------
  // phase = world_gen (active worldgen run)
  // -----------------------------------------------------------------------

  describe('phase=world_gen (active)', () => {
    it('409 world_gen_in_progress + Retry-After: 30', async () => {
      const seed = await seedCampaign(pool, scope)
      // A running worldgen stage puts the phase in 'world_gen'.
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'concept_intake',
        status: 'running',
        startedAt: new Date(),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'world_gen_in_progress' })
      expect(res.headers['retry-after']).toBe('30')
      expect(queueSpy.add).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // phase = world_gen_failed (3 sub-branches)
  // -----------------------------------------------------------------------

  describe('phase=world_gen_failed', () => {
    it('409 phase_not_yet_implementable on stage_not_implemented error', async () => {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'failed' })
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'world_and_factions',
        status: 'failed',
        error: 'stage_not_implemented: world_and_factions',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        code: 'phase_not_yet_implementable',
        stuckAtStage: 'world_and_factions',
      })
      expect(queueSpy.add).not.toHaveBeenCalled()
    })

    it('409 world_gen_capped on world_gen_cost_cap_exceeded error', async () => {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'failed' })
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'starting_situation',
        status: 'failed',
        error: 'world_gen_cost_cap_exceeded: $10.50 > $10.00',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'world_gen_capped' })
      expect(queueSpy.add).not.toHaveBeenCalled()
    })

    it('202 re-enqueued on transient infra-class failure', async () => {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'failed' })
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'concept_intake',
        status: 'failed',
        error: 'Redis connection lost: ECONNREFUSED',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({
        campaignId: seed.campaignId,
        action: 'world-gen-re-enqueued',
      })
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
      const [name, data, addOpts] = queueSpy.add.mock.calls[0] as [
        string,
        { campaignId: string },
        { jobId: string },
      ]
      expect(name).toBe('world-gen')
      expect(data).toEqual({ campaignId: seed.campaignId })
      expect(addOpts.jobId).toBe(seed.campaignId)
    })
  })

  // -----------------------------------------------------------------------
  // llm-outage-resilience §3.3 — the parked representation. A park leaves
  // the stage row failed with worlds.status still 'generating' plus an
  // llm_resume_stamps row keyed ('world_gen', campaignId). While the stamp
  // is armed and not overdue the phase derives generating-shaped, so the
  // retry arm 409s as if generating; once the failed surface DOES derive
  // (overdue / exhausted / genuine failure), a retry starts a fresh park
  // episode — clearStamp before the re-enqueue.
  // -----------------------------------------------------------------------

  describe('parked world-gen (resume stamps)', () => {
    async function insertStamp(
      campaignId: string,
      s: { nextResumeAt: Date | null; consumedMs?: number; attempt?: number },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO llm_resume_stamps
           (pipeline, entity_id, resume_attempt, next_resume_at, park_consumed_ms, last_error_class)
         VALUES ('world_gen', $1, $2, $3, $4, 'connectivity')`,
        [campaignId, s.attempt ?? 1, s.nextResumeAt, s.consumedMs ?? 30_000],
      )
    }

    async function stampExists(campaignId: string): Promise<boolean> {
      const { rows } = await pool.query(
        `SELECT 1 FROM llm_resume_stamps WHERE pipeline = 'world_gen' AND entity_id = $1`,
        [campaignId],
      )
      return rows.length > 0
    }

    it('armed + not overdue → 409 world_gen_in_progress (no re-enqueue, stamp intact)', async () => {
      const seed = await seedCampaign(pool, scope) // world stays 'generating'
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'world_and_factions',
        status: 'failed',
        error: '{"code":"llm_overloaded","message":"529"}',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      await insertStamp(seed.campaignId, { nextResumeAt: new Date(Date.now() + 60_000) })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'world_gen_in_progress' })
      expect(res.headers['retry-after']).toBe('30')
      expect(queueSpy.add).not.toHaveBeenCalled()
      expect(await stampExists(seed.campaignId)).toBe(true)
    })

    it('overdue stamp (wake never claimed) → 202 re-enqueued with a FRESH episode (stamp cleared)', async () => {
      const seed = await seedCampaign(pool, scope)
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'world_and_factions',
        status: 'failed',
        error: '{"code":"llm_overloaded","message":"529"}',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      // 10 minutes past the scheduled resume — beyond the 5-minute grace.
      await insertStamp(seed.campaignId, { nextResumeAt: new Date(Date.now() - 10 * 60_000) })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({
        campaignId: seed.campaignId,
        action: 'world-gen-re-enqueued',
      })
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
      expect(await stampExists(seed.campaignId)).toBe(false)
    })

    it('exhausted budget → 202 re-enqueued with a FRESH episode (stamp cleared)', async () => {
      // Exhaustion ran today's failed path, so the world is entity-failed.
      const seed = await seedCampaign(pool, scope, { worldStatus: 'failed' })
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'world_and_factions',
        status: 'failed',
        error: '{"code":"llm_overloaded","message":"529"}',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      await insertStamp(seed.campaignId, {
        nextResumeAt: null,
        consumedMs: 6 * 60 * 60 * 1000,
        attempt: 4,
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(202)
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
      expect(await stampExists(seed.campaignId)).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // phase = world_ready
  // -----------------------------------------------------------------------

  describe('phase=world_ready', () => {
    it('409 nothing_to_resume', async () => {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'complete' })
      // All worldgen stages completed → world_ready (campaign still in setup).
      for (const stage of ['concept_intake', 'starting_situation', 'random_tables']) {
        await insertRun(pool, {
          worldId: seed.worldId,
          stage,
          status: 'completed',
          startedAt: new Date(Date.now() - 1000),
          completedAt: new Date(),
        })
      }
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'nothing_to_resume' })
      expect(queueSpy.add).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // phase = character_creation
  // -----------------------------------------------------------------------

  // MYT-102 A3: the arm is implemented — it sweeps concepts stuck at
  // 'processing' with owed pipeline work (a pending/failed character-stage
  // run and no active running one) and re-adds their cc-<campaignId>-<userId>
  // jobs. removeOnComplete/Fail {count:0} on the campaign-setup queue means a
  // dead job's id is free, so the deterministic re-add lands.
  describe('phase=character_creation', () => {
    async function insertConcept(
      campaignId: string,
      userId: string,
      status: 'submitted' | 'processing' | 'completed' | 'failed',
    ): Promise<void> {
      await pool.query(
        `INSERT INTO character_concepts (
           id, campaign_id, user_id, concept_text, situation_grounding_text,
           guided_choices, status
         )
         VALUES ($1, $2, $3, 'A road-weary cleric searching for an old companion',
                 'arrived at the tavern as the storm broke', '{}'::jsonb, $4)`,
        [uuidv7(), campaignId, userId, status],
      )
    }

    async function addMember(campaignId: string, n: number): Promise<{ userId: string }> {
      const userId = uuidv7()
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [userId, scope.userSub(n), scope.displayName(n), scope.username(n)],
      )
      await pool.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'player', true)`,
        [uuidv7(), campaignId, userId],
      )
      return { userId }
    }

    async function seedCharCreationCampaign(): Promise<SeededCampaign> {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'complete' })
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'concept_intake',
        status: 'completed',
        startedAt: new Date(Date.now() - 2000),
        completedAt: new Date(Date.now() - 1000),
      })
      return seed
    }

    it('202 re-enqueues a lost-enqueue orphan (processing concept + pending seed row)', async () => {
      const seed = await seedCharCreationCampaign()
      await insertConcept(seed.campaignId, seed.userId, 'processing')
      // The POST /characters tx seeded a pending character_concept row, but
      // the enqueue after COMMIT was lost (Redis blip) — scout shape 1.
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_concept',
        status: 'pending',
        userId: seed.userId,
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({
        campaignId: seed.campaignId,
        action: 'character-creation-re-enqueued',
        reEnqueued: 1,
      })
      expect(ccQueueSpy.add).toHaveBeenCalledTimes(1)
      expect(ccQueueSpy.add).toHaveBeenCalledWith(
        'character-creation',
        { campaignId: seed.campaignId, userId: seed.userId },
        { jobId: `cc-${seed.campaignId}-${seed.userId}` },
      )
      expect(queueSpy.add).not.toHaveBeenCalled()
    })

    it('202 re-enqueues only the stuck member, not a healthy in-flight one (failed run + pending seed)', async () => {
      const seed = await seedCharCreationCampaign()
      // Member A: location_selection failed (transient exhausted pre-fix) +
      // the character_concept seed still pending — scout shape 2.
      await insertConcept(seed.campaignId, seed.userId, 'processing')
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'location_selection',
        status: 'failed',
        userId: seed.userId,
        error: 'llm_rate_limited',
        startedAt: new Date(Date.now() - 60_000),
        completedAt: new Date(Date.now() - 59_000),
      })
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_concept',
        status: 'pending',
        userId: seed.userId,
      })
      // Member B: a worker is actively on their stage — must NOT be swept.
      const memberB = await addMember(seed.campaignId, 5)
      await insertConcept(seed.campaignId, memberB.userId, 'processing')
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_concept',
        status: 'running',
        userId: memberB.userId,
        startedAt: new Date(),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({
        campaignId: seed.campaignId,
        action: 'character-creation-re-enqueued',
        reEnqueued: 1,
      })
      expect(ccQueueSpy.add).toHaveBeenCalledTimes(1)
      expect(ccQueueSpy.add).toHaveBeenCalledWith(
        'character-creation',
        { campaignId: seed.campaignId, userId: seed.userId },
        { jobId: `cc-${seed.campaignId}-${seed.userId}` },
      )
    })

    it('409 nothing_to_resume when every processing concept has an active run (healthy no-op)', async () => {
      const seed = await seedCharCreationCampaign()
      await insertConcept(seed.campaignId, seed.userId, 'processing')
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_concept',
        status: 'running',
        userId: seed.userId,
        startedAt: new Date(),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'nothing_to_resume' })
      expect(ccQueueSpy.add).not.toHaveBeenCalled()
    })

    it('503 queue_not_ready when the character-creation queue is not wired', async () => {
      const seed = await seedCharCreationCampaign()
      await insertConcept(seed.campaignId, seed.userId, 'processing')
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_concept',
        status: 'pending',
        userId: seed.userId,
      })
      const bareApp = await buildTestApp(pool, redis, queueSpy)
      try {
        const res = await bareApp.inject({
          method: 'POST',
          url: `/api/campaigns/${seed.campaignId}/resume`,
          headers: { 'x-mythrun-dev-sub': seed.devSub },
        })
        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({ code: 'queue_not_ready' })
      } finally {
        await bareApp.close()
      }
    })
  })

  // -----------------------------------------------------------------------
  // phase = post_creation
  // -----------------------------------------------------------------------

  describe('phase=post_creation', () => {
    it('422 phase_resume_not_yet_implemented for post_creation', async () => {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'complete' })
      // Charcreation done; postcreation stage pending → 'post_creation'.
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'concept_intake',
        status: 'completed',
        startedAt: new Date(Date.now() - 3000),
        completedAt: new Date(Date.now() - 2000),
      })
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_sheet',
        status: 'completed',
        userId: seed.userId,
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_integration',
        status: 'pending',
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(422)
      const body = res.json<{ code: string; phase: string }>()
      expect(body.code).toBe('phase_resume_not_yet_implemented')
      expect(body.phase).toBe('post_creation')
      expect(queueSpy.add).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // phase = complete (campaign moved to active)
  // -----------------------------------------------------------------------

  describe('phase=complete', () => {
    it('409 already_complete', async () => {
      const seed = await seedCampaign(pool, scope, {
        worldStatus: 'complete',
        campaignStatus: 'active',
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'already_complete' })
      expect(queueSpy.add).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // phase = failed (post-worldgen terminal failure)
  // -----------------------------------------------------------------------

  describe('phase=failed', () => {
    it('409 terminal_failure when charcreation failed downstream', async () => {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'complete' })
      // World OK; later-stage failure puts us in 'failed' (not world_gen_failed).
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'concept_intake',
        status: 'completed',
        startedAt: new Date(Date.now() - 3000),
        completedAt: new Date(Date.now() - 2000),
      })
      await insertRun(pool, {
        campaignId: seed.campaignId,
        stage: 'character_concept',
        status: 'failed',
        userId: seed.userId,
        error: 'charcreation_synthesis_failed',
        startedAt: new Date(Date.now() - 1000),
        completedAt: new Date(),
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'terminal_failure' })
      expect(queueSpy.add).not.toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // phase = not_started (Redis-blip orphan path)
  // -----------------------------------------------------------------------

  describe('phase=not_started', () => {
    it('202 enqueued-after-orphan-recovery when no job exists', async () => {
      const seed = await seedCampaign(pool, scope)
      // No pipeline_runs rows → 'not_started'.
      queueSpy.setJob(null)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({
        campaignId: seed.campaignId,
        action: 'world-gen-enqueued-after-orphan-recovery',
      })
      expect(queueSpy.getJob).toHaveBeenCalledWith(seed.campaignId)
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
      const [name, data, addOpts] = queueSpy.add.mock.calls[0] as [
        string,
        { campaignId: string },
        { jobId: string },
      ]
      expect(name).toBe('world-gen')
      expect(data).toEqual({ campaignId: seed.campaignId })
      expect(addOpts.jobId).toBe(seed.campaignId)
    })

    it('409 world_gen_in_progress when a live job already exists', async () => {
      const seed = await seedCampaign(pool, scope)
      queueSpy.setJob({
        isCompleted: () => false,
        isFailed: () => false,
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'world_gen_in_progress' })
      // No re-enqueue when a live job is already running.
      expect(queueSpy.add).not.toHaveBeenCalled()
    })

    it('202 enqueued-after-orphan-recovery when job exists but completed', async () => {
      const seed = await seedCampaign(pool, scope)
      // Stale completed BullMQ job (would happen if `removeOnComplete` was
      // misconfigured, hence the SHOWSTOPPER fix tracked in D9). We still
      // recover: it's a no-op job, re-enqueue is safe.
      queueSpy.setJob({
        isCompleted: () => true,
        isFailed: () => false,
      })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': seed.devSub },
      })
      expect(res.statusCode).toBe(202)
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  // Auth: only owners can resume.
  // -----------------------------------------------------------------------

  describe('auth', () => {
    it('403 not_campaign_owner for a non-owner member', async () => {
      const seed = await seedCampaign(pool, scope)
      const otherUserId = uuidv7()
      const otherSub = scope.userSub(1)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [otherUserId, otherSub, scope.displayName(1), scope.username(1)],
      )
      await pool.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'player', true)`,
        [uuidv7(), seed.campaignId, otherUserId],
      )
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': otherSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_owner' })
    })

    it('403 not_campaign_member for an entirely unrelated user', async () => {
      const seed = await seedCampaign(pool, scope)
      const otherUserId = uuidv7()
      const otherSub = scope.userSub(1)
      await pool.query(
        `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
        [otherUserId, otherSub, scope.displayName(1), scope.username(1)],
      )
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${seed.campaignId}/resume`,
        headers: { 'x-mythrun-dev-sub': otherSub },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ code: 'not_campaign_member' })
    })
  })
})
