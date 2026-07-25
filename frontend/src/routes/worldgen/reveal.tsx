import { useEffect, useState } from 'react'
import {
  Stack,
  Box,
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
import { MIN_EXPECTED_ENTITIES, useWikiNavigation } from '@mythrun/client-core/worldgen'
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
// against its phase — the eyebrow fade at `settle`, the pane arrival / drawer
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
  /** The OUTLINE H1 — the world's name once the snapshot delivers it, the
   *  generic title while it's unknown. Visually hidden on BOTH regimes since
   *  ux-run3: the wiki panel is the document and its header carries the name
   *  on the glass (run-2's myth-8ozsw put the name in the left prime slot;
   *  run-3 found it duplicated the panel header at the same register, so the
   *  left slot demoted to the quiet "Your world" eyebrow and the name lives
   *  in the outline + panel only). Mobile also titles the wiki drawer. */
  title: string
}

/** Desktop: the true 50/50, ARRIVING IN MOTION (D6). The WHOLE left column —
 *  eyebrow over graph over the explore prompt + Continue — composes INSIDE the
 *  panes row's stage cell (ux-run2 myth-ma8yv, critique 018), so the two panes
 *  share both alignment edges: the wiki's top lands on the eyebrow's line and
 *  its bottom on the Continue row's line (a spread in a book, not two
 *  components that happened to load near each other). Pre-`resolve` the stage
 *  cell owns the full width, so the stacking order the player sees mid-moment
 *  is unchanged; at `resolve` the column eases to the left half while the wiki
 *  slides in from the right. The eyebrow (with the hidden outline H1 — see the
 *  fade block) arrives at `settle`, the explore prompt (and Continue) at
 *  `resolve` — whole-block opacity fades with their space reserved from the
 *  first frame, so nothing shifts mid-moment. A settled mount renders all of
 *  it visible, instantly. */
function DesktopReveal({ graph, wikiPanel, continueAction, moment, title }: RevealChromeProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack data-testid="worldgen-reveal">
      <RevealPanes
        data-testid="reveal-panes"
        moment={moment}
        stage={
          <Stack grow gap={4}>
            <RevealFade moment={moment} visibleFrom="settle">
              {/* The settle beat's arrival is now the QUIET EYEBROW (ux-run3):
                  run-2's full-size name here (myth-8ozsw) doubled the wiki
                  panel's header at the same size/weight on one baseline, and
                  the panel is the document — so the left slot demoted to the
                  static "Your world" chrome in the codebase's uppercase
                  ui-label eyebrow register, keeping the settle fade an object
                  and the panes' shared top alignment line (myth-ma8yv). The
                  outline H1 rides along visually hidden, still the world's
                  name — the a11y intent of myth-8ozsw survives. */}
              <VisuallyHidden>
                <Heading level={1} role="title">
                  {title}
                </Heading>
              </VisuallyHidden>
              <Text role="ui-label" as="p">
                {t('worldReveal.title')}
              </Text>
            </RevealFade>
            {/* Box grow (`flex-1 min-h-0`) gives the graph a DEFINITE flexed
                height between the title and the Continue row, so its fillHost
                h-full chain resolves and it owns the column's slack. */}
            <Box grow>{graph}</Box>
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
        }
        panel={wikiPanel}
      />
    </Stack>
  )
}

