import { useCallback, useEffect, useRef, useState } from 'react'
import type { PipelineEvent } from '@mythrun/contract/events'
import type { ApiContext } from '../api/endpoint.ts'
import { getCharacterCreationProgress, type CharacterCreationProgress } from '../api/characters.ts'
import { createSseStatusClient, type SseStatusClient } from '../realtime/sse-status-client.ts'

// useLiveRoster (MYT-91): the DOM-free data layer behind the party-staging roster.
// It replaces the MYT-90 shell's blind 5s poll with the REAL liveness signals — the
// campaign status SSE — so a teammate finishing their character surfaces on the
// owner's roster without a reload. It mirrors use-character-creation-stream's
// connect/teardown + mounted-ref discipline, but folds a DIFFERENT thing: the
// stream is a pure TRIGGER here (the owner refetches the whole roster; the event
// carries no roster data), never a per-user reducer.
//
// Two liveness triggers, both reloading the whole progress fetch:
//   1. ANY `character_creation_complete` (any member) — a teammate's character just
//      landed, so the roster changed. (The owner sees everyone; no per-user filter.)
//   2. Each entry INTO `connected` (the initial connect AND every reconnect) — a
//      drop-and-recover re-syncs the roster in case a completion arrived during the
//      gap. The web foreground-refetch port adds the focus/slow-poll fallback on top.
//
// A live refetch swaps the roster IN PLACE (no loading flash): the surface must
// never blink back to the loading line mid-session on a reconnect or a completion.
// Only the initial mount shows `loading`.

/** Injected seams — default to the real client-core endpoint + SSE transport; tests
 *  substitute a spy fetch + a hand-driven client. */
export interface LiveRosterDeps {
  readonly getProgress?: (ctx: ApiContext, campaignId: string) => Promise<CharacterCreationProgress>
  readonly createClient?: (ctx: ApiContext) => SseStatusClient
}

/** The roster-fetch lifecycle. `ready` carries the latest progress; a live refetch
 *  folds fresh progress in place, and an errored fetch self-heals on the next reload. */
export type ProgressState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly progress: CharacterCreationProgress }

const streamPath = (campaignId: string): string =>
  `/api/campaigns/${encodeURIComponent(campaignId)}/status/stream`

/** A mounted flag as a ref, so a late SSE frame (a leaky transport delivering after
 *  teardown) never fires a reload post-unmount. */
function useMountedRef(): { readonly current: boolean } {
  const ref = useRef(true)
  useEffect(() => {
    ref.current = true
    return () => {
      ref.current = false
    }
  }, [])
  return ref
}

export function useLiveRoster(
  campaignId: string,
  ctx: ApiContext,
  deps: LiveRosterDeps = {},
): { state: ProgressState; reload: () => void } {
  const getProgress = deps.getProgress ?? getCharacterCreationProgress
  const createClient = deps.createClient ?? createSseStatusClient

  const [state, setState] = useState<ProgressState>({ status: 'loading' })
  const [reloadKey, setReloadKey] = useState(0)
  const mountedRef = useMountedRef()

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
  }, [])

  // Fetch on mount + on each reload. No loading-reset on reload: a live refetch
  // swaps the roster IN PLACE. `active` supersedes a stale in-flight fetch so a slow
  // response (or one settling after teardown) can never clobber a newer one.
  useEffect(() => {
    let active = true
    const settle = (next: ProgressState): void => {
      if (active) setState(next)
    }
    getProgress(ctx, campaignId)
      .then((progress) => {
        settle({ status: 'ready', progress })
      })
      .catch(() => {
        settle({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, getProgress, reloadKey])

  // The campaign status SSE. Fold: any `character_creation_complete` → reload; each
  // transition INTO `connected` → reload. Close the stream on unmount.
  useEffect(() => {
    const client = createClient(ctx)
    let lastConnected = false
    const offEvent = client.onEvent((event: PipelineEvent) => {
      if (!mountedRef.current) return
      if (event.type === 'character_creation_complete') reload()
    })
    const unsubscribe = client.connectionState.subscribe((connection) => {
      const nowConnected = connection.status === 'connected'
      if (nowConnected && !lastConnected) reload()
      lastConnected = nowConnected
    })
    client.open(streamPath(campaignId))
    return () => {
      offEvent()
      unsubscribe()
      client.close()
    }
  }, [ctx, campaignId, createClient, reload, mountedRef])

  return { state, reload }
}
