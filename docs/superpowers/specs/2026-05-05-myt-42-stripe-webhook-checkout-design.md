# MYT-42 — Stripe webhook + checkout endpoints (design)

**Status:** ready for implementation
**Spec authored:** 2026-05-05
**Builds on:** `docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md` and the patches it landed in `docs/specs/2026-04-13-billing-cost-controls.md` §3, §4, §5, §7, §9, §10.

---

## 1. Goal

Land the routes and the webhook that turn Stripe payments into credits in the ledger.

MYT-41 left the codebase with: a closed `LOOKUP_KEYS` contract, a boot probe that verifies Stripe matches it, ESLint tripwires against price mutations, an env-validated restricted key, and migration 006 that dropped the legacy billing-config tables. No money flows yet — there is no checkout endpoint, no webhook handler, and no credit grant on purchase.

MYT-42 closes the loop:
1. Seven user-facing HTTP routes under `/api/billing/*` plus a public webhook at `/webhooks/stripe`.
2. A webhook handler that verifies Stripe signatures, dedupes on event ID, and writes credit grants into `credit_ledger` inside a single Postgres transaction per event.
3. Migration 007 that creates `purchases`, `user_subscriptions`, and `billing_history` with the new lookup_key shape.
4. Repo namespaces for `purchases`, `userSubscriptions`, `stripeEvents`, `billingHistory`, plus `users.findOrCreateStripeCustomer`.
5. A trial-credit grant emitted at registration through `repo.credits.grant` inside a transaction that also creates the `users` row.
6. The `source_type='trial'` marker on the trial grant ledger row is the signal MYT-43 will read; **MYT-42 does NOT extend `atomicDebit`** — that recipe extension was moved to MYT-43 in round 1 of this spec's review (Florin C2 / Sestertius C1: MYT-40's recipe is balance-based, not row-traversal-based; exposing `consumedSourceType` requires a recipe redesign, which belongs to MYT-43 alongside the consumption-priority decision).

After this issue, a user can register, get a free trial credit, click Buy, complete Stripe Checkout, and see credits appear in their balance. They can manage their subscription via the Customer Portal that MYT-41 already configured.

## 2. Non-goals

- The session runtime's trial-mode limits (reduced budget, demo world, time cap) — MYT-43 owns those, reading the trial signal via `credit_ledger.source_type='trial'` on the consumed row.
- The `atomicDebit` recipe extension to RETURN consumed `source_type` — moved to MYT-43 (see §1.6 — MYT-40's recipe is balance-based; exposing per-row consumption requires a recipe redesign that belongs alongside MYT-43's consumption-priority decision).
- Webhook secret rolling-rotation procedure — manual ops; runbook follow-up.
- Per-event-type webhook handler modules — single orchestrator suffices at 6 events.
- `stripe_customer_id` backfill for users created before MYT-42 — lazy-create-on-first-use covers all paths going forward.
- Subscription pause/resume — out of Customer Portal allowlist per MYT-41.
- Dunning event variants (`invoice.payment_failed`, etc.) — log-and-ignore for now, follow-up bead.
- **Partial refunds** — full clawback only at launch (decision 5 of round-2 review). Webhook handler asserts `charge.amount_refunded === charge.amount_captured` before clawing back; mismatch pages a `billing.partial_refund_unsupported` alarm and skips clawback. Operator workflow: refund full charges only; partial refunds require manual reconciliation. Partial-refund implementation is a follow-up bead.
- **Non-card / non-Link payment methods** (ACH, SEPA, BNPL, Cash App Pay, Amazon Pay, etc.) — out of scope at launch (decision 3 of round-2 review). Mythrun's launch market is US/card-first. Checkout Sessions pin `payment_method_types: ['card', 'link']`; account-level Payment Methods config disables everything else. Apple Pay and Google Pay come along automatically as wallet wrappers over `card`. International expansion + delayed-confirm support is a follow-up bead with concrete event-handler additions (`checkout.session.async_payment_succeeded`, `_failed`, plus `purchases.status='pending_settlement'` state).
- A frontend pricing page or Buy button — backend-only; frontend lives in a later milestone.
- Frontend "Upgrade tier" UI — required for the custom upgrade endpoint per §4.6; deferred to the frontend milestone. The MYT-42 backend endpoint ships and is callable from any frontend that pulls together the appropriate request body.

## 3. Architecture overview

```
                     ┌──────────────────────────┐
   POST /api/users/  │ register (MYT-38, ext'd) │
   register          │  + trial credit insert   │
                     └──────────────────────────┘

   GET  /api/billing/skus            ──► public, served from boot-cache populated by MYT-41 probe
   GET  /api/billing/balance         ──► JWT, reads credit_ledger + user_subscriptions
   POST /api/billing/checkout        ──► JWT, creates Stripe Checkout Session (initial subscription / à-la-carte)
   POST /api/billing/upgrade-tier    ──► JWT, executes a tier upgrade via subscriptions.update +
                                          proration_date=current_period_start + proration_behavior='always_invoice'
   POST /api/billing/portal          ──► JWT, creates Customer Portal Session (downgrades + cancel + payment-method update)
   GET  /api/billing/history         ──► JWT, cursor-paginated (purchases ∪ invoices ∪ refunds)
   GET  /api/billing/subscription    ──► JWT, single active sub or null

   POST /webhooks/stripe             ──► public, Stripe-signed (encapsulated raw-body parser),
                                          dispatch table → per-event-type handler,
                                          single Postgres tx per event with
                                          stripe_events.event_id PK idempotency
```

New backend files:
- `backend/src/routes/billing.ts` — the 7 user-facing routes (skus, balance, checkout, upgrade-tier, portal, history, subscription).
- `backend/src/routes/webhook.ts` — `POST /webhooks/stripe` route in its own encapsulated plugin, raw-body parser scoped to that plugin, signature verification, dispatch into orchestrator.
- `backend/src/billing/webhook.ts` — orchestrator + per-event-type handler functions.
- `backend/src/billing/customer.ts` — `findOrCreateStripeCustomer(tx, userId)` helper used by both checkout and portal.
- `backend/src/billing/upgrade.ts` — tier-upgrade implementation (validates monotonic upgrade, calls `subscriptions.update` with `proration_date` set to the current period start, `proration_behavior: 'always_invoice'`); the resulting `invoice.paid` is processed by the same webhook handler that handles renewals.
- `backend/src/billing/sku-cache.ts` — boot-time cache of `LOOKUP_KEYS` + Stripe price snapshot, populated immediately after the probe passes. Exposes forward (`lookup_key → SkuInternalEntry`) and reverse (`stripe_price_id → SkuInternalEntry`) lookups for webhook handlers, plus a `publicListing: SkuPublicListing[]` view for the public route response. The reverse map is required because Stripe at API version `2026-04-22.dahlia` returns price IDs (not lookup keys) on `InvoiceLineItem.pricing.price_details.price`. The two types (internal vs public) are split so the public endpoint cannot accidentally leak `stripe_price_id` (per Stilton I7 round 3).
- `backend/src/billing/errors.ts` — `BillingErrorCode` union type (closed enum of all 4xx codes any billing route can return).
- `backend/src/repo/purchases.ts`, `backend/src/repo/user-subscriptions.ts`, `backend/src/repo/stripe-events.ts`, `backend/src/repo/billing-history.ts` — four new namespaces.

