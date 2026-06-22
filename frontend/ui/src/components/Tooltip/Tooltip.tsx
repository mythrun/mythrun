import { Tooltip as RadixTooltip } from 'radix-ui'
import type { TooltipProps, TooltipProviderProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Tooltip — the unstyled Radix `Tooltip` primitive (hover/focus open with a
// shared delay, Esc/blur close, a portalled bubble, `aria-describedby` wiring),
// styled 100% with our tokens. Appears on hover AND keyboard focus.
//
// SUPPLEMENTARY ONLY (documented on the contract + story): the tooltip is a
// DESCRIPTION (`aria-describedby`), never the trigger's NAME — and it does not
// appear on touch. The trigger must be an already-labelled control; the tooltip
// carries the EXTRA hint, never the only one. Never make it the sole label for,
// or sole access to, an action.
//
// Visuals follow the flat 1-bit register (§3): a small token-styled bubble on the
// `--surface-raised` tier with a 1px `--border-strong` edge, 0px radius, NO shadow.
// Layered at `--z-tooltip` (1500, the top of the stack).
export function Tooltip({
  trigger,
  content,
  side = 'top',
  'data-testid': dataTestId,
}: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{trigger}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
          side={side}
          sideOffset={4}
          className={cn(
            'z-[var(--z-tooltip)] max-w-[16rem] px-[var(--space-2)] py-[var(--space-1)]',
            'rounded-none border border-border-strong bg-surface-raised text-ink',
            'font-ui text-xs',
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

// TooltipProvider — coordinates the shared open/close delay so moving between
// adjacent triggers feels instant. Mount ONCE near the app ROOT; every Tooltip
// must have one as an ancestor.
export function TooltipProvider({ delayDuration, children }: TooltipProviderProps) {
  return (
    <RadixTooltip.Provider {...(delayDuration !== undefined ? { delayDuration } : {})}>
      {children}
    </RadixTooltip.Provider>
  )
}
