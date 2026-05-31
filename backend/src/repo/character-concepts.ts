// backend/src/repo/character-concepts.ts
//
// MYT-53: repository for character_concepts. One row per
// (campaign_id, user_id). UPSERT semantics match the spec's
// re-submit-after-failure contract: re-POST while in 'submitted'
// or 'failed' replaces the row and resets status to 'submitted';
// 'processing' and 'completed' are not UPSERT-able through this path
// (the route layer guards with 409 'concept_locked').

import type { Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import type { ClientLike } from './_types.js'

export interface CharacterConcept {
  readonly id: string
  readonly campaignId: string
  readonly userId: string
  readonly conceptText: string | null
  readonly situationGroundingText: string
  readonly guidedChoices: Record<string, unknown>
  readonly status: 'submitted' | 'processing' | 'completed' | 'failed'
  readonly error: Record<string, unknown> | null
  readonly submittedAt: Date
  readonly updatedAt: Date
}

interface UpsertInput {
  readonly campaignId: string
  readonly userId: string
  readonly conceptText: string | null
  readonly situationGroundingText: string
  readonly guidedChoices: Record<string, unknown>
}

// myth-gp2c Cluster C: raw row shape of the character-integration party JOIN
// (character_concepts ⋈ campaign_members ⋈ users ⋈ campaign_characters ⋈
// characters), filtered to status='completed'. Homed on
// `repo.characterConcepts.loadCompletedParty` per the design's cross-domain
// join section ("integration party (concept-anchored)"). The character-
// integration stage maps this into its in-memory PartyMember shape.
export interface CompletedPartyRow {
  readonly user_id: string
  readonly display_name: string
  readonly concept_text: string | null
  readonly situation_grounding_text: string
  readonly concept_output: Record<string, unknown> | null
  readonly character_id: string | null
  readonly character_name: string | null
  readonly character_class: string | null
  readonly character_species: string | null
  readonly character_background: string | null
  readonly character_level: number | null
  readonly character_hit_points: number | null
  readonly character_armor_class: number | null
}

interface DbRow {
  id: string
  campaign_id: string
  user_id: string
  concept_text: string | null
  situation_grounding_text: string
  guided_choices: Record<string, unknown>
  status: 'submitted' | 'processing' | 'completed' | 'failed'
  error: Record<string, unknown> | null
  submitted_at: Date
  updated_at: Date
}

function toConcept(row: DbRow): CharacterConcept {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    userId: row.user_id,
    conceptText: row.concept_text,
    situationGroundingText: row.situation_grounding_text,
    guidedChoices: row.guided_choices,
    status: row.status,
    error: row.error,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  }
}

