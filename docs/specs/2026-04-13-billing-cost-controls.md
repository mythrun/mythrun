# Billing & Cost Controls Sub-Spec

> **Type**: Sub-spec (conforms to Production Architecture Overview)
> **Date**: 2026-04-13
> **Status**: Draft
> **Parent**: `2026-04-06-production-architecture-overview.md`
> **Depends on**: Backend Core (schema, repository), Auth & Users (user identity, JWT middleware)
> **Scope**: Stripe integration, subscription + session pack billing, dual credit types (sessions + world gen), token budget metering, free trial with cliffhanger, per-session cost tracking, spending alerts.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Credit Model](#2-credit-model)
3. [Subscription Tiers](#3-subscription-tiers)
4. [À-la-carte SKUs](#4-à-la-carte-skus)
5. [Stripe Integration](#5-stripe-integration)
6. [Session Budget and Token Metering](#6-session-budget-and-token-metering)
7. [Free Trial](#7-free-trial)
8. [Cost Tracking and Alerts](#8-cost-tracking-and-alerts)
9. [API Routes](#9-api-routes)
10. [Edge Cases](#10-edge-cases)
11. [Out of Scope](#11-out-of-scope)

---

## 1. Overview

Mythrun's billing model has two resource types with different costs:

| Resource | Per-unit LLM cost | What it buys |
|----------|------------------|-------------|
| **Session** | $1-3 in API calls | One game session (token-budgeted, ~2-4 hours) |
| **World generation** | $3-5 in API calls | One complete world (concept through starting situations) |

Both resources are tracked via a credit ledger. Credits are granted by subscriptions (monthly) or one-time pack purchases. The campaign owner's credits are consumed — players just need an account.

### Key Design Decisions (from architecture overview)

- Campaign owner pays for sessions
- Atomic credit decrement (no race conditions)
- Token budget per session with graceful wind-down at 90%
- Free trial: one session in a pre-built demo world, time-capped, ends on cliffhanger
- Subscription is primary, packs are secondary
- World gen credits are separate from session credits (capped per tier)
- Credit ledger supports rollover or expiry (business decision deferred)

---

## 2. Credit Model

### Credit Ledger

The `credit_ledger` table (from Backend Core spec) tracks all credit transactions:

```sql
CREATE TABLE credit_ledger (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('session', 'world_gen')),
  amount INTEGER NOT NULL,  -- positive = grant, negative = debit
  source_type TEXT NOT NULL CHECK (source_type IN ('subscription', 'purchase', 'gift', 'trial', 'refund', 'debit')),
  source_id UUID,  -- references purchases.id or subscription event ID
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ  -- null = never expires
);
CREATE INDEX idx_credit_ledger_user_type ON credit_ledger(user_id, credit_type, expires_at);
```

**Note:** The Backend Core spec's `credit_ledger` table needs updating to add the `credit_type` column. This change should be incorporated into migration 001.

### Balance Calculation

```sql
SELECT COALESCE(SUM(amount), 0) AS balance
FROM credit_ledger
WHERE user_id = $1
  AND credit_type = $2
  AND (expires_at IS NULL OR expires_at > now());
```

This query is fast: indexed scan scoped to one user's ledger entries for one credit type.

### Atomic Debit

To consume a credit (e.g., starting a session):

```sql
-- atomic-debit recipe — see MYT-40 design spec
-- (docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md) for the
-- full rationale and the empty-ledger-race history.

BEGIN;
SET LOCAL transaction_isolation = 'read committed';
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Lock anchor on the users row (always exists; FK guarantees). Locking
-- on credit_ledger rows would race when no rows exist — see "the bug"
-- below.
SELECT id FROM users WHERE id = $userId FOR UPDATE;
-- rowCount = 0 → throw UserNotFoundError (404), NOT InsufficientCreditsError.

-- Idempotency check: a retry of the same logical debit returns the prior row.
SELECT * FROM credit_ledger
  WHERE user_id = $userId
    AND credit_type = $type
    AND source_type = 'debit'
    AND source_id = $sourceId;
-- If found: assert amount matches; COMMIT and return prior row.

-- Balance check: only spendable (unexpired) credits count.
SELECT COALESCE(SUM(amount), 0) AS balance
  FROM credit_ledger
  WHERE user_id = $userId
    AND credit_type = $type
    AND (expires_at IS NULL OR expires_at > now());

-- If balance >= amount: insert debit, COMMIT.
-- Else: ROLLBACK and throw InsufficientCreditsError.
INSERT INTO credit_ledger
  (id, user_id, credit_type, amount, source_type, source_id)
  VALUES ($id, $userId, $type, -$amount, 'debit', $sourceId);

COMMIT;
```

**The bug in the original recipe:** A previous draft of this section anchored the lock on `credit_ledger` rows (`SELECT SUM(amount) FROM credit_ledger ... FOR UPDATE`). This is incorrect when the user has zero ledger rows yet — `FOR UPDATE` locks zero tuples (PostgreSQL row locks are physical, not predicate, outside SERIALIZABLE), so two concurrent debits both see balance=0 and both insert. The fix is to anchor on the `users` row, which always exists by FK. The MYT-40 design (`docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md`) covers the full reasoning, including why this works under READ COMMITTED but would break under REPEATABLE READ.

---

## 3. Subscription Tiers

### Infrastructure

Subscription tier metadata lives in `backend/src/billing/lookup-keys.ts`. Stripe Prices map to tiers by `lookup_key`; the DB does not cache tier metadata. (See MYT-41 spec for the design rationale: Stripe stays the source of truth for prices; the lookup-keys file is the closed enum that backend code reads.)

### Launch Tiers

| Tier ID | Name | Sessions/mo | World Gens/mo | Target Price |
|---------|------|-------------|---------------|-------------|
| `tier_wayfarer` | Wayfarer | 4 | 1 | $X/mo |
| `tier_sojourner` | Sojourner | 8 | 2 | $Y/mo |
| `tier_mythwright` | Mythwright | 16 | 4 | $Z/mo |

Exact pricing populated after per-session and per-world-gen cost modeling.

### Subscription Lifecycle

1. **Subscribe:** User selects a tier → Stripe Checkout → `checkout.session.completed` webhook → create `credit_ledger` entries (session credits + world gen credits) — tier metadata read from `lookup-keys.ts` contract.
2. **Monthly renewal:** Stripe charges automatically → `invoice.paid` webhook → grant new monthly credits.
3. **Cancel:** User cancels via Stripe Customer Portal → `customer.subscription.deleted` webhook → no new credits granted. Existing credits remain usable through `current_period_end` (no retroactive expiry).
4. **Upgrade/downgrade:** Handled by Stripe proration via Customer Portal Switch Plan. The webhook processes the new tier's credit grant.

### Subscription Tracking

```sql
CREATE TABLE user_subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_lookup_key TEXT NOT NULL,  -- closed enum enforced at write-time by MYT-42 webhook handler
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);
```

> MYT-42 ships migration 007 with this new shape (replacing the legacy `tier_id REFERENCES subscription_tiers(id)` column dropped in MYT-41 migration 006).

### Rollover Policy

No rollover at launch. Tier credits are granted with `expires_at = current_period_end`. Mid-period cancellation does not retroactively expire that period's credits — the user paid for the period, gets to use it through `current_period_end`.

---

## 4. À-la-carte SKUs

### SKU Configuration

SKU metadata lives in `backend/src/billing/lookup-keys.ts`. Stripe Prices map to SKUs by `lookup_key`. There is no DB-resident pack table.

### Launch SKUs

| SKU ID | Display Name | Sessions | World Gens | Target Price |
|---|---|---|---|---|
| `sku_session` | Session | 1 | 0 | $X |
| `sku_world` | World | 1 | 1 | $Y |

À-la-carte credits never expire (`expires_at = NULL`).

### Purchase Flow

1. User adds SKUs to cart → `POST /api/billing/checkout` with the unified body shape `{ items: [{ lookup_key, quantity }] }` (cart-shape rules per MYT-41 spec §3 — single-tier carts use `mode: 'subscription'`; à-la-carte-only carts use `mode: 'payment'`; mixed carts → 400 reject). The `metadata.packId` shape from earlier drafts is gone — there's no per-line metadata.packId; `metadata` carries only `userId` (server-derived from the JWT).
2. Server resolves each `lookup_key` to its Stripe Price via the runtime probe-validated mapping → creates Stripe Checkout Session.
3. Server stores `metadata: { userId }` on the Stripe Checkout Session (per-line-item `lookup_key` walk replaces the single packId field — see MYT-41 spec §"Webhook credit-grant contract for MYT-42").
4. Returns `{ checkoutUrl }` → frontend redirects to Stripe.
5. Stripe processes payment → `checkout.session.completed` webhook (writes `user_subscriptions` for tier carts; writes `purchases` + grants credits for à-la-carte). For tier carts, the credit grant comes from the corresponding `invoice.paid` event with `billing_reason='subscription_create'` — NOT from `checkout.session.completed`. See MYT-42 §5.4.1 + MYT-41 §"Per-event-type resolution rules" (Decision 1 of MYT-42 round-2 review).
6. Webhook handler: reads `metadata.userId`, iterates Checkout Session `line_items` keyed by `lookup_key`, inserts `purchases` row + `credit_ledger` entries (one per item × quantity) for à-la-carte; for tier mode, inserts only the `user_subscriptions` row and waits for `invoice.paid` to grant credits.
7. User sees credits in their balance.

> MYT-42 ships migration 007 which recreates the `purchases` table with a composite UNIQUE on `(stripe_event_id, kind)`, and adds `user_subscriptions` (with expanded status enum + `cancel_at` + `cancellation_details` + `stripe_event_created_at`), `billing_history` (kind/status/expires_at/occurred_at), and the `credit_ledger.source_purchase_id` + `credit_ledger.source_billing_history_id` FK columns + the `credit_ledger_source_link_chk` constraint.

---

## 5. Stripe Integration

### Products and Prices

All products and prices are created in Stripe Dashboard (not via API). Code references prices by `lookup_key` only; no Stripe Price IDs are stored in the application database. The `backend/src/billing/lookup-keys.ts` contract is the closed enum; the boot probe (MYT-41) verifies every key resolves to a price with the expected shape (currency, type, billing_scheme, recurring interval, etc.).

### Endpoint split (MYT-42)

MYT-42 splits the user-facing Stripe entry points by intent:

- **`POST /api/billing/checkout`** — new subscriptions and new à-la-carte purchases. Body: `{ items: [{ lookup_key, quantity }] }`. Cart-shape rules per MYT-41 §3 (single-tier OR à-la-carte-only; mixed rejects 400; tier-cart quantity must be 1).
- **`POST /api/billing/upgrade-tier`** — tier upgrades for an existing active subscription. Body: `{ target_tier_lookup_key }`. Returns `{ invoice_id, amount_paid_cents }`. Server-side calls `stripe.subscriptions.update` with `payment_behavior: 'pending_if_incomplete'`; the actual credit grant lands on the `customer.subscription.pending_update_applied` webhook (MYT-42 §4.6 / §5.4.6). Tier upgrades do NOT go through Customer Portal.
- **`POST /api/billing/portal`** — Customer Portal session for downgrades + cancel + payment-method update + invoice history. Tier upgrades are NOT in the Portal allowlist (per-tier `subscription_update.products` is downgrade-only; see MYT-41 spec §"Customer Portal config").

### Webhook Handling

**Endpoint:** `POST /webhooks/stripe`

**Verification:** Every webhook request is verified using the Stripe webhook signing secret. Unverified requests are rejected with 400.

**Events handled:**

| Event | Action |
|-------|--------|
| `checkout.session.completed` | For one-time: create `purchases` row, grant pack credits. For subscription: create `user_subscriptions` row, grant first month's credits. |
| `invoice.paid` | Grant monthly subscription credits (after the first month). |
| `customer.subscription.updated` | Update `user_subscriptions` tier/status (upgrade/downgrade). |
| `customer.subscription.deleted` | Mark subscription as canceled. |
| `charge.refunded` | Insert negative credit_ledger entry (clawback credits). If balance goes negative, flag for manual review. |

**Idempotency:** Every webhook includes a Stripe event ID. We store processed event IDs in a `stripe_events` table and skip duplicates:

```sql
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Ordering:** Stripe webhooks can arrive out of order. The handler checks the current state before applying changes (e.g., don't grant credits if the subscription is already canceled).

### Stripe Customer Portal

Users manage their subscription via Stripe's hosted Customer Portal. Enabled features at launch (Stripe's exact Dashboard labels):

- **Cancel subscription** (Cancel at end of billing period)
- **Switch plan** (allowlist: Wayfarer, Sojourner, Mythwright)
- **Payment methods** (update; card only at launch)
- **Invoice history** (visible)

Disabled at launch: Promotion codes, Retention coupons, Tax ID, Phone, Shipping address, Update quantities, Cancellation reason (optional, off at launch).

`GET /api/billing/portal` → creates a Stripe portal session → returns `{ portalUrl }` → frontend redirects.

No custom payment management UI needed.

### Price Manipulation Prevention

Pricing is immutable from application code. Defense in depth, in order of strength:

1. **Stripe restricted API key** with no `Prices: write` or `Products: write` — Stripe's API rejects mutation attempts at the network level. This is the actual SDK-level boundary.
2. **Code references prices by `lookup_key` only** — no hardcoded Stripe Price IDs anywhere in the application. The `backend/src/billing/lookup-keys.ts` contract is the closed enum; the boot probe (MYT-41) verifies every key resolves to a price with the expected shape.
3. **ESLint rules** `mythrun/no-stripe-price-mutations` and `mythrun/no-stripe-subscription-price-mutation` ban price/product/coupon catalog mutations and subscription item-price mutations — code-review tripwires above the SDK boundary, not runtime boundaries.

Per-charge correctness is the webhook handler's responsibility (MYT-42): it reconstructs the expected `amount_total` from each line-item's `lookup_key` and verifies against the Stripe-reported total before crediting. Catalog-shape correctness is the boot probe's responsibility (MYT-41): if any lookup_key doesn't resolve to an active price with the expected shape, the deploy fails closed.

Credit allocation happens ONLY in the webhook handler, never on the checkout success redirect. The success redirect URL (`/billing/success`) shows a "Processing..." state until the webhook fires and credits appear in the balance.

---

## 6. Session Budget and Token Metering

### Token Budget

Each session is allocated a token budget when it starts. The budget is defined per credit type (session credits from tier subscriptions may have a different budget than session credits from à-la-carte SKUs — for launch, identical).

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Default token budget | 500,000 output tokens | ~2-4 hours of play at estimated 3,000-5,000 output tokens per turn, 100-150 turns per session |
| Warning threshold | 80% (400,000 tokens) | Gives players ~20 more turns to wrap up |
| Wind-down threshold | 90% (450,000 tokens) | ST instructed to guide session to natural pause |
| Hard cap | 120% (600,000 tokens) | Absolute maximum — cancel stream if exceeded |

These values are configurable in the `settings` table, not hardcoded.

### Token Accumulation

During a session, every LLM call reports its token usage. The flow:

1. LLM call completes → returns `{ input_tokens, output_tokens }`
2. Session controller increments Redis counters: `INCRBY session:{campaignId}:usage:input {input_tokens}`, `INCRBY session:{campaignId}:usage:output {output_tokens}`
3. After incrementing, read the current output total
4. If output total > 80% of budget → send `session_budget_warning` to all clients
5. If output total > 90% of budget → inject wind-down instruction into ST's next evaluation
6. Redis counters are checkpointed to `session_usage` Postgres table every 5 minutes (per the session state checkpoint strategy)

### Cost Estimation

For display purposes (not billing — billing is per session credit, not per token):

```typescript
const MODEL_PRICING = {  // $/MTok
  opus:   { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku:  { input: 0.80, output: 4 },
}
```

The `session_usage.estimated_cost_usd` is calculated on session end by summing `(input_tokens * input_price + output_tokens * output_price) / 1_000_000` across all model tiers used during the session.

---

## 7. Free Trial

### What the User Gets

- One free session in a **pre-built demo world** (no world-gen cost)
- Time-capped at **45 minutes** (tracked via session start time, not token budget)
- Reduced token budget (250,000 output tokens — half of normal)
- Ends with a **narrative cliffhanger** (ST instructed to create a hook, not a resolution)
- After trial ends, user sees conversion prompt (from UX spec)

### Implementation

Trial credit is granted at registration, not at session-start. On `POST /api/users/register`, the same transaction that creates the `users` row inserts a `credit_ledger` row (`credit_type='session', amount=1, source_type='trial', source_id=NULL, source_purchase_id=NULL, source_billing_history_id=NULL, expires_at=NULL`) and sets `users.free_trial_used = true`. The `source_type='trial'` value is the **signal MYT-42 emits** — it's how downstream code identifies the row consumed at session-start as the trial credit (vs. a paid session credit).

Sessions consume the trial credit via the standard atomic-debit recipe (§2), but **MYT-43 MUST honor the trial-FIRST consumption invariant**: for users who have BOTH trial credit and paid credits in their balance, the atomic-debit recipe consumes the trial row before any paid row, so the trial UX (reduced budget, demo world, time cap) runs on the trial credit and not on a paid credit. The recipe redesign that exposes `consumedSourceType` from atomic-debit is deferred to MYT-43 (per MYT-42 §7.6 hand-off); MYT-42 pins only the trial-FIRST invariant and the `source_type='trial'` signal.

No special trial-mode session machinery; the time-cap, reduced token budget, and demo-world choices below are session-runtime concerns owned by MYT-43, decoupled from credit-grant timing.

1. `users.free_trial_used` flag (set true at registration; subsequent registrations of an existing-by-username user MUST NOT re-grant).
2. When a trial-credit session starts:
   - Token budget is reduced
   - A 45-minute timer starts
   - The pre-built demo world is used (a specific world ID configured in settings)
3. At 40 minutes, the ST receives: "The session is ending in 5 minutes. Guide the narrative to a compelling cliffhanger — an unresolved tension, a revelation, a danger emerging. Do NOT resolve the current situation."
4. At 45 minutes, the session ends regardless. The ST fires a final `session_end` with a hook summary.
5. The conversion prompt appears.

### Demo World

A carefully crafted world that:
- Showcases the best of the AI DM experience (interesting NPCs, atmospheric locations, a strong start)
- Is pre-generated and stored in the database (no pipeline cost)
- Is forked per-user on trial start (so their trial session doesn't affect other trials)
- Has enough depth for a 45-minute hook but doesn't need to support long campaigns

The demo world is created manually (or via the pipeline once and then frozen). It's a content investment, not an engineering feature.

---

## 8. Cost Tracking and Alerts

### Per-Session Cost Tracking

The `session_usage` table captures per-session costs:

```sql
-- Already in Backend Core schema
CREATE TABLE session_usage (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  user_id UUID NOT NULL REFERENCES users(id),  -- the owner who paid
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  budget_limit_tokens INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Per-World-Gen Cost Tracking

Pipeline stages already track token usage in `pipeline_runs` (input_tokens, output_tokens, cost_usd). Total world-gen cost is `SUM(cost_usd) FROM pipeline_runs WHERE world_id = $1`.

### Operator Alerts

CloudWatch alarms for cost anomalies:

| Alarm | Condition | Action |
|-------|-----------|--------|
| Daily LLM spend exceeds $X | Custom metric: sum of `estimated_cost_usd` across all sessions in 24h | SNS → SMS |
| Single session exceeds $10 | Per-session cost check at session end | Log warning |
| World gen exceeds $15 | Per-world cost check at pipeline completion | Log warning |
| Monthly Anthropic API spend | AWS billing alarm on the Anthropic account (separate from Mythrun infra billing) | SNS → email |

### Cost Dashboard (Future)

A simple admin page showing:
- Daily/weekly/monthly LLM spend breakdown (by session vs world gen)
- Average cost per session and per world gen
- Revenue vs cost per user
- Margin per session

This is deferred to the Observability sub-spec or a future admin tools project.

---

## 9. API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/billing/balance` | JWT | Get current credit balances + active tier `{ balance: { session, world_gen }, tier: { lookup_key, displayName, renewsAt } | null }` |
| GET | `/api/billing/skus` | Public | List available SKUs keyed by `lookup_key` (covers both tier subscriptions and à-la-carte items). Caching/TTL/fallback rules per MYT-41 spec §4. |
| POST | `/api/billing/checkout` | JWT | Create Stripe Checkout Session. Body: `{ items: [{ lookup_key, quantity }] }`. Mode (`subscription`/`payment`) is server-derived from cart shape per MYT-41 spec §3. |
| GET | `/api/billing/portal` | JWT | Get Stripe Customer Portal URL |
| GET | `/api/billing/history` | JWT | Purchase and subscription history |
| GET | `/api/billing/subscription` | JWT | Current subscription details (tier, status, period dates) |
| POST | `/webhooks/stripe` | Stripe signature | Handle Stripe webhook events |

### Balance Endpoint Response

```json
{
  "balance": {
    "session": 7,
    "world_gen": 2
  },
  "tier": {
    "lookup_key": "tier_wayfarer",
    "displayName": "Wayfarer",
    "renewsAt": "2026-05-13T00:00:00Z"
  }
}
```

`tier` is `null` when the user has no active subscription.

### Checkout Endpoint

Body shape: `{ items: [{ lookup_key, quantity }] }`. The Checkout `mode` is server-derived from the items' types per the cart-shapes table in MYT-41 spec §3 (single-tier carts → `'subscription'`; à-la-carte-only carts → `'payment'`; mixed → 400 reject).

The server creates the Stripe Checkout Session with:
- `mode: 'subscription'` or `mode: 'payment'` (server-derived from cart shape)
- `line_items: [{ price: <resolved-from-lookup_key>, quantity }]` for each cart item
- `metadata: { userId }` (per-line-item `lookup_key` walk replaces tierId/packId)
- `success_url: https://mythrun.com/billing/success?session_id={CHECKOUT_SESSION_ID}`
- `cancel_url: https://mythrun.com/billing/cancel`
- `customer`: existing Stripe customer ID if the user has one, or auto-create

### Stripe Customer Mapping

`users.stripe_customer_id` is part of the initial schema (migration 001). Populated lazily on first checkout via `customers.create` in MYT-42. Subsequent checkouts use the existing customer ID so payment methods and history are linked.

---

## 10. Edge Cases

| Scenario | Handling |
|----------|---------|
| **Double-click on checkout button** | Frontend disables button after first click. Backend is idempotent (same checkout session reused). |
| **Webhook arrives before success redirect** | Normal case. Credits are granted on webhook, not on redirect. Frontend polls balance on success page. |
| **Webhook delayed (>30s)** | Success page shows "Processing your purchase..." with a polling check on `/api/billing/balance`. Timeout after 60s with "If credits don't appear, contact support." |
| **User starts session right as credits expire** | The `FOR UPDATE` lock in the debit transaction prevents race conditions. If credits expired between page load and session start, the debit fails gracefully. |
| **Refund after credits are spent** | Negative credit_ledger entry. If balance goes negative, user can't start new sessions until balance is positive (next month's grant or a new purchase). |
| **Subscription payment fails** | Stripe retries automatically (3 attempts over ~2 weeks). During `past_due` status, no new credits are granted but existing credits still work. After final failure, subscription is canceled. |
| **User has both subscription and à-la-carte credits** | Both contribute to balance. Debit ordering is implementation-defined; MYT-43 picks the consumption-priority strategy. **Trial-FIRST invariant**: users with both trial and paid credits MUST consume trial before any paid row (per §7). |
| **Owner leaves mid-session** | Session continues using already-debited credit. No new debit occurs. If owner loses credits mid-session (impossible — debit happens at start), the session finishes normally. |
| **Campaign ownership transfer** | New owner's credits are used for future sessions. Past session costs stay attributed to the original owner. |
| **Refund makes balance negative** | Clawback inserts a negative-polarity row (`source_type='debit'`, `expires_at=NULL`) via `repo.credits.recordClawback`; `SUM(amount)` may go negative. New session-start fails `InsufficientCreditsError`. Operator alarm `billing.refund_makes_balance_negative` per MYT-42 spec §15.5 (Decision 5 of round-2 review). User can recover by purchasing more credits or waiting for next subscription cycle. |
| **Refund against expired bucket** | The original credit row may have `expires_at < now()` by the time the refund arrives. Clawback still inserts the negative row with `expires_at=NULL` (debit rows never expire per migration 004's `credit_ledger_debit_no_expiry_chk`). Effective balance: the expired credit was already excluded from the balance SUM by the expiry filter, so the negative row reduces SUM further. Operator alarm flags this as a corner case per MYT-42 §10. |
| **Refund mid-session** | Session has already debited the credit at start. The refund's clawback inserts an additional negative row; the session continues to completion (no mid-session debit reversal). Net balance reflects both the start-of-session debit AND the refund clawback. |
| **Concurrent checkout customer-create** | Two simultaneous first-checkout requests from the same user race on `users.stripe_customer_id`. MYT-42 §9 specifies a `SELECT … FOR UPDATE` on the users row inside `findOrCreateStripeCustomer(tx, userId)` PLUS Stripe's `idempotencyKey: 'mythrun-customer-${userId}'` on `customers.create`. The DB lock serializes the two requests; Stripe's idempotency-key collapses any duplicate `customers.create` calls to a single customer record. |
| **Partial refund paging** | Operator clicks Refund with a partial amount in Dashboard. Per Decision 5 of MYT-42 round-2 review, partial refunds are unsupported at launch; the webhook handler emits `billing.partial_refund_unsupported` and skips clawback. Manual reconciliation required. |
| **Tier-upgrade mid-period** | User on Wayfarer upgrades to Sojourner via `/api/billing/upgrade-tier`. Stripe applies a flat dollar delta proration ($25 - $15 = $10 charged immediately). On `customer.subscription.pending_update_applied`, MYT-42 grants the **full credit delta** (4 → 8 sessions, 1 → 2 worlds = +4 sessions, +1 world) with `expires_at` extended to the new period end. The `payment_behavior: 'pending_if_incomplete'` flag ensures items don't advance until the proration invoice is paid (no zero-credit tier-advance state). |

---

## 11. Out of Scope

| Feature | Deferred To |
|---------|------------|
| Exact pricing numbers | Post-cost-modeling — requires real per-turn and per-world-gen data |
| Cost dashboard / admin panel | Observability sub-spec or future admin tools |
| Creator payouts (world marketplace) | Future marketplace sub-spec |
| Gift credits / promo codes | Future — ledger already supports `source_type = 'gift'` |
| Usage-based billing (per-token) | Rejected — session packs are the model |
| Cryptocurrency payments | No |
| Regional pricing | Future — Stripe supports this natively |
| Annual subscription discount | Future — add when monthly retention data exists |
