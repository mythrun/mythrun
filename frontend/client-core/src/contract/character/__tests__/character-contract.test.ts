import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ClassName } from '../../../srd/classes.ts'
import * as characterBarrel from '../index.ts'
import type {
  // Shared data + view-model shapes (types.ts)
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
  // Prop contracts
  CharacterLevel,
  LevelCardProps,
  FreeformPromptProps,
  GuidedBuilderProps,
  CharacterLoadingBeatProps,
  CharacterSheetRevealProps,
  PartyRosterProps,
} from '../index.ts'
// The same contracts must be reachable from the top `@mythrun/client-core/contract`
// barrel (the enforced portability seam) — pin one representative of each family.
import type {
  GuidedChoice as TopGuidedChoice,
  CuratedSheet as TopCuratedSheet,
  RosterMember as TopRosterMember,
  LevelCardProps as TopLevelCardProps,
  GuidedBuilderProps as TopGuidedBuilderProps,
  CharacterSheetRevealProps as TopCharacterSheetRevealProps,
  PartyRosterProps as TopPartyRosterProps,
} from '../../index.ts'

// Type-level contract for the MYT-90 character-creation surface. The runtime
// barrel stays value-free (asserted below + by contract.test.ts); here we PIN the
// exact data + prop SHAPES so the six @mythrun/ui components, the B4 view-model,
// and the native impl all satisfy one DOM-free surface. Callbacks are plain
// functions (§9) — never DOM events.
describe('character contract barrel', () => {
  it('is importable and exports types only (no runtime values)', () => {
    expect(Object.keys(characterBarrel)).toHaveLength(0)
  })
})

describe('shared data + view-model shapes', () => {
  it('GuidedStep is the five-step closed union', () => {
    expectTypeOf<GuidedStep>().toEqualTypeOf<
      'class' | 'subclass' | 'species' | 'background' | 'notes'
    >()
  })

  it('GuidedChoice keys the class off the SRD ClassName; subclass/notes optional', () => {
    expectTypeOf<GuidedChoice>().toEqualTypeOf<{
      className: ClassName
      subclass?: string
      species: string
      background: string
      notes?: string
    }>()
  })

  it('GuidedOption is a selectable card (id + name + display description)', () => {
    expectTypeOf<GuidedOption>().toEqualTypeOf<{
      id: string
      name: string
      description: string
    }>()
  })

  it('RailStep carries the step, label, optional chosen value, and progress state', () => {
    expectTypeOf<RailStep>().toEqualTypeOf<{
      step: GuidedStep
      label: string
      chosen?: string
      state: 'done' | 'now' | 'todo'
    }>()
  })

  it('LoadingBeat is a pending/active/done beat', () => {
    expectTypeOf<LoadingBeat>().toEqualTypeOf<{
      id: string
      label: string
      state: 'pending' | 'active' | 'done'
    }>()
  })

  it('AbilityAbbrev is the six-ability closed union', () => {
    expectTypeOf<AbilityAbbrev>().toEqualTypeOf<
      'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'
    >()
  })

  it('AbilityTile pairs a score with its derived modifier', () => {
    expectTypeOf<AbilityTile>().toEqualTypeOf<{
      abbrev: AbilityAbbrev
      score: number
      modifier: number
    }>()
  })

  it('SheetStat is a label/value stripe cell', () => {
    expectTypeOf<SheetStat>().toEqualTypeOf<{ label: string; value: string }>()
  })

  it('SheetEntry is a name with an optional gloss', () => {
    expectTypeOf<SheetEntry>().toEqualTypeOf<{ name: string; gloss?: string }>()
  })

  it('CuratedSheet is the field-guide reveal; spells present only for casters', () => {
    expectTypeOf<CuratedSheet>().toEqualTypeOf<{
      name: string
      identityLine: string
      stats: SheetStat[]
      abilities: AbilityTile[]
      prose: string[]
      features: SheetEntry[]
      equipment: SheetEntry[]
      spells?: SheetEntry[]
    }>()
  })

  it('SheetSkill records proficiency + expertise', () => {
    expectTypeOf<SheetSkill>().toEqualTypeOf<{
      name: string
      proficient: boolean
      expertise: boolean
    }>()
  })

  it('FullSheet is the expanded mechanical detail the curated view hides', () => {
    expectTypeOf<FullSheet>().toEqualTypeOf<{
      skills: SheetSkill[]
      savingThrows: string[]
      equipment: SheetEntry[]
      spells: SheetEntry[]
    }>()
  })

  it('RosterStatus is the creating/ready/gathering/empty union', () => {
    expectTypeOf<RosterStatus>().toEqualTypeOf<'creating' | 'ready' | 'gathering' | 'empty'>()
  })

  it('RosterMember carries the viewer flag + optional character name', () => {
    expectTypeOf<RosterMember>().toEqualTypeOf<{
      userId: string
      displayName: string
      characterName?: string
      status: RosterStatus
      isViewer: boolean
    }>()
  })
})

