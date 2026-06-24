import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The settings screen (`/settings`) — a thin stub the settings flow fills.
// Composes @mythrun/ui + an i18n placeholder only (R5).
export function SettingsRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-settings">
      <Heading level={1}>{t('stub.settings')}</Heading>
      <Text as="p">{t('stub.settings')}</Text>
    </Stack>
  )
}
