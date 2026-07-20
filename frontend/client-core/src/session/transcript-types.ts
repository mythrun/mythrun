// Transcript item types for the live-play view-model (MYT-92, spec §2).
//
// A `TranscriptItem` is one rendered row of the play transcript. The transcript
// reducer (`transcript-reducer.ts`) owns TRANSCRIPT CONTENT only — it folds the
// content-bearing server frames into this ordered list; out-of-band control /
// presence frames are the `useSession` hook's concern, not the reducer's.
//
// Design pin (the wave-2 shared contract, spec §7): EVERY mechanical frame
// (`skill_check` / `dice_roll` / `ledger_update` / `mode_change` / `combat_started`
// / `combat_resolved`) is a FIRST-CLASS item that carries the whole frame, even
// though MYT-92 renders each as a terse mono system line. MYT-93/94 extend the
// RENDERING (MessageStream's item dispatch), never this shape — so the reducer is
// wave-2-final and the two wave-2 issues only touch presentation.
//
// `turnId` (where present) is the whole-turn-replace unit the reducer keys on when
// a `session_reconnect` replay rebuilds a turn the client saw live.

import type { ServerFrame } from '@mythrun/contract/events'

/** A frame narrowed to its `type` — the mechanical items carry the whole frame so
 *  MYT-93/94 extend RENDERING (MessageStream's dispatch) without touching this. */
type FrameOf<T extends ServerFrame['type']> = Extract<ServerFrame, { type: T }>

/** A rendered transcript row. `key` is a stable, reducer-minted React key; `turnId`
 *  (where present) is the whole-turn-replace unit. Every mechanical frame is a
 *  first-class item even though MYT-92 renders each as a terse mono system line. */
export type TranscriptItem =
  | { kind: 'dm'; key: string; turnId: string; text: string; streaming: boolean }
  | {
      kind: 'player'
      key: string
      turnId: null
      seq: number | null
      userId: string
      displayName: string
      characterName: string
      text: string
      pending: boolean
    }
  | { kind: 'skill_check'; key: string; turnId: string; frame: FrameOf<'skill_check'> }
  | { kind: 'dice_roll'; key: string; turnId: string; frame: FrameOf<'dice_roll'> }
  | { kind: 'ledger_update'; key: string; turnId: string; frame: FrameOf<'ledger_update'> }
  | { kind: 'mode_change'; key: string; turnId: string | null; frame: FrameOf<'mode_change'> }
  | { kind: 'combat_started'; key: string; turnId: string; frame: FrameOf<'combat_started'> }
  | { kind: 'combat_resolved'; key: string; turnId: string; frame: FrameOf<'combat_resolved'> }
  // A DM CORRECTION (myth-d6knq) — the DM amending something previously narrated.
  // Its own content kind (NOT a `dm` row): the transcript renders it as a set-apart
  // errata slip, never as story prose, so a correction can never read as the fiction
  // it corrects (enforced-ignorance-adjacent: the record stays honest and distinct).
  // Carries the correction's OWN emission `turnId` (the turn the FT issued it in, per
  // the backend row model — not the corrected turn's), so it folds through
  // whole-turn-replace exactly like the mechanical/dm rows. `text` is DM DATA.
  | { kind: 'dm_correction'; key: string; turnId: string; text: string }

export interface TranscriptState {
  readonly items: readonly TranscriptItem[]
  readonly seqSeen: ReadonlySet<number>
  readonly nextId: number
}

export const emptyTranscript: TranscriptState = {
  items: [],
  seqSeen: new Set<number>(),
  nextId: 0,
}
