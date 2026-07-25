import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { DividerProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// A 1px rule. Horizontal: full-width, 1px tall; vertical: full-height, 1px wide.
// Carries role="separator" + aria-orientation.
//
// `tone` picks the line colour. `border` (default) is the DECORATIVE --border
// token (bg-border) — the quiet sub-3:1 chrome line, NOT --border-strong (the
// interactive-control boundary). `ink` is the structural INK seam: the dark
// pigment `paper-900`, for a boundary read as a deliberate cut (a cover→body
// seam). It uses the RAMP token (bg-paper-900), not the adaptive `--ink` TEXT
// token, on purpose — `--ink` inverts to a light value in dark mode (so text
// stays legible), but an ink hairline is the dark mark on paper in EITHER theme:
// bg-paper-900 stays a dark line on the dark card, cohering with the flat-1-bit
// register instead of flipping to a bright rule.
const divider = cva('', {
  variants: {
    orientation: {
      horizontal: 'h-px w-full',
      vertical: 'w-px h-full',
    },
    tone: {
      border: 'bg-border',
      strong: 'bg-border-strong',
      ink: 'bg-paper-900',
    },
  },
  defaultVariants: {
    orientation: 'horizontal',
    tone: 'border',
  },
})

export const Divider = forwardRef<HTMLDivElement, DividerProps>(function Divider(
  { orientation = 'horizontal', tone = 'border', children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={orientation}
      className={cn(divider({ orientation, tone }))}
      {...rest}
    >
      {children}
    </div>
  )
})
