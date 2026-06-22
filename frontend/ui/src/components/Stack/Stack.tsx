import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { StackProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { GAP_CLASS } from '../../lib/space.ts'

// Enum variants (direction/align/justify) are fixed sets → CVA. The gap is an
// open SpaceToken, so it comes from the GAP_CLASS lookup (full static classes),
// not a CVA variant. No colors here — pure layout.
const stack = cva('flex', {
  variants: {
    direction: {
      row: 'flex-row',
      column: 'flex-col',
    },
    align: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
    },
    justify: {
      start: 'justify-start',
      center: 'justify-center',
      end: 'justify-end',
      between: 'justify-between',
    },
  },
  defaultVariants: {
    direction: 'column',
  },
})

export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  { direction = 'column', gap, align, justify, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(stack({ direction, align, justify }), gap !== undefined && GAP_CLASS[gap])}
      {...rest}
    >
      {children}
    </div>
  )
})
