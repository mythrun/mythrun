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
import type { WorldGenQueueLike, WorldGenJobLike } from '../campaigns.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')
const REDIS_KEY_PREFIX = `test:campaigns-resume-${String(Date.now())}:`

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

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
    redis,
    redisKeyPrefix: REDIS_KEY_PREFIX,
    worldGenQueue: queueSpy.queue,
  })
  await app.ready()
  return app
}

// -------------------------------------------------------------------------

describe('POST /api/campaigns/:campaignId/resume (MYT-51 T10)', () => {
  let pool: Pool
  let redis: Redis
  let queueSpy: QueueSpy
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
    // myth-5jdo: scoped cleanup replaces blanket DELETEs.
    await cleanupTestScope(pool, scope)
    app = await buildTestApp(pool, redis, queueSpy)
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

  describe('phase=character_creation', () => {
    it('422 phase_resume_not_yet_implemented (downstream ticket NOT in body)', async () => {
      const seed = await seedCampaign(pool, scope, { worldStatus: 'complete' })
      // World ready → a charcreation stage running puts us in 'character_creation'.
      await insertRun(pool, {
        worldId: seed.worldId,
        stage: 'concept_intake',
        status: 'completed',
        startedAt: new Date(Date.now() - 2000),
        completedAt: new Date(Date.now() - 1000),
      })
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
      expect(res.statusCode).toBe(422)
      const body = res.json<{ code: string; phase: string; downstreamTicket?: string }>()
      expect(body.code).toBe('phase_resume_not_yet_implemented')
      expect(body.phase).toBe('character_creation')
      // Roc-Imp6: downstream ticket NOT in response.
      expect(body.downstreamTicket).toBeUndefined()
      expect(queueSpy.add).not.toHaveBeenCalled()
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
        stage: 'continuity_check',
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
