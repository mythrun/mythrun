import type { Meta, StoryObj } from '@storybook/react-vite'
import { CreditBalance } from './CreditBalance.tsx'

// CreditBalance — the two-bucket credit readout on the Sessions & Billing settings
// surface. It itemises the SESSION and WORLD-GEN buckets as two independent labeled
// mono readouts; the two are NEVER conflated and NO summed total is shown (spec §4).
// Pure/presentational: these specimens hand it fixed numbers + interim labels; the
// real screen passes the client-core balance view-model + i18n'd labels (copy stays
// in the shell). The `inline` header variant is descoped — the header already ships
// the session number via MYT-87's HeaderCredits — so this serves settings only.
//
// The labels below are interim chrome (stories are lint-exempt); the settings screen
// supplies the real i18n keys. Values render exactly as passed (the shell formats).

// Interim settings labels — the shell owns the real copy.
const SESSION_LABEL = 'session credits'
const WORLD_GEN_LABEL = 'world credits'

const meta: Meta<typeof CreditBalance> = {
  title: 'Billing/CreditBalance',
  component: CreditBalance,
  tags: ['autodocs'],
  args: { sessionLabel: SESSION_LABEL, worldGenLabel: WORLD_GEN_LABEL },
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

type Story = StoryObj<typeof CreditBalance>

// The default settings readout — both buckets itemised, a typical mid balance.
export const Default: Story = {
  name: 'Both buckets (settings)',
  args: { session: 12, worldGen: 5 },
}

// A drained account — both buckets at zero. The zeros render as `0`, never blank
// or a fallback (the low-credit prompting lives in the surrounding screen).
export const ZeroBalance: Story = {
  name: 'Zero balance',
  args: { session: 0, worldGen: 0 },
}

// A subscriber with a healthy balance — larger counts confirm the mono readout holds
// its ledger alignment as the numbers widen.
export const LargerBalance: Story = {
  name: 'Larger balance',
  args: { session: 148, worldGen: 32 },
}

// ~375px — the phone-class measure. The justified ledger rows reflow without change;
// the label truncates before it can squeeze the value.
export const Narrow: Story = {
  name: 'Narrow (~375px)',
  args: { session: 12, worldGen: 5 },
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
