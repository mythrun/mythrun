import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { BoxProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { PADDING_CLASS } from '../../lib/space.ts'

// surface + border are fixed enums → CVA token classes (bg-surface*, the strong
// interactive-grade border). padding is an open SpaceToken → PADDING_CLASS
// lookup. Colors come only from surface/border TOKENS (no raw values).
const box = cva('', {
  variants: {
    surface: {
      base: 'bg-surface',
      raised: 'bg-surface-raised',
      overlay: 'bg-surface-overlay',
    },
    border: {
      true: 'border border-border-strong',
      false: '',
    },
  },
  defaultVariants: {
    surface: 'base',
    border: false,
  },
})

export const Box = forwardRef<HTMLDivElement, BoxProps>(function Box(
  { padding, surface = 'base', border = false, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(box({ surface, border }), padding !== undefined && PADDING_CLASS[padding])}
      {...rest}
    >
      {children}
    </div>
  )
})
