// backend/src/routes/campaign-characters.ts
//
// MYT-53: per-player character-creation routes. This file holds the
// HTTP routes added by MYT-53. The plugin currently mounts T12-T17:
//
//   T12 POST /api/campaigns/:campaignId/starting-situation       (owner)
//   T13 POST /api/campaigns/:campaignId/start-character-creation (owner)
//   T14 POST /api/campaigns/:campaignId/archive                  (owner)
//   T15 POST /api/campaigns/:campaignId/characters               (member)
//   T16 GET  /api/campaigns/:campaignId/starting-situations      (member)
//   T17 GET  /api/campaigns/:campaignId/characters               (member)
//
// T12-T14 use `requireCampaignMember(repo, 'owner')`; T15-T17 use
// `requireCampaignMember(repo)` (any accepted member — owner OR player).
// T22 will register the plugin in `app.ts` and add the routes that carry
// `pipelineRoute: true` to `contract/pipeline-routes.ts`.
//
// Plug-in opts:
//   - `pool`     — shared pg Pool; the plugin builds its own repo via
//                  `createRepo(opts.pool)`.
//   - `characterCreationQueue` — BullMQ-compatible queue surface (only
//                  `.add()` is touched). Optional so the test app and
//                  the real boot can pass `undefined` during the brief
//                  window where the queue is not yet wired; the route
//                  responds 503 'queue_not_ready' in that state.

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { entityHierarchy } from '../repo/entity-hierarchy.js'
import type { CharacterDbRow } from '../repo/mappers.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'

export interface CharacterCreationQueueLike {
  add(
    name: string,
    data: { campaignId: string; userId: string },
    opts?: { jobId?: string },
  ): Promise<unknown>
}

export interface Opts {
  readonly pool: Pool
  // Explicit `| undefined` rather than `?:` so app.ts can pass the value
  // through unconditionally without a conditional-spread branch (and we
  // don't need a buildApp test specifically for the no-queue boot path).
  readonly characterCreationQueue: CharacterCreationQueueLike | undefined
}

// T12 body. Zod's `safeParse` is the parse boundary; failure → 400 'bad_body'.
const StartingSituationBodySchema = z.object({
  index: z.number().int().min(0).max(2),
})

// T15 body. `conceptText` and `guidedChoices` are individually optional;
// v1 is freeform-only — both texts required. The guided-mode follow-on
// bead reshapes this schema when it ships (adds guidedChoices). Bounded
// 20..2000 / 20..4000 to mirror the DB CHECK constraints in migration 016
// — keeps the failure mode at the route boundary (400 bad_body) rather
// than a 500 from Postgres rejecting the row.
const PostCharacterBodySchema = z.object({
  conceptText: z.string().min(20).max(4000),
  situationGroundingText: z.string().min(20).max(2000),
})

