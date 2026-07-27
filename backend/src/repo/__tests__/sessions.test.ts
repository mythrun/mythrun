import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createSessionsRepo } from '../sessions.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

// myth-5jdo: session_usage.campaign_id is RESTRICT-FK to campaigns — must
// delete session_usage rows tied to the scope's campaigns BEFORE the shared
// cleanupTestScope removes the campaigns themselves.
async function cleanupSessionsScope(p: Pool, scope: TestScope): Promise<void> {
  await p.query(
    `DELETE FROM session_usage
       WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE $1)`,
    [`${scope.id}%`],
  )
  await cleanupTestScope(p, scope)
}

const databaseUrl = process.env.DATABASE_URL ?? ''

async function makeCampaign(pool: Pool, scope: TestScope): Promise<{ campaignId: string }> {
  const users = createUsersRepo(pool)
  const worlds = createWorldsRepo(pool)
  const campaigns = createCampaignsRepo(pool)
  const owner = await users.create(pool, {
    cognitoSub: scope.userSub(0),
    displayName: scope.displayName(0),
    username: scope.username(0),
  })
  const world = await worlds.create({
    createdBy: owner.id,
    name: scope.worldName(0),
    concept: 'c',
  })
  const c = await campaigns.create({
    worldId: world.id,
    createdBy: owner.id,
    name: scope.campaignName(0),
  })
  return { campaignId: c.id }
}

