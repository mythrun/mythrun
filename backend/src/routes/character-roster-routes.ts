// backend/src/routes/character-roster-routes.ts
//
// Party-facing status reads (split out of campaign-characters.ts): the
// roster and the per-PC creation-progress board. Both are member-visible
// (owner OR player) and carry `pipelineRoute: true`.
//
//   T17 GET /api/campaigns/:campaignId/characters                    (member)
//   MYT-54 T12 GET /api/campaigns/:campaignId/character-creation-progress (member)

import type { FastifyPluginAsync } from 'fastify'
import { createRepo } from '../repo/index.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { isResumingStamp } from '../sse/derive-phase.js'
import type { ResumeStamp } from '../repo/resume-stamps.js'
import type { Opts } from './campaign-characters.js'

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only synchronous app.get registrations).
// eslint-disable-next-line @typescript-eslint/require-await
export const characterRosterRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

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
  //
  // MYT-90 D8: each concept also carries `confirmedAt` (the "This is me"
  // timestamp, null until confirmed) and `characterId` (the generated PC id,
  // null until the sheet exists). The FE character-creation routing table keys
  // the reveal→party-staging split on `confirmedAt` (reload-stable) and hands
  // `characterId` to the reveal so it can fetch the sheet. Both are
  // response-body-only additions — no pipelineRoute contract ripple.
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

      // llm-outage-resilience §3.4 (Task 9): the armed/overdue stamp arms.
      // Only a 'processing' concept can be parked (the processor never flips
      // the row on a park), so the stamp read is bounded to those members.
      // Stamp contract: pipeline 'character_creation', entity_id = concept id.
      const stampByConceptId = new Map<string, ResumeStamp>()
      for (const r of conceptRows) {
        if (r.status !== 'processing') continue
        const stamp = await repo.resumeStamps.get('character_creation', r.id)
        if (stamp !== null) stampByConceptId.set(r.id, stamp)
      }
      const now = new Date()

      const concepts: {
        userId: string
        displayName: string
        status: string
        submittedAt: string
        confirmedAt: string | null
        characterId: string | null
        error?: unknown
        lastErrorClass?: 'connectivity' | 'rate-limit'
        resumeAttempt?: number
      }[] = []
      const missing: { userId: string; displayName: string }[] = []
      for (const m of memberRows) {
        const c = byUserId.get(m.user_id)
        if (c) {
          const stamp = stampByConceptId.get(c.id) ?? null
          // While the stamp is resuming (§3.3: unexhausted, not overdue) the
          // concept stays 'processing' — generating-never-failed-while-armed;
          // an overdue or exhausted stamp derives 'failed' (the retryable
          // surface) as a PURE read; the row itself is untouched.
          const status =
            stamp !== null && !isResumingStamp(stamp, now) ? 'failed' : c.status
          concepts.push({
            userId: m.user_id,
            displayName: m.display_name,
            status,
            submittedAt: c.submitted_at.toISOString(),
            // MYT-90 D8: null until the player confirms ("This is me") /
            // until the sheet stage persists the character row.
            confirmedAt: c.confirmed_at === null ? null : c.confirmed_at.toISOString(),
            characterId: c.character_id,
            // `error` is only emitted when the row is in 'failed'.
            // Other terminal states (completed/integrated) never set it
            // and shouldn't surface it even if the column is non-null
            // due to historical writes.
            ...(c.status === 'failed' && c.error !== null && c.error !== undefined
              ? { error: c.error }
              : {}),
            // Additive park fields — the parked hold copy AND the retryable
            // view both key off the class (spec §3.4).
            ...(stamp !== null
              ? { lastErrorClass: stamp.lastErrorClass, resumeAttempt: stamp.resumeAttempt }
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
}
