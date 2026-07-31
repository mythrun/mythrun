// backend/src/routes/__tests__/session-preps.test.ts
//
// MYT-63 route integration tests: trigger / list / read / reset. Real Postgres
// (FK + unique constraints fire genuinely), bypass auth + requireOnboarded so
// request.dbUser is populated for requireCampaignMember, raw-INSERT fixtures
// keyed off TestScope. The session-prep queue is a vi.fn() spy.
//
// Enforced ignorance: list + read responses MUST NOT carry sd_playbook. The
// assertions check (a) no seeded sentinel in the serialized body AND (b) the
// body has EXACTLY the five SafeSessionPrep keys — so a future {...row} spread
// regression that adds sdPlaybook (even null, no sentinel) is caught structurally.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { createRepo } from '../../repo/index.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { sessionPrepsPlugin, type SessionPrepQueueLike } from '../session-preps.js'
import { cleanupTestScope, makeTestScope, type TestScope } from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const SECRET = 'SECRET_PLAYBOOK_DO_NOT_LEAK'
const SAFE_KEYS = ['createdAt', 'ftContext', 'id', 'sessionNumber', 'snapshotId']

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
    `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'a long enough concept', 'complete')`,
    [worldId, owner.userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, owner.userId, scope.campaignName(index)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return { campaignId, worldId }
}

