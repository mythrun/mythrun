# MYT-95 Billing & Credits Screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the player-facing billing surface — the Sessions & Billing settings screen (both credit buckets, subscription tiers with correct CTA gating, à-la-carte packs, portal, purchase history), the Stripe checkout-return routes (the header session-credit display + settings path already ship via MYT-87's HeaderCredits — no header work in this issue), and the `PurchasePrompt` (owner/non-owner) + 402-mapping seam MYT-92 wires into live play.

**Architecture:** Frontend-only against SHIPPED backend billing routes (`/api/billing/{balance,skus,history,checkout,portal,upgrade-tier}`) — no backend code. Layered per R1–R5: `@mythrun/contract` mirrors the wire; `@mythrun/client-core` owns the endpoint slices, view-models, the subscription-CTA gating decision, and the checkout-return poll hook (the brains); `@mythrun/ui` owns four presentational components on the DOM-free prop-contract seam; the web app composes them into the settings route, the header chrome, and the return routes. The two credit buckets (`session`, `world_gen`) are NEVER conflated at any layer.

**Tech Stack:** React + Vite + Tailwind; `@mythrun/{contract,client-core,ui}` + web; TanStack Query (suspense); Zod (contract + request bodies); Vitest + RTL + MSW; Storybook. Stripe test mode + Stripe CLI webhook forwarder for the E2E.

## Global Constraints

- **Two buckets never conflated.** `session` and `world_gen` are independent everywhere. Play-adjacent chrome (header + campaign card) tracks **session only**; the settings screen itemises BOTH. No surface ever renders a summed total (spec §4).
- **Subscription CTA gating is a REQUIRED acceptance criterion, not chrome.** An already-subscribed user must be UNABLE to reach plain subscription checkout (double-subscribe bug). The gating decision is a pure client-core function with an exhaustive test that pins: `activeSubscription !== null ⇒ cta !== 'subscribe'` (spec §4).
- **Owner-pays split.** The session-start 402 fires on the campaign OWNER's shortfall regardless of who clicked Start. Owner → buy path; non-owner → calm notice with NO buy CTA (buying credits the wrong ledger). The campaign-card low-credit treatment is OWNER-ONLY; no member-visible owner-balance read exists or may be added (spec §4).
- **No "best value" labels** on any tier (§11 register constraint carries).
- **Pack (à-la-carte) history rows CANNOT name credit counts** — `billing_history.lookup_key` is NULL for à-la-carte rows, so the prose reads "Purchase — $X.XX", no per-item credit detail. Subscription (invoice) rows carry `lookup_key` and may name the tier (spec §4, verified in `backend/src/repo/billing-history.ts`).
- **i18n:** every new user-facing string is a key with a `[ph: …]` placeholder value; **both** `frontend/client-core/src/i18n/locales/en/common.json` AND `frontend/client-core/src/i18n/descriptions.ts` are updated in lockstep (the `resources.test.ts` drift test asserts identical key sets). Server-sourced strings (Stripe tier `displayName`, price) are DATA, not copy — rendered directly.
- **Named exports only; strict TS (no `any`, no assertions unless unavoidable); functions <50 lines; modules <400 lines.**
- **Layering (R1–R5):** brains (slices, view-models, gating, poll hook) in `@mythrun/client-core`; presentational components in `@mythrun/ui`, importing DOM-free props from `@mythrun/client-core/contract` (neutral handlers `onPress`/`onSelect`/`onBuy`, no `className`/DOM events); web routes compose. No ad-hoc UI. Every DS component ships a Storybook story + tests; square/1-bit/paper register, NO circles/dots/chips; two faces only (`--font-body` serif for prose, `--font-ui` mono for data/chrome).
- **Prop-contract files are TYPE-ONLY** (`contract.test.ts` asserts the barrel carries no runtime values). New files live under `frontend/client-core/src/contract/billing/`, re-exported via `contract/billing/index.ts` → `contract/index.ts`.
- **Append-only shared surfaces** (controller resolves at merge, §7): `frontend/ui/src/index.ts` barrel, `frontend/client-core/src/index.ts` barrel, `frontend/client-core/src/contract/index.ts`, `common.json`/`descriptions.ts`.
- **Declared collision surfaces** (spec §7): `frontend/src/app/app-frame.tsx` — COLLISION DISSOLVED (Task 12 controller decision): 95 no longer touches this file; 92 is its only wave-1 writer. `frontend/src/app/router.tsx` — 95 is the single wave-1 writer (adds the checkout-return routes). `frontend/src/routes/home/home-card.tsx` — 91 OWNS; 95's low-credit treatment is a **standalone patch task the controller applies POST-91-MERGE** (Task 13), never a direct edit in the 95 worktree.
- **The live session-start 402 wiring is NOT in this issue.** MYT-95 ships `PurchasePrompt` + the 402-mapping unit-tested against the mocked contract shape `{ code:'insufficient_credits', available, required }` and exports the seam; MYT-92 wires and E2E-verifies the live arm at the 92-merge point (spec §4 coupling note).
- **TDD:** failing test first, always. Conventional Commits, one per task. Test conventions: mirror `frontend/client-core/src/api/billing.test.tsx` (MSW + `renderHook` + suspense wrapper) for slices/hooks; RTL for components; co-located `.test.ts(x)`.

---

## Task 1: Verify-first — probe live billing routes + confirm webhook forwarder

**No code.** This is the spec §7.3 verify-first bead: with AWS/Stripe **test mode** live, observe the EXACT wire shapes the six billing routes return and confirm the Stripe CLI webhook forwarder precondition the E2E depends on. Everything downstream (the contract schemas in Task 2, the view-models) is grounded in what this records.

**Files:**
- Create: `tmp/sdd/myt95-verify-notes.md` (the observed-shapes record; `tmp/` is gitignored — not committed).

**Interfaces:**
- Produces: the authoritative observed JSON shapes for `GET /api/billing/balance`, `GET /api/billing/skus`, `GET /api/billing/history`, `POST /api/billing/checkout`, `POST /api/billing/upgrade-tier`, `POST /api/billing/portal`, and the 402 `insufficient_credits` body — consumed by Task 2's contract schemas.

- [ ] **Step 1 — bring up the dev stack.** `pnpm db:up` (Postgres), then `pnpm dev` (backend on `:3030` + the web app). Confirm Stripe TEST keys are configured in `backend/.env.development` (the boot SKU probe must pass — a boot failure here means Stripe keys/lookup_keys drift, root-cause before proceeding).
- [ ] **Step 2 — start the Stripe CLI webhook forwarder (E2E PRECONDITION).** In a separate shell:
  ```bash
  stripe listen --forward-to localhost:3030/webhooks/stripe
  ```
  Record the printed `whsec_…` signing secret and confirm it matches the backend's configured webhook secret (if they differ, credits never land — the credit grant rides ONLY the `checkout.session.completed` webhook). **If the forwarder cannot run, STOP and record it as a failed precondition** — the Task 14 E2E must fail-loud on this, not hang.
- [ ] **Step 3 — obtain an authed session.** The billing routes are JWT/cookie-gated. Sign in through the web app at `localhost` (the dev auth path) and copy the session cookie for curl, OR drive the probes from the browser devtools/network tab. Record the method used.
- [ ] **Step 4 — probe the GET routes** and paste the verbatim JSON into the notes file:
  ```bash
  curl -s -b "$COOKIE" localhost:3030/api/billing/balance   | jq .
  curl -s          localhost:3030/api/billing/skus           | jq .   # public, no auth
  curl -s -b "$COOKIE" localhost:3030/api/billing/history    | jq .
  ```
  Confirm: `balance` → `{ session, world_gen, active_subscription }`; `skus` → array of `{ lookup_key, displayName, type, sessionsGranted, worldsGranted, price:{ unit_amount_cents, currency } }` (NO `stripe_price_id`); `history` → `{ events:[{ id, kind, occurred_at, amount_cents, currency, lookup_key, status, source_id_stripe }], nextCursor }`. **Explicitly confirm a pack (à-la-carte) row has `lookup_key: null` and a subscription/invoice row carries it** — this is the load-bearing fact for the history prose.
