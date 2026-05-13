import { type Pool, type PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toUser, type UserDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import type { CreateUserInput, User, UserUpdate } from './types.js'

export class LookupTimeoutError extends Error {
  readonly code = 'LOOKUP_TIMEOUT'
  constructor(readonly cognitoSub: string) {
    super(`getByCognitoSubWithTimeout exceeded statement_timeout for sub=${cognitoSub}`)
    this.name = 'LookupTimeoutError'
  }
}

export function createUsersRepo(pool: Pool) {
  return {
    create: async (tx: ClientLike, input: CreateUserInput): Promise<User> => {
      const id = uuidv7()
      const result = await tx.query<UserDbRow>(
        `INSERT INTO users (id, cognito_sub, username, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, input.cognitoSub, input.username, input.displayName],
      )
      const row = result.rows[0]
      if (!row) throw new Error('users.create: INSERT returned no row')
      return toUser(row)
    },

    getById: async (id: string): Promise<User | null> => {
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE id = $1', [id])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    getByCognitoSub: async (sub: string): Promise<User | null> => {
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE cognito_sub = $1', [
        sub,
      ])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    getByCognitoSubWithTimeout: async (
      sub: string,
      statementTimeoutMs: number,
    ): Promise<User | null> => {
      const client: PoolClient = await pool.connect()
      let inTransaction = false
      try {
        // SET LOCAL is transaction-scoped; outside a tx it's a no-op.
        // Wrap the read in BEGIN/COMMIT so the timeout actually applies.
        await client.query(
          `BEGIN;
           SET LOCAL statement_timeout = '${String(statementTimeoutMs)}ms';`,
        )
        inTransaction = true

        const result = await client.query<UserDbRow>('SELECT * FROM users WHERE cognito_sub = $1', [
          sub,
        ])
        await client.query('COMMIT')
        inTransaction = false

        const row = result.rows[0]
        return row ? toUser(row) : null
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Ignore — connection may already be in failed state.
          }
        }
        if (typeof err === 'object' && err !== null && 'code' in err) {
          if ((err as { code?: string }).code === '57014') {
            throw new LookupTimeoutError(sub)
          }
        }
        throw err
        /* c8 ignore next — v8 finally-boundary quirk; both paths tested. */
      } finally {
        client.release()
      }
    },

    getByUsername: async (username: string): Promise<User | null> => {
      // Case-insensitive: matches the UNIQUE LOWER(username) index from migration 005.
      const result = await pool.query<UserDbRow>(
        'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
        [username],
      )
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    update: async (id: string, patch: UserUpdate): Promise<User> => {
      const result = await pool.query<UserDbRow>(
        `UPDATE users
            SET username           = COALESCE($2, username),
                display_name       = COALESCE($3, display_name),
                stripe_customer_id = COALESCE($4, stripe_customer_id),
                free_trial_used    = COALESCE($5, free_trial_used),
                updated_at         = now()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.username ?? null,
          patch.displayName ?? null,
          patch.stripeCustomerId ?? null,
          patch.freeTrialUsed ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error(`users.update: no user with id ${id}`)
      return toUser(row)
    },
  }
}

/**
 * Narrowed shape of the Stripe customers resource consumed by
 * `findOrCreateStripeCustomer`. Defined here (rather than importing the full
 * `Stripe` type) so tests can supply a stub without resorting to `as unknown
 * as Stripe` casts. The runtime `Stripe` instance from the SDK satisfies this
 * structurally — pass it as-is.
 */
export interface StripeCustomersClient {
  readonly customers: {
    create(
      params: { metadata: { userId: string } },
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
}

/**
 * Resolve the Stripe customer ID for a user, creating one on first use.
 *
 * Three-phase prefetch-then-write pattern (per spec §9, lines 1146–1186):
 *
 *   Phase 1 — short tx: read the existing `stripe_customer_id`. If non-null,
 *             return it immediately. No lock; the connection releases on
 *             return.
 *
 *   Phase 2 — outside any DB tx: call `stripe.customers.create` with a
 *             deterministic idempotency-key (`customer_for_${userId}`). The
 *             Stripe call's latency (100–500ms typical, multi-second tail
 *             under outage) MUST NOT happen inside a held lock; concurrent
 *             callers all hit the same Stripe-side customer record via the
 *             idempotency-key cache.
 *
 *   Phase 3 — short tx with full MYT-40 timeout discipline (per round-5
 *             Petra C3): `BEGIN; SET LOCAL transaction_isolation = 'read
 *             committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL
 *             statement_timeout = '5s'`. Re-read the row `FOR UPDATE` to
 *             serialize against concurrent racers. If a racer wrote first,
 *             return their value (the `cus_*` we just created from Stripe
 *             becomes an orphan — Stripe-side cleanup is documented as a
 *             known gap). Otherwise UPDATE with our `cus_*` and return it.
 *
 * The multi-statement `BEGIN; SET LOCAL ...` triple is issued as a single
 * `client.query(...)` — pg's simple-query mode handles the semicolon-
 * separated batch, and SET LOCAL only takes effect inside the transaction
 * opened by the leading BEGIN.
 */
export async function findOrCreateStripeCustomer(
  pool: Pool,
  stripe: StripeCustomersClient,
  userId: string,
): Promise<string> {
  // Phase 1 — short tx: read existing value; release immediately.
  const phase1 = await pool.query<{ stripe_customer_id: string | null }>(
    'SELECT stripe_customer_id FROM users WHERE id = $1',
    [userId],
  )
  if (phase1.rows.length === 0) {
    throw new Error(`findOrCreateStripeCustomer: users row not found for userId=${userId}`)
  }
  const existing = phase1.rows[0]?.stripe_customer_id
  if (existing) return existing

  // Phase 2 — outside any DB tx: Stripe API call. Idempotency-keyed, so
  // concurrent callers all hit the same Stripe-side customer record (Stripe's
  // idempotency cache dedupes within 24h); the DB-side write phase below
  // picks one canonical winner.
  const customer = await stripe.customers.create(
    { metadata: { userId } },
    { idempotencyKey: `customer_for_${userId}` },
  )
  const cusId = customer.id

  // Phase 3 — short tx: serialized write with FOR UPDATE to handle concurrent
  // racers. The lock is held only across two short DB ops (re-read + UPDATE);
  // no Stripe call happens inside this tx, so MYT-40's full timeout discipline
  // applies — all three SET LOCALs (transaction_isolation + lock_timeout +
  // statement_timeout) are set, identical to atomicDebit's recipe.
  const client = await pool.connect()
  try {
    await client.query(
      "BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'",
    )
    const phase3 = await client.query<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    )
    const racewinner = phase3.rows[0]?.stripe_customer_id
    if (racewinner) {
      // A concurrent caller wrote first within Stripe's 24h idempotency
      // window. Use the persisted value; the cus_* we created moments ago
      // becomes a Stripe-side orphan (documented gap).
      await client.query('COMMIT')
      return racewinner
    }
    await client.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [userId, cusId])
    await client.query('COMMIT')
    return cusId
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Ignore — connection may already be in a failed state.
    }
    throw err
    /* c8 ignore next — v8 finally-boundary quirk; both paths tested. */
  } finally {
    client.release()
  }
}