Patches:
- `backend/src/repo/users.ts` — `findOrCreateStripeCustomer(tx, userId)` (FOR-UPDATE lock + lazy-create); **`create(tx, ...)` refactored to accept a `ClientLike` transaction handle** so the trial-credit grant can ride in the same BEGIN. Round 1 / round 2 of this spec's review (Florin I4 / Hydra C1 / Ducat I6 / Sphinx I2) flagged this as a real refactor, not a type-annotation change.
- `backend/src/repo/credits.ts` — extract a `grantInTx(client, input)` helper that runs ONLY the INSERT (no own BEGIN/COMMIT, no own connection acquisition); the existing `grant(input)` becomes a thin wrapper that opens a tx and delegates to `grantInTx`. Add a new method `recordClawback(client, input)` that writes negative-polarity rows (`source_type='debit'`, `amount < 0`) for refund clawbacks — this is the ONLY entrypoint that may write a debit row to credit_ledger outside `atomicDebit`. **No change to `atomicDebit`** — that recipe extension was deferred to MYT-43 in round 1 of this spec's review.
- `backend/src/routes/users.ts` (MYT-38's register handler) — refactored to open `BEGIN`/`COMMIT` explicitly, call `users.create(client, ...)` + `repo.credits.grantInTx(client, ...)` + `UPDATE users SET free_trial_used = true` + read-back the row for the response shape. **`classifyProfanity` LLM calls remain BEFORE `BEGIN`** (per Sphinx I2 round 2: a 200–800ms LLM call inside a transaction holds a `PoolClient` open and is a DoS amplifier on a `max=10` pool).
- `backend/src/billing/probe.ts` — populate `sku-cache` immediately after a successful probe (cheap; same data already fetched). Add a Customer Portal config probe step that asserts `proration_behavior='create_prorations'` AND `schedule_at_period_end.conditions` contains `{type:'decreasing_item_amount'}` AND the per-tier `subscription_update.products` allowlists are downgrade-only. Defense-in-depth against Dashboard config drift.
- `backend/src/auth/require-onboarded.ts` — extend the boot-time allowlist mechanism to include a `PUBLIC_ROUTE_ALLOWLIST` (parallel to the existing `JWT_NO_DB_ALLOWLIST`) enforced at boot time. The closed allowlist enumerates EVERY existing route carrying `config: { auth: 'public' }` plus the two new MYT-42 additions:
  - `GET /health` (existing — liveness check)
  - `GET /health/ready` (existing — readiness check)
  - `GET /api/invites/:inviteCode/preview` (existing — MYT-39 invite preview, per Stilton C2 round 3)
  - `GET /api/billing/skus` (new — public pricing-page endpoint)
  - `POST /webhooks/stripe` (new — Stripe-signature-authed)
  
  Adding any new `auth: 'public'` route requires extending this list AND a security review on the PR. Per Sphinx C3 round 2 + Stilton C2 round 3: closes the defense-in-depth gap where a future implementer marking the wrong route public ships silently. The implementation plan for MYT-42 includes an audit step that greps the codebase for `auth: 'public'` registrations and asserts the allowlist is exhaustive before enabling boot-time enforcement (otherwise enabling enforcement breaks the existing invites-preview path).

  **Enforcement mechanism** (per Ephesus C3 round 6 — recurring across rounds 4/5/6, pinning here so implementer doesn't have to derive it). The check is wired as a top-level Fastify `onRoute` hook registered on the root `app` instance BEFORE any `app.register(...)` call:

  ```ts
  // backend/src/auth/public-route-allowlist.ts
  export const PUBLIC_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
    'GET /health',
    'GET /health/ready',
    'GET /api/invites/:inviteCode/preview',
    'GET /api/billing/skus',
    'POST /webhooks/stripe',
  ])

  // backend/src/app.ts — registered BEFORE any app.register() call so it sees
  // every subsequent route registration in every encapsulated child plugin.
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.config?.auth !== 'public') return  // routes without auth: 'public' are unaffected
    const key = `${routeOptions.method} ${routeOptions.url}`
    if (!PUBLIC_ROUTE_ALLOWLIST.has(key)) {
      throw new Error(`auth: public used on non-allowlisted route: ${key}`)
    }
  })
  ```

  Comparison key: the literal `${METHOD} ${URL}` string with parametric placeholders preserved (`:inviteCode` is matched verbatim, NOT substituted). Routes with no `config.auth` (the JWT-default path) are silently skipped — the hook only flags routes that explicitly declared `auth: 'public'`. The hook fires synchronously during plugin registration; `await app.ready()` propagates the throw, aborting boot before `app.listen()`. The §13 test asserts both directions: (a) registering an allowlisted public route succeeds; (b) registering a non-allowlisted public route causes `await app.ready()` to reject with the documented error message.

  Type augmentation for `config.auth` typo-safety:

  ```ts
  // backend/src/types/fastify.d.ts
  declare module 'fastify' {
    interface FastifyContextConfig {
      auth?: 'public' | 'jwt'
    }
  }
  ```

  This makes `config: { auth: 'pubic' }` (typo) a TypeScript compile error rather than a silent JWT-required fallback.
- `backend/src/server.ts` / `backend/src/app.ts` — wire the new route plugins.

### 3.1 Stripe API at dahlia — load-bearing field-shape notes

The MYT-41 spec pinned `STRIPE_API_VERSION = '2026-04-22.dahlia'`. Several Subscription / Invoice / Checkout fields the implementer might assume from older docs are NOT at the same paths in dahlia. Round 1 of this spec's review (Reviewer-Doubloon C1/C2/C3) flagged three concrete shape changes; record them here so the rest of the spec's references stay consistent:

1. **Subscription period dates** live on `subscription.items.data[i].current_period_start` and `…current_period_end`. They were removed from the top-level `Subscription` object in API version `2025-03-31.basil` and replaced with per-item period dates. Mythrun enforces single-item subscriptions at the cart-shape rule (§4.2), so `subscription.items.data[0]` is the canonical read site. Add a runtime guard that asserts `subscription.items.data.length === 1` and aborts loudly on any other count (defends against a Customer Portal misconfiguration that adds a second item).

2. **Invoice line price identification** comes from `line.pricing.price_details.price` (a price ID string, e.g. `price_xxx`). The previous `line.price.lookup_key` field was removed in `2025-03-31.basil`. Webhook handlers walking `invoice.lines.data` MUST resolve the line's lookup_key by reverse-lookup against the SKU cache (§10), NOT by reading `line.price.lookup_key`.

3. **Checkout Session line items** are NEVER present in the `checkout.session.completed` event payload at dahlia. The handler MUST always retrieve them via `stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price'] })` inside the webhook transaction. Stripe Checkout Session line items are immutable post-completion, so the retrieve is deterministic on retry — safe inside the tx.

4. **`event.data.object.customer`** is a string (the customer ID `cus_*`), not a `Customer` object, on subscription / invoice / charge events. Read it as a string. Resolve via `users.stripe_customer_id` lookup; on miss, fall back to `subscription.metadata.userId` (a UUID string set at Checkout Session creation in §4.3) before logging + 200.

5. **`event.api_version`** carries the Dashboard webhook endpoint's configured API version, NOT the SDK's pin. Dashboard webhook configuration MUST set API version to `2026-04-22.dahlia` (§15 step 1). The handler asserts `event.api_version === STRIPE_API_VERSION` at dispatch time and logs a loud error on mismatch (silent corruption of typed field access otherwise).

6. **`Charge.invoice` was REMOVED at `2025-03-31.basil`** (per Carthage C1 round 4). The Charge object no longer carries an `invoice` linkage. Resolution direction inverts: to find the Invoice from a PaymentIntent or Charge, query `stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: pi_id } })` and read the resulting `invoice` field. Affects: `charge.refunded` handler's subscription-refund resolution path (§5.4.5 step 1) — see the prefetch-shape update below.

7. **`Invoice.subscription` was REMOVED at `2025-03-31.basil`** (per Carthage C2 round 4) along with `Invoice.subscription_details` and `Invoice.subscription_proration_date`. The replacement is `invoice.parent.subscription_details.subscription` (after asserting `invoice.parent.type === 'subscription_details'`). **`Invoice.parent` is documented nullable** (per Carthage C3 round 6 — admin-issued / manual standalone invoices have `parent === null`); every dereference path MUST optional-chain. Affects: `invoice.paid` handler's subscription resolution path (§5.4.2, §5.3 prefetch shape).

8. **Subscribe to `refund.created` AND `refund.updated`** (per Carthage C3 / Persepolis C3 round 4 + Carthage C1 round 6): `event.data.object` on `charge.refunded` was the Charge, not the Refund — the handler had no canonical way to identify which `re_*` ID just landed. Subscribing to `refund.created` gives `event.data.object.id === re_*` directly, and `event.data.object.payment_intent` / `event.data.object.charge` are top-level strings. **However**, card refunds flow through dahlia status transitions: `pending` → `succeeded` (typical async path for some non-US card networks) and `succeeded` → `failed` (issuer rejects after Stripe re-credits the merchant). Per Carthage C1 round 6, the launch design therefore subscribes to BOTH `refund.created` and `refund.updated` and gates clawback strictly on `event.data.object.status === 'succeeded'`. The pending → failed path produces no clawback (status was never `succeeded` at our handler entry); the succeeded → failed path is documented as a known launch gap (rare, requires manual operator reconciliation — follow-up bead). `refund.failed` is NOT subscribed at launch because the only path that requires reversal (succeeded → failed, where we already clawed back) is rare enough to handle via runbook. Decision 5's full-refund-only invariant is preserved; partial-refund support remains a follow-up bead.

These notes are referenced by §5.4.1, §5.4.2, §5.4.3, §5.4.5, and §15. Implementers should re-read the dahlia API reference for any field not explicitly listed in this spec rather than assume older shapes.

## 4. Routes

### 4.1 Body shapes + auth

| Route | Auth | Body | Returns |
|---|---|---|---|
| `GET /api/billing/skus` | public (`config: { auth: 'public' }`) | — | `[{ lookup_key, displayName, type, sessionsGranted, worldsGranted, price: { unit_amount_cents, currency } }]` |
| `GET /api/billing/balance` | JWT | — | `{ balance: { session, world_gen }, tier: { lookup_key, displayName, renewsAt, cancelAtPeriodEnd } \| null }` |
| `POST /api/billing/checkout` | JWT | `{ items: [{ lookup_key, quantity }] }` | `{ checkoutUrl }` |
| `POST /api/billing/upgrade-tier` | JWT | `{ target_tier_lookup_key }` | `{ invoice_id, amount_paid_cents }` |
| `POST /api/billing/portal` | JWT | — | `{ portalUrl }` |
| `GET /api/billing/history?cursor=<token>` | JWT | — | `{ events: [{ kind: 'purchase'\|'invoice'\|'refund', id, occurredAt, amount_cents, currency, lookup_key?, status }], nextCursor: string \| null }` |
| `GET /api/billing/subscription` | JWT | — | The user's full `user_subscriptions` row enriched with `displayName`, or `null` |
| `POST /webhooks/stripe` | public | raw body (preserved via encapsulated `addContentTypeParser`) | `200 { received: true }` on success / 400 on signature mismatch |

**Error envelope:** every 4xx response from these routes uses the shape `{ code: 'snake_case_string', ...optional_detail }`. The closed set of codes lives in `backend/src/billing/errors.ts` exporting a `BillingErrorCode` union. The webhook route (`POST /webhooks/stripe`) follows the same envelope for `400 { code: 'missing_signature' }` / `{ code: 'invalid_signature' }`.

**History pagination.** Page size: 50. Cursor wire format: `cursor = base64url(JSON.stringify({ t: occurred_at_iso, i: id }))` — encodes the `(occurredAt, id)` of the **last row of the current page**. The next page is `WHERE (occurred_at, id) < (cursor.t, cursor.i)` ordered `occurred_at DESC, id DESC`. `id` is `billing_history.id UUID` (UUIDv7), unique table-wide so ties at the page boundary resolve deterministically. Cursor-based not offset because invoices, purchases, and refunds interleave by time and offset is an N+1 hazard at the DB layer.

### 4.2 Cart validation (`POST /api/billing/checkout`)

Body Zod schema:
```
items: array.min(1).max(100)
  .each({ lookup_key: enum(LOOKUP_KEYS), quantity: int.min(1).max(100) })
```

After Zod, server-enforced rules:
1. Every `lookup_key` MUST be in the `LOOKUP_KEYS` closed enum (Zod handles this; mentioned for clarity).
2. If ANY item has `type === 'recurring'` (a tier): `items.length === 1` AND `items[0].quantity === 1`. Otherwise → 400 `{ code: 'tier_cart_shape' }`.
3. If ALL items have `type === 'one_time'`: any combination + any quantity ≤ 100 allowed.
4. Mixed cart (tier + à-la-carte) → 400 `{ code: 'mixed_cart' }`. Stripe Checkout mode is single-valued; mixing modes isn't representable.
5. **Duplicate `lookup_key` in the same cart** (multiple `items[]` entries sharing a key) → 400 `{ code: 'duplicate_lookup_key' }`. Clients sum quantities client-side; the server treats duplicates as a programming error and refuses to coalesce.

Server-derived `mode`: `'subscription'` if any tier present, else `'payment'`.

### 4.3 Stripe Checkout Session creation

```
{
  mode: <derived>,
  payment_method_types: ['card', 'link'],  // decision 3 of round-2 review: card-only (Apple Pay / Google Pay come along automatically as wallet wrappers); Link is Stripe's saved-card SSO and is card-equivalent for settlement
  line_items: <items resolved via SKU cache to { price: <price_id>, quantity }>,
  customer: <findOrCreateStripeCustomer(tx, userId)>,
  metadata: { userId },
  success_url: `${env.frontendBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${env.frontendBaseUrl}/billing/cancel`,
  // mode='subscription' only:
  subscription_data: { metadata: { userId } },  // belt + suspenders fallback for customer-id misses on .subscription.* events
}
```

`payment_method_types: ['card', 'link']` is the runtime-enforced lock. A second defense layer lives at the Stripe Account-level Payment Methods config (Dashboard → Settings → Payment Methods), where Card + Link are enabled and everything else is disabled (per §15 runbook step). Apple Pay and Google Pay are wallet wrappers over `'card'` — they appear automatically on supported devices when `'card'` is in the list, no enum entry required. Stripe Checkout's hosted page handles Apple Pay domain verification automatically (we're served from `checkout.stripe.com`).

`subscription_data.metadata.userId` is a fallback signal: webhook handlers (§5.4.3 / §5.4.4) resolve user via `event.data.object.customer` (the `cus_*` string) → `users.stripe_customer_id`. If that lookup misses (a Stripe-side delivery race; should be unreachable in practice because `findOrCreateStripeCustomer` writes `users.stripe_customer_id` synchronously before checkout-session-create returns), handlers fall back to `subscription.metadata.userId` before logging + 200.

The `findOrCreateStripeCustomer(tx, userId)` call lives BEFORE the `checkout.sessions.create` call in the request handler, both running outside any DB transaction (the customer-create path takes its own short tx with `SELECT … FOR UPDATE` per §9). Stripe API calls are not held inside webhook transactions — see §5.3 for the prefetch-then-write split.

### 4.4 Customer Portal creation (`POST /api/billing/portal`)

```
stripe.billingPortal.sessions.create({
  customer: <findOrCreateStripeCustomer(userId)>,
  return_url: `${env.frontendBaseUrl}/account`,
})
```

Lazy-creates the customer if the user has never checked out — this lets a freshly-registered user open the portal even though they have nothing to manage. The portal will show "no active subscription"; the user can leave or browse historical invoices (which there are none of). MYT-41 spec §8 originally proposed a `409 { code: 'no_billing_history' }` for this case to avoid an enumeration vector, but the lazy-create path is no worse: every call to this endpoint is JWT-authenticated and rate-limited, and `customers.create` is idempotent on the deterministic key, so an attacker authenticated as user X can't enumerate other users' Stripe records. The lazy-create wins on UX (no special-case 409 frontend handling) without weakening the boundary. This is a deliberate change from MYT-41 §8 — see §14 spec patches.

### 4.6 Tier upgrade endpoint (`POST /api/billing/upgrade-tier`)

Body Zod: `{ target_tier_lookup_key: enum(LOOKUP_KEYS where type === 'recurring') }`. Validation:

1. Caller is JWT-authenticated; resolve their active subscription via `repo.userSubscriptions.getActiveForUser(tx, userId)`. No active subscription → 400 `{ code: 'no_active_subscription' }`.
2. Compute current tier from `active_sub.tier_lookup_key`. Compute target tier from body. Both are in `LOOKUP_KEYS` (Zod enforced).
3. **Monotonic upgrade check**: target tier's `unit_amount_cents` (from SKU cache) MUST be strictly greater than current tier's. Equal → 400 `{ code: 'tier_unchanged' }`. Less → 400 `{ code: 'not_an_upgrade' }` (downgrades go through Customer Portal per Decision 2).

Implementation:

```ts
// All Stripe state needed up-front; no DB transaction held during the Stripe call.
const subscription = await stripe.subscriptions.retrieve(active_sub.stripe_subscription_id, {
  expand: ['items.data.price'],
})
const subscription_item_id = subscription.items.data[0].id
const period_start = subscription.items.data[0].current_period_start  // dahlia: per-item

// One Stripe call. Stripe computes proration_date == period_start ⇒ flat delta charge.
// proration_behavior='always_invoice' fires the proration invoice synchronously
// (instead of deferring it to the next renewal), and the invoice's default
// payment method (the user's saved card) is charged immediately.
const updated = await stripe.subscriptions.update(active_sub.stripe_subscription_id, {
  items: [{ id: subscription_item_id, price: target_price_id }],
  proration_date: period_start,
  proration_behavior: 'always_invoice',
})

// Find the just-created invoice. Stripe attaches it to the subscription's
// latest_invoice field synchronously when proration_behavior='always_invoice'.
const latest_invoice = await stripe.invoices.retrieve(updated.latest_invoice as string)
return reply.send({
  invoice_id: latest_invoice.id,
  amount_paid_cents: latest_invoice.amount_paid,
})
```

The webhook handler does the actual credit grant when `invoice.paid` arrives for this invoice — same code path as renewals (§5.4.2), with an explicit `billing_reason='subscription_update'` branch that recognizes the upgrade and grants the credit DELTA (not the full new tier).

**Credit-grant math at webhook time** (executed in §5.4.2 not here):
- Compute `target_spec = LOOKUP_KEYS[target_tier_lookup_key]`, `current_spec = LOOKUP_KEYS[old_tier_lookup_key]` (read from `user_subscriptions.tier_lookup_key` BEFORE the upsert applies the new tier — see §5.4.3 lock-acquisition order).
- Sessions delta = `target_spec.sessionsGranted - current_spec.sessionsGranted` (e.g. Wayfarer→Mythwright: 16 - 4 = 12).
- Worlds delta = `target_spec.worldsGranted - current_spec.worldsGranted` (Wayfarer→Mythwright: 4 - 1 = 3).
- `expires_at` = `current_period_end + tier_period_length` (i.e., the next-period-end after the upgrade — credits get a full period of life rather than the days remaining in the original period). For Mythrun's monthly tiers, that's `current_period_end + 30 days` rounded to Stripe's actual billing-cycle anchor at next renewal.
- Insert via `repo.credits.grantInTx(tx, ...)` with `source_type='subscription'`, `source_billing_history_id` linking to the billing_history row written for this invoice.

**Effective per-period cost over a Wayfarer→Mythwright upgrade on day 28 of the period** (sanity check):
- Day 1: $15 Wayfarer initial → 4 sessions, 1 world, expires day 30.
- Day 28: $30 upgrade delta (flat — Stripe's `proration_date=period_start` math) → 12 sessions, 3 worlds, expires day 60.
- Day 30: $45 Mythwright renewal → 16 sessions, 4 worlds, expires day 60.
- Total Days 1–60: $15 + $30 + $45 = $90. Compare to two full Mythwright periods: $45 + $45 = $90. Same.
- Total credits Days 1–60: 4 (Wayfarer, days 1–30) + 12 (upgrade-delta, days 28–60) + 16 (Mythwright period 2, days 30–60) = 32 sessions; 1 + 3 + 4 = 8 worlds. Same as two full Mythwright periods.

Not gameable — the user pays the same as if they'd subscribed to Mythwright from day 1.

**Why this can't go through Customer Portal Switch Plan**: Stripe's Customer Portal `proration_behavior='create_prorations'` is hard-coded to time-prorate the dollar charge. Setting `proration_date=current_period_start` requires a direct API call to `subscriptions.update` — Customer Portal doesn't expose that knob. So upgrades use this Mythrun-native endpoint; downgrades use Customer Portal Switch Plan (per Decision 2 of round-2 review). The asymmetry is by design.

### 4.5 SKU listing endpoint (`GET /api/billing/skus`)

Served from `sku-cache.ts` — a module-level frozen object populated immediately after a successful boot probe. The cache holds the same data the probe already fetched (`stripe.prices.list({ lookup_keys, expand: ['data.product'] })`), enriched with the `LOOKUP_KEYS` contract metadata (displayName, sessionsGranted, worldsGranted, type).

Cache is read-only after boot; refreshes only on next deploy (which re-runs the probe). Mythrun policy is "Stripe Dashboard is the source of truth, deploy releases pin to a probe-validated state" (MYT-41 spec §1) — prices changing without a deploy is a violation, so cache-on-boot is the right grain.

`SkuPublicListing` is a strictly public projection: the type EXPLICITLY excludes `stripe_price_id` and any user-/tenant-/environment-leaky fields. A typecheck assertion in §13 enforces this. Response sets `Cache-Control: public, max-age=300` (with `Vary: Authorization` defensive header) so CDN traffic doesn't hit the app process on burst loads. Per-IP rate limit `60/min` is added for symmetric DoS defense (the only public endpoint that lookups Stripe state).

If the SKU cache is empty (no probe pass yet — should be impossible because the probe gates boot), return 503. Defensive only.

## 5. Webhook handler

### 5.1 Route + raw-body parser

`POST /webhooks/stripe` lives in `backend/src/routes/webhook.ts`. It is **public** (`config: { auth: 'public' }`) — Stripe authenticates via signature, not JWT. The raw body parser is **encapsulation-scoped** because Fastify's default JSON parser would consume the bytes before `stripe.webhooks.constructEvent` can hash them. `addContentTypeParser` in Fastify v5 is encapsulation-scoped, NOT route-scoped — calling it on the top-level `app` makes it global and would break every other JSON route in the system. The parser must be registered inside a child plugin that registers only the webhook route:

```ts
// backend/src/routes/webhook.ts
export const webhookRoutes: FastifyPluginAsync = async (scope) => {
  // Per Stilton C1 round 3: Fastify v5 INHERITS the parent's default
  // 'application/json' parser into child encapsulation contexts. Calling
  // addContentTypeParser('application/json', ...) without first removing
  // the inherited default throws FST_ERR_CTP_ALREADY_PRESENT at app.ready().
  // Remove the inherited parser, then register the buffer-pass-through.
  scope.removeContentTypeParser('application/json')
  scope.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),  // pass-through; the route handler gets the Buffer
  )
  scope.post('/webhooks/stripe', { config: { auth: 'public' }, ...rateLimitConfig }, handler)
}

// backend/src/app.ts
await app.register(webhookRoutes)  // encapsulated; the parser does not leak to siblings
```

Inside the route handler, `request.body` is the raw `Buffer` produced by the encapsulated parser; bind it as `const rawBody = request.body as Buffer`. Stripe also sends `application/json; charset=utf-8` on some retries — Fastify matches the registered `application/json` against this with parameter-tolerance, but the regression test in §13 explicitly covers the charset-suffix variant.

The webhook route additionally carries `rateLimit: { max: 1500, timeWindow: '1 minute' }` (per-IP). Decision-justification: per Sphinx I4 round 2, Stripe's burst delivery rate during backlog drain (e.g., right after `STRIPE_WEBHOOK_SECRET` rotation per §15) is documented at up to ~25/sec = 1500/min. A lower cap throttles legitimate Stripe traffic into 429s and pushes events into ~3 days of exponential-backoff retries — the exact failure mode the rate limit is supposed to defend against. 1500/min is well above worst-case Stripe traffic; non-Stripe abuse traffic from a single IP at this rate is handled at the ALB / WAF layer, not here.

### 5.2 Signature verification

```ts
const sig = request.headers['stripe-signature']
if (!sig || typeof sig !== 'string') return reply.code(400).send({ code: 'missing_signature' })
let event: Stripe.Event
try {
  event = stripe.webhooks.constructEvent(rawBody, sig, env.stripeWebhookSecret)
} catch (err) {
  request.log.warn({ err }, 'stripe_webhook_signature_invalid')
  return reply.code(400).send({ code: 'invalid_signature' })
}
```

`env.stripeWebhookSecret = 'PLACEHOLDER'` (the MYT-41 → MYT-42 window value) **fails closed** here: `constructEvent` will reject every signature because the literal 'PLACEHOLDER' isn't a valid `whsec_*`. No bypass branch. The first action after MYT-42 ships is rotating Secrets Manager from PLACEHOLDER → the Dashboard-issued `whsec_*` (manual ops step in the runbook).

### 5.3 Idempotency + dispatch

Every event runs in a single Postgres transaction with explicit isolation parity (matches MYT-41's webhook-credit-grant contract and MYT-40's atomic-debit recipe):

```sql
BEGIN;
SET LOCAL transaction_isolation = 'read committed';
SET LOCAL lock_timeout = '1s';            -- per Camembert C2 round 3: matches MYT-40's discipline so
SET LOCAL statement_timeout = '5s';       -- a contended user-row lock can't pin a PoolClient indefinitely
-- Defense-in-depth: assert event.api_version matches the SDK's pin
-- (handler-side, not in SQL — see TS dispatch below).
INSERT INTO stripe_events (event_id, event_type, processed_at)
  VALUES ($1, $2, now())
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id;
-- empty result → duplicate; ROLLBACK and return 200
-- non-empty → continue with handler-specific writes
COMMIT;
```

`stripe_events` already exists from migration 001 with `event_id TEXT PRIMARY KEY`. First-write-wins. Stripe retries the same event ID on transient delivery failures; the second delivery hits the conflict and exits cleanly. **Note on rollback semantics:** any handler error inside the tx (CHECK violation, FK miss, etc.) rolls back the `stripe_events` row alongside the rest of the writes. This is the correct shape for *retryable* failures (transient DB error, momentary lock contention) — Stripe redelivers, the handler tries again. **It is NOT the right shape for non-retryable bugs**: a handler that always errors burns ~3 days of Stripe retries before delivery is given up, accumulating noise in logs. A future "poison-event escape" (record `last_error` + `attempts` in `stripe_events` and stop retrying after N failed attempts) is a follow-up bead.

**Stripe API calls are NOT held inside the webhook tx.** Per Chimera I2 / Hydra I2 / Sphinx M3 round 2, several handlers need to retrieve additional Stripe state (Checkout Session line_items, parent subscription on `invoice.paid`, parent invoice and subscription on `refund.created`). Holding the row-level lock on `stripe_events.event_id` across a Stripe network call (typical 100–500ms, tail latency multi-second under Stripe outage) compounds with MYT-40's `lock_timeout='1s'` discipline and produces confusing `DebitTimeoutError` cascades in unrelated user-facing paths. The handler structure is **prefetch-then-write**:

**This is the canonical dispatcher.** §5.3 contained TWO TS dispatcher blocks in earlier rounds; per Ephesus I2 / Petra C1 / Petra C2 round 5, the second block (which passed `(event, tx, stripe)` and lacked timeout SET LOCALs and the validation-failed sentinel) has been removed — the block below is the only dispatcher contract. Handlers receive `(event, prefetch, client)`; they NEVER receive the Stripe SDK; they MAY return `'validation_failed'` to signal "COMMIT the stripe_events row to suppress retries, but skip downstream writes."

```ts
type HandlerResult = 'ok' | 'validation_failed'
type EventHandler = (
  event: Stripe.Event,
  prefetch: unknown,
  client: ClientLike,
) => Promise<HandlerResult>

const HANDLERS: Record<KnownStripeEventType, EventHandler> = {
  'checkout.session.completed':     handleCheckoutCompleted,
  'invoice.paid':                   handleInvoicePaid,
  'customer.subscription.created':  handleSubscriptionUpsert,  // upsert-shaped; same handler as .updated
  'customer.subscription.updated':  handleSubscriptionUpsert,
  'customer.subscription.deleted':  handleSubscriptionDeleted,
  'refund.created':                 handleRefundEvent,
  'refund.updated':                 handleRefundEvent,
}
type KnownStripeEventType = keyof typeof HANDLERS

async function dispatchEvent(event: Stripe.Event, stripe: Stripe, pool: Pool, log: Logger) {
  // Defense-in-depth: assert the Dashboard webhook endpoint API version matches
  // the SDK's pin. Per Ephesus I3 / Carthage M4 round 5: a mismatch is fail-CLOSED
  // (skip handler invocation, COMMIT the stripe_events row to suppress retries,
  // page the operator). The earlier "log + continue" rule was inconsistent with
  // §3.1 notes 6/7/8 documenting BREAKING field-shape changes between API
  // versions — typed field access against the wrong version is silent corruption,
  // not graceful degrade.
  if (event.api_version !== STRIPE_API_VERSION) {
    log.error(
      { event_api_version: event.api_version, sdk_pin: STRIPE_API_VERSION, event_id: event.id },
      'stripe_webhook_api_version_mismatch',
    )
    // Best-effort: still record the event_id so Stripe stops retrying. If even
    // that fails (DB outage), the catch-block in the caller rolls back and
    // Stripe redelivers — which is the safe behavior in that case.
    const client = await pool.connect()
    try {
      await client.query("BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'")
      await stripeEvents.recordOrSkip(client, event.id, event.type)
      await client.query('COMMIT')
    } catch (err) { try { await client.query('ROLLBACK') } catch { /* connection dead */ } throw err }
    finally { client.release() }
    return  // do NOT invoke the handler; typed field access is unsafe
  }

  // Phase 1: prefetch all Stripe state needed for this handler. Outside any DB tx.
  // Idempotent on retry (Stripe Checkout Sessions, paid invoices, settled charges
  // are all immutable post-completion). Tail latency under Stripe outage just
  // delays our processing — it does NOT pin DB resources.
  const prefetch = await PREFETCHERS[event.type as KnownStripeEventType]?.(event, stripe)

  // Phase 2: open the DB tx with full timeout discipline (per Petra C1 round 5 —
  // matches MYT-40's `atomicDebit` recipe so a contended `users` row from a
  // concurrent session-debit can't pin the webhook PoolClient).
  const client = await pool.connect()
  try {
    await client.query("BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'")
    const inserted = await stripeEvents.recordOrSkip(client, event.id, event.type)
    if (inserted === 'duplicate') {
      await client.query('ROLLBACK')
      return
    }
    const handler = HANDLERS[event.type as KnownStripeEventType]
    if (!handler) {
      // Unknown event type: COMMIT the stripe_events row (records acknowledgement
      // so Stripe stops retrying) and exit cleanly.
      log.info({ event_type: event.type, event_id: event.id }, 'stripe_webhook_unknown_type')
      await client.query('COMMIT')
      return
    }
    // Per Petra C2 round 5: handler returns 'ok' (commit all writes) or
    // 'validation_failed' (commit ONLY the stripe_events row; the handler
    // is contractually required to have written nothing else when returning
    // the sentinel — §13 has a regression test asserting this).
    const result = await handler(event, prefetch, client)
    await client.query('COMMIT')
    if (result === 'validation_failed') {
      log.error({ event_id: event.id }, 'billing.handler_validation_failed_committed')
    }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* connection dead; pool will recycle */ }
    throw err  // caller (the route handler) returns 5xx so Stripe retries
  } finally {
    client.release()
  }
}
```

**Timeout discipline** (Petra C1 round 5): the three `SET LOCAL`s above are the same set MYT-40's `atomicDebit` uses — they MUST be applied at every webhook tx, not just the illustrative SQL block. Implementations that omit them lose the entire pool-protection invariant. Tests in §13 assert that a slow holder on `users.id` produces a typed lock timeout in ~1s (not the holder's full sleep duration).

**Validation-failed sentinel** (Petra C2 round 5): handlers that detect amount-validation failure (per cross-cutting rule 2 in §5.4) MUST return `'validation_failed'` rather than throw. Throwing rolls back `stripe_events` and Stripe redelivers indefinitely. Returning the sentinel commits the `stripe_events` row (suppresses retries) without any other writes. The §13 regression test injects an amount-mismatch on `checkout.session.completed` and asserts (a) no `purchases`/`credit_ledger`/`billing_history` rows landed, (b) `stripe_events` IS persisted, (c) replay of the same `event.id` is correctly skipped as duplicate.

**API-version mismatch is fail-closed** (Ephesus I3 / Carthage M4 round 5): the earlier "log + continue" path was inconsistent with §3.1's documentation of breaking field-shape changes between Stripe API versions. The dispatcher now skips handler invocation entirely on mismatch and commits only the `stripe_events` row — same shape as `'validation_failed'`. Paging-grade alarm fires; operator fixes the Dashboard endpoint API version.

The `PREFETCHERS` table mirrors `HANDLERS`: each event type optionally declares a prefetch function that returns whatever Stripe-side data the handler needs. Handlers receive that prefetch data as their second argument; they do not call Stripe themselves. Tests in §13 mock the Stripe client at the prefetch boundary (the handler's tx body never references it).

**Per-event prefetch shapes** (per Roquefort C2 round 3 + Carthage C1/C2 round 4 — pinning these against the actual dahlia field shapes):

- `checkout.session.completed`: `{ session: stripe.checkout.sessions.retrieve(session_id, { expand: ['line_items.data.price'] }) }`. The session.metadata.userId is on this object.
- `customer.subscription.created` / `customer.subscription.updated` / `customer.subscription.deleted`: no prefetch needed — the event payload IS the Subscription, with `subscription.metadata.userId` directly readable. Per §3.1 note 2: `subscription.items.data[i].price.lookup_key` IS still present at dahlia (the lookup_key removal applies only to `InvoiceLineItem`, not Subscription items).
- `invoice.paid`: read the parent subscription via `invoice.parent.subscription_details.subscription` (per §3.1 note 7 — `invoice.subscription` was removed at basil; `invoice.parent` itself is nullable per Carthage C3 round 6). The prefetch resolves the parent-subscription ID with full optional-chaining + type gate, returning `{ subscription: null }` for any non-subscription path so the handler can log+skip cleanly:

```ts
'invoice.paid': async (event, stripe) => {
  const invoice = event.data.object as Stripe.Invoice
  const parentSubId = invoice.parent?.type === 'subscription_details'
    ? invoice.parent.subscription_details?.subscription ?? null
    : null
  return {
    subscription: parentSubId
      ? await stripe.subscriptions.retrieve(parentSubId, { expand: ['items.data.price'] })
      : null,
  }
}
```

The §5.4.2 handler early-returns (log INFO `billing.invoice_non_subscription` + COMMIT `stripe_events` + 200, no credit grant) when `prefetch.subscription === null`. The handler's customer-id-miss fallback reads `prefetch.subscription.metadata.userId`, NOT `event.data.object.metadata.userId` (the latter is the Invoice's own metadata, which is empty for Checkout-driven subs).
- `refund.created` AND `refund.updated` (per §3.1 note 8 — both subscribed at launch; `refund.failed` deliberately not subscribed): `event.data.object` is the Refund directly. `event.data.object.id === re_*`. `event.data.object.payment_intent` and `event.data.object.charge` are top-level strings (both nullable; `refund.charge` may be missing for non-PI refund paths per Carthage I1 round 6). The handler gates clawback on `event.data.object.status === 'succeeded'` per Carthage C1 round 6 — `pending` / `requires_action` / `canceled` / `failed` paths log+commit+200 without clawback. Prefetch resolves the parent invoice for subscription-refund routing; à-la-carte refunds skip the invoice path entirely:

```ts
async (event, stripe) => {
  const refund = event.data.object as Stripe.Refund
  // Step-0 partial-refund check needs charge.amount_refunded vs amount_captured.
  // refund.charge is nullable; if absent, fall through to the §5.4.5 'neither matches' branch.
  const charge = refund.charge ? await stripe.charges.retrieve(refund.charge) : null
  // Subscription-invoice resolution: PI → invoicePayments.list → invoice (per §3.1 note 6 —
  // Charge.invoice was removed at basil). null-safe at every hop because invoice.parent
  // is itself nullable per §3.1 note 7.
  let invoice: Stripe.Invoice | null = null
  let subscription: Stripe.Subscription | null = null
  if (refund.payment_intent) {
    const ip = await stripe.invoicePayments.list({
      payment: { type: 'payment_intent', payment_intent: refund.payment_intent },
      limit: 1,
    })
    const invoiceId = ip.data[0]?.invoice ?? null
    if (invoiceId) {
      invoice = await stripe.invoices.retrieve(invoiceId)
      const parentSubId = invoice.parent?.type === 'subscription_details'
        ? invoice.parent.subscription_details?.subscription ?? null
        : null
      if (parentSubId) {
        subscription = await stripe.subscriptions.retrieve(parentSubId)
      }
    }
  }
  return { charge, invoice, subscription }
}
```

For à-la-carte refunds the `invoicePayments.list` returns empty (`ip.data` length 0); the resolution chain stays null and §5.4.5 step 1 proceeds via `purchases WHERE stripe_payment_intent_id = refund.payment_intent`. Handler's customer-id-miss fallback reads `prefetch.subscription?.metadata.userId` if the chain resolves.

These prefetch shapes are pinned in the spec so the implementer doesn't have to derive them. Tests assert each handler's prefetch contract via fixture data.

**Lock acquisition order discipline.** All webhook handlers that touch user-scoped state acquire `SELECT id FROM users WHERE id = $1 FOR UPDATE` as their first **write-blocking** DB operation in the tx (after the `stripe_events` insert and after any read-only resolution queries needed to determine the userId — per Petra I8 round 5: `checkout.session.completed` resolves via `metadata.userId`, `invoice.paid` and `customer.subscription.*` resolve via `users.stripe_customer_id` lookup, `refund.created` resolves via `purchases`/`billing_history` walk). This anchor lock matches MYT-40's `atomicDebit` recipe and prevents deadlocks where two concurrent handlers (e.g., `checkout.session.completed` racing `invoice.paid`) acquire user-scoped locks in different orders. Per Hydra I3 round 2 + Petra I1/I7 round 5: this discipline applies to ALL handlers that write user-scoped state, including `customer.subscription.created`/`.updated`/`.deleted` (the single-statement upsert is atomic, but adding the anchor lock makes the §5.3 deadlock-prevention claim hold uniformly across handlers).

**Route-handler integration.** The Fastify route handler at `POST /webhooks/stripe` calls `dispatchEvent(event, stripe, pool, request.log)` after signature verification (§5.2) and returns `200 { received: true }` on success or 5xx (rethrown error) on failure so Stripe retries.

### 5.4 Per-event-type handlers

Two cross-cutting rules apply to every handler:

1. **`event.data.object.customer` is a string** (`cus_*`), not an object. Read it as a string. Resolve user via `users.stripe_customer_id`. On miss, fall back to `subscription.metadata.userId` (if present on the event's subscription object — set at Checkout Session creation per §4.3) before logging + 200.
2. **Per-charge amount validation** (per MYT-41 spec §"Replacing parent spec §5.5"): before granting any credits, the handler reconstructs `expected_subtotal = sum(unit_amount * quantity)` from line-item lookup_keys + the SKU cache and asserts `expected_subtotal === event.data.object.amount_subtotal` (Checkout Session) or `expected_subtotal === event.data.object.subtotal_excluding_tax` (Invoice — per Stilton I6 / Roquefort C3 round 3, this is the pre-tax-pre-discount field; tax-/discount-tolerant by construction so a future tax-on flip doesn't silently break this assertion).
   
   **Validation runs FIRST** (after stripe_events insert + user-row anchor lock, BEFORE any other DB writes). Per Camembert I3 round 3, this resolves the prior round's contradiction where "COMMIT stripe_events on validation failure" conflicted with "catch-block rolls back the entire tx." Concretely:
   
   ```ts
   // Inside the dispatch tx, after stripe_events insert + anchor lock:
   const validationResult = validateAmount(event, prefetch, skuCache)
   if (!validationResult.ok) {
     log.error({ event_id, expected: validationResult.expected, actual: validationResult.actual },
               'billing.amount_validation_failed')
     return 'validation_failed'   // sentinel; the dispatcher COMMITs (stripe_events row stays) without invoking handler writes
   }
   await handler(event, prefetch, client)
   return 'ok'
   ```
   
   The dispatcher COMMIT-s on `'validation_failed'` (the only write at that point is the `stripe_events` row, which is what we want — Stripe stops retrying), and ROLLBACK-s on any thrown exception (the handler's writes were partial; Stripe redelivers). This split makes "validation failure" a non-throwing return, distinct from the runtime-error path.

#### 5.4.1 `checkout.session.completed`

Resolve user via `event.data.object.metadata.userId` (we set this on session create per §4.3). If `metadata.userId` doesn't resolve to a `users` row, this is a **paid-but-unknown-user** state — money taken, no credits to grant, manual reconciliation needed. Emit a paging metric `billing.checkout_orphan` at error level with all relevant IDs (`session_id`, `payment_intent`, `subscription`, `metadata.userId`, `customer`), COMMIT the `stripe_events` row (so Stripe stops retrying), return 200, and rely on the alarm to wake an operator. This case must NOT be silently swallowed under the generic "unknown customer" bucket.

**Cross-check:** assert `event.data.object.customer === users[metadata.userId].stripe_customer_id` (per MYT-41 spec §"Defense in depth on `metadata.userId`"). Mismatch → page + COMMIT + 200; the user-checkout-customer triple is corrupted and needs operator review.

**Always retrieve line_items.** The `checkout.session.completed` event payload at dahlia does NOT include `line_items` — fetch them with `stripe.checkout.sessions.retrieve(session_id, { expand: ['line_items.data.price'] })` inside the tx (deterministic on retry; sessions are immutable post-completion).

Branch on `event.data.object.mode`:

- **Subscription mode**: per Decision 1 of round-2 review, `checkout.session.completed` for subscription mode does **NOT grant credits**. Subscription credit grants flow exclusively through `invoice.paid` (single source of truth — handles fresh subscriptions + renewals + SCA-pending → SCA-completed transitions + ACH/SEPA settlement uniformly). This handler's responsibilities for subscription mode:
  - **Upsert** `user_subscriptions` via `repo.userSubscriptions.upsertFromStripe` (single `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE` statement) with `status` from Stripe (NOT hardcoded `'active'` — handles SCA-pending `'incomplete'` correctly), `tier_lookup_key`, period dates from `items.data[0].current_period_*`, `cancel_at_period_end`. The upsert tolerates any arrival order between `checkout.session.completed`, `customer.subscription.created`, and `customer.subscription.updated` since all three call the same `upsertFromStripe`. Stale-event ordering is rejected via `WHERE excluded.stripe_event_created_at > existing.stripe_event_created_at`.
  - **No billing_history write here.** Per Manchego M2 round 3: the invoice's billing_history row is owned by the `invoice.paid` handler (§5.4.2), NOT this one — otherwise both handlers would race to INSERT the same `(source_id_stripe = invoice_id, kind='invoice')` and the second would 23505 on the UNIQUE constraint. checkout.session.completed for subscription mode writes ONLY the `user_subscriptions` row; the invoice (and its credit grants + billing_history) is owned by `invoice.paid`. This matches Decision 1's "invoice.paid is the single source of truth for subscription credit grants" — the same invariant extends to billing_history rows.
  - **NO `credit_ledger` writes** in this handler for subscription mode. The downstream `invoice.paid` arrives ~100ms later (or whenever SCA / ACH / etc. settle) and produces the grant.
- **Payment mode (à-la-carte)**: walk the prefetched `line_items.data` (retrieved via `stripe.checkout.sessions.retrieve(session_id, { expand: ['line_items.data.price'] })` in the prefetch phase per §5.3). For each line, resolve `line.price.id` against the SKU cache reverse map → `lookup_key` → `LookupKeySpec`.
  - **Amount validation**: compute `expected_subtotal = sum(spec.priceCents * line.quantity)` and assert `expected_subtotal === event.data.object.amount_subtotal` (Chimera I5 round 2 — using `amount_subtotal` not `amount_total` is tax-/discount-tolerant by construction; tax/discount are off at launch but a future config flip wouldn't silently break this validation). Mismatch → §5.4 cross-cutting rule 2 (log + COMMIT + 200, no grant).
  - **One `purchases` row per line item**: `(stripe_payment_intent_id = event.data.object.payment_intent, lookup_key, quantity, amount_cents = line.amount_total, currency, status='completed')`. Composite UNIQUE on `(stripe_payment_intent_id, lookup_key)` per §6.
  - **Credit grants** via `repo.credits.grantInTx(client, ...)`: one row per `(line, credit_type)` — `amount = spec.sessionsGranted * line.quantity` for sessions; same for worlds. `source_type='purchase'`, **`source_purchase_id = purchases.id`** (the row just inserted) per Decision 4 of round-2 review. `source_billing_history_id = NULL`. `expires_at = NULL` (à-la-carte never expires).
  - **billing_history** row: `kind='purchase'`, `source_id_stripe = payment_intent`, `amount_cents = amount_subtotal`, `lookup_key = NULL` (multi-line; the per-line lookup_keys are in the `purchases` rows).

Per Doubloon I3 round 2: the legacy `payment_status === 'paid'` branch is no longer load-bearing for subscription mode (since we don't grant on this event for subscriptions). For payment mode, retain a defensive `payment_status === 'paid'` assertion before any credit grant — at launch with `payment_method_types: ['card', 'link']` (Decision 3), this is always true; a non-paid value indicates misconfiguration and triggers a paging log line.

#### 5.4.2 `invoice.paid`

Fires for: subscription create (fresh sub or post-SCA settlement), subscription cycle (renewal), subscription update (mid-period upgrade via §4.6). All three branches GRANT credits per the per-billing-reason subsections below. The §5.4.2 preface that previously said "skip subscription_create / subscription_update" was a round-1 design that round-2 Decision 1 inverted; the inversion was applied but the preface text wasn't deleted, producing the contradiction Manchego C1 round 3 caught. Subsequent removal: this paragraph.

Per Decision 1 of round-2 review, **`invoice.paid` is the single source of truth for subscription credit grants**. One handler covers fresh subscriptions (`subscription_create`), renewals (`subscription_cycle`), mid-period upgrades via the §4.6 endpoint (`subscription_update`), SCA-pending → SCA-completed transitions, and any future delayed-confirm settlement uniformly. The dedup mechanism is `stripe_events.event_id` PK — the same `invoice.paid` event redelivered hits the conflict and exits cleanly. Other `billing_reason` values (`manual`, `quote_accept`, `subscription_threshold`, etc.) record `billing_history` only — see the per-case sections below for the full branching.

Resolve user via `event.data.object.customer` (string) → `users.stripe_customer_id`. On miss → fall back to `subscription.metadata.userId` (retrieved at prefetch time per §5.3). On total miss → behavior depends on `billing_reason` and `amount_paid`:

- `billing_reason === 'subscription_cycle'` (or `'subscription_create'` / `'subscription_update'`) AND `amount_paid > 0` → **paging-grade** `billing.invoice_orphan` log line at error level (per Kraken I4 round 2: a real renewal payment landed for a customer we can't find — money taken, no credits granted, no alert is unacceptable). COMMIT + 200 (don't loop Stripe retries; manual reconciliation).
- Any other condition (zero amount, test event, etc.) → INFO-level log + COMMIT + 200.

Acquire the user-row anchor lock per §5.3 lock-acquisition discipline. Then read the prefetched subscription state (Stripe's `Subscription` object retrieved at prefetch time): assert `subscription.items.data.length === 1` (loud abort on multi-item — Mythrun doesn't expose multi-item subs to users; an admin-created multi-item sub is operator error and should not silently grant). Read `tier_lookup_key = items.data[0].price.lookup_key`, `period_start = items.data[0].current_period_start`, `period_end = items.data[0].current_period_end`.

Branch on `billing_reason`:

#### `billing_reason === 'subscription_cycle'` (renewal)

- **Amount validation**: assert `event.data.object.subtotal_excluding_tax === price.unit_amount` (single-item subscription; per §5.4 cross-cutting rule 2 + Carthage C1 round 5, this is the pre-tax-pre-discount field; tax-/discount-tolerant by construction so a future tax-on flip doesn't silently break the assertion). Mismatch → §5.4 cross-cutting rule 2.
- **Insert order (per Petra I5 round 5): append billing_history → grant credits.** The credit_ledger row's `source_billing_history_id` FK references the billing_history row; FK requires billing_history first or the tx aborts.
- **Append billing_history** row: `kind='invoice'`, `source_id_stripe = invoice_id`, `amount_cents = subtotal_excluding_tax`, `lookup_key = tier_lookup_key`, `expires_at = period_end` (mirrors the credit_ledger.expires_at for refund-resolution per §5.4.5).
- **Grant** via `repo.credits.grantInTx(client, ...)`: one row per `(credit_type)` — `amount = spec.sessionsGranted` for `credit_type='session'`, same for worlds. `source_type='subscription'`. `source_billing_history_id = <billing_history row inserted above>`. `source_purchase_id = NULL`. `expires_at = period_end`.

#### `billing_reason === 'subscription_create'` (initial subscription invoice — fresh sub or post-SCA settlement)

Same logic as `subscription_cycle`, with one subtlety: at this moment `user_subscriptions` may not yet have a row for this `stripe_subscription_id` if `customer.subscription.created` / `customer.subscription.updated` hasn't arrived yet (race on Stripe's side). The `upsertFromStripe` call from §5.4.3 covers the row creation; if THIS handler runs first, it must also call `upsertFromStripe` (idempotent) so that the user_subscriptions row exists. **Insert order (per Petra I5 round 5): `upsertFromStripe` → append billing_history → grant credits.** The credit_ledger row's `source_billing_history_id` FK references the billing_history row, so billing_history MUST be inserted first or the FK constraint aborts the tx and Stripe redelivers indefinitely.

#### `billing_reason === 'subscription_update'` (mid-period upgrade via §4.6)

- This is the upgrade-tier endpoint's invoice landing. The invoice carries the **flat dollar delta** (e.g., $30 for Wayfarer→Mythwright via Stripe's `proration_date=current_period_start` math).
- **Derive OLD and NEW tier from the invoice line items, NOT from `user_subscriptions`** (per Petra I3 round 5 — load-bearing revenue-hole fix). Stripe's typical event ordering for an `/upgrade-tier` call is `customer.subscription.updated` → `invoice.paid`; the former runs `upsertFromStripe` (per §5.4.3) and writes the NEW `tier_lookup_key` to `user_subscriptions` BEFORE this handler reads it. If this handler used `getActiveForUser` to find the "OLD" tier, it would read the NEW tier (already overwritten), compute `delta = NEW − NEW = 0`, and grant ZERO credits despite the user paying the full upgrade delta. The fix: a proration invoice carries TWO line items — one negative (the prorated refund of the OLD price) and one positive (the prorated charge for the NEW price). Each line's `pricing.price_details.price` (Stripe price ID at dahlia, since `lookup_key` was removed from `InvoiceLineItem` per §3.1 note 2) resolves via the SKU cache reverse map to its `lookup_key`. Concretely: `oldLookupKey = skuCache.findByPriceId(prefetch.invoice.lines.data.find(l => l.amount < 0)!.pricing.price_details.price).lookup_key`; `newLookupKey = skuCache.findByPriceId(prefetch.invoice.lines.data.find(l => l.amount > 0)!.pricing.price_details.price).lookup_key`. Both are pinned by the invoice itself, independent of any race against `customer.subscription.updated`.
- Compute the credit DELTA from the resolved tier specs: `(LOOKUP_KEYS[newLookupKey].sessionsGranted - LOOKUP_KEYS[oldLookupKey].sessionsGranted)` for sessions, same for worlds.
- **Amount validation**: assert `event.data.object.subtotal_excluding_tax === (LOOKUP_KEYS[newLookupKey].priceCents - LOOKUP_KEYS[oldLookupKey].priceCents)` (the flat dollar delta per Decision 2). Mismatch → §5.4 cross-cutting rule 2 (likely indicates a Stripe-side proration math change or a config drift; pages an alert).
- **Upsert** `user_subscriptions` to the new tier via `upsertFromStripe` (idempotent against any prior `customer.subscription.updated`-driven upsert).
- **Insert order (per Petra I5 round 5): `upsertFromStripe` → append billing_history → grant credits.**
- **Append billing_history** row: `kind='invoice'`, `source_id_stripe = invoice_id`, `amount_cents = subtotal_excluding_tax` (the delta), `lookup_key = newLookupKey`, `expires_at = period_end + tier_period_length`.
- **Grant** via `repo.credits.grantInTx(client, ...)`: one row per `(credit_type)` with `amount = delta` (for the credit_type), `source_type='subscription'`, `source_billing_history_id = <the billing_history row inserted above>`, `expires_at = period_end + tier_period_length` (i.e., the next-period-end after the upgrade — credits get a full period of life, not the days remaining in the original period). For Mythrun's monthly tiers this is `period_end + INTERVAL '1 month'` computed in SQL.

#### Other `billing_reason` values (`manual`, `quote_accept`, `subscription_threshold`, etc.)

Per Chimera M7 round 2: explicit allowlist. The handler accepts `subscription_cycle`, `subscription_create`, `subscription_update`. Any other `billing_reason` → record `billing_history` row only (audit trail), no credit grant. Log at INFO with the unhandled `billing_reason`. Defends against admin-issued Dashboard invoices accidentally granting credits.

#### Negative-amount or zero-amount invoices

Skip credit grant and skip amount validation; record `billing_history` only (with the negative or zero amount). Negative invoices are Stripe-side credit memos (e.g., promotion-code refunds, downgrade prorations from non-Mythrun-issued operations); they're audit-relevant but don't trigger ledger writes.

#### 5.4.3 `customer.subscription.created` and `customer.subscription.updated` (shared `handleSubscriptionUpsert`)

Both event types use the same handler because the upsert shape is identical. Stripe doesn't guarantee delivery order between `customer.subscription.created`, `customer.subscription.updated`, and `checkout.session.completed`; the upsert handler tolerates any ordering.

Resolve user via `event.data.object.customer` → `users.stripe_customer_id`; fallback to `event.data.object.metadata.userId` on miss. Total miss → log + COMMIT + 200.

Assert `subscription.items.data.length === 1`. Read `tier_lookup_key`, `status`, `items.data[0].current_period_start`, `items.data[0].current_period_end`, `cancel_at_period_end`, `cancellation_details` (if present — Stripe surfaces it on `cancel_at_period_end` toggles).

`repo.userSubscriptions.upsertFromStripe` issues a single `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE` statement so concurrent deliveries can't both INSERT and trip the UNIQUE constraint. The UPDATE clause reads `WHERE excluded.stripe_event_created_at > user_subscriptions.stripe_event_created_at` (strict `>`, NOT `>=`, per Camembert I1 / Stilton + Roquefort M5 round 3 — same-second distinct events converge to one row, picking whichever arrived first; subsequent same-second events are rejected as stale, which is acceptable because Stripe's event delivery includes the canonical event in the FIRST delivery and redeliveries are byte-identical). The `stripe_event_created_at` column is added to `user_subscriptions` in migration 007; populated from `event.created` (the Stripe Event's own timestamp), NOT from any field on the Subscription / Invoice payload.

**No credit grant** in this handler — all subscription credits flow through `invoice.paid` per Decision 1 of round-2 review. Subscription state (tier, period, status, cancel_at_period_end) lives in this row; credits live in `credit_ledger`.

#### 5.4.4 `customer.subscription.deleted`

UPDATE via `repo.userSubscriptions.markCanceled(client, stripe_subscription_id, event.data.object)` which sets `status='canceled'`, **preserves `cancel_at_period_end` from the event payload as a historical fact** (per Kraken C3 round 2: collapsing to false on `.deleted` destroys the user-vs-Stripe-cancel distinction needed for differential UX and analytics — re-subscribe prompts, refund decisioning, churn reasons), copies `event.data.object.cancellation_details` into the row, and copies `event.data.object.cancel_at` (a Stripe-side timestamp marking when the cancel takes effect) if present.

Existing credits in `credit_ledger` stay; they remain consumable until natural `expires_at` (`current_period_end`). Per parent spec §3.3 + §10: no retroactive expiry on cancellation. The user paid for the period; they get to use it through `current_period_end` regardless of cancellation reason.

If no row matches the `stripe_subscription_id` (Stripe-side test event, deleted user, deletion-before-creation), log + COMMIT + 200.

#### 5.4.5 `refund.created` and `refund.updated` (shared `handleRefundEvent`)

Refund handling at launch: **full refunds only** (per Decision 5 of round-2 review). Partial-refund implementation is a follow-up bead. **Event subscription**: BOTH `refund.created` and `refund.updated` (per Carthage C1 round 6). The two share `handleRefundEvent` because the dispatch shape is identical — both events carry `event.data.object` as the Refund object with the current `status` snapshot.

**Step −1 — status gate** (per Carthage C1 round 6): assert `event.data.object.status === 'succeeded'`. Refund status values at dahlia: `pending | requires_action | succeeded | failed | canceled`. Only `succeeded` reflects "money returned to user, credits should be clawed back." For any other status:
- `pending` / `requires_action` (typical async-card path): log INFO `billing.refund_pending` + COMMIT `stripe_events` row + 200. The transition to `succeeded` will fire `refund.updated` and re-enter this handler.
- `failed` / `canceled`: log INFO `billing.refund_terminal_non_success` + COMMIT + 200. No clawback (none was made — this handler always idempotently arrives at the succeeded path before any clawback writes). No reversal needed.

**Documented launch gap** (per Carthage C1 round 6): the rare succeeded → failed transition (Stripe re-credits the merchant after a previously-succeeded refund — issuer-side rejection) IS a revenue gap because clawback already landed. At launch this is handled via runbook (paging-grade alarm `billing.refund_succeeded_to_failed` fires when `refund.updated` arrives with `status='failed'` AND a prior clawback exists for that `refund.id` in `billing_history`). The reversal mechanism (insert positive credit_ledger rows undoing the clawback) is a follow-up bead. This is a deliberate trade-off: card refund failure after settlement is rare in production, and the runbook resolution path is well-defined (operator issues a goodwill credit grant).

**Step 0 — partial-refund hard-refuse**: To enforce full-refund-only, the handler reads the parent Charge state via `prefetch.charge` (the prefetcher already optional-chained the `refund.charge` retrieve per §5.3 — if `prefetch.charge === null`, fall through to step 1's "neither matches" branch). Assert `prefetch.charge.amount_refunded === prefetch.charge.amount_captured` — i.e., the Charge's cumulative refund total equals its captured amount. Mismatch (partial refund: the Refund just landed but doesn't fully refund the Charge) → emit a paging metric `billing.partial_refund_unsupported` at error level with `{ charge_id: refund.charge, refund_id: refund.id, amount_captured, amount_refunded, payment_intent: refund.payment_intent }`, COMMIT the `stripe_events` row (suppresses Stripe retries — there's nothing to retry until partial-refund support lands), do NOT clawback, return 200. Operator workflow: the Stripe-side refund stays valid (the customer's money is being returned by Stripe); Mythrun-side credit clawback is gated until manual reconciliation. Operators are instructed (in the runbook) to refund full charges only.

For full refunds:

**Lock-acquisition ordering exception.** Per Manchego I2 round 3: the §5.3 discipline "user-row anchor lock as the FIRST DB operation in the tx" cannot apply directly to `refund.created` because the user is unknown until step 1's resolution finishes. The handler-specific ordering for refunds is:
1. `stripe_events` insert (§5.3 standard).
2. Originating-entity resolution (read-only queries against `purchases` / `billing_history`; no FOR UPDATE).
3. `SELECT id FROM users WHERE id = $resolved_user_id FOR UPDATE` (the deferred anchor lock).
4. Re-fetch the originating rows under the lock to confirm they haven't transitioned (e.g., concurrent refund racing this one). Refusal-on-already-refunded is in step 3 of the original §5.4.5 numbered list below.
5. Write clawback rows + UPDATE source row status + append `billing_history` row.

This "optimistic resolve, then re-read under lock" pattern is the right shape for cross-row, cross-user webhook resolution where the user_id is not known a priori. The §5.3 anchor-lock-first discipline applies to all OTHER handlers (where `user_id` resolves from `metadata.userId` or `customer.id` BEFORE any DB read); `refund.created` is the documented exception.

1. **Resolve the originating Mythrun entity.** `event.data.object.payment_intent` (string on the Refund object, may be null for non-PI charges — e.g., legacy direct-Charge refunds outside Mythrun's surface) is the join key. Two resolution paths in order:
   - **À-la-carte purchase**: query `purchases WHERE stripe_payment_intent_id = $1 AND status='completed'`. If non-empty, walk all matching `purchases` rows (a multi-line cart has multiple). For each row, query `credit_ledger WHERE source_purchase_id = purchases.id AND source_type='purchase'` to find the originating grant rows (per Decision 4 of round-2 review: explicit FK columns).
   - **Subscription invoice**: the Refund's `payment_intent` is the PI Stripe auto-generated for the invoice; the mapping from PI → invoice_id is resolved at PREFETCH time (per §5.3 prefetch-then-write split) via `stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: refund.payment_intent } })` and reading the result's `invoice` field (per §3.1 note 6 — `Charge.invoice` was removed at basil, so the inverse `invoicePayments` lookup is the dahlia-correct resolution direction). The handler's tx body uses the prefetched `invoice_id` as the `source_id_stripe` lookup key against `billing_history WHERE source_id_stripe = $1 AND kind='invoice'`. From the resulting `billing_history.id`, query `credit_ledger WHERE source_billing_history_id = billing_history.id AND source_type='subscription'` to find the originating grant rows.
   - **Neither matches** (`payment_intent: null`, admin Dashboard test charge, non-Mythrun charge, OR à-la-carte purchase whose `purchases.status` is already `'refunded'` — operator clicked "Re-deliver" in Dashboard producing a fresh `event.id` for the same `re_*`, OR the originating `billing_history.status` is already `'refunded'` for the subscription path): log at WARN + COMMIT `stripe_events` + **return 200 immediately. Steps 2–5 below do NOT run.** Per Persepolis C5 round 6: continuing past this branch would 23505 on `billing_history.source_id_stripe = re_*` UNIQUE (the prior delivery already inserted that row) and force Stripe into ~3 days of retry-loop. The early exit is the canonical "already-processed refund" idempotency path. Steps 2–5 only execute when step 1 found at least one still-completed originating row.

2. **Compute the clawback.** For each originating `credit_ledger` grant row found above, insert a debit row via `repo.credits.recordClawback(client, ...)` (the new method in §7.6) with:
   - `credit_type = original.credit_type`
   - `amount = -original.amount` (negative; respects migration 004 polarity invariant — only `source_type='debit'` rows can carry negative amounts)
   - `source_type='debit'` (per MYT-40 §"Caller obligations": `'refund'` source_type is reserved for POSITIVE goodwill grants; clawbacks use `'debit'`)
   - `source_id = original.id` (the originating grant row's UUID; namespace-disjoint from session-debit `source_id` per Kraken C4 round 2 — UUIDv7 non-collision is the discipline invariant)
   - **`expires_at = NULL`** (per Kraken I8 round 2: `credit_ledger_debit_no_expiry_chk` migration-004 CHECK requires `source_type='debit'` rows have `expires_at IS NULL`. Setting `expires_at = original.expires_at` would violate the CHECK and abort the refund tx, putting the refund pipeline into infinite Stripe retry).
   - `source_purchase_id = NULL`, `source_billing_history_id = NULL` (the new FK columns are for grant rows; clawback rows link via `source_id` for idempotency-keyed dedup).

3. **UPDATE source row status.** For à-la-carte: `UPDATE purchases SET status='refunded' WHERE id = $1` for each affected purchases row. For subscription invoice: `UPDATE billing_history SET status='refunded' WHERE id = $1` for the affected billing_history row.

4. **Append a `billing_history` row** with `kind='refund'`, `source_id_stripe = refund.id` (Stripe's `re_*` ID — `event.data.object.id`, unambiguous now that we subscribe to `refund.created` rather than `charge.refunded`; unique even when the same PI has multiple full refunds across time — re-refund of an already-refunded charge is forbidden by Stripe), `amount_cents = -refund.amount`, `lookup_key = NULL` (multi-line refunds don't pin a single lookup_key), `occurred_at = to_timestamp(refund.created)` (Refund's own `created` Unix timestamp).

5. **Resulting balance** MAY go negative. MYT-40's atomic-debit refuses to consume from balance ≤ 0; at session-start, the user gets 402 Payment Required and must purchase to lift the balance back to positive. An in-flight session (already-debited credit) is unaffected by a refund arriving mid-session — the debit row stays committed; only the *next* session-start gates on the new balance.

**Refunds beyond `current_period_end`**: the clawback rows have `expires_at = NULL` per step 2, so they contribute to the balance computation indefinitely. The originating grant rows have already expired (passed `current_period_end`) and don't contribute to the balance. Net effect: balance moves down by the clawback amount, even though the originating grant is no longer counted — the user owes the platform the refund amount in unexpired credit-currency until they buy more. Documented in §12.

### 5.5 Customer-not-found handling

For all subscription events: if `customer.id` doesn't map to any user (manual Dashboard creation, deleted user, out-of-band test event), log + commit (the stripe_events row records acknowledgement so Stripe stops retrying) + 200. This avoids breaking Stripe's delivery for events we can't act on; investigation goes through logs.

### 5.6 Unknown event types

Any event type not in the `HANDLERS` map: log + commit (stripe_events row records the event_id) + 200. The Dashboard webhook config can subscribe to a broader set of events than we handle without breaking ingestion. Tightening or loosening the Dashboard subscription is a runtime ops change, not a code deploy.

## 6. Migration 007 — re-create purchases + user_subscriptions

```sql
-- Migration 007 — re-create purchases + user_subscriptions with the lookup_key shape.
--
-- MYT-41 migration 006 dropped both tables (empty, FK-correct order, pre-drop
-- ASSERT). MYT-42 re-creates them with the new shape: lookup_key TEXT replaces
-- the legacy session_pack_size INTEGER on purchases; tier_lookup_key TEXT
-- replaces the legacy tier_id REFERENCES subscription_tiers(id) on
-- user_subscriptions (no FK; the closed enum is enforced at write-time by the
-- webhook handler against backend/src/billing/lookup-keys.ts).

-- purchases: à-la-carte purchase records. The (stripe_payment_intent_id, lookup_key)
-- composite UNIQUE replaces a per-row UNIQUE on stripe_payment_intent_id alone:
-- a multi-line cart (e.g., 3× sku_session + 1× sku_world) shares one PaymentIntent
-- across multiple purchases rows, so per-row UNIQUE on PI alone would 23505 on the
-- second insert. The composite tolerates multi-line carts AND blocks duplicate
-- inserts of the same (PI, lookup_key) pair.
CREATE TABLE purchases (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id),
  stripe_payment_intent_id    TEXT        NOT NULL,
  lookup_key                  TEXT        NOT NULL,
  quantity                    INTEGER     NOT NULL CHECK (quantity > 0),
  amount_cents                INTEGER     NOT NULL,
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  status                      TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_payment_intent_id, lookup_key)
);
CREATE INDEX idx_purchases_user ON purchases(user_id);

CREATE TABLE user_subscriptions (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_lookup_key             TEXT        NOT NULL,
  stripe_subscription_id      TEXT        NOT NULL UNIQUE,
  -- Stripe sends the full enum: incomplete, incomplete_expired, trialing, active,
  -- past_due, canceled, unpaid. Mythrun cares about all of them; we relax the
  -- earlier 4-value CHECK to admit incomplete/incomplete_expired/trialing so
  -- §5.4.1's SCA-pending path (status='incomplete') doesn't violate the constraint.
  status                      TEXT        NOT NULL CHECK (status IN (
                                            'active','past_due','canceled','unpaid',
                                            'incomplete','incomplete_expired','trialing'
                                          )),
  current_period_start        TIMESTAMPTZ NOT NULL,
  current_period_end          TIMESTAMPTZ NOT NULL,
  cancel_at_period_end        BOOLEAN     NOT NULL DEFAULT false,
  cancel_at                   TIMESTAMPTZ NULL,           -- Stripe's cancel_at field (timestamp), nullable
  cancellation_details        JSONB       NULL,           -- Stripe's cancellation_details on .deleted, nullable
  -- Used by upsertFromStripe to reject stale-event ordering: an UPDATE on
  -- conflict reads WHERE excluded.stripe_event_created_at > row's value (strict), so a
  -- late stale event can't overwrite a fresh row.
  stripe_event_created_at     TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);

-- billing_history: the unified audit feed for /api/billing/history. Per
-- Decision 4 of round-2 review, the refund-resolution role moves to explicit
-- FK columns on credit_ledger (added below); billing_history.related_id_stripe
-- is dropped — Chimera I7 / Kraken I3 round 2 flagged it as a dead column
-- whose population rules contradicted between the schema and the prose.
-- For à-la-carte: kind='purchase', source_id_stripe = payment_intent.
-- For subscription invoice: kind='invoice', source_id_stripe = invoice_id.
-- For refund: kind='refund', source_id_stripe = refund_id (re_*).
-- The three Stripe ID prefixes used today (pi_*, in_*, re_*) are disjoint.
-- A CHECK constraint enforces the prefix per kind for defense-in-depth.
CREATE TABLE billing_history (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                        TEXT        NOT NULL CHECK (kind IN ('purchase','invoice','refund')),
  source_id_stripe            TEXT        NOT NULL UNIQUE,
  lookup_key                  TEXT        NULL,           -- nullable: multi-line à-la-carte rows leave it NULL; subscription invoices fill it
  amount_cents                INTEGER     NOT NULL,       -- positive for purchase/invoice, negative for refund
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  status                      TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
  expires_at                  TIMESTAMPTZ NULL,           -- mirrors the originating credit_ledger.expires_at; NULL for à-la-carte and refund
  occurred_at                 TIMESTAMPTZ NOT NULL,       -- Stripe's event timestamp (full precision)
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'purchase' AND source_id_stripe LIKE 'pi_%')
    OR (kind = 'invoice'  AND source_id_stripe LIKE 'in_%')
    OR (kind = 'refund'   AND source_id_stripe LIKE 're_%')
  )
);
CREATE INDEX idx_billing_history_user_occurred ON billing_history(user_id, occurred_at DESC, id DESC);

-- credit_ledger refund-resolution FKs (Decision 4 of round-2 review).
-- Grants link back to either a purchases row (à-la-carte) or a billing_history
-- row (subscription invoice). The CHECK enforces "exactly one is non-null per
-- non-debit, non-trial grant" — the refund handler queries via FK to find
-- the originating grant rows. ON DELETE RESTRICT prevents an orphaned grant
-- if a parent row is ever hard-deleted (we don't today, but the constraint
-- enforces invariant against future cleanup paths).
ALTER TABLE credit_ledger
  ADD COLUMN source_purchase_id        UUID NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  ADD COLUMN source_billing_history_id UUID NULL REFERENCES billing_history(id) ON DELETE RESTRICT,
  ADD CONSTRAINT credit_ledger_source_link_chk CHECK (
    -- Per Petra C3 / Persepolis C1 round 6: per-source_type CASE enforces the
    -- correct FK shape at write time. The earlier OR-shaped predicate was
    -- non-restrictive — it admitted (e.g.) source_type='trial' rows with a
    -- spurious source_purchase_id, and source_type='subscription' rows
    -- pointing at the wrong FK column. Restating the rule per source_type
    -- closes those holes AND forecloses on a future 'refund' grant landing
    -- as a fully-orphaned row (refund-goodwill grants link to billing_history).
    CASE source_type
      WHEN 'debit'        THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'trial'        THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'gift'         THEN source_purchase_id IS NULL AND source_billing_history_id IS NULL
      WHEN 'refund'       THEN source_purchase_id IS NULL AND source_billing_history_id IS NOT NULL
      WHEN 'purchase'     THEN source_purchase_id IS NOT NULL AND source_billing_history_id IS NULL
      WHEN 'subscription' THEN source_purchase_id IS NULL AND source_billing_history_id IS NOT NULL
      ELSE FALSE  -- reject unknown source_types at the DB layer; forces schema discipline
    END
  );
CREATE INDEX idx_credit_ledger_source_purchase
  ON credit_ledger(source_purchase_id) WHERE source_purchase_id IS NOT NULL;
CREATE INDEX idx_credit_ledger_source_billing_history
  ON credit_ledger(source_billing_history_id) WHERE source_billing_history_id IS NOT NULL;

-- Post-create assertion (current_schema() not hard-coded 'public', per the
-- migration 005 fix).
DO $$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('purchases', 'user_subscriptions', 'billing_history')
    GROUP BY 1 = 1
    HAVING count(*) = 3
  ), 'migration 007 did not create all three tables';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'credit_ledger'
      AND column_name IN ('source_purchase_id', 'source_billing_history_id')
    GROUP BY 1 = 1
    HAVING count(*) = 2
  ), 'migration 007 did not add credit_ledger FK columns';
END $$;
```

Schema-parity test (`backend/src/db/__tests__/migrate-schema.test.ts`) updated:
- Add `'purchases'`, `'user_subscriptions'`, `'billing_history'` to `EXPECTED_TABLES`.
- Add `'idx_purchases_user'`, `'idx_user_subscriptions_user'`, `'idx_billing_history_user_occurred'`, `'idx_credit_ledger_source_purchase'`, `'idx_credit_ledger_source_billing_history'` to `EXPECTED_IDX_NAMES`.
- Add the new check constraints (purchases.status, purchases.quantity > 0, user_subscriptions.status, user_subscriptions period-monotonicity, billing_history.kind, billing_history.status, billing_history prefix-by-kind, credit_ledger_source_link_chk) to `EXPECTED_CHECK_CONSTRAINTS`.
- Add the FK rows: `purchases.user_id` (NO ACTION), `user_subscriptions.user_id` (CASCADE), `billing_history.user_id` (CASCADE), `credit_ledger.source_purchase_id` (RESTRICT), `credit_ledger.source_billing_history_id` (RESTRICT).
- Append `'007_recreate_billing_tables.sql'` to the migrations list.

`reset-data.ts` `TABLES` list extended with `purchases`, `user_subscriptions`, and `billing_history`.

## 7. Repo namespaces

### 7.1 `repo.purchases`

```ts
interface PurchasesRepo {
  create(tx: ClientLike, row: NewPurchase): Promise<Purchase>
  getByPaymentIntent(tx: ClientLike, payment_intent_id: string): Promise<readonly Purchase[]>  // multi-line cart returns >1
  listByUser(tx: ClientLike, userId: string, opts: { cursor?: string, limit: number }): Promise<{ rows: Purchase[], nextCursor: string | null }>
  markRefunded(tx: ClientLike, purchaseId: string): Promise<void>  // by purchases.id, not PI, to handle multi-line carts
}
```

### 7.2 `repo.userSubscriptions`

```ts
interface UserSubscriptionsRepo {
  upsertFromStripe(tx: ClientLike, row: SubscriptionRow): Promise<UserSubscription>
  // Single-statement INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE.
  // The UPDATE clause includes WHERE excluded.stripe_event_created_at >=
  // user_subscriptions.stripe_event_created_at to reject stale-event ordering.
  // Atomic against concurrent deliveries (handles checkout.session.completed
  // racing customer.subscription.created racing customer.subscription.updated).

  getActiveForUser(tx: ClientLike, userId: string): Promise<UserSubscription | null>
  // The "single active subscription" the §9 balance + subscription endpoints need.
  // Mythrun policy via Customer Portal Switch Plan is one active subscription
  // per user. "Active" excludes status IN ('canceled','incomplete_expired').

  markCanceled(tx: ClientLike, stripe_subscription_id: string, payload: { cancel_at_period_end: boolean; cancel_at: string | null; cancellation_details: unknown }): Promise<void>
  // status='canceled'. PRESERVE cancel_at_period_end from the event payload
  // (per Kraken C3 round 2 / Stilton M4 round 3). Per Carthage I3 round 5: at
  // dahlia, cancel_at_period_end on the .deleted payload is the HISTORICAL
  // fact — Stripe docs: "did (if status=canceled) cancel at the end of the
  // current billing period." A user who clicked Cancel-At-Period-End and
  // had the subscription delete arrives with cancel_at_period_end=true; a
  // Stripe-initiated dunning cancellation arrives with =false. Preserving
  // the payload value distinguishes these for analytics; collapse-to-false
  // would erase the distinction.
  //
  // The user-vs-Stripe-cancel distinction is also redundantly available
  // via cancellation_details.reason. Documented Stripe enum values at
  // dahlia (per Carthage I1 round 5):
  //   'canceled_by_retention_policy'  // Stripe Smart Retries / retention automation
  //   'cancellation_requested'        // user clicked Cancel in Customer Portal
  //                                   // OR you called subscriptions.cancel
  //   'payment_disputed'              // Stripe canceled because of a dispute
  //   'payment_failed'                // Stripe canceled after dunning exhausted
  // cancel_at (timestamp) and cancellation_details (full object) are also
  // recorded; analytics + audit feed read both.
}
```

### 7.3 `repo.stripeEvents`

```ts
interface StripeEventsRepo {
  recordOrSkip(tx: ClientLike, event_id: string, event_type: string): Promise<'inserted' | 'duplicate'>
  // INSERT ... ON CONFLICT DO NOTHING RETURNING. 'duplicate' means a prior
  // transaction already recorded this event_id. Durability is conditional on
  // the caller's transaction committing — a tx that ROLLBACKs after recordOrSkip
  // returned 'inserted' loses the row, and the next Stripe retry sees 'inserted'
  // again (correct for retryable failures; see §5.3 rollback semantics).
}
```

### 7.4 `repo.billingHistory`

```ts
interface BillingHistoryRepo {
  append(tx: ClientLike, row: NewBillingHistoryRow): Promise<BillingHistoryRow>
  // Inserts a kind='purchase'|'invoice'|'refund' row. source_id_stripe is the Stripe
  // ID (pi_*, in_*, or re_*); UNIQUE constraint blocks duplicate inserts. The
  // CHECK constraint enforces prefix-by-kind for defense-in-depth.

  findBySourceStripeId(tx: ClientLike, source_id_stripe: string): Promise<BillingHistoryRow | null>
  // Used by §5.4.5 refund.created subscription-invoice resolution: lookup by
  // invoice_id (resolved from refund.payment_intent → invoicePayments.list →
  // invoice_id at prefetch time per §5.3, since Charge.invoice was removed at
  // 2025-03-31.basil per §3.1 note 6).

  listByUser(tx: ClientLike, userId: string, opts: { cursor?: { t: string, i: string }, limit: number }): Promise<{ rows: BillingHistoryRow[], nextCursor: string | null }>
  // Cursor format per §4.1.

  markRefunded(tx: ClientLike, id: string): Promise<void>
}
```

The `findByRelatedStripeId` method from round 1 is **dropped** (per Chimera I7 / Kraken I3 round 2 — it referenced a `related_id_stripe` column that no handler actually queried, and Decision 4's explicit FK columns on credit_ledger replace its intended role). Refund resolution now flows through credit_ledger's `source_purchase_id` / `source_billing_history_id` FK columns directly.

### 7.5 `repo.users.create` + `findOrCreateStripeCustomer` (extensions)

```ts
interface UsersRepo {
  // ... existing methods ...

  // BREAKING CHANGE to MYT-38's create(): now accepts a ClientLike so the
  // route handler can wrap users.create + repo.credits.grant + UPDATE
  // free_trial_used inside a single BEGIN/COMMIT.
  create(tx: ClientLike, params: NewUser): Promise<User>

  findOrCreateStripeCustomer(tx: ClientLike, userId: string): Promise<string>
  // Returns the cus_*. Acquires a row-level lock on users.id via
  // SELECT stripe_customer_id FROM users WHERE id = $1 FOR UPDATE.
  // If non-null, returns it. If null, calls customer.ts helper to create at
  // Stripe (with idempotency-key 'customer_for_${userId}'), then unconditional
  // UPDATE inside the same FOR UPDATE-locked tx. The lock serializes concurrent
  // callers cleanly without relying on the conditional-UPDATE race-loser branch.
}
```

### 7.6 `repo.credits` extensions: `grantInTx` + `recordClawback`

Per Hydra C1 round 2: the shipped `repo.credits.grant` from MYT-40 acquires its own connection from the pool, runs its own `BEGIN`/`COMMIT`, and takes its own `SELECT … FOR UPDATE` user lock. Calling it with an already-open transaction is a real refactor, not a type-annotation change. MYT-42 splits the implementation:

```ts
interface CreditsRepo {
  // PUBLIC, transaction-owning. Backwards-compatible with MYT-40 callers that
  // don't have a tx of their own. Internally: pool.connect() + BEGIN + grantInTx + COMMIT.
  grant(row: NewCreditLedgerRow): Promise<CreditLedgerRow>

  // PUBLIC, transaction-following. Caller passes a ClientLike with an already-open
  // tx; this method performs the SELECT user FOR UPDATE + INSERT against that
  // same tx without managing its own BEGIN/COMMIT. Used by:
  //   - register flow (trial credit, §8)
  //   - checkout.session.completed handler (à-la-carte grants, §5.4.1)
  //   - invoice.paid handler (subscription grants, §5.4.2)
  // The user-row FOR UPDATE inside grantInTx assumes the caller has NOT already
  // taken that lock. If the caller already holds it (per §5.3 lock-acquisition
  // discipline), the FOR UPDATE in grantInTx is a no-op self-relock — Postgres
  // permits this for ACCESS EXCLUSIVE locks. Verify in tests.
  grantInTx(tx: ClientLike, row: NewCreditLedgerRow): Promise<CreditLedgerRow>

  // NEW: clawback writer. Bypasses the polarity guard explicitly because
  // clawbacks are the ONE legitimate path for negative-amount, source_type='debit'
  // rows outside atomicDebit. Asserts: amount < 0; source_type='debit'; source_id
  // is non-null (the originating grant row's UUID); expires_at IS NULL (per
  // migration 004's credit_ledger_debit_no_expiry_chk).
  // Used by:
  //   - refund.created handler (§5.4.5)
  recordClawback(tx: ClientLike, row: NewClawbackRow): Promise<CreditLedgerRow>

  // UNCHANGED from MYT-40.
  atomicDebit(tx: ClientLike, params: AtomicDebitParams): Promise<AtomicDebitResult>
}
```

Why a new method instead of letting `grant` take negative amounts: the existing MYT-40 `grant` ships explicit guards `if (amount <= 0) throw` and `if (sourceType === 'debit') throw 'use atomicDebit'`. Hydra C2 round 2 caught that the round-1 spec's "use grant() for clawbacks" prescription would crash on every refund. `recordClawback` is the new sanctioned entrypoint; tests in §13 assert (a) `grant` still rejects negative amounts and `'debit'` source_type, (b) `recordClawback` requires negative amount + `'debit'` source_type + non-null source_id + null expires_at, (c) `recordClawback`'s output respects migration 004's `uniq_credit_ledger_debit_idempotency` UNIQUE INDEX `(user_id, credit_type, source_id) WHERE source_type='debit'` — clawback rows MUST use the originating grant's UUID as `source_id`, never a session UUID, to keep the namespaces disjoint per Kraken C4 round 2.

**Deliberate non-extension:** `repo.credits.atomicDebit` is NOT extended in this issue. Round 1 of this spec's review (Florin C2 / Sestertius C1) showed that exposing `consumedSourceType` requires a recipe redesign — MYT-40's recipe is balance-based, not row-traversal-based, and there is no "consumed row" to label without rewriting the lock discipline. The trial-detection signal (`source_type='trial'` on the consumed credit) lives in `credit_ledger` already; MYT-43 picks the consumption-priority order and exposes the signal at that point. MYT-42 ships the credit, not the consumer.

**Trial-FIRST consumption invariant** (Kraken I6 round 2): MYT-43's eventual consumption-priority order MUST consume `source_type='trial'` rows BEFORE any other source type for users with both trial and paid credits. Rationale: the trial UX (reduced budget, demo world, time cap) is supposed to run on the trial credit; if MYT-43 picks a priority that lets paid credits be consumed first, trial-mode never lands for the user, and the trial credit just sits in the ledger forever (or expires unused if we ever add expiry). This invariant is pinned in MYT-42 because the credit is shipped here; MYT-43 must honor it.

## 8. Trial credit at registration

The MYT-38 register handler today calls `users.create(...)` against the connection pool with no explicit transaction — there is no existing `BEGIN`/`COMMIT` to extend. MYT-42 refactors the register flow to open a transaction explicitly, then composes the trial-credit grant inside it.

**Refactor:**

1. `repo.users.create(client, params)` now accepts a `ClientLike` (per §7.5). The route handler acquires a `PoolClient` via `pool.connect()` and runs `BEGIN`/`COMMIT` itself. The shipped `users.create` (single `pool.query` INSERT) is updated to take the client and run on it instead.
2. **`classifyProfanity` LLM calls remain BEFORE `BEGIN`** (per Sphinx I2 round 2): the existing MYT-38 register handler runs `classifyProfanity(username)` and `classifyProfanity(displayName)` before creating the users row. These are Haiku calls (200–800ms typical). They MUST stay outside the transaction — holding a `PoolClient` open during a 200ms+ LLM call exhausts the pool under sustained register traffic (`max=10`). The 23505 fallback paths from the shipped handler (username taken, already onboarded, inconsistent state) also stay outside the transaction; if any fires, no transaction was opened so there is nothing to ROLLBACK.
3. The route handler calls, in order:
   - `await classifyProfanity(username)` — outside any tx.
   - `await classifyProfanity(displayName)` — outside any tx.
   - `await client.query('BEGIN')`
   - `const user = await repo.users.create(client, params)` — creates the users row (without `free_trial_used`).
   - `await repo.credits.grantInTx(client, { userId: user.id, creditType: 'session', amount: 1, sourceType: 'trial', sourceId: null, expiresAt: null })` — uses `grantInTx` (the new transaction-following entrypoint per §7.6, NOT the connection-acquiring `grant`). Per Hydra C1 round 2: `grant` opens its own connection and BEGIN/COMMIT, which would commit the route's transaction prematurely if called from inside it.
   - `await client.query('UPDATE users SET free_trial_used = true WHERE id = $1', [user.id])`
   - `await client.query('COMMIT')` (or ROLLBACK on error inside a try/catch/finally that always releases the client).
4. The handler re-reads `user` (or stitches `free_trial_used = true` into the response shape) so the `POST /api/users/register` body reflects the post-COMMIT state. Florin I4 in round 1 noted this gap.

**Why all in one transaction:** if the credit_ledger INSERT fails (CHECK violation, concurrent constraint deadlock, anything), the users row must roll back too — otherwise we'd have an "onboarded user with no trial credit + flag set" stuck state that the existing-user-check code path can't recover from (re-registration is short-circuited, so the user can never get their trial). Single transaction is the only correct shape.

The trial credit is structurally a `credit_type='session'` row — it goes through the same atomic-debit recipe as any session credit. The `source_type='trial'` marker is the signal MYT-43 reads to apply trial-session limits when it picks the consumption-priority order.

`source_id = NULL` and `expires_at = NULL`: the trial isn't tied to a purchase or invoice; it doesn't expire on a billing cycle. The MYT-40 schema tolerates `source_id = NULL` only for non-debit rows (the CHECK constraint is `(source_type <> 'debit' OR source_id IS NOT NULL)` — trial source_type satisfies this).

`free_trial_used = true` is set at registration, not on consumption. The flag's purpose is "prevent a second trial from ever being granted to this user." If an existing user re-registers (same Cognito sub, somehow), the existing-user check fires earlier and the second registration short-circuits — so this code path runs at most once per `users.id`.

Test additions to `backend/src/__tests__/onboarding.test.ts`:
- After successful register, the response body has `free_trial_used: true`.
- After successful register, exactly one `credit_ledger` row exists for the user with `credit_type='session'`, `amount=1`, `source_type='trial'`, `source_id=NULL`, `expires_at=NULL`.
- Re-registration short-circuit (existing path) does NOT add a second trial credit row.
- A failed credit_ledger insert (simulated via temporary CHECK violation or mocked error) ROLLS BACK the users row — neither row exists post-failure.

## 9. Customer-create lifecycle

`backend/src/billing/customer.ts`:

```ts
export async function createStripeCustomer(
  stripe: Stripe,
  userId: string,
): Promise<string> {
  // No `email` field: users.email was dropped in migration 005. Omitting it
  // also keeps the customers.create call's parameter set deterministic, which
  // matters for the idempotency-key. Adding email later (e.g., backfill from
  // Cognito) would change the parameter set and the same idempotency key would
  // start returning idempotency_key_in_use errors — at that point we change
  // the key to a new namespace (e.g., `customer_v2_for_${userId}`).
  const customer = await stripe.customers.create(
    { metadata: { userId } },
    { idempotencyKey: `customer_for_${userId}` },
  )
  return customer.id
}
```

`repo.users.findOrCreateStripeCustomer(pool, userId)` — uses **prefetch-then-write** (NOT a single tx held through the Stripe call), per Stilton I9 round 3 / Hydra I2 round 2 (the round-2 fix attempted to address this for webhook handlers but missed this surface):

```ts
async function findOrCreateStripeCustomer(pool: Pool, userId: string): Promise<string> {
  // Phase 1 — short tx: read existing value; release immediately.
  const phase1 = await pool.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [userId],
  )
  if (phase1.rows.length === 0) {
    throw new Error(`findOrCreateStripeCustomer: users row not found for userId=${userId}`)
  }
  if (phase1.rows[0].stripe_customer_id) return phase1.rows[0].stripe_customer_id

  // Phase 2 — outside any DB tx: Stripe API call. Idempotency-keyed, so concurrent
  // callers all hit the same Stripe-side customer record (Stripe's idempotency cache
  // dedupes within 24h); the DB-side write phase below picks one canonical winner.
  const cusId = await createStripeCustomer(stripeClient, userId)

  // Phase 3 — short tx: serialized write with FOR UPDATE to handle concurrent racers.
  // The lock is held only across two short DB ops (re-read + UPDATE); no Stripe call
  // happens inside this tx, so MYT-40's full timeout discipline applies — per Petra
  // C3 round 5, all three SET LOCALs (transaction_isolation + lock_timeout +
  // statement_timeout) MUST be set, identical to MYT-40's atomicDebit recipe.
  // Pinning isolation removes a TOCTOU hole if the connection-pool default ever
  // drifts (e.g., a future SET SESSION transaction_isolation = 'repeatable read').
  const client = await pool.connect()
  try {
    await client.query("BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'")
    const phase3 = await client.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    )
    const racewinner = phase3.rows[0]?.stripe_customer_id
    if (racewinner) {
      // A concurrent caller wrote first within Stripe's 24h idempotency window
      // they got the same cus_*. Use the persisted one.
      await client.query('COMMIT')
      return racewinner
    }
    await client.query(
      `UPDATE users SET stripe_customer_id = $2 WHERE id = $1`,
      [userId, cusId],
    )
    await client.query('COMMIT')
    return cusId
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

Why prefetch-then-write: round 2's "FOR UPDATE through the Stripe call" shape held the user-row lock for the duration of `customers.create` — 100–500ms typical, multi-second tail under Stripe outage. Combined with MYT-40's `lock_timeout='1s'` discipline, any concurrent atomic-debit on the same user (session-start) would fail with a confusing `DebitTimeoutError` for what's actually a Stripe-side latency. The prefetch-then-write pattern releases the lock during the Stripe call; the lock is held only across two short DB queries.

Concurrent-caller handling: two parallel callers for the same userId both hit Phase 1 (no lock), both see NULL, both call Stripe. Stripe's idempotency-key (`customer_for_${userId}`) returns the SAME `cus_*` to both. Phase 3's FOR UPDATE serializes them: first racer's UPDATE wins; second racer's Phase-3 SELECT sees the now-populated value (the racewinner branch) and returns it. Net: at most one row state per user, at most one Stripe customer per user.

Why the idempotency-key strategy: Stripe's `customers.create` accepts an idempotency-key header that returns the same Customer object across retries within 24h, **provided the request parameters match exactly**. `customer_for_${userId}` is deterministic and the parameters are `{ metadata: { userId } }` only. The 24h window is sufficient for our concurrent-callers race (which resolves in milliseconds). Outside 24h: the first call after that window creates a new Stripe customer; if our Phase-3 already wrote a value, we never reach the Stripe call again, so the orphan-customer-after-24h vector is closed by the `if (phase1.rows[0].stripe_customer_id) return` short-circuit at Phase 1.

## 10. SKU listing cache

`backend/src/billing/sku-cache.ts`:

```ts
// Internal cache entry — INCLUDES stripe_price_id for the webhook reverse-map.
// Used by handlers, NEVER serialized to a public response.
export interface SkuInternalEntry {
  readonly lookup_key: LookupKey
  readonly stripe_price_id: string  // e.g. price_1ABCxyz — internal-only
  readonly displayName: string
  readonly type: 'recurring' | 'one_time'
  readonly sessionsGranted: number
  readonly worldsGranted: number
  readonly price: { unit_amount_cents: number; currency: string }
}

// Public projection — EXCLUDES stripe_price_id. This is the type the
// /api/billing/skus route serializes. Per Stilton I7 round 3: principle of
// least disclosure on a public unauthenticated endpoint; the Stripe price ID
// has no business in a marketing/pricing-page payload.
export interface SkuPublicListing {
  readonly lookup_key: LookupKey
  readonly displayName: string
  readonly type: 'recurring' | 'one_time'
  readonly sessionsGranted: number
  readonly worldsGranted: number
  readonly price: { unit_amount_cents: number; currency: string }
}

interface SkuCache {
  readonly byLookupKey: ReadonlyMap<LookupKey, SkuInternalEntry>
  readonly byPriceId: ReadonlyMap<string, SkuInternalEntry>  // reverse lookup, used by webhook handlers
  readonly publicListing: readonly SkuPublicListing[]        // serialization-friendly array view; excludes stripe_price_id
}

let cache: SkuCache | null = null

export function setSkuCache(snapshot: SkuCache): void {
  cache = snapshot
}

export function getSkuCache(): SkuCache | null {
  return cache
}
```

The reverse map (`byPriceId`) is required by webhook handlers that need to resolve a Stripe-returned `price.id` (e.g., `invoice.lines.data[i].pricing.price_details.price`) back to a `lookup_key` and `LookupKeySpec`. At dahlia, the lookup_key is no longer present on invoice line objects — see §3.1 note 2.

Populated by `probe.ts` after a successful probe pass — the probe already fetched every Stripe price (`stripe.prices.list({ lookup_keys, expand: ['data.product'] })`); building the snapshot is mechanical:

```ts
// at the end of probeStripeContract, after mismatches.length === 0:
const publicListing: SkuPublicListing[] = []
const byLookupKey = new Map<LookupKey, SkuInternalEntry>()
const byPriceId = new Map<string, SkuInternalEntry>()
for (const [lookup_key, spec] of Object.entries(LOOKUP_KEYS)) {
  const price = byLookup.get(lookup_key)!  // probe asserted presence
  const internal: SkuInternalEntry = {
    lookup_key: lookup_key as LookupKey,
    stripe_price_id: price.id,
    displayName: spec.displayName,
    type: spec.type,
    sessionsGranted: spec.sessionsGranted,
    worldsGranted: spec.worldsGranted,
    price: { unit_amount_cents: price.unit_amount!, currency: price.currency },
  }
  byLookupKey.set(internal.lookup_key, internal)
  byPriceId.set(internal.stripe_price_id, internal)
  // Public projection: omit stripe_price_id explicitly via a TS-rest pattern.
  const { stripe_price_id: _omit, ...publicEntry } = internal
  publicListing.push(publicEntry)
}
setSkuCache({ byLookupKey, byPriceId, publicListing })
```

`GET /api/billing/skus` reads `cache.publicListing` and returns it. Cache miss → 503 (defensive only; the probe gates boot, so any request reaching this endpoint has a populated cache). Response sets `Cache-Control: public, max-age=300` and `Vary: Authorization`.

The `SkuPublicListing` interface explicitly omits `stripe_price_id` (per Stilton I7 round 3) — internal Stripe identifiers do not leak through the public endpoint. A typecheck assertion in §13 enforces both (a) `SkuPublicListing` does NOT have `stripe_price_id`, (b) `SkuPublicListing` has no field whose name matches `userId|email|tenant|internal|env|secret`.

Cache is process-scoped; refreshes only on next deploy (which re-runs the probe). This is the right grain because the probe is the contract — prices changing without a deploy is a violation of the MYT-41 design.

## 11. History endpoint

`GET /api/billing/history?cursor=<token>` returns the user's `billing_history` rows (the unified audit feed). The `billing_history` table is defined in §6 — populated by `checkout.session.completed`, `invoice.paid`, and `refund.created` handlers alongside their primary writes inside the same transaction as `stripe_events.event_id`. We don't mirror Stripe invoices into Postgres on demand; the webhook is the canonical write path. This trades a small write at webhook time for a fast, cursor-pageable read.

Cursor wire format: `cursor = base64url(JSON.stringify({ t: occurred_at_iso, i: id }))`. The next page is `WHERE (occurred_at, id) < (cursor.t, cursor.i)` ordered `occurred_at DESC, id DESC`. Page size 50.

Query:

```sql
SELECT * FROM billing_history
WHERE user_id = $1
  AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2, $3::uuid))
ORDER BY occurred_at DESC, id DESC
LIMIT $4 + 1;  -- fetch one extra to derive nextCursor
```

If the query returns 51 rows, the response includes the FIRST 50 rows and sets `nextCursor` from the **50th row's** `(occurred_at, id)`. The 51st row is fetched only to detect that a next page exists (it is NOT the cursor source). If 50 or fewer rows return, `nextCursor` is `null`. Per Stilton I3 round 3: this matches §4.1's "encodes the LAST row of the current page" definition; the prior round-2 prose that said "from the 51st row's" was off by one and would have produced page-2 queries that included the cursor row itself (duplicate).

`occurred_at` is Stripe's event timestamp at full precision. `id` is `billing_history.id UUID` (UUIDv7), unique table-wide so ties on `occurred_at` resolve deterministically by id.

## 12. Errors + edge cases

The closed set of error codes lives in `backend/src/billing/errors.ts` exporting a `BillingErrorCode` union type. All 4xx responses use the envelope `{ code: 'snake_case', ...optional_detail }`.

### 12.1 BillingErrorCode union (normative)

```ts
export type BillingErrorCode =
  | 'body_invalid'              // Zod schema rejected body
  | 'mixed_cart'                // tier + à-la-carte in same cart
  | 'tier_cart_shape'           // tier with items.length > 1 OR quantity > 1
  | 'duplicate_lookup_key'      // same lookup_key listed twice in items[]
  | 'unknown_lookup_key'        // lookup_key not in LOOKUP_KEYS
  | 'no_active_subscription'    // /upgrade-tier called by user with no active sub
  | 'tier_unchanged'            // /upgrade-tier target_tier === current tier
  | 'not_an_upgrade'            // /upgrade-tier target_tier price <= current
  | 'invalid_cursor'            // /history cursor failed base64url/JSON decode
  | 'stripe_unavailable'        // Stripe API call returned 5xx or timed out
  | 'missing_signature'         // /webhooks/stripe missing Stripe-Signature header
  | 'invalid_signature'         // /webhooks/stripe constructEvent failed

// Closed enum. Adding a code requires updating this type, the §12 table, and any
// route handler that emits it. The §13 routes test asserts every emit-site uses
// a code that's in this union.
```

### 12.2 Scenarios

| Scenario | Response |
|---|---|
| Checkout body invalid (Zod) | 400 with field-level detail; code `body_invalid` |
| Mixed tier + à-la-carte cart | 400 `{ code: 'mixed_cart' }` |
| Tier with quantity > 1 or items.length > 1 | 400 `{ code: 'tier_cart_shape' }` |
| Duplicate lookup_key in cart | 400 `{ code: 'duplicate_lookup_key' }` |
| Unknown lookup_key | 400 `{ code: 'unknown_lookup_key' }` |
| `/upgrade-tier` for user with no active subscription | 400 `{ code: 'no_active_subscription' }` |
| `/upgrade-tier` target_tier price equal to current | 400 `{ code: 'tier_unchanged' }` |
| `/upgrade-tier` target_tier price below current (downgrade attempt) | 400 `{ code: 'not_an_upgrade' }` (downgrades go through Customer Portal) |
| `/history` cursor token malformed | 400 `{ code: 'invalid_cursor' }` |
| Stripe API error during checkout | 502 `{ code: 'stripe_unavailable' }` (logged with detail) |
| Stripe API timeout / unavailable on /upgrade-tier | 502 `{ code: 'stripe_unavailable' }` |
| User has no `stripe_customer_id` and Stripe is down at portal request | 502 `{ code: 'stripe_unavailable' }` |
| Webhook signature missing | 400 `{ code: 'missing_signature' }` |
| Webhook signature invalid | 400 `{ code: 'invalid_signature' }` |
| Webhook secret is `'PLACEHOLDER'` | All signatures invalid → 400. **Fail-closed by design.** The first action after MYT-42 ships is rotating Secrets Manager from PLACEHOLDER → the Dashboard-issued `whsec_*`. |
| Webhook `event.api_version` ≠ SDK pin | 200 + ERROR-level log `stripe_webhook_api_version_mismatch`; processing continues but Dashboard config needs an ops fix |
| Webhook event already processed (idempotent replay) | 200 (stripe_events PK ON CONFLICT DO NOTHING; ROLLBACK and exit) |
| `subscription.*`/`charge.*` event for unknown customer | 200 + INFO-level log + record event_id; non-paging |
| **`invoice.paid` with `billing_reason='subscription_cycle'` AND `amount_paid > 0` AND user lookup misses** | 200 + ERROR-level log `billing.invoice_orphan` + COMMIT (per Kraken I4 round 2: real renewal payment landed for a customer we can't resolve — paging-grade, manual reconciliation) |
| **`checkout.session.completed` with `metadata.userId` missing or unresolvable** | 200 + ERROR-level log `billing.checkout_orphan` + COMMIT (paid customer with no credits to grant; **paging-grade**, distinct from generic unknown-customer); manual reconciliation required |
| **`checkout.session.completed` `event.data.object.customer` ≠ `users[metadata.userId].stripe_customer_id`** | 200 + ERROR-level log `billing.checkout_customer_mismatch` + COMMIT (paging-grade); manual reconciliation |
| Webhook `amount_subtotal` reconstruction mismatch (per-charge validation, §5.4 cross-cutting rule 2) | 200 + ERROR-level log `billing.amount_validation_failed` + COMMIT (no credit grant; suppresses Stripe retries); manual reconciliation |
| Webhook event of unknown type | 200 + INFO-level log + record event_id |
| `refund.created` whose parent Charge has `amount_refunded < amount_captured` (partial refund) | 200 + ERROR-level log `billing.partial_refund_unsupported` + COMMIT (no clawback per Decision 5; manual reconciliation; operator instructed to refund full charges only) |
| Refund on an invoice/charge that doesn't map to any local row | 200 + WARN-level log; no clawback (we have nothing to debit) |
| Refund makes balance negative | Allowed; atomic-debit at session-start returns 402 until balance is positive |
| Refund arrives mid-session (after debit but before session ends) | The in-flight debit is unaffected; the session completes normally; the negative balance gates only the *next* session-start. The 402 response includes `available: <negative number>` so the frontend can show "you need to purchase N credits to lift your balance to positive" |
| Refund against credits that already expired | Clawback row inserts with `expires_at = NULL` (per migration 004 polarity invariant) and contributes negatively to balance indefinitely; the originating grant has expired and no longer contributes positively. Net: balance moves down by the clawback amount until purchases offset it. |
| Concurrent refund + session-start | credit_ledger / users FOR UPDATE locks serialize; refund completes first or session-start consumes pre-refund credits, never both |
| Concurrent checkout calls before customer exists | `findOrCreateStripeCustomer` FOR UPDATE on users.id serializes; only the first racer reaches the Stripe API. Stripe idempotency-key dedupes Stripe-side as a belt-and-suspenders defense |
| Subscription event arrives before checkout.session.completed (out-of-order delivery) | All three handlers (`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`) call the same `upsertFromStripe` (single ON CONFLICT DO UPDATE statement); any arrival order converges to one row, with stale-event ordering rejected by `WHERE excluded.stripe_event_created_at > existing.stripe_event_created_at` |
| `users.stripe_customer_id` row not found for a `customer.subscription.*` event | 200 + log + try `subscription.metadata.userId` fallback; total miss → log + record event_id (Stripe-side test event for an orphan customer) |
| **`invoice.paid` with `billing_reason='subscription_create'`** (Decision 1: invoice.paid is single source of truth) | Grant first-month credits via `repo.credits.grantInTx`; record `billing_history` row. `upsertFromStripe` first if no `user_subscriptions` row exists yet (covers race against `customer.subscription.created`). |
| **`invoice.paid` with `billing_reason='subscription_update'`** (Decision 2: tier upgrade via `/api/billing/upgrade-tier`) | Read OLD tier via `getActiveForUser` BEFORE upserting; compute credit DELTA `(target_spec - old_spec)`; assert `subtotal === flat_dollar_delta`; upsert `user_subscriptions` to new tier; grant DELTA credits with `expires_at = period_end + tier_period_length` (extended life); record `billing_history` row with `kind='invoice'`. |
| `invoice.paid` with other `billing_reason` (`manual`, `quote_accept`, `subscription_threshold`, etc.) | Record `billing_history` row only; no credit grant (per Chimera M7 round 2: explicit allowlist defends against admin-issued Dashboard invoices accidentally granting credits) |
| `invoice.paid` with negative or zero amount | Skip credit grant; skip amount validation; record `billing_history` row |
| `customer.subscription.updated` schedules a downgrade for next period (Stripe Subscription Schedule fired by Customer Portal `schedule_at_period_end.conditions=[{type:'decreasing_item_amount'}]`) | UPDATE `user_subscriptions` row with CURRENT (still-active) tier_lookup_key; the actual tier change fires at period_end as a separate `customer.subscription.updated` event when the Subscription Schedule activates the new phase. |
| `customer.subscription.deleted` with `cancellation_details.reason='cancellation_requested'` (user clicked Cancel) | UPDATE `status='canceled'`; PRESERVE `cancel_at_period_end` (don't collapse); record `cancellation_details` for analytics. Existing credits stay until natural expiry. |
| `customer.subscription.deleted` with `cancellation_details.reason='payment_failed'` (Stripe canceled for non-payment) | Same write path as above. Existing credits remain consumable through `current_period_end` because the user paid for the period that's still active. The next period's renewal didn't go through; no new grant fires. |
| Concurrent `customer.subscription.updated` and `checkout.session.completed` for same subscription | `upsertFromStripe`'s ON CONFLICT DO UPDATE is atomic; both transactions converge to a single row reflecting the most recent event |
| Operator manually pastes `cus_*` into `users.stripe_customer_id` mid-checkout | `findOrCreateStripeCustomer`'s FOR UPDATE serializes the lock against operator INSERTs; either the operator wins (subsequent checkout reads the manual value and uses it) or the lock holder wins (operator INSERT blocks until the lock releases). 23505 cannot occur because the FOR UPDATE happens before the UPDATE |
| `/api/billing/upgrade-tier` with target tier price equal to current | 400 `{ code: 'tier_unchanged' }`. No Stripe call. |
| `/api/billing/upgrade-tier` with target tier price below current (downgrade attempt) | 400 `{ code: 'not_an_upgrade' }`. Downgrades go through Customer Portal Switch Plan. |
| `/api/billing/upgrade-tier` for user with no active subscription | 400 `{ code: 'no_active_subscription' }`. User must subscribe first via `/api/billing/checkout`. |
| `/api/billing/upgrade-tier` Stripe `subscriptions.update` returns auth-required error (SCA challenge on the saved card) | 502 `{ code: 'stripe_unavailable' }` for now; the user can retry from the upgrade flow. (Future: surface SCA challenge URL through a 3DS-handoff response — follow-up bead.) |
| Public route registered with `auth: 'public'` outside the boot-time allowlist | Boot fails with `'auth: public used on non-allowlisted route: <route>'`. Per Sphinx C3 round 2 / Stilton C2 round 3 defense-in-depth. |

## 13. Testing

**Unit / integration**:

- `backend/src/billing/__tests__/webhook.test.ts` — per-event-type fixtures and assertions:
  - **Prefetch-then-write split**: handlers receive prefetched Stripe state (mocked); the handler's tx body never references the Stripe SDK. A test asserts that mocking `stripe` to throw on any method call doesn't break a handler whose prefetch succeeded.
  - `checkout.session.completed` mode='payment' multi-line cart: 3 line items → 3 `purchases` rows sharing one `payment_intent` (verifies the composite UNIQUE), one `billing_history` row, three `credit_ledger` rows with `source_purchase_id` set. Re-replay of the same `event.id`: no second writes (idempotency).
  - `checkout.session.completed` mode='subscription' (Decision 1: NO credit grant): one `user_subscriptions` row (status from Stripe, e.g., `'active'` or `'incomplete'`), one `billing_history` row for the invoice, **zero `credit_ledger` rows**. Subsequent `invoice.paid` produces the credits.
  - `checkout.session.completed` `metadata.userId` missing → ERROR-level `billing.checkout_orphan`, no writes other than `stripe_events`, returns 200.
  - `checkout.session.completed` `event.data.object.customer` ≠ `users[metadata.userId].stripe_customer_id` → ERROR-level `billing.checkout_customer_mismatch`, no writes other than `stripe_events`.
  - `checkout.session.completed` reconstructed `expected_subtotal ≠ amount_subtotal` → ERROR-level `billing.amount_validation_failed`, no credit grant.
  - `checkout.session.completed` `payment_method_types: ['card', 'link']` is what the test fixture's Stripe `checkout.sessions.create` mock expects (Decision 3 lock).
  - `invoice.paid` `billing_reason='subscription_create'` (Decision 1: GRANTS first-month credits): per-credit_type rows with `source_type='subscription'`, `source_billing_history_id` set, `expires_at = period_end`. `upsertFromStripe` first if no `user_subscriptions` row exists; otherwise UPDATE.
  - `invoice.paid` `billing_reason='subscription_cycle'`: per-credit_type rows; `expires_at = period_end`.
  - `invoice.paid` `billing_reason='subscription_update'` (Decision 2: tier upgrade): asserts `subtotal === flat_dollar_delta` (computed from SKU cache for old + new tier); inserts DELTA credits with `expires_at = period_end + tier_period_length`; `user_subscriptions` upserted to new tier; OLD tier read BEFORE the upsert (regression: ensure handler reads old tier before overwriting).
  - `invoice.paid` `billing_reason='manual'` or `'quote_accept'` etc.: `billing_history` row only; no credit grant (allowlist).
  - `invoice.paid` for unknown customer with `amount_paid > 0` and `billing_reason='subscription_cycle'` → ERROR-level `billing.invoice_orphan`, paging-grade.
  - `customer.subscription.created` arrives BEFORE `checkout.session.completed`: upsert produces row; subsequent checkout.session.completed `upsertFromStripe` is no-op or UPDATE depending on event timestamps.
  - `customer.subscription.updated` arrives twice in different orders: stale-event ordering rejected via `WHERE excluded.stripe_event_created_at > existing.stripe_event_created_at` (note: strict `>`, not `>=` — same-second distinct events converge to one).
  - `customer.subscription.deleted` PRESERVES `cancel_at_period_end` from event payload (Kraken C3 round 2: doesn't collapse to false); records `cancellation_details`; existing credit_ledger rows untouched.
  - `refund.created` whose parent Charge has `amount_refunded < amount_captured` (partial refund) → ERROR-level `billing.partial_refund_unsupported`, no clawback (Decision 5).
  - `refund.created` full refund for à-la-carte: queries credit_ledger via `source_purchase_id` FK, calls `recordClawback` for each grant row → debit rows with `source_type='debit'`, `amount = -original.amount`, `source_id = original.id`, **`expires_at = NULL`** (regression: Kraken I8 round 2 — verify CHECK constraint `credit_ledger_debit_no_expiry_chk` is satisfied), updates `purchases.status='refunded'`, appends `billing_history` row with `kind='refund'`. **Test fixture sets `event.data.object.id = 're_*'` and the handler asserts `billing_history.source_id_stripe === event.data.object.id`** (regression: Carthage C3 / Persepolis C3 round 4 — refund_id derivation is now unambiguous because the event payload IS the Refund).
  - `refund.created` full refund for subscription invoice: prefetch resolves PI → invoice_id via `stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: refund.payment_intent } })` (per §3.1 note 6 — `Charge.invoice` was removed at basil, this is the dahlia-correct resolution direction); handler queries `billing_history` by `source_id_stripe = invoice_id`, then queries `credit_ledger` by `source_billing_history_id = bh.id`, calls `recordClawback` per row. **Regression**: a fixture asserts the prefetch does NOT call `stripe.charges.retrieve(charge_id).invoice` (which would return undefined at dahlia and break the chain).
  - `refund.created` with `payment_intent: null` (legacy non-PI charge refund): log + commit + 200; no writes.
  - `refund.created` whose parent invoice resolution returns `invoice.parent.type !== 'subscription_details'` (e.g., a manually-created invoice in the Dashboard): log + commit + 200; falls through to "neither matches" branch.
  - Unknown event type: 200 + log + `stripe_events` row recorded.
  - Signature missing → 400 `{ code: 'missing_signature' }`.
  - Signature invalid → 400 `{ code: 'invalid_signature' }`.
  - Webhook secret = `'PLACEHOLDER'`: every event returns 400 (fail-closed).
  - `event.api_version` ≠ SDK pin: ERROR-level log, processing continues.

- `backend/src/billing/__tests__/upgrade.test.ts` — `/api/billing/upgrade-tier`:
  - Happy path Wayfarer→Mythwright: calls `subscriptions.update` with `proration_date=current_period_start`, `proration_behavior='always_invoice'`, returns `{ invoice_id, amount_paid_cents }`.
  - Validation: target_tier === current → 400 `{ code: 'tier_unchanged' }`.
  - Validation: target_tier price < current → 400 `{ code: 'not_an_upgrade' }`.
  - Validation: user has no active sub → 400 `{ code: 'no_active_subscription' }`.
  - Stripe API error → 502 `{ code: 'stripe_unavailable' }`.

- `backend/src/billing/__tests__/customer.test.ts` — `findOrCreateStripeCustomer`:
  - Happy path: row has `stripe_customer_id=NULL`, helper calls Stripe, UPDATE succeeds, returns the new `cus_*`.
  - Idempotent re-call: row already has `cus_*`; helper returns it without calling Stripe.
  - Concurrent calls (simulated via two parallel transactions): FOR UPDATE serializes; only one Stripe call; both return the same `cus_*`.

- `backend/src/billing/__tests__/sku-cache.test.ts`:
  - `setSkuCache` + `getSkuCache` round-trip preserves `byLookupKey`, `byPriceId`, and `listing`.
  - `byPriceId` reverse map populated correctly from probe data.
  - `SkuPublicListing` type assertion: a const test that fails to compile if `SkuPublicListing` ever gains a field named `stripe_price_id` OR a field whose name matches `userId|email|tenant|internal|env|secret`. Defends the public-projection invariant per Stilton I7 round 3.

- `backend/src/repo/__tests__/purchases.test.ts`:
  - Insert two rows with same `stripe_payment_intent_id` and DIFFERENT `lookup_key`: succeeds (composite UNIQUE).
  - Insert two rows with same `(stripe_payment_intent_id, lookup_key)`: 23505 (composite UNIQUE).
  - `getByPaymentIntent` returns multi-line array.
  - `markRefunded(purchaseId)` flips status without affecting siblings sharing the PI.

- `backend/src/repo/__tests__/user-subscriptions.test.ts`:
  - `upsertFromStripe` insert path.
  - `upsertFromStripe` update path.
  - `upsertFromStripe` stale-event rejection (older `stripe_event_created_at` doesn't overwrite — strict `>` not `>=`).
  - `getActiveForUser` excludes `status IN ('canceled','incomplete_expired')`.
  - `markCanceled` sets status + records `cancellation_details`; `cancel_at_period_end` PRESERVED from payload.
  - Concurrent upserts: two parallel transactions both calling `upsertFromStripe` for the same `stripe_subscription_id` produce exactly one row (atomic ON CONFLICT DO UPDATE).

- `backend/src/repo/__tests__/stripe-events.test.ts`:
  - `recordOrSkip` first call returns `'inserted'`.
  - Second call with same `event_id` returns `'duplicate'`.
  - Tx rollback after `'inserted'` → next call sees `'inserted'` again (durability conditional on commit).

- `backend/src/repo/__tests__/billing-history.test.ts`:
  - `append` for each kind, with the prefix-by-kind CHECK enforced (e.g., `kind='purchase'` requires source_id_stripe LIKE 'pi_%'; mismatched prefix → CHECK violation).
  - `findBySourceStripeId` returns the matching row by `source_id_stripe`.
  - `listByUser` cursor pagination with ties on `occurred_at` resolves by `id` deterministically.

- `backend/src/repo/__tests__/credits.test.ts`:
  - `grant(input)` (no tx, MYT-40 backwards-compat) opens its own connection + tx and commits.
  - `grantInTx(tx, input)` runs against a passed-in tx; rollback of that tx rolls back the credit_ledger row.
  - `grant` rejects `amount <= 0` and `sourceType='debit'` (regression).
  - `recordClawback(tx, ...)` accepts negative amount + `'debit'` source_type + non-null source_id; rejects positive amount or null source_id; rejects non-null `expires_at` (regression: migration 004 `credit_ledger_debit_no_expiry_chk`).
  - Polymorphic source link (Decision 4): grants have exactly one of `source_purchase_id` / `source_billing_history_id` non-null; setting both raises `credit_ledger_source_link_chk` violation; debit + trial rows have neither set.
  - **No `consumedSourceType` test** (deferred to MYT-43); existing `atomicDebit` tests stand.

- `backend/src/repo/__tests__/users.test.ts`:
  - `create(tx, ...)` accepts a transaction handle.
  - `findOrCreateStripeCustomer(tx, userId)` happy + concurrent paths (above).

- `backend/src/routes/__tests__/billing.test.ts`:
  - Each route: auth contract (JWT-required vs public), body validation, response shape.
  - Cart-shape rules: mixed cart, tier with quantity > 1, duplicate lookup_key, unknown lookup_key, empty array, max-100 array.
  - History endpoint cursor round-trip: page 1 → cursor → page 2; concatenation matches a flat fetch. Malformed cursor → 400 `{ code: 'invalid_cursor' }`.
  - SKU listing endpoint: response is `cache.publicListing` (NOT `cache.byLookupKey` — the public projection excludes `stripe_price_id`); sets `Cache-Control: public, max-age=300` + `Vary: Authorization`. Test asserts the response body contains no `stripe_price_id` field on any item.
  - Error-code enum: every emitted code is a member of the `BillingErrorCode` union (regression: a const TS check enforces this at compile time).

- `backend/src/routes/__tests__/webhook.test.ts`:
  - **Raw-body parser is encapsulation-scoped** — a sibling JSON route (e.g., `/api/users/register`) still receives a parsed object, NOT a Buffer.
  - The webhook handler receives the Buffer for `Content-Type: application/json`.
  - The webhook handler receives the Buffer for `Content-Type: application/json; charset=utf-8` (charset-suffix variant).
  - **Webhook plugin contains exactly one route** (regression: import `webhookRoutes`, register against an empty Fastify, walk `app.printRoutes()`, assert exactly one route at `POST /webhooks/stripe`). Sphinx C1/M6 round 2.
  - Rate limit: 1501st request from same IP within 1 minute → 429.

- `backend/src/__tests__/onboarding.test.ts` — extended for §8:
  - After register: response includes `free_trial_used: true`.
  - After register: exactly one credit_ledger row with `source_type='trial'`, `amount=1`, `expires_at=NULL`, `source_id=NULL`, `source_purchase_id=NULL`, `source_billing_history_id=NULL`.
  - Re-registration short-circuit: no second trial credit row.
  - Failed credit_ledger insert (mocked): users row also rolled back (single transaction).
  - `classifyProfanity` runs BEFORE `BEGIN` (regression: a profanity-classified-as-offensive response returns 422 with NO `pool.connect()` having been called — i.e., no transaction was opened).

- `backend/src/__tests__/probe-portal-config.test.ts` (new): boot probe asserts Customer Portal config has `proration_behavior='create_prorations'` AND `schedule_at_period_end.conditions` contains `{type:'decreasing_item_amount'}` AND each tier's `subscription_update.products` allowlist is downgrade-only. Probe failure → boot abort.

- `backend/src/__tests__/public-route-allowlist.test.ts` (new): boot-time allowlist for `auth: 'public'` routes. Test that registering a route with `config: { auth: 'public' }` outside the allowlist causes `app.ready()` to throw at boot.

**Schema parity**: `backend/src/db/__tests__/migrate-schema.test.ts` updated for migration 007 (purchases, user_subscriptions, billing_history; their indexes; their check constraints including the user_subscriptions period-monotonicity CHECK; their FKs).

**Webhook presence test (replaces the absence test)**: MYT-41's `backend/src/__tests__/webhook-absence.test.ts` is renamed to `webhook-presence.test.ts` and asserts:
- `POST /webhooks/stripe` with no signature returns 400 (route is registered).
- `POST /webhooks/stripe` with an invalid signature returns 400.
The "route exists" tripwire is preserved; the "route does NOT exist" tripwire is appropriately retired.

## 14. Spec patches to other docs

**MYT-41 spec patches** (`docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md`):
- §"Per-event-type resolution rules" — **reverse** the original "checkout.session.completed grants first-month, invoice.paid skips subscription_create" contract (per Decision 1 of round-2 review). New canonical rule: `invoice.paid` is the single source of truth for subscription credit grants for ALL `billing_reason` values that grant credits (`subscription_create`, `subscription_cycle`, `subscription_update`); `checkout.session.completed` for subscription mode writes ONLY the `user_subscriptions` row — NO credit grant AND NO `billing_history` row (per §5.4.1 + Manchego M2 round 3 + Persepolis C1 round 4: the invoice's `billing_history` row is owned by `invoice.paid`; concurrent INSERT from both handlers would 23505 on `(source_id_stripe = invoice_id, kind='invoice')` UNIQUE). Rationale: handles SCA-pending and any future delayed-confirm path uniformly; eliminates the dedup gap when SCA completes.
- §"Webhook credit-grant contract for MYT-42" — add notes 1–5 from §3.1 of this spec verbatim (Stripe API at dahlia field-shape changes).
- §"Webhook credit-grant contract for MYT-42" — add `customer.subscription.created` to the Dashboard webhook event subscription list. The handler is shared with `customer.subscription.updated` (`handleSubscriptionUpsert`).
- §"Customer Portal config" — add explicit settings: `subscription_update.proration_behavior='create_prorations'`, `subscription_update.schedule_at_period_end.conditions=[{type:'decreasing_item_amount'}]`, per-tier `subscription_update.products` allowlists are downgrade-only. Per Decision 2 of round-2 review.
- §"Customer Portal config" — note that tier upgrades go through the new MYT-42 endpoint `/api/billing/upgrade-tier`, NOT through Customer Portal Switch Plan. Customer Portal Switch Plan is for downgrades (handled natively by Stripe via Subscription Schedules) + cancel + payment-method update only.
- §"Account-level Payment Methods config" — add a new subsection: at Stripe Dashboard → Settings → Payment Methods, enable Card + Link only; disable Cash App Pay, Amazon Pay, Klarna, Affirm, ACH, SEPA, etc. Apple Pay and Google Pay display toggles stay enabled (they're wallet wrappers over `card`). Per Decision 3 of round-2 review.
- §8 portal lazy-create — patch the original "409 no_billing_history" recommendation to lazy-create-on-first-portal-request per §4.4 of this spec. The fraud-vector argument is rebutted: every portal call is JWT-authenticated and rate-limited; `customers.create` is idempotent; the boundary holds without the 409 special case.
- §"Refund handling" — explicitly say negative-polarity rows use `source_type='debit'` (NOT `'refund'`), citing migration 004's polarity CHECK constraint AND the new `recordClawback` repo method. The `'refund'` source_type is reserved for positive-polarity goodwill grants per MYT-40. Add: clawback rows use `expires_at = NULL` per migration 004's `credit_ledger_debit_no_expiry_chk` (Kraken I8 round 2).

**Parent billing spec patches** (`docs/specs/2026-04-13-billing-cost-controls.md`):
- §4 (purchase flow) — refer to the unified `POST /api/billing/checkout` body shape; drop any leftover language about per-line metadata.packId.
- §5 (Stripe integration) — note the MYT-42 split: `/api/billing/checkout` for new subscriptions / new à-la-carte; `/api/billing/upgrade-tier` for tier upgrades; Customer Portal for downgrades + cancel + payment-method update.
- §7 (free trial) — refine the patched language to reflect the source_type='trial' signal MYT-42 emits and the trial-FIRST consumption invariant MYT-43 must honor.
- §10 (edge cases) — add the refund-makes-balance-negative case, the refund-against-expired-bucket case, the refund-mid-session case, the concurrent-checkout-customer-create case, the partial-refund-paging case, and the tier-upgrade-mid-period case (flat dollar delta, full credit delta, expires_at extended).

**Backend-core spec patches** (`docs/specs/2026-04-13-backend-core.md`):
- §5.2 (repo namespace listings) — restore `repo.purchases`, `repo.userSubscriptions`, `repo.stripeEvents`, and `repo.billingHistory` to the "shipped" set; remove the corresponding deferral rows from the deferral table; note that `users.create` now accepts a `ClientLike`; note the new `repo.credits.grantInTx` and `repo.credits.recordClawback` methods.
- Schema block — `purchases`, `user_subscriptions`, and `billing_history` come back with the new shape (composite UNIQUE on purchases; expanded status enum + `cancel_at` + `cancellation_details` + `stripe_event_created_at` on user_subscriptions; full billing_history table with kind/status/expires_at/occurred_at; credit_ledger gains `source_purchase_id` + `source_billing_history_id` FK columns + `credit_ledger_source_link_chk`).
- §"Caller obligations" reference — note that MYT-42 honors the "no direct INSERT into credit_ledger" rule by routing the trial grant through `repo.credits.grantInTx` and refund clawbacks through `repo.credits.recordClawback`.

**MYT-40 spec patches** (`docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md`):
- §"Repo surface" — add `grantInTx(tx, input)` and `recordClawback(tx, input)` alongside the existing `grant` + `atomicDebit`. Note that `grant` opens its own tx; `grantInTx` follows a caller-supplied tx; `recordClawback` is the only sanctioned writer of negative-polarity / `source_type='debit'` rows outside `atomicDebit`.
- §"Caller obligations" — clarify that `grant` rejects negative amounts and `'debit'` source_type, and that clawback writers MUST use `recordClawback` instead.

## 15. Operational notes

These are pre-deploy and post-deploy steps Miklos executes against the Stripe Dashboard. Sequence in `tmp/myt-42-stripe-dashboard-instructions.md` for execution.

### 15.1 Stripe Account-level Payment Methods config (Decision 3)

Dashboard → Settings → Payment Methods. Set state:
- **Card**: enabled.
- **Link**: enabled.
- **Apple Pay**: enabled (display toggle; wraps Card).
- **Google Pay**: enabled (display toggle; wraps Card).
- All other methods: **disabled**, including Cash App Pay, Amazon Pay, Klarna, Affirm, ACH Direct Debit, SEPA Direct Debit, iDEAL, Bancontact, etc.

Defense-in-depth on top of the `payment_method_types: ['card', 'link']` runtime pin in §4.3.

### 15.2 Stripe Customer Portal config (Decision 2)

Dashboard → Settings → Billing → Customer Portal. The MYT-41 runbook configured the basics (cancel, switch plan, payment method update, invoice history, branding). MYT-42 extends:

- **Subscription updates → Prorate subscription updates**: ON (`proration_behavior='create_prorations'`).
- **Subscription updates → Schedule at period end**: enable, with conditions checkbox `"When the resulting item amount would decrease"` (`schedule_at_period_end.conditions=[{type:'decreasing_item_amount'}]`). This is the asymmetric upgrade-immediate / downgrade-at-renewal behavior native to Stripe.
- **Subscription updates → Allowed plans (per tier)**: configure DOWNGRADE-only allowlists.
  - Wayfarer config: empty (Wayfarer is the smallest tier; nothing to downgrade to via Portal — only Cancel works).
  - Sojourner config: Wayfarer.
  - Mythwright config: Sojourner, Wayfarer.
- Tier upgrades go through the new MYT-42 endpoint `/api/billing/upgrade-tier`, NOT through Customer Portal Switch Plan. The frontend's "Upgrade" button calls our endpoint; the "Manage subscription" / "Switch plan" Portal flow only ever offers downgrades.

### 15.3 Webhook endpoint registration + secret rotation post-MYT-42 deploy

1. After MYT-42 deploys to staging, register the webhook endpoint in the Stripe Dashboard test-mode account: `https://dashboard.stripe.com/test/webhooks` → Add endpoint → URL `https://staging.mythrun.com/webhooks/stripe`, **API version `2026-04-22.dahlia`** (Dashboard → API version selector — MUST match the SDK's pin per §3.1 note 5; otherwise event payloads at the handler will silently shape-mismatch typed field accesses; if the dropdown does NOT list `2026-04-22.dahlia`, the account's API version baseline is older — bump it via Dashboard → Developers → API version → upgrade BEFORE creating the webhook endpoint), events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, **`refund.created`** AND **`refund.updated`** (NOT `charge.refunded` — per §3.1 note 8 + Carthage C3 / Persepolis C3 round 4: the Refund-typed payload is required to derive `refund_id` for billing_history without ambiguity. Per Carthage C1 round 6: `refund.updated` is required for the pending → succeeded async-card path; without it, refunds that start as `pending` would never trigger clawback even after Stripe transitions them to `succeeded`). We deliberately do NOT subscribe to `invoice.payment_failed` / `charge.failed` / `charge.dispute.*` / `subscription_schedule.*` at launch; those lifecycles reach us via `customer.subscription.updated` status transitions. Adding subscriptions is a Dashboard-only ops change, not a code deploy.
2. Stripe issues a `whsec_*` signing secret on creation; copy it.
3. `aws secretsmanager update-secret --secret-id mythrun/staging/stripe-webhook-secret --secret-string 'whsec_<value>'`.
4. Force a rolling deploy (`gh workflow run Deploy`) so the new secret is loaded.
5. Verify: send a test event from the Dashboard's Webhook detail page; confirm 200 + a `stripe_events` row. Note: Dashboard test events use a sentinel `event.id` — verifying with a real test purchase via Payment Link is the more thorough check.

Until step 3, every webhook returns 400 (PLACEHOLDER fails closed). Stripe queues retries with exponential backoff for ~3 days; events delivered before step 3 are lost from Stripe's perspective.

### 15.4 Boot probe parity

When MYT-42 lands, the probe still verifies the same 5 lookup_keys. The MYT-42 surface doesn't change Stripe's price catalog. The new `sku-cache` is a side effect of a successful probe pass; cache failure doesn't gate boot.

The probe gains a Customer Portal config check: read the default Portal config and assert (a) `subscription_update.proration_behavior === 'create_prorations'`, (b) `subscription_update.schedule_at_period_end.conditions` contains `{type: 'decreasing_item_amount'}`, (c) per-tier `subscription_update.products` allowlists match the downgrade-only matrix in §15.2. Probe failure → boot abort. Defends against Dashboard config drift.

### 15.5 Alarm hand-off (paging-grade webhook events)

These webhook log events are paging-grade and require CloudWatch alarms (filed as a follow-up bead alongside MYT-42, similar to `myth-billing-probe-alarm` from MYT-41 close):

- `billing.checkout_orphan` — paid checkout completed for an unresolvable `metadata.userId`; money taken, no credits granted. Manual reconciliation.
- `billing.checkout_customer_mismatch` — checkout completed for a user whose `stripe_customer_id` doesn't match the event's `customer`; possible session corruption.
- `billing.invoice_orphan` — `invoice.paid` for `subscription_cycle` with `amount_paid > 0` for an unresolvable customer (e.g., GDPR-deleted user with active sub still in Stripe). Money taken, no credits, no auto-recovery.
- `billing.amount_validation_failed` — Stripe-reported `subtotal` doesn't match server-reconstructed `expected_subtotal` from SKU cache. Possible price-mutation attempt or Stripe-side data corruption.
- `billing.partial_refund_unsupported` — Operator clicked Refund with a partial amount. Per Decision 5: clawback gated until manual reconciliation.

### 15.6 MYT-43 hand-off

MYT-43 picks up the trial-detection signal at session-start. The signal is `credit_ledger.source_type = 'trial'` on the row consumed by the atomic-debit recipe at session-start. MYT-43 decides:

- The consumption-priority order — **MUST honor the trial-FIRST invariant from §7.6** (trial credits consumed before any other source for users with both trial and paid credits, so the trial UX runs on the trial credit and not on a paid one).
- How to expose `consumedSourceType` from the atomic-debit recipe (the recipe redesign deferred from MYT-42 §7.6 lands in MYT-43).
- The session-start branching: if `consumedSourceType === 'trial'` → trial-mode session (reduced budget, demo world, time cap).

MYT-42 intentionally does NOT pick the priority order beyond pinning the trial-FIRST invariant; the rest is a session-runtime concern.

---

## Appendix: what-this-doc-is-not

This is the design for MYT-42 specifically. It is not:
- The MYT-41 spec (which sets the contract this implements). See `docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md`.
- The implementation plan (next step after this spec is approved). The plan will land at `docs/superpowers/plans/2026-05-05-myt-42-stripe-webhook-checkout.md` via the writing-plans skill.
- The parent billing spec. See `docs/specs/2026-04-13-billing-cost-controls.md` for the user-experience-level contract, which this design implements.
