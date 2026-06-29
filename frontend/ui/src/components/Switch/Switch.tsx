import { forwardRef } from 'react'
import { Switch as RadixSwitch } from 'radix-ui'
import type { SwitchProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Switch — a BINARY on/off that takes effect immediately (vs Checkbox, which stages a
// form value). Behaviour + a11y from the unstyled Radix `Switch` primitive (role=switch,
// Space-to-toggle, hidden form input, controlled + uncontrolled, disabled); the contract
// stays DOM-free, so Radix's `onCheckedChange(checked)` maps to the neutral `onChange`
// (§9). Styled 100% with tokens (R3 / no-ad-hoc-color).
//
// A clean, flat 1-bit RECTANGULAR slider that matches the rest of the control set: 0px
// radius, the same thin `border-border-strong` + parchment fill as the inputs and the
// unchecked checkbox when OFF, and a filled `--accent` ember square (the selected-radio
// idiom) when ON. The thumb is an ink square OFF and a parchment square ON, so it stays
// legible against both the parchment and the ember and the state reads from BOTH colour
// and position — which keeps it legible under the global prefers-reduced-motion reset
// (base.css), where the `transform` slide is neutralised but the colour swap survives.
//
// Geometry is whole-pixel (border-box) so the slide stays crisp: track 48×24, 1px
// border, 2px padding → a 42×18 content box; the thumb is an 18px square (full content
// height). Travel = TRACK_W − 2·border − 2·padding − thumb = 24px, so OFF and ON rest at
// the same inset on each end (symmetric — fixes the old short-travel asymmetry). Colour
// stays on token classes; only the box geometry (px) is set inline — the 24px slide is a
// Tailwind arbitrary translate (a class, so it carries the literal).

const TRACK_W = 48
const TRACK_H = 24
const BORDER = 1
const PAD = 2
const THUMB = TRACK_H - 2 * BORDER - 2 * PAD // 18 — square, full content height

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, defaultChecked, onChange, disabled = false, id, describedBy, name, label },
  ref,
) {
  // Radix's prop types are non-undefined under `exactOptionalPropertyTypes`, so we
  // conditionally spread the optional controlled props rather than forwarding undefined.
  const control = (
    <RadixSwitch.Root
      ref={ref}
      {...(id !== undefined ? { id } : {})}
      {...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {})}
      {...(name !== undefined ? { name } : {})}
      {...(checked !== undefined ? { checked } : {})}
      {...(defaultChecked !== undefined ? { defaultChecked } : {})}
      {...(onChange ? { onCheckedChange: onChange } : {})}
      disabled={disabled}
      style={{ width: TRACK_W, height: TRACK_H, padding: PAD, borderWidth: BORDER }}
      className={cn(
        // Sharp parchment square — same thin border + fill as the inputs / unchecked checkbox.
        'relative inline-flex shrink-0 items-center rounded-none border-solid',
        'border-border-strong bg-surface',
        // ON: a filled ember square — the form's selected-radio idiom.
        'data-[state=checked]:bg-accent data-[state=checked]:border-accent',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
        // disabled keeps the boundary visible (never borderless), just dimmed.
        'disabled:cursor-not-allowed disabled:opacity-50',
        'cursor-pointer',
      )}
    >
      <RadixSwitch.Thumb
        style={{ width: THUMB, height: THUMB }}
        className={cn(
          'block shrink-0 rounded-none',
          // OFF: ink square on parchment. ON: parchment square on ember (stays legible).
          'bg-ink data-[state=checked]:bg-surface',
          // Exact, symmetric, whole-pixel slide (24px — see the geometry note above), on a
          // slightly CLICKY curve: a small overshoot snaps the thumb into place at the end.
          'translate-x-0 data-[state=checked]:translate-x-[24px]',
          'transition-transform duration-[var(--duration-base)] ease-[cubic-bezier(0.34,1.45,0.64,1)]',
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
