import { useEffect, useReducer, useRef, useState } from 'react'
import { Stack, GuidedBuilder } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  guidedReducer,
  guidedRail,
  guidedChoice,
  flattenToConceptText,
  canonicalClassName,
  hydrateGuidedState,
  useCharacterDraft,
  type GuidedChoiceDraft,
  type GuidedState,
  type SessionDraftStore,
} from '@mythrun/client-core/character'
import { CLASS_OPTIONS, SPECIES, BACKGROUNDS } from '@mythrun/client-core/srd'
import type { GuidedChoicesPayload } from '@mythrun/client-core'
import type { GuidedBuilderLabels, GuidedOption, GuidedStep, RailStep } from '@mythrun/client-core/contract'
import type { SituationRecapData } from './freeform-path.tsx'
import { GroundingScreen, NotesScreen, type Notice } from './guided-screens.tsx'

// The GUIDED PATH (MYT-90, D4) — the "answer a few questions" fork. A controlled
// driver around the presentational @mythrun/ui <GuidedBuilder>, wired to the
// client-core guided BRAIN: the reducer owns the ordered Class → Subclass → Species
// → Background → Notes sequence AND the conditional Subclass skip (it drops that step
// when the party's starting level does not grant the chosen class a subclass), and
// `flattenToConceptText` folds the picks into the concept sentence. This driver holds
// only the transient view state the reducer deliberately does not: the current step's
// pre-commit selection, the free-text notes, and the grounding field.
//
// Two committed steps are free text, not option grids, so they render the shared
// <FreeformPrompt> instead of the builder: the optional Notes coda, then — exactly as
// the freeform path does — the grounding whisper (the chosen situation's invitation).
// A completed run submits the flattened conceptText AND situationGroundingText AND
// the structured guidedChoices (ux-run2 myth-4jhrk — the picks travel as data, so
// the backend can pin them instead of re-deriving them from prose) via the
// route-injected `submit`; `onSkipToFreeform` abandons to the freeform fork.
//
// MYT-102 signposting + grounding: the builder-less free-text screens keep the
// journey's progress rail — the standalone <GuidedRail> renders the same
// `guidedRail(state)` rungs the builder shows — so the signposting never disappears
// at the exact moment the option grids do. The grounding screen additionally keeps
// the chosen situation's RECAP (LLM DATA) in view above the prompt, so "how do you
// come to be here?" is answered against the actual opening scene.
//
// NAVIGATION (ux-run2 myth-80an1): one Back, one meaning, one position — the
// bottom-left of the action row on EVERY screen. The builder renders it itself;
// the free-text screens get it through FreeformPrompt's `onBack`. On the Class
// step Back leaves to the chooser (the reversible entry decision); everywhere
// else it steps back in-path via the reducer.
//
// THE SUBCLASS SUB-QUESTION (ux-run2 myth-mttu7): SRD ships exactly one subclass
// per class, so the subclass step is a statement with consent, never a staged
// choice — the sole card arrives PRESELECTED, the question is the world-lore
// statement ("Life Domain is the Cleric's path here."), and Continue is the
// single act. The rail never shows it as a station (it rides the CLASS rung).
//
// Options map SRD → cards: each option's `id` is the value the reducer commits (the
// class ID for `class`; the canonical English SRD name for the rest — the locale-
// independent flatten input), while the shown `name`/`description` are i18n catalog
// keys, never the canonical name. The rail labels + chosen values come straight
// from the reducer's `guidedRail` selector.

/** The grounding field's minimum characters — mirrors the backend
 *  `SubmitCharacterBodySchema` (`.min(20)`), so a too-short answer is a calm nudge
 *  here rather than a 400 at the request boundary. The flattened conceptText always
 *  clears the floor, so only the grounding field needs the check. */
const MIN_CHARS = 20

/** The four option-grid steps (Notes is free text; it renders a FreeformPrompt). */
type OptionStep = Exclude<GuidedStep, 'notes'>

/** A minimal `t` — the option builders only ever resolve a key to a string. */
type Translate = (key: string) => string

/** The current step's option cards. `id` is the exact value the reducer commits;
 *  `name`/`description` are i18n display keys (never the canonical name). The
 *  description is the one-line "plays like" gloss — the decision criteria a
 *  newcomer needs on the card itself (ux-run2 myth-334oz). The single-option
 *  subclass card stays gloss-less: its statement question carries the lore. */
