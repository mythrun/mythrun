import type { PoolClient } from 'pg'

// Run `fn` inside a BEGIN/COMMIT scope on the provided client. ROLLBACKs on
// throw (best-effort — swallows secondary ROLLBACK errors so the original
// throw surfaces). Returns whatever `fn` returns.
//
// Why this exists: world-gen stages used to wrap the LLM call AND the
// persist writes in a single outer transaction. RDS staging sets
// idle_in_transaction_session_timeout=60000, so any LLM call exceeding 60s
// triggered "FATAL: terminating connection due to idle-in-transaction
// timeout" mid-stream and crashed the worker (MYT-55 staging smoke).
//
// Scope each transaction to only the persist phase via this helper; the
// LLM call sits outside the BEGIN, so the connection is never "idle in a
// transaction" while waiting for the model.
export async function withTransaction<T>(
  client: PoolClient,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN')
  try {
    const result = await fn()
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Swallow secondary ROLLBACK errors (connection may already be broken)
      // so the original throw context surfaces to the caller.
    }
    throw err
  }
}

/**
 * Per-call SET LOCAL knobs for `repo.transaction`'s BEGIN prelude. The audit
 * found these varying by site (register, billing webhook, world-create each
 * differ), so they are passed per call rather than baked into the helper.
 */
export interface TxOpts {
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  lockTimeoutMs?: number
  statementTimeoutMs?: number
}

/**
 * Build the `BEGIN; SET LOCAL …` simple-query batch for a transaction.
 *
 * Emitted as ONE multi-statement string so the SET LOCALs land in the same
 * transaction as the BEGIN — a `SET LOCAL` issued with no active transaction
 * is a silent no-op, so ordering after BEGIN is load-bearing.
 *
 * `isolation` defaults to 'read committed' — every current site pins it
 * explicitly; we never inherit the connection/RDS default. Unset timeout
 * opts emit no statement (the connection keeps its server default).
 */
export function beginPrelude(opts?: TxOpts): string {
  const isolation = opts?.isolation ?? 'read committed'
  const parts = ['BEGIN', `SET LOCAL transaction_isolation = '${isolation}'`]
  if (opts?.lockTimeoutMs !== undefined) {
    parts.push(`SET LOCAL lock_timeout = '${String(opts.lockTimeoutMs)}ms'`)
  }
  if (opts?.statementTimeoutMs !== undefined) {
    parts.push(`SET LOCAL statement_timeout = '${String(opts.statementTimeoutMs)}ms'`)
  }
  return parts.join(';\n') + ';'
}
