import { useEffect } from 'react'
import { Stack, Text, Button, StreamingProse } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useSynthesisState, type SynthesisStream } from '@mythrun/client-core'
import type { RejectionState } from './rejection.tsx'

// The campaign-create SYNTHESIZING beat (myth-umggn) — the world brief writing
// itself. The guided screen opened the stream (so its calm notices still own
// every pre-stream failure); this screen renders the arriving prose off the
// stream's store (StreamingProse — paper register, ember caret, no spinner)
// and fires ONE neutral intent per terminal:
//
//   - complete  → onSynthesized({previewId, concept}) — the controller swaps
//                 to the preview screen, whose contract is unchanged; the
//                 settled text stays put (identical type classes), the
//                 actions arrive under it.
//   - rejected  → onRejected(rejection) — the streamed text resolves into the
//                 SAME rejection screen the synchronous 422 produced: the
//                 judged concept stays visible there (synthesizedConcept),
//                 with the reason. Nothing the player watched arrive vanishes.
//   - failed / content_filtered → onRejected({code:'content_filtered'}) — the
//                 terminal content-policy dead-end, mirroring the sync route.
//   - failed / anything else → the HALTED partial text stays on the page under
//                 a calm notice + a quiet `try again` (onRetry → back to the
//                 guided picks, which are draft-persisted). No auto-retry: the
//                 stream is a non-idempotent Sonnet call.
//
// Pure presentation + the store subscription: the screen never navigates
// itself and never opens/closes the stream (the controller owns the handle).
// Composes @mythrun/ui only; every string is an i18n key; the PROSE
// renders as data (R5).

export interface SynthesizingScreenProps {
  /** The live synthesis stream the guided screen opened. */
  stream: SynthesisStream
  /** The brief completed and parked (terminal `complete`) → preview screen. */
  onSynthesized: (payload: { previewId: string; concept: string }) => void
  /** The gate rejected the brief (terminal `rejected`), or the content policy
   *  blocked it (terminal `content_filtered`) → rejection screen. */
  onRejected: (rejection: RejectionState) => void
  /** Chose `try again` after a transient failure → back to the guided picks. */
  onRetry: () => void
}

export function SynthesizingScreen({
  stream,
  onSynthesized,
  onRejected,
  onRetry,
}: SynthesizingScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const state = useSynthesisState(stream)

  // Terminal routing runs as an effect (the controller's setState can't run
  // mid-render). Exactly one terminal ever arrives, so this fires once.
  useEffect(() => {
    if (state.status === 'complete') {
      onSynthesized({ previewId: state.previewId, concept: state.concept })
    } else if (state.status === 'rejected') {
      onRejected(state.rejection)
    } else if (state.status === 'failed' && state.code === 'content_filtered') {
      onRejected({ code: 'content_filtered' })
    }
  }, [state, onSynthesized, onRejected])

  // The transient-failure resting state (content_filtered routes away above).
  const failed = state.status === 'failed' && state.code !== 'content_filtered'
  // What the paragraph shows: the accumulated text while streaming (and the
  // halted partial on failure); the authoritative concept once complete (a
  // post-stream repair may have diverged from the streamed text); the judged
  // concept on a rejection — each terminal keeps the prose on the page for the
  // one render before the controller swaps screens.
  const text =
    state.status === 'streaming' || state.status === 'failed'
      ? state.text
      : state.status === 'complete'
        ? state.concept
        : (state.rejection.synthesizedConcept ?? '')

  return (
    <Stack gap={6} data-testid="screen-synthesizing">
      {/* The kicker hugs the brief writing itself (one cluster); a transient
          failure notice + retry sit beneath, matching the funnel hierarchy. */}
      <Stack gap={3}>
        <Text role="ui-label" data-testid="synthesizing-eyebrow">
          {t('campaignNew.synthesizing.eyebrow')}
        </Text>
        {/* The arriving brief holds the SAME reading measure the settled
            preview caps to (ux-run2 myth-ia9v2) — the synthesize → preview
            swap keeps the text seated, no reflow to a wider wall. */}
        <Stack maxWidth="prose">
          <StreamingProse
            data-testid="synthesizing-prose"
            text={text}
            writing={state.status === 'streaming'}
            writingLabel={t('campaignNew.synthesizing.stillWriting')}
          />
        </Stack>
      </Stack>
      {failed ? (
        <Stack gap={3} align="start">
          <Text role="ui-caption" data-testid="synthesizing-failed">
            {t('campaignNew.synthesizing.failed')}
          </Text>
          <Button variant="ghost" size="sm" onPress={onRetry} data-testid="synthesizing-retry">
            {t('campaignNew.synthesizing.tryAgain')}
          </Button>
        </Stack>
      ) : null}
    </Stack>
  )
}
