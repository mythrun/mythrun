// Layout primitives (MYT-82 Wave 1). Each impl is typed against its contract in
// @mythrun/client-core; the contract prop types are re-exported here so app code
// imports component + props from the single package root.
export { Stack } from './components/Stack/Stack.tsx'
export { Box } from './components/Box/Box.tsx'
export { Grid } from './components/Grid/Grid.tsx'
export { Divider } from './components/Divider/Divider.tsx'

// Typography primitives (MYT-82 Wave 1b).
export { Text } from './components/Text/Text.tsx'
export { Heading } from './components/Heading/Heading.tsx'
export { Link } from './components/Link/Link.tsx'
export { VisuallyHidden } from './components/VisuallyHidden/VisuallyHidden.tsx'

export type {
  StackProps,
  BoxProps,
  GridProps,
  DividerProps,
  SpaceToken,
  TextProps,
  TextRole,
  HeadingProps,
  HeadingLevel,
  HeadingRole,
  LinkProps,
  VisuallyHiddenProps,
} from '@mythrun/client-core/contract'
