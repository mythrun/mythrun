import { useEffect, useRef, useState } from 'react'
import {
  Stack,
  Heading,
  Text,
  Button,
  Spinner,
  Drawer,
  FullBleedStage,
  VisuallyHidden,
  WorldGenGraph,
  RevealPanes,
  RevealFade,
  revealPhaseAtLeast,
  useViewportNarrow,
} from '@mythrun/ui'
import { completedTailStageCount, getWorldSnapshot, type WorldGenStream } from '@mythrun/client-core'
import type { RevealMoment } from '@mythrun/client-core/contract'
import { MIN_EXPECTED_ENTITIES } from '@mythrun/client-core/worldgen'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'
import { WikiPanel, useWikiModel, type FetchSnapshot } from './reveal-wiki-panel.tsx'
import { DrawerBackClose } from './drawer-back-close.tsx'

// The WORLD REVEAL (MYT-89 Phase D, D5 layout + reveal timing) — where the
// `/campaigns/:id` route lands the moment the CONNECTIONS ARE WOVEN
// (entity_relationships completes), not when the whole pipeline finishes.
//
// TWO LAYOUT REGIMES, one structural flip (`useViewportNarrow` — the DS's one
// narrow regime, the same boolean FullBleedStage flips on internally):
//   • DESKTOP: a true 50/50 — `RevealPanes` (D6) lays the interactive graph
//     (C4) beside the browsable wiki (D4) as two equal min-width-0 halves (the
//     `Grid columns={2}` track behavior), and is HOW the moment's layout
//     arrives: full-width graph easing to the left half while the wiki slides
//     in from the right at `resolve`. The row owns the VERTICAL space (audit
//     v3): the graph fills its half in both dimensions (`fillHost`), never
//     pans (`pannable={false}`), and the wiki caps to the row and scrolls
//     internally. No entity list — the wiki IS the browse surface.
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
// THE REVEAL MOMENT (D6, §3.8): the route wraps this screen in a
// <RevealTransition> and hands the `moment` down; the layout stages itself
// against its phase — the title fade at `settle`, the pane arrival / drawer
// mount at `resolve`. The fog is born drained in every phase (`revealFogShown`
// — the §3.8 fog-gone invariant, enforced from the swap). A mount without a
// moment renders the settled end state instantly (the late arriver).
//
// SILENT UPDATES (MYT-89 reveal timing): while the player explores, the
// pipeline's tail stages (entity_consolidation → embed_world) keep running
// behind this screen. Each tail completion bumps the `stages`-derived refetch
// token and the wiki QUIETLY refetches its snapshot — consolidated ghosts and
// coherence-pass reconciliations just appear in the data; no spinner takeover,
// no layout jolt (the old model stays rendered until the fresh one resolves).
// The graph absorbs the same patches through the stream's nodes/edges props.
// The Continue affordance is PRESENT from first paint but gated (`continueReady`)
// until the pipeline finishes — the starting-situation POST requires a complete
// world — rendering DISABLED with a quiet settling indicator while the tail runs
// and enabling in place when it does.
//
// SHARED SELECTION is single-id-space (BUG 2.1): the graph selects by
// `displayId` and, post-gen, every node is finalized so its `displayId` IS its
// real entity id — the same id the wiki keys on. Two pieces of state carry it:
// `selection` (persistent — the graph highlight) and `wikiPush` (a ONE-SHOT
// push signal — see the effect below). Flat 1-bit paper register; all UI
// composes @mythrun/ui.

// The snapshot fetch/refetch model + the wiki panel live in reveal-wiki-panel.tsx
// (extracted at the D6 module-size ceiling; composed here exactly as before).

/** The reveal moment a NON-PLAYED mount renders (the late arriver, a settled
 *  world, every pre-D6 test): the end state, hard — no transitions. */
const SETTLED_MOMENT: RevealMoment = { phase: 'done', instant: true }

/** The fog-drain NUMERATOR on the reveal — always "fully arrived", so the fog
 *  is BORN DRAINED (`settlePopulation`'s mount path) whatever the world size:
 *  the §3.8 hard invariant (fog totally gone), enforced from the swap. A
 *  sub-floor world (< MIN_EXPECTED_ENTITIES) is the case this floors: keeping
 *  its residual haze for a live gust was tried and cut on the D6 sequence
 *  capture — the remounted sim's cold low-pass FADES THE HAZE BACK IN over the
 *  moment's first seconds, and the wind then needs ~20s to carry it off, an
 *  inverted arc. Born-drained also retires the permanent-residual-haze
 *  artifact sub-floor worlds had on the settled reveal (D5's mobile shot).
 *  Pure — exported for unit test. */