function optionsFor(step: OptionStep, className: string | undefined, t: Translate): GuidedOption[] {
  switch (step) {
    case 'class':
      return CLASS_OPTIONS.map((option) => ({
        id: option.id,
        name: t(`characterCreate.guided.class.options.${option.id}.name`),
        description: t(`characterCreate.guided.class.options.${option.id}.gloss`),
      }))
    case 'subclass': {
      // The reducer only reaches the Subclass step once a class is chosen, so a match
      // is always found; the empty fallback is unreachable in practice.
      const chosen = CLASS_OPTIONS.find((option) => option.id === className)
      return chosen === undefined
        ? []
        : [
            {
              id: chosen.subclass,
              name: t(`characterCreate.guided.subclass.options.${chosen.id}.name`),
              description: '',
            },
          ]
    }
    case 'species':
      return SPECIES.map((name) => ({
        id: name,
        name: t(`characterCreate.guided.species.options.${name}.name`),
        description: t(`characterCreate.guided.species.options.${name}.gloss`),
      }))
    case 'background':
      return BACKGROUNDS.map((name) => ({
        id: name,
        name: t(`characterCreate.guided.background.options.${name}.name`),
        description: t(`characterCreate.guided.background.options.${name}.gloss`),
      }))
  }
}

/** The value already committed for a step — used to re-select the prior pick when the
 *  player steps Back, so Next works without re-clicking. Undrafted steps (and the
 *  free-text Notes step) start unselected — EXCEPT the single-option subclass
 *  sub-question, which arrives preselected (a statement with consent, not a staged
 *  choice; ux-run2 myth-mttu7). */
function selectionForStep(step: GuidedStep, choice: GuidedChoiceDraft): string | null {
  switch (step) {
    case 'class':
      return choice.className ?? null
    case 'subclass':
      return (
        choice.subclass ??
        CLASS_OPTIONS.find((option) => option.id === choice.className)?.subclass ??
        null
      )
    case 'species':
      return choice.species ?? null
    case 'background':
      return choice.background ?? null
    case 'notes':
      return null
  }
}

/** The structured picks for the wire (the myth-4jhrk `GuidedChoicesPayload`
 *  contract) — canonical SRD names, present-only fields
 *  (exactOptionalPropertyTypes: absent, never explicitly undefined). */
function toGuidedChoicesPayload(state: GuidedState): GuidedChoicesPayload {
  const { className, subclass, species, background } = state.choice
  return {
    ...(className !== undefined && { class: canonicalClassName(className) }),
    ...(subclass !== undefined && { subclass }),
    ...(species !== undefined && { species }),
    ...(background !== undefined && { background }),
  }
}

/** The resolved "Step N of M" rail counter (ux-run2 myth-udhp3) — current is the
 *  `now` rung's 1-based position; M counts every station incl. the grounding leg. */
function railCounter(rail: RailStep[], t: TFunction): string {
  const current = rail.findIndex((rung) => rung.state === 'now') + 1
  return t('characterCreate.guided.stepCounter', { current, total: rail.length })
}

/** The current option step's hero question. The single-option subclass renders
 *  as a statement with consent (ux-run2 myth-mttu7) — the lore statement, never
 *  a staged question. */
function questionFor(
  step: OptionStep,
  choice: GuidedChoiceDraft,
  t: TFunction,
  resolve: Translate,
): string {
  if (step !== 'subclass') return resolve(`characterCreate.guided.${step}.question`)
  return t('characterCreate.guided.subclass.statement', {
    subclass: selectionForStep('subclass', choice) ?? '',
    className: choice.className !== undefined ? canonicalClassName(choice.className) : '',
  })
}

