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
