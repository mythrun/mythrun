// PackList (MYT-95) — the DOM-free prop vocabulary for the Sessions & Billing
// pack picker: the subscription-tier comparison (each tier carries a GATED CTA the
// shell resolves via client-core `subscriptionCta`, never re-decided here) over the
// à-la-carte packs (quantity presets + a buy verb). Platform-neutral (§9): pure
// data + shell-owned i18n'd labels + neutral handlers, no DOM types, no className.
//
// NO "best value"/"recommended"/"most popular" marker is carried or rendered (§11
// register constraint) — the tier vocabulary is name + price + grants + the gated
// CTA. What differentiates the tiers is the GRANT LEDGER (below), which is server
// data, not a nudge: the product states what each tier gives you and lets the
// reader decide. The one state the vocabulary does mark is `isCurrent`.
//
// GRANT LEDGER (myth-9jrh9): run-1's cards were name + price only — three tiers
// with zero feature differentiation, so the screen could not be used to make a
// billing decision. Every tier and pack now carries its per-cycle grants as
// label·value rows composed by the shell from the `GET /api/billing/skus` payload
// (`sessionsGranted` / `worldsGranted`), so the UI can never drift from Stripe and
// the same two rows sit in the same order in every card — the scan-across
// comparison a pricing table exists to support.

/** One grant row in a tier/pack card's ledger, e.g. label "Sessions", value
 *  "4 / month". BOTH halves are shell-composed i18n'd strings over server data —
 *  the DS never composes copy and never formats a count. */
export interface PackGrant {
  /** The metered thing (the mono field label), e.g. "Sessions" / "Worlds". */
  readonly label: string
  /** The shell-formatted amount, e.g. "4 / month" (a tier) or "1" (a pack). */
  readonly value: string
}

/** One subscription tier row, pre-resolved by the shell. `cta` is the GATED action
 *  from client-core `subscriptionCta` — an active subscriber can never carry
 *  `subscribe` (the double-subscribe guard, spec §4); the component only RENDERS it. */
export interface SubscriptionTierView {
  /** The Stripe lookup key (the stable tier id the CTA handler echoes back). */
  readonly lookupKey: string
  /** Server data — the tier's display name (Wayfarer / Sojourner / Mythwright). */
  readonly displayName: string
  /** Shell-formatted recurring price, e.g. "$15 / month". Server DATA, not DS copy. */
  readonly priceLabel: string
  /** What the tier grants per billing cycle — the scannable differentiator. Rows
   *  arrive in the shell's order and render in that order in EVERY card, so the
   *  ledgers line up across the comparison. */
  readonly grants: readonly PackGrant[]
  /** The gated action verb key. `subscribe` ONLY when there is no active sub. */
  readonly cta: 'subscribe' | 'upgrade' | 'manage'
  /** True when this tier IS the active subscription. The card marks it with a mono
   *  ink label line + a raised paper surface (typography + surface tier, NOT a chip
   *  or badge); its action stays `manage`. */
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
  /** What ONE unit of the pack grants. The world pack grants a world AND a session
   *  (so a bought world arrives playable) — the ledger is how the reader learns it. */
  readonly grants: readonly PackGrant[]
}

/** Props for the pack picker: the subscription comparison over the à-la-carte packs. */
export interface PackListProps {
  /** The subscription tiers, ascending by price (shell-ordered). */
  readonly tiers: readonly SubscriptionTierView[]
  /** The à-la-carte packs (one-time SKUs) — the top-up path. */
  readonly alaCarte: readonly AlaCarteView[]
  /** Terse quantity presets for à-la-carte (e.g. [1, 4, 8, 16]); clamped 1–100. */
  readonly quantityPresets: readonly number[]
  /** Fired when a tier's gated CTA is pressed — the shell routes it (checkout /
   *  upgrade-tier / portal) off the echoed `cta`. */
  readonly onTierCta: (lookupKey: string, cta: 'subscribe' | 'upgrade' | 'manage') => void
  /** Fired when an à-la-carte pack is bought at the chosen (clamped) quantity. */
  readonly onBuyAlaCarte: (lookupKey: string, quantity: number) => void
  /** i18n'd section headings + CTA verbs + the "current" marker + the à-la-carte buy
   *  verb (copy stays in the shell, not the DS). */
  readonly labels: {
    /** Heading over the subscription comparison. */
    readonly plansTitle: string
    /** One-line note under the plans heading (how tier credits renew / expire). */
    readonly plansHelp: string
    /** Heading over the à-la-carte packs — the top-up section. */
    readonly alaCarteTitle: string
    /** One-line note under the à-la-carte heading (how bought credits behave). */
    readonly alaCarteHelp: string
    readonly subscribe: string
    readonly upgrade: string
    readonly manage: string
    readonly current: string
    readonly buy: string
  }
  /** Test hook on the root element. */
  readonly 'data-testid'?: string
}
