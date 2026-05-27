// backend/src/llm/prep/world-dump.ts
//
// Shared "world dump" rendering — single source of truth for what the
// LLM sees when handed a full world (entities + facts + relationships
// + prose kernels).
//
// Extracted from stages/coherence-pass.ts in MYT-54 T5 so the
// character-integration worker can reuse the exact same inventory
// shape + textual rendering. No behavior change vs. the inlined
// originals: coherence-pass continues to import these.
//
// Two pieces:
//   - loadWorldInventory: pulls entities (+access tier), prose kernels,
//     facts, and relationships for one world into in-memory maps.
//   - renderWorldDump: deterministic prose form with entity UUIDs the
//     LLM can echo back.

import type { PoolClient } from 'pg'
import { entities } from '../../repo/entities.js'
import type { AccessLevel } from '../../repo/facts.js'
import { relationships } from '../../repo/relationships.js'

// In-memory inventory of a world's UUIDs at one point in time.
// Used for (a) the world dump rendered into the prompt, (b) any
// downstream consumer that needs to look up entities/facts/relationships
// by id without re-querying.
export interface WorldInventory {
  readonly entitiesById: Map<
    string,
    { id: string; name: string; entityType: string; accessLevel: AccessLevel }
  >
  readonly proseByEntityId: Map<string, string>
  readonly factsById: Map<string, { id: string; entityId: string; content: string; topic: string; accessLevel: string }>
  readonly relationshipsById: Map<
    string,
    {
      id: string
      sourceEntityId: string
      targetEntityId: string
      relationshipType: string
      description: string
      // myth-imxg.3: persisted by stages 4/4b/7 (migration 020); stage 7
      // reads it for edge-removed SSE events. Structurally propagated by
      // loadWorldInventory's `new Map(relRows.map((r) => [r.id, r]))`.
      synthKey: string
    }
  >
}

export async function loadWorldInventory(
  client: PoolClient,
  worldId: string,
): Promise<WorldInventory> {
  const entityRows = await entities.listByWorld(client, worldId)
  const entitiesById = new Map(
    entityRows.map((e) => [
      e.id,
      { id: e.id, name: e.name, entityType: e.entityType, accessLevel: e.accessLevel },
    ]),
  )

  const proseResult = await client.query<{ entity_id: string; content: string }>(
    `SELECT pk.entity_id, pk.content
       FROM prose_kernels pk
       JOIN entities e ON e.id = pk.entity_id
      WHERE e.world_id = $1`,
    [worldId],
  )
  const proseByEntityId = new Map<string, string>()
  for (const row of proseResult.rows) {
    proseByEntityId.set(row.entity_id, row.content)
  }

  const factResult = await client.query<{
    id: string
    entity_id: string
    topic: string
    access_level: string
    content: string
  }>(
    `SELECT f.id, f.entity_id, f.topic, f.access_level, f.content
       FROM facts f
       JOIN entities e ON e.id = f.entity_id
      WHERE e.world_id = $1`,
    [worldId],
  )
  const factsById = new Map<
    string,
    { id: string; entityId: string; content: string; topic: string; accessLevel: string }
  >()
  for (const row of factResult.rows) {
    factsById.set(row.id, {
      id: row.id,
      entityId: row.entity_id,
      topic: row.topic,
      accessLevel: row.access_level,
      content: row.content,
    })
  }

  const relRows = await relationships.listByWorld(client, worldId)
  const relationshipsById = new Map(relRows.map((r) => [r.id, r]))

  return { entitiesById, proseByEntityId, factsById, relationshipsById }
}

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
