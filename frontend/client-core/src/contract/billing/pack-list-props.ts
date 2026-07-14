// PackList (MYT-95) — the DOM-free prop vocabulary for the Sessions & Billing
// pack picker: the subscription-tier split (each tier carries a GATED CTA the
// shell resolves via client-core `subscriptionCta`, never re-decided here) over the
// à-la-carte packs (quantity presets + a buy verb). Platform-neutral (§9): pure
// data + shell-owned i18n'd labels + neutral handlers, no DOM types, no className.
//
// NO "best value"/"recommended" marker is carried or rendered (§11 register
// constraint) — the tier vocabulary is name + price + the gated CTA, nothing that
// nudges the choice.

/** One subscription tier row, pre-resolved by the shell. `cta` is the GATED action
 *  from client-core `subscriptionCta` — an active subscriber can never carry
 *  `subscribe` (the double-subscribe guard, spec §4); the component only RENDERS it. */
export interface SubscriptionTierView {
  /** The Stripe lookup key (the stable tier id the CTA handler echoes back). */
  readonly lookupKey: string
  /** Server data — the tier's display name (Wayfarer / Sojourner / Mythwright). */
  readonly displayName: string
  /** Shell-formatted recurring price, e.g. "$12 / mo". Server DATA, not DS copy. */
  readonly priceLabel: string
  /** The gated action verb key. `subscribe` ONLY when there is no active sub. */
  readonly cta: 'subscribe' | 'upgrade' | 'manage'
  /** True when this tier IS the active subscription (marked with a quiet mono
   *  "current" line, NOT a chip; its action stays `manage`). */
  readonly isCurrent: boolean
}

/** One à-la-carte pack row (a one-time SKU — Session / World). */
export interface AlaCarteView {
  /** The Stripe lookup key (echoed back by the buy handler). */
  readonly lookupKey: string
  /** Server data — the pack's display name (Session / World). */
  readonly displayName: string
  /** Shell-formatted unit price, e.g. "$5 each". Server DATA, not DS copy. */
  readonly unitPriceLabel: string
}

/** Props for the pack picker: the subscription-vs-à-la-carte split. */
export interface PackListProps {
  /** The subscription tiers, ascending by price (shell-ordered). */
  readonly tiers: readonly SubscriptionTierView[]
  /** The à-la-carte packs (one-time SKUs). */
  readonly alaCarte: readonly AlaCarteView[]
  /** Terse quantity presets for à-la-carte (e.g. [1, 4, 8, 16]); clamped 1–100. */
  readonly quantityPresets: readonly number[]
  /** Fired when a tier's gated CTA is pressed — the shell routes it (checkout /
   *  upgrade-tier / portal) off the echoed `cta`. */
  readonly onTierCta: (lookupKey: string, cta: 'subscribe' | 'upgrade' | 'manage') => void
  /** Fired when an à-la-carte pack is bought at the chosen (clamped) quantity. */
  readonly onBuyAlaCarte: (lookupKey: string, quantity: number) => void
  /** i18n'd CTA verbs + the "current" marker + the à-la-carte buy verb (copy
   *  stays in the shell, not the DS). */
  readonly labels: {
    readonly subscribe: string
    readonly upgrade: string
    readonly manage: string
    readonly current: string
    readonly buy: string
  }
  /** Test hook on the root element. */
  readonly 'data-testid'?: string
}
