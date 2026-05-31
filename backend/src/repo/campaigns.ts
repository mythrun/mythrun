import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import {
  toCampaign,
  toCampaignMember,
  type CampaignDbRow,
  type CampaignMemberDbRow,
} from './mappers.js'
import type {
  Campaign,
  CampaignMember,
  CampaignMemberRole,
  CampaignUpdate,
  CreateCampaignInput,
} from './types.js'
import type { ClientLike } from './_types.js'

// Raw row shape of the world-gen context JOIN (campaigns ⋈ worlds). The
// world-gen processor maps this into its CampaignContext (parsing the jsonb
// vocabulary_registry). Homed on `repo.campaigns` per the design's
// "campaigns ⋈ worlds context loaders stay composite methods on repo.campaigns".
export interface WorldGenContextRow {
  readonly campaign_id: string
  readonly world_id: string
  readonly created_by: string
  readonly name: string
  readonly concept: string
  readonly tone: string | null
  readonly themes: string | null
  readonly era: string | null
  readonly key_tensions: string | null
  readonly geography_summary: string | null
  readonly political_summary: string | null
  readonly dev_bypass_access_filter: boolean
  readonly vocabulary_registry: unknown
}

// myth-gp2c Cluster C: raw row shape of the character-integration meta JOIN
// (campaigns ⋈ worlds) — pre_integration_notes + world_id + the chosen
// starting-situation index and the world's situation entries. Homed on
// `repo.campaigns` per the design's "campaigns ⋈ worlds context loaders stay
// composite methods on repo.campaigns". The integration stage resolves the
// chosen situation's prose from these.
export interface IntegrationMetaRow {
  readonly pre_integration_notes: string | null
  readonly world_id: string
  readonly starting_situation_index: number | null
  readonly starting_situation_entries: {
    readonly index: number
    readonly locationEntityId: string
    readonly prose: string
  }[]
}

