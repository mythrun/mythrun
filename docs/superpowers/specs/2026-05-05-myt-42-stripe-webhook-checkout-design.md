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
- Partial refunds — full clawback only at launch; partial-refund handling is a follow-up bead. Stripe Dashboard operators should refund full charges only until partial-refund support lands.
- Mid-period tier-switch credit grants on `invoice.paid` with `billing_reason='subscription_update'` — skipped at launch (the original tier's credits remain consumable through period_end; the new tier's credits arrive at next renewal). Customer Portal Switch Plan defaults to "applies at next renewal" so this branch is rare and admin-driven; document and revisit if Customer Portal exposes a "switch plan immediately" path.
- A frontend pricing page or Buy button — backend-only; frontend lives in a later milestone.

## 3. Architecture overview

```
                     ┌──────────────────────────┐
   POST /api/users/  │ register (MYT-38, ext'd) │
   register          │  + trial credit insert   │
                     └──────────────────────────┘

   GET  /api/billing/skus            ──► public, served from boot-cache populated by MYT-41 probe
   GET  /api/billing/balance         ──► JWT, reads credit_ledger + user_subscriptions
   POST /api/billing/checkout        ──► JWT, creates Stripe Checkout Session
   POST /api/billing/portal          ──► JWT, creates Customer Portal Session
   GET  /api/billing/history         ──► JWT, cursor-paginated (purchases ∪ invoices)
   GET  /api/billing/subscription    ──► JWT, single active sub or null

   POST /webhooks/stripe             ──► public, Stripe-signed (raw body parser),
                                          dispatch table → per-event-type handler,
                                          single Postgres tx per event with
                                          stripe_events.event_id PK idempotency
```

New backend files:
- `backend/src/routes/billing.ts` — the 6 user-facing routes.
- `backend/src/routes/webhook.ts` — `POST /webhooks/stripe` route, raw-body parser scope, signature verification, dispatch into orchestrator.
- `backend/src/billing/webhook.ts` — orchestrator + per-event-type handler functions.
- `backend/src/billing/customer.ts` — `findOrCreateStripeCustomer(userId)` helper used by both checkout and portal.
- `backend/src/billing/sku-cache.ts` — boot-time cache of `LOOKUP_KEYS` + Stripe price snapshot, populated immediately after the probe passes. Exposes both forward (`lookup_key → SkuListing`) and reverse (`stripe_price_id → SkuListing`) lookups; the reverse map is required by webhook handlers since Stripe at API version `2026-04-22.dahlia` returns price IDs (not lookup keys) on `InvoiceLineItem.pricing.price_details.price`.
- `backend/src/repo/purchases.ts`, `backend/src/repo/user-subscriptions.ts`, `backend/src/repo/stripe-events.ts`, `backend/src/repo/billing-history.ts` — four new namespaces.

