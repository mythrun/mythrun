import { useState } from 'react'
import { Stack, Text, Button, Divider } from '@mythrun/ui'

// The play surface's SESSION-LIFECYCLE affordances (myth-lhp99) — the two ways a
// table calls it a night, both in the brand's quiet paper register (no "Session
// Complete!" fanfare):
//
//   • EndSessionControl — a low-emphasis "End session" in the between-turns chrome
//     (never competing with Send or the fiction). It is a `ghost` control that
//     expands to a one-beat inline confirm — no modal. myth-atxhx: it is no longer
//     PERSISTENT. The shell mounts it only once the session is genuinely near its
//     end; the gate lives there (this file stays presentational).
//   • WindDownOffer — a dismissible offer hung off the long rest the engine
//     already detects: "A good place to stop." after a night's rest is the most
//     natural session boundary in the genre.
//
// Both are thin compositions of @mythrun/ui primitives (the same route-side
// composition posture as notices.tsx) — neutral callbacks + resolved i18n labels,
// no cognition, no raw chrome. Confirming / resting fires the caller's
// `endSession()`; the shell owns the transport wire + the farewell-then-recap flow.

/** Resolved copy for the persistent end control + its inline confirm. */
export interface EndSessionLabels {
  /** The resting control ("End session"). */
  readonly control: string
  /** The confirm prompt ("End tonight's session?"). */
  readonly prompt: string
  /** The confirm action ("End session"). */
  readonly confirm: string
  /** The dismiss action ("Keep playing"). */
  readonly cancel: string
  /** The CONSEQUENCE disclosure shown AT the confirm (myth-xxyo9, rewritten by
   *  myth-atxhx). It leads with irreversibility, not cost: because a session is a
   *  play unit rather than a sitting — leave and rejoin any time — a player can
   *  reasonably read an end as banking the remainder for later. It is not. The
   *  session cannot be resumed, and the credit was debited at session START, so
   *  the cost half is record. The old line disclosed only the cost, in a past
   *  tense that read as a RECEIPT: the most reassuring possible framing for the
   *  most destructive available action. */
  readonly disclosure: string
}

/** A low-emphasis end-session control. Resting: a quiet ghost button.
 *  Pressed: a one-beat inline confirm — no modal. myth-xxyo9: BOTH confirm
 *  affordances are bordered `secondary` buttons ("two square outline buttons side
 *  by side is fully in-register" — bare mono text next to a bordered button reads
 *  as a label, not an option). myth-88lmb: the credit disclosure sits under the
 *  QUESTION line, before the decision — under the buttons it read as a
 *  consequence of confirming. `disabled` covers the window after the end is
 *  already in flight (the farewell is rendering; the shell unmounts this control
 *  the moment the confirm lands — the swept transition). */
export function EndSessionControl({
  labels,
  onEnd,
  disabled = false,
}: {
  labels: EndSessionLabels
  onEnd: () => void
  disabled?: boolean
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <Stack direction="row" justify="end" data-testid="end-session-control">
        <Button
          variant="ghost"
          size="sm"
          onPress={() => {
            setConfirming(true)
          }}
          disabled={disabled}
          data-testid="end-session-open"
        >
          {labels.control}
        </Button>
      </Stack>
    )
  }

  return (
    <Stack gap={1} align="end" data-testid="end-session-confirm">
      <Stack direction="row" gap={2} align="start" justify="end" wrap>
        {/* myth-88lmb: the disclosure sits under the QUESTION, not under the
            buttons — right-aligned beneath "End session" it parsed as a
            consequence of confirming ("ending will cost a credit") rather than
            the statement of record it is. myth-atxhx: it now leads with what
            ending forecloses (the session can't be resumed), because that is the
            fact a player is most likely to assume the other way. */}
        <Stack gap={1} align="end">
          <Text role="meta">{labels.prompt}</Text>
          <Text role="meta" data-testid="end-session-disclosure">
            {labels.disclosure}
          </Text>
        </Stack>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => {
            setConfirming(false)
          }}
          data-testid="end-session-cancel"
        >
          {labels.cancel}
        </Button>
        <Button variant="secondary" size="sm" onPress={onEnd} disabled={disabled} data-testid="end-session-do">
          {labels.confirm}
        </Button>
      </Stack>
    </Stack>
  )
}

/** Resolved copy for the wind-down offer. */
export interface WindDownLabels {
  /** The quiet framing line ("A good place to stop."). */
  readonly prompt: string
  /** The end action ("Rest here for now"). */
  readonly rest: string
  /** The dismiss action ("Keep playing"). */
  readonly keep: string
}

/** The wind-down offer, hung off a detected long rest. A hairline sets it apart
 *  from the transcript above; the offer itself is one quiet line + two quiet
 *  affordances. "Rest here for now" ends the session (resumable); "Keep playing"
 *  dismisses. `disabled` covers the already-ending window. */
export function WindDownOffer({
  labels,
  onRest,
  onKeepPlaying,
  disabled = false,
}: {
  labels: WindDownLabels
  onRest: () => void
  onKeepPlaying: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Stack gap={2} data-testid="wind-down-offer">
      <Divider />
      <Stack direction="row" gap={3} align="center" justify="between" wrap>
        <Text role="meta">{labels.prompt}</Text>
        <Stack direction="row" gap={2} align="center">
          <Button
            variant="ghost"
            size="sm"
            onPress={onKeepPlaying}
            data-testid="wind-down-keep"
          >
            {labels.keep}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={onRest}
            disabled={disabled}
            data-testid="wind-down-rest"
          >
            {labels.rest}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  )
}
