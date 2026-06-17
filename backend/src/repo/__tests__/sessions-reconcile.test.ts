import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { createWorldsRepo } from '../worlds.js'
import { createCampaignsRepo } from '../campaigns.js'
import { createSessionsRepo } from '../sessions.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

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

describe('sessions repo — reconciled_at conditional gate (integration)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('sess-rec')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  it('a fresh session has reconciledAt === null', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    const found = await sessions.getById(s.id)
    expect(found?.reconciledAt).toBeNull()
  })

  it('markReconciled returns 1 and sets reconciledAt non-null', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    const rows = await sessions.markReconciled(s.id)
    expect(rows).toBe(1)
    const found = await sessions.getById(s.id)
    expect(found?.reconciledAt).toBeInstanceOf(Date)
    expect(found?.reconciledAt).not.toBeNull()
  })

  it('second markReconciled returns 0 (conditional gate already set)', async () => {
    const sessions = createSessionsRepo(pool)
    const { campaignId } = await makeCampaign(pool, scope)
    const s = await sessions.create({ campaignId, sessionNumber: 1 })
    expect(await sessions.markReconciled(s.id)).toBe(1)
    expect(await sessions.markReconciled(s.id)).toBe(0)
  })
})
