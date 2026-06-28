import type { Meta, StoryObj } from '@storybook/react-vite'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

// The DEV-only `/dev/transport` transport harness, rendered through the real
// route tree at its seeded entry. It is not a player screen — but every
// `src/routes/*.tsx` carries a story so the 375/1280 overflow gate measures it
// (the screen-story-coverage gate). Rendered idle: creating the barrel clients
// opens no socket, so the harness paints its bare @mythrun/ui shell without
// touching the network.
const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/DevTransport',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

export const Idle: Story = {
  name: 'Dev transport · idle',
  render: () => <ScreenHarness entry="/dev/transport" />,
  play: expectScreen('route-dev-transport'),
}
