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

The webhook handler (lands in MYT-42, but the contract is fixed here) **iterates `data.object.line_items` and grants credits per-line-item via `lookup_key`**, not via the single-SKU `metadata.packId` shape parent spec §4 step 3 assumes. For each line item:

```
lookup_key = line_item.price.lookup_key   (resolved via expand at session-retrieve time)
quantity   = line_item.quantity
spec       = LOOKUP_KEYS[lookup_key]      (throws on unknown — fail loud, do not partially grant)
sessions   = spec.sessionsGranted * quantity
worlds     = spec.worldsGranted   * quantity
```

The grant inserts up to two `credit_ledger` rows per line item — one with `credit_type = 'session'` if `sessions > 0`, one with `credit_type = 'world_gen'` if `worlds > 0`.

**Idempotency mechanism: `stripe_events` table, not `source_id`.** Per parent spec §5, the webhook handler is gated by inserting `event.id` into the `stripe_events` table (event_id PK, ON CONFLICT DO NOTHING). The handler MUST run the entire credit-grant in a single Postgres transaction with the `stripe_events` insert as the first statement. ON CONFLICT means a retry sees the row already exists, the transaction commits with no further work, and credit grants are not re-applied. Migration 004's `uniq_credit_ledger_debit_idempotency` partial unique index does NOT constrain grants — `stripe_events` is the grant-side idempotency.

**The transaction shape:**

```sql
BEGIN;
SET LOCAL transaction_isolation = 'read committed';
INSERT INTO stripe_events (event_id, event_type)
  VALUES ($eventId, $eventType)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id;
-- if no row returned, the event was already processed; COMMIT and exit.
-- otherwise, run all credit_ledger inserts for this event below.
INSERT INTO credit_ledger (...);  -- one per (line_item, credit_type) where >0
COMMIT;
```

A handler crash mid-loop produces a ROLLBACK; the retry re-runs the whole loop atomically. Without the transaction, partial grants are possible.

**`source_id` shape on grant rows:** `credit_ledger.source_id` is `UUID` (per migration 001 line 30). For grant rows, set `source_id = uuidv7()` — a fresh UUIDv7 per row, derived nowhere from Stripe identifiers. The Stripe `event_id` and `checkout.session.id` are stored in a sibling structured field (the parent spec's `purchases` table on its MYT-42 reshape, OR a `stripe_event_id` column on `credit_ledger` if MYT-42 prefers; the choice is MYT-42's). What matters here: don't try to encode Stripe IDs into the UUID column; the `stripe_events` PK provides cross-event idempotency without it.

**`metadata.userId` is required on the Checkout session** so the webhook resolves `userId` without a prior `customers` lookup; the parent spec §4 step 3's `metadata.packId` is replaced with the per-line-item walk above. The webhook handler MUST verify `metadata.userId` resolves to a real `users` row before granting (don't insert against a fabricated user; FK violation aborts the transaction silently from Stripe's view, triggering retries).

**Defense in depth on `metadata.userId`:** the Checkout endpoint also sets `customer = users[userId].stripe_customer_id` on the same Checkout session (creating the Stripe customer on first checkout, populating `users.stripe_customer_id` atomically). The webhook handler asserts `event.data.object.customer === users[metadata.userId].stripe_customer_id` — a tampered metadata.userId would fail this cross-check. `metadata` is set server-side from the JWT-derived user; client-supplied metadata is rejected at the HTTP boundary.

### Per-event-type resolution rules

`metadata.userId` is only present on `checkout.session.completed` events. Other event types must resolve `userId` differently:

| Event type | Resolution | Credit grant? |
|---|---|---|
| `checkout.session.completed` | `metadata.userId` (server-set at Checkout creation); cross-check against `customer` field | Yes — per-line-item walk, see above |
| `invoice.paid` (subscription cycle) | `customer.id → users.stripe_customer_id`; verify `billing_reason === 'subscription_cycle'` (skip first-cycle invoices, those grants come from `checkout.session.completed`) | Yes — read the subscription's `items[].price.lookup_key`, grant credits per LOOKUP_KEYS spec |
| `customer.subscription.updated` | `customer.id → users.stripe_customer_id` | Mid-period plan switch credit handling is deferred to MYT-42; at minimum, update `users` subscription state. Pro-rated credit grants are MYT-42 design |
| `customer.subscription.deleted` | `customer.id → users.stripe_customer_id` | No grants. Update subscription state; existing credits remain usable through `expires_at`. |
| `charge.refunded` | Traverse via `charge.payment_intent → customer.id → users.stripe_customer_id` | Reverse: insert negative credit_ledger rows mirroring the original grant. Track in `purchases` (MYT-42 reshape) for audit. Negative balance flagged for manual review per parent §5.265 |

Event types not in this table are ignored (return 200 OK to Stripe; emit a `billing.webhook_ignored` log line for observability).

**`users.stripe_customer_id` becomes the join key** for non-Checkout events. The Checkout flow populates it on first checkout (passing `customer = ...` to `checkout.sessions.create`, or letting Stripe auto-create and storing the returned `customer.id` on the user row in the same transaction as the credit grant). Until first checkout, `users.stripe_customer_id` is NULL — but no non-Checkout webhook event can arrive for a user who hasn't had their first Checkout, so the NULL state is unreachable from the webhook handler's perspective.

### Stripe price-shape verification (boot probe scope)

The boot probe (per §3) verifies the contract-shape dimensions where Dashboard misconfiguration would silently produce wrong charges:

| Dimension | Tier | À-la-carte | Reason |
|---|---|---|---|
| `lookup_key` resolves to exactly one active price | yes | yes | Mismatch / typo. |
| `currency === 'usd'` | yes | yes | EUR-by-accident charges wrong amount. |
| `recurring.interval === 'month'` | yes | n/a | Annual-by-accident charges 12× expected interval. |
| `recurring.interval_count === 1` | yes | n/a | Quarterly (`interval='month', interval_count=3`) silently passes interval check; bills every 3 months while granting monthly. |
| `recurring.usage_type === 'licensed'` | yes | n/a | Metered changes which webhook events fire (`invoice.created` line items vs flat `invoice.paid`); breaks credit-grant assumption. |
| `billing_scheme === 'per_unit'` | yes | yes | Tiered changes how `amount_total` is computed and breaks downstream amount validation. |
| `unit_amount > 0` | yes | yes | $0 price produces free paid-tier subscriptions. |
| Type matches contract (`recurring` ↔ tier, no `recurring` ↔ SKU) | yes | yes | Kind mismatch. |
| No duplicate active lookup_keys | yes | yes | Silent-overwrite would let an attacker swap pricing. |

**Not verified (out of scope):** `unit_amount` exact value (Miklos-owned via Dashboard), product name, `tax_behavior` (revisit when international billing matters).

