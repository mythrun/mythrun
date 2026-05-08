// Trial-credit assertions for the register handler. The base
// onboarding.test.ts covers the three legacy 4xx/2xx shapes; this file
// pins the new behavior introduced in MYT-42 task 32:
//
//   1. After a successful register, the user has exactly ONE
//      credit_ledger row (`source_type='trial'`, `amount=1`,
//      `source_id=NULL`, `expires_at=NULL`, both FK columns NULL).
//   2. `users.free_trial_used = true` after register.
//   3. The three writes are atomic — if `grantInTx` raises mid-tx
//      the users INSERT is rolled back too (no orphan users row, no
//      credit row).
//
// The atomicity test imports the `grantInTx` symbol from the credits
// repo and replaces it with a stub that throws AFTER it would have
// succeeded. The route handler's try/catch must ROLLBACK the users
// INSERT in response, leaving the DB unchanged.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'

vi.mock('../llm/profanity.js', () => ({
  classifyProfanity: vi.fn(),
}))

import { createPgPool } from '../db/postgres.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import { resetData } from '../repo/__tests__/_helpers/reset-data.js'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import { createRepo } from '../repo/index.js'
import * as creditsRepo from '../repo/credits.js'
import { classifyProfanity } from '../llm/profanity.js'
import { makeStubEnv } from './helpers/stub-env.js'

const classifyProfanityMock = vi.mocked(classifyProfanity)

const databaseUrl = process.env.DATABASE_URL ?? ''
const here = fileURLToPath(import.meta.url)
const REAL_MIGRATIONS_DIR = resolve(here, '../../../migrations')

function silentLogger(): ReturnType<typeof pino> {
  const sink: DestinationStream = {
    write: (): void => {
      // discard log output
    },
  }
  return pino({ base: { component: 'migrate' } }, sink)
}

describe('onboarding trial-credit (integration)', () => {
  let pool: Pool
  let app: Awaited<ReturnType<typeof buildApp>>
  let testIpCounter = 0
  let currentTestIp = ''

  function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({ ...opts, remoteAddress: currentTestIp })
  }

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createPgPool(databaseUrl, { max: 2 })
    await pool.query('DROP EXTENSION IF EXISTS pgcrypto CASCADE')
    await pool.query('DROP SCHEMA public CASCADE')
    await pool.query('CREATE SCHEMA public')
    await pool.query('GRANT ALL ON SCHEMA public TO PUBLIC')
    await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER')
    await runMigrations({ pool, migrationsDir: REAL_MIGRATIONS_DIR, logger: silentLogger() })

    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))

    const deps: AppDeps = {
      pg: pool,
      redisRealtime: { ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve('OK') } as unknown as Redis,
      redisBatch: { ping: () => Promise.resolve('PONG'), quit: () => Promise.resolve('OK') } as unknown as Redis,
      redisKeyPrefix: "test:use1:",
      repo: createRepo(pool),
    }
    app = await buildApp(deps, { mode: 'bypass' }, { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() })
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  beforeEach(async () => {
    testIpCounter += 1
    currentTestIp = `10.1.${String(Math.floor(testIpCounter / 256))}.${String(testIpCounter % 256)}`
    await resetData(pool)
    vi.restoreAllMocks()
    // Re-establish the classifyProfanity mock default after restoreAllMocks
    // wipes it. All trial-credit tests register with clean usernames/displays.
    classifyProfanityMock.mockResolvedValue({ profane: false })
  })

  it('grants exactly one trial credit row on successful register', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username: 'alice', displayName: 'Alice' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ user: { id: string; freeTrialUsed: boolean } }>()
    expect(body.user.freeTrialUsed).toBe(true)

    const ledger = await pool.query<{
      credit_type: string
      amount: number
      source_type: string
      source_id: string | null
      expires_at: Date | null
      source_purchase_id: string | null
      source_billing_history_id: string | null
    }>(
      `SELECT credit_type, amount, source_type, source_id, expires_at,
              source_purchase_id, source_billing_history_id
         FROM credit_ledger
        WHERE user_id = $1`,
      [body.user.id],
    )
    expect(ledger.rowCount).toBe(1)
    const row = ledger.rows[0]
    expect(row).toBeDefined()
    if (!row) throw new Error('unreachable: rowCount === 1 but row undefined')
    expect(row.credit_type).toBe('session')
    expect(row.amount).toBe(1)
    expect(row.source_type).toBe('trial')
    expect(row.source_id).toBeNull()
    expect(row.expires_at).toBeNull()
    expect(row.source_purchase_id).toBeNull()
    expect(row.source_billing_history_id).toBeNull()
  })

  it('sets free_trial_used=true on the users row', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username: 'alice', displayName: 'Alice' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ user: { id: string } }>()

    const userRow = await pool.query<{ free_trial_used: boolean }>(
      'SELECT free_trial_used FROM users WHERE id = $1',
      [body.user.id],
    )
    expect(userRow.rowCount).toBe(1)
    expect(userRow.rows[0]?.free_trial_used).toBe(true)
  })

  it('idempotent replay does NOT add a second trial credit row', async () => {
    const first = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username: 'alice', displayName: 'Alice' },
    })
    expect(first.statusCode).toBe(201)
    const firstBody = first.json<{ user: { id: string } }>()

    const replay = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username: 'alice', displayName: 'Alice' },
    })
    expect(replay.statusCode).toBe(200)

    const ledger = await pool.query<{ id: string }>(
      'SELECT id FROM credit_ledger WHERE user_id = $1',
      [firstBody.user.id],
    )
    expect(ledger.rowCount).toBe(1)
  })

  it('rolls back users INSERT if grantInTx throws', async () => {
    // Stub grantInTx so it throws AFTER the route's users.create has
    // already inserted the row. The handler's catch+ROLLBACK must undo
    // the users INSERT — at the end of this test no users row and no
    // credit_ledger row should exist for the would-be user.
    const grantSpy = vi
      .spyOn(creditsRepo, 'grantInTx')
      .mockImplementation(() => {
        throw new Error('simulated grant failure')
      })

    const res = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username: 'alice', displayName: 'Alice' },
    })
    // 500 — the simulated error is not a 23505, so the handler re-throws
    // and Fastify's default error handler returns 500.
    expect(res.statusCode).toBe(500)
    expect(grantSpy).toHaveBeenCalledOnce()

    const users = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username = 'alice'",
    )
    expect(users.rowCount).toBe(0)
    const ledger = await pool.query<{ id: string }>(
      "SELECT id FROM credit_ledger",
    )
    expect(ledger.rowCount).toBe(0)
  })
})
