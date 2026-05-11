// backend/src/routes/billing.ts
/* eslint-disable max-lines -- All seven MYT-42 billing handlers live in one
 * plugin module by design (single registration site, shared private helpers
 * like resolveUserId / withStripeUnavailable / isReplied). Splitting per-
 * handler files would scatter those helpers and the SkuCache fixture surface
 * across many small modules. The 400-line cap is a heuristic; this file's
 * cohesion outweighs it. */
//
// MYT-42 billing routes plugin. Routes are added task by task (Tasks 25–31).
// Current routes:
//   - GET  /api/billing/skus          (Task 25) — public pricing catalogue
//   - GET  /api/billing/balance        (Task 26) — JWT, credit balances + active sub summary
//   - GET  /api/billing/subscription   (Task 27) — JWT, full active subscription row or null
//   - GET  /api/billing/history        (Task 28) — JWT, cursor-paginated billing audit feed
//   - POST /api/billing/checkout       (Task 29) — JWT, cart → Stripe Checkout Session
//   - POST /api/billing/portal         (Task 30) — JWT, Stripe Customer Portal session
//   - POST /api/billing/upgrade-tier   (Task 31) — JWT, monotonic tier upgrade via
//                                                  pending_if_incomplete proration.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Stripe } from 'stripe'
import type { Env } from '../config/env.js'
import { getSkuCache, type SkuInternalEntry } from '../billing/sku-cache.js'
import { getStripeClient } from '../billing/stripe-client.js'
import { findOrCreateStripeCustomer } from '../billing/customer.js'
import { LOOKUP_KEYS, type LookupKey } from '../billing/lookup-keys.js'
import { createRepo, type Repo } from '../repo/index.js'
import { userSubscriptions } from '../repo/user-subscriptions.js'
import { billingHistory } from '../repo/billing-history.js'

export interface BillingRoutesOpts {
  readonly pool: Pool
  readonly env: Env
}

// Resolve the caller's users.id from request.user.sub. Returns null and
// writes the appropriate error reply on failure (matching the pattern in
// routes/invites.ts).
async function resolveUserId(
  repo: Repo,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  if (!request.user) {
    reply.code(401).send({ code: 'unauthenticated' })
    return null
  }
  const user = await repo.users.getByCognitoSub(request.user.sub)
  if (!user) {
    reply.code(403).send({ code: 'username_required' })
    return null
  }
  return user.id
}

// Handler: GET /api/billing/balance
async function handleBalance(
  pool: Pool,
  repo: Repo,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const userId = await resolveUserId(repo, request, reply)
  if (userId === null) return reply

  const [session, world_gen, sub] = await Promise.all([
    repo.credits.balance(userId, 'session'),
    repo.credits.balance(userId, 'world_gen'),
    userSubscriptions.getActiveForUser(pool, userId),
  ])

  const active_subscription =
    sub === null
      ? null
      : {
          tier_lookup_key: sub.tier_lookup_key,
          current_period_end: sub.current_period_end.toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end,
          status: sub.status,
        }

  return reply.code(200).send({ session, world_gen, active_subscription })
}

interface HistoryCursor {
  readonly t: string
  readonly i: string
}

/**
 * Decode and validate the base64url-encoded cursor query param.
 * Returns the parsed cursor on success, 'invalid' on any failure, or
 * undefined when the param was not provided.
 */
function decodeCursor(raw: string | undefined): HistoryCursor | 'invalid' | undefined {
  if (raw === undefined) return undefined

  let json: string
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return 'invalid'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json) as unknown
  } catch {
    return 'invalid'
  }

  if (typeof parsed !== 'object' || parsed === null || !('t' in parsed) || !('i' in parsed)) {
    return 'invalid'
  }

  // TypeScript narrows parsed to `object & { t: unknown } & { i: unknown }`
  // after the `in` checks; destructuring is safe without assertion.
  const { t, i } = parsed
  if (typeof t !== 'string' || typeof i !== 'string') return 'invalid'
  return { t, i }
}

