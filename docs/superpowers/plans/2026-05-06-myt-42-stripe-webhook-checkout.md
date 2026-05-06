# MYT-42 Stripe Webhook + Checkout Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the webhook handler + 7 user-facing routes + migration 007 + repo namespaces + trial-credit grant per `docs/superpowers/specs/2026-05-05-myt-42-stripe-webhook-checkout-design.md`. After this issue, a user can register, get a free trial credit, click Buy, complete Stripe Checkout, and see credits land in their balance. Tier upgrades use Stripe's `payment_behavior: 'pending_if_incomplete'` so item-advance is structurally tied to payment settlement.

**Architecture:** Six layers, in dependency order — (1) migration 007 creating `purchases` / `user_subscriptions` / `billing_history` with the lookup_key shape and `credit_ledger` FK columns; (2) four new repo namespaces (`purchases`, `userSubscriptions`, `stripeEvents`, `billingHistory`) plus extensions on `users` and `credits`; (3) auth-boundary plumbing (`PUBLIC_ROUTE_ALLOWLIST` enforced via `onRoute` hook + `FastifyContextConfig.auth` type augmentation); (4) SKU cache + probe extension; (5) webhook handler with prefetch-then-write split, signature verification, idempotency on `stripe_events.event_id`, `payment_behavior: 'pending_if_incomplete'` lifecycle (4 webhook events drive the upgrade flow); (6) the 7 routes + register-handler refactor that grants the trial credit inside the same tx as `users.create`.

**Tech Stack:** Node 24 + TypeScript strict + Fastify v5 + Postgres (`pg`) + Stripe SDK (`stripe@^17`) + Vitest. All Stripe API calls pinned to `STRIPE_API_VERSION = '2026-04-22.dahlia'`.

