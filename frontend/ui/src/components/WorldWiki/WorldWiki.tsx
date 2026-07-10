import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react'
import type { EntityKind } from '@mythrun/contract/rest'
import type { WikiEntity, WorldWikiProps } from '@mythrun/client-core/contract'
import { useWikiNavigation } from '@mythrun/client-core/worldgen'
import { WikiHome } from './WikiHome.tsx'
import { WikiPage } from './WikiPage.tsx'
import { resolveKindLabel } from './kind-label.ts'

// WorldWiki (MYT-89 Phase D, D4; intro-as-home myth-b9bap) — the browsable
// wiki as a real PLACE: a home landing (the world's INTRODUCTION when the
// model carries one, else search + browse-by-kind — WikiHome) opening onto
// per-entity pages (fact body + RELATED cross-links + back, WikiPage). This
// shell owns the D3 `useWikiNavigation` stack INTERNALLY, so its outer surface
// stays the same plain-data props the reveal already passes (model +
// selectedId/onSelect for the graph↔wiki bridge, query/onQuery for the
// search).
//
// SCROLL MEMORY: the shell holds the handle on the in-view surface's scroll
// container and captures its `scrollTop` right before every push — internal
// (home row, related hop) and external (a graph tap) alike — so the entry
// beneath retains where the reader was; `back()` restores it verbatim (the
// surface re-seats on location change). PAGE offsets live in the D3 stack
// (`setScroll`); the HOME offset lives in a local ref, because the stack
// deliberately retains no home scroll and home is now a READING surface (a
// dig-deeper tap at the bottom of the intro must return to the references,
// not the title). Back pops without capturing: the discarded entry's offset
// has nowhere to be restored to.
//
// THE BRIDGE: an EXTERNAL `selectedId` change pushes that entity's page (the
// hook's same-entity no-op dedups a re-tap); internal navigation reports the
// entity landed on through `onSelect`. Back/home report nothing — `onSelect`
// carries an id, and D5 wires the full bidirectional selection. A page whose
// entity left the model (a silent tail-stage refetch consolidated it away)
// falls back to rendering home — pure render fallback, no state surgery; the
// stack self-heals on the next navigation.

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
    backLabel = '[ph: back]',
    relatedLabel = '[ph: related]',
    emptyBodyLabel = '[ph: nothing recorded here yet]',
    referencesLabel = '[ph: dig deeper]',
    indexLabel = '[ph: index]',
    'data-testid': dataTestId,
  },
  ref,
) {
  const { current, push, back, setScroll } = useWikiNavigation()
  const scrollRef = useRef<HTMLElement | null>(null)
  // The HOME scroll offset — shell-owned (see the scroll-memory note above).
  const homeScroll = useRef(0)

  // id → entity + kind, nested children included — the page lookup. A nested
  // location shares its group's kind.
  const pages = useMemo(() => {
    const byId = new Map<string, { entity: WikiEntity; kind: EntityKind }>()
    const visit = (entity: WikiEntity, kind: EntityKind): void => {
      byId.set(entity.id, { entity, kind })
      for (const child of entity.children ?? []) visit(child, kind)
    }
    for (const group of model.groups) {
      for (const entity of group.entities) visit(entity, group.kind)
    }
    return byId
  }, [model])

  const page = current.type === 'entity' ? pages.get(current.entityId) : undefined

  // Whether HOME is the surface in view — including the defensive fallback
  // render (a page whose entity left the model). Mirrored into a ref so
  // `captureScroll` stays referentially stable (were it recreated per
  // navigation, the external-selection effect below would re-fire and re-push
  // a stale `selectedId`).
  const homeInView = page === undefined
  const homeInViewRef = useRef(homeInView)
  homeInViewRef.current = homeInView

  // Record the surface-in-view's scroll offset: a page's into its stack entry,
  // home's into the shell's own ref. A no-op when nothing is mounted.
  const captureScroll = useCallback(() => {
    const top = scrollRef.current?.scrollTop ?? 0
    if (homeInViewRef.current) homeScroll.current = top
    else setScroll(top)
  }, [setScroll])

  // Internal navigation: home rows + related hops land on an entity page and
  // report it outward so the graph highlight keeps step.
  const openEntity = useCallback(
    (entityId: string) => {
      captureScroll()
      push(entityId)
      onSelect(entityId)
    },
    [captureScroll, push, onSelect],
  )

  // External navigation (the graph tap): a `selectedId` CHANGE pushes that
  // page. No `onSelect` echo — the selection came from outside. The hook's
  // same-entity no-op dedups re-taps and the initial-mount push of a page
  // already in view.
  useEffect(() => {
    if (selectedId === undefined) return
    captureScroll()
    push(selectedId)
  }, [selectedId, captureScroll, push])

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className="flex max-h-full min-h-0 min-w-0 flex-col"
    >
      {current.type === 'entity' && page !== undefined ? (
        <WikiPage
          entity={page.entity}
          kindLabel={resolveKindLabel(page.kind, groupLabels)}
          scroll={current.scroll}
          scrollRef={scrollRef}
          onBack={back}
          onOpenRelated={openEntity}
          backLabel={backLabel}
          relatedLabel={relatedLabel}
          emptyBodyLabel={emptyBodyLabel}
        />
      ) : (
        <WikiHome
          model={model}
          selectedId={selectedId}
          onOpen={openEntity}
          query={query ?? ''}
          onQuery={onQuery}
          searchLabel={searchLabel}
          searchPlaceholder={searchPlaceholder}
          {...(groupLabels !== undefined ? { groupLabels } : {})}
          emptyLabel={emptyLabel}
          referencesLabel={referencesLabel}
          indexLabel={indexLabel}
          scroll={homeScroll.current}
          scrollRef={scrollRef}
        />
      )}
    </div>
  )
})
