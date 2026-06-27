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
//
// `collapse` = the general "card on desktop, NATIVE/inline on mweb" responsive
// pattern: below `sm` (<640px) the card drops its border + surface (full-width on
// the bare page) but KEEPS a horizontal page gutter so content isn't edge-to-edge;
// at `sm`+ it is the normal
// bordered card with a centered ~420px max-width and its own padding. The SURFACE
// is applied via compound variants (not the base `surface` variant) so it can be
// scoped to `sm:` in collapse mode — that keeps mobile genuinely surface-free
// without relying on a `bg-surface`/`bg-transparent` merge to cancel out.
const card = cva('rounded-none overflow-hidden', {
  variants: {
    surface: {
      base: '',
      raised: '',
    },
    collapse: {
      false: 'border border-border-strong',
      true: cn(
        // mweb: flush/native — no border/surface, full width, but a horizontal page
        // gutter (px-space-5) so content never runs to the screen edges.
        'border-0 w-full px-[var(--space-5)]',
        // sm+: the bordered card returns — strong edge, padding, centered ~420px.
        'sm:w-auto sm:mx-auto sm:max-w-[420px] sm:border sm:border-border-strong sm:p-[var(--space-6)]',
      ),
    },
  },
  compoundVariants: [
    // Non-collapse: the surface paints at every width.
    { collapse: false, surface: 'base', class: 'bg-surface' },
    { collapse: false, surface: 'raised', class: 'bg-surface-raised' },
    // Collapse: the surface paints only from sm+ (flush/transparent below sm).
    { collapse: true, surface: 'base', class: 'sm:bg-surface' },
    { collapse: true, surface: 'raised', class: 'sm:bg-surface-raised' },
  ],
  defaultVariants: {
    surface: 'base',
    collapse: false,
  },
})

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { surface = 'base', collapse = false, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn(card({ surface, collapse }))} {...rest}>
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
