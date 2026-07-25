// Worker /health endpoint on port 3001 (bound to 127.0.0.1). Container ECS
// healthCheck hits this. 200 when all four runtime deps respond within
// PROBE_TIMEOUT_MS: redis-batch, redis-realtime, pg, and both BullMQ
// workers running. 503 otherwise with the failed probe names in the
// response body.
//
// myth-jykft — the server binds in TWO phases:
//
//   1. `startHealthServer(port)` binds the socket. worker.ts calls this FIRST,
//      before it registers a single BullMQ worker, so a second worker process
//      on the same host dies on EADDRINUSE instead of silently becoming a
//      competing consumer of the shared queues. Same shape as server.ts's
//      `listenOrFail`. This rejects SAME-HOST duplicates only: under ECS
//      awsvpc every task has its own network namespace, so N replicas each
//      bind their own 127.0.0.1:3001 and the legitimate multi-replica
//      (and rolling-deploy overlap) topology is untouched.
//   2. `arm(deps)` supplies the runtime deps once boot has finished. Between
//      bind and arm, /health answers 503 `{ healthy:false, failed:['boot'] }`
//      — the same "not ready" signal ECS saw before, when the port simply
//      wasn't listening yet. Health still only goes green once every dep is up.

import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Worker as BullmqWorker } from 'bullmq'

const PROBE_TIMEOUT_MS = 1000

export interface HealthDeps {
  readonly pg: Pool
  readonly redisBatch: Redis
  readonly redisRealtime: Redis
  readonly workers: readonly BullmqWorker[]
}

export interface WorkerHealthServer {
  /** The bound Fastify instance. Exposed so tests can `inject` without a
   *  socket round-trip; production only ever uses `arm` + `close`. */
  readonly app: FastifyInstance
  /** Supply the runtime deps. Until this runs, /health is 503 (see header). */
  arm: (deps: HealthDeps) => void
  close: () => Promise<void>
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

export async function startHealthServer(port: number): Promise<WorkerHealthServer> {
  const app = Fastify({ logger: false })
  let deps: HealthDeps | undefined

  app.get('/health', async (_req, reply) => {
    // Bound but not yet armed: boot is still running. Report not-ready rather
    // than green — an un-armed worker consumes nothing.
    if (deps === undefined) {
      return reply.code(503).send({ healthy: false, failed: ['boot'] })
    }
    const armed = deps
    const probes = await Promise.all([
      probe('redis-batch', () => armed.redisBatch.ping()),
      probe('redis-realtime', () => armed.redisRealtime.ping()),
      probe('pg', () => armed.pg.query('SELECT 1')),
      ...armed.workers.map((w) =>
        probe(`worker-${w.name}`, () =>
          w.isRunning() ? Promise.resolve() : Promise.reject(new Error('worker is not running')),
        ),
      ),
    ])
    const failed = probes.filter((r) => !r.ok).map((r) => r.name)
    if (failed.length > 0) {
      return reply.code(503).send({ healthy: false, failed })
    }
    return reply.code(200).send({ healthy: true })
  })

  // The bind itself is the duplicate-consumer guard (see header). A throw here
  // — EADDRINUSE in particular — propagates to worker.ts's bindHealthOrFail,
  // which classifies it and refuses to boot.
  await app.listen({ host: '127.0.0.1', port })

  return {
    app,
    arm: (next: HealthDeps): void => {
      deps = next
    },
    close: (): Promise<void> => app.close(),
  }
}
