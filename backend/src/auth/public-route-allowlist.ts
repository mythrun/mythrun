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
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method]
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
