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

// myth-3u4a0: a concept stuck at 'processing' with no live worker driving it
// (the staging hang: two LLM calls done, then an un-timed-out await stalled and
// the BullMQ lock renewed forever) cannot be reset by the player, because the
// reset only unwound terminal ('completed'/'failed') rows — bricking creation.
// A 'processing' row whose `updated_at` has not advanced for this long has no
// live worker: it comfortably exceeds the whole-job watchdog
// (CHARACTER_CREATION_JOB_TIMEOUT_MS, 16m) minus its longest legitimate
// no-write gap (a single stage's LLM + persistence, ~1-2m under the 5m per-stage
// watchdog), so a still-progressing job has always bumped `updated_at` within
// the window. Kept just below the 16m whole-job cap so the player can self-serve
// a recovery slightly before the backstop fails the job.
const STALE_PROCESSING_RESET_MS = 10 * 60_000

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

    /**
     * Count concepts in a "situation-locked" state (status IN ('processing',
     * 'completed')) for a campaign — the T12 POST /starting-situation guard.
     * Once any player's pipeline is running or done, the owner can no longer
     * change the starting situation. SQL verbatim from the former inline
     * `SELECT COUNT(*)::text AS n FROM character_concepts WHERE campaign_id = $1
     * AND status IN ('processing', 'completed')`.
     */
    countLocked: async (campaignId: string): Promise<number> => {
      const result = await c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM character_concepts
         WHERE campaign_id = $1 AND status IN ('processing', 'completed')`,
        [campaignId],
      )
      /* c8 ignore next — COUNT(*) always returns a row, fallback unreachable */
      return Number.parseInt(result.rows[0]?.n ?? '0', 10)
    },

    /**
     * MYT-54 T12 progress board: every character_concepts row for a campaign
     * (user_id, status, submitted_at, error). The route nests these under the
     * member roster. `error` is JSONB; the caller decides when to surface it.
     *
     * MYT-90 D8: additively surfaces `confirmed_at` (the "This is me"
     * confirmation timestamp — the FE routing table keys the reveal→party-staging
     * split on it so a reload in the completed→active window is stable) and
     * `character_id` (the member's generated PC id — the reveal needs it to fetch
     * the sheet). `character_id` LEFT JOINs `campaign_characters` (its
     * `(campaign_id, user_id)` is UNIQUE), so it is null until the sheet stage
     * persists the character.
     */
    listForCampaign: async (
      campaignId: string,
    ): Promise<
      readonly {
        user_id: string
        status: string
        submitted_at: Date
        error: unknown
        confirmed_at: Date | null
        character_id: string | null
      }[]
    > => {
      const result = await c.query<{
        user_id: string
        status: string
        submitted_at: Date
        error: unknown
        confirmed_at: Date | null
        character_id: string | null
      }>(
        `SELECT cc.user_id, cc.status, cc.submitted_at, cc.error, cc.confirmed_at,
                ccx.character_id
           FROM character_concepts cc
           LEFT JOIN campaign_characters ccx
             ON ccx.campaign_id = cc.campaign_id AND ccx.user_id = cc.user_id
          WHERE cc.campaign_id = $1`,
        [campaignId],
      )
      return result.rows
    },

    /**
     * Read the concept_text + guided_choices for one (campaign, user) concept —
     * the character_concept stage's prompt inputs. Returns null when the row is
     * absent (the caller throws an invariant-violation in that case). SQL
     * verbatim from the former inline read in
     * `character-creation-processor.ts buildConceptArgs`.
     */
    getConceptInputs: async (
      campaignId: string,
      userId: string,
    ): Promise<{ concept_text: string | null; guided_choices: Record<string, unknown> } | null> => {
      const result = await c.query<{
        concept_text: string | null
        guided_choices: Record<string, unknown>
      }>(
        `SELECT concept_text, guided_choices FROM character_concepts
           WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      return result.rows[0] ?? null
    },

    /**
     * myth-y7xt T2 / data-layer unification: persist the structured narrative
     * (concept_output JSONB) once the character_concept stage produces it, so
     * MYT-54's campaign-scoped integration worker can read it. SQL verbatim from
     * the former inline `UPDATE character_concepts SET concept_output = $1::jsonb,
     * updated_at = now() WHERE campaign_id = $2 AND user_id = $3`. `outputJson`
     * is the caller-serialized JSON string (the column is jsonb; the cast lives
     * in the SQL).
     */
    setConceptOutput: async (
      campaignId: string,
      userId: string,
      outputJson: string,
    ): Promise<void> => {
      await c.query(
        `UPDATE character_concepts
            SET concept_output = $1::jsonb, updated_at = now()
          WHERE campaign_id = $2 AND user_id = $3`,
        [outputJson, campaignId, userId],
      )
    },

    /**
     * myth-evpfr: read back the structured narrative `setConceptOutput` wrote.
     *
     * The character-creation loop persists concept_output BEFORE it marks the
     * character_concept stage completed, so "stage 2 is completed" implies this
     * row is populated. That ordering is what makes stage-3 re-entry
     * RECOVERABLE: a job that resumes after stage 2's marker committed finds
     * `ctx.conceptOutput === null` in memory but the same narrative still here.
     * Returns null when the row (or the column) is absent — the caller treats
     * that as genuinely unrecoverable and terminal-fails.
     */
    getConceptOutput: async (
      campaignId: string,
      userId: string,
    ): Promise<Record<string, unknown> | null> => {
      const result = await c.query<{ concept_output: Record<string, unknown> | null }>(
        `SELECT concept_output FROM character_concepts
           WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      return result.rows[0]?.concept_output ?? null
    },

    /**
     * MYT-102 A3: the resume route's stuck-concept sweep. A concept is STUCK
     * when it sits at 'processing' but no worker is (or will be) driving it:
     * some character-stage pipeline_runs row for the (campaign, user) is
     * 'pending' (lost enqueue — the POST /characters seed row was committed
     * but the queue.add after COMMIT never landed) or 'failed' (a transient
     * retry exhausted before MYT-102's exhausted-'failed' listener existed),
     * AND no character-stage row is 'running' (an active worker holds the
     * stage; the per-stage watchdog bounds how long that can last, so resume
     * must not double-enqueue under it).
     *
     * The stage list mirrors STAGES_IN_ORDER in
     * character-creation-processor.ts (the per-player pipeline; the
     * campaign-scoped 'character_integration' has its own recovery path).
     */
    listStuckProcessing: async (
      campaignId: string,
    ): Promise<readonly { user_id: string }[]> => {
      const result = await c.query<{ user_id: string }>(
        `SELECT cc.user_id
           FROM character_concepts cc
          WHERE cc.campaign_id = $1
            AND cc.status = 'processing'
            AND EXISTS (
              SELECT 1 FROM pipeline_runs pr
               WHERE pr.campaign_id = cc.campaign_id
                 AND pr.user_id = cc.user_id
                 AND pr.stage IN ('location_selection', 'character_concept', 'character_sheet')
                 AND pr.status IN ('pending', 'failed')
            )
            AND NOT EXISTS (
              SELECT 1 FROM pipeline_runs pr
               WHERE pr.campaign_id = cc.campaign_id
                 AND pr.user_id = cc.user_id
                 AND pr.stage IN ('location_selection', 'character_concept', 'character_sheet')
                 AND pr.status = 'running'
            )
          ORDER BY cc.submitted_at ASC`,
        [campaignId],
      )
      return result.rows
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

    /**
     * MYT-90 A7: "Start over" on the character reveal. Flip the caller's OWN
     * concept from a terminal PRE-play state ('completed' or 'failed') back to
     * a resubmittable 'submitted' and clear the generated character sheet, so
     * POST /characters — which 409s concept_locked on a 'completed' row — can
     * re-run the per-player pipeline. `confirmed_at` + `error` are cleared so
     * the reset row is indistinguishable from a fresh submission.
     *
     * The flip is guarded so an INTEGRATED character or an ACTIVE campaign
     * cannot be unwound: the conditional UPDATE matches only 'completed'/'failed'
     * concepts whose campaign is not yet 'active' (once play starts,
     * session_participants — the one non-cascading FK to characters — references
     * the sheet and the run is live). Returns false when nothing matched → the
     * route replies 409 not_resettable.
     *
     * myth-3u4a0: ALSO matches a STALE 'processing' row (no `updated_at` write
     * for `staleMs`), so a player whose creation job hung — lock renewing
     * forever, no live worker — can self-serve a reset instead of being bricked.
     * A FRESH 'processing' row (an active worker mid-stage) stays locked. The
     * whole-job watchdog + the exhausted-'failed' listener remain the worker-side
     * recovery; this is the player-side one for the case where neither could flip
     * the row (e.g. a wedged DB await).
     *
     * Composes inside `repo.transaction` (the route wraps it) so the status flip
     * + the sheet DELETE commit atomically. Deleting the `characters` row
     * cascades the campaign_characters join + the four sub-tables + the MYT-70
     * ledger rows (all FK ON DELETE CASCADE); the not-active guard guarantees no
     * session_participants row points at it.
     */
    resetConcept: async (
      campaignId: string,
      userId: string,
      staleMs: number = STALE_PROCESSING_RESET_MS,
    ): Promise<boolean> => {
      const flip = await c.query<{ id: string }>(
        `UPDATE character_concepts
            SET status = 'submitted', confirmed_at = NULL, error = NULL, updated_at = now()
          WHERE campaign_id = $1 AND user_id = $2
            AND (
              status IN ('completed', 'failed')
              OR (status = 'processing'
                  AND updated_at < now() - ($3::double precision * interval '1 millisecond'))
            )
            AND campaign_id IN (SELECT id FROM campaigns WHERE id = $1 AND status <> 'active')
          RETURNING id`,
        [campaignId, userId, staleMs],
      )
      if (flip.rows.length === 0) return false
      // Clear the generated sheet so "Start over" regenerates from scratch. The
      // character-sheet stage keys its lookup-or-INSERT on campaign_characters;
      // with the join gone it INSERTs a fresh characters row on resubmission.
      await c.query(
        `DELETE FROM characters
          WHERE id IN (
            SELECT character_id FROM campaign_characters
             WHERE campaign_id = $1 AND user_id = $2
          )`,
        [campaignId, userId],
      )
      return true
    },

    /**
     * MYT-90 A7: "This is me" — persist the player's confirmation so a reload
     * doesn't bounce them out of party staging. Sets confirmed_at on the
     * caller's OWN 'completed' concept. COALESCE keeps the FIRST confirmation
     * timestamp, so a repeated click is a genuine no-op (idempotent). Returns
     * false when the concept isn't 'completed' (nothing to confirm) → the route
     * replies 409 not_confirmable.
     */
    confirmConcept: async (campaignId: string, userId: string): Promise<boolean> => {
      const result = await c.query<{ id: string }>(
        `UPDATE character_concepts
            SET confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
          WHERE campaign_id = $1 AND user_id = $2 AND status = 'completed'
          RETURNING id`,
        [campaignId, userId],
      )
      return result.rows.length > 0
    },
  }
}

/** Back-compat factory — pool-bound `characterConcepts` surface. Identical
 *  shape to the pre-unification `createCharacterConceptsRepo`. */
export const createCharacterConceptsRepo = (pool: Pool) => characterConceptsNs(pool)

export type CharacterConceptsRepo = ReturnType<typeof createCharacterConceptsRepo>
