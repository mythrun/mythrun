import type { Meta, StoryObj } from '@storybook/react-vite'
import type { BalanceResponse, CampaignSummary } from '@mythrun/client-core'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/Home',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

// A representative hub covering EVERY `cardPhase` in the full widened
// `CampaignSummary` shape (world identity, party roster, session activity), so the
// visual audit + the 375/1280 overflow gate see all six states at once. One card
// carries an adversarially long title (overflow stress), one is a joined world (the
// `creator` credit shows), one has a >5 party (the `+N` seal overflow), and the
// still-generating world has no colours (the ghost band).
const HUB_CAMPAIGNS: readonly CampaignSummary[] = [
  {
    id: 'c-generating',
    worldId: 'w-1',
    name: 'The Interminable Saga of the Drowned Cathedral and Its Thousand Sunken Bells',
    status: 'setup',
    language: 'en',
    createdAt: '2026-06-24T10:00:00.000Z',
    updatedAt: '2026-06-24T11:00:00.000Z',
    worldName: 'Aerthmoor',
    worldColors: null,
    creator: null,
    party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: false }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'generating',
  },
  {
    id: 'c-failed',
    worldId: 'w-2',
    name: 'Ashfall Reach',
    status: 'failed',
    language: 'en',
    createdAt: '2026-06-24T12:00:00.000Z',
    updatedAt: '2026-06-24T13:00:00.000Z',
    worldName: 'The Cinderlands',
    worldColors: { from: 'ember-200', to: 'umber-800' },
    creator: null,
    party: [{ userId: 'u-1', displayName: 'Ada', hasCharacter: false }],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'failed',
  },
  {
    id: 'c-needs-character',
    worldId: 'w-3',
    name: 'The Verdigris Court',
    status: 'setup',
    language: 'en',
    createdAt: '2026-06-24T14:00:00.000Z',
    updatedAt: '2026-06-24T15:00:00.000Z',
    worldName: 'Selavere',
    worldColors: { from: 'moss-100', to: 'verdigris-800' },
    creator: 'Bram',
    party: [
      { userId: 'u-1', displayName: 'Ada', hasCharacter: false },
      { userId: 'u-2', displayName: 'Bram', hasCharacter: true },
    ],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'needs-character',
  },
  {
    id: 'c-waiting',
    worldId: 'w-4',
    name: 'Harrow of the Iris Fen',
    status: 'setup',
    language: 'en',
    createdAt: '2026-06-24T16:00:00.000Z',
    updatedAt: '2026-06-24T17:00:00.000Z',
    worldName: 'The Iris Fen',
    worldColors: { from: 'iris-100', to: 'heather-800' },
    creator: null,
    party: [
      { userId: 'u-1', displayName: 'Ada', hasCharacter: true },
      { userId: 'u-2', displayName: 'Bram', hasCharacter: false },
      { userId: 'u-3', displayName: 'Cyra', hasCharacter: false },
    ],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'waiting-for-players',
  },
  {
    id: 'c-not-played',
    worldId: 'w-5',
    name: 'The Lapis Road',
    status: 'active',
    language: 'en',
    createdAt: '2026-06-24T18:00:00.000Z',
    updatedAt: '2026-06-24T19:00:00.000Z',
    worldName: 'Karthvalen',
    worldColors: { from: 'lapis-100', to: 'slate-900' },
    creator: null,
    party: [
      { userId: 'u-1', displayName: 'Ada', hasCharacter: true },
      { userId: 'u-2', displayName: 'Bram', hasCharacter: true },
    ],
    sessionCount: 0,
    lastPlayedAt: null,
    cardPhase: 'not-played',
  },
  {
    id: 'c-played',
    worldId: 'w-6',
    name: 'The Rose Assembly',
    status: 'active',
    language: 'en',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
    worldName: 'Ondemor',
    worldColors: { from: 'rose-100', to: 'rose-800' },
    creator: 'Bram',
    // A >5 party to exercise the `+N` seal overflow on the card.
    party: [
      { userId: 'u-1', displayName: 'Ada', hasCharacter: true },
      { userId: 'u-2', displayName: 'Bram', hasCharacter: true },
      { userId: 'u-3', displayName: 'Cyra', hasCharacter: true },
      { userId: 'u-4', displayName: 'Dane', hasCharacter: true },
      { userId: 'u-5', displayName: 'Esk', hasCharacter: true },
      { userId: 'u-6', displayName: 'Fenn', hasCharacter: true },
      { userId: 'u-7', displayName: 'Git', hasCharacter: true },
    ],
    sessionCount: 12,
    lastPlayedAt: '2026-06-18T21:00:00.000Z',
    cardPhase: 'played',
  },
]

const BALANCE: BalanceResponse = {
  session: 1250,
  world_gen: 4,
  active_subscription: null,
}

export const Populated: Story = {
  name: 'Home · the campaign hub (all phases)',
  render: () => (
    <ScreenHarness entry="/home" session="ready" seedCampaigns={HUB_CAMPAIGNS} seedBalance={BALANCE} />
  ),
  play: expectScreen('route-home'),
}

export const Empty: Story = {
  name: 'Home · empty (first-run shelf)',
  render: () => (
    <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} seedBalance={BALANCE} />
  ),
  play: expectScreen('home-empty'),
}