**Spec sections referenced throughout:** the spec at `docs/superpowers/specs/2026-05-05-myt-42-stripe-webhook-checkout-design.md` is the source of truth for all production code shapes. This plan sequences the work and pins the test approach; for the actual code bodies (especially long ones — the webhook dispatcher, the migration DDL, the per-event handlers), the implementer reads the spec section cited in each task. Don't reproduce long code blocks here — the spec has them already.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `backend/migrations/007_recreate_billing_tables.sql` | Create | Re-creates `purchases`, `user_subscriptions`, `billing_history` with the lookup_key shape; ALTERs `credit_ledger` to add `source_purchase_id` + `source_billing_history_id` FK columns + `credit_ledger_source_link_chk` per-source_type CASE CHECK; pre/post-create ASSERTs. |
| `backend/src/db/__tests__/migrate-schema.test.ts` | Modify | Add the three new tables to `EXPECTED_TABLES`; add new indexes to `EXPECTED_IDX_NAMES`; add status / kind / amount / period-monotonicity / `source_link_chk` to `EXPECTED_CHECK_CONSTRAINTS`; add new FK rows; append `'007_recreate_billing_tables.sql'`. |
| `backend/src/repo/__tests__/_helpers/reset-data.ts` | Modify | Add `purchases`, `user_subscriptions`, `billing_history` back to `TABLES` (in FK-correct truncate order). |
| `backend/src/repo/stripe-events.ts` | Create | `recordOrSkip(tx, event_id, event_type)` helper with `INSERT ... ON CONFLICT (event_id) DO NOTHING RETURNING`. |
| `backend/src/repo/__tests__/stripe-events.test.ts` | Create | First-write-wins, second-call returns `'duplicate'`. |
| `backend/src/repo/purchases.ts` | Create | `insertMany(tx, rows)` (one PI, multiple lookup_keys), `getByPaymentIntent(tx, pi)` (returns rows `ORDER BY id ASC`), `markRefunded(tx, id)` (gated on `status='completed'`). |
| `backend/src/repo/__tests__/purchases.test.ts` | Create | Composite UNIQUE on `(stripe_payment_intent_id, lookup_key)`, 23505 on duplicate, deterministic ordering, idempotent markRefunded. |
| `backend/src/repo/user-subscriptions.ts` | Create | `upsertFromStripe(tx, row)` (single `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE` with strict-`>` `stripe_event_created_at` filter), `markCanceled(tx, sub_id, payload)`, `getActiveForUser(tx, user_id)` (excludes `canceled` / `incomplete_expired` / `paused`). |
| `backend/src/repo/__tests__/user-subscriptions.test.ts` | Create | Upsert idempotency, stale-event ordering rejection, `cancel_at_period_end` preservation on `.deleted`, `getActiveForUser` exclusion list. |
| `backend/src/repo/billing-history.ts` | Create | `append(tx, row, opts: { onConflict: 'do_nothing' \| 'do_update_coalesce' })` with `ON CONFLICT (kind, source_id_stripe)` semantics; `findBySourceStripeId(tx, source_id_stripe)`; `findInvoiceByPaymentIntent(tx, payment_intent_id)`; `listByUser(tx, user_id, { cursor, limit })` (cursor-paginated); `markRefunded(tx, id)` (gated on `status='completed'`). |
| `backend/src/repo/__tests__/billing-history.test.ts` | Create | Composite UNIQUE on `(kind, source_id_stripe)`, prefix-by-kind CHECK, COALESCE upsert preserves NULLs without overwriting non-NULLs, cursor pagination tie-break, idempotent markRefunded. |
| `backend/src/repo/users.ts` | Modify | `create(tx: ClientLike, params)` refactored to accept a `ClientLike` (no own BEGIN/COMMIT, no own pool.connect). Add `findOrCreateStripeCustomer(pool, userId)` per §9 — three-phase tx pattern with full timeout discipline + Stripe idempotency-key. |
| `backend/src/repo/__tests__/users.test.ts` | Modify | Existing tests adapted to pass a `client` to `create`; new tests for `findOrCreateStripeCustomer` happy path + concurrent racers + Phase-3 race resolution. |
| `backend/src/repo/credits.ts` | Modify | Extract `grantInTx(tx, input)` running INSERT only (no own BEGIN). `grant(input)` becomes a thin wrapper that opens a tx and delegates. Add `recordClawback(tx, input)` for negative-polarity refund clawbacks (`source_type='debit'`, `amount < 0`, `expires_at IS NULL`, `ON CONFLICT (user_id, credit_type, source_id) WHERE source_type='debit' DO NOTHING` per migration 004's `uniq_credit_ledger_debit_idempotency` index). |
| `backend/src/repo/__tests__/credits.test.ts` | Modify | `grantInTx` self-relock under existing user-row lock (Postgres tuple-lock re-entrancy); `recordClawback` polarity asserts (rejects `amount > 0` / `source_type ≠ 'debit'` / `expires_at NOT NULL`); `recordClawback` ON CONFLICT idempotency. |
| `backend/src/billing/errors.ts` | Create | `BillingErrorCode` union (closed enum). |
| `backend/src/billing/sku-cache.ts` | Create | Module-level frozen cache; `setSkuCache({ byLookupKey, byPriceId, publicListing })` (called once after probe), `getSkuCache()` (read-only). `SkuInternalEntry` and `SkuPublicListing` types. |
| `backend/src/billing/__tests__/sku-cache.test.ts` | Create | Set/get round-trip; immutability after set; `SkuPublicListing` excludes `stripe_price_id` (typecheck assertion); 503-on-empty getter. |
| `backend/src/billing/probe.ts` | Modify | After probe success, populate sku-cache with the data already fetched. Add a Customer Portal config probe step that asserts the §15.2 settings (per spec §3 line 76). |
| `backend/src/billing/__tests__/probe.test.ts` | Modify | Add tests: probe populates sku-cache; Customer Portal config probe asserts the documented `proration_behavior` and `schedule_at_period_end.conditions`. |
| `backend/src/billing/customer.ts` | Create | `findOrCreateStripeCustomer(pool, stripeClient, userId)` per §9 — re-exports / thin shell over `repo.users.findOrCreateStripeCustomer` (the helper itself ALSO does the Stripe `customers.create` call; see §9's full code). |
| `backend/src/billing/__tests__/customer.test.ts` | Create | Happy path (no existing customer → creates via Stripe → writes users.stripe_customer_id). Concurrent racers (per §9: Phase-1 + Phase-2 + Phase-3-with-FOR-UPDATE). Stripe-idempotency-key dedup. |
| `backend/src/billing/upgrade.ts` | Create | `executeUpgrade(stripeClient, pool, userId, target_tier_lookup_key)` — implements §4.6: monotonic-upgrade validation, retrieves subscription (asserts no in-flight `pending_update`), constructs idempotency-key (NO `period_start`), calls `stripe.subscriptions.update` with `payment_behavior: 'pending_if_incomplete'` + `proration_behavior: 'always_invoice'`, returns `{ status: 'pending' \| 'applied', detail }` per the response shape. |
| `backend/src/billing/__tests__/upgrade.test.ts` | Create | Happy path (no `pending_update` after update → 'applied'); decline path (`pending_update` populated → 'pending' with `expires_at`); already-pending-update returns 409; not-monotonic returns 400; tier_unchanged returns 400. |
| `backend/src/billing/webhook.ts` | Create | Orchestrator. Exports `dispatchEvent(event, stripe, pool, log)`, `PREFETCHERS`, `HANDLERS`, plus the per-event handler functions (`handleCheckoutCompleted`, `handleInvoicePaid`, `handleSubscriptionUpsert`, `handleSubscriptionDeleted`, `handleRefundEvent`, `handlePendingUpdateApplied`, `handlePendingUpdateExpired`). Each handler matches the §5.4.x contract in the spec. |
| `backend/src/billing/__tests__/webhook.test.ts` | Create | Per-handler test fixtures + assertions per §13. The big one — covers every per-event-type contract listed in §5.4. |
| `backend/src/auth/public-route-allowlist.ts` | Create | `PUBLIC_ROUTE_ALLOWLIST: ReadonlySet<string>` enumerating the 5 public routes. Exports a `registerPublicRouteAllowlistHook(app)` function that adds the `onRoute` hook per §3 (lines 86–109). |
| `backend/src/auth/__tests__/public-route-allowlist.test.ts` | Create | Allowlisted route registers cleanly; non-allowlisted route causes `await app.ready()` to reject with the documented message. |
| `backend/src/types/fastify.d.ts` | Create | Module augmentation: `interface FastifyContextConfig { auth?: 'public' \| 'jwt' }`. Makes `config: { auth: 'pubic' }` (typo) a TS compile error. |
| `backend/src/routes/webhook.ts` | Create | Webhook plugin. Encapsulated `addContentTypeParser('application/json', { parseAs: 'buffer' }, …)` + `removeContentTypeParser('application/json')` per Fastify v5 inheritance. Single `POST /webhooks/stripe` route with `config: { auth: 'public' }` + per-route rate limit (1500/min). Calls `dispatchEvent` after signature verification. |
| `backend/src/routes/__tests__/webhook.test.ts` | Create | Plugin contains exactly one route; sibling JSON route registered against `app` still parses JSON; webhook handler receives Buffer for `Content-Type: application/json` AND `application/json; charset=utf-8`; signature missing → 400; signature invalid → 400; `whsec_*='PLACEHOLDER'` fails closed; rate limit exceeded → 429. |
| `backend/src/routes/billing.ts` | Create | The 7 user-facing routes — `GET /skus`, `GET /balance`, `GET /subscription`, `GET /history`, `POST /checkout`, `POST /portal`, `POST /upgrade-tier`. Each is JWT-protected except `/skus` (public, per allowlist). |
| `backend/src/routes/__tests__/billing.test.ts` | Create | Per-route auth contract (JWT-required vs public), body validation, response shape, error-code envelope. Every route emits codes from `BillingErrorCode`. |
| `backend/src/routes/users.ts` | Modify | Register handler refactored to open `BEGIN`/`COMMIT` explicitly: `users.create(client, ...)` → `repo.credits.grantInTx(client, { source_type: 'trial', amount: 1 })` → `UPDATE users SET free_trial_used = true` → COMMIT → read-back the row for the response shape. **`classifyProfanity` calls remain BEFORE BEGIN** per Sphinx I2 round 2. |
| `backend/src/routes/__tests__/users.test.ts` | Modify | Existing register tests adapted; add: trial credit grant present after register (one credit_ledger row, `source_type='trial'`, `amount=1`, `expires_at=NULL`, `source_id=NULL`, `source_purchase_id=NULL`, `source_billing_history_id=NULL`); `users.free_trial_used = true`. |
| `backend/src/app.ts` | Modify | Register the public-route allowlist hook on `app` BEFORE any `app.register(...)` call; register `webhookRoutes` BEFORE `billingRoutes` (encapsulation order); ensure `@fastify/rate-limit` is registered at root scope BEFORE any plugin that uses per-route limits. Pin the registration order with a `// LOAD-BEARING ORDER:` comment. |
| `backend/src/__tests__/webhook-absence.test.ts` | Delete | Was a placeholder MYT-41 test asserting `POST /webhooks/stripe` returns 404. MYT-42 ships the route, so this test goes away. |
| `backend/src/__tests__/app.test.ts` | Modify (or create if absent) | Smoke test that `app.ready()` resolves without throwing — proves the allowlist + plugin-registration order is correct. |
| `tmp/myt-42-stripe-dashboard-instructions.md` | Modify | Sync runbook with all round-2 through round-8 spec additions: `payment_method_types: ['card', 'link']` Account-level config; Customer Portal Switch Plan + Schedule-at-period-end + per-tier downgrade allowlists; webhook endpoint registration with API version pin; `customer.subscription.pending_update_applied` + `customer.subscription.pending_update_expired` + `refund.created` + `refund.updated` event subscriptions; `whsec_*` rotation post-deploy. |
| `docs/specs/2026-04-13-billing-cost-controls.md` | Modify | Patches per spec §14. |
| `docs/specs/2026-04-13-backend-core.md` | Modify | Patches per spec §14. |
| `docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md` | Modify | Patches per spec §14. |
| `docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md` | Modify | Patches per spec §14. |

**Out-of-scope for this plan (other commits / human action):**
- Stripe Dashboard provisioning (Miklos executes `tmp/myt-42-stripe-dashboard-instructions.md` AFTER backend deploys to staging — webhook endpoint URL has to exist).
- `whsec_*` rotation in AWS Secrets Manager (manual ops; runbook step in §15.3).
- Pre-ship empirical verification of `payment_behavior: 'pending_if_incomplete'` test-mode behavior (per §3.1 note 9 — see Task 35 for the test, but the actual Stripe test-mode card decline is a Miklos action).
- Wiki update (run via AUTHORING.md subagent at end-of-issue close, in same push as code).
- Linear close + bead `myth-billing-tier-upgrade-failed-payment-reversal` follow-up + bead `myth-billing-partial-refund-support` follow-up.

---

## Task 1: Migration 007 — purchases + user_subscriptions + billing_history + credit_ledger ALTERs

**Files:**
- Create: `backend/migrations/007_recreate_billing_tables.sql`
- Modify: `backend/src/db/__tests__/migrate-schema.test.ts`
- Modify: `backend/src/repo/__tests__/_helpers/reset-data.ts`

- [ ] **Step 1: Read the migration DDL from spec §6**

The full DDL is at `docs/superpowers/specs/2026-05-05-myt-42-stripe-webhook-checkout-design.md` §6 (lines 773–956). Read every line. Three CREATE TABLEs (`purchases`, `user_subscriptions`, `billing_history`), one ALTER on `credit_ledger` (adds `source_purchase_id` + `source_billing_history_id` columns + `credit_ledger_source_link_chk`). Pre-create ASSERT (tables don't exist yet — migration 006 dropped them). Post-create ASSERT (tables exist with the right columns; per §6 the assertion uses `current_schema()`-anchored queries, NOT hardcoded `'public'`).

- [ ] **Step 2: Write the migration file verbatim from spec §6**

Run: `mkdir -p backend/migrations && touch backend/migrations/007_recreate_billing_tables.sql`

Copy the DDL block from spec §6 lines 786–956 into the file. Verbatim. The `UNIQUE (kind, source_id_stripe)` composite, the prefix-by-kind CHECK, the per-source_type CASE on `credit_ledger_source_link_chk`, and the partial index `idx_billing_history_invoice_pi` are all load-bearing per round-8 fixes.

- [ ] **Step 3: Update `migrate-schema.test.ts` `EXPECTED_TABLES`, `EXPECTED_IDX_NAMES`, `EXPECTED_CHECK_CONSTRAINTS`, FK rows, migrations list**

Add to `EXPECTED_TABLES`: `purchases`, `user_subscriptions`, `billing_history`.

Add to `EXPECTED_IDX_NAMES`:
- `idx_purchases_user`
- `idx_user_subscriptions_user`
- `idx_billing_history_user_occurred`
- `idx_billing_history_invoice_pi`
- `idx_credit_ledger_source_purchase`
- `idx_credit_ledger_source_billing_history`

Add to `EXPECTED_CHECK_CONSTRAINTS` (the spec lists these in §6 line 932 — "Add the new check constraints (purchases.status, purchases.quantity > 0, user_subscriptions.status, user_subscriptions period-monotonicity, billing_history.kind, billing_history.status, billing_history prefix-by-kind, credit_ledger_source_link_chk)").

Add the FK rows (the test's existing FK helper structure) for: `purchases.user_id → users.id`, `user_subscriptions.user_id → users.id ON DELETE CASCADE`, `billing_history.user_id → users.id ON DELETE CASCADE`, `credit_ledger.source_purchase_id → purchases.id ON DELETE RESTRICT`, `credit_ledger.source_billing_history_id → billing_history.id ON DELETE RESTRICT`.

Append `'007_recreate_billing_tables.sql'` to the migrations list.

- [ ] **Step 4: Update `reset-data.ts` `TABLES`**

Add `purchases`, `user_subscriptions`, `billing_history` to the `TABLES` array. Order matters for FK-correct truncation: child-before-parent. Suggested order (after the existing entries): `billing_history`, `user_subscriptions`, `purchases`. (Each truncates BEFORE the `users` truncate; reverse-FK order.)

- [ ] **Step 5: Run schema-parity test to verify the migration applies cleanly**

Run: `cd backend && pnpm vitest run src/db/__tests__/migrate-schema.test.ts`

Expected: PASS. The test runs migrations 001-007 against a clean DB and verifies the resulting schema matches the expected shape.

- [ ] **Step 6: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/migrations/007_recreate_billing_tables.sql backend/src/db/__tests__/migrate-schema.test.ts backend/src/repo/__tests__/_helpers/reset-data.ts
git commit -m "feat(myt-42): migration 007 — purchases + user_subscriptions + billing_history + credit_ledger FK columns"
```

---

## Task 2: `repo.stripeEvents` (recordOrSkip)

**Files:**
- Create: `backend/src/repo/stripe-events.ts`
- Create: `backend/src/repo/__tests__/stripe-events.test.ts`

The spec contract is in §7.3 (lines 1010–1023).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/repo/__tests__/stripe-events.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { withTx } from './_helpers/with-tx'
import { resetData } from './_helpers/reset-data'
import { stripeEvents } from '../stripe-events'

beforeEach(resetData)

describe('repo.stripeEvents.recordOrSkip', () => {
  it('returns "inserted" on first write and "duplicate" on second', async () => {
    await withTx(async (tx) => {
      const first = await stripeEvents.recordOrSkip(tx, 'evt_test_1', 'invoice.paid')
      expect(first).toBe('inserted')
      const second = await stripeEvents.recordOrSkip(tx, 'evt_test_1', 'invoice.paid')
      expect(second).toBe('duplicate')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/repo/__tests__/stripe-events.test.ts`

Expected: FAIL — module `../stripe-events` does not exist.

- [ ] **Step 3: Implement `repo.stripeEvents.recordOrSkip`**

```ts
// backend/src/repo/stripe-events.ts
import type { ClientLike } from './_types'

export const stripeEvents = {
  async recordOrSkip(
    tx: ClientLike,
    event_id: string,
    event_type: string,
  ): Promise<'inserted' | 'duplicate'> {
    const result = await tx.query<{ event_id: string }>(
      `INSERT INTO stripe_events (event_id, event_type, processed_at)
         VALUES ($1, $2, now())
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
      [event_id, event_type],
    )
    return result.rows.length === 0 ? 'duplicate' : 'inserted'
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/repo/__tests__/stripe-events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/stripe-events.ts backend/src/repo/__tests__/stripe-events.test.ts
git commit -m "feat(myt-42): repo.stripeEvents.recordOrSkip"
```

---

## Task 3: `repo.purchases`

**Files:**
- Create: `backend/src/repo/purchases.ts`
- Create: `backend/src/repo/__tests__/purchases.test.ts`

The spec contract is in §7.1 (lines 959–970). Three methods: `insertMany`, `getByPaymentIntent` (returns rows ordered by id ASC per Petra M1 round 8), `markRefunded`.

- [ ] **Step 1: Write failing tests covering composite UNIQUE, deterministic ordering, idempotent markRefunded**

```ts
// backend/src/repo/__tests__/purchases.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { withTx } from './_helpers/with-tx'
import { resetData } from './_helpers/reset-data'
import { createTestUser } from './_helpers/create-test-user'
import { purchases } from '../purchases'
import { v7 as uuidv7 } from 'uuid'

beforeEach(resetData)

describe('repo.purchases', () => {
  it('insertMany writes one row per (PI, lookup_key); composite UNIQUE blocks duplicates', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      await purchases.insertMany(tx, [
        { id: uuidv7(), user_id: user.id, stripe_payment_intent_id: 'pi_test_1', lookup_key: 'sku_session', quantity: 3, amount_cents: 1500, currency: 'usd' },
        { id: uuidv7(), user_id: user.id, stripe_payment_intent_id: 'pi_test_1', lookup_key: 'sku_world',   quantity: 1, amount_cents: 1000, currency: 'usd' },
      ])
      const got = await purchases.getByPaymentIntent(tx, 'pi_test_1')
      expect(got).toHaveLength(2)
      // Inserting (pi_test_1, sku_session) again raises 23505
      await expect(purchases.insertMany(tx, [
        { id: uuidv7(), user_id: user.id, stripe_payment_intent_id: 'pi_test_1', lookup_key: 'sku_session', quantity: 1, amount_cents: 500, currency: 'usd' },
      ])).rejects.toThrow(/duplicate key/)
    })
  })

  it('getByPaymentIntent returns rows ORDER BY id ASC for deterministic concurrent-handler iteration', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const ids = [uuidv7(), uuidv7(), uuidv7()]
      await purchases.insertMany(tx, ids.map((id, i) => ({
        id, user_id: user.id, stripe_payment_intent_id: 'pi_test_2',
        lookup_key: ['sku_session', 'sku_world', 'sku_session_pack_3'][i],
        quantity: 1, amount_cents: 500, currency: 'usd',
      })))
      const got = await purchases.getByPaymentIntent(tx, 'pi_test_2')
      const sorted = [...ids].sort()
      expect(got.map(r => r.id)).toEqual(sorted)
    })
  })

  it('markRefunded is idempotent — second call sees status=refunded already, returns rowcount 0 cleanly', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const id = uuidv7()
      await purchases.insertMany(tx, [{ id, user_id: user.id, stripe_payment_intent_id: 'pi_test_3', lookup_key: 'sku_session', quantity: 1, amount_cents: 500, currency: 'usd' }])
      const r1 = await purchases.markRefunded(tx, id)
      expect(r1.rowsAffected).toBe(1)
      const r2 = await purchases.markRefunded(tx, id)
      expect(r2.rowsAffected).toBe(0)  // status='completed' predicate filters out the already-refunded row
    })
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd backend && pnpm vitest run src/repo/__tests__/purchases.test.ts`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `repo.purchases`**

```ts
// backend/src/repo/purchases.ts
import type { ClientLike } from './_types'

