// backend/src/llm/prep/name-resolution.ts
//
// myth-2ob3: pure-functional name resolver shared by entity_relationships
// and coherence_pass stages. Maps LLM-emitted names to canonical UUIDs
// against a per-pass inventory snapshot.

import type { WorldInventory } from './world-dump.js'

/**
 * Normalize a name for lookup. Pure hygiene:
 *  - NFC-normalize Unicode (composed form)
 *  - trim leading/trailing whitespace
 *  - collapse internal whitespace runs (including tabs/newlines) to one space
 *
 * Case-sensitive. NO fuzzy matching, NO Levenshtein. If the LLM emits
 * "the Drowned Quarter" for an entity "The Drowned Quarter", resolution
 * still misses — that's a real model error to surface, not paper over.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ')
}

/**
 * Per-pass resolution context. Built ONCE from a world inventory snapshot.
 * For coherence_pass, rename patches apply LAST (after all other patches
 * have used this context), so the context is never mutated mid-pass.
 */
export interface NameResolutionContext {
  /** Normalized entity name -> entityId. Excludes duplicates. */
  readonly entityIdByName: ReadonlyMap<string, string>
  /** Names that appear on multiple entities. Resolution drops with WARN. */
  readonly ambiguousEntityNames: ReadonlySet<string>
  /** Normalized entity name -> (topic -> [factIds]). >1 fact = ambiguous. */
  readonly factIdByPair: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>
  /** srcName -> tgtName -> type -> [relIds]. >1 = ambiguous. */
  readonly relIdByTriple: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>
  >
}

export function buildResolutionContext(inv: WorldInventory): NameResolutionContext {
  const entityIdByName = new Map<string, string>()
  const seenNames = new Set<string>()
  const ambiguousEntityNames = new Set<string>()
  for (const e of inv.entitiesById.values()) {
    const n = normalizeName(e.name)
    if (seenNames.has(n)) {
      ambiguousEntityNames.add(n)
      entityIdByName.delete(n)
      continue
    }
    seenNames.add(n)
    entityIdByName.set(n, e.id)
  }

  const factIdByPair = new Map<string, Map<string, string[]>>()
  for (const f of inv.factsById.values()) {
    const ent = inv.entitiesById.get(f.entityId)
    if (ent === undefined) continue
    const entName = normalizeName(ent.name)
    let byTopic = factIdByPair.get(entName)
    if (byTopic === undefined) {
      byTopic = new Map()
      factIdByPair.set(entName, byTopic)
    }
    const arr = byTopic.get(f.topic) ?? []
    arr.push(f.id)
    byTopic.set(f.topic, arr)
  }

  const relIdByTriple = new Map<string, Map<string, Map<string, string[]>>>()
  for (const r of inv.relationshipsById.values()) {
    const src = inv.entitiesById.get(r.sourceEntityId)
    const tgt = inv.entitiesById.get(r.targetEntityId)
    /* c8 ignore start — defensive: relationships table has ON DELETE CASCADE
     * FKs on both endpoints, so an orphan relationship is unreachable
     * under a consistent world inventory. */
    if (src === undefined || tgt === undefined) continue
    /* c8 ignore stop */
    const sn = normalizeName(src.name)
    const tn = normalizeName(tgt.name)
    let byTgt = relIdByTriple.get(sn)
    if (byTgt === undefined) {
      byTgt = new Map()
      relIdByTriple.set(sn, byTgt)
    }
    let byType = byTgt.get(tn)
    if (byType === undefined) {
      byType = new Map()
      byTgt.set(tn, byType)
    }
    const arr = byType.get(r.relationshipType) ?? []
    arr.push(r.id)
    byType.set(r.relationshipType, arr)
  }

  return { entityIdByName, ambiguousEntityNames, factIdByPair, relIdByTriple }
}

export interface ResolvedRelationship {
  readonly kind: 'resolved'
  readonly sourceEntityId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}
export interface PhantomTarget {
  readonly kind: 'phantom_target'
  readonly sourceEntityId: string
  readonly phantomName: string
  readonly synthId: string
  readonly relationshipType: string
  readonly description: string
}
export interface PhantomSource {
  readonly kind: 'phantom_source'
  readonly phantomName: string
  readonly synthId: string
  readonly targetEntityId: string
  readonly relationshipType: string
  readonly description: string
}
export interface PhantomBoth {
  readonly kind: 'phantom_both'
  readonly sourceName: string
  readonly sourceSynthId: string
  readonly targetName: string
  readonly targetSynthId: string
  readonly relationshipType: string
  readonly description: string
}
export interface DroppedRelationship {
  readonly kind: 'dropped'
  readonly reason:
    | 'unknown_source'
    | 'unknown_target'
    | 'unknown_both'
    | 'ambiguous_source'
    | 'ambiguous_target'
}
export type RelationshipResolution =
  | ResolvedRelationship
  | PhantomTarget
  | PhantomSource
  | PhantomBoth
  | DroppedRelationship

export interface EmittedRelationship {
  readonly from_name: string
  readonly to_name: string
  readonly relationship: string
  readonly description: string
}

type DeclarationsMap = ReadonlyMap<string, { readonly synthId: string; readonly entityType: string }>

function lookupEndpoint(
  ctx: NameResolutionContext,
  rawName: string,
  decls: DeclarationsMap,
):
  | { kind: 'real'; id: string }
  | { kind: 'phantom'; synthId: string }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' } {
  const n = normalizeName(rawName)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'ambiguous' }
  const real = ctx.entityIdByName.get(n)
  if (real !== undefined) return { kind: 'real', id: real }
  const phantom = decls.get(n)
  if (phantom !== undefined) return { kind: 'phantom', synthId: phantom.synthId }
  return { kind: 'unknown' }
}