// Handler: GET /api/billing/history
async function handleHistory(
  pool: Pool,
  repo: Repo,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const userId = await resolveUserId(repo, request, reply)
  if (userId === null) return reply

  const rawCursor = (request.query as Record<string, string | undefined>).cursor
  const cursorResult = decodeCursor(rawCursor)
  if (cursorResult === 'invalid') {
    return reply.code(400).send({ code: 'invalid_cursor' })
  }

  const listOpts = cursorResult !== undefined ? { cursor: cursorResult, limit: 50 } : { limit: 50 }
  const { rows, nextCursor } = await billingHistory.listByUser(pool, userId, listOpts)

  const encodedNextCursor =
    nextCursor !== null ? Buffer.from(nextCursor, 'utf8').toString('base64url') : null

  const events = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    occurred_at: row.occurred_at.toISOString(),
    amount_cents: row.amount_cents,
    currency: row.currency,
    lookup_key: row.lookup_key,
    status: row.status,
    source_id_stripe: row.source_id_stripe,
  }))

  return reply.code(200).send({ events, nextCursor: encodedNextCursor })
}

// Handler: GET /api/billing/subscription
async function handleSubscription(
  pool: Pool,
  repo: Repo,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const userId = await resolveUserId(repo, request, reply)
  if (userId === null) return reply

  const sub = await userSubscriptions.getActiveForUser(pool, userId)

  const active_subscription =
    sub === null
      ? null
      : {
          tier_lookup_key: sub.tier_lookup_key,
          stripe_subscription_id: sub.stripe_subscription_id,
          status: sub.status,
          current_period_start: sub.current_period_start.toISOString(),
          current_period_end: sub.current_period_end.toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end,
          cancel_at: sub.cancel_at !== null ? sub.cancel_at.toISOString() : null,
        }

  return reply.code(200).send({ active_subscription })
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout (Task 29)
//
// Spec: §4.2 (cart validation) + §4.3 (Stripe Checkout Session creation).
// Body shape: { items: [{ lookup_key, quantity }], success_url, cancel_url }.
//
// Validation library note: this handler uses hand-written structural guards
// rather than Zod. Zod is not yet a runtime dependency (it lands with MYT-44's
// LLM wrapper layer); per the precedent set by routes/users.ts, small request
// shapes are validated inline so we don't add a dep the plan didn't pre-install.
// The structural-validation exception in the ZFC rule covers schema checks.
// ---------------------------------------------------------------------------

interface CheckoutItem {
  readonly lookup_key: LookupKey
  readonly quantity: number
}

interface CheckoutBody {
  readonly items: readonly CheckoutItem[]
  readonly success_url: string
  readonly cancel_url: string
}

const MAX_ITEMS = 100
const MAX_QTY = 100

function isLookupKey(value: unknown): value is LookupKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOOKUP_KEYS, value)
}

/**
 * Structural body validation. Returns the typed body on success, or null when
 * the shape is invalid in a way the route maps to 400 `body_invalid`.
 *
 * Note: an unknown lookup_key is NOT rejected here — it's a domain-level error
 * that maps to its own `unknown_lookup_key` code with the offending key in the
 * detail. This keeps the structural-vs-domain split clean.
 */
function parseCheckoutBody(body: unknown): CheckoutBody | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { items?: unknown; success_url?: unknown; cancel_url?: unknown }

  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MAX_ITEMS) return null
  if (typeof b.success_url !== 'string' || b.success_url.length === 0) return null
  if (typeof b.cancel_url !== 'string' || b.cancel_url.length === 0) return null

  const items: CheckoutItem[] = []
  for (const raw of b.items) {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as { lookup_key?: unknown; quantity?: unknown }
    if (typeof r.lookup_key !== 'string' || r.lookup_key.length === 0) return null
    if (
      typeof r.quantity !== 'number' ||
      !Number.isInteger(r.quantity) ||
      r.quantity < 1 ||
      r.quantity > MAX_QTY
    ) {
      return null
    }
    // lookup_key shape is OK; domain validity is checked downstream so the
    // route can return `unknown_lookup_key` with the offending key.
    items.push({ lookup_key: r.lookup_key as LookupKey, quantity: r.quantity })
  }

  return { items, success_url: b.success_url, cancel_url: b.cancel_url }
}

type CartValidationFailure =
  | { readonly code: 'unknown_lookup_key'; readonly lookup_key: string }
  | { readonly code: 'duplicate_lookup_key' }
  | { readonly code: 'mixed_cart' }
  | { readonly code: 'tier_cart_shape' }

