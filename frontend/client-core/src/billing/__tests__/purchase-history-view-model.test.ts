import { describe, expect, it } from 'vitest'
import type { BillingHistoryEvent, SkuListing } from '@mythrun/contract/rest'
import { purchaseHistoryView, type HistoryRowView } from '../purchase-history-view-model.ts'

// The history feed sources pack (à-la-carte) rows with `lookup_key: null` and NO
// credit counts, and subscription (invoice) rows carrying a tier `lookup_key`.
// `purchaseHistoryView` may therefore only name a tier for invoice rows — a pack
// row can never promise per-item credit detail (spec §4 load-bearing fact).

const skus: SkuListing[] = [
  {
    lookup_key: 'tier_mythwright',
    displayName: 'Mythwright',
    type: 'recurring',
    sessionsGranted: 12,
    worldsGranted: 4,
    price: { unit_amount_cents: 4500, currency: 'usd' },
  },
]

function event(overrides: Partial<BillingHistoryEvent>): BillingHistoryEvent {
  return {
    id: 'evt-1',
    kind: 'purchase',
    occurred_at: '2026-07-01T10:00:00.000Z',
    amount_cents: 500,
    currency: 'usd',
    lookup_key: null,
    status: 'completed',
    source_id_stripe: 'pi_1',
    ...overrides,
  }
}

/** Maps a single event and narrows the sole row out of the result array. */
function onlyRow(e: BillingHistoryEvent): HistoryRowView {
  const rows = purchaseHistoryView([e], skus)
  expect(rows).toHaveLength(1)
  const [row] = rows
  if (row === undefined) throw new Error('expected exactly one row')
  return row
}

describe('purchaseHistoryView', () => {
  it('maps a pack row (lookup_key null) → tierDisplayName null (never names credit counts)', () => {
    const row = onlyRow(event({ kind: 'purchase', lookup_key: null }))
    expect(row).toEqual({
      id: 'evt-1',
      kind: 'purchase',
      amountCents: 500,
      currency: 'usd',
      tierDisplayName: null,
      occurredAt: '2026-07-01T10:00:00.000Z',
      refunded: false,
    })
  })

  it('resolves the tier displayName for a subscription (invoice) row from the catalogue', () => {
    const row = onlyRow(
      event({ id: 'evt-2', kind: 'invoice', lookup_key: 'tier_mythwright', amount_cents: 4500 }),
    )
    expect(row.tierDisplayName).toBe('Mythwright')
    expect(row.kind).toBe('invoice')
    expect(row.refunded).toBe(false)
  })

  it('falls back to null when a populated lookup_key is absent from the catalogue', () => {
    const row = onlyRow(event({ kind: 'invoice', lookup_key: 'tier_unknown' }))
    expect(row.tierDisplayName).toBeNull()
  })

  it('marks a refunded row (status refunded → refunded true)', () => {
    const row = onlyRow(event({ kind: 'refund', status: 'refunded', lookup_key: null }))
    expect(row.refunded).toBe(true)
    expect(row.tierDisplayName).toBeNull()
  })

  it('maps an empty feed to an empty array', () => {
    expect(purchaseHistoryView([], skus)).toEqual([])
  })
})
