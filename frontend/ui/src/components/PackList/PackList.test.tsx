import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { PackList } from './PackList.tsx'
import type { SubscriptionTierView, AlaCarteView } from '@mythrun/client-core/contract'

// The i18n'd verbs the settings shell passes (copy lives in the shell, not the DS).
// Realistic interim strings — the component only reflects what it's given.
const LABELS = {
  subscribe: 'Subscribe',
  upgrade: 'Upgrade',
  manage: 'Manage',
  current: 'Current plan',
  buy: 'Buy',
} as const

// Three tiers as the shell would resolve them with NO active subscription: every
// tier's gated CTA is `subscribe` (the double-subscribe guard is upstream — the
// component renders whatever cta it's handed). Named individually so a singleton
// case can reference one without index-access non-null assertions.
const wayfarerFresh: SubscriptionTierView = {
  lookupKey: 'tier_wayfarer',
  displayName: 'Wayfarer',
  priceLabel: '$8 / mo',
  cta: 'subscribe',
  isCurrent: false,
}
const sojournerFresh: SubscriptionTierView = {
  lookupKey: 'tier_sojourner',
  displayName: 'Sojourner',
  priceLabel: '$12 / mo',
  cta: 'subscribe',
  isCurrent: false,
}
const mythwrightFresh: SubscriptionTierView = {
  lookupKey: 'tier_mythwright',
  displayName: 'Mythwright',
  priceLabel: '$16 / mo',
  cta: 'subscribe',
  isCurrent: false,
}
const freshTiers: SubscriptionTierView[] = [wayfarerFresh, sojournerFresh, mythwrightFresh]

// The active-Sojourner shape: the lower tier routes to the portal (manage, not
// current), Sojourner is the current plan (manage + isCurrent), Mythwright upgrades.
const activeTiers: SubscriptionTierView[] = [
  { lookupKey: 'tier_wayfarer', displayName: 'Wayfarer', priceLabel: '$8 / mo', cta: 'manage', isCurrent: false },
  { lookupKey: 'tier_sojourner', displayName: 'Sojourner', priceLabel: '$12 / mo', cta: 'manage', isCurrent: true },
  { lookupKey: 'tier_mythwright', displayName: 'Mythwright', priceLabel: '$16 / mo', cta: 'upgrade', isCurrent: false },
]

const sessionPack: AlaCarteView = {
  lookupKey: 'sku_session',
  displayName: 'Session pack',
  unitPriceLabel: '$5 each',
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
    expect(getByText('$8 / mo')).toBeInTheDocument()
    expect(getByText('Sojourner')).toBeInTheDocument()
    expect(getByText('Mythwright')).toBeInTheDocument()
    // Three `subscribe` ctas → three "Subscribe" buttons.
    expect(getAllByRole('button', { name: 'Subscribe' })).toHaveLength(3)
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

  it('marks the current tier with the mono "current" line AND still routes its action to manage', async () => {
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
    // The "current" marker is prose/typographic (mono), not a chip.
    const marker = getByText('Current plan')
    expect(marker).toBeInTheDocument()
    expect(marker.className).toMatch(/font-ui/)
    // The current tier's action is still `manage` — never a second subscribe.
    await user.click(getByTestId('pack-list-tier-cta-tier_sojourner'))
    expect(onTierCta).toHaveBeenCalledOnce()
    expect(onTierCta).toHaveBeenCalledWith('tier_sojourner', 'manage')
  })

  it('renders the upgrade verb for a higher tier when subscribed', () => {
    const { getByRole } = render(
      <PackList
        tiers={activeTiers}
        alaCarte={[]}
        quantityPresets={[1]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(getByRole('button', { name: 'Upgrade' })).toBeInTheDocument()
  })

  it('renders NO "best value" / "recommended" label anywhere (register constraint)', () => {
    const { queryByText } = render(
      <PackList
        tiers={activeTiers}
        alaCarte={[sessionPack]}
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

  it('is square / paper register — no circular marks, price in the mono register', () => {
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
    // The price readouts are the mono data register.
    expect(getByText('$8 / mo').className).toMatch(/font-ui/)
    expect(getByText('$5 each').className).toMatch(/font-ui/)
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
        alaCarte={[sessionPack]}
        quantityPresets={[1, 4, 8, 16]}
        onTierCta={vi.fn()}
        onBuyAlaCarte={vi.fn()}
        labels={LABELS}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
