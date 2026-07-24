import { Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Stack, Heading, Text, Button, Spinner } from '@mythrun/ui'
import { useSessionRecap, type SessionRecap } from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

// The post-play session recap (`/campaigns/:id/recap`, myth-lhp99) — where a
// session lands after the DM's farewell + the `session_end` frame. It renders the
// SECRET-FREE post-session analysis (summary + emerging threads) the backend
// serves, in the brand's quiet register: what happened, what's left open, the
// one-credit cost, and a way back to the campaign. No transcript dump, no "Session
// Complete!" fanfare — closure, not a scoreboard.
//
// The analysis is ASYNC (written by an Opus job after finalize), so the read hook
// polls: a just-ended session shows the calm "writing up the recap" beat until the
// summary lands, then the prose. Enforced ignorance holds server-side — the
// endpoint never reads the secret-aware handoff.
//
// Structure: RecapRoute (param + Suspense) → RecapData (the polling read) →
// RecapView (pure presentation over the recap row — the TDD seam).

/** Resolved copy for the recap surface. */
interface RecapLabels {
  readonly title: string
  readonly sessionLabel: (n: number) => string
  readonly summaryHeading: string
  readonly threadsHeading: string
  readonly cost: string
  readonly pending: string
  readonly empty: string
  readonly back: string
}

function buildLabels(t: TFunction): RecapLabels {
  return {
    title: t('recap.title'),
    sessionLabel: (n: number) => t('recap.sessionLabel', { number: n }),
    summaryHeading: t('recap.summaryHeading'),
    threadsHeading: t('recap.threadsHeading'),
    cost: t('recap.cost'),
    pending: t('recap.pending'),
    empty: t('recap.empty'),
    back: t('recap.back'),
  }
}

/** Pure recap presentation. `recap` is null when the campaign has no ended session
 *  (the empty beat); `pending` while the async analysis is still being written;
 *  `ready` renders the prose. Isolated from the fetch so it unit-tests directly. */
export function RecapView({
  recap,
  labels,
  onBack,
}: {
  recap: SessionRecap | null
  labels: RecapLabels
  onBack: () => void
}): React.JSX.Element {
  if (recap === null) {
    return (
      <Stack gap={4} maxWidth="prose" data-testid="route-recap">
        <Heading level={1}>{labels.title}</Heading>
        <Text role="ui-caption" as="p" data-testid="recap-empty">
          {labels.empty}
        </Text>
        <BackButton label={labels.back} onBack={onBack} />
      </Stack>
    )
  }

  return (
    <Stack gap={4} maxWidth="prose" data-testid="route-recap">
      <Stack gap={1}>
        <Text role="ui-label">{labels.sessionLabel(recap.sessionNumber)}</Text>
        <Heading level={1}>{labels.title}</Heading>
      </Stack>

      {recap.status === 'pending' ? (
        <Stack direction="row" gap={2} align="center" data-testid="recap-pending">
          <Spinner size="xs" tone="accent" />
          <Text role="ui-caption" as="p">
            {labels.pending}
          </Text>
        </Stack>
      ) : (
        <Stack gap={4} data-testid="recap-ready">
          <Stack gap={2}>
            <Text role="ui-label">{labels.summaryHeading}</Text>
            <Text role="prose-body" as="p" data-testid="recap-summary">
              {recap.summary}
            </Text>
          </Stack>
          {recap.emergingThreads !== undefined && recap.emergingThreads.length > 0 && (
            <Stack gap={2} data-testid="recap-threads">
              <Text role="ui-label">{labels.threadsHeading}</Text>
              <Stack gap={1}>
                {recap.emergingThreads.map((thread, i) => (
                  <Text key={i} role="prose-body" as="p">
                    {thread}
                  </Text>
                ))}
              </Stack>
            </Stack>
          )}
        </Stack>
      )}

      <Text role="meta" as="p" data-testid="recap-cost">
        {labels.cost}
      </Text>
      <BackButton label={labels.back} onBack={onBack} />
    </Stack>
  )
}

function BackButton({ label, onBack }: { label: string; onBack: () => void }): React.JSX.Element {
  return (
    <Stack direction="row">
      <Button variant="secondary" onPress={onBack} data-testid="recap-back">
        {label}
      </Button>
    </Stack>
  )
}

/** The polling read + navigation wire. Suspends on first load; subsequent polls
 *  are background (the pending beat, not the fallback, shows while the analysis
 *  is written). */
function RecapData({ campaignId, labels }: { campaignId: string; labels: RecapLabels }): React.JSX.Element {
  const navigate = useNavigate()
  const { data } = useSessionRecap(campaignId)
  return (
    <RecapView
      recap={data.recap}
      labels={labels}
      onBack={() => {
        void navigate(`/campaigns/${campaignId}`)
      }}
    />
  )
}

export function RecapRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const labels = buildLabels(t)
  // The route param is always present for a matched `/campaigns/:id/recap`; the
  // guard keeps the type narrow and renders the calm empty beat if it's ever absent.
  if (id === undefined) {
    return <RecapView recap={null} labels={labels} onBack={() => undefined} />
  }
  return (
    <Suspense fallback={<Spinner />}>
      <RecapData campaignId={id} labels={labels} />
    </Suspense>
  )
}
