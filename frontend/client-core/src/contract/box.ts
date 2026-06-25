import type { BaseProps } from './index.ts'
import type { SpaceToken } from './space-token.ts'

/**
 * Generic surface container. A token-padded panel that can sit on one of the
 * three elevation surfaces and optionally carry a strong (interactive-grade)
 * border. The neutral building block for cards, panels, and grouped content.
 */
export interface BoxProps extends BaseProps {
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
   */
  surface?: 'base' | 'raised' | 'overlay' | 'reversed'
  /** Draw a 1px `--border-strong` boundary on all sides. */
  border?: boolean
  /**
   * Minimum block size. `screen` floors the box at the full viewport height
   * (`100vh`) — a full-screen root, e.g. the dithered 404, where the surface
   * must fill the viewport with no other surface showing below it.
   */
  minHeight?: 'screen'
}
