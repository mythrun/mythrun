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

import type { FastifyPluginAsync } from 'fastify'
import type { Pool } from 'pg'
import { createUsersRepo } from '../repo/users.js'
import { grantInTx } from '../repo/credits.js'
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
  if (typeof body !== 'object' || body === null) return null
  const u = (body as { username?: unknown }).username
  const d = (body as { displayName?: unknown }).displayName
  if (typeof u !== 'string' || u.length < 3 || u.length > 20) return null
  if (typeof d !== 'string' || d.length < 1 || d.length > 40) return null
  return { username: u, displayName: d }
}

function parseUsernameQuery(query: unknown): string | null {
  if (typeof query !== 'object' || query === null) return null
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

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (route registration is synchronous), so the rule is
// disabled here per existing precedent in auth/bypass-plugin.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const usersRoutes: FastifyPluginAsync<Opts> = async (app, opts) => {
  const users = createUsersRepo(opts.pool)

  app.post(
    '/api/users/register',
    {
      config: {
        auth: 'jwt-no-db',
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ code: 'unauthenticated' })
      }

      const parsed = parseRegisterBody(request.body)
      if (!parsed) {
        return reply.code(400).send({ code: 'username_invalid', reason: 'format' })
      }
      const { username, displayName } = parsed

      if (!isValidUsernameFormat(username)) {
        return reply.code(400).send({ code: 'username_invalid', reason: 'format' })
      }

      const usernameProfanity = await classifyProfanity(username)
      if (usernameProfanity.profane) {
        return reply.code(400).send({
          code: 'username_invalid',
          reason: usernameProfanity.reason ?? 'profane',
        })
      }

      const displayProfanity = await classifyProfanity(displayName)
      if (displayProfanity.profane) {
        return reply.code(400).send({
          code: 'display_name_invalid',
          reason: 'profane',
        })
      }

      // Per spec §8: open a transaction, create the users row, grant the
      // trial credit, flip free_trial_used. All three writes must succeed
      // or none — otherwise we get an "onboarded user without trial credit"
      // wedge state that the existing-user short-circuit can never recover
      // from on re-registration.
      //
      // The classifyProfanity calls above MUST stay outside this tx (per
      // Sphinx I2 round 2) — they are 200–800ms LLM calls and holding a
      // PoolClient open across them is a DoS amplifier on `max=10`.
      const client = await opts.pool.connect()
      let inTransaction = false
      try {
        await client.query(
          "BEGIN; SET LOCAL transaction_isolation = 'read committed'; SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s'",
        )
        inTransaction = true

        const user = await users.create(client, {
          cognitoSub: request.user.sub,
          username: username.trim(),
          displayName: displayName.trim(),
        })
        await grantInTx(client, {
          userId: user.id,
          creditType: 'session',
          amount: 1,
          sourceType: 'trial',
          sourceId: null,
          expiresAt: null,
          sourcePurchaseId: null,
          sourceBillingHistoryId: null,
        })
        await client.query('UPDATE users SET free_trial_used = true WHERE id = $1', [
          user.id,
        ])
        await client.query('COMMIT')
        inTransaction = false

        // Stitch the post-COMMIT free_trial_used into the response shape so
        // the body reflects state-at-end-of-tx. Re-reading is wasted I/O —
        // the only column we just changed is the flag.
        const userResponse = { ...user, freeTrialUsed: true }
        return await reply
          .header('Location', '/api/users/me')
          .code(201)
          .send({ user: userResponse, created: true })
      } catch (err) {
        if (inTransaction) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Connection may already be in failed state; pool will recycle.
          }
          inTransaction = false
        }
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as { code?: string }).code === '23505'
        ) {
          const constraint = (err as { constraint?: string }).constraint ?? ''
          if (constraint === 'users_cognito_sub_key') {
            // Re-fetch via the pool (NOT the released client) — the
            // tx is already rolled back and the client is about to be
            // released in `finally`.
            const existing = await users.getByCognitoSub(request.user.sub)
            if (!existing) {
              return await reply.code(500).send({ code: 'inconsistent_state' })
            }
            if (existing.username.toLowerCase() === username.trim().toLowerCase()) {
              return await reply
                .header('Content-Location', '/api/users/me')
                .code(200)
                .send({ user: existing, created: false })
            }
            return await reply.code(409).send({
              code: 'already_onboarded',
              currentUsername: existing.username,
              requestedUsername: username.trim(),
            })
          }
          if (constraint === 'users_username_lower_key') {
            let suggestion = generateSuggestion(username.trim())
            for (let attempt = 0; attempt < 3; attempt++) {
              const r = await classifyProfanity(suggestion)
              if (!r.profane) break
              suggestion = generateSuggestion(username.trim())
            }
            return await reply.code(409).send({ code: 'username_taken', suggestion })
          }
        }
        throw err
      } finally {
        client.release()
      }
    },
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
          reason: profanity.reason ?? 'profane',
        })
      }

      const existing = await users.getByUsername(username)
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
    const user = await users.getByCognitoSub(request.user.sub)
    if (!user) {
      return reply.code(403).send({ code: 'username_required' })
    }
    return reply.send({ user })
  })
}
