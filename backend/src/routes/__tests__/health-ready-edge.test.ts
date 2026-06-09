// backend/src/routes/__tests__/health-ready-edge.test.ts
//
// Edge-case test driving coverage of registerReadyRoute lines around the
// non-Error throw branch (`err instanceof Error ? err.message : String(err)`).
// The existing src/__tests__/health-ready.test.ts covers the happy-path /
// rejecting-Error paths; this file adds the non-Error throw case so the
// `String(err)` branch in routes/health-ready.ts probe() is exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import IoredisMock from 'ioredis-mock'
import { registerReadyRoute } from '../health-ready.js'
import type { AppDeps } from '../../app-deps.js'
import { createRepo } from '../../repo/index.js'
import {
  noopWorldGenQueue,
  noopSessionPrepQueue,
  noopSessionSuspendQueue,
  noopSessionTurnQueue,
  noopDmTriggerQueue,
} from '../../__tests__/helpers/stub-deps.js'

function buildDeps(pgQuery: () => Promise<unknown>): AppDeps {
  const pg = {
    query: pgQuery,
    end: (): Promise<void> => Promise.resolve(),
  } as unknown as Pool
  const realtime: Redis = new IoredisMock()
  const batch: Redis = new IoredisMock()
  return {
    pg,
    redisRealtime: realtime,
    redisBatch: batch,
    redisKeyPrefix: 'test:use1:',
    repo: createRepo(pg),
    worldGenQueue: noopWorldGenQueue(),
    sessionPrepQueue: noopSessionPrepQueue(),
    sessionSuspendQueue: noopSessionSuspendQueue(),
    sessionTurnQueue: noopSessionTurnQueue(),
    dmTriggerQueue: noopDmTriggerQueue(),
  }
}

describe('registerReadyRoute — non-Error throw branch (line 24 String(err) fallback)', () => {
  let app: FastifyInstance | undefined

  beforeEach(() => {
    app = undefined
  })

  afterEach(async () => {
    if (app) await app.close()
    vi.useRealTimers()
  })

  it("returns 503 with failed:['pg'] when pg.query rejects with a non-Error value", async () => {
    // Reject with a plain string, not an Error instance — forces probe()'s
    // ternary into the String(err) branch (line 24 in routes/health-ready.ts).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately rejects with a non-Error to exercise the String(err) branch
    const deps = buildDeps(() => Promise.reject('boom-string-not-error'))
    app = Fastify({ logger: false })
    registerReadyRoute(app, deps)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    const body = res.json<{ ready: boolean; failed: string[] }>()
    expect(body.ready).toBe(false)
    expect(body.failed).toEqual(['pg'])
  })
})
