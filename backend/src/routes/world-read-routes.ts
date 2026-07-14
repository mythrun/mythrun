// backend/src/routes/world-read-routes.ts
//
// Deep world / PC read surfaces (split out of campaign-characters.ts):
// a full character sheet, the world entity hierarchy, and the world's
// random tables. All member-only, all carry `pipelineRoute: true`.
//
//   T18  GET /api/campaigns/:campaignId/characters/:charId  (member)
//   T19a GET /api/campaigns/:campaignId/hierarchy           (member)
//   T19b GET /api/campaigns/:campaignId/random-tables       (member)

import type { FastifyPluginAsync } from 'fastify'
import { createRepo } from '../repo/index.js'
import { requireCampaignMember } from '../auth/access-control.js'
import type { Opts } from './campaign-characters.js'

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only synchronous app.get registrations).
// eslint-disable-next-line @typescript-eslint/require-await
export const worldReadRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

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
      // MYT-90: `concept` carries the character-concept narrative prose the
      // reveal's prose panel renders. Omitted (not serialized as null) when the
      // character has no concept row, mirroring the roster's characterId omit.
      return reply.code(200).send({
        character: full.character,
        skills: full.skills,
        features: full.features,
        equipment: full.equipment,
        spells: full.spells,
        ...(full.concept !== undefined ? { concept: full.concept } : {}),
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
}
