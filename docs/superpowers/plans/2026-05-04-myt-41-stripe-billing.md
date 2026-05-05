# MYT-41 Stripe Billing Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Stripe products/prices contract, boot probe, ESLint guards, migration 006, and parent-spec patches per `docs/superpowers/specs/2026-05-04-myt-41-stripe-billing-design.md`. Stripe Dashboard provisioning is a precondition (Miklos executes `tmp/myt-41-stripe-dashboard-instructions.md` before code lands).

**Architecture:** Three layers of price-mutation defense — restricted Stripe API key (the actual SDK-level boundary), `lookup-keys.ts` indirection (no hardcoded price IDs in code), ESLint tripwires (code-review gate). Boot probe verifies every lookup_key resolves to a Stripe price with the right shape (currency, type, interval, usage_type, billing_scheme, transform_quantity, tax_behavior, product.active, no duplicates) — fails loud on contract drift, retries on transient errors, fails fast on auth errors. Migration 006 drops the legacy billing-config tables (`subscription_tiers`, `session_packs`, plus FK-dependent `user_subscriptions` and `purchases` — recreated by MYT-42 with the new shape).

**Tech Stack:** Node 24 + TypeScript strict + Fastify v5 + Postgres (pg) + Stripe SDK (`stripe@^17`) + Vitest + ESLint flat config (`typescript-eslint`).

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `backend/package.json` | Modify | Add `stripe` dependency. |
| `backend/src/config/env.ts` | Modify | Add `stripeSecretKey` + `stripeWebhookSecret` to `Env`, validate `rk_` prefix on the secret key, accept `'PLACEHOLDER'` literal for the webhook secret (until MYT-42). |
| `backend/src/__tests__/setup-env.ts` | Modify | Add `STRIPE_SECRET_KEY` (`rk_test_baseline`) + `STRIPE_WEBHOOK_SECRET` (`PLACEHOLDER`) baselines so existing tests keep passing. |
| `backend/src/config/__tests__/env.test.ts` | Modify | Add tests: `rk_` prefix accepted, `sk_` prefix rejected, `STRIPE_WEBHOOK_SECRET=PLACEHOLDER` accepted. |
| `backend/src/billing/lookup-keys.ts` | Create | The contract: `LookupKey` union + `LOOKUP_KEYS` map with five entries. |
| `backend/src/billing/__tests__/lookup-keys.test.ts` | Create | Drift test, per-key shape assertions, display-name exactness, `length <= 100` static check. |
| `backend/src/billing/stripe-client.ts` | Create | Module-level cached `Stripe` client constructor; `STRIPE_API_VERSION = '2026-03-25.dahlia'`. |
| `backend/src/billing/probe.ts` | Create | Boot probe with retry/backoff/jitter, full billing-shape verification, structured `bootId`-correlated events, distinct error classes (mismatch / auth / API-change / transient). |
| `backend/src/billing/__tests__/probe.test.ts` | Create | Mocks Stripe SDK at import boundary; covers happy path, every mismatch class, auth failure (no retry), transient retry-then-success, transient exhaustion, has_more API-change, duplicate detection, multiple-mismatches reporting. |
| `backend/src/server.ts` | Modify | After `waitFor` block + before `app.listen`, construct `getStripeClient(env)` and call `probeStripeContract(stripe, logger)`. Errors propagate to the existing `try/catch` boot-fail path. |
| `backend/migrations/006_drop_billing_config_tables.sql` | Create | Pre-drop emptiness ASSERT, FK-correct DROP order (`user_subscriptions`, `purchases`, `session_packs`, `subscription_tiers`), post-drop ASSERT. |
| `backend/src/db/__tests__/migrate-schema.test.ts` | Modify | Drop four tables from `EXPECTED_TABLES`; drop `idx_user_subscriptions_user`, `idx_purchases_user` from `EXPECTED_IDX_NAMES`; drop `purchases.status` + `user_subscriptions.status` checks; drop the three FK rows; append `'006_drop_billing_config_tables.sql'` to migrations list. |
| `backend/src/repo/__tests__/_helpers/reset-data.ts` | Modify | Remove `subscription_tiers`, `session_packs`, `user_subscriptions`, `purchases` from `TABLES`. |
| `backend/eslint-rules/no-stripe-price-mutations.cjs` | Create | ESLint flat-config-compatible custom rule. Bans `prices.create|update`, `products.create|update|del`, `coupons.*`, `promotionCodes.create|update`. |
| `backend/eslint-rules/no-stripe-subscription-price-mutation.cjs` | Create | Bans `stripe.subscriptions.update(_, { items: [{ price }] })`. Conservative — any `items` array containing an object with a `price` property fires. |
| `backend/eslint-rules/__tests__/no-stripe-price-mutations.test.cjs` | Create | `RuleTester` cases: banned set + allowed set per spec §6. |
| `backend/eslint-rules/__tests__/no-stripe-subscription-price-mutation.test.cjs` | Create | `RuleTester` cases for the subscription-item-price-mutation rule. |
| `backend/eslint-rules/__tests__/config-wiring.test.cjs` | Create | Vitest test that runs `pnpm exec eslint <fixture>` and asserts non-zero exit. Catches "rule shipped but not registered." |
| `backend/eslint-rules/__tests__/fixtures/banned.fixture.ts` | Create | One-line file containing `stripe.prices.create({})` for the smoke test. |
| `backend/src/__tests__/webhook-absence.test.ts` | Create | Asserts `app.inject({ method: 'POST', url: '/webhooks/stripe' })` returns 404. MYT-42 deletes this. |
| `eslint.config.js` (repo root) | Modify | Register both custom rules; load via `import` from `./backend/eslint-rules/`. |
| `tmp/myt-41-stripe-dashboard-instructions.md` | Modify | Sync runbook with all round-3 spec additions (interval_count, usage_type, billing_scheme, transform_quantity, tax_behavior, product.active checks; restricted-key permission table; no-Stripe-Dashboard-webhook-endpoint-yet reminder). |
| `docs/specs/2026-04-13-billing-cost-controls.md` | Modify | Patches §3 + §4 + §5 + §6 + §7 + §9 + §10 per spec §"Spec patches". |
| `docs/specs/2026-04-13-backend-core.md` | Modify | Schema-block cleanup + repo-namespace cleanup per spec §"Backend Core". |
| `docs/specs/2026-04-06-production-architecture-overview.md` | Modify | Orphan-reference cleanup. |
| `docs/specs/2026-04-10-ux-design.md` | Modify | Drop session-pack copy; update tier names. |

**Out-of-scope for this plan (other commits / human action):**
- Stripe Dashboard provisioning (Miklos executes `tmp/myt-41-stripe-dashboard-instructions.md` BEFORE these commits land).
- Wiki update (run via AUTHORING.md subagent at end-of-issue close, in same push as code).
- Linear close + bead `myth-billing-probe-alarm` + bead `myth-u7k` re-scope.

---

## Task 1: Install Stripe SDK + version pin

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/pnpm-lock.yaml` (autogenerated)

- [ ] **Step 1: Install the dependency**

```bash
cd backend && pnpm add stripe
```

The SDK's apiVersion type-narrows to a literal union; the spec pins `'2026-03-25.dahlia'`. If the installed SDK version doesn't include that literal, the spec's `stripe-client.ts` will fail tsc — which is fine, that's the build-time signal. We expect the latest `stripe` (~17 or 18 at install time) to support `2026-03-25.dahlia`.

- [ ] **Step 2: Verify the install**

```bash
cd backend && node -e 'const Stripe = require("stripe"); console.log(Stripe.PACKAGE_VERSION ?? "n/a")'
```

Expected: a version string is printed (e.g. `17.x.x` or higher). The `Stripe.PACKAGE_VERSION` field exists on recent SDK versions.

- [ ] **Step 3: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/package.json pnpm-lock.yaml
git commit -m "feat(myt-41): add stripe SDK dependency"
```

---

## Task 2: Extend `env.ts` for Stripe fields + `rk_` prefix validation

**Files:**
- Modify: `backend/src/config/env.ts`
- Modify: `backend/src/__tests__/setup-env.ts`

- [ ] **Step 1: Update setup-env.ts test baselines**

Edit `backend/src/__tests__/setup-env.ts`. Find the existing baselines block:

```typescript
process.env.AUTH_MODE ??= 'bypass'
process.env.NODE_ENV ??= 'development'
process.env.FRONTEND_BASE_URL ??= 'http://localhost:5173'
```

Add two lines below it:

```typescript
process.env.STRIPE_SECRET_KEY ??= 'rk_test_baseline_for_setup_env'
process.env.STRIPE_WEBHOOK_SECRET ??= 'PLACEHOLDER'
```

Why this comes first: existing tests call `loadEnv()` indirectly. Adding the new required env vars to the baseline means existing tests don't break.

- [ ] **Step 2: Write a failing test for `loadEnv()` Stripe fields**

Open `backend/src/config/__tests__/env.test.ts`. If the file doesn't exist or doesn't yet have a Stripe section, append (or insert near the other `loadEnv` tests):

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadEnv } from '../env.js'