### Replacing parent spec §5.5's `amount_total` validation

Parent §5.5 said the webhook handler verifies `amount_total` matches the expected price stored in `subscription_tiers` / `session_packs`. MYT-41 drops those tables; `lookup-keys.ts` deliberately excludes prices. **The webhook handler validates `amount_total` against Stripe itself, not against a checked-in source.** Specifically:

- Webhook receives `event.data.object` with `amount_total` and the line-item array.
- Webhook fetches each line item's `unit_amount` from `event.data.object.line_items[].price.unit_amount` (Stripe expands this when retrieving the Checkout session with `expand: ['line_items.data.price']`).
- Webhook computes `expected_total = sum(unit_amount * quantity)` and asserts `expected_total === amount_total`.

**TOCTOU window:** if a Dashboard mutation lands between Checkout creation and webhook arrival, the `unit_amount` Stripe reports on the webhook event matches what was actually charged (Stripe captures the price snapshot at session creation time). So `amount_total === sum(unit_amount × qty)` is always true under normal Stripe behavior — the validation is a defense against (a) Stripe API bugs, (b) mid-flight tampering by an attacker who can write to Stripe (which the restricted key blocks). It is NOT a defense against the operator changing the price between yesterday and today; that is policy, not correctness.

The boot probe (catalog-shape) and the webhook validation (per-charge sum) together cover §5.5's price-manipulation prevention intent. The `lookup-keys.ts` contract isn't part of the price-validation chain; it's the credit-grant contract.

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
2. The price's type matches the contract: `tier_*` → `recurring`, `sku_*` → one-time (`price.recurring === null`).
3. `currency === 'usd'`.
4. `unit_amount > 0` ($0 price would produce free paid-tier subscriptions).
5. `billing_scheme === 'per_unit'` (tiered breaks `amount_total` math).
6. **`transform_quantity === null`** (`{divide_by: N}` would silently charge fractional units, e.g., charge for half the sessions purchased).
7. **`tax_behavior` is `'unspecified'` or `null`** (Mythrun launches USD-only, no tax handling per non-goals; flipping `tax_behavior='inclusive'` or `'exclusive'` shifts displayed-vs-charged math and should require a deliberate spec patch).
8. **The expanded `product.active === true`** (Stripe permits `price.active=true` while `product.active=false`; `prices.list` still returns the orphaned price, but `checkout.sessions.create` against an archived product 4xx's. The probe must catch this — it is *exactly* the Dashboard-misconfiguration class the probe exists to prevent).
9. For `tier_*`: `recurring.interval === 'month'`.
10. For `tier_*`: `recurring.interval_count === 1` (quarterly tier — `interval='month', interval_count=3` — would otherwise silently pass).
11. For `tier_*`: `recurring.usage_type === 'licensed'` (metered changes which webhook events fire).

**What the probe does NOT verify:** the exact dollar amount and the product name. Those are Miklos-owned via the Dashboard; the probe's job is contract-shape, not pricing-policy.

To support check 8, the probe issues `prices.list({ ..., expand: ['data.product'] })` so each price's `product` field is hydrated to the full Product object. The expanded shape lands as `Stripe.Product`, with `active: boolean`.

**Stripe API errors are not all transient.** The probe distinguishes:

- `Stripe.errors.StripeAuthenticationError` (401, bad API key) → fail fast as `BillingProbeAuthError`. No retry. The fix is to rotate the secret; retrying won't help.
- `Stripe.errors.StripePermissionError` (403, restricted-key missing `Prices: read`) → fail fast as `BillingProbeAuthError`. Same reason.
- `Stripe.errors.StripeAPIError` / `StripeConnectionError` / network timeout → transient, retry up to 3× with backoff (per below).
- Contract mismatch (lookup_key missing, wrong type, etc.) → fail loud as `BillingProbeError`. No retry.

**Transient-error handling.** Stripe API has occasional 5xx and timeouts. The probe distinguishes:

- **Contract mismatch** (lookup_key missing, wrong type, wrong currency, etc.) → boot fails loud with `BillingProbeError`. No retry — this is an operator fix.
- **Transient Stripe API error** (network error, timeout, 5xx) → retry up to 3 times with exponential backoff (1s, 2s, 4s) plus 0–1s jitter (mirrors MYT-37's JWKS hydrate pattern). If all retries fail, boot fails loud with `BillingProbeTransientError` (distinct error class). The operator response differs: contract mismatch = fix Dashboard, transient = check Stripe status page, redeploy.

**The Stripe-availability ceiling.** The probe's worst-case fail-loud window is approximately 31 seconds (3 attempts × 7s timeout + 1+2+4s backoff + jitter). For sustained Stripe outages exceeding that window, **Mythrun's API availability is bounded by Stripe's API availability** — for any container that needs to boot during the outage. Specifically:

- ECS rolling deploys: deploy circuit breaker rolls back automatically — operator playbook: "delay the deploy until Stripe recovers."
- ECS auto-scale events during a Stripe outage: Mythrun cannot add capacity. Surviving healthy tasks continue serving, but the cluster cannot grow.
- ECS task-replacement after health-check failure: running tasks unaffected; replacements stuck until Stripe recovers.
- AZ-level failovers: same — redistributed tasks fail to boot.

**This is a deliberate tradeoff.** Mythrun's launch scale (200–500 concurrent sessions) and rare auto-scale events make fail-loud the correct choice today. The alternative (degraded-boot mode using a Redis-cached "last-successful-contract-digest" — if Stripe is `BillingProbeTransientError`-ing AND the in-cluster Redis has a recent ≤ 1h probe-success digest, boot in degraded mode logging `billing.probe_degraded_boot`) is named as a near-future enhancement, not in MYT-41 scope.

**Operator awareness is the load-bearing piece.** The fail-loud-on-Stripe-outage tradeoff is only safe if the operator notices when Stripe is degraded *before* an unrelated cause forces a task replacement. The follow-up bead `myth-billing-probe-alarm` (named below) is a **hard-blocking precondition** for any production traffic — it pages on `billing.probe_failed | billing.probe_auth_failed | billing.probe_transient_failed` so the operator hears about Stripe-degradation immediately, not via customer reports of failed scaling. The bead has owner=Miklos, target completion within 1 cycle of MYT-41 close, and is required before promoting Mythrun to production-launch readiness. **MYT-41 does not promote to production until that alarm is live.**

**Operationally, the consequence:** if Stripe has a degraded-API incident during Mythrun's launch window, the playbook is (a) check CloudWatch for `billing.probe_failed`/`probe_transient_failed` events to confirm the cause, (b) hold deploys, (c) accept that auto-scale won't add capacity until Stripe recovers, (d) communicate with users if session-play surface degrades. Session play itself is not directly Stripe-dependent (atomic-debit reads from `credit_ledger`, not Stripe), so running tasks continue to serve game traffic during a Stripe outage — only billing-write paths and new-task boots are affected. This decouples session-play availability from Stripe availability for the running fleet.

If during launch operations the cluster-capacity-loss tradeoff turns out to bite (auto-scale events coincide with Stripe outages too often), the degraded-boot mode is the prepared mitigation and can land as a hot patch within hours.

**The probe runs on every boot, not on Stripe-side mutations.** If Miklos archives a price in Dashboard while the API is running, the probe doesn't re-run; in-flight requests using the same `lookup_key` will fail at `checkout.sessions.create` time when MYT-42's per-request resolver looks up the key (see §4 below). Adding a periodic re-probe is operationally useful but deferred — we'd want a CloudWatch metric on the re-probe outcome before a paging-able alarm makes sense.

### 4. MYT-42 resolves `lookup_key → price_id` per request, not from a boot cache.

**Decision:** The Checkout endpoint (lands in MYT-42) resolves each `lookup_key` to a Stripe Price ID by calling `stripe.prices.list({ lookup_keys: [...], active: true })` *at request time*, not by caching the boot-probe's resolved map. The price ID is then passed to `stripe.checkout.sessions.create({ line_items: [{ price: priceId, quantity: ... }] })`.

**Why:** The boot probe is a fail-fast contract verification, not a price-binding cache. If we cached price IDs from boot, a Stripe Dashboard mutation (archive + recreate) during the running container's lifetime would silently use a stale ID; users would hit "no such price" 500s. Per-request resolution makes the system tolerant to mid-flight Dashboard changes — at the cost of one extra Stripe API call per checkout, which is negligible.

**Stripe 5xx behavior at checkout time:** the per-request resolver gets a tight timeout (≤ 3s) and **NO retry, NO cache fallback**. On Stripe 5xx or timeout, the checkout endpoint returns `503 {code: 'billing_temporarily_unavailable'}` with `Retry-After: 30`. The user retries; staging/prod Stripe outages affect checkout availability but not running session play.

**No fallback to boot-cached map.** Even though the boot probe verified prices, the Checkout endpoint never reaches into the probe's resolution map. The boot probe is a fail-fast verification at startup; the per-request resolver is the contract for live operation.

**Caching guidance for non-checkout reads** (e.g., a `GET /api/billing/skus` endpoint that displays tier prices on a marketing page): in-process LRU cache, 60-second TTL, fall-back-to-last-known on Stripe 5xx. The marketing page's data freshness has a different SLA than checkout — stale-but-up is the right tradeoff. Spec'd in MYT-42; flagged here so the implementer doesn't reach for `prices.retrieve` on every render.

### 5. The trial is account-state, not a Stripe SKU.

**Decision:** First-time users get one trial session credit granted **at account registration**, with no card collected and no Stripe interaction. Tracked as a row in `credit_ledger` with `credit_type = 'session'`, `amount = 1`, `source_type = 'trial'`, `source_id = NULL`, `expires_at = NULL`. The grant + the `users.free_trial_used = true` flip happen in a single transaction so a partial failure can't double-grant.

This corrects the parent §7 ambiguity: parent §7 implementation steps imply the flag flips at session-start; that prose is now wrong. The §"Spec patches" section below patches parent §7 to match this design (grant at registration, not at session-start). MYT-43 implements the registration flow against this row shape.

All four migration 004 CHECK constraints + the partial unique idempotency index are non-firing for this row shape — `(source_type='debit') = (amount<0)` becomes `false=false`; `source_id IS NULL` is allowed for non-debits; `expires_at IS NULL` is allowed for non-debits; `source_type` is in the enumerated allowlist. Cross-spec compatible.

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
- `stripe.prices.create|update` — both arg shapes including the archival idiom `update(id, { active: false })`. Archival is a Dashboard task; the runtime never archives prices.
- `stripe.coupons.create|update|del` (disabled at launch; pre-emptive ban so re-enabling is a deliberate spec change)
- `stripe.promotionCodes.create|update` (same reason)
- **`stripe.subscriptions.update` calls passing a literal `price_*` argument in `items[].price`** — closes the subscription-item-mutation backdoor (see below).

**Explicitly allowed (rule does NOT fire):**

- `stripe.checkout.sessions.create` — creates a hosted-checkout session
- `stripe.billingPortal.sessions.create` — creates a Portal session
- `stripe.webhooks.constructEvent` — verifies webhooks
- `stripe.subscriptions.update` for non-pricing fields — `cancel_at_period_end`, `metadata`, `pause_collection`. Banned only for `items[].price` mutations (see custom rule below).
- `stripe.subscriptions.cancel` / `stripe.subscriptions.del` — needed for admin-tools fraud cancellation
- `stripe.customers.create|retrieve|update` — managing the customer record on our side
- All read methods: `prices.list`, `prices.retrieve`, `products.retrieve`, `subscriptions.retrieve`, etc.

### Closing the `subscriptions.update` price-change backdoor

`stripe.subscriptions.update(id, { items: [{ id: si_x, price: 'price_NEW' }] })` is technically a `Subscriptions: write` operation that the restricted key permits, but it changes the effective billing price for the customer's next renewal — the same outcome the price-mutation defenses are supposed to prevent. The defense layers, in order:

1. **Mythrun's tier-switching flow goes through Stripe Customer Portal exclusively** (not via app code). The Portal's "Switch plan" feature is allowlisted (per the §5.4 patch) to the three configured tiers (Wayfarer/Sojourner/Mythwright). App code does NOT call `subscriptions.update({ items: [...] })` to change tiers under any circumstance.
2. **Custom ESLint rule** (`no-stripe-subscription-price-mutation`) flags any `stripe.subscriptions.update` call whose object literal includes `items: [...]` containing a `price` field — regardless of whether the price value is a literal `price_*` string, a lookup_key resolution, or any other expression. The rule is conservative: any subscription-item price-mutation pattern fires the diagnostic and requires explicit `// eslint-disable-next-line` review.
3. **Runtime guard in the Stripe-client wrapper** (out of MYT-41 scope, owned by MYT-42's checkout/portal helper layer): a typed wrapper that disallows passing `items: [{ price }]` to `stripe.subscriptions.update`. Implementation deferred to MYT-42.

The defense is "tier-switching is Portal-only, never app-code-initiated" with lint + (future) typed-wrapper as tripwires. This narrows the Lyra I3 attack surface to "an attacker with access to the Stripe API key calls subscriptions.update directly" — at which point they already have the restricted key and the only remaining defense is rotation + Stripe's own logging. Acceptable.

The narrowing matters: the user's intent is "code can't *write the price*," not "code can't touch any Stripe object." Banning `subscriptions.update|cancel` would block legitimate cancel-from-our-UI flows and admin escape hatches.

**Pattern-evasion is acknowledged.** ESLint matches `MemberExpression` chains; `stripe['products']['create'](...)`, `const create = stripe.products.create.bind(...); create(...)`, or `(stripe as any).products.create(...)` would all bypass the rule. We document this and rely on (a) the restricted API key in §1 as the actual SDK-level boundary, (b) code review catching the sentinel patterns. The rule is a tripwire for honest mistakes, not a defense against motivated bypass.

**Disable comments at code review.** A future PR with `// eslint-disable-next-line no-stripe-price-mutations` is visible at review and requires the reviewer to understand and approve the disable. That's the lint rule's actual job.

### 7. Per-environment Stripe accounts; restricted keys; rotation procedure.

**Decision:** Test mode runs against the Mythrun test-mode Stripe account. Production mode (at launch) runs against a separate Stripe live-mode account. They share no keys. **The `STRIPE_SECRET_KEY` value in each environment's Secrets Manager is a *restricted key* per §1**, not a full-permission secret key.

**Restricted-key permission set:**

| Resource | Access | Notes |
|---|---|---|
| Prices | Read | Probe + per-request resolver. |
| Products | Read | Probe expand. |
| Customers | Write | Create on first checkout; update metadata. |
| Checkout Sessions | Write | Create checkout sessions. |
| Billing Portal Sessions | Write | Create Portal sessions. |
| Subscriptions | Write | Used **only** for admin-tools fraud cancellation (`stripe.subscriptions.cancel`); user-initiated tier switches go through Customer Portal exclusively (per §6 closing of the price-change backdoor). User-initiated cancels also go through Portal at launch; if an in-app cancel button ships later (post-launch UX decision), it would call `stripe.subscriptions.update({ cancel_at_period_end: true })` — covered by this permission. |
| Webhook Endpoints (signing secret) | Read | MYT-42 reads at startup. |
| Events | Read | Future bead: webhook-event replay on missed-event recovery. Not strictly needed for MYT-41 launch but cheap to enable now. |
| Charges | Read | Future bead: refund-flow customer resolution traversal (`charge.payment_intent → customer.id`). |
| Refunds | None at launch | Refund-issuance is operator-via-Dashboard at launch. Add `Write` later if app code initiates refunds. |
| Coupons | None | Disabled at launch per non-goals; banned by ESLint rule. |
| Promotion Codes | None | Same. |

This permission set is enforceable in Stripe Dashboard → Developers → API keys → Create restricted key. The runbook (`tmp/myt-41-stripe-dashboard-instructions.md`) walks through it.

**Rotation procedure:**

For MYT-41 (no Stripe-using runtime code): rotate by (1) create a new restricted key in Stripe Dashboard, (2) update the Secrets Manager entry, (3) trigger an ECS rolling deploy via `gh workflow run Deploy` (ECS does NOT auto-restart on Secrets Manager changes — the rolling deploy is what re-reads the secret). (4) The boot probe re-runs against the new key on each new task; green = rotation complete; red = rollback the secret value.

For post-MYT-42 (Stripe-using runtime code): the same sequence with one critical change — **do NOT revoke the old key until the new-key deploy is fully rolled out.** Stripe Dashboard's "Roll" rotation supports keeping multiple restricted keys live concurrently. Use that. Sequence: (1) create new restricted key, (2) update Secrets Manager, (3) deploy, (4) verify all running tasks are on the new key (CloudWatch: every running task has emitted at least one `billing.probe_passed` since the secret update), (5) revoke the old key in Stripe Dashboard. If you revoke before step 4, in-flight Stripe API calls in old-key tasks start 401-ing.

**Rotation cadence enforcement:** "every 6 months" is a guideline, not an automated check. The cheapest enforcement is a recurring Linear issue (Linear supports cycle-based recurring issues) titled "MYT-ops: rotate STRIPE_SECRET_KEY restricted key in test + prod" — set up at MYT-41 close. Stripe also sends sunset emails for API versions ~12 months in advance; the email destination should be monitored.

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

**`users.stripe_customer_id` already exists.** Migration 001 creates it (`stripe_customer_id TEXT UNIQUE`), and migrations 002–005 leave it intact. MYT-42 reuses the column — no ALTER needed. MYT-41 is silent on this column; the boot probe and lookup-keys contract do not depend on it. The column is `NULL` until a user's first checkout populates it via `customers.create` in MYT-42.

**Webhook route absence during the MYT-41 → MYT-42 window.** Until MYT-42 lands, no `/webhooks/stripe` route exists in the Fastify app — the §5a "fail closed on `'PLACEHOLDER'`" argument depends on the verifying handler being the only code path that consumes the secret. Until that handler exists, the route MUST NOT be registered (no smoke-test handler, no body-logger, no permissive catch-all). MYT-41 closes by confirming via `app.routes` that no route resolves `/webhooks/stripe`; MYT-42 lands the route + the rotated secret atomically. Stripe Dashboard webhook endpoint is also NOT created until MYT-42 — otherwise Stripe queues real events into 404s during the window.

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

### `backend/src/config/env.ts` — add Stripe env fields

The `Env` interface gains two fields and the loader reads + validates them. **Patch:**

```typescript
// In the Env interface:
readonly stripeSecretKey: string         // restricted key prefix 'rk_' enforced
readonly stripeWebhookSecret: string     // 'PLACEHOLDER' permitted until MYT-42 wires the handler

// In loadEnv() / validators:
const stripeSecretKey = readRequired('STRIPE_SECRET_KEY')
if (!stripeSecretKey.startsWith('rk_')) {
  throw new Error(
    `STRIPE_SECRET_KEY must be a Stripe restricted key (rk_*); got prefix '${stripeSecretKey.slice(0, 3)}'. ` +
    `Full-permission keys (sk_*) are forbidden in deployed environments per the MYT-41 design.`,
  )
}
const stripeWebhookSecret = readRequired('STRIPE_WEBHOOK_SECRET') // 'PLACEHOLDER' is fine pre-MYT-42
```

The `rk_` prefix check is the env-loader-side enforcement of the restricted-key invariant from §1. A misrotation that puts an `sk_test_*` (full-permission) key in `STRIPE_SECRET_KEY` would otherwise pass the boot probe (probe only does reads, full-permission satisfies them) and silently degrade the §1 defense.

`STRIPE_WEBHOOK_SECRET` is required-but-not-format-validated; the `'PLACEHOLDER'` literal is allowed during the MYT-41 → MYT-42 window. MYT-42's webhook handler receives the actual signing secret and must fail-closed on any signature mismatch (per §5a).

### `backend/src/billing/stripe-client.ts` — read-only wrapper

A thin module that constructs a `Stripe` client from `env.stripeSecretKey` and exports a cached instance. The wrapper is a constructor cache, not a type-narrowing facade — every Stripe SDK method is reachable through it. The actual read-only enforcement layer is the **restricted API key** (§1) — the SDK rejects mutation attempts at the network level regardless of what code calls. The ESLint rule (§6) is a code-review tripwire on top.

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
// Stripe price with the right type, currency, billing-shape dimensions,
// and (for recurring) interval + interval_count + usage_type. Distinguishes
// auth errors (fail fast — fix the secret), contract mismatches (fail
// loud — fix Dashboard), and transient Stripe-API errors (retry with
// backoff).
//
// Read-only: only stripe.prices.list. Restricted API key in production
// rejects any mutation regardless.

import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import type { Logger } from 'pino'
import { LOOKUP_KEYS, type LookupKey } from './lookup-keys.js'

const PROBE_TIMEOUT_MS = 7000
const PROBE_MAX_ATTEMPTS = 3
const PROBE_BACKOFF_MS = [1000, 2000, 4000]
const PROBE_JITTER_MS = 1000

// Static guardrail: lookup_keys filter has a Stripe-API hard ceiling at 100.
// If LOOKUP_KEYS ever grows past this, the probe needs pagination.
if (Object.keys(LOOKUP_KEYS).length > 100) {
  throw new Error(
    'BillingProbe: LOOKUP_KEYS exceeds 100 entries; Stripe prices.list lookup_keys filter caps at 100 — redesign required.',
  )
}

export class BillingProbeError extends Error {
  readonly code = 'BILLING_PROBE_FAILED'
  constructor(readonly mismatches: ReadonlyArray<string>, readonly bootId: string) {
    super(`Stripe billing probe failed (contract mismatch) [boot=${bootId}]:\n  ${mismatches.join('\n  ')}`)
    this.name = 'BillingProbeError'
  }
}

export class BillingProbeAuthError extends Error {
  readonly code = 'BILLING_PROBE_AUTH'
  constructor(readonly cause: unknown, readonly bootId: string) {
    super(`Stripe billing probe failed at authentication [boot=${bootId}]: ${String(cause)} — rotate STRIPE_SECRET_KEY`)
    this.name = 'BillingProbeAuthError'
  }
}

export class BillingProbeStripeAPIChangeError extends Error {
  readonly code = 'BILLING_PROBE_API_CHANGE'
  constructor(readonly bootId: string) {
    super(`Stripe billing probe got has_more=true on a lookup_keys-bounded query [boot=${bootId}]; Stripe API contract changed.`)
    this.name = 'BillingProbeStripeAPIChangeError'
  }
}

export class BillingProbeTransientError extends Error {
  readonly code = 'BILLING_PROBE_TRANSIENT'
  constructor(readonly cause: unknown, readonly attempts: number, readonly bootId: string) {
    super(`Stripe billing probe failed transiently after ${String(attempts)} attempts [boot=${bootId}]: ${String(cause)}`)
    this.name = 'BillingProbeTransientError'
  }
}

export async function probeStripeContract(
  stripe: Stripe,
  logger: Logger,
): Promise<void> {
  const bootId = randomUUID()
  const lookupKeys = Object.keys(LOOKUP_KEYS) as LookupKey[]

  logger.info({ event: 'billing.probe_started', bootId, count: lookupKeys.length }, 'Stripe billing probe started')

  // Targeted query: ask Stripe for exactly the keys in the contract,
  // expanding the product so we can verify product.active === true.
  // Avoids paginate-all-prices truncation hazard.
  const result = await fetchPricesWithRetry(stripe, lookupKeys, logger, bootId)

  // Defensive: a lookup_keys-bounded query should NEVER return has_more=true.
  // If Stripe ever changes that, treat as a contract-shape change, not a
  // probe-pass-with-truncated-data.
  if (result.has_more) {
    throw new BillingProbeStripeAPIChangeError(bootId)
  }

  const mismatches: string[] = []
  const fetched = result.data

  // Duplicate detection — fail loud, not silent last-wins.
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

  // Build a map only after duplicate-detection.
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

    // Currency
    if (price.currency !== 'usd') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has currency '${price.currency}' in Stripe; contract expects 'usd'`,
      )
    }

    // Type (recurring vs one-time)
    const stripeType: 'recurring' | 'one_time' = price.recurring ? 'recurring' : 'one_time'
    if (stripeType !== spec.type) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has type '${stripeType}' in Stripe but contract expects '${spec.type}'`,
      )
      continue // remaining shape checks depend on the type
    }

    // unit_amount > 0 (no $0 paid-tiers)
    if (typeof price.unit_amount !== 'number' || price.unit_amount <= 0) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has unit_amount '${String(price.unit_amount)}' in Stripe; contract expects > 0`,
      )
    }

    // billing_scheme === 'per_unit' (tiered breaks amount_total math)
    if (price.billing_scheme !== 'per_unit') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has billing_scheme '${price.billing_scheme}' in Stripe; contract expects 'per_unit'`,
      )
    }

    // transform_quantity === null (otherwise fractional charging is silent)
    if (price.transform_quantity !== null) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has non-null transform_quantity in Stripe; contract requires null (no quantity transformation)`,
      )
    }

    // tax_behavior must be 'unspecified' or absent (Mythrun launches USD-only, no tax handling)
    if (price.tax_behavior && price.tax_behavior !== 'unspecified') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has tax_behavior '${price.tax_behavior}' in Stripe; contract expects 'unspecified' (no tax handling at launch)`,
      )
    }

    // Expanded product must be active.
    const product = price.product
    if (typeof product === 'string' || product === null || !('active' in product)) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has unexpanded or deleted product field; probe expected expand: ['data.product']`,
      )
    } else if (!product.active) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' resolves to a price whose product is archived (product.id='${product.id}'); checkout will fail at session-create. Reactivate the product in Dashboard or rotate the lookup_key onto a price under an active product.`,
      )
    }

    // Recurring-only checks
    if (spec.type === 'recurring') {
      if (price.recurring?.interval !== 'month') {
        mismatches.push(
          `lookup_key '${spec.lookupKey}' has recurring.interval '${String(price.recurring?.interval)}' in Stripe; contract expects 'month'`,
        )
      }
      if (price.recurring?.interval_count !== 1) {
        mismatches.push(
          `lookup_key '${spec.lookupKey}' has recurring.interval_count '${String(price.recurring?.interval_count)}' in Stripe; contract expects 1 (monthly, not multi-month)`,
        )
      }
      if (price.recurring?.usage_type !== 'licensed') {
        mismatches.push(
          `lookup_key '${spec.lookupKey}' has recurring.usage_type '${String(price.recurring?.usage_type)}' in Stripe; contract expects 'licensed'`,
        )
      }
    }
  }

  if (mismatches.length > 0) {
    logger.error(
      { event: 'billing.probe_failed', bootId, mismatchCount: mismatches.length, mismatches },
      'Stripe billing contract mismatch',
    )
    throw new BillingProbeError(mismatches, bootId)
  }

  logger.info(
    { event: 'billing.probe_passed', bootId, count: lookupKeys.length },
    'Stripe billing contract verified',
  )
}

