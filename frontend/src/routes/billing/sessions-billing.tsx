import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Stack, Heading, Text, Button, CreditBalance, PackList, PurchaseHistory } from '@mythrun/ui'
import {
  useApiContext,
  useBalance,
  useSkus,
  useHistory,
  createCheckout,
  openPortal,
  upgradeTier,
  balanceView,
  subscriptionTiers,
  aLaCarteSkus,
  subscriptionCta,
  purchaseHistoryView,
  isHttpError,
  type SkuListing,
  type ActiveSubscriptionSummary,
  type HistoryRowView,
  type CheckoutBody,
} from '@mythrun/client-core'
import type {
  SubscriptionTierView,
  AlaCarteView,
  PackGrant,
  PurchaseHistoryRow,
} from '@mythrun/client-core/contract'
import { redirectTo, currentOrigin, currentHref } from '../../platform/web/navigation.ts'
import { BUY_ANCHOR } from '../../app/paths.ts'

// The wired Sessions & Billing surface (MYT-95 Task 11) — the composition shell the
// `/billing` route mounts under Suspense. It reads the three billing suspense
// queries and hands each derived view to a DS component:
//   • CreditBalance   — both credit buckets, itemised, NEVER summed (spec §4), each
//     in its own explained tile (MYT-9jrh9).
//   • PackList        — the price-ordered subscription tiers, each with its GATED
//     CTA (subscribe / upgrade / manage) resolved upstream by `subscriptionCta`
//     (an active subscriber can never reach plain subscribe — the double-subscribe
//     guard) AND its grant ledger, over the à-la-carte packs with quantity presets.
//   • PurchaseHistory — the terse ledger feed; a pack row (lookup_key null) names
//     no credit count, an invoice row may name its tier.
// Each affordance routes to the matching client-core mutation and then navigates
// the browser to the returned Stripe URL through the platform navigation seam (a
// screen never touches `window`, R1). The credit grant itself rides the async
// checkout webhook — the checkout-return route (Task 12) confirms it.

const QUANTITY_PRESETS = [1, 4, 8, 16] as const
const UPGRADE_PENDING_CODE = 'upgrade_already_pending'

interface Formatters {
  readonly money: (cents: number, currency: string) => string
  readonly perMonth: (price: string) => string
  readonly each: (price: string) => string
  readonly grants: (sku: SkuListing, recurring: boolean) => PackGrant[]
}

function makeFormatters(t: TFunction, locale: string): Formatters {
  const money = (cents: number, currency: string): string => {
    // Consumer pricing drops the trailing `.00` on whole amounts ("$15", not
    // "$15.00" — a developer-formatted-decimal tell); a fractional price keeps its
    // cents. (MYT-9jrh9 decidability polish.)
    const whole = cents % 100 === 0
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
    }).format(cents / 100)
  }
  const count = new Intl.NumberFormat(locale)
  // The grant ledger every tier/pack card renders (MYT-9jrh9). It is composed from
  // the SKU payload's own `sessionsGranted` / `worldsGranted`, never from a frontend
  // table of tier sizes — the catalogue is served from the Stripe-probed SKU cache, so
  // reading it here is what keeps the pricing UI from drifting off Stripe. Sessions
  // lead, then worlds, in EVERY card: the fixed order is what lets the reader scan
  // across the three tiers instead of re-reading each one. A zero grant renders no row
  // (the session pack has no world, and an empty "Worlds 0" line is noise, not data).
  const grants = (sku: SkuListing, recurring: boolean): PackGrant[] => {
    const amount = (n: number): string =>
      recurring ? t('billing.grantPerMonth', { amount: count.format(n) }) : count.format(n)
    const rows: PackGrant[] = []
    if (sku.sessionsGranted > 0) rows.push({ label: t('billing.grantSessions'), value: amount(sku.sessionsGranted) })
    if (sku.worldsGranted > 0) rows.push({ label: t('billing.grantWorlds'), value: amount(sku.worldsGranted) })
    return rows
  }
  return {
    money,
    perMonth: (price) => t('billing.pricePerMonth', { price }),
    each: (price) => t('billing.priceEach', { price }),
    grants,
  }
}

