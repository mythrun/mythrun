// backend/src/routes/character-concept-routes.ts
//
// A member's own character-concept write lifecycle (split out of
// campaign-characters.ts): submit/resubmit, start-over, and confirm. All
// three routes are self-scoped (any accepted member acts on their OWN
// concept) and carry `pipelineRoute: true`.
//
//   T15 POST /api/campaigns/:campaignId/characters          (member)
//   A7  POST /api/campaigns/:campaignId/characters/reset     (member)
//   A7  POST /api/campaigns/:campaignId/characters/confirm   (member)

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createRepo, ROLLBACK } from '../repo/index.js'
import { uuidv7 } from '../repo/uuidv7.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'
import type { Opts } from './campaign-characters.js'

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

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only synchronous app.post registrations).
// eslint-disable-next-line @typescript-eslint/require-await, max-lines-per-function
export const characterConceptRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

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
      const camp = campRow ?? { world_id: '', starting_situation_index: null, starting_level: null }

      const worldStatus = await repo.worlds.getStatus(camp.world_id)
      if (worldStatus !== 'complete') {
        return reply.code(409).send({ code: 'world_not_complete' })
      }
      if (camp.starting_situation_index === null) {
        return reply.code(409).send({ code: 'starting_situation_not_chosen' })
      }
      // A3: the party's starting level is picked after the situation and before
      // any concept is submitted — gate character creation on it being chosen.
      if (camp.starting_level === null) {
        return reply.code(409).send({ code: 'starting_level_not_chosen' })
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
  // MYT-90 A7: POST /characters/reset — "Start over" on the reveal.
  //
  // Self-scoped: any member acts on their OWN concept (NOT owner-only). The
  // reveal offers "Start over", but a 'completed' concept is locked (POST
  // /characters 409s concept_locked). This flips the caller's own
  // completed/failed concept back to a resubmittable 'submitted' and clears
  // the generated sheet, so Start over → create re-runs the per-player
  // pipeline. resetConcept guards the flip transactionally (completed/failed —
  // OR a STALE 'processing' row whose creation job hung, myth-3u4a0 — campaign
  // not 'active'); a non-match → 409 not_resettable (can't unwind an integrated
  // character, an active game, or a FRESH 'processing' row an active worker owns).
  // The status flip + the sheet DELETE run in one repo.transaction so they
  // commit atomically.
  // --------------------------------------------------------------------
  app.post<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/characters/reset',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const dbUser = requireDbUser(req)
      const didReset = await repo.transaction((tx) =>
        tx.characterConcepts.resetConcept(req.params.campaignId, dbUser.id),
      )
      if (didReset !== true) return reply.code(409).send({ code: 'not_resettable' })
      return reply.code(204).send()
    },
  )

  // --------------------------------------------------------------------
  // MYT-90 A7: POST /characters/confirm — "This is me" on the reveal.
  //
  // Self-scoped. Persists confirmed_at on the caller's own 'completed' concept
  // so a reload doesn't bounce the player out of party staging. Idempotent (a
  // repeated click keeps the first confirmation timestamp → 204). 409
  // not_confirmable when the concept isn't 'completed' (nothing to confirm).
  // --------------------------------------------------------------------
  app.post<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId/characters/confirm',
    {
      preHandler: requireCampaignMember(repo),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const dbUser = requireDbUser(req)
      const confirmed = await repo.characterConcepts.confirmConcept(
        req.params.campaignId,
        dbUser.id,
      )
      if (!confirmed) return reply.code(409).send({ code: 'not_confirmable' })
      return reply.code(204).send()
    },
  )
}
