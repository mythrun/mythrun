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
}