// Row shape returned by the T17 roster JOIN. Declared at module scope so the
// query's pool.query<...> generic and the response mapper share a single type.
interface RosterRow {
  user_id: string
  display_name: string
  concept_status: 'submitted' | 'processing' | 'completed' | 'failed' | null
  character_id: string | null
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only synchronous app.post registrations).
// eslint-disable-next-line @typescript-eslint/require-await, max-lines-per-function
export const campaignCharactersPlugin: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  // --------------------------------------------------------------------
  // T12: POST /starting-situation
  // --------------------------------------------------------------------
  app.post<{
    Params: { campaignId: string }
    Body: z.infer<typeof StartingSituationBodySchema>
  }>(
    '/api/campaigns/:campaignId/starting-situation',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const parsed = StartingSituationBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ code: 'bad_body' })

      // requireCampaignMember has already proven the campaign exists +
      // current user is its owner. Trust that and reach for world_id
      // unconditionally.
      const campaign = await opts.pool.query<{ world_id: string }>(
        `SELECT world_id FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const worldId = campaign.rows[0]?.world_id ?? ''

      const world = await opts.pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      if (world.rows[0]?.status !== 'complete') {
        return reply.code(409).send({ code: 'world_not_complete' })
      }

      // COUNT(*) always returns exactly one row, so locked.rows[0].n is
      // always defined — fallback '0' is unreachable but type-safe.
      const locked = await opts.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM character_concepts
         WHERE campaign_id = $1 AND status IN ('processing', 'completed')`,
        [req.params.campaignId],
      )
      /* c8 ignore next — COUNT(*) always returns a row, fallback unreachable */
      if (Number.parseInt(locked.rows[0]?.n ?? '0', 10) > 0) {
        return reply.code(409).send({ code: 'situation_locked' })
      }

      await opts.pool.query(
        `UPDATE campaigns SET starting_situation_index = $2 WHERE id = $1`,
        [req.params.campaignId, parsed.data.index],
      )
      return reply.code(200).send({ index: parsed.data.index })
    },
  )

  // --------------------------------------------------------------------
  // T13: POST /start-character-creation
  //
  // BEGIN; flipAllSubmittedToProcessing; .add() for each; COMMIT. If
  // any .add() throws, ROLLBACK first then rethrow so Fastify renders
  // 500 with the rows still in 'submitted'.
  // --------------------------------------------------------------------
  app.post<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/start-character-creation',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const queue = opts.characterCreationQueue
      if (!queue) {
        return reply.code(503).send({ code: 'queue_not_ready' })
      }

      const camp = await opts.pool.query<{ starting_situation_index: number | null }>(
        `SELECT starting_situation_index FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      const idx = camp.rows[0]?.starting_situation_index
      if (idx === null || idx === undefined) {
        return reply.code(409).send({ code: 'starting_situation_not_chosen' })
      }

      const client = await opts.pool.connect()
      try {
        await client.query('BEGIN')
        const flipped = await repo.characterConcepts.flipAllSubmittedToProcessing(
          client,
          req.params.campaignId,
        )
        if (flipped.length === 0) {
          await client.query('ROLLBACK')
          // return-await: finally { client.release() } runs after this
          // return, so the Promise must be awaited inside the try.
          return await reply.code(409).send({ code: 'no_submitters' })
        }
        const enqueued: { userId: string; jobId: string }[] = []
        for (const f of flipped) {
          const jobId = `cc-${req.params.campaignId}-${f.userId}`
          await queue.add(
            'character-creation',
            { campaignId: req.params.campaignId, userId: f.userId },
            { jobId },
          )
          enqueued.push({ userId: f.userId, jobId })
        }
        await client.query('COMMIT')
        return await reply.code(200).send({ enqueued })
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } /* c8 ignore start — v8 marks the `} finally {` branch boundary
         * uncovered even though both the COMMIT-success path and the
         * ROLLBACK-then-throw path are exercised by tests. The
         * client.release() inside is reached on every path; this is a
         * v8-instrumentation artifact, not a real coverage gap. */ finally {
        client.release()
      } /* c8 ignore stop */
    },
  )

  // --------------------------------------------------------------------
  // T14: POST /archive
  //
  // Single conditional UPDATE — RETURNING tells us whether the row was
  // in an archive-eligible status. No pipelineRoute marker: archive is
  // a campaign-level state flip, not a stage in the prep pipeline.
  // --------------------------------------------------------------------
  app.post<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/archive',
    { preHandler: requireCampaignMember(repo, 'owner') },
    async (req, reply) => {
      const result = await opts.pool.query<{ status: string }>(
        `UPDATE campaigns SET status = 'archived'
         WHERE id = $1 AND status IN ('setup', 'active')
         RETURNING status`,
        [req.params.campaignId],
      )
      if (result.rows.length === 0) {
        return reply.code(409).send({ code: 'cannot_archive' })
      }
      return reply.code(200).send({ status: 'archived' })
    },
  )

  // --------------------------------------------------------------------
  // T15: POST /characters — any member submits/updates their concept.
  //
  // UPSERT semantics for re-submission: a row in 'submitted' or 'failed'
  // is rewritten in-place (same id). 'processing' and 'completed' are
  // locked (409 concept_locked). The world must be 'complete' and the
  // owner must have already chosen a starting situation.
  // --------------------------------------------------------------------
  app.post<{
    Params: { campaignId: string }
    Body: z.infer<typeof PostCharacterBodySchema>
  }>(
    '/api/campaigns/:campaignId/characters',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const parsed = PostCharacterBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ code: 'bad_body' })
      const body = parsed.data

      const dbUser = requireDbUser(req)
      const campaign = await opts.pool.query<{
        world_id: string
        starting_situation_index: number | null
      }>(
        `SELECT world_id, starting_situation_index FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      // requireCampaignMember already proved this campaign exists.
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const camp = campaign.rows[0] ?? { world_id: '', starting_situation_index: null }

      const world = await opts.pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [camp.world_id],
      )
      if (world.rows[0]?.status !== 'complete') {
        return reply.code(409).send({ code: 'world_not_complete' })
      }
      if (camp.starting_situation_index === null) {
        return reply.code(409).send({ code: 'starting_situation_not_chosen' })
      }

      const existing = await repo.characterConcepts.getByCampaignAndUser(
        req.params.campaignId,
        dbUser.id,
      )
      if (existing && (existing.status === 'processing' || existing.status === 'completed')) {
        return reply.code(409).send({ code: 'concept_locked' })
      }

      const row = await repo.characterConcepts.upsert({
        campaignId: req.params.campaignId,
        userId: dbUser.id,
        conceptText: body.conceptText,
        situationGroundingText: body.situationGroundingText,
        guidedChoices: {},
      })
      return reply.code(200).send({ conceptId: row.id, status: row.status })
    },
  )

  // --------------------------------------------------------------------
  // T16: GET /starting-situations — list the 3 entries + the owner's pick.
  //
  // 404 world_not_ready when the entries array is empty (stage
  // `starting_situation` hasn't run / hasn't populated this column).
  // chosenIndex is null until the owner POSTs T12.
  // --------------------------------------------------------------------
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/starting-situations',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const campaign = await opts.pool.query<{
        world_id: string
        starting_situation_index: number | null
      }>(
        `SELECT world_id, starting_situation_index FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      // requireCampaignMember already proved this campaign exists.
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const camp = campaign.rows[0] ?? { world_id: '', starting_situation_index: null }

      const world = await opts.pool.query<{
        starting_situation_entries: { index: number; locationEntityId: string; prose: string }[]
      }>(
        `SELECT starting_situation_entries FROM worlds WHERE id = $1`,
        [camp.world_id],
      )
      /* c8 ignore next — world FK invariant per campaigns.world_id NOT NULL */
      const entries = world.rows[0]?.starting_situation_entries ?? []
      if (entries.length === 0) return reply.code(404).send({ code: 'world_not_ready' })

      return reply.code(200).send({
        situations: entries,
        chosenIndex: camp.starting_situation_index,
      })
    },
  )

  // --------------------------------------------------------------------
  // T17: GET /characters — party roster.
  //
  // One row per campaign member, joined to character_concepts (status)
  // and campaign_characters (persisted PC id). LEFT JOINs because a
  // member may not have submitted a concept yet, and a submitted concept
  // may not yet have a persisted character. characterId is omitted from
  // the response object when null (rather than serialized as `null`) so
  // clients can use `'characterId' in member` as the post-creation flag.
  // --------------------------------------------------------------------
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/characters',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const result = await opts.pool.query<RosterRow>(
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
        [req.params.campaignId],
      )
      const members = result.rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        conceptStatus: r.concept_status ?? 'none',
        ...(r.character_id !== null ? { characterId: r.character_id } : {}),
      }))
      return reply.code(200).send({ members })
    },
  )

  // --------------------------------------------------------------------
  // MYT-54 T12: GET /character-creation-progress — per-PC status board.
  //
  // Visible to ALL campaign members (owner OR player) — the finalize UI
  // uses it to drive the "are you sure?" confirmation. Two queries:
  // (1) the member roster ordered by joined_at for a stable display,
  // (2) every character_concepts row for the campaign. Members with a
  // row land in `concepts[]` (status passed through verbatim, including
  // the post-MYT-54 'integrated' state); members without one land in
  // `missing[]`. `error` (JSONB) is included only when the row's status
  // is 'failed' — the JSONB is forwarded as-is so the client owns the
  // display shape.
  // --------------------------------------------------------------------
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/character-creation-progress',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const memberRes = await opts.pool.query<{ user_id: string; display_name: string }>(
        `SELECT cm.user_id, u.display_name
           FROM campaign_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.campaign_id = $1
          ORDER BY cm.joined_at`,
        [req.params.campaignId],
      )

      const conceptRes = await opts.pool.query<{
        user_id: string
        status: string
        submitted_at: Date
        error: unknown
      }>(
        `SELECT user_id, status, submitted_at, error
           FROM character_concepts
          WHERE campaign_id = $1`,
        [req.params.campaignId],
      )
      const byUserId = new Map(conceptRes.rows.map((r) => [r.user_id, r]))

      const concepts: {
        userId: string
        displayName: string
        status: string
        submittedAt: string
        error?: unknown
      }[] = []
      const missing: { userId: string; displayName: string }[] = []
      for (const m of memberRes.rows) {
        const c = byUserId.get(m.user_id)
        if (c) {
          concepts.push({
            userId: m.user_id,
            displayName: m.display_name,
            status: c.status,
            submittedAt: c.submitted_at.toISOString(),
            // `error` is only emitted when the row is in 'failed'.
            // Other terminal states (completed/integrated) never set it
            // and shouldn't surface it even if the column is non-null
            // due to historical writes.
            ...(c.status === 'failed' && c.error !== null && c.error !== undefined
              ? { error: c.error }
              : {}),
          })
        } else {
          missing.push({ userId: m.user_id, displayName: m.display_name })
        }
      }

      return reply.code(200).send({
        campaignId: req.params.campaignId,
        totalMembers: memberRes.rows.length,
        concepts,
        missing,
      })
    },
  )

  // --------------------------------------------------------------------
  // T18: GET /characters/:charId — full character read for one PC.
  //
  // The join check protects against fishing for a character_id by
  // probing every campaign the caller is a member of. The 4 sub-table
  // queries run in parallel; each projects the meaningful columns only
  // (dropping uuid ids so the response shape stays grep-friendly for
  // the dev tool's inspector).
  // --------------------------------------------------------------------
  app.get<{ Params: { campaignId: string; charId: string } }>(
    '/api/campaigns/:campaignId/characters/:charId',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const join = await opts.pool.query<{ character_id: string }>(
        `SELECT character_id FROM campaign_characters
         WHERE campaign_id = $1 AND character_id = $2`,
        [req.params.campaignId, req.params.charId],
      )
      if (join.rows.length === 0) {
        return reply.code(404).send({ code: 'character_not_in_campaign' })
      }

      const [c, skills, features, equipment, spells] = await Promise.all([
        opts.pool.query<CharacterDbRow>(`SELECT * FROM characters WHERE id = $1`, [
          req.params.charId,
        ]),
        opts.pool.query<{ skill_name: string; proficiency_level: string }>(
          `SELECT skill_name, proficiency_level FROM character_skills WHERE character_id = $1`,
          [req.params.charId],
        ),
        opts.pool.query<{ feature_name: string; feature_source: string; description: string }>(
          `SELECT feature_name, feature_source, description FROM character_features WHERE character_id = $1`,
          [req.params.charId],
        ),
        opts.pool.query<{ item_name: string; quantity: number; equipped: boolean }>(
          `SELECT item_name, quantity, equipped FROM character_equipment WHERE character_id = $1`,
          [req.params.charId],
        ),
        opts.pool.query<{ spell_name: string; spell_level: number; prepared: boolean }>(
          `SELECT spell_name, spell_level, prepared FROM character_spells WHERE character_id = $1`,
          [req.params.charId],
        ),
      ])
      return reply.code(200).send({
        character: c.rows[0],
        skills: skills.rows,
        features: features.rows,
        equipment: equipment.rows,
        spells: spells.rows,
      })
    },
  )

  // --------------------------------------------------------------------
  // T19a: GET /hierarchy — world entity hierarchy.
  //
  // Member-only. Returns the full parent-child list for the campaign's
  // world via entityHierarchy.listForWorld. No tier filtering in v1 —
  // the repo doesn't support it yet. Tier-aware filtering is a follow-up
  // bead (the dev tool currently relies on the snapshot view for tier
  // gating; this route is the bulk-hierarchy surface for the wiki
  // inspector + future graph UI).
  // --------------------------------------------------------------------
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/hierarchy',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const camp = await opts.pool.query<{ world_id: string }>(
        `SELECT world_id FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      // requireCampaignMember already proved this campaign exists.
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const worldId = camp.rows[0]?.world_id ?? ''
      const hierarchy = await entityHierarchy.listForWorld(opts.pool, worldId)
      return reply.code(200).send({ hierarchy })
    },
  )

  // --------------------------------------------------------------------
  // T19b: GET /random-tables — world's random tables + nested entries.
  //
  // Two queries: (1) tables, (2) entries scoped to those table ids via
  // ANY($1::uuid[]). The second query is skipped when the table list is
  // empty (avoids a pointless `WHERE table_id = ANY('{}')` round-trip).
  // The handler nests entries under each table; the client doesn't have
  // to do a join itself.
  // --------------------------------------------------------------------
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/random-tables',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const camp = await opts.pool.query<{ world_id: string }>(
        `SELECT world_id FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      // requireCampaignMember already proved this campaign exists.
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const worldId = camp.rows[0]?.world_id ?? ''

      const tables = await opts.pool.query<{ id: string; name: string; category: string }>(
        `SELECT id, name, category FROM random_tables WHERE world_id = $1 ORDER BY name`,
        [worldId],
      )
      const tableIds = tables.rows.map((r) => r.id)
      const entries =
        tableIds.length === 0
          ? {
              rows: [] as {
                table_id: string
                roll_min: number
                roll_max: number
                content: string
              }[],
            }
          : await opts.pool.query<{
              table_id: string
              roll_min: number
              roll_max: number
              content: string
            }>(
              `SELECT table_id, roll_min, roll_max, content
               FROM random_table_entries
               WHERE table_id = ANY($1::uuid[])
               ORDER BY table_id, roll_min`,
              [tableIds],
            )
      const entriesByTable = new Map<
        string,
        { rollMin: number; rollMax: number; content: string }[]
      >()
      for (const r of entries.rows) {
        const arr = entriesByTable.get(r.table_id) ?? []
        arr.push({ rollMin: r.roll_min, rollMax: r.roll_max, content: r.content })
        entriesByTable.set(r.table_id, arr)
      }
      return reply.code(200).send({
        tables: tables.rows.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          entries: entriesByTable.get(t.id) ?? [],
        })),
      })
    },
  )
}