export function resolveRelationship(
  ctx: NameResolutionContext,
  emitted: EmittedRelationship,
  declarations: DeclarationsMap,
): RelationshipResolution {
  const from = lookupEndpoint(ctx, emitted.from_name, declarations)
  const to = lookupEndpoint(ctx, emitted.to_name, declarations)

  if (from.kind === 'ambiguous') return { kind: 'dropped', reason: 'ambiguous_source' }
  if (to.kind === 'ambiguous') return { kind: 'dropped', reason: 'ambiguous_target' }

  if (from.kind === 'real' && to.kind === 'real') {
    return {
      kind: 'resolved',
      sourceEntityId: from.id,
      targetEntityId: to.id,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  if (from.kind === 'real' && to.kind === 'phantom') {
    return {
      kind: 'phantom_target',
      sourceEntityId: from.id,
      phantomName: normalizeName(emitted.to_name),
      synthId: to.synthId,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  if (from.kind === 'phantom' && to.kind === 'real') {
    return {
      kind: 'phantom_source',
      phantomName: normalizeName(emitted.from_name),
      synthId: from.synthId,
      targetEntityId: to.id,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  if (from.kind === 'phantom' && to.kind === 'phantom') {
    return {
      kind: 'phantom_both',
      sourceName: normalizeName(emitted.from_name),
      sourceSynthId: from.synthId,
      targetName: normalizeName(emitted.to_name),
      targetSynthId: to.synthId,
      relationshipType: emitted.relationship,
      description: emitted.description,
    }
  }
  if (from.kind === 'unknown' && to.kind === 'unknown') {
    return { kind: 'dropped', reason: 'unknown_both' }
  }
  if (from.kind === 'unknown') return { kind: 'dropped', reason: 'unknown_source' }
  return { kind: 'dropped', reason: 'unknown_target' }
}

export type FactResolution =
  | { kind: 'resolved'; factId: string; entityId: string }
  | { kind: 'dropped'; reason: 'unknown_entity' | 'ambiguous_entity' | 'unknown_fact' | 'ambiguous_fact' }

export function resolveFact(
  ctx: NameResolutionContext,
  emitted: { entity_name: string; fact_topic: string },
): FactResolution {
  const n = normalizeName(emitted.entity_name)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'dropped', reason: 'ambiguous_entity' }
  const entityId = ctx.entityIdByName.get(n)
  if (entityId === undefined) return { kind: 'dropped', reason: 'unknown_entity' }
  const byTopic = ctx.factIdByPair.get(n)
  const matches = byTopic?.get(emitted.fact_topic) ?? []
  const [first, second] = matches
  if (first === undefined) return { kind: 'dropped', reason: 'unknown_fact' }
  if (second !== undefined) return { kind: 'dropped', reason: 'ambiguous_fact' }
  return { kind: 'resolved', factId: first, entityId }
}

export type EntityResolution =
  | { kind: 'resolved'; entityId: string }
  | { kind: 'dropped'; reason: 'unknown_entity' | 'ambiguous_entity' }

export function resolveProseTarget(
  ctx: NameResolutionContext,
  emitted: { entity_name: string },
): EntityResolution {
  const n = normalizeName(emitted.entity_name)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'dropped', reason: 'ambiguous_entity' }
  const id = ctx.entityIdByName.get(n)
  if (id === undefined) return { kind: 'dropped', reason: 'unknown_entity' }
  return { kind: 'resolved', entityId: id }
}

export type RenameResolution =
  | { kind: 'resolved'; entityId: string; newName: string }
  | { kind: 'dropped'; reason: 'unknown_entity' | 'ambiguous_entity' }

export function resolveRename(
  ctx: NameResolutionContext,
  emitted: { old_name: string; new_name: string },
): RenameResolution {
  const n = normalizeName(emitted.old_name)
  if (ctx.ambiguousEntityNames.has(n)) return { kind: 'dropped', reason: 'ambiguous_entity' }
  const id = ctx.entityIdByName.get(n)
  if (id === undefined) return { kind: 'dropped', reason: 'unknown_entity' }
  return { kind: 'resolved', entityId: id, newName: emitted.new_name }
}

export type RelationshipPatchResolution =
  | { kind: 'resolved'; relationshipId: string }
  | { kind: 'dropped'; reason: 'unknown_relationship' | 'ambiguous_relationship' }

function lookupRelTriple(
  ctx: NameResolutionContext,
  src: string, tgt: string, type: string,
): RelationshipPatchResolution {
  const sn = normalizeName(src)
  const tn = normalizeName(tgt)
  const arr = ctx.relIdByTriple.get(sn)?.get(tn)?.get(type) ?? []
  const [first, second] = arr
  if (first === undefined) return { kind: 'dropped', reason: 'unknown_relationship' }
  if (second !== undefined) return { kind: 'dropped', reason: 'ambiguous_relationship' }
  return { kind: 'resolved', relationshipId: first }
}

export function resolveFixRelationship(
  ctx: NameResolutionContext,
  emitted: { source_name: string; target_name: string; current_type: string },
): RelationshipPatchResolution {
  return lookupRelTriple(ctx, emitted.source_name, emitted.target_name, emitted.current_type)
}

export function resolveDeleteRelationship(
  ctx: NameResolutionContext,
  emitted: { source_name: string; target_name: string; current_type: string },
): RelationshipPatchResolution {
  return lookupRelTriple(ctx, emitted.source_name, emitted.target_name, emitted.current_type)
}
