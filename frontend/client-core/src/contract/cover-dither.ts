import type { BaseProps } from './index.ts'
import type { WorldColor } from '@mythrun/contract/rest'

/**
 * The card-scale dither COVER that carries a world's two-colour identity (the
 * genesis / home-hub cover art). Distinct from `Dither` — that is a fixed-geometry
 * transition STRIP (a 20-cell band framed by two solid sections, no children).
 * CoverDither is a FULL-FIELD tiled texture that fills its host edge-to-edge: the
 * brand's locked 4×4-Bayer two-colour dither, sized to the card-band aspect or the
 * mobile square, never a smooth gradient.
 *
 * COLOUR is `from`→`to`, each a `WorldColor` (the curated cover set — the 12 avatar
 * pigments + selected paper/ember ramp steps; R3 — never a raw colour). `from` is the
 * ground the dither emerges from (the sparse end); `to` is the accent it resolves into
 * (the dense end). The two CSS-var namespaces (pigment → `--color-avatar-{name}`, ramp
 * step → `--color-{name}`) are resolved by `worldColorCssVar` in `@mythrun/contract`.
 *
 * Platform-neutral (§9): the colours come in as `WorldColor` names (not raw colours),
 * the shape as a neutral `size` enum; no className/style/DOM events. No `children` —
 * the cover is a decorative leaf; nothing composes on top of it.
 */
export interface CoverDitherProps extends Omit<BaseProps, 'children'> {
  /** Ground colour (the sparse end the dither emerges from). */
  from: WorldColor
  /** Accent colour (the dense end the dither resolves into). */
  to: WorldColor
  /**
   * Intrinsic shape. `'band'` (the default) is the wide card-cover banner — it
   * fills its host width and derives a short height from the cover aspect.
   * `'swatch'` is a SELF-SIZED small square (a fixed leading thumbnail — the
   * world-identity chip in a compact list row, where the host can't set a width),
   * holding its size as a flex-row item. Either way the dither tiles to fill and
   * the grain stays square-pixel crisp at either size.
   */
  size?: 'band' | 'swatch'
}
