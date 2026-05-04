# MYT-41 — Stripe Products, Prices, and Customer Portal Configuration

**Linear:** MYT-41 — Billing: Stripe products/prices Terraform + Customer Portal config
**Spec:** Patches `docs/specs/2026-04-13-billing-cost-controls.md` §3 + §4 + §5
**Status:** Design — written 2026-05-04
**Authors:** Miklos + Claude

## Goal

Provision the Mythrun Stripe products, prices, and Customer Portal in test mode, and ship the backend contract that lets application code reference these without ever being able to mutate them.

This is a Week-3 platform issue. Production-mode Stripe configuration lands separately at launch readiness, when pricing modeling completes.

## Non-goals

- **Backend Stripe runtime code.** Checkout endpoints, webhook handler, customer creation/lookup at request time — all MYT-42.
- **Per-session metering, budgets, free trial enforcement.** MYT-43.
- **Real production prices.** Test-mode placeholder pricing only; the value of MYT-41 is the *contract and shape*, not the dollar amounts. Production gets real prices when launch readiness comes around.
- **Multi-currency.** USD only.
- **Promotion codes, retention coupons, tax handling.** Disabled at launch; revisit when usage data exists.
- **A Stripe Terraform provider.** Considered and rejected — see Design Decisions §1.

## The product / pricing model

Three monthly subscriptions and two one-time SKUs. No rollover.

| Lookup key | Type | Includes | Notes |
|---|---|---|---|
| `tier_wayfarer` | Subscription, monthly | 4 sessions + 1 world per month | "Weekly D&D" tier |
| `tier_sojourner` | Subscription, monthly | 8 sessions + 2 worlds per month | "Twice-weekly D&D" tier |
| `tier_mythwright` | Subscription, monthly | 16 sessions + 4 worlds per month | Power-user tier; multi-group / multi-world |
| `sku_session` | One-time | 1 session, into an existing world | Top-up |
| `sku_world` | One-time | 1 world generation + 1 session in that world | World start; bundles a session |

A free trial exists separately: one session in a pre-built world, no card required, one-time per account. The trial does not have a Stripe SKU; it's account-state in our DB, granted at registration. (Implementation lands in MYT-43.)

### Cart shapes and Checkout `mode`

Stripe Checkout's `mode` field gates which line-item compositions are allowed. The supported cart shapes for Mythrun are:

| Cart | Mode | Line items |
|---|---|---|
| Subscription only | `subscription` | exactly one `tier_*` price, quantity 1 |
| One-time only (sessions, worlds, or both) | `payment` | any combination of `sku_session` and `sku_world`, any quantities |

**Mixed carts (a tier *plus* one-time line items in a single Checkout) are not supported.** Stripe's `mode: 'subscription'` does technically allow this, but every recurring-grant + one-time-grant on a single cart confuses the credit-grant logic in MYT-42 and complicates pro-ration math when a user later changes plans. If a user wants a tier + a session pack, they take two Checkouts. The contract here says: one cart, one mode.

### Webhook credit-grant contract for MYT-42

The webhook handler (lands in MYT-42, but the contract is fixed here so MYT-42 has no ambiguity) **iterates `data.object.line_items` and grants credits per-line-item via `lookup_key`**, not via the single-SKU `metadata.packId` shape the parent spec §4 step 3 assumes. For each line item:

```
lookup_key = line_item.price.lookup_key   (resolved via expand at session-retrieve time)
quantity   = line_item.quantity
spec       = LOOKUP_KEYS[lookup_key]      (throws on unknown — fail loud, do not partially grant)
sessions   = spec.sessionsGranted * quantity
worlds     = spec.worldsGranted   * quantity
```

The grant inserts up to two `credit_ledger` rows per line item — one with `credit_type = 'session'` if `sessions > 0`, one with `credit_type = 'world_gen'` if `worlds > 0`. Both rows share the same `source_id` (the Stripe `checkout.session.id` plus the line-item index, encoded as a deterministic string so retries are idempotent). This is consistent with migration 004's `uniq_credit_ledger_debit_idempotency` partial unique index, which only constrains debits — grants can share `source_id` across `credit_type`s.

**`metadata.userId` is still required on the Checkout session** so the webhook can resolve `userId` without a prior `customers` lookup; the parent spec §4 step 3's `metadata.packId` is replaced with the per-line-item walk above.

## Design decisions

### 1. Stripe Dashboard owns prices. Code can't mutate them — enforced at the API key.

**Decision:** All Stripe products, prices, and Customer Portal configuration are created and managed by Miklos by hand (CLI for prices, Dashboard UI for Portal config). Backend code references prices only by `lookup_key`, never by Stripe Price ID. **The Stripe API key Mythrun ships to production is a *restricted key* with no `Prices: write` and no `Products: write` permissions** — meaning the Stripe SDK itself rejects any mutation attempt at the network level, regardless of what application code says.

**Why:** Price changes are critical business decisions, not engineering tasks. The user explicitly does not want CC instances (or any code path) able to raise or lower prices, even in test mode. The `lookup_key` indirection is the application-facing contract; the restricted key is the *enforcement* layer.

**Defense in depth, in order of strength:**

