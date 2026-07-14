import { useCallback, useEffect, useRef, useState } from 'react'
import { Stack, InvitePanel } from '@mythrun/ui'
import {
  ensurePrimaryInvite,
  createInvite,
  revokeInvite,
  isHttpError,
  useApiContext,
  type ApiContext,
} from '@mythrun/client-core'
import { canWebShare, webShare as webSharePort, copyText as copyTextPort } from '../platform/web/share.ts'

// The owner's invite surface on the campaign page (MYT-91) — the wired InvitePanel.
// campaign-page mounts this ONLY for the owner (`creator === null`); invite
// create/list/revoke are owner-only backend routes, so a non-owner sees nothing
// where the seam was. All the network + web-global mechanics live HERE (the
// DOM-free @mythrun/ui InvitePanel takes resolved props + neutral callbacks, R1):
// the primary share link resolves on mount, copy routes through the clipboard port,
// share through navigator.share, and "replace link" revokes then re-mints. A caught
// 409 `invite_cap_reached` maps to the calm cap-reached notice; any other failure
// to the transient error notice. The panel keeps its own `invite-panel` testid; the
// `seam-invite` wrapper preserves the campaign-page/detail selectors.

const INVITE_SEAM_TESTID = 'seam-invite'
const COPIED_RESET_MS = 2000

/** A resolved primary link + its code (the code drives revoke). */
interface PrimaryLink {
  readonly inviteUrl: string
  readonly inviteCode: string
}

/** The invite endpoints + web-global ports the panel needs — injected so tests
 *  drive the wiring without a live endpoint or a real clipboard / navigator.share.
 *  Each field defaults to the real client-core fn or the web share port. */
export interface InvitePanelDeps {
  readonly ensurePrimary?: (ctx: ApiContext, campaignId: string) => Promise<PrimaryLink>
  readonly create?: (ctx: ApiContext, campaignId: string) => Promise<PrimaryLink>
  readonly revoke?: (ctx: ApiContext, campaignId: string, inviteCode: string) => Promise<void>
  readonly copyText?: (text: string) => Promise<void>
  readonly webShare?: (input: { title?: string; url: string }) => Promise<void>
  readonly canShare?: boolean
}

type Notice = 'cap-reached' | 'error'

/** Map a caught invite failure to the panel's calm notice arm. The cap is a soft
 *  limit (its own advisory notice); everything else is the transient error arm. */
function noticeFor(err: unknown): Notice {
  return isHttpError(err) && err.code === 'invite_cap_reached' ? 'cap-reached' : 'error'
}

/** The wired invite panel. Owns the link/copy/notice state and the async plumbing;
 *  delegates every pixel to the presentational @mythrun/ui InvitePanel. */
export function CampaignInvitePanel({
  campaignId,
  deps = {},
}: {
  campaignId: string
  deps?: InvitePanelDeps
}): React.JSX.Element {
  const ctx = useApiContext()
  const {
    ensurePrimary = ensurePrimaryInvite,
    create = createInvite,
    revoke = revokeInvite,
    copyText = copyTextPort,
    webShare = webSharePort,
    canShare = canWebShare(),
  } = deps

  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const codeRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Run a link-producing operation (mount load / create / replace) and settle the
  // panel: on success adopt the fresh link + clear the notice; on failure fall to
  // the create affordance under the mapped notice. Guarded by the mounted ref.
  const resolveLink = useCallback((run: () => Promise<PrimaryLink>): void => {
    setLoading(true)
    run().then(
      (link) => {
        if (!mountedRef.current) return
        codeRef.current = link.inviteCode
        setInviteUrl(link.inviteUrl)
        setNotice(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (!mountedRef.current) return
        codeRef.current = null
        setInviteUrl(null)
        setNotice(noticeFor(err))
        setLoading(false)
      },
    )
  }, [])

  useEffect(() => {
    resolveLink(() => ensurePrimary(ctx, campaignId))
  }, [ctx, campaignId, ensurePrimary, resolveLink])

  useEffect(() => {
    // Reset on (re)mount — NOT just cleared on unmount. Under React StrictMode's
    // dev mount→cleanup→remount, a cleanup-only ref stays `false` after the
    // remount, suppressing every async settle (the panel sticks on "preparing…").
    // Mirrors use-live-roster's useMountedRef.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    }
  }, [])

  const onCopy = useCallback((): void => {
    if (inviteUrl === null) return
    copyText(inviteUrl).then(
      () => {
        if (!mountedRef.current) return
        setCopied(true)
        if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => {
          if (mountedRef.current) setCopied(false)
        }, COPIED_RESET_MS)
      },
      () => {
        if (mountedRef.current) setNotice('error')
      },
    )
  }, [inviteUrl, copyText])

  const onShare = useCallback((): void => {
    if (inviteUrl === null) return
    // A user-cancelled share rejects (AbortError) — a non-event, swallow it.
    webShare({ url: inviteUrl }).catch(() => undefined)
  }, [inviteUrl, webShare])

  const onRevoke = useCallback((): void => {
    const code = codeRef.current
    if (code === null) return
    resolveLink(() => revoke(ctx, campaignId, code).then(() => ensurePrimary(ctx, campaignId)))
  }, [ctx, campaignId, revoke, ensurePrimary, resolveLink])

  const onCreate = useCallback((): void => {
    resolveLink(() => create(ctx, campaignId))
  }, [ctx, campaignId, create, resolveLink])

  return (
    <Stack data-testid={INVITE_SEAM_TESTID}>
      <InvitePanel
        inviteUrl={inviteUrl}
        loading={loading}
        canShare={canShare}
        copied={copied}
        notice={notice}
        onCopy={onCopy}
        onShare={onShare}
        onRevoke={onRevoke}
        onCreate={onCreate}
      />
    </Stack>
  )
}
