// Optimistic own-message layer over the transcript reducer (MYT-92, spec §2).
//
// The table sees an own message the instant it is typed — before the server's
// seq-stamped echo returns — so the input never feels laggy. `addPending` appends
// a `player` item with `pending:true` / `seq:null`, keyed `pending:<localId>` (a
// stable key so React reuses the same node when the echo confirms it in place,
// with zero remount). `reduceFrameReconciling` wraps `reduceFrame`: an inbound
// own `player_message` reconciles the FIRST matching pending item instead of
// appending a duplicate; every other frame delegates to the raw reducer verbatim.
//
// seqSeen invariant: the raw reducer records every confirmed player item's `seq`
// in `seqSeen` (the dedup ledger). Reconciliation confirms an item OUTSIDE the raw
// `appendPlayer` path, so it must record the seq here too — otherwise a redelivered
// echo of that seq would slip past the dedup and double-render.
//
// RESIDUAL RISK (accepted, documented per spec §2): the wire protocol carries NO
// client message id, so reconciliation matches on `(viewerUserId, text)` in FIFO
// order. On reconnect, a pending message absent from the replay is RESENT (Task 6);
// if the original actually landed but fell outside the transport's filtered replay
// window, the resend duplicates. Adding a client message id is out of MYT-92 scope
// — this residual is accepted and documented here.

import type { ServerFrame } from '@mythrun/contract/events'
import type { TranscriptItem, TranscriptState } from './transcript-types.ts'
import { applyReconnect, reduceFrame } from './transcript-reducer.ts'

type FrameOf<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>
type PlayerItem = Extract<TranscriptItem, { kind: 'player' }>

/** The `pending:` key prefix — `localId` is recovered by stripping it. */
const PENDING_KEY_PREFIX = 'pending:'

/** The optimistic-add input: the caller mints `localId`; identity is the viewer's. */
export interface PendingInput {
  localId: string
  text: string
  viewerUserId: string
  displayName: string
  characterName: string
}

/** Append an optimistic own `player` item (`pending:true`, `seq:null`). */
export function addPending(state: TranscriptState, input: PendingInput): TranscriptState {
  const item: PlayerItem = {
    kind: 'player',
    key: PENDING_KEY_PREFIX + input.localId,
    turnId: null,
    seq: null,
    userId: input.viewerUserId,
    displayName: input.displayName,
    characterName: input.characterName,
    text: input.text,
    pending: true,
  }
  return { ...state, items: [...state.items, item] }
}

/** Confirm a pending item from its server echo: settle it + adopt the frame's
 *  server-authoritative seq / identity (key + text preserved). */
function confirmPending(item: PlayerItem, frame: FrameOf<'player_message'>): PlayerItem {
  return { ...item, pending: false, seq: frame.seq, displayName: frame.displayName, characterName: frame.characterName }
}

/** Reconcile an own echo against the FIRST matching pending item, or — if none
 *  matches — delegate to the raw reducer (append + seqSeen dedup). */
function reconcileOwnEcho(state: TranscriptState, frame: FrameOf<'player_message'>): TranscriptState {
  const target = state.items.find(
    (it): it is PlayerItem => it.kind === 'player' && it.pending && it.userId === frame.userId && it.text === frame.text,
  )
  if (target === undefined) return reduceFrame(state, frame)
  const items = state.items.map((it) => (it === target ? confirmPending(target, frame) : it))
  const seqSeen = new Set(state.seqSeen).add(frame.seq)
  return { ...state, items, seqSeen }
}

/** Fold ONE frame, reconciling own player echoes — whether they arrive as a
 *  top-level `player_message` or INSIDE a `session_reconnect` batch. A reconnect
 *  is re-folded through a curried reconciling folder so each own echo confirms a
 *  pending item (which survives the whole-turn-replace prune with turnId null)
 *  rather than appending a duplicate; every other frame is the raw reducer
 *  verbatim. */
export function reduceFrameReconciling(
  state: TranscriptState,
  frame: ServerFrame,
  viewerUserId: string,
): TranscriptState {
  if (frame.type === 'player_message' && frame.userId === viewerUserId) {
    return reconcileOwnEcho(state, frame)
  }
  if (frame.type === 'session_reconnect') {
    return applyReconnect(state, frame, (s, f) => reduceFrameReconciling(s, f, viewerUserId))
  }
  return reduceFrame(state, frame)
}

/** The still-pending own messages (drives Task 6's reconnect confirm-or-resend). */
export function unconfirmedPending(state: TranscriptState, viewerUserId: string): { localId: string; text: string }[] {
  const out: { localId: string; text: string }[] = []
  for (const it of state.items) {
    if (it.kind === 'player' && it.pending && it.userId === viewerUserId) {
      out.push({ localId: it.key.slice(PENDING_KEY_PREFIX.length), text: it.text })
    }
  }
  return out
}
