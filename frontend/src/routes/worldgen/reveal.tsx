import { useEffect, useState } from 'react'
import { Stack, Grid, Heading, Text, Button, WorldGenGraph, WorldWiki } from '@mythrun/ui'
import {
  completedTailStageCount,
  getWorldSnapshot,
  useApiContext,
  type ApiContext,
  type WorldGenStream,
} from '@mythrun/client-core'
import { MIN_EXPECTED_ENTITIES, toWikiViewModel, type WikiViewModel } from '@mythrun/client-core/worldgen'
import type { WorldSnapshot } from '@mythrun/contract/rest'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'

// The WORLD REVEAL (MYT-89 Phase D, D3 + reveal timing) — where the
// `/campaigns/:id` route lands the moment the CONNECTIONS ARE WOVEN
// (entity_relationships completes), not when the whole pipeline finishes. The
// owner sees their world graph (C4's `WorldGenGraph`, fed the folded
// nodes/edges) BESIDE the browsable wiki (D2's `WorldWiki`, over the D1
// `toWikiViewModel`), with SHARED SELECTION, an explore prompt, and a Continue →
// that leads to the starting-situation pick (D4).
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
// SHARED SELECTION is single-id-space (BUG 2.1): the graph selects by `displayId`
// and, post-gen, every node is finalized so its `displayId` IS its real entity id
// — the same id the wiki keys on. One `selectedEntityId` state feeds both surfaces
// directly, no synthKey↔id bridge. Flat 1-bit paper register; all UI @mythrun/ui.

/** Fetches the FULL known-tier snapshot (the widened `getWorldSnapshot` returns
 *  entities + facts + entityHierarchy) — injected so tests substitute a resolved
 *  fixture. The route mounts this screen only after the boundary stage
 *  (entity_relationships) has committed — the same stage the endpoint's 409
 *  gate checks — so the fetch never 409s. The known-tier filter is SERVER-side
 *  (worldSnapshotView, enforced ignorance): fetching mid-tail serves the same
 *  known-only projection as post-completion. */
type FetchSnapshot = (ctx: ApiContext, campaignId: string) => Promise<WorldSnapshot>

interface WikiModelState {
  readonly model: WikiViewModel | null
  readonly loading: boolean
}

/** Fetch the world snapshot and normalize it to the wiki view model; REFETCH
 *  quietly whenever `refreshToken` bumps (a silent tail stage completed — the
 *  reconciled world). Quiet by construction: `loading` is only ever true before
 *  the FIRST settle, and the current model stays rendered until a fresh one
 *  resolves (a refetch failure keeps the old model — the next tail completion
 *  retries). A failed/transient first fetch settles to a calm empty panel
 *  (never throws into the route). The `active` flag drops a late resolve after
 *  unmount / a superseded refetch. */
function useWikiModel(
  campaignId: string,
  fetchSnapshot: FetchSnapshot,
  refreshToken: number,
): WikiModelState {
  const ctx = useApiContext()
  const [model, setModel] = useState<WikiViewModel | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    void fetchSnapshot(ctx, campaignId)
      .then((snapshot) => {
        if (!active) return
        setModel(toWikiViewModel(snapshot))
        setLoading(false)
      })
      .catch(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, fetchSnapshot, refreshToken])
  return { model, loading }
}

interface WikiPanelProps {
  state: WikiModelState
  selectedEntityId: string | undefined
  onSelect: (entityId: string) => void
  query: string
  onQuery: (query: string) => void
}

/** The wiki side of the reveal: a calm `[ph: …]` line while the snapshot loads or
 *  when the world has nothing to browse, else the browsable `WorldWiki`. */
function WikiPanel({ state, selectedEntityId, onSelect, query, onQuery }: WikiPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  if (state.model === null) {
    return (
      <Text role="ui-caption" as="p">
        {state.loading ? t('worldReveal.loading') : t('worldReveal.empty')}
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
      groupLabels={{
        faction: t('worldReveal.group.faction'),
        location: t('worldReveal.group.location'),
        npc: t('worldReveal.group.npc'),
        item: t('worldReveal.group.item'),
      }}
      {...(selectedEntityId !== undefined ? { selectedId: selectedEntityId } : {})}
    />
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

  const [selectedEntityId, setSelectedEntityId] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  // The quiet refetch token: how many silent tail stages have completed. Each
  // bump refetches the snapshot so the reconciled world surfaces while the
  // player reads. Monotonic within a mount (stages only advance).
  const wikiRefreshToken = completedTailStageCount(stages)
  const wiki = useWikiModel(campaignId, fetchSnapshot, wikiRefreshToken)

  // The graph now selects in `displayId` space, which post-gen IS the entity id —
  // the same id the wiki keys on. So the shared selection needs no translation.
  const handleContinue = (): void => {
    if (onContinue) onContinue()
    else void navigate(`/campaigns/${campaignId}/situation`)
  }

  return (
    <Stack gap={4} data-testid="worldgen-reveal">
      <Heading level={1} role="title">
        {t('worldReveal.title')}
      </Heading>
      {/* Graph beside wiki. `auto-fill` + `minColumnPx` builds a
          `repeat(auto-fill, minmax(340px, 1fr))` track: below ~680px (2×340 +
          gap) only ONE 340px column fits, so the two panes WRAP into a genuine
          stack at ~375px; at desktop widths two sit side by side — no media
          query. (auto-fit would IGNORE `minColumnPx` — the DS honours it only
          for auto-fill — and collapse to side-by-side even at 375px.) Very wide
          viewports keep empty trailing tracks; cosmetically fine at two panes. */}
      <Grid columns="auto-fill" minColumnPx={340} gap={4}>
        {/* The reveal graph is INTERACTIVE (§3.4): the accessible entity list + shared
            selection (graph ↔ wiki) are the reveal experience — so it opts into the
            component's default-gated behaviour. */}
        <WorldGenGraph
          data-testid="reveal-graph"
          interactive
          nodes={nodes}
          edges={edges}
          onSelect={setSelectedEntityId}
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
          {...(selectedEntityId !== undefined ? { selectedKey: selectedEntityId } : {})}
        />
        <WikiPanel
          state={wiki}
          selectedEntityId={selectedEntityId}
          onSelect={(entityId) => {
            setSelectedEntityId(entityId)
          }}
          query={query}
          onQuery={setQuery}
        />
      </Grid>
      <Text role="prose-body" as="p">
        {t('worldReveal.explorePrompt')}
      </Text>
      {/* The Continue appears QUIETLY once the pipeline finishes (the pick's POST
          requires a complete world). While the tail runs, the explore prompt is the
          whole call to action — exploring IS the intent of this screen. */}
      {continueReady && (
        <Stack direction="row">
          <Button onPress={handleContinue} data-testid="reveal-continue">
            {t('worldReveal.continue')}
          </Button>
        </Stack>
      )}
    </Stack>
  )
}
