export { Text } from './text.tsx'
export type { TextProps } from './text.tsx'

// Layout primitives (MYT-82 Wave 1). Each impl is typed against its contract in
// @mythrun/client-core; the contract prop types are re-exported here so app code
// imports component + props from the single package root.
export { Stack } from './components/Stack/Stack.tsx'
export { Box } from './components/Box/Box.tsx'
export { Grid } from './components/Grid/Grid.tsx'
export { Divider } from './components/Divider/Divider.tsx'
export type {
  StackProps,
  BoxProps,
  GridProps,
  DividerProps,
  SpaceToken,
} from '@mythrun/client-core/contract'
