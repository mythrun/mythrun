// Integration tests for the Cluster-A "create world+campaign" transaction
// footprint authored as composable binder methods (data-layer-repo-unification
// foundation gate, task A + C).
//
// Each method here is the named, single-sourced home for one INSERT/lock that
// `executeCreateTransaction` (backend/src/routes/campaigns.ts) issues today as
// inline SQL on a hand-managed client. The SQL is verbatim from that site — the
// migration of executeCreateTransaction onto these methods is the NEXT task, so
// the methods' shapes are fixed by the current inline footprint.
//
// Targets mythrun_test via createTestPool + scoped fixtures (CONVENTIONS.md).
// These exercise the real BEGIN/COMMIT + advisory-lock + reread chain through
// repo.transaction against Postgres; the connection-ownership + advisory-lock
// serialization can only be verified against a live connection under
// concurrency.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createRepo, type TxRepo } from '../index.js'
import { InsufficientCreditsError } from '../credits-errors.js'
import { uuidv7 } from '../uuidv7.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'
import { createTestUser } from './_helpers/create-test-user.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

// Per-call SET LOCAL knobs that match executeCreateTransaction's prelude
// (lock_timeout 5s, statement_timeout 10s).
const CREATE_TX_OPTS = { lockTimeoutMs: 5000, statementTimeoutMs: 10000 } as const

