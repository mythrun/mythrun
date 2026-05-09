import { type Pool, type PoolClient } from 'pg'
import { uuidv5 } from './uuidv5.js'
import { uuidv7 } from './uuidv7.js'
import { toCreditEntry, type CreditEntryDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import type {
  AtomicDebitResult,
  CreditEntry,
  CreditType,
  DebitInput,
  GrantInput,
  ListEntriesOpts,
} from './types.js'
import {
  DEBIT_LOCK_TIMEOUT_MS,
  DEBIT_STATEMENT_TIMEOUT_MS,
  DEFAULT_LIST_LIMIT,
  IdempotencyConflictError,
  InsufficientCreditsError,
  UserNotFoundError,
} from './credits-errors.js'

export interface CreditsRepoOpts {
  readonly debitLockTimeoutMs?: number
  readonly debitStatementTimeoutMs?: number
}

/** Mythrun-pinned namespace UUID for trial-burn source_ids. Generated
 *  once and never changes; rotating it would orphan existing burn rows
 *  from their idempotency check. */
const TRIAL_BURN_NAMESPACE = '019700e0-0000-7000-8000-000000000003'

/**
 * Sum unexpired trial credits for `(userId, creditType)` and write a
 * negative-amount debit row burning them. Idempotent: source_id is a
 * deterministic UUIDv5 of `(userId, creditType)`, so webhook redelivery
 * sees the existing burn row and ON CONFLICTs to a no-op while the new
 * paid grant lands its own row.
 *
 * Caller MUST hold the users-row FOR UPDATE lock (atomicDebit + grantInTx
 * both establish this). Function is a no-op when trial balance is zero.
 */
async function burnUnexpiredTrialCredits(
  tx: ClientLike,
  userId: string,
  creditType: CreditType,
): Promise<void> {
  const trialSum = await tx.query<{ trial_balance: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS trial_balance
       FROM credit_ledger
      WHERE user_id = $1 AND credit_type = $2
        AND source_type = 'trial' AND amount > 0
        AND (expires_at IS NULL OR expires_at > now())`,
    [userId, creditType],
  )
  const balance = Number(trialSum.rows[0]?.trial_balance ?? 0)
  if (balance <= 0) return

  const burnSourceId = uuidv5(`${userId}:${creditType}`, TRIAL_BURN_NAMESPACE)
  await tx.query(
    `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id)
     VALUES ($1, $2, $3, $4, 'debit', $5)
     ON CONFLICT (user_id, credit_type, source_id) WHERE source_type = 'debit' DO NOTHING`,
    [uuidv7(), userId, creditType, -balance, burnSourceId],
  )
}

/**
 * Read the source_type of the FIFO-oldest unexpired positive credit row
 * for `(userId, creditType)`. Used by atomicDebit to populate
 * `consumedSourceType` on its result. Under the trial/paid mutual-
 * exclusion invariant, all unexpired positives at any moment are the
 * same source-type-class; this query returns that class.
 *
 * Caller MUST run this inside a transaction that has already verified
 * (a) the user row is locked FOR UPDATE, and (b) the balance check
 * passed (so at least one positive unexpired row exists). If no row
 * is found, throws "ledger inconsistency" — this is unreachable on the
 * happy path; firing means schema or invariant has drifted.
 */
async function readConsumedSourceType(
  client: ClientLike,
  input: { userId: string; creditType: CreditType },
): Promise<AtomicDebitResult['consumedSourceType']> {
  const result = await client.query<{ source_type: string }>(
    `SELECT source_type FROM credit_ledger
      WHERE user_id = $1 AND credit_type = $2
        AND amount > 0
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY granted_at ASC, id ASC
      LIMIT 1`,
    [input.userId, input.creditType],
  )
  const row = result.rows[0]
  if (!row) {
    throw new Error(
      `atomicDebit: balance check passed but no positive unexpired ` +
        `credit row found for user ${input.userId} (${input.creditType}). ` +
        `Possible ledger inconsistency.`,
    )
  }
  return row.source_type as AtomicDebitResult['consumedSourceType']
}

/**
 * Standalone version of `grantInTx` — same shape as the closure-bound method
 * on `createCreditsRepo`'s return value, but importable directly so callers
 * that already have a `ClientLike` (e.g., the §5.4 Stripe webhook handlers)
 * don't have to thread a pool-bound repo through. Pure: no pool / connection
 * lifecycle of its own.
 *
 * The user-row anchor lock is safe to re-acquire when the caller already
 * holds it on the same xid (Postgres tuple-lock re-entrancy — same xid
 * re-acquiring is a no-op). This makes the helper composable with the §5.3
 * webhook discipline of "lock the user row first, then grantInTx".
 */
export async function grantInTx(tx: ClientLike, input: GrantInput): Promise<CreditEntry> {
  if (input.amount <= 0) {
    throw new Error('grant: amount must be > 0')
  }
  // Type system already excludes 'debit' from sourceType, but a caller
  // passing through `any` could still violate. Belt-and-suspenders.
  if ((input.sourceType as string) === 'debit') {
    throw new Error('grant: sourceType cannot be "debit" — use atomicDebit')
  }

  const userCheck = await tx.query<{ id: string }>(
    'SELECT id FROM users WHERE id = $1 FOR UPDATE',
    [input.userId],
  )
  if (userCheck.rowCount === 0) {
    throw new UserNotFoundError(input.userId)
  }

  // MYT-43 trial-burn: when granting a paid credit, burn any unexpired
  // trial credits in the same transaction. Maintains the trial/paid
  // mutual-exclusion invariant the Session Runtime relies on.
  if (input.sourceType === 'purchase' || input.sourceType === 'subscription') {
    await burnUnexpiredTrialCredits(tx, input.userId, input.creditType)
  }

  const id = uuidv7()
  // The FK columns source_purchase_id / source_billing_history_id are
  // required for source_type='purchase' / 'subscription' / 'refund' per
  // migration 007's credit_ledger_source_link_chk CHECK. The CHECK
  // enforces "exactly one populated for grant kinds; both NULL for
  // trial/gift/debit"; passing both columns here lets every grant kind
  // share the same INSERT path.
  const result = await tx.query<CreditEntryDbRow>(
    `INSERT INTO credit_ledger
       (id, user_id, credit_type, amount, source_type, source_id, expires_at,
        source_purchase_id, source_billing_history_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      id,
      input.userId,
      input.creditType,
      input.amount,
      input.sourceType,
      input.sourceId ?? null,
      input.expiresAt ?? null,
      input.sourcePurchaseId ?? null,
      input.sourceBillingHistoryId ?? null,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('grant: INSERT returned no row')
  return toCreditEntry(row)
}

/**
 * Caller-shape for `recordClawback`. Negative-polarity row written to
 * credit_ledger when a Stripe refund (full or partial) requires unwinding
 * a prior grant. The originating grant row's UUID — NOT a session id — is
 * the idempotency key per migration 004's `uniq_credit_ledger_debit_idempotency`
 * partial unique index.
 *
 * `expires_at` is intentionally absent from this shape (refund clawbacks
 * never carry an expiry; migration 004's `credit_ledger_debit_no_expiry_chk`
 * enforces that for every debit row).
 */
export interface NewClawbackRow {
  readonly userId: string
  readonly creditType: CreditType
  readonly amount: number // strictly negative
  readonly sourceId: string // originating grant row's UUID
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

    /**
     * Insert a positive-amount credit_ledger row inside an existing
     * caller-managed transaction. Same validation + user-row FOR UPDATE +
     * INSERT as `grant`, but does NOT open its own connection or BEGIN.
     *
     * The user-row anchor lock is safe even when the caller already holds
     * it (Postgres tuple-lock re-entrancy — same xid re-acquiring is a
     * no-op). This makes the helper composable with the §5.3 webhook
     * discipline of "lock the user row first, then call grantInTx".
     */
    grantInTx,

    grant: async (input: GrantInput): Promise<CreditEntry> => {
      const client = await pool.connect()
      let inTransaction = false
      try {
        await beginAndConfigure(client)
        inTransaction = true
        const entry = await grantInTx(client, input)
        await client.query('COMMIT')
        inTransaction = false
        return entry
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

    /**
     * Insert a negative-polarity debit row representing a refund clawback,
     * inside an existing caller-managed transaction. The ONLY entrypoint
     * besides `atomicDebit` allowed to write a `source_type='debit'` row.
     *
     * Idempotency: ON CONFLICT (user_id, credit_type, source_id) WHERE
     * source_type='debit' DO NOTHING — same shape as migration 004's
     * `uniq_credit_ledger_debit_idempotency` partial unique index. If a
     * prior delivery wrote some clawback rows then rolled back, the next
     * delivery's `recordClawback` calls cleanly skip rows already written.
     * On conflict we follow up with a SELECT to return the canonical row
     * (consistent with `repo.billingHistory.append`'s `do_nothing` path).
     */
    recordClawback: async (tx: ClientLike, input: NewClawbackRow): Promise<CreditEntry> => {
      if (input.amount >= 0) {
        throw new Error('recordClawback: amount must be negative')
      }
      if (!input.sourceId || input.sourceId.length === 0) {
        throw new Error('recordClawback: sourceId required (originating grant UUID)')
      }

      const id = uuidv7()
      // Note: `granted_at` is intentionally omitted — the column has a
      // DEFAULT now() (see migration 001). The spec stub listed `created_at`
      // but credit_ledger uses `granted_at` for that role; relying on the
      // default is the simplest correct shape.
      const result = await tx.query<CreditEntryDbRow>(
        `INSERT INTO credit_ledger
           (id, user_id, credit_type, amount, source_type, source_id,
            expires_at, source_purchase_id, source_billing_history_id)
         VALUES ($1, $2, $3, $4, 'debit', $5, NULL, NULL, NULL)
         ON CONFLICT (user_id, credit_type, source_id) WHERE source_type = 'debit'
         DO NOTHING
         RETURNING *`,
        [id, input.userId, input.creditType, input.amount, input.sourceId],
      )
      const inserted = result.rows[0]
      if (inserted) return toCreditEntry(inserted)

      // Conflict path: ON CONFLICT DO NOTHING returns no rows. Follow up
      // with a SELECT to return the canonical row written by the prior
      // (committed) call.
      const existing = await tx.query<CreditEntryDbRow>(
        `SELECT * FROM credit_ledger
          WHERE user_id = $1 AND credit_type = $2
            AND source_id = $3 AND source_type = 'debit'`,
        [input.userId, input.creditType, input.sourceId],
      )
      const existingRow = existing.rows[0]
      if (!existingRow) {
        // Defensive: the partial unique index covers exactly this shape, so
        // a missing row after a conflict implies the prior writer's row was
        // deleted between INSERT and SELECT. credit_ledger has no DELETE
        // path in product code; surface as a hard error.
        throw new Error(
          `recordClawback: row missing after ON CONFLICT for user=${input.userId} ` +
            `creditType=${input.creditType} sourceId=${input.sourceId}`,
        )
      }
      return toCreditEntry(existingRow)
    },

    atomicDebit: async (input: DebitInput): Promise<AtomicDebitResult> => {
      if (input.amount <= 0) {
        throw new Error('atomicDebit: amount must be > 0')
      }
      if (!input.sourceId || input.sourceId.length === 0) {
        throw new Error('atomicDebit: sourceId required (use the per-user idempotency key)')
      }

      const client = await pool.connect()
      let inTransaction = false
      try {
        await beginAndConfigure(client)
        inTransaction = true

        // Lock anchor — serializes all concurrent debits + grants for this user.
        const userCheck = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [input.userId],
        )
        if (userCheck.rowCount === 0) {
          await client.query('ROLLBACK')
          inTransaction = false
          throw new UserNotFoundError(input.userId)
        }

        // Idempotency check — return prior row if same (user, credit_type, source_id).
        const priorResult = await client.query<CreditEntryDbRow>(
          `SELECT * FROM credit_ledger
            WHERE user_id = $1 AND credit_type = $2
              AND source_type = 'debit' AND source_id = $3`,
          [input.userId, input.creditType, input.sourceId],
        )
        const priorRow = priorResult.rows[0]
        if (priorRow) {
          const priorAmount = Math.abs(priorRow.amount)
          if (priorAmount !== input.amount) {
            await client.query('ROLLBACK')
            inTransaction = false
            throw new IdempotencyConflictError(
              input.userId,
              input.sourceId,
              priorAmount,
              input.amount,
            )
          }
          // Idempotency hit — prior debit row exists. Look up the source_type
          // of the FIFO-oldest unexpired positive credit to match the
          // contract on the success path. Under mutual exclusion this is the
          // same source-type-class that was consumed originally.
          const priorSourceType = await readConsumedSourceType(client, input)
          await client.query('COMMIT')
          inTransaction = false
          return { entry: toCreditEntry(priorRow), consumedSourceType: priorSourceType }
        }

        // Balance check — only spendable (unexpired) credits count.
        const balanceResult = await client.query<{ balance: string }>(
          `SELECT COALESCE(SUM(amount), 0)::text AS balance
             FROM credit_ledger
            WHERE user_id = $1 AND credit_type = $2
              AND (expires_at IS NULL OR expires_at > now())`,
          [input.userId, input.creditType],
        )
        const balanceRow = balanceResult.rows[0]
        const available = balanceRow ? Number(balanceRow.balance) : 0
        if (available < input.amount) {
          await client.query('ROLLBACK')
          inTransaction = false
          throw new InsufficientCreditsError(
            input.userId,
            input.creditType,
            available,
            input.amount,
          )
        }

        // Read the source_type of the FIFO-oldest unexpired positive credit
        // BEFORE writing the debit row. Under mutual exclusion, this is
        // what the debit logically consumes. The Session Runtime reads
        // this to decide trial-mode vs full-mode.
        const consumedSourceType = await readConsumedSourceType(client, input)

        // Insert the debit row.
        const id = uuidv7()
        const insertResult = await client.query<CreditEntryDbRow>(
          `INSERT INTO credit_ledger
             (id, user_id, credit_type, amount, source_type, source_id)
           VALUES ($1, $2, $3, $4, 'debit', $5)
           RETURNING *`,
          [id, input.userId, input.creditType, -input.amount, input.sourceId],
        )
        await client.query('COMMIT')
        inTransaction = false

        const row = insertResult.rows[0]
        if (!row) throw new Error('atomicDebit: INSERT returned no row')
        return { entry: toCreditEntry(row), consumedSourceType }
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Ignore — connection may already be in failed state.
          }
        }
        // Map pg timeout errors to DebitTimeoutError.
        if (typeof err === 'object' && err !== null && 'code' in err) {
          const pgCode = (err as { code?: string }).code
          if (pgCode === '55P03' || pgCode === '57014') {
            const { DebitTimeoutError } = await import('./credits-errors.js')
            throw new DebitTimeoutError(input.userId, pgCode)
          }
        }
        throw err
      } finally {
        client.release()
      }
    },

    listEntries: async (userId: string, opts: ListEntriesOpts = {}): Promise<CreditEntry[]> => {
      const limit = opts.limit === null ? null : (opts.limit ?? DEFAULT_LIST_LIMIT)
      const params: unknown[] = [userId]
      let typeClause = ''
      if (opts.type) {
        params.push(opts.type)
        typeClause = ` AND credit_type = $${String(params.length)}`
      }
      let limitClause = ''
      if (limit !== null) {
        params.push(limit)
        limitClause = ` LIMIT $${String(params.length)}`
      }
      const result = await pool.query<CreditEntryDbRow>(
        `SELECT * FROM credit_ledger
          WHERE user_id = $1${typeClause}
          ORDER BY granted_at DESC, id DESC${limitClause}`,
        params,
      )
      return result.rows.map(toCreditEntry)
    },
  }
}

export type CreditsRepo = ReturnType<typeof createCreditsRepo>
