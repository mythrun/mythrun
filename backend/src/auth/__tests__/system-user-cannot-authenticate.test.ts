// backend/src/auth/__tests__/system-user-cannot-authenticate.test.ts
//
// myth-ficc regression pin. The SYSTEM user (`cognito_sub = 'system:mythrun'`)
// owns the demo world and MUST never authenticate. It is held out by a 1970
// sentinel in `suspended_at` — i.e. by the ordinary suspension machinery, with
// no name-based special case anywhere — so the invariant only holds as long as
// every auth surface actually gates on suspension.
//
// This test drives the REAL seeded row (from global-setup) through the REAL
// plugin, rather than asserting the two halves separately and inferring the
// join: sibling coverage in require-onboarded.test.ts mocks the repo, so a
// change to the seeded sentinel — or to the users lookup — would not show up
// there. Read-only: it mutates nothing, so it needs no scoped fixture.

import Fastify, { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { guardTestDatabase } from '../../db/__tests__/guard-db.js'
import { createTestPool } from '../../repo/__tests__/_helpers/test-pool.js'
import { createRepo } from '../../repo/index.js'
import { requireOnboarded } from '../require-onboarded.js'

const databaseUrl = process.env.DATABASE_URL ?? ''
const SYSTEM_SUB = 'system:mythrun'

/** Stand-in for the upstream JWT plugin: it declares the real plugin name and
 *  attaches the claims a verified token would carry. The point of the test is
 *  that a VALID token for the system user still gets nowhere. */
function fakeJwtPlugin(sub: string) {
  return fp(
    // eslint-disable-next-line @typescript-eslint/require-await
    async (app) => {
      // eslint-disable-next-line @typescript-eslint/require-await
      app.addHook('preHandler', async (request) => {
        ;(
          request as unknown as {
            user?: { sub: string; cognitoUsername: string; scopes: readonly string[] }
          }
        ).user = { sub, cognitoUsername: 'system', scopes: [] }
      })
    },
    { fastify: '5.x', name: 'mythrun-auth-jwt' },
  )
}

describe('the SYSTEM user cannot authenticate (myth-ficc)', () => {
  let pool: Pool
  let app: FastifyInstance | undefined
  let systemUserId: string

  beforeAll(async () => {
    await guardTestDatabase(databaseUrl)
    pool = createTestPool(databaseUrl)
    const { rows } = await pool.query<{ id: string; suspended_at: Date | null }>(
      'SELECT id, suspended_at FROM users WHERE cognito_sub = $1',
      [SYSTEM_SUB],
    )
    const row = rows[0]
    if (!row) throw new Error('system user is not seeded; global-setup should have inserted it')
    systemUserId = row.id
    // The sentinel itself — if this ever becomes NULL the holdout is gone and
    // every assertion below would pass for the wrong reason.
    expect(row.suspended_at).toBeInstanceOf(Date)
    expect(row.suspended_at?.getUTCFullYear()).toBe(1970)
  })

  afterAll(async () => {
    if (app) await app.close()
    await pool.end()
  })

  it('is rejected 403 account_suspended by requireOnboarded, holding a valid token', async () => {
    app = Fastify({ logger: false })
    await app.register(fakeJwtPlugin(SYSTEM_SUB))
    await app.register(requireOnboarded, { pool })
    app.get('/check', () => ({ ok: true }))

    const res = await app.inject({ method: 'GET', url: '/check' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ code: 'account_suspended' })
  })

  it('is reported suspended by the predicate the WS surfaces gate on', async () => {
    // The same answer on the transport side: the WS handshake and the per-frame
    // gate both ask this, so a socket for the system user can never open.
    const repo = createRepo(pool)
    await expect(repo.users.isSuspended(systemUserId)).resolves.toBe(true)
  })
})
