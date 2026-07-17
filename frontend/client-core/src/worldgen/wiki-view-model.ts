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

/** One relationship edge as the snapshot carries it — mirrors the graph's
 *  `WorldGenRelationshipSchema` (the known-tier edges Phase A put on the
 *  world-snapshot wire). The wiki reads these to build RELATED links. */
export interface WikiRelationship {
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
}

/** A RELATED cross-link on an entity's page: the OTHER endpoint of a
 *  relationship, its id resolved to a display `name`, and the de-snaked
 *  `relationshipType` as the `label`. */
export interface WikiRelatedLink {
  readonly entityId: string
  readonly name: string
  readonly label: string
}

/** One browsable entity. `children` is present only for a location that
 *  contains nested locations (omitted for leaves and non-location kinds).
 *  `related` are the tiered relationship cross-links (both directions);
 *  `body` is the entity's prose kernel (MYT-102) — the actual description of
 *  what it is, rendered ABOVE the fact passages; absent when the snapshot
 *  carries none. `hasBody` flags whether ANY body content exists (kernel or
 *  facts — the wiki renders an empty-body entity as a bare page). */
export interface WikiEntity {
  readonly id: string
  readonly name: string
  readonly body?: string
  readonly facts: readonly WikiFact[]
  readonly related: readonly WikiRelatedLink[]
  readonly hasBody: boolean
  readonly children?: readonly WikiEntity[]
}

/** Entities of one kind. `kind` is the snapshot `entity_type`. */
export interface WikiGroup {
  readonly kind: EntityKind
  readonly entities: readonly WikiEntity[]
}

/** One dig-deeper link on the introduction page: the WIRE name (the authored
 *  reference label, not the entity's current name) plus the target's kind so
 *  the UI can annotate the link in the wiki's mono kind-tag idiom. Only
 *  references that resolve to a real wiki page survive normalization. */
export interface WikiIntroReference {
  readonly entityId: string
  readonly name: string
  readonly kind: EntityKind
}

/** The world-introduction page (myth-zaqxh) — the wiki's front door. `title`
 *  is the world's name; `paragraphs` is the intro prose split on newline runs
 *  (render one <p> each — never a wall); `references` are the dig-deeper
 *  links, wire order preserved. */
export interface WikiIntroduction {
  readonly title: string
  readonly paragraphs: readonly string[]
  readonly references: readonly WikiIntroReference[]
}

/** One world-glossary row (MYT-102): the world's invented vocabulary as the
 *  wiki shows it — the contract already narrowed entries to the display pair
 *  (no tier/authoring metadata, never `adjacent_franchises`). */
export interface WikiGlossaryEntry {
  readonly term: string
  readonly definition: string
}

export interface WikiViewModel {
  readonly groups: readonly WikiGroup[]
  /** The world's vocabulary, term-sorted. Empty for a snapshot that carries no
   *  `world` (a narrower/pre-MYT-102 source) — never absent. */
  readonly glossary: readonly WikiGlossaryEntry[]
  /** Absent for a pre-migration world (no `introduction` on the snapshot) —
   *  the wiki then opens on the browse home instead. */
  readonly introduction?: WikiIntroduction
}

/**
 * The snapshot the wiki normalizes: the contract's known-tier `WorldSnapshot`
 * WIDENED with the graph's relationship edges — the same superset the
 * world-snapshot endpoint already returns as `WorldGenSnapshot` (client-core
 * `api/campaigns`). `relationships` is OPTIONAL by design: a narrower source
 * (a snapshot without edges) still normalizes to a wiki with no RELATED links
 * rather than crashing, mirroring the module's defensive posture toward
 * tier-filtered / absent data. Declared here (not on the contract) so the pure
 * normalizer stays free of the api-layer type; a plain `WorldSnapshot` value is
 * still assignable, so the existing D3 caller and the wide endpoint source both
 * fit.
 */
export type WikiSnapshot = WorldSnapshot & {
  readonly relationships?: readonly WikiRelationship[]
}

/**
 * The injected data-source SEAM. The consumer (D3) supplies the owner's
 * `getWorldSnapshot`; MYT-94 supplies a character-scoped server source through
 * the SAME type. The normalizer never fetches — it is handed a snapshot.
 */
export type WikiDataSource = () => Promise<WikiSnapshot>

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

/** entityId → its prose kernel content (MYT-102). A whitespace-only kernel is
 *  treated as absent (defensive floor — the pipeline never writes one, but an
 *  empty body must not flip `hasBody`). The backend's UNIQUE(entity_id) means
 *  at most one kernel per entity; a duplicate would simply last-write-win. */
function indexKernelsByEntity(snapshot: WorldSnapshot): Map<string, string> {
  const byEntity = new Map<string, string>()
  for (const kernel of snapshot.proseKernels ?? []) {
    if (kernel.content.trim() === '') continue
    byEntity.set(kernel.entityId, kernel.content)
  }
  return byEntity
}

/** The glossary rows, term-sorted (id as no tiebreak exists — a duplicate term
 *  keeps wire order under the stable sort). Empty when the snapshot carries no
 *  `world` — the defensive posture every optional collection here follows. */
function toGlossary(snapshot: WorldSnapshot): readonly WikiGlossaryEntry[] {
  const entries = snapshot.world?.vocabularyRegistry.entries ?? []
  return entries
    .map((e) => ({ term: e.term, definition: e.definition }))
    .sort((a, b) => a.term.localeCompare(b.term))
}