interface CartValidationOk {
  readonly ok: true
  readonly mode: 'subscription' | 'payment'
}

interface CartValidationErr {
  readonly ok: false
  readonly failure: CartValidationFailure
}

/**
 * Apply the four server-side cart rules (per §4.2):
 *   1. Every lookup_key is in LOOKUP_KEYS.
 *   2. No duplicate lookup_key in the same cart.
 *   3. No mixed cart (recurring + one_time in the same cart).
 *   4. Tier cart shape: a recurring item must be the ONLY item with quantity 1.
 *
 * Order matters: unknown_lookup_key fires before duplicate so the offending
 * key in the detail is well-defined; mixed_cart and tier_cart_shape are
 * downstream of those.
 *
 * On success the derived Stripe Checkout `mode` is returned alongside.
 */
function validateCart(items: readonly CheckoutItem[]): CartValidationOk | CartValidationErr {
  // Rule 1: every lookup_key must be in the closed enum.
  for (const item of items) {
    if (!isLookupKey(item.lookup_key)) {
      return { ok: false, failure: { code: 'unknown_lookup_key', lookup_key: item.lookup_key } }
    }
  }

  // Rule 2: duplicate lookup_keys.
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.lookup_key)) {
      return { ok: false, failure: { code: 'duplicate_lookup_key' } }
    }
    seen.add(item.lookup_key)
  }

  // Rules 3 + 4: tier-vs-à-la-carte shape.
  let hasRecurring = false
  let hasOneTime = false
  for (const item of items) {
    const spec = LOOKUP_KEYS[item.lookup_key]
    if (spec.type === 'recurring') hasRecurring = true
    else hasOneTime = true
  }

  if (hasRecurring && hasOneTime) {
    return { ok: false, failure: { code: 'mixed_cart' } }
  }

  if (hasRecurring) {
    // Tier cart: must be a single line with quantity 1.
    const only = items[0]
    if (items.length !== 1 || only?.quantity !== 1) {
      return { ok: false, failure: { code: 'tier_cart_shape' } }
    }
    return { ok: true, mode: 'subscription' }
  }

  return { ok: true, mode: 'payment' }
}

/**
 * Resolve cart items against the SKU cache to Stripe `line_items` shape.
 * Returns null when the cache is missing an entry — defensive only; the boot
 * probe gates app.ready() so any item in LOOKUP_KEYS is also in the cache.
 */
function resolveLineItems(
  items: readonly CheckoutItem[],
): readonly { readonly price: string; readonly quantity: number }[] | null {
  const cache = getSkuCache()
  if (cache === null) return null

  const lineItems: { readonly price: string; readonly quantity: number }[] = []
  for (const item of items) {
    const entry = cache.byLookupKey.get(item.lookup_key)
    if (entry === undefined) return null
    lineItems.push({ price: entry.stripe_price_id, quantity: item.quantity })
  }
  return lineItems
}

/**
 * Build the Stripe Checkout Session params per §4.3. `subscription_data` is
 * set ONLY when mode='subscription' so the Stripe API doesn't reject it on a
 * payment-mode session. The `userId` metadata sits on both the session and
 * (for subs) the subscription itself — belt-and-suspenders fallback for
 * customer-id misses on `customer.subscription.*` events (§4.3).
 */
function buildCheckoutParams(args: {
  readonly mode: 'subscription' | 'payment'
  readonly cusId: string
  readonly userId: string
  readonly lineItems: readonly { readonly price: string; readonly quantity: number }[]
  readonly successUrl: string
  readonly cancelUrl: string
}): Stripe.Checkout.SessionCreateParams {
  const baseParams: Stripe.Checkout.SessionCreateParams = {
    mode: args.mode,
    customer: args.cusId,
    line_items: args.lineItems.map((li) => ({ price: li.price, quantity: li.quantity })),
    payment_method_types: ['card', 'link'],
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    metadata: { userId: args.userId },
  }
  return args.mode === 'subscription'
    ? { ...baseParams, subscription_data: { metadata: { userId: args.userId } } }
    : baseParams
}

/**
 * Wrap a Stripe SDK call so any thrown error becomes a 502 stripe_unavailable
 * reply (with structured logging). Centralizes the network-error handling
 * pattern the spec mandates for both Stripe API touchpoints in /checkout.
 */
