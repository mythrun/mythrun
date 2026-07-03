// backend/src/routes/campaign-preview.ts
//
// MYT-89 Task A3 — POST /api/campaigns/synthesize-preview.
//
// The guided world-creation flow's first backend call. The client posts 3
// media-picks; this route synthesizes an ORIGINAL concept (Sonnet), runs the
// content/quality input gate, and — on pass — parks the gated concept in
// Redis under a `previewId` WITHOUT charging a credit. The credit is charged
// later, at commit (the create route). So this is a NON-charging preview: a
// user can synthesize and rework a concept before committing ~10 minutes of
// world generation.
//
// Guard order (cost-control, non-negotiable — a 0-credit user must hit ZERO
// LLM calls):
//   1. Zod body parse (guided-only, exactly 3 picks)                → 400
//   2. rate-limit (5/min per user, @fastify/rate-limit, route-level)→ 429
//   3. rejection-storm cooldown (read-only Redis peek)              → 429
//   4. credit balance peek (NON-charging, BEFORE any LLM call)      → 403
//   5. synthesize (Sonnet)
//   6. input gate (Sonnet)                                          → 422
//   7. putPreview + 201 { previewId, concept }
//
// IDOR (load-bearing): the AUTHENTICATED user id (requireDbUser(request).id)
// is baked into the preview key — never a client-supplied id — so a preview is
// only ever readable by the user who synthesized it.
//
// Registered as its own plugin in app.ts (after requireOnboarded, like
// campaignsRoutes) so it inherits the JWT + onboarded gates. Kept separate
// from campaigns.ts to hold that module's size down. NOT a pipelineRoute — it
// is not a campaign-status surface (no stage gate, no SSE).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Logger as PinoLogger } from 'pino'
import { z } from 'zod'

import { createRepo } from '../repo/index.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { synthesizeConcept, SynthesizerPick } from '../llm/prep/synthesize-concept.js'
import { runInputGate } from '../llm/prep/input-gate.js'
import { createRejectionStormCounter } from '../auth/rejection-storm.js'
import { putPreview } from '../preview/preview-store.js'
import { checkRejectionStorm, handleGateRejection } from './concept-gate.js'

export interface CampaignPreviewOpts {
  readonly pool: Pool
  readonly redis: Redis
  readonly redisKeyPrefix: string
}

// Guided-only body: the preview flow always carries exactly 3 media-picks.
// Unknown shapes / wrong pick counts produce a standard 400 from Zod.
const SynthesizePreviewBodySchema = z.object({
  picks: z.array(SynthesizerPick).length(3),
})

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only the synchronous app.post registration).
// eslint-disable-next-line @typescript-eslint/require-await
export const campaignPreviewRoutes: FastifyPluginAsync<CampaignPreviewOpts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const stormCounter = createRejectionStormCounter(opts.redis, opts.redisKeyPrefix)

  app.post(
    '/api/campaigns/synthesize-preview',
    {
      config: {
        // Per-USER cap: 5 previews/min (mirrors POST /api/campaigns). Below
        // what the cost controls tolerate, but enough to block adversarial
        // Sonnet-burn loops that try to slip past the storm cooldown.
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string => {
            try {
              return requireDbUser(req).id
            } catch {
              return req.ip
            }
          },
        },
      },
    },
    async (request, reply) => {
      // Step 1: body validation (guided-only, exactly 3 picks).
      const parsed = SynthesizePreviewBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_body', issues: parsed.error.issues })
      }
      const dbUser = requireDbUser(request)

      // Step 3: rejection-storm cooldown (read-only; the increment happens
      // only on a later 422). Rejects the cheapest way — before any LLM call.
      const stormCheck = await checkRejectionStorm(opts.redis, opts.redisKeyPrefix, dbUser.id)
      if (stormCheck.cooldownActive) {
        reply.header('Retry-After', String(stormCheck.retryAfterSeconds))
        return reply.code(429).send({ code: 'rejection_storm_cooldown' })
      }

      // Step 4: credit balance peek — NON-charging, and BEFORE any LLM call so
      // a 0-credit user burns ZERO Sonnet tokens (the cost-control fix). No
      // debit here; the credit is charged later at commit.
      const peekBalance = await repo.credits.getWorldGenBalance(dbUser.id)
      if (peekBalance < 1) {
        return reply.code(403).send({ code: 'insufficient_credits', creditType: 'world_gen' })
      }

      // Step 5: synthesize an original concept (Sonnet).
      const synth = await synthesizeConcept(parsed.data.picks)

      // Step 6: input gate. On reject: 422 with synthesizedConcept (guided).
      const gate = await runInputGate({ concept: synth.concept, intentSummary: synth.intentSummary })
      if (gate.verdict === 'reject') {
        return handleGateRejection({
          reply,
          gate,
          userId: dbUser.id,
          mode: 'guided',
          synthesizedConcept: synth.concept,
          stormIncrementer: () => stormCounter.incrementAndCheck(dbUser.id),
          logger: request.log as PinoLogger,
        })
      }

      // Step 7: park the gated concept in Redis under a fresh previewId, keyed
      // to the AUTHENTICATED user (IDOR-safe). reworkCount starts at 0 — a
      // later rework (A4) bumps it to 1.
      const previewId = await putPreview(opts.redis, dbUser.id, {
        concept: synth.concept,
        intentSummary: synth.intentSummary,
        reworkCount: 0,
      })

      return reply.code(201).send({ previewId, concept: synth.concept })
    },
  )
}
