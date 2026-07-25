// backend/src/routes/concept-gate.ts
//
// Shared helpers for the concept-gate flow. Extracted verbatim from
// campaigns.ts (MYT-89 Task A3) so the three routes that run a world-concept
// through the input gate share ONE copy:
//   - POST /api/campaigns              (create — freeform | guided, charging)
//   - POST /api/campaigns/synthesize-preview (guided preview, non-charging)
//   - POST /api/campaigns/preview/:previewId/rework (A4 — guided rework, non-charging)
//
// Two pieces live here:
//   - checkRejectionStorm: a READ-ONLY peek at the per-user storm counter, run
//     at the START of a request so a cooling-down user is rejected the cheapest
//     way (before any LLM call). The actual increment happens only on a 422.
//   - handleGateRejection: the `422 { code:'concept_rejected', ... }` emitter.
//     Increments the storm counter, logs the server-only reasoning (never in
//     the response — Roc-Imp6), and includes `synthesizedConcept` when the
//     rejection surface needs it (Kraken-C2) so the user can see what was judged.

import type { FastifyReply } from 'fastify'
import type { Redis } from 'ioredis'
import type { Logger as PinoLogger } from 'pino'
import type { InputGateVerdict } from '../llm/prep/input-gate.js'
import {
  REJECTION_STORM_THRESHOLD,
  REJECTION_STORM_WINDOW_SECONDS,
} from '../auth/rejection-storm.js'

/**
 * Read-only rejection-storm check. Returns the current count + whether
 * the cooldown is active. Distinct from the storm counter's
 * `incrementAndCheck` — the route checks the count BEFORE the gate so
 * cooldowns reject the cheapest possible way (no LLM call). The actual
 * increment happens only on a 422 from the gate.
 */
export async function checkRejectionStorm(
  redis: Redis,
  redisKeyPrefix: string,
  userId: string,
): Promise<{ cooldownActive: boolean; retryAfterSeconds: number }> {
  const key = `${redisKeyPrefix}rejection_storm:${userId}`
  const raw = await redis.get(key)
  const count = raw === null ? 0 : Number.parseInt(raw, 10)
  if (!Number.isFinite(count) || count <= REJECTION_STORM_THRESHOLD) {
    return { cooldownActive: false, retryAfterSeconds: 0 }
  }
  // Match rejection-storm.ts's PTTL rounding contract: never return 0
  // while the cooldown is still active. The fallback to the full window
  // length only fires if the key has no TTL (defensive — every key set
  // by the counter goes via EXPIRE-NX so a TTL is always present).
  const pttlMs = await redis.pttl(key)
  /* c8 ignore start — race fallback: same as rejection-storm.ts:87 —
   * key expired between INCR and PTTL. */
  const retryAfterSeconds = pttlMs > 0 ? Math.ceil(pttlMs / 1000) : REJECTION_STORM_WINDOW_SECONDS
  /* c8 ignore stop */
  return { cooldownActive: true, retryAfterSeconds }
}

/** The `concept_rejected` payload shape — the 422 body AND (myth-umggn) the
 *  streamed route's terminal `rejected` frame carry exactly these fields. */
export interface GateRejectionPayload {
  code: 'concept_rejected'
  reason: InputGateVerdict['reason']
  rejectionMessage: string | null
  synthesizedConcept?: string
}

/**
 * The transport-independent half of a gate rejection (myth-umggn split):
 * increments the rejection-storm counter, logs the server-side reasoning
 * (Roc-Imp6 — never in the payload), and shapes the `concept_rejected`
 * payload.
 *
 * `echoJudgedConcept` decides whether the judged text rides back in
 * `synthesizedConcept` (Kraken-C2 — lets the user see what was judged). It is
 * TRUE for every rejection whose surface is the standalone rejection SCREEN,
 * which has nothing but this payload to render and to seed its "adjust it
 * yourself" affordance from — the proposal routes, on both funnel paths
 * (myth-6t06f). It is FALSE only where the caller already holds the judged text
 * inline: the create route's freeform arm answers the very screen the concept
 * was typed on. (Before myth-6t06f this was a `mode: 'freeform' | 'guided'`
 * flag; the freeform path's proposal checkpoint broke that equivalence, so the
 * decision is now stated rather than inferred.)
 *
 * Shared by the HTTP 422 arm (`handleGateRejection`) and the SSE stream's
 * terminal `rejected` frame.
 */
export async function recordGateRejection(args: {
  gate: InputGateVerdict
  echoJudgedConcept: boolean
  synthesizedConcept: string
  stormIncrementer: () => Promise<{ cooldownActive: boolean; retryAfterSeconds: number }>
  logger: PinoLogger
}): Promise<GateRejectionPayload> {
  // Increment regardless of whether the increment trips the cooldown —
  // the cooldown is checked at the START of the NEXT request, not on
  // this one. (The current request still gets its rejection; the next one
  // will 429 if this increment pushed the count past the threshold.)
  await args.stormIncrementer()

  args.logger.info(
    {
      event: 'input_gate_reject',
      reason: args.gate.reason,
      reasoning: args.gate.reasoning,
    },
    'concept rejected by input gate',
  )

  const payload: GateRejectionPayload = {
    code: 'concept_rejected',
    reason: args.gate.reason,
    rejectionMessage: args.gate.rejectionMessage,
  }
  if (args.echoJudgedConcept) {
    payload.synthesizedConcept = args.synthesizedConcept
  }
  return payload
}

/**
 * Gate rejection branch (HTTP arm): the shared `recordGateRejection`
 * side-effects + payload, sent as the 422 response.
 */
export async function handleGateRejection(args: {
  reply: FastifyReply
  gate: InputGateVerdict
  userId: string
  echoJudgedConcept: boolean
  synthesizedConcept: string
  stormIncrementer: () => Promise<{ cooldownActive: boolean; retryAfterSeconds: number }>
  logger: PinoLogger
}): Promise<FastifyReply> {
  const payload = await recordGateRejection(args)
  return args.reply.code(422).send(payload)
}
