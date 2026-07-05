import { forwardRef } from 'react'
import type { EntityKind } from '@mythrun/contract/rest'
import type { WikiEntity, WorldWikiProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Text } from '../Text/Text.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Divider } from '../Divider/Divider.tsx'
import { SeamlessInput } from '../SeamlessInput/SeamlessInput.tsx'
import { filterWikiModel } from './filter-model.ts'

// WorldWiki (MYT-89 Phase D) — the browsable wiki the owner explores their newly
// generated world through. A borderless search field over a grouped tree
// (factions/locations/npcs/items); nested locations indent under their parent via
// nested <ul>s; the SELECTED entity opens to its facts. Flat 1-bit paper register:
// no boxes/cards/circles — quiet Divider hairlines separate groups, a surface
// token-swap marks the selected row. Selection + query are PROP-DRIVEN (D3 shares
// `selectedId` with the graph), so this component holds no state of its own.
//
// The DS owns no copy: the search label/placeholder, per-kind group headings, and
// empty-state note arrive as `[ph: …]`-defaulted props. Entity names + facts are
// DATA (from the model) and render as-is. Raw <ul>/<li>/<button> carry the tree
// SEMANTICS + keyboard activation (native tab order, Enter/Space) — mirrors the
// C4 EntityList; all TEXT flows through the Text/Heading primitives.

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
// The opened-entity facts region: a quiet indented column, one fact per row
// (mono topic label over serif prose content). No box — just inset + spacing.
const FACTS_CLASS = 'flex flex-col gap-[var(--space-3)] px-[var(--space-3)] pb-[var(--space-3)] pl-[var(--space-5)]'

/** Resolve a kind's heading copy from the consumer map, else a `[ph: …]` default. */
function groupHeading(kind: EntityKind, groupLabels: WorldWikiProps['groupLabels']): string {
  return groupLabels?.[kind] ?? `[ph: ${kind}]`
}

interface FactListProps {
  entity: WikiEntity
}

/** The opened entity's facts as readable prose — topic label over its content. */
function FactList({ entity }: FactListProps): React.JSX.Element | null {
  if (entity.facts.length === 0) return null
  return (
    <div className={FACTS_CLASS}>
      {entity.facts.map((fact) => (
        <div key={fact.id}>
          <Text role="ui-caption" as="p">
            {fact.topic}
          </Text>
          <Text role="prose-body" as="p">
            {fact.content}
          </Text>
        </div>
      ))}
    </div>
  )
}

interface EntityNodeProps {
  entity: WikiEntity
  selectedId: string | undefined
  onSelect: (id: string) => void
}

/** One tree row: the selectable entity button, its facts when selected, and a
 *  nested <ul> of child entities (recursing) indented under it. */
function EntityNode({ entity, selectedId, onSelect }: EntityNodeProps): React.JSX.Element {
  const selected = entity.id === selectedId
  const children = entity.children ?? []
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onSelect(entity.id)
        }}
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        className={cn(ITEM_CLASS, selected && 'bg-surface-active')}
      >
        <Text role="prose-body" truncate>
          {entity.name}
        </Text>
      </button>
      {selected && <FactList entity={entity} />}
      {children.length > 0 && (
        <ul className={NESTED_LIST_CLASS}>
          {children.map((child) => (
            <EntityNode key={child.id} entity={child} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  )
}

export const WorldWiki = forwardRef<HTMLDivElement, WorldWikiProps>(function WorldWiki(
  {
    model,
    selectedId,
    onSelect,
    query,
    onQuery,
    searchLabel = '[ph: search the world]',
    searchPlaceholder = '[ph: search]',
    groupLabels,
    emptyLabel = '[ph: nothing here]',
    'data-testid': dataTestId,
  },
  ref,
) {
  const filtered = filterWikiModel(model, query ?? '')
  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className="flex min-w-0 flex-col gap-[var(--space-4)]"
    >
      <SeamlessInput
        label={searchLabel}
        value={query ?? ''}
        onChange={onQuery}
        placeholder={searchPlaceholder}
      />
      <div className="min-w-0 max-h-full overflow-y-auto">
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
                  <EntityNode
                    key={entity.id}
                    entity={entity}
                    selectedId={selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
})
