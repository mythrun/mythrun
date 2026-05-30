// Integration test for the settings namespace (data-layer-repo-unification).
// `settings.getValue(key)` homes the two cost-cap inline reads. settings.value
// is NOT NULL per schema, so getValue returns null ONLY for a missing row —
// the caller (cost-cap) turns that absence into a fail-loud error.
//
// NOTE: serialized in vitest.config.ts SERIAL_FILES is NOT needed here — this
// test inserts a SCOPED key (settings.key is the PK; a uuid-suffixed key never
// collides with the global world_gen_cost_cap_usd / character_creation rows
// the cost-cap tests mutate). It cleans up its own key in afterEach.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { uuidv7 } from '../uuidv7.js'
import { createSettingsRepo, settingsNs } from '../settings.js'
import { createTestPool } from './_helpers/test-pool.js'

const databaseUrl = process.env.DATABASE_URL ?? ''

describe('settings repo', () => {
  let pool: Pool
  // Per-test unique key so we never touch the global singleton cost-cap rows
  // (those belong to the serialized cost-cap / processor tests).
  const key = `test_setting_${uuidv7()}`

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
  })
  afterEach(async () => {
    await pool.query(`DELETE FROM settings WHERE key = $1`, [key])
  })
  afterAll(async () => {
    await pool.end()
  })

  it('returns the stored value for an existing key', async () => {
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, '42.5')`, [key])
    expect(await settingsNs(pool).getValue(key)).toBe('42.5')
  })

  it('returns null for a missing key', async () => {
    expect(await settingsNs(pool).getValue(key)).toBeNull()
  })

  it('back-compat factory delegates to the binder', async () => {
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, 'hello')`, [key])
    expect(await createSettingsRepo(pool).getValue(key)).toBe('hello')
  })
})
