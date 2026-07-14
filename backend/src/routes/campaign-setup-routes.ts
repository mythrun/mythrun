// backend/src/routes/campaign-setup-routes.ts
//
// Pre-character-creation setup surface (split out of campaign-characters.ts).
// The owner picks a starting situation + the party's starting level; any
// member reads back the situation list. All three routes carry
// `pipelineRoute: true`.
//
//   T12 POST /api/campaigns/:campaignId/starting-situation   (owner)
//   A3  POST /api/campaigns/:campaignId/starting-level       (owner)
//   T16 GET  /api/campaigns/:campaignId/starting-situations  (member)
//
// The two POSTs share the same guard chain: owner-only (preHandler),
// world must be 'complete', and locked once any concept is
// processing/completed.

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { requireCampaignMember } from '../auth/access-control.js'
import type { Opts } from './campaign-characters.js'

// T12 body. Zod's `safeParse` is the parse boundary; failure → 400 'bad_body'.
const StartingSituationBodySchema = z.object({
  index: z.number().int().min(0).max(2),
})

// A3 body (POST /starting-level). `level` is the party-wide starting level
// 1..5 — bounds mirror the campaigns.starting_level DB CHECK (migration 033)
// so an out-of-range value fails at the route boundary (400 bad_body) rather
// than as a 500 from Postgres rejecting the row.
const StartingLevelBodySchema = z.object({
  level: z.number().int().min(1).max(5),
})

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only synchronous app.post/app.get registrations).
// eslint-disable-next-line @typescript-eslint/require-await
export const campaignSetupRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
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

  // --------------------------------------------------------------------
  // A3: POST /starting-level — owner sets the party's starting level (1–5).
  //
  // Sits between the situation pick and character creation. Same guard chain
  // as T12 POST /starting-situation: owner-only (preHandler), world must be
  // 'complete', and locked once any concept is processing/completed. On
  // success the column is written and the route replies 204 (no body — the
  // persisted campaigns.starting_level column is the whole payload).
  // --------------------------------------------------------------------
  app.post<{
    Params: { campaignId: string }
    Body: z.infer<typeof StartingLevelBodySchema>
  }>(
    '/api/campaigns/:campaignId/starting-level',
    {
      preHandler: requireCampaignMember(repo, 'owner'),
      config: { pipelineRoute: true },
    },
    async (req, reply) => {
      const parsed = StartingLevelBodySchema.safeParse(req.body)
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
        return reply.code(409).send({ code: 'level_locked' })
      }

      await repo.campaigns.setStartingLevel(req.params.campaignId, parsed.data.level)
      return reply.code(204).send()
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
      const camp = campRow ?? { world_id: '', starting_situation_index: null, starting_level: null }

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
        startingLevel: camp.starting_level,
      })
    },
  )
}
