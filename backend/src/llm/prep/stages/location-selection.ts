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

import type { Pool, PoolClient } from 'pg'

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
  client: Pool | PoolClient,
  args: LocationSelectionArgs,
): Promise<LocationSelectionResult> {
  const campaign = await client.query<{ starting_situation_index: number | null }>(
    `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
    [args.campaignId],
  )
  const idx = campaign.rows[0]?.starting_situation_index
  if (idx === null || idx === undefined) {
    throw new Error(
      `location-selection: campaigns.starting_situation_index is NULL for campaign ${args.campaignId} (owner has not chosen a starting situation)`,
    )
  }

  const world = await client.query<{ starting_situation_entries: SituationEntry[] }>(
    `SELECT starting_situation_entries FROM worlds WHERE id = $1`,
    [args.worldId],
  )
  const entries = world.rows[0]?.starting_situation_entries ?? []
  const entry = entries.find((e) => e.index === idx)
  if (entry === undefined) {
    throw new Error(
      `location-selection: no entry for index ${String(idx)} in worlds.starting_situation_entries for world ${args.worldId}`,
    )
  }

  const entityCheck = await client.query<{ id: string }>(
    `SELECT id FROM entities WHERE id = $1 AND world_id = $2`,
    [entry.locationEntityId, args.worldId],
  )
  if (entityCheck.rows.length === 0) {
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