export interface GuidedPathProps {
  /** The party's starting level — gates the conditional Subclass step (the reducer
   *  skips it when the chosen class gains no subclass at this level). */
  startingLevel: number
  /** The grounding step's whisper — the chosen situation's invitation (or the route's
   *  generic fallback), exactly as the freeform path uses it. */
  groundingWhisper: string
  /** The chosen situation's recap (MYT-102) — shown above the grounding prompt;
   *  undefined (pending fetch / legacy world) renders the prompt without it. */
  situation?: SituationRecapData
  /** Commit both text fields plus the structured picks (the route binds ctx +
   *  campaignId + the real endpoint; guidedChoices rides the myth-4jhrk
   *  `GuidedChoicesPayload` wire contract so the backend pins the picks —
   *  notably the subclass — instead of re-deriving them from prose). */
  submit: (
    conceptText: string,
    situationGroundingText: string,
    guidedChoices: GuidedChoicesPayload,
  ) => Promise<void>
  /** A successful submit — the route advances the create-machine to `processing`. */
  onSubmitted: () => void
  /** Abandon the guided path for the freeform fork (the route switches the
   *  create-machine back with `skipToFreeform`). */
  onSkipToFreeform: () => void
  /** Leave the guided path for the CHOOSER (the route dispatches create-machine
   *  `back`). Wired to the Class step's Back — the first step, where there is no
   *  prior step — so the entry decision is reversible. The later steps' Back steps
   *  in-path (the reducer), walking down to Class, then here. */
  onBack: () => void
  /** The world panel's step-awareness seam (ux-run2 myth-ehcf4): reports the
   *  currently-selected card's canonical name (e.g. "Cleric") whenever the
   *  selection changes — the SHORT topic the panel uses as its match needle over
   *  entity names + glossary terms (`WorldWikiProps.stepContext`). Undefined
   *  when nothing is selected (the panel then stands its context strip down).
   *  Optional — absent means nobody is listening. */
  onStepContext?: (stepContext: string | undefined) => void
  /** Player-input durability: the draft store + its campaign key. The path seeds the
   *  reducer (via `hydrateGuidedState`) and the notes/grounding fields from the
   *  persisted draft on EVERY mount, and persists picks/notes/grounding as they
   *  change — so a back-to-chooser round-trip (or a reload) restores the picks and
   *  the words. Absent store → persistence is a no-op (tests / native shell). */
  store?: SessionDraftStore | null
  campaignId: string
}

/** The guided flow's durable state (player-input durability): the reducer seeded
 *  from the persisted draft, the pre-commit selection (re-derived per step, so
 *  Back lands on the prior pick and the single-option subclass arrives
 *  preselected — myth-mttu7), and the two free-text fields, all persisted as
 *  they change so a back-to-chooser round-trip (or reload) restores everything. */
function useGuidedFlow(
  startingLevel: number,
  store: SessionDraftStore | null,
  campaignId: string,
): {
  state: GuidedState
  dispatch: (action: Parameters<typeof guidedReducer>[1]) => void
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  notesText: string
  handleNotesChange: (value: string) => void
  groundingText: string
  handleGroundingChange: (value: string) => void
} {
  const draft = useCharacterDraft(store, campaignId)
  const [state, dispatch] = useReducer(
    guidedReducer,
    draft.initial.guided,
    (seed) => hydrateGuidedState(startingLevel, seed),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notesText, setNotesText] = useState(draft.initial.guided?.notes ?? '')
  const [groundingText, setGroundingText] = useState(draft.initial.groundingText ?? '')

  // Persist the committed picks whenever the reducer's choice advances. `state.choice`
  // only ever carries the keys already picked (never an `undefined` value), so the
  // draft's field-by-field merge cannot clobber a stored pick.
  useEffect(() => {
    draft.update({ guided: state.choice })
  }, [draft, state.choice])

  // Re-derive the pre-commit selection from the committed draft on step change.
  useEffect(() => {
    setSelectedId(selectionForStep(state.step, state.choice))
  }, [state.step, state.choice])

  const handleNotesChange = (value: string): void => {
    setNotesText(value)
    draft.update({ guided: { notes: value } })
  }
  const handleGroundingChange = (value: string): void => {
    setGroundingText(value)
    draft.update({ groundingText: value })
  }
  return {
    state,
    dispatch,
    selectedId,
    setSelectedId,
    notesText,
    handleNotesChange,
    groundingText,
    handleGroundingChange,
  }
}

/** The cast-free adapter for the RUNTIME-computed option keys (the i18n typed-key
 *  augmentation rejects a plain string; the `defaultValue` overload accepts one —
 *  the key echoes as its own fallback, and the lockstep test guarantees every key
 *  exists, so the fallback never surfaces). */
function makeResolve(t: TFunction): Translate {
  return (key) => t(key, { defaultValue: key })
}

/** The builder's resolved nav labels. The subclass consent step advances with
 *  "Continue" — consent, not paging (myth-mttu7); every other station pages with
 *  the one shared "Next". */
function builderLabels(t: TFunction, step: OptionStep): GuidedBuilderLabels {
  return {
    next: step === 'subclass' ? t('characterCreate.freeform.continue') : t('characterCreate.guided.next'),
    back: t('characterCreate.guided.back'),
    switchToFreeform: t('characterCreate.guided.switchToFreeform'),
  }
}

/** The world panel's match needle (myth-ehcf4): the current selection's
 *  canonical name; undefined on the free-text screens or before a pick — the
 *  panel then stands its context strip down. */
function selectionNeedle(state: GuidedState, selectedId: string | null): string | undefined {
  if (state.complete || state.step === 'notes' || selectedId === null) return undefined
  if (state.step === 'class') return CLASS_OPTIONS.find((option) => option.id === selectedId)?.name
  return selectedId
}