Patches:
- `backend/src/repo/users.ts` — `findOrCreateStripeCustomer(userId)` that wraps the customer.ts helper + the conditional UPDATE; **`create(client, ...)` refactored to accept a `ClientLike` transaction handle** so the trial-credit grant can ride in the same BEGIN.
- `backend/src/repo/credits.ts` — `grant(client, ...)` accepts a `ClientLike` transaction handle so the trial-credit grant in §8 runs inside the register transaction. **No change to `atomicDebit`** — that recipe extension was deferred to MYT-43 in round 1 of this spec's review.
- `backend/src/routes/users.ts` (MYT-38's register handler) — refactored to open `BEGIN`/`COMMIT` explicitly, call `users.create(client, ...)` + `repo.credits.grant(client, ...)` + `UPDATE users SET free_trial_used = true` + read-back the row for the response shape.
- `backend/src/billing/probe.ts` — populate `sku-cache` immediately after a successful probe (cheap; same data already fetched).
- `backend/src/server.ts` / `backend/src/app.ts` — wire the new route plugins.

### 3.1 Stripe API at dahlia — load-bearing field-shape notes

The MYT-41 spec pinned `STRIPE_API_VERSION = '2026-04-22.dahlia'`. Several Subscription / Invoice / Checkout fields the implementer might assume from older docs are NOT at the same paths in dahlia. Round 1 of this spec's review (Reviewer-Doubloon C1/C2/C3) flagged three concrete shape changes; record them here so the rest of the spec's references stay consistent:

1. **Subscription period dates** live on `subscription.items.data[i].current_period_start` and `…current_period_end`. They were removed from the top-level `Subscription` object in API version `2025-03-31.basil` and replaced with per-item period dates. Mythrun enforces single-item subscriptions at the cart-shape rule (§4.2), so `subscription.items.data[0]` is the canonical read site. Add a runtime guard that asserts `subscription.items.data.length === 1` and aborts loudly on any other count (defends against a Customer Portal misconfiguration that adds a second item).

2. **Invoice line price identification** comes from `line.pricing.price_details.price` (a price ID string, e.g. `price_xxx`). The previous `line.price.lookup_key` field was removed in `2025-03-31.basil`. Webhook handlers walking `invoice.lines.data` MUST resolve the line's lookup_key by reverse-lookup against the SKU cache (§10), NOT by reading `line.price.lookup_key`.

3. **Checkout Session line items** are NEVER present in the `checkout.session.completed` event payload at dahlia. The handler MUST always retrieve them via `stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price'] })` inside the webhook transaction. Stripe Checkout Session line items are immutable post-completion, so the retrieve is deterministic on retry — safe inside the tx.

4. **`event.data.object.customer`** is a string (the customer ID `cus_*`), not a `Customer` object, on subscription / invoice / charge events. Read it as a string. Resolve via `users.stripe_customer_id` lookup; on miss, fall back to `subscription.metadata.userId` (a UUID string set at Checkout Session creation in §4.3) before logging + 200.

5. **`event.api_version`** carries the Dashboard webhook endpoint's configured API version, NOT the SDK's pin. Dashboard webhook configuration MUST set API version to `2026-04-22.dahlia` (§15 step 1). The handler asserts `event.api_version === STRIPE_API_VERSION` at dispatch time and logs a loud error on mismatch (silent corruption of typed field access otherwise).

These notes are referenced by §5.4.1, §5.4.2, §5.4.3, §5.4.5, and §15. Implementers should re-read the dahlia API reference for any field not explicitly listed in this spec rather than assume older shapes.

## 4. Routes

### 4.1 Body shapes + auth

| Route | Auth | Body | Returns |
|---|---|---|---|
| `GET /api/billing/skus` | public (`config: { auth: 'public' }`) | — | `[{ lookup_key, displayName, type, sessionsGranted, worldsGranted, price: { unit_amount_cents, currency } }]` |
| `GET /api/billing/balance` | JWT | — | `{ balance: { session, world_gen }, tier: { lookup_key, displayName, renewsAt, cancelAtPeriodEnd } \| null }` |
| `POST /api/billing/checkout` | JWT | `{ items: [{ lookup_key, quantity }] }` | `{ checkoutUrl }` |
| `POST /api/billing/portal` | JWT | — | `{ portalUrl }` |
| `GET /api/billing/history?cursor=<token>` | JWT | — | `{ events: [{ kind: 'purchase'\|'invoice'\|'refund', id, occurredAt, amount_cents, currency, lookup_key?, status }], nextCursor: string \| null }` |
| `GET /api/billing/subscription` | JWT | — | The user's full `user_subscriptions` row enriched with `displayName`, or `null` |
| `POST /webhooks/stripe` | public | raw body (preserved via plugin-scoped `addContentTypeParser`) | `200 { received: true }` on success / 400 on signature mismatch |

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
  line_items: <items resolved via SKU cache to { price: <price_id>, quantity }>,
  customer: <findOrCreateStripeCustomer(userId)>,
  metadata: { userId },
  success_url: `${env.frontendBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${env.frontendBaseUrl}/billing/cancel`,
  // mode='subscription' only:
  subscription_data: { metadata: { userId } },  // belt + suspenders fallback for customer-id misses on .subscription.* events
}
```

`subscription_data.metadata.userId` is a fallback signal: webhook handlers (§5.4.3 / §5.4.4) resolve user via `event.data.object.customer` (the `cus_*` string) → `users.stripe_customer_id`. If that lookup misses (a Stripe-side delivery race; should be unreachable in practice because `findOrCreateStripeCustomer` writes `users.stripe_customer_id` synchronously before checkout-session-create returns), handlers fall back to `subscription.metadata.userId` before logging + 200. Without this fallback, the spec sets metadata that no handler reads — Doubloon C5 in round 1 of review flagged the inconsistency.

### 4.4 Customer Portal creation (`POST /api/billing/portal`)

```
stripe.billingPortal.sessions.create({
  customer: <findOrCreateStripeCustomer(userId)>,
  return_url: `${env.frontendBaseUrl}/account`,
})
```

Lazy-creates the customer if the user has never checked out — this lets a freshly-registered user open the portal even though they have nothing to manage. The portal will show "no active subscription"; the user can leave or browse historical invoices (which there are none of). MYT-41 spec §8 originally proposed a `409 { code: 'no_billing_history' }` for this case to avoid an enumeration vector, but the lazy-create path is no worse: every call to this endpoint is JWT-authenticated and rate-limited, and `customers.create` is idempotent on the deterministic key, so an attacker authenticated as user X can't enumerate other users' Stripe records. The lazy-create wins on UX (no special-case 409 frontend handling) without weakening the boundary. This is a deliberate change from MYT-41 §8 — see §14 spec patches.

### 4.5 SKU listing endpoint (`GET /api/billing/skus`)

Served from `sku-cache.ts` — a module-level frozen object populated immediately after a successful boot probe. The cache holds the same data the probe already fetched (`stripe.prices.list({ lookup_keys, expand: ['data.product'] })`), enriched with the `LOOKUP_KEYS` contract metadata (displayName, sessionsGranted, worldsGranted, type).

Cache is read-only after boot; refreshes only on next deploy (which re-runs the probe). Mythrun policy is "Stripe Dashboard is the source of truth, deploy releases pin to a probe-validated state" (MYT-41 spec §1) — prices changing without a deploy is a violation, so cache-on-boot is the right grain.

`SkuListing` is a strictly public projection: the type explicitly excludes user-, tenant-, or environment-leaky fields. A typecheck assertion in §13 enforces this. Response sets `Cache-Control: public, max-age=300` so CDN traffic doesn't hit the app process on burst loads. Per-IP rate limit `60/min` is added for symmetric DoS defense (the only public endpoint that lookups Stripe state).

If the SKU cache is empty (no probe pass yet — should be impossible because the probe gates boot), return 503. Defensive only.

## 5. Webhook handler

### 5.1 Route + raw-body parser

`POST /webhooks/stripe` lives in `backend/src/routes/webhook.ts`. It is **public** (`config: { auth: 'public' }`) — Stripe authenticates via signature, not JWT. The raw body parser is **encapsulation-scoped** because Fastify's default JSON parser would consume the bytes before `stripe.webhooks.constructEvent` can hash them. `addContentTypeParser` in Fastify v5 is encapsulation-scoped, NOT route-scoped — calling it on the top-level `app` makes it global and would break every other JSON route in the system. The parser must be registered inside a child plugin that registers only the webhook route:

```ts
// backend/src/routes/webhook.ts
export const webhookRoutes: FastifyPluginAsync = async (scope) => {
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

The webhook route additionally carries `rateLimit: { max: 60, timeWindow: '1 minute' }` (per-IP). Stripe's legitimate cadence is well below this; the cap exists because every webhook request does an HMAC verify + DB write and a flood would burn DB and CPU.

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

`stripe_events` already exists from migration 001 with `event_id TEXT PRIMARY KEY`. First-write-wins. Stripe retries the same event ID on transient delivery failures; the second delivery hits the conflict and exits cleanly. **Note on rollback semantics:** any handler error inside the tx (CHECK violation, FK miss, etc.) rolls back the `stripe_events` row alongside the rest of the writes. This is the correct shape for *retryable* failures (transient DB error, momentary lock contention) — Stripe redelivers, the handler tries again. **It is NOT the right shape for non-retryable bugs**: a handler that always errors burns ~3 days of Stripe retries before delivery is given up, accumulating noise in logs. Handlers must therefore be pure-DB inside the tx (no Stripe API calls, no external network calls) and the tests in §13 must cover every error branch a handler can take. A future "poison-event escape" (record `last_error` + `attempts` in `stripe_events` and stop retrying after N failed attempts) is a follow-up bead.

After successful insert into `stripe_events`, dispatch:

```ts
// Defense-in-depth: assert the Dashboard webhook endpoint API version
// matches the SDK's pin. A mismatch silently corrupts typed field access.
if (event.api_version !== STRIPE_API_VERSION) {
  request.log.error(
    { event_api_version: event.api_version, sdk_pin: STRIPE_API_VERSION, event_id: event.id },
    'stripe_webhook_api_version_mismatch — Dashboard endpoint must be set to STRIPE_API_VERSION',
  )
  // Continue processing — Stripe field shapes are usually backward-compatible within
  // a year — but the loud log triggers an ops fix.
}

const HANDLERS: Record<string, EventHandler> = {
  'checkout.session.completed':     handleCheckoutCompleted,
  'invoice.paid':                   handleInvoicePaid,
  'customer.subscription.created':  handleSubscriptionUpsert,  // upsert-shaped; same handler as .updated
  'customer.subscription.updated':  handleSubscriptionUpsert,
  'customer.subscription.deleted':  handleSubscriptionDeleted,
  'charge.refunded':                handleChargeRefunded,
}
const handler = HANDLERS[event.type]
if (handler) {
  await handler(event, tx, stripe)  // tx is the same transaction stripe_events was inserted into
} else {
  request.log.info({ event_type: event.type, event_id: event.id }, 'stripe_webhook_unknown_type')
  // tx still commits — the stripe_events row records that we acknowledged this event
}
return reply.code(200).send({ received: true })
```

The handler signature takes both the tx and the Stripe SDK because some handlers retrieve additional Stripe state (e.g., `checkout.session.completed` always retrieves `line_items` per §3.1 note 3). The retrieve is deterministic on retry (Stripe Checkout Sessions are immutable post-completion).

### 5.4 Per-event-type handlers

Two cross-cutting rules apply to every handler:

1. **`event.data.object.customer` is a string** (`cus_*`), not an object. Read it as a string. Resolve user via `users.stripe_customer_id`. On miss, fall back to `subscription.metadata.userId` (if present on the event's subscription object — set at Checkout Session creation per §4.3) before logging + 200.
2. **Per-charge `amount_total` validation** (per MYT-41 spec §"Replacing parent spec §5.5"): before granting any credits, the handler reconstructs `expected_total = sum(unit_amount * quantity)` from line-item lookup_keys + the SKU cache and asserts `expected_total === amount_total` (or `amount_paid` for invoices). Mismatch → log `billing.amount_validation_failed` at error level, do NOT grant, COMMIT the `stripe_events` row to suppress retries, return 200. This is the per-charge correctness layer that complements the boot probe.

#### 5.4.1 `checkout.session.completed`

Resolve user via `event.data.object.metadata.userId` (we set this on session create per §4.3). If `metadata.userId` doesn't resolve to a `users` row, this is a **paid-but-unknown-user** state — money taken, no credits to grant, manual reconciliation needed. Emit a paging metric `billing.checkout_orphan` at error level with all relevant IDs (`session_id`, `payment_intent`, `subscription`, `metadata.userId`, `customer`), COMMIT the `stripe_events` row (so Stripe stops retrying), return 200, and rely on the alarm to wake an operator. This case must NOT be silently swallowed under the generic "unknown customer" bucket.

**Cross-check:** assert `event.data.object.customer === users[metadata.userId].stripe_customer_id` (per MYT-41 spec §"Defense in depth on `metadata.userId`"). Mismatch → page + COMMIT + 200; the user-checkout-customer triple is corrupted and needs operator review.

**Always retrieve line_items.** The `checkout.session.completed` event payload at dahlia does NOT include `line_items` — fetch them with `stripe.checkout.sessions.retrieve(session_id, { expand: ['line_items.data.price'] })` inside the tx (deterministic on retry; sessions are immutable post-completion).

Branch on `event.data.object.payment_status` and `event.data.object.mode`:

- **Subscription mode + `payment_status === 'paid'`**: this is the success path. Retrieve the subscription via `stripe.subscriptions.retrieve(subscription_id, { expand: ['items.data.price'] })`. Assert `subscription.items.data.length === 1` (Mythrun policy; loud abort otherwise). Read the subscription's status, `items.data[0].price.lookup_key`, `items.data[0].current_period_start`, `items.data[0].current_period_end`, and `cancel_at_period_end`.
  - **Upsert** `user_subscriptions` via `repo.userSubscriptions.upsertFromStripe` (ON CONFLICT (`stripe_subscription_id`) DO UPDATE) with `status` from Stripe (NOT hardcoded `'active'` — handles SCA-pending and `incomplete` states correctly), `tier_lookup_key`, period dates, and `cancel_at_period_end`. The upsert tolerates out-of-order arrival of `customer.subscription.{created,updated}` events (which Stripe fires on the same session-create, with no guaranteed order vs. `checkout.session.completed`).
  - **Grant first-month credits** via `repo.credits.grant`: per MYT-41 contract, first-month subscription credits come from `checkout.session.completed`, not `invoice.paid`. The `invoice.paid` handler skips `billing_reason === 'subscription_create'` to avoid double-grant. Insert one credit_ledger row per `(credit_type)` — `amount = spec.sessionsGranted` for `credit_type='session'`, `amount = spec.worldsGranted` for `credit_type='world_gen'`. `source_type='subscription'`, `source_id = uuidv7()`, `expires_at = items.data[0].current_period_end`.
  - **Append billing_history** row: `kind='invoice'`, `source_id_stripe = invoice_id` from the session's invoice, `amount_cents = amount_total`, `lookup_key = items.data[0].price.lookup_key`. Used by `/api/billing/history` and by `charge.refunded` resolution.
- **Subscription mode + `payment_status !== 'paid'`** (SCA-pending, `incomplete`, etc.): upsert `user_subscriptions` with the Stripe-reported `status` (likely `incomplete`); do NOT grant credits. The subsequent `invoice.paid` (when SCA completes) is responsible for the credit grant — at that point §5.4.2 sees `billing_reason='subscription_create'` AND no prior credit grant for this subscription, and DOES grant. (The de-dup check is on `(stripe_subscription_id, billing_reason='subscription_create')` not having any existing `credit_ledger` row.)
- **Payment mode (à-la-carte)**: walk the retrieved `line_items.data`. For each line, resolve the `price.id` against the SKU cache reverse map (§10) → `lookup_key` → `LookupKeySpec`. Compute `expected_total = sum(spec.priceCents * line.quantity)` and assert `expected_total === amount_total`; mismatch → §5.4 cross-cutting rule 2 (log + COMMIT + 200, no grant). Pass:
  - **One `purchases` row per line item**: `(stripe_payment_intent_id = event.data.object.payment_intent, lookup_key, quantity, amount_cents = line.amount_total, currency, status='completed')`. The migration 007 schema replaces the per-row `stripe_payment_intent_id UNIQUE` constraint with a composite `(stripe_payment_intent_id, lookup_key) UNIQUE` so multi-line carts (which share one PI) don't collide on insert.
  - **Credit grants** via `repo.credits.grant`: one row per `(line, credit_type)` — `amount = spec.sessionsGranted * line.quantity` for sessions; same for worlds. `source_type='purchase'`, `source_id = purchases.id` (the row just inserted), `expires_at = NULL` (à-la-carte never expires).
  - **billing_history** row: `kind='purchase'`, `source_id_stripe = payment_intent`, `amount_cents = amount_total`, `lookup_key = NULL` (multi-line; the per-line lookup_keys are in the `purchases` rows).

#### 5.4.2 `invoice.paid`

Fires for: subscription cycle (renewal), subscription update (proration). **Skip when `billing_reason === 'subscription_create'`** — first-month credits are granted by `checkout.session.completed` per §5.4.1 (and per MYT-41's locked contract). **Skip when `billing_reason === 'subscription_update'`** — mid-period tier-switch credit grants are out-of-scope for MYT-42 (see §2 non-goals; the original tier's credits remain through period_end, the new tier's credits arrive at next renewal). The handler still records the invoice in `billing_history` for both skipped cases — the skip applies only to credit grants, not to the audit row.

Resolve user via `event.data.object.customer` (string) → `users.stripe_customer_id`. On miss → fall back to `subscription.metadata.userId` (retrieve subscription first if needed). On total miss → log + COMMIT + 200 (this case is "Stripe-side test event for a customer we don't know"; not paging-grade unless paired with a checkout for a real Mythrun user, which would already have triggered §5.4.1's orphan path).

Retrieve the parent subscription via `event.data.object.subscription` for the period dates and the canonical `items.data[0].price.lookup_key` (NOT from `invoice.lines.data[i].price.lookup_key` — that field doesn't exist at dahlia; use the SKU cache reverse map on `line.pricing.price_details.price` if you need a per-line resolution, but the subscription's single-item gives a cleaner read for tier_lookup_key).

For `billing_reason === 'subscription_cycle'`:
- Compute `expected_total = price.unit_amount` (single-item subscription) and assert `expected_total === amount_paid`. Mismatch → §5.4 cross-cutting rule 2.
- Grant via `repo.credits.grant` per `(credit_type)`: `amount = spec.{sessions,worlds}Granted`, `source_type='subscription'`, `source_id = uuidv7()`, `expires_at = subscription.items.data[0].current_period_end`.
- Append `billing_history` row: `kind='invoice'`, `source_id_stripe = invoice_id`, `amount_cents = amount_paid`, `lookup_key = price.lookup_key`.

For `billing_reason === 'subscription_create'` and `'subscription_update'`: append `billing_history` row only; no credit grant (per above).

Negative-amount or zero-amount invoices (downgrade prorations, $0 trial-to-paid transitions if Mythrun ever introduces them): skip the credit grant and skip the amount validation; record `billing_history` only.

#### 5.4.3 `customer.subscription.created` and `customer.subscription.updated` (shared `handleSubscriptionUpsert`)

Both event types use the same handler because the upsert shape is identical. Stripe doesn't guarantee delivery order between `customer.subscription.created`, `customer.subscription.updated`, and `checkout.session.completed`; the upsert handler tolerates any ordering.

Resolve user via `event.data.object.customer` → `users.stripe_customer_id`; fallback to `event.data.object.metadata.userId` on miss. Total miss → log + COMMIT + 200.

Assert `subscription.items.data.length === 1`. Read `tier_lookup_key`, `status`, `items.data[0].current_period_start`, `items.data[0].current_period_end`, `cancel_at_period_end`, `cancellation_details` (if present — Stripe surfaces it on `cancel_at_period_end` toggles).

`repo.userSubscriptions.upsertFromStripe` issues a single `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE` statement so concurrent deliveries can't both INSERT and trip the UNIQUE constraint. The UPDATE clause reads `WHERE excluded.stripe_event_created_at >= user_subscriptions.stripe_event_created_at` to reject stale-event ordering (a late-arriving stale event mustn't overwrite a fresh row). The `stripe_event_created_at` column is added to `user_subscriptions` in migration 007 for this purpose.

**No credit grant** in this handler — all subscription credits flow through `checkout.session.completed` (first month) or `invoice.paid` (renewals). Subscription state lives in this row; credits live in `credit_ledger`.

#### 5.4.4 `customer.subscription.deleted`

UPDATE via `repo.userSubscriptions.markCanceled(stripe_subscription_id, event.data.object)` which sets `status='canceled'`, `cancel_at_period_end = false` (Stripe's payload may say true if scheduled; we collapse to false at deletion since the deletion has occurred), and reads `event.data.object.cancellation_details` into the row for analytics. Existing credits in `credit_ledger` stay; they remain consumable until `expires_at` (`current_period_end`). Per parent spec §3.3 + §10: no retroactive expiry on cancellation.

If no row matches the `stripe_subscription_id` (Stripe-side test event, deleted user, deletion-before-creation), log + COMMIT + 200.

#### 5.4.5 `charge.refunded`

Refund handling at launch: **full refunds only**. Partial refunds are a follow-up bead (§2 non-goals). For full refunds:

1. **Resolve the originating Mythrun entity.** `event.data.object.payment_intent` (string, may be null for non-PI charges) is the join key. Three resolution paths in order:
   - **À-la-carte purchase**: query `purchases WHERE stripe_payment_intent_id = $1 AND status='completed'`. If non-empty, this is an à-la-carte refund. Walk all matching `purchases` rows (a multi-line cart has multiple).
   - **Subscription invoice**: query `billing_history WHERE source_id_stripe IN (SELECT stripe_invoice_id FROM ...)` — actually simpler: `billing_history WHERE source_id_stripe = (SELECT id FROM invoices WHERE payment_intent = $1)`. Since we don't mirror Stripe invoices into Postgres, retrieve the charge via `stripe.charges.retrieve(charge_id)` and read `charge.invoice` to get the invoice ID, then look up `billing_history WHERE source_id_stripe = invoice_id AND kind='invoice'`.
   - **Neither matches**: this is a non-Mythrun charge (admin Dashboard test, manual charge, or null payment_intent). Log + COMMIT + 200.
2. **Compute the clawback.** For each originating credit_ledger row (resolvable from the `purchases.id` or `billing_history.id` foreign reference — see §6 schema additions), insert a debit row via `repo.credits.grant` with: `credit_type = original.credit_type`, `amount = -original.amount`, `source_type='debit'` (NOT `'refund'` — MYT-40 §"Caller obligations" reserves `'debit'` for negative-polarity rows; the `'refund'` source_type per MYT-40 line 136 is for POSITIVE re-grants, e.g., goodwill credits on top of a refund), `source_id = original.id` (links the clawback to its origin grant), `expires_at = original.expires_at`.
   - This satisfies the migration 004 polarity invariant: only `source_type='debit'` rows can have `amount < 0`; the spec's previous claim of `source_type='refund'` with negative amount would have aborted on the polarity CHECK constraint and put the refund pipeline into infinite-retry (Florin C1 round 1).
3. **UPDATE source row status.** For à-la-carte: `UPDATE purchases SET status='refunded' WHERE id = $1`. For subscription invoice: `UPDATE billing_history SET status='refunded' WHERE id = $1`. Append a `billing_history` row with `kind='refund'`, `source_id_stripe = refund_id` (Stripe's `re_*` ID, unique even when the same PI has multiple refunds), `amount_cents = -refund.amount`.
4. **Resulting balance** MAY go negative. MYT-40's atomic-debit refuses to consume from balance ≤ 0; at session-start, the user gets 402 Payment Required and must purchase to lift the balance back to positive. An in-flight session (already-debited credit) is unaffected by a refund arriving mid-session — the debit row stays committed; only the *next* session-start gates on the new balance.

For subscription refunds, the resolution path means we also have the original `credit_ledger` row's `expires_at` (it's mirrored through `billing_history`'s `expires_at` column added in §11). Subscription refunds beyond `current_period_end` clawback against credits that may already have expired — the resulting "negative against an expired bucket" is benign: balance is still computed off non-expired rows, so a clawback against an expired grant simply doesn't move the balance. Document in §12.

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
  -- conflict reads WHERE excluded.stripe_event_created_at >= row's value, so a
  -- late stale event can't overwrite a fresh row.
  stripe_event_created_at     TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);

-- billing_history: the unified audit feed for /api/billing/history AND the
-- resolution table for charge.refunded → originating credit_ledger rows.
-- For à-la-carte: kind='purchase', source_id_stripe = payment_intent.
-- For subscription invoice: kind='invoice', source_id_stripe = invoice_id.
-- For refund: kind='refund', source_id_stripe = refund_id (re_*).
-- Stripe ID namespaces (pi_*, in_*, re_*) are disjoint, so source_id_stripe
-- is globally unique across all three kinds.
CREATE TABLE billing_history (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                        TEXT        NOT NULL CHECK (kind IN ('purchase','invoice','refund')),
  source_id_stripe            TEXT        NOT NULL UNIQUE,
  -- For invoice: subscription_id of the parent subscription (for refund resolution).
  -- For refund: payment_intent of the refunded charge.
  -- For purchase: NULL.
  related_id_stripe           TEXT        NULL,
  lookup_key                  TEXT        NULL,           -- nullable: multi-line à-la-carte rows leave it NULL; subscription invoices fill it
  amount_cents                INTEGER     NOT NULL,       -- positive for purchase/invoice, negative for refund
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  status                      TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
  expires_at                  TIMESTAMPTZ NULL,           -- mirrors the originating credit_ledger.expires_at; NULL for à-la-carte and refund
  occurred_at                 TIMESTAMPTZ NOT NULL,       -- Stripe's event timestamp (full precision)
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_history_user_occurred ON billing_history(user_id, occurred_at DESC, id DESC);
CREATE INDEX idx_billing_history_related_id ON billing_history(related_id_stripe) WHERE related_id_stripe IS NOT NULL;

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
END $$;
```

Schema-parity test (`backend/src/db/__tests__/migrate-schema.test.ts`) updated:
- Add `'purchases'`, `'user_subscriptions'`, `'billing_history'` to `EXPECTED_TABLES`.
- Add `'idx_purchases_user'`, `'idx_user_subscriptions_user'`, `'idx_billing_history_user_occurred'`, `'idx_billing_history_related_id'` to `EXPECTED_IDX_NAMES`.
- Add the new check constraints (purchases.status, purchases.quantity > 0, user_subscriptions.status, user_subscriptions period-monotonicity, billing_history.kind, billing_history.status) to `EXPECTED_CHECK_CONSTRAINTS`.
- Add the FK rows: `purchases.user_id` (NO ACTION), `user_subscriptions.user_id` (CASCADE), `billing_history.user_id` (CASCADE). No FK from `tier_lookup_key` or `lookup_key`.
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

  markCanceled(tx: ClientLike, stripe_subscription_id: string, cancellation_details: unknown): Promise<void>
  // status='canceled', cancel_at_period_end=false (collapsed since deletion has
  // occurred), cancellation_details from Stripe payload.
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
  // Inserts a kind='purchase'|'invoice'|'refund' row. Source-id is the Stripe
  // ID (pi_*, in_*, or re_*); UNIQUE constraint blocks duplicate inserts.

  findByRelatedStripeId(tx: ClientLike, related_id_stripe: string): Promise<readonly BillingHistoryRow[]>
  // Used by §5.4.5 charge.refunded resolution: a refund's
  // event.data.object.payment_intent matches a billing_history row's
  // related_id_stripe (set on kind='invoice' rows to the parent subscription_id,
  // and on kind='purchase' rows the related_id_stripe is the same as
  // source_id_stripe so this is a no-op for à-la-carte refunds).

  listByUser(tx: ClientLike, userId: string, opts: { cursor?: { t: string, i: string }, limit: number }): Promise<{ rows: BillingHistoryRow[], nextCursor: string | null }>
  // Cursor format per §4.1.

  markRefunded(tx: ClientLike, id: string): Promise<void>
}
```

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

### 7.6 `repo.credits.grant` (signature unchanged; tx parameter clarified)

```ts
interface CreditsRepo {
  grant(tx: ClientLike, row: NewCreditLedgerRow): Promise<CreditLedgerRow>
  // Accepts a transaction handle. Used by:
  //   - register flow (trial credit, §8)
  //   - checkout.session.completed handler (à-la-carte purchase grants, §5.4.1)
  //   - invoice.paid handler (subscription cycle grants, §5.4.2)
  //   - charge.refunded handler (debit clawback rows with negative amount and
  //     source_type='debit' to respect MYT-40's polarity invariant)
  // No change to the underlying recipe; just a type annotation that grant
  // takes a tx (already implied by MYT-40's caller obligation #4).
}
```

**Deliberate non-extension:** `repo.credits.atomicDebit` is NOT extended in this issue. Round 1 of this spec's review (Florin C2 / Sestertius C1) showed that exposing `consumedSourceType` requires a recipe redesign — MYT-40's recipe is balance-based, not row-traversal-based, and there is no "consumed row" to label without rewriting the lock discipline. The trial-detection signal (`source_type='trial'` on the consumed credit) lives in `credit_ledger` already; MYT-43 picks the consumption-priority order and exposes the signal at that point. MYT-42 ships the credit, not the consumer.

## 8. Trial credit at registration

The MYT-38 register handler today calls `users.create(...)` against the connection pool with no explicit transaction — there is no existing `BEGIN`/`COMMIT` to extend. MYT-42 refactors the register flow to open a transaction explicitly, then composes the trial-credit grant inside it.

**Refactor:**

1. `repo.users.create(client, params)` now accepts a `ClientLike` (per §7.5). The route handler acquires a `PoolClient` via `pool.connect()` and runs `BEGIN`/`COMMIT` itself. The shipped `users.create` (single `pool.query` INSERT) is updated to take the client and run on it instead.
2. The route handler calls, in order:
   - `await client.query('BEGIN')`
   - `const user = await repo.users.create(client, params)` — creates the users row (without `free_trial_used`).
   - `await repo.credits.grant(client, { userId: user.id, creditType: 'session', amount: 1, sourceType: 'trial', sourceId: null, expiresAt: null })` — uses the canonical repo method per MYT-40 §"Caller obligations" #4 ("No write to credit_ledger may happen outside repo.credits.*"). Round 1 of this spec's review (Sestertius I2) flagged the original raw-INSERT shape as a caller-obligation violation.
   - `await client.query('UPDATE users SET free_trial_used = true WHERE id = $1', [user.id])`
   - `await client.query('COMMIT')` (or ROLLBACK on error inside a try/catch/finally that always releases the client).
3. The handler re-reads `user` (or stitches `free_trial_used = true` into the response shape) so the `POST /api/users/register` body reflects the post-COMMIT state. Florin I4 in round 1 noted this gap.

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

`repo.users.findOrCreateStripeCustomer(tx, userId)` — uses `SELECT ... FOR UPDATE` to serialize concurrent callers, then unconditional UPDATE:

```ts
async function findOrCreateStripeCustomer(tx: ClientLike, userId: string): Promise<string> {
  const locked = await tx.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  )
  if (locked.rows.length === 0) {
    throw new Error(`findOrCreateStripeCustomer: users row not found for userId=${userId}`)
  }
  const existing = locked.rows[0].stripe_customer_id
  if (existing) return existing
  // FOR UPDATE has serialized us against any concurrent caller; safe to call
  // Stripe and unconditional-UPDATE without race-loser branching.
  const cusId = await createStripeCustomer(stripeClient, userId)
  await tx.query(
    `UPDATE users SET stripe_customer_id = $2 WHERE id = $1`,
    [userId, cusId],
  )
  return cusId
}
```

Why the FOR UPDATE shape: round 1 of this spec's review (Florin C3) flagged that the previous conditional-UPDATE-and-re-read shape didn't gracefully handle every interleaving — specifically the `stripe_customer_id_already_set, re-read` failure mode that 23505 surfaces under operator-manual races. FOR UPDATE serializes the entire lookup-or-create against concurrent callers; only the first racer reaches the Stripe call, the others see the populated row and return immediately. No 23505, no race-loser branch, no orphan Stripe customer if the DB write fails post-Stripe-create (because the DB write is inside the same tx as the lock).

Why the idempotency-key strategy: Stripe's `customers.create` accepts an idempotency-key header that returns the same Customer object across retries within 24h, **provided the request parameters match exactly**. `customer_for_${userId}` is deterministic and the parameters are `{ metadata: { userId } }` only. Combined with our DB-side FOR UPDATE serialization, double-creation is impossible: at most one Stripe customer per userId, at most one `users.stripe_customer_id` value per row, no race-loser fallback needed.

## 10. SKU listing cache

`backend/src/billing/sku-cache.ts`:

```ts
interface SkuCache {
  readonly byLookupKey: ReadonlyMap<LookupKey, SkuListing>
  readonly byPriceId: ReadonlyMap<string, SkuListing>  // reverse lookup, used by webhook handlers
  readonly listing: readonly SkuListing[]              // serialization-friendly array view
}

let cache: SkuCache | null = null

export function setSkuCache(snapshot: SkuCache): void {
  cache = snapshot
}

export function getSkuCache(): SkuCache | null {
  return cache
}

export interface SkuListing {
  readonly lookup_key: LookupKey
  readonly stripe_price_id: string  // e.g. price_1ABCxyz
  readonly displayName: string
  readonly type: 'recurring' | 'one_time'
  readonly sessionsGranted: number
  readonly worldsGranted: number
  readonly price: { unit_amount_cents: number; currency: string }
}
```

The reverse map (`byPriceId`) is required by webhook handlers that need to resolve a Stripe-returned `price.id` (e.g., `invoice.lines.data[i].pricing.price_details.price`) back to a `lookup_key` and `LookupKeySpec`. At dahlia, the lookup_key is no longer present on invoice line objects — see §3.1 note 2.

Populated by `probe.ts` after a successful probe pass — the probe already fetched every Stripe price (`stripe.prices.list({ lookup_keys, expand: ['data.product'] })`); building the snapshot is mechanical:

```ts
// at the end of probeStripeContract, after mismatches.length === 0:
const listing: SkuListing[] = []
const byLookupKey = new Map<LookupKey, SkuListing>()
const byPriceId = new Map<string, SkuListing>()
for (const [lookup_key, spec] of Object.entries(LOOKUP_KEYS)) {
  const price = byLookup.get(lookup_key)!  // probe asserted presence
  const item: SkuListing = {
    lookup_key: lookup_key as LookupKey,
    stripe_price_id: price.id,
    displayName: spec.displayName,
    type: spec.type,
    sessionsGranted: spec.sessionsGranted,
    worldsGranted: spec.worldsGranted,
    price: { unit_amount_cents: price.unit_amount!, currency: price.currency },
  }
  listing.push(item)
  byLookupKey.set(item.lookup_key, item)
  byPriceId.set(item.stripe_price_id, item)
}
setSkuCache({ byLookupKey, byPriceId, listing })
```

`GET /api/billing/skus` reads `cache.listing` and returns it. Cache miss → 503 (defensive only; the probe gates boot, so any request reaching this endpoint has a populated cache). Response sets `Cache-Control: public, max-age=300`.

The `SkuListing` interface is a strictly public projection: it has no user-, tenant-, or environment-leaky fields. A typecheck assertion in §13 (a const test that fails to compile if `SkuListing` ever gains a field whose name matches `userId|email|tenant|internal|env|secret`) defends the public-projection invariant.

Cache is process-scoped; refreshes only on next deploy (which re-runs the probe). This is the right grain because the probe is the contract — prices changing without a deploy is a violation of the MYT-41 design.

## 11. History endpoint

`GET /api/billing/history?cursor=<token>` returns the user's `billing_history` rows (the unified audit feed). The `billing_history` table is defined in §6 — populated by `checkout.session.completed`, `invoice.paid`, and `charge.refunded` handlers alongside their primary writes inside the same transaction as `stripe_events.event_id`. We don't mirror Stripe invoices into Postgres on demand; the webhook is the canonical write path. This trades a small write at webhook time for a fast, cursor-pageable read.

Cursor wire format: `cursor = base64url(JSON.stringify({ t: occurred_at_iso, i: id }))`. The next page is `WHERE (occurred_at, id) < (cursor.t, cursor.i)` ordered `occurred_at DESC, id DESC`. Page size 50.

Query:

```sql
SELECT * FROM billing_history
WHERE user_id = $1
  AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2, $3::uuid))
ORDER BY occurred_at DESC, id DESC
LIMIT $4 + 1;  -- fetch one extra to derive nextCursor
```

If the query returns 51 rows, the response includes 50 and sets `nextCursor` from the 51st row's `(occurred_at, id)`. If 50 or fewer, `nextCursor` is `null`.

`occurred_at` is Stripe's event timestamp at full precision. `id` is `billing_history.id UUID` (UUIDv7), unique table-wide so ties on `occurred_at` resolve deterministically by id.

## 12. Errors + edge cases

The closed set of error codes lives in `backend/src/billing/errors.ts` exporting a `BillingErrorCode` union type. All 4xx responses use the envelope `{ code: 'snake_case', ...optional_detail }`.

| Scenario | Response |
|---|---|
| Checkout body invalid (Zod) | 400 with field-level detail; codes `body_invalid` |
| Mixed tier + à-la-carte cart | 400 `{ code: 'mixed_cart' }` |
| Tier with quantity > 1 or items.length > 1 | 400 `{ code: 'tier_cart_shape' }` |
| Duplicate lookup_key in cart | 400 `{ code: 'duplicate_lookup_key' }` |
| Unknown lookup_key | 400 `{ code: 'unknown_lookup_key' }` |
| Stripe API error during checkout | 502 (logged with detail; client gets `{ code: 'stripe_unavailable' }`) |
| User has no `stripe_customer_id` and Stripe is down at portal request | 502 `{ code: 'stripe_unavailable' }` |
| Webhook signature missing | 400 `{ code: 'missing_signature' }` |
| Webhook signature invalid | 400 `{ code: 'invalid_signature' }` |
| Webhook secret is `'PLACEHOLDER'` | All signatures invalid → 400. **Fail-closed by design.** The first action after MYT-42 ships is rotating Secrets Manager from PLACEHOLDER → the Dashboard-issued `whsec_*`. |
| Webhook `event.api_version` ≠ SDK pin | 200 + ERROR-level log `stripe_webhook_api_version_mismatch`; processing continues but Dashboard config needs an ops fix |
| Webhook event already processed (idempotent replay) | 200 (stripe_events PK ON CONFLICT DO NOTHING; ROLLBACK and exit) |
| Webhook event for unknown customer (subscription/invoice/charge events) | 200 + INFO-level log + record event_id; non-paging |
| **`checkout.session.completed` with `metadata.userId` missing or unresolvable** | 200 + ERROR-level log `billing.checkout_orphan` + COMMIT (paid customer with no credits to grant; **paging-grade**, distinct from generic unknown-customer); manual reconciliation required |
| **`checkout.session.completed` `event.data.object.customer` ≠ `users[metadata.userId].stripe_customer_id`** | 200 + ERROR-level log `billing.checkout_customer_mismatch` + COMMIT (paging-grade); manual reconciliation |
| Webhook `amount_total` reconstruction mismatch (per-charge validation, §5.4 cross-cutting rule 2) | 200 + ERROR-level log `billing.amount_validation_failed` + COMMIT (no credit grant; suppresses Stripe retries); manual reconciliation |
| Webhook event of unknown type | 200 + INFO-level log + record event_id |
| Refund on an invoice/charge that doesn't map to any local row | 200 + WARN-level log; no clawback (we have nothing to debit) |
| Refund makes balance negative | Allowed; atomic-debit at session-start returns 402 until balance is positive |
| Refund arrives mid-session (after debit but before session ends) | The in-flight debit is unaffected; the session completes normally; the negative balance gates only the *next* session-start. The 402 response includes `available: <negative number>` so the frontend can show "you need to purchase N credits to lift your balance to positive" |
| Refund against credits that already expired | Clawback row inserts cleanly; balance is computed off non-expired rows so an expired-bucket clawback simply doesn't move the visible balance |
| Concurrent refund + session-start | credit_ledger / users FOR UPDATE locks serialize; refund completes first or session-start consumes pre-refund credits, never both |
| Concurrent checkout calls before customer exists | `findOrCreateStripeCustomer` FOR UPDATE on users.id serializes; only the first racer reaches the Stripe API. Stripe idempotency-key dedupes Stripe-side as a belt-and-suspenders defense |
| Subscription event arrives before checkout.session.completed (out-of-order delivery) | `upsertFromStripe` is a single ON CONFLICT DO UPDATE statement; any arrival order produces a single row, with stale-event ordering rejected by `WHERE excluded.stripe_event_created_at >= existing.stripe_event_created_at` |
| `users.stripe_customer_id` row not found for a `customer.subscription.*` event | 200 + log + try `subscription.metadata.userId` fallback; total miss → log + record event_id (Stripe-side test event for an orphan customer) |
| `invoice.paid` with `billing_reason='subscription_create'` | Skip credit grant (already granted by `checkout.session.completed`); record `billing_history` row for the invoice |
| `invoice.paid` with `billing_reason='subscription_update'` (mid-period proration) | Skip credit grant per §2 non-goals; record `billing_history` row |
| `invoice.paid` with negative or zero amount | Skip credit grant; skip amount validation; record `billing_history` row |
| `customer.subscription.updated` schedules a downgrade for next period (Stripe `pending_update`) | UPDATE `user_subscriptions` row with current price (no change to tier_lookup_key until activation event arrives at period_end) |
| Mid-period upgrade with proration (admin Dashboard only — not exposed to users via Customer Portal) | Per §2 non-goals: no credit grant on the proration invoice. Document policy and revisit if Customer Portal exposes "switch plan immediately" |
| Concurrent `customer.subscription.updated` and `checkout.session.completed` for same subscription | `upsertFromStripe`'s ON CONFLICT DO UPDATE is atomic; both transactions converge to a single row reflecting the latest event |
| Operator manually pastes `cus_*` into `users.stripe_customer_id` mid-checkout | `findOrCreateStripeCustomer`'s FOR UPDATE serializes the lock against operator INSERTs; either the operator wins (subsequent checkout reads the manual value and uses it) or the lock holder wins (operator INSERT blocks until the lock releases). 23505 cannot occur because the FOR UPDATE happens before the UPDATE |

## 13. Testing

**Unit / integration**:

- `backend/src/billing/__tests__/webhook.test.ts` — per-event-type fixtures and assertions:
  - `checkout.session.completed` mode='payment' multi-line cart: 3 line items → 3 `purchases` rows sharing one `payment_intent` (verifies the composite UNIQUE), one `billing_history` row, three `credit_ledger` rows. Re-replay of the same `event.id`: no second writes (idempotency).
  - `checkout.session.completed` mode='subscription' `payment_status='paid'`: one `user_subscriptions` row (status from Stripe, NOT hardcoded `'active'`), one `billing_history` row for the invoice, one credit_ledger row per credit_type. `repo.userSubscriptions.upsertFromStripe` produces exactly one row across re-replay.
  - `checkout.session.completed` mode='subscription' `payment_status='unpaid'` (SCA-pending): one `user_subscriptions` row with `status='incomplete'`, no credit grant. Followed by `invoice.paid` (when SCA completes): credit grant runs.
  - `checkout.session.completed` `metadata.userId` missing → ERROR-level `billing.checkout_orphan`, no writes other than `stripe_events`, returns 200.
  - `checkout.session.completed` `event.data.object.customer` ≠ `users[metadata.userId].stripe_customer_id` → ERROR-level `billing.checkout_customer_mismatch`, no writes other than `stripe_events`.
  - `checkout.session.completed` reconstructed `expected_total ≠ amount_total` → ERROR-level `billing.amount_validation_failed`, no credit grant.
  - `invoice.paid` `billing_reason='subscription_create'`: skipped credit grant (first-month is via checkout.session.completed); `billing_history` row written.
  - `invoice.paid` `billing_reason='subscription_cycle'`: credit grant runs; `billing_history` written.
  - `invoice.paid` `billing_reason='subscription_update'` (proration): skipped credit grant per §2 non-goals; `billing_history` written.
  - `customer.subscription.created` arrives BEFORE `checkout.session.completed`: upsert produces row with `status='incomplete'`; subsequent checkout.session.completed UPDATEs in place; final row reflects the post-checkout state.
  - `customer.subscription.updated` arrives twice in different orders: stale-event ordering rejected via `WHERE excluded.stripe_event_created_at >= existing.stripe_event_created_at`.
  - `customer.subscription.deleted`: status='canceled', `cancellation_details` recorded, existing credit_ledger rows untouched.
  - `charge.refunded` for à-la-carte: walks `purchases` rows by `(stripe_payment_intent_id)`, inserts negative `credit_ledger` rows with `source_type='debit'` (NOT `'refund'` — verify polarity invariant respected per migration 004 CHECK), updates `purchases.status='refunded'`, appends `billing_history` row with `kind='refund'`.
  - `charge.refunded` for subscription invoice: resolves via `billing_history.related_id_stripe`, inserts debit rows referencing the original credit_ledger grants, updates `billing_history.status='refunded'`.
  - `charge.refunded` with `payment_intent: null`: log + commit + 200; no writes.
  - Unknown event type: 200 + log + `stripe_events` row recorded.
  - Signature missing → 400 `{ code: 'missing_signature' }`.
  - Signature invalid → 400 `{ code: 'invalid_signature' }`.
  - Webhook secret = `'PLACEHOLDER'`: every event returns 400 (fail-closed).
  - `event.api_version` ≠ SDK pin: ERROR-level log, processing continues.

- `backend/src/billing/__tests__/customer.test.ts` — `findOrCreateStripeCustomer`:
  - Happy path: row has `stripe_customer_id=NULL`, helper calls Stripe, UPDATE succeeds, returns the new `cus_*`.
  - Idempotent re-call: row already has `cus_*`; helper returns it without calling Stripe.
  - Concurrent calls (simulated via two parallel transactions): FOR UPDATE serializes; only one Stripe call; both return the same `cus_*`.

- `backend/src/billing/__tests__/sku-cache.test.ts`:
  - `setSkuCache` + `getSkuCache` round-trip preserves `byLookupKey`, `byPriceId`, and `listing`.
  - `byPriceId` reverse map populated correctly from probe data.
  - `SkuListing` type assertion: a const test that fails to compile if `SkuListing` ever gains a field whose name matches `userId|email|tenant|internal|env|secret`.

- `backend/src/repo/__tests__/purchases.test.ts`:
  - Insert two rows with same `stripe_payment_intent_id` and DIFFERENT `lookup_key`: succeeds (composite UNIQUE).
  - Insert two rows with same `(stripe_payment_intent_id, lookup_key)`: 23505 (composite UNIQUE).
  - `getByPaymentIntent` returns multi-line array.
  - `markRefunded(purchaseId)` flips status without affecting siblings sharing the PI.

- `backend/src/repo/__tests__/user-subscriptions.test.ts`:
  - `upsertFromStripe` insert path.
  - `upsertFromStripe` update path.
  - `upsertFromStripe` stale-event rejection (older `stripe_event_created_at` doesn't overwrite).
  - `getActiveForUser` excludes `status IN ('canceled','incomplete_expired')`.
  - `markCanceled` sets status + records `cancellation_details`.
  - Concurrent upserts: two parallel transactions both calling `upsertFromStripe` for the same `stripe_subscription_id` produce exactly one row (atomic ON CONFLICT DO UPDATE).

- `backend/src/repo/__tests__/stripe-events.test.ts`:
  - `recordOrSkip` first call returns `'inserted'`.
  - Second call with same `event_id` returns `'duplicate'`.
  - Tx rollback after `'inserted'` → next call sees `'inserted'` again (durability conditional on commit).

- `backend/src/repo/__tests__/billing-history.test.ts`:
  - `append` for each kind.
  - `findByRelatedStripeId` returns matching rows.
  - `listByUser` cursor pagination with ties on `occurred_at` resolves by `id` deterministically.

- `backend/src/repo/__tests__/credits.test.ts` — **no `consumedSourceType` test in MYT-42** (deferred to MYT-43); existing `grant` + `atomicDebit` tests stand. Add a test for `grant(tx, ...)` accepting a transaction handle (regression: MYT-40's signature already supports this; test pins the contract).

- `backend/src/repo/__tests__/users.test.ts`:
  - `create(tx, ...)` accepts a transaction handle.
  - `findOrCreateStripeCustomer(tx, userId)` happy + concurrent paths (above).

- `backend/src/routes/__tests__/billing.test.ts`:
  - Each route: auth contract (JWT-required vs public), body validation, response shape.
  - Cart-shape rules: mixed cart, tier with quantity > 1, duplicate lookup_key, unknown lookup_key, empty array, max-100 array.
  - History endpoint cursor round-trip: page 1 → cursor → page 2; concatenation matches a flat fetch.
  - SKU listing endpoint: response is the public projection of `cache.listing`; sets `Cache-Control: public, max-age=300`.

- `backend/src/routes/__tests__/webhook.test.ts`:
  - **Raw-body parser is encapsulation-scoped** — a sibling JSON route (e.g., `/api/users/register`) still receives a parsed object, NOT a Buffer.
  - The webhook handler receives the Buffer for `Content-Type: application/json`.
  - The webhook handler receives the Buffer for `Content-Type: application/json; charset=utf-8` (charset-suffix variant).
  - Rate limit: 61st request from same IP within 1 minute → 429.

- `backend/src/__tests__/onboarding.test.ts` — extended for §8:
  - After register: response includes `free_trial_used: true`.
  - After register: exactly one credit_ledger row with `source_type='trial'`, `amount=1`, `expires_at=NULL`, `source_id=NULL`.
  - Re-registration short-circuit: no second trial credit row.
  - Failed credit_ledger insert (mocked): users row also rolled back (single transaction).

**Schema parity**: `backend/src/db/__tests__/migrate-schema.test.ts` updated for migration 007 (purchases, user_subscriptions, billing_history; their indexes; their check constraints including the user_subscriptions period-monotonicity CHECK; their FKs).

**Webhook presence test (replaces the absence test)**: MYT-41's `backend/src/__tests__/webhook-absence.test.ts` is renamed to `webhook-presence.test.ts` and asserts:
- `POST /webhooks/stripe` with no signature returns 400 (route is registered).
- `POST /webhooks/stripe` with an invalid signature returns 400.
The "route exists" tripwire is preserved; the "route does NOT exist" tripwire is appropriately retired.

## 14. Spec patches to other docs

**MYT-41 spec patches** (`docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md`):
- §"Per-event-type resolution rules" — reaffirm that `checkout.session.completed` for subscription mode grants first-month credits AND that `invoice.paid` skips `billing_reason='subscription_create'`. (The original MYT-41 text already says this; the patch is to remove any ambiguity introduced by intermediate drafts.)
- §"Webhook credit-grant contract for MYT-42" — add notes 1–5 from §3.1 of this spec verbatim (Stripe API at dahlia field-shape changes).
- §"Webhook credit-grant contract for MYT-42" — add `customer.subscription.created` to the Dashboard webhook event subscription list. The handler is shared with `customer.subscription.updated` (`handleSubscriptionUpsert`).
- §8 portal lazy-create — patch the original "409 no_billing_history" recommendation to lazy-create-on-first-portal-request per §4.4 of this spec. The fraud-vector argument is rebutted: every portal call is JWT-authenticated and rate-limited; `customers.create` is idempotent; the boundary holds without the 409 special case.
- §"Refund handling" — explicitly say negative-polarity rows use `source_type='debit'` (NOT `'refund'`), citing migration 004's polarity CHECK constraint. The `'refund'` source_type is reserved for positive-polarity goodwill grants per MYT-40.

**Parent billing spec patches** (`docs/specs/2026-04-13-billing-cost-controls.md`):
- §4 (purchase flow) — refer to the unified `POST /api/billing/checkout` body shape; drop any leftover language about per-line metadata.packId.
- §7 (free trial) — refine the patched language to reflect the source_type='trial' signal MYT-42 emits and MYT-43 reads.
- §10 (edge cases) — add the refund-makes-balance-negative case, the refund-against-expired-bucket case, the refund-mid-session case, and the concurrent-checkout-customer-create case.

**Backend-core spec patches** (`docs/specs/2026-04-13-backend-core.md`):
- §5.2 (repo namespace listings) — restore `repo.purchases`, `repo.userSubscriptions`, `repo.stripeEvents`, and `repo.billingHistory` to the "shipped" set; remove the corresponding deferral rows from the deferral table; note that `users.create` now accepts a `ClientLike`.
- Schema block — `purchases`, `user_subscriptions`, and `billing_history` come back with the new shape (composite UNIQUE on purchases; expanded status enum + `cancel_at` + `cancellation_details` + `stripe_event_created_at` on user_subscriptions; full billing_history table).
- §"Caller obligations" reference — note that MYT-42 honors the "no direct INSERT into credit_ledger" rule by routing the trial grant through `repo.credits.grant`.

## 15. Operational notes

**Webhook endpoint registration + secret rotation post-MYT-42 deploy** (manual ops, will land in the wiki runbook):

1. After MYT-42 deploys to staging, register the webhook endpoint in the Stripe Dashboard test-mode account: `https://dashboard.stripe.com/test/webhooks` → Add endpoint → URL `https://staging.mythrun.com/webhooks/stripe`, **API version `2026-04-22.dahlia`** (Dashboard → API version selector — MUST match the SDK's pin per §3.1 note 5; otherwise event payloads at the handler will silently shape-mismatch typed field accesses), events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`.
2. Stripe issues a `whsec_*` signing secret on creation; copy it.
3. `aws secretsmanager update-secret --secret-id mythrun/staging/stripe-webhook-secret --secret-string 'whsec_<value>'`.
4. Force a rolling deploy (`gh workflow run Deploy`) so the new secret is loaded.
5. Verify: send a test event from the Dashboard's Webhook detail page; confirm 200 + a `stripe_events` row.

Until step 3, every webhook returns 400 (PLACEHOLDER fails closed). Stripe queues retries with exponential backoff for ~3 days; events delivered before step 3 are lost from Stripe's perspective. Dashboard pre-step-3 should NOT trigger any real charges (test-mode only) — but if it does, manual reconciliation against `billing.checkout_orphan` alerts is the recovery path.

**Boot probe parity**: when MYT-42 lands, the probe still verifies the same 5 lookup_keys. The MYT-42 surface doesn't change Stripe's price catalog. The new `sku-cache` is a side effect of a successful probe pass; cache failure doesn't gate boot.

**Alarm hand-off (paging-grade webhook events)**: three webhook log events are paging-grade and require CloudWatch alarms:
- `billing.checkout_orphan` — paid customer with no resolvable user; manual reconciliation needed.
- `billing.checkout_customer_mismatch` — checkout completed for a user whose `stripe_customer_id` doesn't match the event's customer; possible session corruption.
- `billing.amount_validation_failed` — Stripe-reported amount doesn't match server-reconstructed `expected_total`; possible price-mutation attempt or Stripe-side data corruption.

The alarm bead is filed alongside MYT-42 (similar to `myth-billing-probe-alarm` from MYT-41 close).

**MYT-43 hand-off**: MYT-43 picks up the trial-detection signal at session-start. The signal is `credit_ledger.source_type = 'trial'` on the row consumed by the atomic-debit recipe at session-start. MYT-43 decides:
- The consumption-priority order (likely earliest-expiring, with trial credits last so paid credits are consumed first).
- How to expose `consumedSourceType` from the atomic-debit recipe (the recipe redesign deferred from MYT-42 §7.6 lands in MYT-43).
- The session-start branching: if `consumedSourceType === 'trial'` → trial-mode session (reduced budget, demo world, time cap).

MYT-42 intentionally does NOT pick the priority order; that's a session-runtime concern.

---

## Appendix: what-this-doc-is-not

This is the design for MYT-42 specifically. It is not:
- The MYT-41 spec (which sets the contract this implements). See `docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md`.
- The implementation plan (next step after this spec is approved). The plan will land at `docs/superpowers/plans/2026-05-05-myt-42-stripe-webhook-checkout.md` via the writing-plans skill.
- The parent billing spec. See `docs/specs/2026-04-13-billing-cost-controls.md` for the user-experience-level contract, which this design implements.
