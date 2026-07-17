// backend/src/routes/dev-api-cost.ts
//
// DEV-ONLY (AUTH_MODE=bypass) GET /api/dev/api-cost.
//
// Serves the process-level cumulative approximate Anthropic API spend (USD)
// that llm/cost-middleware.ts accumulates. The floating DevCostTicker widget in
// the web app polls this every ~2s, captures the first value as a baseline, and
// shows the delta — so an operator can watch spend tick up as they drive
// cost-incurring actions.
//
// DEV-STACK-ONLY is the load-bearing property, enforced two ways (the same
// multi-layer gating as dev-credits.ts / dev-fire-turn.ts / dev-prep-prose.ts):
//   1. app.ts registers this plugin ONLY inside its authMode === 'bypass'
//      block — on a real-auth boot (staging AND production) the route is
//      LITERALLY ABSENT, so a request 404s via the app's notFoundHandler. The
//      widget hides on that 404.
//   2. This plugin ALSO self-gates on process.env.AUTH_MODE !== 'bypass'
//      (defense in depth): if a future caller forgets the outer gate, the
//      route still isn't registered on a real-auth boot.
//
// HISTORY (MYT-102): this route was originally gated on mythrunEnv !==
// 'production' — a deliberate "staging still wants the ticker" choice. That
// left it registered on staging (mythrunEnv='staging', authMode='real'); the
// unconditionally-mounted widget saw 200s there and polled indefinitely (1723
// polls observed in a staging audit). The ticker is dev-stack tooling, so the
// gate is now AUTH_MODE=bypass like every other /api/dev route, and the
// frontend widget is additionally gated out of non-dev builds.
//
// Auth: `public`. This is a non-sensitive cumulative counter (a single float
// that resets every process restart and NEVER exists outside the dev bypass
// stack), and the widget must render on EVERY page — including pre-login
// screens and the dev bypass identity, which has no onboarded users row. Going
// through the JWT + requireOnboarded chain would 401/403 there and blank the
// widget. The PUBLIC_ROUTE_ALLOWLIST carries a matching entry (inert on
// staging/production, where the route is never registered).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { getTotalUsd } from '../billing/dev-cost-tracker.js'

// FastifyPluginAsync requires an async function shape; the body is synchronous
// (the gate check + app.get call), matching the precedent in dev-credits.ts /
// dev-fire-turn.ts.
// eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync shape; no top-level await (mirrors dev-credits.ts).
export const devApiCostRoutes: FastifyPluginAsync = async (app) => {
  // Plugin-level AUTH_MODE gate. Belt-and-suspenders with the app.ts wiring
  // (which registers this only inside its bypass block). Reads process.env at
  // register time, mirroring dev-credits.ts / dev-fire-turn.ts.
  if (process.env.AUTH_MODE !== 'bypass') {
    return
  }

  app.get(
    '/api/dev/api-cost',
    {
      config: {
        // See file header: a non-sensitive dev-only counter, polled on every
        // page of the dev stack. Allowlisted in PUBLIC_ROUTE_ALLOWLIST.
        auth: 'public',
        // The widget polls ~every 2s (≈30/min); one operator per IP. 240/min is
        // generous headroom and still bounds a runaway poll loop.
        rateLimit: {
          max: 240,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => req.ip,
        },
      },
    },
    () => ({ totalUsd: getTotalUsd() }),
  )
}
