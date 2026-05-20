import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import {
  createUsersRepo,
  findOrCreateStripeCustomer,
  LookupTimeoutError,
  type StripeCustomersClient,
} from '../users.js'
import type { ClientLike } from '../_types.js'
import { ensureSchema, pool } from './_helpers/with-tx.js'
import { cleanupTestScope, makeTestScope, type TestScope } from './_helpers/test-scope.js'

describe('users repo (integration)', () => {
  let scope: TestScope
  let baseInput: { cognitoSub: string; username: string; displayName: string }

  beforeAll(async () => {
    await ensureSchema()
    // myth-5jdo: short label (<= 10 chars) — username helper truncates at 28
    // chars total; long labels collide on multi-user tests.
    scope = makeTestScope('users')
    baseInput = {
      cognitoSub: scope.userSub(0),
      username: scope.username(0),
      displayName: scope.displayName(0),
    }
  })

  afterAll(async () => {
    // myth-5jdo: cleanup only this scope's rows; the seeded dev users
    // + system user + demo world remain intact for the next test file.
    await cleanupTestScope(pool, scope)
  })

  it('create defensively throws when INSERT returns no row (fake tx)', async () => {
    const repo = createUsersRepo(pool)
    const fakeTx = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    }
    await expect(
      repo.create(fakeTx as unknown as ClientLike, { cognitoSub: 'x', username: 'x', displayName: 'X' }),
    ).rejects.toThrow(/INSERT returned no row/)
  })

  it('create returns a fully-populated user row', async () => {
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    const u = await repo.create(pool, baseInput)
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.cognitoSub).toBe(baseInput.cognitoSub)
    expect(u.displayName).toBe(baseInput.displayName)
    expect(u.username).toBe(baseInput.username)
    expect(u.stripeCustomerId).toBeNull()
    expect(u.freeTrialUsed).toBe(false)
    expect(u.suspendedAt).toBeNull()
    expect(u.createdAt).toBeInstanceOf(Date)
    expect(u.updatedAt).toBeInstanceOf(Date)
  })

  it('getById returns the user when present', async () => {
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    const created = await repo.create(pool, baseInput)
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
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    await repo.create(pool, baseInput)
    const u = await repo.getByCognitoSub(baseInput.cognitoSub)
    expect(u).not.toBeNull()
    expect(u?.username).toBe(baseInput.username)
  })

  it('getByCognitoSub returns null for unknown sub', async () => {
    const repo = createUsersRepo(pool)
    // Use a scope-prefixed sub that definitely doesn't exist (nothing inserted
    // with index 99 in this test).
    const u = await repo.getByCognitoSub(scope.userSub(99))
    expect(u).toBeNull()
  })

  it('update mutates supplied fields and bumps updatedAt', async () => {
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    const created = await repo.create(pool, baseInput)
    await new Promise((r) => setTimeout(r, 5))
    const updated = await repo.update(created.id, { displayName: 'Alicia' })
    expect(updated.displayName).toBe('Alicia')
    expect(updated.username).toBe(baseInput.username)
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('update with all-undefined patch is a no-op (except updatedAt)', async () => {
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    const created = await repo.create(pool, baseInput)
    await new Promise((r) => setTimeout(r, 5))
    const updated = await repo.update(created.id, {})
    expect(updated.displayName).toBe(created.displayName)
    expect(updated.username).toBe(created.username)
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('update throws when the user does not exist', async () => {
    const repo = createUsersRepo(pool)
    await expect(
      repo.update('019dccef-0000-7000-8000-000000000000', { displayName: 'X' }),
    ).rejects.toThrow(/no user with id/)
  })

  it('getByUsername is case-insensitive', async () => {
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    // Mixed-case variant: scope.username is lowercase alphanum, so uppercasing
    // the first char produces a CHECK-valid mixed-case username that still
    // matches the same row case-insensitively.
    const mixed = baseInput.username.charAt(0).toUpperCase() + baseInput.username.slice(1)
    await repo.create(pool, { ...baseInput, username: mixed })
    expect(await repo.getByUsername(mixed.toUpperCase())).not.toBeNull()
    expect(await repo.getByUsername(mixed.toLowerCase())).not.toBeNull()
    expect((await repo.getByUsername(mixed.toLowerCase()))?.username).toBe(mixed)
  })

  it('getByUsername returns null for unknown username', async () => {
    const repo = createUsersRepo(pool)
    expect(await repo.getByUsername(scope.username(99))).toBeNull()
  })

  it('UNIQUE LOWER(username) rejects case-variant duplicates', async () => {
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    const mixed = baseInput.username.charAt(0).toUpperCase() + baseInput.username.slice(1)
    await repo.create(pool, { ...baseInput, username: mixed })
    await expect(
      repo.create(pool, { ...baseInput, cognitoSub: scope.userSub(1), username: mixed.toLowerCase() }),
    ).rejects.toThrow(/users_username_lower_key|duplicate key/)
  })

  it('getByCognitoSubWithTimeout returns the user under normal load', async () => {
    await cleanupTestScope(pool, scope)
    const repo = createUsersRepo(pool)
    const u = await repo.create(pool, baseInput)
    const found = await repo.getByCognitoSubWithTimeout(u.cognitoSub, 200)
    expect(found?.id).toBe(u.id)
  })

  it('getByCognitoSubWithTimeout returns null for unknown sub', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.getByCognitoSubWithTimeout(scope.userSub(99), 200)
    expect(u).toBeNull()
  })

  it('getByCognitoSubWithTimeout maps pg statement_timeout (57014) to LookupTimeoutError', async () => {
    // Drive the catch branch with a fake pool whose client.query throws a pg
    // error carrying code='57014' on the SELECT step. The function must
    // (a) issue ROLLBACK (we accept that silently), and (b) rethrow as
    // LookupTimeoutError.
    const fakePool = {
      connect: (): Promise<PoolClient> => {
        const fake = {
          query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
            const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
            if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
            if (sql.includes('SELECT * FROM users')) {
              const err = Object.assign(new Error('statement timeout'), { code: '57014' })
              return Promise.reject(err)
            }
            if (sql.startsWith('ROLLBACK')) return Promise.resolve({ rows: [], rowCount: 0 })
            return Promise.resolve({ rows: [], rowCount: 0 })
          },
          release: () => {
            /* no-op */
          },
        }
        return Promise.resolve(fake as unknown as PoolClient)
      },
    } as unknown as Pool
    const repo = createUsersRepo(fakePool)
    await expect(repo.getByCognitoSubWithTimeout('any-sub', 10)).rejects.toBeInstanceOf(
      LookupTimeoutError,
    )
  })

  it('getByCognitoSubWithTimeout swallows a ROLLBACK error and rethrows the original', async () => {
    // Fake pool whose SELECT rejects with a non-timeout error AND whose
    // ROLLBACK also rejects. The function must swallow the ROLLBACK failure
    // and rethrow the original SELECT error verbatim (not LookupTimeoutError).
    const fakePool = {
      connect: (): Promise<PoolClient> => {
        const fake = {
          query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
            const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
            if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
            if (sql.includes('SELECT * FROM users')) {
              return Promise.reject(new Error('select exploded'))
            }
            if (sql.startsWith('ROLLBACK')) {
              return Promise.reject(new Error('rollback also exploded'))
            }
            return Promise.resolve({ rows: [], rowCount: 0 })
          },
          release: () => {
            /* no-op */
          },
        }
        return Promise.resolve(fake as unknown as PoolClient)
      },
    } as unknown as Pool
    const repo = createUsersRepo(fakePool)
    await expect(repo.getByCognitoSubWithTimeout('any-sub', 10)).rejects.toThrow(/select exploded/)
  })

  describe('findOrCreateStripeCustomer', () => {
    function makeStripeCustomersStub(returnId: string): {
      client: StripeCustomersClient
      create: ReturnType<typeof vi.fn>
    } {
      const create = vi.fn().mockResolvedValue({ id: returnId })
      const client: StripeCustomersClient = { customers: { create } }
      return { client, create }
    }

    it('creates a Stripe customer and persists the cus_* on first call', async () => {
      await cleanupTestScope(pool, scope)
      const repo = createUsersRepo(pool)
      const created = await repo.create(pool, baseInput)
      const { client, create } = makeStripeCustomersStub('cus_test_A')

      const cusId = await findOrCreateStripeCustomer(pool, client, created.id)

      expect(cusId).toBe('cus_test_A')
      const after = await repo.getById(created.id)
      expect(after?.stripeCustomerId).toBe('cus_test_A')
      expect(create).toHaveBeenCalledTimes(1)
      expect(create).toHaveBeenCalledWith(
        { metadata: { userId: created.id } },
        { idempotencyKey: `customer_for_${created.id}` },
      )
    })

    it('returns the existing stripe_customer_id without calling Stripe', async () => {
      await cleanupTestScope(pool, scope)
      const repo = createUsersRepo(pool)
      const created = await repo.create(pool, baseInput)
      await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [
        created.id,
        'cus_existing',
      ])

      const create = vi.fn().mockImplementation(() => {
        throw new Error('stripe.customers.create should not be called')
      })
      const client: StripeCustomersClient = { customers: { create } }

      const cusId = await findOrCreateStripeCustomer(pool, client, created.id)

      expect(cusId).toBe('cus_existing')
      expect(create).not.toHaveBeenCalled()
    })

    it('race-loser branch: returns concurrent racer value when written between phase 2 and phase 3', async () => {
      await cleanupTestScope(pool, scope)
      const repo = createUsersRepo(pool)
      const created = await repo.create(pool, baseInput)

      // Stripe stub: when create is called, simulate a concurrent racer that
      // already wrote a different cus_* value to the row before this call's
      // Phase-3 lock can take effect.
      const create = vi.fn().mockImplementation(async () => {
        await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [
          created.id,
          'cus_concurrent_racer',
        ])
        return { id: 'cus_test_loser' }
      })
      const client: StripeCustomersClient = { customers: { create } }

      const cusId = await findOrCreateStripeCustomer(pool, client, created.id)

      expect(cusId).toBe('cus_concurrent_racer')
      const after = await repo.getById(created.id)
      expect(after?.stripeCustomerId).toBe('cus_concurrent_racer')
      // The Stripe call still happened — its returned cus_test_loser is now
      // an orphan customer (documented gap per spec §9 line 1201).
      expect(create).toHaveBeenCalledTimes(1)
    })

    it('uses customer_for_${userId} as the Stripe idempotency-key', async () => {
      await cleanupTestScope(pool, scope)
      const repo = createUsersRepo(pool)
      const created = await repo.create(pool, baseInput)
      const { client, create } = makeStripeCustomersStub('cus_test_B')

      await findOrCreateStripeCustomer(pool, client, created.id)

      const callArgs = create.mock.calls[0]
      expect(callArgs?.[1]).toEqual({ idempotencyKey: `customer_for_${created.id}` })
    })

    it('throws when the users row does not exist', async () => {
      const { client, create } = makeStripeCustomersStub('cus_test_C')
      await expect(
        findOrCreateStripeCustomer(pool, client, '019dccef-0000-7000-8000-000000000000'),
      ).rejects.toThrow(/users row not found/)
      expect(create).not.toHaveBeenCalled()
    })

    it('phase-3 rollback path: SELECT FOR UPDATE failure triggers ROLLBACK + rethrow', async () => {
      // Real pool serves the phase-1 SELECT (existing row found via the real users
      // table). For phase-3 we wrap pool.connect so the client's query rejects on
      // SELECT FOR UPDATE and ROLLBACK succeeds — the function must rethrow the
      // original SELECT FOR UPDATE error.
      await cleanupTestScope(pool, scope)
      const repo = createUsersRepo(pool)
      const created = await repo.create(pool, baseInput)
      const { client: stripe } = makeStripeCustomersStub('cus_test_D')

      // Spy on pool.connect — return a fake client whose query rejects on the
      // SELECT FOR UPDATE statement. Other statements behave benignly.
      const fakePool = {
        query: pool.query.bind(pool),
        connect: (): Promise<PoolClient> => {
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.includes('FOR UPDATE')) {
                return Promise.reject(new Error('select-for-update exploded'))
              }
              if (sql.startsWith('ROLLBACK')) return Promise.resolve({ rows: [], rowCount: 0 })
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool

      await expect(findOrCreateStripeCustomer(fakePool, stripe, created.id)).rejects.toThrow(
        /select-for-update exploded/,
      )
    })

    it('phase-3 rollback failure is swallowed; original error still rethrown', async () => {
      await cleanupTestScope(pool, scope)
      const repo = createUsersRepo(pool)
      const created = await repo.create(pool, baseInput)
      const { client: stripe } = makeStripeCustomersStub('cus_test_E')

      const fakePool = {
        query: pool.query.bind(pool),
        connect: (): Promise<PoolClient> => {
          const fake = {
            query: (sqlOrConfig: unknown): Promise<{ rows: unknown[]; rowCount: number }> => {
              const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : ''
              if (sql.startsWith('BEGIN')) return Promise.resolve({ rows: [], rowCount: 0 })
              if (sql.includes('FOR UPDATE')) {
                return Promise.reject(new Error('original-phase3-error'))
              }
              if (sql.startsWith('ROLLBACK')) {
                return Promise.reject(new Error('rollback exploded too'))
              }
              return Promise.resolve({ rows: [], rowCount: 0 })
            },
            release: () => {
              /* no-op */
            },
          }
          return Promise.resolve(fake as unknown as PoolClient)
        },
      } as unknown as Pool

      await expect(findOrCreateStripeCustomer(fakePool, stripe, created.id)).rejects.toThrow(
        /original-phase3-error/,
      )
    })
  })
})
