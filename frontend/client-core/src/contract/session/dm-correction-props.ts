// DmCorrection (myth-d6knq) — the DM's ERRATA register in the live transcript: a rare,
// legitimate amendment of something previously narrated ("what was said before is
// corrected"). It is deliberately NOT the DM narrative register (DmMessage) — it renders
// as a set-apart errata slip (a ruled ledger-margin note), so a correction can never read
// as the fiction it corrects. Quiet by design: the record being kept honest, not an alarm.
//
// Two signals, no chrome furniture: the mono `--font-ui` face (narration is serif) plus a
// ruled margin set it apart — no badge, no chip, no icon circle (the brand's square 1-bit
// register). Platform-neutral (§9): pure data, no DOM types.

/** Props for one DM correction row. */
export interface DmCorrectionProps {
  /** The correction prose (DM output — DATA, not an i18n key). */
  text: string
  /** The resolved errata eyebrow — the terse chrome label marking the row as an
   *  amendment (e.g. "correction"). Resolved route-side (the DS component is i18n-agnostic). */
  label: string
}