async function fetchPricesWithRetry(
  stripe: Stripe,
  lookupKeys: ReadonlyArray<LookupKey>,
  logger: Logger,
  bootId: string,
): Promise<Stripe.ApiList<Stripe.Price>> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    try {
      return await stripe.prices.list(
        {
          lookup_keys: [...lookupKeys],
          active: true,
          // expand the product so we can verify product.active === true.
          // (A price.active=true child of an archived product still
          // returns from prices.list but fails at checkout.sessions.create.)
          expand: ['data.product'],
          // limit is the response page size cap. Use lookupKeys.length × 10
          // (capped at Stripe's hard ceiling of 100) as headroom for
          // duplicate-detection — a misconfigured Dashboard with multiple
          // active prices per lookup_key needs to fit in one response, or
          // the has_more=true assertion fires and we report the wrong
          // failure class.
          limit: Math.min(lookupKeys.length * 10, 100),
        },
        { timeout: PROBE_TIMEOUT_MS },
      )
    } catch (err) {
      // Auth / permission errors are NOT transient. Fail fast — retrying
      // won't help; the operator must rotate the secret.
      if (
        err instanceof Stripe.errors.StripeAuthenticationError ||
        err instanceof Stripe.errors.StripePermissionError
      ) {
        logger.error(
          { event: 'billing.probe_auth_failed', bootId, err: err.message },
          'Stripe billing probe auth/permission failure',
        )
        throw new BillingProbeAuthError(err, bootId)
      }
      lastErr = err
      if (attempt === PROBE_MAX_ATTEMPTS) break
      const base = PROBE_BACKOFF_MS[attempt - 1] ?? PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1]!
      const jitter = Math.floor(Math.random() * PROBE_JITTER_MS)
      logger.warn(
        {
          event: 'billing.probe_transient_retry',
          bootId,
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
      bootId,
      attempts: PROBE_MAX_ATTEMPTS,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
    'Stripe billing probe transient failure after retries',
  )
  throw new BillingProbeTransientError(lastErr, PROBE_MAX_ATTEMPTS, bootId)
}
```

The probe is called from the boot gate (after `loadEnv` succeeds, before `app.listen`). Failure modes:

- `BillingProbeAuthError` → rotate `STRIPE_SECRET_KEY`; do NOT retry on the same key.
- `BillingProbeError` → fix Dashboard; redeploy after.
- `BillingProbeStripeAPIChangeError` → Stripe API contract changed; investigate, possibly bump `STRIPE_API_VERSION`.
- `BillingProbeTransientError` → check Stripe status; redeploy after Stripe recovers.

All five emit structured CloudWatch events with a `bootId` field for trace correlation. A CloudWatch metric filter alarming on `billing.probe_failed | billing.probe_auth_failed | billing.probe_transient_failed` is a follow-up bead (`myth-billing-probe-alarm`) that should land within one cycle of MYT-41 close — without it, contract drift surfaces only via customer-reported failures.

### `backend/migrations/006_drop_billing_config_tables.sql`

```sql
-- Migration 006 — drop legacy billing-config tables and their dependents.
--
-- MYT-41 moves the tier and pack credit-allocation contract into a
-- checked-in TS file (backend/src/billing/lookup-keys.ts). Stripe stays
-- the source of truth for prices; lookup_key is the indirection that
-- lets backend code reference SKUs without coupling to Stripe Price IDs.
--
-- Drop order matters because migration 001 created the FK
--   user_subscriptions.tier_id → subscription_tiers(id) (ON DELETE NO ACTION)
-- A naive `DROP TABLE subscription_tiers` would fail with SQLSTATE 2BP01
-- ("cannot drop table because other objects depend on it"), aborting
-- migration 006 inside the runner's transaction wrapper.
--
-- `purchases` from migration 001 has no FK into the config tables (no
-- `package_id` column; columns are id, user_id, stripe_payment_intent_id,
-- session_pack_size, amount_cents, currency, status, created_at).
-- It's still dropped here because MYT-42 recreates it with a new
-- shape (lookup_key TEXT instead of session_pack_size INTEGER).
--
-- Drop order:
--   1. user_subscriptions (FK depends on subscription_tiers)
--   2. purchases (no FK, but recreated by MYT-42)
--   3. session_packs
--   4. subscription_tiers

