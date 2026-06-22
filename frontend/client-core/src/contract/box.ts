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
   * Elevation surface: `base` (`--surface`), `raised` (`--surface-raised`,
   * popover tier), `overlay` (`--surface-overlay`, modal tier). Default `base`.
   */
  surface?: 'base' | 'raised' | 'overlay'
  /** Draw a 1px `--border-strong` boundary on all sides. */
  border?: boolean
}
