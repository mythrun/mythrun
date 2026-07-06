// backend/src/routes/__tests__/worldgen-stage-timings.test.ts
//
// MYT-89 audit ③ — GET /api/worldgen/stage-timings.
//
// The route is a global aggregate read with no per-request state beyond the DB,
// so a standalone Fastify app (register the plugin + rate-limit, no auth chain)
// is enough to exercise the handler → repo → real Postgres path end to end. The
// auth wiring (default JWT + onboarded chain, registration under bypass boot) is
// covered by the backend-routes drift test; here we assert the DATA behavior and
// the wire shape the FE consumes verbatim.
//
// Seeding mirrors pipeline-runs.test.ts: fresh uuidv7 ids + a per-invocation
// UNIQUE stage name, so the global GROUP BY row for that stage aggregates ONLY
// this test's rows (immune to other files' / prior runs' pipeline_runs rows). No
// blanket DELETE — rows are inert under the unique-stage scoping.

import { afterAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { Pool } from 'pg'
import type { Pool as PgPool } from 'pg'
import { StageTimingsResponseSchema } from '@mythrun/contract/rest'
import { worldgenRoutes } from '../worldgen.js'
import { uuidv7 } from '../../repo/uuidv7.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function buildApp(poolForRoute: PgPool): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: 1 })
  await app.register(rateLimit, { global: false, max: 1000, timeWindow: '1 minute' })
  await app.register(worldgenRoutes, { pool: poolForRoute })
  await app.ready()
  return app
}

// Insert a completed pipeline_runs row for `stage` on a fresh world with a known
// duration (distinct worlds per call so two rows can share a stage without
// tripping idx_pipeline_runs_unique).
async function seedCompletedRun(stage: string, durationSeconds: number): Promise<void> {
  const userId = uuidv7()
  const worldId = uuidv7()
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, `s-${userId}`, 'Test', `t${userId.slice(-6)}`],
  )
  await pool.query(
    `INSERT INTO worlds (id, created_by, name, concept) VALUES ($1, $2, 'W', 'C')`,
    [worldId, userId],
  )
  await pool.query(
    `INSERT INTO pipeline_runs (id, world_id, stage, status, started_at, completed_at, user_id)
     VALUES ($1, $2, $3, 'completed', now() - ($4 || ' seconds')::interval, now(), NULL)`,
    [uuidv7(), worldId, stage, String(durationSeconds)],
  )
}

describe('GET /api/worldgen/stage-timings', () => {
  const apps: FastifyInstance[] = []

  afterAll(async () => {
    for (const a of apps) await a.close()
    await pool.end()
  })

  it('real-data smoke: returns the averaged per-stage duration (ms) from history', async () => {
    const stage = `myt89-route-${uuidv7().slice(-12)}`
    await seedCompletedRun(stage, 2) // 2000ms
    await seedCompletedRun(stage, 4) // 4000ms → avg 3000ms

    const app = await buildApp(pool)
    apps.push(app)
    const res = await app.inject({ method: 'GET', url: '/api/worldgen/stage-timings' })

    expect(res.statusCode).toBe(200)
    const body: unknown = res.json()
    // The whole payload validates against the wire contract the FE consumes.
    const parsed = StageTimingsResponseSchema.parse(body)
    const mine = parsed.find((r) => r.stage === stage)
    expect(mine).toBeDefined()
    expect(mine?.avgMs).toBe(3000)
  })

  it('returns [] on cold-start (no completed history)', async () => {
    // Stub pool: the repo query returns zero rows → the handler sends []. Proves
    // the FE's graceful-degradation path deterministically (the live query is
    // global, so a shared DB is never truly empty under parallel test load).
    const emptyPool = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    } as unknown as PgPool
    const app = await buildApp(emptyPool)
    apps.push(app)
    const res = await app.inject({ method: 'GET', url: '/api/worldgen/stage-timings' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })
})
