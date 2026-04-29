import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app-deps.js'

const PROBE_TIMEOUT_MS = 1000

interface ProbeResult {
  name: string
  ok: boolean
  error: string | undefined
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
    return { name, ok: true, error: undefined }
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerReadyRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health/ready', async (_req, reply) => {
    const results = await Promise.all([
      probe('pg', () => deps.pg.query('SELECT 1')),
      probe('redis-realtime', () => deps.redisRealtime.ping()),
      probe('redis-batch', () => deps.redisBatch.ping()),
    ])

    const failed = results.filter((r) => !r.ok).map((r) => r.name)

    if (failed.length > 0) {
      for (const r of results) {
        if (!r.ok) app.log.warn({ probe: r.name, err: r.error }, 'health-ready probe failed')
      }
      return reply.code(503).send({ ready: false, failed })
    }
    return reply.code(200).send({ ready: true })
  })
}
