// SituationRecap (MYT-102) — the quiet paper card that keeps the chosen opening
// situation in view while the player writes their character: a mono eyebrow over
// the situation's serif title + location, then the scene prose. Mounted above the
// creation prompts so the concept/grounding answers are written AGAINST the actual
// opening scene, not from memory of a screen three steps back.
//
// Platform-neutral (§9): resolved strings only — the eyebrow is shell-resolved
// chrome; title/locationName/prose are LLM-authored DATA rendered verbatim (never
// i18n keys). No callbacks: the narrow-viewport collapse of a long prose body is
// presentation detail the component owns internally.

/** Props for the opening-situation recap card. */
export interface SituationRecapProps {
  /** The resolved mono eyebrow label (the shell owns the copy). */
  eyebrow: string
  /** The situation's title — LLM-authored DATA, rendered verbatim. */
  title: string
  /** The situation's location name — LLM-authored DATA, rendered verbatim. */
  locationName: string
  /** The situation's scene prose — LLM-authored DATA, rendered verbatim. */
  prose: string
}
