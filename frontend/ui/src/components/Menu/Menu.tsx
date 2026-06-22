import { DropdownMenu as RadixMenu } from 'radix-ui'
import type { MenuProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Menu / DropdownMenu — the unstyled Radix `DropdownMenu` primitive (open on
// Enter/Space/ArrowDown, roving ArrowKey navigation across items, Enter to select,
// Esc-to-close with focus-RETURN to the trigger, a portalled content layer, ARIA
// `menu`/`menuitem` wiring), styled 100% with our tokens. The contract stays
// DOM-free — selection is the neutral `onSelect(value)` callback (§9), open/close
// is `onOpenChange(open)`; never a DOM event.
//
// Visuals follow the flat 1-bit register (§3): the CONTENT sits on the
// `--surface-raised` tier with a 1px `--border-strong` edge, 0px radius, NO shadow.
// Each item highlights via the `--surface-hover` token-swap on `data-highlighted`
// (Radix's keyboard/pointer focus marker); disabled items read muted. Layered at
// `--z-dropdown` (1000).
export function Menu({
  trigger,
  items,
  onSelect,
  open,
  onOpenChange,
  side = 'bottom',
  'data-testid': dataTestId,
}: MenuProps) {
  // Radix's props are non-undefined under `exactOptionalPropertyTypes`, so we
  // conditionally spread the optional controlled-open props.
  return (
    <RadixMenu.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
          side={side}
          sideOffset={4}
          className={cn(
            'z-[var(--z-dropdown)] min-w-[10rem] overflow-hidden p-[var(--space-1)]',
            'rounded-none border border-border-strong bg-surface-raised text-ink font-ui',
          )}
        >
          {items.map((item) => (
            <RadixMenu.Item
              key={item.value}
              disabled={item.disabled ?? false}
              // Radix's onSelect passes a DOM Event; the contract is DOM-free, so we
              // discard it and emit the neutral item value (§9).
              onSelect={() => onSelect?.(item.value)}
              className={cn(
                'relative flex cursor-pointer select-none items-center',
                'px-[var(--space-3)] py-[var(--space-2)] text-sm',
                'rounded-none outline-none data-[highlighted]:bg-surface-hover',
                'data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-tertiary',
              )}
            >
              {item.label}
            </RadixMenu.Item>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}
