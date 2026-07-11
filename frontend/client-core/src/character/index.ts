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

export { partyRosterViewModel } from './party-roster-view-model.ts'
export type {
  CharacterCreationProgress,
  ProgressConcept,
  ProgressMissing,
} from './party-roster-view-model.ts'
