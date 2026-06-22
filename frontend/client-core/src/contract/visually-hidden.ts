import type { BaseProps } from './index.ts'

/**
 * Screen-reader-only wrapper: its children are removed from the visual layout
 * but remain in the accessibility tree (for SR-only labels, headings that
 * orient assistive tech, etc.). Carries only `children` — no visual props.
 */
export type VisuallyHiddenProps = BaseProps
