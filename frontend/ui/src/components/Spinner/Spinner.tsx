import { forwardRef } from 'react'
import type { SpinnerProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// An indeterminate busy indicator. Per the brand's motion rule (spec §4 — "only
// opacity/fades animate, nothing spins/slides/bounces"), this is an OPACITY
// PULSE, never a rotating spinner: a short row of square 1-bit pixels (flat
// brand → `--radius: 0`, so no rounded dots) that pulse opacity in a staggered
// wave via Tailwind's `animate-pulse` (keyframe is opacity-only: 0%/100% → 1,
// 50% → .5) plus per-dot `animation-delay`.
//
// REDUCED MOTION: the global `prefers-reduced-motion` reset in `base.css`
// neutralizes the animation (duration 0.01ms, one iteration). Because the dots'
// RESTING opacity is 1 (no `opacity-0` class) the spinner settles VISIBLE — it
// is never invisible when motion is reduced. The `role="status"` + accessible
// name is the non-motion signal (motion is never the sole indicator).
//
// a11y: `role="status"` (a polite live region) + an `aria-label` SR name. The
// dots are `aria-hidden` (pure decoration); the status name carries the meaning.
// `label` is an i18n key the consumer supplies; the default `'Loading'` keeps a
// bare <Spinner /> from being silent to AT.

// Per-size dot dimensions (full literal token classes so Tailwind v4's source
// scanner generates them — same technique as `space.ts`). Square pixels, not
// dots, to honour the flat 1-bit language.
const DOT_SIZE_CLASS: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'w-[var(--space-1)] h-[var(--space-1)]',
  md: 'w-[var(--space-2)] h-[var(--space-2)]',
  lg: 'w-[var(--icon-sm)] h-[var(--icon-sm)]',
}

// Staggered start per dot → a left-to-right opacity wave (still pure opacity).
const DOT_DELAY_CLASS = ['[animation-delay:0ms]', '[animation-delay:150ms]', '[animation-delay:300ms]']

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(props, ref) {
  const { size = 'md', label = 'Loading' } = props
  return (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      className="inline-flex items-center gap-[var(--space-1)]"
      data-testid={props['data-testid']}
    >
      {DOT_DELAY_CLASS.map((delay) => (
        <span
          key={delay}
          aria-hidden="true"
          className={cn('bg-ink animate-pulse', DOT_SIZE_CLASS[size], delay)}
        />
      ))}
    </span>
  )
})
