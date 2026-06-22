import { forwardRef } from 'react'
import { Switch as RadixSwitch } from 'radix-ui'
import type { SwitchProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Switch — the unstyled Radix `Switch` primitive (Space-to-toggle keyboard, ARIA
// `role="switch"`/`aria-checked`, a hidden form input), styled 100% with our
// tokens. The native mirror is `rn-primitives` (same API) — the contract stays
// DOM-free, so Radix's `onCheckedChange(checked)` maps to the neutral `onChange`
// (§9) with no DOM event surfaced.
//
// Flat 1-bit (§3): a pill TRACK with a square THUMB. off → `--surface` track +
// `--border-strong` edge; on → `--accent` fill (the token-swap). The thumb
// SLIDES via a logical-property translate — but that's a control affordance (the
// state IS its position), not decorative motion. We keep it to `transform` +
// `--duration-fast`/`--ease-out`; the global `prefers-reduced-motion` reset in
// base.css neutralises the transition for motion-averse users (the on/off color
// swap still conveys the state, so motion is never the sole signal). disabled
// gets the muted token swap (a11y-exempt for contrast, §4); the focus ring is the
// shared theme-aware `outline-accent`.

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, defaultChecked, onChange, disabled = false, id, name, label },
  ref,
) {
  // Radix's prop types are non-undefined under `exactOptionalPropertyTypes`, so
  // we conditionally spread the optional controlled props (passing an explicit
  // `undefined` would be a type error) rather than always forwarding them.
  const control = (
    <RadixSwitch.Root
      ref={ref}
      {...(id !== undefined ? { id } : {})}
      {...(name !== undefined ? { name } : {})}
      {...(checked !== undefined ? { checked } : {})}
      {...(defaultChecked !== undefined ? { defaultChecked } : {})}
      {...(onChange ? { onCheckedChange: onChange } : {})}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-[var(--space-5)] w-[var(--space-8)] shrink-0 items-center',
        'rounded-full border border-border-strong bg-surface p-[2px]',
        'data-[state=checked]:bg-accent data-[state=checked]:border-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:bg-surface disabled:border-border-strong',
        'cursor-pointer',
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          'block h-[var(--space-3)] w-[var(--space-3)] rounded-full bg-paper-50',
          // The slide IS the state — opacity/position only, fast + eased, reduced-motion-safe.
          'transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)]',
          'translate-x-0 data-[state=checked]:translate-x-[var(--space-3)]',
        )}
      />
    </RadixSwitch.Root>
  )

  if (label === undefined) return control
  return (
    <label htmlFor={id} className="inline-flex items-center gap-[var(--space-2)] font-ui text-sm text-ink">
      {control}
      <span>{label}</span>
    </label>
  )
})