describe('loadEnv — Stripe fields', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts a restricted-key (rk_) prefix and exposes stripeSecretKey + stripeWebhookSecret', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc123')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_real_value')
    const env = loadEnv()
    expect(env.stripeSecretKey).toBe('rk_test_abc123')
    expect(env.stripeWebhookSecret).toBe('whsec_real_value')
  })

  it('rejects a full-permission (sk_) secret key', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_full_permission')
    expect(() => loadEnv()).toThrow(/STRIPE_SECRET_KEY must be a Stripe restricted key/)
  })

  it("accepts 'PLACEHOLDER' as the webhook secret (pre-MYT-42 window)", () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc123')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'PLACEHOLDER')
    const env = loadEnv()
    expect(env.stripeWebhookSecret).toBe('PLACEHOLDER')
  })

  it('rejects an empty STRIPE_SECRET_KEY', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '')
    expect(() => loadEnv()).toThrow(/STRIPE_SECRET_KEY/)
  })

  it('rejects an empty STRIPE_WEBHOOK_SECRET', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'rk_test_abc123')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
    expect(() => loadEnv()).toThrow(/STRIPE_WEBHOOK_SECRET/)
  })
})
```

- [ ] **Step 3: Run the test to confirm it FAILS**

```bash
cd backend && pnpm exec vitest run --no-coverage src/config/__tests__/env.test.ts
```

Expected: failures with messages like `Cannot find property 'stripeSecretKey'` or `loadEnv did not throw`.

- [ ] **Step 4: Implement the changes in `env.ts`**

In `backend/src/config/env.ts`:

(a) Extend the `Env` interface:

```typescript
export interface Env {
  readonly databaseUrl: string
  readonly redisRealtimeUrl: string
  readonly redisBatchUrl: string
  readonly port: number
  readonly authMode: AuthMode
  readonly cognitoUserPoolId?: string
  readonly cognitoAppClientId?: string
  readonly cognitoIssuerUrl?: string
  readonly cognitoHostedUiDomain?: string
  readonly frontendBaseUrl: string
  readonly stripeSecretKey: string
  readonly stripeWebhookSecret: string
}
```

(b) Add a validator function near `validateFrontendBaseUrl`:

```typescript
// Mythrun deploys with Stripe restricted keys (rk_*), never full-permission
// keys (sk_*). The restricted key is the actual price-mutation boundary
// per the §1 design decision. Misrotation that puts a full-permission key
// here would silently degrade the defense — the boot probe (read-only)
// would still pass. Catching it at env-load is the cheapest enforcement.
function validateStripeSecretKey(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('STRIPE_SECRET_KEY is required')
  }
  if (!raw.startsWith('rk_')) {
    throw new Error(
      `STRIPE_SECRET_KEY must be a Stripe restricted key (rk_*); got prefix '${raw.slice(0, 3)}'. ` +
        `Full-permission keys (sk_*) are forbidden in deployed environments per the MYT-41 design.`,
    )
  }
  return raw
}

