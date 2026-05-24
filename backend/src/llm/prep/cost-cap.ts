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

// MYT-54 T10: thrown by the character-integration handler's pre-flight when
// `sumCharacterCreationStageCosts + estimateIntegrationCost > cap`. The
// processor (T11) catches this and marks the pipeline_runs row failed with
// code `character_creation_cost_cap_exceeded`. Terminal — no BullMQ retry.
export class CostCapExceededError extends Error {
  readonly code = 'character_creation_cost_cap_exceeded'
  readonly terminal = true
  constructor(
    message: string,
    readonly details: {
      readonly spent: number
      readonly estimated: number
      readonly cap: number
    },
  ) {
    super(message)
    this.name = 'CostCapExceededError'
  }
}

export async function readCostCap(pool: Pool | PoolClient): Promise<number> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'world_gen_cost_cap_usd'`,
  )
  if (result.rows.length === 0) {
    throw new CostCapParseError('row settings.world_gen_cost_cap_usd is missing')
  }
  /* c8 ignore start — rows[0] is guaranteed by the length check above;
     the `?? ''` is defensive against a hypothetical row with NULL value
     that the settings.value NOT NULL constraint already prevents. */
  const raw = result.rows[0]?.value ?? ''
  /* c8 ignore stop */
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
  /* c8 ignore start — COALESCE(SUM(...), 0) always returns one row, so
     the `?? 0` falsy arm is unreachable; kept for TS optional-chain
     narrowing without a non-null assertion. */
  return result.rows[0]?.total ?? 0
  /* c8 ignore stop */
}

// Per myth-y1fs T5 (MYT-53 §Cost-cap coverage):
//   Per-player character-creation pipeline_runs rows are keyed on
//   (campaign_id, user_id) with world_id NULL — the world-gen
//   sumCompletedStageCosts above filters by `user_id IS NULL` and excludes
//   them. The two parallel exports below let each per-player job pre-check
//   the cap against its own campaign-scoped aggregate.
export async function readCharacterCreationCostCap(pool: Pool | PoolClient): Promise<number> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'character_creation_cost_cap_usd'`,
  )
  if (result.rows.length === 0) {
    throw new CostCapParseError('row settings.character_creation_cost_cap_usd is missing')
  }
  /* c8 ignore start — rows[0] is guaranteed by the length check above;
     the `?? ''` is defensive against a hypothetical row with NULL value
     that the settings.value NOT NULL constraint already prevents. */
  const raw = result.rows[0]?.value ?? ''
  /* c8 ignore stop */
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CostCapParseError(
      `character_creation_cost_cap_usd value ${JSON.stringify(raw)} is not a positive number`,
    )
  }
  return parsed
}

export async function sumCharacterCreationStageCosts(
  pool: Pool | PoolClient,
  campaignId: string,
): Promise<number> {
  // MYT-54: widened to include the campaign-scoped 'character_integration'
  // row (user_id IS NULL). Filter by stage rather than by user_id presence
  // so the per-player character_concept + character_sheet rows and the
  // campaign-scoped character_integration row all roll up into the same
  // character_creation_cost_cap_usd budget.
  const result = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
     FROM pipeline_runs
     WHERE campaign_id = $1
       AND status = 'completed'
       AND stage IN ('character_concept', 'character_sheet', 'character_integration')`,
    [campaignId],
  )
  /* c8 ignore start — COALESCE(SUM(...), 0) always returns one row, so
     the `?? 0` falsy arm is unreachable; kept for TS optional-chain
     narrowing without a non-null assertion. */
  return result.rows[0]?.total ?? 0
  /* c8 ignore stop */
}

export interface IssueCostCapRefundArgs {
  readonly userId: string
  readonly worldId: string
}

export async function issueCostCapRefund(pool: Pool, args: IssueCostCapRefundArgs): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE worlds SET status = 'failed' WHERE id = $1`, [args.worldId])
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
