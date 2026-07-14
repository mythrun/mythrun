import { Stack, Heading, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The play route's calm hold surfaces (MYT-92 T16) — the quiet, brand-voiced beats
// the start flow lands on when the live session can't (yet) begin: a viewer/start
// failure retry, the prep dead-end, and the post-session "complete" transition. All
// flat 1-bit paper register (§ brand); a failure is a resume action, not an apology.
// Each is a thin composition of @mythrun/ui primitives centred by the caller's
// CenteredHold. Copy is `[ph:]` (MYT-100 owns the one copy pass).

// The testids are passed as `data-testid` (the i18next no-literal-string rail
// excludes `data-testid` but flags a bare `testId="…"` on a custom component — the
// campaign-page seam pattern).

/** A centred full-height hold — every non-shell play phase (loading / prep / a
 *  notice) fills the full-bleed stage and centres its beat. `grow` takes the flex-1
 *  space the AppFrame full-bleed root gives the route; no min-h escape hatch is
 *  needed (a centred beat has no internal scroll region). */
export function CenteredHold({
  'data-testid': testId,
  children,
}: {
  'data-testid': string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Stack grow align="center" justify="center" gap={4} data-testid={testId}>
      {children}
    </Stack>
  )
}

/** A calm loading line while the viewer identity resolves (before any session). */
export function PlayLoading(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <CenteredHold data-testid="play-loading">
      <Text role="ui-caption" as="p">
        {t('play.loading')}
      </Text>
    </CenteredHold>
  )
}

/** A calm, retryable notice — the shared shape for the viewer-load failure, the
 *  `blocked` start arm, and a generic start `error`. Title optional (the bare
 *  viewer/blocked cases are body-only). */
export function RetryNotice({
  'data-testid': testId,
  title,
  body,
  retryLabel,
  onRetry,
}: {
  'data-testid': string
  title?: string
  body: string
  retryLabel: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <CenteredHold data-testid={testId}>
      {title !== undefined ? (
        <Heading level={1} role="title">
          {title}
        </Heading>
      ) : null}
      <Text role="ui-caption" as="p">
        {body}
      </Text>
      <Stack direction="row">
        <Button variant="secondary" onPress={onRetry} data-testid={`${testId}-retry`}>
          {retryLabel}
        </Button>
      </Stack>
    </CenteredHold>
  )
}

/** The prep dead-end — the SSE reported a `prep-failed`. A retry re-attempts the
 *  whole start (the terminal case will land back here; the calm surface covers it). */
export function PrepFailedNotice({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <RetryNotice
      data-testid="play-prep-failed"
      title={t('play.prep.failedTitle')}
      body={t('play.prep.failedBody')}
      retryLabel={t('play.prep.failedRetry')}
      onRetry={onRetry}
    />
  )
}

/** The brief post-session transition — a `session_end` arrived; the shell navigates
 *  to the recap route (the recap READ is a filed bead; 92 only lands there). */
export function SessionCompleteNotice(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <CenteredHold data-testid="play-complete">
      <Heading level={1} role="title">
        {t('play.complete.title')}
      </Heading>
      <Text role="ui-caption" as="p">
        {t('play.complete.body')}
      </Text>
    </CenteredHold>
  )
}
