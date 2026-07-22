import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Stack, Text, Button, JoinPreview } from '@mythrun/ui'
import {
  previewInvite,
  acceptInvite,
  mapPreviewError,
  mapAcceptError,
  signinReturnToJoin,
  useApiContext,
  useSessionStore,
  type ApiContext,
  type InvitePreview,
  type AcceptResult,
  type AcceptArmKind,
} from '@mythrun/client-core'

// The PUBLIC invite-join route `/join/:code` (MYT-91 §7) — the surface a share
// link resolves to, pre-auth. It previews the invite on mount, then composes the
// @mythrun/ui <JoinPreview> card (the campaign, who invited you, and one CTA). The
// route owns everything the presentational card cannot:
//
//   • the PREVIEW FETCH + its two throw-forks (mapPreviewError). The preview
//     endpoint resolves 200 with `valid:false` for a revoked/expired code (the
//     card renders that in-card, with the real campaign/owner still shown) and
//     only THROWS for a code that never existed (404 → `invalid`) or a transient
//     failure (network/5xx → `error`). A thrown `invalid` has NO campaign data, so
//     the route renders a STANDALONE terminal notice and never mounts the card;
//     `error` is a calm retry arm.
//   • the SIGNED-OUT handoff — the CTA navigates to `signinReturnToJoin(code)`,
//     the SHIPPED isLocalPath-guarded `?returnTo` + OAuth-state round-trip (no new
//     redirect mechanism); on return the route re-mounts signed-in.
//   • the SIGNED-IN inline ACCEPT — `acceptInvite` then navigate: an already-a-
//     member goes straight to the campaign; a fresh member to the shipped
//     join-summary. A failed accept resolves through `mapAcceptError` to a calm
//     arm the card surfaces (no navigation).
//
// Flat 1-bit paper register; all UI composes @mythrun/ui. Every user-facing string
// is an i18n key.

/** The preview lifecycle. `invalid`/`error` are the two `mapPreviewError` forks —
 *  `invalid` is terminal (a code that never existed; retry is pointless), `error`
 *  is the retryable transient arm. `ready` carries the parsed 200 preview (whose
 *  own `valid` may be false — a revoked/expired code the card renders in place). */
type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'invalid' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly preview: InvitePreview }

export interface JoinRouteProps {
  /** The preview source — defaults to the real endpoint; tests + stories substitute it. */
  readonly fetchPreview?: (ctx: ApiContext, code: string) => Promise<InvitePreview>
  /** The accept action — defaults to the real endpoint; tests substitute it. */
  readonly accept?: (ctx: ApiContext, code: string) => Promise<AcceptResult>
  /** Navigation seam — defaults to react-router; tests inject a spy. */
  readonly navigateTo?: (path: string) => void
}

/** The calm standalone body for the non-ready preview states — each stands alone
 *  on the public page (no card): a loading line, the terminal invalid notice, and
 *  the retryable transient arm. */
function PreviewNotice({
  status,
  onRetry,
}: {
  status: 'loading' | 'invalid' | 'error'
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (status === 'loading') {
    return (
      <Text role="ui-caption" as="p" data-testid="route-join-loading">
        {t('join.loading')}
      </Text>
    )
  }
  if (status === 'invalid') {
    return (
      <Text role="ui-caption" as="p" data-testid="route-join-invalid">
        {t('join.invalid')}
      </Text>
    )
  }
  return (
    <Stack gap={3} align="center" data-testid="route-join-error">
      <Text role="ui-caption" as="p">
        {t('join.loadError')}
      </Text>
      <Button variant="secondary" onPress={onRetry}>
        {t('join.retry')}
      </Button>
    </Stack>
  )
}

export function JoinRoute({
  fetchPreview = previewInvite,
  accept = acceptInvite,
  navigateTo,
}: JoinRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  const go = navigateTo ?? ((path: string) => void navigate(path))
  // The route only matches with a `:code`; `?? ''` keeps the hook calls unconditional.
  const { code = '' } = useParams<{ code: string }>()
  const signedIn = useSessionStore((s) => s.status === 'ready')
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  // A retry nudge — bumping it re-runs the preview effect.
  const [reloadKey, setReloadKey] = useState(0)
  const [accepting, setAccepting] = useState(false)
  const [arm, setArm] = useState<AcceptArmKind | null>(null)

  useEffect(() => {
    let active = true
    setLoad({ status: 'loading' })
    void fetchPreview(ctx, code)
      .then((preview) => {
        if (active) setLoad({ status: 'ready', preview })
      })
      .catch((err: unknown) => {
        if (active) setLoad({ status: mapPreviewError(err) })
      })
    return () => {
      active = false
    }
  }, [ctx, code, fetchPreview, reloadKey])

  const onSignIn = (): void => {
    go(signinReturnToJoin(code))
  }

  const onAccept = (): void => {
    setAccepting(true)
    setArm(null)
    void accept(ctx, code)
      .then((result) => {
        // A member who already belongs skips the join-summary (they have already
        // seen the world intro) and lands on the campaign; a fresh member gets it.
        go(result.alreadyMember ? `/campaigns/${result.campaignId}` : `/campaigns/${result.campaignId}/join`)
      })
      .catch((err: unknown) => {
        setArm(mapAcceptError(err))
        setAccepting(false)
      })
  }

  return (
    <Stack minHeight="screen" align="center" justify="center" gap={4} data-testid="route-join">
      {load.status === 'ready' ? (
        <JoinPreview
          campaignName={load.preview.campaignName}
          ownerName={load.preview.ownerDisplayName}
          valid={load.preview.valid}
          signedIn={signedIn}
          accepting={accepting}
          arm={arm}
          onAccept={onAccept}
          onSignIn={onSignIn}
          labels={{
            eyebrow: t('join.preview.eyebrow'),
            invitedBy: t('join.preview.invitedBy'),
            accept: t('join.preview.accept'),
            signin: t('join.preview.signin'),
            invalid: t('join.preview.invalid'),
            full: t('join.preview.full'),
            revoked: t('join.preview.revoked'),
            gone: t('join.preview.gone'),
            notFound: t('join.preview.notFound'),
            timeout: t('join.preview.timeout'),
            error: t('join.preview.error'),
          }}
        />
      ) : (
        <PreviewNotice
          status={load.status}
          onRetry={() => {
            setReloadKey((k) => k + 1)
          }}
        />
      )}
    </Stack>
  )
}
