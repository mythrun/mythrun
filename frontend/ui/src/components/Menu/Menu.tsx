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
// Each item highlights via the `--surface-raised-hover` token-swap on
// `data-highlighted` (Radix's keyboard/pointer focus marker); disabled items read
// muted. Header rows render as non-interactive `DropdownMenu.Label`s. Layered at
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
            // Width cap (mirrors Popover): a long label must truncate inside the
            // portal, not widen it past the viewport — portalled fixed-position
            // content never shows up in body.scrollWidth, so the CI overflow gate
            // cannot see this class of overflow. Radix exposes the available
            // width as a var; min() it with the same 20rem Popover uses.
            'max-w-[min(20rem,var(--radix-dropdown-menu-content-available-width))]',
            'rounded-none border border-border-strong bg-surface-raised text-ink font-ui',
          )}
        >
          {/* The label rides a block-level span INSIDE the flex row: text-overflow
              only applies to block containers, so `truncate` on the flex row itself
              hard-clips mid-glyph with no ellipsis. min-w-0 lets the span shrink
              below its content size; the row keeps flex/items-center for the 44px
              coarse-pointer centering. */}
          {items.map((entry, index) =>
            'header' in entry ? (
              <RadixMenu.Label
                key={`header-${index}`}
                className={cn(
                  'flex select-none items-center',
                  'px-[var(--space-3)] py-[var(--space-2)] text-sm font-medium',
                )}
              >
                <span className="min-w-0 truncate">{entry.label}</span>
              </RadixMenu.Label>
            ) : (
              <RadixMenu.Item
                key={entry.value}
                disabled={entry.disabled ?? false}
                // Radix's onSelect passes a DOM Event; the contract is DOM-free, so we
                // discard it and emit the neutral item value (§9).
                onSelect={() => onSelect?.(entry.value)}
                className={cn(
                  'relative flex cursor-pointer select-none items-center',
                  'px-[var(--space-3)] py-[var(--space-2)] text-sm',
                  // ≥44px rows on touch (matches the Button/IconButton floor).
                  'pointer-coarse:min-h-[44px]',
                  // Raised-tier highlight: --surface-hover equals --surface-raised
                  // in dark theme (both paper-700), which made keyboard focus and
                  // hover INVISIBLE inside the raised popover. The dedicated
                  // raised-tier token keeps one visible step in both themes.
                  'rounded-none outline-none data-[highlighted]:bg-surface-raised-hover',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-tertiary',
                )}
              >
                <span className="min-w-0 truncate">{entry.label}</span>
              </RadixMenu.Item>
            ),
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}
