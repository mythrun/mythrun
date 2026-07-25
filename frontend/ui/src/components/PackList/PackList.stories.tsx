import type { Meta, StoryObj } from '@storybook/react-vite'
import { PackList } from './PackList.tsx'
import type { SubscriptionTierView, AlaCarteView, PackGrant } from '@mythrun/client-core/contract'

// PackList — the Sessions & Billing pack picker: the subscription-tier comparison over
// the à-la-carte packs. Each tier carries a SINGLE gated CTA (`subscribe` / `upgrade` /
// `manage`) resolved upstream by client-core `subscriptionCta` — an active subscriber
// never sees a plain subscribe button (spec §4) — plus its GRANT LEDGER, the
// label·value rows that say what the tier gives you per cycle. The current tier is
// marked with an ink mono line + a raised paper surface (typography and surface tier,
// not a chip); there is NO "best value"/"recommended"/"most popular" nudge (§11): the
// product states what each tier grants and lets the reader decide. À-la-carte quantity
// is a row of preset buttons (single-select) + Buy, clamped into [1, 100].
//
// Register: flat square paper cards, mono price + grant readouts, two faces (serif tier
// names, mono data). Labels are i18n'd strings the shell supplies.

const LABELS = {
  plansTitle: 'Monthly plans',
  plansHelp: "Credits arrive each month. Unused credits don't carry over.",
  alaCarteTitle: 'Or pay as you go',
  alaCarteHelp: 'Bought credits never expire.',
  subscribe: 'Subscribe',
  upgrade: 'Upgrade',
  manage: 'Manage',
  current: 'Your plan',
  buy: 'Buy',
}

// The ledger the shell composes from GET /api/billing/skus — the same rows in the same
// order in every card, which is what makes the three tiers scannable side by side.
const perMonth = (sessions: number, worlds: number): PackGrant[] => [
  { label: 'Sessions', value: `${String(sessions)} / month` },
  { label: 'Worlds', value: `${String(worlds)} / month` },
]

const TIERS_NO_SUB: SubscriptionTierView[] = [
  { lookupKey: 'tier_wayfarer', displayName: 'Wayfarer', priceLabel: '$15 / month', grants: perMonth(4, 1), cta: 'subscribe', isCurrent: false },
  { lookupKey: 'tier_sojourner', displayName: 'Sojourner', priceLabel: '$25 / month', grants: perMonth(8, 2), cta: 'subscribe', isCurrent: false },
  { lookupKey: 'tier_mythwright', displayName: 'Mythwright', priceLabel: '$45 / month', grants: perMonth(16, 4), cta: 'subscribe', isCurrent: false },
]

// Active Sojourner: the lower tier routes to the portal (manage), Sojourner is the
// current plan (manage + current marker + raised surface), Mythwright is an upgrade —
// the three CTA states an active subscriber sees, in one view.
const TIERS_ACTIVE: SubscriptionTierView[] = [
  { lookupKey: 'tier_wayfarer', displayName: 'Wayfarer', priceLabel: '$15 / month', grants: perMonth(4, 1), cta: 'manage', isCurrent: false },
  { lookupKey: 'tier_sojourner', displayName: 'Sojourner', priceLabel: '$25 / month', grants: perMonth(8, 2), cta: 'manage', isCurrent: true },
  { lookupKey: 'tier_mythwright', displayName: 'Mythwright', priceLabel: '$45 / month', grants: perMonth(16, 4), cta: 'upgrade', isCurrent: false },
]

// The world pack grants a world AND a session, so a bought world arrives playable —
// the ledger is where a reader learns that.
const ALA_CARTE: AlaCarteView[] = [
  { lookupKey: 'sku_session', displayName: 'Session', unitPriceLabel: '$5 each', grants: [{ label: 'Sessions', value: '1' }] },
  {
    lookupKey: 'sku_world',
    displayName: 'World',
    unitPriceLabel: '$9 each',
    grants: [
      { label: 'Sessions', value: '1' },
      { label: 'Worlds', value: '1' },
    ],
  },
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

// No active subscription — every tier offers a plain Subscribe. At the settings
// column's real width the three tiers sit side by side as comparison columns, so the
// grant ledgers line up and "what does $45 buy that $15 doesn't" is one glance.
export const NoSubscription: Story = {
  name: 'No subscription',
  args: { tiers: TIERS_NO_SUB, alaCarte: ALA_CARTE },
  render: (args) => (
    <div className="bg-bg p-[var(--space-6)]">
      <PackList {...args} />
    </div>
  ),
}

// Active Sojourner — shows manage (downgrade→portal), the current-plan marker on the
// raised card, and an upgrade, plus the à-la-carte packs.
export const ActiveSubscription: Story = {
  name: 'Active subscription (upgrade / current / manage)',
  args: { tiers: TIERS_ACTIVE, alaCarte: ALA_CARTE },
  render: (args) => (
    <div className="bg-bg p-[var(--space-6)]">
      <PackList {...args} />
    </div>
  ),
}

// Narrow (~375px) — the comparison track collapses to one column, so the cards stack
// full-width and the preset row wraps. Comparison becomes a scroll on a phone, which
// is the right trade at that measure.
export const Narrow: Story = {
  args: { tiers: TIERS_ACTIVE, alaCarte: ALA_CARTE },
  render: (args) => (
    <div className="max-w-[375px] bg-bg p-[var(--space-4)]">
      <PackList {...args} />
    </div>
  ),
}
