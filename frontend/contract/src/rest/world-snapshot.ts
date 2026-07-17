// REST response contract for the world-snapshot endpoint
// (`GET /api/campaigns/:campaignId/world-snapshot`). A FOCUSED projection of
// the backend `WorldSnapshot` (backend/src/repo/world-snapshot-view.ts): the
// runtime handler `reply.send()`s the full composition (world summary,
// relationships, prose kernels, stat blocks, …), but the wiki view model
// consumes only the display collections — entities, their `known`-tier facts,
// the location hierarchy, the entities' prose kernels, and the world's
// glossary (MYT-102). `z.object()` strips the unmodeled keys (same
// focused-projection pattern as `WorldGenSnapshotSchema` in
// client-core/api/campaigns.ts), so the richer payload validates and the extra
// columns fall away without a schema churn each time the backend view grows.
//
// Enforced ignorance is a SERVER concern: for the owner the endpoint already
// returned only `known`-tier entities/facts. This schema does no tier logic —
// the tier is decided upstream by which endpoint served the payload (MYT-94
// will add a character-scoped one). See `toWikiViewModel` in client-core.
import { z } from 'zod'

// The entity_type CHECK domain (migration 001 + the 'pc' addition). 'pc' is
// included so a snapshot that carries an integrated player character still
// validates; the wiki view model groups only the four world-lore kinds and
// omits 'pc' (a PC is not world lore).
export const ENTITY_KINDS = ['npc', 'location', 'faction', 'item', 'pc'] as const
export const EntityKindSchema = z.enum(ENTITY_KINDS)
export type EntityKind = z.infer<typeof EntityKindSchema>

// One entity row on the wire (backend `Entity`, camelCase). `worldId` /
// `accessLevel` exist on the payload but are NOT modeled — the wiki does not
// consume them, so they strip away.
export const WorldSnapshotEntitySchema = z.object({
  id: z.string(),
  entityType: EntityKindSchema,
  name: z.string(),
})
export type WorldSnapshotEntity = z.infer<typeof WorldSnapshotEntitySchema>

// One fact row (backend `FactRow`), narrowed to the display fields. `entityId`
// is the owning entity (the wiki keys facts onto it). `accessLevel` /
// `narrativeStatus` / `source` / timestamps strip away.
export const WorldSnapshotFactSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  topic: z.string(),
  content: z.string(),
})
export type WorldSnapshotFact = z.infer<typeof WorldSnapshotFactSchema>

// One parent→child hierarchy edge (backend `EntityHierarchyRow`). Drives the
// nested-location tree; `id` is unmodeled (the tree keys on the endpoint ids).
export const WorldSnapshotHierarchyEdgeSchema = z.object({
  parentEntityId: z.string(),
  childEntityId: z.string(),
})
export type WorldSnapshotHierarchyEdge = z.infer<typeof WorldSnapshotHierarchyEdgeSchema>

// myth-zaqxh: the world-introduction page — the elevator-pitch prose every world
// opens on at the reveal. `title` is the world's name (mechanical, not
// LLM-invented); `prose` is a few paragraphs authored from the KNOWN-tier slice
// ONLY (enforced ignorance from birth); `references` is an ordered list of
// dig-deeper entities the intro points at, each resolved to a real snapshot
// entity (dangling picks are dropped server-side, so every `entityId` here is a
// member of `entities`).
export const WorldSnapshotIntroReferenceSchema = z.object({
  entityId: z.string(),
  name: z.string(),
})
export type WorldSnapshotIntroReference = z.infer<typeof WorldSnapshotIntroReferenceSchema>

export const WorldSnapshotIntroductionSchema = z.object({
  title: z.string(),
  prose: z.string(),
  references: z.array(WorldSnapshotIntroReferenceSchema),
})
export type WorldSnapshotIntroduction = z.infer<typeof WorldSnapshotIntroductionSchema>

// MYT-102 Track E: one entity's prose kernel — the actual DESCRIPTION of what
// the entity is, keyed onto its entity (backend `ProseKernelRow`, narrowed to
// the display pair; `id` / timestamps strip away). The server serves kernels
// for the known-tier entity set only (worldSnapshotView scopes the query to the
// tier-filtered entities) — the client does ZERO tier logic.
export const WorldSnapshotProseKernelSchema = z.object({
  entityId: z.string(),
  content: z.string(),
})
export type WorldSnapshotProseKernel = z.infer<typeof WorldSnapshotProseKernelSchema>

// One glossary row: the world's invented vocabulary as the wiki shows it.
// DISPLAY FIELDS ONLY — the stored entry's `access_level` / `source` / `avoids`
// / `usage_notes` are authoring metadata and strip at this boundary. The server
// already tier-filters entries to `known` for a member read.
export const WorldSnapshotGlossaryEntrySchema = z.object({
  term: z.string(),
  definition: z.string(),
})
export type WorldSnapshotGlossaryEntry = z.infer<typeof WorldSnapshotGlossaryEntrySchema>

// The world column of the snapshot, narrowed to the ONE field the wiki renders:
// the vocabulary registry's display entries. `adjacent_franchises` (real-world
// IP names) is DELIBERATELY unmodeled — z.object() strips it, so a franchise
// name can structurally never reach a render surface. The summary's other
// columns (id/name/tone/themes/era) strip the same way.
export const WorldSnapshotWorldSchema = z.object({
  vocabularyRegistry: z.object({
    entries: z.array(WorldSnapshotGlossaryEntrySchema),
  }),
})
export type WorldSnapshotWorld = z.infer<typeof WorldSnapshotWorldSchema>

export const WorldSnapshotSchema = z.object({
  // Optional at the contract layer even though a 200 response ALWAYS carries it
  // (the endpoint 409s until `world_introduction` commits, and the backend view
  // always composes it). Kept optional so every pre-existing snapshot fixture —
  // including the reveal/campaign-detail route tests that construct bare
  // snapshots — keeps validating; consumers read it defensively.
  introduction: WorldSnapshotIntroductionSchema.optional(),
  entities: z.array(WorldSnapshotEntitySchema),
  facts: z.array(WorldSnapshotFactSchema),
  entityHierarchy: z.array(WorldSnapshotHierarchyEdgeSchema),
  // MYT-102: both optional at the contract layer even though a real 200 always
  // carries them (the backend view always composes proseKernels + world) — the
  // same fixture back-compat posture as `introduction`: pre-existing bare
  // snapshot fixtures keep validating; consumers read both defensively.
  proseKernels: z.array(WorldSnapshotProseKernelSchema).optional(),
  world: WorldSnapshotWorldSchema.optional(),
})
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>
