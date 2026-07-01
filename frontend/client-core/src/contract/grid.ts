import type { BaseProps } from './index.ts'
import type { SpaceToken } from './space-token.ts'

/**
 * CSS-grid layout container. Lays children out in a fixed column count or a
 * responsive track — `auto-fit` (empty tracks collapse, so cells stretch to
 * fill the row) or `auto-fill` (empty tracks are kept, so cells hold their
 * minimum width and simply wrap). The platform-neutral primitive every
 * two-dimensional arrangement composes.
 */
export interface GridProps extends BaseProps {
  /**
   * A fixed number of equal columns, or a responsive track: `auto-fit` fits as
   * many `minColumnWidth`-wide columns as the container allows and stretches
   * them to fill the row; `auto-fill` fits the same but preserves the column
   * width (extra space becomes empty tracks, not wider cells). Default 1.
   */
  columns?: number | 'auto-fit' | 'auto-fill'
  /** Gap between grid cells, a `--space-*` step. */
  gap?: SpaceToken
  /** Minimum column width for a responsive track, a `--space-*` step. */
  minColumnWidth?: SpaceToken
  /**
   * Minimum column width in raw PIXELS for an `auto-fill` track — the escape
   * hatch for card-scale widths that live OFF the `--space` scale (which caps
   * at 64px), e.g. a ~230px book-cover shelf. Takes precedence over
   * `minColumnWidth`; only applies when `columns` is `auto-fill`.
   */
  minColumnPx?: number
}
