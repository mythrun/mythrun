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

export const purchases = {
  async insertMany(tx: ClientLike, rows: readonly NewPurchaseRow[]): Promise<void> {
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
    await tx.query(
      `INSERT INTO purchases (id, user_id, stripe_payment_intent_id, lookup_key, quantity, amount_cents, currency) VALUES ${values}`,
      params,
    )
  },

  async getByPaymentIntent(
    tx: ClientLike,
    payment_intent_id: string,
  ): Promise<readonly PurchaseRow[]> {
    const result = await tx.query<PurchaseRow>(
      `SELECT id, user_id, stripe_payment_intent_id, lookup_key, quantity, amount_cents, currency, status, created_at
         FROM purchases
         WHERE stripe_payment_intent_id = $1
         ORDER BY id ASC`,
      [payment_intent_id],
    )
    return result.rows
  },

  async markRefunded(tx: ClientLike, id: string): Promise<{ rowsAffected: number }> {
    const result = await tx.query(
      `UPDATE purchases SET status = 'refunded' WHERE id = $1 AND status = 'completed'`,
      [id],
    )
    return { rowsAffected: result.rowCount ?? 0 }
  },
}