async function addMember(pool: Pool, campaignId: string, user: SeededUser): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'player', true)`,
    [uuidv7(), campaignId, user.userId],
  )
}

interface QueueSpy {
  readonly queue: SessionPrepQueueLike
  readonly add: ReturnType<typeof vi.fn>
  readonly getJob: ReturnType<typeof vi.fn>
  /** Register a job as live/terminal under a specific sp-jobId (Task 9 §3.2). */
  setJob(jobId: string, job: { isCompleted(): boolean; isFailed(): boolean } | null): void
}
function createQueueSpy(): QueueSpy {
  const jobs = new Map<string, { isCompleted(): boolean; isFailed(): boolean }>()
  const add = vi.fn().mockResolvedValue({ id: 'stub-job' })
  const getJob = vi.fn((jobId: string) => Promise.resolve(jobs.get(jobId) ?? null))
  const queue: SessionPrepQueueLike = {
    add: (name, data, opts) => add(name, data, opts) as Promise<unknown>,
    getJob: (jobId) => getJob(jobId),
  }
  return {
    queue,
    add,
    getJob,
    setJob: (jobId, job): void => {
      if (job === null) jobs.delete(jobId)
      else jobs.set(jobId, job)
    },
  }
}

async function buildTestApp(pool: Pool, queue?: SessionPrepQueueLike): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(sessionPrepsPlugin, { pool, sessionPrepQueue: queue })
  await app.ready()
  return app
}

describe('sessionPrepsPlugin (MYT-63)', () => {
  let pool: Pool
  let app: FastifyInstance
  let queueSpy: QueueSpy
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sp-routes')
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

  describe('POST /session-prep (trigger, owner)', () => {
    it('202 — owner enqueues with jobId sp-<id>-<n>; default sessionNumber=1', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toEqual({ campaignId, sessionNumber: 1 })
      expect(queueSpy.add).toHaveBeenCalledWith(
        'session-prep',
        { campaignId, sessionNumber: 1 },
        { jobId: `sp-${campaignId}-1` },
      )
    })

    it('§3.2 (Task 9): a LIVE job holding sp-<id>-<n> → 409 prep_in_progress (the D9 add would silently no-op)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      // A parked (delayed) or still-running prep job holds the base id —
      // answering 202 would report a re-trigger that never happened.
      queueSpy.setJob(`sp-${campaignId}-1`, { isCompleted: () => false, isFailed: () => false })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ code: 'prep_in_progress' })
      expect(res.headers['retry-after']).toBe('30')
      expect(queueSpy.add).not.toHaveBeenCalled()
    })

    it('§3.2 (Task 9): a terminal leftover job under the id does not block the trigger (202)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      queueSpy.setJob(`sp-${campaignId}-1`, { isCompleted: () => true, isFailed: () => false })
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(202)
      expect(queueSpy.add).toHaveBeenCalledTimes(1)
    })

    it('403 — non-member', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': stranger.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })

    it('403 — non-owner member (player)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, campaignId, player)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': player.devSub },
        payload: { sessionNumber: 2 },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')
    })

    it('400 — owner sends a non-positive sessionNumber (Zod rejects)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/session-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { sessionNumber: 0 },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('bad_body')
      expect(queueSpy.add).not.toHaveBeenCalled()
    })
  })

  describe('GET /session-preps (list, member) + GET /:prepId (read, member)', () => {
    it('200 — member lists ordered SafeSessionPrep[]; no sd_playbook, exact keys', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, campaignId, player)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 2, ftContext: 'FT2', sdPlaybook: SECRET })
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT1', sdPlaybook: SECRET })

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/session-preps`,
        headers: { 'x-mythrun-dev-sub': player.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain(SECRET)
      const body = res.json<{ preps: Record<string, unknown>[] }>()
      expect(body.preps.map((p) => p.sessionNumber)).toEqual([1, 2])
      for (const p of body.preps) expect(Object.keys(p).sort()).toEqual(SAFE_KEYS)
    })

    it('200 — read returns SafeSessionPrep; no sd_playbook, exact keys', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: SECRET })
      const prepId = (await repo.sessionPreps.listFor(campaignId))[0]?.id
      if (prepId === undefined) throw new Error('expected a seeded prep')

      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/session-preps/${prepId}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain(SECRET)
      expect(Object.keys(res.json<Record<string, unknown>>()).sort()).toEqual(SAFE_KEYS)
    })

    it('404 — read an absent prepId', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campaignId}/session-preps/${uuidv7()}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json<{ code: string }>().code).toBe('prep_not_found')
    })

    it('404 — read a prepId that belongs to a different campaign (no cross-campaign leak)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId: campA } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const { campaignId: campB } = await seedCampaignOwnedBy(pool, scope, owner, 1)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId: campB, sessionNumber: 1, ftContext: 'FT', sdPlaybook: SECRET })
      const otherPrepId = (await repo.sessionPreps.listFor(campB))[0]?.id
      if (otherPrepId === undefined) throw new Error('expected a seeded prep')
      const res = await app.inject({
        method: 'GET',
        url: `/api/campaigns/${campA}/session-preps/${otherPrepId}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /reset-prep (owner)', () => {
    it('200 — owner deletes the prep + re-arms the stage; a later claim re-claims', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const repo = createRepo(pool)
      await repo.sessionPreps.insert({ campaignId, sessionNumber: 1, ftContext: 'FT', sdPlaybook: SECRET })
      await repo.pipelineRuns.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })
      await pool.query(
        `UPDATE pipeline_runs SET status='completed', completed_at=now()
          WHERE campaign_id=$1 AND stage='session-prep:1' AND user_id IS NULL`,
        [campaignId],
      )

      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/reset-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { sessionNumber: 1 },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ campaignId, sessionNumber: 1, reset: true })
      expect(await repo.sessionPreps.existsFor(campaignId, 1)).toBe(false)
      expect(await repo.pipelineRuns.claimStage({ kind: 'campaign', campaignId, stage: 'session-prep:1' })).toBe('claimed')
    })

    it('200 — reset with no existing prep is an idempotent no-op', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/reset-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ campaignId, sessionNumber: 1, reset: true })
    })

    it('403 — non-owner member', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const player = await seedUser(pool, scope, 1)
      await addMember(pool, campaignId, player)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/reset-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': player.devSub },
        payload: {},
      })
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_owner')
    })

    it('400 — owner sends a non-positive sessionNumber (Zod rejects)', async () => {
      const owner = await seedUser(pool, scope, 0)
      const { campaignId } = await seedCampaignOwnedBy(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'POST',
        url: `/api/campaigns/${campaignId}/reset-prep`,
        headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': owner.devSub },
        payload: { sessionNumber: -1 },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('bad_body')
    })
  })
})
