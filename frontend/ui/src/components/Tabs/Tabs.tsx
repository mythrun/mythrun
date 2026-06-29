import { Tabs as RadixTabs } from 'radix-ui'
import type { TabsProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Tabs — the unstyled Radix `Tabs` primitive (roving-tabindex ArrowKey navigation
// across the tab list, ARIA `tablist`/`tab`/`tabpanel` wiring with
// `aria-controls`/`aria-labelledby` between each tab and its panel), styled 100%
// with our tokens. The contract stays DOM-free — `onChange(value)` is the neutral
// value callback (§9), never a DOM event.
//
// Visuals follow the flat 1-bit register (§3): the tab LIST sits on a 1px
// `--border-strong` bottom rule; the ACTIVE tab is marked with a flat
// `--border-strong` underline indicator (a bottom border that overlaps the list
// rule — token, NO shadow). Inactive tabs read muted; the active tab reads `--ink`.
// The theme-aware focus ring rides each tab.
export function Tabs({
  items,
  value,
  defaultValue,
  onChange,
  label,
  'data-testid': dataTestId,
}: TabsProps) {
  // Radix's props are non-undefined under `exactOptionalPropertyTypes`, so we
  // conditionally spread the optional controlled props. Default the uncontrolled
  // active tab to the first item so a panel always shows.
  const firstValue = items[0]?.value
  return (
    <RadixTabs.Root
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined
        ? { defaultValue }
        : value === undefined && firstValue !== undefined
          ? { defaultValue: firstValue }
          : {})}
      {...(onChange ? { onValueChange: onChange } : {})}
    >
      <RadixTabs.List
        aria-label={label}
        className={cn('flex border-b border-border-strong')}
      >
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled ?? false}
            className={cn(
              // -mb-px overlaps the active border onto the list rule (one flat line).
              '-mb-px px-[var(--space-4)] py-[var(--space-2)] text-sm font-ui',
              'border-b-2 border-transparent text-ink-tertiary',
              'data-[state=active]:border-border-strong data-[state=active]:text-ink',
              'rounded-none cursor-pointer select-none',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
              'disabled:cursor-not-allowed disabled:text-ink-tertiary disabled:opacity-60',
            )}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>

      {items.map((item) => (
        <RadixTabs.Content
          key={item.value}
          value={item.value}
          className={cn('pt-[var(--space-4)] text-ink font-ui focus:outline-none')}
        >
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  )
}
