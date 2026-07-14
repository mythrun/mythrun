import type { ClassName } from '../../srd/classes.ts'

// Shared data + view-model shapes for the MYT-90 character-creation surface. These
// are the DOM-free vocabulary the six @mythrun/ui character components render and the
// B4 view-model produces objects of. Platform-neutral (§9): pure data — no DOM types,
// no React/JSX, no runtime values. Display strings arrive already resolved (the DS
// owns no copy); `[ph:]` display copy is a later web-layer task.

// Re-export the SRD class union so a consumer reads the guided-builder's class
// identity off the same contract surface it reads the shapes from.
export type { ClassName } from '../../srd/classes.ts'

/** The ordered steps of the guided builder. `subclass` is offered conditionally
 *  (once the party's starting level reaches the class's `SUBCLASS_LEVEL`); `notes`
 *  is the optional free-text coda. */
export type GuidedStep = 'class' | 'subclass' | 'species' | 'background' | 'notes'

/** The accumulated guided picks — the builder's controlled selection state, folded
 *  by the B4 view-model into concept text for the backend. `className` keys off the
 *  SRD {@link ClassName}; `subclass`/`notes` are absent until chosen. */
export interface GuidedChoice {
  className: ClassName
  subclass?: string
  species: string
  background: string
  notes?: string
}

/** A selectable card in the current guided step. `description` is a resolved
 *  display string (the web layer fills the `[ph:]` copy). */
export interface GuidedOption {
  id: string
  name: string
  description: string
}

/** One rung of the guided builder's progress rail: the step, its resolved label,
 *  the chosen value (once picked), and where it sits relative to the cursor. */
export interface RailStep {
  step: GuidedStep
  label: string
  chosen?: string
  state: 'done' | 'now' | 'todo'
}

/** One line of the "coming into being" beat that plays while the character is
 *  generated — a labelled row that advances pending → active → done. */
export interface LoadingBeat {
  id: string
  label: string
  state: 'pending' | 'active' | 'done'
}

/** The six D&D 5e ability abbreviations (the ability-tile heading). */
export type AbilityAbbrev = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'

/** One ability tile on the sheet — the rolled score and its derived modifier
 *  (both computed in deterministic code; the LLM never rolls). */
export interface AbilityTile {
  abbrev: AbilityAbbrev
  score: number
  modifier: number
}

/** One cell of the AC / HP / Proficiency / Hit Die / Speed stripe — a resolved
 *  label over its display value. */
export interface SheetStat {
  label: string
  value: string
}

/** One feature or equipment row — the item name with an optional quiet gloss. */
export interface SheetEntry {
  name: string
  gloss?: string
}

/** The field-guide reveal (the `meet-character` "Meet your character" view): the
 *  curated, prose-forward sheet a new player meets their character through. `spells`
 *  is present only for casting classes. */
export interface CuratedSheet {
  name: string
  identityLine: string
  stats: SheetStat[]
  abilities: AbilityTile[]
  prose: string[]
  features: SheetEntry[]
  equipment: SheetEntry[]
  spells?: SheetEntry[]
}

/** One skill row on the expanded sheet — proficiency and (double-proficiency)
 *  expertise flags. */
export interface SheetSkill {
  name: string
  proficient: boolean
  expertise: boolean
}

/** The expanded mechanical sheet the curated view hides — revealed when the player
 *  opts into the full detail. */
export interface FullSheet {
  skills: SheetSkill[]
  savingThrows: string[]
  equipment: SheetEntry[]
  spells: SheetEntry[]
}

/** A party member's creation state: `creating` (concept submitted, character still
 *  generating), `ready` (character made), `gathering` (a real joined teammate who
 *  hasn't started a character yet), or `empty` (the synthetic invite slot only —
 *  never a real member). A joined-but-unstarted member is `gathering`, distinct from
 *  the `empty` invite affordance the party-staging surface appends when soloing. */
export type RosterStatus = 'creating' | 'ready' | 'gathering' | 'empty'

/** One row of the party-finalize roster. `characterName` is present once the member
 *  is `ready`; `isViewer` marks the current player's own row ("you"). */
export interface RosterMember {
  userId: string
  displayName: string
  characterName?: string
  status: RosterStatus
  isViewer: boolean
}