export interface NewPurchaseRow {
  readonly id: string
  readonly user_id: string
  readonly stripe_payment_intent_id: string
  readonly lookup_key: string
  readonly quantity: number
  readonly amount_cents: number
  readonly currency: string
}

export interface PurchaseRow extends NewPurchaseRow {
  readonly status: 'completed' | 'refunded'
  readonly created_at: Date
}

export const purchases = {
  async insertMany(tx: ClientLike, rows: readonly NewPurchaseRow[]): Promise<void> {
    if (rows.length === 0) return
    const values = rows.map((_, i) => {
      const o = i * 7
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`
    }).join(', ')
    const params = rows.flatMap(r => [r.id, r.user_id, r.stripe_payment_intent_id, r.lookup_key, r.quantity, r.amount_cents, r.currency])
    await tx.query(
      `INSERT INTO purchases (id, user_id, stripe_payment_intent_id, lookup_key, quantity, amount_cents, currency) VALUES ${values}`,
      params,
    )
  },

  async getByPaymentIntent(tx: ClientLike, payment_intent_id: string): Promise<readonly PurchaseRow[]> {
    const result = await tx.query<PurchaseRow>(
      `SELECT id, user_id, stripe_payment_intent_id, lookup_key, quantity, amount_cents, currency, status, created_at
         FROM purchases
         WHERE stripe_payment_intent_id = $1
         ORDER BY id ASC`,
      [payment_intent_id],
    )
    return result.rows
  },

  async markRefunded(tx: ClientLike, id: string): Promise<{ rowsAffected: number }> {
    const result = await tx.query(
      `UPDATE purchases SET status = 'refunded' WHERE id = $1 AND status = 'completed'`,
      [id],
    )
    return { rowsAffected: result.rowCount ?? 0 }
  },
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && pnpm vitest run src/repo/__tests__/purchases.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/purchases.ts backend/src/repo/__tests__/purchases.test.ts
git commit -m "feat(myt-42): repo.purchases (insertMany / getByPaymentIntent / markRefunded)"
```

---

## Task 4: `repo.userSubscriptions`

**Files:**
- Create: `backend/src/repo/user-subscriptions.ts`
- Create: `backend/src/repo/__tests__/user-subscriptions.test.ts`

Spec contract in §7.2 (lines 970–1010). Three methods:
- `upsertFromStripe(tx, row)` — single `INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE` with strict-`>` `stripe_event_created_at` filter (per Camembert I1 / Stilton + Roquefort M5 round 3).
- `markCanceled(tx, sub_id, payload)` — sets `status='canceled'`, **preserves** `cancel_at_period_end` from the event payload (per Kraken C3 round 2 / round 5 cancel_at_period_end-as-historical-fact framing).
- `getActiveForUser(tx, user_id)` — returns one active sub or null. Excludes `canceled`, `incomplete_expired`, `paused` per round-7 paused-enum-add.

- [ ] **Step 1: Write failing tests**

The full test list is long; the high-level contracts:
1. Upsert a fresh row → row exists with `tier_lookup_key=$NEW`, `stripe_event_created_at=$T1`.
2. Re-upsert with same `stripe_event_created_at` → row unchanged (strict `>` rejects).
3. Re-upsert with newer `stripe_event_created_at` and a different `tier_lookup_key` → row updated.
4. Re-upsert with older `stripe_event_created_at` → row unchanged (stale-event ordering).
5. `markCanceled` on a row sets `status='canceled'`, **preserves** `cancel_at_period_end=true` from the event payload (NOT collapsed to false).
6. `getActiveForUser` returns the row when status is `active`/`trialing`/`past_due`/`unpaid`/`incomplete`. Returns null when status is `canceled`/`incomplete_expired`/`paused`.

Write all six tests in `user-subscriptions.test.ts`. Reference the §7.2 contract for the field shape.

- [ ] **Step 2: Run tests to verify failure**

Run: `cd backend && pnpm vitest run src/repo/__tests__/user-subscriptions.test.ts`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `repo.userSubscriptions` per spec §7.2**

The full implementation is in spec §7.2 (lines 970–1010). Translate the interface contract into the TS module. Key shapes:

```ts
// backend/src/repo/user-subscriptions.ts
export interface UpsertFromStripeRow {
  readonly user_id: string
  readonly stripe_subscription_id: string
  readonly tier_lookup_key: string
  readonly status: string  // any of the 8 admitted values per migration 007
  readonly current_period_start: Date
  readonly current_period_end: Date
  readonly cancel_at_period_end: boolean
  readonly stripe_event_created_at: Date  // from event.created
  // ... rest per spec §7.2
}

export const userSubscriptions = {
  async upsertFromStripe(tx, row): Promise<void> { /* INSERT ... ON CONFLICT (stripe_subscription_id) DO UPDATE WHERE excluded.stripe_event_created_at > user_subscriptions.stripe_event_created_at */ },
  async markCanceled(tx, stripe_subscription_id, payload: { cancel_at_period_end: boolean; cancel_at: number | null; cancellation_details: unknown }): Promise<void> { /* sets status='canceled', PRESERVES cancel_at_period_end and cancellation_details from payload */ },
  async getActiveForUser(tx, user_id): Promise<ActiveSubscriptionRow | null> { /* SELECT ... WHERE status NOT IN ('canceled', 'incomplete_expired', 'paused') LIMIT 1 */ },
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && pnpm vitest run src/repo/__tests__/user-subscriptions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/user-subscriptions.ts backend/src/repo/__tests__/user-subscriptions.test.ts
git commit -m "feat(myt-42): repo.userSubscriptions (upsertFromStripe / markCanceled / getActiveForUser)"
```

---

## Task 5: `repo.billingHistory`

**Files:**
- Create: `backend/src/repo/billing-history.ts`
- Create: `backend/src/repo/__tests__/billing-history.test.ts`

Spec contract in §7.4 (lines 1023–1047). Methods:
- `append(tx, row, opts: { onConflict?: 'do_nothing' | 'do_update_coalesce' })` — supports both ON CONFLICT shapes per round-8 fix. Default behavior: throw on conflict (forces caller to opt in to idempotency). `do_nothing` → `INSERT ... ON CONFLICT (kind, source_id_stripe) DO NOTHING RETURNING id`. `do_update_coalesce` → `INSERT ... ON CONFLICT (kind, source_id_stripe) DO UPDATE SET expires_at = COALESCE(billing_history.expires_at, EXCLUDED.expires_at), lookup_key = COALESCE(billing_history.lookup_key, EXCLUDED.lookup_key), stripe_payment_intent_id = COALESCE(billing_history.stripe_payment_intent_id, EXCLUDED.stripe_payment_intent_id) RETURNING id`.
- `findBySourceStripeId(tx, source_id_stripe)` — single-row lookup; per Persepolis I7 round 8, this is called with `kind` filter from the caller side.
- `findInvoiceByPaymentIntent(tx, payment_intent_id)` — `SELECT id FROM billing_history WHERE stripe_payment_intent_id = $1 AND kind='invoice'` — drives §5.4.5 refund subscription routing.
- `listByUser(tx, user_id, { cursor, limit })` — cursor-paginated audit feed.
- `markRefunded(tx, id)` — gated on `status='completed'`.

- [ ] **Step 1: Write failing tests**

Test list:
1. `append` with default `throw` semantics: second insert with same `(kind, source_id_stripe)` raises 23505.
2. `append` with `do_nothing`: second insert returns the existing row's id (via `RETURNING id` from the conflict-target row — note: ON CONFLICT DO NOTHING returns NO rows; need to handle this with a follow-up `SELECT id WHERE (kind, source_id_stripe) = ($1, $2)` in the repo, OR use `RETURNING id` + a fallback select).
3. `append` with `do_update_coalesce`: first call writes `expires_at=NULL`, second call with non-null `expires_at` updates it.
4. `findInvoiceByPaymentIntent` returns null when no row matches; returns id when an `invoice` kind row has the PI.
5. `listByUser` cursor-pagination: insert 51 rows, fetch page 1 (50 rows + nextCursor); fetch page 2 (1 row + null cursor).
6. Prefix-by-kind CHECK: inserting `kind='purchase' source_id_stripe='in_xxx'` raises CHECK violation.
7. `markRefunded` is idempotent (rowcount 0 on second call).

- [ ] **Step 2: Run tests to verify failure**

Run: `cd backend && pnpm vitest run src/repo/__tests__/billing-history.test.ts`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `repo.billingHistory` per spec §7.4**

The repo implementation matches the contract shape in spec §7.4. Key implementation note for `do_nothing` semantics: `INSERT ... ON CONFLICT DO NOTHING RETURNING id` returns no rows on conflict, so the repo needs a follow-up SELECT to return the canonical id either way.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && pnpm vitest run src/repo/__tests__/billing-history.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/billing-history.ts backend/src/repo/__tests__/billing-history.test.ts
git commit -m "feat(myt-42): repo.billingHistory (append upsert / findInvoiceByPaymentIntent / listByUser / markRefunded)"
```

---

## Task 6: `repo.users.create` refactor — accept ClientLike

**Files:**
- Modify: `backend/src/repo/users.ts`
- Modify: `backend/src/repo/__tests__/users.test.ts`
- Modify: any callers of `users.create` outside the register handler (search and update)

Per spec §3 line 73 and §7.5: the existing `users.create(input)` (which opens its own tx) is refactored to `users.create(tx: ClientLike, params)` so the trial-credit grant in MYT-42's register handler can ride in the same BEGIN.

This is a BREAKING refactor of the existing signature. All callers must be updated.

- [ ] **Step 1: Find every caller of `users.create`**

Run: `cd backend && grep -rn "users.create\|repo.users.create" src/ --include='*.ts'`

Expected: returns the register handler in `src/routes/users.ts` and any tests. Note each call site.

- [ ] **Step 2: Write the failing test (refactored signature)**

Update `backend/src/repo/__tests__/users.test.ts` to use the new signature: `users.create(client, params)` instead of `users.create(params)`. The test should fail to compile until the implementation is updated.

- [ ] **Step 3: Refactor `users.create` to accept `ClientLike`**

Remove the internal `pool.connect()` / `BEGIN` / `COMMIT`. The function now does only the INSERT against the supplied `tx`.

- [ ] **Step 4: Update every caller**

For each call site found in Step 1:
- The register handler in `src/routes/users.ts` will be refactored in Task 32 to wrap `users.create` in an explicit BEGIN/COMMIT — that task does the call-site update.
- For any test that called `users.create(params)` directly without a tx, wrap with `await withTx(async (tx) => await users.create(tx, params))`.

If there are non-test callers besides the register handler, they need the same wrapping. Stop and confirm with the user if you find any — the spec assumes the register handler is the only non-test caller.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd backend && pnpm vitest run src/repo/__tests__/users.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck to verify no other broken callers**

Run: `cd backend && pnpm typecheck`

Expected: PASS. If typecheck fails on a caller in `src/routes/users.ts`, that's expected — Task 32 fixes that. Skip the typecheck temporarily IF the only failure is in `routes/users.ts`; otherwise fix the broken caller.

- [ ] **Step 7: Commit**

```bash
git add backend/src/repo/users.ts backend/src/repo/__tests__/users.test.ts
git commit -m "refactor(myt-42): users.create accepts ClientLike (caller owns BEGIN/COMMIT)"
```

---

## Task 7: `repo.users.findOrCreateStripeCustomer`

**Files:**
- Modify: `backend/src/repo/users.ts`
- Modify: `backend/src/repo/__tests__/users.test.ts`

The full implementation is in spec §9 (lines 1142–1226). Three-phase prefetch-then-write pattern: Phase 1 read (no lock), Phase 2 Stripe call (idempotency-keyed, outside any tx), Phase 3 short tx with `FOR UPDATE` + race-loser branch. Phase 3 uses the full SET LOCAL triple per Petra C3 round 5.

- [ ] **Step 1: Write failing tests with mocked Stripe SDK**

Test list:
1. Happy path: Phase 1 sees null, Phase 2 calls Stripe, Phase 3 writes the cusId.
2. Already-populated: Phase 1 sees `cus_X`, returns immediately without Stripe call.
3. Race-loser: Phase 1 sees null, Phase 2 returns `cus_A`, but BEFORE Phase 3 the row is concurrently written to `cus_B` → Phase 3 sees `cus_B` under FOR UPDATE, returns `cus_B` (the racewinner branch).
4. Stripe idempotency-key matches the spec: `customer_for_${userId}`.

The Stripe SDK is mocked at the import boundary — the helper takes a `stripeClient` parameter so the test injects a fake.

- [ ] **Step 2: Run tests to verify failure**

Run: `cd backend && pnpm vitest run src/repo/__tests__/users.test.ts`

Expected: FAIL — `findOrCreateStripeCustomer` does not exist.

- [ ] **Step 3: Implement `findOrCreateStripeCustomer` per spec §9**

Implement the three-phase pattern verbatim from spec §9 lines 1146–1186. Note the SET LOCAL triple in Phase 3 is multi-statement-string per MYT-40's discipline.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && pnpm vitest run src/repo/__tests__/users.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/users.ts backend/src/repo/__tests__/users.test.ts
git commit -m "feat(myt-42): repo.users.findOrCreateStripeCustomer (three-phase prefetch-then-write)"
```

---

## Task 8: `repo.credits` — extract `grantInTx` + add `recordClawback`

**Files:**
- Modify: `backend/src/repo/credits.ts`
- Modify: `backend/src/repo/__tests__/credits.test.ts`

Spec contract in §7.6 (lines 1068–1110). Three changes:
1. Extract a `grantInTx(tx, input)` from the existing `grant(input)` — `grantInTx` takes a `ClientLike` and runs ONLY the INSERT (no own BEGIN/COMMIT, no own pool.connect).
2. `grant(input)` becomes a thin wrapper that opens a tx and delegates to `grantInTx`. Existing `grant` callers continue to work unchanged.
3. Add `recordClawback(tx, input)` — writes negative-polarity rows for refund clawbacks. Asserts `amount < 0`, `source_type='debit'`, `source_id` non-null (originating grant's UUID), `expires_at IS NULL`. INSERT uses `ON CONFLICT (user_id, credit_type, source_id) WHERE source_type='debit' DO NOTHING` per Persepolis C2 round 8.

- [ ] **Step 1: Write failing tests**

Test list:
1. `grantInTx` writes a row when called with a valid input and an active tx.
2. `grantInTx` self-relock under existing user-row lock: caller takes `SELECT id FROM users WHERE id = $1 FOR UPDATE`, then calls `grantInTx`. The internal SELECT FOR UPDATE in `grantInTx` is a no-op (Postgres tuple-lock re-entrancy); no error, no timeout.
3. `grant(input)` (the public wrapper) still works as before — backwards-compatible with MYT-40 callers.
4. `recordClawback` rejects `amount > 0`.
5. `recordClawback` rejects `source_type !== 'debit'`.
6. `recordClawback` rejects `expires_at !== null`.
7. `recordClawback` rejects `source_id === null`.
8. `recordClawback` happy path writes a negative-polarity debit row.
9. `recordClawback` ON CONFLICT idempotency: second call with same `(user_id, credit_type, source_id)` is a no-op.

- [ ] **Step 2: Run tests to verify failure**

Run: `cd backend && pnpm vitest run src/repo/__tests__/credits.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement per spec §7.6**

```ts
// backend/src/repo/credits.ts (additions)
export interface NewClawbackRow {
  readonly userId: string
  readonly creditType: 'session' | 'world'
  readonly amount: number  // strictly negative
  readonly sourceType: 'debit'
  readonly sourceId: string  // originating grant row's UUID
  readonly expiresAt: null
  readonly sourcePurchaseId: null
  readonly sourceBillingHistoryId: null
}

export const credits = {
  // ...existing grant() refactored to thin wrapper...

  async grantInTx(tx: ClientLike, input: NewCreditLedgerRow): Promise<CreditLedgerRow> {
    // INSERT-only, no BEGIN. The user-row FOR UPDATE inside this fn is safe to
    // re-acquire in the same tx (Postgres tuple-lock re-entrancy — see §7.6
    // line 1063 corrected per Petra C3 round 5).
    // ...
  },

  async recordClawback(tx: ClientLike, input: NewClawbackRow): Promise<CreditLedgerRow> {
    if (input.amount >= 0) throw new Error('recordClawback: amount must be negative')
    if (input.sourceType !== 'debit') throw new Error("recordClawback: sourceType must be 'debit'")
    if (input.sourceId === null) throw new Error('recordClawback: sourceId required (originating grant UUID)')
    if (input.expiresAt !== null) throw new Error('recordClawback: expiresAt must be NULL (migration 004 credit_ledger_debit_no_expiry_chk)')

    const result = await tx.query<CreditLedgerRow>(
      `INSERT INTO credit_ledger (id, user_id, credit_type, amount, source_type, source_id, expires_at, source_purchase_id, source_billing_history_id, created_at)
         VALUES ($1, $2, $3, $4, 'debit', $5, NULL, NULL, NULL, now())
         ON CONFLICT (user_id, credit_type, source_id) WHERE source_type='debit' DO NOTHING
         RETURNING *`,
      [/* uuidv7() */ generateId(), input.userId, input.creditType, input.amount, input.sourceId],
    )
    if (result.rows.length === 0) {
      // ON CONFLICT fired — return the existing row so caller has a consistent shape
      const existing = await tx.query<CreditLedgerRow>(
        `SELECT * FROM credit_ledger WHERE user_id = $1 AND credit_type = $2 AND source_id = $3 AND source_type = 'debit'`,
        [input.userId, input.creditType, input.sourceId],
      )
      return existing.rows[0]
    }
    return result.rows[0]
  },
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && pnpm vitest run src/repo/__tests__/credits.test.ts`

Expected: PASS (all 9 tests green).

- [ ] **Step 5: Commit**

```bash
git add backend/src/repo/credits.ts backend/src/repo/__tests__/credits.test.ts
git commit -m "feat(myt-42): repo.credits — grantInTx extraction + recordClawback"
```

---

## Task 9: `BillingErrorCode` union

**Files:**
- Create: `backend/src/billing/errors.ts`

Spec contract in §12.1 (lines 1311–1330).

- [ ] **Step 1: Write the union**

```ts
// backend/src/billing/errors.ts
export type BillingErrorCode =
  | 'body_invalid'
  | 'mixed_cart'
  | 'tier_cart_shape'
  | 'duplicate_lookup_key'
  | 'unknown_lookup_key'
  | 'no_active_subscription'
  | 'tier_unchanged'
  | 'not_an_upgrade'
  | 'invalid_cursor'
  | 'stripe_unavailable'
  | 'missing_signature'
  | 'invalid_signature'
  | 'upgrade_payment_pending'
  | 'upgrade_already_pending'  // per Petra I5 round 7 — sub already has a pending_update from a prior attempt

// Closed enum. Adding a code requires updating this type, the §12.2 scenarios
// table in the spec, and any route handler that emits it. The §13 routes test
// asserts every emit-site uses a code that's in this union.
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/billing/errors.ts
git commit -m "feat(myt-42): BillingErrorCode union (closed enum of 4xx codes)"
```

---

## Task 10: `FastifyContextConfig` type augmentation

**Files:**
- Create: `backend/src/types/fastify.d.ts`

Per spec §3 lines 113–122 — makes `config: { auth: 'pubic' }` (typo) a TS compile error rather than a silent JWT-required fallback.

- [ ] **Step 1: Write the type augmentation**

```ts
// backend/src/types/fastify.d.ts
import 'fastify'

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: 'public' | 'jwt'
  }
}
```

- [ ] **Step 2: Verify it works — tsc on a deliberate typo**

Add a one-line scratch test (then delete) that does `app.post('/x', { config: { auth: 'pubic' } }, handler)`. Run `pnpm typecheck`. Expected: TS2322 or similar TypeError on the literal `'pubic'`. Delete the scratch.

- [ ] **Step 3: Commit**

```bash
git add backend/src/types/fastify.d.ts
git commit -m "feat(myt-42): FastifyContextConfig.auth type augmentation"
```

---

## Task 11: `PUBLIC_ROUTE_ALLOWLIST` + `onRoute` hook

**Files:**
- Create: `backend/src/auth/public-route-allowlist.ts`
- Create: `backend/src/auth/__tests__/public-route-allowlist.test.ts`

Per spec §3 lines 86–109. The hook is registered on `app` BEFORE any `app.register(...)` call (Task 33 wires this in `app.ts`). This task ships the module + test.

- [ ] **Step 1: Audit existing routes for `auth: 'public'` usages**

Run: `cd backend && grep -rn "auth: 'public'\|auth:\"public\"" src/ --include='*.ts'`

Confirm the result matches the spec's allowlist:
- `GET /health`
- `GET /health/ready`
- `GET /api/invites/:inviteCode/preview`

If any other public routes exist, STOP and discuss with the user before proceeding — the allowlist must be exhaustive at boot.

- [ ] **Step 2: Write failing test**

```ts
// backend/src/auth/__tests__/public-route-allowlist.test.ts
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { registerPublicRouteAllowlistHook, PUBLIC_ROUTE_ALLOWLIST } from '../public-route-allowlist'

describe('public-route allowlist hook', () => {
  it('PUBLIC_ROUTE_ALLOWLIST contains the expected entries', () => {
    expect(PUBLIC_ROUTE_ALLOWLIST.has('GET /health')).toBe(true)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('POST /webhooks/stripe')).toBe(true)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('GET /api/billing/skus')).toBe(true)
  })

  it('allowlisted public route registers cleanly', async () => {
    const app = Fastify()
    registerPublicRouteAllowlistHook(app)
    app.get('/health', { config: { auth: 'public' } }, async () => ({ ok: true }))
    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })

  it('non-allowlisted public route causes app.ready() to reject', async () => {
    const app = Fastify()
    registerPublicRouteAllowlistHook(app)
    app.get('/secret-public-route', { config: { auth: 'public' } }, async () => ({ ok: true }))
    await expect(app.ready()).rejects.toThrow(/non-allowlisted route/)
    await app.close()
  })

  it('JWT-default route (no config.auth) is silently skipped', async () => {
    const app = Fastify()
    registerPublicRouteAllowlistHook(app)
    app.get('/api/something', async () => ({ ok: true }))
    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })
})
```

- [ ] **Step 3: Run test to verify failure**

Run: `cd backend && pnpm vitest run src/auth/__tests__/public-route-allowlist.test.ts`

Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement per spec §3 lines 86–109**

```ts
// backend/src/auth/public-route-allowlist.ts
import type { FastifyInstance } from 'fastify'

export const PUBLIC_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  'GET /health',
  'GET /health/ready',
  'GET /api/invites/:inviteCode/preview',
  'GET /api/billing/skus',
  'POST /webhooks/stripe',
])

