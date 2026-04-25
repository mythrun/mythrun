import { buildApp, createShutdown } from './app.js'
import type { AppDeps } from './app-deps.js'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'

const stubDeps: AppDeps = {
  pg: { end: () => Promise.resolve() } as unknown as Pool,
  redisRealtime: { quit: () => Promise.resolve('OK') } as unknown as Redis,
  redisBatch: { quit: () => Promise.resolve('OK') } as unknown as Redis,
}
const app = buildApp(stubDeps)
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

const handleShutdown = createShutdown(app, stubDeps)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void handleShutdown(signal))
}
