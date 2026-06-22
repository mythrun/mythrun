import { Popover as RadixPopover } from 'radix-ui'
import type { PopoverProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Popover — the unstyled Radix `Popover` primitive (a portalled content layer
// anchored to the trigger, focus move INTO the content and BACK to the trigger on
// close, Esc-to-close, ARIA wiring), styled 100% with our tokens. Unlike a
// Tooltip it holds INTERACTIVE content (the entity-card popover, spec §12). The
// contract stays DOM-free — open/close is the neutral `onOpenChange(open)` (§9).
//
// Visuals follow the flat 1-bit register (§3): the CONTENT sits on the
// `--surface-raised` popover tier with a 1px `--border-strong` edge, 0px radius,
// NO shadow — depth rides on the border + surface tier. Layered at `--z-popover`
// (1100).
export function Popover({
  trigger,
  label,
  open,
  defaultOpen,
  onOpenChange,
  side = 'bottom',
  children,
  'data-testid': dataTestId,
}: PopoverProps) {
  // Radix's props are non-undefined under `exactOptionalPropertyTypes`, so we
  // conditionally spread the optional controlled props.
  return (
    <RadixPopover.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
          aria-label={label}
          side={side}
          sideOffset={4}
          className={cn(
            'z-[var(--z-popover)] w-[min(20rem,var(--radix-popover-content-available-width))]',
            'flex flex-col gap-[var(--space-2)] p-[var(--space-4)]',
            'rounded-none border border-border-strong bg-surface-raised text-ink font-ui',
            'focus:outline-none',
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
