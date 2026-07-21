// The `@mythrun/client-core/character` subpath barrel (MYT-90). The DOM-free
// character-creation BRAIN: the flow state machine, the guided-builder reducer, the
// flatten-to-concept-text fold, and the sheet + party-roster view-models. All the
// LOGIC lives here (platform-independent); the six @mythrun/ui character components
// are pure render, and consume the shapes this produces via `@mythrun/client-core/
// contract`. Rides its own subpath (mirroring `/srd` and `/worldgen`) so the render
// surface can import the brain slice without dragging the whole client into its bundle.

export { flattenToConceptText, canonicalClassName } from './flatten.ts'

export {
  initialGuidedState,
  guidedReducer,
  guidedRail,
  guidedChoice,
} from './guided-reducer.ts'
export type { GuidedState, GuidedAction, GuidedChoiceDraft } from './guided-reducer.ts'

export { createMachine, createTransition } from './create-machine.ts'
export type { CreateState, CreateEvent } from './create-machine.ts'

export { sheetViewModel } from './sheet-view-model.ts'
export type { CharacterSheetSource, SheetAbilityScores, SheetSpell } from './sheet-view-model.ts'

// The RAW getCharacter → reveal view-model adapter (promoted from the character-new
// web route in MYT-94 so the in-session sheet view-model can adapt brain-side, R1).
export { toCharacterSheetSource, toRevealViewModel } from './sheet-adapter.ts'

export { partyRosterViewModel } from './party-roster-view-model.ts'
export type {
  CharacterCreationProgress,
  ProgressConcept,
  ProgressMissing,
} from './party-roster-view-model.ts'

export { useCharacterCreationStream } from './use-character-creation-stream.ts'
export type {
  CharacterCreationStream,
  CharacterCreationStreamDeps,
} from './use-character-creation-stream.ts'
export {
  useCreationProgressPoll,
  creationPollDelay,
  DEFAULT_CREATION_POLL,
} from './use-creation-progress-poll.ts'
export type {
  CreationProgressPoll,
  CreationProgressPollDeps,
  CreationPollConfig,
} from './use-creation-progress-poll.ts'
export { CHARACTER_CREATION_STAGES, remainingCreationWaitMs } from './creation-eta.ts'
export type { CharacterCreationStage } from './creation-eta.ts'
