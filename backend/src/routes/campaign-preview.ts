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

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { Logger as PinoLogger } from 'pino'
import { z } from 'zod'

import { createRepo } from '../repo/index.js'
import { requireDbUser } from '../auth/require-db-user.js'
import { synthesizeConcept, SynthesizerPick } from '../llm/prep/synthesize-concept.js'
import { runInputGate } from '../llm/prep/input-gate.js'
import { reviseConcept } from '../llm/prep/revise-concept.js'
import { createRejectionStormCounter } from '../auth/rejection-storm.js'
import { getPreview, overwritePreview, putPreview } from '../preview/preview-store.js'
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

// Rework body: a single freeform change note. `.max(800)` mirrors the
// synthesizer's per-pick `whyILikeIt` bound — a change note is a sentence or
// two, not an essay.
const ReworkBodySchema = z.object({
  change: z.string().min(1).max(800),
})

// Per-USER cap: 5 requests/min (mirrors POST /api/campaigns). Below what the
// cost controls tolerate, but enough to block adversarial Sonnet-burn loops
// that try to slip past the storm cooldown. Shared verbatim by BOTH preview
// routes (synthesize-preview + rework) — each route gets its own @fastify/
// rate-limit bucket, so the caps are independent but identically shaped.
const previewRateLimit = {
  max: 5,
  timeWindow: '1 minute',
  keyGenerator: (req: FastifyRequest): string => {
    try {
      return requireDbUser(req).id
    } catch {
      return req.ip
    }
  },
}

// Cheap cost-control guards shared by BOTH preview routes, run BEFORE any LLM
// call so a cooling-down or 0-credit user burns ZERO Sonnet tokens:
//   - rejection-storm cooldown peek (read-only Redis)  → 429
//   - credit balance peek (NON-charging)               → 403
// SENDS the matching response and returns `true` when a guard trips (the caller
// then returns its reply to signal "handled"); returns `false` when both pass
// and the handler should proceed to load/LLM. The storm counter is INCREMENTED
// elsewhere (handleGateRejection, on a 422) — this is only the read-only peek.
// Reports a boolean rather than returning the reply because the bare
// `FastifyReply` type collapses to `never` under this repo's tsconfig, which
// would make a `!== null` nullability check on a returned reply always-false.
async function runPreviewCostGuards(args: {
  reply: FastifyReply
  redis: Redis
  redisKeyPrefix: string
  credits: { getWorldGenBalance(userId: string): Promise<number> }
  userId: string
}): Promise<boolean> {
  const stormCheck = await checkRejectionStorm(args.redis, args.redisKeyPrefix, args.userId)
  if (stormCheck.cooldownActive) {
    args.reply.header('Retry-After', String(stormCheck.retryAfterSeconds))
    args.reply.code(429).send({ code: 'rejection_storm_cooldown' })
    return true
  }
  const peekBalance = await args.credits.getWorldGenBalance(args.userId)
  if (peekBalance < 1) {
    args.reply.code(403).send({ code: 'insufficient_credits', creditType: 'world_gen' })
    return true
  }
  return false
}

