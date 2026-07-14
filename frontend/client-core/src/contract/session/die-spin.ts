// DieSpin (MYT-93, spec §5) — the flat 2D outlined d20 the RollCard spins. A STEPPED
// rotation (8 discrete 45° steps ≈ one ~1s revolution — pixel-honest, never a smooth
// CSS interpolation, the motion analog of the brand's stepped Bayer dither); on the last
// step it calls `onSpinComplete`. `result` stamps the numeral in the die centre in
// --font-ui once landed. `reducedMotion` → no spin, `onSpinComplete` fires immediately.
// The die is aria-hidden decoration; the landed result announces via a polite live
// region carrying `resultLabel` (motion is never the only signal). Platform-neutral
// (§9): pure data + a neutral callback — no DOM types.

/** Props for the stepped 2D outlined d20. */
export interface DieSpinProps {
  /** Run the stepped spin (the card flips this true on Roll; false once landed). */
  spinning: boolean
  /** The stamped numeral once landed (null while un-rolled / mid-spin). */
  result: number | null
  /** Honour reduced motion — no spin, land instantly, fire onSpinComplete at once. */
  reducedMotion: boolean
  /** Fired when the spin's last step lands (or immediately under reduced motion). */
  onSpinComplete: () => void
  /** Resolved [ph:] SR label announced with the landed result (polite live region). */
  resultLabel?: string
}
