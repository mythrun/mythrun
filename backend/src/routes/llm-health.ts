// backend/src/routes/llm-health.ts
//
// GET /api/llm-health (llm-outage-resilience §4.1) — the sitewide outage
// readout behind the frame's NoticeStrip. Public (`config.auth: 'public'`,
// mirroring /health/ready), one Redis read per request through the tracker,
// a plain polling GET with no caching. The payload is EXACTLY
// `{state: 'ok'|'degraded', since: number|null}` — the frontend zod schema
// (client-core/src/api/llm-health.ts) pins that shape; any drift becomes a
// ContractValidationError the positive-assertion-only strip hook reads as
// "ok", silently disarming the notice.

import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app-deps.js'

export function registerLlmHealthRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/llm-health', { config: { auth: 'public' } }, async (_req, reply) => {
    const tracker = deps.llmHealthTracker
    if (tracker === undefined) {
      // Boot-gate-disabled fallback / harnesses without a tracker: fail loud
      // with a typed 503 (the characterCreationQueue 'queue_not_ready'
      // posture). The frontend hook degrades a failed poll to "ok".
      return reply.code(503).send({ error: 'llm_health_unavailable' })
    }
    const state = await tracker.read()
    return reply.code(200).send(state)
  })
}
