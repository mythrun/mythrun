// PurchaseHistory (MYT-95) — the DOM-free prop vocabulary for the terse billing-ledger
// feed on the Sessions & Billing settings surface. It renders the unified billing
// history (à-la-carte pack purchases + subscription invoices + refunds) as a quiet mono
// list, one shell-composed line per row. Platform-neutral (§9): pure data + shell-owned
// i18n'd prose, no DOM types, no callbacks.
//
// À-LA-CARTE CONSTRAINT (spec §4): a pack row CANNOT name credit counts — its
// `lookup_key` is NULL in `billing_history`, so the shell composes its label from the
// feed source + amount ONLY (e.g. "Purchase — $12.00"). Subscription invoice rows carry
// a tier and may name it ("Mythwright — $16.00"). That composition is the shell's job;
// this component only reflects the finished `label` string (the client-core
// purchase-history view-model surfaces `tierDisplayName: null` for pack rows).

/** One billing-ledger line. The `label` is finished, shell-composed terse prose — the
 *  DS never composes copy. `refunded` drives a quiet TYPOGRAPHIC demotion of the row (a
 *  reversed transaction reads as a muted record), never a chip/badge. */
export interface PurchaseHistoryRow {
  /** Stable row id (the billing_history event id) — the list key + per-row test hook. */
  readonly id: string
  /** Shell-composed terse prose, e.g. "Purchase — $12.00" / "Mythwright — $16.00". */
  readonly label: string
  /** True when the transaction was reversed — the row renders as a muted record line. */
  readonly refunded: boolean
}

/** Props for the terse purchase-history feed. */
export interface PurchaseHistoryProps {
  /** The billing-ledger rows, newest first (ordering is the shell's job). */
  readonly rows: readonly PurchaseHistoryRow[]
  /** The i18n'd empty-state line shown when there are no rows (copy stays in the shell). */
  readonly emptyLabel: string
  /** Test hook on the root element. */
  readonly 'data-testid'?: string
}
