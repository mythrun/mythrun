// backend/src/repo/credit-grants.ts
//
// MYT-51 Task 11. Repo helper for `source_type='admin'` credit grants
// driven by the dev-only POST /api/dev/credits/grant route (spec D13).
//
// Lives in a sibling module to `credits.ts` rather than as another method
// on `createCreditsRepo` because (a) `admin` is intentionally excluded
// from the `CreditSourceType` union — the production `grant` surface
// must not accept it — and (b) the dev-only route's persistence shape
// is fixed (`source_id=NULL`, `expires_at=NULL`, both FKs NULL), with no
// idempotency / clawback / trial-burn semantics; a focused helper keeps
// those production-only concerns from leaking into the dev path.
//
// The route layer enforces:
//   - AUTH_MODE === 'bypass' (registration-time gate)
//   - amount cap (Zod max(100), positive integer)
//   - 30/hour per-IP rate limit
// This module's only job is the typed INSERT. Migration 012 admits
// `source_type='admin'` in both the column whitelist and the table-level
// FK-shape CASE.

import type { Pool } from 'pg'
import { uuidv7 } from './uuidv7.js'
import type { CreditType } from './types.js'

export interface InsertCreditGrantInput {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number
}

export interface InsertCreditGrantResult {
  readonly ledgerId: string
  readonly newBalance: number
}

/**
 * Insert a positive-amount `source_type='admin'` row in `credit_ledger`
 * and return the new (unexpired) balance for `(userId, creditType)`.
 *
 * Runs inside a transaction so the INSERT and the subsequent SUM read
 * see a consistent snapshot — without the BEGIN/COMMIT a concurrent
 * grant or debit could land between the two statements and the returned
 * `newBalance` would diverge from the row we just wrote.
 *
 * No idempotency key, no trial-burn, no clawback semantics — those are
 * production surfaces in `credits.ts`. This helper is the dev-only path.
 */
export async function insertCreditGrant(
  pool: Pool,
  input: InsertCreditGrantInput,
): Promise<InsertCreditGrantResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error('insertCreditGrant: amount must be a positive integer')
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const id = uuidv7()
    await client.query(
      `INSERT INTO credit_ledger
         (id, user_id, credit_type, amount, source_type,
          source_id, expires_at, source_purchase_id, source_billing_history_id)
       VALUES ($1, $2, $3, $4, 'admin', NULL, NULL, NULL, NULL)`,
      [id, input.userId, input.creditType, input.amount],
    )
    const balanceResult = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS balance
         FROM credit_ledger
        WHERE user_id = $1
          AND credit_type = $2
          AND (expires_at IS NULL OR expires_at > now())`,
      [input.userId, input.creditType],
    )
    await client.query('COMMIT')

    const row = balanceResult.rows[0]
    const newBalance = row ? Number(row.balance) : 0
    return { ledgerId: id, newBalance }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Connection may already be in a failed state; the throw below
      // surfaces the original error.
    }
    throw err
  } finally {
    client.release()
  }
}
