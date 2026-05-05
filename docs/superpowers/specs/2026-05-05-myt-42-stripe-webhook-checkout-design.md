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
3. Migration 007 that re-creates `purchases` and `user_subscriptions` with the new lookup_key shape.
4. Repo namespaces for `purchases`, `userSubscriptions`, `stripeEvents`, plus `users.findOrCreateStripeCustomer`.
5. A trial-credit grant inserted at registration in the same transaction as the `users` INSERT.
6. An extension to `credits.atomicDebit` that RETURNs the consumed row's `source_type` so MYT-43 can detect trial sessions.

After this issue, a user can register, get a free trial credit, click Buy, complete Stripe Checkout, and see credits appear in their balance. They can manage their subscription via the Customer Portal that MYT-41 already configured.

## 2. Non-goals

- The session runtime's trial-mode limits (reduced budget, demo world, time cap) — MYT-43 owns those, reading the trial signal MYT-42 surfaces.
- Webhook secret rolling-rotation procedure — manual ops; runbook follow-up.
- Per-event-type webhook handler modules — single orchestrator suffices at 5 events.
- `stripe_customer_id` backfill for users created before MYT-42 — lazy-create-on-first-use covers all paths going forward.
- Subscription pause/resume — out of Customer Portal allowlist per MYT-41.
- Dunning event variants (`invoice.payment_failed`, etc.) — log-and-ignore for now, follow-up bead.
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
- `backend/src/billing/sku-cache.ts` — boot-time cache of `LOOKUP_KEYS` + Stripe price snapshot, populated immediately after the probe passes.
- `backend/src/repo/purchases.ts`, `backend/src/repo/user-subscriptions.ts`, `backend/src/repo/stripe-events.ts` — three new namespaces.

