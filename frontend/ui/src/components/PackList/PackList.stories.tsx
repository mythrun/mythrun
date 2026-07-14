import type { Meta, StoryObj } from '@storybook/react-vite'
import { PackList } from './PackList.tsx'
import type { SubscriptionTierView, AlaCarteView } from '@mythrun/client-core/contract'

// PackList — the Sessions & Billing pack picker: the subscription-tier split over
// the à-la-carte packs. Each tier carries a SINGLE gated CTA (`subscribe` /
// `upgrade` / `manage`) resolved upstream by client-core `subscriptionCta` — an
// active subscriber never sees a plain subscribe button (spec §4). The current tier
// is marked with a quiet mono "current" line (typography, not a chip); there is NO
// "best value"/"recommended" nudge (§11). À-la-carte quantity is a row of preset
// buttons (single-select) + Buy, clamped into [1, 100].
//
// Register: flat square paper cards, mono price readouts, two faces (serif tier
// names, mono data). Labels are i18n'd strings the shell supplies.

const LABELS = {
  subscribe: 'Subscribe',
  upgrade: 'Upgrade',
  manage: 'Manage',
  current: 'Current plan',
  buy: 'Buy',
}

const TIERS_NO_SUB: SubscriptionTierView[] = [
  { lookupKey: 'tier_wayfarer', displayName: 'Wayfarer', priceLabel: '$8 / mo', cta: 'subscribe', isCurrent: false },
  { lookupKey: 'tier_sojourner', displayName: 'Sojourner', priceLabel: '$12 / mo', cta: 'subscribe', isCurrent: false },
  { lookupKey: 'tier_mythwright', displayName: 'Mythwright', priceLabel: '$16 / mo', cta: 'subscribe', isCurrent: false },
]

// Active Sojourner: the lower tier routes to the portal (manage), Sojourner is the
// current plan (manage + current marker), Mythwright is an upgrade — the three CTA
// states an active subscriber sees, in one view.
const TIERS_ACTIVE: SubscriptionTierView[] = [
  { lookupKey: 'tier_wayfarer', displayName: 'Wayfarer', priceLabel: '$8 / mo', cta: 'manage', isCurrent: false },
  { lookupKey: 'tier_sojourner', displayName: 'Sojourner', priceLabel: '$12 / mo', cta: 'manage', isCurrent: true },
  { lookupKey: 'tier_mythwright', displayName: 'Mythwright', priceLabel: '$16 / mo', cta: 'upgrade', isCurrent: false },
]

const ALA_CARTE: AlaCarteView[] = [
  { lookupKey: 'sku_session', displayName: 'Session pack', unitPriceLabel: '$5 each' },
  { lookupKey: 'sku_world', displayName: 'World pack', unitPriceLabel: '$9 each' },
]

const PRESETS = [1, 4, 8, 16]

// The story handlers are declarative no-ops (expression body, so not an
// empty-function lint offender) — the specimens demonstrate layout/register, not
// the shell's checkout wiring.
const noop = (): void => undefined

const meta: Meta<typeof PackList> = {
  title: 'Billing/PackList',
  component: PackList,
  tags: ['autodocs'],
  args: {
    onTierCta: noop,
    onBuyAlaCarte: noop,
    labels: LABELS,
    quantityPresets: PRESETS,
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof PackList>

// No active subscription — every tier offers a plain Subscribe.
export const NoSubscription: Story = {
  name: 'No subscription',
  args: { tiers: TIERS_NO_SUB, alaCarte: ALA_CARTE },
  render: (args) => (
    <div className="max-w-[520px] bg-bg p-[var(--space-6)]">
      <PackList {...args} />
    </div>
  ),
}

// Active Sojourner — shows manage (downgrade→portal), the current-plan marker, and
// an upgrade, plus the à-la-carte packs.
export const ActiveSubscription: Story = {
  name: 'Active subscription (upgrade / current / manage)',
  args: { tiers: TIERS_ACTIVE, alaCarte: ALA_CARTE },
  render: (args) => (
    <div className="max-w-[520px] bg-bg p-[var(--space-6)]">
      <PackList {...args} />
    </div>
  ),
}

// Narrow (~375px) — the cards stack full-width; the preset row wraps.
export const Narrow: Story = {
  args: { tiers: TIERS_ACTIVE, alaCarte: ALA_CARTE },
  render: (args) => (
    <div className="max-w-[375px] bg-bg p-[var(--space-4)]">
      <PackList {...args} />
    </div>
  ),
}
