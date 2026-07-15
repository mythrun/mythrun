import { describe, it, expect, expectTypeOf } from 'vitest'
import type { TranscriptItem as SourceTranscriptItem } from '../../../session/transcript-types.ts'
import type { EntityIndex } from '../../../session/entity-index.ts'
import type { EntityHighlightLabels } from '../dm-message-props.ts'
import * as sessionBarrel from '../index.ts'
import type {
  // Re-exported view-model shape (from session/transcript-types.ts)
  TranscriptItem,
  // Prop contracts — one per @mythrun/ui play component
  MessageStreamProps,
  DmMessageProps,
  PlayerMessageProps,
  SessionInputProps,
  ThinkingIndicatorProps,
  SessionStartBeatProps,
} from '../index.ts'

// Type-level contract for the MYT-92 live-play surface. The runtime barrel stays
// value-free (asserted below + by contract.test.ts); here we PIN the exact prop
// SHAPES so the six @mythrun/ui play components (Tasks 9–14) and the native impl all
// satisfy one DOM-free surface. Callbacks are plain functions (§9) — never DOM events.
//
// Register pins under test (spec §2): PlayerMessage carries NO avatar/bubble props;
// ThinkingIndicator's CLEAR conditions are hook-side (not props) — it renders the
// current booleans/names only; SessionStartBeat is ONE beat with two labeled phases.
describe('session contract barrel', () => {
  it('is importable and exports types only (no runtime values)', () => {
    expect(Object.keys(sessionBarrel)).toHaveLength(0)
  })
})

describe('re-exported view-model shape', () => {
  it('TranscriptItem is re-exported unchanged from the session/ view-model layer', () => {
    // MessageStream reads its row model off THIS contract surface, not a second
    // import — mirroring how character/index.ts re-exports LoadingBeat.
    expectTypeOf<TranscriptItem>().toEqualTypeOf<SourceTranscriptItem>()
  })
})

describe('prop contracts (exact — the U tasks build to these)', () => {
  it('MessageStreamProps — transcript items + connection line + reduced-motion + MYT-94 highlight seam', () => {
    // EXACT-shape pin (do NOT weaken to toMatchTypeOf). MYT-94 (Task 11) appends the
    // three append-only optional highlight-seam fields below.
    //
    // ── CONTROLLER EXTENSION SPOT (wave-2 reconcile) ──────────────────────────────
    // This worktree branched from main BEFORE MYT-93 merged, so the base shape here is
    // MYT-92's 3 fields (items/connectionLine/reducedMotion) — NOT the "MYT-93 7 reveal
    // fields" the bead note describes (they are not present in this worktree). At the
    // MYT-93 + MYT-94 merge, UNION MYT-93's reveal fields into this same exact-shape
    // literal alongside MYT-94's `highlight?/onEntityOpen?/highlightLabels?`.
    expectTypeOf<MessageStreamProps>().toEqualTypeOf<{
      items: readonly TranscriptItem[]
      connectionLine: string | null
      reducedMotion: boolean
      highlight?: EntityIndex
      onEntityOpen?: (entityId: string) => void
      highlightLabels?: EntityHighlightLabels
    }>()
  })

  it('DmMessageProps — serif streaming prose; writingLabel SR annotation; MYT-94 highlight seam', () => {
    expectTypeOf<DmMessageProps>().toEqualTypeOf<{
      text: string
      streaming: boolean
      writingLabel?: string
      // MYT-94 (Task 11) — append-only settled-prose highlight seam.
      highlight?: EntityIndex
      onEntityOpen?: (entityId: string) => void
      highlightLabels?: EntityHighlightLabels
    }>()
  })

  it('PlayerMessageProps — name + text + pending; NO avatar/bubble props', () => {
    expectTypeOf<PlayerMessageProps>().toEqualTypeOf<{
      displayName: string
      characterName: string
      text: string
      pending: boolean
    }>()
  })

  it('SessionInputProps — controlled composer with a Send + an @DM summon intent', () => {
    expectTypeOf<SessionInputProps>().toEqualTypeOf<{
      value: string
      onChange: (v: string) => void
      onSend: () => void
      onSummonDm: () => void
      disabled: boolean
      placeholder: string
      summonLabel: string
      sendLabel: string
    }>()
  })

  it('ThinkingIndicatorProps — purely presentational booleans/names (clear is hook-side)', () => {
    expectTypeOf<ThinkingIndicatorProps>().toEqualTypeOf<{
      thinking: boolean
      typingNames: readonly string[]
      thinkingLabel: string
      typingLabel: string
    }>()
  })

  it('SessionStartBeatProps — ONE beat, two labeled phases (prep | connecting)', () => {
    expectTypeOf<SessionStartBeatProps>().toEqualTypeOf<{
      phase: 'prep' | 'connecting'
      reducedMotion: boolean
      prepLabel: string
      connectingLabel: string
    }>()
  })
})
