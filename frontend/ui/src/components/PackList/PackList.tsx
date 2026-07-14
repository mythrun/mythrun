import { forwardRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PackListProps, SubscriptionTierView, AlaCarteView } from '@mythrun/client-core/contract'
import { Stack } from '../Stack/Stack.tsx'
import { Card, CardBody } from '../Card/Card.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Button } from '../Button/Button.tsx'

// PackList (MYT-95) — the Sessions & Billing pack picker: the subscription-tier
// split over the à-la-carte packs. Each tier renders a SINGLE gated CTA whose verb
// is `labels[tier.cta]` — the gating decision (`subscribe`/`upgrade`/`manage`) is
// made upstream in client-core `subscriptionCta` and only RENDERED here, so an
// active subscriber can never reach a plain subscribe button (spec §4). The
// current tier is marked with a quiet mono "current" line (typography, NOT a chip),
// and its action stays `manage`.
//
// Register (§3): flat square paper Cards, mono price readouts, two faces only
// (serif tier names via Heading, mono data via Text role="data"/"meta"). NO
// chips/dots, NO "best value"/"recommended" nudge (§11) — the component renders
// only the shell-supplied name/price/verbs, so no such label can appear.
//
// À-la-carte quantity is a row of preset Buttons (single-select, the picked preset
// carries the bordered `secondary` treatment; the rest are `ghost`) + a Buy Button.
// Presets are clamped into [1, 100] — the defensive guard the buy handler emits.

/** Clamp a quantity into the purchasable [1, 100] range (Stripe line-item bound). */
function clampQuantity(quantity: number): number {
  return Math.min(100, Math.max(1, quantity))
}

/** The gated CTA verb tier button — `manage` is a neutral (secondary) management
 *  action; `subscribe`/`upgrade` are the accent purchase actions. */
function tierCtaVariant(cta: SubscriptionTierView['cta']): 'primary' | 'secondary' {
  return cta === 'manage' ? 'secondary' : 'primary'
}

/** One subscription-tier card: name (serif) + price (mono) + optional "current"
 *  line + the single gated CTA. */
function TierCard({
  tier,
  ctaLabel,
  currentLabel,
  onTierCta,
}: {
  readonly tier: SubscriptionTierView
  readonly ctaLabel: string
  readonly currentLabel: string
  readonly onTierCta: PackListProps['onTierCta']
}): ReactElement {
  return (
    <Card>
      <CardBody>
        <Stack gap={2} align="start">
          <Heading level={3} role="title">
            {tier.displayName}
          </Heading>
          <Text role="data">{tier.priceLabel}</Text>
          {tier.isCurrent && <Text role="meta">{currentLabel}</Text>}
          <Button
            variant={tierCtaVariant(tier.cta)}
            onPress={() => {
              onTierCta(tier.lookupKey, tier.cta)
            }}
            data-testid={`pack-list-tier-cta-${tier.lookupKey}`}
          >
            {ctaLabel}
          </Button>
        </Stack>
      </CardBody>
    </Card>
  )
}

/** One à-la-carte pack card: name (serif) + unit price (mono) + a preset-quantity
 *  row + Buy. Selection is local (the shell only learns the chosen quantity on buy). */
function AlaCarteCard({
  pack,
  presets,
  buyLabel,
  onBuyAlaCarte,
}: {
  readonly pack: AlaCarteView
  readonly presets: readonly number[]
  readonly buyLabel: string
  readonly onBuyAlaCarte: PackListProps['onBuyAlaCarte']
}): ReactElement {
  const defaultQuantity = clampQuantity(presets[0] ?? 1)
  const [quantity, setQuantity] = useState<number>(defaultQuantity)
  return (
    <Card>
      <CardBody>
        <Stack gap={2} align="start">
          <Heading level={3} role="title">
            {pack.displayName}
          </Heading>
          <Text role="data">{pack.unitPriceLabel}</Text>
          {presets.length > 0 && (
            <Stack direction="row" gap={2} wrap>
              {presets.map((preset, index) => {
                const value = clampQuantity(preset)
                return (
                  <Button
                    // Presets can repeat after clamping (e.g. [150, 200] → 100/100),
                    // so the index (stable, order-preserving) is the React key.
                    key={index}
                    variant={quantity === value ? 'secondary' : 'ghost'}
                    // Single-select toggle state: the picked preset reports pressed
                    // to assistive tech (the variant is the visual half, this the
                    // semantic half). See ButtonProps `aria-pressed`.
                    aria-pressed={quantity === value}
                    onPress={() => {
                      setQuantity(value)
                    }}
                  >
                    {String(value)}
                  </Button>
                )
              })}
            </Stack>
          )}
          <Button
            variant="primary"
            onPress={() => {
              onBuyAlaCarte(pack.lookupKey, quantity)
            }}
            data-testid={`pack-list-buy-${pack.lookupKey}`}
          >
            {buyLabel}
          </Button>
        </Stack>
      </CardBody>
    </Card>
  )
}

export const PackList = forwardRef<HTMLDivElement, PackListProps>(function PackList(
  { tiers, alaCarte, quantityPresets, onTierCta, onBuyAlaCarte, labels, 'data-testid': testId = 'pack-list' },
  ref,
) {
  return (
    <div ref={ref} data-testid={testId}>
      <Stack gap={4}>
        {tiers.map((tier) => (
          <TierCard
            key={tier.lookupKey}
            tier={tier}
            ctaLabel={labels[tier.cta]}
            currentLabel={labels.current}
            onTierCta={onTierCta}
          />
        ))}
        {alaCarte.map((pack) => (
          <AlaCarteCard
            key={pack.lookupKey}
            pack={pack}
            presets={quantityPresets}
            buyLabel={labels.buy}
            onBuyAlaCarte={onBuyAlaCarte}
          />
        ))}
      </Stack>
    </div>
  )
})
