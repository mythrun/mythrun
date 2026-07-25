import { WATCHED_STAGES, type StageProgress } from '@mythrun/contract/events'
import { MIN_EXPECTED_ENTITIES } from '../worldgen/entity-floor.ts'

// The REAL-EVENT accretion level behind the calm world-gen wait's dither mark
// (ux-run2 myth-i2pdo). The run-2 critique's bar for a long-wait indicator:
// "drive the accretion from real pipeline events… so stillness means stillness
// and motion means work" — a time-driven animation can't tell "working" from
// "hung", which is exactly what three minutes of a frozen estimate felt like.
//
// The level counts only things that actually happened: completed WATCHED stages
// (the visible wait's slice — the silent tail is nobody's wait) plus arrived
// entities, over the expected total (the watched slice + the DB-derived
// MIN_EXPECTED_ENTITIES floor). The prep stretch contributes its three stage
// completions — a slow early resolve — and the entity stream carries the rest
// in dozens of small steps. Monotone in its inputs, clamped 0..1, never
// wall-clock-driven. Pure + DOM-free; the web surface feeds it to the mark's
// quantized fill.

/** A `Set` for the O(1) membership read; WATCHED_STAGES is canonical + ordered,
 *  membership is all this needs. */
const WATCHED_SET: ReadonlySet<string> = new Set(WATCHED_STAGES)

/**
 * The mark's accretion level at this instant: real events so far / expected
 * events. `stages` is the live stream fold (any slice — non-watched entries are
 * ignored); `nodeCount` the arrived entity count (capped at the floor so a
 * generous world never overflows the level).
 */
export function worldGenAccretion(stages: readonly StageProgress[], nodeCount: number): number {
  const completedWatched = stages.filter(
    (s) => s.status === 'completed' && WATCHED_SET.has(s.stage),
  ).length
  const events = completedWatched + Math.min(Math.max(0, nodeCount), MIN_EXPECTED_ENTITIES)
  const expected = WATCHED_STAGES.length + MIN_EXPECTED_ENTITIES
  return Math.min(1, events / expected)
}