export function revealFogShown(nodeCount: number): number {
  return Math.max(nodeCount, MIN_EXPECTED_ENTITIES)
}

/** The pieces both layout regimes compose: the interactive graph, the wiki
 *  surface (a pane on desktop; the drawer's child on mobile), the Continue
 *  affordance (always present — DISABLED with a settling indicator while the
 *  tail runs, enabled when ready), and the reveal MOMENT the layout stages
 *  itself against (D6). */
interface RevealChromeProps {
  /** `null` until the first fold delivers nodes — see the graph const. */
  graph: React.JSX.Element | null
  wikiPanel: React.JSX.Element
  continueAction: React.JSX.Element
  moment: RevealMoment
}

/** Desktop: the true 50/50, ARRIVING IN MOTION (D6). RevealPanes holds the
 *  graph at full width through the moment and eases it to the left half while
 *  the wiki slides in from the right at `resolve`, landing on the same
 *  equal-halves track the old `Grid columns={2}` built. The title fades in at
 *  `settle`, the explore prompt (and Continue) at `resolve` — whole-block
 *  opacity fades with their space reserved from the first frame, so nothing
 *  shifts mid-moment. A settled mount renders all of it visible, instantly. */
function DesktopReveal({ graph, wikiPanel, continueAction, moment }: RevealChromeProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="worldgen-reveal">
      <RevealFade moment={moment} visibleFrom="settle">
        <Heading level={1} role="title">
          {t('worldReveal.title')}
        </Heading>
      </RevealFade>
      <RevealPanes data-testid="reveal-panes" moment={moment} stage={graph} panel={wikiPanel} />
      <RevealFade moment={moment} visibleFrom="resolve">
        <Text role="prose-body" as="p">
          {t('worldReveal.explorePrompt')}
        </Text>
        {/* Continue is present from first paint — disabled with a quiet settling
            indicator while the tail runs (the pick's POST requires a complete
            world), enabling in place when it finishes. Exploring is the intent
            meanwhile; the prompt above stays truthful because the control exists. */}
        {continueAction}
      </RevealFade>
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
 *  holds, so the gen→reveal flip doesn't jolt the pane (and the reveal moment
 *  can rely on that continuity: the stage renders identically in EVERY phase).
 *  The wiki rides the edge-handle Drawer: mount-persistent children (the
 *  reader's page + scroll survive close→open), the reveal title/prompt as the
 *  sheet's own header, and Continue at the top of the sheet body — every
 *  reveal affordance lives in the summonable sheet, keeping the base screen
 *  pure world. THE MOMENT (D6): the drawer mounts at `resolve` — §3.8's
 *  "handle arrives at the right edge"; before that nothing occludes the
 *  just-revealed world. Mount is monotonic (phases only advance), so the
 *  mount-persistence contract is untouched once it exists. */
function MobileReveal({ graph, wikiPanel, continueAction, moment, open, onOpenChange }: MobileRevealProps): React.JSX.Element {
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
      {revealPhaseAtLeast(moment.phase, 'resolve') && (
        <>
          {/* E2 (Phase E): mobile Back precedence — while the drawer is open, a
              browser/hardware Back closes it before leaving the route (the
              close-drawer → leave-route layer, via the router's history
              integration). Mounted with the drawer; inert while closed. */}
          <DrawerBackClose
            open={open}
            onClose={() => {
              onOpenChange(false)
            }}
          />
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
        </>
      )}
    </Stack>
  )
}

/** The Continue affordance — PRESENT FROM FIRST PAINT and honest about its state
 *  (the reveal-gate audit): the button always renders — DISABLED, with a quiet
 *  settling indicator to its right, while the silent tail (entity_consolidation →
 *  embed_world) is still finishing (the starting-situation POST it leads to
 *  requires a complete world) — and ENABLES in place when `ready` flips true (the
 *  pipeline reaches world_ready, driven by the live SSE phase). The pending
 *  cluster rides the SAME fixed-height row to the button's right, so the flip
 *  removes it WITHOUT moving the button or anything laid out below it (no jump).
 *  This makes the explore prompt above ("wander your world, continue when you're
 *  ready") truthful — the affordance exists, it just isn't ready yet — instead of
 *  promising a control the old `null` gate hid entirely. */
