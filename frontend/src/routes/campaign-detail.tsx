import { useEffect, useRef, useState } from 'react'
import { Stack, Heading, Text, Button, RevealTransition } from '@mythrun/ui'
import {
  connectionsDone,
  getStartingSituations,
  getStageTimings,
  useApiContext,
  useWorldGenStream,
  type ApiContext,
  type StageTiming,
  type StartingSituationsResponse,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { usePrefersReducedMotion } from '../platform/web/use-prefers-reduced-motion.ts'
import { GeneratingView } from './worldgen/generating.tsx'
import { WorldReveal } from './worldgen/reveal.tsx'
import { CampaignPage } from './campaign-page.tsx'

// The campaign-detail screen (`/campaigns/:id`) — the home-hub card's click
// target AND where the create flow lands after Begin (MYT-89 Phase C, C6). It is
// PHASE-AWARE: it opens the world-gen status stream (`useWorldGenStream`, C5) and
// branches on the coarse lifecycle so the SAME url is the returnable home for a
// generating world, a failed/terminal one, the reveal (D3), and — once a
// starting situation is chosen — the CAMPAIGN PAGE (D5).
//
// THE WIKI-REVEAL MOMENT (MYT-89 reveal timing): the reveal fires the instant
// connection-weaving (`entity_relationships`) COMPLETES — `connectionsDone` over
// the stream's folded stages — NOT when the whole pipeline finishes. The silent
// tail (consolidation → embed) keeps running behind the reveal while the owner
// explores the wiki; the SSE stream stays open (the hook stays mounted), tail
// completions quietly refresh the reveal's wiki snapshot (its `stages` prop),
// and Continue appears only at full completion (`continueReady` — the
// starting-situation POST requires a complete world). The world-snapshot
// endpoint's 409 gate keys on the SAME boundary stage, and its known-tier
// filter is server-side, so the earlier fetch is both available and
// enforced-ignorance-safe. Once the mid-gen reveal has shown, the world_ready
// flip must NOT interpose the settling line (that would unmount the exploring
// owner's screen) — `sawMidGenRevealRef` keeps the reveal continuous through
// the flip.
//
// THE POST-SITUATION SEAM: picking a starting situation (D4) does NOT advance the
// pipeline phase — it only records `campaigns.starting_situation_index`, so the
// derived phase stays `world_ready` (it flips to `complete` only when the campaign
// goes active, after the whole party's characters are integrated). So a `complete`
// STATUS with a `world_ready` PHASE is ambiguous: the just-generated owner (no
// situation yet → the one-time reveal) vs the owner who just picked one (→ the
// campaign page). The pipeline phase can't tell them apart, so this route reads the
// chosen-situation flag (`getStartingSituations().chosenIndex`) for exactly that
// `world_ready` case. Every later phase (character_creation / post_creation /
// complete) implies a situation is already chosen, so those go straight to the
// campaign page. Flat 1-bit paper register throughout; all UI composes @mythrun/ui.

/** The situations source — defaults to the real endpoint; tests substitute it. */
type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>

/** The stage-timings source (the ETA history) — defaults to the real endpoint. */
type FetchTimings = (ctx: ApiContext) => Promise<readonly StageTiming[]>

/** Fetch the historical per-stage timings ONCE while generating — the data-driven
 *  ETA source the status card renders a rough "time left" from. `null` until it
 *  resolves and on ANY failure (cold-start `[]` also yields no estimate downstream),
 *  so the card degrades to bars-only. Gated to the generating window so no other
 *  phase fetches. */
function useStageTimings(
  ctx: ApiContext,
  active: boolean,
  fetchTimings: FetchTimings,
): readonly StageTiming[] | null {
  const [timings, setTimings] = useState<readonly StageTiming[] | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    void fetchTimings(ctx)
      .then((res) => {
        if (alive) setTimings(res)
      })
      .catch(() => {
        if (alive) setTimings(null)
      })
    return () => {
      alive = false
    }
  }, [ctx, active, fetchTimings])
  return timings
}

/** Whether the owner has already chosen a starting situation. `loading` is the
 *  brief resolve window; `not-chosen` and a fetch failure both fall to the reveal
 *  (the pre-situation default — worst case the owner re-picks idempotently). */
