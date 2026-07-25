import { useRef, useState } from 'react'
import { Stack, Text, Button, SeamlessInput, HatchLine } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  startSynthesisStream,
  useApiContext,
  isHttpError,
  type SynthesisStream,
} from '@mythrun/client-core'

// The campaign-create FREEFORM screen (spec §1, "Start from an idea") — the
// player writes a world concept in one borderless prose field and sends it on. A
// quiet eyebrow, the serif question-that-IS-the-label over a `SeamlessInput
// multiline`, a faint hint, then the text-forward primary + a quiet
// switch-to-brainstorm line.
//
// myth-6t06f: the primary no longer commits ~10 minutes of world generation. It
// opens the SAME synthesis stream the brainstorm path opens (`startSynthesisStream`
// with the concept instead of picks), so this path lands on the proposal
// checkpoint — read it back, adjust it once, then Begin — instead of buying the
// whole world sight-unseen. That makes this screen's error surface identical to
// the brainstorm screen's: the gate verdict is now a TERMINAL FRAME the
// synthesizing screen routes to the rejection screen, so only the pre-stream
// guard trips (429 cooldown, 403 credits, transient) stay here as calm inline
// notices.
//
// Pure presentation with ONE side effect: the primary opens the stream and fires
// a neutral intent — the screen never navigates itself; the controller owns the
// stream handle and the screens. Composes @mythrun/ui only (no ad-hoc UI); every
// string is an i18n key (R5).

// The freeform floor mirrors the contract's `SynthesizeConceptRequestSchema.concept
// .min(20)` (a shorter concept is a body-shape bug, not a gate concern): the
// primary stays disabled below it, QUIETLY — no red error, the action simply isn't
// offered yet.
const MIN_CONCEPT_CHARS = 20

// A transient, calm inline notice after a failed OPEN — the brainstorm screen's
// exact set (myth-6t06f), because the two screens now open the same stream and
// meet the same guard chain: `retry` for a transient failure, `cooldown` after a
// rejection-storm rate limit, `credits` when the balance can't cover world-gen.
interface Notice {
  kind: 'retry' | 'cooldown' | 'credits'
}

export interface FreeformScreenProps {
  /** The synthesis stream OPENED (200 head) → the controller advances to the
   *  synthesizing screen, which renders the arriving proposal and routes the
   *  terminals (complete → preview, rejected/content_filtered → rejection). */
  onStreaming: (stream: SynthesisStream) => void
  /** Chose the quiet switch line → the controller advances to `guided`. */
  onGuided: () => void
  /**
   * Seed text for the concept field (default empty). The controller seeds it from
   * the persisted world-concept draft (myth-5fi4q) and keeps it current as the
   * player types; the rejection screen's "edit as freeform" drops the judged
   * guided concept in the same way. Read once at mount (the screen unmounts
   * between flow steps, so it re-seeds from whatever the controller now holds).
   */
  initialConcept?: string
  /**
   * Fired with the concept on every keystroke — the controller persists it so a
   * reload never costs the player the world they had already described
   * (myth-5fi4q). Omitted, the field is simply not persisted.
   */
  onConceptChange?: (concept: string) => void
}

/** Map an OPEN failure to its calm inline notice — the brainstorm screen's
 *  `noticeFor`, verbatim. The gate verdicts (concept_rejected /
 *  content_filtered) can no longer arrive here: the gate runs after the stream
 *  opens, so those are the synthesizing screen's terminals. */
function noticeFor(err: unknown): Notice {
  if (isHttpError(err)) {
    if (err.code === 'rejection_storm_cooldown') return { kind: 'cooldown' }
    if (err.code === 'insufficient_credits') return { kind: 'credits' }
  }
  return { kind: 'retry' }
}

export function FreeformScreen({
  onStreaming,
  onGuided,
  initialConcept = '',
  onConceptChange,
}: FreeformScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const [concept, setConcept] = useState(() => initialConcept)
  const changeConcept = (next: string): void => {
    setConcept(next)
    onConceptChange?.(next)
  }
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Synchronous double-submit guard (the character-creation submit's pattern):
  // `busy`/`disabled` are async state, so two clicks in the same tick both pass
  // the disabled check and fire TWO synthesis streams — two Sonnet burns, and a
  // second stream handle the controller would leak past the first. The ref is
  // set synchronously, so the second click returns immediately.
  const committing = useRef(false)

  const trimmed = concept.trim()
  const ready = trimmed.length >= MIN_CONCEPT_CHARS

  const draft = async (): Promise<void> => {
    if (committing.current) return
    committing.current = true
    setNotice(null)
    setBusy(true)
    try {
      // The concept IS the synthesis input (myth-6t06f) — same endpoint, same
      // stream, same terminals as the brainstorm path's picks.
      const stream = await startSynthesisStream(ctx, { concept: trimmed })
      // The draft is NOT cleared here: it survives synthesize → proposal so a
      // "start over" (or a rejection) returns the player to their own words.
      // The controller clears it only once a campaign is actually committed.
      onStreaming(stream)
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
          onChange={changeConcept}
          // Typing is the screen's one next action (ux-run3 myth-en2jj) — the
          // field takes focus on entry; the paper focus stroke marks it.
          focusOnMount
          data-testid="freeform-input"
        />
        <Text role="ui-caption" data-testid="freeform-hint">
          {t('campaignNew.freeform.hint')}
        </Text>
        {notice ? (
          <Text role="ui-caption" data-testid="freeform-notice">
            {t(`campaignNew.freeform.${notice.kind}`)}
          </Text>
        ) : null}
      </Stack>
      {/* Actions — one primary act, the mode-switch quieted beneath it. */}
      <Stack align="start" gap={4}>
        <Stack gap={2}>
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready || busy}
            onPress={() => { void draft() }}
            data-testid="freeform-draft"
          >
            {t('campaignNew.freeform.draft')}
          </Button>
          {/* The disclosure at the trigger (ux-run3 myth-g3mt6). Since
              myth-6t06f this act drafts a proposal rather than buying the
              world, so it wears the brainstorm trigger's line — a minute, and
              everything is still revisable. The world-build disclosure now sits
              where the world is actually bought: the proposal's Begin. */}
          <Text role="meta" data-testid="freeform-cost">
            {t('campaignNew.freeform.cost')}
          </Text>
        </Stack>
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