-- Pre-drop emptiness check. Pre-merge verification ran ~hours/days ago;
-- a row could land between merge and deploy. The migration runs inside
-- the runner's BEGIN/COMMIT, so a non-empty assertion fires-and-aborts
-- before any destructive operation runs. The four expected counts are 0.
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM user_subscriptions) = 0,
    'user_subscriptions is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
  ASSERT (SELECT count(*) FROM purchases) = 0,
    'purchases is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
  ASSERT (SELECT count(*) FROM session_packs) = 0,
    'session_packs is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
  ASSERT (SELECT count(*) FROM subscription_tiers) = 0,
    'subscription_tiers is non-empty; refusing to drop. Inspect rows and decide migration strategy.';
END $$;

-- Drops in FK-correct order.
DROP TABLE IF EXISTS user_subscriptions;
DROP TABLE IF EXISTS purchases;
DROP TABLE IF EXISTS session_packs;
DROP TABLE IF EXISTS subscription_tiers;

-- Post-drop assertion.
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

**Migration 006 is non-reversible without backup restore.** Pre-drop ASSERT fires loud if any environment has unexpected rows; pre-merge verification confirms emptiness in dev/staging today. MYT-42 ships migration 007 to recreate `user_subscriptions` and `purchases` with the new shape; rollback between MYT-41 ship and MYT-42 ship leaves those two tables absent — acceptable because no code references them in that window.

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

