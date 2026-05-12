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
// Identity: this route does NOT honor `x-mythrun-dev-sub`. Credit grants
// always target `bypass:dev-1`. The dev tool's identity switcher selects
// the active sub for normal API calls; credit grants are pinned to the
// canonical bypass identity so the dev tool's credit-ledger panel always
// works regardless of which sub is currently selected. If a dev needs
// credits as a non-default sub, they edit the DB directly (the smoke-test
// setup script already does this).
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

// Fixed identity for dev-mode credit grants (spec D13). Mirrors the
// constant in auth/bypass-plugin.ts; restated literally here so this
// module is grep-discoverable without dereferencing the auth layer.
const BYPASS_DEV_SUB = 'bypass:dev-1'

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

      // Always resolve `bypass:dev-1` — spec D13 explicitly forbids
      // honoring the `x-mythrun-dev-sub` header here.
      const user = await repo.users.getByCognitoSub(BYPASS_DEV_SUB)
      if (!user) {
        // The bypass-dev user is expected to exist in any dev / test
        // environment that reaches this route (it's seeded by the local
        // dev setup script). Surface as 500 with a clear operator-facing
        // code rather than silently 404 — a missing seed user is a
        // configuration error, not a request error.
        return reply.code(500).send({ code: 'bypass_user_missing' })
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
