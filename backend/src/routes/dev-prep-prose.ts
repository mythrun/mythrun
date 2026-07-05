// backend/src/routes/dev-prep-prose.ts
//
// MYT-62 Task 5. Dev-only SSE route
// GET /api/dev/campaigns/:campaignId/prep-prose.
//
// Streams `prep-delta` prose events off the SEPARATE `prep:campaign:{id}`
// Redis channel — the channel that carries sd_playbook prose (which may
// contain plot secrets). This route is the STRUCTURAL half of enforced
// ignorance: it is registered ONLY inside the `authMode === 'bypass'` block
// in app.ts, so a production boot literally never serves a prose route.
// There is no prod path that exposes sd_playbook prose; the control is the
// absence of the route, not a runtime filter.
//
// Multi-layer gating (defense in depth — mirrors dev-credits.ts):
//   1. The plugin itself registers no route when AUTH_MODE !== 'bypass' (the
//      process-env gate below).
//   2. app.ts's wiring also gates the register + the prose subscriber's
//      construction on config.env.authMode === 'bypass'.
//
// SSE wiring mirrors campaigns.ts's `status/stream` route MINUS the initial
// snapshot: prose is ephemeral + dev-only, there's no persisted snapshot to
// replay. There is also no requireCampaignMember preHandler and no
// `pipelineRoute: true` marker — this is not a player-facing pipeline-status
// surface, it's a dev-tool wire-log feed.
//
// The prose subscriber forwards whatever lands on the prep channel VERBATIM:
// it has no type-tripwire (that gate is pipeline-channel-only, in
// pipeline-subscriber.ts). The prep channel is dev-only by construction, so
// the tripwire would be redundant — and a tripwire here would risk dropping
// a legitimately secret-bearing prep-delta the dev tool wants to inspect.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Logger as PinoLogger } from 'pino'
import { openSseConnection } from '../sse/sse-connection.js'
import type { PipelineSubscriber } from '../sse/pipeline-subscriber.js'
import type { ConnectionCounter } from '../sse/connection-counter.js'

export interface DevPrepProseRoutesOpts {
  /** A PipelineSubscriber constructed with `{ channel: 'prep' }` — it
   *  PSUBSCRIBEs `${prefix}prep:campaign:*` and forwards messages verbatim
   *  (no tripwire). Constructed + decorated in app.ts's bypass block so its
   *  dedicated PSUBSCRIBE client can be closed at shutdown. */
  readonly subscriber: PipelineSubscriber
  /** Shared SSE connection counter (same instance the status/stream route
   *  uses) so the periodic-log connection count reflects prose streams too. */
  readonly counter: ConnectionCounter
  /** The single allowlisted CORS origin (config.env.frontendBaseUrl). Threaded
   *  to openSseConnection so the hijacked prose SSE response echoes the same
   *  CORS header @fastify/cors sets — the dev tool fetches this cross-origin
   *  (localhost:5173 → localhost:3030), same as the campaigns status stream. */
  readonly frontendBaseUrl: string
}

interface Params {
  readonly campaignId: string
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (the AUTH_MODE check + app.get call are synchronous).
// Matches the precedent in dev-credits.ts / campaigns.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const devPrepProseRoutes: FastifyPluginAsync<DevPrepProseRoutesOpts> = async (app, opts) => {
  // Plugin-level AUTH_MODE gate. Belt-and-suspenders with the app.ts wiring
  // gate — if a future caller forgets the outer guard, this inner guard
  // still keeps the route (and the secret-bearing prose feed) off production.
  if (process.env.AUTH_MODE !== 'bypass') {
    return
  }

  app.get<{ Params: Params }>(
    '/api/dev/campaigns/:campaignId/prep-prose',
    {
      config: {
        // Per-IP cap. The dev tool runs locally (one IP); 30/min is well
        // above the wire-log drawer's open cadence and bounds a runaway
        // reconnect loop.
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => req.ip,
        },
      },
    },
    async (request, reply) => {
      const campaignId = request.params.campaignId
      opts.counter.increment()

      // onClose composes detach-then-decrement (same ordering as
      // status/stream): the subscriber detaches the sink before the counter
      // decrements, so the periodic log never counts a detached sink.
      let detach: (() => void) | null = null
      const sink = openSseConnection({
        request,
        reply,
        logger: request.log as PinoLogger,
        allowedOrigin: opts.frontendBaseUrl,
        onClose: () => {
          if (detach) detach()
          opts.counter.decrement()
        },
      })
      detach = opts.subscriber.attach(campaignId, sink)

      // No initial snapshot frame — prose is ephemeral; clients receive only
      // prep-delta events published after they attach.
      return reply
    },
  )
}
