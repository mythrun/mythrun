import { forwardRef } from 'react'
import type { ThemeToggleProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'
import { useTheme } from '../../theme/theme-provider.tsx'

// The canonical theme-toggle FAB (MYT-84 §11). A SQUARE button with its OWN solid
// `surface` + `border-strong` so it floats cleanly ABOVE the dither crown
// (occluding it — never embedded). Self-positioning: `fixed` top-right so the
// genesis screens render `<ThemeToggle/>` and it floats over the crown without the
// screen reaching for raw positioning (no-ad-hoc-ui). A true 48px square — width ==
// height == `--control-lg` (the largest control step) so it reads as a real,
// noticeable button and is square BY CONSTRUCTION (one token on both axes), well
// above the 44px touch floor. 0px radius, theme-aware focus ring; the `md` (20px)
// sun/moon glyph sits proportionate in the 48px box. The BUTTON carries the
// accessible name (`label`); the sun/moon Icon is decorative.
//
// Colors use the `bg-surface`/`text-ink`/`border-border-strong` token UTILITIES,
// which flip under `.dark` (the @theme-inline gotcha: never raw --color-* here).
// The glyph follows the theme: sun in light, moon in dark (matches the mockup).
export const ThemeToggle = forwardRef<HTMLButtonElement, ThemeToggleProps>(function ThemeToggle(
  { label, ...rest },
  ref,
) {
  const { theme, toggle } = useTheme()
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={toggle}
      className={cn(
        'fixed top-[var(--space-4)] right-[var(--space-4)] z-[var(--z-nav)]',
        // A true square: width == height == --control-lg (48px). One token on both
        // axes guarantees square-by-construction and reads as a real, noticeable
        // button (well above the 44px touch floor).
        'inline-flex items-center justify-center h-[var(--control-lg)] w-[var(--control-lg)] shrink-0',
        'rounded-none cursor-pointer select-none',
        'bg-surface text-ink border border-border-strong',
        'hover:bg-surface-hover active:bg-surface-active',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      )}
      {...rest}
    >
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} size="md" decorative />
    </button>
  )
})
