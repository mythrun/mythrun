import { useRef, useState } from 'react'
import { Stack, Text, FreeformPrompt, SituationRecap } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { StartingSituation } from '@mythrun/client-core'
import {
  useCharacterDraft,
  toPronounChoice,
  pronounsPick,
  type PronounChoice,
  type SessionDraftStore,
} from '@mythrun/client-core/character'
import type { GuidedChoicesPayload } from '@mythrun/client-core'
import { PronounAside } from './pronoun-aside.tsx'

// The FREEFORM PATH (MYT-90, D3) — the "tell us who you are" fork. It collects
// the TWO required submit fields ONE AT A TIME (the calm pacing): first the
// concept ("Who are you?" → conceptText), then the grounding (a second prompt
// whose whisper is the chosen situation's invitation → situationGroundingText).
// Only the current step renders; a valid concept advances to grounding, a valid
// grounding submits BOTH fields via the route-injected `submit`.
//
// myth-gdycq: the concept step also carries the optional PRONOUN ask in the
// prompt's quiet aside slot — the same ask the guided builder puts on its notes
// step, so neither path is the one where the player never got to say.
//
// MYT-102 grounding + signposting: the chosen situation's RECAP (title, location,
// scene prose — LLM DATA) sits above the prompt on BOTH steps, so the player
// writes against the actual opening scene rather than a memory of the pick
// screen; and each prompt carries the quiet "1 of 2" step indicator so nobody
// front-loads their whole answer into the first question.
//
// Each field mirrors the backend body floor (min 20). A too-short answer is a
// calm inline notice (never a red error), not a submit — the same quiet
// ui-caption notice the app uses elsewhere. A failed submit resurfaces the
// freeform path with a calm retry notice; a successful one hands control back to
// the route (`onSubmitted`), which advances the create-machine to `processing`.

/** The minimum characters each freeform field carries — mirrors the backend
 *  `SubmitCharacterBodySchema` (`.min(20)`), so a too-short answer is caught here
 *  as a calm nudge rather than bouncing off the request boundary as a 400. */
const MIN_CHARS = 20

/** Which of the two one-at-a-time freeform steps is showing. */
type Step = 'concept' | 'grounding'
/** The calm inline notice state: a too-short nudge, a failed-submit retry, or none. */
type Notice = 'tooShort' | 'error' | null

/** The chosen situation's recap slice — LLM DATA the recap card renders verbatim
 *  (the fetched `StartingSituation` is assignable to it; the paths never need the
 *  index or the invitation, which rides separately as the grounding whisper). */
export type SituationRecapData = Pick<StartingSituation, 'title' | 'locationName' | 'prose'>

export interface FreeformPathProps {
  /** The grounding step's whisper — the chosen situation's LLM-authored
   *  invitation (or the route's generic fallback when none is chosen). */
  groundingWhisper: string
  /** The chosen situation's recap (MYT-102) — undefined while the fetch is
   *  pending / failed, or when no situation is chosen (legacy worlds): the
   *  prompts then render without the recap card, exactly as before. */
  situation?: SituationRecapData
  /** Commit both fields plus any structured picks (the route binds ctx +
   *  campaignId + the real endpoint). myth-gdycq: the freeform path carries the
   *  optional PRONOUN pick on the same wire field the guided builder uses, so
   *  the backend pins it identically on both paths. */
  submit: (
    conceptText: string,
    situationGroundingText: string,
    guidedChoices?: GuidedChoicesPayload,
  ) => Promise<void>
  /** A successful submit — the route advances the create-machine to `processing`. */
  onSubmitted: () => void
  /** Leave the freeform path for the CHOOSER (the route dispatches the create-machine
   *  `back`). Invoked from the concept step's Back; the grounding step's Back steps
   *  in-path to the concept first. The draft is already persisted, so returning to
   *  the chooser — or switching paths — never loses the player's words. */
  onBack: () => void
  /** Player-input durability: the localStorage-backed draft store + the campaign it
   *  is keyed by. The path seeds its fields from the persisted draft on EVERY mount
   *  (so re-entering the flow — after a failure, "Start over", or a back-to-chooser
   *  round-trip — restores the words) and persists each keystroke. Absent store →
   *  persistence is a no-op (tests / native shell before it wires one). */
  store?: SessionDraftStore | null
  campaignId: string
}

/** Submit both fields; a failure re-opens the path with a calm retry notice.
 *  The `submitting` ref is a synchronous double-press guard — on success the
 *  route unmounts the path, so the guard stays set. */
function submitFreeform(args: {
  conceptText: string
  groundingText: string
  pronouns: PronounChoice
  submit: FreeformPathProps['submit']
  onSubmitted: () => void
  setNotice: (notice: Notice) => void
  submitting: { current: boolean }
}): void {
  const { conceptText, groundingText, pronouns, submit, onSubmitted, setNotice, submitting } = args
  if (submitting.current) return
  submitting.current = true
  setNotice(null)
  // The default choice contributes NOTHING to the body — its absence is what
  // tells the chargen prompt to read the description (myth-gdycq).
  void submit(conceptText.trim(), groundingText.trim(), pronounsPick(pronouns))
    .then(() => {
      onSubmitted()
    })
    .catch(() => {
      submitting.current = false
      setNotice('error')
    })
}

