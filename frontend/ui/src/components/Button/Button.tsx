import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { ButtonProps, ButtonVariant, ButtonSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Spinner } from '../Spinner/Spinner.tsx'

// Text/label action button — a REAL <button> (native keyboard activation +
// a11y), never a div-button. `onPress` is the platform-neutral activation
// callback; the web impl maps it to onClick.
//
// Flat 1-bit (§3): `rounded-none` (the brand has 0px radius — `--radius: 0`).
// State matrix (§6) is TOKEN-SWAP, no shadows/transforms: hover/active shift the
// fill to the `accent-hover`/`accent-active` token (primary) or the
// `surface-hover` token (secondary/ghost). Focus is the shared a11y ring; the
// disabled arm swaps to muted tokens (a11y-exempt for contrast, §4).
//
// Focus ring (a11y-critical, §3): a 2px hard square outline, 2px offset, in the
// `accent` token — which is EXACTLY what `--focus-ring-color` references in both
// themes, so the ring is theme-aware. We use the `outline-accent` token utility
// (not the arbitrary `outline-[var(--focus-ring-color)]`) because no-ad-hoc-color
// (R3) bans arbitrary color utilities; the token form is semantically identical.
//
// Hit-target (a11y-critical, §4): the VISUAL height is the `--control-*` token
// (32/40/48), and those three heights MUST read as distinct in the size scale.
// A blanket `min-h-[44px]` would force `sm`(32) and `md`(40) both up to 44px —
// collapsing the scale (sm≈md). So the 44px WCAG 2.5.5 target rides the
// `pointer-coarse:` variant instead (see the base class): only a COARSE pointer
// (touch) gets the 44px floor — where target size matters — while a fine pointer
// (mouse) keeps the distinct 32/40/48 visual hierarchy, which is what matters
// there. (Non-color arbitrary values like `min-h-[44px]` are allowed by R3 — it
// only bans arbitrary *color* utilities.)
//
// State matrix (§6): each variant carries a hover AND an active (pressed)
// token-swap. primary swaps the accent fill (accent-hover → accent-active);
// secondary/ghost swap the neutral surface (surface-hover → surface-active),
// one paper step per state.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-paper-50 hover:bg-accent-hover active:bg-accent-active',
  secondary:
    'bg-surface text-ink border border-border-strong hover:bg-surface-hover active:bg-surface-active',
  ghost: 'bg-transparent text-ink hover:bg-surface-hover active:bg-surface-active',
}

// Visual height from the `--control-*` token (32/40/48); padding ramps +4/+8
// (12/16/24); font steps 12/14/16 (text-xs/sm/base). All three axes change per
// step so the sizes are clearly distinguishable — not just the height.
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-[var(--control-sm)] px-[var(--space-3)] text-xs',
  md: 'h-[var(--control-md)] px-[var(--space-4)] text-sm',
  lg: 'h-[var(--control-lg)] px-[var(--space-5)] text-base',
}

const button = cva(
  cn(
    // Layout: label + (optional) spinner sit on one row, centered, never wrapping.
    'inline-flex items-center justify-center gap-[var(--space-2)] whitespace-nowrap',
    'font-ui font-medium select-none cursor-pointer',
    // Flat 1-bit corners.
    'rounded-none',
    // ≥44px touch target on COARSE pointers only (WCAG 2.5.5). On a fine pointer
    // the visual height stays the distinct --control-* step (32/40/48); a blanket
    // min-h would flatten sm/md to 44px and kill the size scale.
    'pointer-coarse:min-h-[44px]',
    // Theme-aware focus ring (== --focus-ring-color in both themes).
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    // Disabled (incl. loading): muted token swap, non-interactive cursor.
    // a11y-exempt for contrast (§4). `disabled:border-border-strong` keeps the
    // secondary border from looking active while muted.
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

// The Spinner footprint tracks the control size (sm/md → small dots; lg → md).
const SPINNER_SIZE: Record<ButtonSize, 'sm' | 'md'> = { sm: 'sm', md: 'sm', lg: 'md' }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    disabled = false,
    onPress,
    type = 'button',
    children,
    ...rest
  },
  ref,
) {
  // Loading is a non-interactive busy state: disable the control AND swallow the
  // press (the native `disabled` already blocks click/keyboard, but we gate
  // onPress too so a future non-disabled busy treatment can't leak a press).
  const isInactive = disabled || loading
  return (
    <button
      ref={ref}
      type={type}
      onClick={isInactive ? undefined : onPress}
      disabled={isInactive}
      aria-busy={loading || undefined}
      className={cn(button({ variant, size }))}
      {...rest}
    >
      {loading && <Spinner size={SPINNER_SIZE[size]} />}
      {children}
    </button>
  )
})
