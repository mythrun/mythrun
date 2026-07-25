import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createRepo, expectCommitted } from '../index.js'
import { snapshotsNs } from '../snapshots.js'
import type { ClientLike } from '../_types.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('snapshots repo', () => {
  let pool: Pool
  let campaignId: string
  let otherCampaignId: string
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('snapshots')
  })
  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })
  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
    const userId = uuidv7()
    const worldId = uuidv7()
    campaignId = uuidv7()
    otherCampaignId = uuidv7()
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(0), scope.displayName(0), scope.username(0)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, $3, 'C', 'complete')`,
      [worldId, userId, scope.worldName(0)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [campaignId, worldId, userId, scope.campaignName(0)],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES ($1, $2, $3, $4, 'setup')`,
      [otherCampaignId, worldId, userId, scope.campaignName(1)],
    )
  })

  it('create returns the persisted row, round-tripping through getById', async () => {
    const repo = createRepo(pool)
    const created = await repo.snapshots.create({
      campaignId,
      label: 'pre-session-2',
      data: '{"entities":[]}',
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.campaignId).toBe(campaignId)
    expect(created.label).toBe('pre-session-2')
    expect(created.data).toBe('{"entities":[]}')
    expect(created.createdAt).toBeInstanceOf(Date)

    await expect(repo.snapshots.getById(created.id)).resolves.toEqual(created)
  })

  // Mirrors `users.create`'s defensive arm: RETURNING cannot legitimately come
  // back empty, so an empty result means something is wrong with the client and
  // must throw rather than hand back a half-built row.
  it('create defensively throws when INSERT returns no row (fake client)', async () => {
    const fake = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) }
    await expect(
      snapshotsNs(fake as unknown as ClientLike).create({
        campaignId: 'x',
        label: 'x',
        data: 'x',
      }),
    ).rejects.toThrow(/INSERT returned no row/)
  })

  it('getById returns null for an unknown id', async () => {
    const repo = createRepo(pool)
    await expect(repo.snapshots.getById(uuidv7())).resolves.toBeNull()
  })

  it('listByCampaign returns only that campaign’s snapshots, newest first', async () => {
    const repo = createRepo(pool)
    const first = await repo.snapshots.create({ campaignId, label: 'one', data: 'a' })
    const second = await repo.snapshots.create({ campaignId, label: 'two', data: 'b' })
    await repo.snapshots.create({ campaignId: otherCampaignId, label: 'elsewhere', data: 'c' })

    const rows = await repo.snapshots.listByCampaign(campaignId)
    expect(rows.map((r) => r.label)).toEqual(['two', 'one'])
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id])
  })

  it('listByCampaign is empty for a campaign with no snapshots', async () => {
    const repo = createRepo(pool)
    await expect(repo.snapshots.listByCampaign(otherCampaignId)).resolves.toEqual([])
  })

  it('getLatest returns the most recent snapshot for the campaign', async () => {
    const repo = createRepo(pool)
    await repo.snapshots.create({ campaignId, label: 'one', data: 'a' })
    const newest = await repo.snapshots.create({ campaignId, label: 'two', data: 'b' })
    await repo.snapshots.create({ campaignId: otherCampaignId, label: 'elsewhere', data: 'c' })

    await expect(repo.snapshots.getLatest(campaignId)).resolves.toEqual(newest)
  })

  it('getLatest returns null when the campaign has no snapshots', async () => {
    const repo = createRepo(pool)
    await expect(repo.snapshots.getLatest(campaignId)).resolves.toBeNull()
  })

  // `created_at DEFAULT now()` is TRANSACTION time in Postgres, so two snapshots
  // written inside one transaction carry the SAME created_at. Ordering on the
  // timestamp alone would make "latest" a coin flip; the UUIDv7 id tiebreak is
  // what actually keeps it deterministic. This is the case that proves it.
  it('orders deterministically when two snapshots share a transaction timestamp', async () => {
    const repo = createRepo(pool)
    const written = expectCommitted(
      await repo.transaction(async (tx) => {
        const a = await tx.snapshots.create({ campaignId, label: 'tx-first', data: 'a' })
        const b = await tx.snapshots.create({ campaignId, label: 'tx-second', data: 'b' })
        return { a, b }
      }),
    )
    expect(written.a.createdAt.getTime()).toBe(written.b.createdAt.getTime())

    const rows = await repo.snapshots.listByCampaign(campaignId)
    expect(rows.map((r) => r.label)).toEqual(['tx-second', 'tx-first'])
    await expect(repo.snapshots.getLatest(campaignId)).resolves.toEqual(written.b)
  })
})
