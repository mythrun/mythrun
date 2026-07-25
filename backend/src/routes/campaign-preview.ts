// backend/src/routes/campaign-preview.ts
//
// MYT-89 Task A3 — POST /api/campaigns/synthesize-preview.
//
// World creation's PROPOSAL checkpoint. The client posts either 3 media-picks
// (the brainstorm path) or its own concept text (the freeform path, myth-6t06f);
// this route synthesizes an ORIGINAL concept (Sonnet), runs the content/quality
// input gate, and — on pass — parks the gated concept in Redis under a
// `previewId` WITHOUT charging a credit. The credit is charged later, at commit
// (the create route). So this is a NON-charging preview: a user can synthesize
// and rework a concept before committing ~10 minutes of world generation.
//
// Guard order (cost-control, non-negotiable — a 0-credit user must hit ZERO
// LLM calls):
//   1. Zod body parse (3 picks, or a 20..4000 concept)              → 400
//   2. rate-limit (5/min per user, @fastify/rate-limit, route-level)→ 429
//   3. rejection-storm cooldown (read-only Redis peek)              → 429
//   4. credit balance peek (NON-charging, BEFORE any LLM call)      → 403
//   5. FREEFORM ONLY: input gate on the player's RAW words (Sonnet) → 422
//   6. synthesize (Sonnet)
//   7. BRAINSTORM ONLY: input gate on the synthesis (Sonnet)        → 422
//   8. putPreview + 201 { previewId, title, concept }
//
// WHERE THE GATE SITS, per path (myth-6t06f). Brainstorm has no raw words worth
// gating — its input is three media titles — so it gates what it wrote. Freeform
// gates the player's OWN text, BEFORE the synthesis: that is the exact check the
// create route ran on this text before the checkpoint existed (a synthesis in
// between could launder a concept the gate would have rejected), and it keeps
// the abusive-input path at one cheap call instead of a full synthesis. Each
// path therefore runs exactly ONE gate call, as it always did.
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
import {
  synthesizeConcept,
  synthesizeFromConcept,
  SynthesizerPick,
} from '../llm/prep/synthesize-concept.js'
import { runInputGate } from '../llm/prep/input-gate.js'
import { reviseConcept } from '../llm/prep/revise-concept.js'
import { createRejectionStormCounter } from '../auth/rejection-storm.js'
import {
  getPreview,
  overwritePreview,
  putPreview,
  type PreviewRecord,
} from '../preview/preview-store.js'
import { checkRejectionStorm, handleGateRejection } from './concept-gate.js'

export interface CampaignPreviewOpts {
  readonly pool: Pool
  readonly redis: Redis
  readonly redisKeyPrefix: string
}

// The proposal body — ONE of the funnel's two inputs (myth-6t06f):
//   - `{ picks }`   the brainstorm path's exactly-3 media picks;
//   - `{ concept }` the freeform path's own world description (bounds mirror
//                   the create route's freeform source: 20..4000).
// Both synthesize into the same `SynthesizerOutput`, so everything downstream
// (gate, preview store, wire, proposal UI) is shape-identical. Unknown shapes /
// wrong pick counts produce a standard 400 from Zod. Exported for the STREAMED
// sibling route (campaign-preview-stream.ts, myth-umggn) so both transports
// validate the identical body.
export const SynthesizePreviewBodySchema = z.union([
  z.object({ picks: z.array(SynthesizerPick).length(3) }),
  z.object({ concept: z.string().min(20).max(4000) }),
])
export type SynthesizePreviewBody = z.infer<typeof SynthesizePreviewBodySchema>

/** Which funnel path a proposal body came from. The freeform arm gates the
 *  player's RAW words before synthesizing (see `runPreviewCostGuards`'s
 *  cost-control sibling note at the call sites); the brainstorm arm has no raw
 *  words to gate — its picks are media titles — so it gates the synthesis. */
export function isFreeformBody(
  body: SynthesizePreviewBody,
): body is { concept: string } {
  return 'concept' in body
}

// Rework body: a single freeform change note. `.max(800)` mirrors the
// synthesizer's per-pick `whyILikeIt` bound — a change note is a sentence or
// two, not an essay.
const ReworkBodySchema = z.object({
  change: z.string().min(1).max(800),
})

