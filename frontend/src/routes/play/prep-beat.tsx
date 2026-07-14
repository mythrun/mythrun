import { useEffect, useState } from 'react'
import { useSessionPrep, type ApiContext, type SessionPrepStream } from '@mythrun/client-core'
import { SessionStartBeat } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { CenteredHold, PrepFailedNotice } from './notices.tsx'

// The prep phase (MYT-92 T16). The start flow's `prep_not_ready` arm lands here: the
// SSE-driven atmospheric wait (`useSessionPrep`) drives a two-phase SessionStartBeat
// while the DM prepares tonight's session, and the beat resolves UPWARD — when prep
// goes `ready`, `onReady` re-attempts start (= the flow's `retry`).
//
// FAILURE LATCH (T3 accumulated note): `useSessionPrep` re-snapshots `generating`
// after a reconnect that followed a live `prep-failed` (the prep row's existence is
// the snapshot's only signal). So once the hook reports a failure, this beat LATCHES
// it and renders the calm failure + retry — it never re-arms the atmospheric beat off
// a post-failure `generating` re-snapshot. The parent unmounts this beat on the
// start-flow transition, so the latch lives exactly as long as the prep phase.

/** The `useSessionPrep` seam — injected for tests; defaults to the real hook. */
type UsePrep = (ctx: ApiContext, campaignId: string) => SessionPrepStream

export interface PrepBeatProps {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly reducedMotion: boolean
  /** Re-attempt start (= the flow's `retry`) when prep completes. */
  readonly onReady: () => void
  /** Injected prep hook (tests); defaults to `useSessionPrep`. */
  readonly usePrep?: UsePrep
}

export function PrepBeat({
  ctx,
  campaignId,
  reducedMotion,
  onReady,
  usePrep = useSessionPrep,
}: PrepBeatProps): React.JSX.Element {
  const { t } = useTranslation()
  const prep = usePrep(ctx, campaignId)

  // Latch a failure: once seen it never reverts to the beat (a post-failure reconnect
  // re-snapshots `generating`, which must NOT re-arm the atmospheric wait).
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (prep.status === 'failed') setFailed(true)
  }, [prep.status])

  // Prep completed → resolve upward (re-attempt start). Fired from an effect so the
  // parent's state update isn't a render-phase side effect.
  useEffect(() => {
    if (prep.status === 'ready') onReady()
  }, [prep.status, onReady])

  if (failed) return <PrepFailedNotice onRetry={onReady} />

  return (
    <CenteredHold data-testid="play-prep">
      <SessionStartBeat
        phase="prep"
        reducedMotion={reducedMotion}
        prepLabel={t('play.start.prep')}
        connectingLabel={t('play.start.connecting')}
      />
    </CenteredHold>
  )
}
