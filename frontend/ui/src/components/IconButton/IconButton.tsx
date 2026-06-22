import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { IconButtonProps, ButtonVariant, ButtonSize, IconSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'
import { Spinner } from '../Spinner/Spinner.tsx'

// Icon-only action button — a REAL <button aria-label={label}> (native keyboard
// + a11y). The BUTTON carries the accessible name (from `label`, required); the
// inner Icon is DECORATIVE (`aria-hidden`), so there is exactly one name and the
// #1 icon-button a11y bug (a nameless control) is structurally impossible.
//
// Shares Button's flat 1-bit corners, token-swap state matrix, and theme-aware
// focus ring (see Button.tsx for the rationale on `outline-accent` vs the
// arbitrary token wrapper). The difference is GEOMETRY: an icon-only control has
// no text to pad the tap area, so the ≥44px hit-target (§4) is pinned on BOTH
// axes (`min-w-[44px] min-h-[44px]`) at EVERY size, including `sm`. The visual
// box still tracks `--control-*` (square), but it never shrinks below 44px.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-paper-50 hover:bg-accent-hover active:bg-accent-active',
  secondary: 'bg-surface text-ink border border-border-strong hover:bg-surface-hover',
  ghost: 'bg-transparent text-ink hover:bg-surface-hover',
}

// Square visual box from the `--control-*` token (width == height).
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'w-[var(--control-sm)] h-[var(--control-sm)]',
  md: 'w-[var(--control-md)] h-[var(--control-md)]',
  lg: 'w-[var(--control-lg)] h-[var(--control-lg)]',
}

const iconButton = cva(
  cn(
    'inline-flex items-center justify-center shrink-0 cursor-pointer select-none',
    'rounded-none',
    // ≥44px hit-target on BOTH axes at every size (icon-only → no text padding).
    'min-w-[44px] min-h-[44px]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-tertiary disabled:border-border-strong',
  ),
  {
    variants: {
      variant: VARIANT_CLASS,
      size: SIZE_CLASS,
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

// The glyph/spinner footprint tracks the control size.
const ICON_SIZE: Record<ButtonSize, IconSize> = { sm: 'sm', md: 'md', lg: 'lg' }
const SPINNER_SIZE: Record<ButtonSize, 'sm' | 'md'> = { sm: 'sm', md: 'sm', lg: 'md' }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'primary', size = 'md', loading = false, disabled = false, onPress, ...rest },
  ref,
) {
  const isInactive = disabled || loading
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={isInactive ? undefined : onPress}
      disabled={isInactive}
      aria-busy={loading || undefined}
      className={cn(iconButton({ variant, size }))}
      {...rest}
    >
      {loading ? <Spinner size={SPINNER_SIZE[size]} /> : <Icon name={icon} size={ICON_SIZE[size]} decorative />}
    </button>
  )
})
