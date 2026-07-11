// The guided character builder's pure reducer (MYT-90). Advances the ordered
// Class → Subclass → Species → Background → Notes sequence, SKIPPING the Subclass
// step when the chosen class does not gain a subclass at the party's starting level
// (the `subclassOfferedAt` gate), and supports stepping back over the skip. The
// accumulated GuidedChoice and the progress rail are exposed as pure selectors, not
// stored in state, so there is a single derivation and no cross-field drift.
//
// Platform-independent BRAIN (R1): no React/DOM. The controlled @mythrun/ui
// GuidedBuilder holds no step state — it drives this reducer and reads the selectors.

import { CLASSES, subclassOfferedAt } from '../srd/index.ts'
import type { ClassName, GuidedChoice, GuidedStep, RailStep } from '../contract/index.ts'
import { canonicalClassName } from './flatten.ts'

/** The accumulating guided picks — partial by construction (fields fill in as the
 *  player advances). Folded into a complete {@link GuidedChoice} by `guidedChoice`. */
export interface GuidedChoiceDraft {
  className?: ClassName
  subclass?: string
  species?: string
  background?: string
  notes?: string
}

/** The reducer's state: the party's starting `level` (gates the subclass step), the
 *  current `step`, the accumulated `choice`, and whether the flow has run past the
 *  final step. */
export interface GuidedState {
  readonly level: number
  readonly step: GuidedStep
  readonly choice: GuidedChoiceDraft
  readonly complete: boolean
}

/** `choose` commits the current step's value and advances (skipping subclass when
 *  the class/level does not grant one); `back` steps to the previous real step. */
export type GuidedAction = { readonly type: 'choose'; readonly value: string } | { readonly type: 'back' }

const FULL_ORDER: readonly GuidedStep[] = ['class', 'subclass', 'species', 'background', 'notes']
const NO_SUBCLASS_ORDER: readonly GuidedStep[] = ['class', 'species', 'background', 'notes']

const STEP_LABELS: Record<GuidedStep, string> = {
  class: 'Class',
  subclass: 'Subclass',
  species: 'Species',
  background: 'Background',
  notes: 'Notes',
}

const CLASS_NAME_SET = new Set<string>(CLASSES)
function isClassName(value: string): value is ClassName {
  return CLASS_NAME_SET.has(value)
}

/** The actual step path for a class at a level — the Subclass step is present only
 *  once the class/level grants a subclass. Before a class is chosen the path omits
 *  it (the builder is still on the Class step regardless). */
function stepSequence(className: ClassName | undefined, level: number): readonly GuidedStep[] {
  if (className !== undefined && subclassOfferedAt(className, level)) return FULL_ORDER
  return NO_SUBCLASS_ORDER
}

/** The first guided state at the party's starting `level`. */
export function initialGuidedState(level: number): GuidedState {
  return { level, step: 'class', choice: {}, complete: false }
}

/** Apply a pick to the draft and move to the next step in the (possibly re-computed)
 *  sequence; running past the final step marks the flow complete. */
function advance(state: GuidedState, patch: Partial<GuidedChoiceDraft>): GuidedState {
  const choice = { ...state.choice, ...patch }
  const sequence = stepSequence(choice.className, state.level)
  const next = sequence[sequence.indexOf(state.step) + 1]
  if (next === undefined) return { ...state, choice, complete: true }
  return { ...state, choice, step: next, complete: false }
}

function applyChoice(state: GuidedState, value: string): GuidedState {
  switch (state.step) {
    case 'class':
      return isClassName(value) ? advance(state, { className: value }) : state
    case 'subclass':
      return advance(state, { subclass: value })
    case 'species':
      return advance(state, { species: value })
    case 'background':
      return advance(state, { background: value })
    case 'notes':
      return advance(state, { notes: value })
  }
}

function goBack(state: GuidedState): GuidedState {
  const sequence = stepSequence(state.choice.className, state.level)
  const currentIndex = state.complete ? sequence.length - 1 : sequence.indexOf(state.step)
  const prev = sequence[currentIndex - 1]
  if (prev === undefined) return state
  return { ...state, step: prev, complete: false }
}

/** The pure reducer: advance a pick, or step back. */
export function guidedReducer(state: GuidedState, action: GuidedAction): GuidedState {
  switch (action.type) {
    case 'choose':
      return applyChoice(state, action.value)
    case 'back':
      return goBack(state)
  }
}

/** The chosen display value for a rung, or undefined when that step is unpicked. */
function chosenFor(step: GuidedStep, choice: GuidedChoiceDraft): string | undefined {
  switch (step) {
    case 'class':
      return choice.className !== undefined ? canonicalClassName(choice.className) : undefined
    case 'subclass':
      return choice.subclass
    case 'species':
      return choice.species
    case 'background':
      return choice.background
    case 'notes':
      return choice.notes
  }
}

/** The progress rail: one rung per step in the actual path, each marked done / now /
 *  todo relative to the cursor (all done once the flow is complete). */
export function guidedRail(state: GuidedState): RailStep[] {
  const sequence = stepSequence(state.choice.className, state.level)
  const cursor = state.complete ? sequence.length : sequence.indexOf(state.step)
  return sequence.map((step, index) => {
    const progress: RailStep['state'] = index < cursor ? 'done' : index === cursor ? 'now' : 'todo'
    const chosen = chosenFor(step, state.choice)
    return chosen === undefined
      ? { step, label: STEP_LABELS[step], state: progress }
      : { step, label: STEP_LABELS[step], chosen, state: progress }
  })
}

/** The accumulated picks folded into a complete {@link GuidedChoice}, or null until
 *  class, species, and background are all chosen. A subclass is included only when
 *  the class/level grants one (a stale draft subclass is dropped); notes only when
 *  present and non-empty — the same gates `flattenToConceptText` applies. */
export function guidedChoice(state: GuidedState): GuidedChoice | null {
  const { className, species, background, subclass, notes } = state.choice
  if (className === undefined || species === undefined || background === undefined) return null

  const base: GuidedChoice = { className, species, background }
  const withSubclass =
    subclass !== undefined && subclassOfferedAt(className, state.level)
      ? { ...base, subclass }
      : base
  return notes !== undefined && notes.length > 0 ? { ...withSubclass, notes } : withSubclass
}
