import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type CreateWorldInput, type World, type WorldUpdate } from './types.js'
import { toWorld, type WorldDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import {
  VocabularyRegistrySchema,
  type VocabularyRegistry,
} from '../llm/schemas/vocabulary-registry.js'

// Allowlist projection of the worlds table — the enforced-ignorance wire-shape
// gate. Plot-bearing columns (key_tensions, political_summary, world_overview,
// geography_summary, starting_situations, follow_up_questions) are
// intentionally excluded: they're prep-time artifacts the Fast-Thinker must
// never see. `getSnapshotSummary` returns this type; `getById` (full row,
// prep/Slow-Thinker tier) returns `World`. Re-pointing a player-facing read at
// `getById` is a compile error, not a silent leak — that is the boundary.
//
// Lives here (not in world-snapshot-view.ts) so the allowlist column list has
// exactly one home: getSnapshotSummary. The composite read view
// (worldSnapshotView.fetch) composes getSnapshotSummary and re-exports this
// type for back-compat.
export interface WorldSummary {
  readonly id: string
  readonly name: string
  readonly concept: string
  readonly tone: string | null
  readonly themes: string | null
  readonly era: string | null
  readonly vocabularyRegistry: VocabularyRegistry
}

// Raw row shape of the allowlist SELECT — snake_case columns straight from pg.
interface WorldSummaryDbRow {
  readonly id: string
  readonly name: string
  readonly concept: string
  readonly tone: string | null
  readonly themes: string | null
  readonly era: string | null
  readonly vocabulary_registry: unknown
}

// Input for the Cluster-A "create world (generating)" insert. The id is
// supplied by the caller (executeCreateTransaction generates a uuidv7 per
// row); `name` defaults to 'Untitled' exactly as the inline site does.
export interface InsertGeneratingInput {
  readonly id: string
  readonly createdBy: string
  readonly name?: string
  readonly concept: string
  readonly devBypassAccessFilter: boolean
}

// Composable binder: every method captures the ClientLike `c` (pool OR an
// in-flight tx client) so the same body serves `repo.worlds.X` (pool-bound)
// and `tx.worlds.X` (tx-bound). SQL is unchanged from the prior pool-bound
// factory — only `pool.query` → `c.query`. See the data-layer-repo-unification
// design ("Internal mechanism: closure-bound namespaces").
// eslint-disable-next-line max-lines-per-function
export function worldsNs(c: ClientLike) {
  return {
    create: async (input: CreateWorldInput): Promise<World> => {
      const id = uuidv7()
      const result = await c.query<WorldDbRow>(
        `INSERT INTO worlds (
            id, created_by, source_world_id, name, concept,
            tone, themes, geography_summary, political_summary, era,
            key_tensions, world_overview, follow_up_questions, starting_situations,
            is_public, status, language
         ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            COALESCE($15, false),
            COALESCE($16, 'generating'),
            COALESCE($17, 'en')
         ) RETURNING *`,
        [
          id,
          input.createdBy,
          input.sourceWorldId ?? null,
          input.name,
          input.concept,
          input.tone ?? null,
          input.themes ?? null,
          input.geographySummary ?? null,
          input.politicalSummary ?? null,
          input.era ?? null,
          input.keyTensions ?? null,
          input.worldOverview ?? null,
          input.followUpQuestions ?? null,
          input.startingSituations ?? null,
          input.isPublic ?? null,
          input.status ?? null,
          input.language ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('worlds.create: INSERT returned no row')
      return toWorld(row)
    },

    /**
     * Cluster-A create-tx footprint: insert a freshly-generating world row.
     * Composable — runs over the captured client (pool OR an in-flight tx
     * client). SQL verbatim from `executeCreateTransaction`
     * (backend/src/routes/campaigns.ts): `INSERT INTO worlds (id, created_by,
     * name, concept, status, dev_bypass_access_filter) VALUES ($1, $2,
     * 'Untitled', $3, 'generating', $4)`. `name` defaults to 'Untitled'.
     */
    insertGenerating: async (input: InsertGeneratingInput): Promise<void> => {
      await c.query(
        `INSERT INTO worlds (id, created_by, name, concept, status, dev_bypass_access_filter)
         VALUES ($1, $2, $3, $4, 'generating', $5)`,
        [
          input.id,
          input.createdBy,
          input.name ?? 'Untitled',
          input.concept,
          input.devBypassAccessFilter,
        ],
      )
    },

    /**
     * Full row, including the plot-bearing columns — prep/Slow-Thinker tier
     * ONLY. Player-facing reads use `getSnapshotSummary` (the enforced-
     * ignorance allowlist). Do NOT satisfy a Fast-Thinker world read with
     * this method — it re-exposes plot fields. (CLAUDE.md Non-Negotiable
     * Principle: enforced ignorance is a hard boundary.)
     */
    getById: async (id: string): Promise<World | null> => {
      const result = await c.query<WorldDbRow>('SELECT * FROM worlds WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toWorld(row) : null
    },

    /**
     * Enforced-ignorance allowlist projection — the single-sourced home of the
     * world column list the Fast-Thinker is allowed to see. Returns
     * `WorldSummary`, a type that structurally cannot hold the plot columns
     * (key_tensions, political_summary, world_overview, geography_summary,
     * starting_situations, follow_up_questions). The vocabulary registry is
     * returned in full here; tier-filtering of its entries is the composite
     * read view's concern (`worldSnapshotView.fetch`).
     *
     * Returns null when the world id is unknown — the composite view turns
     * that into its "not found" error so this stays a pure read.
     */
    getSnapshotSummary: async (id: string): Promise<WorldSummary | null> => {
      const result = await c.query<WorldSummaryDbRow>(
        `SELECT id, name, concept, tone, themes, era, vocabulary_registry
           FROM worlds WHERE id = $1`,
        [id],
      )
      const row = result.rows[0]
      if (row === undefined) return null
      // jsonb arrives already-parsed; the migration's column default + CHECK
      // guarantee top-level shape. .parse narrows to VocabularyRegistry.
      const registry = VocabularyRegistrySchema.parse(row.vocabulary_registry)
      return {
        id: row.id,
        name: row.name,
        concept: row.concept,
        tone: row.tone,
        themes: row.themes,
        era: row.era,
        vocabularyRegistry: registry,
      }
    },

    /**
     * Return the singleton demo world (the trial-mode fork-source). The
     * partial unique index `idx_worlds_one_demo` guarantees at most one
     * row with `is_demo=true`. Returns null if no demo world is currently
     * flagged — operationally this means migration 008's seed was wiped or
     * the demo was retired without a replacement.
     *
     * Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md §9
     */
    getDemo: async (): Promise<World | null> => {
      const result = await c.query<WorldDbRow>(
        `SELECT * FROM worlds WHERE is_demo = true LIMIT 1`,
      )
      const row = result.rows[0]
      return row ? toWorld(row) : null
    },

    listByUser: async (userId: string): Promise<World[]> => {
      const result = await c.query<WorldDbRow>(
        `SELECT * FROM worlds WHERE created_by = $1 ORDER BY created_at DESC`,
        [userId],
      )
      return result.rows.map(toWorld)
    },

    update: async (id: string, patch: WorldUpdate): Promise<World> => {
      const result = await c.query<WorldDbRow>(
        `UPDATE worlds
            SET name                 = COALESCE($2, name),
                concept              = COALESCE($3, concept),
                tone                 = COALESCE($4, tone),
                themes               = COALESCE($5, themes),
                geography_summary    = COALESCE($6, geography_summary),
                political_summary    = COALESCE($7, political_summary),
                era                  = COALESCE($8, era),
                key_tensions         = COALESCE($9, key_tensions),
                world_overview       = COALESCE($10, world_overview),
                follow_up_questions  = COALESCE($11, follow_up_questions),
                starting_situations  = COALESCE($12, starting_situations),
                is_public            = COALESCE($13, is_public),
                moderation_status    = COALESCE($14, moderation_status),
                language             = COALESCE($15, language),
                updated_at           = now()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.name ?? null,
          patch.concept ?? null,
          patch.tone ?? null,
          patch.themes ?? null,
          patch.geographySummary ?? null,
          patch.politicalSummary ?? null,
          patch.era ?? null,
          patch.keyTensions ?? null,
          patch.worldOverview ?? null,
          patch.followUpQuestions ?? null,
          patch.startingSituations ?? null,
          patch.isPublic ?? null,
          patch.moderationStatus ?? null,
          patch.language ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.update: no world with id ${id}`)
      return toWorld(row)
    },

    updateStatus: async (
      id: string,
      status: 'generating' | 'complete' | 'failed',
    ): Promise<World> => {
      const result = await c.query<WorldDbRow>(
        `UPDATE worlds SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.updateStatus: no world with id ${id}`)
      return toWorld(row)
    },

    // ── World-gen processor status writers (pool-bound at the call site) ──────
    //
    // These three are the world-gen processor's recovery/completion bookkeeping.
    // SQL is byte-identical to the prior inline statements — deliberately NOT
    // routed through `updateStatus` above, which stamps `updated_at = now()` +
    // does a `RETURNING *` not-found throw. The processor wants exactly the
    // status-only UPDATE it had (no updated_at touch, no throw on 0 rows — the
    // guarded `AND status = ...` arms are no-ops by design when the guard fails).
    // They run on `deps.pool` OUTSIDE any stage transaction so a failed-status
    // write survives a stage-tx rollback (see the design's "Intentionally
    // pool-bound writes").

    /**
     * Mark a world complete. SQL verbatim from the processor's
     * `markWorldComplete`: `UPDATE worlds SET status = 'complete' WHERE id = $1`.
     */
    markComplete: async (id: string): Promise<void> => {
      await c.query(`UPDATE worlds SET status = 'complete' WHERE id = $1`, [id])
    },

    /**
     * Eagerly flip a world to 'failed' on a stage error. SQL verbatim from the
     * processor's `handleStageError` / `markStageCappedAndRefund` (issued via
     * cost-cap's refund tx in that path): `UPDATE worlds SET status = 'failed'
     * WHERE id = $1`.
     */
    markFailed: async (id: string): Promise<void> => {
      await c.query(`UPDATE worlds SET status = 'failed' WHERE id = $1`, [id])
    },

    /**
     * BullMQ retry recovery: reset a world the prior attempt flipped to 'failed'
     * back to 'generating' so the retry runs in the correct state. The
     * `AND status = 'failed'` guard makes first-attempt invocation a no-op. SQL
     * verbatim from the processor's top-of-job reset.
     */
    resetFailedToGenerating: async (id: string): Promise<void> => {
      await c.query(
        `UPDATE worlds SET status = 'generating' WHERE id = $1 AND status = 'failed'`,
        [id],
      )
    },

    /**
     * stage-3 (locations_and_npcs) input read: the world's overview prose.
     * Returns '' when the column is null / the world is unknown, matching the
     * processor's prior `?? ''` default. SQL verbatim from `loadStage3Inputs`.
     */
    getWorldOverview: async (id: string): Promise<string> => {
      const result = await c.query<{ world_overview: string | null }>(
        `SELECT world_overview FROM worlds WHERE id = $1`,
        [id],
      )
      return result.rows[0]?.world_overview ?? ''
    },

    incrementForkCount: async (id: string): Promise<World> => {
      const result = await c.query<WorldDbRow>(
        `UPDATE worlds SET fork_count = fork_count + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.incrementForkCount: no world with id ${id}`)
      return toWorld(row)
    },

    // ── World-gen stage persist writers ─────────────────────────────────────
    //
    // Focused single-purpose column writers homing the targeted UPDATEs the
    // world-gen stages used to issue inline against their own PoolClient. SQL
    // is byte-identical to the prior stage-local statements — only the
    // `client.query` → `c.query` relocation. These deliberately do NOT route
    // through the COALESCE-multi-column `update` above: that one stamps
    // `updated_at = now()` + does a `RETURNING *` not-found throw, which would
    // change the stages' observable behavior. Each stage gets exactly the
    // statement it had. (See the data-layer-repo-unification design, "Out of
    // scope: any change to query behavior".)

    /**
     * concept-intake (stage 1) persist. Writes the LLM-synthesized concept
     * columns. SQL verbatim from `stages/concept-intake.ts`.
     */
    applyConcept: async (
      id: string,
      draft: {
        name: string
        tone: string
        themes: string
        geographySummary: string
        politicalSummary: string
        era: string
        keyTensions: string
        followUpQuestions: string
      },
    ): Promise<void> => {
      await c.query(
        `UPDATE worlds SET
           name = $2, tone = $3, themes = $4, geography_summary = $5,
           political_summary = $6, era = $7, key_tensions = $8, follow_up_questions = $9
         WHERE id = $1`,
        [
          id,
          draft.name,
          draft.tone,
          draft.themes,
          draft.geographySummary,
          draft.politicalSummary,
          draft.era,
          draft.keyTensions,
          draft.followUpQuestions,
        ],
      )
    },

    /**
     * vocabulary-intake (stage 1.5) persist. SQL verbatim from
     * `stages/vocabulary-intake.ts`. `registryJson` is the caller-serialized
     * JSON string (the column is jsonb; the cast lives in the SQL).
     */
    setVocabularyRegistry: async (id: string, registryJson: string): Promise<void> => {
      await c.query(`UPDATE worlds SET vocabulary_registry = $2::jsonb WHERE id = $1`, [
        id,
        registryJson,
      ])
    },

    /**
     * world-and-factions (stage 2) persist. SQL verbatim from
     * `stages/world-and-factions.ts` `persistTree` — this one DOES set
     * `updated_at = now()` exactly as the stage did.
     */
    setWorldOverview: async (id: string, worldOverview: string): Promise<void> => {
      await c.query(`UPDATE worlds SET world_overview = $1, updated_at = now() WHERE id = $2`, [
        worldOverview,
        id,
      ])
    },

    /**
     * entity-relationships (stage 4) persist. Buffers the phantom-endpoint
     * declarations + relationships for stage 4b. SQL verbatim from
     * `stages/entity-relationships.ts`. `pendingJson` is the caller-serialized
     * JSON string.
     */
    setEntityConsolidationPending: async (id: string, pendingJson: string): Promise<void> => {
      await c.query(`UPDATE worlds SET entity_consolidation_pending = $1::jsonb WHERE id = $2`, [
        pendingJson,
        id,
      ])
    },

    /**
     * entity-consolidation (stage 4b) read: the pending phantom buffer stage 4
     * wrote. Returns the raw jsonb value (node-postgres hands back a parsed
     * object) or null when the column is null / the world is unknown. SQL
     * verbatim from `stages/entity-consolidation.ts`. Caller applies its
     * EMPTY_PENDING default. Runs on the pool OUTSIDE the persist tx, exactly
     * as the prior inline read did.
     */
    getEntityConsolidationPending: async <T = unknown>(id: string): Promise<T | null> => {
      const result = await c.query<{ entity_consolidation_pending: T | null }>(
        `SELECT entity_consolidation_pending FROM worlds WHERE id = $1`,
        [id],
      )
      return result.rows[0]?.entity_consolidation_pending ?? null
    },

    /**
     * entity-consolidation (stage 4b) persist. Clears the pending buffer back
     * to empty arrays. SQL verbatim from `stages/entity-consolidation.ts` —
     * the empty-arrays literal is part of the statement (no parameter).
     */
    clearEntityConsolidationPending: async (id: string): Promise<void> => {
      await c.query(
        `UPDATE worlds SET entity_consolidation_pending = '{"declarations": [], "relationships": []}'::jsonb WHERE id = $1`,
        [id],
      )
    },

    /**
     * starting-situation (stage 6) persist — the picker-facing prose blob.
     * SQL verbatim from `stages/starting-situation.ts`. `situationsJson` is
     * the caller-serialized JSON string (the column is TEXT — schema 001).
     */
    setStartingSituations: async (id: string, situationsJson: string): Promise<void> => {
      await c.query(`UPDATE worlds SET starting_situations = $2 WHERE id = $1`, [id, situationsJson])
    },

    /**
     * starting-situation (stage 6) persist — the resolved entries (index →
     * location entity). SQL verbatim from `stages/starting-situation.ts`.
     * `entriesJson` is the caller-serialized JSON string.
     */
    setStartingSituationEntries: async (id: string, entriesJson: string): Promise<void> => {
      await c.query(`UPDATE worlds SET starting_situation_entries = $2::jsonb WHERE id = $1`, [
        id,
        entriesJson,
      ])
    },
  }
}

/** Back-compat factory — pool-bound `worlds` surface. Identical shape to the
 *  pre-unification `createWorldsRepo`. Direct importers keep working; new code
 *  goes through `repo.worlds`. */
export const createWorldsRepo = (pool: Pool) => worldsNs(pool)