async function withStripeUnavailable<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  where: string,
  call: () => Promise<T>,
): Promise<T | { readonly _replied: FastifyReply }> {
  try {
    return await call()
  } catch (err) {
    request.log.error({ err, userId, where }, 'billing.checkout_stripe_unavailable')
    return { _replied: reply.code(502).send({ code: 'stripe_unavailable' }) }
  }
}

function isReplied(result: unknown): result is { readonly _replied: FastifyReply } {
  return typeof result === 'object' && result !== null && '_replied' in result
}

// ---------------------------------------------------------------------------
// POST /api/billing/portal (Task 30)
//
// Spec: §4.4 — Customer Portal session creation.
// Body shape: { return_url: string }.
//
// Lazy-creates the Stripe customer if one doesn't exist yet (§4.4).
// ---------------------------------------------------------------------------

interface PortalBody {
  readonly return_url: string
}

function parsePortalBody(body: unknown): PortalBody | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { return_url?: unknown }
  if (typeof b.return_url !== 'string' || b.return_url.length === 0) return null
  return { return_url: b.return_url }
}

// Handler: POST /api/billing/portal
async function handlePortal(
  pool: Pool,
  repo: Repo,
  env: Env,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // 1. Body shape (structural).
  const parsed = parsePortalBody(request.body)
  if (parsed === null) {
    return reply.code(400).send({ code: 'body_invalid' })
  }

  // 2. Auth resolution.
  const userId = await resolveUserId(repo, request, reply)
  if (userId === null) return reply

  // 3. Find or lazy-create the Stripe customer.
  const stripe = getStripeClient(env)
  const cusResult = await withStripeUnavailable(
    request,
    reply,
    userId,
    'findOrCreateStripeCustomer',
    () => findOrCreateStripeCustomer(pool, stripe, userId),
  )
  if (isReplied(cusResult)) return cusResult._replied

  // 4. Create the portal session.
  const portalResult = await withStripeUnavailable(
    request,
    reply,
    userId,
    'billingPortal.sessions.create',
    () =>
      stripe.billingPortal.sessions.create({ customer: cusResult, return_url: parsed.return_url }),
  )
  if (isReplied(portalResult)) return portalResult._replied

  return reply.code(200).send({ url: portalResult.url })
}

// Handler: POST /api/billing/checkout
async function handleCheckout(
  pool: Pool,
  repo: Repo,
  env: Env,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // 1. Body shape (structural).
  const parsed = parseCheckoutBody(request.body)
  if (parsed === null) {
    return reply.code(400).send({ code: 'body_invalid' })
  }

  // 2. Cart rules (domain).
  const validation = validateCart(parsed.items)
  if (!validation.ok) {
    return reply.code(400).send(validation.failure)
  }

  // 3. Auth resolution.
  const userId = await resolveUserId(repo, request, reply)
  if (userId === null) return reply

  // 4. Resolve SKU cache → Stripe line_items.
  const lineItems = resolveLineItems(parsed.items)
  if (lineItems === null) {
    return reply.code(503).send({ code: 'sku_cache_unavailable' })
  }

  // 5. Stripe customer find-or-create per §9. MUST run BEFORE Checkout Session
  // create, OUTSIDE any held DB tx. The helper internally splits into a short
  // read tx + Stripe call + short write tx.
  const stripe = getStripeClient(env)
  const cusResult = await withStripeUnavailable(
    request,
    reply,
    userId,
    'findOrCreateStripeCustomer',
    () => findOrCreateStripeCustomer(pool, stripe, userId),
  )
  if (isReplied(cusResult)) return cusResult._replied

  // 6. Build + create the Checkout Session.
  const params = buildCheckoutParams({
    mode: validation.mode,
    cusId: cusResult,
    userId,
    lineItems,
    successUrl: parsed.success_url,
    cancelUrl: parsed.cancel_url,
  })
  const sessionResult = await withStripeUnavailable(
    request,
    reply,
    userId,
    'checkout.sessions.create',
    () => stripe.checkout.sessions.create(params),
  )
  if (isReplied(sessionResult)) return sessionResult._replied

  return reply.code(200).send({ checkout_session_id: sessionResult.id, url: sessionResult.url })
}

