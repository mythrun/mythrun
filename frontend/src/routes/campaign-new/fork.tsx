import { Stack, Heading, Text, GhostChoiceList } from '@mythrun/ui'
import type { GhostChoiceItem } from '@mythrun/client-core/contract'
import { useTranslation } from 'react-i18next'

// The campaign-create FORK (spec §2) — the flow's first moment. A quiet eyebrow,
// the serif question-that-frames-the-choice, an italic lede, then the two paths as
// a borderless `GhostChoiceList`: "Start from an idea" (→ the freeform screen) and
// "Build from what you love" (→ the guided screen). Pure presentation — it fires
// two neutral intents and knows nothing of the state machine; the controller maps
// each to a `screen`. Composes @mythrun/ui only (no ad-hoc UI); every string is an
// i18n key (R5).
export interface ForkScreenProps {
  /** Chose "Start from an idea" → the controller advances to `freeform`. */
  onFreeform: () => void
  /** Chose "Build from what you love" → the controller advances to `guided`. */
  onGuided: () => void
}

export function ForkScreen({ onFreeform, onGuided }: ForkScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const choices: GhostChoiceItem[] = [
    {
      id: 'freeform',
      title: t('campaignNew.fork.idea.title'),
      subtitle: t('campaignNew.fork.idea.subtitle'),
      onSelect: onFreeform,
    },
    {
      id: 'guided',
      title: t('campaignNew.fork.love.title'),
      subtitle: t('campaignNew.fork.love.subtitle'),
      onSelect: onGuided,
    },
  ]
  return (
    <Stack gap={6} data-testid="screen-fork">
      <Stack gap={2}>
        <Text role="ui-label" data-testid="fork-eyebrow">
          {t('campaignNew.fork.eyebrow')}
        </Text>
        <Heading level={1} role="title" data-testid="fork-question">
          {t('campaignNew.fork.question')}
        </Heading>
        <Text role="subtitle" as="p" data-testid="fork-lede">
          {t('campaignNew.fork.lede')}
        </Text>
      </Stack>
      <GhostChoiceList items={choices} data-testid="fork-choices" />
    </Stack>
  )
}