function ContinueAffordance({ ready, onPress }: { ready: boolean; onPress: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack direction="row" align="center" gap={3}>
      <Button onPress={onPress} disabled={!ready} data-testid="reveal-continue">
        {t('worldReveal.continue')}
      </Button>
      {!ready && (
        <Stack direction="row" align="center" gap={2} data-testid="reveal-continue-pending">
          {/* The Spinner is its own role="status" live region with its own name;
              the aria-hidden wrapper strips that whole subtree from the a11y tree
              so it reads as a purely DECORATIVE activity mark and the meta line is
              the sole readable signal — no double live region (the
              ThinkingIndicator idiom). The disabled Button already carries the
              not-yet-ready meaning to AT. */}
          {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- a11y-only wrapper: strips the Spinner's role=status subtree from the a11y tree; a decorative mark, not visual UI, and not expressible via @mythrun/ui props (BaseProps bans aria-hidden) */}
          <span aria-hidden="true" className="inline-flex flex-none">
            <Spinner size="xs" tone="accent" />
          </span>
          <Text role="meta" as="span">
            {t('worldReveal.settling')}
          </Text>
        </Stack>
      )}
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
  /** Whether Continue is ENABLED. The button is present in every state; the
   *  route passes false while the tail is still running (the starting-situation
   *  POST requires a complete world), rendering it disabled with a settling
   *  indicator, and true on completion to enable it in place. Default true (a
   *  settled world). */
  continueReady?: boolean
  /** Continue intent — leads to the starting-situation pick (D4). Defaults to
   *  navigating to the situation route; injectable so callers/tests override. */
  onContinue?: () => void
  /** The snapshot source — defaults to the real endpoint; tests substitute it. */
  fetchSnapshot?: FetchSnapshot
  /** The reveal MOMENT (D6) — the route's <RevealTransition> hands it down and
   *  the layout stages itself against it (title/prompt fades, the desktop pane
   *  arrival, the mobile drawer's mount, the fog's final gust). Default: the
   *  settled end state — a reveal that never played (the late arriver). */
  moment?: RevealMoment
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
  moment = SETTLED_MOMENT,
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

  // The pane WAITS for the first fold (a late arriver's first render precedes
  // the SSE snapshot): were the graph mounted at nodes=[], its fog would be
  // born drained in a 0-count world and the count's arrival would GROW the
  // pane-adaptive virtual space — the fog sim warm-starts grown slots ALIVE
  // (its mid-generation resize semantics), resurrecting fog over a done
  // reveal (caught live). Mounting at the real count births the fog drained
  // at the real world size; later folds only merge/rename (never grow the
  // count), so the space never grows post-mount.
  const graph = nodes.length === 0 ? null : (
    <WorldGenGraph
      data-testid="reveal-graph"
      interactive
      nodes={nodes}
      edges={edges}
      onSelect={handleGraphSelect}
      reducedMotion={prefersReducedMotion}
      // E2 (Phase E): the SR/keyboard path into the aria-hidden reveal graph — a
      // roving hidden listbox whose selection drives the same onSelect (and thus
      // the same wiki push) a canvas tap does. Resolved label; DS owns no copy.
      nodeListLabel={t('worldReveal.graphNodeList')}
      // The REGIME props (MYT-89 audit v3 + v4). Desktop: the pane is a true
      // half of the screen — it FILLS the RevealPanes row (fillHost) and must
      // never pan (pannable false zeroes the camera seat; labels tier down by
      // budget instead). Narrow: the pannable camera over the full-legible
      // world, and the pane FILLS the full-bleed stage to the fold (audit v4 —
      // the v3 `!narrow` gate left it on the graph's own 62dvh clamp, stopping
      // two-thirds down the screen). Both breakpoints: the settled world
      // INSISTS on its shape (forcefulSettle, audit v4) — the reveal force
      // profile + drag releases snapping back.
      pannable={narrow}
      fillHost
      forcefulSettle
      // The world is BORN — the fog is gone and STAYS gone, through its one
      // clear mechanism (MYT-89 spawn-drain): the numerator is floored at the
      // drain denominator so the fog mounts drained for EVERY world size (the
      // §3.8 hard invariant, sub-floor residual included — see revealFogShown
      // for why a live gust of the residual was cut).
      shownEntities={revealFogShown(nodes.length)}
      totalEntities={MIN_EXPECTED_ENTITIES}
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
  const continueAction = <ContinueAffordance ready={continueReady} onPress={handleContinue} />

  if (narrow) {
    return (
      <MobileReveal
        graph={graph}
        wikiPanel={wikiPanel}
        continueAction={continueAction}
        moment={moment}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    )
  }
  return (
    <DesktopReveal
      graph={graph}
      wikiPanel={wikiPanel}
      continueAction={continueAction}
      moment={moment}
    />
  )
}