// ---------------------------------------------------------------------------
// POST /api/billing/upgrade-tier (Task 31)
//
// Spec: §4.6 — monotonic tier upgrade. Body shape: { target_tier_lookup_key }.
//
// Flow (per spec §4.6 lines 218–328):
//   1. Validate body structurally → 400 body_invalid.
//   2. Resolve user; load active subscription → 400 no_active_subscription.
//   3. Validate target tier exists in the SKU cache → 400 unknown_lookup_key.
//   4. Both tiers must be type='recurring' and target.unit_amount_cents must
//      be strictly greater than current.unit_amount_cents (equal →
//      tier_unchanged, less → not_an_upgrade; one_time mixed in →
//      not_an_upgrade because a tier upgrade to a one-off is malformed).
//   5. Retrieve the live Stripe subscription. If pending_update is already
//      populated (a prior upgrade is mid-flight), return 409
//      upgrade_already_pending so the caller doesn't double-charge.
//   6. Call subscriptions.update with payment_behavior='pending_if_incomplete'
//      and proration_date=current_period_start (period-start proration is the
//      load-bearing knob that makes the upgrade non-gameable; see §4.6 sanity
//      check at lines 318–325).
//   7. Inspect the response's pending_update: populated → items did NOT
//      advance (card decline / SCA / async settlement) → 502
//      upgrade_payment_pending. Null → items advanced; webhook
//      (customer.subscription.pending_update_applied — Task 22) does the
//      credit grant + tier upsert. Return 200 immediately.
//
// Idempotency-key shape: `upgrade:<userId>:<sub_id>:<target>`. Per Petra I1
// round 8, period_start is DELIBERATELY omitted (period-boundary double-click
// would otherwise yield two distinct keys → potential double-charge). The
// `tier_unchanged` early-exit at step 4 covers the post-COMMIT replay case
// where Stripe's 24h idempotency cache has expired but our DB shows the new
// tier.
// ---------------------------------------------------------------------------

interface UpgradeTierBody {
  readonly target_tier_lookup_key: string
}

function parseUpgradeTierBody(body: unknown): UpgradeTierBody | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { target_tier_lookup_key?: unknown }
  if (typeof b.target_tier_lookup_key !== 'string' || b.target_tier_lookup_key.length === 0) {
    return null
  }
  return { target_tier_lookup_key: b.target_tier_lookup_key }
}

/**
 * Read the value from `subscription.latest_invoice` as a wire-shape string ID
 * or null. Stripe's type is `string | Invoice | null`; we only emit the ID
 * (the route owner shape never returns the expanded object). Per spec lines
 * 297–299 (`latest_invoice_id` field).
 */
function readLatestInvoiceId(subscription: Stripe.Subscription): string | null {
  const li = subscription.latest_invoice
  if (typeof li === 'string') return li
  if (li !== null && typeof li.id === 'string') return li.id
  return null
}

/**
 * Map a Stripe `pending_update` to the wire `detail` shape returned alongside
 * the 409/502 codes. Used by both the already-pending pre-check (409) and the
 * post-update payment-pending path (502).
 */
function pendingUpdateDetail(subscription: Stripe.Subscription): {
  readonly pending_update_expires_at: string
  readonly latest_invoice_id: string | null
} {
  const pu = subscription.pending_update
  if (pu === null) {
    // Defensive — caller only invokes this when pending_update is populated.
    throw new Error('pendingUpdateDetail called with null pending_update')
  }
  return {
    pending_update_expires_at: new Date(pu.expires_at * 1000).toISOString(),
    latest_invoice_id: readLatestInvoiceId(subscription),
  }
}

interface UpgradeTierTargets {
  readonly target: SkuInternalEntry
  readonly current: SkuInternalEntry
}

/**
 * Lookup the SKU cache for both target + current tier; apply the
 * monotonic-upgrade rule (target > current, strictly). Returns the resolved
 * tier pair on success or a typed failure for the caller to map to a status.
 *
 * The current tier is always expected to exist in the SKU cache (the boot
 * probe verifies every LOOKUP_KEYS entry has a Stripe price). A miss is a
 * structural-invariant violation — surface 503 sku_cache_unavailable.
 */
