// backend/src/auth/require-onboarded.ts
//
// Plugin that gates protected routes on a real users row existing for
// the caller's cognito_sub. Public + jwt-no-db routes opt out.
//
// jwt-no-db usage is bounded by JWT_NO_DB_ALLOWLIST: at boot, every
// route registered with config.auth === 'jwt-no-db' must be in the
// allowlist or app.ready() throws. New jwt-no-db routes need an
// allowlist edit AND a security review on the PR.

import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { createUsersRepo } from '../repo/users.js'

interface Opts {
  readonly pool: Pool
}

const JWT_NO_DB_ALLOWLIST = new Set<string>([
  'POST::/api/users/register',
  'GET::/api/users/check-username',
])

const REQUIRE_ONBOARDED_LOOKUP_TIMEOUT_MS = 200

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only hook registration is synchronous), so the rule
// is disabled per existing precedent in auth/bypass-plugin.ts.
// eslint-disable-next-line @typescript-eslint/require-await
const impl: FastifyPluginAsync<Opts> = async (app, opts) => {
  const users = createUsersRepo(opts.pool)
  const observed: { method: string; url: string }[] = []

  // Collect routes during registration. Fastify v5 doesn't expose a stable
  // public app.routes() API; the canonical pattern is onRoute → collect →
  // validate in onReady.
  //
  // Fastify auto-registers HEAD alongside every GET, sharing the same handler
  // and config. There's no security distinction between them — if GET is
  // jwt-no-db, HEAD is too — so we skip HEAD here and let the GET entry
  // represent the URL.
  app.addHook('onRoute', (routeOptions) => {
    const cfg = routeOptions.config as { auth?: string } | undefined
    if (cfg?.auth === 'jwt-no-db') {
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method]
      for (const m of methods) {
        if (m.toUpperCase() === 'HEAD') continue
        observed.push({ method: m, url: routeOptions.url })
      }
    }
  })

  // Boot-time enforcement of the allowlist.
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onReady', async () => {
    const offenders: string[] = []
    for (const { method, url } of observed) {
      const normalizedMethod = method.toUpperCase()
      const normalizedUrl = url.replace(/\/$/, '') || '/'
      const key = `${normalizedMethod}::${normalizedUrl}`
      if (!JWT_NO_DB_ALLOWLIST.has(key)) {
        offenders.push(key)
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `requireOnboarded: jwt-no-db opt-out used on non-allowlisted routes: ${offenders.join(', ')}. ` +
          `If a new route legitimately needs jwt-no-db, add it to JWT_NO_DB_ALLOWLIST in require-onboarded.ts ` +
          `AND get a security review on the PR.`,
      )
    }
  })

  // Per-request gate.
  app.addHook('preHandler', async (request, reply) => {
    const cfg = request.routeOptions.config.auth
    if (cfg === 'public' || cfg === 'jwt-no-db') return

    if (request.routeOptions.url === undefined) return // 404 fall-through

    if (!request.user) {
      return reply.code(401).send({ code: 'unauthenticated' })
    }

    const row = await users.getByCognitoSubWithTimeout(
      request.user.sub,
      REQUIRE_ONBOARDED_LOOKUP_TIMEOUT_MS,
    )
    if (!row) {
      return reply.code(403).send({ code: 'username_required' })
    }
    if (row.suspendedAt !== null) {
      // Closes the up-to-1h ban-lag window between admin-suspending a
      // user and their access token expiring. Source spec
      // 2026-04-13-auth-users.md §6 line 284 commits MYT-39 to this.
      return reply.code(403).send({ code: 'account_suspended' })
    }
    // Frozen so a buggy / malicious downstream hook can't swap fields
    // in place. TS `readonly` is structural-only; runtime freeze is the
    // actual guarantee. Per
    // docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §4.
    request.dbUser = Object.freeze(row)
  })
}

// No `dependencies` field: the real-mode `mythrun-auth-jwt` and the dev-mode
// `mythrun-auth-bypass` both attach request.user via preHandler, and either
// satisfies this plugin's contract. fastify-plugin's `dependencies` is
// strict AND, which would lock us out of bypass mode. Hook ordering
// (registerAuth runs before this plugin) is the actual guarantee.
export const requireOnboarded = fp(impl, {
  fastify: '5.x',
  name: 'mythrun-require-onboarded',
})
