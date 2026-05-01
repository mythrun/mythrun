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
4. [Session Packs (One-Time Purchases)](#4-session-packs-one-time-purchases)
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

Tiers are defined as a **configuration table**, not hardcoded. This allows adding/changing tiers without code deploys.

```sql
CREATE TABLE subscription_tiers (
  id TEXT PRIMARY KEY,  -- e.g., 'adventurer', 'champion'
  name TEXT NOT NULL,
  stripe_price_id TEXT NOT NULL,  -- Stripe's price identifier
  session_credits_per_month INTEGER NOT NULL,
  world_gen_credits_per_month INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Launch Tiers (Configurable — Exact Pricing TBD After Cost Modeling)

| Tier ID | Name | Sessions/mo | World Gens/mo | Target Price |
|---------|------|-------------|---------------|-------------|
| `adventurer` | Adventurer | ~4-6 | 1 | $X/mo |
| `champion` | Champion | ~10-12 | 2-3 | $Y/mo |

Exact numbers are populated after per-session and per-world-gen cost modeling is complete. The infrastructure supports any values.

### Subscription Lifecycle

1. **Subscribe:** User selects a tier → Stripe Checkout → `checkout.session.completed` webhook → create `credit_ledger` entries (session credits + world gen credits)
2. **Monthly renewal:** Stripe charges automatically → `invoice.paid` webhook → grant new monthly credits
3. **Cancel:** User cancels via Stripe Customer Portal → `customer.subscription.deleted` webhook → no new credits granted. Existing credits remain usable until expiry (if rollover is off) or indefinitely (if rollover is on).
4. **Upgrade/downgrade:** Handled by Stripe proration. The webhook processes the new tier's credit grant.

### Subscription Tracking

```sql
CREATE TABLE user_subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES subscription_tiers(id),
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_subscriptions_user ON user_subscriptions(user_id);
```

### Rollover Flexibility

The `expires_at` column on `credit_ledger` enables both models:

- **No rollover:** Credits granted with `expires_at = current_period_end`. Unused credits expire at the end of the billing cycle.
- **Rollover with cap:** Credits granted with `expires_at = NULL` (never expire). A separate check enforces maximum balance: `IF current_balance + new_grant > cap THEN grant = cap - current_balance`.

The business decision (rollover vs no-rollover) is a configuration flag, not a code change.

---

## 4. Session Packs (One-Time Purchases)

### Pack Configuration

```sql
CREATE TABLE session_packs (
  id TEXT PRIMARY KEY,  -- e.g., 'pack_5', 'pack_12'
  name TEXT NOT NULL,
  session_credits INTEGER NOT NULL,
  world_gen_credits INTEGER NOT NULL DEFAULT 0,
  stripe_price_id TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Launch Packs (Pricing TBD)

| Pack ID | Sessions | World Gens | Target Price |
|---------|----------|------------|-------------|
| `pack_5` | 5 | 0 | $X |
| `pack_12` | 12 | 1 | $Y |

Pack credits never expire (`expires_at = NULL`).

### Purchase Flow

1. User selects a pack → `POST /api/billing/checkout` with `{ packId: 'pack_5' }`
2. Server looks up the pack in `session_packs` table → creates Stripe Checkout Session with the `stripe_price_id`
3. Server stores `metadata: { packId, userId }` on the Stripe Checkout Session
4. Returns `{ checkoutUrl }` → frontend redirects to Stripe
5. Stripe processes payment → `checkout.session.completed` webhook
6. Webhook handler: reads `metadata`, inserts `purchases` row, inserts `credit_ledger` entries
7. User sees credits in their balance

---

## 5. Stripe Integration

### Products and Prices

All products and prices are created in Stripe Dashboard (not via API). The Stripe Price IDs are stored in our `subscription_tiers` and `session_packs` tables.

| Stripe Product | Type | Prices |
|---------------|------|--------|
| Mythrun Adventurer | Recurring (monthly) | One price per tier |
| Mythrun Champion | Recurring (monthly) | One price per tier |
| Session Pack (5) | One-time | One price |
| Session Pack (12) | One-time | One price |

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

Users manage their payment method, view invoices, and cancel subscriptions via Stripe's hosted Customer Portal:

`GET /api/billing/portal` → creates a Stripe portal session → returns `{ portalUrl }` → frontend redirects.

No custom payment management UI needed.

### Price Manipulation Prevention

- The server maps pack/tier IDs to Stripe Price IDs from the database — the client never sends a price
- The webhook handler verifies `amount_total` matches the expected price for the pack/tier in `metadata`
- Credit allocation happens ONLY in the webhook handler, never on the checkout success redirect
- The success redirect URL (`/billing/success`) shows a "Processing..." state until the webhook fires and credits appear in the balance

---

## 6. Session Budget and Token Metering

### Token Budget

Each session is allocated a token budget when it starts. The budget is defined per credit type (session credits from subscriptions may have a different budget than session credits from packs — but for launch, they're identical).

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

1. `users.free_trial_used` flag (from schema)
2. When a user with no credits and `free_trial_used = false` starts a session:
   - The session is flagged as a trial session (`session_usage.source_type = 'trial'`)
   - Token budget is reduced
   - A 45-minute timer starts
   - The pre-built demo world is used (a specific world ID configured in settings)
3. At 40 minutes, the ST receives: "The session is ending in 5 minutes. Guide the narrative to a compelling cliffhanger — an unresolved tension, a revelation, a danger emerging. Do NOT resolve the current situation."
4. At 45 minutes, the session ends regardless. The ST fires a final `session_end` with a hook summary.
5. `free_trial_used` is set to `true`
6. The conversion prompt appears

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
| GET | `/api/billing/balance` | JWT | Get current credit balances `{ session_credits, world_gen_credits }` |
| GET | `/api/billing/tiers` | Public | List available subscription tiers (for pricing page) |
| GET | `/api/billing/packs` | Public | List available session packs |
| POST | `/api/billing/checkout` | JWT | Create Stripe Checkout Session. Body: `{ type: 'subscription', tierId }` or `{ type: 'pack', packId }` |
| GET | `/api/billing/portal` | JWT | Get Stripe Customer Portal URL |
| GET | `/api/billing/history` | JWT | Purchase and subscription history |
| GET | `/api/billing/subscription` | JWT | Current subscription details (tier, status, period dates) |
| POST | `/webhooks/stripe` | Stripe signature | Handle Stripe webhook events |

### Balance Endpoint Response

```json
{
  "session_credits": 7,
  "world_gen_credits": 2,
  "subscription": {
    "tier": "adventurer",
    "status": "active",
    "renewsAt": "2026-05-13T00:00:00Z"
  }
}
```

### Checkout Endpoint

The server creates the Stripe Checkout Session with:
- `mode: 'subscription'` or `mode: 'payment'` (depending on type)
- `line_items: [{ price: stripe_price_id, quantity: 1 }]`
- `metadata: { userId, tierId/packId }` — used by the webhook to credit the right user
- `success_url: https://mythrun.com/billing/success?session_id={CHECKOUT_SESSION_ID}`
- `cancel_url: https://mythrun.com/billing/cancel`
- `customer`: existing Stripe customer ID if the user has one, or auto-create

### Stripe Customer Mapping

```sql
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT UNIQUE;
```

Created on first checkout. Subsequent checkouts use the existing customer ID so payment methods and history are linked.

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
| **User has both subscription and pack credits** | Both contribute to balance. Debit consumes the earliest-expiring credits first (subscription credits with expiry before pack credits with no expiry). |
| **Owner leaves mid-session** | Session continues using already-debited credit. No new debit occurs. If owner loses credits mid-session (impossible — debit happens at start), the session finishes normally. |
| **Campaign ownership transfer** | New owner's credits are used for future sessions. Past session costs stay attributed to the original owner. |

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
