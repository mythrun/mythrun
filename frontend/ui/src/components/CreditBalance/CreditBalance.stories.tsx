import type { Meta, StoryObj } from '@storybook/react-vite'
import { CreditBalance } from './CreditBalance.tsx'

// CreditBalance — the two-bucket credit readout on the Sessions & Billing settings
// surface. It itemises the SESSION and WORLD-GEN buckets as two independent labeled
// mono tiles; the two are NEVER conflated and NO summed total is shown (spec §4).
// Each tile binds its label to its number and carries its own two-line explainer —
// what one credit buys, and what the zero state costs — because these are the
// product's two economic units and a bare number teaches nothing.
//
// Pure/presentational: these specimens hand it fixed numbers + interim copy; the real
// screen passes the client-core balance view-model + i18n'd strings (copy stays in the
// shell). The `inline` header variant is descoped — the header already ships the
// session number via MYT-87's HeaderCredits — so this serves settings only.

// Interim settings copy — the shell owns the real strings.
const COPY = {
  sessionLabel: 'Session credits',
  sessionHelp: 'One credit starts one session.',
  sessionZeroHelp: "At zero, you can't start a session.",
  worldGenLabel: 'World credits',
  worldGenHelp: 'One credit builds one world and its characters.',
  worldGenZeroHelp: "At zero, you can't start a new campaign.",
}

const meta: Meta<typeof CreditBalance> = {
  title: 'Billing/CreditBalance',
  component: CreditBalance,
  tags: ['autodocs'],
  args: COPY,
  // A paper page ground at the settings column's real width — the tiles hold ~300px
  // and sit side by side rather than stretching, which is what keeps each number
  // bound to its own label.
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <Story />
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof CreditBalance>

// The default settings readout — both buckets itemised and explained, a typical mid
// balance.
export const Default: Story = {
  name: 'Both buckets (settings)',
  args: { session: 12, worldGen: 5 },
}

// A drained account — both buckets at zero. The zeros render as `0`, never blank or a
// fallback, and the zero-state line beside them is the same line a healthy account
// sees (the explainer teaches before the wall, it does not appear at it). The
// purchase affordances live in the surrounding screen's à-la-carte section.
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

// ~375px — the phone-class measure. The pair collapses to a single column; each tile
// keeps its own label, number, and explainers.
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
