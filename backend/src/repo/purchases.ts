import type { ClientLike } from './_types.js'

export interface NewPurchaseRow {
  readonly id: string
  readonly user_id: string
  readonly stripe_payment_intent_id: string
  readonly lookup_key: string
  readonly quantity: number
  readonly amount_cents: number
  readonly currency: string
}

export interface PurchaseRow extends NewPurchaseRow {
  readonly status: 'completed' | 'refunded'
  readonly created_at: Date
}

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.purchases.X` and `tx.purchases.X` share one body. */
export function purchasesNs(c: ClientLike) {
  return {
    insertMany: async (rows: readonly NewPurchaseRow[]): Promise<void> => {
      if (rows.length === 0) return
      const values = rows
        .map((_, i) => {
          const o = i * 7
          return `($${String(o + 1)}, $${String(o + 2)}, $${String(o + 3)}, $${String(o + 4)}, $${String(o + 5)}, $${String(o + 6)}, $${String(o + 7)})`
        })
        .join(', ')
      const params = rows.flatMap((r) => [
        r.id,
        r.user_id,
        r.stripe_payment_intent_id,
        r.lookup_key,
        r.quantity,
        r.amount_cents,
        r.currency,
      ])
      await c.query(
        `INSERT INTO purchases (id, user_id, stripe_payment_intent_id, lookup_key, quantity, amount_cents, currency) VALUES ${values}`,
        params,
      )
    },

    getByPaymentIntent: async (
      payment_intent_id: string,
    ): Promise<readonly PurchaseRow[]> => {
      const result = await c.query<PurchaseRow>(
        `SELECT id, user_id, stripe_payment_intent_id, lookup_key, quantity, amount_cents, currency, status, created_at
         FROM purchases
         WHERE stripe_payment_intent_id = $1
         ORDER BY id ASC`,
        [payment_intent_id],
      )
      return result.rows
    },

    /**
     * Re-fetch purchase rows by id under FOR UPDATE, ORDER BY id ASC, and
     * return only those still in status='completed'. Composable — runs over the
     * caller's tx client; the §5.4.5 refund handler uses this for the
     * lock-order-sensitive re-read (round-7 Persepolis C5) between the
     * lock-free resolve and the locked clawback. The `ORDER BY id ASC` is
     * load-bearing for cross-handler deadlock avoidance (consistent lock
     * acquisition order). SQL verbatim from `refetchPurchasesUnderLock`.
     */
    refetchCompletedForUpdate: async (
      ids: readonly string[],
    ): Promise<readonly PurchaseRow[]> => {
      const result = await c.query<PurchaseRow>(
        `SELECT id, user_id, stripe_payment_intent_id, lookup_key, quantity,
                amount_cents, currency, status, created_at
           FROM purchases
           WHERE id = ANY($1::uuid[])
           ORDER BY id ASC
           FOR UPDATE`,
        [ids],
      )
      return result.rows.filter((r) => r.status === 'completed')
    },

    markRefunded: async (id: string): Promise<{ rowsAffected: number }> => {
      const result = await c.query(
        `UPDATE purchases SET status = 'refunded' WHERE id = $1 AND status = 'completed'`,
        [id],
      )
      return { rowsAffected: result.rowCount ?? 0 }
    },
  }
}
