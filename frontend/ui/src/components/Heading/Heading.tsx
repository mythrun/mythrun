import { createElement, forwardRef } from 'react'
import type { HeadingLevel, HeadingProps } from '@mythrun/client-core/contract'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// Section heading primitive. `level` picks the semantic element (h1..h6 — the
// document-outline/a11y axis); `role` picks the VISUAL size/weight, decoupled
// from the level (standard DS practice). Serif throughout, via TYPE_ROLE_CLASS.

// Fixed semantic-level → tag map (full static enum, not a DOM passthrough).
const LEVEL_TAG: Record<HeadingLevel, 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'> = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6',
}

export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(function Heading(
  { level, role = 'heading', children, ...rest },
  ref,
) {
  return createElement(
    LEVEL_TAG[level],
    { ref, className: TYPE_ROLE_CLASS[role], ...rest },
    children,
  )
})
