import type { BaseProps } from './index.ts'
import type { SpaceToken } from './space-token.ts'

/**
 * CSS-grid layout container. Lays children out in either a fixed column count
 * or a responsive `auto-fit` track sized off a minimum column width. The
 * platform-neutral primitive every two-dimensional arrangement composes.
 */
export interface GridProps extends BaseProps {
  /**
   * A fixed number of equal columns, or `auto-fit` for a responsive track that
   * fits as many `minColumnWidth`-wide columns as the container allows.
   * Default 1.
   */
  columns?: number | 'auto-fit'
  /** Gap between grid cells, a `--space-*` step. */
  gap?: SpaceToken
  /** Minimum column width for the `auto-fit` track, a `--space-*` step. */
  minColumnWidth?: SpaceToken
}
