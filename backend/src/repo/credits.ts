import { type Pool } from 'pg'
import type { CreditType } from './types.js'

export interface CreditsRepoOpts {
  readonly debitLockTimeoutMs?: number
  readonly debitStatementTimeoutMs?: number
}

export function createCreditsRepo(pool: Pool, _opts: CreditsRepoOpts = {}) {
  void _opts // reserved for Task 6 (debit lock/statement timeouts)
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
  }
}

export type CreditsRepo = ReturnType<typeof createCreditsRepo>
