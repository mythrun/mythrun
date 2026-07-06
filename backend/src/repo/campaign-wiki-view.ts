// backend/src/repo/campaign-wiki-view.ts
//
// MYT-74c — the PLAYER campaign-wiki read. A purpose-built narrow `known`-tier
// projection, distinct from the owner-only worldSnapshotView: the narrow wiki
// world summary (no `concept`), known entities (name + type), their known facts,
// and known-tier relationships among them. NO prose kernels, NO stat blocks —
// those are owner-snapshot content, not player-wiki content.
import type { ClientLike } from './_types.js'
import { entities } from './entities.js'
import { facts } from './facts.js'
import { relationships } from './relationships.js'
import { worldsNs, type WikiWorldSummary } from './worlds.js'
import type { FactRow } from './facts.js'
import type { RelationshipRow } from './relationships.js'

export interface WikiEntity {
  readonly id: string
  readonly name: string
  readonly entityType: string
}
export interface CampaignWiki {
  readonly world: WikiWorldSummary
  readonly entities: readonly WikiEntity[]
  readonly facts: readonly FactRow[]
  readonly relationships: readonly RelationshipRow[]
}

async function fetch(client: ClientLike, worldId: string): Promise<CampaignWiki> {
  const summary = await worldsNs(client).getWikiSummary(worldId)
  // The route guards null-world upstream (a wiki read is only reachable for a
  // campaign whose world_id FK is NOT NULL); this throw is the defensive floor.
  if (summary === null) throw new Error(`campaign-wiki-view: world ${worldId} not found`)
  const world: WikiWorldSummary = {
    ...summary,
    vocabularyRegistry: {
      entries: summary.vocabularyRegistry.entries.filter((e) => e.access_level === 'known'),
      adjacent_franchises: summary.vocabularyRegistry.adjacent_franchises,
    },
  }
  const entityRows = await entities.listByWorld(client, worldId, { accessLevels: ['known'] })
  const entityIds = entityRows.map((e) => e.id)
  const [factRows, relationshipRows] = await Promise.all([
    facts.listByEntities(client, entityIds, { accessLevels: ['known'], liveOnly: true }),
    // MYT-89 Phase A (A5): known-tier only. Without the tier filter a `secret`
    // relationship between two `known` entities would surface in the PLAYER
    // wiki — the endpoint filter alone can't catch it since both endpoints pass.
    relationships.listAmong(client, entityIds, ['known']),
  ])
  return {
    world,
    entities: entityRows.map((e) => ({ id: e.id, name: e.name, entityType: e.entityType })),
    facts: factRows,
    relationships: relationshipRows,
  }
}

export const campaignWikiView = { fetch } as const
