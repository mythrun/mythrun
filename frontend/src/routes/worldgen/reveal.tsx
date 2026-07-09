import { useEffect, useRef, useState } from 'react'
import {
  Stack,
  Grid,
  Heading,
  Text,
  Button,
  Drawer,
  FullBleedStage,
  VisuallyHidden,
  WorldGenGraph,
  WorldWiki,
  useViewportNarrow,
} from '@mythrun/ui'
import {
  completedTailStageCount,
  getWorldSnapshot,
  useApiContext,
  type ApiContext,
  type WorldGenSnapshot,
  type WorldGenStream,
} from '@mythrun/client-core'
import { MIN_EXPECTED_ENTITIES, toWikiViewModel, type WikiViewModel } from '@mythrun/client-core/worldgen'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useNavigate } from 'react-router-dom'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'

// The WORLD REVEAL (MYT-89 Phase D, D5 layout + reveal timing) — where the
// `/campaigns/:id` route lands the moment the CONNECTIONS ARE WOVEN
// (entity_relationships completes), not when the whole pipeline finishes.
//
// TWO LAYOUT REGIMES, one structural flip (`useViewportNarrow` — the DS's one
// narrow regime, the same boolean FullBleedStage flips on internally):
//   • DESKTOP: a true 50/50 — `Grid columns={2}` lays the interactive graph
//     (C4) beside the browsable wiki (D4), both stretching to fill (the old
//     `auto-fill` template kept empty trailing tracks on wide viewports).
//   • MOBILE (< 640px): the graph OWNS THE GLASS — the same `FullBleedStage`
//     mechanism as the generating act (`inset={6}` cancels the AppFrame's
//     content padding; the stage fills the viewport below the header), with a
//     visually-hidden H1 keeping the document outline. The wiki lives in the
//     D1 edge-handle Drawer: summoned/dismissed from the handle pinned at the
//     right edge, ALSO opened by a node tap. The Drawer's children stay
//     MOUNTED across close→open, so the reader's page + scroll survive; the
//     title/explore-prompt ride the sheet's own header, and Continue sits at
//     the top of the sheet body.
//
// SILENT UPDATES (MYT-89 reveal timing): while the player explores, the
// pipeline's tail stages (entity_consolidation → embed_world) keep running
// behind this screen. Each tail completion bumps the `stages`-derived refetch
// token and the wiki QUIETLY refetches its snapshot — consolidated ghosts and
// coherence-pass reconciliations just appear in the data; no spinner takeover,
// no layout jolt (the old model stays rendered until the fresh one resolves).
// The graph absorbs the same patches through the stream's nodes/edges props.
// The Continue affordance is gated (`continueReady`) until the pipeline
// finishes — the starting-situation POST requires a complete world — and
// appears quietly when it does.
//
// SHARED SELECTION is single-id-space (BUG 2.1): the graph selects by
// `displayId` and, post-gen, every node is finalized so its `displayId` IS its
// real entity id — the same id the wiki keys on. Two pieces of state carry it:
// `selection` (persistent — the graph highlight) and `wikiPush` (a ONE-SHOT
// push signal — see the effect below). Flat 1-bit paper register; all UI
// composes @mythrun/ui.

/** Fetches the FULL known-tier snapshot. Typed as the RELATIONSHIP-BEARING
 *  `WorldGenSnapshot` (`getWorldSnapshot`'s actual response — assignable to the
 *  view model's `WikiSnapshot`): a relationship-less source is a COMPILE error,
 *  so the wiki's RELATED cross-links can never silently come up empty (the
 *  D2-review re-type). Injected so tests substitute a resolved fixture. The
 *  route mounts this screen only after the boundary stage
 *  (entity_relationships) has committed — the same stage the endpoint's 409
 *  gate checks — so the fetch never 409s. The known-tier filter is SERVER-side
 *  (worldSnapshotView, enforced ignorance): fetching mid-tail serves the same
 *  known-only projection as post-completion. */