1. **Restricted Stripe API key** (strongest). Stripe supports per-resource read/write permissions on API keys via Dashboard → Developers → API keys → Restricted keys. The Mythrun key has: `Prices: read`, `Products: read`, `Customers: write`, `Checkout sessions: write`, `Billing portal sessions: write`, `Subscriptions: write` (needed for `cancel_at_period_end` from app UI), `Webhook signing secret: read`. The key has **no** `Prices: write` and **no** `Products: write`. A `prices.create()` call returns 403 from Stripe's API; the SDK can't bypass it.
2. **`lookup_key` indirection.** Application code references `tier_wayfarer`, never `price_1NaBcD...`. Even if a future engineer wanted to bypass the contract, they'd have to introduce a hardcoded price ID — which is grep-detectable and code-reviewable.
3. **ESLint rule** (tripwire, not boundary). Bans `stripe.prices.create|update`, `stripe.products.create|update|del`, and `stripe.coupons.*`/`stripe.promotionCodes.*` (the latter two pre-emptively, since they're disabled at launch — re-enabling them is a later spec). The rule does NOT ban `stripe.subscriptions.update|cancel`: those are operationally needed (e.g., in-app "cancel my subscription" calling `stripe.subscriptions.update({ cancel_at_period_end: true })`, or admin-tools fraud cancellation calling `stripe.subscriptions.cancel`). Banning them would foreclose on the parent billing spec §3 lifecycle and on legitimate ops escape hatches.

ESLint is a code-review tripwire — pattern-matching on `MemberExpression` chains can be evaded via destructuring, bracket access, or aliasing. We accept that. The restricted key is the actual security boundary; lint catches honest mistakes before they reach review.

**Why not a Stripe Terraform provider:** Considered and rejected. First, the only viable provider (`franckverrot/stripe`) is community-maintained and has incomplete Customer Portal coverage. Second and more importantly: putting Stripe state in TF means any `terraform apply` could mutate prices through whatever Stripe key TF holds. The user wants *zero* such code paths; TF can't deliver that with a write-capable key. Dashboard + CLI authored by Miklos is the correct shape.

### 2. `lookup-keys.ts` is the contract; database tables are dropped.

**Decision:** A checked-in TypeScript file at `backend/src/billing/lookup-keys.ts` exhaustively declares every `lookup_key` Mythrun uses, with non-pricing metadata (display name, sessions granted, worlds granted, recurring vs one-time). The `subscription_tiers` and `session_packs` tables created in migration 001 are dropped (migration 006).

**Why:** The original spec stored credit allocations in DB rows so they were "configurable without code deploy." In practice, tier credit allocations *don't* change without a code change anyway — you'd want to update tests, naming, marketing copy, and the lookup-keys contract together. Putting the same metadata in a checked-in TS file gives strict type safety, code-review of changes, and zero drift between what code expects and what the DB believes.

**The tradeoff:** Adding or renaming a tier requires a migration-equivalent code change (PR with the new `lookup-keys.ts` entry). That's the right level of friction for something that's a real business decision.

**Pricing is *not* in the file.** The TS contract holds non-pricing metadata: lookup_key, display name, type (sub vs one-time), sessions granted, worlds granted. Price stays only in Stripe. Code that wants to display a price reads it from Stripe at runtime via `prices.retrieve` (read is fine and expected). This prevents the file from drifting from what Stripe actually charges.

### 3. Boot-time probe verifies the contract against Stripe.

**Decision:** On API boot, the backend asks Stripe for exactly the lookup_keys in the contract via `stripe.prices.list({ lookup_keys: [...], active: true, expand: ['data.product'] })`. The probe verifies every key resolves, has the right type (recurring vs one-time), the right currency (`usd`), the right billing interval (`month` for recurring), no duplicate-active-key collision, and surfaces structured failure events distinguishing transient Stripe errors from contract mismatches.

**Why:** A typo in the Stripe Dashboard ("`tier_wayfarrer`"), a wrong-currency price (EUR by accident), an annual-instead-of-monthly subscription tier, or a duplicate-lookup-key conflict would all silently produce wrong charges in production. Boot is the cheapest place to catch them.

**Read-only:** The probe only calls `stripe.prices.list`. No writes ever. No `prices.update` or `products.update` paths exist in the codebase (per §1's restricted API key).

**Per-key targeted query, not paginate-all-prices.** Stripe's `prices.list` accepts `lookup_keys: string[]` and returns *exactly* the matched prices, regardless of how many other active prices exist in the account. This eliminates the silent-truncation hazard at >100 active prices and is operationally cheaper than auto-pagination.

**What the probe verifies (per lookup_key in the contract):**

1. The key resolves to exactly one active price. Zero matches → "not found." Two or more → "duplicate-active-key conflict; archive one in Dashboard or rotate the lookup_key." Both are `BillingProbeError`s; multi-match is a *fail-loud* failure mode, not silently-pick-one.
2. The price's `currency === 'usd'`.
3. The price's type matches the contract: `tier_*` → `recurring`, `sku_*` → one-time (`price.recurring === null`).
4. For `tier_*`: `price.recurring.interval === 'month'`.

**What the probe does NOT verify:** the dollar amount and the product name. Those are operationally meaningful but Miklos-owned via the Dashboard; the probe's job is contract-shape, not pricing-policy.

**Transient-error handling.** Stripe API has occasional 5xx and timeouts. The probe distinguishes:

- **Contract mismatch** (lookup_key missing, wrong type, wrong currency, etc.) → boot fails loud with `BillingProbeError`. No retry — this is an operator fix.
- **Transient Stripe API error** (network error, timeout, 5xx) → retry up to 3 times with exponential backoff (1s, 2s, 4s) plus 0–1s jitter (mirrors MYT-37's JWKS hydrate pattern). If all retries fail, boot fails loud with `BillingProbeTransientError` (distinct error class). The operator response differs: contract mismatch = fix Dashboard, transient = check Stripe status page, redeploy.

**The deliberate availability tradeoff:** if Stripe's API is fully unavailable for >7 seconds during a Mythrun container start, that container fails to boot. ECS rolling deploys during Stripe outages would take Mythrun down. This is the right tradeoff for Mythrun's scale (revenue-per-incident is small relative to the cost of silently shipping a broken-billing build). It is documented here so the operator playbook for "Stripe is degraded" includes "delay the deploy."

**The probe runs on every boot, not on Stripe-side mutations.** If Miklos archives a price in Dashboard while the API is running, the probe doesn't re-run; in-flight requests using the same `lookup_key` will fail at `checkout.sessions.create` time when MYT-42's per-request resolver looks up the key (see §4 below). Adding a periodic re-probe is operationally useful but deferred — we'd want a CloudWatch metric on the re-probe outcome before a paging-able alarm makes sense.

### 4. MYT-42 resolves `lookup_key → price_id` per request, not from a boot cache.

**Decision:** The Checkout endpoint (lands in MYT-42) resolves each `lookup_key` to a Stripe Price ID by calling `stripe.prices.list({ lookup_keys: [...], active: true })` *at request time*, not by caching the boot-probe's resolved map. The price ID is then passed to `stripe.checkout.sessions.create({ line_items: [{ price: priceId, quantity: ... }] })`.

**Why:** The boot probe is a fail-fast contract verification, not a price-binding cache. If we cached price IDs from boot, a Stripe Dashboard mutation (archive + recreate) during the running container's lifetime would silently use a stale ID; users would hit "no such price" 500s. Per-request resolution makes the system tolerant to mid-flight Dashboard changes — at the cost of one extra Stripe API call per checkout, which is negligible.

**Caching guidance for non-checkout reads** (e.g., a `/api/billing/tiers` endpoint that displays tier prices on a marketing page): in-process LRU cache, 60-second TTL, fall-back-to-last-known on Stripe 5xx. Spec'd in MYT-42; flagged here so the implementer doesn't reach for `prices.retrieve` on every render.

### 5. The trial is account-state, not a Stripe SKU.

**Decision:** First-time users get one trial session granted automatically at account creation, with no card collected and no Stripe interaction. Tracked as a row in `credit_ledger` with `credit_type = 'session'`, `amount = 1`, `source_type = 'trial'`, `source_id = NULL`, `expires_at = NULL`. The grant + the `users.free_trial_used = true` flip happen in a single transaction so a partial failure can't double-grant.

**Why account state, not a Stripe SKU:** Trials have a different fraud profile than purchases (collusion risk if a single user can spawn unlimited trial sessions). Putting it in account state lets us add account-level abuse signals later. **Per-Cognito-sub uniqueness alone does not prevent multi-account trial farming** (free Google sign-up = free trial); MYT-43 owns the decision on additional friction (CAPTCHA, payment-method fingerprint, IP/device heuristics) or the deliberate accepted-loss posture.

**For MYT-41:** the lookup-keys.ts contract excludes the trial; it isn't a Stripe SKU. The credit-row shape above is fixed here so MYT-43 implements against it.

**Consumption ordering with paid credits is deferred to MYT-43.** With `expires_at = NULL` on trial credits and `expires_at = current_period_end` on tier credits, an `expires_at ASC` debit ordering would consume tier credits first and leave the trial credit forever-unconsumed. UX usually wants the opposite (consume trials first as a "try the product" nudge). MYT-43 picks the consumption-priority strategy — likely a `priority` column or `source_type`-based ordering — and the migration that adds it.

### 5a. Webhook secret PLACEHOLDER is a fail-closed sentinel, never a bypass branch.

**Decision:** While `STRIPE_WEBHOOK_SECRET = 'PLACEHOLDER'` (between MYT-41 ship and MYT-42 wiring the handler), no webhook handler exists, so the value is read by no code. Once MYT-42 lands the handler, `stripe.webhooks.constructEvent(payload, signature, secret)` is called unconditionally — it fails closed on signature mismatch (which a literal `'PLACEHOLDER'` always produces). **No `if (secret === 'PLACEHOLDER') skipVerification()` branch is acceptable**, even in dev mode. The webhook handler must verify every request unconditionally; a "helpful" dev-mode skip would be a security regression.

This invariant is documented here so MYT-42's implementer doesn't reach for the bypass.

### 6. ESLint rule scope (tripwire layer, not boundary).

**Decision:** A custom ESLint rule (`no-stripe-price-mutations`) bans method calls that would mutate price/product/coupon catalog state. Allowed mutations include subscription lifecycle calls that the parent billing spec assumes are operationally needed.

**Banned (rule fires):**

- `stripe.products.create|update|del`
- `stripe.prices.create|update` (Stripe doesn't expose `prices.del`; archival is `update({ active: false })`, also banned)
- `stripe.coupons.create|update|del` (disabled at launch; pre-emptive ban so re-enabling is a deliberate spec change)
- `stripe.promotionCodes.create|update` (same reason)

**Explicitly allowed (rule does NOT fire):**

- `stripe.checkout.sessions.create` — creates a hosted-checkout session
- `stripe.billingPortal.sessions.create` — creates a Portal session
- `stripe.webhooks.constructEvent` — verifies webhooks
- `stripe.subscriptions.update` — needed for in-app cancel (`{ cancel_at_period_end: true }`), pause, metadata edits
- `stripe.subscriptions.cancel` / `stripe.subscriptions.del` — needed for admin-tools fraud cancellation
- `stripe.customers.create|retrieve|update` — managing the customer record on our side
- All read methods: `prices.list`, `prices.retrieve`, `products.retrieve`, `subscriptions.retrieve`, etc.

The narrowing matters: the user's intent is "code can't *write the price*," not "code can't touch any Stripe object." Banning `subscriptions.update|cancel` would block legitimate cancel-from-our-UI flows and admin escape hatches.

**Pattern-evasion is acknowledged.** ESLint matches `MemberExpression` chains; `stripe['products']['create'](...)`, `const create = stripe.products.create.bind(...); create(...)`, or `(stripe as any).products.create(...)` would all bypass the rule. We document this and rely on (a) the restricted API key in §1 as the actual SDK-level boundary, (b) code review catching the sentinel patterns. The rule is a tripwire for honest mistakes, not a defense against motivated bypass.

**Disable comments at code review.** A future PR with `// eslint-disable-next-line no-stripe-price-mutations` is visible at review and requires the reviewer to understand and approve the disable. That's the lint rule's actual job.

### 7. Per-environment Stripe accounts; restricted keys; rotation procedure.

**Decision:** Test mode runs against the Mythrun test-mode Stripe account. Production mode (at launch) runs against a separate Stripe live-mode account. They share no keys. **The `STRIPE_SECRET_KEY` value in each environment's Secrets Manager is a *restricted key* per §1**, not a full-permission secret key.

**Restricted-key permission set:**

| Resource | Access |
|---|---|
| Prices | Read |
| Products | Read |
| Customers | Write |
| Checkout Sessions | Write |
| Billing Portal Sessions | Write |
| Subscriptions | Write |
| Webhooks (signing secret) | Read |
| Coupons | None |
| Promotion Codes | None |

This permission set is enforceable in Stripe Dashboard → Developers → API keys → Create restricted key. The runbook (`tmp/myt-41-stripe-dashboard-instructions.md`) walks through it.

**Rotation procedure:** rotate the restricted key every 6 months, immediately on suspected compromise, or when the permission set needs to change. Procedure: (1) create a new restricted key in Stripe Dashboard, (2) update the Secrets Manager entry, (3) trigger an ECS rolling deploy, (4) the boot probe re-runs against the new key on each new task — green = rotation complete, red = rollback the secret. The rotation has the same operability profile as any other secret rotation.

**MYT-31 status:** populated test-mode `STRIPE_SECRET_KEY` for staging with a *full-permission* key (the restricted-key concept didn't exist in MYT-41's design when MYT-31 ran). **This MYT-41 close replaces it with a restricted key**; the runbook step is "rotate the existing secret to the restricted key."

**Webhook secret:** `STRIPE_WEBHOOK_SECRET` stays at `PLACEHOLDER` until MYT-42 wires the handler and Miklos creates the webhook endpoint in Stripe. The PLACEHOLDER → live-secret rotation is part of MYT-42, not MYT-41. The boot probe does not consume `STRIPE_WEBHOOK_SECRET`; placeholder is fine for booting.

### 8. MYT-42 endpoint authn shape (contract for downstream).

These contracts are fixed by MYT-41 so MYT-42's implementer has no ambiguity. They describe how the routes that consume the lookup-keys contract must authenticate.

**`POST /api/billing/checkout`:**

- Requires JWT auth via the existing `requireOnboarded` plugin (so caller has a `users` row).
- The request body specifies the `lookup_key`(s) and quantities. **The `customer_id` is server-derived** from `request.user.sub` → `users.stripe_customer_id` (lookup, create-on-first-use). Never trust a client-supplied customer ID.
- The Checkout session's `metadata.userId` is the server-derived user ID, used by the webhook handler.
- The Checkout session's `success_url` and `cancel_url` are Mythrun-controlled (`${env.frontendBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}` and `/billing/cancel`); never client-supplied. Stripe allows arbitrary URLs here, which is an open-redirector primitive if exposed.

**`POST /api/billing/portal`:**

- Requires JWT auth.
- The Portal session's `customer` parameter is server-derived from `request.user.sub` → `users.stripe_customer_id`. Never trust a client-supplied customer ID; the Portal URL Stripe returns is a bearer-style URL that lets anyone with it manage that customer's subscription, so a misimplementation here is an IDOR (cancel-anyone's-sub) vector.
- The Portal session's `return_url` is Mythrun-controlled (`${env.frontendBaseUrl}/account`); never client-supplied.

**`POST /webhooks/stripe`:**

- `config.auth = 'public'` (no JWT — Stripe authenticates via signature, not bearer token).
- `stripe.webhooks.constructEvent(rawBody, signatureHeader, env.stripeWebhookSecret)` is the trust boundary; signature mismatch returns 400 immediately. **No bypass branch on `secret === 'PLACEHOLDER'`** (per §5a).
- The handler iterates `event.data.object.line_items` for credit grants per §"Webhook credit-grant contract for MYT-42" above, never `metadata.packId`.

**`users.stripe_customer_id` ALTER lands in MYT-42, not MYT-41.** The column is defined in the parent specs but does not exist in any current migration. MYT-41 ships migration 006 (drops billing config tables); MYT-42 ships migration 007 (adds `users.stripe_customer_id TEXT UNIQUE NULL`). MYT-41 is silent on this column; the boot probe and lookup-keys contract do not depend on it.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  Stripe (test mode)                                                │
│                                                                    │
│   Products + Prices              Customer Portal config            │
│   (created via CLI by user)       (configured via Dashboard UI)    │
│                                                                    │
│   tier_wayfarer    (recurring)                                     │
│   tier_sojourner   (recurring)                                     │
│   tier_mythwright  (recurring)                                     │
│   sku_session      (one-time)                                      │
│   sku_world        (one-time)                                      │
│                                                                    │
└─────────▲────────────────────────────────────────────────▲─────────┘
          │ read-only API access                            │ webhook
          │                                                 │ events
          │                                                 │ (MYT-42)
          │
┌─────────┴──────────────────────────────────────────────────────────┐
│  backend                                                           │
│                                                                    │
│   src/billing/lookup-keys.ts  ──── exhaustive contract             │
│   src/billing/probe.ts        ──── boot-time verify against Stripe │
│   src/billing/stripe-client.ts──── thin wrapper, read methods only │
│                                                                    │
│   .eslintrc.cjs               ──── no-stripe-mutations rule        │
│                                                                    │
│   migrations/006              ──── DROP subscription_tiers, _packs │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

   ↓ MYT-42 will add:
   src/routes/billing.ts        — POST /api/billing/checkout, /portal
   src/routes/webhooks.ts       — POST /webhooks/stripe
   src/billing/webhook-handler.ts
```

## Files

### `backend/src/billing/lookup-keys.ts` — the contract

```typescript
// Exhaustive list of every Stripe lookup_key Mythrun uses.
//
// Pricing is NOT in this file. Price stays in Stripe. Code that needs
// the live price retrieves it from the Stripe API at runtime.
//
// Adding a new tier or SKU is a deliberate code change: edit this file,
// run the boot probe to confirm Stripe matches, ship the migration if
// any DB shape needs to change. There is no "dynamic tier" facility.

export type LookupKey =
  | 'tier_wayfarer'
  | 'tier_sojourner'
  | 'tier_mythwright'
  | 'sku_session'
  | 'sku_world'

export interface LookupKeySpec {
  /** The Stripe lookup_key. Single source of truth. */
  readonly lookupKey: LookupKey
  /** User-facing display name. Matches the Stripe product name. */
  readonly displayName: string
  /** 'recurring' = subscription tier; 'one_time' = a-la-carte SKU. */
  readonly type: 'recurring' | 'one_time'
  /** Sessions granted on each successful purchase / billing cycle. */
  readonly sessionsGranted: number
  /** Worlds granted on each successful purchase / billing cycle. */
  readonly worldsGranted: number
}

export const LOOKUP_KEYS = {
  tier_wayfarer:   { lookupKey: 'tier_wayfarer',   displayName: 'Wayfarer',   type: 'recurring', sessionsGranted: 4,  worldsGranted: 1 },
  tier_sojourner:  { lookupKey: 'tier_sojourner',  displayName: 'Sojourner',  type: 'recurring', sessionsGranted: 8,  worldsGranted: 2 },
  tier_mythwright: { lookupKey: 'tier_mythwright', displayName: 'Mythwright', type: 'recurring', sessionsGranted: 16, worldsGranted: 4 },
  sku_session:     { lookupKey: 'sku_session',     displayName: 'Session',    type: 'one_time',  sessionsGranted: 1,  worldsGranted: 0 },
  sku_world:       { lookupKey: 'sku_world',       displayName: 'World',      type: 'one_time',  sessionsGranted: 1,  worldsGranted: 1 },
} as const satisfies Record<LookupKey, LookupKeySpec>
```

### `backend/src/billing/stripe-client.ts` — read-only wrapper

A thin module that constructs a `Stripe` client from `STRIPE_SECRET_KEY` and exports a single instance. The wrapper does *not* expose mutation methods — consumers use `stripeClient.prices.list`, `stripeClient.prices.retrieve`, etc. directly off the underlying SDK. The ESLint rule prevents accidental misuse.

```typescript
// Module-level cached client. Tests that need to inject a different env
// must mock the Stripe SDK at the import boundary (vitest's vi.mock), not
// reach into this cache.

import Stripe from 'stripe'
import type { Env } from '../config/env.js'

// Pin to the latest Stripe API release line as of MYT-41 design (2026-05).
// Bumping this is a deliberate spec patch — it changes webhook payload
// shapes and field names, and the SDK type-narrows apiVersion to the
// literal union of valid versions, so a wrong string fails tsc.
//
// Cadence: review Stripe's API changelog every 6 months as routine
// maintenance; bump only when there's a feature we need or a breaking
// change with a sunset date.
const STRIPE_API_VERSION = '2026-03-25.dahlia' as const

let cached: Stripe | null = null

export function getStripeClient(env: Env): Stripe {
  if (!cached) {
    cached = new Stripe(env.stripeSecretKey, {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
    })
  }
  return cached
}
```

### `backend/src/billing/probe.ts` — boot-time verify

```typescript
// Runs once per boot, after loadEnv() succeeds and before app.listen().
//
// Verifies every lookup_key in LOOKUP_KEYS resolves to exactly one active
// Stripe price with the right type, currency, and (for recurring) billing
// interval. Distinguishes contract-mismatch failures (operator fixes
// Dashboard) from transient Stripe API errors (retry with backoff, then
// boot fails until Stripe recovers).
//
// Read-only: only stripe.prices.list. Restricted API key in production
// rejects any mutation regardless.

import type Stripe from 'stripe'
import type { Logger } from 'pino'
import { LOOKUP_KEYS, type LookupKey } from './lookup-keys.js'

const PROBE_TIMEOUT_MS = 7000
const PROBE_MAX_ATTEMPTS = 3
const PROBE_BACKOFF_MS = [1000, 2000, 4000]
const PROBE_JITTER_MS = 1000

export class BillingProbeError extends Error {
  readonly code = 'BILLING_PROBE_FAILED'
  constructor(readonly mismatches: ReadonlyArray<string>) {
    super(`Stripe billing probe failed (contract mismatch):\n  ${mismatches.join('\n  ')}`)
    this.name = 'BillingProbeError'
  }
}

export class BillingProbeTransientError extends Error {
  readonly code = 'BILLING_PROBE_TRANSIENT'
  constructor(readonly cause: unknown, readonly attempts: number) {
    super(`Stripe billing probe failed transiently after ${String(attempts)} attempts: ${String(cause)}`)
    this.name = 'BillingProbeTransientError'
  }
}

export async function probeStripeContract(
  stripe: Stripe,
  logger: Logger,
): Promise<void> {
  const lookupKeys = Object.keys(LOOKUP_KEYS) as LookupKey[]

  // Targeted query: ask Stripe for exactly the keys in the contract.
  // Returns at most one active price per lookup_key (or zero if missing).
  // Avoids paginate-all-prices truncation hazard at >100 active prices.
  const fetched = await fetchPricesWithRetry(stripe, lookupKeys, logger)

  const mismatches: string[] = []

  // Detect duplicate active lookup_keys (operationally rare but possible
  // via API; a fail-loud failure mode, not silent last-wins).
  const counts = new Map<string, number>()
  for (const p of fetched) {
    if (p.lookup_key) counts.set(p.lookup_key, (counts.get(p.lookup_key) ?? 0) + 1)
  }
  for (const [k, n] of counts) {
    if (n > 1) {
      mismatches.push(
        `lookup_key '${k}' has ${String(n)} active Stripe prices — archive duplicates in Dashboard`,
      )
    }
  }

  // Build a map only AFTER duplicate-detection so we don't silently
  // overwrite. Skip duplicates from the per-key checks below; they're
  // already a mismatch.
  const byLookup = new Map<string, Stripe.Price>()
  for (const p of fetched) {
    if (p.lookup_key && (counts.get(p.lookup_key) ?? 0) === 1) {
      byLookup.set(p.lookup_key, p)
    }
  }

  for (const key of lookupKeys) {
    const spec = LOOKUP_KEYS[key]
    if ((counts.get(spec.lookupKey) ?? 0) > 1) continue // already flagged
    const price = byLookup.get(spec.lookupKey)
    if (!price) {
      mismatches.push(`lookup_key '${spec.lookupKey}' not found in active Stripe prices`)
      continue
    }
    if (price.currency !== 'usd') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has currency '${price.currency}' in Stripe; contract expects 'usd'`,
      )
    }
    const stripeType: 'recurring' | 'one_time' = price.recurring ? 'recurring' : 'one_time'
    if (stripeType !== spec.type) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has type '${stripeType}' in Stripe but contract expects '${spec.type}'`,
      )
      continue
    }
    if (spec.type === 'recurring' && price.recurring?.interval !== 'month') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has recurring.interval '${String(price.recurring?.interval)}' in Stripe; contract expects 'month'`,
      )
    }
  }

  if (mismatches.length > 0) {
    logger.error(
      { event: 'billing.probe_failed', mismatchCount: mismatches.length, mismatches },
      'Stripe billing contract mismatch',
    )
    throw new BillingProbeError(mismatches)
  }

  logger.info(
    { event: 'billing.probe_passed', count: lookupKeys.length },
    'Stripe billing contract verified',
  )
}

async function fetchPricesWithRetry(
  stripe: Stripe,
  lookupKeys: ReadonlyArray<LookupKey>,
  logger: Logger,
): Promise<Stripe.Price[]> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await stripe.prices.list(
        {
          lookup_keys: [...lookupKeys],
          active: true,
          limit: lookupKeys.length, // exactly enough; never exceeds the contract size
        },
        { timeout: PROBE_TIMEOUT_MS },
      )
      return res.data
    } catch (err) {
      lastErr = err
      if (attempt === PROBE_MAX_ATTEMPTS) break
      const base = PROBE_BACKOFF_MS[attempt - 1] ?? PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1]!
      const jitter = Math.floor(Math.random() * PROBE_JITTER_MS)
      logger.warn(
        {
          event: 'billing.probe_transient_retry',
          attempt,
          nextDelayMs: base + jitter,
          err: err instanceof Error ? err.message : String(err),
        },
        'Stripe billing probe transient error; retrying',
      )
      await new Promise((r) => setTimeout(r, base + jitter))
    }
  }
  logger.error(
    {
      event: 'billing.probe_transient_failed',
      attempts: PROBE_MAX_ATTEMPTS,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
    'Stripe billing probe transient failure after retries',
  )
  throw new BillingProbeTransientError(lastErr, PROBE_MAX_ATTEMPTS)
}
```

The probe is called from the boot gate (after `loadEnv` succeeds, before `app.listen`). On `BillingProbeError` → operator fixes Dashboard. On `BillingProbeTransientError` → operator checks Stripe status, redeploys after Stripe recovers. Both surface to ECS as task crashes; the deployment circuit breaker triggers a rollback.

### `backend/migrations/006_drop_billing_config_tables.sql`

```sql
-- Migration 006 — drop legacy billing-config tables and their dependents.
--
-- MYT-41 moves the tier and pack credit-allocation contract into a
-- checked-in TS file (backend/src/billing/lookup-keys.ts). Stripe stays
-- the source of truth for prices; lookup_key is the indirection that
-- lets backend code reference SKUs without coupling to Stripe Price IDs.
--
-- Drop order matters because of FK dependencies created in migration 001:
--   user_subscriptions.tier_id → subscription_tiers(id) (NO ACTION)
--   purchases.package_id       → session_packs(id) or subscription_tiers(id)
-- A naive `DROP TABLE subscription_tiers` would fail with SQLSTATE 2BP01
-- ("cannot drop table because other objects depend on it"), aborting
-- migration 006 inside the runner's transaction wrapper.
--
-- We drop the dependent tables (user_subscriptions, purchases) FIRST.
-- MYT-42 will recreate them with the new shape — referencing
-- lookup_key TEXT NOT NULL instead of FK-into-config-table — as
-- migration 007.

-- Dependents first.
DROP TABLE IF EXISTS user_subscriptions;
DROP TABLE IF EXISTS purchases;

-- Config tables.
DROP TABLE IF EXISTS session_packs;
DROP TABLE IF EXISTS subscription_tiers;

DO $$ BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'session_packs',
        'subscription_tiers',
        'user_subscriptions',
        'purchases'
      )
  ), 'one or more billing-config tables were not dropped';
END $$;
```

`current_schema()` (not hard-coded `'public'`) per the migration 005 fix — keeps the wiki schema extractor happy.

**This migration is non-reversible without backup restore.** All four dropped tables are empty in every Mythrun environment as of 2026-05 (verified by Miklos before merge: `SELECT count(*)` returns 0 for each, in dev / staging). MYT-42 ships migration 007 to recreate `user_subscriptions` and `purchases` with the new shape; rollback of MYT-41 between MYT-41 ship and MYT-42 ship leaves those two tables absent — acceptable because no code references them in that window.

### ESLint rule — `no-stripe-price-mutations`

A custom rule under `backend/eslint-rules/no-stripe-price-mutations.cjs` (wired into the existing `eslint.config.js` flat-config), banning `MemberExpression` chains that mutate the Stripe price/product/coupon catalog. **`stripe.subscriptions.update|cancel|del` are explicitly NOT banned** — they're operationally needed for in-app cancel and admin-tools.

Banned patterns (rule fires):

```
stripe.products.create
stripe.products.update
stripe.products.del
stripe.prices.create
stripe.prices.update
stripe.coupons.create
stripe.coupons.update
stripe.coupons.del
stripe.promotionCodes.create
stripe.promotionCodes.update
```

Pattern-evasion paths the rule does NOT catch (documented in the rule's source comment, not in scope to defend against in MYT-41):

- `stripe['products']['create'](...)` — bracket access
- `const c = stripe.products.create.bind(stripe.products); c(...)` — alias
- `(stripe as any).products.create(...)` — type-system bypass

The restricted API key in §1 is the actual SDK-level boundary against these.

Test fixtures (`backend/eslint-rules/__tests__/no-stripe-price-mutations.test.cjs`) cover banned (`prices.create`, `products.update`, etc.) and allowed (`prices.list`, `prices.retrieve`, `subscriptions.update`, `subscriptions.cancel`, `checkout.sessions.create`, `webhooks.constructEvent`) cases.

`backend/src/billing/webhook-handler.ts` (lands in MYT-42) receives `customer.subscription.updated` events from Stripe; receiving is not mutating, so the rule doesn't apply.

## Spec patches

The Billing spec at `docs/specs/2026-04-13-billing-cost-controls.md` needs three sections updated as part of MYT-41 close. The patch is in-place; no new spec file.

### `docs/specs/2026-04-13-billing-cost-controls.md` §3 — Subscription Tiers

- Replace the `Adventurer` / `Champion` table with Wayfarer / Sojourner / Mythwright + their session/world allocations.
- Replace the `subscription_tiers` table CREATE TABLE block (§3.137–151 of parent spec) with: "Subscription tier metadata lives in `backend/src/billing/lookup-keys.ts`. Stripe Prices map to tiers by `lookup_key`; the DB does not cache tier metadata."
- Update §3 "Subscription Tracking" — `user_subscriptions` table block (§3.171–184 of parent) needs revision: `tier_id TEXT NOT NULL REFERENCES subscription_tiers(id)` becomes `tier_lookup_key TEXT NOT NULL` (no FK; the boot probe verifies the lookup_key is valid). MYT-42's migration 007 creates the new shape; this MYT-41 patch updates the spec text to match.
- Drop §3.165–169 "Subscription Lifecycle" references to `subscription_tiers` — replace with "tier metadata read from lookup-keys.ts contract."
- Drop the rollover-as-config language; replace §3.186–193 with a single line: "No rollover at launch. Tier credits are granted with `expires_at = current_period_end`. Mid-period cancellation does not retroactively expire that period's credits — the user paid for the period, gets to use it through `current_period_end`."

### `docs/specs/2026-04-13-billing-cost-controls.md` §4 — Session Packs

- Rename to "À-la-carte SKUs" (sessions and worlds, sold one-at-a-time, not bundled in fixed-size packs).
- Replace `pack_5` / `pack_12` table with `sku_session` and `sku_world`.
- Replace the `session_packs` table CREATE TABLE block (§4.201–213 of parent) with: "Pack metadata lives in lookup-keys.ts. Stripe Prices map to SKUs by `lookup_key`."
- Replace `purchases` table CREATE TABLE block (§4.175 of parent) — same shape change as `user_subscriptions`: drop the FK-into-config-table, store `lookup_key TEXT NOT NULL` instead. MYT-42 migration 007.
- Update the purchase flow (§4.224–232 of parent): step 3's `metadata: { packId, userId }` becomes `metadata: { userId }`; the per-line-item lookup_key walk replaces the single packId field.
- Note: pack credits never expire (`expires_at = NULL`) — this language stays. Mid-period subscription cancellation does NOT affect pack credits.

### `docs/specs/2026-04-13-billing-cost-controls.md` §5 — Stripe Integration

- Update §5.1 (Products and Prices) to reference the lookup-keys contract; remove the table that lists Stripe Price IDs.
- §5.4 (Customer Portal) — replace with the four enabled features (use Stripe's exact Dashboard labels):
  - **Cancel subscription** (Cancel at end of billing period)
  - **Switch plan** (allowlist: Wayfarer, Sojourner, Mythwright)
  - **Payment methods** (update; card only at launch)
  - **Invoice history** (visible)
  Disabled at launch: Promotion codes, Retention coupons, Tax ID, Phone, Shipping address, Update quantities, Cancellation reason (optional, off at launch).
- §5.5 (Price Manipulation Prevention) — explicit replacement text: "Pricing is immutable from application code. Defense in depth, in order of strength: (1) Stripe restricted API key with no `Prices: write` or `Products: write` — Stripe's API rejects mutation attempts at the network level. (2) Code references prices by `lookup_key` only; no hardcoded Stripe Price IDs. (3) ESLint rule `no-stripe-price-mutations` bans price/product/coupon catalog mutations — a code-review tripwire, not a runtime boundary. The amount-validation in the webhook handler (also in §5.5) is the per-charge correctness check; the boot probe is the catalog-shape correctness check."

### `docs/specs/2026-04-13-billing-cost-controls.md` §7 — Free Trial (orphan-reference cleanup)

- §7.350 references `session_usage.source_type = 'trial'` — the `session_usage` table has no `source_type` column. Replace with: "Trial sessions are tracked at the credit-grant level (`credit_ledger` row with `source_type='trial'`). Per-session metering follows the standard token-budgeting flow (§6); trial sessions are not specially flagged in `session_usage`."

### `docs/specs/2026-04-13-billing-cost-controls.md` §10 — Edge Cases (orphan-reference cleanup)

- §10.477 ("Debit consumes the earliest-expiring credits first…") conflicts with the MYT-40 atomic-debit recipe, which inserts a single negative ledger row with no FIFO/LIFO ordering. Replace with: "Debit ordering is implementation-defined; MYT-43 picks the consumption-priority strategy."

### `docs/specs/2026-04-13-billing-cost-controls.md` §9 — API Routes (consistency)

- `GET /api/billing/tiers` and `GET /api/billing/packs` (§9.420 of parent) — replace with `GET /api/billing/skus` returning a single list keyed by lookup_key. Caching/TTL/fallback rules per §4 above. (Implementation lands in MYT-42; spec text updates here.)

### `docs/specs/2026-04-06-production-architecture-overview.md` (orphan-reference cleanup)

- Line 768's `pack_5` reference → update to `sku_session`/`sku_world`.

### `docs/specs/2026-04-10-ux-design.md` (orphan-reference cleanup)

- Line 490's `Adventurer` / `Champion` mentions → update to `Wayfarer` / `Sojourner` / `Mythwright`.

**Out-of-scope follow-up:** existing bead `myth-u7k` ("Repo: add billing namespaces — purchases, userSubscriptions, subscriptionTiers, sessionPacks, stripeEvents") references the now-dropped `subscriptionTiers` and `sessionPacks` namespaces. As part of MYT-41 close, edit that bead to remove those two namespaces from its scope, OR close it as obsolete pending MYT-42's recreation of `user_subscriptions` and `purchases` with the new shape.

## Tests

### Unit tests — `backend/src/billing/__tests__/lookup-keys.test.ts`

- Every key in `LookupKey` union has a corresponding `LOOKUP_KEYS` entry.
- **Drift test:** for every entry, `LOOKUP_KEYS[k].lookupKey === k` (the map key and the `lookupKey` property must match; mismatch is a deliberate bug since both are required to be the same string).
- **Per-key shape assertions** (not just "OR positive"):
  - `tier_wayfarer`: `type='recurring'`, `sessionsGranted=4`, `worldsGranted=1`
  - `tier_sojourner`: `type='recurring'`, `sessionsGranted=8`, `worldsGranted=2`
  - `tier_mythwright`: `type='recurring'`, `sessionsGranted=16`, `worldsGranted=4`
  - `sku_session`: `type='one_time'`, `sessionsGranted=1`, `worldsGranted=0`
  - `sku_world`: `type='one_time'`, `sessionsGranted=1`, `worldsGranted=1`
- Display names exactly: Wayfarer, Sojourner, Mythwright, Session, World.

### Integration tests — `backend/src/billing/__tests__/probe.test.ts`

Mocks `stripe.prices.list` via `vi.mock` at the SDK boundary (no real Stripe calls).

- Happy path: all 5 lookup_keys returned with correct currency='usd', recurring.interval='month' for tiers, no recurring for SKUs → probe resolves; logger emits `billing.probe_passed`.
- Missing lookup_key → `BillingProbeError` with "lookup_key 'tier_X' not found in active Stripe prices" in the message.
- Type mismatch (tier_* returned as one-time) → `BillingProbeError` with type-mismatch message.
- Currency mismatch (tier_* with `currency='eur'`) → `BillingProbeError` with currency message.
- Interval mismatch (tier_* with `recurring.interval='year'`) → `BillingProbeError` with interval message.
- Duplicate lookup_keys (two active prices share `lookup_key='tier_wayfarer'`) → `BillingProbeError` with duplicate-detection message; **not silent last-wins**.
- Multiple mismatches across keys → all reported in a single `BillingProbeError.mismatches` array (don't short-circuit on first).
- Transient error path: mock `prices.list` to throw `Stripe.errors.StripeAPIError` twice, succeed on third attempt → probe resolves; logger emits `billing.probe_transient_retry` twice and `billing.probe_passed` once.
- Transient-error exhaustion: mock throws on all 3 attempts → `BillingProbeTransientError` with `attempts=3`; logger emits `billing.probe_transient_failed`.

### ESLint rule tests — `backend/eslint-rules/__tests__/no-stripe-price-mutations.test.cjs`

Use ESLint's `RuleTester`. Banned cases (rule diagnostic):

- `stripe.prices.create({...})`, `stripe.prices.update(id, {...})`
- `stripe.products.create({...})`, `stripe.products.update(id, {...})`, `stripe.products.del(id)`
- `stripe.coupons.create({...})`, `stripe.coupons.update(id, {...})`, `stripe.coupons.del(id)`
- `stripe.promotionCodes.create({...})`, `stripe.promotionCodes.update(id, {...})`

Allowed cases (no diagnostic):

- `stripe.prices.list({...})`, `stripe.prices.retrieve(id)`
- `stripe.products.retrieve(id)`
- `stripe.subscriptions.update(id, { cancel_at_period_end: true })` — explicitly allowed (cancel-from-app)
- `stripe.subscriptions.cancel(id)` — explicitly allowed (admin fraud cancel)
- `stripe.checkout.sessions.create({...})`
- `stripe.billingPortal.sessions.create({...})`
- `stripe.webhooks.constructEvent(...)`
- `stripe.customers.create|retrieve|update`

### Schema parity test update — `backend/src/db/__tests__/migrate-schema.test.ts`

The test pins `EXPECTED_TABLES`, `EXPECTED_IDX_NAMES`, `EXPECTED_CHECK_CONSTRAINTS`, and `EXPECTED_FK_DELETE_RULES`. Migration 006 changes affect ALL of these:

- **`EXPECTED_TABLES`:** remove `subscription_tiers`, `session_packs`, `user_subscriptions`, `purchases` (the latter two are recreated by MYT-42 migration 007; this MYT-41 patch removes them, MYT-42 adds them back with the new shape).
- **`EXPECTED_IDX_NAMES`:** remove `idx_user_subscriptions_user`, `idx_purchases_user`.
- **`EXPECTED_CHECK_CONSTRAINTS`:** remove `purchases.status` check, `user_subscriptions.status` check.
- **`EXPECTED_FK_DELETE_RULES`:** remove every row where `table_name IN ('user_subscriptions', 'purchases')`. That's:
  - `purchases.user_id → users` (NO ACTION)
  - `user_subscriptions.tier_id → subscription_tiers` (NO ACTION) — the FK that blocks the naive drop
  - `user_subscriptions.user_id → users` (CASCADE)
- **Migrations list:** append `'006_drop_billing_config_tables.sql'`.
- **Post-migration assertion:** `users` table still exists, four dropped tables don't, `_migrations` shows 006 applied.

### `reset-data.ts` test helper update — `backend/src/repo/__tests__/_helpers/reset-data.ts`

Remove `subscription_tiers`, `session_packs`, `user_subscriptions`, `purchases` from the `TABLES` array used by the test-data reset helper. (No code uses these tables after this migration.)

## Operational notes

### Execution sequence for closing MYT-41

The order avoids the "code lands but probe-fails-on-boot until human-action" gap:

1. **Miklos executes the Stripe setup FIRST.** Per `tmp/myt-41-stripe-dashboard-instructions.md`: create the restricted API key, rotate the Secrets Manager `STRIPE_SECRET_KEY` to it, create the 5 products + prices via CLI, configure the Customer Portal. Verify in Stripe Events log that a test Pay Link fires.
2. **Then code lands.** lookup-keys.ts, probe.ts, stripe-client.ts, ESLint rule, migration 006, tests, spec patches. Push.
3. **CI is green** (typecheck + lint + tests).
4. **Boot probe verifies on staging.** ECS rolling deploy picks up the new image; boot probe runs against the now-provisioned Stripe state and emits `billing.probe_passed` in CloudWatch logs. If the probe fails, the deploy circuit-breaker triggers a rollback automatically.
5. **Wiki update.** Run the AUTHORING.md subagent to sync the wiki — schema diagram drops `subscription_tiers`, `session_packs`, `user_subscriptions`, `purchases`; add a new runbook page documenting the production-mode click-path for launch readiness. **Wiki changes commit BEFORE the final push** so code + wiki land in a single push (per CLAUDE.md "wiki is not optional"). The wiki commit is in the same push as the code commit; CI sees a consistent state.
6. **Final push.** Code + wiki together.
7. **Linear flip to Done.**

This sequence inverts the natural "code-then-Stripe" instinct, but it's correct: the boot probe is fail-loud and the restricted-key permission set is fail-loud — nothing about the code path runs successfully without Stripe being provisioned, so provisioning first eliminates the gap.

### Probe failure behavior in ECS

`BillingProbeError` and `BillingProbeTransientError` both throw out of the boot gate, exit the Node process non-zero. ECS marks the task UNHEALTHY; rolling deploys with deployment-circuit-breaker enabled (default for Mythrun's `mythrun-staging-api` service) automatically roll back to the previous task-definition revision after N consecutive task failures. Operator response: read CloudWatch logs for the structured event:

- `billing.probe_failed` (mismatchCount, mismatches array) — fix Dashboard, redeploy.
- `billing.probe_transient_failed` (attempts, err) — check Stripe status page; if Stripe is degraded, wait and redeploy when green.

A CloudWatch alarm on the metric filter `billing.probe_failed` is a good follow-up bead but not in MYT-41 scope; the deploy circuit-breaker is the primary signal until that alarm exists.

### Mid-flight Dashboard mutations

The probe runs once per boot, not on Stripe-side mutations. If Miklos archives or renames a price in Dashboard while staging is running, the probe doesn't re-run; in-flight `checkout.sessions.create` calls (per §4: per-request `lookup_key` resolution) will surface the mismatch as the user's first checkout failure. **Operational rule: archival of an active production lookup_key during business hours is an incident.** The runbook documents the right Dashboard procedure: create the new price first, validate the lookup_key resolves, then archive the old. A periodic re-probe + alarm is a follow-up enhancement.

### Wiki references that need updating beyond runbook

The MYT-41 wiki update covers more than the runbook page. The following wiki content references tables migration 006 drops:

- `docs/wiki/diagrams/data/schema.dot` — table nodes for `subscription_tiers`, `session_packs`, `user_subscriptions`, `purchases` (the latter two are recreated in MYT-42 with new shape; for MYT-41 they're temporarily absent).
- `docs/wiki/content/data/schema.html` — schema reference page.
- `docs/wiki/build/schemaTypes.ts` — table-type classification entries.
- Any source-hash-tracked content depending on `backend/migrations/` (refresh hashes via `pnpm wiki:accept-drift`).

The AUTHORING.md subagent handles all of these.

### Pricing

Test-mode prices are placeholders ($15 / $25 / $45 / $5 / $9 in the runbook). Production launches with prices set by cost modeling, via the same procedure against the live-mode Stripe account. The lookup-keys contract is unaffected by price changes — that's the whole point.

### Webhook endpoint

No webhook handler in MYT-41. `STRIPE_WEBHOOK_SECRET` stays at `PLACEHOLDER`. MYT-42 wires the handler and rotates the secret. Per §5a: no bypass branch on PLACEHOLDER, ever.

### Bead myth-u7k cleanup

Open bead `myth-u7k` ("Repo: add billing namespaces — purchases, userSubscriptions, subscriptionTiers, sessionPacks, stripeEvents") references namespaces being dropped here. Edit during MYT-41 close: remove `subscriptionTiers` and `sessionPacks` from its scope; `purchases` and `userSubscriptions` get re-scoped to MYT-42 (the new shape).

## What MYT-41 ships

- `backend/src/billing/lookup-keys.ts` — the contract.
- `backend/src/billing/stripe-client.ts` — read-only wrapper, pinned to `2026-03-25.dahlia`.
- `backend/src/billing/probe.ts` — boot probe with retry/backoff/jitter, structured failure events, currency + interval + duplicate-detect verification, targeted lookup_keys query (no pagination ceiling).
- `backend/eslint-rules/no-stripe-price-mutations.cjs` + ESLint config wiring (narrowed scope: bans price/product/coupon catalog mutations only; allows subscription lifecycle).
- `backend/migrations/006_drop_billing_config_tables.sql` — drops `user_subscriptions`, `purchases`, `session_packs`, `subscription_tiers` in FK-correct order.
- Tests for all of the above.
- Updates: `backend/src/server.ts` (call probe at boot), `backend/src/db/__tests__/migrate-schema.test.ts` (full enumeration update — tables + indexes + checks + FKs), `backend/src/repo/__tests__/_helpers/reset-data.ts` (drop the four dropped tables from the truncate list).
- Spec patches: `docs/specs/2026-04-13-billing-cost-controls.md` §3 + §4 + §5 + §7 + §9 + §10; cross-spec orphan refs in `2026-04-06-production-architecture-overview.md` and `2026-04-10-ux-design.md`.
- Hand-off: `tmp/myt-41-stripe-dashboard-instructions.md` for Miklos to execute (now front-loaded: restricted-key creation + product/price creation + Customer Portal config happen BEFORE code lands).
- Bead `myth-u7k` re-scoping (drop `subscriptionTiers`/`sessionPacks` namespaces; re-scope `purchases`/`userSubscriptions` to MYT-42).

## What MYT-41 does NOT ship

- Backend Stripe runtime code (checkout endpoints, webhook handler) → MYT-42
- Per-session metering and budget enforcement → MYT-43
- Real production prices → launch readiness
- Wiki runbook (deferred to end-of-issue close per workflow)
