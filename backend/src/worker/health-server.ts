// Worker /health endpoint on port 3001 (bound to 127.0.0.1). Container ECS
// healthCheck hits this. 200 when all four runtime deps respond within
// PROBE_TIMEOUT_MS: redis-batch, redis-realtime, pg, and both BullMQ
// workers running. 503 otherwise with the failed probe names in the
// response body.

import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Worker as BullmqWorker } from 'bullmq'

const PROBE_TIMEOUT_MS = 1000

interface HealthDeps {
  readonly pg: Pool
  readonly redisBatch: Redis
  readonly redisRealtime: Redis
  readonly workers: readonly BullmqWorker[]
}

interface ProbeResult {
  readonly name: string
  readonly ok: boolean
}

async function probe(name: string, fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`probe timeout after ${String(PROBE_TIMEOUT_MS)}ms`))
        }, PROBE_TIMEOUT_MS)
      }),
    ])
    return { name, ok: true }
  } catch {
    return { name, ok: false }
  }
}

export async function startHealthServer(
  port: number,
  deps: HealthDeps,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.get('/health', async (_req, reply) => {
    const probes = await Promise.all([
      probe('redis-batch', () => deps.redisBatch.ping()),
      probe('redis-realtime', () => deps.redisRealtime.ping()),
      probe('pg', () => deps.pg.query('SELECT 1')),
      ...deps.workers.map((w) =>
        probe(`worker-${w.name}`, () =>
          w.isRunning()
            ? Promise.resolve()
            : Promise.reject(new Error('worker is not running')),
        ),
      ),
    ])
    const failed = probes.filter((r) => !r.ok).map((r) => r.name)
    if (failed.length > 0) {
      return reply.code(503).send({ healthy: false, failed })
    }
    return reply.code(200).send({ healthy: true })
  })

  await app.listen({ host: '127.0.0.1', port })
  return app
}
