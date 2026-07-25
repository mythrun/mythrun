import { useRef, useState } from 'react'
import { Stack, Text, Button, SeamlessInput, HatchLine } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { createCampaign, useApiContext, isHttpError } from '@mythrun/client-core'

// The campaign-create FREEFORM screen (spec §1, "Start from an idea") — the
// player writes a world concept in one borderless prose field and commits it. A
// quiet eyebrow, the serif question-that-IS-the-label over a `SeamlessInput
// multiline`, a faint hint, then the text-forward Begin + a quiet switch-to-guided
// line. Pure presentation with ONE side effect: Begin calls `createCampaign` and
// fires a neutral intent on success — the screen never navigates itself; the
// controller maps `onCommitted` to the generating route. Composes @mythrun/ui only
// (no ad-hoc UI); every string is an i18n key (R5).

// The freeform floor mirrors the contract's `FreeformSourceSchema.concept.min(20)`
// (a shorter concept is a body-shape bug, not a gate concern): Begin stays disabled
// below it, QUIETLY — no red error, the action simply isn't offered yet.
const MIN_CONCEPT_CHARS = 20

// What B3 renders inline below the field after a failed commit. `rejected` carries
// a calm, already-resolved message (the server's `rejectionMessage`, or a fallback);
// `retry` is the calm try-again nudge for a transient failure. B5 lifts the full
// rejection screen (edit-as-freeform, guided synthesizedConcept) to the controller;
// B3 keeps it minimal + inline and re-enables Begin either way.
type Notice = { kind: 'rejected'; message: string } | { kind: 'retry' }

export interface FreeformScreenProps {
  /** Committed a concept (HTTP 201) → the controller advances to the generating route. */
  onCommitted: (campaignId: string) => void
  /** Chose the quiet switch line → the controller advances to `guided`. */
  onGuided: () => void
  /**
   * Seed text for the concept field (default empty). The rejection screen's
   * "edit as freeform" carries the judged guided concept in here so the player
   * lands on freeform pre-filled; a normal fork → freeform entry omits it. Read
   * once at mount (the screen unmounts between flow steps, so it re-seeds fresh).
   */
  initialConcept?: string
}

/** Pull a non-empty `rejectionMessage` off an HttpError body (nullable per contract). */
function rejectionMessageOf(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'rejectionMessage' in body) {
    const message = (body as { rejectionMessage?: unknown }).rejectionMessage
    if (typeof message === 'string' && message.length > 0) return message
  }
  return null
}

export function FreeformScreen({
  onCommitted,
  onGuided,
  initialConcept = '',
}: FreeformScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const [concept, setConcept] = useState(() => initialConcept)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Synchronous double-submit guard (the character-creation submit's pattern):
  // `busy`/`disabled` are async state, so two clicks in the same tick both pass
  // the disabled check and fire TWO createCampaign calls — a real double-charge
  // on a money-adjacent CTA (2 campaigns + 2 world-gen credits). The ref is set
  // synchronously, so the second click returns immediately.
  const committing = useRef(false)

  const trimmed = concept.trim()
  const ready = trimmed.length >= MIN_CONCEPT_CHARS

  // Map a failed commit to the inline notice. A concept/content rejection shows the
  // server's calm message (or the fallback); anything else — the 503 upstream case
  // AND any unexpected failure — is a calm try-again (Begin re-enables in `finally`).
  const noticeFor = (err: unknown): Notice => {
    if (isHttpError(err) && (err.code === 'concept_rejected' || err.code === 'content_filtered')) {
      return { kind: 'rejected', message: rejectionMessageOf(err.body) ?? t('campaignNew.freeform.rejectedFallback') }
    }
    return { kind: 'retry' }
  }

  const begin = async (): Promise<void> => {
    if (committing.current) return
    committing.current = true
    setNotice(null)
    setBusy(true)
    try {
      const res = await createCampaign(ctx, {
        world: { kind: 'new', source: { mode: 'freeform', concept: trimmed } },
      })
      onCommitted(res.campaignId)
    } catch (err) {
      setNotice(noticeFor(err))
    } finally {
      setBusy(false)
      committing.current = false
    }
  }

  return (
    <Stack gap={6} data-testid="screen-freeform">
      {/* Prompt cluster — the mono kicker hugs the serif question (the field's
          own label), and the hint sits just under the field. One tight group so
          the eye reads "kicker → question → write here → hint" as a unit. */}
      <Stack gap={3}>
        <Text role="ui-label" data-testid="freeform-eyebrow">
          {t('campaignNew.freeform.eyebrow')}
        </Text>
        <SeamlessInput
          multiline
          label={t('campaignNew.freeform.question')}
          value={concept}
          onChange={setConcept}
          data-testid="freeform-input"
        />
        <Text role="ui-caption" data-testid="freeform-hint">
          {t('campaignNew.freeform.hint')}
        </Text>
        {notice ? (
          <Text role="ui-caption" data-testid="freeform-notice">
            {notice.kind === 'rejected' ? notice.message : t('campaignNew.freeform.retry')}
          </Text>
        ) : null}
      </Stack>
      {/* Actions — one primary act, the mode-switch quieted beneath it. */}
      <Stack align="start" gap={4}>
        <Button
          variant="primary"
          loading={busy}
          disabled={!ready || busy}
          onPress={() => { void begin() }}
          data-testid="freeform-begin"
        >
          {t('campaignNew.freeform.begin')}
        </Button>
        {/* The mode-switch hatch — same affordance class as the guided screen's
            (ux-run2 myth-vjl7d): quiet prompt, underlined actionable phrase. */}
        <HatchLine
          data-testid="freeform-switch"
          prompt={t('campaignNew.freeform.switchPrompt')}
          action={t('campaignNew.freeform.switchAction')}
          onPress={onGuided}
        />
      </Stack>
    </Stack>
  )
}
