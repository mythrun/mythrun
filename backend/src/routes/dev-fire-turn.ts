// backend/src/routes/dev-fire-turn.ts
//
// MYT-66 Task 10. Dev-only POST /api/dev/campaigns/:campaignId/fire-turn.
//
// The minimal test/dev trigger for a DM turn: a curl-able poke that enqueues
// ONE session-turn job onto the same `session-turn` BullMQ queue the real
// trigger surface (MYT-67) will use, so the enqueue → worker → broadcast
// round-trip can be smoked end-to-end without the (not-yet-built) player chat
// trigger path. Identity is a fixed dev poke — exact character resolution is
// MYT-67's concern; here we just need SOMETHING to enqueue.
//
// Multi-layer gating (defense in depth — mirrors dev-credits.ts):
//   1. The plugin itself registers no route when AUTH_MODE !== 'bypass' (the
//      process-env gate below).
//   2. app.ts's wiring also gates the register on config.env.authMode ===
//      'bypass'. A production boot never reaches this handler.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { enqueueTurn, type TurnQueueLike } from '../session/turn-queue.js'
import type { TriggerMessage } from '../session/tiers/types.js'

export interface DevFireTurnRoutesOpts {
  /** The session-turn producer (add-only). Same instance app.ts forwards to the
   *  rest of the request surface; the raw Queue is closed at shutdown. */
  readonly queue: TurnQueueLike
  readonly pool: Pool
}

interface Params {
  readonly campaignId: string
}

// Strict body: a single non-empty trigger string. The dev poke carries no
// identity payload — the route fixes a `dev` user / `Dev` character below.
const FireTurnBodySchema = z
  .object({
    triggerText: z.string().min(1),
  })
  .strict()

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (the AUTH_MODE check + app.post call are synchronous).
// Matches the precedent in dev-credits.ts / dev-prep-prose.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const devFireTurnRoutes: FastifyPluginAsync<DevFireTurnRoutesOpts> = async (app, opts) => {
  // Plugin-level AUTH_MODE gate. Belt-and-suspenders with the app.ts wiring
  // gate — if a future caller forgets the outer guard, this inner guard still
  // keeps the route off production.
  if (process.env.AUTH_MODE !== 'bypass') {
    return
  }

  const repo = createRepo(opts.pool)

  app.post<{ Params: Params }>(
    '/api/dev/campaigns/:campaignId/fire-turn',
    {
      config: {
        // Per-IP cap. The dev tool runs locally (one IP); 30/min is well above
        // a manual smoke cadence and bounds a runaway reconnect/poke loop.
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => req.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = FireTurnBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_body',
          issues: parsed.error.issues,
        })
      }
      const { triggerText } = parsed.data
      const { campaignId } = request.params

      // Resolve the live session for this campaign. No active session → there is
      // nothing for the worker to drive; 409 so a smoke caller fires /start first.
      const session = await repo.sessions.getActiveByCampaign(campaignId)
      if (session === null) {
        return reply.code(409).send({ code: 'no_active_session' })
      }

      // A minimal dev trigger. Exact identity resolution (the dev sub's
      // character) is not needed for the round-trip smoke — MYT-67 owns the
      // real player-chat trigger path that maps a member to their character.
      const trigger: TriggerMessage = { userId: 'dev', characterName: 'Dev', text: triggerText }

      // turnId (H2) is allocated here at enqueue and rides the payload, so it is
      // stable across a BullMQ redelivery. No custom jobId (H10): the session
      // lock is the per-session mutex, so turns must each land as a distinct job.
      const turnId = randomUUID()
      await enqueueTurn(opts.queue, {
        campaignId,
        sessionId: session.id,
        turnId,
        triggerMessages: [trigger],
      })

      return reply.code(202).send({ turnId })
    },
  )
}
