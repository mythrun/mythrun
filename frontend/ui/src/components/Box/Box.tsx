import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { BoxProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { PADDING_CLASS } from '../../lib/space.ts'

// surface + border + minHeight are fixed enums → CVA token classes (bg-surface*,
// the strong interactive-grade border, the viewport floor). padding is an open
// SpaceToken → PADDING_CLASS lookup. Colors come only from surface/border TOKENS
// (no raw values).
//
// `reversed` is the dark surface: `dark` re-establishes the reversed surface via
// base.css's `:where(.dark){ background-color: var(--bg); color: var(--ink) }` —
// `--bg` flips to paper-900 and inherited text flips to the light `--ink`
// (paper-100). `bg-bg` makes the dark fill explicit at zero risk: under
// `@theme inline` the `bg-bg` utility inlines `var(--bg)` (which flips under
// `.dark`), whereas the raw `--color-bg` token is frozen at the light value — so
// the utility, not a raw token, is what actually paints dark. This mirrors the
// MYT-82 page→footer Dither Footer story.
const box = cva('', {
  variants: {
    surface: {
      base: 'bg-surface',
      raised: 'bg-surface-raised',
      overlay: 'bg-surface-overlay',
      reversed: 'dark bg-bg',
    },
    border: {
      true: 'border border-border-strong',
      false: '',
    },
    // Full-viewport floor: `min-h-screen` = `min-height: 100vh`. A non-color
    // arbitrary-free utility (R3-clean, like Button's `min-h-[44px]`). The
    // literal string appears in source so the Tailwind v4 scanner generates it.
    minHeight: {
      screen: 'min-h-screen',
    },
  },
  defaultVariants: {
    surface: 'base',
    border: false,
  },
})

export const Box = forwardRef<HTMLDivElement, BoxProps>(function Box(
  { padding, surface = 'base', border = false, minHeight, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        box({ surface, border, ...(minHeight !== undefined && { minHeight }) }),
        padding !== undefined && PADDING_CLASS[padding],
      )}
      {...rest}
    >
      {children}
    </div>
  )
})