type ChosenState = 'loading' | 'not-chosen' | 'chosen'

/** Resolve the chosen-situation flag, but ONLY while the ambiguous `world_ready`
 *  case is live (`active`). Other phases never fetch — they route deterministically. */
function useSituationChosen(
  ctx: ApiContext,
  campaignId: string,
  active: boolean,
  fetchSituations: FetchSituations,
): ChosenState {
  const [state, setState] = useState<ChosenState>('loading')
  useEffect(() => {
    if (!active) return
    let alive = true
    setState('loading')
    void fetchSituations(ctx, campaignId)
      .then((res) => {
        if (alive) setState(res.chosenIndex !== null ? 'chosen' : 'not-chosen')
      })
      .catch(() => {
        if (alive) setState('not-chosen')
      })
    return () => {
      alive = false
    }
  }, [ctx, campaignId, active, fetchSituations])
  return state
}

/** Calm, retryable world-gen failure — a resume action, not an apology (§ brand). */
function FailedView({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={3} data-testid="worldgen-failed">
      <Heading level={1} role="title">
        {t('worldGen.failedTitle')}
      </Heading>
      <Text as="p">{t('worldGen.failedBody')}</Text>
      <Stack direction="row">
        <Button onPress={onRetry} data-testid="worldgen-retry">
          {t('worldGen.retry')}
        </Button>
      </Stack>
    </Stack>
  )
}

/** The non-resumable dead end — no retry affordance, a nudge to start fresh. */
function TerminalView(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={3} data-testid="worldgen-terminal">
      <Heading level={1} role="title">
        {t('worldGen.terminalTitle')}
      </Heading>
      <Text as="p">{t('worldGen.terminalBody')}</Text>
    </Stack>
  )
}

/** The access-control dead end (myth-otukr): the status stream's open returned
 *  403/404 — the campaign doesn't exist, or the viewer isn't a member — so no
 *  phase ever arrives. A calm, terminal no-access screen (NO retry: retrying an
 *  access denial can't grant access), mirroring the /play route's calm-hold
 *  pattern. Without this the route stranded on the phase===null settling line
 *  forever. */
function NoAccessView(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={3} data-testid="campaign-no-access">
      <Heading level={1} role="title">
        {t('campaign.noAccess.title')}
      </Heading>
      <Text as="p">{t('campaign.noAccess.body')}</Text>
    </Stack>
  )
}

/** The brief resolve window at `world_ready` while the chosen-situation flag loads —
 *  a calm line, so the reveal↔page split never flashes the wrong surface. */
function SettlingView(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={3} data-testid="campaign-settling">
      <Text role="ui-caption" as="p">
        {t('campaign.settling')}
      </Text>
    </Stack>
  )
}

export interface CampaignDetailRouteProps {
  /** The chosen-situation source — defaults to the real endpoint; tests substitute it. */
  fetchSituations?: FetchSituations
  /** The stage-timings source (the ETA history) — defaults to the real endpoint;
   *  tests substitute it. */
  fetchTimings?: FetchTimings
}

