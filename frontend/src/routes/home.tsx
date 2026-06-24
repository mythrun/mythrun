import { Suspense } from 'react'
import { Stack, Heading, Text, Card, CardHeader, CardBody, Spinner } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useMyCampaigns, type CampaignSummary } from '@mythrun/client-core'

// The home hub — the ONE end-to-end wired screen (done-when #3: "renders real
// backend data behind a loading state"). It fetches `GET /api/campaigns/mine`
// through the `useMyCampaigns` client-core hook (R5 — a screen reaches the
// backend ONLY via a client-core hook, never raw fetch/react-query), maps the
// validated rows to @mythrun/ui Cards, and renders an empty state when the
// player has no campaigns.
//
// `useMyCampaigns` is a TanStack SUSPENSE query: it throws a promise while
// loading and throws a typed error on failure. So `HomeRoute` (the outer
// component) owns the <Suspense> boundary — a <Spinner/> fallback — and the
// route-level error boundary (W3c, wired as the routes' `errorElement`) owns the
// failure branch. The data-consuming `<CampaignHub>` therefore renders only once
// the data has resolved; it never sees a loading or error state itself.

// The four wire campaign statuses → their i18n label keys. A static literal map
// (not a computed `home.status.${status}` template) keeps every key a
// first-class string the typed-keys guard + the i18n:todo scan can see.
const STATUS_LABEL_KEY = {
  setup: 'home.status.setup',
  active: 'home.status.active',
  archived: 'home.status.archived',
  failed: 'home.status.failed',
} as const satisfies Record<CampaignSummary['status'], string>

/** One campaign as a flat Card: its name (title) over its localized status. */
function CampaignCard({ campaign }: { campaign: CampaignSummary }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card data-testid={`campaign-card-${campaign.id}`}>
      <CardHeader>
        <Heading level={2} role="title">
          {campaign.name}
        </Heading>
      </CardHeader>
      <CardBody>
        <Text role="ui-label">{t(STATUS_LABEL_KEY[campaign.status])}</Text>
      </CardBody>
    </Card>
  )
}

/**
 * The data-consuming inner content. Calls the suspense hook (so it only renders
 * post-resolution), then maps the validated campaigns to Cards — or the
 * empty-state placeholder when the player owns none.
 */
function CampaignHub(): React.JSX.Element {
  const { t } = useTranslation()
  const { data } = useMyCampaigns()
  const { campaigns } = data

  if (campaigns.length === 0) {
    return (
      <Text as="p" role="prose-body" data-testid="home-empty">
        {t('home.empty')}
      </Text>
    )
  }

  return (
    <Stack gap={4} data-testid="home-campaigns">
      {campaigns.map((campaign) => (
        <CampaignCard key={campaign.id} campaign={campaign} />
      ))}
    </Stack>
  )
}

export function HomeRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={5} data-testid="route-home">
      <Heading level={1}>{t('home.title')}</Heading>
      <Suspense
        fallback={
          <Spinner label={t('home.loading')} data-testid="home-loading" />
        }
      >
        <CampaignHub />
      </Suspense>
    </Stack>
  )
}
