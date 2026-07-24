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
  /** The COARSE remaining-wait estimate (MYT-102), already resolved — the
   *  consumer owns the tick, the math (`remainingCreationWaitMs` → `waitDisplay`),
   *  and the i18n formatting; the beat just renders it as a quiet aria-hidden
   *  line under the ladder (e.g. "2 min remaining"). OMITTED — not empty — when
   *  there is no usable estimate to show (cold-start, or the estimate exhausted,
   *  in which case `stalledLabel` takes over). Mutually exclusive with
   *  `stalledLabel`; the consumer passes at most one. */
  countdownLabel?: string
  /** The indeterminate "still working" line (MYT-102) the beat shows IN PLACE OF
   *  the countdown once the estimate exhausts (the running stage overran) or the
   *  wait wedged — so the wait never sits at a dead 0:00. Already-resolved i18n;
   *  unlike the countdown it is meaningful content (a one-time state change, not
   *  per-second churn), so it is NOT aria-hidden. OMITTED while the estimate is
   *  still usable. Mutually exclusive with `countdownLabel`. */
  stalledLabel?: string
}
