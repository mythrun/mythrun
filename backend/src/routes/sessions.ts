// backend/src/routes/sessions.ts
//
// Session-scoped routes. Currently exposes only POST /api/sessions/:id/ws-ticket
// — the HTTP half of the WebSocket ticket exchange. The actual WebSocket
// upgrade handler lives in the Session Runtime milestone and consumes
// tickets via consumeWsTicket.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §6

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import { createRepo } from '../repo/index.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { requireCampaignMember } from '../auth/access-control.js'
import { mintWsTicket } from '../auth/ws-ticket.js'

interface Opts {
  readonly pool: Pool
  readonly redisRealtime: Redis
  /** Includes trailing colon, e.g. "production:use1:ws:ticket:". Pinned
   *  per environment+region per docs/specs/2026-04-10-infrastructure-devops.md
   *  because staging+prod share one ElastiCache cluster. */
  readonly redisKeyPrefix: string
}

export const sessionsRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  app.post<{ Params: { id: string } }>(
    '/api/sessions/:id/ws-ticket',
    {
      config: {
        // Per-USER (not per-IP) cap — CG-NAT pools would otherwise share
        // the cap. The global @fastify/rate-limit at app.ts is
        // `global: false`, so without this opt-in the route ships
        // uncapped. MYT-45 swaps the in-memory store for Redis-backed.
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => requireDbUser(req).id,
        },
      },
      preHandler: [
        // Step 1: resolve :id (sessionId) → its parent campaignId.
        async (request, reply) => {
          const session = await repo.sessions.getById(request.params.id)
          if (!session) {
            return reply.code(404).send({ code: 'session_not_found' })
          }
          // Set the typed augmentation field rather than mutating
          // request.params — keeps the route's typed Params shape
          // honest for type-introspection tools / future OpenAPI gen.
          request.resolvedCampaignId = session.campaignId
        },
        // Step 2: verify membership.
        requireCampaignMember(repo),
      ],
    },
    async (request) => {
      const sessionId = request.params.id
      const dbUser = requireDbUser(request)
      // resolvedCampaignId is set by the upstream preHandler; non-null
      // assertion is safe — if step 1 returned 404 we wouldn't reach here.
      const campaignId = request.resolvedCampaignId!
      const { ticket, expiresAt } = await mintWsTicket(
        { redis: opts.redisRealtime, keyPrefix: opts.redisKeyPrefix },
        { userId: dbUser.id, sessionId, campaignId },
      )
      return { ticket, expiresAt }
    },
  )
}
