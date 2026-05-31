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
import { createRepo, ROLLBACK } from '../repo/index.js'
import { uuidv7 } from '../repo/uuidv7.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'

// Per-player MYT-53 jobs carry `{ campaignId, userId }`; the campaign-
// scoped MYT-54 T11 'character-integration' job carries
// `{ campaignId, ownerUserId }`. Both names land on the same
// `campaign-setup` queue (see worker.ts router), so the single .add()
// surface here admits either payload via a discriminated union on `name`.
// Existing implementers (server.ts buildCharacterCreationQueue, the test
// spies) forward through to BullMQ's `Queue.add()`, which already accepts
// arbitrary job-data shapes — the narrowing here is purely the route
// plugin's compile-time contract.
export type CharacterCreationJobData =
  | { campaignId: string; userId: string }
  | { campaignId: string; ownerUserId: string }

export interface CharacterCreationQueueLike {
  add(
    name: 'character-creation' | 'character-integration',
    data: CharacterCreationJobData,
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

// MYT-54 T13 body. `pre_integration_notes` is fully optional: missing,
// explicit null, and empty string all mean "no notes" and collapse to
// NULL in the campaigns.pre_integration_notes column at write time. The
// upper bound matches the DB CHECK in migration 018 so a too-long blob
// fails at the route boundary (400 bad_body) rather than as a 500 from
// Postgres rejecting the row.
const FinalizeBodySchema = z.object({
  pre_integration_notes: z.string().min(0).max(4000).nullable().optional(),
})

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
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const worldId = (await repo.campaigns.getWorldId(req.params.campaignId)) ?? ''

      const worldStatus = await repo.worlds.getStatus(worldId)
      if (worldStatus !== 'complete') {
        return reply.code(409).send({ code: 'world_not_complete' })
      }

      if ((await repo.characterConcepts.countLocked(req.params.campaignId)) > 0) {
        return reply.code(409).send({ code: 'situation_locked' })
      }

      await repo.campaigns.setStartingSituationIndex(req.params.campaignId, parsed.data.index)
      return reply.code(200).send({ index: parsed.data.index })
    },
  )

  // myth-nmg9: POST /start-character-creation is RETIRED. Per-player
  // pipeline now auto-triggers from inside POST /characters' own
  // transaction (the upsert→flip→enqueue sequence below). Removing
  // the owner-batch step matches the user-described flow: as soon as
  // a player submits a concept (with starting_situation chosen), their
  // pipeline starts without waiting on an explicit owner action.

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
      const archived = await repo.campaigns.archive(req.params.campaignId)
      if (!archived) {
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
      // requireCampaignMember already proved this campaign exists.
      const campRow = await repo.campaigns.getWorldAndSituationIndex(req.params.campaignId)
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const camp = campRow ?? { world_id: '', starting_situation_index: null }

      const worldStatus = await repo.worlds.getStatus(camp.world_id)
      if (worldStatus !== 'complete') {
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

      // myth-nmg9 / myth-gp2c Cluster C: submit + flip + seed the recovery row
      // atomically in one `repo.transaction` (the upsert writes
      // status='submitted'; the flip immediately advances it to 'processing';
      // the seed row writes a 'pending' character_concept pipeline_runs trace),
      // THEN enqueue AFTER the tx commits. Moving the enqueue out of the
      // transaction is the MYT-56 discipline: a queue.add inside BEGIN/COMMIT is
      // the "enqueued but commit failed" zombie-job shape this refactor exists
      // to eliminate. Seeding the recovery row mirrors world-gen's
      // executeCreateTransaction (insertSeedRow): a missed enqueue (Redis blip
      // between COMMIT and queue.add) leaves a resumable 'pending' trace instead
      // of a concept stranded at 'processing' with no pipeline_runs row. The
      // worker's campaign-user claim re-arms that pending row to 'running' via
      // ON CONFLICT. The tx returns the conceptId; the enqueue runs off that
      // value after commit.
      const queue = opts.characterCreationQueue
      if (!queue) {
        return reply.code(503).send({ code: 'queue_not_ready' })
      }

      const txResult = await repo.transaction(async (tx) => {
        const row = await tx.characterConcepts.upsert({
          campaignId: req.params.campaignId,
          userId: dbUser.id,
          conceptText: body.conceptText,
          situationGroundingText: body.situationGroundingText,
          guidedChoices: {},
        })
        const flipped = await tx.characterConcepts.flipSubmittedToProcessing(
          req.params.campaignId,
          dbUser.id,
        )
        /* c8 ignore start — the upsert immediately above wrote
         * status='submitted', and the row is uniquely keyed on
         * (campaign_id, user_id) so the flip MUST find it. The ROLLBACK
         * sentinel branch is defense-in-depth against a concurrent admin
         * DELETE between the upsert and the flip. */
        if (flipped === null) {
          return ROLLBACK
        }
        /* c8 ignore stop */
        await tx.pipelineRuns.insertCharacterConceptSeedRow({
          id: uuidv7(),
          campaignId: req.params.campaignId,
          userId: dbUser.id,
        })
        return { conceptId: row.id }
      })

      /* c8 ignore start — see the in-tx ROLLBACK note above; the sentinel
       * surfaces here only on the concurrent-delete race. */
      if (txResult === ROLLBACK) {
        return reply.code(409).send({ code: 'concept_lost_race' })
      }
      /* c8 ignore stop */

      // Enqueue AFTER the tx committed (MYT-56), off the returned conceptId.
      const jobId = `cc-${req.params.campaignId}-${dbUser.id}`
      await queue.add(
        'character-creation',
        { campaignId: req.params.campaignId, userId: dbUser.id },
        { jobId },
      )
      return reply.code(200).send({
        conceptId: txResult.conceptId,
        status: 'processing',
        jobId,
      })
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
      // requireCampaignMember already proved this campaign exists.
      const campRow = await repo.campaigns.getWorldAndSituationIndex(req.params.campaignId)
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const camp = campRow ?? { world_id: '', starting_situation_index: null }

      // myth-k1ee added `title` + `locationName` to each entry; older
      // pre-myth-k1ee worlds may still have entries without these fields.
      // The route passes the JSONB through verbatim so both shapes work.
      const entries = await repo.worlds.getStartingSituationEntries<{
        index: number
        locationEntityId: string
        prose: string
        title?: string
        locationName?: string
      }>(camp.world_id)
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
      const roster = await repo.campaigns.getPartyRoster(req.params.campaignId)
      const members = roster.map((r) => ({
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
      const memberRows = await repo.campaigns.listMembersBasic(req.params.campaignId)

      const conceptRows = await repo.characterConcepts.listForCampaign(req.params.campaignId)
      const byUserId = new Map(conceptRows.map((r) => [r.user_id, r]))

      const concepts: {
        userId: string
        displayName: string
        status: string
        submittedAt: string
        error?: unknown
      }[] = []
      const missing: { userId: string; displayName: string }[] = []
      for (const m of memberRows) {
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
        totalMembers: memberRows.length,
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
      const inCampaign = await repo.characters.isInCampaign(
        req.params.campaignId,
        req.params.charId,
      )
      if (!inCampaign) {
        return reply.code(404).send({ code: 'character_not_in_campaign' })
      }

      const full = await repo.characters.getFullCharacter(req.params.charId)
      return reply.code(200).send({
        character: full.character,
        skills: full.skills,
        features: full.features,
        equipment: full.equipment,
        spells: full.spells,
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
      // requireCampaignMember already proved this campaign exists.
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const worldId = (await repo.campaigns.getWorldId(req.params.campaignId)) ?? ''
      const hierarchy = await repo.entityHierarchy.listForWorld(worldId)
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
      // requireCampaignMember already proved this campaign exists.
      /* c8 ignore next — invariant per requireCampaignMember preHandler */
      const worldId = (await repo.campaigns.getWorldId(req.params.campaignId)) ?? ''

      const tables = await repo.randomTables.listByWorld(worldId)
      const tableIds = tables.map((r) => r.id)
      const entries = await repo.randomTables.listEntriesByTableIds(tableIds)
      const entriesByTable = new Map<
        string,
        { rollMin: number; rollMax: number; content: string }[]
      >()
      for (const r of entries) {
        const arr = entriesByTable.get(r.table_id) ?? []
        arr.push({ rollMin: r.roll_min, rollMax: r.roll_max, content: r.content })
        entriesByTable.set(r.table_id, arr)
      }
      return reply.code(200).send({
        tables: tables.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          entries: entriesByTable.get(t.id) ?? [],
        })),
      })
    },
  )

  // --------------------------------------------------------------------
  // MYT-54 T13: POST /finalize-character-creation
  //
  // Owner-only fan-in trigger. The column flip
  // (`campaigns.pre_integration_notes`) + the completed-concept gate run
  // atomically in one `repo.transaction`; the singleton `ci-${campaignId}`
  // queue enqueue runs AFTER the tx commits (MYT-56 — a queue.add inside
  // BEGIN/COMMIT is the zombie-job shape this refactor eliminates). A 202
  // therefore implies the notes are committed AND the job was enqueued; the
  // job picked up by the MYT-54 T11 processor calls the T10 handler. jobId is
  // deterministic — BullMQ dedups on duplicate IDs, so a frantic double-click
  // from the owner is safe at the queue layer.
  //
  // The two 409 paths (`not_in_setup`, `no_completed_concepts`) reject from
  // INSIDE the callback by throwing FinalizeRejected — that ROLLBACKs (so the
  // notes flip is never persisted on the no-completed path) and the catch
  // below maps the carried code to the 409. The queue is never touched on
  // either 409 path (it only runs after a clean commit).
  //
  // Body normalization: missing OR empty-string `pre_integration_notes`
  // collapse to NULL in the column — the integration handler treats
  // "no notes" as a single state regardless of which client surface
  // emitted it.
  // --------------------------------------------------------------------
  app.post<{
    Params: { campaignId: string }
    Body: z.infer<typeof FinalizeBodySchema>
  }>(
    '/api/campaigns/:campaignId/finalize-character-creation',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const parsed = FinalizeBodySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'bad_body' })
      }
      const noteRaw = parsed.data.pre_integration_notes
      // Empty string and null/undefined all collapse to NULL — the column
      // is nullable and the handler treats "no notes" as a single state.
      const notes = noteRaw !== null && noteRaw !== undefined && noteRaw.length > 0 ? noteRaw : null

      const queue = opts.characterCreationQueue
      if (!queue) {
        return reply.code(503).send({ code: 'queue_not_ready' })
      }
      const dbUser = requireDbUser(req)

      try {
        await repo.transaction(async (tx) => {
          // Transactional flip: false back means status was already
          // 'active' or 'archived' (i.e. finalize already ran or owner
          // archived the campaign). Throw → ROLLBACK keeps the contract
          // tight — the queue is never touched on the 409 path.
          const flipped = await tx.campaigns.setPreIntegrationNotesIfSetup(
            req.params.campaignId,
            notes,
          )
          if (!flipped) {
            throw new FinalizeRejected('not_in_setup')
          }

          // At least one 'completed' concept required — fan-in trigger.
          // Without this gate the integration job would run with an empty
          // party and produce zero characters. Throw → ROLLBACK undoes the
          // notes flip above (preserving the prior contract).
          const n = await tx.characterConcepts.countCompleted(req.params.campaignId)
          if (n === 0) {
            throw new FinalizeRejected('no_completed_concepts')
          }
        })
      } /* c8 ignore start — the catch's `instanceof` discriminates the two
         * 409 rejects (covered by tests) from a real non-FinalizeRejected DB
         * error inside the tx (the tx already rolled back + released), which
         * rethrows to the Fastify error handler → 500. That false branch +
         * rethrow is not deterministically reproducible from the route tests
         * once inputs are normalized; the whole catch is ignored so the v8
         * branch-boundary artifact on the closing brace is absorbed too. The
         * 409 outcomes are still asserted at the response level by the finalize
         * tests (not_in_setup / no_completed_concepts). */ catch (err) {
        if (err instanceof FinalizeRejected) {
          return reply.code(409).send({ code: err.code })
        }
        throw err
      }
      /* c8 ignore stop */

      // Enqueue AFTER the tx committed (MYT-56). Singleton jobId — BullMQ
      // dedups, so a re-POST while the job is queued/processing is a no-op at
      // the queue layer.
      const jobId = `ci-${req.params.campaignId}`
      await queue.add(
        'character-integration',
        { campaignId: req.params.campaignId, ownerUserId: dbUser.id },
        { jobId },
      )
      return reply.code(202).send({ campaignId: req.params.campaignId, jobId })
    },
  )
}

// Internal sentinel carrying the 409 code from inside the finalize tx callback.
// Throwing forces a ROLLBACK (undoing the notes flip on the no-completed path)
// + propagates; the route's catch maps `.code` to the 409 response. A typed
// throw is the cleanest way to distinguish the two reject reasons while still
// rolling back — the `repo.ROLLBACK` sentinel carries no reason.
class FinalizeRejected extends Error {
  constructor(readonly code: 'not_in_setup' | 'no_completed_concepts') {
    super(code)
    this.name = 'FinalizeRejected'
  }
}
