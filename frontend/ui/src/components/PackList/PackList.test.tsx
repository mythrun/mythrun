import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { PackList } from './PackList.tsx'
import type { SubscriptionTierView, AlaCarteView, PackGrant } from '@mythrun/client-core/contract'

// The i18n'd section copy + verbs the settings shell passes (copy lives in the shell,
// not the DS). Realistic interim strings — the component only reflects what it's given.
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
} as const

// The grant ledger the shell composes from GET /api/billing/skus — the same two rows,
// in the same order, in every tier card. That ordering IS the comparison.
const grants = (sessions: string, worlds: string): PackGrant[] => [
  { label: 'Sessions', value: sessions },
  { label: 'Worlds', value: worlds },
]

// Three tiers as the shell would resolve them with NO active subscription: every
// tier's gated CTA is `subscribe` (the double-subscribe guard is upstream — the
// component renders whatever cta it's handed). Named individually so a singleton
// case can reference one without index-access non-null assertions.
const wayfarerFresh: SubscriptionTierView = {
  lookupKey: 'tier_wayfarer',
  displayName: 'Wayfarer',
  priceLabel: '$15 / month',
  grants: grants('4 / month', '1 / month'),
  cta: 'subscribe',
  isCurrent: false,
}
const sojournerFresh: SubscriptionTierView = {
  lookupKey: 'tier_sojourner',
  displayName: 'Sojourner',
  priceLabel: '$25 / month',
  grants: grants('8 / month', '2 / month'),
  cta: 'subscribe',
  isCurrent: false,
}
const mythwrightFresh: SubscriptionTierView = {
  lookupKey: 'tier_mythwright',
  displayName: 'Mythwright',
  priceLabel: '$45 / month',
  grants: grants('16 / month', '4 / month'),
  cta: 'subscribe',
  isCurrent: false,
}
const freshTiers: SubscriptionTierView[] = [wayfarerFresh, sojournerFresh, mythwrightFresh]

// The active-Wayfarer shape: Wayfarer is the current plan (manage + isCurrent), the
// higher tiers upgrade — the CTA states an active subscriber sees, in one view.
const activeTiers: SubscriptionTierView[] = [
  { ...wayfarerFresh, cta: 'manage', isCurrent: true },
  { ...sojournerFresh, cta: 'upgrade' },
  { ...mythwrightFresh, cta: 'upgrade' },
]

const sessionPack: AlaCarteView = {
  lookupKey: 'sku_session',
  displayName: 'Session',
  unitPriceLabel: '$5 each',
  grants: [{ label: 'Sessions', value: '1' }],
}
// The world pack grants a world AND a session, so a bought world arrives playable.
const worldPack: AlaCarteView = {
  lookupKey: 'sku_world',
  displayName: 'World',
  unitPriceLabel: '$9 each',
  grants: [
    { label: 'Worlds', value: '1' },
    { label: 'Sessions', value: '1' },
  ],
}

