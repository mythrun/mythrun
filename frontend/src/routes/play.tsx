import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApiContext } from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import { usePrefersReducedMotion } from '../platform/web/use-prefers-reduced-motion.ts'
import {
  usePlayViewer,
  defaultFetchMe,
  defaultFetchCampaigns,
  type FetchMe,
  type FetchCampaigns,
} from './play/play-viewer.ts'
import { PlaySession, type PlaySessionProps } from './play/play-session.tsx'
import { PlayLoading, RetryNotice } from './play/notices.tsx'

// The live-play screen (`/campaigns/:id/play`, MYT-92 spec §2) — the keystone that
// replaces the stub. It runs on the full-bleed AppFrame content variant (T15's
// `handle: { fullBleed: true }`): header + this stage = exactly one viewport, the
// transcript scrolls internally.
//
// The route is a THIN composition: it resolves the viewer identity + campaign
// ownership (`usePlayViewer`), then hands off to <PlaySession>, which owns the start
// flow + the live session shell. The client-core hooks carry all the reasoning (the
// start classifier, the transcript reducer, the transport view-model); this file only
// wires identity → the started-session driver and renders the calm loading/error
// holds around it. Enforced ignorance holds by construction — the screen only renders
// transport-delivered frames; it adds no frame type and no read surface.
//
// Injectable seams (defaults are the real endpoints/hooks) mirror the CharacterSurface
// house pattern: `fetchMe`/`fetchCampaigns` for the identity load, and the three
// session hooks threaded down so tests drive any phase deterministically without a
// live transport.

export interface PlayRouteProps {
  readonly fetchMe?: FetchMe
  readonly fetchCampaigns?: FetchCampaigns
  readonly useStart?: PlaySessionProps['useStart']
  readonly usePrep?: PlaySessionProps['usePrep']
  readonly useLiveSession?: PlaySessionProps['useLiveSession']
}

export function PlayRoute({
  fetchMe = defaultFetchMe,
  fetchCampaigns = defaultFetchCampaigns,
  useStart,
  usePrep,
  useLiveSession,
}: PlayRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const reducedMotion = usePrefersReducedMotion()
  // The campaign_failed terminal arm returns here (the setup page), where the
  // integration-failure surface owns the retry. Template-literal path (not a
  // translatable string); `navigate` returns a promise under react-router 7 → void it.
  const exitToCampaign = useCallback((): void => {
    void navigate(`/campaigns/${id}`)
  }, [navigate, id])

  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
  }, [])

  const viewerState = usePlayViewer(id, ctx, reloadKey, fetchMe, fetchCampaigns)

  let content: React.JSX.Element
  if (viewerState.status === 'loading') {
    content = <PlayLoading />
  } else if (viewerState.status === 'error') {
    content = (
      <RetryNotice
        data-testid="play-viewer-error"
        body={t('play.error.body')}
        retryLabel={t('play.error.retry')}
        onRetry={reload}
      />
    )
  } else {
    content = (
      <PlaySession
        ctx={ctx}
        campaignId={id}
        viewer={viewerState.viewer}
        reducedMotion={reducedMotion}
        onExitToCampaign={exitToCampaign}
        {...(useStart !== undefined && { useStart })}
        {...(usePrep !== undefined && { usePrep })}
        {...(useLiveSession !== undefined && { useLiveSession })}
      />
    )
  }

  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- play-stage viewport-fill root; the min-h-0 flex-scroll column is not expressible via @mythrun/ui Stack props (BaseProps bans className), mirroring app-frame.tsx's full-bleed root
    <div className="flex min-h-0 flex-1 flex-col" data-testid="route-play">
      {content}
    </div>
  )
}
