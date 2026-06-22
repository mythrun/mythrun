import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import { Checkbox as RadixCheckbox } from 'radix-ui'
import type { CheckboxProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'

// Checkbox — the unstyled Radix `Checkbox` primitive (Space-to-toggle keyboard,
// ARIA `aria-checked` incl. the `mixed` tri-state, a hidden form input), styled
// 100% with our tokens. The native mirror is `rn-primitives` (same API) — the
// contract stays DOM-free, so Radix's `onCheckedChange(checked)` maps straight
// to the neutral `onChange` (§9) with no DOM event surfaced. Indeterminate is a
// VALUE (`checked: 'indeterminate'`), not a separate flag — Radix's model.
//
// Flat 1-bit (§3): a square `--control` * ~half-height box, `rounded-none`, a 1px
// `--border-strong` interactive boundary. The CHECKED / INDETERMINATE state is a
// token-swap to the `--accent` fill with the `paper-50` glyph (the same on-accent
// pairing Button uses). invalid swaps the border to the danger token AND sets
// `aria-invalid` (both halves). disabled gets the muted token swap + a
// non-interactive cursor (a11y-exempt for contrast, §4). The focus ring is the
// shared theme-aware `outline-accent`.
const box = cva(
  cn(
    'inline-flex h-[var(--space-5)] w-[var(--space-5)] shrink-0 items-center justify-center',
    'rounded-none border border-border-strong bg-surface text-paper-50',
    // Checked + indeterminate (Radix sets both via data-state) swap to the accent fill.
    'data-[state=checked]:bg-accent data-[state=checked]:border-accent',
    'data-[state=indeterminate]:bg-accent data-[state=indeterminate]:border-accent',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-tertiary disabled:border-border-strong',
    'cursor-pointer',
  ),
  {
    variants: {
      invalid: {
        true: 'border-border-danger focus-visible:outline-border-danger',
        false: '',
      },
    },
    defaultVariants: { invalid: false },
  },
)

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { checked, defaultChecked, onChange, disabled = false, invalid = false, id, describedBy, name, label },
  ref,
) {
  // Radix's prop types are non-undefined under `exactOptionalPropertyTypes`, so
  // we conditionally spread the optional controlled props (an explicit
  // `undefined` would be a type error) rather than always forwarding them.
  const control = (
    <RadixCheckbox.Root
      ref={ref}
      {...(id !== undefined ? { id } : {})}
      {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})}
      {...(name !== undefined ? { name } : {})}
      {...(checked !== undefined ? { checked } : {})}
      {...(defaultChecked !== undefined ? { defaultChecked } : {})}
      {...(onChange ? { onCheckedChange: onChange } : {})}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className={cn(box({ invalid }))}
    >
      <RadixCheckbox.Indicator className="inline-flex">
        {/* The indicator renders only for checked OR indeterminate; pick the
            glyph from the live state so `mixed` shows the minus, not the check. */}
        {checked === 'indeterminate' ? (
          <Icon name="minus" size="sm" decorative />
        ) : (
          <Icon name="check" size="sm" decorative />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  )

  // The optional inline label wraps the control in a <label> so a click on the
  // text toggles the box (full field labelling is FormField's job). Without a
  // label, the bare control is returned for FormField / a consumer to bind.
  if (label === undefined) return control
  return (
    <label htmlFor={id} className="inline-flex items-center gap-[var(--space-2)] font-ui text-sm text-ink">
      {control}
      <span>{label}</span>
    </label>
  )
})