describe('sessions repo (integration)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sess')
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupSessionsScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    // myth-5jdo: scoped cleanup replaces resetData.
    await cleanupSessionsScope(pool, scope)
  })

  it('create returns a session with default status=active', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.campaignId).toBe(campaignId)
    expect(s.sessionNumber).toBe(1)
    expect(s.status).toBe('active')
    expect(s.startedAt).toBeInstanceOf(Date)
    expect(s.endedAt).toBeNull()
  })

  it('getById returns null for unknown session', async () => {
    const sessions = createSessionsRepo(pool)
    expect(await sessions.getById('019dccef-0000-7000-8000-000000000000')).toBeNull()
  })

  it('getById returns the session when present', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const created = await sessions.create({ campaignId, sessionNumber: 1 })
    const found = await sessions.getById(created.id)
    expect(found?.id).toBe(created.id)
    expect(found?.status).toBe('active')
  })

  it('update throws when the session does not exist', async () => {
    const sessions = createSessionsRepo(pool)
    await expect(
      sessions.update('019dccef-0000-7000-8000-000000000000', { summary: 'x' }),
    ).rejects.toThrow(/no session with id/)
  })

  it('create defensively throws when INSERT returns no row (fake pool)', async () => {
    // Real PG always returns a row from INSERT...RETURNING *. The defensive
    // `if (!row)` exists to surface a programmer error if that ever changes.
    const fakePool = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as Pool
    const sessions = createSessionsRepo(fakePool)
    await expect(
      sessions.create({ campaignId: '019dccef-0000-7000-8000-000000000000', sessionNumber: 1 }),
    ).rejects.toThrow(/INSERT returned no row/)
  })

  it('getActiveByCampaign returns the active session', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const created = await sessions.create({ campaignId, sessionNumber: 1 })
    const active = await sessions.getActiveByCampaign(campaignId)
    expect(active?.id).toBe(created.id)
  })

  it('getActiveByCampaign returns null when no active session', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    expect(await sessions.getActiveByCampaign(campaignId)).toBeNull()
  })

  it('getActiveByCampaign skips ended sessions', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.update(s.id, { status: 'ended', endedAt: new Date() })
    expect(await sessions.getActiveByCampaign(campaignId)).toBeNull()
  })

  it('update mutates supplied fields', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    const updated = await sessions.update(s.id, { summary: 'a recap' })
    expect(updated.summary).toBe('a recap')
    expect(updated.status).toBe('active')
  })

  it('listByCampaign returns DESC by startedAt', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const a = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.update(a.id, { status: 'ended', endedAt: new Date() })
    await new Promise((r) => setTimeout(r, 5))
    const b = await sessions.create({ campaignId, sessionNumber: 2 })
    const list = await sessions.listByCampaign(campaignId)
    expect(list.map((s) => s.id)).toEqual([b.id, a.id])
  })

  it('getMostRecentByCampaign returns null when the campaign has no sessions', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    expect(await sessions.getMostRecentByCampaign(campaignId)).toBeNull()
  })

  it('getMostRecentByCampaign returns the highest-session_number row (MYT-74a interlock)', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    // End session 1 before creating session 2 — idx_sessions_one_active forbids
    // two active rows on the same campaign. The reconcile interlock reads this
    // most-recent row's ended_at / reconciled_at tri-state.
    const a = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.update(a.id, { status: 'ended', endedAt: new Date() })
    const b = await sessions.create({ campaignId, sessionNumber: 2 })
    const recent = await sessions.getMostRecentByCampaign(campaignId)
    expect(recent?.id).toBe(b.id)
    expect(recent?.sessionNumber).toBe(2)
    expect(recent?.reconciledAt).toBeNull()
  })

  it('partial-unique idx_sessions_one_active prevents two concurrent active sessions', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    await sessions.create({ campaignId, sessionNumber: 1 })
    await expect(sessions.create({ campaignId, sessionNumber: 2 })).rejects.toThrow()
  })

  describe('recordUsage / budgetSummary (MYT-43)', () => {
    async function makeSession(): Promise<{ sessionId: string }> {
      const sessions = createSessionsRepo(pool)
      const { campaignId } = await makeCampaign(pool, scope)
      const s = await sessions.create({ campaignId, sessionNumber: 1 })
      return { sessionId: s.id }
    }

    it('first call inserts row with deltas + computed cost (sonnet)', async () => {
      const sessions = createSessionsRepo(pool)
      const { sessionId } = await makeSession()
      const result = await sessions.recordUsage(sessionId, 'claude-sonnet-5', {
        inputTokens: 1000,
        outputTokens: 500,
      })
      expect(result.inputTokens).toBe(1000)
      expect(result.outputTokens).toBe(500)
      // sonnet: 1000 * 3 + 500 * 15 = 10500 / 1M = 0.0105
      expect(result.estimatedCostUsd).toBeCloseTo(0.0105, 6)
    })

    it('second call increments existing row (mixed model)', async () => {
      const sessions = createSessionsRepo(pool)
      const { sessionId } = await makeSession()
      await sessions.recordUsage(sessionId, 'claude-haiku-4-5-20251001', {
        inputTokens: 1000,
        outputTokens: 100,
      })
      const result = await sessions.recordUsage(sessionId, 'claude-sonnet-5', {
        inputTokens: 500,
        outputTokens: 50,
      })
      expect(result.inputTokens).toBe(1500)
      expect(result.outputTokens).toBe(150)
    })

    it('cacheWriteTokens + cacheReadTokens go to separate columns', async () => {
      const sessions = createSessionsRepo(pool)
      const { sessionId } = await makeSession()
      const result = await sessions.recordUsage(sessionId, 'claude-sonnet-5', {
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 200,
        cacheReadTokens: 1000,
      })
      expect(result.inputTokens).toBe(100)
      expect(result.cacheWriteTokens).toBe(200)
      expect(result.cacheReadTokens).toBe(1000)
    })

    it('budgetSummary returns null for sessions with no usage', async () => {
      const sessions = createSessionsRepo(pool)
      const { sessionId } = await makeSession()
      expect(await sessions.budgetSummary(sessionId)).toBeNull()
    })

    it('budgetSummary returns the row after recordUsage', async () => {
      const sessions = createSessionsRepo(pool)
      const { sessionId } = await makeSession()
      const recorded = await sessions.recordUsage(sessionId, 'claude-haiku-4-5-20251001', {
        inputTokens: 1000,
        outputTokens: 100,
      })
      const summary = await sessions.budgetSummary(sessionId)
      expect(summary).toEqual(recorded)
    })

    it('recordUsage on non-existent session throws SessionNotFoundError', async () => {
      const sessions = createSessionsRepo(pool)
      const { SessionNotFoundError } = await import('../sessions-errors.js')
      const fakeId = '019700e0-0000-7000-8000-00000000ffff'
      await expect(
        sessions.recordUsage(fakeId, 'claude-haiku-4-5-20251001', {
          inputTokens: 100,
          outputTokens: 50,
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError)
    })
  })
})