### `docs/specs/2026-04-13-billing-cost-controls.md` §7 — Free Trial

- Replace §7.348–356 implementation-steps prose with: *"Trial credit is granted at registration, not at session-start. On `POST /api/users/register`, the same transaction that creates the `users` row inserts a `credit_ledger` row (`credit_type='session', amount=1, source_type='trial', source_id=NULL, expires_at=NULL`) and sets `users.free_trial_used = true`. Sessions consume the trial credit via the standard atomic-debit recipe (§2). No special trial-mode session machinery; the time-cap and demo-world choices in §7 are session-runtime concerns owned by MYT-43, decoupled from credit-grant timing."*
- §7.350 references `session_usage.source_type = 'trial'` — the `session_usage` table has no `source_type` column. Drop this line; trial sessions are not flagged in `session_usage`.

### `docs/specs/2026-04-13-billing-cost-controls.md` §10 — Edge Cases (orphan-reference cleanup)

- §10.477 ("Debit consumes the earliest-expiring credits first…") conflicts with the MYT-40 atomic-debit recipe, which inserts a single negative ledger row with no FIFO/LIFO ordering. Replace with: "Debit ordering is implementation-defined; MYT-43 picks the consumption-priority strategy."

### `docs/specs/2026-04-13-billing-cost-controls.md` §9 — API Routes (consistency)

