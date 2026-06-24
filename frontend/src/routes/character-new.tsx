import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The character-create screen (`/campaigns/:id/character/new`) — a thin stub the
// character-creation flow fills. Composes @mythrun/ui + an i18n placeholder only
// (R5).
export function CharacterNewRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-character-new">
      <Heading level={1}>{t('stub.characterNew')}</Heading>
      <Text as="p">{t('stub.characterNew')}</Text>
    </Stack>
  )
}
