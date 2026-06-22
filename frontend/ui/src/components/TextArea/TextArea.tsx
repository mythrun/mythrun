import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { TextAreaProps, InputSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Multi-line text input — a REAL native <textarea> (real form control + a11y).
// The multi-line sibling of Input: same neutral `onChange(value)` (§9), same
// flat 1-bit register (0px corners, `--border-strong`, `bg-surface`/`text-ink`,
// `font-ui` mono), same theme-aware focus ring, same invalid/disabled/read-only
// behaviour. See Input.tsx for the per-state rationale.
//
// Geometry differs: height comes from native `rows` (auto-height), not a fixed
// `--control-*` height. The `--control-*` token sets a per-control MIN height so
// even a 1-row textarea clears the touch floor; vertical padding gives the text
// breathing room, and only vertical resize is allowed (the base layer pins
// `resize: vertical`).
const SIZE_CLASS: Record<InputSize, string> = {
  sm: 'min-h-[var(--control-sm)] px-[var(--space-2)] py-[var(--space-2)] text-sm',
  md: 'min-h-[var(--control-md)] px-[var(--space-3)] py-[var(--space-2)] text-sm',
  lg: 'min-h-[var(--control-lg)] px-[var(--space-4)] py-[var(--space-3)] text-base',
}

const textArea = cva(
  cn(
    'block w-full font-ui bg-surface text-ink',
    'rounded-none border border-border-strong',
    'placeholder:text-ink-tertiary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-tertiary disabled:border-border-strong',
    'read-only:cursor-default',
  ),
  {
    variants: {
      size: SIZE_CLASS,
      invalid: {
        true: 'border-border-danger focus-visible:outline-border-danger',
        false: '',
      },
    },
    defaultVariants: { size: 'md', invalid: false },
  },
)

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    value,
    defaultValue,
    onChange,
    placeholder,
    name,
    id,
    size = 'md',
    rows,
    invalid = false,
    disabled = false,
    readOnly = false,
    required = false,
    ...rest
  },
  ref,
) {
  return (
    <textarea
      ref={ref}
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
      rows={rows}
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      aria-invalid={invalid || undefined}
      className={cn(textArea({ size, invalid }))}
      {...rest}
    />
  )
})