describe('PackList', () => {
  it('renders each tier with its displayName, priceLabel, and a CTA labeled by its cta', () => {
    const { getByText, getAllByRole } = render(
      <PackList
        tiers={freshTiers}
        alaCarte={[]}
        quantityPresets={[1, 4, 8]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(getByText('Wayfarer')).toBeInTheDocument()
    expect(getByText('$15 / month')).toBeInTheDocument()
    expect(getByText('Sojourner')).toBeInTheDocument()
    expect(getByText('Mythwright')).toBeInTheDocument()
    // Three `subscribe` ctas → three "Subscribe" buttons.
    expect(getAllByRole('button', { name: 'Subscribe' })).toHaveLength(3)
  })

  // myth-9jrh9 — the defect this component shipped with: three cards carrying name +
  // price and NOTHING else, i.e. "pay $30 more per month for a name change". Every
  // tier now states what it grants, so the reader can answer "why would I pay more?"
  // without leaving the screen.
  it('renders each tier’s grant ledger — the value that differentiates the tiers', () => {
    const { getByTestId } = render(
      <PackList
        tiers={freshTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    const wayfarer = within(getByTestId('pack-list-tier-tier_wayfarer'))
    expect(wayfarer.getByText('4 / month')).toBeInTheDocument()
    expect(wayfarer.getByText('1 / month')).toBeInTheDocument()

    const mythwright = within(getByTestId('pack-list-tier-tier_mythwright'))
    expect(mythwright.getByText('16 / month')).toBeInTheDocument()
    expect(mythwright.getByText('4 / month')).toBeInTheDocument()
  })

  // A pricing table's job is comparison: the same rows, in the same order, in every
  // column — so the eye scans ACROSS the ledgers instead of holding three cards in
  // memory. The component preserves the shell's row order verbatim; this pins that.
  it('renders the grant rows in the same order in EVERY tier — the scan-across contract', () => {
    const { getByTestId } = render(
      <PackList
        tiers={freshTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    const labelsFor = (lookupKey: string): (string | null)[] =>
      within(getByTestId(`pack-list-tier-${lookupKey}`))
        .getAllByTestId(/grant-label$/)
        .map((el) => el.textContent)

    expect(labelsFor('tier_wayfarer')).toEqual(['Sessions', 'Worlds'])
    expect(labelsFor('tier_sojourner')).toEqual(['Sessions', 'Worlds'])
    expect(labelsFor('tier_mythwright')).toEqual(['Sessions', 'Worlds'])
  })

  // Run-1's cards were FULL-WIDTH and STACKED, so comparing three plans meant a
  // vertical scroll with memory load on a ~1200px column that was ~70% empty. The
  // tiers ride a multi-column auto-fit track instead: a horizontal glance at desktop
  // width, collapsing to the stack only at phone widths. Pinned so a refactor cannot
  // quietly return the surface to a stack.
  it('lays the tiers out as a multi-column comparison track, not a full-width stack', () => {
    const { getByTestId } = render(
      <PackList
        tiers={freshTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    const track = getByTestId('pack-list-plans').querySelector('.grid')
    expect(track).not.toBeNull()
    expect(track?.getAttribute('style')).toMatch(/auto-fit/)
  })

  it('renders the section headings and their one-line notes', () => {
    const { getByText } = render(
      <PackList
        tiers={freshTiers}
        alaCarte={[sessionPack]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(getByText(LABELS.plansTitle)).toBeInTheDocument()
    expect(getByText(LABELS.plansHelp)).toBeInTheDocument()
    expect(getByText(LABELS.alaCarteTitle)).toBeInTheDocument()
    expect(getByText(LABELS.alaCarteHelp)).toBeInTheDocument()
  })

  // The à-la-carte section IS the top-up path, and the world pack's second grant is
  // the load-bearing fact: buying a world also buys the session that plays it.
  it('renders each à-la-carte pack with its unit price and what one unit grants', () => {
    const { getByTestId } = render(
      <PackList
        tiers={[]}
        alaCarte={[sessionPack, worldPack]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    const world = within(getByTestId('pack-list-pack-sku_world'))
    expect(world.getByText('$9 each')).toBeInTheDocument()
    expect(world.getByText('Worlds')).toBeInTheDocument()
    expect(world.getByText('Sessions')).toBeInTheDocument()
  })

  it("fires onTierCta(lookupKey, cta) with the tier's gated cta on press", async () => {
    const onTierCta = vi.fn()
    const user = userEvent.setup()
    const { getByTestId } = render(
      <PackList
        tiers={[sojournerFresh]}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={onTierCta}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    await user.click(getByTestId('pack-list-tier-cta-tier_sojourner'))
    expect(onTierCta).toHaveBeenCalledOnce()
    expect(onTierCta).toHaveBeenCalledWith('tier_sojourner', 'subscribe')
  })

  // Run-1: the ONLY signals for the active plan were a low-contrast gray caption and
  // the CTA verb — "state communication is a whisper", and a WCAG-borderline whisper
  // at that. The marker is now an ink mono LABEL (no muted tone) and the card carries
  // the raised paper surface, so the current plan is found without reading.
  it('marks the current tier with an ink mono label AND a raised card, still routing to manage', async () => {
    const onTierCta = vi.fn()
    const user = userEvent.setup()
    const { getByText, getByTestId } = render(
      <PackList
        tiers={activeTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={onTierCta}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    // The marker is prose/typographic (mono ui-label), not a chip — and NOT the muted
    // `meta` tone the run-1 caption used.
    const marker = getByText('Your plan')
    expect(marker.className).toMatch(/font-ui/)
    expect(marker.className).not.toMatch(/text-ink-secondary/)
    // The current card sits one paper step up; the others stay on the base surface.
    expect(getByTestId('pack-list-tier-tier_wayfarer').className).toMatch(/bg-surface-raised/)
    expect(getByTestId('pack-list-tier-tier_sojourner').className).not.toMatch(/bg-surface-raised/)
    // The current tier's action is still `manage` — never a second subscribe.
    await user.click(getByTestId('pack-list-tier-cta-tier_wayfarer'))
    expect(onTierCta).toHaveBeenCalledOnce()
    expect(onTierCta).toHaveBeenCalledWith('tier_wayfarer', 'manage')
  })

  it('renders the upgrade verb for a higher tier when subscribed', () => {
    const { getAllByRole } = render(
      <PackList
        tiers={activeTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(getAllByRole('button', { name: 'Upgrade' })).toHaveLength(2)
  })

  // The grant ledger states what a tier GIVES; it never nudges which one to take.
  // §11 bans the anchor/decoy vocabulary outright, so no amount of differentiation
  // may reintroduce it.
  it('renders NO "best value" / "recommended" / "most popular" label anywhere (register constraint)', () => {
    const { queryByText } = render(
      <PackList
        tiers={activeTiers}
        alaCarte={[sessionPack, worldPack]}
        quantityPresets={[1, 4, 8, 16]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(queryByText(/best value/i)).toBeNull()
    expect(queryByText(/recommended/i)).toBeNull()
    expect(queryByText(/popular/i)).toBeNull()
  })

  it('buys an à-la-carte pack at the chosen preset quantity', async () => {
    const onBuyAlaCarte = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PackList
        tiers={[]}
        alaCarte={[sessionPack]}
        quantityPresets={[1, 4, 8]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={onBuyAlaCarte}
        labels={LABELS}
      />,
    )
    // Pick a non-default preset, then buy.
    await user.click(getByRole('button', { name: '4' }))
    await user.click(getByRole('button', { name: 'Buy' }))
    expect(onBuyAlaCarte).toHaveBeenCalledOnce()
    expect(onBuyAlaCarte).toHaveBeenCalledWith('sku_session', 4)
  })

  it('marks the selected à-la-carte preset with aria-pressed (single-select toggle state)', async () => {
    const user = userEvent.setup()
    const { getByRole } = render(
      <PackList
        tiers={[]}
        alaCarte={[sessionPack]}
        quantityPresets={[1, 4, 8]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    // Default: the first preset (1) is the selected toggle; the others are released.
    expect(getByRole('button', { name: '1', pressed: true })).toBeInTheDocument()
    expect(getByRole('button', { name: '4', pressed: false })).toBeInTheDocument()
    expect(getByRole('button', { name: '8', pressed: false })).toBeInTheDocument()
    // Picking 4 moves the pressed state onto it and releases 1.
    await user.click(getByRole('button', { name: '4' }))
    expect(getByRole('button', { name: '4', pressed: true })).toBeInTheDocument()
    expect(getByRole('button', { name: '1', pressed: false })).toBeInTheDocument()
  })

  it('buys at the default (first-preset) quantity when no preset is picked', async () => {
    const onBuyAlaCarte = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PackList
        tiers={[]}
        alaCarte={[sessionPack]}
        quantityPresets={[8, 16]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={onBuyAlaCarte}
        labels={LABELS}
      />,
    )
    await user.click(getByRole('button', { name: 'Buy' }))
    expect(onBuyAlaCarte).toHaveBeenCalledOnce()
    expect(onBuyAlaCarte).toHaveBeenCalledWith('sku_session', 8)
  })

  it('clamps an over-range preset DOWN to 100', async () => {
    const onBuyAlaCarte = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PackList
        tiers={[]}
        alaCarte={[sessionPack]}
        quantityPresets={[200]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={onBuyAlaCarte}
        labels={LABELS}
      />,
    )
    await user.click(getByRole('button', { name: 'Buy' }))
    expect(onBuyAlaCarte).toHaveBeenCalledWith('sku_session', 100)
  })

  it('clamps a below-range preset UP to 1', async () => {
    const onBuyAlaCarte = vi.fn()
    const user = userEvent.setup()
    const { getByRole } = render(
      <PackList
        tiers={[]}
        alaCarte={[sessionPack]}
        quantityPresets={[0]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={onBuyAlaCarte}
        labels={LABELS}
      />,
    )
    await user.click(getByRole('button', { name: 'Buy' }))
    expect(onBuyAlaCarte).toHaveBeenCalledWith('sku_session', 1)
  })

  it('is square / paper register — no circular marks, price + grants in the mono register', () => {
    const { container, getByText } = render(
      <PackList
        tiers={[wayfarerFresh]}
        alaCarte={[sessionPack]}
        quantityPresets={[1, 4]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    // No circular marks anywhere (rounded-full is banned brand-wide).
    expect(container.querySelector('.rounded-full')).toBeNull()
    // The price + grant readouts are the mono data register — the ledger face, and
    // the reason the grant list needs no bullet glyph.
    expect(getByText('$15 / month').className).toMatch(/font-ui/)
    expect(getByText('$5 each').className).toMatch(/font-ui/)
    expect(getByText('4 / month').className).toMatch(/font-ui/)
  })

  it('defaults the root test id and lets it be overridden', () => {
    const { getByTestId, rerender } = render(
      <PackList
        tiers={freshTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(getByTestId('pack-list')).toBeInTheDocument()
    rerender(
      <PackList
        tiers={freshTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
        data-testid="settings-packs"
      />,
    )
    expect(getByTestId('settings-packs')).toBeInTheDocument()
  })

  it('forwards the ref to the root element', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <PackList
        ref={ref}
        tiers={freshTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PackList
        tiers={activeTiers}
        alaCarte={[sessionPack, worldPack]}
        quantityPresets={[1, 4, 8, 16]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
