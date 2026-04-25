import Fastify, { type FastifyInstance } from 'fastify'
import type { AppDeps } from './app-deps.js'

// Deps held by server.ts for shutdown; Backend Core's first plugin will
// add `app.decorate('pg', deps.pg)` and the FastifyInstance type
// augmentation. This ticket only establishes the dependency-injection
// shape via AppDeps. The `_` prefix marks the param as intentionally
// unused this ticket; the eslint-disable is a deliberate intermediate
// state — the next consuming plugin will reference deps and remove it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const buildApp = (_deps: AppDeps): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'

export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

export const createShutdown = (app: FastifyInstance): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      // Yield once so pino's async log queue drains before close.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
// MYT-28 idempotency marker — verifies second push produces new task-def revision
