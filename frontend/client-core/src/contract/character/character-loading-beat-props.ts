import type { LoadingBeat } from './types.ts'

// CharacterLoadingBeat (MYT-90) — the "coming into being" beat that plays while the
// character sheet is generated: the 1-bit figure filling in beside a column of
// advancing beats (a name surfaces, rolling ability scores, gathering equipment).
// Platform-neutral (§9): pure data + a reduced-motion flag; no DOM types.

/** Props for the character-generation loading beat. */
export interface CharacterLoadingBeatProps {
  /** The resolved beat heading (the eyebrow over the surfacing rows) — the shell
   *  resolves i18n and passes it. */
  heading: string
  /** The ordered beats, each advancing pending → active → done. */
  beats: LoadingBeat[]
  /** Honour the user's reduced-motion preference — no fill animation / churn.
   *  (The countdown is exempt — it is content, not decoration.) */
  reducedMotion: boolean
  /** The ticking `~M:SS` remaining-wait estimate (MYT-102), already resolved —
   *  the consumer owns the tick, the math (`remainingCreationWaitMs`), and the
   *  i18n formatting; the beat just renders it as a quiet aria-hidden line
   *  under the rows (the world-gen countdown register). OMITTED — not empty —
   *  when there is no usable history: the beat then shows no countdown rather
   *  than a fake one. */
  countdownLabel?: string
}
