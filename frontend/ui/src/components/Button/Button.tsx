import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { ButtonProps, ButtonVariant, ButtonSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Spinner } from '../Spinner/Spinner.tsx'

// Leading-icon slot spacing (the contained-button-with-icon convention, e.g.
// Material): a ~18-20px icon sits before the label with an 8px gap. The size-tuned
// `gap` in SIZE_CLASS below is calibrated for the loading SPINNER (a tighter 6px on
// sm/md so the small spinner reads as one unit with the label); a leading ICON is
// larger and wants the canonical 8px, so when an `icon` is present we override the
// gap to `--space-2` (tailwind-merge lets the later class win). The whole icon+label
// group is centered by `justify-center`, which optically centers the label.
const ICON_GAP = 'gap-[var(--space-2)]'

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
// `accent-fg` token (the FOREGROUND accent — the ring sits OUTSIDE the control so
// it must contrast against the page, not carry text like the fill) — which is
// EXACTLY what `--focus-ring-color` references in both themes, so the ring is
// theme-aware. We use the `outline-accent-fg` token utility (not the arbitrary
// `outline-[var(--focus-ring-color)]`) because no-ad-hoc-color (R3) bans arbitrary
// color utilities; the token form is semantically identical.
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
//
// NON-INTERACTIVE (disabled OR busy) is ONE muted family with per-variant
// geometry (myth-skbzw, superseding MYT-0xao0's ember ghost). Run 2 found the
// accent-carrying disabled primary "visually indistinguishable from enabled —
// a player who has waited ten minutes will click it and get nothing" (the
// world-reveal settling Continue; same finding on the wizard/builder Next).
// So the invariant flipped: the accent is the EXCLUSIVE mark of an enabled
// primary. While non-interactive, every variant mutes to ~45% ink (the
// tertiary-ink token) with NO accent anywhere, keeping only its geometry:
//   • primary  → paper fill + muted --border edge + tertiary-ink label. It
//     SNAPS to the full accent fill the moment it becomes available — "the
//     accent fill is the reward for having decided." The rest-state transparent
//     border reserves the 1px edge so the toggle adds no reflow.
//   • secondary → its bordered neutral, softened (decorative --border edge,
//     tertiary-ink label).
//   • ghost    → a quiet tertiary-ink label on the bare page.
// Busy rides these same `disabled:` arms (a busy control is natively disabled),
// so "working" and "not yet available" share one legible stood-down look.
// Disabled is a11y-exempt for contrast (§4).
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: cn(
    'bg-accent text-paper-50 border border-transparent hover:bg-accent-hover active:bg-accent-active',
    'disabled:bg-surface disabled:border-border disabled:text-ink-tertiary',
  ),
  secondary: cn(
    'bg-surface text-ink border border-border-strong hover:bg-surface-hover active:bg-surface-active',
    'disabled:bg-surface disabled:border-border disabled:text-ink-tertiary',
  ),
  ghost: cn(
    'bg-transparent text-ink hover:bg-surface-hover active:bg-surface-active',
    'disabled:bg-transparent disabled:text-ink-tertiary',
  ),
}

// MINIMUM height from the `--control-*` token (32/40/48) — a FLOOR, not a fixed
// height, so a wrapped label grows the button taller (with `py` for breathing room)
// instead of clipping; a single-line label still sits at the control height. The
// horizontal padding ramps +4/+8 (12/16/24); font steps 12/14/16 (text-xs/sm/base).
// All three axes change per step so the sizes stay clearly distinguishable.
//
// GAP (spinner/icon ↔ label): tuned to the spinner that actually sits there, not
// a uniform value. sm/md carry the 12px spinner, so the canonical 8px gap reads
// as 0.67em — too loose, the spinner detaches from the label; 6px ≈ half the
// spinner pulls it into one unit. lg carries the 24px spinner, where 8px is a
// clean 0.5em / one-third-of-spinner, so it keeps the --space-2 gap.
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'min-h-[var(--control-sm)] px-[var(--space-3)] py-[var(--space-1)] text-xs gap-[6px]',
  md: 'min-h-[var(--control-md)] px-[var(--space-4)] py-[var(--space-2)] text-sm gap-[6px]',
  lg: 'min-h-[var(--control-lg)] px-[var(--space-5)] py-[var(--space-2)] text-base gap-[var(--space-2)]',
}