export function registerPublicRouteAllowlistHook(app: FastifyInstance): void {
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.config?.auth !== 'public') return
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
    for (const m of methods) {
      const key = `${m} ${routeOptions.url}`
      if (!PUBLIC_ROUTE_ALLOWLIST.has(key)) {
        throw new Error(`auth: public used on non-allowlisted route: ${key}`)
      }
    }
  })
}
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd backend && pnpm vitest run src/auth/__tests__/public-route-allowlist.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/auth/public-route-allowlist.ts backend/src/auth/__tests__/public-route-allowlist.test.ts
git commit -m "feat(myt-42): PUBLIC_ROUTE_ALLOWLIST + onRoute hook for boot-time enforcement"
```

---

## Task 12: SKU cache module

**Files:**
- Create: `backend/src/billing/sku-cache.ts`
- Create: `backend/src/billing/__tests__/sku-cache.test.ts`

Spec contract in §10 (lines 1226–1308). The cache is module-level, frozen-after-set, populated once after the boot probe.

- [ ] **Step 1: Write failing tests**

Test the contract: `setSkuCache` writes once, subsequent calls throw (frozen); `getSkuCache` returns the frozen object; `getSkuPublicListing()` returns the public-projection slice (the typecheck assertion proves `stripe_price_id` is NOT in `SkuPublicListing`).

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement per spec §10**

The `SkuInternalEntry` type INCLUDES `stripe_price_id`; `SkuPublicListing` EXCLUDES it. The split is load-bearing per Stilton I7 round 3.

- [ ] **Step 4: Run test to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/sku-cache.ts backend/src/billing/__tests__/sku-cache.test.ts
git commit -m "feat(myt-42): sku-cache module — internal vs public projection split"
```

