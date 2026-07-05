import type { FastifyInstance } from 'fastify'

/**
 * Closed allowlist of routes that may register with config.auth === 'public'.
 *
 * The boot-time onRoute hook (registerPublicRouteAllowlistHook) rejects any
 * registration of a public route NOT in this set. Adding a new public route
 * requires:
 *   1. Adding the literal `${METHOD} ${URL}` string here.
 *   2. Security review on the PR.
 *
 * Per spec §3 lines 86–109.
 */
export const PUBLIC_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'GET /health',
  'GET /health/ready',
  'GET /api/invites/:inviteCode/preview',
  'GET /api/billing/skus',
  'POST /webhooks/stripe',
  // MYT-65: the WebSocket session-transport upgrade. It opts out of the JWT
  // chain because a browser-native WebSocket cannot send an Authorization
  // header — the auth boundary is instead the single-use ws-ticket, validated
  // by wsSessionAuth (the route's preHandler) BEFORE the upgrade completes. So
  // `auth: 'public'` here means "no JWT", NOT "unauthenticated": the preHandler
  // consumes + binds the ticket to the path's sessionId and re-checks campaign
  // membership against the loaded session row. See routes/ws-session.ts.
  'GET /ws/session/:sessionId',
  // MYT-84: the BFF session endpoints. They are `public` (no JWT) because the
  // caller has no access token yet on /session, and /refresh + /logout
  // authenticate via the httpOnly refresh cookie (validated server-side by the
  // Cognito grant), NOT a Bearer. Login-CSRF on /session is bounded by
  // application/json-only (415 otherwise) + no form-body parser + CORS preflight.
  // SECURITY REVIEW REQUIRED on any change to these three entries.
  'POST /api/auth/session',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  // DEV/STAGING-ONLY internal tooling: the API-cost ticker endpoint. It is
  // `public` because it is a non-sensitive cumulative process counter (approx
  // Anthropic spend in USD, reset every restart) that the floating DevCostTicker
  // widget polls on EVERY page — including pre-login and the dev bypass identity
  // (no onboarded users row), which the JWT + requireOnboarded chain would
  // 401/403. It is NEVER registered under mythrunEnv==='production' (app.ts gate
  // + the plugin self-gate), so this allowlist entry is inert in prod. See
  // routes/dev-api-cost.ts.
  'GET /api/dev/api-cost',
])

/**
 * Registers an onRoute hook that throws on any route registered with
 * config.auth === 'public' that is NOT in the allowlist.
 *
 * MUST be called on the root `app` BEFORE any `app.register(...)` call —
 * Fastify's onRoute hook is inherited downward only into plugins
 * registered AFTER the hook is added on the same scope. The hook fires
 * synchronously during plugin registration; any thrown error propagates
 * via `await app.ready()`.
 *
 * Per spec §3 lines 99–109.
 */
export function registerPublicRouteAllowlistHook(app: FastifyInstance): void {
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.config?.auth !== 'public') return
    /* c8 ignore start — defense-in-depth: Fastify allows `method` as a
     * string or string[], but no in-tree public route registers with
     * array methods. */
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
    /* c8 ignore stop */
    for (const m of methods) {
      // Fastify auto-generates a HEAD route for every GET registration.
      // The auto-generated HEAD fires onRoute with a non-null onSend array;
      // skip it — HEAD semantics are identical to GET and need no separate
      // allowlist entry.
      if (m === 'HEAD' && routeOptions.onSend != null) continue
      const key = `${m} ${routeOptions.url}`
      if (!PUBLIC_ROUTE_ALLOWLIST.has(key)) {
        throw new Error(`auth: public used on non-allowlisted route: ${key}`)
      }
    }
  })
}
