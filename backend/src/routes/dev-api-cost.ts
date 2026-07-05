// backend/src/routes/dev-api-cost.ts
//
// DEV/STAGING-ONLY GET /api/dev/api-cost.
//
// Serves the process-level cumulative approximate Anthropic API spend (USD)
// that llm/cost-middleware.ts accumulates. The floating DevCostTicker widget in
// the web app polls this every ~2s, captures the first value as a baseline, and
// shows the delta — so an operator can watch spend tick up as they drive
// cost-incurring actions.
//
// NEVER-PROD is the load-bearing property, enforced two ways:
//   1. app.ts registers this plugin ONLY when config.env.mythrunEnv !==
//      'production' — in a prod boot the route is LITERALLY ABSENT, so a request
//      404s via the app's notFoundHandler. The widget hides on that 404.
//   2. This plugin ALSO self-gates on opts.mythrunEnv (defense in depth): if a
//      future caller forgets the outer gate, the route still isn't registered
//      under production.
//
// Auth: `public`. This is a non-sensitive cumulative counter (a single float
// that resets every process restart and NEVER exists in production), and the
// widget must render on EVERY page — including pre-login screens and the dev
// bypass identity, which has no onboarded users row. Going through the JWT +
// requireOnboarded chain would 401/403 there and blank the widget. The
// PUBLIC_ROUTE_ALLOWLIST carries a matching entry (inert in prod, where the
// route is never registered).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { getTotalUsd } from '../billing/dev-cost-tracker.js'

export interface DevApiCostRoutesOpts {
  readonly mythrunEnv: 'production' | 'staging' | 'development'
}

// FastifyPluginAsync requires an async function shape; the body is synchronous
// (the gate check + app.get call), matching the precedent in dev-credits.ts /
// dev-fire-turn.ts.
// eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync shape; no top-level await (mirrors dev-credits.ts).
export const devApiCostRoutes: FastifyPluginAsync<DevApiCostRoutesOpts> = async (app, opts) => {
  // Never-prod self-gate (belt-and-suspenders with the app.ts registration gate).
  if (opts.mythrunEnv === 'production') return

  app.get(
    '/api/dev/api-cost',
    {
      config: {
        // See file header: a non-sensitive dev/staging-only counter, polled on
        // every page. Allowlisted in PUBLIC_ROUTE_ALLOWLIST.
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
