import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { WikiEntity, WikiIntroduction, WikiViewModel, WorldWikiProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Text } from '../Text/Text.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Divider } from '../Divider/Divider.tsx'
import { WikiSearch } from './WikiSearch.tsx'
import { WikiViewSwitch, type WikiView } from './WikiViewSwitch.tsx'
import { WikiGlossary } from './WikiGlossary.tsx'
import { WikiScrollFrame } from './WikiScrollFrame.tsx'
import { RelatedFooter } from './RelatedFooter.tsx'
import { filterWikiModel } from './filter-model.ts'
import { resolveKindLabel } from './kind-label.ts'
import { smartQuotes } from './smart-quotes.ts'

// WikiHome (MYT-89 D4; intro-as-home myth-b9bap; MYT-100 tabbed IA) — the wiki's
// landing, restructured into two PEER VIEWS instead of one long scroll. When the
// world carries a glossary, a segmented WikiViewSwitch splits the panel into:
//   • INDEX — the world's front door (the introduction when present) followed by
//     the search field + browse-by-kind groups, and
//   • GLOSSARY — the invented vocabulary as a collapsible, scannable list.
// The switch sits PERSISTENT above the scroll region so it never scrolls away;
// the active view scrolls beneath it. A per-entity page is a DRILL-IN over
// whichever view (the shell swaps WikiHome for WikiPage and back) — not a third
// segment — so the switch's active view is owned by the SHELL and survives the
// round-trip.
//
// A world WITHOUT a glossary keeps the single-view landing (no switch): the
// introduction over its INDEX eyebrow + search + groups, or — a pre-migration
// world with neither intro nor glossary — the browse groups under the search
// alone. The graceful absence, not a placeholder.
//
// Groups browse-by-kind (factions/locations/npcs/items; nested locations indent
// under their parent via nested <ul>s). Every entity row is a NAVIGATION
// affordance — it opens the entity's page. Flat 1-bit paper register: no
// boxes/cards/circles — quiet Divider hairlines separate sections; the
// graph-selected entity's row is marked with a quiet surface token-swap.
//
// SCROLL MEMORY (the shell's home side): the scroll container carries the shared
// `scrollRef` so the shell can read `scrollTop` at push-away time, and `scroll`
// re-seats the reader on mount (layout-effect, before paint) — a dig-deeper tap
// at the bottom of the intro returns to the references, not the title.
//
// The DS owns no copy: labels arrive resolved from the shell (required props, no
// in-component defaults). The world name, prose, and entity/reference/glossary
// values are DATA and render as-is. Raw <ul>/<li>/<button> carry the tree
// semantics + native keyboard activation.

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

interface BrowseGroupsProps {
  model: WikiViewModel
  query: string
  selectedId: string | undefined
  onOpen: (entityId: string) => void
  groupLabels?: WorldWikiProps['groupLabels']
  emptyLabel: string
}

/** The browse-by-kind groups, query-filtered — the body of the index view. The
 *  glossary is NOT here anymore (it's its own view); the empty note shows when no
 *  entity survives the filter. */
function BrowseGroups({
  model,
  query,
  selectedId,
  onOpen,
  groupLabels,
  emptyLabel,
}: BrowseGroupsProps): React.JSX.Element {
  const filtered = filterWikiModel(model, query)
  if (filtered.groups.length === 0) {
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
    </>
  )
}

/** Cap on step-relevant rows per surface (glossary / entities) — the strip is a
 *  grounding hint, never a second index. */
const MAX_STEP_HITS = 3

interface StepContextSectionProps {
  model: WikiViewModel
  /** The active creation step's topic — the eyebrow AND the match needle. */
  stepContext: string
  onOpen: (entityId: string) => void
  groupLabels?: WorldWikiProps['groupLabels']
}

/** The step-relevant landing strip (ux-run2 myth-ehcf4) — what turns the panel
 *  from a static poster into a participant. The consumer passes the step's
 *  topic (or the selected card's name) as `stepContext`; it renders as the
 *  quiet eyebrow and runs through the SAME filter the search field uses
 *  (mechanical name/term match — no semantic mapping lives here). Matching
 *  glossary terms surface with their definitions OPEN — the world's voice,
 *  no tap required — and matching entities as openable rows. No hits →
 *  nothing renders and the home is exactly the step-less panel. */
