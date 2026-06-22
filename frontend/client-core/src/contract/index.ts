import type { ReactNode } from 'react'

/**
 * Base props shared by every mythrunUI component. Platform-neutral: no DOM types.
 * Ref forwarding is handled per-component (each component's props type adds its own ref);
 * components never expose className/style/CSSProperties/DOM event handlers.
 */
export interface BaseProps {
  children?: ReactNode
  'data-testid'?: string
}

// Layout-primitive contracts (MYT-82 Wave 1). Type-only re-exports — the barrel
// stays free of runtime values (asserted by contract.test.ts).
export type { SpaceToken } from './space-token.ts'
export type { StackProps } from './stack.ts'
export type { BoxProps } from './box.ts'
export type { GridProps } from './grid.ts'
export type { DividerProps } from './divider.ts'

// Typography-primitive contracts (MYT-82 Wave 1b).
export type { TextProps, TextRole } from './text.ts'
export type { HeadingProps, HeadingLevel, HeadingRole } from './heading.ts'
export type { LinkProps } from './link.ts'
export type { VisuallyHiddenProps } from './visually-hidden.ts'

// Leaf-primitive contracts (MYT-82 Wave 1c) — Icon + Spinner, composed by the
// controls (Button loading, IconButton).
export type { IconProps, IconName, IconSize } from './icon.ts'
export type { SpinnerProps } from './spinner.ts'

// Control contracts (MYT-82 Wave 2a) — Button + IconButton. These compose the
// Icon + Spinner leaves; the contracts stay DOM-free (`onPress`, no className).
export type { ButtonProps, ButtonVariant, ButtonSize, ButtonType } from './button.ts'
export type { IconButtonProps } from './icon-button.ts'
