import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type {
  CardProps,
  CardHeaderProps,
  CardBodyProps,
  CardFooterProps,
} from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Card — the flat container (§3). Depth is a paper surface tier + a 1px
// `--border-strong` interactive-grade edge (`border-border-strong`), NOT a
// shadow, and the corners are square (`rounded-none` — the brand's 0px radius).
// `overflow-hidden` clips the slots' dividers flush to that square edge.
//
// Compound slots (§9): `Card` is a NEUTRAL generic container — no implicit role,
// no implicit heading. `CardHeader`/`CardBody`/`CardFooter` are token-padded
// regions; the header/footer carry a 1px DECORATIVE `--border` divider
// (`border-border`, the quiet sub-3:1 chrome line — NOT `--border-strong`, which
// is reserved for the interactive control edge of the Card itself).
const card = cva(
  cn('border border-border-strong rounded-none overflow-hidden'),
  {
    variants: {
      surface: {
        base: 'bg-surface',
        raised: 'bg-surface-raised',
      },
    },
    defaultVariants: {
      surface: 'base',
    },
  },
)

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { surface = 'base', children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn(card({ surface }))} {...rest}>
      {children}
    </div>
  )
})

// Top slot: token padding + a decorative divider on the bottom edge.
export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(
  { children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn('p-[var(--space-4)] border-b border-border')} {...rest}>
      {children}
    </div>
  )
})

// Main slot: token padding, no divider.
export const CardBody = forwardRef<HTMLDivElement, CardBodyProps>(function CardBody(
  { children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn('p-[var(--space-4)]')} {...rest}>
      {children}
    </div>
  )
})

// Bottom slot: token padding + a decorative divider on the top edge.
export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(function CardFooter(
  { children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn('p-[var(--space-4)] border-t border-border')} {...rest}>
      {children}
    </div>
  )
})