Patches:
- `backend/src/repo/users.ts` — `findOrCreateStripeCustomer(userId)` that wraps the customer.ts helper + the conditional UPDATE.
- `backend/src/repo/credits.ts` — `atomicDebit` returns the consumed row's `source_type` as part of its result type.
- `backend/src/routes/users.ts` (MYT-38's register handler) — INSERT trial credit_ledger row + SET `users.free_trial_used = true` inside the existing register transaction.
- `backend/src/billing/probe.ts` — populate `sku-cache` immediately after a successful probe (cheap; same data already fetched).
- `backend/src/server.ts` / `backend/src/app.ts` — wire the new route plugins.

## 4. Routes

### 4.1 Body shapes + auth

| Route | Auth | Body | Returns |
|---|---|---|---|
| `GET /api/billing/skus` | public (`config: { auth: 'public' }`) | — | `[{ lookup_key, displayName, type, sessionsGranted, worldsGranted, price: { unit_amount_cents, currency } }]` |
| `GET /api/billing/balance` | JWT | — | `{ balance: { session, world_gen }, tier: { lookup_key, displayName, renewsAt, cancelAtPeriodEnd } \| null }` |
| `POST /api/billing/checkout` | JWT | `{ items: [{ lookup_key, quantity }] }` | `{ checkoutUrl }` |
| `POST /api/billing/portal` | JWT | — | `{ portalUrl }` |
| `GET /api/billing/history?cursor=<id>` | JWT | — | `{ events: [{ kind: 'purchase'\|'invoice', id, occurredAt, amount_cents, currency, lookup_key?, status }], nextCursor: string \| null }` |
| `GET /api/billing/subscription` | JWT | — | The user's full `user_subscriptions` row enriched with `displayName`, or `null` |
| `POST /webhooks/stripe` | public | raw body (preserved via route-scoped `addContentTypeParser`) | `200 { received: true }` on success / 400 on signature mismatch |

History page size: 50. Cursor = the lex-smallest `(occurredAt, id)` of the next page. Sort order: `occurredAt DESC, id DESC`. Cursor-based not offset because invoices and purchases interleave by time and offset is an N+1 hazard at the DB layer.

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
  subscription_data: { metadata: { userId } },  // so customer.subscription.* events also carry userId
}
```

Subscription metadata carries `userId` so `customer.subscription.{updated,deleted}` events have a back-reference even though Stripe doesn't include checkout metadata on subscription events.

### 4.4 Customer Portal creation (`POST /api/billing/portal`)

```
stripe.billingPortal.sessions.create({
  customer: <findOrCreateStripeCustomer(userId)>,
  return_url: `${env.frontendBaseUrl}/account`,
})
```

Lazy-creates the customer if the user has never checked out — this lets a freshly-registered user open the portal even though they have nothing to manage. The portal will show "no active subscription"; the user can leave or browse historical invoices (which there are none of). Acceptable UX.

### 4.5 SKU listing endpoint (`GET /api/billing/skus`)

Served from `sku-cache.ts` — a module-level frozen object populated immediately after a successful boot probe. The cache holds the same data the probe already fetched (`stripe.prices.list({ lookup_keys, expand: ['data.product'] })`), enriched with the `LOOKUP_KEYS` contract metadata (displayName, sessionsGranted, worldsGranted, type).

Cache is read-only after boot; refreshes only on next deploy (which re-runs the probe). Mythrun policy is "Stripe Dashboard is the source of truth, deploy releases pin to a probe-validated state" (MYT-41 spec §1) — prices changing without a deploy is a violation, so cache-on-boot is the right grain.

If the SKU cache is empty (no probe pass yet — should be impossible because the probe gates boot), return 503. Defensive only.

## 5. Webhook handler

### 5.1 Route + raw-body parser

`POST /webhooks/stripe` lives in `backend/src/routes/webhook.ts`. It is **public** (`config: { auth: 'public' }`) — Stripe authenticates via signature, not JWT. The raw body parser is **route-scoped** via `addContentTypeParser` because Fastify's default JSON parser would consume the bytes before `stripe.webhooks.constructEvent` can hash them. Wrong scope here is a Fastify gotcha and a common Stripe-integration footgun.

```ts
app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),  // pass-through; route handler gets the Buffer
)
```

Apply the parser only to the webhook route via Fastify's plugin scope. Other routes keep the default JSON parser.

### 5.2 Signature verification

```ts
const sig = request.headers['stripe-signature']
if (!sig || typeof sig !== 'string') return reply.code(400).send({ error: 'missing_signature' })
let event: Stripe.Event
try {
  event = stripe.webhooks.constructEvent(rawBody, sig, env.stripeWebhookSecret)
} catch (err) {
  request.log.warn({ err }, 'stripe_webhook_signature_invalid')
  return reply.code(400).send({ error: 'invalid_signature' })
}
```

`env.stripeWebhookSecret = 'PLACEHOLDER'` (the MYT-41 → MYT-42 window value) **fails closed** here: `constructEvent` will reject every signature because the literal 'PLACEHOLDER' isn't a valid `whsec_*`. No bypass branch. The first action after MYT-42 ships is rotating Secrets Manager from PLACEHOLDER → the Dashboard-issued `whsec_*` (manual ops step in the runbook).

### 5.3 Idempotency + dispatch

Every event runs in a single Postgres transaction:

```sql
BEGIN;
INSERT INTO stripe_events (event_id, event_type, processed_at)
  VALUES ($1, $2, now())
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id;
-- empty result → duplicate; ROLLBACK and return 200
-- non-empty → continue with handler-specific writes
COMMIT;
```

`stripe_events` already exists from migration 001 with `event_id TEXT PRIMARY KEY`. First-write-wins. Stripe retries the same event ID on transient delivery failures; the second delivery hits the conflict and exits cleanly.

After successful insert into `stripe_events`, dispatch:

```ts
const HANDLERS: Record<string, EventHandler> = {
  'checkout.session.completed':     handleCheckoutCompleted,
  'invoice.paid':                   handleInvoicePaid,
  'customer.subscription.updated':  handleSubscriptionUpdated,
  'customer.subscription.deleted':  handleSubscriptionDeleted,
  'charge.refunded':                handleChargeRefunded,
}
const handler = HANDLERS[event.type]
if (handler) {
  await handler(event, tx)  // tx is the same transaction stripe_events was inserted into
} else {
  request.log.info({ event_type: event.type, event_id: event.id }, 'stripe_webhook_unknown_type')
  // tx still commits — the stripe_events row records that we acknowledged this event
}
return reply.code(200).send({ received: true })
```

### 5.4 Per-event-type handlers

#### 5.4.1 `checkout.session.completed`

Resolves user via `event.data.object.metadata.userId` (we set this on session create per §4.3).

Branch on `event.data.object.mode`:
- `'payment'` (à-la-carte): walk `line_items` (expand at retrieval if not present in the event). For each line item, resolve `price.lookup_key` against `LOOKUP_KEYS`, INSERT a `purchases` row with `quantity` and `amount_cents`, INSERT `credit_ledger` rows for the granted credits (each row carries `source_id = uuidv7()` and `source_type='purchase'`, expires_at=NULL). One purchase row per line item.
- `'subscription'`: INSERT a `user_subscriptions` row with `tier_lookup_key = price.lookup_key` for the subscription's first item, `status='active'`, period dates from `subscription.current_period_*`. **No credit grant on this event** — the subscription's first `invoice.paid` event arrives shortly after and grants them. Single source of truth for subscription credits is `invoice.paid`.

#### 5.4.2 `invoice.paid`

Fires for: subscription create (initial invoice), subscription cycle (renewal), subscription update (proration on tier-switch). All three paths grant credits via the same code.

Resolve user via `customer.id` → `users.stripe_customer_id` lookup. If no match → log + commit (the stripe_events row records acknowledgement) + 200.

Walk the invoice's `lines.data`. Each line carries a `price` and a `quantity`. For each line whose `price.lookup_key` is in `LOOKUP_KEYS` and whose `amount` is positive:
- Resolve the lookup_key spec (sessions/worlds granted per unit).
- INSERT credit_ledger rows: `amount = quantity × spec.sessionsGranted` for sessions; same for worlds. `source_type='subscription'`, `source_id=uuidv7()`, `expires_at = subscription.current_period_end` (no rollover for tier credits per spec §3).

Negative-amount lines (downgrade prorations) → skip; no credit clawback for downgrades, the user keeps what they paid for through period_end.

#### 5.4.3 `customer.subscription.updated`

Resolve user via `customer.id` → `users.stripe_customer_id`. UPDATE `user_subscriptions` row with new `tier_lookup_key` (from `subscription.items.data[0].price.lookup_key`), `status`, `current_period_start`, `current_period_end`, `cancel_at_period_end`. **No credit grant** — credits flow through `invoice.paid`.

If no row exists for this `stripe_subscription_id` (out-of-order delivery — update arrived before the create event), INSERT a new row instead of UPDATE. Handler is upsert-shaped.

#### 5.4.4 `customer.subscription.deleted`

UPDATE the matching `user_subscriptions` row to `status='canceled'`. Existing credits in `credit_ledger` stay; they remain consumable until `expires_at` (`current_period_end`). Per spec §3.3 + §10: no retroactive expiry on cancellation.

#### 5.4.5 `charge.refunded`

Resolve the original `purchases` row via `stripe_payment_intent_id = event.data.object.payment_intent`. UPDATE `purchases.status = 'refunded'`. INSERT a NEGATIVE `credit_ledger` row with `amount = -<original_amount>`, `credit_type` matching the original grant, `source_type='refund'`, `source_id=uuidv7()`, `expires_at` matching the original.

Resulting balance MAY go negative. The atomic-debit recipe (MYT-40) refuses to consume from a negative balance — at session-start, the user gets 402 Payment Required. They need to purchase more credits to lift the balance back to positive.

If the original purchase was for à-la-carte (no expiry), the negative entry is for à-la-carte; if it was for a subscription invoice, the negative entry is for that subscription period. Subscription refunds beyond `current_period_end` are best-effort (the credits may already have expired).

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

CREATE TABLE purchases (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id),
  stripe_payment_intent_id    TEXT        NOT NULL UNIQUE,
  lookup_key                  TEXT        NOT NULL,
  quantity                    INTEGER     NOT NULL CHECK (quantity > 0),
  amount_cents                INTEGER     NOT NULL,
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  status                      TEXT        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','refunded')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_purchases_user ON purchases(user_id);

CREATE TABLE user_subscriptions (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_lookup_key             TEXT        NOT NULL,
  stripe_subscription_id      TEXT        NOT NULL UNIQUE,
  status                      TEXT        NOT NULL CHECK (status IN ('active','past_due','canceled','unpaid')),
  current_period_start        TIMESTAMPTZ NOT NULL,
  current_period_end          TIMESTAMPTZ NOT NULL,
  cancel_at_period_end        BOOLEAN     NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);

-- Post-create assertion (current_schema() not hard-coded 'public', per the
-- migration 005 fix).
DO $$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('purchases', 'user_subscriptions')
    GROUP BY 1 = 1
    HAVING count(*) = 2
  ), 'migration 007 did not create both tables';
END $$;
```

