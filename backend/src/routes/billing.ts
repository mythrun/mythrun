// backend/src/routes/billing.ts
//
// MYT-42 billing routes plugin. Routes are added task by task (Tasks 25–31).
// Current routes:
//   - GET /api/billing/skus   (Task 25) — public pricing catalogue
//
// Subsequent tasks add: /balance, /subscription, /history, /checkout,
// /portal, /upgrade-tier.

import type { FastifyPluginAsync } from 'fastify'
import { getSkuCache } from '../billing/sku-cache.js'

export const billingRoutes: FastifyPluginAsync = async (scope) => {
  scope.get('/api/billing/skus', {
    config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (_request, reply) => {
    const cache = getSkuCache()
    if (cache === null) {
      // Defensive only — the boot probe gates app.ready() so any request
      // reaching this route should see a populated cache.
      return reply.code(503).send({ code: 'sku_cache_unavailable' })
    }
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .send(cache.publicListing)
  })

  // Subsequent tasks 26-31 add: /balance, /subscription, /history,
  // /checkout, /portal, /upgrade-tier
}
