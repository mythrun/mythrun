import { forwardRef } from 'react'
import type { PurchaseHistoryProps, PurchaseHistoryRow } from '@mythrun/client-core/contract'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'

// PurchaseHistory (MYT-95) — the terse billing-ledger feed on the Sessions & Billing
// settings surface. It renders the unified history (à-la-carte pack purchases +
// subscription invoices + refunds) as a quiet mono list: one shell-composed line per
// row, newest first. The shell owns the prose — à-la-carte rows CANNOT name credit
// counts (spec §4), so their label is just "Purchase — $X.XX"; this component only
// reflects the finished `label`.
//
// Pure/presentational: composed only from the DS Stack/Text primitives — no ad-hoc
// layout or type classes. Register: flat 1-bit paper, machine-mono lines, square by
// construction (the primitives carry no radius), NO chips/dots/badges. A REFUNDED row is
// marked TYPOGRAPHICALLY, never with a chip: it demotes from the ink ledger role
// (`data`) to the quiet muted record role (`meta`), so a reversed transaction reads as a
// settled/struck line. An empty feed renders the shell's `emptyLabel` as the same quiet
// meta line. No pagination affordance — the feed shows the page the shell hands it (the
// client-core `nextCursor` exists for a future load-more, not built here).

function HistoryLine({ row }: { readonly row: PurchaseHistoryRow }): React.JSX.Element {
  return (
    <Text role={row.refunded ? 'meta' : 'data'} as="p" data-testid={`purchase-history-row-${row.id}`}>
      {row.label}
    </Text>
  )
}

export const PurchaseHistory = forwardRef<HTMLDivElement, PurchaseHistoryProps>(function PurchaseHistory(
  { rows, emptyLabel, 'data-testid': testId = 'purchase-history' },
  ref,
) {
  return (
    <Stack ref={ref} gap={2} data-testid={testId}>
      {rows.length === 0 ? (
        <Text role="meta" as="p" data-testid="purchase-history-empty">
          {emptyLabel}
        </Text>
      ) : (
        rows.map((row) => <HistoryLine key={row.id} row={row} />)
      )}
    </Stack>
  )
})