function validateStripeWebhookSecret(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('STRIPE_WEBHOOK_SECRET is required (use PLACEHOLDER until MYT-42 wires the handler)')
  }
  // PLACEHOLDER literal is permitted in the MYT-41 → MYT-42 window. MYT-42's
  // webhook handler verifies via stripe.webhooks.constructEvent unconditionally;
  // any signature mismatch fails closed regardless of whether the secret is
  // the literal 'PLACEHOLDER' or a real whsec_*. No bypass branch.
  return raw
}
```

(c) Update `loadEnv()` to read + validate:

```typescript
export function loadEnv(): Env {
  const portRaw = process.env.PORT
  if (!portRaw) throw new Error('Missing required env var: PORT')
  const port = Number(portRaw)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT must be numeric, got: ${portRaw}`)
  }
  const authConfig = loadAuthConfig()
  const frontendBaseUrl = validateFrontendBaseUrl(
    process.env.FRONTEND_BASE_URL,
    process.env.NODE_ENV,
  )
  const stripeSecretKey = validateStripeSecretKey(process.env.STRIPE_SECRET_KEY)
  const stripeWebhookSecret = validateStripeWebhookSecret(process.env.STRIPE_WEBHOOK_SECRET)
  return Object.freeze({
    databaseUrl: buildDatabaseUrl(),
    redisRealtimeUrl: buildRedisUrl('realtime'),
    redisBatchUrl: buildRedisUrl('batch'),
    port,
    ...authConfig,
    frontendBaseUrl,
    stripeSecretKey,
    stripeWebhookSecret,
  })
}
```

- [ ] **Step 5: Re-run the env tests — expect PASS**

```bash
cd backend && pnpm exec vitest run --no-coverage src/config/__tests__/env.test.ts
```

Expected: all 5 new tests pass.

- [ ] **Step 6: Run typecheck (catches downstream consumers of `Env`)**

```bash
cd backend && pnpm typecheck
```

Expected: clean. The new fields are additive; nothing should regress.

- [ ] **Step 7: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/src/config/env.ts backend/src/config/__tests__/env.test.ts backend/src/__tests__/setup-env.ts
git commit -m "feat(myt-41): env — stripeSecretKey (rk_ prefix) + stripeWebhookSecret"
```

---

## Task 3: `lookup-keys.ts` contract + tests

**Files:**
- Create: `backend/src/billing/lookup-keys.ts`
- Create: `backend/src/billing/__tests__/lookup-keys.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/billing/__tests__/lookup-keys.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { LOOKUP_KEYS, type LookupKey } from '../lookup-keys.js'

describe('LOOKUP_KEYS contract', () => {
  it('every map key matches its lookupKey property (drift detection)', () => {
    for (const k of Object.keys(LOOKUP_KEYS) as LookupKey[]) {
      expect(LOOKUP_KEYS[k].lookupKey).toBe(k)
    }
  })

  it('tier_wayfarer: recurring, 4 sessions, 1 world, "Wayfarer"', () => {
    expect(LOOKUP_KEYS.tier_wayfarer).toEqual({
      lookupKey: 'tier_wayfarer',
      displayName: 'Wayfarer',
      type: 'recurring',
      sessionsGranted: 4,
      worldsGranted: 1,
    })
  })

  it('tier_sojourner: recurring, 8 sessions, 2 worlds, "Sojourner"', () => {
    expect(LOOKUP_KEYS.tier_sojourner).toEqual({
      lookupKey: 'tier_sojourner',
      displayName: 'Sojourner',
      type: 'recurring',
      sessionsGranted: 8,
      worldsGranted: 2,
    })
  })

  it('tier_mythwright: recurring, 16 sessions, 4 worlds, "Mythwright"', () => {
    expect(LOOKUP_KEYS.tier_mythwright).toEqual({
      lookupKey: 'tier_mythwright',
      displayName: 'Mythwright',
      type: 'recurring',
      sessionsGranted: 16,
      worldsGranted: 4,
    })
  })

  it('sku_session: one_time, 1 session, 0 worlds, "Session"', () => {
    expect(LOOKUP_KEYS.sku_session).toEqual({
      lookupKey: 'sku_session',
      displayName: 'Session',
      type: 'one_time',
      sessionsGranted: 1,
      worldsGranted: 0,
    })
  })

  it('sku_world: one_time, 1 session, 1 world, "World"', () => {
    expect(LOOKUP_KEYS.sku_world).toEqual({
      lookupKey: 'sku_world',
      displayName: 'World',
      type: 'one_time',
      sessionsGranted: 1,
      worldsGranted: 1,
    })
  })

  it('contract size <= 100 (Stripe prices.list lookup_keys filter ceiling)', () => {
    expect(Object.keys(LOOKUP_KEYS).length).toBeLessThanOrEqual(100)
  })

  it('exactly 5 entries', () => {
    expect(Object.keys(LOOKUP_KEYS)).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run — expect FAIL (module doesn't exist)**

```bash
cd backend && pnpm exec vitest run --no-coverage src/billing/__tests__/lookup-keys.test.ts
```

Expected: `Cannot find module '../lookup-keys.js'`.

- [ ] **Step 3: Create `backend/src/billing/lookup-keys.ts`**

```typescript
// Exhaustive list of every Stripe lookup_key Mythrun uses.
//
// Pricing is NOT in this file. Price stays in Stripe. Code that needs
// the live price retrieves it from the Stripe API at runtime via
// stripe.prices.retrieve / list.
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

- [ ] **Step 4: Run — expect PASS**

```bash
cd backend && pnpm exec vitest run --no-coverage src/billing/__tests__/lookup-keys.test.ts
```

Expected: 8 tests, all green.

- [ ] **Step 5: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/src/billing/lookup-keys.ts backend/src/billing/__tests__/lookup-keys.test.ts
git commit -m "feat(myt-41): lookup-keys.ts contract — 3 tiers + 2 a-la-carte SKUs"
```

---

## Task 4: `stripe-client.ts` wrapper

**Files:**
- Create: `backend/src/billing/stripe-client.ts`

This is a small constructor-cache module. Its main correctness signal is "does it tsc against the installed Stripe SDK with `apiVersion: '2026-03-25.dahlia'`." Behavioral tests for the cached-instance behavior would tangle with module mocking and offer little value; the probe.test.ts (next task) exercises it indirectly.

- [ ] **Step 1: Create `backend/src/billing/stripe-client.ts`**

```typescript
// Module-level cached client. Tests that need a different env must mock
// the Stripe SDK at the import boundary (vitest's vi.mock), not reach into
// this cache. The cache is process-scoped; rotation requires a process
// restart (ECS rolling deploy after Secrets Manager update).

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

- [ ] **Step 2: Verify typecheck**

```bash
cd backend && pnpm typecheck
```

Expected: clean. If `'2026-03-25.dahlia'` isn't in the installed Stripe SDK's `apiVersion` literal union, TS errors here. If that happens: bump the Stripe SDK version (`pnpm add stripe@latest`) and try again. The Stripe SDK currently installed should accept it.

- [ ] **Step 3: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/src/billing/stripe-client.ts
git commit -m "feat(myt-41): stripe-client.ts — cached client pinned to 2026-03-25.dahlia"
```

---

## Task 5: `probe.ts` — boot-time verify

**Files:**
- Create: `backend/src/billing/probe.ts`
- Create: `backend/src/billing/__tests__/probe.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/billing/__tests__/probe.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import Stripe from 'stripe'
import {
  probeStripeContract,
  BillingProbeError,
  BillingProbeAuthError,
  BillingProbeStripeAPIChangeError,
  BillingProbeTransientError,
} from '../probe.js'

type PriceFixture = {
  id: string
  lookup_key: string
  currency: string
  unit_amount: number
  billing_scheme: 'per_unit' | 'tiered'
  transform_quantity: null | { divide_by: number; round: 'up' | 'down' }
  tax_behavior: 'unspecified' | 'inclusive' | 'exclusive' | null
  recurring: null | { interval: 'month' | 'year' | 'week' | 'day'; interval_count: number; usage_type: 'licensed' | 'metered' }
  product: { id: string; active: boolean }
}

function tierFixture(overrides: Partial<PriceFixture> = {}): PriceFixture {
  return {
    id: 'price_tier_wayfarer',
    lookup_key: 'tier_wayfarer',
    currency: 'usd',
    unit_amount: 1500,
    billing_scheme: 'per_unit',
    transform_quantity: null,
    tax_behavior: 'unspecified',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: { id: 'prod_wayfarer', active: true },
    ...overrides,
  }
}

function skuFixture(overrides: Partial<PriceFixture> = {}): PriceFixture {
  return {
    id: 'price_sku_session',
    lookup_key: 'sku_session',
    currency: 'usd',
    unit_amount: 500,
    billing_scheme: 'per_unit',
    transform_quantity: null,
    tax_behavior: 'unspecified',
    recurring: null,
    product: { id: 'prod_session', active: true },
    ...overrides,
  }
}

function allFiveFixtures(): PriceFixture[] {
  return [
    tierFixture({ id: 'price_w', lookup_key: 'tier_wayfarer', product: { id: 'p_w', active: true } }),
    tierFixture({ id: 'price_s', lookup_key: 'tier_sojourner', product: { id: 'p_s', active: true } }),
    tierFixture({ id: 'price_m', lookup_key: 'tier_mythwright', product: { id: 'p_m', active: true } }),
    skuFixture({ id: 'price_se', lookup_key: 'sku_session', product: { id: 'p_se', active: true } }),
    skuFixture({ id: 'price_wo', lookup_key: 'sku_world', product: { id: 'p_wo', active: true } }),
  ]
}

function listOk(data: PriceFixture[], hasMore = false) {
  return { data, has_more: hasMore }
}

function makeLogger(): { logger: Logger; calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = []
  const make = (level: string) => (obj: Record<string, unknown>) => calls.push([level, obj])
  const logger = {
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  } as unknown as Logger
  return { logger, calls }
}

function makeStripe(list: ReturnType<typeof vi.fn>) {
  return { prices: { list } } as unknown as Stripe
}

describe('probeStripeContract', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('happy path — all 5 lookup_keys with correct shape → resolves', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const { logger, calls } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).resolves.toBeUndefined()
    const events = calls.map(([, o]) => o['event'])
    expect(events).toContain('billing.probe_started')
    expect(events).toContain('billing.probe_passed')
  })

  it('missing lookup_key → BillingProbeError with not-found message', async () => {
    const fixtures = allFiveFixtures().filter((p) => p.lookup_key !== 'tier_wayfarer')
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      name: 'BillingProbeError',
      mismatches: expect.arrayContaining([expect.stringContaining('not found in active Stripe prices')]),
    })
  })

  it('type mismatch — tier_* returned as one-time → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_wayfarer' ? { ...p, recurring: null } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining("contract expects 'recurring'")]),
    })
  })

  it("currency mismatch — 'eur' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_session' ? { ...p, currency: 'eur' } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining("currency 'eur'")]),
    })
  })

  it('unit_amount = 0 → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_world' ? { ...p, unit_amount: 0 } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('unit_amount')]),
    })
  })

  it("billing_scheme = 'tiered' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_sojourner' ? { ...p, billing_scheme: 'tiered' as const } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('billing_scheme')]),
    })
  })

  it('transform_quantity ≠ null → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_session'
        ? { ...p, transform_quantity: { divide_by: 2, round: 'up' as const } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('transform_quantity')]),
    })
  })

  it("tax_behavior = 'inclusive' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_world' ? { ...p, tax_behavior: 'inclusive' as const } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('tax_behavior')]),
    })
  })

  it("recurring.interval = 'year' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_mythwright' && p.recurring
        ? { ...p, recurring: { ...p.recurring, interval: 'year' as const } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('recurring.interval')]),
    })
  })

  it('recurring.interval_count = 3 (quarterly) → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_wayfarer' && p.recurring
        ? { ...p, recurring: { ...p.recurring, interval_count: 3 } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('recurring.interval_count')]),
    })
  })

  it("recurring.usage_type = 'metered' → BillingProbeError", async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_sojourner' && p.recurring
        ? { ...p, recurring: { ...p.recurring, usage_type: 'metered' as const } }
        : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('usage_type')]),
    })
  })

  it('archived product (product.active=false) → BillingProbeError', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'sku_session' ? { ...p, product: { ...p.product, active: false } } : p,
    )
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('archived')]),
    })
  })

  it('duplicate active lookup_key → BillingProbeError (no silent last-wins)', async () => {
    const fixtures = [
      ...allFiveFixtures(),
      tierFixture({ id: 'price_dup', lookup_key: 'tier_wayfarer', product: { id: 'p_dup', active: true } }),
    ]
    const list = vi.fn().mockResolvedValue(listOk(fixtures))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([expect.stringContaining('2 active Stripe prices')]),
    })
  })

  it('multiple mismatches — all reported (no short-circuit)', async () => {
    const fixtures = allFiveFixtures().map((p) =>
      p.lookup_key === 'tier_sojourner' ? { ...p, currency: 'eur' } : p,
    )
    // also drop tier_mythwright entirely
    const filtered = fixtures.filter((p) => p.lookup_key !== 'tier_mythwright')
    const list = vi.fn().mockResolvedValue(listOk(filtered))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      mismatches: expect.arrayContaining([
        expect.stringContaining('tier_mythwright'),
        expect.stringContaining('tier_sojourner'),
      ]),
    })
  })

  it('has_more = true → BillingProbeStripeAPIChangeError', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures(), true))
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toBeInstanceOf(
      BillingProbeStripeAPIChangeError,
    )
  })

  it('StripeAuthenticationError (401) → BillingProbeAuthError, no retry', async () => {
    const authErr = new Stripe.errors.StripeAuthenticationError({
      type: 'StripeAuthenticationError',
      message: 'Invalid API Key',
      raw: {},
      headers: {},
      requestId: 'req_x',
      statusCode: 401,
    } as unknown as Stripe.StripeRawError)
    const list = vi.fn().mockRejectedValue(authErr)
    const { logger, calls } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toBeInstanceOf(
      BillingProbeAuthError,
    )
    expect(list).toHaveBeenCalledTimes(1)
    expect(calls.some(([, o]) => o['event'] === 'billing.probe_auth_failed')).toBe(true)
  })

  it('StripePermissionError (403) → BillingProbeAuthError, no retry', async () => {
    const permErr = new Stripe.errors.StripePermissionError({
      type: 'StripePermissionError',
      message: 'Restricted key missing Prices: read',
      raw: {},
      headers: {},
      requestId: 'req_y',
      statusCode: 403,
    } as unknown as Stripe.StripeRawError)
    const list = vi.fn().mockRejectedValue(permErr)
    const { logger } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toBeInstanceOf(
      BillingProbeAuthError,
    )
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('transient error twice then success → resolves; emits 2 retry events', async () => {
    const apiErr = new Stripe.errors.StripeAPIError({
      type: 'StripeAPIError',
      message: '503',
      raw: {},
      headers: {},
      requestId: 'req_z',
      statusCode: 503,
    } as unknown as Stripe.StripeRawError)
    const list = vi
      .fn()
      .mockRejectedValueOnce(apiErr)
      .mockRejectedValueOnce(apiErr)
      .mockResolvedValueOnce(listOk(allFiveFixtures()))
    const { logger, calls } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).resolves.toBeUndefined()
    expect(list).toHaveBeenCalledTimes(3)
    const retries = calls.filter(([, o]) => o['event'] === 'billing.probe_transient_retry')
    expect(retries).toHaveLength(2)
    expect(calls.some(([, o]) => o['event'] === 'billing.probe_passed')).toBe(true)
  }, 30_000)

  it('transient error 3 times → BillingProbeTransientError; emits transient_failed', async () => {
    const apiErr = new Stripe.errors.StripeAPIError({
      type: 'StripeAPIError',
      message: '503',
      raw: {},
      headers: {},
      requestId: 'req_q',
      statusCode: 503,
    } as unknown as Stripe.StripeRawError)
    const list = vi.fn().mockRejectedValue(apiErr)
    const { logger, calls } = makeLogger()
    await expect(probeStripeContract(makeStripe(list), logger)).rejects.toMatchObject({
      name: 'BillingProbeTransientError',
      attempts: 3,
    })
    expect(list).toHaveBeenCalledTimes(3)
    expect(calls.some(([, o]) => o['event'] === 'billing.probe_transient_failed')).toBe(true)
  }, 30_000)

  it('every event emitted in a probe run carries the same bootId', async () => {
    const list = vi.fn().mockResolvedValue(listOk(allFiveFixtures()))
    const { logger, calls } = makeLogger()
    await probeStripeContract(makeStripe(list), logger)
    const ids = new Set(
      calls
        .map(([, o]) => o['bootId'])
        .filter((v): v is string => typeof v === 'string'),
    )
    expect(ids.size).toBe(1)
  })
})
```

- [ ] **Step 2: Run — expect FAIL (module doesn't exist)**

```bash
cd backend && pnpm exec vitest run --no-coverage src/billing/__tests__/probe.test.ts
```

Expected: `Cannot find module '../probe.js'`.

- [ ] **Step 3: Create `backend/src/billing/probe.ts`**

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

  const result = await fetchPricesWithRetry(stripe, lookupKeys, logger, bootId)

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
    if ((counts.get(spec.lookupKey) ?? 0) > 1) continue

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

    if (typeof price.unit_amount !== 'number' || price.unit_amount <= 0) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has unit_amount '${String(price.unit_amount)}' in Stripe; contract expects > 0`,
      )
    }

    if (price.billing_scheme !== 'per_unit') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has billing_scheme '${price.billing_scheme}' in Stripe; contract expects 'per_unit'`,
      )
    }

    if (price.transform_quantity !== null) {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has non-null transform_quantity in Stripe; contract requires null (no quantity transformation)`,
      )
    }

    if (price.tax_behavior && price.tax_behavior !== 'unspecified') {
      mismatches.push(
        `lookup_key '${spec.lookupKey}' has tax_behavior '${price.tax_behavior}' in Stripe; contract expects 'unspecified' (no tax handling at launch)`,
      )
    }

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
          expand: ['data.product'],
          limit: Math.min(lookupKeys.length * 10, 100),
        },
        { timeout: PROBE_TIMEOUT_MS },
      )
    } catch (err) {
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

- [ ] **Step 4: Run — expect PASS**

```bash
cd backend && pnpm exec vitest run --no-coverage src/billing/__tests__/probe.test.ts
```

Expected: ~19 tests, all green. The transient-retry tests take up to ~7s each because the backoff is real (1s+2s+4s); set Vitest test-level timeouts at 30_000 (already in the test file).

- [ ] **Step 5: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/src/billing/probe.ts backend/src/billing/__tests__/probe.test.ts
git commit -m "feat(myt-41): probe.ts — boot-time Stripe contract verification"
```

---

## Task 6: Wire the probe into the boot gate

**Files:**
- Modify: `backend/src/server.ts`

The probe runs after the wait-for-services block and before `app.listen`, with `pino` taken from a logger we construct ad hoc (server.ts uses `console.log` today; switching it wholesale to pino is out of scope — wrap a minimal pino-shaped logger and pass it).

- [ ] **Step 1: Read the current `server.ts` boot gate**

The boot gate is `main()` at line 85; the relevant section is between the `waitFor('Redis (batch)')` call and `buildApp(...)`.

- [ ] **Step 2: Add the probe call**

Patch `backend/src/server.ts` — add the import:

```typescript
import { getStripeClient } from './billing/stripe-client.js'
import { probeStripeContract } from './billing/probe.js'
```

After the `console.log('✓ Redis (batch) ready')` line (around line 132) and before `const repo = createRepo(pgRef)`, insert:

```typescript
    // MYT-41: Stripe contract verification. The probe lists the lookup_keys
    // in LOOKUP_KEYS, asserts each resolves to an active price with the
    // expected shape, and throws a typed error on mismatch / auth failure /
    // exhausted transient retries. server.ts's outer try/catch turns the
    // throw into a non-zero process exit; ECS rolls back the deploy.
    const stripeClient = getStripeClient(env)
    const probeLogger = console as unknown as import('pino').Logger
    await probeStripeContract(stripeClient, probeLogger)
    console.log('✓ Stripe contract verified')
```

(`console as unknown as Logger` is intentional — `pino`'s structured logging isn't wired into server.ts boot output yet, and the probe's `info`/`warn`/`error` methods all line up with `console`'s. The ECS task's stdout flows into CloudWatch Logs as plain JSON-shaped lines, which is what we want.)

- [ ] **Step 3: Verify typecheck**

```bash
cd backend && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Run the existing server-related tests**

```bash
cd backend && pnpm exec vitest run --no-coverage src/__tests__/app.test.ts src/__tests__/health-ready.test.ts
```

Expected: all green. These tests use `buildApp` not `main()`, so they don't exercise the probe — but they should still pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/src/server.ts
git commit -m "feat(myt-41): wire Stripe contract probe into boot gate"
```

---

## Task 7: Migration 006 — drop legacy billing-config tables

**Files:**
- Create: `backend/migrations/006_drop_billing_config_tables.sql`
- Modify: `backend/src/db/__tests__/migrate-schema.test.ts`
- Modify: `backend/src/repo/__tests__/_helpers/reset-data.ts`

- [ ] **Step 1: Create the migration**

Create `backend/migrations/006_drop_billing_config_tables.sql`:

```sql
-- Migration 006 — drop legacy billing-config tables and their dependents.
--
-- MYT-41 moves the tier and pack credit-allocation contract into a
-- checked-in TS file (backend/src/billing/lookup-keys.ts). Stripe stays
-- the source of truth for prices; lookup_key is the indirection that
-- lets backend code reference SKUs without coupling to Stripe Price IDs.
--
-- Drop order matters because migration 001 created the FK
--   user_subscriptions.tier_id -> subscription_tiers(id) (ON DELETE NO ACTION)
-- A naive `DROP TABLE subscription_tiers` would fail with SQLSTATE 2BP01
-- ("cannot drop table because other objects depend on it"), aborting
-- migration 006 inside the runner's transaction wrapper.
--
-- `purchases` has no FK into the config tables but is still dropped here
-- because MYT-42 recreates it with a new shape (lookup_key TEXT instead
-- of session_pack_size INTEGER).
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

-- Post-drop assertion. current_schema() (not hard-coded 'public') keeps
-- the wiki schema extractor happy per the migration 005 fix.
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

- [ ] **Step 2: Update the schema-parity test enumerations**

In `backend/src/db/__tests__/migrate-schema.test.ts`:

(a) Drop `'subscription_tiers'`, `'session_packs'`, `'user_subscriptions'`, `'purchases'` from `EXPECTED_TABLES`.

(b) Drop `'idx_user_subscriptions_user'` and `'idx_purchases_user'` from `EXPECTED_IDX_NAMES`.

(c) Drop the rows from `EXPECTED_CHECK_CONSTRAINTS` that reference `purchases.status` or `user_subscriptions.status`. (Use the `table_name` field on each row to identify them.)

(d) Drop the rows from `EXPECTED_FK_DELETE_RULES` where `table_name` is `'user_subscriptions'` or `'purchases'`. There are three: `user_subscriptions.tier_id`, `user_subscriptions.user_id`, `purchases.user_id`.

(e) In the `applies all migrations` test, append `'006_drop_billing_config_tables.sql'` to the expected migrations list.

(f) Add a positive assertion after the existing migration-005 user-column assertions:

```typescript
    // Migration 006: legacy billing-config tables are gone.
    const droppedTables = ['subscription_tiers', 'session_packs', 'user_subscriptions', 'purchases']
    const tableExists = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [droppedTables],
    )
    expect(tableExists.rows).toEqual([])
```

- [ ] **Step 3: Update the reset-data helper**

In `backend/src/repo/__tests__/_helpers/reset-data.ts`, the `TABLES` array currently includes `'subscription_tiers'`, `'session_packs'`, `'user_subscriptions'`, `'purchases'`. Remove all four. (After this migration, `TRUNCATE` on a non-existent table errors with `42P01`.)

- [ ] **Step 4: Run the migrate-schema test**

```bash
cd backend && pnpm exec vitest run --no-coverage src/db/__tests__/migrate-schema.test.ts
```

Expected: green. The test runs all migrations including 006, asserts the four tables are gone.

- [ ] **Step 5: Run the broader test suite to catch breaks from reset-data**

```bash
cd backend && pnpm exec vitest run --no-coverage src/repo/__tests__/users.test.ts src/repo/__tests__/credits.test.ts
```

Expected: green. These integration tests use `resetData`; if any test was relying on one of the dropped tables existing, it would surface here.

- [ ] **Step 6: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/migrations/006_drop_billing_config_tables.sql backend/src/db/__tests__/migrate-schema.test.ts backend/src/repo/__tests__/_helpers/reset-data.ts
git commit -m "feat(myt-41): migration 006 — drop legacy billing-config tables"
```

---

## Task 8: ESLint rule `no-stripe-price-mutations`

**Files:**
- Create: `backend/eslint-rules/no-stripe-price-mutations.cjs`
- Create: `backend/eslint-rules/__tests__/no-stripe-price-mutations.test.cjs`

- [ ] **Step 1: Write the failing RuleTester test**

Create `backend/eslint-rules/__tests__/no-stripe-price-mutations.test.cjs`:

```javascript
const { RuleTester } = require('eslint')
const rule = require('../no-stripe-price-mutations.cjs')

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
})

tester.run('no-stripe-price-mutations', rule, {
  valid: [
    'stripe.prices.list({})',
    'stripe.prices.retrieve("price_x")',
    'stripe.products.retrieve("prod_x")',
    'stripe.subscriptions.update(id, { cancel_at_period_end: true })',
    'stripe.subscriptions.update(id, { metadata: {} })',
    'stripe.subscriptions.update(id, { pause_collection: {} })',
    'stripe.subscriptions.cancel(id)',
    'stripe.checkout.sessions.create({})',
    'stripe.billingPortal.sessions.create({})',
    'stripe.webhooks.constructEvent(body, sig, secret)',
    'stripe.customers.create({})',
    'stripe.customers.retrieve("cus_x")',
    'stripe.customers.update("cus_x", {})',
  ],
  invalid: [
    { code: 'stripe.prices.create({})',                       errors: [{ messageId: 'banned' }] },
    { code: 'stripe.prices.update("price_x", {})',            errors: [{ messageId: 'banned' }] },
    { code: 'stripe.prices.update("price_x", { active: false })', errors: [{ messageId: 'banned' }] },
    { code: 'stripe.products.create({})',                     errors: [{ messageId: 'banned' }] },
    { code: 'stripe.products.update("prod_x", {})',           errors: [{ messageId: 'banned' }] },
    { code: 'stripe.products.del("prod_x")',                  errors: [{ messageId: 'banned' }] },
    { code: 'stripe.coupons.create({})',                      errors: [{ messageId: 'banned' }] },
    { code: 'stripe.coupons.update("coupon_x", {})',          errors: [{ messageId: 'banned' }] },
    { code: 'stripe.coupons.del("coupon_x")',                 errors: [{ messageId: 'banned' }] },
    { code: 'stripe.promotionCodes.create({})',               errors: [{ messageId: 'banned' }] },
    { code: 'stripe.promotionCodes.update("promo_x", {})',    errors: [{ messageId: 'banned' }] },
  ],
})

console.log('no-stripe-price-mutations: all RuleTester cases passed')
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && node eslint-rules/__tests__/no-stripe-price-mutations.test.cjs
```

Expected: throws `Cannot find module '../no-stripe-price-mutations.cjs'`.

- [ ] **Step 3: Create the rule**

Create `backend/eslint-rules/no-stripe-price-mutations.cjs`:

```javascript
// ESLint rule: no-stripe-price-mutations
//
// Bans Stripe SDK calls that would mutate the price/product/coupon
// catalog. Pattern-matches MemberExpression chains:
//
//   stripe.<namespace>.<method>(...)
//
// Banned namespaces + methods (rule fires on the call expression):
//   prices.create, prices.update
//   products.create, products.update, products.del
//   coupons.create, coupons.update, coupons.del
//   promotionCodes.create, promotionCodes.update
//
// Pattern-evasion paths the rule does NOT catch (documented):
//   stripe['products']['create'](...)         — bracket access
//   const c = stripe.products.create.bind(...); c(...) — alias
//   (stripe as any).products.create(...)      — type-system bypass
//
// The actual SDK-level enforcement is the restricted Stripe API key
// (no Prices: write / Products: write permission); this rule is a
// code-review tripwire on top.

const BANNED = {
  prices:         new Set(['create', 'update']),
  products:       new Set(['create', 'update', 'del']),
  coupons:        new Set(['create', 'update', 'del']),
  promotionCodes: new Set(['create', 'update']),
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban Stripe price/product/coupon mutation calls.' },
    schema: [],
    messages: {
      banned:
        "Stripe price/product/coupon mutations are forbidden — use Dashboard / CLI. The restricted API key blocks these at the network level; this rule catches them at code review.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'MemberExpression' ||
          callee.object.object.type !== 'Identifier' ||
          callee.object.object.name !== 'stripe' ||
          callee.object.property.type !== 'Identifier' ||
          callee.property.type !== 'Identifier'
        ) {
          return
        }
        const namespace = callee.object.property.name
        const method = callee.property.name
        const banned = BANNED[namespace]
        if (banned && banned.has(method)) {
          context.report({ node, messageId: 'banned' })
        }
      },
    }
  },
}
```

- [ ] **Step 4: Run the RuleTester test — expect PASS**

```bash
cd backend && node eslint-rules/__tests__/no-stripe-price-mutations.test.cjs
```

Expected: prints `no-stripe-price-mutations: all RuleTester cases passed` with no error.

- [ ] **Step 5: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/eslint-rules/no-stripe-price-mutations.cjs backend/eslint-rules/__tests__/no-stripe-price-mutations.test.cjs
git commit -m "feat(myt-41): eslint rule — no-stripe-price-mutations"
```

---

## Task 9: ESLint rule `no-stripe-subscription-price-mutation`

**Files:**
- Create: `backend/eslint-rules/no-stripe-subscription-price-mutation.cjs`
- Create: `backend/eslint-rules/__tests__/no-stripe-subscription-price-mutation.test.cjs`

This rule fires on `stripe.subscriptions.update(_, { items: [{ price: ... }] })` — closing the price-change-via-subscription-item-mutation backdoor (Lyra round-2 finding). `subscriptions.update` for `cancel_at_period_end`, `metadata`, `pause_collection`, etc. is NOT banned.

- [ ] **Step 1: Write the failing RuleTester test**

Create `backend/eslint-rules/__tests__/no-stripe-subscription-price-mutation.test.cjs`:

```javascript
const { RuleTester } = require('eslint')
const rule = require('../no-stripe-subscription-price-mutation.cjs')

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
})

tester.run('no-stripe-subscription-price-mutation', rule, {
  valid: [
    'stripe.subscriptions.update(id, { cancel_at_period_end: true })',
    'stripe.subscriptions.update(id, { metadata: {} })',
    'stripe.subscriptions.update(id, { pause_collection: {} })',
    'stripe.subscriptions.update(id, { items: [{ quantity: 2 }] })',
    'stripe.subscriptions.cancel(id)',
    'stripe.subscriptions.retrieve(id)',
    'stripe.checkout.sessions.create({ line_items: [{ price: "price_x" }] })',
  ],
  invalid: [
    {
      code: 'stripe.subscriptions.update(id, { items: [{ id: "si_x", price: "price_NEW" }] })',
      errors: [{ messageId: 'banned' }],
    },
    {
      code: 'stripe.subscriptions.update(id, { items: [{ price: someVar }] })',
      errors: [{ messageId: 'banned' }],
    },
    {
      code: 'stripe.subscriptions.update(id, { items: [{ price: lookupKeyToPrice() }] })',
      errors: [{ messageId: 'banned' }],
    },
  ],
})

console.log('no-stripe-subscription-price-mutation: all RuleTester cases passed')
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && node eslint-rules/__tests__/no-stripe-subscription-price-mutation.test.cjs
```

Expected: `Cannot find module`.

- [ ] **Step 3: Create the rule**

Create `backend/eslint-rules/no-stripe-subscription-price-mutation.cjs`:

```javascript
// ESLint rule: no-stripe-subscription-price-mutation
//
// Closes the price-change-via-subscription-item-mutation backdoor:
//   stripe.subscriptions.update(id, { items: [{ price: 'price_X' }] })
//
// The restricted API key permits Subscriptions: write (needed for
// cancel_at_period_end and admin fraud cancellation), so this is one of
// the few mutation paths still possible from the SDK. Mythrun's tier-
// switching flow goes through Customer Portal exclusively (per spec §6);
// app code does NOT initiate item-price mutations. This rule enforces.
//
// Conservative match: any `stripe.subscriptions.update` call whose first
// argument-after-id is an object with an `items` array, where any element
// is an object containing a `price` property. Quantity-only item updates
// (no `price` key) are allowed.

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban subscription item-price mutations. Tier-switching goes through Customer Portal, not app code.',
    },
    schema: [],
    messages: {
      banned:
        "stripe.subscriptions.update with items[].price is forbidden — tier-switching goes through Customer Portal exclusively (per MYT-41 spec §6). Other update fields (cancel_at_period_end, metadata, pause_collection, items[].quantity) are fine.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'MemberExpression' ||
          callee.object.object.type !== 'Identifier' ||
          callee.object.object.name !== 'stripe' ||
          callee.object.property.type !== 'Identifier' ||
          callee.object.property.name !== 'subscriptions' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'update'
        ) {
          return
        }
        // stripe.subscriptions.update(id, body) — body is arg[1]
        const body = node.arguments[1]
        if (!body || body.type !== 'ObjectExpression') return
        for (const prop of body.properties) {
          if (
            prop.type === 'Property' &&
            prop.key.type === 'Identifier' &&
            prop.key.name === 'items' &&
            prop.value.type === 'ArrayExpression'
          ) {
            for (const elem of prop.value.elements) {
              if (!elem || elem.type !== 'ObjectExpression') continue
              for (const itemProp of elem.properties) {
                if (
                  itemProp.type === 'Property' &&
                  itemProp.key.type === 'Identifier' &&
                  itemProp.key.name === 'price'
                ) {
                  context.report({ node, messageId: 'banned' })
                  return
                }
              }
            }
          }
        }
      },
    }
  },
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd backend && node eslint-rules/__tests__/no-stripe-subscription-price-mutation.test.cjs
```

Expected: prints success.

- [ ] **Step 5: Commit**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun
git add backend/eslint-rules/no-stripe-subscription-price-mutation.cjs backend/eslint-rules/__tests__/no-stripe-subscription-price-mutation.test.cjs
git commit -m "feat(myt-41): eslint rule — no-stripe-subscription-price-mutation"
```

