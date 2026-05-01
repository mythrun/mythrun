import { type Pool, type PoolClient } from 'pg'
import { uuidv7 } from './uuidv7.js'
import { toCreditEntry, type CreditEntryDbRow } from './mappers.js'
import type { CreditEntry, CreditType, GrantInput } from './types.js'
import {
  DEBIT_LOCK_TIMEOUT_MS,
  DEBIT_STATEMENT_TIMEOUT_MS,
  UserNotFoundError,
} from './credits-errors.js'

export interface CreditsRepoOpts {
  readonly debitLockTimeoutMs?: number
  readonly debitStatementTimeoutMs?: number
}

export function createCreditsRepo(pool: Pool, opts: CreditsRepoOpts = {}) {
  const lockTimeoutMs = opts.debitLockTimeoutMs ?? DEBIT_LOCK_TIMEOUT_MS
  const stmtTimeoutMs = opts.debitStatementTimeoutMs ?? DEBIT_STATEMENT_TIMEOUT_MS

  // Multi-statement string keeps BEGIN + the three SET LOCAL statements
  // ordered correctly. SET LOCAL must follow BEGIN — see spec
  // "Atomic debit — locking strategy". Do NOT wrap in a transaction
  // helper that hoists BEGIN/COMMIT.
  const beginAndConfigure = (client: PoolClient): Promise<unknown> =>
    client.query(
      `BEGIN;
       SET LOCAL transaction_isolation = 'read committed';
       SET LOCAL lock_timeout = '${String(lockTimeoutMs)}ms';
       SET LOCAL statement_timeout = '${String(stmtTimeoutMs)}ms';`,
    )

  return {
    balance: async (userId: string, type: CreditType): Promise<number> => {
      const result = await pool.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS balance
           FROM credit_ledger
          WHERE user_id = $1
            AND credit_type = $2
            AND (expires_at IS NULL OR expires_at > now())`,
        [userId, type],
      )
      const row = result.rows[0]
      if (!row) return 0
      return Number(row.balance)
    },

    grant: async (input: GrantInput): Promise<CreditEntry> => {
      if (input.amount <= 0) {
        throw new Error('grant: amount must be > 0')
      }
      // Type system already excludes 'debit' from sourceType, but a caller
      // passing through `any` could still violate. Belt-and-suspenders.
      if ((input.sourceType as string) === 'debit') {
        throw new Error('grant: sourceType cannot be "debit" — use atomicDebit')
      }

      const client = await pool.connect()
      let inTransaction = false
      try {
        await beginAndConfigure(client)
        inTransaction = true

        const userCheck = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [input.userId],
        )
        if (userCheck.rowCount === 0) {
          await client.query('ROLLBACK')
          inTransaction = false
          throw new UserNotFoundError(input.userId)
        }

        const id = uuidv7()
        const result = await client.query<CreditEntryDbRow>(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            id,
            input.userId,
            input.creditType,
            input.amount,
            input.sourceType,
            input.sourceId ?? null,
            input.expiresAt ?? null,
          ],
        )
        await client.query('COMMIT')
        inTransaction = false

        const row = result.rows[0]
        if (!row) throw new Error('grant: INSERT returned no row')
        return toCreditEntry(row)
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Ignore — connection may already be in failed state.
          }
        }
        throw err
      } finally {
        client.release()
      }
    },
  }
}

export type CreditsRepo = ReturnType<typeof createCreditsRepo>