describe('Cluster-A create-tx footprint (integration)', () => {
  let pool: Pool
  let scope: TestScope

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    scope = makeTestScope('create-tx')
  })

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupTestScope(pool, scope)
  })

  /** Grant `n` world_gen credits to `userId` (positive ledger row). */
  async function grantWorldGen(userId: string, n: number): Promise<void> {
    await pool.query(
      `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type)
       VALUES ($1, $2, 'world_gen', $3, 'gift')`,
      [uuidv7(), userId, n],
    )
  }

  it('worlds.insertGenerating writes a world row with status=generating and name default', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(0) })
    const worldId = uuidv7()

    await repo.transaction(async (tx) => {
      await tx.worlds.insertGenerating({
        id: worldId,
        createdBy: userId,
        concept: 'a verdant kingdom on the brink',
        devBypassAccessFilter: false,
      })
    }, CREATE_TX_OPTS)

    const row = await pool.query<{
      name: string
      concept: string
      status: string
      dev_bypass_access_filter: boolean
    }>(
      `SELECT name, concept, status, dev_bypass_access_filter FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(row.rows[0]?.name).toBe('Untitled')
    expect(row.rows[0]?.concept).toBe('a verdant kingdom on the brink')
    expect(row.rows[0]?.status).toBe('generating')
    expect(row.rows[0]?.dev_bypass_access_filter).toBe(false)
  })

  it('worlds.insertGenerating honors an explicit name and devBypassAccessFilter=true', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(1) })
    const worldId = uuidv7()

    await repo.transaction(async (tx) => {
      await tx.worlds.insertGenerating({
        id: worldId,
        createdBy: userId,
        name: scope.worldName(0),
        concept: 'c',
        devBypassAccessFilter: true,
      })
    }, CREATE_TX_OPTS)

    const row = await pool.query<{ name: string; dev_bypass_access_filter: boolean }>(
      `SELECT name, dev_bypass_access_filter FROM worlds WHERE id = $1`,
      [worldId],
    )
    expect(row.rows[0]?.name).toBe(scope.worldName(0))
    expect(row.rows[0]?.dev_bypass_access_filter).toBe(true)
  })

  it('campaigns.insertSetup writes a campaign row with name=Untitled and status=setup', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(2) })
    const worldId = uuidv7()
    const campaignId = uuidv7()

    await repo.transaction(async (tx) => {
      await tx.worlds.insertGenerating({
        id: worldId,
        createdBy: userId,
        name: scope.worldName(1),
        concept: 'c',
        devBypassAccessFilter: false,
      })
      await tx.campaigns.insertSetup({ id: campaignId, worldId, createdBy: userId })
    }, CREATE_TX_OPTS)

    const row = await pool.query<{ name: string; status: string; world_id: string }>(
      `SELECT name, status, world_id FROM campaigns WHERE id = $1`,
      [campaignId],
    )
    expect(row.rows[0]?.name).toBe('Untitled')
    expect(row.rows[0]?.status).toBe('setup')
    expect(row.rows[0]?.world_id).toBe(worldId)
  })

  it('campaigns.insertOwnerMember writes an owner member with invite_accepted=true', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(3) })
    const worldId = uuidv7()
    const campaignId = uuidv7()
    const memberId = uuidv7()

    await repo.transaction(async (tx) => {
      await tx.worlds.insertGenerating({
        id: worldId,
        createdBy: userId,
        name: scope.worldName(2),
        concept: 'c',
        devBypassAccessFilter: false,
      })
      await tx.campaigns.insertSetup({ id: campaignId, worldId, createdBy: userId })
      await tx.campaigns.insertOwnerMember({ id: memberId, campaignId, userId })
    }, CREATE_TX_OPTS)

    const row = await pool.query<{ role: string; invite_accepted: boolean; user_id: string }>(
      `SELECT role, invite_accepted, user_id FROM campaign_members WHERE id = $1`,
      [memberId],
    )
    expect(row.rows[0]?.role).toBe('owner')
    expect(row.rows[0]?.invite_accepted).toBe(true)
    expect(row.rows[0]?.user_id).toBe(userId)
  })

  it('credits.insertWorldGenDebit writes a -1 world_gen debit with source_id=worldId', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(4) })
    await grantWorldGen(userId, 1)
    const worldId = uuidv7()
    const ledgerId = uuidv7()

    await repo.transaction(async (tx) => {
      await tx.worlds.insertGenerating({
        id: worldId,
        createdBy: userId,
        name: scope.worldName(3),
        concept: 'c',
        devBypassAccessFilter: false,
      })
      await tx.credits.insertWorldGenDebit({ id: ledgerId, userId, worldId })
    }, CREATE_TX_OPTS)

    const row = await pool.query<{
      credit_type: string
      amount: number
      source_type: string
      source_id: string | null
      source_purchase_id: string | null
      source_billing_history_id: string | null
      expires_at: Date | null
    }>(
      `SELECT credit_type, amount, source_type, source_id,
              source_purchase_id, source_billing_history_id, expires_at
         FROM credit_ledger WHERE id = $1`,
      [ledgerId],
    )
    expect(row.rows[0]?.credit_type).toBe('world_gen')
    expect(row.rows[0]?.amount).toBe(-1)
    expect(row.rows[0]?.source_type).toBe('debit')
    expect(row.rows[0]?.source_id).toBe(worldId)
    expect(row.rows[0]?.source_purchase_id).toBeNull()
    expect(row.rows[0]?.source_billing_history_id).toBeNull()
    expect(row.rows[0]?.expires_at).toBeNull()
    // Net balance: granted 1, debited 1 → 0.
    expect(await repo.credits.getWorldGenBalance(userId)).toBe(0)
  })

  it('pipelineRuns.insertSeedRow writes a concept_intake pending row with NULL started_at + user_id', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(5) })
    const worldId = uuidv7()
    const runId = uuidv7()

    await repo.transaction(async (tx) => {
      await tx.worlds.insertGenerating({
        id: worldId,
        createdBy: userId,
        name: scope.worldName(4),
        concept: 'c',
        devBypassAccessFilter: false,
      })
      await tx.pipelineRuns.insertSeedRow({ id: runId, worldId })
    }, CREATE_TX_OPTS)

    const row = await pool.query<{
      stage: string
      status: string
      started_at: Date | null
      user_id: string | null
      world_id: string
    }>(
      `SELECT stage, status, started_at, user_id, world_id FROM pipeline_runs WHERE id = $1`,
      [runId],
    )
    expect(row.rows[0]?.stage).toBe('concept_intake')
    expect(row.rows[0]?.status).toBe('pending')
    expect(row.rows[0]?.started_at).toBeNull()
    expect(row.rows[0]?.user_id).toBeNull()
    expect(row.rows[0]?.world_id).toBe(worldId)
  })

  it('credits.acquireUserCreditLock runs inside a tx without error (advisory xact lock)', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(6) })

    // The lock is released on COMMIT; here we just assert it acquires and the
    // tx commits cleanly. Serialization behavior is exercised by the
    // concurrency smoke below.
    await expect(
      repo.transaction(async (tx) => {
        await tx.credits.acquireUserCreditLock(userId)
      }, CREATE_TX_OPTS),
    ).resolves.toBeUndefined()
  })

  it('the full create footprint commits atomically through one tx client', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(7) })
    await grantWorldGen(userId, 1)

    const { worldId, campaignId } = await replayCreateFootprint(repo, userId, scope.worldName(5))
    expect((await pool.query(`SELECT 1 FROM worlds WHERE id = $1`, [worldId])).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM campaigns WHERE id = $1`, [campaignId])).rowCount).toBe(1)
    expect(
      (await pool.query(`SELECT 1 FROM campaign_members WHERE campaign_id = $1`, [campaignId]))
        .rowCount,
    ).toBe(1)
    expect((await pool.query(`SELECT 1 FROM pipeline_runs WHERE world_id = $1`, [worldId])).rowCount).toBe(1)
    expect(await repo.credits.getWorldGenBalance(userId)).toBe(0)
  })

  // === Task C: the concurrency smoke (the gate) ===
  it('serializes two parallel creates on the advisory lock — exactly one wins with 1 credit', async () => {
    const repo = createRepo(pool)
    const { id: userId } = await createTestUser(pool, scope, { sub: scope.userSub(8) })
    await grantWorldGen(userId, 1)

    // Fire two create footprints in parallel. The advisory xact lock
    // serializes them: the winner debits the single credit; the loser's
    // under-lock balance reread sees 0 and throws InsufficientCreditsError.
    const [a, b] = await Promise.allSettled([
      replayCreateFootprint(repo, userId, scope.worldName(6)),
      replayCreateFootprint(repo, userId, scope.worldName(7)),
    ])

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled')
    const rejected = [a, b].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The loser rejects with the typed insufficient-credits error.
    expect(rejected[0]?.reason).toBeInstanceOf(InsufficientCreditsError)

    // Exactly one world row landed; balance is fully spent.
    const worldCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM worlds WHERE created_by = $1`,
      [userId],
    )
    expect(worldCount.rows[0]?.n).toBe(1)
    expect(await repo.credits.getWorldGenBalance(userId)).toBe(0)
  })
})

/**
 * Replay executeCreateTransaction's footprint through repo.transaction:
 * acquireUserCreditLock → getWorldGenBalance reread → throw if < 1 →
 * worlds.insertGenerating → campaigns.insertSetup → insertOwnerMember →
 * credits.insertWorldGenDebit → pipelineRuns.insertSeedRow. Returns the
 * created ids (post-commit) or throws InsufficientCreditsError.
 */
async function replayCreateFootprint(
  repo: ReturnType<typeof createRepo>,
  userId: string,
  worldName: string,
): Promise<{ worldId: string; campaignId: string }> {
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const memberId = uuidv7()
  const ledgerId = uuidv7()
  const runId = uuidv7()
  const out = await repo.transaction(async (tx: TxRepo) => {
    await tx.credits.acquireUserCreditLock(userId)
    const balance = await tx.credits.getWorldGenBalance(userId)
    if (balance < 1) {
      throw new InsufficientCreditsError(userId, 'world_gen', balance, 1)
    }
    await tx.worlds.insertGenerating({
      id: worldId,
      createdBy: userId,
      name: worldName,
      concept: 'c',
      devBypassAccessFilter: false,
    })
    await tx.campaigns.insertSetup({ id: campaignId, worldId, createdBy: userId })
    await tx.campaigns.insertOwnerMember({ id: memberId, campaignId, userId })
    await tx.credits.insertWorldGenDebit({ id: ledgerId, userId, worldId })
    await tx.pipelineRuns.insertSeedRow({ id: runId, worldId })
    return { worldId, campaignId }
  }, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 })
  // The footprint never returns ROLLBACK; narrow it out for the caller.
  if (typeof out === 'symbol') {
    throw new Error('unreachable: create footprint does not return ROLLBACK')
  }
  return out
}
