import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerFrame } from '@mythrun/contract/events'
import type { ApiContext } from '../api/endpoint.ts'
import { createWsSessionClient, useConnectionState } from '../realtime/index.ts'
import type { WsSessionClient } from '../realtime/ws-session-client.ts'
import type { ConnectionState } from '../realtime/connection.ts'
import type { TranscriptItem } from './transcript-types.ts'
import { emptyTranscript } from './transcript-types.ts'
import { addPending, reduceFrameReconciling, unconfirmedPending } from './optimistic.ts'

// useSession (MYT-92 A6): the play view-model over the shipped WS transport
// (realtime/ws-session-client.ts, MYT-85). The transport is a dumb typed pipe with
// production-grade reconnection; this hook is the flow reducer layered over it. It:
//
//   1. Connects on mount with `seedLastSeq: 0` — a full-history replay (spec §2
//      Backlog): the owner's first connect AND the 409-join / mid-session joiner
//      all rebuild the whole transcript from the `session_reconnect` backlog.
//   2. Folds every inbound frame through `reduceFrameReconciling` (Task 5) — the
//      transcript reducer with own-echo reconciliation + turnId whole-turn replace.
//   3. Owns the OUT-OF-BAND control/presence state the reducer deliberately ignores
//      (`foldOutOfBand`): the thinking indicator (opened by `dm_thinking`, cleared
//      by the first `text_delta`/`turn_end`/`turn_error` for that turn — a stuck
//      indicator must NOT survive a reconnect, so `session_reconnect` resets it),
//      the typing set, and the `ended` flag (`session_end`).
//   4. Sends own messages optimistically (`addPending` + `send`); a `send` that
//      returns `false` (socket not OPEN) leaves the item pending. On a reconnect
//      (`reconnecting` → `connected`), AFTER the replay batch settles, every
//      still-`unconfirmedPending` message is resent: the replay confirms the ones
//      that landed, the rest are re-sent. The accepted residual (a landed message
//      outside the filtered replay window duplicating) is documented in optimistic.ts.
//   5. `summonDm` is an own message whose text already carries the `@dm` token (the
//      explicit-text path — the table SEES the summon; the invisible `dm_invoke`
//      frame is NOT used). `endSession` sends the bare `end_session` summon.
//
// Enforced ignorance holds by construction: the hook only ever renders frames the
// transport hands it; it adds no frame type and no read surface.

/** The out-of-band control/presence state the transcript reducer ignores. */
export interface SessionPresence {
  /** The turnId of the open "DM is thinking" indicator, or null when none is open. */
  readonly thinkingTurnId: string | null
  /** The users currently typing (`typing_start` minus `typing_stop`). */
  readonly typingUserIds: readonly string[]
  /** True once a `session_end` frame has arrived. */
  readonly ended: boolean
}

export const emptyPresence: SessionPresence = {
  thinkingTurnId: null,
  typingUserIds: [],
  ended: false,
}

/** Fold ONE frame into the out-of-band presence state. Pure (no React) so it
 *  unit-tests directly. The transcript-content frames all fall through the default
 *  arm (the reducer owns them); only the control/presence frames move state here. */
export function foldOutOfBand(state: SessionPresence, frame: ServerFrame): SessionPresence {
  switch (frame.type) {
    case 'dm_thinking':
      return { ...state, thinkingTurnId: frame.turnId }
    case 'text_delta':
    case 'turn_end':
    case 'turn_error':
      // The first live signal for the thinking turn clears the indicator.
      return state.thinkingTurnId === frame.turnId ? { ...state, thinkingTurnId: null } : state
    case 'typing_start':
      return state.typingUserIds.includes(frame.userId)
        ? state
        : { ...state, typingUserIds: [...state.typingUserIds, frame.userId] }
    case 'typing_stop':
      return { ...state, typingUserIds: state.typingUserIds.filter((id) => id !== frame.userId) }
    case 'session_end':
      return { ...state, ended: true }
    case 'session_reconnect':
      // A stuck indicator must not survive a reconnect (spec §2): reset it. A turn
      // genuinely still running re-arms it with a fresh live `dm_thinking`. The
      // batch carries no presence frames (they are not persisted), so there is
      // nothing else to fold here.
      return state.thinkingTurnId === null ? state : { ...state, thinkingTurnId: null }
    default:
      return state
  }
}

/** The play view-model the screen renders against. `connection` is the raw
 *  transport state (the route renders `reconnecting`/`failed` as a quiet system
 *  line); `thinking`/`typingUserIds`/`ended` are the out-of-band presence bits. */
