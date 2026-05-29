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