Schema-parity test (`backend/src/db/__tests__/migrate-schema.test.ts`) updated:
- Add `'purchases'`, `'user_subscriptions'` back to `EXPECTED_TABLES`.
- Add `'idx_purchases_user'`, `'idx_user_subscriptions_user'` back to `EXPECTED_IDX_NAMES`.
- Add the new check constraints (purchases.status, purchases.quantity > 0, user_subscriptions.status) to `EXPECTED_CHECK_CONSTRAINTS`.
- Add the FK rows back to `EXPECTED_FK_DELETE_RULES`: `purchases.user_id` (NO ACTION), `user_subscriptions.user_id` (CASCADE). No FK from `tier_lookup_key`.
- Append `'007_recreate_billing_tables.sql'` to the migrations list.

`reset-data.ts` `TABLES` list extended with `purchases` and `user_subscriptions` (FK-correct order: user_subscriptions before users; purchases anywhere before users via TRUNCATE CASCADE).

## 7. Repo namespaces

### 7.1 `repo.purchases`

```ts
interface PurchasesRepo {
  create(tx: ClientLike, row: NewPurchase): Promise<Purchase>
  getByPaymentIntent(payment_intent_id: string): Promise<Purchase | null>
  listByUser(userId: string, opts: { cursor?: string, limit: number }): Promise<{ rows: Purchase[], nextCursor: string | null }>
  markRefunded(tx: ClientLike, payment_intent_id: string): Promise<void>
}
```

