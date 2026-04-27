import { describe, it, expect } from 'vitest'
import { guardTestDatabase } from './guard-db.js'

describe('guardTestDatabase', () => {
  it('throws when databaseUrl is empty', async () => {
    await expect(guardTestDatabase('')).rejects.toThrow(/DATABASE_URL not set/)
  })

  it('throws on remote host', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@rds.amazonaws.com:5432/mythrun'),
    ).rejects.toThrow(/Refusing/)
  })

  it('throws on disallowed db name', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@127.0.0.1:5432/production'),
    ).rejects.toThrow(/Refusing/)
  })

  it('accepts localhost mythrun', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@localhost:5432/mythrun'),
    ).resolves.toBeUndefined()
  })

  it('accepts 127.0.0.1 mythrun_test', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@127.0.0.1:5432/mythrun_test'),
    ).resolves.toBeUndefined()
  })

  it('accepts 127.0.0.1 mythrun_ci', async () => {
    await expect(
      guardTestDatabase('postgresql://u:p@127.0.0.1:5432/mythrun_ci'),
    ).resolves.toBeUndefined()
  })
})