export function FreeformPath({
  groundingWhisper,
  situation,
  submit,
  onSubmitted,
  onBack,
  store,
  campaignId,
}: FreeformPathProps): React.JSX.Element {
  const { t } = useTranslation()
  // Seed from the persisted draft, read once per MOUNT (the hook's `initial`). A
  // remount — the player re-entering freeform after a back-to-chooser, a failure, or
  // a reload — re-reads the current draft, so their words come back. Persisting on
  // every keystroke keeps that draft current.
  const draft = useCharacterDraft(store ?? null, campaignId)
  // Restore-on-mount lands on the concept step so the player reviews the restored
  // concept before re-confirming; the WORDS are what must survive, not the cursor.
  const [step, setStep] = useState<Step>('concept')
  const [conceptText, setConceptText] = useState(draft.initial.conceptText ?? '')
  const [groundingText, setGroundingText] = useState(draft.initial.groundingText ?? '')
  // The pronoun pick is player input like any other — restored on mount and
  // persisted on change, so a Start over / reload never silently drops it.
  const [pronouns, setPronouns] = useState<PronounChoice>(() =>
    toPronounChoice(draft.initial.pronouns),
  )
  const [notice, setNotice] = useState<Notice>(null)

  const handleConceptChange = (value: string): void => {
    setConceptText(value)
    draft.update({ conceptText: value })
  }
  const handleGroundingChange = (value: string): void => {
    setGroundingText(value)
    draft.update({ groundingText: value })
  }
  const handlePronounsChange = (choice: PronounChoice): void => {
    setPronouns(choice)
    draft.update({ pronouns: choice })
  }

  /** Back: from grounding, step in-path to the concept (keeping both fields); from
   *  the concept step, leave to the chooser. Either way nothing typed is lost — the
   *  draft is already persisted. */
  const handleBack = (): void => {
    if (step === 'grounding') {
      setNotice(null)
      setStep('concept')
      return
    }
    onBack()
  }
  // A synchronous in-flight guard (a ref, not state — a double-press fires before
  // a state update would flush) so a second Continue can't fire a second submit.
  const submitting = useRef(false)

  const handleConcept = (): void => {
    if (conceptText.trim().length < MIN_CHARS) {
      setNotice('tooShort')
      return
    }
    setNotice(null)
    setStep('grounding')
  }

  const handleGrounding = (): void => {
    if (groundingText.trim().length < MIN_CHARS) {
      setNotice('tooShort')
      return
    }
    submitFreeform({
      conceptText,
      groundingText,
      pronouns,
      submit,
      onSubmitted,
      setNotice,
      submitting,
    })
  }

  /** The quiet NAMED signpost over the current prompt (ux-run3 myth-7ceqw c):
   *  "1 of 2 · Who you are" — the count tells the player another question
   *  follows, the name tells them what each door asks, so nobody front-loads
   *  their whole answer into the first. */
  const stepIndicator = t(
    step === 'concept'
      ? 'characterCreate.freeform.stepConcept'
      : 'characterCreate.freeform.stepGrounding',
  )
  const currentValue = step === 'concept' ? conceptText : groundingText

  return (
    <Stack gap={5}>
      {/* The opening scene, kept in view on both steps (MYT-102). Title/location/
          prose are LLM DATA; only the eyebrow is catalog chrome. */}
      {situation !== undefined && (
        <SituationRecap
          eyebrow={t('characterCreate.recap.eyebrow')}
          title={situation.title}
          locationName={situation.locationName}
          prose={situation.prose}
        />
      )}
      {/* The quiet Back rides the prompt's action row — the flow's ONE Back
          position (ux-run2 myth-80an1, matching the guided path): the concept
          step leaves to the chooser; the grounding step steps back in-path. The
          grounding whisper is the situation's bespoke invitation — the DM's
          voice, promoted past hint chrome (ux-run2 myth-4gnrp). */}
      <FreeformPrompt
        // Remount per step so focusOnMount re-fires — each step's one next
        // action is typing (ux-run3 myth-en2jj).
        key={step}
        focusOnMount
        stepIndicator={stepIndicator}
        prompt={
          step === 'concept'
            ? t('characterCreate.freeform.conceptPrompt')
            : t('characterCreate.freeform.groundingPrompt')
        }
        whisper={step === 'concept' ? t('characterCreate.freeform.conceptWhisper') : groundingWhisper}
        {...(step === 'concept' ? {} : { whisperVoice: 'dm' as const })}
        // The grounding step answers a long DM invitation with a sentence or
        // two, so it takes the detail floor rather than the essay floor — the
        // essay floor walked the field's own bottom edge and the Continue off
        // a 1280x720 frame (ux-run3 myth-21lpi). The concept step keeps the
        // essay floor: "Who are you?" is the blank page that wants room.
        compact={step === 'grounding'}
        value={currentValue}
        onChange={step === 'concept' ? handleConceptChange : handleGroundingChange}
        onSubmit={step === 'concept' ? handleConcept : handleGrounding}
        submitLabel={t('characterCreate.freeform.continue')}
        // Honest gating (myth-7ceqw b): Continue stands down while the field is
        // empty; the too-short floor below MIN_CHARS stays a calm notice.
        submitDisabled={currentValue.trim() === ''}
        // The grounding Continue is the character-generation trigger — it
        // carries the commit disclosure (myth-g3mt6).
        {...(step === 'grounding' && { submitHint: t('characterCreate.freeform.cost') })}
        // myth-gdycq: the pronoun ask rides the CONCEPT step — the moment the
        // player is describing who this character is — not the grounding step,
        // which is about the scene. Optional and quiet; the default commits to
        // nothing.
        {...(step === 'concept' && {
          aside: <PronounAside value={pronouns} onChange={handlePronounsChange} />,
        })}
        onBack={handleBack}
        backLabel={t('back')}
      />
      {notice !== null ? (
        <Text role="ui-caption" as="p" data-testid="freeform-notice">
          {notice === 'tooShort'
            ? t('characterCreate.freeform.tooShort')
            : t('characterCreate.freeform.error')}
        </Text>
      ) : null}
    </Stack>
  )
}