interface MobileRevealProps extends RevealChromeProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The lifted wiki stack's Back layer — see `DrawerBackClose`. */
  canPageBack: boolean
  onPageBack: () => void
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
function MobileReveal({
  graph,
  wikiPanel,
  continueAction,
  moment,
  open,
  onOpenChange,
  canPageBack,
  onPageBack,
  title,
}: MobileRevealProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack data-testid="worldgen-reveal">
      <VisuallyHidden>
        <Heading level={1} role="title">
          {title}
        </Heading>
      </VisuallyHidden>
      <FullBleedStage inset={6} data-testid="reveal-stage">
        {graph}
      </FullBleedStage>
      {revealPhaseAtLeast(moment.phase, 'resolve') && (
        <>
          {/* E2 (Phase E) + myth-g7kg6: mobile Back precedence — while the drawer
              is open, a browser/hardware Back unwinds ONE layer at a time (the
              reader's wiki page, then the drawer, then the route), via the
              router's history integration. Mounted with the drawer; inert while
              closed. */}
          <DrawerBackClose
            open={open}
            canPageBack={canPageBack}
            onPageBack={onPageBack}
            onClose={() => {
              onOpenChange(false)
            }}
          />
          <Drawer
            data-testid="reveal-drawer"
            title={title}
            description={t('worldReveal.explorePrompt')}
            openLabel={t('worldReveal.wikiOpen')}
            closeLabel={t('worldReveal.wikiClose')}
            open={open}
            onOpenChange={onOpenChange}
          >
            {/* Continue keeps its natural height at the top of the sheet; the
                wiki FILLS what's left (`Box grow` — flex-1 min-h-0) so IT is
                the scroller, not the sheet body. That is what makes the wiki's
                per-page scroll capture/restore real on mobile: while the body
                scrolled, the wiki's own container never moved and every
                captured offset was 0 (myth-1k9qt). */}
            <Stack gap={4} grow>
              {continueAction}
              <Box grow>{wikiPanel}</Box>
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

// The graph-tap selection cluster. The PERSISTENT selection (the graph
// highlight) vs the ONE-SHOT push signal (what the wiki's external-selection
// effect consumes). Split because the wiki's `back()` reports nothing outward:
// were the push signal persistent, re-tapping the SAME node after backing out
// would read as "no change" and the page would never re-open (the D4-review
// re-tap bug).
//
// The push signal clears once the mounted wiki has consumed it (child effects
// run before this parent effect, and the wiki's same-entity push is a no-op,
// so re-delivering is always safe). Deferred while the panel is still the
// loading line (`modelReady` false): the signal must survive until the wiki
// mounts and can consume it on its first effect pass.
// COUPLING: this one-shot pattern relies on WorldWiki treating
// externalSelection as a jump signal — clearing it to undefined must NOT
// navigate home (WorldWiki's external-selection effect keys on the value
// changing to a defined id). A D4-side semantics change breaks re-tap here.
//
// A graph tap: highlight, push the wiki page and — on mobile, where the wiki
// sleeps in the drawer — SUMMON the sheet so the page is actually seen,
// SYNCHRONOUSLY. D5 deferred the summon one macrotask here, because the graph
// selects on POINTERUP while Radix arms the sheet's outside-dismiss at the same
// gesture's POINTERDOWN and delivers it at its trailing CLICK — so an open sheet
// was shut by its own summoning tap. That guard now lives in the Drawer itself
// (myth-cwhdk: it ignores the dismissal carrying the pointerdown that was in
// flight when it opened), which is a guarantee rather than a race won by a hair,
// so this stays plain state.
function useGraphSelection(narrow: boolean, modelReady: boolean, summonDrawer: () => void) {
  const [selection, setSelection] = useState<string | undefined>(undefined)
  const [wikiPush, setWikiPush] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (modelReady && wikiPush !== undefined) setWikiPush(undefined)
  }, [modelReady, wikiPush])
  const handleGraphSelect = (displayId: string): void => {
    setSelection(displayId)
    setWikiPush(displayId)
    if (narrow) summonDrawer()
  }
  return { selection, setSelection, wikiPush, handleGraphSelect }
}

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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [query, setQuery] = useState('')
  // The quiet refetch token: how many silent tail stages have completed. Each
  // bump refetches the snapshot so the reconciled world surfaces while the
  // player reads. Monotonic within a mount (stages only advance).
  const wikiRefreshToken = completedTailStageCount(stages)
  const wiki = useWikiModel(campaignId, fetchSnapshot, wikiRefreshToken)
  // The wiki's page stack, LIFTED out of WorldWiki (myth-g7kg6) so the mobile
  // Back precedence can pop a page before the drawer closes. The wiki drives it
  // exactly as it drives its own; only the ownership moved.
  const wikiNavigation = useWikiNavigation()
  const { selection, setSelection, wikiPush, handleGraphSelect } = useGraphSelection(
    narrow,
    wiki.model !== null,
    () => { setDrawerOpen(true) },
  )

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
      // The glyph KEY (myth-466cy): the same kind labels the wiki's group headings
      // speak, so the graph's diamond/square/stack vocabulary reads as documented
      // rather than decorative. Only kinds present in the world render. The
      // reserved `hollow` seat (ux-run3) names the OUTLINE-only marks — nodes
      // whose name tier-retired at this density, findable in the panel's index —
      // which the key otherwise left reading as a glitch.
      legend={{
        faction: t('worldReveal.group.faction'),
        location: t('worldReveal.group.location'),
        npc: t('worldReveal.group.npc'),
        item: t('worldReveal.group.item'),
        hollow: t('worldReveal.legendHollow'),
      }}
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
      navigation={wikiNavigation}
    />
  )
  const continueAction = <ContinueAffordance ready={continueReady} onPress={handleContinue} />
  // The OUTLINE H1 (+ the mobile drawer's title): the world's NAME once the
  // model delivers it (myth-8ozsw); generic fallback only pre-model. Visually
  // hidden on the glass since ux-run3 — the wiki panel's header carries it.
  const title = wiki.model?.introduction?.title ?? t('worldReveal.title')

  if (narrow) {
    return (
      <MobileReveal
        graph={graph}
        wikiPanel={wikiPanel}
        continueAction={continueAction}
        moment={moment}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        canPageBack={wikiNavigation.canBack}
        onPageBack={wikiNavigation.back}
        title={title}
      />
    )
  }
  return (
    <DesktopReveal
      graph={graph}
      wikiPanel={wikiPanel}
      continueAction={continueAction}
      moment={moment}
      title={title}
    />
  )
}