type TierResolveOutcome =
  | { readonly ok: true; readonly targets: UpgradeTierTargets }
  | {
      readonly ok: false
      readonly status: 400
      readonly code: 'unknown_lookup_key' | 'tier_unchanged' | 'not_an_upgrade'
    }
  | { readonly ok: false; readonly status: 503; readonly code: 'sku_cache_unavailable' }

function resolveUpgradeTiers(
  targetLookupKey: string,
  currentLookupKey: string,
): TierResolveOutcome {
  const cache = getSkuCache()
  if (cache === null) {
    return { ok: false, status: 503, code: 'sku_cache_unavailable' }
  }
  // The body's target_tier_lookup_key arrives as an unconstrained string; an
  // unknown one is a domain error (mapped to unknown_lookup_key). Narrow via
  // isLookupKey first so the cache lookup is well-typed and we don't lean on
  // a type assertion against the Map's key type.
  if (!isLookupKey(targetLookupKey)) {
    return { ok: false, status: 400, code: 'unknown_lookup_key' }
  }
  const target = cache.byLookupKey.get(targetLookupKey)
  if (target === undefined) {
    // Defensive — isLookupKey passed, so LOOKUP_KEYS has an entry. A missing
    // SKU cache entry means the boot probe didn't populate this key — surface
    // as 503 so deploys catch the drift.
    return { ok: false, status: 503, code: 'sku_cache_unavailable' }
  }
  // The active subscription's tier_lookup_key is persisted as a plain string
  // in user_subscriptions (no DB FK; see migration 007). Narrow before lookup.
  if (!isLookupKey(currentLookupKey)) {
    // The subscription was upserted from Stripe with a lookup_key our code
    // doesn't know about — same root cause as a missing SKU cache entry.
    return { ok: false, status: 503, code: 'sku_cache_unavailable' }
  }
  const current = cache.byLookupKey.get(currentLookupKey)
  if (current === undefined) {
    return { ok: false, status: 503, code: 'sku_cache_unavailable' }
  }
  // Both must be recurring tiers. A target sku_session/sku_world on a tier
  // upgrade is malformed — map to not_an_upgrade.
  if (target.type !== 'recurring' || current.type !== 'recurring') {
    return { ok: false, status: 400, code: 'not_an_upgrade' }
  }
  // Monotonic upgrade rule: strict `>`. Equal → tier_unchanged. Less → not_an_upgrade.
  if (target.price.unit_amount_cents === current.price.unit_amount_cents) {
    return { ok: false, status: 400, code: 'tier_unchanged' }
  }
  if (target.price.unit_amount_cents < current.price.unit_amount_cents) {
    return { ok: false, status: 400, code: 'not_an_upgrade' }
  }
  return { ok: true, targets: { target, current } }
}

