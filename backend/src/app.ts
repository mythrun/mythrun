import { randomUUID } from 'node:crypto'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from './app-deps.js'
import { registerAuth, type RegisterAuthOptions } from './auth/index.js'
import { registerReadyRoute } from './routes/health-ready.js'

export const buildApp = async (
  deps: AppDeps,
  authOpts: RegisterAuthOptions,
): Promise<FastifyInstance> => {
  // Explicit type parameters force selection of the plain-HTTP Fastify
  // overload. Without them, TS picks the first matching overload
  // (Http2SecureServer), which then propagates incompatible RawServer
  // types into hooks/plugins that expect the default.
  const app = Fastify<Server, IncomingMessage, ServerResponse>({
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
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req(request) {
          // Strip query strings from logged URLs so future routes that
          // take tokens via query (notably MYT-39's WebSocket
          // ?ticket=<nonce>) don't leak the token into CloudWatch.
          // Path is preserved so operators can tell which route was hit.
          const rawUrl: unknown = request.url
          const url =
            typeof rawUrl === 'string'
              ? (rawUrl.split('?')[0] ?? rawUrl)
              : undefined
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
  return app
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'
export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

export interface ShutdownClients {
  readonly pg: Pool
  readonly redisRealtime: Redis
  readonly redisBatch: Redis
}

export const createShutdown = (
  app: FastifyInstance,
  clients: ShutdownClients,
): ShutdownHandler => {
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
