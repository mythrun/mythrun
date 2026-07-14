// backend/src/routes/campaign-lifecycle-routes.ts
//
// Owner-only campaign state transitions (split out of
// campaign-characters.ts): finalize (setup → integration) and archive.
// Finalize carries `pipelineRoute: true`; archive does not (it's a
// campaign-level state flip, not a stage in the prep pipeline).
//
//   MYT-54 T13 POST /api/campaigns/:campaignId/finalize-character-creation (owner)
//   T14        POST /api/campaigns/:campaignId/archive                     (owner)

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'
import type { Opts } from './campaign-characters.js'

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
// eslint-disable-next-line @typescript-eslint/require-await
export const campaignLifecycleRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

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
