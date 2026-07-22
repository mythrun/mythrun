import { useEffect, useReducer, useRef, useState } from 'react'
import { Stack, Text, GuidedBuilder, GuidedRail, FreeformPrompt, SituationRecap } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  initialGuidedState,
  guidedReducer,
  guidedRail,
  guidedChoice,
  flattenToConceptText,
  type GuidedChoiceDraft,
} from '@mythrun/client-core/character'
import { CLASS_OPTIONS, SPECIES, BACKGROUNDS } from '@mythrun/client-core/srd'
import type { GuidedOption, GuidedStep, RailStep } from '@mythrun/client-core/contract'
import type { SituationRecapData } from './freeform-path.tsx'

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
// A completed run submits BOTH the flattened conceptText AND situationGroundingText
// via the route-injected `submit`; `onSkipToFreeform` abandons to the freeform fork.
//
// MYT-102 signposting + grounding: the builder-less free-text screens keep the
// journey's progress rail — the standalone <GuidedRail> renders the same
// `guidedRail(state)` rungs the builder shows (Notes `now` on the coda; every pick
// `done` + the rail-only Grounding rung `now` once the flow completes) — so the
// signposting never disappears at the exact moment the option grids do. The
// grounding screen additionally keeps the chosen situation's RECAP (LLM DATA) in
// view above the prompt, so "how do you come to be here?" is answered against the
// actual opening scene.
//
// Options map SRD → cards: each option's `id` is the value the reducer commits (the
// class ID for `class`; the canonical English SRD name for the rest — the locale-
// independent flatten input), while the shown `name` is an i18n catalog key, never
// the canonical name. The rail labels + chosen values come straight from the reducer's
// `guidedRail` selector.

/** The grounding field's minimum characters — mirrors the backend
 *  `SubmitCharacterBodySchema` (`.min(20)`), so a too-short answer is a calm nudge
 *  here rather than a 400 at the request boundary. The flattened conceptText always
 *  clears the floor, so only the grounding field needs the check. */
const MIN_CHARS = 20

/** The four option-grid steps (Notes is free text; it renders a FreeformPrompt). */
type OptionStep = Exclude<GuidedStep, 'notes'>

/** A minimal `t` — the option builders only ever resolve a key to a string. */
type Translate = (key: string) => string

/** The resolved hero-question catalog key per option step. */
const OPTION_QUESTION_KEY: Record<OptionStep, string> = {
  class: 'characterCreate.guided.class.question',
  subclass: 'characterCreate.guided.subclass.question',
  species: 'characterCreate.guided.species.question',
  background: 'characterCreate.guided.background.question',
}

/** The current step's option cards. `id` is the exact value the reducer commits;
 *  `name` is an i18n display key (never the canonical name); `description` is
 *  intentionally empty (name-only cards) — per-option flavour copy is out of scope
 *  for these cards. */
function optionsFor(step: OptionStep, className: string | undefined, t: Translate): GuidedOption[] {
  switch (step) {
    case 'class':
      return CLASS_OPTIONS.map((option) => ({
        id: option.id,
        name: t(`characterCreate.guided.class.options.${option.id}.name`),
        description: '',
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
        description: '',
      }))
    case 'background':
      return BACKGROUNDS.map((name) => ({
        id: name,
        name: t(`characterCreate.guided.background.options.${name}.name`),
        description: '',
      }))
  }
}

/** The value already committed for a step — used to re-select the prior pick when the
 *  player steps Back, so Next works without re-clicking. Undrafted steps (and the
 *  free-text Notes step) start unselected. */
function draftValueForStep(step: GuidedStep, choice: GuidedChoiceDraft): string | null {
  switch (step) {
    case 'class':
      return choice.className ?? null
    case 'subclass':
      return choice.subclass ?? null
    case 'species':
      return choice.species ?? null
    case 'background':
      return choice.background ?? null
    case 'notes':
      return null
  }
}

/** The calm inline notice on the grounding step: a too-short nudge, a failed-submit
 *  retry, or none. */
type Notice = 'tooShort' | 'error' | null

/** The post-complete GROUNDING screen — the second required field, collected
 *  exactly as the freeform path does, with the journey rail (every pick done,
 *  Grounding `now`) and the opening-scene recap kept in view above the prompt
 *  (MYT-102). */
