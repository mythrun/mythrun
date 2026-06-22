import { Dialog as RadixDialog } from 'radix-ui'
import type { ModalProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { IconButton } from '../IconButton/IconButton.tsx'

// Modal dialog — the unstyled Radix `Dialog` primitive (focus TRAP, focus-RETURN
// to the trigger on close, Esc-to-close, scroll lock, ARIA `dialog` wiring, a
// portalled overlay + panel), styled 100% with our tokens. Radix supplies the
// headline a11y; the contract stays DOM-free — open/close is the neutral
// `onOpenChange(open)` boolean (§9), never a DOM event. The native mirror swaps
// the platform modal behind the same API.
//
// Visuals follow the flat 1-bit register (§3): the PANEL sits on the
// `--surface-overlay` modal tier with a 1px `--border-strong` edge, 0px radius,
// NO shadow — depth rides on the surface tier + the `--scrim` veil, not elevation.
// The SCRIM is the `--z-overlay` layer (1200); the panel is `--z-modal` (1300).
// The `title` is the required accessible name (Radix `Dialog.Title` →
// `aria-labelledby`); `description` (optional) wires `aria-describedby`. The close
// control is an IconButton (icon `close`, label = the consumer's i18n key), so it
// is never nameless.
export function Modal({
  title,
  description,
  closeLabel,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  closeOnScrimClick = true,
  children,
  'data-testid': dataTestId,
}: ModalProps) {
  // Radix's props are non-undefined under `exactOptionalPropertyTypes`, so we
  // conditionally spread the optional controlled props rather than forwarding an
  // explicit `undefined` (a type error).
  return (
    <RadixDialog.Root
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger !== undefined ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}

      <RadixDialog.Portal>
        {/* Scrim — the dimming veil. `--z-overlay` (1200), under the panel. */}
        <RadixDialog.Overlay
          data-mythrun-scrim=""
          className={cn('fixed inset-0 z-[var(--z-overlay)] bg-scrim')}
        />
        <RadixDialog.Content
          {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
          // When scrim-click should NOT close, swallow the Radix interact-outside
          // event (fires for the scrim + the pointer-dismiss). Esc + the close
          // button still work. Conditionally spread so we never pass `undefined`
          // (an exactOptionalPropertyTypes error).
          {...(closeOnScrimClick
            ? {}
            : {
                onInteractOutside: (e: Event) => {
                  e.preventDefault()
                },
              })}
          className={cn(
            'fixed left-1/2 top-1/2 z-[var(--z-modal)] -translate-x-1/2 -translate-y-1/2',
            'w-[min(92vw,32rem)] max-h-[85vh] overflow-y-auto',
            'flex flex-col gap-[var(--space-3)] p-[var(--space-5)]',
            'rounded-none border border-border-strong bg-surface-overlay text-ink font-ui',
            'focus:outline-none',
          )}
        >
          <div className="flex items-start justify-between gap-[var(--space-3)]">
            <div className="flex flex-col gap-[var(--space-1)]">
              <RadixDialog.Title className="text-lg font-semibold text-ink">{title}</RadixDialog.Title>
              {description !== undefined ? (
                <RadixDialog.Description className="text-sm text-ink-secondary">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close asChild>
              <IconButton icon="close" label={closeLabel} variant="ghost" size="sm" />
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
