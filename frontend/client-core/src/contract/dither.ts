import type { BaseProps } from './index.ts'

/**
 * The two-color ground→accent transition the brand dither renders. The GROUND
 * (the solid block the band emerges from) is always a paper step; the ACCENT is
 * a brand color. Only the three sanctioned pairings exist (brand guidelines →
 * "Color pairings"):
 *  - `'light-ember'` — `paper-100` ground dithering to `ember-600` (canonical warm).
 *  - `'light-ink'`   — `paper-100` ground dithering to `paper-900` (quiet monochrome).
 *  - `'dark-cream'`  — `paper-900` ground dithering to `paper-100` (reverse / dark).
 *
 * A closed union — `ember`-ground / semantic-color pairings are FORBIDDEN by the
 * brand, so they are not expressible. Default `'light-ember'`.
 */
export type DitherPairing = 'light-ember' | 'light-ink' | 'dark-cream'

/**
 * Dither axis. `vertical` (the default) puts the ground above and the accent
 * below (a horizon). `horizontal` is allowed for section-break ribbons. Radial
 * is FORBIDDEN by the brand (it reads as "glow"), so it is not expressible.
 */
export type DitherDirection = 'vertical' | 'horizontal'

/**
 * The brand's ONLY sanctioned gradient: a stepped 4×4-Bayer dither between two
 * colors — NEVER a smooth CSS/SVG gradient. Reference pin: *Return of the Obra
 * Dinn*. It renders a decorative texture band; any `children` layer on top of it
 * stay accessible (the texture itself is `aria-hidden`).
 *
 * The formula is LOCKED (brand guidelines → "The dither formula"): 4×4 ordered
 * Bayer matrix, an 8px (preview) / 6px (hero) cell, a 20-cell band framed by two
 * solid blocks, 15% pseudorandom chaos / 85% ordered Bayer, two-color
 * ground→accent.
 *
 * Platform-neutral (§9): the colors come in as a sanctioned token `pairing`
 * (not raw colors), the axis as a neutral enum; no className/style/DOM events.
 */
export interface DitherProps extends BaseProps {
  /** Which sanctioned ground→accent token pairing. Default `'light-ember'`. */
  pairing?: DitherPairing
  /** Band axis. Default `'vertical'` (ground above, accent below). */
  direction?: DitherDirection
  /** `'hero'` → 6px cell (full-bleed); `'preview'` → 8px cell (small surface).
   *  Default `'preview'`. The grain must stay visible as grain at display size. */
  scale?: 'hero' | 'preview'
  /** Content layered OVER the texture — inherited from {@link BaseProps} as
   *  `children`. The dither sits behind; content stays in the a11y tree. */
  children?: BaseProps['children']
}
