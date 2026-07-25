import type { BaseProps } from './index.ts'

/**
 * A 1px decorative rule that separates content. Uses the decorative `--border`
 * token (a quiet sub-3:1 line — it is non-interactive chrome, not a control
 * boundary). Carries a `separator` role with the matching `aria-orientation`.
 */
export interface DividerProps extends BaseProps {
  /** Rule axis. Default `horizontal`. */
  orientation?: 'horizontal' | 'vertical'
  /**
   * Line tone. `border` (default) is the quiet decorative `--border` hairline
   * (sub-3:1 chrome). `strong` is the interactive-grade `--border-strong` step —
   * a rule that must read as PRESENT without claiming the completed-ink weight
   * (a stepper's pending segment — ux-run2 myth-tf60g). `ink` is the structural
   * INK seam — the dark pigment (`paper-900`), for a boundary that must read as
   * a deliberate cut (e.g. a cover→body seam on a cover card). Unlike the
   * adaptive `--ink` TEXT token (which inverts for readability in dark mode),
   * an ink hairline is the dark mark on paper in EITHER theme, so the seam
   * stays a dark line — cohering with the flat-1-bit register rather than
   * flipping to a bright rule on the dark card.
   */
  tone?: 'border' | 'strong' | 'ink'
}
