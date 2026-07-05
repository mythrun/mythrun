// backend/src/repo/world-inventory.ts
//
// `worldInventory` repo namespace — the composite multi-table "world dump"
// read. Moved verbatim from `llm/prep/world-dump.ts` `loadWorldInventory`
// (data-layer-repo-unification): a single bespoke read that composes
// entities (+ access tier), prose kernels, facts, and relationships for one
// world into in-memory maps. It does not fit a single-table namespace, so it
// gets its own composite-read namespace rather than re-exposing `repo.pool`.
//
// The SQL began byte-identical to the prior `loadWorldInventory` body: the two
// entity/relationship reads delegate to the `entities` / `relationships`
// binders (the same call the function made), and the prose + facts reads are
// the same raw JOIN queries. ONE divergence (MYT-74a): the facts read now adds
// `AND f.superseded_by IS NULL` — superseded (corrected/retracted) canon must
// never resurface to the prep/coherence reader. The returned shape
// (`WorldInventory`, `entitiesById` Map, etc.) is unchanged — `world-dump.ts`
// re-exports the type and the renderer consume it.
//
// `load` is composable over any ClientLike: `repo.worldInventory.load(...)`
// (pool-bound, outside-tx — stage 4 entity_relationships) and
// `tx.worldInventory.load(...)` (in-flight tx client) share one body. Stage 7
// coherence-pass + the character-integration worker call `worldInventoryNs(c)`
// directly with the PoolClient they already hold.

import type { ClientLike } from './_types.js'
import { entitiesNs } from './entities.js'
import type { AccessLevel } from './facts.js'
import { relationshipsNs } from './relationships.js'

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
      // MYT-89 Phase A: persisted by stages 4/4b/7 (migration 031); stage 7
      // reads it to preserve the existing tier on a fix_relationship that
      // doesn't re-tier. Structurally propagated by load's
      // `new Map(relRows.map((r) => [r.id, r]))`.
      accessLevel: AccessLevel
      // myth-imxg.3: persisted by stages 4/4b/7 (migration 020); stage 7
      // reads it for edge-removed SSE events. Structurally propagated by
      // load's `new Map(relRows.map((r) => [r.id, r]))`.
      synthKey: string
    }
  >
}

/** Composable binder: captures `c` (pool OR in-flight tx client) and holds the
 *  composite world-inventory read so `repo.worldInventory.load` and
 *  `tx.worldInventory.load` share one body. SQL byte-identical to the prior
 *  `loadWorldInventory` (llm/prep/world-dump.ts). */
export function worldInventoryNs(c: ClientLike) {
  return {
    load: async (worldId: string): Promise<WorldInventory> => {
      const entityRows = await entitiesNs(c).listByWorld(worldId)
      const entitiesById = new Map(
        entityRows.map((e) => [
          e.id,
          { id: e.id, name: e.name, entityType: e.entityType, accessLevel: e.accessLevel },
        ]),
      )

      const proseResult = await c.query<{ entity_id: string; content: string }>(
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

      const factResult = await c.query<{
        id: string
        entity_id: string
        topic: string
        access_level: string
        content: string
      }>(
        `SELECT f.id, f.entity_id, f.topic, f.access_level, f.content
           FROM facts f
           JOIN entities e ON e.id = f.entity_id
          WHERE e.world_id = $1 AND f.superseded_by IS NULL`,
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

      const relRows = await relationshipsNs(c).listByWorld(worldId)
      const relationshipsById = new Map(relRows.map((r) => [r.id, r]))

      return { entitiesById, proseByEntityId, factsById, relationshipsById }
    },
  }
}
