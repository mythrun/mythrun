import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The home hub — a thin stub for W3c. W3e rewrites this to fetch
// `campaigns/mine` through `useMyCampaigns` behind a <Suspense> boundary (the
// done-when #3 wired path). Until then it composes @mythrun/ui + an i18n
// placeholder only (R5), carrying a testid so the router test can assert the
// authed branch resolves here.
export function HomeRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-home">
      <Heading level={1}>{t('stub.home')}</Heading>
      <Text as="p">{t('stub.home')}</Text>
    </Stack>
  )
}
