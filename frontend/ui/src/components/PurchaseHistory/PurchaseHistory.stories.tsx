import type { Meta, StoryObj } from '@storybook/react-vite'
import { PurchaseHistory } from './PurchaseHistory.tsx'
import type { PurchaseHistoryRow } from '@mythrun/client-core/contract'

// PurchaseHistory — the terse billing-ledger feed on the Sessions & Billing settings
// surface: pack purchases + subscription invoices + refunds as a quiet mono list, one
// shell-composed line per row. À-la-carte rows CANNOT name credit counts (spec §4), so
// their label is just "Purchase — $X.XX"; invoice rows may name the tier. A refunded row
// demotes to the muted record register (never a chip). These specimens hand it fixed
// interim prose; the real screen passes the client-core purchase-history view-model
// mapped to labels (copy stays in the shell).
//
// The labels below are interim chrome (stories are lint-exempt); the settings screen
// supplies the real i18n keys. Values render exactly as passed (the shell formats).

// Interim ledger rows — the shell owns the real copy + Intl money formatting.
const MIXED_ROWS: readonly PurchaseHistoryRow[] = [
  { id: 'evt-1', label: 'Mythwright — $16.00', refunded: false },
  { id: 'evt-2', label: 'Purchase — $12.00', refunded: false },
  { id: 'evt-3', label: 'Sojourner — $8.00', refunded: false },
  { id: 'evt-4', label: 'Purchase — $12.00', refunded: true },
]
const EMPTY_LABEL = 'No purchases yet.'

const meta: Meta<typeof PurchaseHistory> = {
  title: 'Billing/PurchaseHistory',
  component: PurchaseHistory,
  tags: ['autodocs'],
  args: { emptyLabel: EMPTY_LABEL },
  // A paper page ground + a settings-column measure (the consuming screen owns width).
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <div className="mx-auto max-w-[420px]">
          <Story />
        </div>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof PurchaseHistory>

// The default feed — a subscription invoice, two pack purchases, and a refunded charge.
// The refunded row (last) demotes to the quiet muted record line — no chip, no badge.
export const Default: Story = {
  name: 'Mixed feed',
  args: { rows: MIXED_ROWS },
}

// An account that has never purchased — the empty state renders the shell's quiet line
// (the feed never shows a fallback dash or a fabricated row).
export const Empty: Story = {
  name: 'Empty feed',
  args: { rows: [] },
}

// ~375px — the phone-class measure. The mono lines reflow without change; the ledger
// stays a flat quiet list, no horizontal scroll.
export const Narrow: Story = {
  name: 'Narrow (~375px)',
  args: { rows: MIXED_ROWS },
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-4)]">
        <div className="w-[375px] max-w-full">
          <Story />
        </div>
      </div>
    ),
  ],
}
