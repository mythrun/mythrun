import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { DividerProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// A 1px rule on the DECORATIVE --border token (bg-border) — NOT --border-strong,
// which is the interactive-control boundary. Horizontal: full-width, 1px tall;
// vertical: full-height, 1px wide. Carries role="separator" + aria-orientation.
const divider = cva('bg-border', {
  variants: {
    orientation: {
      horizontal: 'h-px w-full',
      vertical: 'w-px h-full',
    },
  },
  defaultVariants: {
    orientation: 'horizontal',
  },
})

export const Divider = forwardRef<HTMLDivElement, DividerProps>(function Divider(
  { orientation = 'horizontal', children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      className={cn(divider({ orientation }))}
      {...rest}
    >
      {children}
    </div>
  )
})