### 7.2 `repo.userSubscriptions`

```ts
interface UserSubscriptionsRepo {
  upsertFromStripe(tx: ClientLike, row: SubscriptionRow): Promise<UserSubscription>
  // Insert if no row exists for stripe_subscription_id; UPDATE otherwise.
  // Used by both customer.subscription.created (via checkout.session.completed)
  // and customer.subscription.updated, so out-of-order delivery is tolerated.

  getActiveForUser(userId: string): Promise<UserSubscription | null>
  // The "single active subscription" the patched §9 balance + subscription
  // endpoints need. Mythrun policy via Customer Portal Switch Plan is one
  // active subscription per user.

  markCanceled(tx: ClientLike, stripe_subscription_id: string): Promise<void>
}
```

### 7.3 `repo.stripeEvents`

```ts
interface StripeEventsRepo {
  recordOrSkip(tx: ClientLike, event_id: string, event_type: string): Promise<'inserted' | 'duplicate'>
  // INSERT ... ON CONFLICT DO NOTHING RETURNING. 'duplicate' return value
  // means "already processed; caller should ROLLBACK and return 200".
}
```

### 7.4 `repo.users.findOrCreateStripeCustomer` (extension)

```ts
interface UsersRepo {
  // ... existing methods ...
  findOrCreateStripeCustomer(userId: string): Promise<string>
  // Returns the cus_*. If users.stripe_customer_id is non-null, returns it.
  // Otherwise calls customer.ts helper to lazy-create at Stripe (with
  // idempotency-key 'customer_for_${userId}'), then UPDATEs users SET
  // stripe_customer_id = $cus_id WHERE id = $userId AND stripe_customer_id IS NULL.
  // Returns the value persisted (which may be a different cus_id if a parallel
  // race already wrote one).
}
```

