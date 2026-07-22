// SessionStartBeat (MYT-92) — the 1-bit loading-beat family (paper + Dither hatch, same
// register as CharacterLoadingBeat / WorldGenLoading — NOT voxel). Register pin (spec
// §2): ONE beat with two labeled phases — `prep` (the SSE-driven atmospheric "DM is
// preparing tonight's session…" 1–2 minute wait) and `connecting` (the short
// socket-connect boundary). Accelerates toward completion; `reducedMotion` lands
// instantly (no churn). Platform-neutral (§9): pure data + resolved i18n labels.

/** Props for the two-phase session-start loading beat. */
export interface SessionStartBeatProps {
  /** Which phase of the one beat is active. */
  phase: 'prep' | 'connecting'
  /** Honour reduced motion — the beat lands instantly, no churn. */
  reducedMotion: boolean
  /** The resolved beat heading (the eyebrow over the phase rows) — the shell
   *  resolves i18n and passes it (MYT-100 lifted it into the contract, matching
   *  CharacterLoadingBeat). */
  heading: string
  /** Resolved i18n label for the prep (session-preparing) phase. */
  prepLabel: string
  /** Resolved i18n label for the connecting (socket-connect) phase. */
  connectingLabel: string
}
