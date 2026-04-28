import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import { createPgPool } from '../../db/postgres.js'
import { runMigrations } from '../../db/migrate.js'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createUsersRepo } from '../users.js'
import { resetData } from './_helpers/reset-data.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: () => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' }, serializers: { err: pino.stdSerializers.err } }, sink)
}

describe('users repo (integration)', () => {
  let pool: Pool

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 1 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  const baseInput = {
    cognitoSub: 'google_12345',
    email: 'a@b.com',
    displayName: 'Alice',
    username: 'alice',
    authProvider: 'google' as const,
  }

  it('create returns a fully-populated user row', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.create(baseInput)
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.cognitoSub).toBe('google_12345')
    expect(u.email).toBe('a@b.com')
    expect(u.displayName).toBe('Alice')
    expect(u.username).toBe('alice')
    expect(u.avatarUrl).toBeNull()
    expect(u.authProvider).toBe('google')
    expect(u.stripeCustomerId).toBeNull()
    expect(u.freeTrialUsed).toBe(false)
    expect(u.suspendedAt).toBeNull()
    expect(u.createdAt).toBeInstanceOf(Date)
    expect(u.updatedAt).toBeInstanceOf(Date)
  })

  it('getById returns the user when present', async () => {
    const repo = createUsersRepo(pool)
    const created = await repo.create(baseInput)
    const found = await repo.getById(created.id)
    expect(found).not.toBeNull()
    expect(found?.id).toBe(created.id)
  })

  it('getById returns null for unknown id', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.getById('019dccef-0000-7000-8000-000000000000')
    expect(u).toBeNull()
  })

  it('getByCognitoSub returns the user when present', async () => {
    const repo = createUsersRepo(pool)
    await repo.create(baseInput)
    const u = await repo.getByCognitoSub('google_12345')
    expect(u).not.toBeNull()
    expect(u?.email).toBe('a@b.com')
  })

  it('getByCognitoSub returns null for unknown sub', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.getByCognitoSub('nope')
    expect(u).toBeNull()
  })

  it('getByEmail returns the user when present', async () => {
    const repo = createUsersRepo(pool)
    await repo.create(baseInput)
    const u = await repo.getByEmail('a@b.com')
    expect(u?.username).toBe('alice')
  })

  it('update mutates supplied fields and bumps updatedAt', async () => {
    const repo = createUsersRepo(pool)
    const created = await repo.create(baseInput)
    await new Promise((r) => setTimeout(r, 5))
    const updated = await repo.update(created.id, { displayName: 'Alicia' })
    expect(updated.displayName).toBe('Alicia')
    expect(updated.username).toBe('alice')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('update with all-undefined patch is a no-op (except updatedAt)', async () => {
    const repo = createUsersRepo(pool)
    const created = await repo.create(baseInput)
    await new Promise((r) => setTimeout(r, 5))
    const updated = await repo.update(created.id, {})
    expect(updated.displayName).toBe(created.displayName)
    expect(updated.username).toBe(created.username)
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('update throws when the user does not exist', async () => {
    const repo = createUsersRepo(pool)
    await expect(repo.update('019dccef-0000-7000-8000-000000000000', { displayName: 'X' })).rejects.toThrow(
      /no user with id/,
    )
  })
})
