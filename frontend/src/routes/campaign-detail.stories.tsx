import type { Meta, StoryObj } from '@storybook/react-vite'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/CampaignDetail',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

export const Default: Story = {
  render: () => <ScreenHarness entry="/campaigns/c-1" session="ready" />,
  // The harness has no SSE backend, so the status stream reconnects forever and
  // the route deterministically holds the GENERATING act — that is this story's
  // reachable screen state, and asserting it proves the route composition mounts
  // through the frame. (The settled landing is covered by Screens/CampaignPage,
  // which renders the component directly with an injected campaigns source —
  // `route-campaign-detail` is unreachable through a dead-API route tree.)
  play: expectScreen('worldgen-generating'),
}
