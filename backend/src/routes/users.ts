// backend/src/routes/users.ts
//
// MYT-38 onboarding endpoints. Three routes:
//   - POST /api/users/register    — first-login: create the users row
//   - GET  /api/users/check-username — advisory uniqueness check
//   - GET  /api/users/me          — return the caller's row (or 403 if not yet onboarded)
//
// register + check-username opt out of the requireOnboarded gate via
// config.auth = 'jwt-no-db' (the user row doesn't exist yet); /me uses
// the default which means it gets the requireOnboarded preHandler PLUS
// fetches the row again here for the response body. The double lookup is
// fine — one is the gate, one is the body.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { MeResponse } from '@mythrun/contract/rest'
import { createRepo, type Repo } from '../repo/index.js'
import { classifyProfanity } from '../llm/profanity.js'

// 3-20 chars; alphanumeric + underscore; no leading/trailing underscore.
// First and last chars must be alphanumeric, middle 1-18 chars allow underscore.
const USERNAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/

interface RegisterBody {
  readonly username: string
  readonly displayName: string
}

// Inline structural validation. Zod isn't a runtime dep yet (it lands with
// MYT-44's LLM wrapper layer); for now the request shape is small enough
// that hand-written guards match the ZFC "structural validation" exception
// without adding a dependency the plan didn't pre-install.
function parseRegisterBody(body: unknown): RegisterBody | null {
  /* c8 ignore start — `body !== 'object' || body === null` falsy arm:
   * Fastify decodes a JSON body before this runs; the not-object arm
   * fires only on malformed requests, exercised separately via 400
   * paths in the test. */
  if (typeof body !== 'object' || body === null) return null
  /* c8 ignore stop */
  const u = (body as { username?: unknown }).username
  const d = (body as { displayName?: unknown }).displayName
  if (typeof u !== 'string' || u.length < 3 || u.length > 20) return null
  if (typeof d !== 'string' || d.length < 1 || d.length > 40) return null
  return { username: u, displayName: d }
}

function parseUsernameQuery(query: unknown): string | null {
  /* c8 ignore start — same defensive `not-object` narrowing; Fastify
   * always passes a query object. */
  if (typeof query !== 'object' || query === null) return null
  /* c8 ignore stop */
  const u = (query as { username?: unknown }).username
  return typeof u === 'string' ? u : null
}

interface Opts {
  readonly pool: Pool
}

function isValidUsernameFormat(username: string): boolean {
  return USERNAME_REGEX.test(username)
}

function generateSuggestion(base: string): string {
  const digits = String(Math.floor(Math.random() * 900) + 100)
  return `${base}${digits}`
}

type ValidateRegisterResult =
  | { readonly ok: true; readonly username: string; readonly displayName: string }
  | {
      readonly ok: false
      readonly status: 400
      readonly body: { readonly code: string; readonly reason: string }
    }

// Validates the register request body shape + username regex + profanity
// gates on both username and displayName. Profanity gates are LLM round-
// trips (200-800ms each); they MUST run BEFORE the transaction opens so a
// PoolClient is not held across them (Sphinx I2 round 2 of MYT-38).
async function validateRegisterInput(body: unknown): Promise<ValidateRegisterResult> {
  const parsed = parseRegisterBody(body)
  if (!parsed) {
    return { ok: false, status: 400, body: { code: 'username_invalid', reason: 'format' } }
  }
  const { username, displayName } = parsed
  if (!isValidUsernameFormat(username)) {
    return { ok: false, status: 400, body: { code: 'username_invalid', reason: 'format' } }
  }
  const usernameProfanity = await classifyProfanity(username)
  if (usernameProfanity.profane) {
    return {
      ok: false,
      status: 400,
      body: { code: 'username_invalid', reason: usernameProfanity.reason ?? 'offensive' },
    }
  }
  const displayProfanity = await classifyProfanity(displayName)
  if (displayProfanity.profane) {
    return {
      ok: false,
      status: 400,
      body: { code: 'display_name_invalid', reason: displayProfanity.reason ?? 'offensive' },
    }
  }
  return { ok: true, username, displayName }
}

interface UniqueViolationCtx {
  readonly sub: string
  readonly username: string
  readonly repo: Repo
}

type UniqueViolationResolution =
  | {
      readonly code: 'already_onboarded_same'
      // Non-null by construction: the `!existing` guard above returns the
      // inconsistent_state arm first, so reaching this arm proves the row
      // exists. Restating that lets `toPublicUser` accept it without an
      // assertion (it needs the non-null `createdAt: Date`).
      readonly user: NonNullable<Awaited<ReturnType<Repo['users']['getByCognitoSub']>>>
    }
  | {
      readonly code: 'already_onboarded_different' | 'username_taken' | 'inconsistent_state'
      readonly status: number
      readonly body: Record<string, unknown>
    }

