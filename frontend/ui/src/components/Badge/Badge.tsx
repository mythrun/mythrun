import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { BadgeProps, BadgeVariant } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Badge — a small inline status chip (a count, a state label, a tag). Flat 1-bit
// register (§3): `rounded-none`, NO shadow, tight padding. Mono `font-ui` because
// a badge is DATA, not prose (the brand's machine-mono register for state).
//
// A leaf with no ARIA role: the chip's TEXT carries the meaning, so it announces
// as its content. Color is reinforcement, never the sole signal — the same §4
// discipline the Banner follows, here distilled to a chip.
//
// `neutral` (default) is the quiet brand chip: the `--surface` tier over a
// `--border-strong` edge with `--ink` text. The four severities reuse the §4
// status-intent triad — a faint `--surface-{intent}` tint with the AA
// `--text-{intent}` ink (the tinted-panel + readable-ink pairing that clears AA
// in both themes, exactly as Banner uses it). Full literal token classes so
// Tailwind v4's source scanner generates them.
const badge = cva(
  cn(
    'inline-flex items-center',
    'px-[var(--space-2)] py-[var(--space-1)]',
    'font-ui text-xs font-medium leading-none',
    'rounded-none border',
  ),
  {
    variants: {
      variant: {
        neutral: 'bg-surface text-ink border-border-strong',
        success: 'bg-surface-success text-text-success border-border-success',
        warning: 'bg-surface-warning text-text-warning border-border-warning',
        danger: 'bg-surface-danger text-text-danger border-border-danger',
        info: 'bg-surface-info text-text-info border-border-info',
      } satisfies Record<BadgeVariant, string>,
    },
    defaultVariants: { variant: 'neutral' },
  },
)

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = 'neutral', children, 'data-testid': dataTestId },
  ref,
) {
  return (
    <span
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(badge({ variant }))}
    >
      {children}
    </span>
  )
})
