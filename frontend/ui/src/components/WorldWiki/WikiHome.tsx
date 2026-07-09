import type { EntityKind } from '@mythrun/contract/rest'
import type { WikiEntity, WikiViewModel, WorldWikiProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Text } from '../Text/Text.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Divider } from '../Divider/Divider.tsx'
import { SeamlessInput } from '../SeamlessInput/SeamlessInput.tsx'
import { filterWikiModel } from './filter-model.ts'

// WikiHome (MYT-89 D4) — the wiki's landing: the borderless search field over
// browse-by-kind groups (factions/locations/npcs/items; nested locations
// indent under their parent via nested <ul>s). Every entity row is a
// NAVIGATION affordance now — it opens the entity's page (no inline fact
// dropdown anymore; the page carries the body). Flat 1-bit paper register:
// no boxes/cards/circles — quiet Divider hairlines separate groups; the
// graph-selected entity's row is marked with a quiet surface token-swap.
//
// The DS owns no copy: labels arrive resolved from the shell (which defaults
// them to `[ph: …]`). Entity names are DATA and render as-is. Raw
// <ul>/<li>/<button> carry the tree semantics + native keyboard activation.

const ITEM_CLASS = cn(
  'flex w-full min-w-0 items-baseline text-left',
  'bg-transparent text-ink rounded-none cursor-pointer select-none',
  'px-[var(--space-3)] py-[var(--space-2)]',
  'hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
// Nested locations indent structurally: each deeper <ul> adds a left inset, so the
// hierarchy reads from the layout — no per-depth computed style needed.
const NESTED_LIST_CLASS = 'pl-[var(--space-4)]'

/** Resolve a kind's heading copy from the consumer map, else a `[ph: …]` default. */
function groupHeading(kind: EntityKind, groupLabels: WorldWikiProps['groupLabels']): string {
  return groupLabels?.[kind] ?? `[ph: ${kind}]`
}

interface EntityNodeProps {
  entity: WikiEntity
  selectedId: string | undefined
  onOpen: (entityId: string) => void
}

/** One browse row: the entity button (opens its page) and a nested <ul> of
 *  child entities (recursing) indented under it. */
function EntityNode({ entity, selectedId, onOpen }: EntityNodeProps): React.JSX.Element {
  const selected = entity.id === selectedId
  const children = entity.children ?? []
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onOpen(entity.id)
        }}
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        className={cn(ITEM_CLASS, selected && 'bg-surface-active')}
      >
        <Text role="prose-body" truncate>
          {entity.name}
        </Text>
      </button>
      {children.length > 0 && (
        <ul className={NESTED_LIST_CLASS}>
          {children.map((child) => (
            <EntityNode key={child.id} entity={child} selectedId={selectedId} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  )
}

export interface WikiHomeProps {
  model: WikiViewModel
  /** The graph-selected entity, if any — its row is marked (prop-driven). */
  selectedId: string | undefined
  /** Open an entity's page. Neutral — carries the entity id. */
  onOpen: (entityId: string) => void
  /** The current search query (controlled by the shell). */
  query: string
  onQuery: (query: string) => void
  /** i18n'd chrome copy, resolved by the shell (the DS owns none). */
  searchLabel: string
  searchPlaceholder: string
  groupLabels?: WorldWikiProps['groupLabels']
  emptyLabel: string
}

export function WikiHome({
  model,
  selectedId,
  onOpen,
  query,
  onQuery,
  searchLabel,
  searchPlaceholder,
  groupLabels,
  emptyLabel,
}: WikiHomeProps): React.JSX.Element {
  const filtered = filterWikiModel(model, query)
  return (
    <div className="flex max-h-full min-h-0 min-w-0 flex-col gap-[var(--space-4)]">
      <SeamlessInput
        label={searchLabel}
        value={query}
        onChange={onQuery}
        placeholder={searchPlaceholder}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {filtered.groups.length === 0 ? (
          <Text role="prose-body" as="p">
            {emptyLabel}
          </Text>
        ) : (
          filtered.groups.map((group, index) => (
            <section key={group.kind}>
              {index > 0 && <Divider tone="border" />}
              <Heading level={2} role="title">
                {groupHeading(group.kind, groupLabels)}
              </Heading>
              <ul className="min-w-0">
                {group.entities.map((entity) => (
                  <EntityNode key={entity.id} entity={entity} selectedId={selectedId} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
