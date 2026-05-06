// backend/src/routes/billing.ts
//
// MYT-42 billing routes plugin. Routes are added task by task (Tasks 25–31).
// Current routes:
//   - GET  /api/billing/skus          (Task 25) — public pricing catalogue
//   - GET  /api/billing/balance        (Task 26) — JWT, credit balances + active sub summary
//   - GET  /api/billing/subscription   (Task 27) — JWT, full active subscription row or null
//   - GET  /api/billing/history        (Task 28) — JWT, cursor-paginated billing audit feed
//   - POST /api/billing/checkout       (Task 29) — JWT, cart → Stripe Checkout Session
//
// Subsequent tasks add: /portal, /upgrade-tier.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Stripe } from 'stripe'
import type { Env } from '../config/env.js'
import { getSkuCache } from '../billing/sku-cache.js'
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

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('t' in parsed) ||
    !('i' in parsed)
  ) {
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

  const listOpts =
    cursorResult !== undefined
      ? { cursor: cursorResult, limit: 50 }
      : { limit: 50 }
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

function isReplied(
  result: unknown,
): result is { readonly _replied: FastifyReply } {
  return typeof result === 'object' && result !== null && '_replied' in result
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
  const cusResult = await withStripeUnavailable(request, reply, userId, 'findOrCreateStripeCustomer',
    () => findOrCreateStripeCustomer(pool, stripe, userId))
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
  const sessionResult = await withStripeUnavailable(request, reply, userId, 'checkout.sessions.create',
    () => stripe.checkout.sessions.create(params))
  if (isReplied(sessionResult)) return sessionResult._replied

  return reply.code(200).send({ checkout_session_id: sessionResult.id, url: sessionResult.url })
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (route registration is synchronous), so the rule is
// disabled here per existing precedent in auth/bypass-plugin.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const billingRoutes: FastifyPluginAsync<BillingRoutesOpts> = async (scope, opts) => {
  const repo = createRepo(opts.pool)

  scope.get('/api/billing/skus', {
    config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (_request, reply) => {
    const cache = getSkuCache()
    if (cache === null) {
      // Defensive only — the boot probe gates app.ready() so any request
      // reaching this route should see a populated cache.
      return reply.code(503).send({ code: 'sku_cache_unavailable' })
    }
    return reply
      .header('Cache-Control', 'public, max-age=300')
      .send(cache.publicListing)
  })

  scope.get('/api/billing/balance', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, (request, reply) => handleBalance(opts.pool, repo, request, reply))

  scope.get('/api/billing/subscription', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, (request, reply) => handleSubscription(opts.pool, repo, request, reply))

  scope.get('/api/billing/history', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, (request, reply) => handleHistory(opts.pool, repo, request, reply))

  scope.post('/api/billing/checkout', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, (request, reply) => handleCheckout(opts.pool, repo, opts.env, request, reply))

  // Subsequent tasks 30-31 add: /portal, /upgrade-tier
}
