import { createElement, forwardRef } from 'react'
import type { HeadingLevel, HeadingProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
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

// Fixed-line boxes (myth-7jc1h — the cover card's title zone): clamp overflow
// AND reserve the height in `lh` units so the box tracks the role's own
// line-height. Full static literals (the v4 scanner only emits what it sees).
const LINES_CLASS: Record<2, string> = {
  2: 'line-clamp-2 min-h-[2lh]',
}

export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(function Heading(
  { level, role = 'heading', lines, children, ...rest },
  ref,
) {
  return createElement(
    LEVEL_TAG[level],
    { ref, className: cn(TYPE_ROLE_CLASS[role], lines !== undefined && LINES_CLASS[lines]), ...rest },
    children,
  )
})
