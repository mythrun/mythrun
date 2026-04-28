import { type Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { type CreateUserInput, type User, type UserUpdate } from './types.js'
import { toUser, type UserDbRow } from './mappers.js'

export function createUsersRepo(pool: Pool) {
  return {
    create: async (input: CreateUserInput): Promise<User> => {
      const id = uuidv7()
      const result = await pool.query<UserDbRow>(
        `INSERT INTO users (id, cognito_sub, email, display_name, username, avatar_url, auth_provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
          input.cognitoSub,
          input.email,
          input.displayName,
          input.username,
          input.avatarUrl ?? null,
          input.authProvider,
        ],
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

    getByEmail: async (email: string): Promise<User | null> => {
      const result = await pool.query<UserDbRow>('SELECT * FROM users WHERE email = $1', [email])
      const row = result.rows[0]
      return row ? toUser(row) : null
    },

    update: async (id: string, patch: UserUpdate): Promise<User> => {
      const result = await pool.query<UserDbRow>(
        `UPDATE users
            SET display_name       = COALESCE($2, display_name),
                username           = COALESCE($3, username),
                avatar_url         = COALESCE($4, avatar_url),
                stripe_customer_id = COALESCE($5, stripe_customer_id),
                free_trial_used    = COALESCE($6, free_trial_used),
                updated_at         = now()
          WHERE id = $1
          RETURNING *`,
        [
          id,
          patch.displayName ?? null,
          patch.username ?? null,
          patch.avatarUrl ?? null,
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