---

## Task 10: Wire both ESLint rules into `eslint.config.js`

**Files:**
- Modify: `eslint.config.js` (repo root)

- [ ] **Step 1: Update eslint.config.js**

Open `/Users/miklos/Desktop/Files/Mythrun/Code/mythrun/eslint.config.js` and add the rule imports + plugin definition.

Current shape:

```javascript
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: [...] },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  { /* rules */ },
  eslintConfigPrettier,
)
```

Replace with:

```javascript
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const noStripePriceMutations = require('./backend/eslint-rules/no-stripe-price-mutations.cjs')
const noStripeSubscriptionPriceMutation = require('./backend/eslint-rules/no-stripe-subscription-price-mutation.cjs')

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'docs/wiki/site/**',
      'docs/superpowers/**',
      'docs/specs/**',
      '.beads/**',
      '**/*.config.js',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: {
      mythrun: {
        rules: {
          'no-stripe-price-mutations': noStripePriceMutations,
          'no-stripe-subscription-price-mutation': noStripeSubscriptionPriceMutation,
        },
      },
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Default exports are forbidden. Use named exports only.',
        },
      ],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'mythrun/no-stripe-price-mutations': 'error',
      'mythrun/no-stripe-subscription-price-mutation': 'error',
    },
  },
  eslintConfigPrettier,
)
```

