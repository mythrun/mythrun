import type { ClientLike } from './_types.js'

/** Composable binder over a single ClientLike. Holds the canonical SQL so
 *  `repo.stripeEvents.X` and `tx.stripeEvents.X` share one body. */
export function stripeEventsNs(c: ClientLike) {
  return {
    recordOrSkip: async (
      event_id: string,
      event_type: string,
    ): Promise<'inserted' | 'duplicate'> => {
      const result = await c.query<{ event_id: string }>(
        `INSERT INTO stripe_events (event_id, event_type, processed_at)
         VALUES ($1, $2, now())
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [event_id, event_type],
      )
      return result.rows.length === 0 ? 'duplicate' : 'inserted'
    },
  }
}

/** Back-compat shim: explicit-client const-object surface that delegates to the
 *  canonical `stripeEventsNs` binder. Direct importers
 *  (`stripeEvents.recordOrSkip(tx, ...)`) keep working; new code goes through
 *  `repo.stripeEvents`. */
export const stripeEvents = {
  recordOrSkip: (
    tx: ClientLike,
    event_id: string,
    event_type: string,
  ): Promise<'inserted' | 'duplicate'> => stripeEventsNs(tx).recordOrSkip(event_id, event_type),
}
