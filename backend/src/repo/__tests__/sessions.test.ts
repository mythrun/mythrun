import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createSessionsRepo } from '../sessions.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino(
    { base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } },
    sink,
  )
}

const baseUserInput = {
  cognitoSub: 'g_owner',
  email: 'owner@x.com',
  displayName: 'Owner',
  username: 'owner',
  authProvider: 'google' as const,
}

async function makeCampaign(pool: Pool): Promise<{ campaignId: string }> {
  const users = createUsersRepo(pool)
  const worlds = createWorldsRepo(pool)
  const campaigns = createCampaignsRepo(pool)
  const owner = await users.create(pool, baseUserInput)
  const world = await worlds.create({ createdBy: owner.id, name: 'W', concept: 'c' })
  const c = await campaigns.create({ worldId: world.id, createdBy: owner.id, name: 'C' })
  return { campaignId: c.id }
}

describe('sessions repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  it('create returns a session with default status=active', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
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
    const { campaignId } = await makeCampaign(pool)
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
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as Pool
    const sessions = createSessionsRepo(fakePool)
    await expect(
      sessions.create({ campaignId: '019dccef-0000-7000-8000-000000000000', sessionNumber: 1 }),
    ).rejects.toThrow(/INSERT returned no row/)
  })

  it('getActiveByCampaign returns the active session', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const created = await sessions.create({ campaignId, sessionNumber: 1 })
    const active = await sessions.getActiveByCampaign(campaignId)
    expect(active?.id).toBe(created.id)
  })

  it('getActiveByCampaign returns null when no active session', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    expect(await sessions.getActiveByCampaign(campaignId)).toBeNull()
  })

  it('getActiveByCampaign skips ended sessions', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.update(s.id, { status: 'ended', endedAt: new Date() })
    expect(await sessions.getActiveByCampaign(campaignId)).toBeNull()
  })

  it('update mutates supplied fields', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    const updated = await sessions.update(s.id, { summary: 'a recap' })
    expect(updated.summary).toBe('a recap')
    expect(updated.status).toBe('active')
  })

  it('listByCampaign returns DESC by startedAt', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    const a = await sessions.create({ campaignId, sessionNumber: 1 })
    await sessions.update(a.id, { status: 'ended', endedAt: new Date() })
    await new Promise((r) => setTimeout(r, 5))
    const b = await sessions.create({ campaignId, sessionNumber: 2 })
    const list = await sessions.listByCampaign(campaignId)
    expect(list.map((s) => s.id)).toEqual([b.id, a.id])
  })

  it('partial-unique idx_sessions_one_active prevents two concurrent active sessions', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool)
    await sessions.create({ campaignId, sessionNumber: 1 })
    await expect(sessions.create({ campaignId, sessionNumber: 2 })).rejects.toThrow()
  })

  describe('recordUsage / budgetSummary (MYT-43)', () => {
    async function makeSession(): Promise<{ sessionId: string }> {
      const sessions = createSessionsRepo(pool)
      const { campaignId } = await makeCampaign(pool)
      const s = await sessions.create({ campaignId, sessionNumber: 1 })
      return { sessionId: s.id }
    }

    it('first call inserts row with deltas + computed cost (sonnet)', async () => {
      const sessions = createSessionsRepo(pool)
      const { sessionId } = await makeSession()
      const result = await sessions.recordUsage(sessionId, 'claude-sonnet-4-6', {
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
      const result = await sessions.recordUsage(sessionId, 'claude-sonnet-4-6', {
        inputTokens: 500,
        outputTokens: 50,
      })
      expect(result.inputTokens).toBe(1500)
      expect(result.outputTokens).toBe(150)
    })

    it('cacheWriteTokens + cacheReadTokens go to separate columns', async () => {
      const sessions = createSessionsRepo(pool)
      const { sessionId } = await makeSession()
      const result = await sessions.recordUsage(sessionId, 'claude-sonnet-4-6', {
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
