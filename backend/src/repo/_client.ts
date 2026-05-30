// Transaction mechanics for the unified repo surface (Plan Phase 1, Task 1).
//
// `runTransaction` is the engine behind `repo.transaction`: connect → BEGIN
// (+ per-call SET LOCAL prelude) → run the callback against a client-bound
// namespace surface → COMMIT / ROLLBACK → release. It encodes the three
// terminal outcomes the real billing/world-gen sites need (commit, throw,
// no-op discard) and the use-after-settle guard that prevents a captured tx
// handle from corrupting a recycled pooled connection.
//
// Two production incidents shape this:
//   - MYT-55: slow I/O (LLM/Stripe) must never sit inside BEGIN/COMMIT.
//     Callers do slow work BEFORE calling repo.transaction; the callback
//     only holds writes.
//   - MYT-56: side-effects (queue.add) must happen AFTER commit. The
//     callback returns a value the caller uses post-commit.
import type { Pool, PoolClient } from 'pg'
import { beginPrelude, type TxOpts } from '../db/transaction.js'
import type { ClientLike } from './_types.js'

/**
 * Sentinel a transaction callback returns to request a ROLLBACK without
 * surfacing an error. The no-op / idempotent-discard outcome (Stripe
 * duplicate-redelivery and unknown-event paths) — these must NOT masquerade
 * as thrown errors that trigger needless webhook retries.
 */
export const ROLLBACK = Symbol('repo.ROLLBACK')
export type RollbackSignal = typeof ROLLBACK

const SETTLED_MESSAGE =
  'tx repo used after the transaction settled — post-tx recovery/branch ' +
  'logic must use the pool-bound repo.X, never a captured tx.'

/**
 * Wrap a live PoolClient so it can be handed to the namespace binder while
 * the transaction is open, then fenced off once it settles. After `settle()`
 * any `.query` throws — the underlying client has been released back to the
 * pool and may already be serving another request, so a captured `tx` handle
 * touching it would corrupt an unrelated connection.
 */
export function makeSettlingClient(client: PoolClient): {
  client: ClientLike
  settle: () => void
} {
  let settled = false
  const wrapped: ClientLike = {
    query: (queryText, values) => {
      if (settled) {
        throw new Error(SETTLED_MESSAGE)
      }
      return client.query(queryText, values)
    },
  }
  return {
    client: wrapped,
    settle: () => {
      settled = true
    },
  }
}

/**
 * Run `fn` inside a transaction on a freshly-acquired pool connection.
 *
 * `bind` turns the in-flight client into the tx-composable namespace surface
 * (the binder arrives in a later task; tests stub it). `fn` receives that
 * surface and returns either a value (→ COMMIT, value returned for post-commit
 * work) or the ROLLBACK sentinel (→ ROLLBACK, sentinel returned, no error).
 * A throw rolls back and propagates.
 *
 * The wrapped client is settled (fenced) before release in every terminal
 * path, so a captured `tx` used after settlement throws rather than touching
 * the recycled connection.
 */
export async function runTransaction<TxR, T>(
  pool: Pool,
  bind: (c: ClientLike) => TxR,
  fn: (tx: TxR) => Promise<T | RollbackSignal>,
  opts: TxOpts | undefined,
): Promise<T | RollbackSignal> {
  const client = await pool.connect()
  const { client: txClient, settle } = makeSettlingClient(client)
  // Track a terminal error so the `finally` can DESTROY (not plain-release)
  // a connection whose transaction state may be leaked. A COMMIT or no-op
  // ROLLBACK can throw (serialization/deadlock failure — real under
  // repeatable-read / serializable, both allowed by TxOpts), and a BEGIN
  // prelude throw leaves the connection mid-statement; plain-releasing any
  // of these poisons the next borrower (25P02). `release(err)` destroys the
  // socket instead. Mirrors the canonical idiom in db/migrate.ts.
  let releaseErr: Error | undefined
  try {
    await client.query(beginPrelude(opts))
    let result: T | RollbackSignal
    try {
      result = await fn(bind(txClient))
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Swallow secondary ROLLBACK errors (connection may already be
        // broken) so the original throw context surfaces to the caller.
      }
      settle()
      throw err
    }
    if (result === ROLLBACK) {
      await client.query('ROLLBACK')
      settle()
      return ROLLBACK
    }
    await client.query('COMMIT')
    settle()
    return result
  } catch (err) {
    settle() // idempotent — just flips a boolean; safe to call twice.
    releaseErr = err instanceof Error ? err : new Error(String(err))
    throw err
  } finally {
    client.release(releaseErr)
  }
}
