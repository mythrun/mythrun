import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { WikiEntity } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Text } from '../Text/Text.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { RelatedFooter } from './RelatedFooter.tsx'
import { WikiScrollFrame } from './WikiScrollFrame.tsx'

// WikiPage (MYT-89 D4; MYT-102 entity bodies) — one entity as a PLACE, a
// field-guide plate: the mono kind tag over the serif name, then the entity's
// prose KERNEL — its actual description of what it is — as serif paragraphs
// (split on newline runs, the introduction idiom), then the composed known-tier
// fact passages (topic over content, one fact per passage) below, or a calm
// empty note when the world recorded nothing at all, then the RELATED footer.
// A quiet mono back button sits PINNED above the scrolling <article> so a deep
// reader always has the way out in reach.
//
// SCROLL MEMORY (the D3 contract's consumer side): the <article> is THE scroll
// container. The shell reads its `scrollTop` into the navigation stack right
// before pushing away (via the shared `scrollRef`); this component re-seats
// the reader by writing `scroll` back into the container whenever the page in
// view changes — layout-effect, so the restore lands before paint. `scroll`
// changes only alongside a navigation (the stack batches the capture with the
// push), so the effect never fights a live reader mid-scroll.

const BACK_CLASS = cn(
  'flex items-baseline gap-[var(--space-2)] self-start',
  'bg-transparent rounded-none cursor-pointer select-none',
  'px-[var(--space-3)] py-[var(--space-2)]',
  'font-ui text-xs uppercase tracking-wide text-ink-secondary',
  'hover:text-ink hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

// The mono small-caps tag idiom (the wiki's shared label vocabulary) for the
// kind line.
const KIND_CLASS = 'font-ui text-[0.65rem] uppercase tracking-wide text-ink-tertiary'

export interface WikiPageProps {
  /** The entity this page shows. */
  entity: WikiEntity
  /** The kind tag over the name — COPY, resolved by the shell through the same
   *  `groupLabels` map the home's group headings use (`resolveKindLabel`), so
   *  both surfaces speak identical labels. Never the raw enum value. */
  kindLabel: string
  /** The retained scroll offset (px) to seat the reader at — `WikiLocation.scroll`. */
  scroll?: number
  /** The shell's handle on the scroll container (it reads `scrollTop` at
   *  push-away time). Standalone renders may omit it. */
  scrollRef?: RefObject<HTMLElement | null>
  /** Pop back to the previous page. */
  onBack: () => void
  /** Open a RELATED link's target page. */
  onOpenRelated: (entityId: string) => void
  /** i18n'd chrome copy, supplied by the consumer (the DS owns none). */
  backLabel: string
  relatedLabel: string
  emptyBodyLabel: string
}

export function WikiPage({
  entity,
  kindLabel,
  scroll = 0,
  scrollRef,
  onBack,
  onOpenRelated,
  backLabel,
  relatedLabel,
  emptyBodyLabel,
}: WikiPageProps): React.JSX.Element {
  const fallbackRef = useRef<HTMLElement | null>(null)
  const articleRef = scrollRef ?? fallbackRef
  const entityId = entity.id

  useLayoutEffect(() => {
    const el = articleRef.current
    if (el !== null) el.scrollTop = scroll
  }, [entityId, scroll, articleRef])

  // The kernel as paragraphs — split on newline runs, blanks dropped (the
  // introduction idiom; mechanical string work, ZFC-safe).
  const bodyParagraphs =
    entity.body === undefined
      ? []
      : entity.body
          .split(/\n+/)
          .map((p) => p.trim())
          .filter((p) => p !== '')

  return (
    <div className="flex max-h-full min-h-0 min-w-0 flex-col">
      <button type="button" onClick={onBack} className={BACK_CLASS}>
        <span aria-hidden="true">‹</span>
        {backLabel}
      </button>
      {/* Horizontal inset only — the frame's own one-line floor (ux-run3) owns
          the bottom padding. */}
      <WikiScrollFrame as="article" scrollRef={articleRef} contentClassName="px-[var(--space-3)]">
        <header className="flex flex-col gap-[var(--space-1)] pb-[var(--space-4)] pt-[var(--space-2)]">
          <p className={KIND_CLASS}>{kindLabel}</p>
          <Heading level={2} role="heading">
            {entity.name}
          </Heading>
        </header>
        {entity.hasBody ? (
          <div className="flex flex-col gap-[var(--space-4)]">
            {bodyParagraphs.length > 0 && (
              <div className="flex flex-col gap-[var(--space-3)]">
                {bodyParagraphs.map((paragraph, index) => (
                  // Index keys are safe here (the list is static per render)
                  // and, unlike text keys, two byte-identical paragraphs can't
                  // collide and drop one — the WikiHome introduction idiom.
                  <Text key={index} role="prose-body" as="p">
                    {paragraph}
                  </Text>
                ))}
              </div>
            )}
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
        ) : (
          <Text role="subtitle" as="p">
            {emptyBodyLabel}
          </Text>
        )}
        <RelatedFooter related={entity.related} label={relatedLabel} onOpen={onOpenRelated} />
      </WikiScrollFrame>
    </div>
  )
}
