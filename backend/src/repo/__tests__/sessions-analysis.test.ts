import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createSessionsRepo } from '../sessions.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'
import type { SessionHandoff } from '../../llm/schemas/post-session-analysis.js'

// MYT-74b T7 — markEnded / writeAnalysis / getPriorContextForPrep against real PG.
// session_usage is RESTRICT-FK to campaigns; this file never writes session_usage,
// but mirror sessions.test.ts's scope-then-cleanup ordering for safety.
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

function makeHandoff(): SessionHandoff {
  return {
    party: [{ characterName: 'Bram', location: 'the cellar', condition: 'wounded' }],
    timeOfDay: 'dusk',
    unresolvedThreads: ['the locked door'],
    npcs: [{ name: 'Mira', state: 'wary of the party', voice: ['You should not have come.'] }],
    keyLocations: [{ name: 'the cellar', atmosphere: 'damp and cold' }],
  }
}

describe('sessions analysis repo (integration)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sessanalysis')
  })

  afterAll(async () => {
    await cleanupSessionsScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupSessionsScope(pool, scope)
  })

  describe('markEnded', () => {
    it('flips active → ended once (1), no-ops thereafter (0)', async () => {
      const sessions = createSessionsRepo(pool)
      const { campaignId } = await makeCampaign(pool, scope)
      const s = await sessions.create({ campaignId, sessionNumber: 1 })
      expect(s.status).toBe('active')
      expect(s.endedAt).toBeNull()

      const first = await sessions.markEnded(s.id)
      expect(first).toBe(1)

      const ended = await sessions.getById(s.id)
      expect(ended?.status).toBe('ended')
      expect(ended?.endedAt).toBeInstanceOf(Date)

      const second = await sessions.markEnded(s.id)
      expect(second).toBe(0)
    })
  })

  describe('writeAnalysis', () => {
    it('persists summary+handoff once (1), no-ops on a second write (0)', async () => {
      const sessions = createSessionsRepo(pool)
      const { campaignId } = await makeCampaign(pool, scope)
      const s = await sessions.create({ campaignId, sessionNumber: 1 })
      const handoff = makeHandoff()

      const first = await sessions.writeAnalysis(s.id, {
        summary: 'S',
        emergingThreads: ['t1'],
        handoff,
      })
      expect(first).toBe(1)

      const written = await sessions.getById(s.id)
      expect(written?.summary).not.toBeNull()
      expect(written?.handoff).not.toBeNull()
      expect(JSON.parse(written?.summary ?? '')).toEqual({
        summary: 'S',
        emergingThreads: ['t1'],
      })
      expect(JSON.parse(written?.handoff ?? '')).toEqual(handoff)

      const second = await sessions.writeAnalysis(s.id, {
        summary: 'OTHER',
        emergingThreads: ['t2'],
        handoff,
      })
      expect(second).toBe(0)
      // The original write is untouched.
      const after = await sessions.getById(s.id)
      expect(JSON.parse(after?.summary ?? '')).toEqual({ summary: 'S', emergingThreads: ['t1'] })
    })
  })

  describe('getLatestEndedRecap (myth-lhp99)', () => {
    it('returns the NEWEST ended session (facts + raw summary), or null when none ended', async () => {
      const sessions = createSessionsRepo(pool)
      const { campaignId } = await makeCampaign(pool, scope)

      // No sessions at all → null.
      expect(await sessions.getLatestEndedRecap(campaignId)).toBeNull()

      // An ACTIVE session alone does not count.
      const s1 = await sessions.create({ campaignId, sessionNumber: 1 })
      expect(await sessions.getLatestEndedRecap(campaignId)).toBeNull()

      // Ended, analysis not yet written → facts with summaryJson null.
      await sessions.markEnded(s1.id)
      const pending = await sessions.getLatestEndedRecap(campaignId)
      expect(pending).toEqual({
        sessionNumber: 1,
        endedAt: expect.any(Date) as Date,
        summaryJson: null,
      })

      // A newer ended session with a written analysis wins (ORDER BY session_number DESC).
      const s2 = await sessions.create({ campaignId, sessionNumber: 2 })
      await sessions.markEnded(s2.id)
      await sessions.writeAnalysis(s2.id, {
        summary: 'S2',
        emergingThreads: ['t'],
        handoff: { npcs: [] },
      })
      const latest = await sessions.getLatestEndedRecap(campaignId)
      expect(latest?.sessionNumber).toBe(2)
      expect(latest?.summaryJson).not.toBeNull()
    })
  })

  describe('getPriorContextForPrep', () => {
    it('returns ended-with-summary sessions newest-first, excluding active and summary-NULL, capped to limit', async () => {
      const sessions = createSessionsRepo(pool)
      const { campaignId } = await makeCampaign(pool, scope)
      const handoff = makeHandoff()

      // Sessions 1, 2, 3: ended + analysis written.
      for (const n of [1, 2, 3]) {
        const s = await sessions.create({ campaignId, sessionNumber: n })
        await sessions.markEnded(s.id)
        await sessions.writeAnalysis(s.id, {
          summary: `summary-${String(n)}`,
          emergingThreads: [`thread-${String(n)}`],
          handoff,
        })
      }
      // Session 4: ended but NO analysis (summary IS NULL) — excluded.
      const noAnalysis = await sessions.create({ campaignId, sessionNumber: 4 })
      await sessions.markEnded(noAnalysis.id)
      // Session 5: active (never ended) — excluded.
      await sessions.create({ campaignId, sessionNumber: 5 })

      const ctx = await sessions.getPriorContextForPrep(campaignId, 2)
      // LIMIT 2, newest-first ⇒ sessions 3 then 2.
      expect(ctx.map((r) => r.sessionNumber)).toEqual([3, 2])
      // Raw column strings returned; the processor owns parsing.
      expect(JSON.parse(ctx[0]?.summaryJson ?? '')).toEqual({
        summary: 'summary-3',
        emergingThreads: ['thread-3'],
      })
      expect(JSON.parse(ctx[0]?.handoffJson ?? '')).toEqual(handoff)
    })
  })
})