- [ ] **Step 2: Run lint to confirm the project still lints clean**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && pnpm lint
```

Expected: clean. No code paths use the banned patterns yet.

- [ ] **Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "feat(myt-41): wire mythrun ESLint plugin (price-mutation + subscription-price-mutation rules)"
```

---

## Task 11: ESLint config-wiring smoke test

**Files:**
- Create: `backend/eslint-rules/__tests__/fixtures/banned.fixture.ts`
- Create: `backend/eslint-rules/__tests__/config-wiring.test.cjs`

This catches "rule shipped but not registered in `eslint.config.js`" — the `RuleTester` tests don't exercise the project's flat config.

- [ ] **Step 1: Create the banned-pattern fixture**

Create `backend/eslint-rules/__tests__/fixtures/banned.fixture.ts`:

```typescript
// This file deliberately contains a banned pattern to exercise the
// no-stripe-price-mutations rule via the project's eslint.config.js.
// If lint passes on this file, the rule is shipped but not registered.

declare const stripe: { prices: { create: (input: object) => unknown } }
stripe.prices.create({})
```

- [ ] **Step 2: Update the eslint ignores so this fixture is normally excluded**

The fixture would otherwise fail every `pnpm lint` invocation. Add `'backend/eslint-rules/__tests__/fixtures/**'` to the `ignores` block in `eslint.config.js`.

