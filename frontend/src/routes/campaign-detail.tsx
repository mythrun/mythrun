import { Stack, Heading, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The campaign-detail screen (`/campaigns/:id`) — the home-hub card's click
// target. A thin interim stub (mirrors the other flow stubs) so a card click
// resolves to a real screen instead of falling through to the 404; the real
// detail surface (a modal/sheet) is a later ticket's concern. Composes
// @mythrun/ui + an i18n placeholder only (R5).
export function CampaignDetailRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-campaign-detail">
      <Heading level={1}>{t('stub.campaignDetail')}</Heading>
      <Text as="p">{t('stub.campaignDetail')}</Text>
    </Stack>
  )
}
