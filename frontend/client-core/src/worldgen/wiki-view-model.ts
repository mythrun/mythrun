// Wiki VIEW MODEL — the pure, DOM-free normalizer that turns a world-snapshot
// into the browsable model the owner explores after world-gen completes. Lives
// in the client brain (platform-neutral): it consumes the injected data source,
// never a fetch of its own.
//
// ENFORCED IGNORANCE IS SERVER-SIDE. `toWikiViewModel` does NO tier filtering.
// The owner's source (`getWorldSnapshot`) already returned only `known`-tier
// entities/facts — the server chose the tier by choosing which endpoint served
// the payload. MYT-94 will feed a DIFFERENT, character-scoped SERVER endpoint
// into the same `WikiDataSource` seam (a player sees a narrower world than its
// owner); it will NOT add a client-side filter here. The ignorance boundary is
// a hard server boundary, so the normalizer stays a dumb reshape either way.

import type { EntityKind, WorldSnapshot, WorldSnapshotEntity } from '@mythrun/contract/rest'

/** A fact as the wiki shows it — the display fields, keyed off nothing (the
 *  owning entity carries it). Projected from the snapshot fact row. */
export interface WikiFact {
  readonly id: string
  readonly topic: string
  readonly content: string
}

/** One browsable entity. `children` is present only for a location that
 *  contains nested locations (omitted for leaves and non-location kinds). */
export interface WikiEntity {
  readonly id: string
  readonly name: string
  readonly facts: readonly WikiFact[]
  readonly children?: readonly WikiEntity[]
}

/** Entities of one kind. `kind` is the snapshot `entity_type`. */
export interface WikiGroup {
  readonly kind: EntityKind
  readonly entities: readonly WikiEntity[]
}

export interface WikiViewModel {
  readonly groups: readonly WikiGroup[]
}

/**
 * The injected data-source SEAM. The consumer (D3) supplies the owner's
 * `getWorldSnapshot`; MYT-94 supplies a character-scoped server source through
 * the SAME type. The normalizer never fetches — it is handed a snapshot.
 */
export type WikiDataSource = () => Promise<WorldSnapshot>

// World-lore group order. 'pc' is intentionally absent — a player character is
// not world lore, so pc entities are omitted from the wiki (they never appear
// in an owner's post-gen snapshot, but a character-scoped source could carry
// one, and it still does not belong in the world wiki).
const KIND_ORDER: readonly EntityKind[] = ['faction', 'location', 'npc', 'item']

/** Deterministic order: by name, then id as a stable tiebreak. */
function compareByNameThenId(a: WorldSnapshotEntity, b: WorldSnapshotEntity): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
}

/** entityId → its facts, id-ordered and projected to the display shape. */
function indexFactsByEntity(snapshot: WorldSnapshot): Map<string, readonly WikiFact[]> {
  const byEntity = new Map<string, WikiFact[]>()
  for (const fact of snapshot.facts) {
    const bucket = byEntity.get(fact.entityId) ?? []
    bucket.push({ id: fact.id, topic: fact.topic, content: fact.content })
    byEntity.set(fact.entityId, bucket)
  }
  for (const bucket of byEntity.values()) {
    bucket.sort((a, b) => a.id.localeCompare(b.id))
  }
  return byEntity
}

/** childId → parentId, from the hierarchy edges. */
function indexParentByChild(snapshot: WorldSnapshot): Map<string, string> {
  const parentByChild = new Map<string, string>()
  for (const edge of snapshot.entityHierarchy) {
    parentByChild.set(edge.childEntityId, edge.parentEntityId)
  }
  return parentByChild
}

interface Layout {
  /** Top-level entities of each kind (nested children removed). */
  readonly rootsByKind: ReadonlyMap<EntityKind, readonly WorldSnapshotEntity[]>
  /** parentId → its direct child entities (name/id ordered). */
  readonly childrenByParent: ReadonlyMap<string, readonly WorldSnapshotEntity[]>
}

/**
 * Partition entities into per-kind roots + a parent→children index. An entity
 * is nested iff its hierarchy parent EXISTS in the snapshot; a dangling edge
 * (parent tier-filtered away) leaves the child at top level rather than
 * orphaning it — the backend view already constrains edges to surfaced pairs,
 * so this is a defensive floor, not the common path.
 */
function layOut(snapshot: WorldSnapshot): Layout {
  const byId = new Map(snapshot.entities.map((e) => [e.id, e]))
  const parentByChild = indexParentByChild(snapshot)
  const rootsByKind = new Map<EntityKind, WorldSnapshotEntity[]>()
  const childrenByParent = new Map<string, WorldSnapshotEntity[]>()

  for (const entity of snapshot.entities) {
    const parentId = parentByChild.get(entity.id)
    if (parentId !== undefined && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? []
      siblings.push(entity)
      childrenByParent.set(parentId, siblings)
    } else {
      const roots = rootsByKind.get(entity.entityType) ?? []
      roots.push(entity)
      rootsByKind.set(entity.entityType, roots)
    }
  }
  for (const bucket of childrenByParent.values()) bucket.sort(compareByNameThenId)
  for (const bucket of rootsByKind.values()) bucket.sort(compareByNameThenId)
  return { rootsByKind, childrenByParent }
}

/** Build one entity node, recursing into its nested-location children. */
function toEntityNode(
  entity: WorldSnapshotEntity,
  layout: Layout,
  factsByEntity: ReadonlyMap<string, readonly WikiFact[]>,
): WikiEntity {
  const base: WikiEntity = {
    id: entity.id,
    name: entity.name,
    facts: factsByEntity.get(entity.id) ?? [],
  }
  const kids = layout.childrenByParent.get(entity.id) ?? []
  if (kids.length === 0) return base
  return { ...base, children: kids.map((k) => toEntityNode(k, layout, factsByEntity)) }
}

/**
 * Normalize a world-snapshot into the wiki view model: group entities by kind
 * (canonical order), nest child locations under their parents, attach each
 * entity's facts. Deterministic throughout. Does NO tier filtering — see the
 * enforced-ignorance note at the top of this module.
 */
export function toWikiViewModel(snapshot: WorldSnapshot): WikiViewModel {
  const factsByEntity = indexFactsByEntity(snapshot)
  const layout = layOut(snapshot)
  const groups: WikiGroup[] = []
  for (const kind of KIND_ORDER) {
    const roots = layout.rootsByKind.get(kind) ?? []
    if (roots.length === 0) continue
    groups.push({ kind, entities: roots.map((e) => toEntityNode(e, layout, factsByEntity)) })
  }
  return { groups }
}