- [ ] **Step 5 — probe the POST routes** (test-mode; use a real Stripe test SKU/tier):
  ```bash
  curl -s -b "$COOKIE" -H 'content-type: application/json' -X POST localhost:3030/api/billing/checkout \
    -d '{"items":[{"lookup_key":"sku_session","quantity":1}],"success_url":"http://localhost:5173/billing/return","cancel_url":"http://localhost:5173/billing/cancelled"}' | jq .
  curl -s -b "$COOKIE" -H 'content-type: application/json' -X POST localhost:3030/api/billing/portal \
    -d '{"return_url":"http://localhost:5173/settings"}' | jq .
  ```
  Confirm: `checkout` → `{ checkout_session_id, url }`; `portal` → `{ url }`. For `upgrade-tier`, record BOTH shapes: the 200 `{ invoice_id }` (against a lower-tier test subscriber) AND the 409 `{ code:'upgrade_already_pending', detail:{ pending_update_expires_at, latest_invoice_id } }` (re-fire while a prior upgrade is mid-flight). Note the web frontend origin (`http://localhost:5173`) for the return-URL construction in Tasks 11/12.
- [ ] **Step 6 — record the 402 shape.** From the spec/mock (and confirmed against `sessions.ts` if a drained-owner session-start can be triggered), record the session-start insufficient-credits body: `{ code:'insufficient_credits', available:<number>, required:<number> }`. This is the shape Task 6's mapping unit-tests against.
- [ ] **Step 7 — write `tmp/sdd/myt95-verify-notes.md`** with all observed shapes + the webhook-forwarder status. No commit (gitignored).

---

## Task 2: Contract — billing response schemas

**Files:**
- Modify: `frontend/contract/src/rest/billing.ts` (append the MYT-95 schemas; the barrel `rest/index.ts` already does `export * from './billing.js'`).
- Test: `frontend/contract/src/__tests__/billing.test.ts` (extend).

**Interfaces:**
- Consumes: the observed shapes from Task 1.
- Produces: `LookupKeySchema`, `SkuListing`/`SkuListingResponseSchema`, `BillingHistoryEvent`/`BillingHistoryResponseSchema`, `CheckoutResponseSchema`, `PortalResponseSchema`, `UpgradeTierResponseSchema` (+ inferred types) from `@mythrun/contract/rest`.
- **Drift pin (controller decision, ambiguity 6):** the enum mirrors `backend/src/billing/lookup-keys.ts`; a backend unit test pins them together — create `backend/src/billing/__tests__/lookup-keys-contract.test.ts` asserting `new Set(LookupKeySchema.options)` equals the set of backend lookup keys (backend already imports `@mythrun/contract`). A key added on either side fails the suite instead of drifting silently.

- [ ] **Step 1 — write failing tests** in `billing.test.ts`: a valid skus array parses; a valid history response parses; a history row with `lookup_key: null` parses (à-la-carte); a malformed skus entry (missing `price`) is rejected; `CheckoutResponseSchema` parses `{ checkout_session_id, url }`; `UpgradeTierResponseSchema` parses `{ invoice_id: null }`. Run → FAIL.
- [ ] **Step 2 — append the schemas** to `billing.ts`:
```ts
// --- MYT-95: response schemas for the billing screens ---

// Mirrors backend/src/billing/lookup-keys.ts LookupKey (the closed SKU enum).
export const LookupKeySchema = z.enum([
  'tier_wayfarer',
  'tier_sojourner',
  'tier_mythwright',
  'sku_session',
  'sku_world',
])
export type LookupKey = z.infer<typeof LookupKeySchema>

// GET /api/billing/skus — the public pricing catalogue. Mirrors the backend
// SkuPublicListing (billing/sku-cache.ts) EXACTLY — note: NO stripe_price_id.
export const SkuPriceSchema = z.object({
  unit_amount_cents: z.number().int(),
  currency: z.string(),
})
export const SkuListingSchema = z.object({
  lookup_key: LookupKeySchema,
  displayName: z.string(),
  type: z.enum(['recurring', 'one_time']),
  sessionsGranted: z.number().int(),
  worldsGranted: z.number().int(),
  price: SkuPriceSchema,
})
export type SkuListing = z.infer<typeof SkuListingSchema>
export const SkuListingResponseSchema = z.array(SkuListingSchema)
export type SkuListingResponse = z.infer<typeof SkuListingResponseSchema>

// GET /api/billing/history — the unified billing audit feed. `lookup_key` is
// NULL for à-la-carte pack rows (they cannot name credit counts); populated for
// subscription invoice rows. Cursor is opaque base64url; null = last page.
export const BillingHistoryEventSchema = z.object({
  id: z.string(),
  kind: z.enum(['purchase', 'invoice', 'refund']),
  occurred_at: z.iso.datetime(),
  amount_cents: z.number().int(),
  currency: z.string(),
  lookup_key: z.string().nullable(),
  status: z.enum(['completed', 'refunded']),
  source_id_stripe: z.string(),
})
export type BillingHistoryEvent = z.infer<typeof BillingHistoryEventSchema>
export const BillingHistoryResponseSchema = z.object({
  events: z.array(BillingHistoryEventSchema),
  nextCursor: z.string().nullable(),
})
export type BillingHistoryResponse = z.infer<typeof BillingHistoryResponseSchema>

// POST /api/billing/checkout — returns the Stripe redirect (grants NOTHING).
export const CheckoutResponseSchema = z.object({
  checkout_session_id: z.string(),
  url: z.string(),
})
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>

// POST /api/billing/portal — the Customer Portal redirect.
export const PortalResponseSchema = z.object({ url: z.string() })
export type PortalResponse = z.infer<typeof PortalResponseSchema>

// POST /api/billing/upgrade-tier — 200 shape. The 409 upgrade_already_pending
// body is an ERROR payload (surfaced via HttpError.code), not a success shape.
export const UpgradeTierResponseSchema = z.object({ invoice_id: z.string().nullable() })
export type UpgradeTierResponse = z.infer<typeof UpgradeTierResponseSchema>
```
- [ ] **Step 3 — rebuild the contract package** so downstream packages resolve the new schemas: `pnpm --filter @mythrun/contract build`. Run `pnpm --filter @mythrun/contract test` → PASS.
- [ ] **Step 4 — commit** `feat(MYT-95): contract schemas for billing skus/history/checkout/portal/upgrade`.

---

## Task 3: client-core — billing endpoint slices

**Files:**
- Modify: `frontend/client-core/src/api/billing.ts` (add slices beside `getBalance`/`useBalance`).
- Modify: `frontend/client-core/src/index.ts` (barrel — append-only).
- Test: `frontend/client-core/src/api/billing.test.tsx` (extend, mirroring the MSW harness already in the file).

**Interfaces:**
- Consumes: the Task 2 schemas from `@mythrun/contract/rest`; `defineEndpoint`, `ApiContext` (`./endpoint.ts`); `HttpError` (`./errors.ts`).
- Produces: `getSkus`/`useSkus() → { data: SkuListingResponse }`; `getHistory`/`useHistory() → { data: BillingHistoryResponse }`; `createCheckout(ctx, body) → Promise<CheckoutResponse>`; `openPortal(ctx, body) → Promise<PortalResponse>`; `upgradeTier(ctx, body) → Promise<UpgradeTierResponse>` (throws `HttpError` 409 `upgrade_already_pending`).

