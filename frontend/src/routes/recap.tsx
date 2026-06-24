import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The shareable session-recap screen (`/campaigns/:id/recap`) — a thin stub.
// Public so a recap link resolves un-authed. NOTE: the URL param shape is
// PROVISIONAL — the backend serves recaps by `sessionId`; the stub must not
// calcify a campaign-id contract (spec §4). Composes @mythrun/ui + an i18n
// placeholder only (R5).
export function RecapRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-recap">
      <Heading level={1}>{t('stub.recap')}</Heading>
      <Text as="p">{t('stub.recap')}</Text>
    </Stack>
  )
}
