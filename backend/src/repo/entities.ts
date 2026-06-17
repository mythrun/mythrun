// Repo for the `entities` table (migration 001 lines 114–123, extended by
// migration 014). Bare-named exports — every caller already holds a
// PoolClient via the stage's transaction (mirrors `stripe-events.ts`,
// not `worlds.ts`).
//
// entity_type is constrained by the table's CHECK to ('npc', 'location',
// 'faction', 'item'). Regions are persisted as type='location' per the
// pipeline spec §3 (no separate 'region' enum value).
//
// myth-exac: access_level is now a required column on entities (migration
// 014). The LLM emits the tier per entity in stages 2/3; the persister
// stamps it at INSERT time. listByWorld accepts an optional access-level
// filter so snapshot reads can narrow to {known} for Fast Thinker or
// {known, discoverable, secret} for Slow Thinker / prep stages.

import type { ClientLike } from './_types.js'
import type { AccessLevel } from './facts.js'

export type EntityType = 'npc' | 'location' | 'faction' | 'item'

export interface InsertEntityInput {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
  // myth-exac: required at insert. The LLM emits this per entity in
  // the world-and-factions / locations-and-npcs stages; the persister
  // passes it straight through.
  readonly accessLevel: AccessLevel
  readonly statBlockId?: string | null
  /** Provenance marker. Format: 'stage:<stage_name>' for world-gen-
   *  created entities; 'session:<uuid>' for Scribe-created entities
   *  during play. */
  readonly createdIn: string
}

export interface Entity {
  readonly id: string
  readonly worldId: string
  readonly entityType: EntityType
  readonly name: string
  readonly accessLevel: AccessLevel
}

interface EntityRow {
  readonly id: string
  readonly world_id: string
  readonly entity_type: EntityType
  readonly name: string
  readonly access_level: AccessLevel
}

/** Row shape for the world-gen input loaders (entity name + type + its
 *  prose-kernel content). `prose` is null when the entity has no kernel yet. */
export interface EntityProseRow {
  readonly name: string
  readonly entity_type: string
  readonly prose: string | null
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    worldId: row.world_id,
    entityType: row.entity_type,
    name: row.name,
    accessLevel: row.access_level,
  }
}

/** Composable binder: captures `c` (pool OR in-flight tx client) and holds the
 *  canonical SQL so `repo.entities.X` and `tx.entities.X` share one
 *  implementation. Mirrors the worlds.ts `worldsNs` pattern. */
