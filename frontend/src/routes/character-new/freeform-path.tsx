import { useRef, useState } from 'react'
import { Stack, Text, FreeformPrompt } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The FREEFORM PATH (MYT-90, D3) — the "tell us who you are" fork. It collects
// the TWO required submit fields ONE AT A TIME (the calm pacing): first the
// concept ("Who are you?" → conceptText), then the grounding (a second prompt
// whose whisper is the chosen situation's invitation → situationGroundingText).
// Only the current step renders; a valid concept advances to grounding, a valid
// grounding submits BOTH fields via the route-injected `submit`.
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

export interface FreeformPathProps {
  /** The grounding step's whisper — the chosen situation's LLM-authored
   *  invitation (or the route's generic fallback when none is chosen). */
  groundingWhisper: string
  /** Commit both fields (the route binds ctx + campaignId + the real endpoint). */
  submit: (conceptText: string, situationGroundingText: string) => Promise<void>
  /** A successful submit — the route advances the create-machine to `processing`. */
  onSubmitted: () => void
}

export function FreeformPath({ groundingWhisper, submit, onSubmitted }: FreeformPathProps): React.JSX.Element {
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

  return (
    <Stack gap={5}>
      {step === 'concept' ? (
        <FreeformPrompt
          prompt={t('characterCreate.freeform.conceptPrompt')}
          whisper={t('characterCreate.freeform.conceptWhisper')}
          value={conceptText}
          onChange={setConceptText}
          onSubmit={handleConcept}
        />
      ) : (
        <FreeformPrompt
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