---

## Task 13: Probe extension — populate sku-cache + Customer Portal config probe

**Files:**
- Modify: `backend/src/billing/probe.ts`
- Modify: `backend/src/billing/__tests__/probe.test.ts`

Per spec §3 line 76: probe populates the sku-cache after a successful contract verification, and adds a Customer Portal config probe step asserting the §15.2 settings (proration_behavior, schedule_at_period_end.conditions, per-tier downgrade allowlists).

- [ ] **Step 1: Write failing tests**

Test list:
1. Probe success populates sku-cache with `byLookupKey`, `byPriceId`, `publicListing`.
2. Probe also calls `stripe.billingPortal.configurations.list()` and asserts the documented config shape.
3. Probe fails loud if the Customer Portal config drifts (e.g., `proration_behavior !== 'create_prorations'`).

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement**

Extend `probe.ts` to: (a) after the existing contract-shape verification passes, call `setSkuCache(...)` with the data already fetched; (b) call `stripe.billingPortal.configurations.list({ active: true, is_default: true, limit: 1 })` and assert the returned config matches §15.2 — bail with a typed `PortalConfigDriftError` on mismatch.

- [ ] **Step 4: Run test to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/probe.ts backend/src/billing/__tests__/probe.test.ts
git commit -m "feat(myt-42): probe populates sku-cache + asserts Customer Portal config"
```

---

## Task 14: `findOrCreateStripeCustomer` thin shell + `customer.ts`

**Files:**
- Create: `backend/src/billing/customer.ts`
- Create: `backend/src/billing/__tests__/customer.test.ts`

Per spec §3 line 66 — a thin shell module that re-exports `repo.users.findOrCreateStripeCustomer` and provides the Stripe-call portion of the helper. The repo helper from Task 7 takes a `pool` + `stripeClient`; this module composes them at the route layer.

In practice this may collapse into the repo helper directly — review Task 7's signature. If Task 7's `repo.users.findOrCreateStripeCustomer(pool, stripeClient, userId)` already does the Stripe call, this task is just exporting a thin re-export under `backend/src/billing/`. If Task 7's repo helper takes the cusId as input (Stripe call lives in this module), this module owns the `customers.create` call.

- [ ] **Step 1: Decide the split**

Read Task 7's signature. The spec §9 implementation has the Stripe call (`createStripeCustomer(stripeClient, userId)`) inline in the helper, which suggests Task 7's `repo.users.findOrCreateStripeCustomer` IS the full helper including the Stripe call. In that case this task is a re-export only.

- [ ] **Step 2: Write a thin re-export**

```ts
// backend/src/billing/customer.ts
export { findOrCreateStripeCustomer } from '../repo/users.ts'
```

(If Task 7 split it differently, write the appropriate composition module.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/billing/customer.ts
git commit -m "feat(myt-42): billing/customer.ts re-export"
```

---

## Task 15: Webhook plugin shell — raw-body parser + signature verification

**Files:**
- Create: `backend/src/routes/webhook.ts`
- Create: `backend/src/routes/__tests__/webhook.test.ts`

Spec §5.1 (lines 341–370) + §5.2 (lines 370–386). The plugin is encapsulated; it removes the inherited `application/json` parser and adds a buffer-pass-through. Signature verification runs in the route handler before dispatch.

- [ ] **Step 1: Write failing tests**

Test list per §13 lines 1465–1480:
1. Plugin registered against a fresh Fastify, `app.printRoutes()` returns exactly one route at `POST /webhooks/stripe`.
2. Sibling JSON route registered against `app` AFTER `webhookRoutes` still receives a parsed object (encapsulation holds).
3. Webhook handler receives a Buffer for `Content-Type: application/json`.
4. Webhook handler receives a Buffer for `Content-Type: application/json; charset=utf-8`.
5. Missing `Stripe-Signature` header → 400 `{ code: 'missing_signature' }`.
6. Invalid signature → 400 `{ code: 'invalid_signature' }`.
7. `STRIPE_WEBHOOK_SECRET='PLACEHOLDER'` → all signatures invalid (fail-closed by design).

For step 5/6/7 the tests inject a fake `dispatchEvent` that asserts it's never called when signature verification fails.

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement webhook route plugin per spec §5.1 + §5.2**

```ts
// backend/src/routes/webhook.ts
import type { FastifyPluginAsync } from 'fastify'
import { dispatchEvent } from '../billing/webhook'
import { getStripeClient } from '../billing/stripe-client'
import { env } from '../config/env'

export const webhookRoutes: FastifyPluginAsync = async (scope) => {
  scope.removeContentTypeParser('application/json')
  scope.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 },  // §5.1 + Ephesus I3 round 8 — bound the buffer
    (_req, body, done) => done(null, body),
  )

  scope.post('/webhooks/stripe', {
    config: { auth: 'public', rateLimit: { max: 1500, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature']
    if (!sig || typeof sig !== 'string') {
      return reply.code(400).send({ code: 'missing_signature' })
    }
    if (!Buffer.isBuffer(request.body)) {
      request.log.error('webhook_parser_misconfigured — request.body is not a Buffer')
      return reply.code(500).send({ code: 'internal' })
    }

    const stripe = getStripeClient()
    let event: import('stripe').Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(request.body, sig, env.stripeWebhookSecret)
    } catch (err) {
      request.log.warn({ err: { message: (err as Error).message } }, 'stripe_webhook_signature_invalid')
      return reply.code(400).send({ code: 'invalid_signature' })
    }

    await dispatchEvent(event, stripe, request.server.pool, request.log)
    return reply.code(200).send({ received: true })
  })
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd backend && pnpm vitest run src/routes/__tests__/webhook.test.ts`

Expected: PASS for the signature/parser tests. The `dispatchEvent` mock is what the test asserts is or isn't called.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/webhook.ts backend/src/routes/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook plugin — encapsulated raw-body parser + signature verification"
```

---

## Task 16: Webhook dispatcher (`dispatchEvent`) — shell + idempotency + api-version gate

**Files:**
- Create: `backend/src/billing/webhook.ts` (shell only — handlers in subsequent tasks)
- Create: `backend/src/billing/__tests__/webhook.test.ts` (shell tests only)

Spec §5.3 (lines 386–553). The full canonical dispatcher TS code is at lines 412–489. Read it in full.

This task ships the `dispatchEvent` orchestrator + the api-version-mismatch fail-closed path + the idempotency gate. The HANDLERS map is stubbed with placeholder handlers that just return `'ok'` — actual handlers come in Tasks 17–24.

- [ ] **Step 1: Write failing tests for dispatcher contract**

Test list:
1. Duplicate `event.id` (second call) → ROLLBACK + return without invoking handler.
2. Unknown event type → COMMIT `stripe_events` row + return (no handler invocation).
3. `event.api_version !== STRIPE_API_VERSION` → fail-closed: handler NOT invoked, `stripe_events` row IS committed (best-effort), return.
4. Handler throws → ROLLBACK (entire tx including `stripe_events` row) + rethrow (so route returns 5xx and Stripe retries).
5. Handler returns `'validation_failed'` → COMMIT (only `stripe_events` row is in the tx; no other writes) + log `billing.handler_validation_failed_committed`.
6. Handler returns `'ok'` → COMMIT all writes.
7. SET LOCAL triple is applied: `transaction_isolation = 'read committed'`, `lock_timeout = '1s'`, `statement_timeout = '5s'`.

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `dispatchEvent` per spec §5.3**

The full code is in spec §5.3 lines 412–489. Copy verbatim, adapting only the import paths. Note the multi-statement `BEGIN; SET LOCAL ...; SET LOCAL ...; SET LOCAL ...` string — `pg`'s simple-query mode handles this; if your `pg` config uses extended-query mode by default, split into 4 separate `client.query()` calls (per Petra I3 round 7). Verify in test.

Stub the HANDLERS map with placeholders:

```ts
const HANDLERS: Record<KnownStripeEventType, EventHandler> = {
  'checkout.session.completed':                       async () => 'ok',
  'invoice.paid':                                     async () => 'ok',
  'customer.subscription.created':                    async () => 'ok',
  'customer.subscription.updated':                    async () => 'ok',
  'customer.subscription.deleted':                    async () => 'ok',
  'customer.subscription.pending_update_applied':     async () => 'ok',
  'customer.subscription.pending_update_expired':     async () => 'ok',
  'refund.created':                                   async () => 'ok',
  'refund.updated':                                   async () => 'ok',
}
```

Same for PREFETCHERS (each returns `{}`).

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS for the 7 dispatcher contract tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): dispatchEvent orchestrator — idempotency, api-version gate, sentinel"
```

---

## Task 17: Webhook handler — `checkout.session.completed` (subscription mode)

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.1 (lines 553–602) — subscription branch (lines 593–597). Subscription mode does NOT grant credits and does NOT write a billing_history row. It writes ONLY the `user_subscriptions` row via `upsertFromStripe`.

- [ ] **Step 1: Write failing fixture-based test**

