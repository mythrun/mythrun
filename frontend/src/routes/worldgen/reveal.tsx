import { useEffect, useState } from 'react'
import { Stack, Grid, Heading, Text, Button, WorldGenGraph, WorldWiki } from '@mythrun/ui'
import {
  getWorldSnapshot,
  useApiContext,
  type ApiContext,
  type WorldGenStream,
} from '@mythrun/client-core'
import { toWikiViewModel, type WikiViewModel } from '@mythrun/client-core/worldgen'
import type { WorldSnapshot } from '@mythrun/contract/rest'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'

// The WORLD REVEAL (MYT-89 Phase D, D3) — where the `/campaigns/:id` route lands
// the moment world-gen completes (it replaces C6's `CompleteHandoff` placeholder).
// The owner sees their SETTLED world graph (C4's `WorldGenGraph`, fed the folded
// nodes/edges) BESIDE the browsable wiki (D2's `WorldWiki`, over the D1
// `toWikiViewModel`), with SHARED SELECTION, an explore prompt, and a Continue →
// that leads to the starting-situation pick (D4).
//
// SHARED SELECTION is single-id-space (BUG 2.1): the graph selects by `displayId`
// and, post-gen, every node is finalized so its `displayId` IS its real entity id
// — the same id the wiki keys on. One `selectedEntityId` state feeds both surfaces
// directly, no synthKey↔id bridge. Flat 1-bit paper register; all UI @mythrun/ui.

/** Fetches the FULL known-tier snapshot (the widened `getWorldSnapshot` returns
 *  entities + facts + entityHierarchy) — injected so tests substitute a resolved
 *  fixture. World-gen is complete here, so the endpoint never 409s. */
type FetchSnapshot = (ctx: ApiContext, campaignId: string) => Promise<WorldSnapshot>

interface WikiModelState {
  readonly model: WikiViewModel | null
  readonly loading: boolean
}

/** Fetch the world snapshot once and normalize it to the wiki view model. A
 *  failed/transient fetch settles to a calm empty panel (never throws into the
 *  route). The `active` flag drops a late resolve after unmount. */
function useWikiModel(campaignId: string, fetchSnapshot: FetchSnapshot): WikiModelState {
  const ctx = useApiContext()
  const [model, setModel] = useState<WikiViewModel | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    setLoading(true)
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
  }, [ctx, campaignId, fetchSnapshot])
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
  /** The campaign whose settled world is being revealed. */
  campaignId: string
  /** Continue intent — leads to the starting-situation pick (D4). Defaults to
   *  navigating to the situation route; injectable so callers/tests override. */
  onContinue?: () => void
  /** The snapshot source — defaults to the real endpoint; tests substitute it. */
  fetchSnapshot?: FetchSnapshot
}

export function WorldReveal({
  campaignId,
  nodes,
  edges,
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
  const wiki = useWikiModel(campaignId, fetchSnapshot)

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
        <WorldGenGraph
          data-testid="reveal-graph"
          nodes={nodes}
          edges={edges}
          onSelect={setSelectedEntityId}
          reducedMotion={prefersReducedMotion}
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
      <Stack direction="row">
        <Button onPress={handleContinue} data-testid="reveal-continue">
          {t('worldReveal.continue')}
        </Button>
      </Stack>
    </Stack>
  )
}
