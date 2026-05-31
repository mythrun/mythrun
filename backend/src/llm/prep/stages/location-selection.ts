// backend/src/llm/prep/stages/location-selection.ts
//
// MYT-53 / myth-7kmz stage 1: no-LLM resolver. Reads
// campaigns.starting_situation_index, looks up
// worlds.starting_situation_entries[index], validates the referenced
// entity still exists (defensive against state drift between owner-pick
// time and fan-out time), and returns the resolved location entity id.
// Writes nothing — stage 4 re-derives the same id when writing the
// deferred "starts at $location" fact (spec §Stages, §Risks #3).
//
// Returns zeroed cost/usage so the worker's per-stage pipeline_runs
// accounting treats this like any other stage (just with $0 spend).

import type { Repo } from '../../../repo/index.js'

export interface LocationSelectionArgs {
  readonly campaignId: string
  readonly worldId: string
}

export interface LocationSelectionResult {
  readonly locationEntityId: string
  readonly costUsd: 0
  readonly inputTokens: 0
  readonly outputTokens: 0
}

interface SituationEntry {
  readonly index: number
  readonly locationEntityId: string
  readonly prose: string
}

export async function runLocationSelectionStage(
  repo: Repo,
  args: LocationSelectionArgs,
): Promise<LocationSelectionResult> {
  const idx = await repo.campaigns.getStartingSituationIndex(args.campaignId)
  if (idx === null) {
    throw new Error(
      `location-selection: campaigns.starting_situation_index is NULL for campaign ${args.campaignId} (owner has not chosen a starting situation)`,
    )
  }

  // worldId came from campaigns.world_id (FK to worlds.id) so the row
  // exists; starting_situation_entries is NOT NULL DEFAULT '[]'.
  const entries = await repo.worlds.getStartingSituationEntries<SituationEntry>(args.worldId)
  const entry = entries.find((e) => e.index === idx)
  /* c8 ignore start — drift-defense: campaigns.starting_situation_index
   * CHECK constrains it to {0,1,2}; starting_situation stage always emits 3
   * entries indexed 0/1/2. This throw fires only if the entries array
   * was mutated after world-gen — operator action, not happy path. */
  if (entry === undefined) {
    throw new Error(
      `location-selection: no entry for index ${String(idx)} in worlds.starting_situation_entries for world ${args.worldId}`,
    )
  }
  /* c8 ignore stop */

  const entityExists = await repo.entities.existsInWorld(entry.locationEntityId, args.worldId)
  if (!entityExists) {
    throw new Error(
      `location-selection: location entity not found — id=${entry.locationEntityId} world=${args.worldId} (state drift between owner pick and fan-out)`,
    )
  }

  return {
    locationEntityId: entry.locationEntityId,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
}
