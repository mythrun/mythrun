import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  createUsersRepo,
  findOrCreateStripeCustomer,
  type StripeCustomersClient,
} from '../users.js'
import { resetData } from './_helpers/reset-data.js'
import { ensureSchema, pool } from './_helpers/with-tx.js'

describe('users repo (integration)', () => {
  beforeAll(async () => {
    await ensureSchema()
  })

  beforeEach(async () => {
    await resetData(pool)
  })

  const baseInput = {
    cognitoSub: 'google_12345',
    username: 'alice',
    displayName: 'Alice',
  }

  it('create returns a fully-populated user row', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.create(pool, baseInput)
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.cognitoSub).toBe('google_12345')
    expect(u.displayName).toBe('Alice')
    expect(u.username).toBe('alice')
    expect(u.stripeCustomerId).toBeNull()
    expect(u.freeTrialUsed).toBe(false)
    expect(u.suspendedAt).toBeNull()
    expect(u.createdAt).toBeInstanceOf(Date)
    expect(u.updatedAt).toBeInstanceOf(Date)
  })

  it('getById returns the user when present', async () => {
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
    const repo = createUsersRepo(pool)
    await repo.create(pool, baseInput)
    const u = await repo.getByCognitoSub('google_12345')
    expect(u).not.toBeNull()
    expect(u?.username).toBe('alice')
  })

  it('getByCognitoSub returns null for unknown sub', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.getByCognitoSub('nope')
    expect(u).toBeNull()
  })

  it('update mutates supplied fields and bumps updatedAt', async () => {
    const repo = createUsersRepo(pool)
    const created = await repo.create(pool, baseInput)
    await new Promise((r) => setTimeout(r, 5))
    const updated = await repo.update(created.id, { displayName: 'Alicia' })
    expect(updated.displayName).toBe('Alicia')
    expect(updated.username).toBe('alice')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
  })

  it('update with all-undefined patch is a no-op (except updatedAt)', async () => {
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
    await expect(repo.update('019dccef-0000-7000-8000-000000000000', { displayName: 'X' })).rejects.toThrow(
      /no user with id/,
    )
  })

  it('getByUsername is case-insensitive', async () => {
    const repo = createUsersRepo(pool)
    await repo.create(pool, { ...baseInput, username: 'Gandalf' })
    expect(await repo.getByUsername('GANDALF')).not.toBeNull()
    expect(await repo.getByUsername('gandalf')).not.toBeNull()
    expect((await repo.getByUsername('gandalf'))?.username).toBe('Gandalf')
  })

  it('UNIQUE LOWER(username) rejects case-variant duplicates', async () => {
    const repo = createUsersRepo(pool)
    await repo.create(pool, { ...baseInput, username: 'Admin' })
    await expect(
      repo.create(pool, { ...baseInput, cognitoSub: 'google_xyz', username: 'admin' }),
    ).rejects.toThrow(/users_username_lower_key|duplicate key/)
  })

  it('getByCognitoSubWithTimeout returns the user under normal load', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.create(pool, baseInput)
    const found = await repo.getByCognitoSubWithTimeout(u.cognitoSub, 200)
    expect(found?.id).toBe(u.id)
  })

  it('getByCognitoSubWithTimeout returns null for unknown sub', async () => {
    const repo = createUsersRepo(pool)
    const u = await repo.getByCognitoSubWithTimeout('nope', 200)
    expect(u).toBeNull()
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
      const repo = createUsersRepo(pool)
      const created = await repo.create(pool, baseInput)

      // Stripe stub: when create is called, simulate a concurrent racer that
      // already wrote a different cus_* value to the row before this call's
      // Phase-3 lock can take effect.
      const create = vi.fn().mockImplementation(async () => {
        await pool.query(
          'UPDATE users SET stripe_customer_id = $2 WHERE id = $1',
          [created.id, 'cus_concurrent_racer'],
        )
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
  })
})
