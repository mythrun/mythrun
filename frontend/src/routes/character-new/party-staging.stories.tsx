import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import {
  ApiClientProvider,
  createSseStatusClient,
  type ApiContext,
  type CampaignSummary,
  type CharacterCreationProgress,
  type SseStatusClient,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { PartyStagingSurface, type PartyStagingDeps } from './party-staging.tsx'

// PartyStagingSurface — the "ready to begin?" screen a player reaches once their
// character is confirmed (the DS <PartyRoster> under a screen headline, driven by
// the client-core view-model). The specimens feed the surface fixed roster +
// role data through the `deps` seam (a resolved getProgress/getCampaigns/finalize)
// so it settles to a fixed party WITHOUT a live backend. Solo = the common launch
// case (one member + the invite slot); Party = a laggard still creating (the owner
// can begin now or wait); Member = the non-owner waiting line. These exist for the
// E1 responsive/a11y sweep; the wiring is covered by party-staging.test.tsx.

const STORY_CID = 'story-campaign'
const OWNER = 'owner'
// A confirmed, non-owner party member (Ordric) — the viewer for the waiting-line specimen.
const MEMBER = 'u2'
const STORY_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

function campaign(over: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id: STORY_CID,
    worldId: 'world-1',
    name: 'The Hollow Road',
    status: 'setup',
    language: 'en',
    createdAt: '2026-07-11T10:00:00.000Z',
    updatedAt: '2026-07-11T10:00:00.000Z',
    worldName: 'Aldermoor',
    worldColors: null,
    creator: null,
    party: [{ userId: OWNER, displayName: 'Miklos', hasCharacter: true }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'needs-character',
    ...over,
  }
}

// A never-opened status-SSE client so a specimen never touches the network — the
// live roster stays quiet and renders the fixed specimen data.
const quietClient = (ctx: ApiContext): SseStatusClient => {
  const { connectionState } = createSseStatusClient(ctx)
  return {
    open: () => undefined,
    onEvent: () => () => undefined,
    onSnapshot: () => () => undefined,
    connectionState,
    close: () => undefined,
  }
}

// A deps seam that resolves fixed data (no live backend); the quiet SSE client keeps
// the specimen static under Storybook.
function fixture(
  progress: CharacterCreationProgress,
  campaigns: readonly CampaignSummary[],
): PartyStagingDeps {
  return {
    getProgress: () => Promise.resolve(progress),
    getCampaigns: () => Promise.resolve(campaigns),
    finalize: () => Promise.resolve({ campaignId: STORY_CID, jobId: 'story-job' }),
    createClient: quietClient,
  }
}

// Solo — the viewer is the only member; the surface appends the invite slot.
const SOLO_PROGRESS: CharacterCreationProgress = {
  campaignId: STORY_CID,
  totalMembers: 1,
  concepts: [{ userId: OWNER, displayName: 'Miklos', status: 'completed', submittedAt: 't1' }],
  missing: [],
}

// A full party with a laggard — two ready, one still creating (a `processing`
// concept → the "Choosing who they are…" stand-in). The owner can begin or wait.
const PARTY_PROGRESS: CharacterCreationProgress = {
  campaignId: STORY_CID,
  totalMembers: 3,
  concepts: [
    { userId: OWNER, displayName: 'Miklos', status: 'completed', submittedAt: 't1' },
    { userId: 'u2', displayName: 'Ordric', status: 'completed', submittedAt: 't2' },
    { userId: 'u3', displayName: 'Pell', status: 'processing', submittedAt: 't3' },
  ],
  missing: [],
}

const PARTY_CAMPAIGN = campaign({
  party: [
    { userId: OWNER, displayName: 'Miklos', hasCharacter: true },
    { userId: 'u2', displayName: 'Ordric', hasCharacter: true },
    { userId: 'u3', displayName: 'Pell', hasCharacter: false },
  ],
})

function renderWith(
  viewerUserId: string,
  progress: CharacterCreationProgress,
  campaigns: readonly CampaignSummary[],
): React.JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <ApiClientProvider value={STORY_CTX}>
        <PartyStagingSurface
          campaignId={STORY_CID}
          viewerUserId={viewerUserId}
          onFinalized={() => undefined}
          deps={fixture(progress, campaigns)}
        />
      </ApiClientProvider>
    </I18nextProvider>
  )
}

const meta: Meta<typeof PartyStagingSurface> = {
  title: 'Screens/PartyStaging',
  component: PartyStagingSurface,
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof PartyStagingSurface>

// Solo owner — one member + the dashed invite slot, the solo Begin enabled.
export const SoloOwner: Story = {
  name: 'Solo owner (the common launch case)',
  render: () => renderWith(OWNER, SOLO_PROGRESS, [campaign()]),
}

// Full party, owner view — two ready + one creating; the party Begin. The owner
// can begin now or wait for the laggard.
export const PartyOwner: Story = {
  name: 'Full party — owner (a laggard still creating)',
  render: () => renderWith(OWNER, PARTY_PROGRESS, [PARTY_CAMPAIGN]),
}

// Member (non-owner) — no Begin control; the waiting line instead.
export const MemberWaiting: Story = {
  name: 'Member (non-owner) — waiting line',
  render: () =>
    renderWith(
      MEMBER,
      PARTY_PROGRESS,
      [campaign({ creator: 'Miklos', party: PARTY_CAMPAIGN.party })],
    ),
}
