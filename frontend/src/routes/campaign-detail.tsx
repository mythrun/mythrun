import { Stack, Heading, Text, Button } from '@mythrun/ui'
import { useApiContext, useWorldGenStream } from '@mythrun/client-core'
import type { PipelinePhase } from '@mythrun/contract/events'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { GeneratingView } from './worldgen/generating.tsx'
import { WorldReveal } from './worldgen/reveal.tsx'

// The campaign-detail screen (`/campaigns/:id`) — the home-hub card's click
// target AND where the create flow lands after Begin (MYT-89 Phase C, C6). It is
// PHASE-AWARE: it opens the world-gen status stream (`useWorldGenStream`, C5) and
// branches on the coarse lifecycle so the SAME url is the returnable home for a
// generating world, a failed/terminal one, the just-finished handoff, and — once
// the campaign is fully set up — the existing detail content (the fall-through).
//
// The `complete` status covers BOTH the just-finished handoff (phase
// `world_ready`/`character_creation`/`post_creation`) and a fully-active campaign
// (phase `complete`); `phase` splits them — the handoff is the seam Phase D fills
// with the reveal → wiki → continue, and phase `complete` falls through to the
// campaign page. Flat 1-bit paper register throughout; all UI composes @mythrun/ui.

/** Phases where world-gen has FINISHED but the campaign is still mid-setup — the
 *  Phase D handoff seam (reveal → wiki → continue), not yet a playable campaign. */
const HANDOFF_PHASES: ReadonlySet<PipelinePhase> = new Set<PipelinePhase>([
  'world_ready',
  'character_creation',
  'post_creation',
])

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

/** The existing (interim) detail content — the fall-through for a campaign that is
 *  past setup and fully playable. A later ticket owns the real detail surface. */
function DetailContent(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-campaign-detail">
      <Heading level={1}>{t('stub.campaignDetail')}</Heading>
      <Text as="p">{t('stub.campaignDetail')}</Text>
    </Stack>
  )
}

export function CampaignDetailRoute(): React.JSX.Element {
  const ctx = useApiContext()
  // The route only matches with an `:id`; `?? ''` keeps the hook call
  // unconditional (hooks can't branch) without a non-null assertion.
  const { id = '' } = useParams<{ id: string }>()
  const { nodes, edges, status, phase, retry } = useWorldGenStream(ctx, id)

  if (status === 'generating') return <GeneratingView nodes={nodes} edges={edges} />
  if (status === 'failed') return <FailedView onRetry={() => void retry()} />
  if (status === 'terminal') return <TerminalView />

  // status === 'complete': the just-finished handoff vs a fully-active campaign.
  // The handoff is the Phase D reveal — the settled graph beside the browsable
  // wiki, with a Continue → to the starting-situation pick (D4).
  if (phase !== null && HANDOFF_PHASES.has(phase))
    return <WorldReveal campaignId={id} nodes={nodes} edges={edges} />
  return <DetailContent />
}
