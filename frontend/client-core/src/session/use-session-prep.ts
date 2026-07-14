import { useEffect, useRef, useState } from 'react'
import type { PipelineEvent } from '@mythrun/contract/events'
import type { ApiContext } from '../api/endpoint.ts'
import { createSseStatusClient, type SseStatusClient } from '../realtime/sse-status-client.ts'

// useSessionPrep (MYT-92 A3): the DOM-free data layer behind the session-prep
// atmospheric wait (spec §2). The play route subscribes this on the `prep_not_ready`
// arm (or on entering play before any session exists) and offers Start once
// `status === 'ready'`. It:
//
//   1. Opens the prep-status SSE (`createSseStatusClient`) — the campaign-scoped
//      prep channel, distinct from the world-gen status stream.
//   2. Seeds `status` from the connect-time `event: snapshot` first frame
//      (`{ status: 'ready' | 'generating' }`), then advances it on the live prep-*
//      events: `prep-started` → generating, `prep-ready` → ready,
//      `prep-failed{terminal}` → failed (carrying the BullMQ terminal flag the
//      route uses to decide retry-vs-dead-end).
//   3. Closes the SSE on unmount; a mounted ref guards a late frame from a leaky
//      transport so it never setStates after teardown.
//
// Enforced ignorance holds by construction: the prep-status channel's allowlist
// tripwire (PIPELINE_SSE_EVENTS) drops any prose `prep-delta`, so only these
// player-safe status frames ever reach here.
//
// SCOPE: a reconnect re-snapshots the current prep bit (the prep row's existence is
// the snapshot's only signal), so a `prep-failed` seen live can be re-shown as
// `generating` after a drop. The route owns the terminal beat and unmounts this on
// transition, so a stuck reconnect is not a case this hook models.

/** The coarse prep lifecycle the atmospheric wait renders against. `terminal` is
 *  only ever true alongside `status: 'failed'` (a `prep-failed{terminal:true}` — a
 *  BullMQ dead end a retry won't clear). */
export interface SessionPrepStream {
  readonly status: 'generating' | 'ready' | 'failed'
  readonly terminal: boolean
}

/** Injected transport — defaults to the real SSE status client; tests substitute a
 *  hand-driven client. */
export interface SessionPrepDeps {
  readonly createClient?: (ctx: ApiContext) => SseStatusClient
}

const prepStatusPath = (campaignId: string): string =>
  `/api/campaigns/${encodeURIComponent(campaignId)}/prep-status`

/** Read the coarse prep bit off the connect-time snapshot payload. The frame is our
 *  own backend's `{ status: 'ready' | 'generating' }`, but it arrives as `unknown`,
 *  so anything that isn't an explicit `ready` object falls back to `generating`
 *  (the not-yet-prepared campaign). */
function isReadySnapshot(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && 'status' in raw && raw.status === 'ready'
}

/** Fold one live prep-* event into the next stream state (a later event wins). Any
 *  non-prep event (the channel is prep-scoped, but the union is wide) is ignored. */
function reducePrepEvent(ev: PipelineEvent): SessionPrepStream | null {
  switch (ev.type) {
    case 'prep-started':
      return { status: 'generating', terminal: false }
    case 'prep-ready':
      return { status: 'ready', terminal: false }
    case 'prep-failed':
      return { status: 'failed', terminal: ev.terminal }
    default:
      return null
  }
}

/** A mounted flag as a ref, so a late SSE frame never setStates after teardown. */
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

export function useSessionPrep(
  ctx: ApiContext,
  campaignId: string,
  deps: SessionPrepDeps = {},
): SessionPrepStream {
  const createClient = deps.createClient ?? createSseStatusClient

  const [stream, setStream] = useState<SessionPrepStream>({ status: 'generating', terminal: false })
  const mountedRef = useMountedRef()

  useEffect(() => {
    const client = createClient(ctx)
    const offSnapshot = client.onSnapshot((raw) => {
      if (!mountedRef.current) return
      setStream({ status: isReadySnapshot(raw) ? 'ready' : 'generating', terminal: false })
    })
    const offEvent = client.onEvent((event) => {
      if (!mountedRef.current) return
      const next = reducePrepEvent(event)
      if (next !== null) setStream(next)
    })
    client.open(prepStatusPath(campaignId))
    return () => {
      offSnapshot()
      offEvent()
      client.close()
    }
  }, [ctx, campaignId, createClient, mountedRef])

  return stream
}
