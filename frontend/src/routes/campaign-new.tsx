import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The campaign-create screen (`/campaigns/new`) — a thin stub the
// campaign-creation flow fills. Composes @mythrun/ui + an i18n placeholder only
// (R5).
export function CampaignNewRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-campaign-new">
      <Heading level={1}>{t('stub.campaignNew')}</Heading>
      <Text as="p">{t('stub.campaignNew')}</Text>
    </Stack>
  )
}
