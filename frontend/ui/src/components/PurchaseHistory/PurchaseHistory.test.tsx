import { describe, it, expect } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import { axe } from 'jest-axe'
import { PurchaseHistory } from './PurchaseHistory.tsx'
import type { PurchaseHistoryRow } from '@mythrun/client-core/contract'

// Realistic interim rows — the settings shell composes these labels (copy lives in the
// shell, not the DS). À-la-carte pack rows read "Purchase — $X.XX" (no credit counts,
// spec §4); a subscription invoice row may name the tier; a refunded row carries
// refunded:true and demotes to the muted record register.
const ROWS: readonly PurchaseHistoryRow[] = [
  { id: 'evt-1', label: 'Purchase — $12.00', refunded: false },
  { id: 'evt-2', label: 'Mythwright — $16.00', refunded: false },
  { id: 'evt-3', label: 'Purchase — $8.00', refunded: true },
]
const EMPTY_LABEL = 'no purchases yet'

describe('PurchaseHistory', () => {
  it('renders every row label in the mono register', () => {
    const { getByText, getByTestId } = render(<PurchaseHistory rows={ROWS} emptyLabel={EMPTY_LABEL} />)
    for (const row of ROWS) {
      expect(getByText(row.label)).toBeInTheDocument()
      // role=data|meta both resolve to the machine-mono family (font-ui) — the brand's
      // data/chrome face, never the serif prose face.
      expect(getByTestId(`purchase-history-row-${row.id}`).className).toMatch(/font-ui/)
    }
  })

  it('renders the empty label when the feed has no rows', () => {
    const { getByTestId, getByText } = render(<PurchaseHistory rows={[]} emptyLabel={EMPTY_LABEL} />)
    expect(getByTestId('purchase-history-empty')).toHaveTextContent(EMPTY_LABEL)
    expect(getByText(EMPTY_LABEL)).toBeInTheDocument()
  })

  it('does not render the empty label when there are rows', () => {
    const { queryByTestId } = render(<PurchaseHistory rows={ROWS} emptyLabel={EMPTY_LABEL} />)
    expect(queryByTestId('purchase-history-empty')).toBeNull()
  })

  it('marks a refunded row typographically (a muted record), NOT with a chip/badge', () => {
    const { container, getByTestId } = render(<PurchaseHistory rows={ROWS} emptyLabel={EMPTY_LABEL} />)
    const refunded = getByTestId('purchase-history-row-evt-3')
    const active = getByTestId('purchase-history-row-evt-1')
    // A refunded row demotes from the ink ledger value (`data`) to the quiet muted
    // record line (`meta` → text-ink-secondary); an active row keeps the ink token.
    expect(refunded.className).toMatch(/text-ink-secondary/)
    expect(active.className).not.toMatch(/text-ink-secondary/)
    // Typographic only — never a chip: no fill, no border, no pill anywhere.
    expect(refunded.className).not.toMatch(/\bbg-/)
    expect(refunded.className).not.toMatch(/border/)
    expect(container.querySelector('.rounded-full')).toBeNull()
  })

  it('defaults the root test id and lets it be overridden', () => {
    const { getByTestId, rerender } = render(<PurchaseHistory rows={ROWS} emptyLabel={EMPTY_LABEL} />)
    expect(getByTestId('purchase-history')).toBeInTheDocument()
    rerender(<PurchaseHistory rows={ROWS} emptyLabel={EMPTY_LABEL} data-testid="settings-history" />)
    expect(getByTestId('settings-history')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(<PurchaseHistory ref={ref} rows={ROWS} emptyLabel={EMPTY_LABEL} />)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations (populated feed)', async () => {
    const { container } = render(<PurchaseHistory rows={ROWS} emptyLabel={EMPTY_LABEL} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no a11y violations (empty feed)', async () => {
    const { container } = render(<PurchaseHistory rows={[]} emptyLabel={EMPTY_LABEL} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