describe('prop contracts (exact — the C tasks build to these)', () => {
  it('CharacterLevel is the 1..5 starting-level union', () => {
    expectTypeOf<CharacterLevel>().toEqualTypeOf<1 | 2 | 3 | 4 | 5>()
  })

  it('LevelCardProps', () => {
    expectTypeOf<LevelCardProps>().toEqualTypeOf<{
      level: CharacterLevel
      grantGloss: string
      selected: boolean
      onSelect: () => void
    }>()
  })

  it('FreeformPromptProps — neutral onChange(value)/onSubmit, optional placeholder', () => {
    expectTypeOf<FreeformPromptProps>().toEqualTypeOf<{
      prompt: string
      whisper: string
      value: string
      onChange: (v: string) => void
      onSubmit: () => void
      placeholder?: string
    }>()
  })

  it('GuidedBuilderProps is fully controlled (no internal step state)', () => {
    expectTypeOf<GuidedBuilderProps>().toEqualTypeOf<{
      rail: RailStep[]
      question: string
      options: GuidedOption[]
      selectedId: string | null
      onSelect: (id: string) => void
      onNext: () => void
      onBack: () => void
      onSkipToFreeform: () => void
    }>()
  })

  it('CharacterLoadingBeatProps', () => {
    expectTypeOf<CharacterLoadingBeatProps>().toEqualTypeOf<{
      beats: LoadingBeat[]
      reducedMotion: boolean
    }>()
  })

  it('CharacterSheetRevealProps — controlled expand + confirm/start-over', () => {
    expectTypeOf<CharacterSheetRevealProps>().toEqualTypeOf<{
      curated: CuratedSheet
      full: FullSheet
      expanded: boolean
      onToggleExpand: () => void
      onConfirm: () => void
      onStartOver: () => void
    }>()
  })

  it('PartyRosterProps — owner-gated begin + invite', () => {
    expectTypeOf<PartyRosterProps>().toEqualTypeOf<{
      members: RosterMember[]
      viewerIsOwner: boolean
      canBegin: boolean
      onBegin: () => void
      onInvite: () => void
    }>()
  })
})

describe('reachable from the top @mythrun/client-core/contract barrel', () => {
  it('re-exports the shared shapes unchanged', () => {
    expectTypeOf<TopGuidedChoice>().toEqualTypeOf<GuidedChoice>()
    expectTypeOf<TopCuratedSheet>().toEqualTypeOf<CuratedSheet>()
    expectTypeOf<TopRosterMember>().toEqualTypeOf<RosterMember>()
  })

  it('re-exports the prop contracts unchanged', () => {
    expectTypeOf<TopLevelCardProps>().toEqualTypeOf<LevelCardProps>()
    expectTypeOf<TopGuidedBuilderProps>().toEqualTypeOf<GuidedBuilderProps>()
    expectTypeOf<TopCharacterSheetRevealProps>().toEqualTypeOf<CharacterSheetRevealProps>()
    expectTypeOf<TopPartyRosterProps>().toEqualTypeOf<PartyRosterProps>()
  })
})