// Composable binder: each method captures the ClientLike `c` (pool OR an
// in-flight tx client) so the same body serves `repo.campaigns.X` and
// `tx.campaigns.X`. The body is the method dictionary, not a complex
// algorithm; the namespace pattern is load-bearing for the repo layer's
// grep-ability. SQL unchanged — only `pool.query` → `c.query`.
// eslint-disable-next-line max-lines-per-function
export function campaignsNs(c: ClientLike) {
  return {
    create: async (input: CreateCampaignInput): Promise<Campaign> => {
      const id = uuidv7()
      const result = await c.query<CampaignDbRow>(
        `INSERT INTO campaigns (id, world_id, source_world_id, created_by, name, status, language)
         VALUES (
            $1, $2, $3, $4, $5,
            COALESCE($6, 'setup'),
            COALESCE($7, 'en')
         ) RETURNING *`,
        [
          id,
          input.worldId,
          input.sourceWorldId ?? null,
          input.createdBy,
          input.name,
          input.status ?? null,
          input.language ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('campaigns.create: INSERT returned no row')
      return toCampaign(row)
    },

    /**
     * Cluster-A create-tx footprint: insert a campaign row in 'setup' status
     * with name 'Untitled'. Composable — runs over the captured client. SQL
     * verbatim from `executeCreateTransaction` (backend/src/routes/campaigns.ts):
     * `INSERT INTO campaigns (id, world_id, created_by, name, status) VALUES
     * ($1, $2, $3, 'Untitled', 'setup')`. Distinct from `create` (which
     * COALESCEs status/language and carries source_world_id) — this is the
     * fixed-literal create-side shape.
     */
    insertSetup: async (input: {
      id: string
      worldId: string
      createdBy: string
      name?: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO campaigns (id, world_id, created_by, name, status)
         VALUES ($1, $2, $3, $4, 'setup')`,
        [input.id, input.worldId, input.createdBy, input.name ?? 'Untitled'],
      )
    },

    /**
     * Cluster-A create-tx footprint: insert the owner membership row.
     * Composable — runs over the captured client. SQL verbatim from
     * `executeCreateTransaction`: `INSERT INTO campaign_members (id,
     * campaign_id, user_id, role, invite_accepted) VALUES ($1, $2, $3, 'owner',
     * true)`. Distinct from `addMember` — that one parameterizes role +
     * invite_accepted and carries ON CONFLICT DO NOTHING + a RETURNING/SELECT
     * round-trip; the create site writes the owner row with fixed literals and
     * no conflict handling.
     */
    insertOwnerMember: async (input: {
      id: string
      campaignId: string
      userId: string
    }): Promise<void> => {
      await c.query(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'owner', true)`,
        [input.id, input.campaignId, input.userId],
      )
    },

    getById: async (id: string): Promise<Campaign | null> => {
      const result = await c.query<CampaignDbRow>('SELECT * FROM campaigns WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toCampaign(row) : null
    },

    /**
     * World-id-only read. Returns null when the campaign is absent. SQL verbatim
     * from the inline `SELECT world_id FROM campaigns WHERE id = $1` reads in
     * campaign-characters.ts (T12 / T19a hierarchy / T19b random-tables) and
     * character-creation-processor.ts (worldId resolution). Distinct from
     * `getById` (full Campaign row) — the callers only need the world_id.
     */
    getWorldId: async (id: string): Promise<string | null> => {
      const result = await c.query<{ world_id: string }>(
        `SELECT world_id FROM campaigns WHERE id = $1`,
        [id],
      )
      return result.rows[0]?.world_id ?? null
    },

    /**
     * Read a campaign's world_id + starting_situation_index together. Returns
     * null when the campaign is absent. SQL verbatim from the inline read in
     * campaign-characters.ts (T15 POST /characters + T16 GET
     * /starting-situations). The two columns are read as a pair in both sites.
     */
    getWorldAndSituationIndex: async (
      id: string,
    ): Promise<{ world_id: string; starting_situation_index: number | null } | null> => {
      const result = await c.query<{
        world_id: string
        starting_situation_index: number | null
      }>(
        `SELECT world_id, starting_situation_index FROM campaigns WHERE id = $1`,
        [id],
      )
      return result.rows[0] ?? null
    },

    /**
     * Read a campaign's chosen starting_situation_index only. Returns null when
     * the campaign is absent OR the index is unset (both collapse to null — the
     * caller treats either as "owner has not chosen"). SQL verbatim from the
     * inline read in location-selection.ts.
     */
    getStartingSituationIndex: async (id: string): Promise<number | null> => {
      const result = await c.query<{ starting_situation_index: number | null }>(
        `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
        [id],
      )
      return result.rows[0]?.starting_situation_index ?? null
    },

    /**
     * Set a campaign's starting_situation_index (T12 POST /starting-situation).
     * SQL verbatim from the former inline `UPDATE campaigns SET
     * starting_situation_index = $2 WHERE id = $1`.
     */
    setStartingSituationIndex: async (id: string, index: number): Promise<void> => {
      await c.query(
        `UPDATE campaigns SET starting_situation_index = $2 WHERE id = $1`,
        [id, index],
      )
    },

    /**
     * Archive a campaign (T14 POST /archive) — only when it is still 'setup' or
     * 'active'. Returns true when a row was archived, false when no eligible row
     * matched (already archived / unknown). SQL verbatim from the former inline
     * `UPDATE campaigns SET status = 'archived' WHERE id = $1 AND status IN
     * ('setup', 'active') RETURNING status`.
     */
    archive: async (id: string): Promise<boolean> => {
      const result = await c.query<{ status: string }>(
        `UPDATE campaigns SET status = 'archived'
         WHERE id = $1 AND status IN ('setup', 'active')
         RETURNING status`,
        [id],
      )
      return result.rows.length > 0
    },

    /**
     * Rename a campaign by id (PATCH /name). Returns true when a row was
     * updated, false when none matched. SQL verbatim from the former inline
     * `UPDATE campaigns SET name = $2, updated_at = now() WHERE id = $1
     * RETURNING id`. Distinct from the generic `update` (COALESCE multi-column)
     * — this is the focused name-only flip the route used.
     */
    renameById: async (id: string, name: string): Promise<boolean> => {
      const result = await c.query<{ id: string }>(
        `UPDATE campaigns SET name = $2, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, name],
      )
      return result.rowCount === 1
    },

    /**
     * Flip a campaign to 'failed' (character-integration terminal-error path).
     * SQL verbatim from the former inline `UPDATE campaigns SET status =
     * 'failed', updated_at = now() WHERE id = $1`. Distinct from `setActive`
     * (the success flip) and the generic `update`.
     */
    setFailed: async (id: string): Promise<void> => {
      await c.query(
        `UPDATE campaigns SET status = 'failed', updated_at = now() WHERE id = $1`,
        [id],
      )
    },

    /**
     * Concurrent-generation guard (POST /api/campaigns step 2b): does the user
     * own a campaign whose world is currently 'generating'? Returns true when at
     * least one such campaign exists. SQL verbatim from the former inline
     * `SELECT campaigns.id FROM campaigns WHERE campaigns.created_by = $1 AND
     * campaigns.world_id IN (SELECT id FROM worlds WHERE status = 'generating')
     * LIMIT 1`.
     */
    findInFlightGenerationForUser: async (userId: string): Promise<boolean> => {
      const result = await c.query<{ id: string }>(
        `SELECT campaigns.id FROM campaigns
         WHERE campaigns.created_by = $1
           AND campaigns.world_id IN (SELECT id FROM worlds WHERE status = 'generating')
         LIMIT 1`,
        [userId],
      )
      return result.rows.length > 0
    },

    /**
     * World-gen job context: the campaign + its world's prep columns, joined.
     * Returns null when the campaign (or its world) is absent. SQL verbatim
     * from the world-gen processor's `loadCampaignContext`. The caller maps the
     * raw row into its CampaignContext (parsing the jsonb vocabulary_registry).
     */
    loadWorldGenContext: async (campaignId: string): Promise<WorldGenContextRow | null> => {
      const result = await c.query<WorldGenContextRow>(
        `SELECT c.id AS campaign_id, w.id AS world_id, w.created_by, w.name, w.concept,
                w.tone, w.themes, w.era, w.key_tensions, w.geography_summary,
                w.political_summary, w.dev_bypass_access_filter, w.vocabulary_registry
           FROM campaigns c
           JOIN worlds w ON w.id = c.world_id
          WHERE c.id = $1`,
        [campaignId],
      )
      return result.rows[0] ?? null
    },

    /**
     * concept-intake (stage 1) name propagation. Sets the campaign owning
     * `worldId` to the LLM-synthesized name, but ONLY while it still carries
     * the create-time 'Untitled' placeholder (so a user's PATCH rename isn't
     * clobbered). Composable — runs over the captured client. SQL verbatim
     * from `stages/concept-intake.ts` (myth-4lhr).
     */
    setNameFromUntitled: async (worldId: string, name: string): Promise<void> => {
      await c.query(
        `UPDATE campaigns SET name = $2 WHERE world_id = $1 AND name = 'Untitled'`,
        [worldId, name],
      )
    },

    /**
     * myth-gp2c Cluster C: flip a campaign to 'active' — the final write of
     * character-integration once every PC is woven into the world. Distinct
     * from the generic `update` (COALESCE + RETURNING) so the SQL stays
     * byte-identical to the former inline write. SQL verbatim from
     * `stages/character-integration.ts writeIntegration`. Composes inside the
     * stage's `repo.transaction`.
     */
    setActive: async (campaignId: string): Promise<void> => {
      await c.query(
        `UPDATE campaigns SET status = 'active', updated_at = now() WHERE id = $1`,
        [campaignId],
      )
    },

    /**
     * myth-gp2c Cluster C: the POST /finalize-character-creation flip. Sets
     * pre_integration_notes ONLY while the campaign is still 'setup' (RETURNING
     * tells the route whether the flip applied — 0 rows means finalize already
     * ran or the owner archived). Returns true when a row was updated, false
     * otherwise. SQL verbatim from the former inline write. Composes inside the
     * route's `repo.transaction`.
     */
    setPreIntegrationNotesIfSetup: async (
      campaignId: string,
      notes: string | null,
    ): Promise<boolean> => {
      const result = await c.query(
        `UPDATE campaigns
              SET pre_integration_notes = $1, updated_at = now()
            WHERE id = $2 AND status = 'setup'
            RETURNING id`,
        [notes, campaignId],
      )
      return result.rowCount === 1
    },

    /**
     * myth-gp2c Cluster C: load character-integration campaign meta — the
     * campaign's pre_integration_notes + world_id, joined to the world's
     * starting-situation entries + the campaign's chosen index. Runs on the
     * pool OUTSIDE the integration persist tx. SQL verbatim from the former
     * `character-integration.ts loadCampaignMeta`. Returns null when the
     * campaign row is absent (callers gate on existence).
     */
    loadIntegrationMeta: async (campaignId: string): Promise<IntegrationMetaRow | null> => {
      const result = await c.query<IntegrationMetaRow>(
        `SELECT c.pre_integration_notes,
                c.world_id,
                c.starting_situation_index,
                w.starting_situation_entries
           FROM campaigns c
           JOIN worlds w ON w.id = c.world_id
          WHERE c.id = $1`,
        [campaignId],
      )
      return result.rows[0] ?? null
    },

    listByUser: async (userId: string): Promise<Campaign[]> => {
      const result = await c.query<CampaignDbRow>(
        `SELECT c.* FROM campaigns c
            JOIN campaign_members cm ON cm.campaign_id = c.id
          WHERE cm.user_id = $1 AND cm.invite_accepted = true
          ORDER BY c.created_at DESC`,
        [userId],
      )
      return result.rows.map(toCampaign)
    },

    update: async (id: string, patch: CampaignUpdate): Promise<Campaign> => {
      const result = await c.query<CampaignDbRow>(
        `UPDATE campaigns
            SET name       = COALESCE($2, name),
                status     = COALESCE($3, status),
                language   = COALESCE($4, language),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, patch.name ?? null, patch.status ?? null, patch.language ?? null],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`campaigns.update: no campaign with id ${id}`)
      return toCampaign(row)
    },

    addMember: async (input: {
      campaignId: string
      userId: string
      role: CampaignMemberRole
      inviteAccepted?: boolean
    }): Promise<CampaignMember> => {
      const id = uuidv7()
      const inserted = await c.query<CampaignMemberDbRow>(
        `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campaign_id, user_id) DO NOTHING
         RETURNING *`,
        [id, input.campaignId, input.userId, input.role, input.inviteAccepted ?? true],
      )
      const insertedRow = inserted.rows[0]
      if (inserted.rowCount === 1 && insertedRow !== undefined) {
        return toCampaignMember(insertedRow)
      }
      const existing = await c.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [input.campaignId, input.userId],
      )
      const row = existing.rows[0]
      if (!row) throw new Error('addMember: ON CONFLICT then SELECT returned no row')
      return toCampaignMember(row)
    },

    getMembership: async (campaignId: string, userId: string): Promise<CampaignMember | null> => {
      const result = await c.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId],
      )
      const row = result.rows[0]
      return row ? toCampaignMember(row) : null
    },

    getOwner: async (campaignId: string): Promise<CampaignMember | null> => {
      const result = await c.query<CampaignMemberDbRow>(
        `SELECT * FROM campaign_members WHERE campaign_id = $1 AND role = 'owner'`,
        [campaignId],
      )
      const row = result.rows[0]
      return row ? toCampaignMember(row) : null
    },

    /**
     * T17 GET /characters party roster: one row per campaign member joined to
     * character_concepts (status) + campaign_characters (persisted PC id). LEFT
     * JOINs because a member may not have submitted a concept yet, and a
     * submitted concept may not yet have a persisted character. SQL verbatim
     * from the former inline roster JOIN in campaign-characters.ts. Homed on
     * `repo.campaigns.getPartyRoster` per the design's cross-domain join section.
     */
    getPartyRoster: async (
      campaignId: string,
    ): Promise<
      readonly {
        user_id: string
        display_name: string
        concept_status: 'submitted' | 'processing' | 'completed' | 'failed' | null
        character_id: string | null
      }[]
    > => {
      const result = await c.query<{
        user_id: string
        display_name: string
        concept_status: 'submitted' | 'processing' | 'completed' | 'failed' | null
        character_id: string | null
      }>(
        `SELECT cm.user_id,
                u.display_name,
                cc.status        AS concept_status,
                ch.character_id  AS character_id
         FROM campaign_members cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN character_concepts cc
           ON cc.campaign_id = cm.campaign_id AND cc.user_id = cm.user_id
         LEFT JOIN campaign_characters ch
           ON ch.campaign_id = cm.campaign_id AND ch.user_id = cm.user_id
         WHERE cm.campaign_id = $1
         ORDER BY cm.joined_at`,
        [campaignId],
      )
      return result.rows
    },

    /**
     * MYT-54 T12 progress board: member roster (user_id + display_name) ordered
     * by joined_at, no concept/character join. SQL verbatim from the former
     * inline read in campaign-characters.ts
     * (GET /character-creation-progress). Distinct from `listMembers` (which
     * also pulls username + role + filters suspended users) — this is the
     * lighter display-only roster the progress board used.
     */
    listMembersBasic: async (
      campaignId: string,
    ): Promise<readonly { user_id: string; display_name: string }[]> => {
      const result = await c.query<{ user_id: string; display_name: string }>(
        `SELECT cm.user_id, u.display_name
           FROM campaign_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.campaign_id = $1
          ORDER BY cm.joined_at`,
        [campaignId],
      )
      return result.rows
    },

    listMembers: async (
      campaignId: string,
    ): Promise<
      {
        userId: string
        role: CampaignMemberRole
        username: string
        displayName: string
        characterId: string | null
        joinedAt: Date
      }[]
    > => {
      const result = await c.query<{
        user_id: string
        role: string
        username: string
        display_name: string
        joined_at: Date
      }>(
        `SELECT cm.user_id, cm.role, u.username, u.display_name, cm.joined_at
           FROM campaign_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.campaign_id = $1
            AND u.suspended_at IS NULL
          ORDER BY cm.joined_at ASC`,
        [campaignId],
      )
      return result.rows.map((r) => ({
        userId: r.user_id,
        role: r.role === 'owner' ? 'owner' : 'player',
        username: r.username,
        displayName: r.display_name,
        characterId: null,
        joinedAt: r.joined_at,
      }))
    },
  }
}

/** Back-compat factory — pool-bound `campaigns` surface. Identical shape to
 *  the pre-unification `createCampaignsRepo`. */
export const createCampaignsRepo = (pool: Pool) => campaignsNs(pool)
