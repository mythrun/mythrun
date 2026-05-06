import type { ClientLike } from './_types.js'

export const stripeEvents = {
  async recordOrSkip(
    tx: ClientLike,
    event_id: string,
    event_type: string,
  ): Promise<'inserted' | 'duplicate'> {
    const result = await tx.query<{ event_id: string }>(
      `INSERT INTO stripe_events (event_id, event_type, processed_at)
         VALUES ($1, $2, now())
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
      [event_id, event_type],
    )
    return result.rows.length === 0 ? 'duplicate' : 'inserted'
  },
}