- [ ] **Step 1 — write failing tests** (MSW): `getSkus` GETs `/api/billing/skus` and parses the array; `getHistory` GETs `/api/billing/history` (and `?cursor=…` when given); `useSkus`/`useHistory` resolve via suspense; `createCheckout` POSTs the body and returns `{ checkout_session_id, url }`; `openPortal` POSTs `{ return_url }` → `{ url }`; `upgradeTier` POSTs `{ target_tier_lookup_key }` → `{ invoice_id }`; a 409 `upgrade_already_pending` from `upgradeTier` rejects with an `HttpError` whose `.status === 409` and `.code === 'upgrade_already_pending'`. Run → FAIL.
- [ ] **Step 2 — implement** the slices in `billing.ts`:
```ts
import { z } from 'zod'
import { useSuspenseQuery } from '@tanstack/react-query'
import {
  BalanceResponseSchema, type BalanceResponse,
  SkuListingResponseSchema, type SkuListingResponse,
  BillingHistoryResponseSchema, type BillingHistoryResponse,
  CheckoutResponseSchema, type CheckoutResponse,
  PortalResponseSchema, type PortalResponse,
  UpgradeTierResponseSchema, type UpgradeTierResponse,
  LookupKeySchema,
} from '@mythrun/contract/rest'
import { defineEndpoint, type ApiContext } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// getBalance / useBalance — unchanged (above).

export const getSkus = defineEndpoint<SkuListingResponse>({
  method: 'GET',
  path: () => '/api/billing/skus',
  response: SkuListingResponseSchema,
})
export function useSkus() {
  const ctx = useApiContext()
  return useSuspenseQuery({ queryKey: ['billing', 'skus'], queryFn: () => getSkus(undefined, ctx) })
}

export const getHistory = defineEndpoint<BillingHistoryResponse, { cursor?: string }>({
  method: 'GET',
  path: (input) =>
    input.cursor !== undefined
      ? `/api/billing/history?cursor=${encodeURIComponent(input.cursor)}`
      : '/api/billing/history',
  response: BillingHistoryResponseSchema,
})
export function useHistory() {
  const ctx = useApiContext()
  return useSuspenseQuery({ queryKey: ['billing', 'history'], queryFn: () => getHistory({}, ctx) })
}

const CheckoutItemSchema = z.object({
  lookup_key: LookupKeySchema,
  quantity: z.number().int().min(1).max(100),
})
const CheckoutBodySchema = z.object({
  items: z.array(CheckoutItemSchema).min(1).max(100),
  success_url: z.string(),
  cancel_url: z.string(),
})
export type CheckoutBody = z.infer<typeof CheckoutBodySchema>
const checkoutEndpoint = defineEndpoint({
  // In is inferred from the typed `path` param; `request` validates + serializes.
  path: (_input: CheckoutBody) => '/api/billing/checkout',
  method: 'POST',
  request: CheckoutBodySchema,
  response: CheckoutResponseSchema,
})
/** Create a Stripe Checkout Session for à-la-carte packs OR a subscription tier.
 *  Returns the redirect URL — the web caller navigates to it (grants nothing). */
export function createCheckout(ctx: ApiContext, body: CheckoutBody): Promise<CheckoutResponse> {
  return checkoutEndpoint(body, ctx)
}

const PortalBodySchema = z.object({ return_url: z.string() })
export type PortalBody = z.infer<typeof PortalBodySchema>
const portalEndpoint = defineEndpoint({
  path: (_input: PortalBody) => '/api/billing/portal',
  method: 'POST',
  request: PortalBodySchema,
  response: PortalResponseSchema,
})
/** Open the Customer Portal (downgrades / cancel / payment methods). */
export function openPortal(ctx: ApiContext, body: PortalBody): Promise<PortalResponse> {
  return portalEndpoint(body, ctx)
}

const UpgradeTierBodySchema = z.object({ target_tier_lookup_key: LookupKeySchema })
export type UpgradeTierBody = z.infer<typeof UpgradeTierBodySchema>
const upgradeTierEndpoint = defineEndpoint({
  path: (_input: UpgradeTierBody) => '/api/billing/upgrade-tier',
  method: 'POST',
  request: UpgradeTierBodySchema,
  response: UpgradeTierResponseSchema,
})
/** Monotonic tier upgrade (prorated). Throws HttpError 409 `upgrade_already_pending`
 *  when a prior upgrade is mid-flight — the caller renders the calm pending arm. */
export function upgradeTier(ctx: ApiContext, body: UpgradeTierBody): Promise<UpgradeTierResponse> {
  return upgradeTierEndpoint(body, ctx)
}
```
- [ ] **Step 3 — barrel** in `index.ts` (append): `export { getSkus, useSkus, getHistory, useHistory, createCheckout, openPortal, upgradeTier } from './api/billing.ts'` and `export type { CheckoutBody, PortalBody, UpgradeTierBody } from './api/billing.ts'`; add `export type { SkuListing, BillingHistoryEvent, LookupKey } from '@mythrun/contract/rest'` beside the existing `BalanceResponse` re-export.
- [ ] **Step 4 — run** `pnpm --filter @mythrun/client-core test billing` + typecheck → PASS.
- [ ] **Step 5 — commit** `feat(MYT-95): client-core billing endpoint slices (skus/history/checkout/portal/upgrade)`.

---

## Task 4: client-core — tier catalogue + balance view-model

**Files:**
- Create: `frontend/client-core/src/billing/tier-catalogue.ts`, `frontend/client-core/src/billing/balance-view-model.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/billing/__tests__/tier-catalogue.test.ts`, `.../balance-view-model.test.ts`

**Interfaces:**
- Consumes: `SkuListing`, `BalanceResponse` (`@mythrun/contract/rest`).
- Produces: `subscriptionTiers(skus): SkuListing[]` (ascending by price), `aLaCarteSkus(skus): SkuListing[]`, `tierRank(skus, lookupKey): number | undefined`; `balanceView(balance, skus): BalanceView` where `BalanceView = { session, worldGen, subscription: { tierLookupKey, tierDisplayName, cancelAtPeriodEnd, currentPeriodEnd } | null }`.

- [ ] **Step 1 — write failing tests:** `subscriptionTiers` returns only `type:'recurring'`, sorted Wayfarer→Sojourner→Mythwright by `price.unit_amount_cents`; `aLaCarteSkus` returns only `type:'one_time'`; `tierRank` gives `0/1/2` for the three tiers and `undefined` for `sku_session`; `balanceView` maps `session`/`world_gen` to `session`/`worldGen` UNCHANGED and resolves `subscription.tierDisplayName` from the catalogue (falls back to the raw key when absent), null when `active_subscription` is null. **Pin the no-conflation invariant:** assert `BalanceView` has no `total`/summed field and that `session`/`worldGen` echo the inputs independently. Run → FAIL.
- [ ] **Step 2 — implement `tier-catalogue.ts`:**
```ts
import type { SkuListing } from '@mythrun/contract/rest'

/** Recurring subscription tiers, ascending by price (Wayfarer→Mythwright). */
export function subscriptionTiers(skus: readonly SkuListing[]): SkuListing[] {
  return skus
    .filter((s) => s.type === 'recurring')
    .sort((a, b) => a.price.unit_amount_cents - b.price.unit_amount_cents)
}

/** À-la-carte SKUs (session / world packs). */
export function aLaCarteSkus(skus: readonly SkuListing[]): SkuListing[] {
  return skus.filter((s) => s.type === 'one_time')
}

/** Price-rank of a recurring tier (0-based ascending); undefined for non-tiers. */
export function tierRank(skus: readonly SkuListing[], lookupKey: string): number | undefined {
  const idx = subscriptionTiers(skus).findIndex((t) => t.lookup_key === lookupKey)
  return idx === -1 ? undefined : idx
}
```
- [ ] **Step 3 — implement `balance-view-model.ts`:**
```ts
import type { BalanceResponse, SkuListing } from '@mythrun/contract/rest'

export interface BalanceView {
  /** Session credits — the play/session bucket. NEVER summed with worldGen. */
  readonly session: number
  /** World-gen credits — the world-creation bucket. NEVER summed with session. */
  readonly worldGen: number
  readonly subscription: {
    readonly tierLookupKey: string
    readonly tierDisplayName: string
    readonly cancelAtPeriodEnd: boolean
    readonly currentPeriodEnd: string
  } | null
}

export function balanceView(balance: BalanceResponse, skus: readonly SkuListing[]): BalanceView {
  const sub = balance.active_subscription
  const tier = sub === null ? undefined : skus.find((s) => s.lookup_key === sub.tier_lookup_key)
  return {
    session: balance.session,
    worldGen: balance.world_gen,
    subscription:
      sub === null
        ? null
        : {
            tierLookupKey: sub.tier_lookup_key,
            tierDisplayName: tier?.displayName ?? sub.tier_lookup_key,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            currentPeriodEnd: sub.current_period_end,
          },
  }
}
```
- [ ] **Step 4 — barrel + run** `pnpm --filter @mythrun/client-core test billing` (scoped) → PASS.
- [ ] **Step 5 — commit** `feat(MYT-95): tier catalogue + balance view-model (two buckets, never conflated)`.

