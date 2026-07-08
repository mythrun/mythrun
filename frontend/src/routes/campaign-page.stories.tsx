import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import { ApiClientProvider, type ApiContext, type CampaignSummary } from '@mythrun/client-core'
import { expectScreen } from '../storybook/screen-harness.tsx'
import { i18n } from '../i18n/config.ts'
import { CampaignPage } from './campaign-page.tsx'

// The settled campaign page (MYT-89 Phase D, D5 — the explicit MYT-89 boundary):
// world identity (dither cover + world name) over the two dashed stub seams
// (invite players MYT-91, character creation MYT-90). Rendered DIRECTLY with an
// injected campaigns source — through the route tree this state is unreachable
// in the harness (it needs a live status stream reporting `complete` plus a
// chosen situation; the dead-API route deterministically holds the generating
// act, which Screens/CampaignDetail covers). The direct render is the honest
// deterministic specimen of the settled landing.

/** Hoisted so it rides as a JSX expression — the i18next no-literal rail flags
 *  bare string props on custom components (same convention as the seam testids). */
const CAMPAIGN_ID = 'c-1'

const SETTLED_CAMPAIGN: CampaignSummary = {
  id: CAMPAIGN_ID,
  worldId: 'w-1',
  name: 'The Salt Crescent Concord',
  status: 'active',
  language: 'en',
  createdAt: '2026-06-24T10:00:00.000Z',
  updatedAt: '2026-06-24T11:00:00.000Z',
  worldName: 'Brinehollow',
  worldColors: { from: 'ember-200', to: 'umber-800' },
  creator: null,
  party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: false }],
  sessionCount: 0,
  lastPlayedAt: null,
  cardPhase: 'not-played',
}

const STORYBOOK_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

function SettledCampaignPage(): React.JSX.Element {
  return (
    <ApiClientProvider value={STORYBOOK_CTX}>
      <I18nextProvider i18n={i18n}>
        <CampaignPage
          campaignId={CAMPAIGN_ID}
          fetchCampaigns={() => Promise.resolve([SETTLED_CAMPAIGN])}
        />
      </I18nextProvider>
    </ApiClientProvider>
  )
}

const meta: Meta<typeof SettledCampaignPage> = {
  title: 'Screens/CampaignPage',
  component: SettledCampaignPage,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof SettledCampaignPage>

export const Default: Story = {
  render: () => <SettledCampaignPage />,
  play: expectScreen('route-campaign-detail'),
}
