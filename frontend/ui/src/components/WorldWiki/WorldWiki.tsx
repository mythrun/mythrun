import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react'
import type { EntityKind } from '@mythrun/contract/rest'
import type { WikiEntity, WorldWikiProps } from '@mythrun/client-core/contract'
import { useWikiNavigation } from '@mythrun/client-core/worldgen'
import { WikiHome } from './WikiHome.tsx'
import { WikiPage } from './WikiPage.tsx'
import { resolveKindLabel } from './kind-label.ts'

// WorldWiki (MYT-89 Phase D, D4) — the browsable wiki as a real PLACE: a home
// landing (search + browse-by-kind, WikiHome) opening onto per-entity pages
// (fact body + RELATED cross-links + back, WikiPage). This shell owns the D3
// `useWikiNavigation` stack INTERNALLY, so its outer surface stays the same
// plain-data props the reveal already passes (model + selectedId/onSelect for
// the graph↔wiki bridge, query/onQuery for the search).
//
// SCROLL MEMORY: the shell holds the handle on WikiPage's scroll container and
// reads its `scrollTop` into the stack (`setScroll`) right before every push —
// internal (home row, related hop) and external (a graph tap) alike — so the
// entry beneath retains where the reader was; `back()` restores it verbatim
// (WikiPage re-seats on location change). Back pops without capturing: the
// discarded entry's offset has nowhere to be restored to.
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
    'data-testid': dataTestId,
  },
  ref,
) {
  const { current, push, back, setScroll } = useWikiNavigation()
  const scrollRef = useRef<HTMLElement | null>(null)

  // Record the page-in-view's scroll offset into its stack entry. A no-op on
  // home (the stack retains no home scroll) and when no page is mounted.
  const captureScroll = useCallback(() => {
    setScroll(scrollRef.current?.scrollTop ?? 0)
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
        />
      )}
    </div>
  )
})