export function entitiesNs(c: ClientLike) {
  return {
    insert: async (input: InsertEntityInput): Promise<void> => {
      await c.query(
        `INSERT INTO entities (id, world_id, entity_type, name, access_level, stat_block_id, created_in)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.id,
          input.worldId,
          input.entityType,
          input.name,
          input.accessLevel,
          input.statBlockId ?? null,
          input.createdIn,
        ],
      )
    },
    findByWorldAndName: async (worldId: string, name: string): Promise<Entity | null> => {
      const result = await c.query<EntityRow>(
        `SELECT id, world_id, entity_type, name, access_level
       FROM entities WHERE world_id = $1 AND name = $2 LIMIT 1`,
        [worldId, name],
      )
      return result.rows[0] ? toEntity(result.rows[0]) : null
    },
    /**
     * MYT-72: resolve a colloquial entity name to its id, world-scoped, matching
     * on lower(btrim(name)) so "  the spymaster " hits "The Spymaster". Returns
     * null on no match (a clean "no such character" relay — never throws). Used by
     * the lookup tools' name→id step before a graph walk. EXACT normalized match,
     * not fuzzy: a wrong fuzzy id would silently walk the wrong subtree.
     */
    findIdByWorldAndNormalizedName: async (
      worldId: string,
      name: string,
    ): Promise<string | null> => {
      const result = await c.query<{ id: string }>(
        `SELECT id FROM entities WHERE world_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
        [worldId, name],
      )
      return result.rows[0]?.id ?? null
    },
    /**
     * location-selection (character-creation stage 1) drift-defense check: does
     * an entity with `id` exist in `worldId`? Returns true when the row exists.
     * Guards against state drift between owner-pick time and fan-out time. SQL
     * verbatim from the former inline `SELECT id FROM entities WHERE id = $1 AND
     * world_id = $2` in location-selection.ts.
     */
    existsInWorld: async (id: string, worldId: string): Promise<boolean> => {
      const result = await c.query<{ id: string }>(
        `SELECT id FROM entities WHERE id = $1 AND world_id = $2`,
        [id, worldId],
      )
      return result.rows.length > 0
    },
    listByWorld: async (
      worldId: string,
      opts?: { readonly accessLevels?: readonly AccessLevel[] },
    ): Promise<Entity[]> => {
      const accessLevels = opts?.accessLevels
      if (accessLevels) {
        const result = await c.query<EntityRow>(
          `SELECT id, world_id, entity_type, name, access_level
         FROM entities WHERE world_id = $1 AND access_level = ANY($2)`,
          [worldId, accessLevels],
        )
        return result.rows.map(toEntity)
      }
      const result = await c.query<EntityRow>(
        `SELECT id, world_id, entity_type, name, access_level
       FROM entities WHERE world_id = $1`,
        [worldId],
      )
      return result.rows.map(toEntity)
    },
    /**
     * starting-situation (stage 6) name-resolution read: location entities
     * for a world, id + name only. SQL verbatim from the two inline reads in
     * `stages/starting-situation.ts` (`resolveLocationEntries` selected
     * `id, name`; `listLocationNames` selected `name` — this one covers both,
     * the name-list caller maps `.name`). Runs on the pool (outside the
     * persist tx) exactly as the prior reads did.
     */
    listLocationsByWorld: async (
      worldId: string,
    ): Promise<readonly { readonly id: string; readonly name: string }[]> => {
      const result = await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM entities WHERE world_id = $1 AND entity_type = 'location'`,
        [worldId],
      )
      return result.rows
    },
    /**
     * Idempotency wipe used by the stage-4 (entity_relationships) and
     * stage-4b (entity_consolidation) persisters: delete every entity a given
     * stage created for a world so a retry starts from a clean slate. CASCADE
     * FKs clear the rows' prose_kernels / facts / relationships. SQL verbatim
     * from the two stages' inline `DELETE FROM entities WHERE world_id = $1 AND
     * created_in = 'stage:entity_consolidation'` — the `created_in` value is
     * now a parameter so the one method serves both call sites.
     */
    deleteByWorldAndCreatedIn: async (worldId: string, createdIn: string): Promise<void> => {
      await c.query(`DELETE FROM entities WHERE world_id = $1 AND created_in = $2`, [
        worldId,
        createdIn,
      ])
    },
    /**
     * Rename an entity (coherence-pass apply-patch). SQL verbatim from
     * `stages/coherence-pass.ts` `applyRenameEntity`: `UPDATE entities SET name
     * = $1 WHERE id = $2`. Composes inside the coherence-pass repo.transaction.
     */
    updateName: async (input: { id: string; name: string }): Promise<void> => {
      await c.query(`UPDATE entities SET name = $1 WHERE id = $2`, [input.name, input.id])
    },
    /**
     * myth-gp2c Cluster C: insert one PC entity for character-integration.
     * entity_type is the literal 'pc' and access_level the literal 'known' —
     * a PC is always player-visible. The caller mints the id up-front (uuidv7)
     * so it can build the userId→entityId map for the relationship/fact passes.
     * SQL verbatim from `stages/character-integration.ts writeIntegration`
     * pass 1. Distinct from `insert` (which carries stat_block_id + created_in
     * and a caller-supplied type/tier) — this one bakes in the pc/known literals.
     * Composes inside the stage's `repo.transaction`.
     */
    insertPc: async (input: { id: string; worldId: string; name: string }): Promise<void> => {
      await c.query(
        `INSERT INTO entities (id, world_id, entity_type, name, access_level)
         VALUES ($1, $2, 'pc', $3, 'known')`,
        [input.id, input.worldId, input.name],
      )
    },
    /**
     * MYT-71 (world-retrieval): set the pgvector embedding + stamp embedded_at.
     * Canonical write so `embed-write.ts` calls `repo.entities.updateEmbedding`
     * (pool) or `tx.entities.updateEmbedding` (in a transaction). `vecLiteral`
     * is the pgvector text form `'[f1,…,f512]'`; cast to ::vector here (pg has
     * no native vector param type). Returns the affected row count (0 = no such
     * id). The read-side cosine search lives in `world-retrieval.ts`.
     */
    updateEmbedding: async (id: string, vecLiteral: string): Promise<number> => {
      const r = await c.query(
        `UPDATE entities SET embedding = $1::vector, embedded_at = now() WHERE id = $2`,
        [vecLiteral, id],
      )
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
      return r.rowCount ?? 0
    },
    /**
     * MYT-74a (Scribe play-marking): flag a set of entities as touched by play —
     * sets encountered = true + modified_by_play = true and stamps updated_at, so
     * snapshot/inventory reads can distinguish world-gen-pristine entities from
     * ones a session has surfaced or mutated. Both columns exist since migration
     * 001 (DEFAULT false); this is the first setter. Empty input is a no-op:
     * returns 0 without issuing a query (an `= ANY('{}')` UPDATE would be a
     * pointless round-trip). Returns the affected row count for callers that want
     * to assert how many of the requested ids actually existed.
     */
    markTouchedByPlay: async (entityIds: readonly string[]): Promise<number> => {
      if (entityIds.length === 0) return 0
      const r = await c.query(
        `UPDATE entities SET encountered = true, modified_by_play = true, updated_at = now()
         WHERE id = ANY($1)`,
        [entityIds],
      )
      /* c8 ignore next — `?? 0` falsy arm: pg always returns a numeric rowCount on UPDATE. */
      return r.rowCount ?? 0
    },
    /**
     * starting-situation (stage 6) input read: every location / npc / faction
     * entity for a world with its prose-kernel content, ordered by type then
     * creation. SQL verbatim from the processor's `loadStartingSituationInputs`.
     * Runs on the pool OUTSIDE the persist tx exactly as the prior inline read
     * did. The caller renders the "- name: prose" bullets per kind.
     */
    listProseByTypeForStartingSituation: async (
      worldId: string,
    ): Promise<readonly EntityProseRow[]> => {
      const result = await c.query<EntityProseRow>(
        `SELECT e.name, e.entity_type, pk.content AS prose
           FROM entities e
           LEFT JOIN prose_kernels pk ON pk.entity_id = e.id
          WHERE e.world_id = $1 AND e.entity_type IN ('location', 'npc', 'faction')
          ORDER BY e.entity_type, e.created_at`,
        [worldId],
      )
      return result.rows
    },
    /**
     * stage-3 (locations_and_npcs) input read: location + faction entities for a
     * world with prose, ordered by creation. SQL verbatim from the processor's
     * `loadStage3Inputs`. Runs on the pool OUTSIDE the persist tx.
     */
    listProseByTypeForStage3: async (worldId: string): Promise<readonly EntityProseRow[]> => {
      const result = await c.query<EntityProseRow>(
        `SELECT e.name, e.entity_type, pk.content AS prose
           FROM entities e
           LEFT JOIN prose_kernels pk ON pk.entity_id = e.id
          WHERE e.world_id = $1 AND e.entity_type IN ('location', 'faction')
          ORDER BY e.created_at`,
        [worldId],
      )
      return result.rows
    },
  }
}

/** Back-compat shim: explicit-client const-object surface that delegates to the
 *  canonical `entitiesNs` binder. Direct importers (`entities.insert(client,
 *  input)`) keep working; new code goes through `repo.entities`.
 *
 *  Note: `deleteByWorldAndCreatedIn` and `listLocationsByWorld` are NOT
 *  re-exported here — their only callers are the world-gen stages, which all
 *  go through the `repo.entities` / `tx.entities` binder (the migration's
 *  "all access through repo" goal). They live solely on `entitiesNs`. */
export const entities = {
  insert: (client: ClientLike, input: InsertEntityInput): Promise<void> =>
    entitiesNs(client).insert(input),
  findByWorldAndName: (client: ClientLike, worldId: string, name: string): Promise<Entity | null> =>
    entitiesNs(client).findByWorldAndName(worldId, name),
  listByWorld: (
    client: ClientLike,
    worldId: string,
    opts?: { readonly accessLevels?: readonly AccessLevel[] },
  ): Promise<Entity[]> => entitiesNs(client).listByWorld(worldId, opts),
} as const