- `GET /api/billing/tiers` and `GET /api/billing/packs` (§9.420 of parent) → replace with `GET /api/billing/skus` returning a single list keyed by lookup_key. Caching/TTL/fallback rules per §4 above. (Implementation lands in MYT-42; spec text updates here.)
- §9 balance-response example (line ~439) — update `"tier": "adventurer"` to `"tier": "wayfarer"` (or rename the field to `lookup_key` for consistency with the rest of MYT-41's contract).
- §9 checkout body shape (line ~426): `{ type: 'subscription', tierId }` / `{ type: 'pack', packId }` — replace with `{ items: [{ lookup_key, quantity }] }`. The Checkout `mode` is server-derived from the items' types per the cart-shapes table.
- §9 ALTER block (line ~459) — `ALTER TABLE users ADD COLUMN stripe_customer_id` is stale. The column already exists in migration 001. Replace with: *"`users.stripe_customer_id` is part of the initial schema. Populated lazily on first checkout via `customers.create` in MYT-42."*

### `docs/specs/2026-04-13-backend-core.md` — Schema reference + repo namespace cleanup

The Backend Core spec (the canonical schema reference per CLAUDE.md's read-in-dependency-order) carries CREATE TABLE blocks AND `repo.*` namespace listings that migration 006 invalidates. Patch:

**Schema blocks:**
- Remove the `subscription_tiers` CREATE TABLE block (~line 559) and replace with a one-line pointer: *"Subscription tier metadata is in `backend/src/billing/lookup-keys.ts`; Stripe is the source of truth for prices."*
- Remove the `session_packs` CREATE TABLE block (~line 586) and replace similarly: *"À-la-carte SKU metadata is in `backend/src/billing/lookup-keys.ts`."*
- Update the `user_subscriptions` CREATE TABLE block (~line 572) — `tier_id TEXT NOT NULL REFERENCES subscription_tiers(id)` becomes `tier_lookup_key TEXT NOT NULL` (no FK; the lookup-keys contract enforces the closed enum at write-time via MYT-42's webhook handler, which only writes from `LOOKUP_KEYS`). Note that MYT-42 ships migration 007 with this new shape.
- Update the `purchases` CREATE TABLE block — same pattern: drop the `session_pack_size INTEGER` column or any pack reference, store `lookup_key TEXT NOT NULL` instead.

**Repo namespace listings (~line 800–810) and `repo-deferred` table (~line 842):**
- Remove `repo.subscriptionTiers` and `repo.sessionPacks` namespaces entirely — those tables don't exist post-migration-006, and lookup-keys.ts is the contract surface.
- Update the `repo-deferred` table to drop `subscriptionTiers` and `sessionPacks` from the deferral list. `purchases` and `userSubscriptions` stay deferred to MYT-42 (re-shaped, not removed).
- Run `bd list --label=repo-deferred` and verify no other bead references the dropped namespaces; close or rescope any matches.

### `docs/specs/2026-04-06-production-architecture-overview.md` (orphan-reference cleanup)

- Line 768's `pack_5` reference → update to `sku_session` / `sku_world`.
- Line ~380's `purchases` CREATE TABLE block carries stale `session_pack_size INTEGER NOT NULL` → drop the column reference or rewrite the block to point to backend-core's canonical schema.
- Lines ~551, ~575–577, ~749, ~769 reference a `users.session_credits` column or a `free_trial_used = false` gate — both stale per MYT-40 (credits live in `credit_ledger`, balance is `SUM(amount)` filtered by `credit_type` and `expires_at`) and per MYT-41 (the trial is a `credit_ledger` row with `source_type='trial'`, not a column-flip gate). Sweep these references and replace with: "balance check is `SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id=$1 AND credit_type='session' AND (expires_at IS NULL OR expires_at > now())`; trial credits are part of that balance, not a separate gate."
- Line ~515 ER-diagram-style line `User ──has──> session_credits, purchases` — drop the `session_credits` half.

### `docs/specs/2026-04-10-ux-design.md` (orphan-reference cleanup)

- Line 490's `Adventurer` / `Champion` mentions → update to `Wayfarer` / `Sojourner` / `Mythwright`.

### Note on parent-spec line numbers

Cited line numbers above are approximate (parent specs drift by 1–2 lines as edits land). Patch by section heading + content match, not by absolute line number.

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

**Happy path**

- All 5 lookup_keys returned with correct currency='usd', `unit_amount > 0`, `billing_scheme='per_unit'`, recurring tiers with `interval='month'`, `interval_count=1`, `usage_type='licensed'`, SKUs with `recurring=null` → probe resolves; logger emits `billing.probe_started` then `billing.probe_passed` (both with the same `bootId`).

**Contract mismatches (`BillingProbeError`)**

- Missing lookup_key → "not found in active Stripe prices" message.
- Type mismatch (tier_* returned as one-time) → type-mismatch message.
- Currency mismatch (`currency='eur'`) → currency message.
- `unit_amount = 0` → unit_amount message.
- `billing_scheme='tiered'` → billing_scheme message.
- `recurring.interval='year'` (tier) → interval message.
- `recurring.interval_count=3` (tier, monthly-but-quarterly) → interval_count message.
- `recurring.usage_type='metered'` (tier) → usage_type message.
- Duplicate lookup_keys (two active prices share `lookup_key='tier_wayfarer'`) → duplicate-detection message; **not silent last-wins**.
- Multiple mismatches across keys → all reported in a single `BillingProbeError.mismatches` array (no short-circuit).

**Auth / permission errors (`BillingProbeAuthError`, no retry)**

- `Stripe.errors.StripeAuthenticationError` (401) → fail-fast `BillingProbeAuthError`. Logger emits `billing.probe_auth_failed`. **No retry** — `prices.list` mock called exactly once.
- `Stripe.errors.StripePermissionError` (403, restricted-key missing `Prices: read`) → same fail-fast path.

**Stripe API contract change (`BillingProbeStripeAPIChangeError`)**

- Mock returns `has_more: true` on the lookup_keys-bounded query → `BillingProbeStripeAPIChangeError`. (Realistically unreachable today, but defensive against future Stripe API changes.)

**Transient errors (`BillingProbeTransientError`, retry with backoff)**

- Mock throws `Stripe.errors.StripeAPIError` twice, succeeds on third → probe resolves; logger emits `billing.probe_transient_retry` twice (each with the same `bootId`) and `billing.probe_passed` once.
- Mock throws on all 3 attempts → `BillingProbeTransientError` with `attempts=3`; logger emits `billing.probe_transient_failed`.

**Logging / observability**

- Every event emitted by a single boot probe carries the same `bootId` (UUID). Tests assert correlation by capturing logger calls and matching the field across event types.

**Module-load guard**

- `LOOKUP_KEYS` size > 100 — out of scope for runtime test (the constant is checked at module load), but a static type test or a cheap unit test should assert `Object.keys(LOOKUP_KEYS).length <= 100`.

### ESLint rule tests — `backend/eslint-rules/__tests__/no-stripe-price-mutations.test.cjs`

Use ESLint's `RuleTester`. Banned cases (rule diagnostic):

- `stripe.prices.create({...})`, `stripe.prices.update(id, {...})`, `stripe.prices.update(id, { active: false })` (archival idiom)
- `stripe.products.create({...})`, `stripe.products.update(id, {...})`, `stripe.products.del(id)`
- `stripe.coupons.create({...})`, `stripe.coupons.update(id, {...})`, `stripe.coupons.del(id)`
- `stripe.promotionCodes.create({...})`, `stripe.promotionCodes.update(id, {...})`

Allowed cases (no diagnostic):

- `stripe.prices.list({...})`, `stripe.prices.retrieve(id)`
- `stripe.products.retrieve(id)`
- `stripe.subscriptions.update(id, { cancel_at_period_end: true })` — explicitly allowed (cancel-from-app)
- `stripe.subscriptions.update(id, { metadata: {...} })` — allowed
- `stripe.subscriptions.update(id, { pause_collection: {...} })` — allowed
- `stripe.subscriptions.cancel(id)` — explicitly allowed (admin fraud cancel)
- `stripe.checkout.sessions.create({...})`
- `stripe.billingPortal.sessions.create({...})`
- `stripe.webhooks.constructEvent(...)`
- `stripe.customers.create|retrieve|update`

### Subscription-price-mutation rule — `backend/eslint-rules/__tests__/no-stripe-subscription-price-mutation.test.cjs`

Banned cases (rule diagnostic):

- `stripe.subscriptions.update(id, { items: [{ id: 'si_x', price: 'price_NEW' }] })`
- `stripe.subscriptions.update(id, { items: [{ price: someVar }] })` (any price-field expression in items)
- `stripe.subscriptions.update(id, { items: [{ price: lookupKeyToPrice() }] })` (even via function call — the rule is structural, not value-aware)

Allowed cases (no diagnostic):

- `stripe.subscriptions.update(id, { items: [{ quantity: 2 }] })` — quantity-only update is fine
- `stripe.subscriptions.update(id, { cancel_at_period_end: true })` — no items field
- `stripe.subscriptions.update(id, { metadata: {...} })` — no items field

### Config-wiring smoke test — `backend/eslint-rules/__tests__/config-wiring.test.cjs`

A separate test that runs `pnpm exec eslint <fixture>` against a fixture file containing a banned pattern (e.g., `backend/eslint-rules/__tests__/fixtures/banned.fixture.ts` with `stripe.prices.create({})`). Asserts the lint command exits non-zero. **This catches the failure mode "rule is shipped but not registered in `eslint.config.js`"** — `RuleTester` exercises the rule logic directly, but doesn't verify the rule is wired into the project. Without this smoke test, an ESLint flat-config refactor that drops the registration would silently pass CI.

### Webhook route-absence test — `backend/src/__tests__/webhook-absence.test.ts`

A small unit test that asserts `app.routes` (or equivalent Fastify v5 inspection) does NOT contain a route resolving `/webhooks/stripe`. Per §5a, the fail-closed-on-PLACEHOLDER security argument depends on the route being absent until MYT-42 lands the verifying handler. The test fails CI if any future PR registers the route prematurely. MYT-42 deletes this test as part of landing the real handler. Trivial; durable; closes the "manual app.routes check at MYT-41 close" gap.

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
- `backend/src/billing/probe.ts` — boot probe with retry/backoff/jitter; auth-error vs transient-vs-mismatch distinction; full billing-shape verification (currency, type, unit_amount > 0, billing_scheme, interval, interval_count, usage_type); duplicate-detect; `has_more` API-change detection; bootId-correlated structured events.
- `backend/eslint-rules/no-stripe-price-mutations.cjs` — bans price/product/coupon catalog mutations.
- `backend/eslint-rules/no-stripe-subscription-price-mutation.cjs` — bans `subscriptions.update({ items: [{ price }] })` patterns; closes the price-change-via-subscription backdoor.
- ESLint config wiring + a fixture-based smoke test that catches "rule shipped but not registered."
- `backend/migrations/006_drop_billing_config_tables.sql` — pre-drop emptiness ASSERT; drops `user_subscriptions`, `purchases`, `session_packs`, `subscription_tiers` in FK-correct order.
- Tests for all of the above.
- Updates: `backend/src/server.ts` (call probe at boot), `backend/src/db/__tests__/migrate-schema.test.ts` (full enumeration update — tables + indexes + checks + FKs), `backend/src/repo/__tests__/_helpers/reset-data.ts` (drop the four dropped tables from the truncate list).
- Spec patches: `docs/specs/2026-04-13-billing-cost-controls.md` §3 + §4 + §5 + §7 + §9 + §10; `docs/specs/2026-04-13-backend-core.md` schema-block cleanup; cross-spec orphan refs in `2026-04-06-production-architecture-overview.md` and `2026-04-10-ux-design.md`.
- Hand-off: `tmp/myt-41-stripe-dashboard-instructions.md` for Miklos to execute (front-loaded: restricted-key creation + product/price creation + Customer Portal config happen BEFORE code lands).
- Bead `myth-u7k` re-scoping (drop `subscriptionTiers`/`sessionPacks` namespaces; re-scope `purchases`/`userSubscriptions` to MYT-42).
- **Hard-blocking precondition for production-launch readiness:** bead `myth-billing-probe-alarm` — CloudWatch metric filters + alarms on `billing.probe_failed`, `billing.probe_auth_failed`, `billing.probe_transient_failed`, all paged to the same destination as other prod alarms. Owner: Miklos. Target completion: within 1 cycle of MYT-41 close. **Mythrun does not promote to production-launch readiness until this alarm is live.** Per the §3 "Stripe-availability ceiling" analysis, the fail-loud-on-Stripe-outage tradeoff is only safe if the operator hears about Stripe degradation immediately. (Note on implementation: missing-`probe_passed`-after-`probe_started` is a sliding-window detection that requires Lambda or metric math; the simpler-and-sufficient version is the three failure-event alarms.)

## What MYT-41 does NOT ship

- Backend Stripe runtime code (checkout endpoints, webhook handler) → MYT-42
- Per-session metering and budget enforcement → MYT-43
- Real production prices → launch readiness
- Wiki runbook (deferred to end-of-issue close per workflow)
