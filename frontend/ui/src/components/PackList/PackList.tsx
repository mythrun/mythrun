import { forwardRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  PackListProps,
  SubscriptionTierView,
  AlaCarteView,
  PackGrant,
} from '@mythrun/client-core/contract'
import { Stack } from '../Stack/Stack.tsx'
import { Grid } from '../Grid/Grid.tsx'
import { Card, CardBody } from '../Card/Card.tsx'
import { Divider } from '../Divider/Divider.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Button } from '../Button/Button.tsx'

// PackList (MYT-95) — the Sessions & Billing pack picker: the subscription-tier
// comparison over the à-la-carte packs. Each tier renders a SINGLE gated CTA whose
// verb is `labels[tier.cta]` — the gating decision (`subscribe`/`upgrade`/`manage`)
// is made upstream in client-core `subscriptionCta` and only RENDERED here, so an
// active subscriber can never reach a plain subscribe button (spec §4).
//
// Register (§3): flat square paper Cards, mono readouts, two faces only (serif tier
// names via Heading, mono data via Text role="ui-label"/"data"). NO chips/dots, NO
// "best value"/"recommended"/"most popular" nudge (§11) — the component renders only
// the shell-supplied name/price/grants/verbs, so no such label can appear.
//
// DECIDABILITY (myth-9jrh9). Run-1 shipped this as three FULL-WIDTH STACKED cards
// carrying a name, a price, and a button — a pricing table with nothing to compare,
// where the difference between $15 and $45 was a name change. Three changes, all
// structural:
//
//   1. GRANT LEDGER. Every tier and pack states what it grants as label·value rows
//      the shell composes from GET /api/billing/skus (`sessionsGranted` /
//      `worldsGranted`), so the UI cannot drift from Stripe. Row ORDER is the shell's
//      and is preserved verbatim, which is what makes the ledgers line up across the
//      three cards. Note there is no bullet glyph: the label·value ledger row is
//      already the product's list convention (the brand bans dots/checks, and a mono
//      field-label column reads as a table without needing a marker).
//   2. COMPARISON COLUMNS. The tiers sit in an auto-fit track, so the comparison is a
//      horizontal glance at desktop width and only falls back to the stack at phone
//      widths — the layout follows the task instead of fighting it.
//   3. CURRENT-PLAN WEIGHT. The active tier's marker is an ink mono `ui-label` (the
//      run-1 caption was muted `meta` on cream — a WCAG-borderline whisper for the
//      most important status on the page) and its card sits one paper surface step up.
//      Typography + surface tier, never a chip or badge.
//
// The à-la-carte section is the TOP-UP path (run-1 had none on this screen at all):
// its own heading + note, and each pack's ledger states what one unit buys — which is
// how a reader learns the world pack includes the session that plays it.
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

/** The grant ledger: one justified mono row per metered thing, in the shell's order.
 *  Label left (`ui-label`), amount right (`data`) — the same label·value convention the
 *  rest of the product reads in, so the column of labels IS the comparison table. */
function GrantLedger({
  grants,
  testId,
}: {
  readonly grants: readonly PackGrant[]
  readonly testId: string
}): ReactElement | null {
  if (grants.length === 0) return null
  return (
    <Stack gap={1}>
      {grants.map((grant) => (
        <Stack key={grant.label} direction="row" justify="between" align="center" gap={3}>
          <Text role="ui-label" truncate data-testid={`${testId}-grant-label`}>
            {grant.label}
          </Text>
          <Text role="data" noShrink data-testid={`${testId}-grant-value`}>
            {grant.value}
          </Text>
        </Stack>
      ))}
    </Stack>
  )
}

/** One subscription-tier card: the current marker (when active) over name (serif) +
 *  price (mono), a rule, the grant ledger, and the single gated CTA. */
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
    <Card
      surface={tier.isCurrent ? 'raised' : 'base'}
      data-testid={`pack-list-tier-${tier.lookupKey}`}
    >
      <CardBody>
        <Stack gap={3}>
          {/* The current-plan marker leads the card so the eye lands on "which one am
              I on?" before it reads anything. Ink mono, not the muted caption tone. */}
          {tier.isCurrent && (
            <Text role="ui-label" data-testid={`pack-list-tier-current-${tier.lookupKey}`}>
              {currentLabel}
            </Text>
          )}
          <Stack gap={1} align="start">
            <Heading level={3} role="title">
              {tier.displayName}
            </Heading>
            <Text role="data">{tier.priceLabel}</Text>
          </Stack>
          <Divider />
          <GrantLedger grants={tier.grants} testId={`pack-list-tier-${tier.lookupKey}`} />
          <Stack align="start">
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
        </Stack>
      </CardBody>
    </Card>
  )
}

/** One à-la-carte pack card: name (serif) + unit price (mono) + what one unit grants +
 *  a preset-quantity row + Buy. Selection is local (the shell only learns the chosen
 *  quantity on buy). */
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
    <Card data-testid={`pack-list-pack-${pack.lookupKey}`}>
      <CardBody>
        <Stack gap={3}>
          <Stack gap={1} align="start">
            <Heading level={3} role="title">
              {pack.displayName}
            </Heading>
            <Text role="data">{pack.unitPriceLabel}</Text>
          </Stack>
          <Divider />
          <GrantLedger grants={pack.grants} testId={`pack-list-pack-${pack.lookupKey}`} />
          <Stack gap={2} align="start">
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
        </Stack>
      </CardBody>
    </Card>
  )
}

/** A titled section: heading + its one-line note over the card track. Rendered only
 *  when the section has cards — an empty catalogue slice shows no heading. */
function PackSection({
  title,
  help,
  testId,
  children,
}: {
  readonly title: string
  readonly help: string
  readonly testId: string
  readonly children: ReactElement[]
}): ReactElement | null {
  if (children.length === 0) return null
  return (
    <Stack gap={3} data-testid={testId}>
      <Stack gap={1}>
        <Heading level={2}>{title}</Heading>
        <Text role="ui-caption" as="p">
          {help}
        </Text>
      </Stack>
      {/* auto-FIT: the three tiers fill the row as comparison columns at desktop width
          and collapse to one column on a phone. 260px is the floor at which a card
          still holds its ledger rows without the value wrapping under its label. */}
      <Grid columns="auto-fit" minColumnPx={260} gap={4}>
        {children}
      </Grid>
    </Stack>
  )
}

export const PackList = forwardRef<HTMLDivElement, PackListProps>(function PackList(
  { tiers, alaCarte, quantityPresets, onTierCta, onBuyAlaCarte, labels, 'data-testid': testId = 'pack-list' },
  ref,
) {
  return (
    <Stack ref={ref} gap={6} data-testid={testId}>
      <PackSection title={labels.plansTitle} help={labels.plansHelp} testId="pack-list-plans">
        {tiers.map((tier) => (
          <TierCard
            key={tier.lookupKey}
            tier={tier}
            ctaLabel={labels[tier.cta]}
            currentLabel={labels.current}
            onTierCta={onTierCta}
          />
        ))}
      </PackSection>
      <PackSection
        title={labels.alaCarteTitle}
        help={labels.alaCarteHelp}
        testId="pack-list-ala-carte"
      >
        {alaCarte.map((pack) => (
          <AlaCarteCard
            key={pack.lookupKey}
            pack={pack}
            presets={quantityPresets}
            buyLabel={labels.buy}
            onBuyAlaCarte={onBuyAlaCarte}
          />
        ))}
      </PackSection>
    </Stack>
  )
})
