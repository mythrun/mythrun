import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The public landing screen — a thin stub the landing ticket (MYT-86) fills.
// It composes @mythrun/ui only + an i18n placeholder (R5), and carries a
// `data-testid` so the router test can assert which screen the tree resolved to.
export function LandingRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-landing">
      <Heading level={1}>{t('stub.landing')}</Heading>
      <Text as="p">{t('stub.landing')}</Text>
    </Stack>
  )
}
