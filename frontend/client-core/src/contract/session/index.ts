// The MYT-92 play-session contract barrel — the DOM-free prop vocabulary the six
// @mythrun/ui live-play components (MessageStream / DmMessage / PlayerMessage /
// SessionInput / ThinkingIndicator / SessionStartBeat) import their props from (the
// enforced portability seam, R1). Type-only re-exports — the barrel carries no runtime
// values (asserted by contract.test.ts + this dir's barrel test).
//
// TranscriptItem is re-exported from the session/ view-model layer (transcript-types.ts,
// Task 4) so MessageStream reads its row model off THIS contract surface, not a second
// import — mirroring how character/index.ts re-exports LoadingBeat / ClassName. Only the
// TYPE is re-exported; the module's runtime `emptyTranscript` stays out of the barrel.
export type { TranscriptItem } from '../../session/transcript-types.ts'

// MYT-93 reveal view-model shapes (session/roll-reveal.ts) — the dice-moment card
// model + its derived phase + the plain reveal view MessageStream renders against.
// TYPE only; the module's runtime reducer/selectors (rollRevealReducer, buildRevealView,
// useRollReveal) stay OUT of the barrel, mirroring TranscriptItem vs. emptyTranscript.
export type { CardItem, RollPhase, RollRevealView } from '../../session/roll-reveal.ts'

// Prop contracts — one per @mythrun/ui play component (Tasks 9–14).
export type { MessageStreamProps } from './message-stream-props.ts'
export type { DmMessageProps } from './dm-message-props.ts'
// myth-d6knq — the DM correction (errata) row prop contract.
export type { DmCorrectionProps } from './dm-correction-props.ts'
export type { PlayerMessageProps } from './player-message-props.ts'
export type { SessionInputProps } from './session-input-props.ts'
export type { ThinkingIndicatorProps } from './thinking-indicator-props.ts'
export type { SessionStartBeatProps } from './session-start-beat-props.ts'
// myth-ep74g — the between-sessions preparing hold prop contract.
export type { SessionPreparingProps } from './session-preparing-props.ts'

// MYT-93 dice-moment prop contracts (RollCard / DieSpin — Tasks 4/5). RollCardLabels is
// the resolved [ph:] bundle the play route threads through MessageStream to each card.
export type { RollCardProps, RollCardLabels } from './roll-card.ts'
export type { DieSpinProps } from './die-spin.ts'