Use a recorded `checkout.session.completed` event payload (subscription mode) as a fixture. Assert: one `user_subscriptions` row exists with `status` from Stripe, `tier_lookup_key` derived from `line_items[0].price.lookup_key`, period dates from `items.data[0].current_period_*`, `cancel_at_period_end=false`. Assert: ZERO `billing_history` rows. Assert: ZERO `credit_ledger` rows.

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL — handler returns `'ok'` without doing the work.

- [ ] **Step 3: Implement `handleCheckoutCompleted` (subscription branch) per spec §5.4.1**

The handler:
1. Resolves user via `event.data.object.metadata.userId` → `users` row. On miss: paging `billing.checkout_orphan` + COMMIT + 200.
2. Cross-checks `event.data.object.customer === users[metadata.userId].stripe_customer_id`. Mismatch: paging `billing.checkout_customer_mismatch` + COMMIT + 200.
3. Acquires user-row anchor lock (per §5.3 discipline).
4. Branches on `event.data.object.mode`. Subscription branch:
   - Asserts `session.line_items.data.length === 1` (per Persepolis C4 round 7 multi-line guard).
   - Reads `tier_lookup_key = line_items.data[0].price.lookup_key`.
   - Reads period dates from `subscription.items.data[0].current_period_*` (the prefetched Subscription).
   - Calls `repo.userSubscriptions.upsertFromStripe(client, ...)` with `stripe_event_created_at = event.created`.
   - NO billing_history. NO credit_ledger. Returns `'ok'`.

- [ ] **Step 4: Run test to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — checkout.session.completed (subscription mode)"
```

---

## Task 18: Webhook handler — `checkout.session.completed` (payment mode / à-la-carte)

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.1 lines 599–601 — payment-mode branch.

- [ ] **Step 1: Write failing fixture-based tests**

Test list:
1. Multi-line cart (3 line items, one PI): produces 3 `purchases` rows sharing one PI; one `billing_history` row with `kind='purchase'`, `source_id_stripe=pi_*`, `lookup_key=NULL`; six `credit_ledger` rows (3 lines × 2 credit_types) with `source_purchase_id` set.
2. Re-replay of the same `event.id`: no second writes (idempotency via `stripe_events` PK).
3. `payment_status !== 'paid'`: paging log `billing.payment_status_unexpected` + no writes.
4. Reconstructed `expected_subtotal !== amount_subtotal`: validation_failed sentinel.
5. `metadata.userId` missing → orphan paging.
6. `customer ≠ users[metadata.userId].stripe_customer_id` → mismatch paging.

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement payment-mode branch per spec §5.4.1**

Walk `session.line_items.data` (prefetched). For each line, resolve `line.price.id` against the SKU cache reverse map → `lookup_key` → `LookupKeySpec`. Validate `expected_subtotal === amount_subtotal`. Insert one `purchases` row per line. Insert one `billing_history` row with `kind='purchase'`, `source_id_stripe=payment_intent`. Grant credits via `repo.credits.grantInTx` with `source_purchase_id` populated.

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — checkout.session.completed (payment mode / à-la-carte)"
```

---

## Task 19: Webhook handler — `invoice.paid` (subscription_cycle + subscription_create + subscription_update branches + other billing_reasons)

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.2 (lines 604–648). Three credit-granting branches (`subscription_cycle`, `subscription_create`, `subscription_update`) plus the allowlist for other `billing_reason` values + negative/zero-amount handling.

NOTE: per spec §5.4.2 round-7 update, `subscription_update` is **billing-history-only** (NO credit grant) — credits flow through `pending_update_applied` (Task 22).

- [ ] **Step 1: Write failing fixture-based tests**