---

## Task 5: client-core — subscription CTA gating (showstopper)

**Files:**
- Create: `frontend/client-core/src/billing/subscription-cta.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `frontend/client-core/src/billing/__tests__/subscription-cta.test.ts`

**Interfaces:**
- Consumes: `ActiveSubscriptionSummary`, `SkuListing` (`@mythrun/contract/rest`); `tierRank` (Task 4).
- Produces: `subscriptionCta({ activeSubscription, targetTierLookupKey, skus }): TierCtaDecision` where `TierCtaDecision = { cta: 'subscribe' | 'upgrade' | 'manage'; isCurrent: boolean }`.

- [ ] **Step 1 — write the exhaustive failing tests:**
  - `activeSubscription === null` → EVERY tier returns `{ cta:'subscribe', isCurrent:false }`.
  - **THE PIN (required acceptance criterion):** for an active subscription, iterate ALL (currentTier × targetTier) pairs across the three tiers and assert `result.cta !== 'subscribe'` for every pair.
  - active + target price HIGHER → `cta:'upgrade'`, `isCurrent:false`.
  - active + target === current tier → `cta:'manage'`, `isCurrent:true`.
  - active + target price LOWER → `cta:'manage'`, `isCurrent:false`.
  - active + target tier not in the catalogue → `cta:'manage'` (never `'subscribe'`).
  Run → FAIL.
- [ ] **Step 2 — implement:**
```ts
import type { ActiveSubscriptionSummary, SkuListing } from '@mythrun/contract/rest'
import { tierRank } from './tier-catalogue.ts'

/** The gated action for a subscription-tier CTA. `subscribe` is ONLY ever
 *  returned when there is NO active subscription — an already-subscribed user
 *  can never reach plain subscription checkout (the double-subscribe bug the
 *  spec §4 pins as a required acceptance criterion). */
export type SubscriptionCta = 'subscribe' | 'upgrade' | 'manage'

export interface TierCtaDecision {
  readonly cta: SubscriptionCta
  /** True when this tier IS the active tier (display marker; action is `manage`). */
  readonly isCurrent: boolean
}

export function subscriptionCta(args: {
  readonly activeSubscription: ActiveSubscriptionSummary | null
  readonly targetTierLookupKey: string
  readonly skus: readonly SkuListing[]
}): TierCtaDecision {
  const { activeSubscription, targetTierLookupKey, skus } = args
  // No active sub → a fresh subscribe (checkout mode:subscription).
  if (activeSubscription === null) return { cta: 'subscribe', isCurrent: false }

  const currentRank = tierRank(skus, activeSubscription.tier_lookup_key)
  const targetRank = tierRank(skus, targetTierLookupKey)
  // Defensive: an unresolvable tier with an active sub routes to Portal — NEVER
  // to a second subscribe. This is the guard that keeps the pin total.
  if (currentRank === undefined || targetRank === undefined) return { cta: 'manage', isCurrent: false }

  if (targetRank > currentRank) return { cta: 'upgrade', isCurrent: false }
  // Same tier or lower → Customer Portal (downgrade / cancel / payment method).
  return { cta: 'manage', isCurrent: targetRank === currentRank }
}
```
- [ ] **Step 3 — barrel + run** the test → PASS (100×4 scoped).
- [ ] **Step 4 — commit** `feat(MYT-95): subscription CTA gating — no double-subscribe (showstopper fix)`.

---

## Task 6: client-core — purchase-history VM, 402 mapping (MYT-92 seam), checkout-return poll hook

Three brains, each independently tested; one reviewer gate (all client-core, all consumed downstream by the UI/web tasks).

**Files:**
- Create: `frontend/client-core/src/billing/purchase-history-view-model.ts`, `.../insufficient-credits.ts`, `.../use-checkout-return.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel)
- Test: `.../__tests__/purchase-history-view-model.test.ts`, `.../insufficient-credits.test.ts`, `.../use-checkout-return.test.tsx`

**Interfaces:**
- Consumes: `BillingHistoryEvent`, `SkuListing`, `BalanceResponse` (`@mythrun/contract/rest`); `getBalance` (Task 3); `useApiContext`, `useQueryClient`.
- Produces:
  - `purchaseHistoryView(events, skus): HistoryRowView[]` where `HistoryRowView = { id, kind:'purchase'|'invoice'|'refund', amountCents, currency, tierDisplayName: string | null, occurredAt, refunded }`.
  - `isInsufficientCredits(body): body is InsufficientCreditsError` + `purchasePromptModel(err, viewerIsOwner): PurchasePromptModel` where `PurchasePromptModel = { variant:'owner'|'nonOwner', available, required }`. **This is the seam MYT-92 consumes** (guard the session-start 402 body → build the prompt model).
  - `useCheckoutReturn(config?): { status: 'polling' | 'settled' | 'processing' }`.

