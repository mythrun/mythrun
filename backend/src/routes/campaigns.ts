// backend/src/routes/campaigns.ts
//
// Campaign-scoped HTTP routes. MYT-50 lands status + SSE stream only.
// Subsequent issues add create / details / member-mgmt / character-creation
// routes here.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface.md §3
//
// Two routes:
//   GET /api/campaigns/:campaignId/status         — JSON snapshot, 60/min
//   GET /api/campaigns/:campaignId/status/stream  — SSE stream, 10/min per user
//
// SSE attach-then-snapshot ordering matters: openSseConnection's onClose is
// composed so that subscriber.attach()'s detach() runs BEFORE the counter
// decrements. Snapshot is computed AFTER attach so any pipeline events
// published during the gap are queued on the sink rather than lost.
//
// `app.ts` does not register this plugin yet — T7 wires it in alongside
// boot-time construction of the PipelineSubscriber + ConnectionCounter.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Logger as PinoLogger } from 'pino'
import { createRepo } from '../repo/index.js'
import { createPipelineRunsRepo } from '../repo/pipeline-runs.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { derivePhase, type PhaseAndStages } from '../sse/derive-phase.js'
import { openSseConnection } from '../sse/sse-connection.js'
import type { PipelineSubscriber } from '../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../sse/connection-counter.js'

export interface Opts {
  readonly pool: Pool
  readonly subscriber: PipelineSubscriber
  readonly counter: ConnectionCounter
}

interface Params {
  readonly campaignId: string
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only synchronous app.get registrations), matching the
// precedent in routes/sessions.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const campaignsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const pipelineRunsRepo = createPipelineRunsRepo(opts.pool)

  async function loadSnapshot(campaignId: string): Promise<PhaseAndStages | null> {
    const campaign = await repo.campaigns.getById(campaignId)
    if (!campaign) return null
    const world = await repo.worlds.getById(campaign.worldId)
    if (!world) return null
    const runs = await pipelineRunsRepo.listLatestForCampaign(campaignId)
    return derivePhase({
      campaign: { id: campaign.id, status: campaign.status, world_id: campaign.worldId },
      world: { id: world.id, status: world.status },
      runs,
    })
  }

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/status',
    {
      config: {
        // Per-IP cap. Snapshot fetch is cheap (one indexed lookup +
        // bounded pipeline_runs scan); the 60/min ceiling exists to
        // protect against runaway client polling that would otherwise
        // hammer the DB.
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const snapshot = await loadSnapshot(request.params.campaignId)
      if (!snapshot) return reply.code(404).send({ code: 'campaign_not_found' })
      return reply.send(snapshot)
    },
  )

  app.get<{ Params: Params }>(
    '/api/campaigns/:campaignId/status/stream',
    {
      config: {
        // Per-USER (not per-IP) cap on stream opens. CG-NAT pools and
        // shared offices would otherwise burn one user's allotment on
        // another's behalf. Matches routes/sessions.ts ws-ticket pattern.
        // Falls back to req.ip if requireDbUser throws (defence-in-depth:
        // the requireOnboarded preHandler should have populated dbUser).
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
      },
      preHandler: requireCampaignMember(repo),
    },
    async (request, reply) => {
      const campaignId = request.params.campaignId
      opts.counter.increment()

      // Compose detach + counter.decrement into a single onClose so the
      // openSseConnection lifecycle owns teardown. `detach` is assigned
      // AFTER openSseConnection returns (the sink exists first), so the
      // onClose closure reads `detach` via the surrounding let-binding.
      // Pre-attach the close path can fire (e.g. raw 'close' from an
      // immediate disconnect) — `detach` is null then, so the null-check
      // short-circuits and only the counter decrement runs.
      let detach: (() => void) | null = null
      // Fastify v5's request.log is structurally a pino.Logger at
      // runtime (Fastify uses pino internally), but its declared
      // FastifyBaseLogger type omits a couple of pino-internal fields
      // like `msgPrefix`. openSseConnection's logger param is typed
      // strictly as pino.Logger so its internal call sites stay
      // typesafe. Cast through pino.Logger at the boundary — runtime
      // is sound; the type-system gap is purely declarational.
      const sink = openSseConnection({
        request,
        reply,
        logger: request.log as PinoLogger,
        onClose: () => {
          if (detach) detach()
          opts.counter.decrement()
        },
      })
      detach = opts.subscriber.attach(campaignId, sink)

      // Snapshot computed AFTER attach: events published in the gap are
      // queued on the sink, so the client sees them after the initial
      // snapshot frame rather than missing them.
      const snapshot = await loadSnapshot(campaignId)
      if (!snapshot) {
        sink.close('unknown')
        return reply
      }
      sink.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
      // sink lives on past return; reply.hijack() inside openSseConnection
      // means Fastify won't try to serialize a response body. Return reply
      // to satisfy the async handler signature.
      return reply
    },
  )
}
