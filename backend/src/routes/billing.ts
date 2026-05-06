// backend/src/routes/billing.ts
//
// MYT-42 billing routes plugin. Routes are added task by task (Tasks 25–31).
// Current routes:
//   - GET /api/billing/skus          (Task 25) — public pricing catalogue
//   - GET /api/billing/balance        (Task 26) — JWT, credit balances + active sub summary
//   - GET /api/billing/subscription   (Task 27) — JWT, full active subscription row or null
//   - GET /api/billing/history        (Task 28) — JWT, cursor-paginated billing audit feed
//
// Subsequent tasks add: /checkout, /portal, /upgrade-tier.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { getSkuCache } from '../billing/sku-cache.js'
import { createRepo, type Repo } from '../repo/index.js'
import { userSubscriptions } from '../repo/user-subscriptions.js'
import { billingHistory } from '../repo/billing-history.js'

export interface BillingRoutesOpts {
  readonly pool: Pool
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

  // Subsequent tasks 29-31 add: /checkout, /portal, /upgrade-tier
}
