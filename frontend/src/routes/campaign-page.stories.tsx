import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import { ApiClientProvider, type ApiContext, type CampaignSummary } from '@mythrun/client-core'
import { expectScreen } from '../storybook/screen-harness.tsx'
import { i18n } from '../i18n/config.ts'
import { CampaignPage } from './campaign-page.tsx'
import type { CharacterSurfaceDeps } from './character-new/character-surface.tsx'

// The settled campaign page (MYT-89 Phase D, D5 → MYT-90 D8 — the explicit MYT-89
// boundary): world identity (dither cover + world name) over the invite stub seam
// (MYT-91) and the real character surface (MYT-90). Rendered DIRECTLY with an
// injected campaigns source — through the route tree this state is unreachable
// in the harness (it needs a live status stream reporting `complete` plus a
// chosen situation; the dead-API route deterministically holds the generating
// act, which Screens/CampaignDetail covers). The direct render is the honest
// deterministic specimen of the settled landing.
//
// Since MYT-90 D8 the page mounts the real <CharacterSurface>, which owns
// `useNavigate` (it routes to the discrete pick/play screens) and fetches the
// viewer's creation signals. So the specimen wraps the page in a MemoryRouter and
// injects the surface's `fetch*` seams — with the campaign `active`, the surface
// deterministically settles on the play entry (per §3.3) without a live backend.

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

// The character-surface seams — resolve the three viewer signals so the surface
// reaches its `ready` state without touching the (invalid) network; the `active`
// campaign then routes it to the play entry. Values are otherwise inert (an active
// campaign short-circuits ahead of the situation/level/concept branches).
const CHARACTER_DEPS: CharacterSurfaceDeps = {
  fetchMe: () => Promise.resolve({ user: { id: 'u-1' } }),
  fetchSituations: () => Promise.resolve({ situations: [], chosenIndex: 0, startingLevel: 1 }),
  fetchProgress: () =>
    Promise.resolve({ campaignId: CAMPAIGN_ID, totalMembers: 1, concepts: [], missing: [] }),
}

// The PLAYED hub (ux-run2 myth-8x3uh): a campaign with an ended session behind
// it surfaces the last session's open threads (the recap's numbered index) + a
// quiet link to the recap — re-entry reads "continue where you left off". The
// recap source is injected (the same secret-free shape the endpoint serves).
const PLAYED_CAMPAIGN: CampaignSummary = {
  ...SETTLED_CAMPAIGN,
  sessionCount: 1,
  lastPlayedAt: '2026-07-24T02:00:00.000Z',
  cardPhase: 'played',
}

const PLAYED_RECAP = {
  recap: {
    sessionNumber: 1,
    endedAt: '2026-07-24T02:00:00.000Z',
    status: 'ready' as const,
    summary: 'You crossed the causeway at low tide and found the middle gate unbarred.',
    emergingThreads: [
      'The count still expects an answer he will not get.',
      'The dockmaster’s second knows where you are headed.',
      'The dagger’s mark went unread; it is still in your pack.',
    ],
  },
}

function SettledCampaignPage({
  campaign = SETTLED_CAMPAIGN,
  recap,
}: {
  campaign?: CampaignSummary
  recap?: typeof PLAYED_RECAP
}): React.JSX.Element {
  return (
    <MemoryRouter initialEntries={[`/campaigns/${CAMPAIGN_ID}`]}>
      <ApiClientProvider value={STORYBOOK_CTX}>
        <I18nextProvider i18n={i18n}>
          <CampaignPage
            campaignId={CAMPAIGN_ID}
            fetchCampaigns={() => Promise.resolve([campaign])}
            characterDeps={CHARACTER_DEPS}
            {...(recap !== undefined && { fetchRecap: () => Promise.resolve(recap) })}
          />
        </I18nextProvider>
      </ApiClientProvider>
    </MemoryRouter>
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

// Played — the re-entry hub with the last session's thread index + recap link.
export const Played: Story = {
  render: () => <SettledCampaignPage campaign={PLAYED_CAMPAIGN} recap={PLAYED_RECAP} />,
  play: expectScreen('campaign-last-session'),
}
