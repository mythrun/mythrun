import type { Meta, StoryObj } from '@storybook/react-vite'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/CampaignNew',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

export const Default: Story = {
  render: () => <ScreenHarness entry="/campaigns/new" session="ready" />,
  play: expectScreen('route-campaign-new'),
}
