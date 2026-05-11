import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { probeMigrationsCurrent } from '../migrations-current.js'

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}))

import { readdir } from 'node:fs/promises'

// readdir is typed `Promise<Dirent[]>` in some overloads; the probe uses
// the string[] overload, so we cast through unknown to the right shape.
const readdirMock = readdir as unknown as ReturnType<typeof vi.fn>

interface FakePool {
  query: ReturnType<typeof vi.fn>
}

function fakePool(queries: { rows: Record<string, unknown>[] }[]): FakePool {
  const q = vi.fn()
  for (const result of queries) {
    q.mockResolvedValueOnce(result)
  }
  return { query: q }
}

describe('probeMigrationsCurrent', () => {
  beforeEach(() => {
    readdirMock.mockReset()
  })

  it('resolves when image files exactly match applied versions', async () => {
    readdirMock.mockResolvedValue([
      '001_initial_schema.sql',
      '002_indexes.sql',
      'README.md', // non-SQL, filtered out
    ])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] }, // to_regclass result
      { rows: [{ version: '001_initial_schema.sql' }, { version: '002_indexes.sql' }] },
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).resolves.toBeUndefined()
  })

  it('throws operator-actionable error when _migrations table does not exist', async () => {
    readdirMock.mockResolvedValue(['001_initial_schema.sql', '002_indexes.sql'])
    const pool = fakePool([
      { rows: [{ reg: null }] }, // to_regclass returns NULL
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).rejects.toThrow(
      /_migrations table does not exist.*Run `gh workflow run db-migrate`/s,
    )
  })

  it('throws when DB is missing migrations the image expects', async () => {
    readdirMock.mockResolvedValue([
      '001_initial_schema.sql',
      '002_indexes.sql',
      '003_srd_reference_data.sql',
    ])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] },
      { rows: [{ version: '001_initial_schema.sql' }] }, // missing 002, 003
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).rejects.toThrow(
      /missing 2 \(002_indexes\.sql, 003_srd_reference_data\.sql\)/,
    )
  })

  it('resolves when DB has extra applied versions not in image (rollback tolerance)', async () => {
    readdirMock.mockResolvedValue(['001_initial_schema.sql', '002_indexes.sql'])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] },
      {
        rows: [
          { version: '001_initial_schema.sql' },
          { version: '002_indexes.sql' },
          { version: '003_orphan_from_newer_rolled_back_image.sql' },
        ],
      },
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).resolves.toBeUndefined()
  })

  it('filters out non-matching filenames (uppercase, dotfiles, README, .gz)', async () => {
    readdirMock.mockResolvedValue([
      '001_initial_schema.sql',
      '002_INDEXES.sql', // uppercase prefix word — rejected by regex
      '.DS_Store',
      'README.md',
      '003_x.sql.gz',
      '004_z.sql',
    ])
    const pool = fakePool([
      { rows: [{ reg: 'public._migrations' }] },
      { rows: [{ version: '001_initial_schema.sql' }, { version: '004_z.sql' }] },
    ])
    await expect(probeMigrationsCurrent(pool as unknown as Pool)).resolves.toBeUndefined()
  })
})
