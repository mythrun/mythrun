import { randomUUID } from 'node:crypto'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from './app-deps.js'
import { registerAuth, type RegisterAuthOptions } from './auth/index.js'
import { accessControlAllowlist } from './auth/access-control-allowlist.js'
import { registerPublicRouteAllowlistHook } from './auth/public-route-allowlist.js'
import { requireOnboarded } from './auth/require-onboarded.js'
import type { Env } from './config/env.js'
import { registerReadyRoute } from './routes/health-ready.js'
import { usersRoutes } from './routes/users.js'
import { invitesRoutes } from './routes/invites.js'
import { sessionsRoutes } from './routes/sessions.js'
import { webhookRoutes } from './routes/webhook.js'
import { billingRoutes } from './routes/billing.js'

export interface AppConfig {
  /** Origin of the frontend SPA, used to compose share URLs (e.g. invite links).
   *  Validated by loadEnv() against an allowlist of hosts. Pass through
   *  intact — handlers concatenate paths onto it without re-validation. */
  readonly frontendBaseUrl: string
  /** Loaded process env. Threaded into the webhook + billing plugins so
   *  they can pull stripeSecretKey / stripeWebhookSecret without
   *  reaching back into module-level config. */
  readonly env: Env
}

// buildApp is the boot orchestrator: a flat, top-to-bottom registration
// sequence where the ORDER is load-bearing (allowlist hook before
// /health, webhook plugin before usersRoutes, billingRoutes last).
// Splitting it into helpers would scatter the order-dependence across
// files and obscure the wiring contract this function exists to express.
// Comments + Fastify config inflate the line count past the 50-line
// heuristic; the cohesion case is the same as routes/billing.ts.
/* eslint-disable-next-line max-lines-per-function */
export const buildApp = async (
  deps: AppDeps,
  authOpts: RegisterAuthOptions,
  config: AppConfig,
): Promise<FastifyInstance> => {
  // Explicit type parameters force selection of the plain-HTTP Fastify
  // overload. Without them, TS picks the first matching overload
  // (Http2SecureServer), which then propagates incompatible RawServer
  // types into hooks/plugins that expect the default.
  const app = Fastify<Server, IncomingMessage, ServerResponse>({
    // ALB → ECS: trust exactly one proxy hop so request.ip / hostname read
    // X-Forwarded-* with the real client values, not the ALB's. Required for
    // accurate rate-limit keys and for routes that log/use request.ip.
    trustProxy: 1,
    // CRITICAL: Fastify's default pluginTimeout is 10s. Our jwtPlugin's
    // hydrate has up-to-1s jitter + 10s timeout = 11s wall budget. Without
    // the bump, Fastify's pluginTimeout fires first on slow Cognito and
    // the operator sees a generic Fastify timeout instead of our specific
    // auth.jwks_hydrate_failed log line. Bump to 30s.
    pluginTimeout: 30_000,
    genReqId: (req) => {
      const trace = req.headers['x-amzn-trace-id']
      return typeof trace === 'string' ? trace : randomUUID()
    },
    logger: {
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
      serializers: {
        req(request) {
          // Strip query strings from logged URLs so future routes that
          // take tokens via query (notably MYT-39's WebSocket
          // ?ticket=<nonce>) don't leak the token into CloudWatch.
          // Path is preserved so operators can tell which route was hit.
          const rawUrl: unknown = request.url
          const url = typeof rawUrl === 'string' ? (rawUrl.split('?')[0] ?? rawUrl) : undefined
          const remotePort = request.socket.remotePort
          // Build the result with conditional spread so we don't emit
          // explicit `undefined` properties — exactOptionalPropertyTypes
          // forbids `url: undefined` against a `url?: string` signature.
          return {
            method: request.method,
            ...(url !== undefined ? { url } : {}),
            hostname: request.hostname,
            remoteAddress: request.ip,
            ...(remotePort !== undefined ? { remotePort } : {}),
          }
        },
      },
    },
  })

  // Public-route allowlist hook (MYT-42 task 11 + spec §3 lines 86–109).
  // MUST be installed BEFORE any route registration that may set
  // `config.auth: 'public'` — Fastify's onRoute hook is inherited downward
  // only into plugins/routes registered AFTER the hook is added on the
  // same scope. Hoisting this above `/health` is load-bearing: if the
  // hook is registered after /health, the hook never validates the
  // /health registration and a future addition of a public route there
  // would silently slip through.
  registerPublicRouteAllowlistHook(app)

  app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' })) // liveness
  registerReadyRoute(app, deps) // /health/ready opts out via config: { auth: 'public' } INSIDE the route file

  // Custom 404 handler so unmatched paths return a stable JSON shape
  // instead of Fastify's default HTML-ish error. The auth hook's
  // `request.routeOptions.url === undefined` guard (in bypass-plugin.ts +
  // jwt-plugin.ts) already short-circuits auth for the 404 path —
  // Fastify v5's setNotFoundHandler opts only support preValidation /
  // preHandler hooks, not per-route config, so the v4-style
  // `{ config: { auth: 'public' } }` belt-and-suspenders isn't expressible
  // here. The url-undefined guard is the actual contract.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not Found' })
  })

  await registerAuth(app, authOpts)

  // Rate-limit plugin — global=false so individual routes opt in via
  // config.rateLimit. The 1000/min ceiling is a safety net only; per-route
  // limits set tighter caps (e.g. /api/users/register = 5/min).
  //
  // Backed by redisRealtime so the limit applies across the ECS fleet,
  // not per-task. Default keyGenerator returns request.ip (the real
  // client because trustProxy: 1 strips the ALB hop). Routes that need
  // per-sub limiting override via config.rateLimit.keyGenerator.
  //
  // Fails OPEN if Redis is unreachable: @fastify/rate-limit's default
  // skipOnError logs the error and allows the request through. Trade-off
  // accepted — rate-limit infra failure should not 503 the service.
  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
    redis: deps.redisRealtime,
    nameSpace: `${deps.redisKeyPrefix}rl:`,
  })

  // requireOnboarded gates protected routes on a real users row +
  // suspended_at check, attaches frozen request.dbUser. Public +
  // jwt-no-db opt out; jwt-no-db is allowlist-bound and boot fails if a
  // non-allowlisted route uses it.
  await app.register(requireOnboarded, { pool: deps.pg })

  // accessControlAllowlist (MYT-39 §4) — boot-time gate that fails
  // app.ready() if any route uses requireCampaignMember/requireWorldCreator
  // together with config.auth: 'public' or 'jwt-no-db' (which would
  // short-circuit requireOnboarded and leave request.dbUser undefined).
  // Registered AFTER requireOnboarded so the allowlist's onRoute hook
  // sees every subsequent route registration.
  await app.register(accessControlAllowlist)

  // Webhook plugin (MYT-42 Task 15). Registered BEFORE any sibling JSON
  // route the parent scope cares about, so the encapsulated raw-body
  // parser stays inside the child context (Fastify v5's
  // addContentTypeParser is encapsulation-scoped, not route-scoped — see
  // routes/webhook.ts for the full rationale).
  await app.register(webhookRoutes, { pool: deps.pg, env: config.env })

  await app.register(usersRoutes, { pool: deps.pg })
  await app.register(invitesRoutes, {
    pool: deps.pg,
    frontendBaseUrl: config.frontendBaseUrl,
  })

  // Sessions plugin (MYT-39 §6). Currently only POST /api/sessions/:id/ws-ticket;
  // additional session-scoped routes land in the Session Runtime milestone.
  await app.register(sessionsRoutes, {
    pool: deps.pg,
    redisRealtime: deps.redisRealtime,
    redisKeyPrefix: deps.redisKeyPrefix,
  })

  // Billing plugin (MYT-42 Tasks 25–31). Registered last as a direct
  // child of `app` so it inherits the public-route allowlist + auth
  // hooks installed above. /api/billing/skus is the only public route
  // here; the rest go through the JWT + requireOnboarded chain.
  await app.register(billingRoutes, { pool: deps.pg, env: config.env })

  return app
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'
export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

export interface ShutdownClients {
  readonly pg: Pool
  readonly redisRealtime: Redis
  readonly redisBatch: Redis
}

export const createShutdown = (app: FastifyInstance, clients: ShutdownClients): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      // Yield once so pino's async log queue drains before close.
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Drain order matters: HTTP first (no in-flight queries), then pg pool,
      // then redis QUIT (graceful, flushes in-flight commands; vs disconnect
      // which rips the socket).
      await app.close()
      await clients.pg.end()
      await clients.redisRealtime.quit()
      await clients.redisBatch.quit()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
// MYT-28 idempotency marker — verifies second push produces new task-def revision
