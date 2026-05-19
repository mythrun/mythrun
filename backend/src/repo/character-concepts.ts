// backend/src/repo/character-concepts.ts
//
// MYT-53: repository for character_concepts. One row per
// (campaign_id, user_id). UPSERT semantics match the spec's
// re-submit-after-failure contract: re-POST while in 'submitted'
// or 'failed' replaces the row and resets status to 'submitted';
// 'processing' and 'completed' are not UPSERT-able through this path
// (the route layer guards with 409 'concept_locked').

import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'

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

// Namespace factory mirrors the repo-layer convention (see campaigns.ts,
// characters.ts). The body is a method dictionary.
export function createCharacterConceptsRepo(pool: Pool) {
  return {
    upsert: async (input: UpsertInput): Promise<CharacterConcept> => {
      const id = uuidv7()
      const result = await pool.query<DbRow>(
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
      const result = await pool.query<DbRow>(
        `SELECT * FROM character_concepts WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toConcept(row) : null
    },

    listSubmittedByCampaign: async (
      campaignId: string,
    ): Promise<readonly CharacterConcept[]> => {
      const result = await pool.query<DbRow>(
        `SELECT * FROM character_concepts
         WHERE campaign_id = $1 AND status = 'submitted'
         ORDER BY submitted_at`,
        [campaignId],
      )
      return result.rows.map(toConcept)
    },

    markProcessing: async (campaignId: string, userId: string): Promise<void> => {
      await pool.query(
        `UPDATE character_concepts
         SET status = 'processing', updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'submitted'`,
        [campaignId, userId],
      )
    },

    markCompleted: async (campaignId: string, userId: string): Promise<void> => {
      await pool.query(
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
      await pool.query(
        `UPDATE character_concepts
         SET status = 'failed', error = $3::jsonb, updated_at = now()
         WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId, JSON.stringify(error)],
      )
    },

    // Atomic claim helper for the fan-out route: flip every 'submitted'
    // row for a campaign to 'processing' inside the route's transaction
    // alongside the BullMQ enqueue. The route's BEGIN ... COMMIT envelopes
    // both this UPDATE and the queue.add() so a failed enqueue rolls back.
    flipAllSubmittedToProcessing: async (
      client: PoolClient,
      campaignId: string,
    ): Promise<readonly { userId: string; conceptId: string }[]> => {
      const result = await client.query<{ id: string; user_id: string }>(
        `UPDATE character_concepts
         SET status = 'processing', updated_at = now()
         WHERE campaign_id = $1 AND status = 'submitted'
         RETURNING id, user_id`,
        [campaignId],
      )
      return result.rows.map((r) => ({ conceptId: r.id, userId: r.user_id }))
    },
  }
}

export type CharacterConceptsRepo = ReturnType<typeof createCharacterConceptsRepo>
