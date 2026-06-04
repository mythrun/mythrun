// backend/src/routes/__tests__/sessions-start.test.ts
//
// MYT-65 Task 9: session lifecycle HTTP routes — POST /:campaignId/start (the
// billing-debiting session creator), GET /:campaignId/active, and
// GET /:sessionId/messages.
//
// Real Postgres (the idx_sessions_one_active partial-unique index + the
// credit_ledger FK/CHECKs fire genuinely), real ioredis-mock (the start route
// initializes Redis session state via makeSessionState), bypass auth +
// requireOnboarded so request.dbUser is populated for requireCampaignMember.
// Raw-INSERT fixtures keyed off TestScope.
//
// The atomicity assertion is the load-bearing one: the OWNER pays exactly ONE
// session credit on the happy path, and a duplicate /start while a session is
// active does NOT debit a second time (the partial-unique index closes the
// race → 409 before tryDebitForSession runs).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import IoRedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../../repo/uuidv7.js'
import { createRepo } from '../../repo/index.js'
import { bypassPlugin } from '../../auth/bypass-plugin.js'
import { requireOnboarded } from '../../auth/require-onboarded.js'
import { sessionsRoutes } from '../sessions.js'
import { makeSessionState } from '../../redis/session-state.js'
import {
  cleanupTestScope,
  makeTestScope,
  type TestScope,
} from '../../repo/__tests__/_helpers/test-scope.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
// The BARE env+region prefix — sessionsRoutes appends its own sub-prefixes
// (`session:` for state, `ws:ticket:` for the mint store), matching the
// production app.ts wiring + routes/ws-session.ts's consume side.
const KEY_PREFIX = 'test:use1:'

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

/** Grant `amount` session credits to a user via a raw gift INSERT (mirrors
 *  campaigns-create.test.ts's seeding shape — gift carries no FK columns). */
async function grantSessionCredits(pool: Pool, userId: string, amount: number): Promise<void> {
  await pool.query(
    `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
     VALUES ($1, $2, 'session', $3, 'gift', NULL)`,
    [uuidv7(), userId, amount],
  )
}

async function sessionBalance(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ balance: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS balance FROM credit_ledger
      WHERE user_id = $1 AND credit_type = 'session'
        AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  )
  return Number(rows[0]?.balance ?? 0)
}

async function seedActiveCampaign(
  pool: Pool,
  scope: TestScope,
  owner: SeededUser,
  index: number,
): Promise<string> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept, status)
     VALUES ($1, $2, $3, 'a long enough concept', 'complete')`,
    [worldId, owner.userId, scope.worldName(index)],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [campaignId, worldId, owner.userId, scope.campaignName(index)],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, owner.userId],
  )
  return campaignId
}

async function setCampaignStatus(pool: Pool, campaignId: string, status: string): Promise<void> {
  await pool.query(`UPDATE campaigns SET status = $2 WHERE id = $1`, [campaignId, status])
}

async function addMember(pool: Pool, campaignId: string, user: SeededUser): Promise<void> {
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
     VALUES ($1, $2, $3, 'player', true)`,
    [uuidv7(), campaignId, user.userId],
  )
}

async function seedPrep(
  pool: Pool,
  campaignId: string,
  sessionNumber: number,
): Promise<void> {
  const repo = createRepo(pool)
  await repo.sessionPreps.insert({
    campaignId,
    sessionNumber,
    ftContext: 'FT-CONTEXT',
    sdPlaybook: 'SD-PLAYBOOK',
  })
}

/** Seed owner (+`credits` session credits) + an active campaign + a prep for
 *  session 1. Returns the owner + campaignId — the common /start preamble. */
async function seededActiveWithPrep(
  pool: Pool,
  scope: TestScope,
  index: number,
  credits: number,
): Promise<{ owner: SeededUser; campaignId: string }> {
  const owner = await seedUser(pool, scope, index)
  if (credits > 0) await grantSessionCredits(pool, owner.userId, credits)
  const campaignId = await seedActiveCampaign(pool, scope, owner, index)
  await seedPrep(pool, campaignId, 1)
  return { owner, campaignId }
}