// Composable binder mirrors the repo-layer convention (see campaignsNs,
// charactersNs). The body is a method dictionary; each method captures the
// ClientLike `c` so it serves `repo.characterConcepts.X` and
// `tx.characterConcepts.X`. SQL unchanged — only `pool.query` → `c.query`.
//
// myth-gp2c Cluster C: `flipSubmittedToProcessing` dropped its explicit
// `client` first-param — POST /characters now composes it inside a
// `repo.transaction` callback (`tx.characterConcepts.flipSubmittedToProcessing`),
// so the closure binder supplies the client per the design's Migration note.
// eslint-disable-next-line max-lines-per-function
export function characterConceptsNs(c: ClientLike) {
  return {
    upsert: async (input: UpsertInput): Promise<CharacterConcept> => {
      const id = uuidv7()
      const result = await c.query<DbRow>(
        `INSERT INTO character_concepts (
           id, campaign_id, user_id, concept_text,
           situation_grounding_text, guided_choices, status
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'submitted')
         ON CONFLICT (campaign_id, user_id) DO UPDATE
           SET concept_text = EXCLUDED.concept_text,
               situation_grounding_text = EXCLUDED.situation_grounding_text,
               guided_choices = EXCLUDED.guided_choices,
               status = 'submitted',
               error = NULL,
               updated_at = now()
         RETURNING *`,
        [
          id,
          input.campaignId,
          input.userId,
          input.conceptText,
          input.situationGroundingText,
          JSON.stringify(input.guidedChoices),
        ],
      )
      // INSERT ... RETURNING * always returns exactly one row when the
      // INSERT succeeds; the ON CONFLICT DO UPDATE arm always updates
      // (no WHERE on the DO UPDATE). So row is guaranteed.
      const row = result.rows[0]
      /* c8 ignore next 3 — INSERT ... RETURNING always yields a row */
      if (row === undefined) {
        throw new Error('character_concepts UPSERT returned no row — driver invariant violated')
      }
      return toConcept(row)
    },

    getByCampaignAndUser: async (
      campaignId: string,
      userId: string,
    ): Promise<CharacterConcept | null> => {
      const result = await c.query<DbRow>(
        `SELECT * FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toConcept(row) : null
    },

    listSubmittedByCampaign: async (
      campaignId: string,
    ): Promise<readonly CharacterConcept[]> => {
      const result = await c.query<DbRow>(
        `SELECT * FROM character_concepts
         WHERE campaign_id = $1 AND status = 'submitted'
         ORDER BY submitted_at`,
        [campaignId],
      )
      return result.rows.map(toConcept)
    },

    markProcessing: async (campaignId: string, userId: string): Promise<void> => {
      await c.query(
        `UPDATE character_concepts
         SET status = 'processing', updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'submitted'`,
        [campaignId, userId],
      )
    },

    markCompleted: async (campaignId: string, userId: string): Promise<void> => {
      await c.query(
        `UPDATE character_concepts
         SET status = 'completed', error = NULL, updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
    },

    markFailed: async (
      campaignId: string,
      userId: string,
      error: Record<string, unknown>,
    ): Promise<void> => {
      await c.query(
        `UPDATE character_concepts
         SET status = 'failed', error = $3::jsonb, updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId, JSON.stringify(error)],
      )
    },

    // myth-gp2c Cluster C: flip a concept to 'integrated' during character-
    // integration (pass 4) once its PC entity + relationships are persisted.
    // Distinct from markCompleted (the per-player pipeline's terminal flip) —
    // 'integrated' is the post-MYT-54 campaign-scoped terminal state. SQL
    // verbatim from `stages/character-integration.ts writeIntegration`.
    // Composes inside the stage's `repo.transaction`.
    // myth-gp2c Cluster C: count 'completed' concepts for a campaign — the
    // POST /finalize-character-creation fan-in gate (without ≥1 completed
    // concept the integration job would run with an empty party). SQL verbatim
    // from the former inline COUNT. Composes inside the route's
    // `repo.transaction` so the count is consistent with the same-tx flip.
    countCompleted: async (campaignId: string): Promise<number> => {
      const result = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
             FROM character_concepts
            WHERE campaign_id = $1 AND status = 'completed'`,
        [campaignId],
      )
      /* c8 ignore next — COUNT(*) always returns a row, fallback unreachable */
      return Number.parseInt(result.rows[0]?.n ?? '0', 10)
    },

    markIntegrated: async (campaignId: string, userId: string): Promise<void> => {
      await c.query(
        `UPDATE character_concepts
            SET status = 'integrated', updated_at = now()
          WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
    },

    // myth-gp2c Cluster C: load the character-integration party — every
    // 'completed' concept for a campaign joined to its player display name +
    // the persisted characters row (via campaign_characters). Runs on the pool
    // OUTSIDE the integration persist tx exactly as the prior inline read did.
    // SQL verbatim from the former `character-integration.ts loadParty`.
    loadCompletedParty: async (campaignId: string): Promise<readonly CompletedPartyRow[]> => {
      // characters.campaign_id was dropped in migration 009 — membership lives
      // in campaign_characters. Join through it to reach the per-(campaign,
      // user) characters row.
      const result = await c.query<CompletedPartyRow>(
        `SELECT
           cc.user_id,
           u.display_name,
           cc.concept_text,
           cc.situation_grounding_text,
           cc.concept_output,
           ch.id           AS character_id,
           ch.name         AS character_name,
           ch.class        AS character_class,
           ch.species      AS character_species,
           ch.background   AS character_background,
           ch.level        AS character_level,
           ch.hit_points   AS character_hit_points,
           ch.armor_class  AS character_armor_class
           FROM character_concepts cc
           JOIN campaign_members cm USING (campaign_id, user_id)
           JOIN users u ON cm.user_id = u.id
           LEFT JOIN campaign_characters cch
             ON cch.campaign_id = cc.campaign_id AND cch.user_id = cc.user_id
           LEFT JOIN characters ch ON ch.id = cch.character_id
          WHERE cc.campaign_id = $1
            AND cc.status = 'completed'
          ORDER BY cc.submitted_at ASC`,
        [campaignId],
      )
      return result.rows
    },

    // myth-nmg9 / myth-gp2c Cluster C: per-player flip used inside POST
    // /characters' `repo.transaction`. The upsert wrote status='submitted';
    // this call immediately advances it to 'processing' so the per-player
    // BullMQ job can be enqueued AFTER the tx commits. The explicit-client
    // first-param was dropped during the data-layer unification — the closure
    // binder supplies the client, so the same body composes inside the route's
    // tx (`tx.characterConcepts.flipSubmittedToProcessing`). SQL unchanged.
    flipSubmittedToProcessing: async (
      campaignId: string,
      userId: string,
    ): Promise<{ userId: string; conceptId: string } | null> => {
      const result = await c.query<{ id: string; user_id: string }>(
        `UPDATE character_concepts
         SET status = 'processing', updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'submitted'
         RETURNING id, user_id`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      if (row === undefined) return null
      return { conceptId: row.id, userId: row.user_id }
    },
  }
}

/** Back-compat factory — pool-bound `characterConcepts` surface. Identical
 *  shape to the pre-unification `createCharacterConceptsRepo`. */
export const createCharacterConceptsRepo = (pool: Pool) => characterConceptsNs(pool)

export type CharacterConceptsRepo = ReturnType<typeof createCharacterConceptsRepo>
