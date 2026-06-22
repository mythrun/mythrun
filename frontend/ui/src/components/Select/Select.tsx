import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import { Select as RadixSelect } from 'radix-ui'
import type { SelectProps, SelectSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'

// Single-select dropdown — the unstyled Radix `Select` primitive (focus
// management, type-ahead, ArrowKey navigation, ARIA listbox, a portalled
// content layer), styled 100% with our tokens. The native mirror is
// `rn-primitives` (same API) — the contract stays DOM-free so the swap is
// mechanical. Radix's `onValueChange(value)` maps to the neutral `onChange`;
// the contract never exposes a DOM event (§9).
//
// Visuals follow the flat 1-bit register (see Input.tsx for the rationale): the
// TRIGGER is shaped exactly like an Input — `rounded-none`, a 1px
// `--border-strong` interactive boundary, `bg-surface`/`text-ink`, mono
// `font-ui` (a chosen value is data), and the theme-aware `outline-accent`
// focus ring. invalid swaps the border + ring to the danger token AND sets
// `aria-invalid` on the trigger (both halves — not color alone). disabled gets
// the muted token swap (a11y-exempt for contrast, §4).
//
// The CONTENT (portalled listbox) sits on the `--surface-raised` popover tier
// with a `--border-strong` edge — flat 1-bit puts depth on the border, not a
// shadow. Each item highlights via the `--surface-hover` token-swap on
// `data-highlighted` (Radix's keyboard/pointer focus marker); the selected item
// shows a `check` glyph through `Select.ItemIndicator`.
const TRIGGER_SIZE: Record<SelectSize, string> = {
  sm: 'h-[var(--control-sm)] px-[var(--space-2)] text-sm',
  md: 'h-[var(--control-md)] px-[var(--space-3)] text-sm',
  lg: 'h-[var(--control-lg)] px-[var(--space-4)] text-base',
}

const trigger = cva(
  cn(
    // Trigger lays out the value + chevron on one row; the value takes the slack.
    'inline-flex w-full items-center justify-between gap-[var(--space-2)]',
    'font-ui bg-surface text-ink',
    'rounded-none border border-border-strong',
    // Placeholder reads muted (Radix tags it `data-placeholder`).
    'data-[placeholder]:text-ink-tertiary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-tertiary disabled:border-border-strong',
  ),
  {
    variants: {
      size: TRIGGER_SIZE,
      invalid: {
        true: 'border-border-danger focus-visible:outline-border-danger',
        false: '',
      },
    },
    defaultVariants: { size: 'md', invalid: false },
  },
)

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    options,
    value,
    defaultValue,
    onChange,
    placeholder,
    size = 'md',
    invalid = false,
    disabled = false,
    name,
    id,
  },
  ref,
) {
  // Radix's prop types are non-undefined under `exactOptionalPropertyTypes`, so
  // we conditionally spread the optional controlled props (an explicit
  // `undefined` would be a type error) rather than always forwarding them.
  return (
    <RadixSelect.Root
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onChange ? { onValueChange: onChange } : {})}
      {...(name !== undefined ? { name } : {})}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        ref={ref}
        {...(id !== undefined ? { id } : {})}
        aria-invalid={invalid || undefined}
        className={cn(trigger({ size, invalid }))}
      >
        <RadixSelect.Value {...(placeholder !== undefined ? { placeholder } : {})} />
        <RadixSelect.Icon>
          <Icon name="chevron-down" size="sm" decorative />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-[var(--z-popover)] min-w-[var(--radix-select-trigger-width)] overflow-hidden',
            'rounded-none border border-border-strong bg-surface-raised text-ink font-ui',
          )}
        >
          <RadixSelect.Viewport className="p-[var(--space-1)]">
            {options.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                className={cn(
                  'relative flex cursor-pointer select-none items-center',
                  'gap-[var(--space-2)] py-[var(--space-2)] pl-[var(--space-3)] pr-[var(--space-2)] text-sm',
                  // Keyboard/pointer focus highlight — token-swap, no shadow.
                  'rounded-none outline-none data-[highlighted]:bg-surface-hover',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-tertiary',
                )}
              >
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="ml-auto inline-flex">
                  <Icon name="check" size="sm" decorative />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
})