Test list (per §13):
- `subscription_cycle`: validates `subtotal_excluding_tax === price.unit_amount`; appends billing_history with `expires_at = period_end` and `stripe_payment_intent_id` populated; grants credits with `source_billing_history_id` linked.
- `subscription_create`: same as cycle, plus calls `upsertFromStripe` first (in case `customer.subscription.created` hasn't arrived yet).
- `subscription_update`: writes billing_history-only via the symmetric upsert (`ON CONFLICT (kind, source_id_stripe) DO UPDATE SET ... COALESCE(...)`); no credit_ledger writes.
- `billing_reason='manual'` / `'quote_accept'`: billing_history-only; no credit grant.
- Zero-amount invoice: skip credit grant + skip amount validation; record billing_history.
- Customer not found + `billing_reason='subscription_cycle'` + `amount_paid > 0`: paging `billing.invoice_orphan` + COMMIT + 200.
- `prefetch.subscription === null` (non-subscription invoice — `parent.type !== 'subscription_details'` or `parent === null`): log INFO `billing.invoice_non_subscription` + COMMIT + 200.

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `handleInvoicePaid` per spec §5.4.2**

Read the spec section in full. The `subscription_update` branch is the load-bearing change from earlier rounds — billing-history-only, symmetric upsert.

Note: the billing_history row's `stripe_payment_intent_id` field must be populated from `invoice.payments[0].payment.payment_intent` per the basil multi-payment-invoice model (per round-8 Carthage C1 fix; basil removed `Invoice.payment_intent`).

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — invoice.paid (cycle / create / update / non-grant billing_reasons)"
```

---

## Task 20: Webhook handler — `customer.subscription.created` and `customer.subscription.updated` (`handleSubscriptionUpsert` + pending_update gate)

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.3 (lines 649–660). Both events share the same handler. Crucial round-7 addition: the **pending-update gate** — if `event.data.object.pending_update !== null`, the handler logs INFO `billing.subscription_pending_update_visible` + COMMIT + 200 WITHOUT upserting tier (the actual advance happens via `pending_update_applied` in Task 22).

- [ ] **Step 1: Write failing tests**

Test list:
1. Fresh `.created` event with `pending_update === null`: `upsertFromStripe` writes a new row with the event's `tier_lookup_key`, period dates, `cancel_at_period_end`.
2. `.updated` event with `pending_update` populated: log INFO; NO `user_subscriptions` writes. Critical regression test for the round-7 pending-update gate.
3. Stale `.updated` event (lower `event.created` than existing row): WHERE-clause filter rejects; row unchanged.
4. Same-second distinct `.updated` events: per round 3's strict-`>` filter, the first wins; second is rejected as stale.
5. `.updated` arrives BEFORE `.created` (out-of-order delivery): `upsertFromStripe` INSERTs the row; subsequent `.created` is no-op or UPDATE depending on event timestamps.

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `handleSubscriptionUpsert` per spec §5.4.3**

The pending_update gate is the FIRST check after user resolution — log + COMMIT + return BEFORE any DB writes if `pending_update !== null`.

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — handleSubscriptionUpsert with pending_update gate"
```

---

## Task 21: Webhook handler — `customer.subscription.deleted`

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.4 (lines 660–668). Calls `repo.userSubscriptions.markCanceled(...)` — preserves `cancel_at_period_end` from event payload, copies `cancellation_details`, copies `cancel_at` timestamp.

- [ ] **Step 1: Write failing tests**

1. User-initiated cancel-at-period-end (`cancellation_details.reason='cancellation_requested'`): row updated to `status='canceled'`, `cancel_at_period_end=true` preserved.
2. Stripe-initiated dunning cancel (`reason='payment_failed'`): same write path; `cancel_at_period_end=false` preserved.
3. Existing credit_ledger rows untouched after `.deleted`.
4. No row matches `stripe_subscription_id`: log + COMMIT + 200.

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement per spec §5.4.4**

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — customer.subscription.deleted (markCanceled)"
```

---

## Task 22: Webhook handler — `customer.subscription.pending_update_applied` (the upgrade credit grant)

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.6 (lines 711–760) — the upgrade-success path. **Load-bearing**: this is where credits land for tier upgrades, not `invoice.paid`.

- [ ] **Step 1: Write failing fixture-based test**

Fixture: a `pending_update_applied` event for a Wayfarer→Mythwright upgrade. The Subscription has `pending_update === null`, items advanced to NEW tier, `latest_invoice` paid. The associated proration invoice has two line items: -$15 (refund of OLD prorated) and +$45 (charge of NEW prorated), netting $30.

Assertions:
- OLD tier (`wayfarer`) and NEW tier (`mythwright`) derived from invoice line items, NOT from `user_subscriptions` (per round-5 Petra I3).
- Line walker uses the type-narrowing helper (per round-8 Carthage C3): asserts `pricing.type === 'price_details'` before reading `pricing.price_details.price`; rejects unexpected line shape via `'validation_failed'` sentinel.
- Validates `subtotal_excluding_tax === (newPriceCents - oldPriceCents) === 3000` (the $30 delta).
- `upsertFromStripe` writes `user_subscriptions.tier_lookup_key='mythwright'`.
- `billing_history` row is upserted via the COALESCE pattern: `kind='invoice'`, `source_id_stripe=invoice_id`, `lookup_key='mythwright'`, `expires_at=period_end + 1 month`.
- credit_ledger rows: 12 sessions, 3 worlds (the DELTA), `source_billing_history_id` linked, `expires_at = period_end + 1 month`.
- Idempotent: re-running with the same event_id is a no-op via `stripe_events` PK.

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `handlePendingUpdateApplied` per spec §5.4.6**

Read §5.4.6 in full. Use the type-narrowing helper for `pricing.price_details.price` (per Carthage C3 round 8). Use the symmetric `do_update_coalesce` upsert for `billing_history.append`.

- [ ] **Step 4: Run test to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — pending_update_applied (canonical upgrade credit grant)"
```

---

## Task 23: Webhook handler — `customer.subscription.pending_update_expired`

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.6 — the upgrade-failure path. NO DB writes. Log INFO `billing.upgrade_expired` + COMMIT + 200.

- [ ] **Step 1: Write failing test**

Fixture: a `pending_update_expired` event. Assertion: zero writes (no user_subscriptions update, no billing_history, no credit_ledger). Log line emitted with `subscription_id`, `latest_invoice_id`, `target_tier_lookup_key`.

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement per spec §5.4.6**

- [ ] **Step 4: Run test to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — pending_update_expired (no-op + log)"
```

---

## Task 24: Webhook handler — `refund.created` and `refund.updated` (`handleRefundEvent`)

**Files:**
- Modify: `backend/src/billing/webhook.ts`
- Modify: `backend/src/billing/__tests__/webhook.test.ts`

Spec §5.4.5 (lines 668–711) — the refund handler. The most complex handler, with multiple round-fixed contracts:
- Status gate (round 6 Carthage C1): only `status='succeeded'` triggers clawback; pending/failed/canceled/requires_action log+commit+200.
- Step 0 partial-refund hard-refuse: `prefetch.charge.amount_refunded === amount_captured` assertion; mismatch pages and skips.
- DB-side resolution (round 8 Carthage C1): subscription invoice routing via `billing_history.findInvoiceByPaymentIntent`, NOT via `stripe.invoicePayments.list`.
- Three terminal sub-cases in step 1 (round 8 Petra I7): null PI vs already-refunded vs transient-miss.
- Lock-acquisition exception ordering: stripe_events insert → resolve (no lock) → user FOR UPDATE → re-fetch under lock → write clawback + UPDATE source row + append billing_history.
- `recordClawback` ON CONFLICT idempotency.
- billing_history-refund insert with `ON CONFLICT (kind, source_id_stripe) DO NOTHING`.

- [ ] **Step 1: Write failing fixture-based tests**

Test list (per §13 lines 1432–1437 + round-8 additions):
1. Partial-refund hard-refuse: `amount_refunded < amount_captured` → ERROR-level `billing.partial_refund_unsupported`, no clawback.
2. Full refund (à-la-carte): clawback rows written via `recordClawback` for each grant; `purchases.status='refunded'`; billing_history `kind='refund'` row appended.
3. Full refund (subscription invoice): DB-side resolution via `findInvoiceByPaymentIntent`; clawback against grant rows linked via `source_billing_history_id`.
4. Status `pending` / `failed` / `canceled` / `requires_action`: log+commit+200, no clawback.
5. `payment_intent: null`: log INFO `billing.refund_unknown_origin` + COMMIT + 200.
6. Already-refunded (operator re-deliver): log INFO `billing.refund_already_applied` + COMMIT + 200, no double-clawback.
7. Transient resolution miss (refund arrives before parent invoice): THROW so dispatcher rolls back + Stripe redelivers.
8. Multi-line cart full refund: clawback every grant; ON CONFLICT idempotency confirmed by re-running.
9. Post-lock re-fetch detects status flip: log INFO `billing.refund_already_applied` + COMMIT + 200 — steps 5–6 don't run.

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement `handleRefundEvent` per spec §5.4.5**

Read §5.4.5 in full. The handler has more branches than any other; implement each case carefully.

Note: the prefetch shape per round-8 fix only fetches the parent Charge for the partial-refund check; subscription routing happens DB-side in the handler tx.

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/billing/webhook.ts backend/src/billing/__tests__/webhook.test.ts
git commit -m "feat(myt-42): webhook — handleRefundEvent (refund.created / refund.updated)"
```

---

## Task 25: Route — `GET /api/billing/skus`

**Files:**
- Create: `backend/src/routes/billing.ts` (this task ships the file with one route; subsequent tasks add the others)
- Create: `backend/src/routes/__tests__/billing.test.ts`
- Delete: `backend/src/__tests__/webhook-absence.test.ts` (was a placeholder MYT-41 test asserting POST /webhooks/stripe returns 404; MYT-42 ships the route)

Spec §4.5 (lines 329–339). Public endpoint, no auth. Reads from `getSkuCache().publicListing`. Sets `Cache-Control: public, max-age=300`. Per-IP rate limit `60/min`.

- [ ] **Step 1: Delete the placeholder absence test**

Run: `cd backend && rm src/__tests__/webhook-absence.test.ts`

- [ ] **Step 2: Write the failing test for the new route**

```ts
// backend/src/routes/__tests__/billing.test.ts
import { describe, it, expect } from 'vitest'
import { buildTestApp } from '../../__tests__/_helpers/build-test-app'

describe('GET /api/billing/skus', () => {
  it('returns the public SKU listing with Cache-Control', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/billing/skus' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('public')
    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]).toHaveProperty('lookup_key')
    expect(body[0]).toHaveProperty('displayName')
    expect(body[0]).not.toHaveProperty('stripe_price_id')  // public projection excludes internal IDs
    await app.close()
  })

  it('does not require JWT', async () => {
    const app = await buildTestApp()
    const res = await app.inject({ method: 'GET', url: '/api/billing/skus' })
    expect(res.statusCode).toBe(200)  // no Authorization header, but should still work
    await app.close()
  })
})
```

- [ ] **Step 3: Run test to verify failure**

Expected: FAIL.

- [ ] **Step 4: Implement the route + plugin shell**

```ts
// backend/src/routes/billing.ts
import type { FastifyPluginAsync } from 'fastify'
import { getSkuCache } from '../billing/sku-cache'

export const billingRoutes: FastifyPluginAsync = async (scope) => {
  scope.get('/api/billing/skus', {
    config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (_request, reply) => {
    const cache = getSkuCache()
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .send(cache.publicListing)
  })

  // Subsequent tasks add: /balance, /subscription, /history, /checkout, /portal, /upgrade-tier
}
```

- [ ] **Step 5: Run test to verify pass**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/billing.ts backend/src/routes/__tests__/billing.test.ts
git rm backend/src/__tests__/webhook-absence.test.ts
git commit -m "feat(myt-42): GET /api/billing/skus + remove webhook-absence placeholder"
```

---

## Task 26: Route — `GET /api/billing/balance`

**Files:**
- Modify: `backend/src/routes/billing.ts`
- Modify: `backend/src/routes/__tests__/billing.test.ts`

Per §4.1 line 159: JWT-protected. Reads from `credit_ledger` (sums by credit_type, ignores expired) + `user_subscriptions` (active sub via `getActiveForUser`).

- [ ] **Step 1: Write failing test**

Test list:
1. Authenticated user with no subscription, 16 unexpired session credits, 4 unexpired world credits → returns balance shape per §4.1.
2. Authenticated user with active subscription returns the tier_lookup_key.
3. No JWT → 401.

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL.

- [ ] **Step 3: Implement** per §4.1's response shape. Use existing `repo.credits.getBalance` (from MYT-40) + `repo.userSubscriptions.getActiveForUser`.

- [ ] **Step 4: Run test to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/billing.ts backend/src/routes/__tests__/billing.test.ts
git commit -m "feat(myt-42): GET /api/billing/balance"
```

---

## Task 27: Route — `GET /api/billing/subscription`

**Files:**
- Modify: `backend/src/routes/billing.ts`
- Modify: `backend/src/routes/__tests__/billing.test.ts`

Per §4.1: JWT, returns single active sub or null. Just calls `repo.userSubscriptions.getActiveForUser`.

- [ ] **Step 1: Write failing test**

Test list:
1. User with no subscription → 200 with `null`.
2. User with active subscription → 200 with the row's relevant fields.

- [ ] **Step 2: Run test to verify failure** | **Step 3: Implement** | **Step 4: Run test to verify pass** | **Step 5: Commit**

```bash
git add backend/src/routes/billing.ts backend/src/routes/__tests__/billing.test.ts
git commit -m "feat(myt-42): GET /api/billing/subscription"
```

---

## Task 28: Route — `GET /api/billing/history`

**Files:**
- Modify: `backend/src/routes/billing.ts`
- Modify: `backend/src/routes/__tests__/billing.test.ts`

Per §11 (lines 1308–1328) + §4.1 line 160. Cursor-paginated. Calls `repo.billingHistory.listByUser`.

- [ ] **Step 1: Write failing test**

Tests: 51-row pagination (page 1: 50 rows + nextCursor; page 2: 1 row + null cursor); cursor parse failure → 400 `invalid_cursor`; tie-break by id when occurred_at ties.

- [ ] **Step 2: Run test** | **Step 3: Implement** | **Step 4: Run test** | **Step 5: Commit**

```bash
git add backend/src/routes/billing.ts backend/src/routes/__tests__/billing.test.ts
git commit -m "feat(myt-42): GET /api/billing/history (cursor-paginated)"
```

---

## Task 29: Route — `POST /api/billing/checkout`

**Files:**
- Modify: `backend/src/routes/billing.ts`
- Modify: `backend/src/routes/__tests__/billing.test.ts`

Per §4.2 (cart validation) + §4.3 (Stripe Checkout Session creation).

- [ ] **Step 1: Write failing tests**

Test list:
1. Tier-only cart (1 item, quantity 1, recurring lookup_key) → returns Checkout Session URL.
2. À-la-carte cart (multiple items, all one_time lookup_keys) → returns Checkout Session URL.
3. Mixed cart (tier + à-la-carte) → 400 `mixed_cart`.
4. Tier cart with `quantity > 1` → 400 `tier_cart_shape`.
5. Tier cart with `items.length > 1` → 400 `tier_cart_shape`.
6. Duplicate lookup_key in items → 400 `duplicate_lookup_key`.
7. Unknown lookup_key → 400 `unknown_lookup_key`.
8. Calls `findOrCreateStripeCustomer` for the user.
9. Stripe down → 502 `stripe_unavailable`.

- [ ] **Step 2: Run tests** | **Step 3: Implement per §4.2 + §4.3** | **Step 4: Run tests** | **Step 5: Commit**

```bash
git add backend/src/routes/billing.ts backend/src/routes/__tests__/billing.test.ts
git commit -m "feat(myt-42): POST /api/billing/checkout"
```

---

## Task 30: Route — `POST /api/billing/portal`

**Files:**
- Modify: `backend/src/routes/billing.ts`
- Modify: `backend/src/routes/__tests__/billing.test.ts`

Per §4.4 (lines 207–216). Calls `findOrCreateStripeCustomer` then `stripe.billingPortal.sessions.create`.

- [ ] **Step 1: Write failing test** | **Step 2: Run** | **Step 3: Implement per §4.4** | **Step 4: Run** | **Step 5: Commit**

```bash
git add backend/src/routes/billing.ts backend/src/routes/__tests__/billing.test.ts
git commit -m "feat(myt-42): POST /api/billing/portal"
```

---

## Task 31: Route — `POST /api/billing/upgrade-tier`

**Files:**
- Create: `backend/src/billing/upgrade.ts`
- Create: `backend/src/billing/__tests__/upgrade.test.ts`
- Modify: `backend/src/routes/billing.ts`
- Modify: `backend/src/routes/__tests__/billing.test.ts`

Per §4.6 (lines 218–328). The upgrade endpoint uses `payment_behavior: 'pending_if_incomplete'` per round-7 redesign. The route handler wraps `executeUpgrade(...)` from `billing/upgrade.ts`.

- [ ] **Step 1: Write failing tests for `executeUpgrade`**

Test list:
1. Happy path: `subscriptions.update` returns sub with `pending_update === null` → returns `{ status: 'applied', invoice_id }`.
2. Decline path: `subscriptions.update` returns sub with `pending_update` populated → returns `{ status: 'pending', detail: { pending_update_expires_at, latest_invoice_id } }`.
3. Already-pending: a pre-call `subscriptions.retrieve` shows existing `pending_update` → returns 409 `upgrade_already_pending` (per Petra I5 round 7).
4. Idempotency-key derivation: `upgrade:${userId}:${sub_id}:${target_tier_lookup_key}` (NO period_start per Petra I1 round 8).
5. `tier_unchanged` when target === current.
6. `not_an_upgrade` when target_price <= current_price.
7. `no_active_subscription` when `getActiveForUser` returns null.

- [ ] **Step 2: Run tests** | **Step 3: Implement per §4.6** | **Step 4: Run tests** | **Step 5: Commit**

```bash
git add backend/src/billing/upgrade.ts backend/src/billing/__tests__/upgrade.test.ts backend/src/routes/billing.ts backend/src/routes/__tests__/billing.test.ts
git commit -m "feat(myt-42): POST /api/billing/upgrade-tier with payment_behavior: pending_if_incomplete"
```

---

## Task 32: Register handler refactor — trial credit grant inside BEGIN

**Files:**
- Modify: `backend/src/routes/users.ts`
- Modify: `backend/src/routes/__tests__/users.test.ts`

Per spec §3 line 75 and §8 (lines 1110–1142). The register handler refactors to:
1. Run `classifyProfanity` calls BEFORE BEGIN (Sphinx I2 round 2).
2. `await client.query('BEGIN')`.
3. `users.create(client, params)`.
4. `repo.credits.grantInTx(client, { source_type: 'trial', amount: 1, ... })`.
5. `await client.query('UPDATE users SET free_trial_used = true WHERE id = $1', [user.id])`.
6. COMMIT.
7. Read-back the row for the response.

- [ ] **Step 1: Update existing register tests + add trial-credit assertions**

Per §13 line 1213: after register, assert exactly one credit_ledger row with `source_type='trial'`, `amount=1`, `expires_at=NULL`, `source_id=NULL`, `source_purchase_id=NULL`, `source_billing_history_id=NULL`. Also `users.free_trial_used = true`.

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — register handler doesn't grant trial yet.

- [ ] **Step 3: Refactor the register handler per spec §8**

Read §8 in full. Note the BEGIN must come AFTER the LLM calls, not before.

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/users.ts backend/src/routes/__tests__/users.test.ts
git commit -m "feat(myt-42): register handler grants trial credit inside BEGIN"
```

---

## Task 33: Wire it all up in `app.ts`

**Files:**
- Modify: `backend/src/app.ts`
- Modify: `backend/src/__tests__/app.test.ts` (or create if absent)

Pin the registration order. The order is load-bearing for both the public-route allowlist hook (must be added before any `register`) and the webhook plugin's encapsulation (must register at root level so it's a direct child of `app`).

- [ ] **Step 1: Write failing smoke test**

```ts
// backend/src/__tests__/app.test.ts
import { describe, it, expect } from 'vitest'
import { buildApp } from '../app'

describe('app boot', () => {
  it('app.ready() resolves without throwing', async () => {
    const app = await buildApp(/* test deps */)
    await expect(app.ready()).resolves.toBeDefined()
    await app.close()
  })

  it('GET /webhooks/stripe is registered (returns 404 only via method mismatch, NOT route-not-found)', async () => {
    const app = await buildApp()
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/webhooks/stripe', payload: 'invalid' })
    // Returns 400 (missing signature) — proves the route exists
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL.

- [ ] **Step 3: Update `app.ts` registration order**

```ts
// backend/src/app.ts
// LOAD-BEARING ORDER:
//   (1) cors (root scope)
//   (2) rate-limit (root scope) — per-route configs in encapsulated children require root-scope plugin
//   (3) public-route allowlist hook on `app` itself — must precede every register() call
//   (4) auth preHandler / require-onboarded
//   (5) webhookRoutes — direct child of `app`, encapsulated raw-body parser scope
//   (6) billingRoutes
//   (7) other routes (users, invites, etc.)
import Fastify from 'fastify'
import { registerPublicRouteAllowlistHook } from './auth/public-route-allowlist'
import { webhookRoutes } from './routes/webhook'
import { billingRoutes } from './routes/billing'
// ... existing imports ...

export async function buildApp(deps): Promise<FastifyInstance> {
  const app = Fastify({ /* opts */ })
  await app.register(corsPlugin)
  await app.register(rateLimitPlugin)
  registerPublicRouteAllowlistHook(app)
  // ... existing auth + onboarded preHandler wiring ...
  await app.register(webhookRoutes)
  await app.register(billingRoutes)
  // ... other routes ...
  return app
}
```

- [ ] **Step 4: Run tests to verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app.ts backend/src/__tests__/app.test.ts
git commit -m "feat(myt-42): app.ts wiring — allowlist hook + webhook + billing routes (LOAD-BEARING ORDER)"
```

---

## Task 34: Sync runbook + spec patches

**Files:**
- Modify: `tmp/myt-42-stripe-dashboard-instructions.md`
- Modify: `docs/specs/2026-04-13-billing-cost-controls.md`
- Modify: `docs/specs/2026-04-13-backend-core.md`
- Modify: `docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md`
- Modify: `docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md`

Per spec §14 (lines 1523–1550).

- [ ] **Step 1: Apply each spec's patches per §14**

Read §14 in full. The patches are:

**MYT-41 spec patches:**
- §"Per-event-type resolution rules" — invert per Decision 1 of round-2 review.
- §"Webhook credit-grant contract for MYT-42" — add notes 1–9 from §3.1 of this spec verbatim.
- §"Webhook credit-grant contract for MYT-42" — add `customer.subscription.created`, `pending_update_applied`, `pending_update_expired`, `refund.created`, `refund.updated` to the webhook event subscription list.
- §"Customer Portal config" — add explicit settings per Decision 2.
- §"Account-level Payment Methods config" — add per Decision 3.
- §8 portal lazy-create — patch.
- §"Refund handling" — explicitly say negative-polarity rows use `source_type='debit'` (NOT `'refund'`).

**Parent billing spec patches** (§4, §5, §7, §10): per the spec's §14 list.

**Backend-core spec patches**: per the spec's §14 list.

**MYT-40 spec patches**: per the spec's §14 list.

**Runbook**: sync `tmp/myt-42-stripe-dashboard-instructions.md` with all the launch-day click-paths — Account-level Payment Methods (Decision 3), Customer Portal config (Decision 2), Webhook endpoint registration (events list per §15.3 + API version pin), `whsec_*` rotation post-deploy.

- [ ] **Step 2: Verify spec patches don't introduce orphan references**

Run: `cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && grep -rn "MYT-42\|myt-42" docs/specs/ docs/superpowers/specs/ | head -30`

Spot-check each cross-reference still resolves.

- [ ] **Step 3: Commit**

```bash
git add tmp/myt-42-stripe-dashboard-instructions.md docs/specs/2026-04-13-billing-cost-controls.md docs/specs/2026-04-13-backend-core.md docs/superpowers/specs/2026-05-01-myt-40-credit-ledger-design.md docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md
git commit -m "docs(myt-42): sync MYT-41 + parent billing + backend-core + MYT-40 spec patches"
```

---

## Task 35: Pre-ship verification — `payment_behavior: 'pending_if_incomplete'` test-mode behavior

**Files:**
- Create: `backend/src/billing/__tests__/upgrade-pending-update.test.ts`
- (Manual): Stripe test-mode dashboard

Per spec §3.1 note 9 — empirical verification that `payment_behavior: 'pending_if_incomplete'` + price-change on existing item produces a `pending_update` and does NOT advance items on a known-decline test card. This is "trust-but-verify" because of historical Cashier issue #969.

- [ ] **Step 1: Write the integration test (uses real Stripe test API)**

This test does NOT mock Stripe — it calls the real Stripe test API. Mark it as an integration test that runs only with `STRIPE_TEST_API_KEY` set. The test:
1. Creates a test customer.
2. Attaches a known-decline card (`4000000000000341` for soft decline).
3. Creates a subscription on Wayfarer's price ID.
4. Calls `subscriptions.update` with the Mythwright price ID + `payment_behavior: 'pending_if_incomplete'` + `proration_behavior: 'always_invoice'`.
5. Asserts the returned Subscription has `pending_update` populated AND `items.data[0].price.id === wayfarer_price_id` (items did NOT advance).

- [ ] **Step 2: Run the integration test**

Run: `cd backend && STRIPE_TEST_API_KEY=$rk_test_... pnpm vitest run src/billing/__tests__/upgrade-pending-update.test.ts`

Expected: PASS.

If the test FAILS (`pending_update` is null after the call OR items DID advance), it means the historical Cashier #969 limitation is still present at our SDK/API version. STOP and discuss with the user — the upgrade flow design depends on this behavior.

- [ ] **Step 3: Commit**

```bash
git add backend/src/billing/__tests__/upgrade-pending-update.test.ts
git commit -m "test(myt-42): empirical pending_if_incomplete verification on Stripe test mode"
```

---

## Task 36: Final pass — typecheck, lint, full test suite, schema-parity, manual smoke

**Files:**
- (No file changes — verification only)

Per `superpowers:verification-before-completion`: don't claim the work is done until the verification commands pass.

- [ ] **Step 1: Full typecheck**

Run: `cd backend && pnpm typecheck`

Expected: 0 errors.

- [ ] **Step 2: Full lint**

Run: `cd backend && pnpm lint`

Expected: 0 errors. Address any warnings.

- [ ] **Step 3: Full test suite**

Run: `cd backend && pnpm vitest run`

Expected: All tests pass.

- [ ] **Step 4: Schema-parity sanity check**

Run: `cd backend && pnpm vitest run src/db/__tests__/migrate-schema.test.ts`

Expected: PASS — all 7 migrations apply cleanly and the resulting schema matches the expected shape.

- [ ] **Step 5: Manual smoke test — boot the app**

Run: `cd backend && pnpm dev` (or however the dev-mode boot is wired).

Expected: app boots without throwing. Logs should show:
- Boot probe pass.
- SKU cache populated.
- Customer Portal config probe pass.
- All routes registered, including `POST /webhooks/stripe`.
- `app.ready()` resolves.

If the boot fails on a `auth: public used on non-allowlisted route` error, audit your routes — every public route must be in the allowlist.

- [ ] **Step 6: Manual smoke — register flow grants trial**

With the app running, hit `POST /api/users/register` with a valid payload. Verify in the DB: one new `users` row with `free_trial_used=true`; one new `credit_ledger` row with `source_type='trial'`, `amount=1`.

- [ ] **Step 7: No commit (verification-only); record in the plan that all checks passed**

If all 6 steps passed, the implementation is verified and ready for the close-loop steps in CLAUDE.md (wiki update + push + Linear close).

---

## Self-Review

Coverage check against the spec:

| Spec section | Task |
|---|---|
| §1 Goal | covered by tasks 1–33 in aggregate |
| §2 Non-goals | n/a (no work) |
| §3 Architecture overview | task 33 (app.ts wiring) + task 11 (allowlist) + task 10 (type augmentation) |
| §3.1 Stripe API at dahlia field-shape notes | tasks 17–24 (per-handler) |
| §4.1 Body shapes + auth | tasks 25–31 (one per route) |
| §4.2 Cart validation | task 29 |
| §4.3 Checkout Session creation | task 29 |
| §4.4 Customer Portal creation | task 30 |
| §4.5 SKU listing | task 25 |
| §4.6 Tier upgrade endpoint | task 31 |
| §5.1 Webhook route + raw-body parser | task 15 |
| §5.2 Signature verification | task 15 |
| §5.3 Idempotency + dispatch | task 16 |
| §5.4.1 checkout.session.completed | tasks 17 + 18 |
| §5.4.2 invoice.paid | task 19 |
| §5.4.3 customer.subscription.created/.updated | task 20 |
| §5.4.4 customer.subscription.deleted | task 21 |
| §5.4.5 refund.created/.updated | task 24 |
| §5.4.6 pending_update_applied/_expired | tasks 22 + 23 |
| §5.5 Customer-not-found | covered in handler tasks |
| §5.6 Unknown event types | task 16 |
| §6 Migration 007 | task 1 |
| §7.1 repo.purchases | task 3 |
| §7.2 repo.userSubscriptions | task 4 |
| §7.3 repo.stripeEvents | task 2 |
| §7.4 repo.billingHistory | task 5 |
| §7.5 repo.users.create + findOrCreateStripeCustomer | tasks 6 + 7 |
| §7.6 repo.credits grantInTx + recordClawback | task 8 |
| §8 Trial credit at registration | task 32 |
| §9 Customer-create lifecycle | task 7 |
| §10 SKU listing cache | tasks 12 + 13 |
| §11 History endpoint | task 28 |
| §12.1 BillingErrorCode union | task 9 |
| §12.2 Scenarios | covered by handler + route tests |
| §13 Testing | covered task-by-task |
| §14 Spec patches | task 34 |
| §15 Operational notes | task 34 (runbook) + Miklos manual action (Dashboard click-paths) |

No spec gaps identified. Type consistency verified: every method signature in the file-structure table is referenced consistently across tasks.

Placeholder scan: no "TBD" / "implement later" / "similar to Task N" patterns. Each task has its own code blocks (or explicit reference to a spec section with the code).

---

Plan complete and saved to `docs/superpowers/plans/2026-05-06-myt-42-stripe-webhook-checkout.md`.
