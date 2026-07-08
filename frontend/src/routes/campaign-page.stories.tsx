import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CampaignSummary } from '@mythrun/client-core'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

// The settled campaign page (MYT-89 Phase D, D5 — the explicit MYT-89 boundary):
// world identity (dither cover + world name) over the two dashed stub seams
// (invite players MYT-91, character creation MYT-90). Rendered through the real
// route tree at the same `/campaigns/:id` entry as CampaignDetail — this is the
// branch the route settles on once the world is complete and a situation is
// chosen. The seeded campaign carries the world identity the page looks up from
// the hub payload by id.

const SETTLED_CAMPAIGN: CampaignSummary = {
  id: 'c-1',
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

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/CampaignPage',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

export const Default: Story = {
  render: () => (
    <ScreenHarness entry="/campaigns/c-1" session="ready" seedCampaigns={[SETTLED_CAMPAIGN]} />
  ),
  play: expectScreen('route-campaign-detail'),
}