function GroundingScreen({
  rail,
  situation,
  groundingWhisper,
  value,
  onChange,
  onSubmit,
  notice,
  t,
}: {
  rail: RailStep[]
  situation?: SituationRecapData
  groundingWhisper: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  notice: Notice
  t: TFunction
}): React.JSX.Element {
  return (
    <>
      <GuidedRail rail={rail} />
      {situation !== undefined && (
        <SituationRecap
          eyebrow={t('characterCreate.recap.eyebrow')}
          title={situation.title}
          locationName={situation.locationName}
          prose={situation.prose}
        />
      )}
      <FreeformPrompt
        prompt={t('characterCreate.freeform.groundingPrompt')}
        whisper={groundingWhisper}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        submitLabel={t('characterCreate.freeform.continue')}
      />
      {notice !== null ? (
        <Text role="ui-caption" as="p" data-testid="guided-notice">
          {notice === 'tooShort'
            ? t('characterCreate.freeform.tooShort')
            : t('characterCreate.freeform.error')}
        </Text>
      ) : null}
    </>
  )
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
  /** Commit both fields (the route binds ctx + campaignId + the real endpoint). */
  submit: (conceptText: string, situationGroundingText: string) => Promise<void>
  /** A successful submit — the route advances the create-machine to `processing`. */
  onSubmitted: () => void
  /** Abandon the guided path for the freeform fork (the route switches the
   *  create-machine back with `skipToFreeform`). */
  onSkipToFreeform: () => void
}

export function GuidedPath({
  startingLevel,
  groundingWhisper,
  situation,
  submit,
  onSubmitted,
  onSkipToFreeform,
}: GuidedPathProps): React.JSX.Element {
  const { t } = useTranslation()
  // The i18n key augmentation types `t` to the catalog's literal keys, which rejects
  // the RUNTIME-computed option keys (`…options.${id}.name`). The `defaultValue`
  // overload accepts a plain `string` key — so `resolve` is the cast-free adapter for
  // the dynamic keys (the key is echoed as its own fallback; the lockstep test
  // guarantees every key exists, so the fallback never actually surfaces).
  const resolve: Translate = (key) => t(key, { defaultValue: key })
  const [state, dispatch] = useReducer(guidedReducer, startingLevel, initialGuidedState)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notesText, setNotesText] = useState('')
  const [groundingText, setGroundingText] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  // A synchronous in-flight guard (a ref, not state — a double-press fires before a
  // state flush) so a second Continue can't fire a second submit.
  const submitting = useRef(false)

  // Re-derive the pre-commit selection from the committed draft whenever the step
  // changes — so stepping Back lands on the prior pick already selected.
  useEffect(() => {
    setSelectedId(draftValueForStep(state.step, state.choice))
  }, [state.step, state.choice])

  const commit = (): void => {
    if (selectedId === null) return
    dispatch({ type: 'choose', value: selectedId })
  }

  const continueNotes = (): void => {
    // Notes is optional — an empty answer is a valid skip (the reducer/flatten drop it).
    dispatch({ type: 'choose', value: notesText.trim() })
  }

  const handleGrounding = (): void => {
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
    void submit(conceptText, groundingText.trim())
      .then(() => {
        // On success the route unmounts this path (machine → processing), so the guard
        // is left set — there is nothing here to submit twice into.
        onSubmitted()
      })
      .catch(() => {
        submitting.current = false
        setNotice('error')
      })
  }

  const step = state.step
  let screen: React.JSX.Element
  if (state.complete) {
    screen = (
      <GroundingScreen
        rail={guidedRail(state)}
        {...(situation !== undefined ? { situation } : {})}
        groundingWhisper={groundingWhisper}
        value={groundingText}
        onChange={setGroundingText}
        onSubmit={handleGrounding}
        notice={notice}
        t={t}
      />
    )
  } else if (step === 'notes') {
    // The optional free-text coda — a FreeformPrompt, not an option grid; the
    // rail persists above it (Notes `now`) so the journey stays signposted.
    screen = (
      <>
        <GuidedRail rail={guidedRail(state)} />
        <FreeformPrompt
          prompt={t('characterCreate.guided.notes.prompt')}
          whisper={t('characterCreate.guided.notes.whisper')}
          value={notesText}
          onChange={setNotesText}
          onSubmit={continueNotes}
          submitLabel={t('characterCreate.freeform.continue')}
        />
      </>
    )
  } else {
    // An option step (class / subclass / species / background).
    screen = (
      <GuidedBuilder
        rail={guidedRail(state)}
        question={resolve(OPTION_QUESTION_KEY[step])}
        options={optionsFor(step, state.choice.className, resolve)}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNext={commit}
        onBack={() => {
          dispatch({ type: 'back' })
        }}
        onSkipToFreeform={onSkipToFreeform}
        labels={{
          next: t('characterCreate.guided.next'),
          back: t('characterCreate.guided.back'),
          switchToFreeform: t('characterCreate.guided.switchToFreeform'),
        }}
      />
    )
  }

  return <Stack gap={5}>{screen}</Stack>
}