### 7.5 `repo.credits.atomicDebit` (extension)

The existing recipe (MYT-40) selects credits via `FOR UPDATE`, debits, and INSERTs a debit row. Extend the SELECT to RETURN the consumed credit's `source_type`. The function's return type gains:

```ts
interface AtomicDebitResult {
  // ... existing fields ...
  consumedSourceType: 'purchase' | 'subscription' | 'gift' | 'trial' | 'refund'
}
```

MYT-43 reads `consumedSourceType === 'trial'` to decide "this session is a trial session, apply reduced budget + demo world + time cap." MYT-42 ships the column exposure; MYT-43 ships the consumer.

If the consumed credit's source spans multiple ledger rows (e.g., 1 trial + 1 purchase), the recipe returns the source_type of the highest-priority consumed row. The priority order is whatever MYT-43 chooses (likely earliest-expiring or trial-first); MYT-42's recipe is parametric on it. For now, MYT-42 picks "earliest-expiring, then by ascending source_id" which is a stable ordering that puts NULL-expiry trial credits last — meaning trial credits are consumed only after expiring purchase/subscription credits run out. MYT-43 may change this when it wires the consumer; the contract is "the recipe RETURNs source_type of the consumed row," not the priority order itself.

## 8. Trial credit at registration

Extend `POST /api/users/register`'s existing transaction (in `backend/src/routes/users.ts` per MYT-38) to also:

```sql
-- Inside the same BEGIN that creates the users row:
INSERT INTO credit_ledger
  (id, user_id, credit_type, amount, source_type, source_id, expires_at)
  VALUES ($1, $2, 'session', 1, 'trial', NULL, NULL);

UPDATE users SET free_trial_used = true WHERE id = $2;
```

The trial credit is structurally a `credit_type='session'` row — it goes through the same atomic-debit recipe as any session credit. The `source_type='trial'` marker is the signal MYT-43 reads to apply trial-session limits.

`source_id = NULL` and `expires_at = NULL`: the trial isn't tied to a purchase or invoice; it doesn't expire on a billing cycle. The MYT-40 schema tolerates `source_id = NULL` only for non-debit rows (the CHECK constraint is `(source_type <> 'debit' OR source_id IS NOT NULL)` — trial source_type satisfies this).

`free_trial_used = true` is set at registration, not on consumption. The flag's purpose is "prevent a second trial from ever being granted to this user." If an existing user re-registers (same Cognito sub, somehow), the existing-user check fires earlier and the second registration short-circuits — so this code path runs at most once per `users.id`.

Test added to `backend/src/__tests__/onboarding.test.ts`:
- After successful register, `users.free_trial_used = true`.
- After successful register, exactly one `credit_ledger` row exists for the user with `credit_type='session'`, `amount=1`, `source_type='trial'`, `source_id=NULL`, `expires_at=NULL`.
- Re-registration short-circuit (existing path) does NOT add a second trial credit row.

## 9. Customer-create lifecycle

`backend/src/billing/customer.ts`:

```ts
export async function createStripeCustomer(
  stripe: Stripe,
  userId: string,
  email?: string,  // optional; users.email was dropped in migration 005, so omit unless we have a way
): Promise<string> {
  const customer = await stripe.customers.create(
    {
      metadata: { userId },
      ...(email ? { email } : {}),
    },
    { idempotencyKey: `customer_for_${userId}` },
  )
  return customer.id
}
```

