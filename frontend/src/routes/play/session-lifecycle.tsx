import { useState } from 'react'
import { Stack, Text, Button, Divider } from '@mythrun/ui'

// The play surface's SESSION-LIFECYCLE affordances (myth-lhp99) — the two ways a
// table calls it a night, both in the brand's quiet paper register (no "Session
// Complete!" fanfare):
//
//   • EndSessionControl — a persistent, low-emphasis "End session" that lives in
//     the between-turns chrome (never competing with Send or the fiction). It is
//     a `ghost` control that expands to a one-beat inline confirm — no modal.
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
}

/** A persistent, low-emphasis end-session control. Resting: a quiet ghost button.
 *  Pressed: a one-line inline confirm (prompt + Keep playing / End session) — a
 *  single beat, no modal. `disabled` covers the window after the end is already
 *  in flight (the farewell is rendering). */
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
    <Stack direction="row" gap={2} align="center" justify="end" wrap data-testid="end-session-confirm">
      <Text role="meta">{labels.prompt}</Text>
      <Button
        variant="ghost"
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
