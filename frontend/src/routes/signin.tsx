import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The sign-in screen — a thin stub the auth ticket (MYT-84) fills with the
// OAuth acquisition flow. Composes @mythrun/ui + an i18n placeholder only (R5).
export function SigninRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-signin">
      <Heading level={1}>{t('stub.signin')}</Heading>
      <Text as="p">{t('stub.signin')}</Text>
    </Stack>
  )
}