/** De-snake a snake_case relationship type into a display label: underscores →
 *  spaces (`warded_by` → "warded by"). Mechanical string work (ZFC-safe), no
 *  semantics — the reverse direction reuses the SAME label (v1: symmetric). */
function deSnake(relationshipType: string): string {
  return relationshipType.replace(/_/g, ' ')
}

/**
 * entityId → its RELATED links, BOTH directions. Each edge contributes a link
 * on both endpoints' pages (A lists B, B lists A) with the SAME de-snaked
 * label. An endpoint missing from the snapshot's entity set (tier-filtered
 * away — shouldn't happen per the tiering design, but handled defensively) is
 * DROPPED silently rather than surfacing a nameless link. Links are ordered
 * deterministically by target name, then id, then label.
 */
function indexRelatedByEntity(
  snapshot: WikiSnapshot,
  nameById: ReadonlyMap<string, string>,
): Map<string, readonly WikiRelatedLink[]> {
  const byEntity = new Map<string, WikiRelatedLink[]>()
  const add = (ownerId: string, otherId: string, label: string): void => {
    const otherName = nameById.get(otherId)
    if (otherName === undefined) return // endpoint tier-filtered away → drop
    const bucket = byEntity.get(ownerId) ?? []
    bucket.push({ entityId: otherId, name: otherName, label })
    byEntity.set(ownerId, bucket)
  }
  for (const rel of snapshot.relationships ?? []) {
    const label = deSnake(rel.relationshipType)
    add(rel.sourceEntityId, rel.targetEntityId, label)
    add(rel.targetEntityId, rel.sourceEntityId, label)
  }
  for (const bucket of byEntity.values()) {
    bucket.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.entityId.localeCompare(b.entityId) ||
        a.label.localeCompare(b.label),
    )
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

/** The per-entity lookups `toEntityNode` reads — bundled so the recursion
 *  threads one argument, not three parallel maps. */
interface EntityIndexes {
  readonly factsByEntity: ReadonlyMap<string, readonly WikiFact[]>
  readonly relatedByEntity: ReadonlyMap<string, readonly WikiRelatedLink[]>
  readonly kernelByEntity: ReadonlyMap<string, string>
}

/** Build one entity node, recursing into its nested-location children. */
function toEntityNode(entity: WorldSnapshotEntity, layout: Layout, indexes: EntityIndexes): WikiEntity {
  const facts = indexes.factsByEntity.get(entity.id) ?? []
  const body = indexes.kernelByEntity.get(entity.id)
  const base: WikiEntity = {
    id: entity.id,
    name: entity.name,
    ...(body !== undefined ? { body } : {}),
    facts,
    related: indexes.relatedByEntity.get(entity.id) ?? [],
    hasBody: facts.length > 0 || body !== undefined,
  }
  const kids = layout.childrenByParent.get(entity.id) ?? []
  if (kids.length === 0) return base
  return { ...base, children: kids.map((k) => toEntityNode(k, layout, indexes)) }
}

/**
 * Normalize the snapshot's introduction: split the prose into paragraphs on
 * newline runs (blank segments dropped), and resolve each reference against
 * the entity set for its kind — keeping the WIRE name (the authored label) and
 * the wire order. A reference whose entity is absent (consolidated away since
 * authoring) or is a 'pc' (not world lore — no wiki page exists) is dropped
 * silently, the same defensive posture as RELATED links.
 */
function toIntroduction(
  intro: NonNullable<WikiSnapshot['introduction']>,
  kindById: ReadonlyMap<string, EntityKind>,
): WikiIntroduction {
  const references: WikiIntroReference[] = []
  for (const ref of intro.references) {
    const kind = kindById.get(ref.entityId)
    if (kind === undefined || !KIND_ORDER.includes(kind)) continue
    references.push({ entityId: ref.entityId, name: ref.name, kind })
  }
  return {
    title: intro.title,
    paragraphs: intro.prose
      .split(/\n+/)
      .map((p) => p.trim())
      .filter((p) => p !== ''),
    references,
  }
}

/**
 * Normalize a world-snapshot into the wiki view model: group entities by kind
 * (canonical order), nest child locations under their parents, attach each
 * entity's facts, and carry the introduction (the front-door page) through
 * when the snapshot has one. Deterministic throughout. Does NO tier filtering
 * — see the enforced-ignorance note at the top of this module.
 */
export function toWikiViewModel(snapshot: WikiSnapshot): WikiViewModel {
  const indexes: EntityIndexes = {
    factsByEntity: indexFactsByEntity(snapshot),
    relatedByEntity: indexRelatedByEntity(snapshot, new Map(snapshot.entities.map((e) => [e.id, e.name]))),
    kernelByEntity: indexKernelsByEntity(snapshot),
  }
  const layout = layOut(snapshot)
  const groups: WikiGroup[] = []
  for (const kind of KIND_ORDER) {
    const roots = layout.rootsByKind.get(kind) ?? []
    if (roots.length === 0) continue
    groups.push({
      kind,
      entities: roots.map((e) => toEntityNode(e, layout, indexes)),
    })
  }
  const glossary = toGlossary(snapshot)
  if (snapshot.introduction === undefined) return { groups, glossary }
  const kindById = new Map(snapshot.entities.map((e) => [e.id, e.entityType]))
  return { groups, glossary, introduction: toIntroduction(snapshot.introduction, kindById) }
}
