// The per-frame transcript reducer (MYT-92, spec §2 — the keystone).
//
// `reduceFrame(state, frame)` folds ONE server frame into the ordered transcript.
// It is pure (no React, no side effects) so it unit-tests directly and the
// `useSession` hook (Task 6) simply drives it over the transport's frame stream.
//
// Boundary pin — the reducer owns TRANSCRIPT CONTENT only. Out-of-band control /
// presence frames (`session_ready`, `dm_thinking`, `typing_start`/`typing_stop`,
// `player_joined`, `player_left`, `error`, `session_end`) are IGNORED here (they
// fall through to the default arm returning state unchanged); `useSession` owns
// them (thinking/typing indicators, connection lines, the `ended` flag). This
// keeps the reducer's shape stable so MYT-93/94 extend RENDERING only (spec §7).
//
// Whole-turn replace (spec §2, the reconnect-safety invariant): the transport has
// already discarded the register-before-replay overlap (`seq <= lastSeen`) from a
// `session_reconnect` batch. For every turnId the batch carries, this reducer
// REMOVES existing DM/mechanical items with that turnId — they may be the partial
// in-flight turn OR a fully-live-rendered turn inside the replay window; either way
// they must not double-render — then re-folds each batch message so the seq-bearing
// replay rebuilds them settled. A turnId of '' (a turn-less combat/mode frame) is
// NOT a turn key (mirrors the transport's `t !== ''` guard), and player items
// (turnId null) are never pruned — they dedup on seq instead.
//
// Accepted residual (annotated per spec §2): across a MULTI-turn reconnect window
// the re-folded turns append at the tail rather than perfectly interleaving by seq.
// This is acceptable for MYT-92 — the dominant paths (a first-join backlog, and a
// single in-flight-turn reconnect) are exact; richer interleaving is not in scope.

import type { ServerFrame } from '@mythrun/contract/events'
import type { TranscriptItem, TranscriptState } from './transcript-types.ts'

type FrameOf<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>
type MechanicalFrame = FrameOf<
  'skill_check' | 'dice_roll' | 'ledger_update' | 'mode_change' | 'combat_started' | 'combat_resolved'
>

/** The per-frame folder a `session_reconnect` batch is re-folded through.
 *  `reduceFrame` passes itself (unchanged semantics); the optimistic layer injects
 *  a reconciling folder so an own echo INSIDE the batch confirms a pending item
 *  instead of appending a duplicate (MYT-92 Task 5). It is a distinct SEAM (an
 *  exported `applyReconnect` folder arg) rather than an optional 3rd param on
 *  `reduceFrame`, so `reduceFrame` stays a bare 2-arg `Array.reduce` callback. */
type FrameFolder = (state: TranscriptState, frame: ServerFrame) => TranscriptState

/** Append one item, minting a stable monotonic React key from `nextId`. */
function appendItem(state: TranscriptState, make: (key: string) => TranscriptItem): TranscriptState {
  const key = `item:${String(state.nextId)}`
  return { ...state, items: [...state.items, make(key)], nextId: state.nextId + 1 }
}

/** DM prose: append text to the OPEN streaming `dm` run at the tail, or open a new
 *  segment. A text_delta always continues the currently-open narration — the tail.
 *  When the tail is this turn's streaming dm item we append in place; otherwise
 *  (the first delta, or — the myth-uhr0f case — a mid-turn tool frame like a
 *  skill_check roll or a take_rest CLOSED the prior run) we OPEN A NEW segment.
 *  This mirrors the persisted transcript, where the FT emits each text part between
 *  tool calls as its own dm_text row (§3.7 codec) that replays as its own settled
 *  dm item — so a roll/rest that interrupts narration never fuses the teaser's
 *  "...more than once." onto the continuation's "Hast writes..." ("once.Hast"). The
 *  gate + settle operate per-turn, so the two segments still reveal and settle
 *  together; only the joining seam changes. */
function applyDelta(state: TranscriptState, frame: FrameOf<'text_delta'>): TranscriptState {
  const tail = state.items[state.items.length - 1]
  const openRun =
    tail?.kind === 'dm' && tail.turnId === frame.turnId && tail.streaming ? tail : undefined
  if (openRun === undefined) {
    return appendItem(state, (key) => ({ kind: 'dm', key, turnId: frame.turnId, text: frame.text, streaming: true }))
  }
  const items = state.items.map((it) => (it === openRun ? { ...openRun, text: openRun.text + frame.text } : it))
  return { ...state, items }
}

/** `turn_end` / `turn_error`: settle this turn's `dm` item (`streaming:false`). */
function settleTurn(state: TranscriptState, turnId: string): TranscriptState {
  const items = state.items.map((it) => (it.kind === 'dm' && it.turnId === turnId ? { ...it, streaming: false } : it))
  return { ...state, items }
}

