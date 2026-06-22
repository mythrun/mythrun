import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { InputProps, InputSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Single-line text input — a REAL native <input> (real form control + a11y),
// never a contentEditable div. `onChange` is the platform-neutral value
// callback (§9): the impl pulls `e.target.value` and hands the consumer a plain
// string, so the contract never leaks the DOM ChangeEvent.
//
// Visuals follow the flat 1-bit register (see Button.tsx for the rationale on
// the token-focus idiom): `rounded-none` (0px radius), a 1px `--border-strong`
// interactive boundary (§3 — depth rides on borders, not shadows), `bg-surface`
// fill, `text-ink` content. Inputs are DATA, so they use `font-ui` (the mono UI
// face). The control height is the `--control-*` token (§4).
//
// Focus ring (a11y-critical, §3): a 2px hard square outline, 2px offset. Color
// is theme-aware via the `outline-accent` token utility (== --focus-ring-color
// in both themes); no-ad-hoc-color (R3) bans the arbitrary token wrapper.
//
// invalid (§4): the danger-border token + a DANGER-colored focus ring, AND
// `aria-invalid` on the element (set in the impl, not via class) — both halves,
// so the state is conveyed to AT and not by color alone.
//
// disabled / readOnly: the native attributes + muted token styling
// (`disabled:` swaps to `--surface` bg + `--ink-tertiary` text; a11y-exempt for
// contrast as an inactive control, §4).
const SIZE_CLASS: Record<InputSize, string> = {
  sm: 'h-[var(--control-sm)] px-[var(--space-2)] text-sm',
  md: 'h-[var(--control-md)] px-[var(--space-3)] text-sm',
  lg: 'h-[var(--control-lg)] px-[var(--space-4)] text-base',
}

const input = cva(
  cn(
    'block w-full font-ui bg-surface text-ink',
    // Flat 1-bit: 0px corners + the strong interactive border.
    'rounded-none border border-border-strong',
    // Placeholder reads as muted, secondary text.
    'placeholder:text-ink-tertiary',
    // Theme-aware focus ring (default — the invalid arm overrides the color).
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    // Disabled / read-only: muted token swap, non-interactive cursor.
    'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-tertiary disabled:border-border-strong',
    'read-only:cursor-default',
  ),
  {
    variants: {
      size: SIZE_CLASS,
      // Invalid swaps the border to the danger token AND recolors the focus ring
      // to danger. `aria-invalid` is set separately in the impl (not a class).
      invalid: {
        true: 'border-border-danger focus-visible:outline-border-danger',
        false: '',
      },
    },
    defaultVariants: { size: 'md', invalid: false },
  },
)

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    value,
    defaultValue,
    onChange,
    placeholder,
    type = 'text',
    name,
    id,
    size = 'md',
    invalid = false,
    disabled = false,
    readOnly = false,
    required = false,
    ...rest
  },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      value={value}
      defaultValue={defaultValue}
      onChange={
        onChange
          ? (e) => {
              onChange(e.target.value)
            }
          : undefined
      }
      placeholder={placeholder}
      name={name}
      id={id}
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      aria-invalid={invalid || undefined}
      className={cn(input({ size, invalid }))}
      {...rest}
    />
  )
})
