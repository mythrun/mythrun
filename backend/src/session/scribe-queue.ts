// backend/src/session/scribe-queue.ts
//
// MYT-73 T10 — the post-turn Scribe producer (mirrors st-eval-queue.ts). The
// turn worker enqueues ONE Scribe job in its post-turn finally phase (T11 wires
// the producer). Unlike the st-evaluation debounce, the Scribe job is NOT a
// single-flight-per-campaign debounce: it carries the turn's prose + proposed
// deltas + ST injections as its payload, so each turn produces a distinct job
// (no dedup id — a turn's facts must not collapse onto a sibling turn's job).

import type { Queue } from 'bullmq'
import type { WorkingSetProposal } from './working-set/types.js'
import type { WorldDelta } from '../llm/schemas/world-delta.js'

export const QUEUE_SCRIBE = 'scribe' as const
export const SCRIBE_JOB_NAME = 'scribe' as const

/** myth-g4hf3 — one RESOLVED skill check from the turn (the deterministic roll +
 *  the Haiku-pre-generated outcome constraint the FT wrote under). PUBLIC-tier
 *  by construction: the outcome table is generated FT-side under enforced
 *  ignorance and the constraint was already streamed to the players on the
 *  skill_check frame. Carried onto the Scribe job so the tripwire can GROUND on
 *  it — content the system licensed via a resolved roll is definitionally not a
 *  breach. */
export interface ResolvedSkillCheckOutcome {
  readonly characterName: string
  readonly skill: string
  readonly dc: number
  readonly outcomeTier: 'fail' | 'success' | 'great_success'
  readonly constraint: string
}

export interface ScribeJobPayload {
  readonly campaignId: string
  readonly sessionId: string
  readonly turnId: string
  /** The campaign's world id — needed for entity resolution / reconciliation. */
  readonly worldId: string
  /** The Fast Thinker's player-facing prose for this turn (the tripwire's input). */
  readonly prose: string
  /** The FT's per-turn world delta (objective facts it asserted), or null. Its
   *  `facts[]` map to `ft_delta` / `known` / objective working-set proposals. */
  readonly worldDelta: WorldDelta | null
  /** ST injections (already secret-free vetted relay text) recorded this turn. */
  readonly injections: readonly WorkingSetProposal[]
  /** myth-g4hf3 — the turn's resolved skill-check outcomes (roll_skill_check
   *  results + world-lookup skill gates). Feeds the tripwire's grounding floor
   *  and stamps `dice_outcome` provenance onto the turn's ft_delta proposals.
   *  Optional so an in-flight pre-upgrade job still deserializes; absent → []. */
  readonly skillChecks?: readonly ResolvedSkillCheckOutcome[]
}

/** Narrow producer surface (the turn worker's post-turn phase): just `add`. */
export interface ScribeQueueLike {
  add: Queue<ScribeJobPayload>['add']
}

/** Enqueue one post-turn Scribe job. No custom jobId / dedup: each turn's facts
 *  ride a distinct job (collapsing turns onto a shared id would lose a turn's
 *  proposed facts). */
export function enqueueScribe(queue: ScribeQueueLike, payload: ScribeJobPayload): Promise<unknown> {
  return queue.add(SCRIBE_JOB_NAME, payload)
}
