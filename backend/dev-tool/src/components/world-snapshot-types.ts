// myth-exac T23+T24+T25 — wire-type mirrors for the world-snapshot panel.
//
// These shadow backend/src/repo/world-snapshot-view.ts (and its sub-repo
// types) at the dev-tool/backend boundary. Duplicated rather than imported
// across the workspace because the dev-tool tsconfig is intentionally
// self-contained (DOM lib + Bundler moduleResolution; the backend's
// nodenext build settings would clash). Any drift between these types and
// the backend's wire shape is caught by the contract tests on the backend
// side and by the dev-tool verifier's actual-fetch smoke.

export type EntityType = 'npc' | 'location' | 'faction' | 'item'

export type AccessLevel = 'known' | 'discoverable' | 'secret'

// Mirror of the backend's WikiWorldSummary (the plot-safe projection): the
// snapshot route dropped `concept` — the owner's raw plot-bearing seed — when
// it became member-readable (myth-0xwos follow-up). Type name kept as
// WorldSummary locally to minimize mirror churn.
export interface WorldSummary {
  readonly id: string
  readonly name: string
  readonly tone: string | null
  readonly themes: string | null
  readonly era: string | null
  readonly vocabularyRegistry: VocabularyRegistry // myth-pfke
}

// myth-pfke: per-world vocabulary registry types — mirror of the backend's
// VocabularyRegistry / VocabularyEntry shapes. Same justification as the
// other types in this file for the duplication (tsconfig boundaries
// between dev-tool and backend prevent cross-import).

export type VocabularyEntrySource = 'stage_1_5' | 'consolidation' | 'scribe_runtime'

export interface VocabularyEntry {
  readonly term: string
  readonly definition: string
  readonly avoids?: string
  readonly usage_notes?: string
  readonly source: VocabularyEntrySource
  readonly access_level: AccessLevel
}

export interface VocabularyRegistry {
  readonly entries: readonly VocabularyEntry[]
  readonly adjacent_franchises: readonly string[]
}

export interface EntityRow {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
  readonly accessLevel: AccessLevel
}

export interface FactRow {
  readonly id: string
  readonly entityId: string
  readonly topic: string
  readonly accessLevel: AccessLevel
  readonly narrativeStatus: string
  readonly content: string
  readonly source: string
  readonly createdAt: string | Date
  readonly updatedAt: string | Date
}

export interface ProseKernelRow {
  readonly id: string
  readonly entityId: string
  readonly content: string
  readonly createdAt: string | Date
  readonly updatedAt: string | Date
}

export interface RelationshipRow {
  readonly id: string
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
  readonly createdAt: string | Date
}

export interface EntityHierarchyRow {
  readonly id: string
  readonly parentEntityId: string
  readonly childEntityId: string
}

export interface StatBlockRow {
  readonly id: string
  readonly name: string
  readonly cr: string | null
  readonly armorClass: number
  readonly hitPoints: number
  readonly hitDice: string | null
  readonly speed: string
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly skills: string | null
  readonly senses: string | null
  readonly languages: string | null
  readonly createdAt: string | Date
}

export interface WorldSnapshotResponse {
  readonly world: WorldSummary
  readonly entities: readonly EntityRow[]
  readonly facts: readonly FactRow[]
  readonly relationships: readonly RelationshipRow[]
  readonly proseKernels: readonly ProseKernelRow[]
  readonly entityHierarchy: readonly EntityHierarchyRow[]
  readonly statBlocks: readonly StatBlockRow[]
}

/** Mutable counterpart for in-place delta application. Arrays are
 *  copy-on-load so we never mutate the readonly response shape. */
export interface LocalSnapshot {
  world: WorldSummary
  entities: EntityRow[]
  facts: FactRow[]
  relationships: RelationshipRow[]
  proseKernels: ProseKernelRow[]
  entityHierarchy: EntityHierarchyRow[]
  statBlocks: StatBlockRow[]
}

export function toMutableSnapshot(snap: WorldSnapshotResponse): LocalSnapshot {
  return {
    world: snap.world,
    entities: [...snap.entities],
    facts: [...snap.facts],
    relationships: [...snap.relationships],
    proseKernels: [...snap.proseKernels],
    entityHierarchy: [...snap.entityHierarchy],
    statBlocks: [...snap.statBlocks],
  }
}

// Discriminated union of the SSE arms the snapshot panel acts on. Other
// arms (stage-*, cost-update, entity-added, entity-removed, job-failed,
// stage-reset) arrive on the same stream but are ignored here — the
// live-events / status panels render those.
export type SseLiveEvent =
  | { type: 'phase'; phase: string }
  | { type: 'finalized'; synthKey: string; entityId: string }
  | { type: 'entity-updated'; synthKey: string; patch: Record<string, unknown> }
  | {
      type: 'edge-added'
      synthKey: string
      from: string
      to: string
      relationship: string
      description?: string
    }
  | { type: 'edge-removed'; synthKey: string; reason: string }
  | {
      type: 'fact-added'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }
  | { type: 'fact-removed'; entitySynthKey: string; factId: string }
  | {
      type: 'fact-updated'
      entitySynthKey: string
      factId: string
      topic: string
      content: string
      accessLevel: 'known' | 'discoverable' | 'secret'
    }

export interface SseClosePayload {
  readonly reason?: string
}

export interface SseSnapshotPayload {
  readonly phase: string
}

// Phases at which a coherent snapshot is fetchable. The backend's
// snapshot route 409s with snapshot_not_ready outside this set; we
// gate the fetch client-side to avoid the round-trip.
const POST_SNAPSHOT_PHASES = new Set<string>([
  'world_snapshot_ready',
  'world_ready',
  'character_creation',
  'post_creation',
  'complete',
])

export function isPostSnapshotPhase(phase: string | null): boolean {
  return phase !== null && POST_SNAPSHOT_PHASES.has(phase)
}
