import type { BaseProps } from './index.ts'
import type { SpaceToken } from './space-token.ts'

/**
 * Generic surface container. A token-padded panel that can sit on one of the
 * three elevation surfaces and optionally carry a strong (interactive-grade)
 * border. The neutral building block for cards, panels, and grouped content.
 */
export interface BoxProps extends BaseProps {
  /** Semantic landmark element. Default 'div'. Use 'nav'/'main'/'footer'/'header'/'section' for page landmarks. */
  as?: 'div' | 'nav' | 'main' | 'footer' | 'header' | 'section'
  /** Inner padding on all sides, a `--space-*` step. */
  padding?: SpaceToken
  /**
   * Surface tier:
   * - `base` (`--surface`), `raised` (`--surface-raised`, popover tier),
   *   `overlay` (`--surface-overlay`, modal tier) — the three elevation
   *   surfaces. Default `base`.
   * - `reversed` — the REVERSED (dark) surface: a `.dark` region (dark paper-900
   *   bg, inherited text flips to light paper-100), the same inversion the
   *   page→footer break uses. The dark counterpart a `light-ink` Dither resolves
   *   into.
   * - `inverted` — theme-INVERTING: dark on a light page, light on a dark page
   *   (the always-flipped landing footer — the page grades INTO its opposite).
   *   The opposite of the current theme; distinct from `reversed` (ALWAYS dark).
   *   Re-themes ONLY via the semantic CSS-var utilities (`text-ink`, `bg-bg`, …); do
   *   NOT place a `dark:`-variant-themed component inside — on a dark page the light
   *   footer is a `.dark` descendant, so `dark:` utilities would fire backwards.
   * - `none` — TRANSPARENT: paints no background, so the box inherits the page
   *   field. For semantic-landmark wrappers (nav/main) on a flat single-tone page
   *   that must NOT introduce the lighter `--surface` panel tone over the page bg.
   */
  surface?: 'base' | 'raised' | 'overlay' | 'reversed' | 'inverted' | 'none'
  /** Draw a 1px `--border-strong` boundary on all sides. */
  border?: boolean
  /**
   * Minimum block size. `screen` floors the box at the full *dynamic* viewport
   * height (`100dvh` — fills the mobile screen where `100vh` leaves a white gap
   * under the browser chrome) — a full-screen root, e.g. the dithered 404, where
   * the surface must fill the viewport with no other surface showing below it.
   */
  minHeight?: 'screen'
  /** Grow to fill the parent flex track (flex-1 + min-h-0 so inner scroll still
   *  works). The app shell's padded content region uses it so short routes never
   *  expose the page background beneath the surface (MYT-102 audit). */
  grow?: boolean
}
