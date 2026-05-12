// backend/src/llm/prep/cost-cap.ts
//
// Per MYT-51 D11 (revised after blind review):
//   - readCostCap: fail-loud on missing / unparseable row (Roc-Min3).
//   - sumCompletedStageCosts: explicit completed-filter (Wyvern-Imp4).
//   - issueCostCapRefund: marks world failed + inserts refund in one tx
//     (Hydra-C3 + Kraken-C1 fix).
//
// The worker reads the cap at the START of each stage (not 5min TTL),
// so this module's readCostCap fires ~5 times per world-gen run.

import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from '../../repo/uuidv7.js'

export class CostCapParseError extends Error {
  constructor(message: string) {
    super(`cost-cap parse: ${message}`)
    this.name = 'CostCapParseError'
  }
}

export async function readCostCap(pool: Pool): Promise<number> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'world_gen_cost_cap_usd'`,
  )
  if (result.rows.length === 0) {
    throw new CostCapParseError('row settings.world_gen_cost_cap_usd is missing')
  }
  const raw = result.rows[0]?.value ?? ''
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CostCapParseError(`value ${JSON.stringify(raw)} is not a positive number`)
  }
  return parsed
}

export async function sumCompletedStageCosts(
  pool: Pool | PoolClient,
  worldId: string,
): Promise<number> {
  const result = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
     FROM pipeline_runs
     WHERE world_id = $1
       AND user_id IS NULL
       AND status = 'completed'`,
    [worldId],
  )
  return result.rows[0]?.total ?? 0
}

export interface IssueCostCapRefundArgs {
  readonly userId: string
  readonly worldId: string
}

export async function issueCostCapRefund(
  pool: Pool,
  args: IssueCostCapRefundArgs,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE worlds SET status = 'failed' WHERE id = $1`,
      [args.worldId],
    )
    await client.query(
      `INSERT INTO credit_ledger
         (id, user_id, credit_type, amount, source_type,
          source_purchase_id, source_billing_history_id)
       VALUES ($1, $2, 'world_gen', 1, 'cost_cap_refund', NULL, NULL)`,
      [uuidv7(), args.userId],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
