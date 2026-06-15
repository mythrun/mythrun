// backend/src/llm/prep/stages/embed-world.ts
//
// MYT-71 Task 10 — the world-gen embed stage. Runs AFTER coherence_pass (the
// last content stage) and BEFORE worlds.status flips to 'complete', so a world
// is semantically searchable the moment it lands. Embeds the freshly-generated
// world's un-embedded facts + entities via embedWorld (the T9 write-path).
//
// TOTAL STAGE CONTRACT: this stage must NEVER fail the world. The world-gen
// loop's invariant is "any thrown error → handleStageError → world failed", so
// a stage that must not fail catches its own errors. embedWorld already catches
// Voyage round-trip failures internally (returning voyageErrors>0 instead of
// throwing) — but it CAN throw on a DB write error. The try/catch here covers
// BOTH: any throw → log a warning, leave the affected rows NULL (retryable by
// the operational backfill), and return zero cost.
//
// COST: Voyage spend is OFF the Anthropic cost cap, so this stage ALWAYS
// reports { costUsd: 0, inputTokens: 0, outputTokens: 0 } regardless of how
// many rows it embedded. The processor reads these into pipeline_runs and the
// cumulative cost check, which must not see Voyage cost.
//
// NULL-ONLY: `embedWorld` is called WITHOUT `force`, so only un-embedded rows
// are embedded (a full re-embed = a real Voyage spend event, never appropriate
// for a just-generated world whose rows are all NULL anyway).

import type pino from 'pino'
import { embedWorld } from '../../../world/retrieval/index.js'
import { createVoyageEmbedder } from '../../embed.js'
import type { Repo } from '../../../repo/index.js'
import type { StageCost } from '../world-gen-processor.js'

export interface EmbedWorldStageDeps {
  readonly worldId: string
  readonly voyageApiKey: string
  readonly logger: pino.Logger
}

// Zero-cost result: Voyage spend never touches the Anthropic cost cap, so this
// stage always reports zero across all three counters (see module header).
const ZERO_COST: StageCost = { costUsd: 0, inputTokens: 0, outputTokens: 0 }

/**
 * Embed the world's un-embedded facts + entities. TOTAL: never throws, never
 * fails the world. On any error (Voyage exhaustion that escapes embedWorld's own
 * guard, or a DB write error mid-embed) it logs `world_gen.embed_world_failed`,
 * leaves the affected rows NULL for the operational backfill to retry, and
 * returns zero cost. On success it logs `world_gen.embed_world` with the
 * per-run tally.
 */
export async function runEmbedWorldStage(
  repo: Repo,
  deps: EmbedWorldStageDeps,
): Promise<StageCost> {
  const embedder = createVoyageEmbedder({ apiKey: deps.voyageApiKey })
  try {
    const summary = await embedWorld({ embedder, repo }, deps.worldId)
    deps.logger.info(
      { event: 'world_gen.embed_world', worldId: deps.worldId, ...summary },
      'world-gen embed stage completed',
    )
  } catch (err) {
    deps.logger.warn(
      { event: 'world_gen.embed_world_failed', worldId: deps.worldId, err },
      'world-gen embed stage failed; rows left NULL for backfill retry',
    )
  }
  return ZERO_COST
}
