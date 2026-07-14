import type { BillingHistoryEvent, SkuListing } from '@mythrun/contract/rest'

// The purchase-history view-model. The unified billing feed (GET /api/billing/
// history) mixes à-la-carte PACK rows and subscription INVOICE rows. A pack row
// carries `lookup_key: null` and NO credit counts, so this VM can NEVER name a
// tier (or promise per-item credit detail) for it — only invoice rows resolve a
// `tierDisplayName` from the catalogue. The shell composes the terse prose from
// `kind` + `tierDisplayName` + the formatted amount (spec §4).

export interface HistoryRowView {
  readonly id: string
  readonly kind: 'purchase' | 'invoice' | 'refund'
  readonly amountCents: number
  readonly currency: string
  /** The tier name for subscription (invoice) rows. null for à-la-carte pack
   *  rows (no lookup_key — they cannot name credit counts) and refunds. */
  readonly tierDisplayName: string | null
  readonly occurredAt: string
  readonly refunded: boolean
}

export function purchaseHistoryView(
  events: readonly BillingHistoryEvent[],
  skus: readonly SkuListing[],
): HistoryRowView[] {
  return events.map((e) => ({
    id: e.id,
    kind: e.kind,
    amountCents: e.amount_cents,
    currency: e.currency,
    tierDisplayName:
      e.lookup_key === null
        ? null
        : (skus.find((s) => s.lookup_key === e.lookup_key)?.displayName ?? null),
    occurredAt: e.occurred_at,
    refunded: e.status === 'refunded',
  }))
}
