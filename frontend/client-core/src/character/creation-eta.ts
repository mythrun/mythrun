import type { StageProgress } from '@mythrun/contract/events'
import type { StageTiming } from '@mythrun/contract/rest'
import { remainingOverSlice } from '../worldgen/stage-eta.ts'

// The character-creation countdown (MYT-102 Track B) — the world-gen waiting
// register, pointed at the per-player creation pipeline. ONE math, another
// slice: the shared `remainingOverSlice` core (worldgen/stage-eta.ts) summed
// over the canonical CHARACTER_CREATION_STAGES, so the loading beat's "~M:SS
// left" walks with the same honest clamp/hold/jump semantics the world-gen
// screens shipped with. Pure + DOM-free — the web surface owns the 1-second
// tick and the label formatting.
//
// Integration is deliberately EXCLUDED from the slice: the viewer's visible
// wait ends when their OWN sheet completes (the reveal moment); the
// campaign-scoped character_integration runs later, behind the party-staging
// surface, and is nobody's on-screen wait here.

/**
 * The canonical per-player character-creation stages, in pipeline order — a
 * MIRROR of `STAGES_IN_ORDER` in
 * backend/src/llm/prep/character-creation-processor.ts (a string copy, NOT a
 * cross-boundary import — creation-eta.test.ts pins the two lists against
 * silent drift, the SUBCLASS_LEVEL precedent). Promoted here (from the private
 * union `use-character-creation-stream.ts` used to hold) so the stream fold and
 * the countdown read ONE taxonomy.
 */
export const CHARACTER_CREATION_STAGES = [
  'location_selection',
  'character_concept',
  'character_sheet',
] as const

export type CharacterCreationStage = (typeof CHARACTER_CREATION_STAGES)[number]

const CREATION_STAGE_SET: ReadonlySet<string> = new Set(CHARACTER_CREATION_STAGES)

/**
 * The remaining visible character-creation wait (ms) at `nowMs` for the viewer:
 * the sum of historical average durations for the creation stages not yet
 * completed, minus the time already spent inside the currently-running stage
 * (clamped at 0 — an overrun HOLDS at the remaining-future floor and the count
 * drops again at the next stage event). `stages` is the VIEWER's own folded
 * per-player progress (`useCharacterCreationStream` exposes it pre-filtered —
 * per-player stage ids repeat across users, so a mixed array must never reach
 * this sum).
 *
 * Honesty beyond the core (the endpoint is an un-filtered aggregate): `null` —
 * no countdown, never a fake one — when the history carries NO creation-stage
 * row with a positive average. A deployment that has generated worlds but never
 * a character has world-gen history only; the core's "missing timing → 0" rule
 * would read that as an instant estimate, so the slice-level cold-start check
 * degrades to no estimate instead. With ANY real creation history, the core's
 * semantics apply unchanged (a missing row contributes 0).
 */
export function remainingCreationWaitMs(
  timings: readonly StageTiming[] | null,
  stages: readonly StageProgress[],
  nowMs: number,
): number | null {
  if (timings === null) return null
  const hasSliceHistory = timings.some((tm) => CREATION_STAGE_SET.has(tm.stage) && tm.avgMs > 0)
  if (!hasSliceHistory) return null
  return remainingOverSlice(timings, stages, nowMs, CHARACTER_CREATION_STAGES)
}
