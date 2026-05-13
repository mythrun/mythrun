// backend/src/routes/dev-credits.ts
//
// MYT-51 Task 11. Dev-only POST /api/dev/credits/grant.
//
// Spec: docs/superpowers/specs/2026-05-12-myt-51-world-gen-non-streaming-design.md
// D13 (revised after Roc-C1). Force-grants `world_gen` or `session` credits
// to the fixed bypass identity (`bypass:dev-1`). Used by:
//   - The dev tool's credit-ledger panel (force-grant button).
//   - The cost-cap smoke loop (run gen, breaker fires + refunds; grant
//     additional credits, repeat).
//
// Multi-layer gating (defense in depth — Roc-C1):
//   1. The plugin itself registers no route when AUTH_MODE !== 'bypass' —
//      the plugin export is process-env-gated at register time.
//   2. T12's app.ts wiring also gates registration on AUTH_MODE === 'bypass'
//      (belt-and-suspenders against a future caller forgetting either gate).
//   3. The bypass auth plugin's six runtime layers (NODE_ENV allow-list,
//      ECS metadata probe, no-Cognito-config check, per-request re-check,
//      Terraform-forced AUTH_MODE=real in serving modules, plugin tests)
//      mean production never reaches a request handler here even if the
//      gates above regressed.
//
// Identity: grants to the currently-active dev sub (via request.user.sub,
// which the bypass plugin sets from x-mythrun-dev-sub or its default).
// Originally pinned to `bypass:dev-1` per spec D13 / Roc-C1's "drop the
// header" guidance, but that produced "grant succeeds → credits go to a
// sub the user can never spend them as" UX. The security concern Roc-C1
// raised (a buggy test header-spoofing to grant credits to an attacker
// sub) is moot: this route is bypass-mode-gated by 6 plugin layers, no
// production exposure exists, and even in dev the credits aren't
// fungible to anything real. Honoring the header matches every other
// dev route's behavior and removes the dead-end UX. Unknown sub → 400.
//
// Rate limit: 30 req / hour per IP. Even in dev, a buggy test hammering
// this route shouldn't run unbounded — and the cost-cap smoke loop's
// "grant + retry" cycle is naturally well under that ceiling.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import { createRepo } from '../repo/index.js'
import { insertCreditGrant } from '../repo/credit-grants.js'

export interface DevCreditsRoutesOpts {
  readonly pool: Pool
}

// Strict body schema per spec D13. `z.number().int().positive().max(100)`
// refuses non-integer, zero, negative, and >100 inputs — the hard 100 cap
// exists so even a runaway dev script can't move the ledger by more than
// a single SKU's worth of credits per request.
const GrantBodySchema = z
  .object({
    creditType: z.enum(['world_gen', 'session']),
    amount: z.number().int().positive().max(100),
  })
  .strict()

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (the AUTH_MODE check + app.post call are synchronous),
// matching the precedent in auth/bypass-plugin.ts and routes/sessions.ts.
// eslint-disable-next-line @typescript-eslint/require-await
export const devCreditsRoutes: FastifyPluginAsync<DevCreditsRoutesOpts> = async (app, opts) => {
  // Plugin-level AUTH_MODE gate. Belt-and-suspenders with the app.ts
  // wiring gate (T12) — if any future caller forgets the outer guard,
  // this inner guard still keeps the route off production.
  if (process.env.AUTH_MODE !== 'bypass') {
    return
  }

  const repo = createRepo(opts.pool)

  app.post(
    '/api/dev/credits/grant',
    {
      config: {
        // Per-IP cap. The dev tool runs locally (one IP); the cost-cap
        // smoke loop runs from CI (one egress IP). 30/hour is well above
        // legitimate dev usage and well below the threshold a runaway
        // script could reach in a tight loop.
        rateLimit: {
          max: 30,
          timeWindow: '1 hour',
          keyGenerator: (req: FastifyRequest): string => req.ip,
        },
      },
    },
    async (request, reply) => {
      const parsed = GrantBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_body',
          issues: parsed.error.issues,
        })
      }
      const { creditType, amount } = parsed.data

      // The bypass auth plugin sets request.user.sub from the
      // x-mythrun-dev-sub header (or its default). Grant to that user.
      const sub = request.user?.sub
      if (typeof sub !== 'string' || sub.length === 0) {
        return reply.code(401).send({ code: 'no_dev_identity' })
      }
      const user = await repo.users.getByCognitoSub(sub)
      if (!user) {
        return reply.code(400).send({ code: 'unknown_dev_sub', sub })
      }

      const result = await insertCreditGrant(opts.pool, {
        userId: user.id,
        creditType,
        amount,
      })

      return reply.code(201).send({
        ledgerId: result.ledgerId,
        newBalance: result.newBalance,
      })
    },
  )
}
