// Integration test for the health namespace (data-layer-repo-unification).
// `repo.health.ping()` homes the `/health/ready` route's liveness `SELECT 1`
// probe behind the repo surface (the route no longer touches a pg client
// directly). The binder runs over a real pool here so the exercised SQL is
// the production statement.
//
// No scoped fixtures needed — `SELECT 1` reads no rows and writes nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createHealthRepo, healthNs } from '../health.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('health repo', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
  })
  afterAll(async () => {
    await pool.end()
  })

  it('ping resolves against a reachable pool', async () => {
    await expect(healthNs(pool).ping()).resolves.toBeUndefined()
  })

  it('back-compat factory delegates to the binder', async () => {
    await expect(createHealthRepo(pool).ping()).resolves.toBeUndefined()
  })

  it('ping rejects when the underlying client query fails (probe failure path)', async () => {
    const failing = {
      query: () => Promise.reject(new Error('connection refused')),
    }
    await expect(healthNs(failing).ping()).rejects.toThrow(/connection refused/)
  })
})
