import type { GraphNode } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// The ACCESSIBLE representation of the world-gen graph (MYT-89 C4). The Canvas is
// decorative (`aria-hidden`); THIS list is how assistive-tech, keyboard, and touch
// users perceive the forming world and select an entity. A real `<ul>` of real
// `<button>`s — native keyboard activation + tab order, no ARIA reinvention. It is
// also the whole testable surface (jsdom has no Canvas). Flat 1-bit paper register:
// no borders/boxes/dots — the selected row is a quiet surface token-swap.

// Placeholder copy pending brand i18n (Miklos owns user-facing strings). The item
// text is DATA (the entity's real name + kind), not invented prose, so it ships as
// is; only the chrome labels are deferred.
const LIST_ARIA_LABEL = '[ph: entities in your forming world]'
const EMPTY_LABEL = '[ph: the world is still taking shape]'

const ITEM_CLASS = cn(
  'group flex w-full items-baseline justify-between gap-[var(--space-3)] text-left',
  'bg-transparent text-ink rounded-none cursor-pointer select-none',
  'px-[var(--space-3)] py-[var(--space-2)]',
  'hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
const NAME_CLASS = 'min-w-0 truncate font-body text-sm leading-[1.4]'
const KIND_CLASS = 'shrink-0 font-ui text-[0.65rem] uppercase tracking-wide text-ink-tertiary'

export interface EntityListProps {
  nodes: GraphNode[]
  selectedKey: string | undefined
  onSelect: (synthKey: string) => void
}

export function EntityList({ nodes, selectedKey, onSelect }: EntityListProps): React.JSX.Element {
  return (
    <ul aria-label={LIST_ARIA_LABEL} className="min-w-0 max-h-full overflow-y-auto">
      {nodes.length === 0 && (
        <li className="px-[var(--space-3)] py-[var(--space-2)] font-body text-sm text-ink-tertiary">
          {EMPTY_LABEL}
        </li>
      )}
      {nodes.map((node) => {
        const selected = node.synthKey === selectedKey
        return (
          <li key={node.synthKey}>
            <button
              type="button"
              onClick={() => {
                onSelect(node.synthKey)
              }}
              aria-current={selected ? 'true' : undefined}
              data-selected={selected ? 'true' : undefined}
              className={cn(ITEM_CLASS, selected && 'bg-surface-active')}
            >
              <span className={NAME_CLASS}>{node.name}</span>
              <span className={KIND_CLASS}>{node.kind}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
