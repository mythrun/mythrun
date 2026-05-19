// backend/src/routes/campaign-characters.ts
//
// MYT-53: per-player character-creation routes. This file will hold the
// 9 new HTTP routes (T12-T19) added by MYT-53. This commit lands the
// three owner-only state-mutating routes (T12-T14):
//
//   POST /api/campaigns/:campaignId/starting-situation
//   POST /api/campaigns/:campaignId/start-character-creation
//   POST /api/campaigns/:campaignId/archive
//
// All three share the same plugin Opts shape and the
// `requireCampaignMember(repo, 'owner')` auth middleware. T22 will
// register the plugin in `app.ts` and add the routes that carry
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
import { requireCampaignMember } from '../auth/access-control.js'

export interface CharacterCreationQueueLike {
  add(
    name: string,
    data: { campaignId: string; userId: string },
    opts?: { jobId?: string },
  ): Promise<unknown>
}

export interface Opts {
  readonly pool: Pool
  readonly characterCreationQueue?: CharacterCreationQueueLike
}

// T12 body. Zod's `safeParse` is the parse boundary; failure → 400 'bad_body'.
const StartingSituationBodySchema = z.object({
  index: z.number().int().min(0).max(2),
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

      const campaign = await opts.pool.query<{ world_id: string }>(
        `SELECT world_id FROM campaigns WHERE id = $1`,
        [req.params.campaignId],
      )
      const worldId = campaign.rows[0]?.world_id
      if (!worldId) return reply.code(404).send({ code: 'campaign_not_found' })

      const world = await opts.pool.query<{ status: string }>(
        `SELECT status FROM worlds WHERE id = $1`,
        [worldId],
      )
      if (world.rows[0]?.status !== 'complete') {
        return reply.code(409).send({ code: 'world_not_complete' })
      }

      const locked = await opts.pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM character_concepts
         WHERE campaign_id = $1 AND status IN ('processing', 'completed')`,
        [req.params.campaignId],
      )
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
      } finally {
        client.release()
      }
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
}