function buildTierViews(
  tiers: readonly SkuListing[],
  activeSubscription: ActiveSubscriptionSummary | null,
  skus: readonly SkuListing[],
  fmt: Formatters,
): SubscriptionTierView[] {
  return tiers.map((sku) => {
    const decision = subscriptionCta({ activeSubscription, targetTierLookupKey: sku.lookup_key, skus })
    return {
      lookupKey: sku.lookup_key,
      displayName: sku.displayName,
      priceLabel: fmt.perMonth(fmt.money(sku.price.unit_amount_cents, sku.price.currency)),
      grants: fmt.grants(sku, true),
      cta: decision.cta,
      isCurrent: decision.isCurrent,
    }
  })
}

function buildAlaCarteViews(packs: readonly SkuListing[], fmt: Formatters): AlaCarteView[] {
  return packs.map((sku) => ({
    lookupKey: sku.lookup_key,
    displayName: sku.displayName,
    unitPriceLabel: fmt.each(fmt.money(sku.price.unit_amount_cents, sku.price.currency)),
    // Per UNIT, not per chosen quantity — the price line reads "$9 each", so the
    // ledger beside it reads the same way. This is where the reader learns the world
    // pack carries the session that plays the world it just bought.
    grants: fmt.grants(sku, false),
  }))
}

function historyRowLabel(row: HistoryRowView, t: TFunction, money: Formatters['money']): string {
  const amount = money(row.amountCents, row.currency)
  const base =
    row.kind === 'invoice' && row.tierDisplayName !== null
      ? t('billing.history.subscription', { tier: row.tierDisplayName, amount })
      : row.kind === 'refund'
        ? t('billing.history.refund', { amount })
        : t('billing.history.purchase', { amount })
  // Refunds (incl. a reversed pack purchase, whose kind is still `purchase`) carry
  // a terse prose suffix; the DS also demotes the row typographically off `refunded`.
  return row.refunded ? `${base} ${t('billing.history.refundedSuffix')}` : base
}

/** The two credit buckets, each in its own tile with its own explainer (MYT-9jrh9).
 *  Run-1's counters were bare label-number pairs with no way to form a mental model;
 *  the mechanics are real and the copy states them — a session credit starts one
 *  session, a world credit builds one world (characters included) and is what starts
 *  a new campaign. The explainers live WITH their number rather than in a block below
 *  the pair, so neither line can be read against the wrong currency. */
function CreditSection({
  view,
  t,
}: {
  readonly view: ReturnType<typeof balanceView>
  readonly t: TFunction
}): React.JSX.Element {
  return (
    <CreditBalance
      session={view.session}
      sessionLabel={t('billing.sessionLabel')}
      sessionHelp={t('billing.sessionHelp')}
      sessionZeroHelp={t('billing.sessionZeroHelp')}
      worldGen={view.worldGen}
      worldGenLabel={t('billing.worldGenLabel')}
      worldGenHelp={t('billing.worldGenHelp')}
      worldGenZeroHelp={t('billing.worldGenZeroHelp')}
    />
  )
}

