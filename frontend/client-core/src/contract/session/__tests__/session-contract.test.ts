import { describe, it, expect, expectTypeOf } from 'vitest'
import type { TranscriptItem as SourceTranscriptItem } from '../../../session/transcript-types.ts'
import type { EntityIndex } from '../../../session/entity-index.ts'
import type { EntityHighlightLabels } from '../dm-message-props.ts'
import type {
  // MYT-93 reveal view-model shapes (from session/roll-reveal.ts) — re-exported
  // by THIS barrel (type-only), same pattern as TranscriptItem above.
  RollPhase as SourceRollPhase,
  RollRevealView as SourceRollRevealView,
  CardItem as SourceCardItem,
} from '../../../session/roll-reveal.ts'
import * as sessionBarrel from '../index.ts'
import type {
  // Re-exported view-model shape (from session/transcript-types.ts)
  TranscriptItem,
  // Re-exported reveal shapes (from session/roll-reveal.ts — MYT-93)
  RollPhase,
  RollRevealView,
  CardItem,
  // Prop contracts — one per @mythrun/ui play component
  MessageStreamProps,
  DmMessageProps,
  PlayerMessageProps,
  SessionInputProps,
  ThinkingIndicatorProps,
  SessionStartBeatProps,
  // MYT-93 dice-moment prop contracts (RollCard / DieSpin)
  RollCardProps,
  RollCardLabels,
  DieSpinProps,
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

  it('RollPhase / RollRevealView / CardItem re-export the roll-reveal shapes unchanged (MYT-93)', () => {
    // Type-only re-exports of the reveal view-model — RollCard/DieSpin read their
    // phase + card model off THIS contract surface; the runtime reducer stays out
    // of the barrel (same split as TranscriptItem vs. emptyTranscript).
    expectTypeOf<RollPhase>().toEqualTypeOf<SourceRollPhase>()
    expectTypeOf<RollRevealView>().toEqualTypeOf<SourceRollRevealView>()
    expectTypeOf<CardItem>().toEqualTypeOf<SourceCardItem>()
  })
})

describe('prop contracts (exact — the U tasks build to these)', () => {
  it('MessageStreamProps — transcript items + reveal seam (MYT-93) + highlight seam (MYT-94) + correction eyebrow (myth-d6knq)', () => {
    // EXACT-shape pin (do NOT weaken to toMatchTypeOf). MYT-93 appended the four
    // required reveal-seam fields; MYT-94 appended the three optional highlight-seam
    // fields; myth-d6knq appended the optional `correctionLabel` errata eyebrow. The
    // extensions union on distinct names — this literal is the union.
    expectTypeOf<MessageStreamProps>().toEqualTypeOf<{
      items: readonly TranscriptItem[]
      connectionLine: string | null
      reducedMotion: boolean
      rollReveal: RollRevealView
      rollLabels: RollCardLabels
      onRoll: (key: string) => void
      onContinue: (key: string) => void
      highlight?: EntityIndex
      onEntityOpen?: (entityId: string) => void
      highlightLabels?: EntityHighlightLabels
      correctionLabel?: string
    }>()
  })

  it('RollCardProps — one card item + its derived phase + resolved labels + neutral callbacks', () => {
    expectTypeOf<RollCardProps>().toEqualTypeOf<{
      item: CardItem
      phase: RollPhase
      reducedMotion: boolean
      labels: RollCardLabels
      onRoll: () => void
      onContinue: () => void
    }>()
  })

  it('RollCardLabels — the resolved [ph:] bundle the route threads to each card', () => {
    expectTypeOf<RollCardLabels>().toEqualTypeOf<{
      readonly roll: string
      readonly continue: string
      readonly tier: Readonly<Record<'fail' | 'success' | 'great_success', string>>
      readonly dc: string
      readonly advantage: string
      readonly disadvantage: string
      readonly dieResult: string
    }>()
  })

  it('DieSpinProps — spinning + result + reduced-motion; onSpinComplete + optional SR label', () => {
    expectTypeOf<DieSpinProps>().toEqualTypeOf<{
      spinning: boolean
      result: number | null
      reducedMotion: boolean
      onSpinComplete: () => void
      resultLabel?: string
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
      maxLength?: number
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