export function CampaignDetailRoute({
  fetchSituations = getStartingSituations,
  fetchTimings = getStageTimings,
}: CampaignDetailRouteProps = {}): React.JSX.Element {
  const ctx = useApiContext()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls
  // unconditional (hooks can't branch) without a non-null assertion.
  const { id = '' } = useParams<{ id: string }>()
  const { nodes, edges, status, phase, stages, resumedMidGen, retry } = useWorldGenStream(ctx, id)
  // The reveal moment collapses to its ~300ms fade under reduced motion (§3.8).
  const prefersReducedMotion = usePrefersReducedMotion()
  // Only `world_ready` is reveal-vs-page ambiguous; gate the fetch to it.
  const worldReady = status === 'complete' && phase === 'world_ready'
  const chosen = useSituationChosen(ctx, id, worldReady, fetchSituations)
  const generating = status === 'generating'
  // The wiki-reveal moment: connection-weaving has committed — the visible wait
  // is over even though the silent tail is still running (`generating` holds).
  const revealDuringGen = generating && connectionsDone(stages)
  // The ETA history: fetched once during the watched stretch, fed to the status
  // card. The reveal has no ETA — the wait is over.
  const stageTimings = useStageTimings(ctx, generating && !revealDuringGen, fetchTimings)
  // Once the mid-gen reveal has shown, the world_ready flip keeps rendering it
  // straight through the chosen-flag resolve window (no settling interposition —
  // the owner is mid-exploration; pre-pick the reveal IS the default anyway).
  const sawMidGenRevealRef = useRef(false)
  useEffect(() => {
    if (revealDuringGen) sawMidGenRevealRef.current = true
  }, [revealDuringGen])

  // ONE reveal element for every branch that shows it: same type, same position →
  // React keeps it MOUNTED across the generating → world_ready flip (selection,
  // search, the wiki model AND the reveal moment's latch all survive). Continue
  // appears only at completion.
  //
  // THE REVEAL MOMENT (D6, §3.8): the transition plays exactly when the WATCHER
  // reaches the swap — `play={revealDuringGen}` is true on the very render that
  // first swaps generating→reveal, and the transition latches on that first
  // true, so the later world_ready flip (revealDuringGen → false) neither
  // reverses nor restarts it (its own latch; `sawMidGenRevealRef` above keeps
  // this same element rendered through the flip). A late arriver mounts the
  // reveal with play=false forever → the settled end state, no beat.
  const reveal = (
    <RevealTransition
      data-testid="reveal-moment"
      play={revealDuringGen}
      reducedMotion={prefersReducedMotion}
    >
      {(moment) => (
        <WorldReveal
          campaignId={id}
          nodes={nodes}
          edges={edges}
          stages={stages}
          continueReady={status === 'complete'}
          moment={moment}
        />
      )}
    </RevealTransition>
  )

  // The access-control dead end (myth-otukr): the status stream's open returned
  // 403/404, so it stopped retrying and no phase will ever arrive. Surface the
  // calm no-access screen BEFORE the phase===null settling gate below — otherwise
  // a denied/nonexistent/malformed campaign strands on the settling line forever.
  if (status === 'denied') return <NoAccessView />

  // The CONNECTING window (MYT-102 audit): before the stream's first snapshot
  // frame, `phase` is null and the coarse status defaults to 'generating' — a
  // COMPLETED campaign's fresh load flashed the generating flavor screen for a
  // beat before swapping to the reveal/page. The settling line is the designed
  // cover for exactly this ambiguity; render it until the first frame decides.
  if (phase === null) return <SettlingView />

  if (generating) {
    if (revealDuringGen) return reveal
    return (
      <GeneratingView
        nodes={nodes}
        edges={edges}
        stages={stages}
        stageTimings={stageTimings}
        resumedMidGen={resumedMidGen}
        campaignId={id}
      />
    )
  }
  // THE CHARACTER-CONTEXT FAILURE INTERCEPTION (MYT-90 D8): `derivePhase` returns a
  // party-wide `failed` when a per-player concept fails OR when the terminal
  // integration failure flips campaigns.status to 'failed' — and the stream
  // collapses that phase to a coarse `terminal` (see statusForPhase in
  // use-worldgen-stream). That failure happened AFTER the world completed, so it
  // must reach CampaignPage's character surface (which shows a character-context
  // retry, and never terminal-screens the whole party for one member's failure) —
  // NOT the world-gen FailedView/TerminalView. Only a genuine world-gen failure
  // (phase 'world_gen_failed' — retryable 'failed', or resume-capped 'terminal')
  // shows the world-gen screens, so gate the short-circuit on that phase.
  if (phase !== 'failed') {
    if (status === 'failed') return <FailedView onRetry={() => void retry()} />
    if (status === 'terminal') return <TerminalView />
  }

  // status === 'complete'. The `world_ready` phase splits on the chosen-situation
  // flag: the one-time reveal (D3) until a situation is picked, then the campaign
  // page (D5). Every later phase already has a situation → the campaign page.
  if (worldReady) {
    if (chosen === 'loading') return sawMidGenRevealRef.current ? reveal : <SettlingView />
    if (chosen === 'not-chosen') return reveal
  }
  return <CampaignPage campaignId={id} />
}
