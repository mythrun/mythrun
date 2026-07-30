import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/**
 * The app's sticky top bar — owns EVERY scroll-visual mechanic so app code
 * never needs a className (spec 2026-07-30 §Scroll mechanics, normative):
 *
 *  • `position: sticky; top: 0`, one layer above content, below the Menu
 *    portal's --z-dropdown.
 *  • Fluid metrics: brand-slot height `clamp(30px, 22px + 2.12vw, 56px)`,
 *    vertical padding `clamp(10px, 8px + 0.5vw, 16px)`, horizontal gutter
 *    --space-6 (32px) matching the content Box.
 *  • ZERO-CLS elevation: the layout box NEVER changes. `elevated` swaps the
 *    always-present bottom border transparent → --border, and transform-scales
 *    the brand slot to 0.82 (origin left-center) from `sm` up. Transitions
 *    honor prefers-reduced-motion (states still swap; motion is removed).
 *
 * `brand` is the left slot (lockup-in-link); `children` is the right cluster.
 */
export interface StickyBarProps extends BaseProps {
  /** Elevated (content has scrolled beneath): hairline on, brand compacted. */
  elevated: boolean
  /** Left slot — the brand lockup (wrapped in its home link). */
  brand: ReactNode
}