/** Replay-only consolidated DM prose row → a settled `dm` item. */
function appendDm(state: TranscriptState, frame: FrameOf<'dm_message'>): TranscriptState {
  return appendItem(state, (key) => ({ kind: 'dm', key, turnId: frame.turnId, text: frame.text, streaming: false }))
}

/** A DM correction (myth-d6knq) → a set-apart `dm_correction` item. Distinct from
 *  `dm` so MessageStream renders it as an errata slip, never as narration. Appends
 *  at its arrival/seq position (live: current tail; replay: seq order) — the DM
 *  issued the amendment there, so that is where the record shows it. */
function appendCorrection(state: TranscriptState, frame: FrameOf<'dm_correction'>): TranscriptState {
  return appendItem(state, (key) => ({ kind: 'dm_correction', key, turnId: frame.turnId, text: frame.text }))
}

/** Wrap a mechanical frame in its matching first-class item kind. */
function buildMechanical(frame: MechanicalFrame, key: string): TranscriptItem {
  switch (frame.type) {
    case 'skill_check':
      return { kind: 'skill_check', key, turnId: frame.turnId, frame }
    case 'dice_roll':
      return { kind: 'dice_roll', key, turnId: frame.turnId, frame }
    case 'ledger_update':
      return { kind: 'ledger_update', key, turnId: frame.turnId, frame }
    case 'mode_change':
      return { kind: 'mode_change', key, turnId: frame.turnId ?? null, frame }
    case 'combat_started':
      return { kind: 'combat_started', key, turnId: frame.turnId, frame }
    case 'combat_resolved':
      return { kind: 'combat_resolved', key, turnId: frame.turnId, frame }
  }
}

function appendMechanical(state: TranscriptState, frame: MechanicalFrame): TranscriptState {
  return appendItem(state, (key) => buildMechanical(frame, key))
}

/** Confirmed player message: dedup on `seq`, else append a confirmed `player` item. */
function appendPlayer(state: TranscriptState, frame: FrameOf<'player_message'>): TranscriptState {
  if (state.seqSeen.has(frame.seq)) return state
  const seqSeen = new Set(state.seqSeen).add(frame.seq)
  const withItem = appendItem(state, (key) => ({
    kind: 'player', key, turnId: null, seq: frame.seq,
    userId: frame.userId, displayName: frame.displayName, characterName: frame.characterName,
    text: frame.text, pending: false,
  }))
  return { ...withItem, seqSeen }
}

/** A frame's `turnId`, or undefined for a turn-less frame (assertion-free via `in`). */
function frameTurnId(frame: ServerFrame): string | undefined {
  return 'turnId' in frame ? frame.turnId : undefined
}

/** The non-empty turnIds a reconnect batch carries — the whole-turn-replace keys. */
function collectBatchTurnIds(messages: readonly ServerFrame[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    const t = frameTurnId(m)
    if (t !== undefined && t !== '') ids.add(t)
  }
  return ids
}

/** Whole-turn replace: prune items whose turnId the batch rebuilds, then re-fold
 *  each batch message through `foldFrame`. Pending own items (turnId null) survive
 *  the prune, so a reconciling `foldFrame` confirms them from their in-batch echo.
 *  Exported as the reconnect-fold SEAM: `reduceFrame` calls it with `reduceFrame`
 *  (raw semantics); the optimistic layer calls it with `reduceFrameReconciling`. */
export function applyReconnect(
  state: TranscriptState,
  frame: FrameOf<'session_reconnect'>,
  foldFrame: FrameFolder,
): TranscriptState {
  const ids = collectBatchTurnIds(frame.messages)
  const items = state.items.filter((it) => it.turnId === null || !ids.has(it.turnId))
  let next: TranscriptState = { ...state, items }
  for (const m of frame.messages) next = foldFrame(next, m)
  return next
}

/** Fold ONE server frame into the transcript. Out-of-band frames pass through
 *  unchanged (the default arm) — the hook owns them. */
export function reduceFrame(state: TranscriptState, frame: ServerFrame): TranscriptState {
  switch (frame.type) {
    case 'text_delta':
      return applyDelta(state, frame)
    case 'turn_end':
    case 'turn_error':
      return settleTurn(state, frame.turnId)
    case 'dm_message':
      return appendDm(state, frame)
    case 'dm_correction':
      return appendCorrection(state, frame)
    case 'skill_check':
    case 'dice_roll':
    case 'ledger_update':
    case 'mode_change':
    case 'combat_started':
    case 'combat_resolved':
      return appendMechanical(state, frame)
    case 'player_message':
      return appendPlayer(state, frame)
    case 'session_reconnect':
      return applyReconnect(state, frame, reduceFrame)
    default:
      return state
  }
}
