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
  /** Grow to fill the available main-axis space of a flex parent (`flex: 1`). Use on the body region of a column whose sibling (a crown band) is fixed-height. */
  grow?: boolean
}
