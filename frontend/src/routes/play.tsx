import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The live-play screen (`/campaigns/:id/play`) — a thin stub the realtime
// session flow (MYT-85+) fills, adding its collapsible sidebar later (MYT-92).
// Composes @mythrun/ui + an i18n placeholder only (R5).
export function PlayRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-play">
      <Heading level={1}>{t('stub.play')}</Heading>
      <Text as="p">{t('stub.play')}</Text>
    </Stack>
  )
}