/** Submit the completed flow: flatten the picks into conceptText, attach the
 *  structured GuidedChoicesPayload (myth-4jhrk), and report success/failure
 *  through the notice. The `submitting` ref is a synchronous double-press guard;
 *  on success the route unmounts the path, so the guard stays set. */
function submitCompletedFlow(args: {
  state: GuidedState
  startingLevel: number
  groundingText: string
  submit: GuidedPathProps['submit']
  onSubmitted: () => void
  setNotice: (notice: Notice) => void
  submitting: { current: boolean }
}): void {
  const { state, startingLevel, groundingText, submit, onSubmitted, setNotice, submitting } = args
  if (groundingText.trim().length < MIN_CHARS) {
    setNotice('tooShort')
    return
  }
  if (submitting.current) return
  const choice = guidedChoice(state)
  // Unreachable once the flow is complete (class/species/background are all set);
  // the guard keeps the type honest without a non-null assertion.
  if (choice === null) return
  submitting.current = true
  setNotice(null)
  const conceptText = flattenToConceptText(choice, startingLevel)
  void submit(conceptText, groundingText.trim(), toGuidedChoicesPayload(state))
    .then(() => {
      onSubmitted()
    })
    .catch(() => {
      submitting.current = false
      setNotice('error')
    })
}

export function GuidedPath({
  startingLevel,
  groundingWhisper,
  situation,
  submit,
  onSubmitted,
  onSkipToFreeform,
  onBack,
  onStepContext,
  store,
  campaignId,
}: GuidedPathProps): React.JSX.Element {
  const { t } = useTranslation()
  const resolve = makeResolve(t)
  const {
    state,
    dispatch,
    selectedId,
    setSelectedId,
    notesText,
    handleNotesChange,
    groundingText,
    handleGroundingChange,
  } = useGuidedFlow(startingLevel, store ?? null, campaignId)
  const [notice, setNotice] = useState<Notice>(null)
  // A synchronous in-flight guard (a ref, not state — a double-press fires before a
  // state flush) so a second Continue can't fire a second submit.
  const submitting = useRef(false)

  // The panel step-awareness seam (myth-ehcf4): report the selection needle so
  // the world panel follows the decision instead of reciting the same intro.
  const stepContext = selectionNeedle(state, selectedId)
  useEffect(() => {
    onStepContext?.(stepContext)
  }, [onStepContext, stepContext])

  const commit = (): void => {
    if (selectedId === null) return
    dispatch({ type: 'choose', value: selectedId })
  }

  const continueNotes = (): void => {
    // Notes is optional — an empty answer is a valid skip (the reducer/flatten drop it).
    dispatch({ type: 'choose', value: notesText.trim() })
  }

  const handleGrounding = (): void => {
    submitCompletedFlow({ state, startingLevel, groundingText, submit, onSubmitted, setNotice, submitting })
  }

  const step = state.step
  const rail = guidedRail(state)
  const counter = railCounter(rail, t)
  let screen: React.JSX.Element
  if (state.complete) {
    screen = (
      <GroundingScreen
        rail={rail}
        counter={counter}
        {...(situation !== undefined ? { situation } : {})}
        groundingWhisper={groundingWhisper}
        value={groundingText}
        onChange={handleGroundingChange}
        onSubmit={handleGrounding}
        onBack={() => {
          dispatch({ type: 'back' })
        }}
        notice={notice}
        t={t}
      />
    )
  } else if (step === 'notes') {
    screen = (
      <NotesScreen
        rail={rail}
        counter={counter}
        value={notesText}
        onChange={handleNotesChange}
        onSubmit={continueNotes}
        onBack={() => {
          dispatch({ type: 'back' })
        }}
        t={t}
      />
    )
  } else {
    // An option step (class / subclass / species / background). The single-option
    // subclass renders as a statement with consent — the lore statement as the
    // question, the sole card preselected, Continue as the single act.
    screen = (
      <GuidedBuilder
        rail={rail}
        counter={counter}
        question={questionFor(step, state.choice, t, resolve)}
        options={optionsFor(step, state.choice.className, resolve)}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNext={commit}
        onBack={() => {
          // The Class step is the flow's first screen: Back leaves to the chooser.
          if (step === 'class') {
            onBack()
            return
          }
          dispatch({ type: 'back' })
        }}
        onSkipToFreeform={onSkipToFreeform}
        labels={builderLabels(t, step)}
      />
    )
  }

  return <Stack gap={5}>{screen}</Stack>
}