Diff:

```javascript
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'docs/wiki/site/**',
      'docs/superpowers/**',
      'docs/specs/**',
      '.beads/**',
      '**/*.config.js',
      'backend/eslint-rules/__tests__/fixtures/**',
    ],
```

- [ ] **Step 3: Create the config-wiring smoke test**

Create `backend/eslint-rules/__tests__/config-wiring.test.cjs`:

```javascript
// Smoke test: confirms the no-stripe-price-mutations rule is wired into
// the project's eslint.config.js. Spawns a child eslint process pointed
// at a banned-pattern fixture; expects non-zero exit.
//
// The fixture file is normally excluded from `pnpm lint` via the
// ignores block in eslint.config.js, so this child invocation is the
// only thing that ever lints it. We pass --no-ignore here so the
// fixture is actually linted by this child process despite the project
// ignore.
//
// Why not RuleTester: RuleTester exercises the rule logic directly,
// not the project wiring. A flat-config refactor that drops the rule
// registration would silently pass all RuleTester tests.

const { describe, it, expect } = require('vitest')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

describe('eslint config wiring (smoke)', () => {
  it('banned fixture fails project lint', () => {
    const repoRoot = resolve(__dirname, '../../../..')
    const fixture = resolve(repoRoot, 'backend/eslint-rules/__tests__/fixtures/banned.fixture.ts')
    const result = spawnSync(
      'pnpm',
      ['exec', 'eslint', '--no-ignore', fixture],
      { cwd: repoRoot, encoding: 'utf-8' },
    )
    expect(result.status).not.toBe(0)
    const combined = (result.stdout ?? '') + (result.stderr ?? '')
    expect(combined).toMatch(/no-stripe-price-mutations/)
  }, 30_000)
})
```

- [ ] **Step 4: Run the smoke test**

```bash
cd backend && pnpm exec vitest run --no-coverage eslint-rules/__tests__/config-wiring.test.cjs
```

Expected: green (eslint exits non-zero against the fixture; the test asserts that).

- [ ] **Step 5: Verify project lint is still clean**

```bash
cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && pnpm lint
```

Expected: clean. The fixture is in the ignores block.

- [ ] **Step 6: Commit**

```bash
git add backend/eslint-rules/__tests__/fixtures/banned.fixture.ts backend/eslint-rules/__tests__/config-wiring.test.cjs eslint.config.js
git commit -m "feat(myt-41): eslint config-wiring smoke test"
```

---

## Task 12: Webhook route-absence test

**Files:**
- Create: `backend/src/__tests__/webhook-absence.test.ts`

Per spec §5a: while `STRIPE_WEBHOOK_SECRET = 'PLACEHOLDER'`, no `/webhooks/stripe` route exists. The fail-closed-on-PLACEHOLDER security argument depends on the route being absent until MYT-42 lands the verifying handler. MYT-42 deletes this test as part of landing the handler.

- [ ] **Step 1: Write the test**

