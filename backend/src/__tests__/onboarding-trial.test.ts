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
//
// Phase-4 wave-4d (myth-oehx): migrated from resetData() to scoped
// fixtures. Each test sends a unique sub via the `x-mythrun-dev-sub`
// header so credit_ledger / users rows from sibling tests don't pile up
// on the shared `bypass:dev-1` default sub. The atomicity test still
// asserts "no users row" — it queries by the scope-prefixed username,
// not by the literal `alice`, to avoid colliding with any other test
// file that may also have inserted an `alice`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pino, { type DestinationStream } from 'pino'
import type { Pool } from 'pg'
import IoredisMock from 'ioredis-mock'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'

vi.mock('../llm/profanity.js', () => ({
  classifyProfanity: vi.fn(),
}))

import { createPgPool } from '../db/postgres.js'
import { runMigrations } from '../db/migrate.js'
import { guardTestDatabase } from '../db/__tests__/guard-db.js'
import {
  cleanupTestScope,
  makeTestScope,
  type ScopedSub,
} from '../repo/__tests__/_helpers/test-scope.js'
import { buildApp } from '../app.js'
import type { AppDeps } from '../app-deps.js'
import { createRepo } from '../repo/index.js'
import * as creditsRepo from '../repo/credits.js'
import { classifyProfanity } from '../llm/profanity.js'
import { makeStubEnv } from './helpers/stub-env.js'
import { noopWorldGenQueue } from './helpers/stub-deps.js'

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
  // Label kept short ('trial'): scope.username(n) is computed as
  // `${id-with-dashes-stripped}u${n}` and must fit the route's
  // ^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$ regex (max 20 chars).
  // The id is `tst-${label}-${rand8}` = 4 + len(label) + 8 = 12+len(label),
  // so label budget is 6 chars (12 + 6 + 'u' + 1-digit-index = 20).
  const scope = makeTestScope('trial')
  let testIpCounter = 0
  let currentTestIp = ''
  let currentTestSub: ScopedSub = scope.userSub(0)

  function inject(opts: InjectOptions): Promise<LightMyRequestResponse> {
    return app.inject({
      ...opts,
      remoteAddress: currentTestIp,
      headers: { ...(opts.headers ?? {}), 'x-mythrun-dev-sub': currentTestSub },
    })
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
      redisRealtime: new IoredisMock(),
      redisBatch: new IoredisMock(),
      redisKeyPrefix: 'test:use1:',
      repo: createRepo(pool),
      worldGenQueue: noopWorldGenQueue(),
    }
    app = await buildApp(
      deps,
      { mode: 'bypass' },
      { frontendBaseUrl: 'http://localhost:5173', env: makeStubEnv() },
    )
  })

  afterAll(async () => {
    await app.close()
    // credit_ledger is RESTRICT-FK to users; cleanupTestScope handles
    // that ordering. The trial-credit row has source_purchase_id NULL +
    // source_billing_history_id NULL (the atomicity test stubs out the
    // grant call before any purchase / billing-history row would be
    // created), so no satellite-FK cleanup is required here.
    await cleanupTestScope(pool, scope)
    await pool.end()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    testIpCounter += 1
    currentTestIp = `10.1.${String(Math.floor(testIpCounter / 256))}.${String(testIpCounter % 256)}`
    currentTestSub = scope.userSub(testIpCounter * 2)
    vi.restoreAllMocks()
    // Re-establish the classifyProfanity mock default after restoreAllMocks
    // wipes it. All trial-credit tests register with clean usernames/displays.
    classifyProfanityMock.mockResolvedValue({ profane: false })
  })

  it('grants exactly one trial credit row on successful register', async () => {
    const username = scope.username(testIpCounter * 2)
    const res = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username, displayName: scope.displayName(testIpCounter * 2) },
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
    const username = scope.username(testIpCounter * 2)
    const res = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username, displayName: scope.displayName(testIpCounter * 2) },
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
    const username = scope.username(testIpCounter * 2)
    const displayName = scope.displayName(testIpCounter * 2)
    const first = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username, displayName },
    })
    expect(first.statusCode).toBe(201)
    const firstBody = first.json<{ user: { id: string } }>()

    const replay = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username, displayName },
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
    const grantSpy = vi.spyOn(creditsRepo, 'grantInTx').mockImplementation(() => {
      throw new Error('simulated grant failure')
    })

    const username = scope.username(testIpCounter * 2)
    const res = await inject({
      method: 'POST',
      url: '/api/users/register',
      payload: { username, displayName: scope.displayName(testIpCounter * 2) },
    })
    // 500 — the simulated error is not a 23505, so the handler re-throws
    // and Fastify's default error handler returns 500.
    expect(res.statusCode).toBe(500)
    expect(grantSpy).toHaveBeenCalledOnce()

    // Query by scope-prefixed username to avoid false-positive matches
    // against any sibling test file that registers a literal `alice`.
    const users = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE username = $1',
      [username],
    )
    expect(users.rowCount).toBe(0)
    // And likewise scope the credit_ledger probe to only this scope's
    // users — there's no users row joined to this test's sub anyway,
    // but a global SELECT id FROM credit_ledger would conflate this
    // test's "no rollback orphan" assertion with any other scope's
    // trial-credit row.
    const ledger = await pool.query<{ id: string }>(
      `SELECT id FROM credit_ledger
         WHERE user_id IN (SELECT id FROM users WHERE cognito_sub = $1)`,
      [currentTestSub],
    )
    expect(ledger.rowCount).toBe(0)
  })
})
