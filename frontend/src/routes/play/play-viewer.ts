import { useEffect, useState } from 'react'
import {
  getMe,
  getMyCampaigns,
  type ApiContext,
  type CampaignSummary,
} from '@mythrun/client-core'

// The play route's viewer + ownership loader (MYT-92 T16). The live-play screen is
// mounted directly by the router, so — unlike the character surface, which
// CampaignPage feeds a `campaign` prop — it must resolve its OWN identity signals:
//   • the viewer's DB id + display name (`getMe`) — the id is the reconcile key the
//     `player_message` echo carries; the name is the optimistic own-message label.
//   • whether the viewer OWNS this campaign (`creator === null` on the hub payload,
//     mirroring MYT-90's surface) — the start flow threads it into the 402
//     purchase-moment (owner → buy CTA, member → "host is out of credits").
//   • the party roster (userId → displayName) — SessionView presence carries
//     userIds only, so typing names resolve through this map at the shell.
//
// The identity read is the SAME `getMyCampaigns` payload the hub renders, found by
// id. A campaign the viewer can't see (not in `/mine`) resolves to `error` — you
// can't play a session you're not a member of. Any transient fetch failure settles
// to `error` too (a calm retry); a late resolve after unmount is a no-op.

export interface PlayViewer {
  /** The viewer's DB user id — the `player_message` echo reconcile key. */
  readonly userId: string
  /** The viewer's display name — the optimistic own-message label. */
  readonly displayName: string
  /** Whether the viewer created this campaign (`creator === null`). */
  readonly isOwner: boolean
  /** The party roster (userId → displayName) — resolves presence typing names. */
  readonly party: ReadonlyMap<string, string>
}

export type PlayViewerState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly viewer: PlayViewer }

/** The viewer identity read — id + display name. Structural so the default `getMe`
 *  slots in without importing the full `MeResponse`. */
export type FetchMe = (
  ctx: ApiContext,
) => Promise<{ readonly user: { readonly id: string; readonly displayName: string } }>
/** The hub-payload read — the campaigns the viewer can see (identity + role + roster). */
export type FetchCampaigns = (ctx: ApiContext) => Promise<readonly CampaignSummary[]>

export const defaultFetchMe: FetchMe = (ctx) => getMe(undefined, ctx)
export const defaultFetchCampaigns: FetchCampaigns = (ctx) =>
  getMyCampaigns(undefined, ctx).then((r) => r.campaigns)

/** Load the viewer id + display name + ownership + party roster for the campaign. A
 *  `reloadKey` bump re-fetches (the viewer-error retry). */
export function usePlayViewer(
  campaignId: string,
  ctx: ApiContext,
  reloadKey: number,
  fetchMe: FetchMe,
  fetchCampaigns: FetchCampaigns,
): PlayViewerState {
  const [state, setState] = useState<PlayViewerState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void Promise.all([fetchMe(ctx), fetchCampaigns(ctx)])
      .then(([me, campaigns]) => {
        if (!active) return
        const campaign = campaigns.find((c) => c.id === campaignId) ?? null
        if (campaign === null) {
          setState({ status: 'error' })
          return
        }
        setState({ status: 'ready', viewer: toViewer(me, campaign) })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, reloadKey, fetchMe, fetchCampaigns])
  return state
}

/** Fold the two reads into the viewer signals. */
function toViewer(
  me: { user: { id: string; displayName: string } },
  campaign: CampaignSummary,
): PlayViewer {
  return {
    userId: me.user.id,
    displayName: me.user.displayName,
    isOwner: campaign.creator === null,
    party: new Map(campaign.party.map((m) => [m.userId, m.displayName])),
  }
}
