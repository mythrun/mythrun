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
import { settingsNs } from '../../repo/settings.js'
import { pipelineRunsNs } from '../../repo/pipeline-runs.js'
import { createRepo, expectCommitted } from '../../repo/index.js'

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

/**
 * Parse a settings cap value (or its absence) into a positive number, throwing
 * CostCapParseError on a missing row / non-positive / unparseable value. Shared
 * by readCostCap and the coherence-pass handler (which reads the cap via the
 * repo's `settings.getValue` directly, since it holds a Repo not a client).
 */
export function parseCostCapValue(key: string, raw: string | null): number {
  // settings.value is NOT NULL per schema, so a null here means a MISSING row.
  if (raw === null) {
    throw new CostCapParseError(`row settings.${key} is missing`)
  }
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CostCapParseError(`${key} value ${JSON.stringify(raw)} is not a positive number`)
  }
  return parsed
}

export async function readCostCap(pool: Pool | PoolClient): Promise<number> {
  const raw = await settingsNs(pool).getValue('world_gen_cost_cap_usd')
  return parseCostCapValue('world_gen_cost_cap_usd', raw)
}

export async function sumCompletedStageCosts(
  pool: Pool | PoolClient,
  worldId: string,
): Promise<number> {
  // SQL homed in repo.pipelineRuns.sumCostForWorld (verbatim). This wrapper
  // keeps the existing (pool|client, worldId) signature for the world-gen
  // processor + coherence-pass + character processors.
  return pipelineRunsNs(pool).sumCostForWorld(worldId)
}

// Per myth-y1fs T5 (MYT-53 §Cost-cap coverage):
//   Per-player character-creation pipeline_runs rows are keyed on
//   (campaign_id, user_id) with world_id NULL — the world-gen
//   sumCompletedStageCosts above filters by `user_id IS NULL` and excludes
//   them. The two parallel exports below let each per-player job pre-check
//   the cap against its own campaign-scoped aggregate.
export async function readCharacterCreationCostCap(pool: Pool | PoolClient): Promise<number> {
  const raw = await settingsNs(pool).getValue('character_creation_cost_cap_usd')
  return parseCostCapValue('character_creation_cost_cap_usd', raw)
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
  //
  // myth-gp2c Cluster C: SQL homed in repo.pipelineRuns.sumCharacterCreationStageCosts
  // (verbatim). This wrapper keeps the existing (pool|client, campaignId) signature
  // for the per-player character-creation processor; the integration stage reads
  // it via repo.pipelineRuns directly (mirrors coherence-pass's cap reads).
  return pipelineRunsNs(pool).sumCharacterCreationStageCosts(campaignId)
}

export interface IssueCostCapRefundArgs {
  readonly userId: string
  readonly worldId: string
}

export async function issueCostCapRefund(pool: Pool, args: IssueCostCapRefundArgs): Promise<void> {
  // Was a hand-rolled BEGIN/COMMIT; now the unified `repo.transaction`
  // primitive owns connect → BEGIN → COMMIT/ROLLBACK → release. The two writes
  // (mark the world failed + insert the +1 refund row) compose over the tx
  // client. A throw inside the callback (e.g. the credit_ledger FK violation
  // for a missing user) propagates with the world-status UPDATE rolled back —
  // the same atomicity the prior hand-managed tx guaranteed. No slow I/O is
  // inside the callback (MYT-55-safe). SQL byte-identical, relocated into the
  // worlds / credits binders.
  const repo = createRepo(pool)
  expectCommitted(
    await repo.transaction(async (tx) => {
      await tx.worlds.markFailed(args.worldId)
      await tx.credits.insertCostCapRefund({ id: uuidv7(), userId: args.userId })
    }),
  )
}