- [ ] **Step 1 — write failing tests:**
  - `purchaseHistoryView`: a `kind:'purchase'` row with `lookup_key:null` → `tierDisplayName:null` (pack rows can't name credits); a `kind:'invoice'` row with a tier `lookup_key` → `tierDisplayName` resolved from skus; `status:'refunded'` → `refunded:true`.
  - `isInsufficientCredits`: accepts `{ code:'insufficient_credits', available:0, required:1 }`; rejects a wrong `code`, a missing `available`, a non-object.
  - `purchasePromptModel`: `viewerIsOwner:true` → `variant:'owner'`; `false` → `variant:'nonOwner'`; carries `available`/`required` through.
  - `useCheckoutReturn`: with MSW returning an UNCHANGED balance across polls and a tiny budget → resolves to `'processing'`; with a balance that CHANGES on the second poll → resolves to `'settled'` and invalidates `['billing','balance']`.
  Run → FAIL.
- [ ] **Step 2 — implement `purchase-history-view-model.ts`:**
```ts
import type { BillingHistoryEvent, SkuListing } from '@mythrun/contract/rest'

export interface HistoryRowView {
  readonly id: string
  readonly kind: 'purchase' | 'invoice' | 'refund'
  readonly amountCents: number
  readonly currency: string
  /** The tier name for subscription (invoice) rows. null for à-la-carte pack
   *  rows (no lookup_key — they cannot name credit counts) and refunds. */
  readonly tierDisplayName: string | null
  readonly occurredAt: string
  readonly refunded: boolean
}

export function purchaseHistoryView(
  events: readonly BillingHistoryEvent[],
  skus: readonly SkuListing[],
): HistoryRowView[] {
  return events.map((e) => ({
    id: e.id,
    kind: e.kind,
    amountCents: e.amount_cents,
    currency: e.currency,
    tierDisplayName:
      e.lookup_key === null ? null : (skus.find((s) => s.lookup_key === e.lookup_key)?.displayName ?? null),
    occurredAt: e.occurred_at,
    refunded: e.status === 'refunded',
  }))
}
```
- [ ] **Step 3 — implement `insufficient-credits.ts`:**
```ts
/** The 402 body the session-start route emits when the campaign OWNER's session
 *  balance is short (regardless of who clicked Start). MYT-95 unit-tests against
 *  this mocked shape; the LIVE wiring is MYT-92's (spec §4 coupling note). */
export interface InsufficientCreditsError {
  readonly code: 'insufficient_credits'
  readonly available: number
  readonly required: number
}

export function isInsufficientCredits(body: unknown): body is InsufficientCreditsError {
  if (typeof body !== 'object' || body === null) return false
  const b = body as { code?: unknown; available?: unknown; required?: unknown }
  return b.code === 'insufficient_credits' && typeof b.available === 'number' && typeof b.required === 'number'
}

/** The model the PurchasePrompt renders. `viewerIsOwner` is decided by the caller
 *  (MYT-92's play route) from campaign ownership: NON-owners get a calm notice
 *  with NO buy CTA — buying would credit the wrong ledger and not fix the session. */
export interface PurchasePromptModel {
  readonly variant: 'owner' | 'nonOwner'
  readonly available: number
  readonly required: number
}

export function purchasePromptModel(
  err: InsufficientCreditsError,
  viewerIsOwner: boolean,
): PurchasePromptModel {
  return { variant: viewerIsOwner ? 'owner' : 'nonOwner', available: err.available, required: err.required }
}
```
- [ ] **Step 4 — implement `use-checkout-return.ts`:**
```ts
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { BalanceResponse } from '@mythrun/contract/rest'
import { getBalance } from '../api/billing.ts'
import { useApiContext } from '../api/client-context.tsx'

export type CheckoutReturnStatus = 'polling' | 'settled' | 'processing'

interface PollConfig {
  readonly intervalMs?: number
  readonly budgetMs?: number
}

/** Polls the balance after a Stripe checkout redirect. The webhook is the source
 *  of truth for the credit grant, so we cannot confirm synchronously: snapshot the
 *  balance at mount and poll until it CHANGES (→ settled) or the budget expires
 *  (→ processing — a calm NON-error state, never a failure claim for a completed
 *  payment). The pre-redirect baseline doesn't survive the Stripe round-trip, so a
 *  webhook that landed before mount yields `processing` — the accepted fallback. */
export function useCheckoutReturn(config?: PollConfig): { status: CheckoutReturnStatus } {
  const intervalMs = config?.intervalMs ?? 1500
  const budgetMs = config?.budgetMs ?? 12000
  const ctx = useApiContext()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<CheckoutReturnStatus>('polling')
  const baseline = useRef<BalanceResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout>

    const changed = (b: BalanceResponse, base: BalanceResponse): boolean =>
      b.session !== base.session ||
      b.world_gen !== base.world_gen ||
      JSON.stringify(b.active_subscription) !== JSON.stringify(base.active_subscription)

    const tick = async (): Promise<void> => {
      let b: BalanceResponse
      try {
        b = await getBalance(undefined, ctx)
      } catch {
        // Transient balance-fetch failure — keep polling until the budget expires.
        if (!cancelled && Date.now() - startedAt < budgetMs) timer = setTimeout(() => void tick(), intervalMs)
        else if (!cancelled) setStatus('processing')
        return
      }
      if (cancelled) return
      if (baseline.current === null) baseline.current = b
      else if (changed(b, baseline.current)) {
        await queryClient.invalidateQueries({ queryKey: ['billing', 'balance'] })
        if (!cancelled) setStatus('settled')
        return
      }
      if (Date.now() - startedAt >= budgetMs) setStatus('processing')
      else timer = setTimeout(() => void tick(), intervalMs)
    }

    timer = setTimeout(() => void tick(), 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ctx, queryClient, intervalMs, budgetMs])

  return { status }
}
```
- [ ] **Step 5 — barrel** all three (functions + types) and run `pnpm --filter @mythrun/client-core test billing` → PASS. (Use `vi.useFakeTimers()` + a stateful MSW handler in the hook test; pass `{ intervalMs: 5, budgetMs: 20 }` to keep it fast.)
- [ ] **Step 6 — commit** `feat(MYT-95): purchase-history VM + 402 mapping seam + checkout-return poll hook`.

---

## Task 7: @mythrun/ui — CreditBalance

**Files:**
- Create: `frontend/client-core/src/contract/billing/credit-balance-props.ts`, `frontend/client-core/src/contract/billing/index.ts` (new subdir barrel)
- Modify: `frontend/client-core/src/contract/index.ts` (re-export `./billing/index.ts` — append-only, TYPE-only)
- Create: `frontend/ui/src/components/CreditBalance/{CreditBalance.tsx,.stories.tsx,.test.tsx}`
- Modify: `frontend/ui/src/index.ts` (barrel — append-only)

**Interfaces:**
- Produces: `CreditBalanceProps = { session: number; sessionLabel: string; worldGen?: number; worldGenLabel?: string; variant?: 'stacked' | 'inline'; 'data-testid'?: string }`. `stacked` itemises both buckets (settings); `inline` is the compact single-number header variant (`worldGen` omitted). Labels are i18n'd strings passed by the shell (copy stays in the shell, not the DS).

- [ ] **Step 1 — author the prop-contract file** (type-only) + the `billing/index.ts` barrel (`export type { CreditBalanceProps } from './credit-balance-props.ts'`) + re-export from `contract/index.ts`. Run `pnpm --filter @mythrun/client-core typecheck` + `contract.test.ts` → PASS (barrel stays runtime-value-free).
- [ ] **Step 2 — write failing component tests:** `stacked` renders BOTH the session number+label and the worldGen number+label; `inline` renders ONLY the session number (with its label as visually-hidden context, mirroring the shipped `HeaderCredits`); numbers render in the mono `role="data"` register; no summed total is rendered. Run → FAIL.
- [ ] **Step 3 — implement** `CreditBalance.tsx` composing `@mythrun/ui` `Text`/`Stack`/`VisuallyHidden` primitives. Square/mono/paper register; each bucket is a labeled mono readout; NO chips/dots. `inline` = one `Text role="data"` with a `VisuallyHidden` label (so it can slot into the header preserving the shipped `frame-credits` shape). Numbers are locale-formatted BY THE SHELL — the component renders the passed number as given (or accepts pre-formatted strings; keep it a `number` and let the shell format, consistent with `HeaderCredits`' `Intl.NumberFormat`). Run tests → PASS.
- [ ] **Step 4 — story** (`Character`→ change to `Billing/CreditBalance` title): stacked (both buckets) + inline (header) + a zero-balance specimen; desktop and ~375px. Barrel export.
- [ ] **Step 5 — commit** `feat(MYT-95): CreditBalance component (stacked + inline variants)`.

---

## Task 8: @mythrun/ui — PackList

**Files:**
- Create: `frontend/client-core/src/contract/billing/pack-list-props.ts` (+ barrel entry)
- Create: `frontend/ui/src/components/PackList/{PackList.tsx,.stories.tsx,.test.tsx}` + barrel

**Interfaces:**
- Consumes: the CTA outcome shape from Task 5 (`'subscribe' | 'upgrade' | 'manage'` + `isCurrent`), resolved by the shell.
- Produces:
```ts
export interface SubscriptionTierView {
  readonly lookupKey: string
  readonly displayName: string      // server data (Wayfarer / Sojourner / Mythwright)
  readonly priceLabel: string       // shell-formatted, e.g. "$12 / mo"
  readonly cta: 'subscribe' | 'upgrade' | 'manage'
  readonly isCurrent: boolean
}
export interface AlaCarteView {
  readonly lookupKey: string
  readonly displayName: string      // server data (Session / World)
  readonly unitPriceLabel: string   // shell-formatted, e.g. "$5 each"
}
export interface PackListProps {
  readonly tiers: readonly SubscriptionTierView[]
  readonly alaCarte: readonly AlaCarteView[]
  /** Terse quantity presets for à-la-carte (e.g. [1, 4, 8, 16]); clamped 1–100. */
  readonly quantityPresets: readonly number[]
  readonly onTierCta: (lookupKey: string, cta: 'subscribe' | 'upgrade' | 'manage') => void
  readonly onBuyAlaCarte: (lookupKey: string, quantity: number) => void
  /** i18n'd CTA verbs + the "current" marker + the à-la-carte buy verb. */
  readonly labels: {
    readonly subscribe: string
    readonly upgrade: string
    readonly manage: string
    readonly current: string
    readonly buy: string
  }
  readonly 'data-testid'?: string
}
```

- [ ] **Step 1 — prop-contract file + barrel** (type-only). Typecheck → PASS.
- [ ] **Step 2 — write failing tests:** each tier renders its `displayName` + `priceLabel` + a CTA button whose text is `labels[cta]`; clicking it fires `onTierCta(lookupKey, cta)`; the `isCurrent` tier shows the `current` marker (prose/typography, NOT a chip) AND its action is still `manage`; **NO element anywhere contains a "best value"/"recommended" string** (assert absence); the à-la-carte row's presets set the quantity and `onBuyAlaCarte` fires with the chosen quantity; a quantity is clamped to `[1, 100]`. Run → FAIL.
- [ ] **Step 3 — implement** `PackList.tsx`: subscription tiers as flat square paper cards (mono price readout, a single gated CTA `Button` per tier via `labels[cta]`, the current tier marked with a mono "current" line); à-la-carte as a row of preset `Button`s (quantity) + a Buy `Button` → `onBuyAlaCarte`. Clamp helper `Math.min(100, Math.max(1, q))`. Square/1-bit register, two faces, NO chips/dots, NO best-value labels. Run tests → PASS.
- [ ] **Step 4 — stories:** all four tier CTA states (subscribe / upgrade / manage / current) + the à-la-carte control; desktop and ~375px (stacked). Barrel export.
- [ ] **Step 5 — commit** `feat(MYT-95): PackList (gated subscription CTAs + à-la-carte quantity, no best-value labels)`.

---

## Task 9: @mythrun/ui — PurchaseHistory

**Files:**
- Create: `frontend/client-core/src/contract/billing/purchase-history-props.ts` (+ barrel entry)
- Create: `frontend/ui/src/components/PurchaseHistory/{PurchaseHistory.tsx,.stories.tsx,.test.tsx}` + barrel

**Interfaces:**
- Produces:
```ts
export interface PurchaseHistoryRow {
  readonly id: string
  /** Shell-composed terse prose, e.g. "Purchase — $12.00" / "Mythwright — $16.00". */
  readonly label: string
  readonly refunded: boolean
}
export interface PurchaseHistoryProps {
  readonly rows: readonly PurchaseHistoryRow[]
  readonly emptyLabel: string
  readonly 'data-testid'?: string
}
```

- [ ] **Step 1 — prop-contract file + barrel** (type-only). Typecheck → PASS.
- [ ] **Step 2 — write failing tests:** renders each row's `label` in the mono register; an empty `rows` renders `emptyLabel`; a `refunded` row is marked WITHOUT a chip/badge (typographic — e.g. a mono "refunded" suffix or struck weight). Run → FAIL.
- [ ] **Step 3 — implement** `PurchaseHistory.tsx`: a terse mono list (`Text role="meta"`/`data`), one line per row, refund conveyed as prose. No pagination UI (the terse feed shows the first page; `nextCursor` exists for a future load-more — noted, not built). Run tests → PASS.
- [ ] **Step 4 — story:** a mixed feed (pack purchase, subscription invoice, a refund) + the empty state; desktop + ~375px. Barrel export.
- [ ] **Step 5 — commit** `feat(MYT-95): PurchaseHistory (terse mono feed)`.

---

## Task 10: @mythrun/ui — PurchasePrompt (owner / non-owner) + the MYT-92 seam

**Files:**
- Create: `frontend/client-core/src/contract/billing/purchase-prompt-props.ts` (+ barrel entry)
- Create: `frontend/ui/src/components/PurchasePrompt/{PurchasePrompt.tsx,.stories.tsx,.test.tsx}` + barrel

**Interfaces:**
- Consumes: the `PurchasePromptModel` (`variant`, `available`, `required`) from Task 6.
- Produces:
```ts
export interface PurchasePromptProps {
  readonly variant: 'owner' | 'nonOwner'
  readonly heading: string          // i18n'd by the shell
  readonly body: string             // i18n'd by the shell
  /** OWNER only: the buy affordance. Ignored (never rendered) for nonOwner. */
  readonly buyLabel?: string
  readonly quantityPresets?: readonly number[]
  readonly onBuy?: (quantity: number) => void
  readonly onDismiss?: () => void
  readonly 'data-testid'?: string
}
```
- **THE MYT-92 SEAM** (documented for the play-route wiring at the 92-merge point): on a session-start 402, MYT-92 does `if (err instanceof HttpError && err.status === 402 && isInsufficientCredits(err.body))` → `const model = purchasePromptModel(err.body, viewerIsOwner)` → renders `<PurchasePrompt variant={model.variant} heading={t(...)} body={t(..., { available: model.available, required: model.required })} buyLabel={t(...)} quantityPresets={SESSION_PRESETS} onBuy={(qty) => redirectToCheckout('sku_session', qty)} onDismiss={...} />`. The exact handler types are `onBuy: (quantity: number) => void` and `onDismiss: () => void`. MYT-95 does NOT wire the live path; it ships the component + the tested mapping (Task 6).

- [ ] **Step 1 — prop-contract file + barrel** (type-only). Typecheck → PASS.
- [ ] **Step 2 — write failing tests:** `variant:'owner'` renders `heading`+`body`+the buy affordance (preset buttons), and `onBuy` fires with the chosen quantity; `variant:'nonOwner'` renders `heading`+`body` and **NO buy button even when `buyLabel`/`onBuy` are passed** (the guard is on `variant`, not on prop presence); `onDismiss` fires from the dismiss affordance when provided. Run → FAIL.
- [ ] **Step 3 — implement** `PurchasePrompt.tsx`: `owner` = a calm panel with the buy path (preset `Button`s → `onBuy(quantity)`, clamped 1–100) + optional dismiss; `nonOwner` = a calm notice (heading+body only, the "campaign's owner is out of session credits" message), NO buy CTA. Square/paper register. Run tests → PASS.
- [ ] **Step 4 — story:** owner variant (buy path) + non-owner variant (calm notice); desktop + ~375px. Barrel export.
- [ ] **Step 5 — commit** `feat(MYT-95): PurchasePrompt (owner buy path / non-owner calm notice) + MYT-92 seam`.

---

## Task 11: web — Sessions & Billing settings surface

**Files:**
- Modify: `frontend/src/routes/settings.tsx` (fill the stub — mount the billing section under a Suspense boundary)
- Create: `frontend/src/routes/settings/sessions-billing.tsx` (the composed billing surface), `frontend/src/routes/settings/redirect-to.ts` (a mockable `redirectTo(url)` wrapper over `window.location.assign`)
- Modify: `frontend/client-core/src/i18n/locales/en/common.json` + `frontend/client-core/src/i18n/descriptions.ts` (new keys, lockstep)
- Test: `frontend/src/routes/settings/sessions-billing.test.tsx`, `frontend/src/routes/settings/__stories__` (screen story)

**Interfaces:**
- Consumes: `useBalance`, `useSkus`, `useHistory`, `createCheckout`, `openPortal`, `upgradeTier` (Task 3); `balanceView`, `subscriptionTiers`, `aLaCarteSkus`, `subscriptionCta`, `purchaseHistoryView` (Tasks 4–6); `CreditBalance`, `PackList`, `PurchaseHistory` (Tasks 7–9); `useApiContext`.
- Produces: the `/settings` billing surface — both balances, subscription state, tiers with gated CTAs, à-la-carte, portal link, purchase history.

- [ ] **Step 1 — add i18n keys** (`common.json` + `descriptions.ts` lockstep), all `[ph: …]` values, e.g.:
  - `billing.sectionTitle` "[ph: sessions & billing]"
  - `billing.sessionLabel` "[ph: session credits]", `billing.worldGenLabel` "[ph: world credits]"
  - `billing.subscribe` "[ph: subscribe]", `billing.upgrade` "[ph: upgrade]", `billing.manage` "[ph: manage]", `billing.current` "[ph: current plan]", `billing.buy` "[ph: buy]"
  - `billing.pricePerMonth` "[ph: {{price}} / mo]", `billing.priceEach` "[ph: {{price}} each]"
  - `billing.history.title` "[ph: purchase history]", `billing.history.empty` "[ph: no purchases yet]"
  - `billing.history.purchase` "[ph: purchase — {{amount}}]", `billing.history.subscription` "[ph: {{tier}} — {{amount}}]", `billing.history.refund` "[ph: refund — {{amount}}]", `billing.history.refundedSuffix` "[ph: (refunded)]"
  - `billing.portalLink` "[ph: manage billing & payment methods]"
  - `billing.pendingUpgrade` "[ph: an upgrade is already processing — it'll settle shortly]"
- [ ] **Step 2 — write failing tests** (RTL + MSW): the section renders `CreditBalance` with both buckets from a mocked balance; renders the three tiers by their `displayName` with the CTA gating applied (subscriber sees upgrade/manage, NOT subscribe); clicking a `subscribe` tier calls `createCheckout` with `{ items:[{ lookup_key:<tier>, quantity:1 }], success_url, cancel_url }` and redirects; clicking `upgrade` calls `upgradeTier({ target_tier_lookup_key })`; a 409 `upgrade_already_pending` renders the calm `billing.pendingUpgrade` arm (no error toast); clicking `manage`/the portal link calls `openPortal` and redirects; the à-la-carte buy calls `createCheckout` with `sku_session` + the chosen quantity; the history feed renders terse rows (pack row shows "purchase — $X", NO credit count). Run → FAIL.
- [ ] **Step 3 — implement** `sessions-billing.tsx`:
  - Read `useBalance()`, `useSkus()`, `useHistory()` (all suspense — the parent wraps in `<Suspense>`).
  - Derive `balanceView`, `subscriptionTiers`, `aLaCarteSkus`, and per-tier `subscriptionCta({ activeSubscription: balance.active_subscription, targetTierLookupKey: tier.lookup_key, skus })`.
  - Format prices/money via `Intl.NumberFormat(i18n.language, { style:'currency', currency })` (mechanical, ZFC-exempt).
  - Build success/cancel URLs: `` `${window.location.origin}/billing/return` `` / `` `${window.location.origin}/billing/cancelled` `` (the Task 12 routes).
  - `onTierCta(lookupKey, cta)`: `subscribe` → `createCheckout(ctx, { items:[{ lookup_key: lookupKey, quantity:1 }], success_url, cancel_url })` then `redirectTo(res.url)`; `upgrade` → `upgradeTier(ctx, { target_tier_lookup_key: lookupKey })` then invalidate `['billing','balance']` (on 409 `upgrade_already_pending` set the calm pending flag); `manage` → `openPortal(ctx, { return_url: window.location.href })` then `redirectTo(res.url)`.
  - `onBuyAlaCarte(lookupKey, quantity)` → `createCheckout` (session pack) → `redirectTo`.
  - `PurchaseHistory` rows: map `purchaseHistoryView(events, skus)` → `{ id, label, refunded }` where `label = t(row.kind === 'invoice' && row.tierDisplayName ? 'billing.history.subscription' : row.kind === 'refund' ? 'billing.history.refund' : 'billing.history.purchase', { tier: row.tierDisplayName, amount: formatMoney(row.amountCents, row.currency) })`.
  - `redirectTo` lives in `redirect-to.ts` (`export function redirectTo(url: string): void { window.location.assign(url) }`) so tests mock it.
- [ ] **Step 4 — fill `settings.tsx`** to render `<Heading>{t('billing.sectionTitle')}</Heading>` + `<Suspense fallback={<Spinner …/>}><SessionsBilling/></Suspense>` (the surface degrades gracefully like `HeaderCredits`). Run tests → PASS.
- [ ] **Step 5 — screen story** (settings billing surface, subscriber + non-subscriber, desktop + ~375px). Storybook browser sweep stays CI-gated.
- [ ] **Step 6 — commit** `feat(MYT-95): Sessions & Billing settings surface (balances, gated tiers, à-la-carte, portal, history)`.

---

## Task 12: web — checkout-return routes

**CONTROLLER DECISION (ambiguities 1+2 resolved):** the shipped header already satisfies the spec — `HeaderCredits` renders the SESSION bucket (`data.session`) and the header `+` already navigates to settings, which IS the "quiet path to the purchase surface." MYT-95 therefore touches NO header/app-frame file: no quick-buy popover (richer than spec'd; MYT-99 restyles this area anyway), no `HeaderCredits` refactor (zero-value regression surface on MYT-87 chrome). The `CreditBalance` DS component (Task 7) serves the settings surface only. The §7 app-frame 92↔95 collision is hereby DISSOLVED — 92 is the file's only wave-1 writer.

**Files:**
- Create: `frontend/src/routes/billing/checkout-return.tsx`, `frontend/src/routes/billing/checkout-cancelled.tsx`
- Modify: `frontend/src/app/router.tsx` (**SINGLE WAVE-1 WRITER, §7** — add `billing/return` + `billing/cancelled` under the authed AppFrame branch)
- Modify: `common.json` + `descriptions.ts` (lockstep)
- Test: co-located tests for `checkout-return`, `checkout-cancelled`, and a router wiring assertion

**Interfaces:**
- Consumes: `useCheckoutReturn` (Task 6).
- Produces: the two return routes with the pinned terminal states.

- [ ] **Step 1 — add i18n keys** (lockstep): `billing.return.polling` "[ph: confirming your purchase…]", `billing.return.settled` "[ph: credits added — you're all set]", `billing.return.processing` "[ph: purchase processing — your credits will appear shortly]", `billing.return.viewHistory` "[ph: view purchase history]", `billing.cancelled.title` "[ph: checkout cancelled]", `billing.cancelled.body` "[ph: no charge was made — pick up where you left off]", `billing.cancelled.back` "[ph: back to billing]".
- [ ] **Step 2 — write failing tests:**
  - `checkout-return`: `status:'polling'` renders the polling copy; `'settled'` renders the settled copy; `'processing'` renders the calm processing copy WITH the history link and NO error framing (mock `useCheckoutReturn` to return each).
  - `checkout-cancelled`: renders the cancelled copy + a back-to-billing affordance; asserts it is NOT an error surface.
  - router: `buildRoutes(false)` (prod) contains `billing/return` and `billing/cancelled` under the AppFrame child.
  Run → FAIL.
- [ ] **Step 3 — implement:**
  - `checkout-return.tsx`: `const { status } = useCheckoutReturn()`; render the polling/settled/processing beat per status; `processing` links to the settings history. `checkout-cancelled.tsx`: the calm cancelled notice + back-to-billing.
  - `router.tsx`: add `{ path: 'billing/return', element: <CheckoutReturnRoute /> }` and `{ path: 'billing/cancelled', element: <CheckoutCancelledRoute /> }` under the AppFrame `children` (authed).
  Run tests → PASS.
- [ ] **Step 4 — commit** `feat(MYT-95): checkout-return routes (pinned terminal states)`.

---

## Task 13: PATCH (controller applies POST-91-MERGE) — campaign-card owner-only low-credit treatment

**⚠ DO NOT IMPLEMENT IN THE 95 WORKTREE.** `frontend/src/routes/home/home-card.tsx` is OWNED by MYT-91 (it restructures the card's live party data). This task is a **self-contained patch the controller applies to the MERGED home-card after 91 lands** (spec §4 + §7), reconciling with 91's restructure. The full code below is the patch intent; the controller applies it, runs the card's tests, and commits it as part of the 95 merge.

**Files (patched by the controller, post-91-merge):**
- Modify: `frontend/src/routes/home/home-card.tsx` (add the owner-only low-credit line)
- Modify: `frontend/src/routes/home.tsx` (read `useBalance`, pass the low-credit prop to owned cards)
- Modify: `common.json` + `descriptions.ts` (lockstep): `home.card.lowCredits` "[ph: low on session credits — top up to start a session]"
- Test: `frontend/src/routes/home/home-card.test.tsx` (extend)

**Interfaces:**
- Consumes: `CampaignSummary` (`creator: string | null` — **`null` ⇔ the viewer is the owner**, per the shipped card's "creator shows only on a joined world" invariant); `useBalance` (Task 3 / MYT-87). `SESSION_START_COST = 1` (a session-start debits ONE session credit).
- Produces: an owner-only quiet mono low-credit line on the card foot.

- [ ] **Step 1 — failing test:** `CampaignCard` with `creator: null` (owner) + `lowOnSessionCredits: true` renders the `home.card.lowCredits` line; with `creator: 'Ana'` (joined, non-owner) + `lowOnSessionCredits: true` it does NOT (no member-visible owner-balance treatment); with owner + `false` it does not. Run → FAIL.
- [ ] **Step 2 — patch `home-card.tsx`:** add `lowOnSessionCredits?: boolean` to the card props; in the foot `Stack`, after the state line, render (reconciled with 91's foot layout):
```tsx
{creator === null && lowOnSessionCredits ? (
  <Text role="meta" data-testid="card-low-credits">
    {t('home.card.lowCredits')}
  </Text>
) : null}
```
- [ ] **Step 3 — patch `home.tsx`:** read the session balance once and pass it down (owner-only is enforced in the card by the `creator === null` guard, so the boolean can be passed to every card):
```tsx
const { data: balance } = useBalance()
// CONTROLLER DECISION (ambiguity 4): "low" warns BEFORE empty — threshold <= 1
// (one session left or none). One [ph:] key covers both; the 0-vs-1 prose split
// is the MYT-100 copy pass's call.
<CampaignCard campaign={c} lowOnSessionCredits={balance.session <= 1} />
```
  (The home route already renders inside a Suspense boundary; `useBalance` is the shared cached query the header already warms — no extra fetch. If 91's home route shape differs, the controller adapts the prop-passing site.)
- [ ] **Step 4 — run** the home-card + home tests → PASS.
- [ ] **Step 5 — controller commits** `feat(MYT-95): campaign-card owner-only low-credit treatment` (as part of the 95 merge).

---

## Task 14: E2E done-when (verbatim) + verification battery

**Controller-driven.** Not an implementer bead — the full-gate + the real wire-level E2E on the dev stack.

- [ ] **Verification battery:** `pnpm --filter @mythrun/contract test`; `pnpm --filter @mythrun/client-core test` + scoped coverage (100×4) for the new `billing/` modules; `pnpm --filter @mythrun/ui test` + the four new component stories; the web route tests; `pnpm typecheck` (incl. `--filter @mythrun/dev-tool typecheck` if any manifest changed — none expected here, no backend routes); `pnpm lint` (`eslint src`, type-aware); the i18n `resources.test.ts` drift test (every new key documented in `descriptions.ts`); the Storybook browser sweep for the new screens.
- [ ] **E2E done-when (spec §4, verbatim):** "E2E on dev with Stripe test mode (**precondition: the Stripe CLI webhook forwarder is running** — without it credits never land and the smoke must fail the precondition check, not hang): pack checkout round-trip credits the ledger and the UI reflects it; subscription checkout as a NEW subscriber works; the CTA gating renders upgrade-tier/portal (not checkout) for an already-subscribed test user; portal opens; the out-of-credits arm renders the owner prompt on a drained owner account; history lists real rows."
  - Drive it with a real browser (Playwright asserting observable end state) + `psql` on `credit_ledger`/`billing_history` where the flow writes. Confirm the webhook-forwarder precondition FIRST (Task 1 Step 2); fail-loud if absent.
- [ ] **Wiki sync** (the AUTHORING.md subagent) → then the single push; flip Linear MYT-95 to Done. (Per the deferred-design-review regime, §7: NO per-feature visual-audit stop — structural/register rules still bind.)

---

## Self-review

**Spec §4 coverage:**
- Client-core billing slices + view-models (balance two buckets; checkout; upgrade-tier; portal; history) → Tasks 3, 4, 6.
- Subscription CTA gating (required criterion; already-subscribed user cannot reach plain checkout, pinned by test) → Task 5.
- PurchasePrompt owner/non-owner (non-owner NO buy CTA) + the 402-mapping unit-tested against `{code:'insufficient_credits', available, required}` + the exported MYT-92 seam → Tasks 6 + 10.
- Sessions & Billing settings (both buckets; Wayfarer/Sojourner/Mythwright + pay-as-you-go; NO best-value labels; portal; terse history with pack rows carrying no credit counts) → Task 11 (+ components 7–9).
- Header session-credit display + quiet path to the purchase surface → ALREADY SHIPPED (MYT-87 HeaderCredits + the header `+` → settings); Task 12 carries only the checkout-return routes.
- Checkout-return routes with pinned terminal states (poll balance; changed → settled; budget expired → calm NON-error processing → history) → Tasks 6 (hook) + 12 (routes).
- Campaign-card low-credit OWNER-ONLY, authored as a standalone controller-applied post-91 patch → Task 13.
- Trial-end DROPPED (declared) — no task, correct.
- Live session-start 402 wiring NOT ours (92 wires) — Task 10 seam only, correct.
- Verify-first bead (curl-probe + webhook forwarder precondition, notes file) → Task 1. E2E done-when verbatim → Task 14.

**Placeholder scan:** load-bearing logic (contract schemas, slices, tier catalogue, balance VM, gating, history VM, 402 mapping, poll hook) is inline and complete; UI/web tasks carry exact prop contracts + test intent + register rules + i18n keys. No "TBD". The one deliberately-deferred item (pagination load-more) is named, not stubbed.

**Type consistency:** `LookupKey`, `SkuListing`, `BillingHistoryEvent`, `BalanceView`, `TierCtaDecision`/`SubscriptionCta`, `HistoryRowView`, `InsufficientCreditsError`/`PurchasePromptModel`, `CheckoutBody`/`PortalBody`/`UpgradeTierBody`, `SubscriptionTierView`/`AlaCarteView`/`PackListProps`, `CreditBalanceProps`, `PurchaseHistoryProps`, `PurchasePromptProps`, `CheckoutReturnStatus` are used consistently across producing/consuming tasks. `subscriptionCta`/`tierRank`/`balanceView`/`purchaseHistoryView`/`purchasePromptModel`/`useCheckoutReturn` names match between definition and consumption. Handler names are neutral (`onTierCta`/`onBuyAlaCarte`/`onBuy`/`onDismiss`).

**Collisions declared:** `app-frame.tsx` (header region, vs 92's content variant), `router.tsx` (95 single wave-1 writer), `home-card.tsx` (91-owned → Task 13 controller patch), append-only barrels + i18n — all flagged per §7.
