import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from './app-deps.js'
import { registerReadyRoute } from './routes/health-ready.js'

export const buildApp = (deps: AppDeps): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' })) // liveness — ECS container check
  registerReadyRoute(app, deps) // readiness — ALB target-group check
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