// FastifyPluginAsync requires an async function shape; the body has no
// top-level await (only the synchronous app.post registration).
// eslint-disable-next-line @typescript-eslint/require-await
export const campaignPreviewRoutes: FastifyPluginAsync<CampaignPreviewOpts> = async (app, opts) => {
  const repo = createRepo(opts.pool)
  const stormCounter = createRejectionStormCounter(opts.redis, opts.redisKeyPrefix)

  app.post(
    '/api/campaigns/synthesize-preview',
    { config: { rateLimit: previewRateLimit } },
    async (request, reply) => {
      // Step 1: body validation (guided-only, exactly 3 picks).
      const parsed = SynthesizePreviewBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_body', issues: parsed.error.issues })
      }
      const dbUser = requireDbUser(request)

      // Steps 3–4: cheap cost-control guards BEFORE any LLM call — the
      // rejection-storm cooldown peek (429) and the NON-charging credit
      // balance peek (403). A cooling-down or 0-credit user burns ZERO Sonnet
      // tokens. No debit here; the credit is charged later at commit.
      if (
        await runPreviewCostGuards({
          reply,
          redis: opts.redis,
          redisKeyPrefix: opts.redisKeyPrefix,
          credits: repo.credits,
          userId: dbUser.id,
        })
      ) {
        return reply
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
      const previewId = await putPreview(opts.redis, opts.redisKeyPrefix, dbUser.id, {
        concept: synth.concept,
        intentSummary: synth.intentSummary,
        reworkCount: 0,
      })

      return reply.code(201).send({ previewId, concept: synth.concept })
    },
  )

  // POST /api/campaigns/preview/:previewId/rework
  //
  // The single-shot rework. After previewing a concept the player may request
  // ONE change; this revises the parked concept (Sonnet), re-runs the input
  // gate, and — ONLY on gate pass — overwrites the stored preview (bumping
  // reworkCount 0→1). A single-rework budget: a second attempt is 409.
  //
  // Guard order (cost-control mirrors synthesize-preview — a cooling-down or
  // 0-credit holder of a valid previewId must hit ZERO LLM calls, so a
  // rejection-producing rework loop can't burn Sonnet unbounded despite each
  // rejected rework correctly leaving reworkCount:0):
  //   1. Zod body parse ({ change })                                   → 400
  //   2. rate-limit (5/min per user, route-level)                      → 429
  //   3. rejection-storm cooldown (read-only Redis peek)               → 429
  //   4. credit balance peek (NON-charging, BEFORE any LLM call)       → 403
  //   5. load preview by (AUTH user id, previewId)                     → 410 (null)
  //   6. reworkCount ≥ 1 (budget spent)                                → 409
  //   7. reviseConcept (Sonnet)
  //   8. input gate (Sonnet)                                           → 422
  //   9. overwritePreview (sets reworkCount:1) + 200 { previewId, concept }
  //
  // Gate-pass-only mutation (load-bearing correctness invariant): a REJECTED
  // rework leaves the original gated concept AND reworkCount:0 untouched — the
  // player still holds their one budgeted change. The gate rejection still
  // INCREMENTS the storm counter (handleGateRejection), so repeated rejecting
  // reworks trip the cooldown at step 3 of the NEXT request. IDOR: the preview
  // key is baked with the AUTHENTICATED user id, so a cross-user previewId
  // simply misses → the uniform 410 (NOT 404 — same shape the commit returns).
  app.post<{ Params: { previewId: string } }>(
    '/api/campaigns/preview/:previewId/rework',
    { config: { rateLimit: previewRateLimit } },
    async (request, reply) => {
      const parsed = ReworkBodySchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_body', issues: parsed.error.issues })
      }
      const dbUser = requireDbUser(request)
      const { previewId } = request.params

      // Steps 3–4: cheap cost-control guards BEFORE any load/LLM work — the
      // rejection-storm cooldown peek (429) and the NON-charging credit balance
      // peek (403), identical to synthesize-preview. A cooling-down or 0-credit
      // user burns ZERO Sonnet tokens even holding a valid previewId.
      if (
        await runPreviewCostGuards({
          reply,
          redis: opts.redis,
          redisKeyPrefix: opts.redisKeyPrefix,
          credits: repo.credits,
          userId: dbUser.id,
        })
      ) {
        return reply
      }

      // Load by the authenticated user id (IDOR-safe; cross-user misses → 410).
      const preview = await getPreview(opts.redis, opts.redisKeyPrefix, dbUser.id, previewId)
      if (preview === null) {
        return reply.code(410).send({ code: 'preview_expired' })
      }

      // Single-rework budget: one change per preview.
      if (preview.reworkCount >= 1) {
        return reply.code(409).send({ code: 'rework_exhausted' })
      }

      // Revise (Sonnet) then re-gate. Nothing is persisted until the gate passes.
      const revised = await reviseConcept(preview.concept, parsed.data.change)
      const gate = await runInputGate({
        concept: revised.concept,
        intentSummary: revised.intentSummary,
      })
      if (gate.verdict === 'reject') {
        // 422 WITHOUT overwriting the stored concept or bumping reworkCount —
        // the original gated preview + the unspent budget survive.
        return handleGateRejection({
          reply,
          gate,
          userId: dbUser.id,
          mode: 'guided',
          synthesizedConcept: revised.concept,
          stormIncrementer: () => stormCounter.incrementAndCheck(dbUser.id),
          logger: request.log as PinoLogger,
        })
      }

      // Gate pass: overwrite the parked concept (sets reworkCount:1, resets TTL).
      await overwritePreview(opts.redis, opts.redisKeyPrefix, dbUser.id, previewId, {
        concept: revised.concept,
        intentSummary: revised.intentSummary,
        reworkCount: 1,
      })
      return reply.code(200).send({ previewId, concept: revised.concept })
    },
  )
}
