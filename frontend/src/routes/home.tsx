import { Suspense } from 'react'
import { Stack, Heading, Text, Card, CoverDither, Button, Icon, Spinner } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMyCampaigns } from '@mythrun/client-core'
import { CampaignHubBody } from './home/home-hub.tsx'

// The home hub — the ONE end-to-end wired screen (done-when #3: "renders real
// backend data behind a loading state"). It fetches `GET /api/campaigns/mine`
// through the `useMyCampaigns` client-core hook (R5 — a screen reaches the
// backend ONLY via a client-core hook, never raw fetch/react-query), and renders
// the responsive card grid ⊕ mobile index (`CampaignHubBody`, MYT-87 T15) or,
// when the player owns none, the first-run empty shelf.
//
// `useMyCampaigns` is a TanStack SUSPENSE query: it throws a promise while
// loading and throws a typed error on failure. So `HomeRoute` (the outer
// component) owns the <Suspense> boundary — a <Spinner/> fallback — and the
// route-level error boundary (W3c, wired as the routes' `errorElement`) owns the
// failure branch. `CampaignHub` therefore renders only once the data has
// resolved; it never sees a loading or error state itself.

// The campaign-creation route (MYT-89 owns the real screen). Hoisted to a module
// const so the path isn't a JSX-attribute string literal (the i18n rule).
const CAMPAIGN_NEW_PATH = '/campaigns/new'

/**
 * The first-run empty shelf: a single dashed "Unwritten" cover (a paper-ghost
 * dither band — an uncoloured world borrows no fake identity) over the invitation
 * and the create-campaign CTA. `Card collapse` gives the quiet centered ~420px
 * panel (the sign-in card pattern), and `frame="dashed"` reads as an outline
 * waiting to be filled (T4).
 */
function EmptyShelf(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Stack align="center" data-testid="home-empty">
      <Card collapse frame="dashed">
        <Stack gap={5}>
          {/* The "Unwritten" cover — a muted paper→paper ghost band (the same ghost
              the still-generating card shows), holding the cover geometry while
              reading as a blank, waiting page. */}
          <CoverDither size="band" from="paper-100" to="paper-200" data-testid="home-empty-cover" />
          <Stack align="center" gap={4}>
            <Text as="p" role="prose-body">
              {t('home.empty')}
            </Text>
            <Button
              icon={<Icon name="plus" decorative />}
              onPress={() => {
                void navigate(CAMPAIGN_NEW_PATH)
              }}
              data-testid="home-empty-cta"
            >
              {t('home.createCampaign')}
            </Button>
          </Stack>
        </Stack>
      </Card>
    </Stack>
  )
}

/**
 * The data-consuming inner content. Calls the suspense hook (so it only renders
 * post-resolution), then renders the responsive hub body — or the first-run empty
 * shelf when the player owns no campaigns.
 */
function CampaignHub(): React.JSX.Element {
  const { data } = useMyCampaigns()
  const { campaigns } = data

  if (campaigns.length === 0) {
    return <EmptyShelf />
  }

  return <CampaignHubBody campaigns={campaigns} />
}

export function HomeRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={5} data-testid="route-home">
      <Heading level={1}>{t('home.title')}</Heading>
      <Suspense
        fallback={<Spinner label={t('home.loading')} data-testid="home-loading" />}
      >
        <CampaignHub />
      </Suspense>
    </Stack>
  )
}