// Per-USER cap: 5 requests/min (mirrors POST /api/campaigns). Below what the
// cost controls tolerate, but enough to block adversarial Sonnet-burn loops
// that try to slip past the storm cooldown. Shared verbatim by ALL preview
// routes (synthesize-preview + rework + the myth-umggn streamed sibling) —
// each route gets its own @fastify/rate-limit bucket, so the caps are
// independent but identically shaped.
export const previewRateLimit = {
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

// Cheap cost-control guards shared by ALL preview routes (incl. the myth-umggn
// streamed sibling — they run BEFORE the response is hijacked into SSE, so a
// guard trip is a plain JSON status on every transport), run BEFORE any LLM
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
export async function runPreviewCostGuards(args: {
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

/** The gate side-effects + logger every rejection in this module shares. */
interface GateArgs {
  readonly userId: string
  readonly stormIncrementer: () => Promise<{ cooldownActive: boolean; retryAfterSeconds: number }>
  readonly logger: PinoLogger
}

/**
 * Steps 5–8 of the FREEFORM arm (myth-6t06f): gate the player's RAW words, then
 * synthesize the proposal from them and park it.
 *
 * The gate runs BEFORE the synthesis, and that order is load-bearing on two
 * counts. It is the exact protection the create route ran on this text before
 * the proposal checkpoint existed — a synthesis in between could launder a
 * concept the gate would have rejected — and it keeps an abusive input at one
 * cheap gate call instead of a full Sonnet synthesis. There is no second gate:
 * the proposal is a paraphrase of text already judged.
 */
async function freeformProposal(args: {
  reply: FastifyReply
  concept: string
  redis: Redis
  redisKeyPrefix: string
  gateArgs: GateArgs
}): Promise<FastifyReply> {
  const gate = await runInputGate({ concept: args.concept, intentSummary: null })
  if (gate.verdict === 'reject') {
    return handleGateRejection({
      reply: args.reply,
      gate,
      // The judged text IS the player's own; the rejection screen still needs it
      // to render and to seed "adjust it yourself".
      echoJudgedConcept: true,
      synthesizedConcept: args.concept,
      ...args.gateArgs,
    })
  }
  const proposal = await synthesizeFromConcept(args.concept)
  const previewId = await putPreview(args.redis, args.redisKeyPrefix, args.gateArgs.userId, {
    title: proposal.title,
    concept: proposal.concept,
    intentSummary: proposal.intentSummary,
    reworkCount: 0,
  })
  return args.reply
    .code(201)
    .send({ previewId, title: proposal.title, concept: proposal.concept })
}

/**
 * Steps 5–8 of the BRAINSTORM arm: synthesize an original concept from the three
 * picks, gate what was WRITTEN (the input is three media titles — there is
 * nothing else worth judging), and park it on a pass.
 */
async function picksProposal(args: {
  reply: FastifyReply
  picks: readonly SynthesizerPick[]
  redis: Redis
  redisKeyPrefix: string
  gateArgs: GateArgs
}): Promise<FastifyReply> {
  const synth = await synthesizeConcept(args.picks)

  const gate = await runInputGate({ concept: synth.concept, intentSummary: synth.intentSummary })
  if (gate.verdict === 'reject') {
    return handleGateRejection({
      reply: args.reply,
      gate,
      echoJudgedConcept: true,
      synthesizedConcept: synth.concept,
      ...args.gateArgs,
    })
  }

  // Park the gated concept in Redis under a fresh previewId, keyed to the
  // AUTHENTICATED user (IDOR-safe). reworkCount starts at 0 — a later rework
  // (A4) bumps it to 1.
  const previewId = await putPreview(args.redis, args.redisKeyPrefix, args.gateArgs.userId, {
    title: synth.title,
    concept: synth.concept,
    intentSummary: synth.intentSummary,
    reworkCount: 0,
  })
  return args.reply.code(201).send({ previewId, title: synth.title, concept: synth.concept })
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
      // Step 1: body validation (3 picks, or a freeform concept).
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

      const gateArgs: GateArgs = {
        userId: dbUser.id,
        stormIncrementer: () => stormCounter.incrementAndCheck(dbUser.id),
        logger: request.log as PinoLogger,
      }

      if (isFreeformBody(parsed.data)) {
        return freeformProposal({
          reply,
          concept: parsed.data.concept,
          redis: opts.redis,
          redisKeyPrefix: opts.redisKeyPrefix,
          gateArgs,
        })
      }

      return picksProposal({
        reply,
        picks: parsed.data.picks,
        redis: opts.redis,
        redisKeyPrefix: opts.redisKeyPrefix,
        gateArgs,
      })
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

      return reworkProposal({
        reply,
        previewId,
        prior: preview,
        change: parsed.data.change,
        redis: opts.redis,
        redisKeyPrefix: opts.redisKeyPrefix,
        gateArgs: {
          userId: dbUser.id,
          stormIncrementer: () => stormCounter.incrementAndCheck(dbUser.id),
          logger: request.log as PinoLogger,
        },
      })
    },
  )
}

/**
 * Steps 7–9 of the rework: revise the parked proposal (Sonnet), re-gate, and —
 * ONLY on a pass — overwrite it (reworkCount 0→1).
 *
 * Gate-pass-only mutation is the load-bearing invariant: a REJECTED rework
 * leaves the original gated concept AND reworkCount:0 untouched, so the player
 * still holds their one budgeted change.
 */
async function reworkProposal(args: {
  reply: FastifyReply
  previewId: string
  prior: PreviewRecord
  change: string
  redis: Redis
  redisKeyPrefix: string
  gateArgs: GateArgs
}): Promise<FastifyReply> {
  const revised = await reviseConcept(
    { title: args.prior.title, concept: args.prior.concept },
    args.change,
  )
  const gate = await runInputGate({
    concept: revised.concept,
    intentSummary: revised.intentSummary,
  })
  if (gate.verdict === 'reject') {
    return handleGateRejection({
      reply: args.reply,
      gate,
      echoJudgedConcept: true,
      synthesizedConcept: revised.concept,
      ...args.gateArgs,
    })
  }

  await overwritePreview(
    args.redis,
    args.redisKeyPrefix,
    args.gateArgs.userId,
    args.previewId,
    { title: revised.title, concept: revised.concept, intentSummary: revised.intentSummary, reworkCount: 1 },
  )
  return args.reply
    .code(200)
    .send({ previewId: args.previewId, title: revised.title, concept: revised.concept })
}
