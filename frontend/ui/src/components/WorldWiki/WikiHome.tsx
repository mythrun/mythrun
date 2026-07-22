import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { WikiEntity, WikiIntroduction, WikiViewModel, WorldWikiProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Text } from '../Text/Text.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Divider } from '../Divider/Divider.tsx'
import { SeamlessInput } from '../SeamlessInput/SeamlessInput.tsx'
import { RelatedFooter } from './RelatedFooter.tsx'
import { filterWikiModel } from './filter-model.ts'
import { resolveKindLabel } from './kind-label.ts'

// WikiHome (MYT-89 D4; intro-as-home myth-b9bap) — the wiki's landing. When
// the model carries an `introduction` it IS the world's front door, one
// scrolling field-guide surface: the world's name as the serif title moment,
// the grounding prose as real paragraphs, the dig-deeper references in the
// RelatedFooter idiom, then a quiet mono INDEX label introducing the search
// field and the browse-by-kind groups — a book's introduction followed by its
// index, so browse/search stay one scroll away with no mode switch. Without an
// introduction (a pre-migration world) it is the browse landing alone: the
// borderless search field pinned over the scrolling groups.
//
// Groups browse-by-kind (factions/locations/npcs/items; nested locations
// indent under their parent via nested <ul>s). Every entity row is a
// NAVIGATION affordance — it opens the entity's page. Flat 1-bit paper
// register: no boxes/cards/circles — quiet Divider hairlines separate
// sections; the graph-selected entity's row is marked with a quiet surface
// token-swap.
//
// THE GLOSSARY (MYT-102): the world's invented vocabulary closes the index —
// a <dl> of mono terms over serif definitions under the same quiet mono
// section label, searchable through the SAME query (term match, the parity of
// the entities' name match). A world without one gets no section at all (the
// graceful absence); the empty note shows only when NEITHER entities nor
// glossary rows survive the filter.
//
// SCROLL MEMORY (the shell's home side): whichever variant renders, the scroll
// container carries the shared `scrollRef` so the shell can read `scrollTop`
// at push-away time, and `scroll` re-seats the reader on mount (layout-effect,
// before paint) — a dig-deeper tap at the bottom of the intro returns to the
// references, not the title.
//
// The DS owns no copy: labels arrive resolved from the shell (required props, no
// in-component defaults). The world name, prose, and entity/reference names are
// DATA and render as-is. Raw <ul>/<li>/<button> carry the tree semantics +
// native keyboard activation.

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

// The mono small-caps section-label idiom (shared vocabulary with WikiPage's
// kind tag and RelatedFooter's section label) for the INDEX line.
const INDEX_LABEL_CLASS = 'font-ui text-[0.65rem] uppercase tracking-wide text-ink-tertiary'

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

interface HomeGroupsProps {
  model: WikiViewModel
  query: string
  selectedId: string | undefined
  onOpen: (entityId: string) => void
  groupLabels?: WorldWikiProps['groupLabels']
  emptyLabel: string
  glossaryLabel: string
}

/** The world glossary as a definition list: the mono term over the serif
 *  definition, one quiet row per entry (term-sorted by the view model). */