`repo.users.findOrCreateStripeCustomer(userId)`:

```ts
async function findOrCreateStripeCustomer(userId: string): Promise<string> {
  const existing = await this.getStripeCustomerId(userId)
  if (existing) return existing
  const cusId = await createStripeCustomer(stripeClient, userId)
  // Conditional UPDATE: preserve any earlier-written value if a concurrent
  // request beat us.
  const result = await pool.query<{ stripe_customer_id: string }>(
    `UPDATE users SET stripe_customer_id = $2
       WHERE id = $1 AND stripe_customer_id IS NULL
       RETURNING stripe_customer_id`,
    [userId, cusId],
  )
  if (result.rows.length > 0) return cusId
  // We lost the race; re-read.
  const racewinner = await this.getStripeCustomerId(userId)
  if (!racewinner) {
    throw new Error(`findOrCreateStripeCustomer: post-race re-read returned null for userId=${userId}`)
  }
  return racewinner
}
```

Why the idempotency-key strategy: Stripe's `customers.create` accepts an idempotency-key header that returns the same Customer object across retries within 24h. `customer_for_${userId}` is deterministic — concurrent calls collide on Stripe's side and both return the same `cus_*`. Combined with our DB-side conditional UPDATE, double-creation is impossible: at most one Stripe customer per userId, and at most one `users.stripe_customer_id` value per row.

## 10. SKU listing cache

`backend/src/billing/sku-cache.ts`:

```ts
let cache: SkuListing[] | null = null

export function setSkuCache(snapshot: SkuListing[]): void {
  cache = Object.freeze(snapshot.slice())
}

export function getSkuCache(): readonly SkuListing[] | null {
  return cache
}

export interface SkuListing {
  readonly lookup_key: LookupKey
  readonly displayName: string
  readonly type: 'recurring' | 'one_time'
  readonly sessionsGranted: number
  readonly worldsGranted: number
  readonly price: { unit_amount_cents: number; currency: string }
}
```

Populated by `probe.ts` after a successful probe pass — the probe already fetched every Stripe price; building the snapshot is mechanical:

```ts
// at the end of probeStripeContract, after mismatches.length === 0:
setSkuCache(buildSnapshot(LOOKUP_KEYS, byLookup))
```

`GET /api/billing/skus` reads the cache and returns it. Cache miss → 503 (defensive only; the probe would have failed boot before any request was served).

Cache is process-scoped; refreshes only on next deploy (which re-runs the probe). This is the right grain because the probe is the contract — prices changing without a deploy is a violation of the MYT-41 design.

## 11. History endpoint

`GET /api/billing/history?cursor=<id>` returns a unified feed of purchases and subscription invoices for the calling user.

Implementation: a single SQL query that UNIONs `purchases` (mapped to `kind='purchase'`) with `user_subscriptions` invoices fetched from Stripe... actually no — Stripe doesn't expose a "list invoices for customer" SQL view, and we don't mirror invoices into our DB. Two options:

1. **DB-only history** (recommended): the history feed is `purchases` + a thin invoice-mirror table populated by `invoice.paid` handlers. Each `invoice.paid` event INSERTs a `billing_history` row with `(user_id, kind='invoice', stripe_invoice_id, amount_cents, currency, lookup_key, occurred_at)`. The history endpoint queries `purchases UNION billing_history`. Trades a small write at webhook time for a fast, cursor-pageable read.

2. **Live Stripe fetch**: the history endpoint calls `stripe.invoices.list({ customer })`. Latency adds up, hits Stripe rate limits on heavy users, doesn't compose with cursor pagination cleanly.

Option 1 is the choice. It adds a fourth table to migration 007:

