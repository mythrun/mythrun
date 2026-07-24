import { Stack, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { ConceptRejection } from '@mythrun/client-core'

// The shared concept-REJECTION screen (spec §1) — the calm dead-end the create
// flow lands on when a concept can't seed a world. Two shapes reach it:
//
//   - `concept_rejected` (the input gate's verdict): shows the server's
//     already-resolved `rejectionMessage` (NEVER the model's raw reasoning —
//     Roc-Imp6), and — on the GUIDED path (the payload carries a
//     `synthesizedConcept`) — the concept that was judged plus an "edit as
//     freeform" affordance that carries that text into the freeform screen so
//     the player can adjust it themselves.
//   - `content_filtered` (Anthropic's content policy blocked the prompt): a
//     distinct TERMINAL message — retrying hits the same filter on the same
//     text, so no rework/edit is offered; the only way forward is to start over.
//
// Pure presentation firing NEUTRAL intents (`onEditAsFreeform` /
// `onStartOver`) — it never navigates itself; the controller maps them to
// screens. Composes @mythrun/ui only (no ad-hoc UI); every string is an i18n
// key (R5).

/**
 * A rejection the create flow can carry to the shared rejection screen: the
 * input gate's `concept_rejected` verdict (with a player-facing message and, on
 * the guided path, the synthesized concept that was judged) OR the terminal
 * `content_filtered` (the content policy blocked the prompt — no retry).
 */
export type RejectionState = ConceptRejection | { code: 'content_filtered' }

export interface RejectionScreenProps {
  /** The rejection to render (a gate verdict or the terminal content-filter). */
  rejection: RejectionState
  /** Chose "edit as freeform" (guided only) → the controller drops into freeform pre-filled with the judged concept. */
  onEditAsFreeform: (concept: string) => void
  /** Chose "start over" → the controller returns to the guided picks. */
  onStartOver: () => void
}

// The terminal content-filter variant: a calm distinct message + the only exit
// (start over) — no retry, since the same prompt would hit the same filter.
function FilteredRejection({ onStartOver }: { onStartOver: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={6} data-testid="screen-rejection">
      <Stack gap={3}>
        <Text role="ui-label" data-testid="rejection-eyebrow">
          {t('campaignNew.rejection.eyebrow')}
        </Text>
        <Text role="prose-body" as="p" data-testid="rejection-message">
          {t('campaignNew.rejection.filteredMessage')}
        </Text>
      </Stack>
      <Stack align="start">
        <Button variant="ghost" size="sm" onPress={onStartOver} data-testid="rejection-start-over">
          {t('campaignNew.rejection.startOver')}
        </Button>
      </Stack>
    </Stack>
  )
}

export function RejectionScreen({
  rejection,
  onEditAsFreeform,
  onStartOver,
}: RejectionScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  if (rejection.code === 'content_filtered') {
    return <FilteredRejection onStartOver={onStartOver} />
  }
  // A null rejectionMessage means the model declined to author one — fall back
  // to the calm generic line rather than surfacing anything raw.
  const message = rejection.rejectionMessage ?? t('campaignNew.rejection.fallback')
  const judged = rejection.synthesizedConcept
  return (
    <Stack gap={6} data-testid="screen-rejection">
      {/* Kicker hugs the rejection message; the judged concept (guided only) is a
          distinct labelled block below, then the actions. */}
      <Stack gap={3}>
        <Text role="ui-label" data-testid="rejection-eyebrow">
          {t('campaignNew.rejection.eyebrow')}
        </Text>
        <Text role="prose-body" as="p" data-testid="rejection-message">
          {message}
        </Text>
      </Stack>
      {judged !== undefined ? (
        <Stack gap={2}>
          <Text role="ui-label" data-testid="rejection-concept-label">
            {t('campaignNew.rejection.judged')}
          </Text>
          <Text role="prose-body" as="p" data-testid="rejection-concept">
            {judged}
          </Text>
        </Stack>
      ) : null}
      <Stack direction="row" gap={3} align="center">
        {judged !== undefined ? (
          <Button
            variant="primary"
            onPress={() => { onEditAsFreeform(judged) }}
            data-testid="rejection-edit-freeform"
          >
            {t('campaignNew.rejection.editAsFreeform')}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onPress={onStartOver} data-testid="rejection-start-over">
          {t('campaignNew.rejection.startOver')}
        </Button>
      </Stack>
    </Stack>
  )
}