// Handler: POST /api/billing/upgrade-tier
async function handleUpgradeTier(
  pool: Pool,
  repo: Repo,
  env: Env,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // 1. Body shape (structural).
  const parsed = parseUpgradeTierBody(request.body)
  if (parsed === null) {
    return reply.code(400).send({ code: 'body_invalid' })
  }

  // 2. Auth resolution.
  const userId = await resolveUserId(repo, request, reply)
  if (userId === null) return reply

  // 3. Active subscription.
  const activeSub = await userSubscriptions.getActiveForUser(pool, userId)
  if (activeSub === null) {
    return reply.code(400).send({ code: 'no_active_subscription' })
  }

  // 4. Target/current tier resolution + monotonic upgrade rule.
  const tiers = resolveUpgradeTiers(parsed.target_tier_lookup_key, activeSub.tier_lookup_key)
  if (!tiers.ok) {
    return reply.code(tiers.status).send({ code: tiers.code })
  }

  const stripe = getStripeClient(env)

  // 5. Retrieve live Stripe subscription. A pre-existing pending_update means
  // a prior upgrade is mid-flight — refuse the second attempt with 409 to
  // avoid double-charging. Network/5xx errors map to 502 stripe_unavailable.
  const retrieveResult = await withStripeUnavailable(
    request,
    reply,
    userId,
    'subscriptions.retrieve',
    () =>
      stripe.subscriptions.retrieve(activeSub.stripe_subscription_id, {
        expand: ['items.data.price'],
      }),
  )
  if (isReplied(retrieveResult)) return retrieveResult._replied
  const subscription = retrieveResult

  if (subscription.pending_update !== null) {
    return reply.code(409).send({
      code: 'upgrade_already_pending',
      detail: pendingUpdateDetail(subscription),
    })
  }

  const item = subscription.items.data[0]
  if (item === undefined) {
    // Defensive — Mythrun never creates multi-item subs and Stripe always
    // returns at least one item on a non-deleted subscription. Surface as
    // stripe_unavailable so the user can retry.
    request.log.error(
      { userId, stripe_subscription_id: activeSub.stripe_subscription_id },
      'billing.upgrade_tier_subscription_item_missing',
    )
    return reply.code(502).send({ code: 'stripe_unavailable' })
  }
  const subscriptionItemId = item.id
  const periodStart = item.current_period_start

  // 6. Issue the upgrade with pending_if_incomplete + proration_date=period_start.
  // idempotency-key composes (userId, sub_id, target_tier) — period_start is
  // DELIBERATELY OMITTED per Petra I1 round 8 (see file-top comment + §4.6).
  const idempotencyKey = `upgrade:${userId}:${activeSub.stripe_subscription_id}:${parsed.target_tier_lookup_key}`

  // The mythrun/no-stripe-subscription-price-mutation rule was written under
  // the MYT-41 design where ALL tier switches went through Customer Portal.
  // MYT-42 round-7 (spec §4.6) reintroduces direct subscriptions.update for
  // monotonic UPGRADES specifically — Customer Portal can't set
  // proration_date=current_period_start, which is the load-bearing knob that
  // makes the upgrade non-gameable (see §4.6 sanity check, lines 318–325).
  // Downgrades still go through Portal Switch Plan; the asymmetry is by
  // design (spec §4.6 line 327). This is the ONLY app-code site that may
  // mutate items[].price.
  const updateResult = await withStripeUnavailable(
    request,
    reply,
    userId,
    'subscriptions.update',
    () =>
      // eslint-disable-next-line mythrun/no-stripe-subscription-price-mutation
      stripe.subscriptions.update(
        activeSub.stripe_subscription_id,
        {
          items: [{ id: subscriptionItemId, price: tiers.targets.target.stripe_price_id }],
          proration_date: periodStart,
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        },
        { idempotencyKey },
      ),
  )
  if (isReplied(updateResult)) return updateResult._replied
  const updated = updateResult

  // 7. Inspect pending_update on the response.
  if (updated.pending_update !== null) {
    return reply.code(502).send({
      code: 'upgrade_payment_pending',
      detail: pendingUpdateDetail(updated),
    })
  }

  // Items advanced; the proration invoice settled synchronously. The
  // pending_update_applied webhook (Task 22) handles the credit grant + tier
  // upsert. Frontend polls /api/billing/balance for the post-grant state.
  return reply.code(200).send({ invoice_id: readLatestInvoiceId(updated) })
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (route registration is synchronous), so the rule is
// disabled here per existing precedent in auth/bypass-plugin.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const billingRoutes: FastifyPluginAsync<BillingRoutesOpts> = async (scope, opts) => {
  const repo = createRepo(opts.pool)

  scope.get(
    '/api/billing/skus',
    {
      config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (_request, reply) => {
      const cache = getSkuCache()
      if (cache === null) {
        // Defensive only — the boot probe gates app.ready() so any request
        // reaching this route should see a populated cache.
        return reply.code(503).send({ code: 'sku_cache_unavailable' })
      }
      return reply.header('Cache-Control', 'public, max-age=300').send(cache.publicListing)
    },
  )

  scope.get(
    '/api/billing/balance',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    (request, reply) => handleBalance(opts.pool, repo, request, reply),
  )

  scope.get(
    '/api/billing/subscription',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    (request, reply) => handleSubscription(opts.pool, repo, request, reply),
  )

  scope.get(
    '/api/billing/history',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    (request, reply) => handleHistory(opts.pool, repo, request, reply),
  )

  scope.post(
    '/api/billing/checkout',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    (request, reply) => handleCheckout(opts.pool, repo, opts.env, request, reply),
  )

  scope.post(
    '/api/billing/portal',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    (request, reply) => handlePortal(opts.pool, repo, opts.env, request, reply),
  )

  scope.post(
    '/api/billing/upgrade-tier',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    (request, reply) => handleUpgradeTier(opts.pool, repo, opts.env, request, reply),
  )
}