Create `backend/src/__tests__/webhook-absence.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { buildApp } from '../app.js'
import { makeStubDeps } from './helpers/stub-deps.js'

// Per MYT-41 spec §5a: STRIPE_WEBHOOK_SECRET = 'PLACEHOLDER' is fail-closed
// only because no code path consumes it. The /webhooks/stripe route MUST
// NOT exist until MYT-42 lands the verifying handler. This test fails
// loudly if any future PR registers the route prematurely (e.g., a
// logging stub, a smoke handler, a permissive catch-all that shadows
// /webhooks/stripe).
//
// MYT-42 deletes this test as part of landing the real handler.

describe('webhook route absence (MYT-41 → MYT-42 invariant)', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('COGNITO_USER_POOL_ID', '')
    vi.stubEnv('COGNITO_APP_CLIENT_ID', '')
    vi.stubEnv('COGNITO_ISSUER_URL', '')
    vi.stubEnv('COGNITO_HOSTED_UI_DOMAIN', '')
    globalThis.fetch = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    vi.unstubAllEnvs()
  })

  it('POST /webhooks/stripe returns 404 (no route registered, no catch-all swallows it)', async () => {
    app = await buildApp(makeStubDeps(), { mode: 'bypass' }, { frontendBaseUrl: 'http://localhost:5173' })
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run — expect PASS**

```bash
cd backend && pnpm exec vitest run --no-coverage src/__tests__/webhook-absence.test.ts
```

Expected: green. No route exists; Fastify's setNotFoundHandler returns 404.

- [ ] **Step 3: Commit**

```bash
git add backend/src/__tests__/webhook-absence.test.ts
git commit -m "test(myt-41): webhook route absence invariant for MYT-41 → MYT-42 window"
```

---

## Task 13: Spec patches — parent billing spec

**Files:**
- Modify: `docs/specs/2026-04-13-billing-cost-controls.md`

Apply each patch listed under spec §"Spec patches" → `docs/specs/2026-04-13-billing-cost-controls.md` for each of §3, §4, §5, §6, §7, §9, §10. Cited line numbers are approximate; patch by section heading + content match.

- [ ] **Step 1: §3 — Subscription Tiers**

In `docs/specs/2026-04-13-billing-cost-controls.md` §3:

1. Replace the `Adventurer` / `Champion` table with this:

```markdown
| Tier ID | Name | Sessions/mo | World Gens/mo | Target Price |
|---------|------|-------------|---------------|-------------|
| `tier_wayfarer` | Wayfarer | 4 | 1 | $X/mo |
| `tier_sojourner` | Sojourner | 8 | 2 | $Y/mo |
| `tier_mythwright` | Mythwright | 16 | 4 | $Z/mo |
```

2. Replace the `subscription_tiers` CREATE TABLE block with: *"Subscription tier metadata lives in `backend/src/billing/lookup-keys.ts`. Stripe Prices map to tiers by `lookup_key`; the DB does not cache tier metadata."*

3. Update the `user_subscriptions` CREATE TABLE block — change `tier_id TEXT NOT NULL REFERENCES subscription_tiers(id)` to `tier_lookup_key TEXT NOT NULL` (no FK; lookup-keys contract enforces the closed enum at write-time via MYT-42's webhook handler). Add a note: *"MYT-42 ships migration 007 with this new shape."*

4. Drop the §3 "Subscription Lifecycle" references to `subscription_tiers`. Replace with: *"tier metadata read from lookup-keys.ts contract."*

5. Replace the rollover-as-config language with: *"No rollover at launch. Tier credits are granted with `expires_at = current_period_end`. Mid-period cancellation does not retroactively expire that period's credits — the user paid for the period, gets to use it through `current_period_end`."*

- [ ] **Step 2: §4 — Session Packs (rename to À-la-carte SKUs)**

1. Rename the section heading from "Session Packs (One-Time Purchases)" to "À-la-carte SKUs".

2. Replace the `pack_5` / `pack_12` table with:

```markdown
| SKU ID | Display Name | Sessions | World Gens | Target Price |
|---|---|---|---|---|
| `sku_session` | Session | 1 | 0 | $X |
| `sku_world` | World | 1 | 1 | $Y |
```

3. Replace the `session_packs` CREATE TABLE block with: *"Pack metadata lives in `backend/src/billing/lookup-keys.ts`. Stripe Prices map to SKUs by `lookup_key`."*

4. Replace the `purchases` CREATE TABLE block with the same pattern: drop the `session_pack_size INTEGER` column reference, store `lookup_key TEXT NOT NULL` instead. Note MYT-42 migration 007.

5. Update the purchase flow §4 step 3: `metadata: { packId, userId }` becomes `metadata: { userId }`; the per-line-item `lookup_key` walk replaces the single packId field (cross-reference MYT-41 spec §"Webhook credit-grant contract for MYT-42").

- [ ] **Step 3: §5 — Stripe Integration**

1. Update §5.1 (Products and Prices): drop the table that lists Stripe Price IDs; reference the lookup-keys contract.

2. §5.4 (Customer Portal) — replace the entire feature list with these four (Stripe's exact Dashboard labels):
   - **Cancel subscription** (Cancel at end of billing period)
   - **Switch plan** (allowlist: Wayfarer, Sojourner, Mythwright)
   - **Payment methods** (update; card only at launch)
   - **Invoice history** (visible)

   Disabled at launch: Promotion codes, Retention coupons, Tax ID, Phone, Shipping address, Update quantities, Cancellation reason (optional, off at launch).

3. §5.5 (Price Manipulation Prevention) — replace with: *"Pricing is immutable from application code. Defense in depth, in order of strength: (1) Stripe restricted API key with no `Prices: write` or `Products: write` — Stripe's API rejects mutation attempts at the network level. (2) Code references prices by `lookup_key` only; no hardcoded Stripe Price IDs. (3) ESLint rules `no-stripe-price-mutations` and `no-stripe-subscription-price-mutation` ban price/product/coupon catalog mutations and subscription item-price mutations — code-review tripwires, not runtime boundaries. The amount-validation in the webhook handler is the per-charge correctness check; the boot probe is the catalog-shape correctness check."*

- [ ] **Step 4: §6 — Token Budget (vocabulary cleanup)**

Replace the §6 sentence about subscription-credits-vs-pack-credits with: *"the budget is defined per credit type (session credits from tier subscriptions may have a different budget than session credits from à-la-carte SKUs — for launch, identical)."*

- [ ] **Step 5: §7 — Free Trial**

1. Replace the §7 implementation-steps prose with: *"Trial credit is granted at registration, not at session-start. On `POST /api/users/register`, the same transaction that creates the `users` row inserts a `credit_ledger` row (`credit_type='session', amount=1, source_type='trial', source_id=NULL, expires_at=NULL`) and sets `users.free_trial_used = true`. Sessions consume the trial credit via the standard atomic-debit recipe (§2). No special trial-mode session machinery; the time-cap and demo-world choices in §7 are session-runtime concerns owned by MYT-43, decoupled from credit-grant timing."*

2. Drop the line that references `session_usage.source_type = 'trial'` (the column doesn't exist).

- [ ] **Step 6: §10 — Edge Cases**

Replace the line "Debit consumes the earliest-expiring credits first…" with: *"Debit ordering is implementation-defined; MYT-43 picks the consumption-priority strategy."*

- [ ] **Step 7: §9 — API Routes**

1. Replace the two route entries `GET /api/billing/tiers` and `GET /api/billing/packs` with a single entry: `GET /api/billing/skus` returning a list keyed by `lookup_key`. Caching/TTL/fallback rules per MYT-41 spec §4.

2. Update the balance-response example: replace `"tier": "adventurer"` with `"tier": { "lookup_key": "tier_wayfarer", "displayName": "Wayfarer", "renewsAt": "..." }`. Rename `session_credits` → `session` and `world_gen_credits` → `world_gen`. Final shape: `{ balance: { session: 7, world_gen: 2 }, tier: { lookup_key, displayName, renewsAt } | null, ... }`.

3. Update the checkout body shape: replace `{ type: 'subscription', tierId }` / `{ type: 'pack', packId }` with `{ items: [{ lookup_key, quantity }] }`. The Checkout `mode` is server-derived from the items' types per the cart-shapes table.

4. Replace the `ALTER TABLE users ADD COLUMN stripe_customer_id` block with: *"`users.stripe_customer_id` is part of the initial schema (migration 001). Populated lazily on first checkout via `customers.create` in MYT-42."*

- [ ] **Step 8: Commit**

```bash
git add docs/specs/2026-04-13-billing-cost-controls.md
git commit -m "docs(myt-41): patch parent billing spec (§3 + §4 + §5 + §6 + §7 + §9 + §10)"
```

---

## Task 14: Spec patches — backend-core, arch-overview, ux-design

**Files:**
- Modify: `docs/specs/2026-04-13-backend-core.md`
- Modify: `docs/specs/2026-04-06-production-architecture-overview.md`
- Modify: `docs/specs/2026-04-10-ux-design.md`

- [ ] **Step 1: backend-core schema-block + repo-namespace cleanup**

In `docs/specs/2026-04-13-backend-core.md`:

1. Replace the `subscription_tiers` CREATE TABLE block with: *"Subscription tier metadata is in `backend/src/billing/lookup-keys.ts`; Stripe is the source of truth for prices."*

2. Replace the `session_packs` CREATE TABLE block with: *"À-la-carte SKU metadata is in `backend/src/billing/lookup-keys.ts`."*

3. Update the `user_subscriptions` CREATE TABLE block — change `tier_id TEXT NOT NULL REFERENCES subscription_tiers(id)` to `tier_lookup_key TEXT NOT NULL`. Note MYT-42 migration 007.

4. Update the `purchases` CREATE TABLE block — drop `session_pack_size INTEGER`, store `lookup_key TEXT NOT NULL` instead.

5. In the `repo.*` namespace listings (~lines 800–810): remove `repo.subscriptionTiers` and `repo.sessionPacks` entirely. Update the `repo-deferred` table to drop `subscriptionTiers` and `sessionPacks` from the deferral list. `purchases` and `userSubscriptions` stay deferred to MYT-42 (re-shaped).

- [ ] **Step 2: arch-overview orphan-reference cleanup**

In `docs/specs/2026-04-06-production-architecture-overview.md`:

1. Update line ~768's `pack_5` reference to `sku_session` / `sku_world`.

2. Replace line ~771's "Session pack sizes and pricing are configurable (e.g., 5 sessions for $20, 12 sessions for $40)" with: *"À-la-carte SKUs are configurable in Stripe Dashboard, referenced from code by lookup_key per `backend/src/billing/lookup-keys.ts`. No fixed-size packs; sessions and worlds are sold one-at-a-time."*

3. Update the `purchases` CREATE TABLE block at ~line 380 — drop `session_pack_size INTEGER NOT NULL`, point to backend-core's canonical schema.

4. Sweep lines ~551, ~575–577, ~749, ~769 for `users.session_credits` and `free_trial_used = false` references. Replace each with: *"balance check is `SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id=$1 AND credit_type='session' AND (expires_at IS NULL OR expires_at > now())`; trial credits are part of that balance, not a separate gate."*

5. Drop `session_credits` from the ER-diagram-style line at ~line 515 (`User ──has──> session_credits, purchases` → `User ──has──> purchases`).

- [ ] **Step 3: ux-design orphan-reference cleanup**

In `docs/specs/2026-04-10-ux-design.md`:

1. Update line 490's `Adventurer` / `Champion` mentions to `Wayfarer` / `Sojourner` / `Mythwright`.

2. Replace the session-pack copy (~lines 487–499) wholesale with copy describing (a) the three subscription tiers, (b) `sku_session` and `sku_world` as one-at-a-time SKUs, (c) no "best value" labels.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-04-13-backend-core.md docs/specs/2026-04-06-production-architecture-overview.md docs/specs/2026-04-10-ux-design.md
git commit -m "docs(myt-41): patch backend-core + arch-overview + ux-design (orphan-reference cleanup)"
```

---

## Task 15: Sync `tmp/myt-41-stripe-dashboard-instructions.md` with the spec

**Files:**
- Modify: `tmp/myt-41-stripe-dashboard-instructions.md`

The runbook was written before round-3 spec additions (`product.active`, `transform_quantity`, `tax_behavior`, the full `recurring.interval_count` + `usage_type` + `billing_scheme` checks). It also doesn't cover the `additionalProperties: false` body-schema requirement, the `customers.create` idempotency-key contract, and the rk_ prefix expectation in env. Update it now so the operator's checklist matches what the boot probe actually verifies.

- [ ] **Step 1: Read the current runbook and update**

Open `tmp/myt-41-stripe-dashboard-instructions.md`. Apply these changes:

(a) **Step 0 (Restricted-key creation):** verify the permission table matches the spec:

| Resource | Permission |
|---|---|
| Prices | Read |
| Products | Read |
| Customers | Write |
| Checkout Sessions | Write |
| Billing Portal Sessions | Write |
| Subscriptions | Write |
| Webhook Endpoints (signing secrets) | Read |
| Events | Read |
| Charges | Read |
| Refunds | None |
| Coupons | None |
| Promotion Codes | None |
| All other resources | None |

(b) **Step 1 (Create products + prices via CLI):** for each `stripe prices create` invocation, ensure the command does NOT include `--tiers`, `--billing-scheme=tiered`, `--transform-quantity`, `--tax-behavior=inclusive|exclusive`, or `--recurring='interval_count=3'`. The defaults are correct (`per_unit`, no transform, `unspecified` tax_behavior, `interval_count=1`). Add a "do NOT" warning section listing these flags.

(c) **Step 2 (Verify in Dashboard):** add to the per-product checklist:
- [ ] Product status is **Active** (not Archived). If you accidentally archived a product, recreate it or unarchive it; the boot probe verifies `product.active === true`.
- [ ] For tier products: billing interval is "Monthly" (`interval=month`, `interval_count=1`). Annual or quarterly would silently break credit grants.
- [ ] For tier products: usage type is "Licensed" (flat per-period fee), not "Metered" (usage-based).
- [ ] Currency is USD (verified by the probe).