const button = cva(
  cn(
    // Layout: the icon/spinner + label are centered (items/justify-center); the
    // LABEL wraps (default whitespace-normal + text-center) and the button grows
    // TALLER via min-h (SIZE_CLASS) rather than spilling wide — `max-w-full` caps it
    // at the container so a long label never overflows the viewport (responsive by
    // default). shrink-0 (§4): the action affordance still opts OUT of the blanket
    // Stack min-w-0 default so it doesn't squish beside shrinking text in a row.
    'inline-flex items-center justify-center text-center max-w-full shrink-0',
    'font-ui font-medium select-none cursor-pointer',
    // Flat 1-bit corners.
    'rounded-none',
    // ≥44px touch target on COARSE pointers only (WCAG 2.5.5). On a fine pointer
    // the visual height stays the distinct --control-* step (32/40/48); a blanket
    // min-h would flatten sm/md to 44px and kill the size scale.
    'pointer-coarse:min-h-[44px]',
    // Theme-aware focus ring (== --focus-ring-color in both themes).
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
    // Disabled (incl. busy): a plain default cursor — the critique's prescription
    // for the settling Continue, and the not-allowed glyph is a slashed CIRCLE,
    // which the register bans anyway. The muted VISUAL treatment is per-variant
    // geometry over one shared stood-down family (see VARIANT_CLASS).
    'disabled:cursor-default',
  ),
  {
    variants: {
      variant: VARIANT_CLASS,
      size: SIZE_CLASS,
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

// The in-button Spinner footprint tracks the control size, sized to sit
// PROPORTIONATE to the label rather than tower over it. sm/md buttons (12/14px
// labels) get the 12px `xs` spinner; the bigger lg control (16px label) gets the
// 24px `sm` spinner. (A 24px spinner next to a 14px md label read oversized — the
// MYT-82 visual audit — so md drops from `sm`→`xs`.)
const SPINNER_SIZE: Record<ButtonSize, 'xs' | 'sm' | 'md'> = { sm: 'xs', md: 'xs', lg: 'sm' }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    busy = false,
    busyLabel,
    loading = false,
    disabled = false,
    onPress,
    type = 'button',
    icon,
    children,
    ...rest
  },
  ref,
) {
  // `loading` is the legacy alias of `busy` (pre-myth-skbzw call sites) — one
  // merged flag drives the whole busy arm.
  const isBusy = busy || loading
  // Busy is a non-interactive state: disable the control AND swallow the press
  // (the native `disabled` already blocks click/keyboard, but we gate onPress
  // too so a future non-disabled busy treatment can't leak a press).
  const isInactive = disabled || isBusy
  return (
    <button
      ref={ref}
      type={type}
      onClick={isInactive ? undefined : onPress}
      disabled={isInactive}
      aria-busy={isBusy || undefined}
      className={cn(button({ variant, size }), icon !== undefined && ICON_GAP)}
      {...rest}
    >
      {/* Leading-icon slot — decorative (the label is the accessible name), fixed
          (shrink-0) so it never squishes beside the label. Sits before the spinner
          + label; the ICON_GAP override gives it the canonical 8px gap. */}
      {icon !== undefined && (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center">
          {icon}
        </span>
      )}
      {/* tone="inherit": the spinner pixels take the button's text color (the
          muted tertiary ink of the stood-down busy arm) over a transparent
          ground — so it reads against the fill, never a frozen brand color. */}
      {isBusy && <Spinner size={SPINNER_SIZE[size]} tone="inherit" />}
      {/* While busy the label swaps to `busyLabel` when given ("Save" → "Saving");
          the control never goes label-less, so its width holds. */}
      {isBusy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
})
