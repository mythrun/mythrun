// backend/src/repo/world-snapshot-view.ts
//
// myth-exac T19: runtime snapshot composition for the world-snapshot
// endpoint. Distinct from the prototype-era `world_snapshots` table
// (labeled save games) — different data, different module. Naming
// convention here is `worldSnapshotView` to avoid grep collision.
//
// Composes 7 read queries:
//   1. worlds (allowlist projection — see WorldSummary)
//   2. entities.listByWorld (tier-filtered)
//   3. facts.listByEntities (tier-filtered, scoped to entity set)
//   4. proseKernels.listByEntities (scoped to entity set)
//   5. entityHierarchy.listForWorld (post-filtered to entity set)
//   6. statBlocks.listByIds (scoped to entity set's referenced stat blocks)
//   7. relationships.listAmong (DB-filtered to entities-internal pairs)
//
// The WorldSummary allowlist is the wire-shape gate. The worlds table
// holds plot-bearing columns (`key_tensions`, `political_summary`,
// `starting_situations`, `follow_up_questions`, etc.) that must NEVER
// reach a Fast-Thinker prompt. Bypass widens the entity/fact tiers but
// the WorldSummary stays narrow — bypass is for ST/prep visibility into
// hidden entities, not for re-exposing plot-engineering fields on the
// world itself.

import type { ClientLike } from './_types.js'
import type { AccessLevel } from './facts.js'
import type { FactRow } from './facts.js'
import type { Entity } from './entities.js'
import { entities } from './entities.js'
import { facts } from './facts.js'
import type { ProseKernelRow } from './prose-kernels.js'
import { proseKernels } from './prose-kernels.js'
import type { RelationshipRow } from './relationships.js'
import { relationships } from './relationships.js'
import type { EntityHierarchyRow } from './entity-hierarchy.js'
import { entityHierarchy } from './entity-hierarchy.js'
import type { StatBlockRow } from './stat-blocks.js'
import { statBlocks } from './stat-blocks.js'
import { worldsNs, type WorldSummary } from './worlds.js'

// The allowlist projection (the WorldSummary type + its column list) is
// single-sourced in worlds.ts (`getSnapshotSummary`). Re-exported here for
// back-compat — `WorldSummary` was historically declared in this module.
export type { WorldSummary } from './worlds.js'

export interface WorldSnapshot {
  readonly world: WorldSummary
  readonly entities: readonly Entity[]
  readonly facts: readonly FactRow[]
  readonly relationships: readonly RelationshipRow[]
  readonly proseKernels: readonly ProseKernelRow[]
  readonly entityHierarchy: readonly EntityHierarchyRow[]
  readonly statBlocks: readonly StatBlockRow[]
}

interface EntityStatBlockRefRow {
  readonly stat_block_id: string | null
}

async function fetch(
  client: ClientLike,
  worldId: string,
  opts: { readonly bypass: boolean },
): Promise<WorldSnapshot> {
  const accessLevels: readonly AccessLevel[] = opts.bypass
    ? ['known', 'discoverable', 'secret']
    : ['known']

  // 1. World allowlist projection — single-sourced in
  //    worlds.getSnapshotSummary, the enforced-ignorance gate. No
  //    plot-bearing column ever lands on the wire shape, even if the worlds
  //    table grows new columns later.
  const summary = await worldsNs(client).getSnapshotSummary(worldId)
  if (summary === null) {
    throw new Error(`world-snapshot-view: world ${worldId} not found`)
  }
  // getSnapshotSummary returns the full registry; the snapshot view applies
  // the per-tier filter on top. Entries are tier-filtered against the same
  // accessLevels list used for entities/facts; adjacent_franchises is
  // metadata (not player-secret content) and always surfaces.
  const filteredEntries = summary.vocabularyRegistry.entries.filter((e) =>
    accessLevels.includes(e.access_level),
  )
  const world: WorldSummary = {
    ...summary,
    vocabularyRegistry: {
      entries: filteredEntries,
      adjacent_franchises: summary.vocabularyRegistry.adjacent_franchises,
    },
  }

  // 2. Tier-filtered entities. Empty result is fine — the rest of the
  //    composition handles empty entity sets via the empty-input
  //    short-circuits inherent to T04/T05/T06/T07's repo methods.
  const entityRows = await entities.listByWorld(client, worldId, { accessLevels })
  const entityIds = entityRows.map((e) => e.id)
  const entityIdSet = new Set(entityIds)

  // Stat-block IDs referenced by the surfaced entity set. The Entity
  // type returned from entities.listByWorld doesn't carry stat_block_id
  // (T05 keeps the row minimal), so we query the column directly here
  // rather than thread it through the existing repo.
  const statBlockIds = await readStatBlockIds(client, entityIds)

  // 3+4+5+6+7. Parallel: facts, prose, hierarchy, stat blocks,
  // relationships. listAmong, listByEntities (×2), and listByIds all
  // short-circuit on empty input.
  const [
    factRows,
    proseRows,
    hierarchyRows,
    statBlockRows,
    relationshipRows,
  ] = await Promise.all([
    facts.listByEntities(client, entityIds, { accessLevels }),
    proseKernels.listByEntities(client, entityIds),
    entityHierarchy.listForWorld(client, worldId),
    statBlocks.listByIds(client, statBlockIds),
    relationships.listAmong(client, entityIds),
  ])

  // Hierarchy listForWorld returns every edge in the world; constrain
  // to pairs where both endpoints survived the tier filter. listAmong
  // already does this for relationships at the DB level.
  const hierarchyFiltered = hierarchyRows.filter(
    (h) => entityIdSet.has(h.parentEntityId) && entityIdSet.has(h.childEntityId),
  )

  return {
    world,
    entities: entityRows,
    facts: factRows,
    relationships: relationshipRows,
    proseKernels: proseRows,
    entityHierarchy: hierarchyFiltered,
    statBlocks: statBlockRows,
  }
}

// Inline helper rather than a new entities repo method — this read is
// internal to the snapshot composition. If a second caller materializes
// later it can be lifted up.
async function readStatBlockIds(
  client: ClientLike,
  entityIds: readonly string[],
): Promise<readonly string[]> {
  // Defensive: caller passes the result of entities.listByWorld; an
  // empty entityIds list is reachable only when a world has zero
  // entities, a tier-filter-degenerate case the snapshot endpoint
  // surfaces with an empty payload.
  /* c8 ignore start */
  if (entityIds.length === 0) return []
  /* c8 ignore stop */
  const result = await client.query<EntityStatBlockRefRow>(
    `SELECT stat_block_id FROM entities
      WHERE id = ANY($1) AND stat_block_id IS NOT NULL`,
    [entityIds],
  )
  return result.rows
    .map((r) => r.stat_block_id)
    .filter((v): v is string => v !== null)
}

export const worldSnapshotView = { fetch } as const