type FetchSnapshot = (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>

interface WikiModelState {
  readonly model: WikiViewModel | null
  readonly loading: boolean
  /** The last (re)fetch REJECTED. Only rendered when no model has ever
   *  resolved: the panel shows the honest UNAVAILABLE line (a member hitting
   *  the owner-only snapshot endpoint 403s — myth-0xwos — and transient
   *  failures look the same from here), never an error flash. */
  readonly failed: boolean
}

/** Fetch the world snapshot and normalize it to the wiki view model; REFETCH
 *  quietly whenever `refreshToken` bumps (a silent tail stage completed — the
 *  reconciled world). Quiet by construction: `loading` is only ever true before
 *  the FIRST settle, and the current model stays rendered until a fresh one
 *  resolves (a refetch failure keeps the old model — the next tail completion
 *  retries). A failed first fetch settles to the calm unavailable line (never
 *  throws into the route). The `active` flag drops a late resolve after
 *  unmount / a superseded refetch. */
function useWikiModel(
  campaignId: string,
  fetchSnapshot: FetchSnapshot,
  refreshToken: number,
): WikiModelState {
  const ctx = useApiContext()
  const [state, setState] = useState<WikiModelState>({ model: null, loading: true, failed: false })
  useEffect(() => {
    let active = true
    void fetchSnapshot(ctx, campaignId)
      .then((snapshot) => {
        if (!active) return
        setState({ model: toWikiViewModel(snapshot), loading: false, failed: false })
      })
      .catch(() => {
        if (active) setState((s) => ({ ...s, loading: false, failed: true }))
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, fetchSnapshot, refreshToken])
  return state
}

/** The calm single-line states of the wiki panel before a model exists:
 *  loading → the settling line; a failed fetch → the honest unavailable line;
 *  the (defensive) remainder → the empty line. */
function panelLine(state: WikiModelState, t: TFunction): string {
  if (state.loading) return t('worldReveal.loading')
  return state.failed ? t('worldReveal.unavailable') : t('worldReveal.empty')
}

interface WikiPanelProps {
  state: WikiModelState
  /** The one-shot external push signal (a graph tap) — NOT the persistent
   *  selection; see the one-shot effect in `WorldReveal`. */
  externalSelection: string | undefined
  onSelect: (entityId: string) => void
  query: string
  onQuery: (query: string) => void
}

/** The wiki side of the reveal: a calm `[ph: …]` line while the snapshot loads
 *  (or failed to), else the browsable `WorldWiki` with every chrome label
 *  resolved from the app catalog (the DS owns no copy). */
function WikiPanel({ state, externalSelection, onSelect, query, onQuery }: WikiPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  if (state.model === null) {
    return (
      <Text role="ui-caption" as="p">
        {panelLine(state, t)}
      </Text>
    )
  }
  return (
    <WorldWiki
      data-testid="reveal-wiki"
      model={state.model}
      onSelect={onSelect}
      query={query}
      onQuery={onQuery}
      searchLabel={t('worldReveal.wikiSearchLabel')}
      searchPlaceholder={t('worldReveal.wikiSearchPlaceholder')}
      emptyLabel={t('worldReveal.wikiEmpty')}
      backLabel={t('worldReveal.wikiBack')}
      relatedLabel={t('worldReveal.wikiRelated')}
      emptyBodyLabel={t('worldReveal.wikiEmptyBody')}
      groupLabels={{
        faction: t('worldReveal.group.faction'),
        location: t('worldReveal.group.location'),
        npc: t('worldReveal.group.npc'),
        item: t('worldReveal.group.item'),
      }}
      {...(externalSelection !== undefined ? { selectedId: externalSelection } : {})}
    />
  )
}

/** The pieces both layout regimes compose: the interactive graph, the wiki
 *  surface (a pane on desktop; the drawer's child on mobile), and the gated
 *  Continue affordance (`null` while the tail still runs). */
interface RevealChromeProps {
  graph: React.JSX.Element
  wikiPanel: React.JSX.Element
  continueAction: React.JSX.Element | null
}

/** Desktop: the true 50/50 — `Grid columns={2}` builds `repeat(2, minmax(0,
 *  1fr))`, so the two panes stretch to fill the full width (the old
 *  `auto-fill` template kept empty trailing tracks). */
function DesktopReveal({ graph, wikiPanel, continueAction }: RevealChromeProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="worldgen-reveal">
      <Heading level={1} role="title">
        {t('worldReveal.title')}
      </Heading>
      <Grid columns={2} gap={4} data-testid="reveal-panes">
        {graph}
        {wikiPanel}
      </Grid>
      <Text role="prose-body" as="p">
        {t('worldReveal.explorePrompt')}
      </Text>
      {/* The Continue appears QUIETLY once the pipeline finishes (the pick's POST
          requires a complete world). While the tail runs, the explore prompt is the
          whole call to action — exploring IS the intent of this screen. */}
      {continueAction}
    </Stack>
  )
}

interface MobileRevealProps extends RevealChromeProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Mobile: the graph owns the glass. The stage is the generating act's
 *  full-bleed mechanism (`inset={6}` MUST match the AppFrame content Box's
 *  `padding={6}`), placed directly under the (visually hidden) H1 so its top
 *  edge lands at the header's bottom — the same geometry the generation view
 *  holds, so the gen→reveal flip doesn't jolt the pane. The wiki rides the
 *  edge-handle Drawer: mount-persistent children (the reader's page + scroll
 *  survive close→open), the reveal title/prompt as the sheet's own header, and
 *  Continue at the top of the sheet body — every reveal affordance lives in
 *  the summonable sheet, keeping the base screen pure world. */
function MobileReveal({ graph, wikiPanel, continueAction, open, onOpenChange }: MobileRevealProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack data-testid="worldgen-reveal">
      <VisuallyHidden>
        <Heading level={1} role="title">
          {t('worldReveal.title')}
        </Heading>
      </VisuallyHidden>
      <FullBleedStage inset={6} data-testid="reveal-stage">
        {graph}
      </FullBleedStage>
      <Drawer
        data-testid="reveal-drawer"
        title={t('worldReveal.title')}
        description={t('worldReveal.explorePrompt')}
        openLabel={t('worldReveal.wikiOpen')}
        closeLabel={t('worldReveal.wikiClose')}
        open={open}
        onOpenChange={onOpenChange}
      >
        <Stack gap={4}>
          {continueAction}
          {wikiPanel}
        </Stack>
      </Drawer>
    </Stack>
  )
}

export interface WorldRevealProps extends Pick<WorldGenStream, 'nodes' | 'edges'> {
  /** The campaign whose world is being revealed. */
  campaignId: string
  /** The stream's folded per-stage progress — the silent-update driver: each
   *  completed TAIL stage bumps the wiki's quiet refetch token. Omit (or pass a
   *  static array) for a settled world — the wiki then fetches once. */
  stages?: WorldGenStream['stages']
  /** Whether the Continue affordance is offered. The route passes false while
   *  the tail is still running (the starting-situation POST requires a complete
   *  world); the button appears quietly on completion. Default true (a settled
   *  world). */
  continueReady?: boolean
  /** Continue intent — leads to the starting-situation pick (D4). Defaults to
   *  navigating to the situation route; injectable so callers/tests override. */
  onContinue?: () => void
  /** The snapshot source — defaults to the real endpoint; tests substitute it. */
  fetchSnapshot?: FetchSnapshot
}

const NO_STAGES: WorldGenStream['stages'] = []

export function WorldReveal({
  campaignId,
  nodes,
  edges,
  stages = NO_STAGES,
  continueReady = true,
  onContinue,
  fetchSnapshot = getWorldSnapshot,
}: WorldRevealProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The world is done, but WorldGenGraph still paints a rAF Canvas loop unless it
  // is told to settle static — honour the OS/browser preference (web layer).
  const prefersReducedMotion = usePrefersReducedMotion()
  const narrow = useViewportNarrow()

  // The PERSISTENT selection (the graph highlight) vs the ONE-SHOT push signal
  // (what the wiki's external-selection effect consumes). Split because the
  // wiki's `back()` reports nothing outward: were the push signal persistent,
  // re-tapping the SAME node after backing out would read as "no change" and
  // the page would never re-open (the D4-review re-tap bug).
  const [selection, setSelection] = useState<string | undefined>(undefined)
  const [wikiPush, setWikiPush] = useState<string | undefined>(undefined)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [query, setQuery] = useState('')
  // The quiet refetch token: how many silent tail stages have completed. Each
  // bump refetches the snapshot so the reconciled world surfaces while the
  // player reads. Monotonic within a mount (stages only advance).
  const wikiRefreshToken = completedTailStageCount(stages)
  const wiki = useWikiModel(campaignId, fetchSnapshot, wikiRefreshToken)

  // Clear the push signal once the mounted wiki has consumed it (child effects
  // run before this parent effect, and the wiki's same-entity push is a no-op,
  // so re-delivering is always safe). Deferred while the panel is still the
  // loading line: the signal must survive until the wiki mounts and can
  // consume it on its first effect pass.
  // COUPLING: this one-shot pattern relies on WorldWiki treating
  // externalSelection as a jump signal — clearing it to undefined must NOT
  // navigate home (WorldWiki's external-selection effect keys on the value
  // changing to a defined id). A D4-side semantics change breaks re-tap here.
  useEffect(() => {
    if (wiki.model !== null && wikiPush !== undefined) setWikiPush(undefined)
  }, [wiki.model, wikiPush])

  // A graph tap: highlight, push the wiki page and — on mobile, where the wiki
  // sleeps in the drawer — summon the sheet so the page is actually seen.
  //
  // The summon is DEFERRED past the tapping gesture. The graph selects on
  // POINTERUP, but Radix (Dialog ≥1.1.17, `deferPointerDownOutside`) arms the
  // sheet's outside-dismiss at the gesture's POINTERDOWN — which landed on the
  // canvas, outside the sheet — and delivers it at the gesture's trailing
  // CLICK. Opening synchronously puts the sheet in its OPEN state by click
  // time, so its own armed dismissal immediately closes it (a one-gesture
  // open→shut flash; caught live). Deferring one macrotask lets that click
  // land on a still-closed sheet — whose closed-state dismiss suppression
  // swallows it — and then opens. A gesture with no trailing click (a drag)
  // never selects, so the timer only ever runs for real taps.
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (openTimerRef.current !== null) clearTimeout(openTimerRef.current)
    },
    [],
  )
  const handleGraphSelect = (displayId: string): void => {
    setSelection(displayId)
    setWikiPush(displayId)
    if (narrow) {
      if (openTimerRef.current !== null) clearTimeout(openTimerRef.current)
      openTimerRef.current = setTimeout(() => {
        openTimerRef.current = null
        setDrawerOpen(true)
      }, 0)
    }
  }

  const handleContinue = (): void => {
    if (onContinue) onContinue()
    else void navigate(`/campaigns/${campaignId}/situation`)
  }

  const graph = (
    <WorldGenGraph
      data-testid="reveal-graph"
      interactive
      nodes={nodes}
      edges={edges}
      onSelect={handleGraphSelect}
      reducedMotion={prefersReducedMotion}
      // The world is BORN — the fog is gone and stays gone (MYT-89 spawn-drain:
      // a complete world's node count is past the entity floor, so the fog
      // mounts already drained). Omitting these held base-density fog over the
      // reveal (the 0-denominator "no drain" fallback) — a leftover from the
      // pre-drain fade wiring, at odds with the reveal's fog-gone arc.
      shownEntities={nodes.length}
      totalEntities={MIN_EXPECTED_ENTITIES}
      listLabel={t('worldReveal.graphLabel')}
      emptyLabel={t('worldReveal.graphEmpty')}
      {...(selection !== undefined ? { selectedKey: selection } : {})}
    />
  )
  const wikiPanel = (
    <WikiPanel
      state={wiki}
      externalSelection={wikiPush}
      onSelect={setSelection}
      query={query}
      onQuery={setQuery}
    />
  )
  const continueAction = continueReady ? (
    <Stack direction="row">
      <Button onPress={handleContinue} data-testid="reveal-continue">
        {t('worldReveal.continue')}
      </Button>
    </Stack>
  ) : null

  if (narrow) {
    return (
      <MobileReveal
        graph={graph}
        wikiPanel={wikiPanel}
        continueAction={continueAction}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    )
  }
  return <DesktopReveal graph={graph} wikiPanel={wikiPanel} continueAction={continueAction} />
}
