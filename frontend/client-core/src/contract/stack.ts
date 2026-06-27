import type { BaseProps } from './index.ts'
import type { SpaceToken } from './space-token.ts'

/**
 * Flex layout container. Stacks its children along one axis with a token-spaced
 * gap and main/cross-axis alignment. The platform-neutral primitive every
 * vertical/horizontal arrangement composes — no raw flex CSS in feature code.
 */
export interface StackProps extends BaseProps {
  /** Main-axis direction. Default `column`. */
  direction?: 'row' | 'column'
  /** Gap between children, a `--space-*` step. */
  gap?: SpaceToken
  /** Cross-axis alignment of children. */
  align?: 'start' | 'center' | 'end' | 'stretch'
  /** Main-axis distribution of children. */
  justify?: 'start' | 'center' | 'end' | 'between'
  /** Allow children to wrap onto multiple main-axis lines when they overflow. */
  wrap?: boolean
  /** Floor the stack at the full dynamic viewport height (`100dvh`) — a full-screen flex column (e.g. a genesis screen / a centered splash). */
  minHeight?: 'screen'
  /**
   * Grow to fill / WEIGHT the available main-axis space of a flex parent.
   * `true` → `flex: 1` (fill — the common body-region case, e.g. the region below a
   * fixed-height crown band). A NUMBER → an explicit flex-grow WEIGHT, for
   * proportional SPACERS that place content with a deliberate vertical rhythm — e.g.
   * a `grow={2}` spacer above content and a `grow={3}` spacer below seats it
   * optically ABOVE center (more quiet space below than above). Platform-neutral:
   * web maps it to `flex-grow`, native to Yoga's `flexGrow`.
   */
  grow?: boolean | number
}
