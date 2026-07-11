import type { LoadingBeat } from './types.ts'

// CharacterLoadingBeat (MYT-90) — the "coming into being" beat that plays while the
// character sheet is generated: the 1-bit figure filling in beside a column of
// advancing beats (a name surfaces, rolling ability scores, gathering equipment).
// Platform-neutral (§9): pure data + a reduced-motion flag; no DOM types.

/** Props for the character-generation loading beat. */
export interface CharacterLoadingBeatProps {
  /** The ordered beats, each advancing pending → active → done. */
  beats: LoadingBeat[]
  /** Honour the user's reduced-motion preference — no fill animation / churn. */
  reducedMotion: boolean
}