function postStart(
  app: FastifyInstance,
  campaignId: string,
  devSub: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/sessions/${campaignId}/start`,
    headers: { 'content-type': 'application/json', 'x-mythrun-dev-sub': devSub },
    payload: {},
  })
}

/** Start a session and return its id (asserts the 200). */
async function startAndGetSessionId(
  app: FastifyInstance,
  campaignId: string,
  devSub: string,
): Promise<string> {
  const res = await postStart(app, campaignId, devSub)
  if (res.statusCode !== 200) throw new Error(`expected 200, got ${String(res.statusCode)}`)
  return res.json<{ sessionId: string }>().sessionId
}

async function appendMsg(
  pool: Pool,
  sessionId: string,
  seq: number,
  userId: string | null,
): Promise<void> {
  await createRepo(pool).sessionMessages.append({
    sessionId,
    seq,
    userId,
    messageType: userId ? 'player' : 'dm',
    content: `msg-${String(seq)}`,
  })
}

async function buildTestApp(pool: Pool, redis: Redis): Promise<FastifyInstance> {
  globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(bypassPlugin)
  await app.register(requireOnboarded, { pool })
  await app.register(sessionsRoutes, {
    pool,
    redisRealtime: redis,
    redisKeyPrefix: KEY_PREFIX,
  })
  await app.ready()
  return app
}

describe('session lifecycle routes (MYT-65 Task 9)', () => {
  let pool: Pool
  let app: FastifyInstance
  let redis: Redis
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sessions-start')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    process.env.AUTH_MODE = 'bypass'
    process.env.NODE_ENV = 'test'
    await cleanupTestScope(pool, scope)
    redis = new IoRedisMock()
    app = await buildTestApp(pool, redis)
  })
  afterEach(async () => {
    await app.close()
    await redis.quit()
  })

  describe('POST /:campaignId/start', () => {
    it('happy path → 200 {sessionId}; exactly ONE session-credit debit', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      expect(await sessionBalance(pool, owner.userId)).toBe(3)

      const res = await postStart(app, campaignId, owner.devSub)
      expect(res.statusCode).toBe(200)
      const body = res.json<{ sessionId: string }>()
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/)

      // Exactly ONE debit — owner balance dropped by 1.
      expect(await sessionBalance(pool, owner.userId)).toBe(2)

      // The session row exists, is active, and is session 1.
      const repo = createRepo(pool)
      const active = await repo.sessions.getActiveByCampaign(campaignId)
      expect(active?.id).toBe(body.sessionId)
      expect(active?.sessionNumber).toBe(1)
      expect(active?.status).toBe('active')

      // Redis session state was initialized.
      const blob = await makeSessionState(redis, KEY_PREFIX).getState(campaignId)
      expect(blob).toEqual({ participants: [], mode: 'exploration', status: 'active' })
    })

    it('duplicate /start while one is active → 409; NO second debit', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)

      expect((await postStart(app, campaignId, owner.devSub)).statusCode).toBe(200)
      expect(await sessionBalance(pool, owner.userId)).toBe(2)

      const second = await postStart(app, campaignId, owner.devSub)
      expect(second.statusCode).toBe(409)
      // Balance UNCHANGED — no second debit.
      expect(await sessionBalance(pool, owner.userId)).toBe(2)
    })

    it('non-member → 403', async () => {
      const { campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      const stranger = await seedUser(pool, scope, 1)
      const res = await postStart(app, campaignId, stranger.devSub)
      expect(res.statusCode).toBe(403)
      expect(res.json<{ code: string }>().code).toBe('not_campaign_member')
    })

    it('campaign not active → 409', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      await setCampaignStatus(pool, campaignId, 'setup')
      const res = await postStart(app, campaignId, owner.devSub)
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('campaign_not_active')
      // No debit on a precondition failure.
      expect(await sessionBalance(pool, owner.userId)).toBe(3)
    })

    it('no session prep for the next session number → 409', async () => {
      const owner = await seedUser(pool, scope, 0)
      await grantSessionCredits(pool, owner.userId, 3)
      const campaignId = await seedActiveCampaign(pool, scope, owner, 0)
      // No prep seeded.
      const res = await postStart(app, campaignId, owner.devSub)
      expect(res.statusCode).toBe(409)
      expect(res.json<{ code: string }>().code).toBe('prep_not_ready')
      expect(await sessionBalance(pool, owner.userId)).toBe(3)
    })

    it('owner has no session credits → 402; no session row left behind', async () => {
      // Zero credits granted.
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 0)
      const res = await postStart(app, campaignId, owner.devSub)
      expect(res.statusCode).toBe(402)
      expect(res.json<{ code: string }>().code).toBe('insufficient_credits')

      // The just-created session row was rolled back — no active session.
      const repo = createRepo(pool)
      expect(await repo.sessions.getActiveByCampaign(campaignId)).toBeNull()
      expect((await repo.sessions.listByCampaign(campaignId)).length).toBe(0)
    })

    it('a non-owner MEMBER can start; the OWNER pays (not the caller)', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 2)
      const player = await seedUser(pool, scope, 1)
      await grantSessionCredits(pool, player.userId, 5)
      await addMember(pool, campaignId, player)

      const res = await postStart(app, campaignId, player.devSub)
      expect(res.statusCode).toBe(200)
      // OWNER paid (2 → 1); player UNTOUCHED (5).
      expect(await sessionBalance(pool, owner.userId)).toBe(1)
      expect(await sessionBalance(pool, player.userId)).toBe(5)
    })
  })

  describe('GET /:campaignId/active', () => {
    it('returns the active session row', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      const sessionId = await startAndGetSessionId(app, campaignId, owner.devSub)

      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${campaignId}/active`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ session: { id: string; status: string } | null }>()
      expect(body.session?.id).toBe(sessionId)
      expect(body.session?.status).toBe('active')
    })

    it('returns { session: null } when no active session', async () => {
      const owner = await seedUser(pool, scope, 0)
      const campaignId = await seedActiveCampaign(pool, scope, owner, 0)
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${campaignId}/active`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ session: null })
    })

    it('non-member → 403', async () => {
      const owner = await seedUser(pool, scope, 0)
      const campaignId = await seedActiveCampaign(pool, scope, owner, 0)
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${campaignId}/active`,
        headers: { 'x-mythrun-dev-sub': stranger.devSub },
      })
      expect(res.statusCode).toBe(403)
    })
  })

  describe('GET /:sessionId/messages', () => {
    it('returns persisted messages after the given seq, default 0', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      const sessionId = await startAndGetSessionId(app, campaignId, owner.devSub)
      await appendMsg(pool, sessionId, 1, owner.userId)
      await appendMsg(pool, sessionId, 2, null)

      // No afterSeq → default 0 → full history.
      const all = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/messages`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(all.statusCode).toBe(200)
      expect(all.json<{ messages: { seq: number }[] }>().messages.map((m) => m.seq)).toEqual([1, 2])

      // afterSeq=1 returns only seq 2.
      const after = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/messages?afterSeq=1`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(after.statusCode).toBe(200)
      expect(after.json<{ messages: { seq: number }[] }>().messages.map((m) => m.seq)).toEqual([2])
    })

    // Strict /^\d+$/ parse: each of these would be silently coerced by a bare
    // Number() (''→0 = full history, hex/exponent accepted, float truncated),
    // so they must 400 rather than quietly returning a wrong window.
    it.each([
      ['negative', '-1'],
      ['empty', ''],
      ['hex', '0x10'],
      ['exponent', '1e3'],
      ['float', '1.5'],
      ['word', 'abc'],
    ])('rejects a malformed afterSeq (%s) → 400', async (_label, value) => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      const sessionId = await startAndGetSessionId(app, campaignId, owner.devSub)
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/messages?afterSeq=${encodeURIComponent(value)}`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json<{ code: string }>().code).toBe('bad_after_seq')
    })

    it('non-member → 403', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      const sessionId = await startAndGetSessionId(app, campaignId, owner.devSub)
      const stranger = await seedUser(pool, scope, 1)
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/messages`,
        headers: { 'x-mythrun-dev-sub': stranger.devSub },
      })
      expect(res.statusCode).toBe(403)
    })

    it('absent sessionId → 404', async () => {
      const owner = await seedUser(pool, scope, 0)
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${uuidv7()}/messages`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json<{ code: string }>().code).toBe('session_not_found')
    })
  })

  // ws-ticket regression guard: this app registers @fastify/rate-limit (like
  // the production boot), so a keyGenerator that reaches for request.dbUser at
  // onRequest 500s before the route runs. The older sessions.test.ts never
  // registered rate-limit, so it could not catch that. T7's WS upgrade depends
  // on ws-ticket minting a token, so a 200 here is load-bearing.
  describe('POST /:id/ws-ticket (under rate-limit)', () => {
    it('member → 200 with a ticket (keyGenerator does not 500 at onRequest)', async () => {
      const { owner, campaignId } = await seededActiveWithPrep(pool, scope, 0, 3)
      const sessionId = await startAndGetSessionId(app, campaignId, owner.devSub)
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/ws-ticket`,
        headers: { 'x-mythrun-dev-sub': owner.devSub },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ ticket: string; expiresAt: string }>()
      expect(body.ticket).toMatch(/^[0-9a-f]{64}$/)
      expect(Date.parse(body.expiresAt)).not.toBeNaN()
    })
  })
})
