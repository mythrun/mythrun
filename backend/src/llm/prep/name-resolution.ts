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
    if (src === undefined || tgt === undefined) continue
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
