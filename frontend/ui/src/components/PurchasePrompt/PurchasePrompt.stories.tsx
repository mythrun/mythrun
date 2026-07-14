import type { Meta, StoryObj } from '@storybook/react-vite'
import { PurchasePrompt } from './PurchasePrompt.tsx'

// PurchasePrompt — the out-of-session-credits prompt shown on a session-start 402.
// The OWNER variant carries the buy path (preset quantity buttons → onBuy); the
// NON-owner variant is a calm notice with NO buy CTA (buying would credit the wrong
// ledger and not unblock the owner's session). Register: a quiet flat paper panel,
// prose-first, no chips.
//
// These specimens hand it fixed interim copy + presets (stories are lint-exempt
// chrome); the real screen passes the shell's i18n'd strings + the SESSION presets,
// and wires onBuy to checkout. Handlers here are no-ops.

const OWNER_HEADING = 'You are out of session credits'
const OWNER_BODY = 'Starting a session spends one credit. Add more to pick up where you left off.'
const NON_OWNER_HEADING = 'The session cannot start yet'
const NON_OWNER_BODY = "This campaign's owner is out of session credits — they'll need to top up before you can play."
const BUY_LABEL = 'Buy session credits'
const DISMISS_LABEL = 'Dismiss'
const SESSION_PRESETS = [1, 4, 8, 16]

const meta: Meta<typeof PurchasePrompt> = {
  title: 'Billing/PurchasePrompt',
  component: PurchasePrompt,
  tags: ['autodocs'],
  args: { onBuy: () => undefined, onDismiss: () => undefined },
  // A paper page ground + the prompt's natural measure (the consuming surface owns width).
  decorators: [
    (Story) => (
      <div className="bg-bg p-[var(--space-6)]">
        <div className="mx-auto max-w-[480px]">
          <Story />
        </div>
      </div>
    ),
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof PurchasePrompt>

// The OWNER prompt — the buy path. Preset quantity buttons plus a quiet dismiss.
export const Owner: Story = {
  name: 'Owner (buy path)',
  args: {
    variant: 'owner',
    heading: OWNER_HEADING,
    body: OWNER_BODY,
    buyLabel: BUY_LABEL,
    quantityPresets: SESSION_PRESETS,
    dismissLabel: DISMISS_LABEL,
  },
}

// The NON-owner prompt — a calm notice, NO buy CTA. Even if buy props were handed in,
// the variant guard would suppress them; here they are simply omitted.
export const NonOwner: Story = {
  name: 'Non-owner (calm notice)',
  args: {
    variant: 'nonOwner',
    heading: NON_OWNER_HEADING,
    body: NON_OWNER_BODY,
    dismissLabel: DISMISS_LABEL,
  },
}

// ~375px — the phone-class measure. The panel reflows; the preset buttons wrap onto
// a second line rather than overflowing.
export const OwnerNarrow: Story = {
  name: 'Owner — narrow (~375px)',
  args: {
    variant: 'owner',
    heading: OWNER_HEADING,
    body: OWNER_BODY,
    buyLabel: BUY_LABEL,
    quantityPresets: SESSION_PRESETS,
    dismissLabel: DISMISS_LABEL,
  },
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

// ~375px non-owner — the calm notice at the phone measure.
export const NonOwnerNarrow: Story = {
  name: 'Non-owner — narrow (~375px)',
  args: {
    variant: 'nonOwner',
    heading: NON_OWNER_HEADING,
    body: NON_OWNER_BODY,
    dismissLabel: DISMISS_LABEL,
  },
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
