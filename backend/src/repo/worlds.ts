import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type CreateWorldInput, type World, type WorldUpdate } from './types.js'
import { toWorld, type WorldDbRow } from './mappers.js'

export function createWorldsRepo(pool: Pool) {
  return {
    create: async (input: CreateWorldInput): Promise<World> => {
      const id = uuidv7()
      const result = await pool.query<WorldDbRow>(
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

    getById: async (id: string): Promise<World | null> => {
      const result = await pool.query<WorldDbRow>('SELECT * FROM worlds WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toWorld(row) : null
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
      const result = await pool.query<WorldDbRow>(
        `SELECT * FROM worlds WHERE is_demo = true LIMIT 1`,
      )
      const row = result.rows[0]
      return row ? toWorld(row) : null
    },

    listByUser: async (userId: string): Promise<World[]> => {
      const result = await pool.query<WorldDbRow>(
        `SELECT * FROM worlds WHERE created_by = $1 ORDER BY created_at DESC`,
        [userId],
      )
      return result.rows.map(toWorld)
    },

    update: async (id: string, patch: WorldUpdate): Promise<World> => {
      const result = await pool.query<WorldDbRow>(
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
      const result = await pool.query<WorldDbRow>(
        `UPDATE worlds SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, status],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.updateStatus: no world with id ${id}`)
      return toWorld(row)
    },

    incrementForkCount: async (id: string): Promise<World> => {
      const result = await pool.query<WorldDbRow>(
        `UPDATE worlds SET fork_count = fork_count + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`worlds.incrementForkCount: no world with id ${id}`)
      return toWorld(row)
    },
  }
}