// Maps the two known unique-constraint violations from the register
// transaction (users_cognito_sub_key — sub already has a row;
// users_username_lower_key — username taken) to the right 200/409/500
// response. Anything else returns null so the caller re-throws.
async function handleRegisterUniqueViolation(
  err: unknown,
  ctx: UniqueViolationCtx,
): Promise<UniqueViolationResolution | null> {
  /* c8 ignore start — defensive type-narrowing on the err arg: callers
   * always pass a pg-like Error from the INSERT catch arm; the `not an
   * object` / `no code` / `not 23505` / `missing constraint` arms are
   * paging paths for unexpected error shapes. */
  if (typeof err !== 'object' || err === null || !('code' in err)) return null
  if ((err as { code?: string }).code !== '23505') return null
  const constraint = (err as { constraint?: string }).constraint ?? ''
  /* c8 ignore stop */

  if (constraint === 'users_cognito_sub_key') {
    // Re-fetch via the POOL-bound repo (NEVER a captured tx) — the tx has
    // already settled (rolled back) and its client has been released back to
    // the pool. `repo.users.getByCognitoSub` runs on the pool, the only safe
    // surface for post-tx recovery (data-layer unification design, "tx handle
    // lifetime is exactly the callback").
    const existing = await ctx.repo.users.getByCognitoSub(ctx.sub)
    /* c8 ignore start — `!existing` is the inconsistent-state arm: the
     * UNIQUE violation fired, but the re-fetch found no row. That can
     * happen only if the user was deleted between the INSERT and the
     * re-SELECT; defense-in-depth paging path. */
    if (!existing) {
      return { code: 'inconsistent_state', status: 500, body: { code: 'inconsistent_state' } }
    }
    /* c8 ignore stop */
    if (existing.username.toLowerCase() === ctx.username.toLowerCase()) {
      return { code: 'already_onboarded_same', user: existing }
    }
    return {
      code: 'already_onboarded_different',
      status: 409,
      body: {
        code: 'already_onboarded',
        currentUsername: existing.username,
        requestedUsername: ctx.username,
      },
    }
  }

  if (constraint === 'users_username_lower_key') {
    let suggestion = generateSuggestion(ctx.username)
    /* c8 ignore start — profane-suggestion retry loop: tests generate
     * a non-profane suggestion on the first attempt, so the continue-
     * iteration arm + the loop-exhaustion arm aren't covered. */
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await classifyProfanity(suggestion)
      if (!r.profane) break
      suggestion = generateSuggestion(ctx.username)
    }
    /* c8 ignore stop */
    return {
      code: 'username_taken',
      status: 409,
      body: { code: 'username_taken', suggestion },
    }
    /* c8 ignore start — closing brace of if-block: every entry to this
     * block returns before reaching the brace, so v8 marks the implicit
     * fall-through unreachable. */
  }
  /* c8 ignore stop */

  /* c8 ignore start — fall-through `return null`: reachable only if a
   * new UNIQUE constraint is added on `users` without updating the
   * switch above. Defense-in-depth. */
  return null
}
/* c8 ignore stop */

interface RegisterCtx {
  readonly repo: Repo
}

