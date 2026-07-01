import type { BaseProps } from './index.ts'
import type { WorldColor } from '@mythrun/contract/rest'

/**
 * The card-scale dither COVER that carries a world's two-colour identity (the
 * genesis / home-hub cover art). Distinct from `Dither` — that is a fixed-geometry
 * transition STRIP (a 20-cell band framed by two solid sections, no children).
 * CoverDither is a FULL-FIELD Bayer gradient that fills its host edge-to-edge: a
 * true top→bottom sweep between the two world-colours (light ground at the top,
 * deep accent at the bottom), never a smooth gradient, never a floating strip.
 *
 * COLOUR is a `from`/`to` pair, each a `WorldColor` — a `{ramp}-{step}` design
 * token (e.g. `verdigris-200`), R3, never a raw colour. The two ends are ordered by
 * ladder STEP, not by argument order: the lower step is the sparse ground, the
 * higher step the dense accent. `worldColorCssVar` (in `@mythrun/contract`) resolves
 * each to its uniform `var(--color-{ramp}-{step})` reference.
 *
 * THEME-RESPONSIVE, NO RE-RENDER: the Bayer PATTERN (which cell is ground vs accent)
 * is fixed; dark mode re-inks the same pattern by swapping the two colour VALUES
 * (ground → the hue's smouldering `-400`, accent → near-black `-900`, via
 * `reInkPair`), so the cover reads as a dark object with the colour glowing. Handled
 * in CSS — the light and dark pairs ride custom properties the `.dark` selector
 * flips, so a theme toggle re-colours the same SVG with zero JavaScript.
 *
 * GHOST: a still-generating world has no colour pick yet (`from`/`to` absent) — the
 * cover renders a muted `paper` ground→accent placeholder.
 *
 * Platform-neutral (§9): the colours come in as `WorldColor` names (not raw
 * colours), the shape as a neutral `size` enum; no className/style/DOM events. No
 * `children` — the cover is a decorative leaf; nothing composes on top of it.
 */
export interface CoverDitherProps extends Omit<BaseProps, 'children'> {
  /**
   * The lighter world-colour end. Omit BOTH `from` and `to` for the ghost (a
   * still-generating world with no colour pick). Ordering is by ladder step, not
   * argument order — pass the pair in any order.
   */
  from?: WorldColor
  /** The deeper world-colour end. Omit BOTH ends for the ghost placeholder. */
  to?: WorldColor
  /**
   * Intrinsic shape. `'band'` (the default) is the wide card-cover banner — it
   * fills its host width and stands up its own cover-band height (the card is
   * built around it). `'swatch'` is a SELF-SIZED small square (a fixed leading
   * thumbnail — the world-identity chip in a compact list row, where the host
   * can't set a width). `size` also sets the GRAIN density so the dither stays
   * visibly chunky at either scale.
   */
  size?: 'band' | 'swatch'
  /**
   * Draw a slightly-thick, theme-adaptive `border-strong` edge around the cover.
   * Off by default (a `band` cover sits inside its `CoverCard`'s own border). Set
   * for a STANDALONE cover — the mobile index `swatch` — so a low-contrast or pale
   * pair still reads as a distinct tile instead of melting into the page ground.
   */
  bordered?: boolean
}