```sql
CREATE TABLE billing_history (
  id                          UUID        PRIMARY KEY,
  user_id                     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                        TEXT        NOT NULL CHECK (kind IN ('purchase', 'invoice', 'refund')),
  source_id                   TEXT        NOT NULL UNIQUE,  -- stripe payment_intent_id or invoice_id or refund_id
  lookup_key                  TEXT,                          -- nullable for refunds
  amount_cents                INTEGER     NOT NULL,          -- positive for purchase/invoice, negative for refund
  currency                    TEXT        NOT NULL DEFAULT 'usd',
  occurred_at                 TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_history_user_occurred ON billing_history(user_id, occurred_at DESC, id DESC);
```

`checkout.session.completed`, `invoice.paid`, and `charge.refunded` handlers each INSERT a `billing_history` row alongside their primary writes. All inside the same transaction as `stripe_events.event_id` so the write-set is atomic.

Cursor: the lex-smallest `(occurred_at, id)` of the next page. Query:

```sql
SELECT * FROM billing_history
WHERE user_id = $1
  AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2, $3))
ORDER BY occurred_at DESC, id DESC
LIMIT $4 + 1;  -- fetch one extra to derive nextCursor
```

## 12. Errors + edge cases

| Scenario | Response |
|---|---|
| Checkout body invalid (Zod) | 400 with field-level error |
| Mixed tier + à-la-carte cart | 400 `{ code: 'mixed_cart' }` |
| Tier with quantity > 1 or items.length > 1 | 400 `{ code: 'tier_cart_shape' }` |
| Unknown lookup_key | 400 `{ code: 'unknown_lookup_key' }` |
| Stripe API error during checkout | 502 (logged with detail; client gets generic) |
| User has no `stripe_customer_id` and Stripe is down at portal request | 502 (lazy-create can't complete) |
| Webhook signature missing | 400 `{ error: 'missing_signature' }` |
| Webhook signature invalid | 400 `{ error: 'invalid_signature' }` |
| Webhook secret is `'PLACEHOLDER'` | All signatures invalid → 400. **Fail-closed by design.** The first action after MYT-42 ships is rotating Secrets Manager from PLACEHOLDER → the Dashboard-issued `whsec_*`. |
| Webhook event already processed (idempotent replay) | 200 (stripe_events PK ON CONFLICT DO NOTHING; ROLLBACK and exit) |
| Webhook event for unknown customer | 200 + log + record event_id |
| Webhook event of unknown type | 200 + log + record event_id |
| Refund on an invoice that doesn't map to any local row | 200 + log warning; no negative ledger entry (we have nothing to clawback) |
| Refund makes balance negative | Allowed; atomic-debit at session-start returns 402 until balance is positive |
| Concurrent refund + session-start | credit_ledger FOR UPDATE serializes; refund completes first or session-start consumes pre-refund credits, never both |
| Concurrent checkout calls before customer exists | Stripe idempotency-key dedupes Stripe-side; conditional UPDATE serializes DB-side; net result: one cus_* per userId |
| Subscription event arrives before its checkout.session.completed (out-of-order delivery) | Upsert-shaped handler: `customer.subscription.updated` INSERTs if missing |
| `users.stripe_customer_id` row not found for a `customer.subscription.*` event | 200 + log; treat as unknown customer (above) |
| `invoice.paid` with `billing_reason='subscription_update'` and negative amount (downgrade proration) | Skip credit grant; no negative ledger entry. User keeps existing tier credits through period_end. |

## 13. Testing

**Unit / integration**:
- `backend/src/billing/__tests__/webhook.test.ts` — for each event type, fixture event → handler → expected DB writes. Idempotency replay (same event_id twice → second is no-op). Signature failure → 400.
- `backend/src/billing/__tests__/customer.test.ts` — `findOrCreateStripeCustomer` happy path, idempotency-key on retry, race-loser branch.
- `backend/src/billing/__tests__/sku-cache.test.ts` — set/get, cache miss returns null.
- `backend/src/repo/__tests__/purchases.test.ts`, `user-subscriptions.test.ts`, `stripe-events.test.ts` — repo CRUD + the upsert + the duplicate-detection path.
- `backend/src/repo/__tests__/credits.test.ts` — extend existing `atomicDebit` test to assert `consumedSourceType` is in the result.
- `backend/src/routes/__tests__/billing.test.ts` — for each route: auth contract, body validation, cart-shape rules, response shape.
- `backend/src/routes/__tests__/webhook.test.ts` — raw-body parser scope (a JSON body with malformed JSON should still verify if the signature matches the bytes, since we don't parse before constructEvent).
- `backend/src/__tests__/onboarding.test.ts` — extended for trial-credit insertion + free_trial_used flag.

**Schema parity**: `backend/src/db/__tests__/migrate-schema.test.ts` updated for migration 007 (purchases, user_subscriptions, billing_history; their indexes; their check constraints; their FKs).

**Webhook absence test removed**: MYT-41's `backend/src/__tests__/webhook-absence.test.ts` (which asserted POST /webhooks/stripe returns 404) is deleted as part of this issue, since the route now exists.

## 14. Spec patches to other docs

- `docs/specs/2026-04-13-billing-cost-controls.md` §4 (purchase flow) — refer to the unified `POST /api/billing/checkout` body shape; drop any leftover language about per-line metadata.packId.
- `docs/specs/2026-04-13-billing-cost-controls.md` §7 (free trial) — refine the patched language to reflect the source_type='trial' signal MYT-42 surfaces and MYT-43 reads. (The current patch is close; this issue tightens it.)
- `docs/specs/2026-04-13-billing-cost-controls.md` §10 (edge cases) — add the refund-makes-balance-negative case + the concurrent-checkout-customer-create case.
- `docs/specs/2026-04-13-backend-core.md` §5.2 (repo namespace listings) — restore `repo.purchases`, `repo.userSubscriptions`, `repo.stripeEvents` to the "shipped" set; remove the corresponding deferral row from §5.4's deferral table.
- `docs/specs/2026-04-13-backend-core.md` schema block — `purchases` and `user_subscriptions` come back with the new shape; add `billing_history`.

## 15. Operational notes

**Webhook secret rotation post-MYT-42 deploy** (manual ops, will land in the wiki runbook):

1. After MYT-42 deploys to staging, register the webhook endpoint in the Stripe Dashboard test-mode account (`https://dashboard.stripe.com/test/webhooks` → Add endpoint → URL `https://staging.mythrun.com/webhooks/stripe`, events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`).
2. Stripe issues a `whsec_*` signing secret on creation; copy it.
3. `aws secretsmanager update-secret --secret-id mythrun/staging/stripe-webhook-secret --secret-string 'whsec_<value>'`.
4. Force a rolling deploy (`gh workflow run Deploy`) so the new secret is loaded.
5. Verify: send a test event from the Dashboard's Webhook detail page; confirm 200 + a `stripe_events` row.

Until step 3, every webhook returns 400 (PLACEHOLDER fails closed). Stripe queues retries with exponential backoff.

**Boot probe parity**: when MYT-42 lands, the probe still verifies the same 5 lookup_keys. The MYT-42 surface doesn't change Stripe's price catalog. The new `sku-cache` is a side effect of a successful probe pass; cache failure doesn't gate boot.

**MYT-43 hand-off**: MYT-43 picks up the `consumedSourceType` exposed by `atomicDebit` and decides:
- The consumption-priority order (likely earliest-expiring, with trial credits last).
- The session-start branching: if `consumedSourceType === 'trial'` → trial-mode session (reduced budget, demo world, time cap).

MYT-42 intentionally does NOT pick the priority order; that's a session-runtime concern.

---

## Appendix: what-this-doc-is-not

This is the design for MYT-42 specifically. It is not:
- The MYT-41 spec (which sets the contract this implements). See `docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md`.
- The implementation plan (next step after this spec is approved). The plan will land at `docs/superpowers/plans/2026-05-05-myt-42-stripe-webhook-checkout.md` via the writing-plans skill.
- The parent billing spec. See `docs/specs/2026-04-13-billing-cost-controls.md` for the user-experience-level contract, which this design implements.
