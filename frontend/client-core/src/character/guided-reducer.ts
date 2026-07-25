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

/** The chosen display value for a rung, or undefined when that step is unpicked.
 *  The class rung folds a chosen subclass into its value ("Cleric · Life Domain")
 *  — the subclass is a sub-question of the CLASS station, never its own rung
 *  (ux-run2 myth-udhp3 / myth-mttu7). */
function chosenFor(step: GuidedStep, choice: GuidedChoiceDraft): string | undefined {
  switch (step) {
    case 'class': {
      if (choice.className === undefined) return undefined
      const name = canonicalClassName(choice.className)
      return choice.subclass !== undefined ? `${name} · ${choice.subclass}` : name
    }
    // The only caller (guidedRail) iterates NO_SUBCLASS_ORDER — the rail never
    // carries a subclass station (the subclass rides the class rung's value) —
    // so this arm never executes; it exists for switch exhaustiveness over
    // GuidedStep.
    /* v8 ignore next 2 */
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

/** The grounding rung's fixed label — the same brain-side chrome register as
 *  STEP_LABELS (resolved copy is a later web-layer concern for all of them).
 *  "Arrival" (not the design-doc "Grounding") — it pairs with the step's own
 *  question, "And how do you come to be here?" (ux-run2 myth-udhp3). */
const GROUNDING_LABEL = 'Arrival'

/** The progress rail: one rung per DISPLAY station, each marked done / now / todo
 *  relative to the cursor (all done once the flow is complete) — PLUS the final
 *  grounding rung (MYT-102). Grounding is the screen after the builder (the route's
 *  `complete` branch), not a reducer step, but it IS the last leg of the same journey:
 *  the rail carries it as `todo` while the builder runs and `now` once the flow
 *  completes, so the player stays oriented at the exact moment the builder chrome
 *  disappears. It is never `done` — a successful submit unmounts the flow.
 *
 *  The display stations are STABLE (ux-run2 myth-udhp3): the rail never grows a
 *  SUBCLASS station mid-flow — a plan that changes while it is walked reads as a
 *  malfunction. The subclass is a sub-question of the CLASS station: while the
 *  cursor sits on the reducer's `subclass` step the CLASS rung stays `now`, and a
 *  chosen subclass rides the class rung's value ("Cleric · Life Domain"). */
export function guidedRail(state: GuidedState): RailStep[] {
  const stations = NO_SUBCLASS_ORDER
  const cursorStep: GuidedStep = state.step === 'subclass' ? 'class' : state.step
  const cursor = state.complete ? stations.length : stations.indexOf(cursorStep)
  const rungs: RailStep[] = stations.map((step, index) => {
    const progress: RailStep['state'] = index < cursor ? 'done' : index === cursor ? 'now' : 'todo'
    const chosen = chosenFor(step, state.choice)
    return chosen === undefined
      ? { step, label: STEP_LABELS[step], state: progress }
      : { step, label: STEP_LABELS[step], chosen, state: progress }
  })
  rungs.push({
    step: 'grounding',
    label: GROUNDING_LABEL,
    state: state.complete ? 'now' : 'todo',
  })
  return rungs
}

/** The persisted guided draft's loose shape (all free strings, every field optional)
 *  — the character-draft seam persists this; it is structurally the web
 *  `CharacterGuidedDraft`. Kept loose (plain strings, not `ClassName`) because it
 *  comes back from storage un-narrowed; `hydrateGuidedState` re-validates through the
 *  reducer. */
export interface GuidedDraftSeed {
  // `| undefined` on each (not just `?`) so the persisted `CharacterGuidedDraft` (a
  // Zod-inferred shape whose optionals are `string | undefined`) assigns cleanly
  // under exactOptionalPropertyTypes; a caller passing a plain `{className}` also fits.
  className?: string | undefined
  subclass?: string | undefined
  species?: string | undefined
  background?: string | undefined
  notes?: string | undefined
}

/** The persisted value for a step during hydration (undefined = not drafted yet). */
function seedValueForStep(step: GuidedStep, seed: GuidedDraftSeed): string | undefined {
  switch (step) {
    case 'class':
      return seed.className
    case 'subclass':
      return seed.subclass
    case 'species':
      return seed.species
    case 'background':
      return seed.background
    case 'notes':
      return seed.notes
  }
}

/** Reconstruct the reducer state from a persisted draft (player-input durability):
 *  replay `choose` for each step the draft carries a value for, stopping at the first
 *  it does not (the player was mid-that-step). Runs the SAME reducer logic, so the
 *  subclass skip and the complete flag reconstruct exactly. A foreign/invalid value
 *  (e.g. a class name that no longer exists) no-ops the reducer, which stops the
 *  replay — the cursor never advances past a corrupt draft, and never spins. */
export function hydrateGuidedState(level: number, seed: GuidedDraftSeed | undefined): GuidedState {
  let state = initialGuidedState(level)
  if (seed === undefined) return state
  // Bounded by the longest possible path (FULL_ORDER); each iteration advances the
  // cursor or breaks, so it terminates well within the bound.
  for (let i = 0; i < FULL_ORDER.length && !state.complete; i++) {
    const value = seedValueForStep(state.step, seed)
    if (value === undefined || value === '') break
    const next = guidedReducer(state, { type: 'choose', value })
    if (next === state) break
    state = next
  }
  return state
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
