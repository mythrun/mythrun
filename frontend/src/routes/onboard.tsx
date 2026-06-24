import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The onboarding screen (`/auth/onboard`) — a thin stub the auth ticket
// (MYT-84) fills. The three-state session store already routes
// `onboarding-required` here; MYT-84 supplies the profile-finalisation flow.
// Composes @mythrun/ui + an i18n placeholder only (R5).
export function OnboardRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-onboard">
      <Heading level={1}>{t('stub.onboard')}</Heading>
      <Text as="p">{t('stub.onboard')}</Text>
    </Stack>
  )
}