function StepContextSection({
  model,
  stepContext,
  onOpen,
  groupLabels,
}: StepContextSectionProps): React.JSX.Element | null {
  const hits = filterWikiModel(model, stepContext)
  const glossary = hits.glossary.slice(0, MAX_STEP_HITS)
  const entities = hits.groups
    .flatMap((group) => group.entities.map((entity) => ({ entity, kind: group.kind })))
    .slice(0, MAX_STEP_HITS)
  if (glossary.length === 0 && entities.length === 0) return null
  return (
    <section className="flex min-w-0 flex-col gap-[var(--space-2)] pb-[var(--space-2)]">
      <p className={cn(INDEX_LABEL_CLASS, 'px-[var(--space-3)]')}>{stepContext}</p>
      {glossary.map((entry) => (
        <div key={entry.term} className="min-w-0 px-[var(--space-3)]">
          <p className="font-ui text-sm text-ink">{entry.term}</p>
          <Text role="prose-body" as="p">
            {smartQuotes(entry.definition)}
          </Text>
        </div>
      ))}
      {entities.length > 0 && (
        <ul className="min-w-0">
          {entities.map(({ entity, kind }) => (
            <li key={entity.id}>
              <button
                type="button"
                onClick={() => {
                  onOpen(entity.id)
                }}
                className={cn(ITEM_CLASS, 'justify-between gap-[var(--space-3)]')}
              >
                <Text role="prose-body" truncate>
                  {entity.name}
                </Text>
                <span className={INDEX_LABEL_CLASS}>{resolveKindLabel(kind, groupLabels)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Divider tone="border" />
    </section>
  )
}

interface IntroductionArticleProps {
  introduction: WikiIntroduction
  onOpen: (entityId: string) => void
  referencesLabel: string
  groupLabels?: WorldWikiProps['groupLabels']
}

/** The introduction as a PAGE: the grounding prose as paragraphs, then the
 *  dig-deeper references (each annotated with its target's kind through the
 *  same `groupLabels` map every other kind surface speaks). The world-name
 *  TITLE is not here anymore — it lives in the persistent panel header above
 *  the view switch (ux-run2 myth-o9iuh), so it never repeats. */
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
    <article className="min-w-0 px-[var(--space-3)] pt-[var(--space-2)]">
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

interface IndexViewProps {
  model: WikiViewModel
  selectedId: string | undefined
  onOpen: (entityId: string) => void
  query: string
  onQuery: (query: string) => void
  searchLabel: string
  searchPlaceholder: string
  groupLabels?: WorldWikiProps['groupLabels']
  emptyLabel: string
  referencesLabel: string
  indexLabel: string
  /** Whether the persistent switch already names this view — when it does, the
   *  in-body INDEX eyebrow is redundant and suppressed. */
  hasSwitch: boolean
  /** The active creation step's topic (ux-run2 myth-ehcf4) — surfaces the
   *  step-relevant strip at the top of the view. Absent/empty → no strip. */
  stepContext?: string
}

/** The INDEX view: the step-relevant strip (when a `stepContext` is set and the
 *  reader isn't mid-search), then the world's introduction (its front door,
 *  when present) over the search field + browse-by-kind groups. The INDEX
 *  eyebrow separates the intro from the browse section only when the switch
 *  isn't there to name the view. */
function IndexView({
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
  hasSwitch,
  stepContext,
}: IndexViewProps): React.JSX.Element {
  const introduction = model.introduction
  // The step strip stands down while the reader is actively searching — the
  // query owns the surface (its hits already ARE the relevant content).
  const stepTopic = stepContext?.trim() ?? ''
  const step =
    stepTopic !== '' && query.trim() === '' ? (
      <StepContextSection
        model={model}
        stepContext={stepTopic}
        onOpen={onOpen}
        {...(groupLabels !== undefined ? { groupLabels } : {})}
      />
    ) : null
  const browse = (
    <>
      <WikiSearch label={searchLabel} value={query} onChange={onQuery} placeholder={searchPlaceholder} />
      <BrowseGroups
        model={model}
        query={query}
        selectedId={selectedId}
        onOpen={onOpen}
        emptyLabel={emptyLabel}
        {...(groupLabels !== undefined ? { groupLabels } : {})}
      />
    </>
  )

  if (introduction === undefined) {
    // No front door (a pre-migration world, or a snapshot without one): the
    // search over the browse groups alone.
    return (
      <div className="flex min-w-0 flex-col gap-[var(--space-2)]">
        {step}
        {browse}
      </div>
    )
  }

  return (
    <>
      {step}
      <IntroductionArticle
        introduction={introduction}
        onOpen={onOpen}
        referencesLabel={referencesLabel}
        {...(groupLabels !== undefined ? { groupLabels } : {})}
      />
      <section className="flex min-w-0 flex-col gap-[var(--space-2)] pt-[var(--space-4)]">
        <Divider tone="border" />
        {/* The switch, when present, is the view's name — the eyebrow would double it. */}
        {!hasSwitch && <p className={cn(INDEX_LABEL_CLASS, 'px-[var(--space-3)]')}>{indexLabel}</p>}
        {browse}
      </section>
    </>
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
  /** The active view (Index / Glossary), owned by the shell so a drill-in returns
   *  to the view it came from. Ignored (Index) when the world has no glossary. */
  view: WikiView
  onViewChange: (view: WikiView) => void
  /** i18n'd chrome copy, resolved by the shell (the DS owns none). */
  searchLabel: string
  searchPlaceholder: string
  groupLabels?: WorldWikiProps['groupLabels']
  emptyLabel: string
  referencesLabel: string
  indexLabel: string
  /** Segment label for the glossary view + eyebrow (MYT-102). */
  glossaryLabel: string
  /** The active creation step's topic (ux-run2 myth-ehcf4) — a short display
   *  string that is ALSO the match needle for the step-relevant strip. */
  stepContext?: string
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
  view,
  onViewChange,
  searchLabel,
  searchPlaceholder,
  groupLabels,
  emptyLabel,
  referencesLabel,
  indexLabel,
  glossaryLabel,
  stepContext,
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

  const hasGlossary = model.glossary.length > 0
  // A glossary-less world has only the index; force it even if the shell's view
  // state says glossary (the switch that would set it isn't rendered).
  const activeView: WikiView = hasGlossary ? view : 'index'

  return (
    <div className="flex max-h-full min-h-0 min-w-0 flex-col">
      {/* The world's NAME as the panel's persistent identity (ux-run2 myth-o9iuh):
          ABOVE the Index/Glossary strip — the tabs switch the reading matter, not
          the world — and one full role step below `display`, so it anchors the
          panel without out-shouting the page's own task heading (the char-fork /
          builder "two competing H1s" critique). Data, not chrome: the name comes
          off the model; a world without an introduction has no title to show. */}
      {model.introduction !== undefined && (
        <header className="px-[var(--space-3)] pb-[var(--space-2)]">
          <Heading level={2} role="heading">
            {model.introduction.title}
          </Heading>
        </header>
      )}
      {hasGlossary && (
        <div className="px-[var(--space-3)] pb-[var(--space-3)]">
          <WikiViewSwitch value={activeView} onChange={onViewChange} indexLabel={indexLabel} glossaryLabel={glossaryLabel} />
        </div>
      )}
      <WikiScrollFrame scrollRef={containerRef} contentClassName="pb-[var(--space-4)]">
        {activeView === 'glossary' ? (
          <WikiGlossary glossary={model.glossary} />
        ) : (
          <IndexView
            model={model}
            selectedId={selectedId}
            onOpen={onOpen}
            query={query}
            onQuery={onQuery}
            searchLabel={searchLabel}
            searchPlaceholder={searchPlaceholder}
            emptyLabel={emptyLabel}
            referencesLabel={referencesLabel}
            indexLabel={indexLabel}
            hasSwitch={hasGlossary}
            {...(stepContext !== undefined ? { stepContext } : {})}
            {...(groupLabels !== undefined ? { groupLabels } : {})}
          />
        )}
      </WikiScrollFrame>
    </div>
  )
}
