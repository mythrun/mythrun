// CreditBalance (MYT-95) — the two-bucket credit readout on the Sessions & Billing
// settings surface. It itemises BOTH credit buckets (session + world-gen) as
// independent labeled mono readouts; the two buckets are NEVER conflated and NO
// summed total is ever rendered (spec §4). Platform-neutral (§9): pure data +
// shell-owned i18n'd labels, no DOM types, no callbacks.
//
// CONTROLLER DECISION (plan Task 12): the header session-credit display already
// ships via MYT-87's HeaderCredits, so the compact `inline` header variant the plan
// originally spec'd is DESCOPED — CreditBalance serves the settings surface only,
// where both buckets are always present. Both counts are therefore REQUIRED (there
// is no single-bucket variant left to make `worldGen` optional for), which drops the
// `variant` discriminator entirely.
//
// EXPLAINED TILES (myth-9jrh9): run-1 rendered each bucket as one full-width
// justified row, so the label sat ~1200px from its number with nothing binding them,
// and neither number said what the currency WAS. Each bucket is now a bounded tile
// that carries its own count and its own two-line explainer — what one credit buys,
// and what the zero state means. The explainers are REQUIRED, not optional: these
// are the product's two economic units, and a bare number teaches nothing.

/** Props for the two-bucket settings credit readout. */
export interface CreditBalanceProps {
  /** The SESSION credit count — the play/session bucket. NEVER summed with worldGen. */
  readonly session: number
  /** The i18n'd label for the session bucket (copy stays in the shell, not the DS). */
  readonly sessionLabel: string
  /** One line on what a session credit buys — the unit, in the product's own terms. */
  readonly sessionHelp: string
  /** One line on what running out of session credits means for the player. */
  readonly sessionZeroHelp: string
  /** The WORLD-GEN credit count — the world-creation bucket. NEVER summed with session. */
  readonly worldGen: number
  /** The i18n'd label for the world-gen bucket. */
  readonly worldGenLabel: string
  /** One line on what a world credit buys (a world plus its characters). */
  readonly worldGenHelp: string
  /** One line on what running out of world credits means for the player. */
  readonly worldGenZeroHelp: string
  /** Test hook on the root element. */
  readonly 'data-testid'?: string
}