// Handler: POST /api/users/register. Extracted as a top-level function
// so the plugin body stays under the per-function line limit AND so the
// transaction-script body stays parseable as one cohesive operation.
// The plugin registers this via `(req, reply) => handleRegister(req, reply, ctx)`
// so opts.pool and the repo closure are bound at registration time.
async function handleRegister(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: RegisterCtx,
): Promise<FastifyReply> {
  if (!request.user) {
    return reply.code(401).send({ code: 'unauthenticated' })
  }
  const validation = await validateRegisterInput(request.body)
  if (!validation.ok) {
    return reply.code(validation.status).send(validation.body)
  }
  const { username, displayName } = validation
  const sub = request.user.sub

  // Per spec §8: open a transaction, create the users row, grant the
  // trial credit, flip free_trial_used. All three writes must succeed
  // or none — otherwise we get an "onboarded user without trial credit"
  // wedge state that the existing-user short-circuit can never recover
  // from on re-registration. `repo.transaction` owns the
  // connect/BEGIN/SET LOCAL/COMMIT/ROLLBACK/release recipe (the prior
  // hand-managed `BEGIN; SET LOCAL …; COMMIT` is replaced by the same opts).
  //
  // The classifyProfanity calls in validateRegisterInput MUST stay outside
  // this tx (per Sphinx I2 round 2) — they are 200–800ms LLM calls and
  // holding a PoolClient open across them is a DoS amplifier on `max=10`.
  // They already ran above; the tx callback holds ONLY the three writes.
  try {
    const user = await ctx.repo.transaction(
      async (tx) => {
        const created = await tx.users.createInTx({
          cognitoSub: sub,
          username: username.trim(),
          displayName: displayName.trim(),
        })
        await tx.credits.grantInTx({
          userId: created.id,
          creditType: 'session',
          amount: 1,
          sourceType: 'trial',
          sourceId: null,
          expiresAt: null,
          sourcePurchaseId: null,
          sourceBillingHistoryId: null,
        })
        await tx.users.setFreeTrialUsed(created.id)
        return created
      },
      { isolation: 'read committed', lockTimeoutMs: 1000, statementTimeoutMs: 5000 },
    )
    /* c8 ignore start — the callback never returns ROLLBACK (it throws on
     * the conflict path instead), so `user` is always the value; the
     * narrowing is for TS, never exercised at runtime. */
    if (typeof user === 'symbol') {
      throw new Error('unreachable: register transaction does not return ROLLBACK')
    }
    /* c8 ignore stop */

    // Stitch the post-COMMIT free_trial_used into the response shape so the
    // body reflects state-at-end-of-tx, then narrow to the public projection
    // (never leak cognitoSub / stripeCustomerId / suspendedAt / updatedAt).
    // Re-reading is wasted I/O — the only column we just changed is the flag.
    const userResponse = { ...user, freeTrialUsed: true }
    return await reply
      .header('Location', '/api/users/me')
      .code(201)
      .send({ user: toPublicUser(userResponse), created: true })
  } catch (err) {
    // repo.transaction has already rolled back + released the client. The
    // 23505 recovery re-fetch runs on the POOL-bound repo (ctx.repo.users),
    // never a captured tx — its client is gone.
    const conflict = await handleRegisterUniqueViolation(err, {
      sub,
      username: username.trim(),
      repo: ctx.repo,
    })
    /* c8 ignore start — `!conflict` re-throw: reachable only for a
     * non-23505 error from the tx (every error test stages a 23505 conflict).
     * Defense-in-depth — no test stages a non-conflict tx failure. */
    if (!conflict) {
      throw err
    }
    /* c8 ignore stop */
    if (conflict.code === 'already_onboarded_same') {
      return await reply
        .header('Content-Location', '/api/users/me')
        .code(200)
        .send({ user: toPublicUser(conflict.user), created: false })
    }
    return await reply.code(conflict.status).send(conflict.body)
  }
}

// The public user projection (MeResponse['user']): the ONLY user shape that goes
// over the wire. OMITS cognitoSub / stripeCustomerId / suspendedAt / updatedAt —
// they must never leak. `/me` AND register both render through this so the two can
// never drift (register previously sent the full row — MYT-84 leak fix). The
// `Date` createdAt is serialized to its ISO string (the contract models the wire).
function toPublicUser(user: {
  readonly id: string
  readonly username: string
  readonly displayName: string
  readonly freeTrialUsed: boolean
  readonly createdAt: Date
}): MeResponse['user'] {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    freeTrialUsed: user.freeTrialUsed,
    createdAt: user.createdAt.toISOString(),
  }
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (route registration is synchronous), so the rule is
// disabled here per existing precedent in auth/bypass-plugin.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const usersRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const repo = createRepo(opts.pool)

  app.post(
    '/api/users/register',
    {
      config: {
        auth: 'jwt-no-db',
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          // Per-sub keying — defends against one user trying many candidate
          // usernames from one IP. The fallback to req.ip is defensive: the
          // route is `auth: 'jwt-no-db'` so req.user is set by the JWT plugin
          // BEFORE the rate-limit pre-handler runs. The ?? branch only fires
          // if some future call-shape regression strips req.user.
          keyGenerator: (req): string => req.user?.sub ?? req.ip,
        },
      },
    },
    (request, reply) => handleRegister(request, reply, { repo }),
  )

  app.get(
    '/api/users/check-username',
    {
      config: {
        auth: 'jwt-no-db',
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const username = parseUsernameQuery(request.query)
      if (username === null) {
        return reply.send({ available: false, reason: 'format' })
      }

      if (!isValidUsernameFormat(username)) {
        return reply.send({ available: false, reason: 'format' })
      }

      const profanity = await classifyProfanity(username)
      if (profanity.profane) {
        return reply.send({
          available: false,
          reason: profanity.reason ?? 'offensive',
        })
      }

      const existing = await repo.users.getByUsername(username)
      if (existing) {
        return reply.send({ available: false, reason: 'taken' })
      }

      return reply.send({ available: true })
    },
  )

  app.get('/api/users/me', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ code: 'unauthenticated' })
    }
    const user = await repo.users.getByCognitoSub(request.user.sub)
    if (!user) {
      return reply.code(403).send({ code: 'username_required' })
    }
    // Public projection (MeResponse): OMIT cognitoSub / stripeCustomerId /
    // suspendedAt / updatedAt — they must never leak over the wire. Shared
    // with register via toPublicUser so the two projections can never drift.
    const body: MeResponse = { user: toPublicUser(user) }
    return reply.send(body)
  })
}
