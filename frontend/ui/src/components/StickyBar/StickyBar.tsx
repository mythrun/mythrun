import { forwardRef } from 'react'
import type { StickyBarProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// StickyBar — the frame's top bar; owns all scroll-visual mechanics (spec
// 2026-07-30 §Scroll mechanics). Zero-CLS: `elevated` changes PAINT only —
// border color + brand transform — never the layout box. The border is
// always-mounted (transparent at rest) so the hairline's arrival shifts
// nothing; compaction is a transform on the brand slot, so the document
// doesn't reflow mid-scroll. Transitions are removed (not the state change)
// under prefers-reduced-motion via motion-reduce.
export const StickyBar = forwardRef<HTMLElement, StickyBarProps>(function StickyBar(
  { elevated, brand, children, 'data-testid': dataTestId },
  ref,
) {
  return (
    <header
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(
        // z-[100]: no --z-sticky token exists; one layer above content (--z-base 0
        // / --z-nav 10), below the Menu portal's --z-dropdown (1000).
        'sticky top-0 z-[100] bg-bg',
        'flex items-center justify-between gap-[var(--space-4)]',
        'px-[var(--space-6)] py-[clamp(10px,8px+0.5vw,16px)]',
        'border-b transition-colors motion-reduce:transition-none',
        elevated ? 'border-border' : 'border-transparent',
      )}
    >
      <div
        data-brand-slot
        className={cn(
          'h-[clamp(30px,22px+2.12vw,56px)] shrink-0',
          'origin-left transition-transform motion-reduce:transition-none',
          elevated && 'sm:scale-[0.82]',
        )}
      >
        {brand}
      </div>
      {children}
    </header>
  )
})
