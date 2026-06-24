import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The invite-join screen (`/join/:code`) — a thin stub the multiplayer-invite
// flow fills. Public so an invite link resolves pre-auth. Composes @mythrun/ui
// + an i18n placeholder only (R5).
export function JoinRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-join">
      <Heading level={1}>{t('stub.join')}</Heading>
      <Text as="p">{t('stub.join')}</Text>
    </Stack>
  )
}
