import { useRef, useState } from 'react'
import { Stack, Text, FreeformPrompt, SituationRecap } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { StartingSituation } from '@mythrun/client-core'
import { useCharacterDraft, type SessionDraftStore } from '@mythrun/client-core/character'

// The FREEFORM PATH (MYT-90, D3) — the "tell us who you are" fork. It collects
// the TWO required submit fields ONE AT A TIME (the calm pacing): first the
// concept ("Who are you?" → conceptText), then the grounding (a second prompt
// whose whisper is the chosen situation's invitation → situationGroundingText).
// Only the current step renders; a valid concept advances to grounding, a valid
// grounding submits BOTH fields via the route-injected `submit`.
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

/** The two one-at-a-time freeform steps — also the step indicator's numerator. */
const TOTAL_STEPS = 2

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
  /** Commit both fields (the route binds ctx + campaignId + the real endpoint). */
  submit: (conceptText: string, situationGroundingText: string) => Promise<void>
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
  submit: (conceptText: string, situationGroundingText: string) => Promise<void>
  onSubmitted: () => void
  setNotice: (notice: Notice) => void
  submitting: { current: boolean }
}): void {
  const { conceptText, groundingText, submit, onSubmitted, setNotice, submitting } = args
  if (submitting.current) return
  submitting.current = true
  setNotice(null)
  void submit(conceptText.trim(), groundingText.trim())
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
  const [notice, setNotice] = useState<Notice>(null)

  const handleConceptChange = (value: string): void => {
    setConceptText(value)
    draft.update({ conceptText: value })
  }
  const handleGroundingChange = (value: string): void => {
    setGroundingText(value)
    draft.update({ groundingText: value })
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
    submitFreeform({ conceptText, groundingText, submit, onSubmitted, setNotice, submitting })
  }

  /** The quiet "N of 2" signpost over the current prompt. */
  const stepIndicator = t('characterCreate.freeform.stepIndicator', {
    current: step === 'concept' ? 1 : TOTAL_STEPS,
    total: TOTAL_STEPS,
  })

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
        stepIndicator={stepIndicator}
        prompt={
          step === 'concept'
            ? t('characterCreate.freeform.conceptPrompt')
            : t('characterCreate.freeform.groundingPrompt')
        }
        whisper={step === 'concept' ? t('characterCreate.freeform.conceptWhisper') : groundingWhisper}
        {...(step === 'concept' ? {} : { whisperVoice: 'dm' as const })}
        value={step === 'concept' ? conceptText : groundingText}
        onChange={step === 'concept' ? handleConceptChange : handleGroundingChange}
        onSubmit={step === 'concept' ? handleConcept : handleGrounding}
        submitLabel={t('characterCreate.freeform.continue')}
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
