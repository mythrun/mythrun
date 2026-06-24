import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The OAuth callback screen (`/auth/callback/:provider`) — a thin stub the auth
// ticket (MYT-84) fills with token exchange. Composes @mythrun/ui + an i18n
// placeholder only (R5).
export function CallbackRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-callback">
      <Heading level={1}>{t('stub.callback')}</Heading>
      <Text as="p">{t('stub.callback')}</Text>
    </Stack>
  )
}
