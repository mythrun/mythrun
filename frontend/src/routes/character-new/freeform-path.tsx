import { useRef, useState } from 'react'
import { Stack, Text, FreeformPrompt, SituationRecap } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { StartingSituation } from '@mythrun/client-core'

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
}

export function FreeformPath({
  groundingWhisper,
  situation,
  submit,
  onSubmitted,
}: FreeformPathProps): React.JSX.Element {
  const { t } = useTranslation()
  const [step, setStep] = useState<Step>('concept')
  const [conceptText, setConceptText] = useState('')
  const [groundingText, setGroundingText] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
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
    if (submitting.current) return
    submitting.current = true
    setNotice(null)
    void submit(conceptText.trim(), groundingText.trim())
      .then(() => {
        // On success the route unmounts this path (machine → processing), so the
        // guard is left set — there is nothing here to submit twice into.
        onSubmitted()
      })
      .catch(() => {
        submitting.current = false
        setNotice('error')
      })
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
      {step === 'concept' ? (
        <FreeformPrompt
          stepIndicator={stepIndicator}
          prompt={t('characterCreate.freeform.conceptPrompt')}
          whisper={t('characterCreate.freeform.conceptWhisper')}
          value={conceptText}
          onChange={setConceptText}
          onSubmit={handleConcept}
        />
      ) : (
        <FreeformPrompt
          stepIndicator={stepIndicator}
          prompt={t('characterCreate.freeform.groundingPrompt')}
          whisper={groundingWhisper}
          value={groundingText}
          onChange={setGroundingText}
          onSubmit={handleGrounding}
        />
      )}
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
