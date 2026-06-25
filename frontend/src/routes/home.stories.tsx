import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CampaignSummary } from '@mythrun/client-core'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/Home',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

const LONG_CAMPAIGNS: readonly CampaignSummary[] = [
  {
    id: 'c-1',
    worldId: 'w-1',
    name: 'The Interminable Saga of the Drowned Cathedral and Its Thousand Sunken Bells',
    status: 'active',
    language: 'en',
    createdAt: '2026-06-24T10:00:00.000Z',
    updatedAt: '2026-06-24T11:00:00.000Z',
  },
  {
    id: 'c-2',
    worldId: 'w-2',
    name: 'Ashfall Reach and the Long Road Through the Cinderlands Beyond the Edge of the Map',
    status: 'setup',
    language: 'en',
    createdAt: '2026-06-24T12:00:00.000Z',
    updatedAt: '2026-06-24T13:00:00.000Z',
  },
]

export const LongCampaignTitles: Story = {
  name: 'Home · long campaign titles',
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={LONG_CAMPAIGNS} />,
  play: expectScreen('route-home'),
}
