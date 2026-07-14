import { useEffect, useState } from 'react'
import {
  getMe,
  type ApiContext,
  type StartingSituationsResponse,
  type CharacterCreationProgress,
} from '@mythrun/client-core'

// The viewer-signal fetch — the endpoint seams + the fold into routing signals.
// Split out of the character surface so the fetch hook and its seam signatures
// stay one focused unit; the surface + the routed beat consume these.

/** The viewer identity read — only `user.id` is needed (to find the caller's own
 *  concept row). Structural so the default `getMe` slots in without importing the
 *  full `MeResponse` type (not on the client-core barrel). */
export type FetchMe = (ctx: ApiContext) => Promise<{ readonly user: { readonly id: string } }>
export type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>
export type FetchProgress = (ctx: ApiContext, campaignId: string) => Promise<CharacterCreationProgress>
/** Self-scoped mutations — the failure retries. */
export type CampaignMutation = (ctx: ApiContext, campaignId: string) => Promise<unknown>

export const defaultFetchMe: FetchMe = (ctx) => getMe(undefined, ctx)

export interface ViewerSignals {
  readonly situationChosen: boolean
  readonly levelSet: boolean
  readonly conceptStatus: string
  readonly confirmed: boolean
  readonly charId: string | null
  readonly viewerUserId: string
}

export type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly signals: ViewerSignals }

/** Fetch the viewer id + the owner's situation/level progress + the caller's own
 *  concept row, folded into the routing signals. A `reloadKey` bump refetches (the
 *  transition backstop — loading→reveal, confirm→staging, retry). Any failure of
 *  the three settles to `error` (a calm retry); a late resolve after unmount is a
 *  no-op. */
export function useViewerSignals(
  campaignId: string,
  ctx: ApiContext,
  reloadKey: number,
  fetchMe: FetchMe,
  fetchSituations: FetchSituations,
  fetchProgress: FetchProgress,
): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void Promise.all([
      fetchMe(ctx),
      fetchSituations(ctx, campaignId),
      fetchProgress(ctx, campaignId),
    ])
      .then(([me, situations, progress]) => {
        if (!active) return
        const viewerUserId = me.user.id
        const mine = progress.concepts.find((c) => c.userId === viewerUserId) ?? null
        setState({
          status: 'ready',
          signals: {
            situationChosen: situations.chosenIndex !== null,
            levelSet: situations.startingLevel !== null,
            conceptStatus: mine?.status ?? 'none',
            confirmed: mine?.confirmedAt != null,
            charId: mine?.characterId ?? null,
            viewerUserId,
          },
        })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, reloadKey, fetchMe, fetchSituations, fetchProgress])
  return state
}