function GlossaryList({ glossary }: { glossary: WikiViewModel['glossary'] }): React.JSX.Element {
  return (
    <dl className="flex min-w-0 flex-col gap-[var(--space-3)] px-[var(--space-3)] pt-[var(--space-2)]">
      {glossary.map((entry, index) => (
        // Index keys are safe here (the list is static per render) and, unlike
        // term keys, two same-termed rows can't collide and drop one.
        <div key={index} className="min-w-0">
          <dt>
            <Text role="data">{entry.term}</Text>
          </dt>
          <dd>
            <Text role="prose-body" as="p">
              {entry.definition}
            </Text>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The browse-by-kind groups + the closing glossary, query-filtered — the
 *  shared index body of both home variants. */
function HomeGroups({
  model,
  query,
  selectedId,
  onOpen,
  groupLabels,
  emptyLabel,
  glossaryLabel,
}: HomeGroupsProps): React.JSX.Element {
  const filtered = filterWikiModel(model, query)
  if (filtered.groups.length === 0 && filtered.glossary.length === 0) {
    return (
      <Text role="prose-body" as="p">
        {emptyLabel}
      </Text>
    )
  }
  return (
    <>
      {filtered.groups.map((group, index) => (
        <section key={group.kind}>
          {index > 0 && <Divider tone="border" />}
          <Heading level={2} role="title">
            {resolveKindLabel(group.kind, groupLabels)}
          </Heading>
          <ul className="min-w-0">
            {group.entities.map((entity) => (
              <EntityNode key={entity.id} entity={entity} selectedId={selectedId} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
      {filtered.glossary.length > 0 && (
        <section className="flex min-w-0 flex-col gap-[var(--space-2)]">
          {filtered.groups.length > 0 && <Divider tone="border" />}
          <p className={cn(INDEX_LABEL_CLASS, 'px-[var(--space-3)]')}>{glossaryLabel}</p>
          <GlossaryList glossary={filtered.glossary} />
        </section>
      )}
    </>
  )
}

interface IntroductionArticleProps {
  introduction: WikiIntroduction
  onOpen: (entityId: string) => void
  referencesLabel: string
  groupLabels?: WorldWikiProps['groupLabels']
}

/** The introduction as a PAGE: the world-name title moment, the prose as
 *  paragraphs, the dig-deeper references (each annotated with its target's
 *  kind through the same `groupLabels` map every other kind surface speaks). */
function IntroductionArticle({
  introduction,
  onOpen,
  referencesLabel,
  groupLabels,
}: IntroductionArticleProps): React.JSX.Element {
  const references = introduction.references.map((ref) => ({
    entityId: ref.entityId,
    name: ref.name,
    label: resolveKindLabel(ref.kind, groupLabels),
  }))
  return (
    <article className="min-w-0 px-[var(--space-3)]">
      <header className="pb-[var(--space-4)] pt-[var(--space-2)]">
        <Heading level={2} role="display">
          {introduction.title}
        </Heading>
      </header>
      <div className="flex flex-col gap-[var(--space-3)]">
        {introduction.paragraphs.map((paragraph, index) => (
          // Index keys are safe here (the list is static per render) and, unlike
          // text keys, two byte-identical paragraphs can't collide and drop one.
          <Text key={index} role="prose-body" as="p">
            {paragraph}
          </Text>
        ))}
      </div>
      <RelatedFooter related={references} label={referencesLabel} onOpen={onOpen} />
    </article>
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
  referencesLabel: string
  indexLabel: string
  /** Section label over the world-glossary rows closing the index (MYT-102). */
  glossaryLabel: string
  /** The retained scroll offset (px) to seat the reader at on mount — the
   *  shell's home scroll memory. */
  scroll?: number
  /** The shell's handle on the scroll container (it reads `scrollTop` at
   *  push-away time). Standalone renders may omit it. */
  scrollRef?: RefObject<HTMLElement | null>
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
  referencesLabel,
  indexLabel,
  glossaryLabel,
  scroll = 0,
  scrollRef,
}: WikiHomeProps): React.JSX.Element {
  const fallbackRef = useRef<HTMLElement | null>(null)
  const containerRef = scrollRef ?? fallbackRef

  // Re-seat the reader before paint on mount — `scroll` only ever changes
  // across remounts (the shell captures it at push-away time), so this never
  // fights a live reader mid-scroll. A model refetch re-renders WITHOUT
  // remounting, leaving the DOM scroll position untouched.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (el !== null) el.scrollTop = scroll
  }, [scroll, containerRef])

  const introduction = model.introduction
  const groupsProps = { model, query, selectedId, onOpen, emptyLabel, glossaryLabel } as const
  const searchField = (
    <SeamlessInput label={searchLabel} value={query} onChange={onQuery} placeholder={searchPlaceholder} />
  )

  if (introduction === undefined) {
    // The pre-migration browse landing: the search field pinned over the
    // scrolling groups — the graceful absence, not a placeholder-of-shame.
    return (
      <div className="flex max-h-full min-h-0 min-w-0 flex-col gap-[var(--space-4)]">
        {searchField}
        <div
          ref={(el) => {
            containerRef.current = el
          }}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        >
          <HomeGroups {...groupsProps} {...(groupLabels !== undefined ? { groupLabels } : {})} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex max-h-full min-h-0 min-w-0 flex-col">
      <div
        ref={(el) => {
          containerRef.current = el
        }}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-[var(--space-4)]"
      >
        <IntroductionArticle
          introduction={introduction}
          onOpen={onOpen}
          referencesLabel={referencesLabel}
          {...(groupLabels !== undefined ? { groupLabels } : {})}
        />
        <section className="flex min-w-0 flex-col gap-[var(--space-2)] pt-[var(--space-4)]">
          <Divider tone="border" />
          <p className={cn(INDEX_LABEL_CLASS, 'px-[var(--space-3)]')}>{indexLabel}</p>
          {searchField}
          <HomeGroups {...groupsProps} {...(groupLabels !== undefined ? { groupLabels } : {})} />
        </section>
      </div>
    </div>
  )
}
