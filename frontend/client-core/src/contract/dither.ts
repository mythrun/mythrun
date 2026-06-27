import type { BaseProps } from './index.ts'

/**
 * The brand palette RAMPS — six ten-step ramps emitted as `--color-{ramp}-{step}`
 * design tokens (brand guidelines → "Color palette"; the generator is
 * `tokens/generate-palette.mjs`). `paper` is the neutral ground ramp; `ember` is
 * the one saturated brand accent; the four semantic ramps are UI-state colors.
 */
export type PaletteRamp = 'paper' | 'ember' | 'success' | 'warning' | 'danger' | 'info'

/** The ten steps every palette ramp carries (50 = lightest, 900 = darkest). */
export type PaletteStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900

/**
 * A palette color token NAME — `${ramp}-${step}` (e.g. `'paper-100'`,
 * `'ember-600'`). The closed set of the 60 brand palette tokens; each maps to the
 * `--color-{name}` CSS var. This is the ONLY way to name a color in the design
 * system from app code — raw hex / arbitrary colors are forbidden (R3).
 */
export type PaletteColor = `${PaletteRamp}-${PaletteStep}`

/**
 * Dither axis. `vertical` (the default) puts the `from` color above and the `to`
 * color below (a horizon). `horizontal` is allowed for section-break ribbons.
 * Radial is FORBIDDEN by the brand (it reads as "glow"), so it is not expressible.
 */
export type DitherDirection = 'vertical' | 'horizontal'

/**
 * The brand's ONLY sanctioned gradient: a stepped 4×4-Bayer dither between two
 * palette colors — NEVER a smooth CSS/SVG gradient. Reference pin: *Return of the
 * Obra Dinn*. A pure TRANSITION device: it renders ONLY the dithered crossfade
 * band (decorative, `aria-hidden`). Nothing is ever layered on it — the solid
 * `from` color above and the solid `to` color below are the ADJACENT page
 * sections. The canonical use is the page→footer break: cream content above, the
 * band, the dark reversed footer below (brand guidelines → "Footer").
 *
 * COLOR is `from`→`to`, each a PALETTE token (R3 — never a raw color): `from` is
 * the ground the band emerges from (the sparse end), `to` is the accent it
 * resolves into (the dense end). The brand's sanctioned pairings are the canonical
 * picks — `paper-100`→`ember-600` (warm), `paper-100`→`paper-900` (ink),
 * `paper-900`→`paper-100` (reverse) — but the props are open to any palette token
 * so a consumer can match an adjacent section's exact color.
 *
 * The formula is LOCKED (brand guidelines → "The dither formula"): 4×4 ordered
 * Bayer matrix, an 8px (preview) / 6px (hero) cell, a 20-cell band, 15%
 * pseudorandom chaos / 85% ordered Bayer, two-color. (The math also defines the
 * two solid framing blocks; the component CROPS to the dithered band — those
 * solids belong to the adjacent sections, not the texture.)
 *
 * Platform-neutral (§9): the colors come in as palette token names (not raw
 * colors), the axis as a neutral enum; no className/style/DOM events. No
 * `children` — the band is a leaf; nothing composes on top of it.
 */
export interface DitherProps extends Omit<BaseProps, 'children'> {
  /** Ground color (the sparse end the band emerges from). Default `'paper-100'`. */
  from?: PaletteColor
  /** Accent color (the dense end the band resolves into). Default `'ember-600'`. */
  to?: PaletteColor
  /** Band axis. Default `'vertical'` (`from` above, `to` below). */
  direction?: DitherDirection
  /** `'hero'` → 6px cell (full-bleed); `'preview'` → 8px cell (small surface).
   *  Default `'preview'`. The grain must stay visible as grain at display size. */
  scale?: 'hero' | 'preview'
  /**
   * Reverse the transition direction. The default band runs `from`→`to` along the
   * axis (vertical: `from` at the top edge, `to` at the bottom). `flip` inverts it
   * (vertical: `to` dense at the TOP edge, fading DOWN into `from`) — the
   * orientation the genesis-screen CROWN needs, where the band hangs from the top
   * of the page rather than rising from the bottom. Default `false`.
   */
  flip?: boolean
}
