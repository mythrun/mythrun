import { useEffect, useState } from 'react'
import { Stack, Heading, Text, Button } from '@mythrun/ui'
import {
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
import { GeneratingView } from './worldgen/generating.tsx'
import { WorldReveal } from './worldgen/reveal.tsx'
import { CampaignPage } from './campaign-page.tsx'

// The campaign-detail screen (`/campaigns/:id`) — the home-hub card's click
// target AND where the create flow lands after Begin (MYT-89 Phase C, C6). It is
// PHASE-AWARE: it opens the world-gen status stream (`useWorldGenStream`, C5) and
// branches on the coarse lifecycle so the SAME url is the returnable home for a
// generating world, a failed/terminal one, the just-finished reveal (D3), and —
// once a starting situation is chosen — the CAMPAIGN PAGE (D5).
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
  const { nodes, edges, status, phase, stages, retry } = useWorldGenStream(ctx, id)
  // Only `world_ready` is reveal-vs-page ambiguous; gate the fetch to it.
  const worldReady = status === 'complete' && phase === 'world_ready'
  const chosen = useSituationChosen(ctx, id, worldReady, fetchSituations)
  // The ETA history: fetched once while generating, fed to the status card.
  const generating = status === 'generating'
  const stageTimings = useStageTimings(ctx, generating, fetchTimings)

  if (generating)
    return (
      <GeneratingView nodes={nodes} edges={edges} stages={stages} stageTimings={stageTimings} />
    )
  if (status === 'failed') return <FailedView onRetry={() => void retry()} />
  if (status === 'terminal') return <TerminalView />

  // status === 'complete'. The `world_ready` phase splits on the chosen-situation
  // flag: the one-time reveal (D3) until a situation is picked, then the campaign
  // page (D5). Every later phase already has a situation → the campaign page.
  if (worldReady) {
    if (chosen === 'loading') return <SettlingView />
    if (chosen === 'not-chosen')
      return <WorldReveal campaignId={id} nodes={nodes} edges={edges} />
  }
  return <CampaignPage campaignId={id} />
}