export function SessionsBilling(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const ctx = useApiContext()
  const balanceQuery = useBalance()
  const { data: skus } = useSkus()
  const { data: history } = useHistory()
  const [pendingUpgrade, setPendingUpgrade] = useState(false)
  const buySectionRef = useRef<HTMLElement | null>(null)

  const { hash } = useLocation()
  // #buy deep-link (spec §Scroll mechanics): React Router doesn't fragment-
  // scroll, and this section mounts inside a Suspense boundary, so a DOM id
  // anchor works in NO navigation mode. Scroll once the data-resolved section
  // exists; scroll-mt clears the sticky bar (96px ≥ the 88px max bar height).
  useEffect(() => {
    if (hash === BUY_ANCHOR) buySectionRef.current?.scrollIntoView()
  }, [hash])

  const balance = balanceQuery.data
  const view = balanceView(balance, skus)
  const fmt = makeFormatters(t, i18n.language)
  const tiers = buildTierViews(subscriptionTiers(skus), balance.active_subscription, skus, fmt)
  const packs = buildAlaCarteViews(aLaCarteSkus(skus), fmt)
  const rows: PurchaseHistoryRow[] = purchaseHistoryView(history.events, skus).map((row) => ({
    id: row.id,
    label: historyRowLabel(row, t, fmt.money),
    refunded: row.refunded,
  }))

  const checkoutFor = async (items: CheckoutBody['items']): Promise<void> => {
    const res = await createCheckout(ctx, {
      items,
      success_url: `${currentOrigin()}/billing/return`,
      cancel_url: `${currentOrigin()}/billing/cancelled`,
    })
    redirectTo(res.url)
  }

  const runUpgrade = async (sku: SkuListing): Promise<void> => {
    try {
      await upgradeTier(ctx, { target_tier_lookup_key: sku.lookup_key })
      await balanceQuery.refetch()
    } catch (err) {
      // A prior upgrade still mid-flight → the calm pending arm, not an error.
      if (isHttpError(err) && err.status === 409 && err.code === UPGRADE_PENDING_CODE) {
        setPendingUpgrade(true)
        return
      }
      throw err
    }
  }

  const openBillingPortal = async (): Promise<void> => {
    const res = await openPortal(ctx, { return_url: currentHref() })
    redirectTo(res.url)
  }

  const onTierCta = (lookupKey: string, cta: 'subscribe' | 'upgrade' | 'manage'): void => {
    const sku = skus.find((s) => s.lookup_key === lookupKey)
    // `manage` (and any unresolvable tier — the gating guard's defensive arm) →
    // the Customer Portal; `upgrade` → prorated upgrade; `subscribe` → Checkout.
    if (cta === 'manage' || sku === undefined) return void openBillingPortal()
    if (cta === 'upgrade') return void runUpgrade(sku)
    void checkoutFor([{ lookup_key: sku.lookup_key, quantity: 1 }])
  }

  const onBuyAlaCarte = (lookupKey: string, quantity: number): void => {
    const sku = skus.find((s) => s.lookup_key === lookupKey)
    if (sku === undefined) return
    void checkoutFor([{ lookup_key: sku.lookup_key, quantity }])
  }

  return (
    <Stack gap={6} data-testid="sessions-billing">
      <CreditSection view={view} t={t} />
      {/* A plain structural wrapper (not a DS piece) so the #buy deep-link has a
          scroll target around the whole purchase block. */}
      <section ref={buySectionRef} data-testid="billing-buy-section" className="scroll-mt-24">
        <PackList
          tiers={tiers}
          alaCarte={packs}
          quantityPresets={QUANTITY_PRESETS}
          onTierCta={onTierCta}
          onBuyAlaCarte={onBuyAlaCarte}
          labels={{
            plansTitle: t('billing.plansTitle'),
            plansHelp: t('billing.plansHelp'),
            alaCarteTitle: t('billing.alaCarteTitle'),
            alaCarteHelp: t('billing.alaCarteHelp'),
            subscribe: t('billing.subscribe'),
            upgrade: t('billing.upgrade'),
            manage: t('billing.manage'),
            current: t('billing.current'),
            buy: t('billing.buy'),
          }}
        />
      </section>
      {pendingUpgrade ? (
        <Text as="p" data-testid="billing-pending-upgrade">
          {t('billing.pendingUpgrade')}
        </Text>
      ) : null}
      <Button variant="ghost" onPress={() => void openBillingPortal()} data-testid="billing-portal-link">
        {t('billing.portalLink')}
      </Button>
      <Stack gap={3}>
        <Heading level={2}>{t('billing.history.title')}</Heading>
        <PurchaseHistory rows={rows} emptyLabel={t('billing.history.empty')} />
      </Stack>
    </Stack>
  )
}