(d) **Step 3 (Customer Portal config):** confirm the runbook lists exactly the four enabled features (Cancel subscription, Switch plan, Payment methods, Invoice history) and explicitly disables Promotion codes, Retention coupons, Tax ID, Phone, Shipping address, Update quantities, Cancellation reason.

(e) **NEW Step (Do NOT yet — preconditions for MYT-42):**
- Do NOT create the Stripe Dashboard webhook endpoint during MYT-41. That step belongs to MYT-42 (otherwise Stripe queues real events into 404s during the MYT-41 → MYT-42 window).
- Do NOT update `STRIPE_WEBHOOK_SECRET` in Secrets Manager. Leave it at `PLACEHOLDER`. MYT-42 rotates it.
- Do NOT call any Stripe API method from any local CLI script that mutates prices. Use the CLI only for `stripe products create` / `stripe prices create` / `stripe products list` / `stripe prices list` (read or one-time-create only).

(f) **Step 5 (Hand back to me):** add a verification step before final hand-off:

```bash
stripe prices list --lookup-keys=tier_wayfarer,tier_sojourner,tier_mythwright,sku_session,sku_world | jq '.data | length'
```

Expected output: `5`. If less than 5, the boot probe will fail on a missing lookup_key.

(g) Add a footer noting: *"This runbook applies to TEST mode. The same procedure runs against the LIVE-mode Stripe account at production-launch readiness, with real prices set by cost modeling. The lookup-keys contract is unaffected by price changes."*

- [ ] **Step 2: Commit (the file is gitignored — no `git add` needed)**

The runbook is in `tmp/`, gitignored. After the edits, the file is on the operator's machine ready for execution. No commit step.

Note this in the bead's progress note instead.

---

## Task 16: File Linear precondition + bead cleanup

**Files:** none — Linear + Beads CLI work.

- [ ] **Step 1: Create `myth-billing-probe-alarm` bead (hard-blocking precondition for production-launch readiness)**

```bash
bd create \
  --title="CloudWatch alarm on Stripe boot-probe failures" \
  --description="Hard-blocking precondition for production-launch readiness per MYT-41 spec. Add CloudWatch metric filters + alarms on \`billing.probe_failed\`, \`billing.probe_auth_failed\`, \`billing.probe_transient_failed\`, paged to the same destination as other prod alarms. Owner: Miklos. Mythrun does not promote to production-launch until this alarm is live." \
  --type=task --priority=1
```

(P1 = High; this is launch-blocking but not a critical runtime issue today.)

- [ ] **Step 2: Re-scope `myth-u7k`**

```bash
bd show myth-u7k
```

Edit the bead via `bd update` (the bead exists pre-MYT-41 and references namespaces being dropped):
- Remove `subscriptionTiers` and `sessionPacks` from its scope.
- `purchases` and `userSubscriptions` stay deferred to MYT-42 (re-shaped, not removed).

```bash
bd update myth-u7k --notes "MYT-41 close: removed subscriptionTiers and sessionPacks from scope (tables dropped by migration 006; lookup-keys.ts is the contract). purchases and userSubscriptions stay deferred to MYT-42 with the new lookup_key shape."
```

- [ ] **Step 3: Verify no other bead references the dropped namespaces**

```bash
bd list --label=repo-deferred
```

If any bead still mentions `subscriptionTiers` or `sessionPacks`, edit or close it.

---

## Task 17: Final verification + hand-off

**Files:** none — runs the full local check suite and ends with the hand-off checklist.

- [ ] **Step 1: Run the full backend test suite**

```bash
cd backend && pnpm typecheck && pnpm lint && pnpm test 2>&1 | tail -30
```

Expected:
- typecheck clean.
- lint clean (warnings on `max-lines-per-function` for existing repo files are expected per MYT-38 close).
- tests pass. The probe tests take up to ~15s due to backoff retries; total backend test suite around 5-10 minutes.

- [ ] **Step 2: Confirm migrations**

```bash
ls backend/migrations/
```

Expected: `001_initial_schema.sql`, `002_indexes.sql`, `003_srd_reference_data.sql`, `004_credit_ledger_invariants.sql`, `005_drop_profile_columns_users.sql`, `006_drop_billing_config_tables.sql`.

- [ ] **Step 3: Confirm review trail**

```bash
git log --oneline -25
```

Verify that the commits map to tasks 1-14 (15 is a runbook update; 16 is bead work).

- [ ] **Step 4: Hand-off to Miklos**

The plan does NOT push or flip Linear. The hand-off sequence per spec §"Operational notes":

1. **Miklos executes `tmp/myt-41-stripe-dashboard-instructions.md` (NOW UPDATED)** — restricted-key creation, rotate Secrets Manager, create 5 products + prices, configure Customer Portal, verify in Stripe Dashboard. **This must complete BEFORE the code lands** (the boot probe fails if Stripe isn't provisioned yet).
2. **Code lands** — push the commits from this plan to `main`. CI runs (typecheck + lint + tests).
3. **Wiki update** — dispatch the AUTHORING.md wiki-update subagent (per CLAUDE.md "wiki is not optional"). The subagent updates `docs/wiki/diagrams/data/schema.dot`, `docs/wiki/content/data/schema.html`, `docs/wiki/build/schemaTypes.ts`; refreshes source-hashes via `pnpm wiki:accept-drift`. Wiki commit is in the same push as code.
4. **Final push** — code + wiki together.
5. **Verify on staging** — ECS rolling deploy picks up the new image; boot probe runs against the now-provisioned Stripe state and emits `billing.probe_passed` in CloudWatch logs.
6. **Linear flip MYT-41 → Done** via `mcp__linear-server__save_issue`.

- [ ] **Step 5: Final commit (only if anything is left to commit)**

```bash
git status
```

Should be clean (everything committed task-by-task).

---

## Self-review checklist

**Spec coverage cross-check:**

| Spec section | Plan task | ✓ |
|---|---|---|
| §"The product / pricing model" — 5-entry contract | T3 | ✓ |
| §"Cart shapes and Checkout `mode`" — MYT-42 contract documentation | spec patches T13 §9 | ✓ |
| §"Webhook credit-grant contract for MYT-42" — MYT-42 contract documentation | spec patches T13 §4 + §5 | ✓ |
| §"Per-event-type resolution rules" — MYT-42 contract documentation | spec patches T13 §5 | ✓ |
| §"Stripe price-shape verification (boot probe scope)" — code | T5 | ✓ |
| §"Replacing parent spec §5.5's `amount_total` validation" — MYT-42 contract documentation | spec patches T13 §5 | ✓ |
| §1 — Stripe Dashboard owns prices, restricted API key | T2 (env validator) + T15 (runbook step 0) | ✓ |
| §2 — `lookup-keys.ts` is the contract | T3 | ✓ |
| §3 — Boot-time probe | T5 + T6 (wire into boot gate) | ✓ |
| §4 — Per-request resolver (MYT-42 contract) | spec patches T13 §9 | ✓ |
| §5 — Trial is account-state | spec patches T13 §7 | ✓ |
| §5a — Webhook PLACEHOLDER fail-closed sentinel | T2 (env validator) + T12 (route absence test) | ✓ |
| §6 — ESLint rule scope | T8 + T9 + T10 + T11 | ✓ |
| §7 — Per-environment Stripe accounts; restricted keys; rotation | T2 (rk_ prefix) + T15 (runbook) | ✓ |
| §8 — MYT-42 endpoint authn shape | spec patches T13 §9 + cross-refs | ✓ |
| `lookup-keys.ts` | T3 | ✓ |
| `env.ts` patch | T2 | ✓ |
| `stripe-client.ts` | T4 | ✓ |
| `probe.ts` | T5 | ✓ |
| Migration 006 | T7 | ✓ |
| ESLint rule `no-stripe-price-mutations` | T8 | ✓ |
| ESLint rule `no-stripe-subscription-price-mutation` | T9 | ✓ |
| Subscription rule wiring + config-wiring smoke test | T10 + T11 | ✓ |
| Webhook route-absence test | T12 | ✓ |
| Schema parity test update | T7 | ✓ |
| reset-data.ts test helper update | T7 | ✓ |
| Parent billing spec patches §3 + §4 + §5 + §6 + §7 + §9 + §10 | T13 | ✓ |
| Backend-core spec patches | T14 | ✓ |
| Arch-overview + ux-design orphan refs | T14 | ✓ |
| Bead `myth-u7k` re-scope | T16 | ✓ |
| Bead `myth-billing-probe-alarm` (hard-blocking precondition) | T16 | ✓ |
| Stripe Dashboard runbook sync | T15 | ✓ |

**Type / signature consistency:**

- `LookupKey` union vs `LOOKUP_KEYS` map: keys match in both (T3 + drift test).
- `Env.stripeSecretKey` vs `getStripeClient(env: Env)`: matches (T2, T4).
- `probeStripeContract(stripe: Stripe, logger: Logger)` vs server.ts call site: matches (T5, T6).
- `BillingProbeError` / `BillingProbeAuthError` / `BillingProbeStripeAPIChangeError` / `BillingProbeTransientError` — all four exported from probe.ts; all four asserted in probe.test.ts.

**Placeholder scan:** no "TBD", "TODO" (test mode placeholder $values are intentional and called out in the spec/runbook), "implement later", or "similar to Task N" patterns. Every code step contains the actual code; every command step contains the actual command + expected output.
