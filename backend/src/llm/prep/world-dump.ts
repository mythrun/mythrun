// backend/src/llm/prep/world-dump.ts
//
// Shared "world dump" rendering — single source of truth for the textual
// form the LLM sees when handed a full world (entities + facts +
// relationships + prose kernels).
//
// The composite READ that builds the in-memory inventory moved to the repo
// layer as `repo.worldInventory.load` (data-layer-repo-unification): a
// bespoke multi-table read belongs behind the repo boundary, not as a free
// function reaching for `repo.pool`. This file now owns only the deterministic
// renderer; the `WorldInventory` type re-exports from the repo namespace so
// existing `import { ... WorldInventory } from '../world-dump.js'` sites keep
// resolving.

export type { WorldInventory } from '../../repo/world-inventory.js'
import type { WorldInventory } from '../../repo/world-inventory.js'

// Render the inventory into a deterministic textual block. The LLM gets
// every entity's UUID + name + entity_type, then its prose kernel, then
// its facts, then its outgoing relationships — in that order, grouped by
// entity. Relationships are listed once per source entity (the target's
// UUID is included so the LLM has both ends).
export function renderWorldDump(inv: WorldInventory): string {
  const lines: string[] = []
  for (const entity of inv.entitiesById.values()) {
    lines.push(
      `## Entity ${entity.id} (${entity.entityType}) [access_level: ${entity.accessLevel}]: ${entity.name}`,
    )
    const prose = inv.proseByEntityId.get(entity.id)
    if (prose !== undefined) {
      lines.push(`### Prose kernel`)
      lines.push(prose)
    }
    const ownFacts = Array.from(inv.factsById.values()).filter((f) => f.entityId === entity.id)
    if (ownFacts.length > 0) {
      lines.push(`### Facts`)
      for (const fact of ownFacts) {
        lines.push(
          `- Fact ${fact.id} [${fact.topic}, ${fact.accessLevel}]: ${fact.content}`,
        )
      }
    }
    const outgoing = Array.from(inv.relationshipsById.values()).filter(
      (r) => r.sourceEntityId === entity.id,
    )
    if (outgoing.length > 0) {
      lines.push(`### Relationships (outgoing)`)
      for (const rel of outgoing) {
        lines.push(
          `- Relationship ${rel.id} → target ${rel.targetEntityId} [${rel.relationshipType}]: ${rel.description}`,
        )
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}