export interface SessionView {
  readonly items: readonly TranscriptItem[]
  readonly connection: ConnectionState
  readonly thinking: boolean
  readonly typingUserIds: readonly string[]
  readonly ended: boolean
  /** Optimistically add the message, then send it (a failed send stays pending). */
  sendMessage(text: string): void
  /** Send an `@dm`-token-bearing message (the SessionInput composes the token). */
  summonDm(text: string): void
  /** End the live session (the bare `end_session` summon). */
  endSession(): void
}

/** The viewer identity + target the hook connects for. `viewerUserId` is the DB id
 *  the server stamps on this player's `player_message` echoes (the reconcile key). */
export interface SessionParams {
  readonly sessionId: string
  readonly viewerUserId: string
  readonly displayName: string
  readonly characterName: string
}

/** Injected transport — defaults to the real WS session client; tests substitute a
 *  hand-driven client. */
export interface SessionDeps {
  readonly createClient?: (ctx: ApiContext) => WsSessionClient
}

/** A mounted flag as a ref, so a late frame from a leaky transport never setStates
 *  after teardown. */
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

export function useSession(ctx: ApiContext, params: SessionParams, deps: SessionDeps = {}): SessionView {
  const { sessionId, viewerUserId, displayName, characterName } = params
  // One client per mount (createWsSessionClient opens NO socket — connect() does).
  const [client] = useState<WsSessionClient>(() => (deps.createClient ?? createWsSessionClient)(ctx))
  const connection = useConnectionState(client)

  const [transcript, setTranscript] = useState(emptyTranscript)
  const [presence, setPresence] = useState(emptyPresence)

  const mountedRef = useMountedRef()
  // The transcript's authoritative copy for SYNCHRONOUS reads between frames — a
  // frame handler and `sendMessage` both fold onto the latest, not a render-stale
  // snapshot. `setTranscript` mirrors it to trigger the re-render.
  const stateRef = useRef(transcript)
  const resendArmedRef = useRef(false)
  const prevStatusRef = useRef(connection.status)
  const localIdRef = useRef(0)

  const commit = useCallback((next: typeof transcript) => {
    stateRef.current = next
    setTranscript(next)
  }, [])

  const sendMessage = useCallback(
    (text: string) => {
      localIdRef.current += 1
      const localId = `local:${String(localIdRef.current)}`
      commit(addPending(stateRef.current, { localId, text, viewerUserId, displayName, characterName }))
      client.send({ type: 'player_message', text })
    },
    [client, commit, viewerUserId, displayName, characterName],
  )

  const endSession = useCallback(() => {
    client.send({ type: 'end_session' })
  }, [client])

  // Connect + subscribe inbound frames; tear the socket down on unmount.
  useEffect(() => {
    function handleFrame(frame: ServerFrame): void {
      if (!mountedRef.current) return
      const next = reduceFrameReconciling(stateRef.current, frame, viewerUserId)
      commit(next)
      setPresence((prev) => foldOutOfBand(prev, frame))
      // Reconnect confirm-or-resend: after the replay batch settles, resend every
      // message the batch did not confirm (the still-pending own items).
      if (frame.type === 'session_reconnect' && resendArmedRef.current) {
        resendArmedRef.current = false
        for (const p of unconfirmedPending(next, viewerUserId)) {
          client.send({ type: 'player_message', text: p.text })
        }
      }
    }
    const offFrame = client.onFrame(handleFrame)
    // eslint-disable-next-line mythrun/no-raw-db-access -- client.connect() opens the WebSocket session; the rule pattern-matches the `.connect()` method name (a Postgres pool heuristic), a false-fire on the transport client.
    client.connect(sessionId, { seedLastSeq: 0 })
    return () => {
      offFrame()
      client.close()
    }
  }, [client, sessionId, viewerUserId, commit, mountedRef])

  // Arm the pending-resend on a reconnecting → connected transition; the next
  // `session_reconnect` fold fires it (so the replay can confirm first).
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = connection.status
    if (prev === 'reconnecting' && connection.status === 'connected') {
      resendArmedRef.current = true
    }
  }, [connection.status])

  return {
    items: transcript.items,
    connection,
    thinking: presence.thinkingTurnId !== null,
    typingUserIds: presence.typingUserIds,
    ended: presence.ended,
    sendMessage,
    summonDm: sendMessage,
    endSession,
  }
}
