import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../../../src/db/__tests__/guard-db.js'
import { createTestPool } from '../../../../src/repo/__tests__/_helpers/test-pool.js'
import { uuidv7 } from '../../../../src/repo/uuidv7.js'
import { captureFixture } from '../capture.js'
import type { FixtureManifest } from '../types.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('captureFixture (smoke-fixture toolkit)', () => {
  let pool: Pool
  const userId = '019700e0-0000-7000-8000-00000000d002' // seeded dev-user-2
  const worldId = uuidv7()

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    await pool.query(`INSERT INTO worlds (id, created_by, name, concept, status) VALUES ($1, $2, 'CapTest', 'cap concept', 'complete')`, [worldId, userId])
  })
  afterAll(async () => {
    await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    await pool.end()
  })

  it('captures the manifest tables into a self-contained FixtureFile with schemaVersion', async () => {
    const manifest: FixtureManifest = {
      name: 'cap-test',
      tables: [{ name: 'worlds', filter: (ids) => ({ sql: 'id = $1', params: [ids.worldId] }) }],
    }
    const file = await captureFixture(pool, manifest, { campaignId: worldId, worldId })
    expect(file.name).toBe('cap-test')
    expect(file.schemaVersion).toMatch(/\.sql$/)
    const worldsTable = file.tables.find((t) => t.name === 'worlds')
    expect(worldsTable?.rows).toHaveLength(1)
    expect((worldsTable?.rows[0] as { name: string }).name).toBe('CapTest')
    expect(worldsTable?.shared).toBe(false)
  })
})
