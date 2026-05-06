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
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE cognito_sub = $1', [sub])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    getByCognitoSubWithTimeout: async (sub: string, statementTimeoutMs: number): Promise<User | null> => {
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

        const result = await client.query<UserDbRow>(
          'SELECT * FROM users WHERE cognito_sub = $1',
          [sub],
        )
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
