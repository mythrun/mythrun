import { forwardRef } from 'react'
import { RadioGroup as RadixRadioGroup } from 'radix-ui'
import type { RadioGroupProps, RadioProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Radio / RadioGroup — the unstyled Radix `RadioGroup` primitive (arrow-key
// roving selection within the group, ARIA `radiogroup`/`radio`, a hidden form
// input), styled 100% with our tokens. The native mirror is `rn-primitives`
// (same API) — the contract stays DOM-free, so Radix's `onValueChange(value)`
// maps to the neutral `onChange` (§9) with no DOM event surfaced.
//
// `RadioGroup` owns the value/name/keyboard model; `Radio` is an item that MUST
// render inside it. Flat 1-bit (§3): 0px radius EVERYWHERE — no rounded exception.
// The item is a SQUARE box (`rounded-none`, 1px `--border-strong` edge, `--surface`
// fill); selecting it FILLS an inset inner square in the `--accent` token. That
// filled-square fill is how a Radio differs from a Checkbox (the Checkbox stamps a
// `check` glyph; the Radio fills its box). The focus ring is the shared theme-aware
// `outline-accent`; disabled gets the muted token swap (a11y-exempt for contrast, §4).

// RadioGroup is the container; `children` are the Radio items. It carries the
// neutral controlled/uncontrolled value model.
export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroup(
  { value, defaultValue, onChange, name, disabled = false, id, describedBy, children },
  ref,
) {
  // Radix's prop types are non-undefined under `exactOptionalPropertyTypes`, so
  // we conditionally spread the optional controlled props (an explicit
  // `undefined` would be a type error) rather than always forwarding them.
  return (
    <RadixRadioGroup.Root
      ref={ref}
      {...(id !== undefined ? { id } : {})}
      {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})}
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onChange ? { onValueChange: onChange } : {})}
      {...(name !== undefined ? { name } : {})}
      disabled={disabled}
      className={cn('flex flex-col gap-[var(--space-2)]')}
    >
      {children}
    </RadixRadioGroup.Root>
  )
})

// A single option. The square box + accent fill are token-styled; the optional
// inline label wraps the item in a <label> so clicking the text selects it.
export const Radio = forwardRef<HTMLButtonElement, RadioProps>(function Radio(
  { value, label, disabled = false, id },
  ref,
) {
  const item = (
    <RadixRadioGroup.Item
      ref={ref}
      {...(id !== undefined ? { id } : {})}
      value={value}
      disabled={disabled}
      className={cn(
        'inline-flex h-[var(--space-5)] w-[var(--space-5)] shrink-0 items-center justify-center',
        // 0px radius everywhere — a SQUARE box (matches Checkbox), no rounded exception.
        'rounded-none border border-border-strong bg-surface',
        'data-[state=checked]:border-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:border-border-strong',
        'cursor-pointer',
      )}
    >
      <RadixRadioGroup.Indicator
        // Selected = a solid accent square FILLING the box with an even ~5px gutter
        // (14px in the 24px box ≈ 58%). Reads as a "filled box" — distinct from the
        // Checkbox's edge-to-edge flood + check glyph. (33% read as a floating speck.)
        className={cn('inline-flex h-[14px] w-[14px] rounded-none bg-accent')}
      />
    </RadixRadioGroup.Item>
  )

  if (label === undefined) return item
  return (
    <label htmlFor={id} className="inline-flex items-center gap-[var(--space-2)] font-ui text-sm text-ink">
      {item}
      <span>{label}</span>
    </label>
  )
})
