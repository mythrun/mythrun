// The MYT-90 character-creation contract barrel — the DOM-free prop + shared-type
// vocabulary for the whole character-creation frontend. The six @mythrun/ui character
// components import their props from here (the enforced portability seam), and the B4
// view-model produces objects of the shared shapes. Type-only re-exports (the barrel
// carries no runtime values — asserted by contract.test.ts + this dir's barrel test).

// Shared data + view-model shapes (also re-exports the SRD `ClassName`).
export type {
  ClassName,
  GuidedStep,
  GuidedChoice,
  GuidedOption,
  RailStep,
  LoadingBeat,
  AbilityAbbrev,
  AbilityTile,
  SheetStat,
  SheetEntry,
  SheetSkill,
  CuratedSheet,
  FullSheet,
  RosterStatus,
  RosterMember,
} from './types.ts'

// Prop contracts — one per @mythrun/ui character component.
export type { CharacterLevel, LevelCardProps } from './level-card-props.ts'
export type { FreeformPromptProps } from './freeform-prompt-props.ts'
export type { GuidedBuilderProps } from './guided-builder-props.ts'
export type { CharacterLoadingBeatProps } from './character-loading-beat-props.ts'
export type { CharacterSheetRevealProps } from './character-sheet-reveal-props.ts'
export type { PartyRosterProps } from './party-roster-props.ts'
